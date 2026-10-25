import { importPlace, extractUrl, splitAddress } from './maps.js';
import { planTrip } from './plan.js';
import { ensureSchema } from './schema.js';
import { insertIndex, mergeFixed } from './schedule.js';
import { findDay, findTime, hasScheduleCue, parseNaturalLanguage, KINDS } from './nl.js';
import { geocode } from './geocode.js';
import { suggestStay } from '../public/geo.js';
import { transitAdvice } from './transit.js';
import { suggestPlaces } from './suggest.js';
import { computeRoute, MODES, validPoint, sanitizeDeparture } from './route.js';
import { translateText, translateImage, DIRECTIONS, IMAGE_RE, MAX_IMAGE_CHARS } from './translate.js';

const MAX_ITEMS = 80;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去掉容易混淆的 l o 0 1
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

function randomId(len) {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const int = (v, lo, hi, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const ITEM_COLS = 'id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, cost, geo_tried, travel, stay';
const GEOCODABLE = "('place', 'hotel')"; // 吃飯、交通這類通常不是一個查得到的地名
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadTrip(env, id) {
  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!trip) return null;
  const { results } = await env.DB.prepare(
    `SELECT ${ITEM_COLS} FROM items WHERE trip_id = ? ORDER BY day, position`,
  ).bind(id).all();
  let tips = {};
  try { tips = JSON.parse(trip.tips); } catch { /* 壞資料就當沒有 */ }
  return { id: trip.id, name: trip.name, days: trip.days, start_date: trip.start_date, version: trip.version, tips, items: results };
}

const bump = (env, id) => env.DB.prepare('UPDATE trips SET version = version + 1 WHERE id = ?').bind(id);

// 依 layout 重寫項目的 day/position。layout: { "0": [id...], "1": [id...] }
function layoutStatements(env, tripId, layout) {
  const stmts = [];
  for (const [day, ids] of Object.entries(layout)) {
    ids.forEach((id, pos) =>
      stmts.push(env.DB.prepare('UPDATE items SET day = ?, position = ? WHERE id = ? AND trip_id = ?').bind(+day, pos, id, tripId)));
  }
  return stmts;
}

// 新增一個項目到指定天的合適位置(依時間規則),回傳新 id
async function insertItem(env, tripId, nDays, e) {
  const id = crypto.randomUUID();
  const { results } = await env.DB.prepare(
    'SELECT id, time, kind FROM items WHERE trip_id = ? AND day = ? ORDER BY position',
  ).bind(tripId, e.day).all();
  const idx = e.day > 0 ? insertIndex(results, e, e.day, nDays) : results.length;
  const order = results.map((r) => r.id);
  order.splice(idx, 0, id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, trip_id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, geo_tried, stay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, tripId, e.day, idx, e.name, e.lat ?? null, e.lng ?? null, e.url ?? null, e.note ?? '', e.who ?? '',
      e.time ?? null, KINDS.includes(e.kind) ? e.kind : 'place', e.day > 0 && e.fixed ? 1 : 0, e.lat != null ? 1 : 0,
      e.stay !== undefined ? e.stay : suggestStay(e.name, KINDS.includes(e.kind) ? e.kind : 'place')),
    ...layoutStatements(env, tripId, { [e.day]: order }),
    bump(env, tripId),
  ]);
  return id;
}

