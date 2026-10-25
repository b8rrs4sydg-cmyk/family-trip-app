// 地名 → 座標(伺服器端)。使用規範:Nominatim 每秒最多 1 次、要帶可辨識的 User-Agent,
// 查到的座標存進資料庫,同一地點不會重查。伺服器查不到時,瀏覽器會用自己的網路再查一次(public/index.html)。
import { geocodeWith, queryFromTitle, viewbox, NOMINATIM } from '../public/geocoding.js';

export { queryFromTitle, viewbox };
export const DEFAULT_BASE = NOMINATIM;

const UA = 'family-trip/1.0 (+https://github.com/b8rrs4sydg-cmyk/Trip)';

// bases:{ nominatim, photon } 可換成自架的服務(wrangler.jsonc 的 GEOCODE_BASE、PHOTON_BASE)
export function geocode(title, near = [], fetchFn = fetch, bases = {}) {
  return geocodeWith(title, near, fetchFn, bases, { 'user-agent': UA });
}
