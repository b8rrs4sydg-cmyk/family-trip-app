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

// bounded:只在已知地點附近找(找不到再放寬),避免「Sanrio Puroland」這種英文名跑到別的城市
export function nominatimUrl(q, near = [], base = NOMINATIM, bounded = false) {
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: '1', namedetails: '1', 'accept-language': 'zh-TW' });
  const vb = viewbox(near);
  if (vb) { p.set('viewbox', vb); if (bounded) p.set('bounded', '1'); }
  return `${base}/search?${p}`;
}

export function photonUrl(q, near = [], base = PHOTON, bounded = false) {
  const p = new URLSearchParams({ q, limit: '1' });
  const pts = near.filter(ok);
  if (pts.length && bounded) { const [l, t, r, b] = viewbox(near).split(','); p.set('bbox', [l, b, r, t].join(',')); }
  if (pts.length) { // 以已知地點的中心當作偏好位置
    p.set('lat', (pts.reduce((s, x) => s + x.lat, 0) / pts.length).toFixed(4));
    p.set('lon', (pts.reduce((s, x) => s + x.lng, 0) / pts.length).toFixed(4));
  }
  return `${base}/api/?${p}`;
}

export function parseNominatim(json) {
  const hit = Array.isArray(json) ? json[0] : null;
  const p = { lat: Number(hit?.lat), lng: Number(hit?.lon), address: hit?.display_name || '', text: [hit?.display_name, hit?.name, ...Object.values(hit?.namedetails || {})].filter(Boolean).join(' ') };
  return ok(p) ? p : null;
}

export function parsePhoton(json) {
  const f = json?.features?.[0];
  const c = f?.geometry?.coordinates;
  const pr = f?.properties || {};
  const p = { lat: Number(c?.[1]), lng: Number(c?.[0]), address: [pr.name, pr.street, pr.housenumber, pr.district, pr.city, pr.state, pr.country].filter(Boolean).join(', '), text: Object.values(f?.properties || {}).filter((v) => typeof v === 'string').join(' ') };
  return ok(p) ? p : null;
}

// 地圖服務對查不到的名稱常會亂猜一個「長得有點像」的地點。中日文名稱至少要有連續兩個字出現在結果裡才採用;
// 英文名稱(結果多半是日文名)無法比對,照單全收。
export function relevant(query, text) {
  const q = String(query).replace(/\s+/g, '');
  if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(q)) return true;
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return true;
  for (let i = 0; i + 1 < q.length; i++) if (t.includes(q.slice(i, i + 2))) return true;
  return false;
}

// 依序試各個服務。有任何一個「回答了」(即使是查無)就算查過;全部都失敗(網路、限流)才丟錯。
const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// maxKm:AI 推薦的地點一定在行程附近,查到離所有已知地點都很遠的結果(同名的外地店)就不採用
export async function geocodeWith(title, near, fetchFn, bases = {}, headers = {}, alts = []) {
  const queries = [...new Set([title, ...alts].map(queryFromTitle).filter(Boolean))];
  if (!queries.length) return null;
  const hasNear = near.some(ok);
  let answered = false;
  let lastErr = null;
  // 先在已知地點附近找,找不到再放寬到全世界
  for (const bounded of hasNear ? [true, false] : [false]) {
    for (const q of queries) {
      const providers = [
        [nominatimUrl(q, near, bases.nominatim, bounded), parseNominatim],
        [photonUrl(q, near, bases.photon, bounded), parsePhoton],
      ];
      for (const [url, parse] of providers) {
        try {
          const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`geocode ${res.status}`);
          answered = true;
          const p = parse(await res.json());
          if (p && relevant(q, p.text) && !(bases.maxKm && hasNear && near.filter(ok).every((n) => km(n, p) > bases.maxKm))) return { lat: p.lat, lng: p.lng, address: p.address || '' };
        } catch (e) { lastErr = e; }
      }
    }
  }
  if (!answered) throw lastErr || new Error('geocode failed');
  return null;
}
