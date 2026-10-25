// 站與站之間的移動時間。
// 有設定 GOOGLE_MAPS_API_KEY → 用 Google Routes API:開車含即時路況、大眾運輸用班表(含即時誤點資訊)、
//   若指定了未來的出發時間,則是依該時間預測。
// 沒設定(或 Google 回不出來)→ 步行/開車退回 OSM 道路路網計算(只有距離與道路時間,沒有路況);
//   大眾運輸沒有免費來源,回 none,由前端用直線距離估算。

export const MODES = ['walk', 'transit', 'drive'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const validPoint = (p) => p && num(p.lat) !== null && num(p.lng) !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export { departureISO } from '../public/geo.js';

// 出發時間必須在合理範圍內(Google 只接受現在到未來約 100 天);過去或太遠的一律當作「現在」
export function sanitizeDeparture(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  if (t < now + 60_000 || t > now + 90 * 86_400_000) return null;
  return new Date(t).toISOString();
}

const km2 = (meters) => Math.round(meters / 10) / 100;
const secs = (s) => { const n = Number.parseFloat(String(s ?? '').replace('s', '')); return Number.isFinite(n) ? n : null; };

export async function googleRoute(key, from, to, mode, departure, fetchFn = fetch) {
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: { walk: 'WALK', transit: 'TRANSIT', drive: 'DRIVE' }[mode],
    languageCode: 'zh-TW',
    units: 'METRIC',
  };
  if (mode === 'drive') body.routingPreference = 'TRAFFIC_AWARE';
  if (departure && mode !== 'walk') body.departureTime = departure;
  const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
      'x-goog-fieldmask': 'routes.duration,routes.staticDuration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`google routes ${res.status}`);
  const r = (await res.json()).routes?.[0];
  const d = secs(r?.duration);
  if (d === null) return null; // 查無路線(例如這兩點之間沒有大眾運輸)
  const base = secs(r?.staticDuration);
  return {
    source: 'google',
    mode,
    min: Math.max(1, Math.round(d / 60)),
    km: km2(r.distanceMeters ?? 0),
    // 只有開車才有「塞車多花幾分鐘」的概念
    delayMin: mode === 'drive' && base !== null ? Math.max(0, Math.round((d - base) / 60)) : null,
    predicted: !!departure,
  };
}

export const OSRM_BASE = 'https://routing.openstreetmap.de';

// base 可換成自架的 OSRM(wrangler.jsonc 的 OSRM_BASE;路徑格式 /routed-foot、/routed-car)
export async function osrmRoute(from, to, mode, fetchFn = fetch, base = OSRM_BASE) {
  if (mode === 'transit') return null;
  const profile = mode === 'walk' ? 'routed-foot' : 'routed-car';
  const url = `${base}/${profile}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const res = await fetchFn(url, { headers: { 'user-agent': 'family-trip/1.0 (+https://github.com/b8rrs4sydg-cmyk/Trip)' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`osrm ${res.status}`);
  const r = (await res.json()).routes?.[0];
  if (!r || num(r.duration) === null) return null;
  return { source: 'osrm', mode, min: Math.max(1, Math.round(r.duration / 60)), km: km2(r.distance), delayMin: null, predicted: false };
}

// useGoogle=false:只用免費的 OSM 路網(用在「不是今天、也不在近期」的行程,不浪費 Google 額度)
export async function computeRoute(env, { from, to, mode, departure, useGoogle = true }, fetchFn = fetch) {
  if (env.GOOGLE_MAPS_API_KEY && useGoogle) {
    try {
      const r = await googleRoute(env.GOOGLE_MAPS_API_KEY, from, to, mode, departure, fetchFn);
      if (r) return r;
    } catch (e) { console.error('google route failed', e); }
  }
  try {
    const r = await osrmRoute(from, to, mode, fetchFn, env.OSRM_BASE || undefined);
    if (r) return r;
  } catch (e) { console.error('osrm route failed', e); }
  return { source: 'none', mode };
}
