// 地名 → 座標。用 OpenStreetMap 的 Nominatim(免金鑰)。
// 使用規範:每秒最多 1 次、要帶可辨識的 User-Agent、結果要快取 → 查到的座標存進資料庫,同一地點不會重查。

const UA = 'family-trip/1.0 (+https://github.com/b8rrs4sydg-cmyk/Trip)';

// 「去淺草寺」→「淺草寺」;括號內的補充說明去掉
export function queryFromTitle(title) {
  return String(title)
    .replace(/^(去|到|前往|逛逛?|參觀|遊覽|拜訪)\s*/, '')
    .replace(/[(（].*$/, '')
    .trim();
}

// 以已知地點的範圍當作偏好區域,避免「中央車站」跑到別的國家。回傳 'left,top,right,bottom' 或 null
export function viewbox(points, pad = 2) {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const f = (n) => n.toFixed(4);
  return [f(Math.min(...lngs) - pad), f(Math.max(...lats) + pad), f(Math.max(...lngs) + pad), f(Math.min(...lats) - pad)].join(',');
}

export const DEFAULT_BASE = 'https://nominatim.openstreetmap.org';

// base 可以換成自架的 Nominatim 或相容服務(wrangler.jsonc 的 GEOCODE_BASE)
export async function geocode(title, near = [], fetchFn = fetch, base = DEFAULT_BASE) {
  const q = queryFromTitle(title);
  if (!q) return null;
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '1', 'accept-language': 'zh-TW' });
  const vb = viewbox(near);
  if (vb) params.set('viewbox', vb); // bounded 預設為 0:只是優先,不是限制
  const res = await fetchFn(`${base}/search?${params}`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const [hit] = await res.json();
  const lat = Number(hit?.lat), lng = Number(hit?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
