import { test } from 'node:test';
import { departureISO } from '../public/geo.js';
import assert from 'node:assert/strict';
import { sanitizeDeparture, googleRoute, osrmRoute, computeRoute, validPoint } from '../src/route.js';

const A = { lat: 35.7148, lng: 139.7967 };
const B = { lat: 35.7101, lng: 139.8107 };

test('departureISO 用經度粗估時區', () => {
  assert.equal(departureISO('2026-11-21', '9:05', 139.7), '2026-11-21T09:05:00+09:00');
  assert.equal(departureISO('2026-11-21', null, 121.5), '2026-11-21T09:00:00+08:00');
  assert.equal(departureISO('2026-11-21', '10:00', -74), '2026-11-21T10:00:00-05:00');
  assert.equal(departureISO('', '10:00', 139), null);
});

test('sanitizeDeparture:過去或太遠都當作「現在」', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(sanitizeDeparture('2026-10-31T10:00:00Z', now), null);
  assert.equal(sanitizeDeparture('2027-06-01T10:00:00Z', now), null);
  assert.equal(sanitizeDeparture('壞掉', now), null);
  assert.equal(sanitizeDeparture(null, now), null);
  assert.equal(sanitizeDeparture('2026-11-05T10:00:00+09:00', now), '2026-11-05T01:00:00.000Z');
});

test('validPoint', () => {
  assert.ok(validPoint(A));
  assert.ok(!validPoint({ lat: 91, lng: 0 }));
  assert.ok(!validPoint({ lat: '35', lng: 139 }));
  assert.ok(!validPoint(null));
});

test('googleRoute:開車用路況並算出塞車多花的時間;請求內容正確', async () => {
  let sent;
  const fetchFn = async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return Response.json({ routes: [{ duration: '1500s', staticDuration: '1080s', distanceMeters: 9200 }] }); };
  const r = await googleRoute('KEY', A, B, 'drive', null, fetchFn);
  assert.deepEqual(r, { source: 'google', mode: 'drive', min: 25, km: 9.2, delayMin: 7, predicted: false });
  assert.equal(sent.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(sent.init.headers['x-goog-api-key'], 'KEY');
  assert.equal(sent.body.travelMode, 'DRIVE');
  assert.equal(sent.body.routingPreference, 'TRAFFIC_AWARE');
  assert.equal(sent.body.departureTime, undefined);
});

test('googleRoute:大眾運輸帶出發時間;步行不帶;查無路線回 null', async () => {
  let body;
  const ok = async (_u, init) => { body = JSON.parse(init.body); return Response.json({ routes: [{ duration: '960s', distanceMeters: 3900 }] }); };
  const t = await googleRoute('K', A, B, 'transit', '2026-11-21T00:00:00.000Z', ok);
  assert.equal(t.min, 16); assert.equal(t.predicted, true); assert.equal(t.delayMin, null);
  assert.equal(body.travelMode, 'TRANSIT'); assert.ok(body.departureTime); assert.equal(body.routingPreference, undefined);
  await googleRoute('K', A, B, 'walk', '2026-11-21T00:00:00.000Z', ok);
  assert.equal(body.travelMode, 'WALK'); assert.equal(body.departureTime, undefined);
  assert.equal(await googleRoute('K', A, B, 'transit', null, async () => Response.json({})), null);
  await assert.rejects(googleRoute('K', A, B, 'drive', null, async () => new Response('', { status: 403 })));
});

test('osrmRoute:步行/開車用道路路網;大眾運輸沒有來源', async () => {
  let url;
  const fetchFn = async (u) => { url = u; return Response.json({ routes: [{ duration: 1429.7, distance: 1784.9 }] }); };
  const r = await osrmRoute(A, B, 'walk', fetchFn);
  assert.deepEqual(r, { source: 'osrm', mode: 'walk', min: 24, km: 1.78, delayMin: null, predicted: false });
  assert.match(url, /routed-foot/); assert.match(url, /139\.7967,35\.7148;139\.8107,35\.7101/);
  assert.match(await (async () => { await osrmRoute(A, B, 'drive', fetchFn); return url; })(), /routed-car/);
  assert.equal(await osrmRoute(A, B, 'transit', fetchFn), null);
});

test('computeRoute:沒金鑰走 OSM;Google 失敗也退回;全都不行回 none', async () => {
  const osm = async () => Response.json({ routes: [{ duration: 600, distance: 3000 }] });
  assert.equal((await computeRoute({}, { from: A, to: B, mode: 'drive' }, osm)).source, 'osrm');
  const calls = [];
  const mixed = async (u) => { calls.push(String(u)); if (String(u).includes('googleapis')) return new Response('', { status: 500 }); return osm(); };
  assert.equal((await computeRoute({ GOOGLE_MAPS_API_KEY: 'k' }, { from: A, to: B, mode: 'walk' }, mixed)).source, 'osrm');
  assert.equal(calls.length, 2);
  assert.equal((await computeRoute({}, { from: A, to: B, mode: 'transit' }, osm)).source, 'none');
  assert.equal((await computeRoute({}, { from: A, to: B, mode: 'walk' }, async () => { throw new Error('net'); })).source, 'none');
});

test('computeRoute:useGoogle=false 時不會呼叫 Google', async () => {
  const urls = [];
  const f = async (u) => { urls.push(String(u)); return Response.json({ routes: [{ duration: 300, distance: 900 }] }); };
  const r = await computeRoute({ GOOGLE_MAPS_API_KEY: 'k' }, { from: A, to: B, mode: 'walk', useGoogle: false }, f);
  assert.equal(r.source, 'osrm');
  assert.ok(urls.every((u) => !u.includes('googleapis')));
});
