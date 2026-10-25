import { importPlace, extractUrl, splitAddress } from './maps.js';
import { planTrip } from './plan.js';
import { ensureSchema } from './schema.js';
import { insertIndex, mergeFixed, insertNearest } from './schedule.js';
import { findDay, findTime, hasScheduleCue, parseNaturalLanguage, KINDS } from './nl.js';
import { geocode } from './geocode.js';
import { suggestStay } from '../public/geo.js';
import { transitAdvice } from './transit.js';
import { newCode, normalizeCode, formatCode } from './code.js';
import { lodgingPlan, isLodging, AI_LODGING, COPY_MARK } from './lodging.js';
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

const ITEM_COLS = 'id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, cost, geo_tried, travel, stay, kind_set, alias';
const GEOCODABLE = "('place', 'hotel', 'meal')"; // 交通、航班這類通常不是一個查得到的地名
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
      `INSERT INTO items (id, trip_id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, geo_tried, stay, alias)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, tripId, e.day, idx, e.name, e.lat ?? null, e.lng ?? null, e.url ?? null, e.note ?? '', e.who ?? '',
      e.time ?? null, KINDS.includes(e.kind) ? e.kind : 'place', e.day > 0 && e.fixed ? 1 : 0, e.lat != null ? 1 : 0,
      e.stay !== undefined ? e.stay : suggestStay(e.name, KINDS.includes(e.kind) ? e.kind : 'place'), e.alias ?? null),
    ...layoutStatements(env, tripId, { [e.day]: order }),
    bump(env, tripId),
  ]);
  return id;
}

// 「加入」:貼連結 → 匯入地點;用說的 → AI 拆成多筆行程。回傳新增的項目摘要。
async function smartAdd(env, tripId, nDays, text, who, defaultDay = 0, hint = null) {
  const { url } = extractUrl(text);

  if (url) {
    // 連結前後的文字可能帶有「第二天 14:00」,先取出來
    const d = findDay(text, nDays);
    const t = findTime(text);
    let rest = text;
    for (const tok of [d?.text, t?.text]) if (tok) rest = rest.replace(tok, ' ');
    const place = await importPlace(rest);
    if (!place.name) throw new Error(place.cid ? '這種連結(含 cid)沒有地點資訊。請在 Google 地圖按「分享」重新複製連結,或直接輸入地點名稱' : '讀不到地點名稱,請改貼「分享」的連結,或直接輸入地點名稱');
    const explicit = d?.day && d.day <= nDays ? d.day : 0;
    const day = explicit || defaultDay;
    const e = { ...place, day, time: t?.time ?? null, kind: 'place', fixed: explicit > 0, who };
    return [{ id: await insertItem(env, tripId, nDays, e), name: place.name, day, time: e.time }];
  }

  if (!hasScheduleCue(text) && text.length <= 30) {
    const id = await insertItem(env, tripId, nDays, { name: text, day: defaultDay, kind: hint?.kind || 'place', note: hint?.note, alias: hint?.alias, who });
    return [{ id, name: text, day: defaultDay, time: null }];
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
      name: e.title, note: e.note, day: e.day || defaultDay, time: e.time, kind: e.kind, fixed: e.day > 0, who,
    });
    added.push({ id, name: e.title, day: e.day || defaultDay, time: e.time, badDay: e.badDay });
  }
  return added;
}


// 住宿與一般項目的區分:AI 自動產生與手動複製的「住宿副本」在重排時會被清掉重做,不算原本的項目
const isLodgingCopy = (r) => r.added_by === AI_LODGING || (r.added_by === COPY_MARK && isLodging(r));

// 算出 AI 的排法(不寫入)。回傳的 days 每一格是:{id}(現有項目)、{copyOf,label}(住宿副本)、{add:{name,kind}}(AI 新增的地點)
// 算出 AI 的排法(不寫入)。回傳的 days 每一格是:{id}(現有項目)、{copyOf,label}(住宿副本)、{add:{name,kind}}(AI 新增的地點)
// scope:
//   new    (預設,沒有想法時):已排在某天的項目一律不動;只把「還沒安排」的地點插進最順路的一天。
//   adjust (有想法時):以目前排法為草稿請 AI 調整,沒被提到的盡量不動。
//   all    (使用者明確要求重排整個行程):AI 重新分天。
async function buildProposal(env, tripId, nDays, instruction, draft, draftAdds, scopeIn) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, lat, lng, day, position, time, kind, kind_set, fixed, stay, note, added_by FROM items WHERE trip_id = ?',
  ).bind(tripId).all();
  const real = results.filter((r) => !isLodgingCopy(r));
  const hotels = real.filter((r) => isLodging(r));
  const fixed = real.filter((r) => r.fixed && r.day > 0 && !isLodging(r));
  const movable = real.filter((r) => !(r.fixed && r.day > 0) && !isLodging(r));
  const nonHotel = real.filter((r) => !isLodging(r));
  const placed = nonHotel.filter((r) => r.day > 0);
  const byId = new Map(real.map((r) => [r.id, r]));
  const lp = lodgingPlan(hotels.map((h) => ({ id: h.id, day: h.day })), nDays);
  const entry = (sp, label) => (sp.copy ? { copyOf: sp.hotel.id, label } : { id: sp.hotel.id });
  const movableIds = new Set(movable.map((m) => m.id));
  const cleanDraft = draft ? draft.map((d) => d.filter((id) => movableIds.has(id))) : null;
  const hasDraft = cleanDraft && cleanDraft.some((d) => d.length);
  // 目前的排法(每天依順序),當作預設的草稿
  const currentByDay = Array.from({ length: nDays }, () => []);
  for (const r of [...placed].sort((a, b) => a.position - b.position)) if (r.day <= nDays) currentByDay[r.day - 1].push(r);
  let scope = scopeIn === 'all' ? 'all' : instruction || hasDraft ? 'adjust' : 'new';
  if (scope === 'new' && !placed.length) scope = 'all'; // 還沒有任何排好的:整個重新排才有意義

  let lists, plan = { tips: [], stays: [], adds: [], usedAi: true };
  if (scope === 'new') {
    lists = currentByDay.map((l) => [...l]);
    for (const it of nonHotel.filter((r) => r.day === 0)) insertNearest(lists, it);
  } else {
    const useDraft = scope === 'adjust' ? (hasDraft ? cleanDraft : currentByDay.map((l) => l.filter((x) => movableIds.has(x.id)).map((x) => x.id))) : null;
    plan = await planTrip(env, movable, nDays, fixed, instruction, hotels, useDraft && useDraft.some((d) => d.length) ? useDraft : null);
    // 沒有輸入想法時,不套用 AI 擅自改的停留時間與新增的地點(避免蓋掉使用者自己設的值)
    if (!instruction) { plan.stays = []; plan.adds = []; }
    lists = mergeFixed(plan.days.map((ids) => ids.map((id) => byId.get(id))), fixed);
  }
  const days = lists.map((items, i) => [
    ...lp.head[i].map((sp) => entry(sp, '從住宿出發')),
    ...items.map((x) => ({ id: x.id })),
    ...lp.tail[i].map((sp) => entry(sp, '回住宿休息')),
  ]);
  // 新增的地點(這次 AI 提議的,加上使用者先前已接受在草稿裡的)放在當天最後一個地點之後、回住宿之前
  const adds = [...(Array.isArray(draftAdds) ? draftAdds : []), ...plan.adds];
  const seen = new Set(real.map((r) => String(r.name).toLowerCase()));
  for (const a of adds) {
    const name = clean(a?.name, 40), day = Math.round(Number(a?.day));
    if (!name || !(day >= 1 && day <= nDays) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const tail = lp.tail[day - 1].length;
    days[day - 1].splice(days[day - 1].length - tail, 0, { add: { name, kind: a.kind === 'meal' ? 'meal' : 'place' } });
  }
  const nameOf = new Map(real.map((r) => [r.id, r.name]));
  return {
    days, tips: plan.tips, keepTips: scope === 'new', scope, newCount: scope === 'new' ? nonHotel.filter((r) => r.day === 0).length : undefined, usedAi: plan.usedAi, lodging: hotels.length ? hotels[0].name : null,
    stays: plan.stays.map((x) => ({ id: x.id, name: nameOf.get(x.id), minutes: x.minutes })),
  };
}

// 套用(可能是使用者拖曳調整過的)排法。所有項目與欄位都重新驗證,不信任前端。
async function applyProposal(env, tripId, nDays, body) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, lat, lng, day, kind, kind_set, url, note, added_by FROM items WHERE trip_id = ?',
  ).bind(tripId).all();
  const oldCopies = results.filter(isLodgingCopy);
  const real = results.filter((r) => !isLodgingCopy(r));
  const byId = new Map(real.map((r) => [r.id, r]));
  const src = Array.isArray(body.days) ? body.days.slice(0, nDays) : [];
  const placed = new Set();
  const layout = {};
  const inserts = [];
  const addedNames = [];
  const newItem = (day, name, kind, h, label) => {
    const id = crypto.randomUUID();
    const isCopy = !!h;
    inserts.push(env.DB.prepare(
      `INSERT INTO items (id, trip_id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, geo_tried)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
    ).bind(id, tripId, name, isCopy ? h.lat : null, isCopy ? h.lng : null, isCopy ? h.url ?? null : null,
      isCopy ? [label, h.note].filter(Boolean).join(' · ').slice(0, 300) : '', isCopy ? AI_LODGING : 'AI', isCopy ? 'hotel' : kind, isCopy && h.lat != null ? 2 : 0));
    if (!isCopy) addedNames.push({ name, day });
    return id;
  };
  let count = 0;
  for (let d = 1; d <= nDays; d++) {
    layout[d] = [];
    for (const e of Array.isArray(src[d - 1]) ? src[d - 1] : []) {
      if (++count > 300) return { error: '項目太多了' };
      if (e && typeof e.id === 'string' && byId.has(e.id) && !placed.has(e.id)) { placed.add(e.id); layout[d].push(e.id); }
      else if (e && typeof e.copyOf === 'string' && byId.has(e.copyOf)) layout[d].push(newItem(d, byId.get(e.copyOf).name, 'hotel', byId.get(e.copyOf), clean(e.label, 20) || '住宿'));
      else if (e?.add && clean(e.add.name, 40)) layout[d].push(newItem(d, clean(e.add.name, 40), KINDS.includes(e.add.kind) ? e.add.kind : 'place', null));
    }
  }
  layout[0] = real.filter((r) => !placed.has(r.id)).map((r) => r.id); // 沒被安排到的留在「還沒安排」
  const tips = {};
  const setTips = Array.isArray(body.tips); // body.tips 為 null:沿用目前每天的提醒
  if (setTips) body.tips.slice(0, nDays).forEach((t, i) => { const v = clean(t, 80); if (v) tips[i + 1] = v; });
  const stays = (Array.isArray(body.stays) ? body.stays : []).filter((x) => byId.has(x?.id) && Number(x.minutes) >= 15 && Number(x.minutes) <= 720);
  await env.DB.batch([
    ...oldCopies.map((c) => env.DB.prepare('DELETE FROM items WHERE id = ? AND trip_id = ?').bind(c.id, tripId)),
    ...inserts,
    ...real.filter((r) => isLodging(r) && r.kind !== 'hotel').map((h) => env.DB.prepare("UPDATE items SET kind = 'hotel' WHERE id = ? AND trip_id = ?").bind(h.id, tripId)),
    ...layoutStatements(env, tripId, layout),
    ...(setTips ? [env.DB.prepare('UPDATE trips SET tips = ? WHERE id = ?').bind(JSON.stringify(tips), tripId)] : []),
    ...stays.map((x) => env.DB.prepare('UPDATE items SET stay = ? WHERE id = ? AND trip_id = ?').bind(Math.round(Number(x.minutes)), x.id, tripId)),
    bump(env, tripId),
  ]);
  return { ok: true, added: addedNames };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','trips',id,...]
  const method = request.method;
  // 用短碼加入行程:POST /api/join { code } → { id, name }。短碼空間夠大,另外限制每個 IP 每分鐘的嘗試次數。
  if (parts[0] === 'api' && parts[1] === 'join' && parts.length === 2 && method === 'POST') {
    await ensureSchema(env);
    const ip = request.headers.get('cf-connecting-ip') || 'x';
    const rl = new Request(`https://join-rl.invalid/${ip}/${Math.floor(Date.now() / 60000)}`);
    const seen = Number((await caches.default.match(rl)?.then((r) => r?.text())) || 0);
    if (seen >= 15) return fail('試太多次了,請一分鐘後再試', 429);
    await caches.default.put(rl, new Response(String(seen + 1), { headers: { 'cache-control': 'max-age=90' } }));
    const body = await request.json().catch(() => ({}));
    const code = normalizeCode(body.code);
    if (!code) return fail('短碼是 8 個字,例如 ABCD-EFGH,請再確認');
    const t = await env.DB.prepare('SELECT id, name FROM trips WHERE code = ?').bind(code).first();
    return t ? json({ id: t.id, name: t.name }) : fail('找不到這個短碼,請向分享的人再確認一次', 404);
  }

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
      const dd = Number(body.day);
      const h = body.place && typeof body.place === 'object' ? body.place : null;
      const hint = h ? { kind: KINDS.includes(h.kind) ? h.kind : 'place', note: clean(h.note, 300), alias: clean(h.alias, 80) || null } : null;
      const added = await smartAdd(env, tripId, exists.days, text, clean(body.who, 20), Number.isInteger(dd) && dd >= 1 && dd <= exists.days ? dd : 0, hint);
      return json({ added });
    } catch (e) {
      return fail(e.message || '無法加入,請再試一次');
    }
  }

  // 這個行程的分享短碼(第一次要時產生)
  if (parts[3] === 'code' && parts.length === 4 && method === 'POST') {
    let row = await env.DB.prepare('SELECT code FROM trips WHERE id = ?').bind(tripId).first();
    for (let i = 0; i < 6 && !row?.code; i++) {
      const c = newCode();
      try { await env.DB.prepare('UPDATE trips SET code = ? WHERE id = ? AND code IS NULL').bind(c, tripId).run(); } catch { /* 撞號:換一個再試 */ }
      row = await env.DB.prepare('SELECT code FROM trips WHERE id = ?').bind(tripId).first();
    }
    return row?.code ? json({ code: formatCode(row.code) }) : fail('暫時無法產生短碼,請再試一次', 503);
  }

  // 復原刪除:把先前刪掉的項目原樣放回去(含原本的天與位置)
  if (parts[3] === 'items' && parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const it = body.item || {};
    const name = clean(it.name, 80);
    const day = Number.isInteger(it.day) && it.day >= 0 && it.day <= exists.days ? it.day : 0;
    if (!name) return fail('資料格式不對');
    const id = typeof it.id === 'string' && /^[0-9a-f-]{36}$/.test(it.id) ? it.id : crypto.randomUUID();
    if (await env.DB.prepare('SELECT 1 FROM items WHERE id = ?').bind(id).first()) return json({ ok: true, already: true });
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    const lat = num(it.lat), lng = num(it.lng);
    const { results } = await env.DB.prepare('SELECT id FROM items WHERE trip_id = ? AND day = ? ORDER BY position').bind(tripId, day).all();
    const order = results.map((r) => r.id);
    order.splice(Math.min(Math.max(0, Number(it.position) || 0), order.length), 0, id);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO items (id, trip_id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, cost, geo_tried, travel, stay)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, tripId, day, name, lat, lng, clean(it.url, 500) || null, clean(it.note, 300), clean(it.added_by, 40),
        TIME_RE.test(String(it.time ?? '')) ? String(it.time).padStart(5, '0') : null, KINDS.includes(it.kind) ? it.kind : 'place', day > 0 && it.fixed ? 1 : 0,
        num(it.cost), lat != null ? 2 : Math.min(2, Number(it.geo_tried) || 0), MODES.includes(it.travel) ? it.travel : null, num(it.stay)),
      ...layoutStatements(env, tripId, { [day]: order }),
      bump(env, tripId),
    ]);
    return json({ ok: true, id });
  }

  // 把這個地點複製到其他天(例如住宿複製成每天的「出發點」或「回來點」)
  if (parts[3] === 'items' && parts.length === 6 && parts[5] === 'copy' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const src = await env.DB.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ? AND trip_id = ?`).bind(parts[4], tripId).first();
    if (!src) return fail('找不到這個項目', 404);
    const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= exists.days).slice(0, 14);
    if (!days.length) return fail('請選擇要複製到哪一天');
    const atStart = body.where === 'start';
    const stmts = [];
    for (const d of days) {
      const { results } = await env.DB.prepare('SELECT id FROM items WHERE trip_id = ? AND day = ? ORDER BY position').bind(tripId, d).all();
      const order = results.map((r) => r.id);
      const id = crypto.randomUUID();
      if (atStart) order.unshift(id); else order.push(id);
      stmts.push(env.DB.prepare(
        `INSERT INTO items (id, trip_id, day, position, name, lat, lng, url, note, added_by, time, kind, fixed, cost, geo_tried, stay)
         VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)`,
      ).bind(id, tripId, src.name, src.lat, src.lng, src.url, src.note, COPY_MARK, src.kind, src.geo_tried, src.stay), ...layoutStatements(env, tripId, { [d]: order }));
    }
    await env.DB.batch([...stmts, bump(env, tripId)]);
    return json({ ok: true, copied: days.length });
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
    // 類別(景點/餐飲/住宿…):手動改過就記下來,之後不再用名稱猜
    if (body.kind !== undefined) {
      if (!KINDS.includes(body.kind)) return fail('類別不對');
      sets.push('kind = ?', 'kind_set = 1'); args.push(body.kind);
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
      `SELECT id, name, note, alias FROM items WHERE trip_id = ? AND lat IS NULL AND geo_tried < 2 AND kind IN ${GEOCODABLE} LIMIT 4`,
    ).bind(tripId).all();
    const { results: near } = await env.DB.prepare('SELECT lat, lng FROM items WHERE trip_id = ? AND lat IS NOT NULL').bind(tripId).all();
    const stmts = [];
    let found = 0;
    let failed = false;
    for (const [i, it] of todo.entries()) {
      if (i) await sleep(1100);
      let pt = null;
      try { pt = await geocode(it.name, near, fetch, { nominatim: env.GEOCODE_BASE || undefined, photon: env.PHOTON_BASE || undefined, maxKm: it.alias ? 60 : undefined }, [...(it.alias ? [it.alias, `${it.alias} ${it.name}`] : []), `${it.name} ${it.note || ''}`, it.note, ...(splitAddress(it.name).address ? [splitAddress(it.name).name, splitAddress(it.name).address] : [])]); } catch (e) { console.error('geocode failed', e); failed = true; break; } // 網路或被限流:不標記,下次再試
      const addr = pt?.address ? pt.address.slice(0, 120) : '';
      stmts.push(env.DB.prepare('UPDATE items SET lat = ?, lng = ?, geo_tried = 2, note = CASE WHEN note = \'\' AND ? != \'\' THEN ? ELSE note END WHERE id = ? AND trip_id = ?').bind(pt?.lat ?? null, pt?.lng ?? null, addr, addr, it.id, tripId));
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
    const key = new Request(`https://transit-cache.invalid/v2/${r3(from.lat)},${r3(from.lng)}/${r3(to.lat)},${r3(to.lng)}`);
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
  // AI 排行程分兩步:preview 只算出建議(不寫入資料庫),使用者在畫面上對照、拖曳、對話微調,確認後 apply 才寫入
  if (parts[3] === 'plan' && parts.length === 5 && parts[4] === 'preview' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const instruction = clean(body.instruction, 300);
    const draft = Array.isArray(body.draft) ? body.draft.slice(0, exists.days).map((d) => (Array.isArray(d) ? d.filter((x) => typeof x === 'string').slice(0, 100) : [])) : null;
    const adds = Array.isArray(body.draftAdds) ? body.draftAdds.slice(0, 6) : [];
    return json(await buildProposal(env, tripId, exists.days, instruction, draft, adds, body.scope));
  }
  if (parts[3] === 'plan' && parts.length === 5 && parts[4] === 'apply' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const r = await applyProposal(env, tripId, exists.days, body);
    return r.error ? fail(r.error) : json(r);
  }
  // 舊的一步到位(預覽後立刻套用),保留給舊版畫面
  if (parts[3] === 'plan' && parts.length === 4 && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const instruction = clean(body.instruction, 300);
    const prop = await buildProposal(env, tripId, exists.days, instruction, null, [], body.scope);
    const r = await applyProposal(env, tripId, exists.days, { days: prop.days, tips: prop.tips, stays: prop.stays.map((x) => ({ id: x.id, minutes: x.minutes })) });
    return r.error ? fail(r.error) : json({ ok: true, usedAi: prop.usedAi, lodging: prop.lodging, stays: prop.stays.map((x) => ({ name: x.name, minutes: x.minutes })), added: r.added });
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
