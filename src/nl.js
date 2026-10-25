// 自然語言行程:「第一天13:00從台灣飛往東京」→ 第 1 天 13:00「航班:台灣 → 東京」。
// 先請 AI 解析;AI 失敗或沒結果時,用規則解析保底(涵蓋常見說法)。

export const KINDS = ['flight', 'transport', 'hotel', 'meal', 'place', 'other'];

const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function cnToNum(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + CN[s[1]];
  if (s.length === 2 && s[1] === '十') return CN[s[0]] * 10;
  if (s.length === 3 && s[1] === '十') return CN[s[0]] * 10 + CN[s[2]];
  return CN[s] ?? NaN;
}

const NUM = '[0-9一二兩三四五六七八九十]+';
const DAY_RE = new RegExp(`(第\\s*(${NUM})\\s*[天日]|最後一[天日]|最後\\s*一天|[Dd]ay\\s*(\\d+)|[Dd](\\d+)(?![0-9]))`, 'g');
const TIME_COLON = /(\d{1,2})\s*[:：]\s*(\d{2})/;
const TIME_DIAN = new RegExp(`(上午|早上|早晨|中午|下午|傍晚|晚上|晚間)?\\s*(${NUM})\\s*[點点]\\s*(半|(\\d{1,2})\\s*分?)?`);

function pad(n) { return String(n).padStart(2, '0'); }

function applyPeriod(h, period) {
  if (!period) return h;
  if (/下午|傍晚|晚/.test(period) && h < 12) return h + 12;
  if (period === '中午' && h < 11) return h + 12; // 中午1點 → 13:00
  return h;
}

// 找出第一個時間。回傳 { time: 'HH:MM', text: 原文片段 } 或 null
export function findTime(s) {
  let m = TIME_COLON.exec(s);
  if (m && +m[1] < 24 && +m[2] < 60) return { time: `${pad(+m[1])}:${m[2]}`, text: m[0] };
  m = TIME_DIAN.exec(s);
  if (m) {
    const h = applyPeriod(cnToNum(m[2]), m[1]);
    const min = m[3] === '半' ? 30 : m[4] ? +m[4] : 0;
    if (h >= 0 && h < 24 && min < 60) return { time: `${pad(h)}:${pad(min)}`, text: m[0] };
  }
  // 只說「中午」沒給鐘點
  m = /中午(?![0-9一二兩三四五六七八九十點点])/.exec(s);
  if (m) return { time: '12:00', text: m[0] };
  return null;
}

// 找出第一個「第幾天」。回傳 { day, text } 或 null;「最後一天」回傳 day = nDays
export function findDay(s, nDays) {
  DAY_RE.lastIndex = 0;
  const m = DAY_RE.exec(s);
  if (!m) return null;
  if (/最後/.test(m[0])) return { day: nDays, text: m[0] };
  const n = cnToNum(m[2] ?? m[3] ?? m[4]);
  return Number.isFinite(n) ? { day: n, text: m[0] } : null;
}

const strip = (s) => s.replace(/^[\s,，。；;、:：的在]+|[\s,，。；;、:：]+$/g, '');

export function hasScheduleCue(text) {
  DAY_RE.lastIndex = 0;
  return DAY_RE.test(text) || !!findTime(text) || /(飛|航班|機票|搭|坐|入住|退房|check.?in|check.?out|出發|抵達|住宿|訂位|預約)/i.test(text);
}

export function classify(text) {
  if (/(飛|航班|機票|飛機)/.test(text)) return 'flight';
  if (/(入住|退房|住宿|飯店|旅館|民宿|check.?in|check.?out)/i.test(text)) return 'hotel';
  if (/(搭|坐|電車|新幹線|高鐵|巴士|公車|JR|地鐵|捷運|計程車|租車|接駁)/i.test(text)) return 'transport';
  if (/(吃|早餐|午餐|晚餐|宵夜|餐廳|拉麵|壽司|燒肉|居酒屋|咖啡)/.test(text)) return 'meal';
  return 'place';
}

// 「從台灣飛往東京」→「航班:台灣 → 東京」
export function tidyTitle(s, kind) {
  let t = strip(s);
  if (kind === 'flight') {
    const m = /從\s*(.+?)\s*(?:飛往|飛到|飛去|飛抵|搭機前往|搭機到|搭飛機到|搭飛機前往|飛)\s*(.+)/.exec(t);
    if (m) return `航班:${strip(m[1])} → ${strip(m[2])}`;
    const to = /(?:飛往|飛到|飛去|飛抵)\s*(.+)/.exec(t);
    if (to) return `航班:飛往${strip(to[1])}`;
  }
  return t;
}

