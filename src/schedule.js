import { haversineKm } from '../public/geo.js';
// 決定新項目在某一天裡的位置。純函式,方便測試。
//
// 規則(使用者之後都可以用 ↑↓ 微調):
// - 有時間的項目:依時間插在其他「有時間」的項目之間。
// - 當天沒有其他有時間的項目時:
//   第一天的航班/交通放最前面(抵達後才開始玩)、最後一天的放最後(要趕去機場);
//   其餘依時間:早上排前面、傍晚以後排後面、中間排中間。
// - 沒有時間:放當天最後。

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? +m[1] * 60 + +m[2] : null;
};

export function insertIndex(dayItems, item, day, nDays) {
  const t = toMin(item.time);
  if (t == null) return dayItems.length;

  const timed = dayItems
    .map((it, i) => ({ i, m: toMin(it.time) }))
    .filter((x) => x.m != null);

  if (timed.length) {
    const later = timed.find((x) => x.m > t);
    if (later) return later.i;
    return timed[timed.length - 1].i + 1;
  }

  const transit = item.kind === 'flight' || item.kind === 'transport';
  if (transit && day === 1 && nDays > 1) return 0;
  if (transit && day === nDays && nDays > 1) return dayItems.length;
  if (t < 12 * 60) return 0;
  if (t >= 17 * 60) return dayItems.length;
  return Math.floor(dayItems.length / 2);
}

// 把固定在某天的項目(使用者用自然語言指定的)併入 AI 排好的各天。
// days: [[item,...],...](第 1 天起);fixed: [{id,day,time,kind},...]
export function mergeFixed(days, fixed) {
  const out = days.map((d) => [...d]);
  const sorted = [...fixed].sort((a, b) => (toMin(a.time) ?? 1e9) - (toMin(b.time) ?? 1e9));
  for (const f of sorted) {
    const d = out[f.day - 1];
    if (!d) continue;
    d.splice(insertIndex(d, f, f.day, out.length), 0, f);
  }
  return out;
}

export // 把一個還沒排的地點插進「最順路」的一天與位置:找出讓路線多繞最少的地方,並稍微避免全擠在同一天。
// dayLists:[[item,...]...](第 1 天起,已排好的項目,含指定天數的航班等)。有座標的才比較距離,沒座標的放進最少的那天最後。
function insertNearest(dayLists, item) {
  const hasXY = (x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng);
  if (!hasXY(item)) {
    const d = dayLists.reduce((m, l, i) => (l.length < dayLists[m].length ? i : m), 0);
    dayLists[d].push(item);
    return;
  }
  let best = null;
  dayLists.forEach((list, d) => {
    const pts = list.map((x, i) => ({ x, i })).filter((p) => hasXY(p.x));
    // 這一天沒有任何有座標的項目:只算人數(很空的天優先)
    if (!pts.length) { const c = 3 + list.length * 0.8; if (!best || c < best.c) best = { c, d, i: list.length }; return; }
    for (let k = 0; k <= pts.length; k++) {
      const prev = pts[k - 1]?.x, next = pts[k]?.x;
      const detour = prev && next ? haversineKm(prev, item) + haversineKm(item, next) - haversineKm(prev, next) : haversineKm(prev || next, item);
      const c = detour + list.length * 0.8;
      const at = k === pts.length ? list.length : pts[k].i; // 插在第 k 個有座標項目之前
      if (!best || c < best.c) best = { c, d, i: at };
    }
  });
  dayLists[best.d].splice(best.i, 0, item);
}
