// 當天的「順路排序」:有時間的項目(航班、預約…)是固定的錨點、維持時間順序;
// 其他有座標的地點用「最省繞路」的方式插進去,避免來回折返。沒有座標的項目跟著前一個項目走。
import { haversineKm, hasCoord } from './geo.js';

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? +m[1] * 60 + +m[2] : null;
};

export function orderDay(items) {
  const units = [];
  for (const it of items) {
    const prev = units[units.length - 1];
    if (prev && !hasCoord(it) && toMin(it.time) == null) prev.items.push(it);
    else units.push({ items: [it], t: toMin(it.time), p: hasCoord(it) ? it : null });
  }
  const anchors = units.filter((u) => u.t != null).sort((a, b) => a.t - b.t);
  const free = units.filter((u) => u.t == null && u.p);
  const loose = units.filter((u) => u.t == null && !u.p);
  const path = [...anchors];
  const d = (a, b) => (a?.p && b?.p ? haversineKm(a.p, b.p) : 0);
  const cost = (u, k) => {
    const prev = path[k - 1], next = path[k];
    return d(prev, u) + d(u, next) - d(prev, next);
  };
  const place = (u) => {
    let best = 0, bc = Infinity;
    for (let k = 0; k <= path.length; k++) { const c = cost(u, k); if (c < bc - 1e-9) { bc = c; best = k; } }
    path.splice(best, 0, u);
  };
  for (const u of free) place(u);
  // 再挑一輪:每個自由地點拿出來重新找最好的位置
  for (let r = 0; r < 3; r++) for (const u of free) { path.splice(path.indexOf(u), 1); place(u); }
  return [...path, ...loose].flatMap((u) => u.items);
}

export const pathKm = (items) => items.filter(hasCoord).reduce((s, it, i, a) => s + (i ? haversineKm(a[i - 1], it) : 0), 0);
