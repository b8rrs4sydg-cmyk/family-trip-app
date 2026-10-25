import { haversineKm, suggestStay, isLodging } from '../public/geo.js';
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

// ---- 行程類型、時間與負荷(AI 重排與插入共用)----
const THEME = /樂園|遊樂園|迪士尼|環球影城|Disney|Universal|Puroland|ピューロ|ディズニー|ユニバーサル|ランド|シー\b|哈利波特|Studio|スタジオ|動物園|海洋公園/i;
const DAY_BUDGET = 10 * 60; // 一天排滿大約這麼多分鐘(停留時間加總)

// 這個項目大概要待多久:使用者設的優先,否則依名稱與類型估
export const stayOf = (it) => it?.stay ?? suggestStay(it?.name, it?.kind || 'place') ?? 0;
// 整天等級的大型行程(樂園等):一天最多排一個
export const isHeavy = (it) => !!it && it.kind !== 'meal' && !isLodging(it) && (THEME.test(String(it.name ?? '')) || stayOf(it) >= 240);
// 餐飲落在一天的哪個位置(0=一開始、1=最後):早餐/市場偏前、晚餐類偏後、其餘中間
export function mealTarget(it) {
  const n = String(it?.name ?? '');
  if (/早餐|早午餐|早安|モーニング|咖啡|喫茶|市場|Market|朝/i.test(n)) return 0.2;
  if (/燒肉|焼肉|燒鳥|焼鳥|居酒屋|壽喜燒|すき焼|鐵板|晚餐|ディナー|酒吧|Bar|BBQ|烤肉|火鍋/i.test(n)) return 0.95;
  return 0.5;
}
const dayLoad = (list) => list.reduce((m, x) => m + (isLodging(x) || x.kind === 'flight' || x.kind === 'transport' ? 0 : stayOf(x)), 0);

// 把一個還沒排的地點插進「最合適」的一天與位置。評分(越小越好):
//  - 路線多繞的公里數、當天已有幾個項目
//  - 當天停留時間加總超過預算的部分
//  - 大型行程(樂園)不和另一個大型行程同一天
//  - 餐飲要放在合理的用餐時段(早餐前面、晚餐後面)
// dayLists:[[item,...]...](第 1 天起,已排好的項目,含指定天數的航班等)。有座標的才比較距離,沒座標的放進最少的那天最後。
export function insertNearest(dayLists, item) {
  const hasXY = (x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng);
  const heavy = isHeavy(item), mins = stayOf(item), meal = item.kind === 'meal';
  // 與距離無關的懲罰:這天的負荷與大型行程衝突
  const dayPenalty = (list) => (heavy && list.some(isHeavy) ? 1000 : 0) + Math.max(0, dayLoad(list) + mins - DAY_BUDGET) / 3;
  const slotPenalty = (list, at) => (meal && list.length ? 12 * Math.abs(at / list.length - mealTarget(item)) : 0);
  if (!hasXY(item)) {
    let b = 0, bc = Infinity;
    dayLists.forEach((l, i) => { const c = l.length + dayPenalty(l); if (c < bc) { bc = c; b = i; } });
    dayLists[b].push(item);
    return;
  }
  let best = null;
  dayLists.forEach((list, d) => {
    const pts = list.map((x, i) => ({ x, i })).filter((p) => hasXY(p.x));
    const base = dayPenalty(list);
    // 這一天沒有任何有座標的項目:只算人數(很空的天優先)
    if (!pts.length) { const c = 3 + list.length * 0.8 + base + slotPenalty(list, list.length); if (!best || c < best.c) best = { c, d, i: list.length }; return; }
    for (let k = 0; k <= pts.length; k++) {
      const prev = pts[k - 1]?.x, next = pts[k]?.x;
      const detour = prev && next ? haversineKm(prev, item) + haversineKm(item, next) - haversineKm(prev, next) : haversineKm(prev || next, item);
      const at = k === pts.length ? list.length : pts[k].i; // 插在第 k 個有座標項目之前
      const c = detour + list.length * 0.8 + base + slotPenalty(list, at);
      if (!best || c < best.c) best = { c, d, i: at };
    }
  });
  dayLists[best.d].splice(best.i, 0, item);
}

// AI 排完後的檢查:同一天有兩個以上大型行程(樂園)時,把多的拿出來重新放到合適的別天。
// keep:不能動的項目 id(固定時間等)。
export function spreadHeavy(dayLists, keep = new Set()) {
  for (const list of dayLists) {
    while (list.filter(isHeavy).length >= 2) {
      const x = [...list].reverse().find((y) => isHeavy(y) && !keep.has(y.id));
      if (!x) break;
      list.splice(list.indexOf(x), 1);
      insertNearest(dayLists, x);
      if (dayLists.every((l) => l.filter(isHeavy).length >= 1) && list.filter(isHeavy).length >= 2) break; // 每天都有了,放不下就算了
    }
  }
  return dayLists;
}
