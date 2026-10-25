import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, estimateTravel, fmtKm, fmtMin, dayDateLabel, tripText, dayColor, directionsUrl, money, parseFlightTitle, isoDate, flightSearchUrl, hotelSearchUrl } from '../public/geo.js';
import { queryFromTitle, viewbox, geocode } from '../src/geocode.js';
import { nominatimUrl, parseNominatim, parsePhoton } from '../public/geocoding.js';
import { normalizeSuggestions, suggestPlaces } from '../src/suggest.js';

const asakusa = { lat: 35.7148, lng: 139.7967 };
const skytree = { lat: 35.7101, lng: 139.8107 };
const kyoto = { lat: 34.9858, lng: 135.7588 };

test('haversineKm:淺草寺到晴空塔約 1.4 公里,東京到京都約 370 公里', () => {
  assert.ok(Math.abs(haversineKm(asakusa, skytree) - 1.4) < 0.2);
  assert.ok(Math.abs(haversineKm(asakusa, kyoto) - 367) < 15);
  assert.equal(haversineKm(asakusa, asakusa), 0);
});

test('estimateTravel:近的走路、遠的大眾運輸', () => {
  const near = estimateTravel(asakusa, { lat: 35.7155, lng: 139.8 });
  assert.equal(near.mode, 'walk');
  assert.ok(near.min >= 1 && near.min < 20);
  const far = estimateTravel(asakusa, kyoto);
  assert.equal(far.mode, 'transit');
  assert.ok(far.min > 300);
});

test('estimateTravel 可指定交通方式', () => {
  assert.equal(estimateTravel(asakusa, kyoto, 'walk').mode, 'walk');
  assert.equal(estimateTravel(asakusa, skytree, 'transit').mode, 'transit');
  const drive = estimateTravel(asakusa, skytree, 'drive');
  assert.equal(drive.mode, 'drive');
  assert.ok(drive.min >= 3 && drive.min < 15);
  assert.match(directionsUrl(asakusa, skytree, 'drive'), /travelmode=driving/);
});

test('格式化', () => {
  assert.equal(fmtKm(0.35), '350 公尺');
  assert.equal(fmtKm(3.24), '3.2 公里');
  assert.equal(fmtKm(25.4), '25 公里');
  assert.equal(fmtMin(45), '45 分鐘');
  assert.equal(fmtMin(125), '2 小時 5 分');
  assert.equal(fmtMin(120), '2 小時');
  assert.equal(money(12345.6), '¥12,346');
  assert.equal(dayColor(0), '#8a8a8a');
  assert.equal(dayColor(1), dayColor(9));
});

test('dayDateLabel:第 N 天的日期與星期,跨月也對', () => {
  assert.equal(dayDateLabel('2026-10-30', 1), '10/30(五)');
  assert.equal(dayDateLabel('2026-10-30', 3), '11/1(日)');
  assert.equal(dayDateLabel('', 1), null);
  assert.equal(dayDateLabel('abc', 1), null);
});

test('directionsUrl', () => {
  assert.match(directionsUrl(asakusa, skytree, 'walk'), /travelmode=walking/);
  assert.match(directionsUrl(asakusa, skytree, 'transit'), /origin=35\.7148,139\.7967&destination=35\.7101,139\.8107&travelmode=transit/);
});

test('tripText 輸出可貼到 LINE 的文字', () => {
  const t = tripText({
    name: '東京五日', days: 2, start_date: '2026-11-01', tips: { 1: '早點出發' },
    items: [
      { day: 1, time: '13:00', name: '航班:台灣 → 東京', cost: 12000, note: '' },
      { day: 1, time: null, name: '淺草寺', cost: 0, note: '要排隊' },
      { day: 0, time: null, name: '待定', cost: null, note: '' },
    ],
  });
  assert.equal(t, ['東京五日', '預估花費 ¥12,000', '', '【第 1 天 11/1(日)】', '💡 早點出發', '13:00 航班:台灣 → 東京(¥12,000)', '・淺草寺 — 要排隊', '', '【還沒安排】', '・待定'].join('\n'));
});

test('queryFromTitle / viewbox', () => {
  assert.equal(queryFromTitle('去淺草寺'), '淺草寺');
  assert.equal(queryFromTitle('逛逛 秋葉原(買相機)'), '秋葉原');
  assert.equal(queryFromTitle('入住新宿王子飯店'), '新宿王子飯店');
  assert.equal(queryFromTitle('住宿 東京站丸之內飯店'), '東京站丸之內飯店');
  assert.equal(queryFromTitle('淺草寺'), '淺草寺');
  assert.equal(viewbox([]), null);
  assert.equal(viewbox([{ lat: 35, lng: 139 }], 1), '138.0000,36.0000,140.0000,34.0000');
});

test('geocode 解析 Nominatim 結果,帶 User-Agent 與偏好範圍', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url: new URL(url), init }; return Response.json([{ lat: '35.7148374', lon: '139.7967029' }]); };
  const r = await geocode('去淺草寺', [{ lat: 35.6, lng: 139.7 }], fetchFn);
  assert.deepEqual(r, { lat: 35.7148374, lng: 139.7967029 });
  assert.equal(seen.url.searchParams.get('q'), '淺草寺');
  assert.ok(seen.url.searchParams.get('viewbox'));
  assert.match(seen.init.headers['user-agent'], /family-trip/);
  // 可以換成自架的服務
  await geocode('x', [], async (u) => { assert.ok(String(u).startsWith('http://localhost:9/search?')); return Response.json([{ lat: '1', lon: '2' }]); }, { nominatim: 'http://localhost:9' });
});

