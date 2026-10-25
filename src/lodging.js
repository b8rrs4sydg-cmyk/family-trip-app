// 住宿與每日頭尾:每天從前一晚住的地方出發、最後回到今晚住的地方。純函式,方便測試。
import { isLodging } from '../public/geo.js';

export { isLodging };
export const AI_LODGING = 'AI住宿'; // 由 AI 排行程自動產生的「出發/回住宿」副本會標這個,重排時會先清掉

// hotels: [{id, day}](day 0 = 沒指定天,視為從第 1 天起)。
// 回傳 { head: [[spec]...], tail: [[spec]...] }(各 nDays 天)。spec = { hotel, copy }:
//   copy=false 用原本那個項目(第一次住進去的那天放在當天最後),copy=true 產生一個副本。
//   第 1 天沒有 head(剛抵達),最後一天沒有 tail(要離開)。
export function lodgingPlan(hotels, nDays) {
  const hs = hotels.map((h) => ({ ...h, start: Math.min(Math.max(h.day > 0 ? h.day : 1, 1), nDays) }))
    .sort((a, b) => a.start - b.start);
  const head = Array.from({ length: nDays }, () => []);
  const tail = Array.from({ length: nDays }, () => []);
  if (!hs.length) return { head, tail };
  const at = (d) => hs.reduce((cur, h) => (h.start <= d ? h : cur), hs[0]);
  const used = new Set();
  for (let d = 1; d <= nDays; d++) {
    if (d > 1) head[d - 1].push({ hotel: at(d - 1), copy: true });
    if (d < nDays) {
      const h = at(d);
      tail[d - 1].push({ hotel: h, copy: used.has(h.id) });
      used.add(h.id);
    }
  }
  // 只住在最後一天的(沒有出現在任何一天的「回住宿」),原本的項目放在最後一天最前面
  for (const h of hs) if (!used.has(h.id)) head[nDays - 1].unshift({ hotel: h, copy: false });
  return { head, tail };
}
