// 離線支援:
// - 頁面與程式(同網站的檔案):網路優先,斷線時用上次的版本
// - 行程資料 GET /api/trips/<id>:網路優先,斷線時回傳上次的完整行程,並加上 x-offline 標頭讓畫面顯示「離線中」
// - MapLibre(jsDelivr):快取優先
// 地圖圖磚不快取,離線時地圖底圖會是空白,但地點清單、時間、備註、常用日文句都看得到。
const VER = 'v19';
const SHELL = `shell-${VER}`;
const DATA = `data-${VER}`;
const CDN = `cdn-${VER}`;
const SHELL_URLS = ['/', '/geo.js', '/geocoding.js', '/phrases.js', '/manifest.webmanifest', '/icon.svg'];
const TRIP_RE = /^\/api\/trips\/[a-z0-9]{12}$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA, CDN].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const withHeader = async (res, name, value) => {
  const h = new Headers(res.headers);
  h.set(name, value);
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: h });
};

async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function tripData(req, url) {
  const cache = await caches.open(DATA);
  const key = url.origin + url.pathname; // 不含 ?v=
  try {
    const res = await fetch(req);
    if (res.ok) {
      const body = await res.clone().json().catch(() => null);
      if (body && !body.unchanged) await cache.put(key, res.clone()); // 「沒有變動」的回應不覆蓋完整行程
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return withHeader(hit, 'x-offline', '1');
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      e.respondWith(networkFirst(req, SHELL, '/').catch(async () => (await caches.match('/')) || Response.error()));
    } else if (SHELL_URLS.includes(url.pathname)) {
      e.respondWith(networkFirst(req, SHELL, url.pathname));
    } else if (TRIP_RE.test(url.pathname)) {
      e.respondWith(tripData(req, url));
    }
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(CDN).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await c.put(req, res.clone());
      return res;
    }));
  }
});
