// AI 排行程:把地點分配到各天並排序。AI 輸出一律驗證,失敗就用幾何方法保底。

const SYSTEM = `你是台灣旅遊行程規劃助手,使用者是家中長輩,請用簡單的繁體中文。
任務:把給定的地點分配到指定天數,同一天的地點要地理上相近,並排成順暢的參觀順序(考慮路線不要來回折返、午餐時間、景點開放時段常識)。
規則:
- 每個地點 id 必須剛好出現一次,不可新增或遺漏。
- 每天地點數量盡量平均,長輩體力有限,每天不要排太滿。
- 「已固定行程」是使用者指定好的(例如航班),不要動它,也不要把它放進 days。請依它安排:有航班抵達的第一天少排一點;最後一天有航班離開,地點要排在出發前、集中在機場附近順路的地方。
- 預設不要把已經排在某一天的地點換到別天,也不要打亂他們原本的順序;只有在使用者的想法明確要求時(例如「第三天想逛街」「把某地點移到別天」)才可以移動,而且只動必要的部分。
- 「住宿」是每天出發與回來的地方(已排好,不在地點清單裡)。請讓每天的第一個地點、最後一個地點都盡量靠近住宿,整天的路線像一個圈:從住宿出發、逛完回到住宿,不要來回跨區。
- tips 是每天一句簡短提醒(如:早點出發、這天走路較多、記得預約)。
- 若有「使用者的想法」,要優先照辦,並且仍遵守上面的規則:
  · 想把某地點「安排久一點/短一點」:在 stays 裡填那個地點的 id 與新的停留分鐘數(15 到 720);沒被要求的地點不要放進 stays。
  · 想要某天有某種主題(例如逛街、美食、親子):先從現有地點挑符合的排到那天;不夠時,在 adds 裡新增最多 3 個真實存在、知名、地圖上搜得到的地點(name 用正式名稱、day 是第幾天、kind 是 place 或 meal),並與該天其他地點在同一區域。沒有這類需求就讓 adds 留空陣列。
只輸出 JSON。`;

const SCHEMA = {
  type: 'object',
  properties: {
    days: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    tips: { type: 'array', items: { type: 'string' } },
    stays: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, minutes: { type: 'number' } }, required: ['id', 'minutes'] } },
    adds: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, day: { type: 'number' }, kind: { type: 'string', enum: ['place', 'meal'] } }, required: ['name', 'day', 'kind'] } },
  },
  required: ['days', 'tips', 'stays', 'adds'],
};

const dist = (a, b) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180));

// 保底:最近鄰路線,再平均切成 N 天。沒有座標的放最後。
export function fallbackPlan(items, nDays) {
  const withGeo = items.filter((i) => i.lat != null && i.lng != null);
  const noGeo = items.filter((i) => i.lat == null || i.lng == null);
  const route = [];
  const left = [...withGeo];
  if (left.length) {
    let cur = left.splice(left.reduce((b, it, i, a) => (it.lng < a[b].lng ? i : b), 0), 1)[0];
    route.push(cur);
    while (left.length) {
      let bi = 0;
      for (let i = 1; i < left.length; i++) if (dist(cur, left[i]) < dist(cur, left[bi])) bi = i;
      cur = left.splice(bi, 1)[0];
      route.push(cur);
    }
  }
  const all = [...route, ...noGeo];
  const days = Array.from({ length: nDays }, () => []);
  const cuts = pickCuts(route, all.length, nDays);
  let day = 0;
  all.forEach((it, i) => {
    if (cuts.includes(i)) day++;
    days[day].push(it.id);
  });
  return { days, tips: [] };
}

// 在路線上挑 nDays-1 個切點:優先切在相鄰兩點距離最遠處,但每天至少保留一些地點。
function pickCuts(route, total, nDays) {
  const even = Array.from({ length: nDays - 1 }, (_, k) => Math.ceil(((k + 1) * total) / nDays));
  if (nDays < 2 || total < nDays) return even;
  const min = Math.max(1, Math.floor(total / (nDays * 2)));
  // gap[i] = 第 i 點與前一點的距離;切點 i 代表第 i 個地點是新一天的開頭
  const cand = [];
  for (let i = min; i <= total - min; i++) cand.push({ i, g: i < route.length ? dist(route[i - 1], route[i]) : 0 });
  cand.sort((a, b) => b.g - a.g);
  const picked = [];
  for (const c of cand) {
    if (picked.every((p) => Math.abs(p - c.i) >= min)) picked.push(c.i);
    if (picked.length === nDays - 1) return picked;
  }
  return even;
}

