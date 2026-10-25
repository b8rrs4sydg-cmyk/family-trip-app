// 航班輸入:「IT202 1/15 14:25-18:35」→ 航班項目。沒有可靠的免費即時航班資料,
// 所以航空公司與常見航線用內建表辨識,起降時間由使用者填(訂位確認信上有),時差與飛行時間自動算。
import { isoDate } from '../public/geo.js';

// IATA 機場:名稱、座標、時區(小時,不處理夏令時間;這幾個地區都沒有)
export const AIRPORTS = {
  TPE: { name: '桃園國際機場', city: '台北', lat: 25.0777, lng: 121.2328, tz: 8 },
  TSA: { name: '松山機場', city: '台北', lat: 25.0694, lng: 121.5525, tz: 8 },
  KHH: { name: '高雄國際機場', city: '高雄', lat: 22.5771, lng: 120.3500, tz: 8 },
  RMQ: { name: '台中國際機場', city: '台中', lat: 24.2647, lng: 120.6208, tz: 8 },
  NRT: { name: '成田國際機場', city: '東京', lat: 35.7720, lng: 140.3929, tz: 9 },
  HND: { name: '羽田機場', city: '東京', lat: 35.5494, lng: 139.7798, tz: 9 },
  KIX: { name: '關西國際機場', city: '大阪', lat: 34.4320, lng: 135.2304, tz: 9 },
  ITM: { name: '大阪伊丹機場', city: '大阪', lat: 34.7855, lng: 135.4382, tz: 9 },
  NGO: { name: '中部國際機場', city: '名古屋', lat: 34.8584, lng: 136.8054, tz: 9 },
  CTS: { name: '新千歲機場', city: '札幌', lat: 42.7752, lng: 141.6923, tz: 9 },
  FUK: { name: '福岡機場', city: '福岡', lat: 33.5859, lng: 130.4510, tz: 9 },
  OKA: { name: '那霸機場', city: '沖繩', lat: 26.1958, lng: 127.6459, tz: 9 },
  ICN: { name: '仁川國際機場', city: '首爾', lat: 37.4602, lng: 126.4407, tz: 9 },
  BKK: { name: '素萬那普機場', city: '曼谷', lat: 13.6900, lng: 100.7501, tz: 7 },
  SIN: { name: '樟宜機場', city: '新加坡', lat: 1.3644, lng: 103.9915, tz: 8 },
  HKG: { name: '香港國際機場', city: '香港', lat: 22.3080, lng: 113.9185, tz: 8 },
};

export const AIRLINES = {
  IT: '台灣虎航', CI: '中華航空', BR: '長榮航空', JX: '星宇航空', AE: '華信航空', B7: '立榮航空',
  JL: '日本航空', NH: '全日空', MM: '樂桃航空', GK: '捷星日本', TR: '酷航', CX: '國泰航空',
  KE: '大韓航空', OZ: '韓亞航空', SQ: '新加坡航空', TG: '泰國航空', UO: '香港快運', '7C': '濟州航空',
};

// 已知的固定航線(航班號 → 起訖)。查得到的才放;其餘讓使用者自己寫「TPE→NRT」。
const KNOWN = { IT201: ['NRT', 'TPE'], IT202: ['TPE', 'NRT'] };

const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// 起降當地時間 + 兩地時區 → 飛行分鐘數(跨日自動補 24 小時)
export function flightMinutes(depTime, arrTime, depTz, arrTz) {
  const d = toMin(depTime), a = toMin(arrTime);
  if (d == null || a == null) return null;
  let m = (a - arrTz * 60) - (d - depTz * 60);
  while (m <= 0) m += 1440;
  return m <= 24 * 60 ? m : null;
}

// text → { code, airline, from, to, day, time, arrive, minutes } | null。
// opts:{ startDate: 'YYYY-MM-DD', nDays }。偵測不到已知航空公司的航班號就回 null(避免把一般文字誤判成航班)。
export function parseFlightInput(text, { startDate = null, nDays = 1 } = {}) {
  const src = String(text ?? '');
  const m = /(?:^|[^A-Za-z0-9])([A-Za-z]{2}|[A-Za-z]\d|\d[A-Za-z])\s?(\d{1,4})(?![\d:])/.exec(src);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  if (!AIRLINES[prefix]) return null;
  const code = `${prefix}${m[2]}`;
  const rest = src.replace(m[0], ' ');

  // 起訖:先用明寫的 IATA(TPE→NRT),再用已知航班號
  let from = null, to = null;
  const r = /\b([A-Za-z]{3})\s*(?:→|->|=>|-|至|到|~)\s*([A-Za-z]{3})\b/.exec(rest);
  if (r && AIRPORTS[r[1].toUpperCase()] && AIRPORTS[r[2].toUpperCase()]) { from = r[1].toUpperCase(); to = r[2].toUpperCase(); }
  else if (KNOWN[code]) [from, to] = KNOWN[code];

  // 起降時間:14:25-18:35,或只有一個時間(起飛)
  const times = [...rest.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1].padStart(5, '0')).filter((t) => toMin(t) != null && toMin(t) < 1440);
  const time = times[0] ?? null, arrive = times[1] ?? null;

  // 日期:1/15、2027/1/15、1月15日;或「第 N 天」
  let day = 0;
  const dm = /(?:(\d{4})[/.\-年])?(\d{1,2})[/.\-月](\d{1,2})日?/.exec(rest.replace(/\d{1,2}:\d{2}/g, ' '));
  if (dm && startDate) {
    const mo = +dm[2], dd = +dm[3];
    const y = dm[1] ? +dm[1] : +startDate.slice(0, 4);
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    for (let i = 1; i <= nDays; i++) if (isoDate(startDate, i) === iso) { day = i; break; }
  }
  if (!day) { const n = /第\s*([一二三四五六七八九十\d]+)\s*天/.exec(rest); if (n) { const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; const v = map[n[1]] ?? +n[1]; if (v >= 1 && v <= nDays) day = v; } }

  const A = from && AIRPORTS[from], B = to && AIRPORTS[to];
  const minutes = A && B ? flightMinutes(time, arrive, A.tz, B.tz) : null;
  return { code, airline: AIRLINES[prefix], from, to, day, time, arrive, minutes };
}

// 解析結果 → 要加入的項目欄位。地圖上的位置:去程放目的地機場、回程放出發地機場(都在旅遊地)
export function flightItem(f, { nDays = 1 } = {}) {
  const A = f.from && AIRPORTS[f.from], B = f.to && AIRPORTS[f.to];
  const outbound = f.day === 1 || (!f.day && !!B && B.city !== '台北');
  const pin = A && B ? (f.day === nDays && nDays > 1 ? A : outbound ? B : A) : (B || A || null);
  const route = A && B ? `${A.city} ${f.from} → ${B.city} ${f.to}` : f.code;
  const bits = [f.airline, f.arrive ? `抵達 ${f.arrive}(當地)` : null, !A || !B ? '請補上起訖,例如 TPE→NRT' : null, !f.time ? '請補上起飛時間(訂位確認信上有)' : null].filter(Boolean);
  return {
    name: `${f.code} ${route}`,
    kind: 'flight',
    day: f.day || 0,
    time: f.time,
    stay: f.minutes,
    note: bits.join(' · '),
    lat: pin?.lat ?? null,
    lng: pin?.lng ?? null,
    airport: pin ? `${pin.name}` : null,
  };
}
