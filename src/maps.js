// Google Maps 連結解析:短網址展開 → 地點名稱 + 座標。不需要 Google API。

const ALLOWED = [
  /^maps\.app\.goo\.gl$/,
  /^goo\.gl$/,
  /^(www\.)?google\.[a-z.]+$/,
  /^maps\.google\.[a-z.]+$/,
  /^consent\.google\.[a-z.]+$/,
];
const isAllowedHost = (h) => ALLOWED.some((re) => re.test(h));

export function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return { url: null, hint: String(text).trim() };
  const hint = String(text).replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { url: m[0], hint };
}

// 手動追蹤重新導向,每一跳都檢查網域白名單(避免被拿來打任意網址)。
export async function resolveUrl(url, fetchFn = fetch) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const u = new URL(cur);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
    if (!isAllowedHost(u.hostname)) throw new Error('不是 Google 地圖連結');
    if (/^consent\.google\./.test(u.hostname)) {
      const c = u.searchParams.get('continue');
      if (c) { cur = c; continue; }
    }
    // 長網址本身已含資訊,不必再抓
    if (/\/maps\/(place|search|dir)\b/.test(u.pathname) || u.searchParams.has('q')) return cur;
    const res = await fetchFn(cur, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; FamilyTrip/1.0)' },
    });
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400) { cur = new URL(loc, cur).toString(); continue; }
    return cur;
  }
  return cur;
}

const dec = (s) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
};
const COORD_ONLY = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const COORD_IN = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
const inRange = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const isCoord = (s) => { const m = COORD_ONLY.exec(s); return !!m && inRange(+m[1], +m[2]); };

// 從網址取出地點名稱與座標。Google 地圖有很多種網址,依可靠程度由高到低嘗試:
//   !3d緯度!4d經度(地點本身)→ /@緯度,經度(畫面中心,次選)→ 路徑裡的座標(/maps/search/35.6,139.4)
//   → ?q= / ?ll= / ?center= / ?destination= 裡的座標。名稱則看 /place/名稱、/dir/起點/終點、?q=名稱。
export function parseMapsUrl(finalUrl) {
  const u = new URL(finalUrl);
  const segs = u.pathname.split('/').filter(Boolean).map(dec);
  let name = null, lat = null, lng = null;

  const mi = segs.indexOf('maps');
  const rest = mi >= 0 ? segs.slice(mi + 1) : segs;
  const kind = rest[0]; // place | search | dir | @lat,lng | ...
  const isData = (x) => /^data=/.test(x) || /^@/.test(x) || /^am=/.test(x);

  if (kind === 'place' || kind === 'search') {
    const cand = rest[1];
    if (cand && !isData(cand) && !isCoord(cand)) name = cand;
  } else if (kind === 'dir') {
    const stops = rest.slice(1).filter((x) => !isData(x));
    const last = stops[stops.length - 1];
    if (last && !isCoord(last)) name = last;
  }
  if (!name) {
    const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('destination');
    if (q && !isCoord(q) && !/^place_id:/i.test(q)) name = q;
  }

  const full = u.pathname + u.search + u.hash;
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(full) || /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decodeURIComponent(full.replace(/%(?![0-9a-f]{2})/gi, '%25')));
  const view = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(full);
  // 導航路線網址裡的 @ 是畫面中心,不是終點:有終點名稱就不用它,改用名稱去查位置
  let m = pin || (kind === 'dir' && name ? null : view);
  if (!m) {
    // 路徑裡直接寫座標,例如 /maps/search/35.6246,139.4262 或 /maps/place/35.62,139.42
    for (const x of rest) { const c = COORD_ONLY.exec(x); if (c && inRange(+c[1], +c[2])) { m = c; break; } }
  }
  if (!m) {
    for (const key of ['q', 'query', 'll', 'center', 'destination', 'sll']) {
      const v = u.searchParams.get(key);
      const c = v && COORD_ONLY.exec(v);
      if (c && inRange(+c[1], +c[2])) { m = c; break; }
    }
  }
  if (m) { lat = parseFloat(m[1]); lng = parseFloat(m[2]); }
  if (name && (isCoord(name) || COORD_IN.test(name) && name.length < 30)) name = null;
  return { name, lat, lng, cid: u.searchParams.get('cid') || null };
}

export async function importPlace(text, fetchFn = fetch) {
  const { url, hint } = extractUrl(text);
  if (!url) return { name: hint.slice(0, 80) || null, lat: null, lng: null, url: null };
  const finalUrl = await resolveUrl(url, fetchFn);
  const p = parseMapsUrl(finalUrl);
  // 有座標但網址沒有名稱:用使用者一起貼的文字,再不行就先叫「地圖上的地點」,使用者可以在編輯裡改名
  const name = (p.name || hint || (p.lat != null ? '地圖上的地點' : '')).slice(0, 80) || null;
  return {
    name,
    lat: p.lat,
    lng: p.lng,
    url, // 保留使用者貼的原始連結,點開就是 Google 地圖
    cid: p.cid,
  };
}