// 驗證並修正 AI 輸出:去掉未知/重複 id,補上遺漏的,補滿天數。
export function normalizePlan(raw, items, nDays) {
  const valid = new Set(items.map((i) => i.id));
  const seen = new Set();
  const days = Array.from({ length: nDays }, () => []);
  const src = Array.isArray(raw?.days) ? raw.days : [];
  src.slice(0, nDays).forEach((d, di) => {
    if (!Array.isArray(d)) return;
    for (const id of d) {
      if (typeof id === 'string' && valid.has(id) && !seen.has(id)) { seen.add(id); days[di].push(id); }
    }
  });
  const missing = items.filter((i) => !seen.has(i.id));
  // 遺漏的放到目前最少的那天
  for (const it of missing) days.reduce((m, d) => (d.length < m.length ? d : m), days[0]).push(it.id);
  const tips = Array.isArray(raw?.tips) ? raw.tips.slice(0, nDays).map((t) => String(t ?? '').slice(0, 80)) : [];
  // 依使用者想法調整的停留時間與新增的地點(都要驗證)
  const stays = [];
  for (const x of Array.isArray(raw?.stays) ? raw.stays : []) {
    const m = Math.round(Number(x?.minutes));
    if (typeof x?.id === 'string' && valid.has(x.id) && Number.isFinite(m) && m >= 15 && m <= 720 && !stays.some((y) => y.id === x.id)) stays.push({ id: x.id, minutes: m });
  }
  const have = items.map((i) => String(i.name).toLowerCase());
  const adds = [];
  for (const x of Array.isArray(raw?.adds) ? raw.adds : []) {
    const name = String(x?.name ?? '').trim().slice(0, 40);
    const day = Math.round(Number(x?.day));
    const key = name.toLowerCase();
    if (!name || !Number.isInteger(day) || day < 1 || day > nDays) continue;
    if (have.some((h) => h.includes(key) || key.includes(h)) || adds.some((a) => a.name.toLowerCase() === key)) continue;
    adds.push({ name, day, kind: x?.kind === 'meal' ? 'meal' : 'place' });
    if (adds.length >= 3) break;
  }
  return { days, tips, stays, adds };
}

export function parseAiResponse(result) {
  // 舊模型回 {response},較新的模型回 OpenAI 格式 {choices:[{message:{content}}]}
  const r = result?.response ?? result?.choices?.[0]?.message?.content ?? result;
  if (r && typeof r === 'object') return r;
  if (typeof r !== 'string') return null;
  const m = r.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function planTrip(env, items, nDays, fixed = [], instruction = '', lodging = [], draft = null) {
  if (!items.length) return { days: Array.from({ length: nDays }, () => []), tips: [], stays: [], adds: [], usedAi: false };
  const list = items.map((i) => ({
    id: i.id, name: i.name, stayMinutes: i.stay ?? undefined,
    lat: i.lat != null ? +i.lat.toFixed(4) : undefined,
    lng: i.lng != null ? +i.lng.toFixed(4) : undefined,
  }));
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `天數:${nDays}\n住宿:${JSON.stringify(lodging.map((l) => ({ name: l.name, lat: l.lat != null ? +l.lat.toFixed(4) : undefined, lng: l.lng != null ? +l.lng.toFixed(4) : undefined, fromDay: l.day > 0 ? l.day : 1 })))}\n已固定行程:${JSON.stringify(fixed.map((f) => ({ day: f.day, time: f.time, title: f.name })))}\n地點:${JSON.stringify(list)}\n${draft ? `目前草稿(各天的地點 id 順序,使用者可能已手動調整過):${JSON.stringify(draft)}\n請以草稿為基礎,只依使用者的想法做必要的調整,沒被提到的部分盡量不動。\n` : ''}${instruction ? `使用者的想法:${instruction}\n` : ''}請輸出 {"days":[[id,...],...共${nDays}天],"tips":[每天一句提醒,共${nDays}句],"stays":[{"id":"","minutes":60}],"adds":[{"name":"","day":1,"kind":"place"}]}` },
  ];
  const base = { messages, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } };
  // 先要求 json_schema;模型不支援就退回純文字再自行解析。
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: SCHEMA } }, {}]) {
    try {
      const raw = parseAiResponse(await env.AI.run(env.AI_MODEL, { ...base, ...extra }));
      if (raw) return { ...normalizePlan(raw, items, nDays), usedAi: true };
    } catch (e) {
      console.error('AI plan failed', e);
    }
  }
  return { ...fallbackPlan(items, nDays), stays: [], adds: [], usedAi: false };
}
