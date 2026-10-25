// 地名 → 座標:網址組合與結果解析(伺服器與瀏覽器共用,純函式)。
// 兩個免金鑰的 OpenStreetMap 資料服務:Nominatim 與 Photon。伺服器查不到(被限流)時,瀏覽器會用自己的網路再查一次。

export const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const PHOTON = 'https://photon.komoot.io';

// 「去淺草寺」→「淺草寺」;括號內的補充說明去掉
export function queryFromTitle(title) {
  return String(title)
    .replace(/^(去|到|前往|逛逛?|參觀|遊覽|拜訪|入住|住宿|住在?|退房|在)\s*/, '')
    .replace(/[(（].*$/, '')
    .trim();
}

const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

// 已知地點的範圍(往外各加 pad 度),當作偏好區域,避免「中央車站」跑到別的國家。回傳 'left,top,right,bottom' 或 null
export function viewbox(points, pad = 2) {
  const pts = points.filter(ok);
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const f = (n) => n.toFixed(4);
  return [f(Math.min(...lngs) - pad), f(Math.max(...lats) + pad), f(Math.max(...lngs) + pad), f(Math.min(...lats) - pad)].join(',');
}

export function nominatimUrl(q, near = [], base = NOMINATIM) {
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: '1', 'accept-language': 'zh-TW' });
  const vb = viewbox(near);
  if (vb) p.set('viewbox', vb); // bounded 預設為 0:只是優先,不是限制
  return `${base}/search?${p}`;
}

export function photonUrl(q, near = [], base = PHOTON) {
  const p = new URLSearchParams({ q, limit: '1' });
  const pts = near.filter(ok);
  if (pts.length) { // 以已知地點的中心當作偏好位置
    p.set('lat', (pts.reduce((s, x) => s + x.lat, 0) / pts.length).toFixed(4));
    p.set('lon', (pts.reduce((s, x) => s + x.lng, 0) / pts.length).toFixed(4));
  }
  return `${base}/api/?${p}`;
}

export function parseNominatim(json) {
  const hit = Array.isArray(json) ? json[0] : null;
  const p = { lat: Number(hit?.lat), lng: Number(hit?.lon) };
  return ok(p) ? p : null;
}

export function parsePhoton(json) {
  const c = json?.features?.[0]?.geometry?.coordinates;
  const p = { lat: Number(c?.[1]), lng: Number(c?.[0]) };
  return ok(p) ? p : null;
}

// 依序試各個服務。有任何一個「回答了」(即使是查無)就算查過;全部都失敗(網路、限流)才丟錯。
export async function geocodeWith(title, near, fetchFn, bases = {}, headers = {}) {
  const q = queryFromTitle(title);
  if (!q) return null;
  const providers = [
    [nominatimUrl(q, near, bases.nominatim), parseNominatim],
    [photonUrl(q, near, bases.photon), parsePhoton],
  ];
  let answered = false;
  let lastErr = null;
  for (const [url, parse] of providers) {
    try {
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`geocode ${res.status}`);
      answered = true;
      const p = parse(await res.json());
      if (p) return p;
    } catch (e) { lastErr = e; }
  }
  if (!answered) throw lastErr || new Error('geocode failed');
  return null;
}