// 規則解析:依「第N天」切段,每段取時間與內容
export function parseWithRules(text, nDays) {
  const src = String(text);
  DAY_RE.lastIndex = 0;
  const marks = [...src.matchAll(DAY_RE)];
  const segs = [];
  if (!marks.length) segs.push({ day: 0, body: src });
  else {
    if (marks[0].index > 0 && strip(src.slice(0, marks[0].index))) segs.push({ day: 0, body: src.slice(0, marks[0].index) });
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const d = /最後/.test(m[0]) ? nDays : cnToNum(m[2] ?? m[3] ?? m[4]);
      segs.push({ day: d, body: src.slice(m.index + m[0].length, end) });
    });
  }
  const out = [];
  for (const s of segs) {
    // 一段裡有多個項目時(以 、 或 ; 或 換行 分開)各自成一筆;共用同一天
    const parts = s.body.split(/[;；\n]+/).map(strip).filter(Boolean);
    for (const part of parts) {
      const tm = findTime(part);
      const rest = tm ? part.replace(tm.text, ' ') : part;
      const kind = classify(rest);
      const title = tidyTitle(rest.replace(/\s+/g, ' '), kind);
      if (!title) continue;
      out.push({ day: s.day, time: tm?.time ?? null, title, kind, note: '' });
    }
  }
  return out;
}

// 驗證 AI 或規則的輸出:天數超出範圍就當作「尚未安排」、時間格式不對就丟掉
export function normalizeEntries(raw, nDays) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  const out = [];
  for (const e of list.slice(0, 20)) {
    if (!e || typeof e !== 'object') continue;
    const title = String(e.title ?? '').trim().slice(0, 80);
    if (!title) continue;
    let day = Number.parseInt(e.day, 10);
    let badDay = null; // 說了超出行程天數的日子,提醒使用者
    if (!Number.isInteger(day) || day < 0) day = 0;
    else if (day > nDays) { badDay = day; day = 0; }
    let time = typeof e.time === 'string' ? e.time.trim() : null;
    if (time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) time = null;
    if (time) time = time.padStart(5, '0');
    out.push({
      day,
      badDay,
      time: time || null,
      title,
      kind: KINDS.includes(e.kind) ? e.kind : 'other',
      note: String(e.note ?? '').trim().slice(0, 300),
    });
  }
  return out;
}

const SYSTEM = `你是旅遊行程助理。使用者用口語描述行程,請拆成一筆筆行程項目。
規則:
- day:第幾天(整數)。「最後一天」= 總天數。沒說是哪一天就填 0。
- time:24 小時制 "HH:MM";沒說時間就填 null。「下午一點」= "13:00"。
- title:簡短標題,使用繁體中文。航班寫成「航班:出發地 → 目的地」。
- kind 只能是 flight(飛機)、transport(其他交通)、hotel(住宿)、meal(餐飲)、place(景點)、other。
- note:額外資訊(班機號碼、訂位代號等),沒有就空字串。
- 只輸出 JSON,不要新增使用者沒說的項目。`;

const SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          time: { type: ['string', 'null'] },
          title: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          note: { type: 'string' },
        },
        required: ['day', 'time', 'title', 'kind'],
      },
    },
  },
  required: ['entries'],
};

import { parseAiResponse } from './plan.js';

export async function parseNaturalLanguage(env, text, nDays) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `總天數:${nDays}\n使用者說:${text}\n請輸出 {"entries":[{"day":1,"time":"13:00","title":"...","kind":"flight","note":""}]}` },
  ];
  const base = { messages, max_tokens: 1000, chat_template_kwargs: { enable_thinking: false } };
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: SCHEMA } }, {}]) {
    try {
      const raw = parseAiResponse(await env.AI.run(env.AI_MODEL, { ...base, ...extra }));
      const entries = normalizeEntries(raw, nDays);
      if (entries.length) return { entries, usedAi: true };
    } catch (e) {
      console.error('AI parse failed', e);
    }
  }
  return { entries: normalizeEntries(parseWithRules(text, nDays), nDays), usedAi: false };
}