// 「加入」:貼連結 → 匯入地點;用說的 → AI 拆成多筆行程。回傳新增的項目摘要。
async function smartAdd(env, tripId, nDays, text, who) {
  const { url } = extractUrl(text);

  if (url) {
    // 連結前後的文字可能帶有「第二天 14:00」,先取出來
    const d = findDay(text, nDays);
    const t = findTime(text);
    let rest = text;
    for (const tok of [d?.text, t?.text]) if (tok) rest = rest.replace(tok, ' ');
    const place = await importPlace(rest);
    if (!place.name) throw new Error(place.cid ? '這種連結(含 cid)沒有地點資訊。請在 Google 地圖按「分享」重新複製連結,或直接輸入地點名稱' : '讀不到地點名稱,請改貼「分享」的連結,或直接輸入地點名稱');
    const day = d?.day && d.day <= nDays ? d.day : 0;
    const e = { ...place, day, time: t?.time ?? null, kind: 'place', fixed: day > 0, who };
    return [{ id: await insertItem(env, tripId, nDays, e), name: place.name, day, time: e.time }];
  }

  if (!hasScheduleCue(text) && text.length <= 30) {
    const id = await insertItem(env, tripId, nDays, { name: text, day: 0, kind: 'place', who });
    return [{ id, name: text, day: 0, time: null }];
  }

  const { entries } = await parseNaturalLanguage(env, text, nDays);
  if (!entries.length) throw new Error('看不懂這句話,可以換個說法,例如「第一天13:00從台灣飛往東京」');
  const added = [];
  for (const e of entries) {
    // 同一天、同名、同時間已經有了(例如按了兩次):不重複加
    const dup = await env.DB.prepare('SELECT id FROM items WHERE trip_id = ? AND day = ? AND name = ? AND COALESCE(time, \'\') = ?')
      .bind(tripId, e.day, e.title, e.time ?? '').first();
    if (dup) { added.push({ id: dup.id, name: e.title, day: e.day, time: e.time, duplicate: true }); continue; }
    const id = await insertItem(env, tripId, nDays, {
      name: e.title, note: e.note, day: e.day, time: e.time, kind: e.kind, fixed: e.day > 0, who,
    });
    added.push({ id, name: e.title, day: e.day, time: e.time, badDay: e.badDay });
  }
  return added;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','trips',id,...]
  const method = request.method;
  if (parts[0] !== 'api' || parts[1] !== 'trips') return null;
  await ensureSchema(env);

  // 建立行程
  if (parts.length === 2 && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = randomId(12);
    await env.DB.prepare('INSERT INTO trips (id, name, days, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, clean(body.name, 40) || '我們的旅行', int(body.days, 1, 14, 5), Date.now()).run();
    return json({ id });
  }

  const tripId = parts[2];
  if (!tripId || !/^[a-z0-9]{12}$/.test(tripId)) return fail('找不到行程', 404);

  // 讀取(帶 v= 目前版本時,沒變動就只回 unchanged,省流量)
  if (parts.length === 3 && method === 'GET') {
    const v = url.searchParams.get('v');
    if (v !== null) {
      const row = await env.DB.prepare('SELECT version FROM trips WHERE id = ?').bind(tripId).first();
      if (!row) return fail('找不到行程', 404);
      if (String(row.version) === v) return json({ unchanged: true });
    }
    const trip = await loadTrip(env, tripId);
    return trip ? json(trip) : fail('找不到行程', 404);
  }

  const exists = await env.DB.prepare('SELECT days FROM trips WHERE id = ?').bind(tripId).first();
  if (!exists) return fail('找不到行程', 404);

  // 修改名稱 / 天數
  if (parts.length === 3 && method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const name = clean(body.name, 40);
    const days = body.days != null ? int(body.days, 1, 14, exists.days) : exists.days;
    let start;
    if (body.start_date === undefined) start = undefined;
    else if (body.start_date === '' || body.start_date === null) start = null;
    else if (DATE_RE.test(String(body.start_date))) start = String(body.start_date);
    else return fail('日期格式不對');
    const stmts = [env.DB.prepare('UPDATE trips SET name = COALESCE(NULLIF(?, \'\'), name), days = ? WHERE id = ?').bind(name, days, tripId)];
    if (start !== undefined) stmts.push(env.DB.prepare('UPDATE trips SET start_date = ? WHERE id = ?').bind(start, tripId));
    // 天數縮短時,超出的項目退回「尚未安排」;position 加大是為了排在原本「尚未安排」的項目後面,且保持彼此順序
    if (days < exists.days) stmts.push(env.DB.prepare('UPDATE items SET day = 0, fixed = 0, position = position + 10000 WHERE trip_id = ? AND day > ?').bind(tripId, days));
    stmts.push(bump(env, tripId));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }

  // 加入:貼連結、打地點名稱、或用自然語言描述行程
  if (parts[3] === 'add' && parts.length === 4 && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const text = clean(body.text, 800);
    if (!text) return fail('請先輸入想去的地方,或貼上連結');
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ?').bind(tripId).first();
    if (cnt.n >= MAX_ITEMS) return fail('項目太多了,請先刪除一些');
    try {
      const added = await smartAdd(env, tripId, exists.days, text, clean(body.who, 20));
      return json({ added });
    } catch (e) {
      return fail(e.message || '無法加入,請再試一次');
    }
  }

  // 改單一項目:名稱、備註、時間
  if (parts[3] === 'items' && parts.length === 5 && method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    let time;
    if (body.time === undefined) time = undefined;
    else if (body.time === '' || body.time === null) time = null;
    else if (TIME_RE.test(String(body.time))) time = String(body.time).padStart(5, '0');
    else return fail('時間格式不對');
    const sets = ['name = COALESCE(NULLIF(?, \'\'), name)', 'note = COALESCE(?, note)'];
    const newName = clean(body.name, 80);
    const args = [newName, body.note != null ? clean(body.note, 300) : null];
    if (time !== undefined) { sets.push('time = ?'); args.push(time); }
    if (body.cost !== undefined) {
      const c = body.cost === '' || body.cost === null ? null : Number(body.cost);
      if (c !== null && (!Number.isFinite(c) || c < 0 || c > 1e9)) return fail('金額格式不對');
      sets.push('cost = ?'); args.push(c);
    }
    // 停留時間(分鐘);空字串 = 不設定
    if (body.stay !== undefined) {
      const m = body.stay === '' || body.stay === null ? null : Math.round(Number(body.stay));
      if (m !== null && (!Number.isFinite(m) || m < 0 || m > 1440)) return fail('停留時間格式不對');
      sets.push('stay = ?'); args.push(m);
    }
    // 從這一站到下一站的交通方式;空字串 = 用建議的
    if (body.travel !== undefined) {
      if (body.travel !== '' && body.travel !== null && !MODES.includes(body.travel)) return fail('交通方式不對');
      sets.push('travel = ?'); args.push(body.travel || null);
    }
    // 手動指定位置(在地圖上點選,或瀏覽器自己查到的座標);geoTried 單獨為 true 表示「查過了、沒找到」
    const pinned = body.lat !== undefined && body.lng !== undefined && body.lat !== null && body.lng !== null;
    if (pinned) {
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail('座標格式不對');
      sets.push('lat = ?', 'lng = ?', 'geo_tried = 2'); args.push(lat, lng);
    } else if (body.geoTried === true) sets.push('geo_tried = 2');
    // 名稱改了、而且不是從地圖連結來的,就重新定位
    if (newName && !pinned) sets.push('lat = CASE WHEN url IS NULL AND name != ? THEN NULL ELSE lat END', 'lng = CASE WHEN url IS NULL AND name != ? THEN NULL ELSE lng END', 'geo_tried = CASE WHEN url IS NULL AND name != ? THEN 0 ELSE geo_tried END');
    if (newName && !pinned) args.push(newName, newName, newName);
    const r = await env.DB.batch([
      env.DB.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND trip_id = ?`).bind(...args, parts[4], tripId),
      bump(env, tripId),
    ]);
    return r[0].meta.changes ? json({ ok: true }) : fail('找不到這個項目', 404);
  }

  if (parts[3] === 'items' && parts.length === 5 && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM items WHERE id = ? AND trip_id = ?').bind(parts[4], tripId),
      bump(env, tripId),
    ]);
    return json({ ok: true });
  }

  // 整份排列(上移下移/移到某天,前端算好整份送上來)
  if (parts[3] === 'layout' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const layout = body.layout;
    if (!layout || typeof layout !== 'object') return fail('資料格式不對');
    const { results } = await env.DB.prepare('SELECT id FROM items WHERE trip_id = ?').bind(tripId).all();
    const known = new Set(results.map((r) => r.id));
    const seen = new Set();
    const safe = {};
    for (const [day, ids] of Object.entries(layout)) {
      const d = Number(day);
      if (!Number.isInteger(d) || d < 0 || d > exists.days || !Array.isArray(ids)) return fail('資料格式不對');
      safe[d] = ids.filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
    }
    // 請求裡沒提到的項目一律放回「尚未安排」
    const rest = [...known].filter((id) => !seen.has(id));
    safe[0] = [...(safe[0] || []), ...rest];
    await env.DB.batch([...layoutStatements(env, tripId, safe), bump(env, tripId)]);
    return json({ ok: true });
  }

  // 補座標:把只有名稱的地點查成座標。一次最多 4 個、每個間隔超過 1 秒(Nominatim 的使用規範)
  if (parts[3] === 'geocode' && method === 'POST') {
    const { results: todo } = await env.DB.prepare(
      `SELECT id, name, note FROM items WHERE trip_id = ? AND lat IS NULL AND geo_tried < 2 AND kind IN ${GEOCODABLE} LIMIT 4`,
    ).bind(tripId).all();
    const { results: near } = await env.DB.prepare('SELECT lat, lng FROM items WHERE trip_id = ? AND lat IS NOT NULL').bind(tripId).all();
    const stmts = [];
    let found = 0;
    let failed = false;
    for (const [i, it] of todo.entries()) {
      if (i) await sleep(1100);
      let pt = null;
      try { pt = await geocode(it.name, near, fetch, { nominatim: env.GEOCODE_BASE || undefined, photon: env.PHOTON_BASE || undefined }, [`${it.name} ${it.note || ''}`, it.note, ...(splitAddress(it.name).address ? [splitAddress(it.name).name, splitAddress(it.name).address] : [])]); } catch (e) { console.error('geocode failed', e); failed = true; break; } // 網路或被限流:不標記,下次再試
      stmts.push(env.DB.prepare('UPDATE items SET lat = ?, lng = ?, geo_tried = 2 WHERE id = ? AND trip_id = ?').bind(pt?.lat ?? null, pt?.lng ?? null, it.id, tripId));
      if (pt) { found++; near.push(pt); }
    }
    if (stmts.length) await env.DB.batch([...stmts, bump(env, tripId)]);
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE trip_id = ? AND lat IS NULL AND geo_tried < 2 AND kind IN ${GEOCODABLE}`,
    ).bind(tripId).first();
    return json({ found, remaining: left.n, failed });
  }

  // AI 推薦景點(不會自動加入,由使用者挑)
  if (parts[3] === 'suggest' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const trip = await env.DB.prepare('SELECT name, days FROM trips WHERE id = ?').bind(tripId).first();
    const { results } = await env.DB.prepare('SELECT name FROM items WHERE trip_id = ?').bind(tripId).all();
    const list = await suggestPlaces(env, { tripName: trip.name, days: trip.days, names: results.map((r) => r.name), query: clean(body.query, 80) });
    if (!list.length) return fail('AI 暫時想不出來,請稍後再試;旅行名稱寫上目的地(例如「東京五日遊」)會更準', 503);
    return json({ suggestions: list });
  }

  // 移動時間(即時路況)。結果短暫快取:同一對地點、同一種交通方式 10 分鐘內共用,省 API 額度
  if (parts[3] === 'route' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { from, to } = body;
    if (!validPoint(from) || !validPoint(to)) return fail('座標格式不對');
    const mode = MODES.includes(body.mode) ? body.mode : 'transit';
    const departure = sanitizeDeparture(body.depart);
    const r4 = (n) => n.toFixed(4);
    const key = new Request(`https://route-cache.invalid/${body.osmOnly === true ? 'osm' : 'g'}/${mode}/${r4(from.lat)},${r4(from.lng)}/${r4(to.lat)},${r4(to.lng)}/${departure ? departure.slice(0, 16) : 'now'}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return json(await hit.json());
    const useGoogle = body.osmOnly !== true;
    const result = await computeRoute(env, { from, to, mode, departure, useGoogle });
    if (result.source !== 'none') {
      await cache.put(key, new Response(JSON.stringify(result), { headers: { 'cache-control': `max-age=${departure || result.source === 'osrm' ? 3600 : 600}` } }));
    }
    return json(result);
  }

  // 大眾運輸怎麼搭(附近車站 + AI 說明);結果快取 7 天
  if (parts[3] === 'transit' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { from, to } = body;
    if (!validPoint(from) || !validPoint(to)) return fail('座標格式不對');
    const r3 = (n) => n.toFixed(3);
    const key = new Request(`https://transit-cache.invalid/${r3(from.lat)},${r3(from.lng)}/${r3(to.lat)},${r3(to.lng)}`);
    const hit = await caches.default.match(key);
    if (hit) return json(await hit.json());
    const r = await transitAdvice(env, { from: { ...from, name: clean(from.name, 40) }, to: { ...to, name: clean(to.name, 40) } });
    // 沒有具體搭法(不推薦或查不到):回 available:false,畫面就不會出現大眾運輸的建議;只快取半天
    const out = r ? { available: true, ...r } : { available: false };
    await caches.default.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': `max-age=${r ? 604800 : 43200}` } }));
    return json(out);
  }

  // 翻譯:文字(中↔日)
  if (parts[3] === 'translate' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const text = clean(body.text, 500);
    if (!text) return fail('請先輸入要翻譯的內容');
    const direction = DIRECTIONS.includes(body.direction) ? body.direction : 'zh2ja';
    const r = await translateText(env, text, direction);
    return r ? json(r) : fail('翻譯暫時失敗,請稍後再試;常用的句子可以直接點「說給對方看」的句子', 503);
  }

  // 翻譯:照片(菜單、招牌 → 繁體中文)
  if (parts[3] === 'translate-image' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const image = String(body.image ?? '');
    if (image.length > MAX_IMAGE_CHARS) return fail('照片太大了,請再拍一次或換小一點的照片');
    if (!IMAGE_RE.test(image)) return fail('照片格式不支援(請用 JPG、PNG 或 WebP)');
    const r = await translateImage(env, image);
    return r ? json(r) : fail('看不清楚這張照片,請靠近一點、光線亮一點再拍一次', 422);
  }

  // AI 排行程:指定過天數的項目(航班等)不動,其餘交給 AI 分天
  if (parts[3] === 'plan' && method === 'POST') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, lat, lng, day, time, kind, fixed, stay FROM items WHERE trip_id = ?',
    ).bind(tripId).all();
    const fixed = results.filter((r) => r.fixed && r.day > 0);
    const movable = results.filter((r) => !(r.fixed && r.day > 0));
    const body = await request.json().catch(() => ({}));
    const instruction = clean(body.instruction, 300);
    const plan = await planTrip(env, movable, exists.days, fixed, instruction);
    const byId = new Map(results.map((r) => [r.id, r]));
    const merged = mergeFixed(plan.days.map((ids) => ids.map((id) => byId.get(id))), fixed);
    const layout = { 0: [] };
    merged.forEach((items, i) => { layout[i + 1] = items.map((x) => x.id); });
    const tips = {};
    plan.tips.forEach((t, i) => { if (t) tips[i + 1] = t; });
    await env.DB.batch([
      ...layoutStatements(env, tripId, layout),
      env.DB.prepare('UPDATE trips SET tips = ? WHERE id = ?').bind(JSON.stringify(tips), tripId),
      ...plan.stays.map((x) => env.DB.prepare('UPDATE items SET stay = ? WHERE id = ? AND trip_id = ?').bind(x.minutes, x.id, tripId)),
      bump(env, tripId),
    ]);
    // 使用者想要的主題而現有地點不夠時,AI 新增的地點(之後會自動查位置)
    const added = [];
    for (const a of plan.adds) {
      await insertItem(env, tripId, exists.days, { name: a.name, day: a.day, kind: a.kind, who: 'AI' });
      added.push({ name: a.name, day: a.day });
    }
    const nameOf = new Map(results.map((r) => [r.id, r.name]));
    return json({ ok: true, usedAi: plan.usedAi, stays: plan.stays.map((x) => ({ name: nameOf.get(x.id), minutes: x.minutes })), added });
  }

  return fail('不支援的操作', 404);
}

export default {
  async fetch(request, env) {
    try {
      const res = await handle(request, env);
      if (res) return res;
    } catch (e) {
      console.error(e);
      return fail('系統忙碌,請稍後再試', 500);
    }
    return env.ASSETS.fetch(request);
  },
};
