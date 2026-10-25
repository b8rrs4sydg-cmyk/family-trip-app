// 前後端共用的地理與顯示小工具(純函式,方便測試)。

export const DAY_COLORS = ['#2563eb', '#e11d48', '#059669', '#7c3aed', '#ea580c', '#0891b2', '#c026d3', '#65a30d'];
export const dayColor = (day) => (day > 0 ? DAY_COLORS[(day - 1) % DAY_COLORS.length] : '#8a8a8a');

export const hasCoord = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 沒有路網資料時的「估算」:直線距離乘 1.3 當路程。
// auto:1.2 公里內視為步行(每分鐘 75 公尺),再遠視為大眾運輸(時速約 28 公里,另加 8 分鐘等候);
// 也可以指定 walk / transit / drive(開車時速約 35 公里,另加 3 分鐘上下車)。
export function estimateTravel(a, b, mode = 'auto') {
  const road = haversineKm(a, b) * 1.3;
  const m = mode === 'auto' ? (road <= 1.2 ? 'walk' : 'transit') : mode;
  const min = m === 'walk' ? Math.max(1, Math.round((road * 1000) / 75))
    : m === 'drive' ? Math.round(3 + (road / 35) * 60)
    : Math.round(8 + (road / 28) * 60);
  return { mode: m, km: road, min };
}

export function fmtKm(km) {
  return km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} 公尺` : `${km < 10 ? km.toFixed(1) : Math.round(km)} 公里`;
}

export function fmtMin(min) {
  if (min < 60) return `${min} 分鐘`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

export function directionsUrl(a, b, mode) {
  const p = (x) => `${x.lat},${x.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${p(a)}&destination=${p(b)}&travelmode=${{ walk: 'walking', drive: 'driving' }[mode] || 'transit'}`;
}

export const money = (n) => `¥${Math.round(Number(n)).toLocaleString('en-US')}`;

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
// start: 'YYYY-MM-DD';day 從 1 開始。沒有出發日期就回 null。
export function dayDateLabel(start, day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + day - 1));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEK[d.getUTCDay()]})`;
}

// 一鍵複製的行程文字,方便貼到 LINE
export function tripText(trip) {
  const lines = [trip.name];
  const total = trip.items.reduce((s, i) => s + (i.cost || 0), 0);
  if (total) lines.push(`預估花費 ${money(total)}`);
  // 先排好的每一天,「還沒安排」放最後
  for (const d of [...Array.from({ length: trip.days }, (_, i) => i + 1), 0]) {
    const items = trip.items.filter((i) => i.day === d);
    if (!items.length) continue;
    lines.push('');
    lines.push(d === 0 ? '【還沒安排】' : `【第 ${d} 天${dayDateLabel(trip.start_date, d) ? ' ' + dayDateLabel(trip.start_date, d) : ''}】`);
    if (d > 0 && trip.tips?.[d]) lines.push(`💡 ${trip.tips[d]}`);
    for (const i of items) {
      lines.push(`${i.time ? i.time + ' ' : '・'}${i.name}${i.cost ? `(${money(i.cost)})` : ''}${i.note ? ` — ${i.note}` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---- 機票 / 飯店:沒有免費的即時搜尋 API,所以帶入日期與路線,開外部網站搜尋 ----

// 「航班:台灣 → 東京」→ { from: '台灣', to: '東京' }
export function parseFlightTitle(name) {
  const m = /^航班\s*[:：]\s*(.+?)\s*(?:→|->|=>|至)\s*(.+)$/.exec(String(name));
  return m ? { from: m[1].trim(), to: m[2].trim() } : null;
}

// 第 day 天的日期(YYYY-MM-DD);沒有出發日期或 day 不是 1 以上就回 null
export function isoDate(start, day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start || '');
  if (!m || !(day >= 1)) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + day - 1)).toISOString().slice(0, 10);
}

export function flightSearchUrl(item, start) {
  const f = parseFlightTitle(item.name);
  const date = isoDate(start, item.day);
  const q = `${f ? `從${f.from}到${f.to}的機票` : `${item.name} 機票`}${date ? ` ${date}` : ''}`;
  return `https://www.google.com/travel/flights?hl=zh-TW&q=${encodeURIComponent(q)}`;
}

export function hotelSearchUrl(item, start) {
  const name = String(item.name).replace(/^(入住|住宿|住|check[- ]?in)\s*/i, '').trim() || item.name;
  const p = new URLSearchParams({ ss: name });
  const inD = isoDate(start, item.day);
  if (inD) { p.set('checkin', inD); p.set('checkout', isoDate(start, item.day + 1)); }
  return `https://www.booking.com/searchresults.zh-tw.html?${p}`;
}

// 出發時間字串(RFC3339)。沒有時區資料庫,用經度粗估時區(日本 139° → +09:00、台灣 121° → +08:00)。
export function departureISO(date, time, lng) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const t = /^([01]?\d|2[0-3]):[0-5]\d$/.test(time || '') ? time.padStart(5, '0') : '09:00';
  const off = Math.max(-12, Math.min(14, Math.round(lng / 15)));
  return `${date}T${t}:00${off < 0 ? '-' : '+'}${String(Math.abs(off)).padStart(2, '0')}:00`;
}