test('geocode:Nominatim 被擋(失敗)時改用 Photon;兩個都查無才是 null;兩個都壞才丟錯', async () => {
  const urls = [];
  const blocked = async (u) => {
    urls.push(String(u));
    if (String(u).includes('nominatim')) return new Response('', { status: 429 });
    return Response.json({ features: [{ geometry: { coordinates: [139.4294453, 35.6245615] } }] });
  };
  assert.deepEqual(await geocode('サンリオピューロランド', [{ lat: 35.6, lng: 139.4 }], blocked), { lat: 35.6245615, lng: 139.4294453 });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /photon\.komoot\.io\/api\/\?q=/);
  assert.match(urls[1], /lat=35\.6000&lon=139\.4000/); // 以已知地點為偏好位置
  const none = async (u) => (String(u).includes('nominatim') ? Response.json([]) : Response.json({ features: [] }));
  assert.equal(await geocode('不存在的地方', [], none), null);
  // 一個被擋、另一個查無 → 有服務回答了,視為查無(不會一直重試)
  const mixed = async (u) => (String(u).includes('nominatim') ? new Response('', { status: 403 }) : Response.json({ features: [] }));
  assert.equal(await geocode('x', [], mixed), null);
  await assert.rejects(geocode('x', [], async () => new Response('', { status: 429 })));
});

test('解析器共用的 URL 與結果格式', () => {
  assert.match(nominatimUrl('淺草寺', []), /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
  assert.equal(parseNominatim([]), null);
  assert.deepEqual(parsePhoton({ features: [{ geometry: { coordinates: [139.8, 35.7] } }] }), { lat: 35.7, lng: 139.8 });
  assert.equal(parsePhoton({ features: [{ geometry: { coordinates: ['x', 'y'] } }] }), null);
  assert.equal(parseNominatim([{ lat: '999', lon: '1' }]), null);
});

test('normalizeSuggestions 去重、排除已加入、限制數量', () => {
  const r = normalizeSuggestions({ suggestions: [
    { name: '淺草寺', reason: '已經有了', kind: 'place' },
    { name: '東京晴空塔', reason: '看夜景', kind: 'place' },
    { name: '東京晴空塔', reason: '重複', kind: 'place' },
    { name: '築地場外市場', reason: '吃海鮮', kind: 'meal' },
    { name: '', reason: 'x' }, null,
  ] }, ['淺草寺 雷門']);
  assert.deepEqual(r.map((x) => x.name), ['東京晴空塔', '築地場外市場']);
  assert.equal(r[1].kind, 'meal');
});

test('suggestPlaces:AI 失敗回空陣列', async () => {
  const env = { AI_MODEL: 'm', AI: { run: async () => { throw new Error('down'); } } };
  assert.deepEqual(await suggestPlaces(env, { tripName: 'x', days: 3, names: [] }), []);
  const ok = { AI_MODEL: 'm', AI: { run: async () => ({ response: { suggestions: [{ name: '上野公園', reason: '賞花', kind: 'place' }] } }) } };
  assert.equal((await suggestPlaces(ok, { tripName: 'x', days: 3, names: [] }))[0].name, '上野公園');
});

test('parseFlightTitle / isoDate', () => {
  assert.deepEqual(parseFlightTitle('航班:台灣 → 東京'), { from: '台灣', to: '東京' });
  assert.deepEqual(parseFlightTitle('航班:東京 → 台灣'), { from: '東京', to: '台灣' });
  assert.equal(parseFlightTitle('淺草寺'), null);
  assert.equal(isoDate('2026-11-29', 1), '2026-11-29');
  assert.equal(isoDate('2026-11-29', 3), '2026-12-01');
  assert.equal(isoDate('', 1), null);
  assert.equal(isoDate('2026-11-29', 0), null);
});

test('機票與飯店搜尋連結帶入路線與日期', () => {
  const f = new URL(flightSearchUrl({ name: '航班:台灣 → 東京', day: 1 }, '2026-11-20'));
  assert.equal(f.hostname, 'www.google.com');
  assert.equal(f.searchParams.get('q'), '從台灣到東京的機票 2026-11-20');
  assert.equal(new URL(flightSearchUrl({ name: '航班:台灣 → 東京', day: 1 }, null)).searchParams.get('q'), '從台灣到東京的機票');
  const h = new URL(hotelSearchUrl({ name: '入住新宿王子飯店', day: 2 }, '2026-11-20'));
  assert.equal(h.hostname, 'www.booking.com');
  assert.equal(h.searchParams.get('ss'), '新宿王子飯店');
  assert.equal(h.searchParams.get('checkin'), '2026-11-21');
  assert.equal(h.searchParams.get('checkout'), '2026-11-22');
  assert.equal(new URL(hotelSearchUrl({ name: '某飯店', day: 0 }, '2026-11-20')).searchParams.has('checkin'), false);
});

test('長途交通:成田機場到淺草寺大眾運輸約 1.5 小時內、不會是數小時', () => {
  const narita = { lat: 35.7720, lng: 140.3929 };
  const t = estimateTravel(narita, asakusa, 'transit');
  assert.ok(t.min >= 60 && t.min <= 110, `transit ${t.min}`);
  assert.ok(estimateTravel(narita, asakusa, 'drive').min <= 100);
});
