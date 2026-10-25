// 大眾運輸怎麼搭:先用 OpenStreetMap(Overpass)找出起訖點附近的車站與路線,
// 再請 AI 依這些真實資料組出一段「搭什麼線、在哪站上下車」的說明。
// 沒有免費的即時班表資料,所以這是「建議搭法」,實際請以導航為準。
import { parseAiResponse } from './plan.js';
import { haversineKm } from '../public/geo.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const UA = 'family-trip/1.0 (+https://github.com/b8rrs4sydg-cmyk/Trip)';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'steps'],
};

const SYSTEM = `你是日本與台灣大眾運輸的專家,幫帶長輩出遊的家庭說明「從 A 到 B 怎麼搭」。用繁體中文,簡短好懂。
規則:
- 只使用真實存在的路線與車站;下面的「附近車站」「附近路線」是從地圖資料查到的,優先採用。
- steps 每一步一句話,例如:「淺草站搭東京メトロ銀座線(往澀谷)」「在溜池山王站轉乘南北線」「赤羽橋站下車,步行約 5 分鐘」。最多 4 步。
- summary 一句話總結(40 字內),例如:「淺草站搭銀座線,在溜池山王站轉南北線,到麻布十番步行 8 分」。
- 距離很近、不需要搭車時,說明步行或搭一站即可。
- 不確定、或這段不適合搭大眾運輸(太近、沒有直達也不好轉乘)時,不要編造:steps 留空陣列,summary 留空字串。不要輸出 null。不要寫票價或發車時間。
- 只輸出 JSON。`;

// ---- 附近的車站與路線 ----
export function parseOverpass(json, point) {
  const els = Array.isArray(json?.elements) ? json.elements : [];
  const seen = new Set();
  const stations = [];
  const lines = new Set();
  for (const e of els) {
    const t = e.tags || {};
    if (e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)) {
      const name = t['name:zh'] || t.name || t['name:ja'] || t['name:en'];
      const key = t['name:ja'] || t.name || name;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      stations.push({ name, ja: t['name:ja'] || t.name || '', km: haversineKm(point, { lat: e.lat, lng: e.lon }) });
    } else if (e.type === 'relation') {
      const raw = String(t.name || t.ref || '');
      const line = raw.split(/[::]/)[0].trim();
      if (line && line.length <= 40) lines.add(line);
    }
  }
  stations.sort((a, b) => a.km - b.km);
  return {
    stations: stations.slice(0, 4).map((s) => ({ name: s.name, ja: s.ja, meters: Math.round(s.km * 1000 / 10) * 10 })),
    lines: [...lines].slice(0, 12),
  };
}

export async function nearbyTransit(point, fetchFn = fetch) {
  const q = `[out:json][timeout:10];node(around:1000,${point.lat},${point.lng})[railway~"^(station|halt)$"]->.s;.s out body;rel(bn.s)[type=route][route~"^(subway|train|light_rail|monorail)$"];out tags;`;
  const one = async (base) => {
    const res = await fetchFn(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: `data=${encodeURIComponent(q)}`,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${new URL(base).host} ${res.status}`);
    return parseOverpass(await res.json(), point);
  };
  // 幾個鏡像同時問,誰先答就用誰(單一鏡像常常忙線)
  try { return await Promise.any(OVERPASS.map(one)); }
  catch (e) { console.error('overpass failed', e); return { stations: [], lines: [], err: (e.errors || [e]).map((x) => x.message).join('; ') }; }
}

// AI 有時會填入 null、無、N/A 這類字串;視為沒有內容
const EMPTY = /^(null|undefined|none|n\/?a|nil|無|没有|沒有|不適用|不详|不詳|未知|-|—)$/i;
const clean = (v, n) => {
  if (v == null || typeof v === 'object') return '';
  const t = String(v).trim().slice(0, n);
  return EMPTY.test(t) ? '' : t;
};
const GIVE_UP = /建議用導航|請用導航|無法提供|沒有合適|查不到/;

// 只有「有具體搭乘步驟」才算有建議;否則回 null,前端就不會顯示大眾運輸的建議
export function normalizeTransit(raw) {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, 4);
  const summary = clean(raw?.summary, 120);
  if (!steps.length || GIVE_UP.test(summary)) return null;
  return { summary: summary || steps[0], steps };
}

const fmtNear = (n) => `${n.stations.map((s) => `${s.name}${s.ja && s.ja !== s.name ? `(${s.ja})` : ''}${s.meters}公尺`).join('、') || '(查不到)'};路線:${n.lines.join('、') || '(查不到)'}`;

export async function transitAdvice(env, { from, to }, fetchFn = fetch) {
  const [nf, nt] = await Promise.all([nearbyTransit(from, fetchFn), nearbyTransit(to, fetchFn)]);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `起點:${from.name || '起點'}(${from.lat.toFixed(4)}, ${from.lng.toFixed(4)})\n附近車站:${fmtNear(nf)}\n\n終點:${to.name || '終點'}(${to.lat.toFixed(4)}, ${to.lng.toFixed(4)})\n附近車站:${fmtNear(nt)}\n\n直線距離約 ${haversineKm(from, to).toFixed(1)} 公里。輸出 {"summary":"","steps":[""]}` },
  ];
  const base = { messages, max_tokens: 500, chat_template_kwargs: { enable_thinking: false } };
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: SCHEMA } }, {}]) {
    try {
      const r = normalizeTransit(parseAiResponse(await env.AI.run(env.AI_MODEL, { ...base, ...extra })));
      if (r) return { ...r, from: nf.stations[0]?.name, to: nt.stations[0]?.name, grounded: nf.stations.length > 0 && nt.stations.length > 0, diag: nf.err || nt.err || undefined };
    } catch (e) { console.error('AI transit failed', e); }
  }
  return null;
}
