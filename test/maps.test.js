import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrl, parseMapsUrl, resolveUrl, importPlace } from '../src/maps.js';

test('extractUrl 分離分享文字中的名稱與連結', () => {
  const r = extractUrl('淺草寺\nhttps://maps.app.goo.gl/AbC123');
  assert.equal(r.url, 'https://maps.app.goo.gl/AbC123');
  assert.equal(r.hint, '淺草寺');
  assert.equal(extractUrl('東京鐵塔').url, null);
});

test('parseMapsUrl 取地點名稱與釘選座標(優先 !3d!4d)', () => {
  const u = 'https://www.google.com/maps/place/%E6%B7%BA%E8%8D%89%E5%AF%BA/@35.7147,139.7967,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d35.7148374!4d139.7967029';
  const r = parseMapsUrl(u);
  assert.equal(r.name, '淺草寺');
  assert.equal(r.lat, 35.7148374);
  assert.equal(r.lng, 139.7967029);
});

test('parseMapsUrl 名稱中的 + 轉空白,只有 @ 時用視角座標', () => {
  const r = parseMapsUrl('https://www.google.com/maps/place/Tokyo+Skytree/@35.71,139.81,15z');
  assert.equal(r.name, 'Tokyo Skytree');
  assert.equal(r.lat, 35.71);
});

test('parseMapsUrl 支援 ?q= 名稱與 ?q=緯度,經度', () => {
  assert.equal(parseMapsUrl('https://www.google.com/maps?q=Shibuya+Crossing').name, 'Shibuya Crossing');
  const c = parseMapsUrl('https://maps.google.com/?q=35.6595,139.7005');
  assert.equal(c.name, null);
  assert.equal(c.lat, 35.6595);
});

test('resolveUrl 展開短網址,並逐跳檢查網域', async () => {
  const calls = [];
  const fetchFn = async (u) => {
    calls.push(u);
    if (u.startsWith('https://maps.app.goo.gl/')) {
      return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/place/A/@1,2,3z' } });
    }
    throw new Error('should not fetch long url');
  };
  const out = await resolveUrl('https://maps.app.goo.gl/x', fetchFn);
  assert.equal(out, 'https://www.google.com/maps/place/A/@1,2,3z');
  assert.equal(calls.length, 1);
});

test('resolveUrl 拒絕非 Google 網域(含轉址到外部)', async () => {
  await assert.rejects(resolveUrl('https://evil.example.com/x', async () => new Response()));
  const redirectOut = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
  await assert.rejects(resolveUrl('https://maps.app.goo.gl/x', redirectOut));
});

test('resolveUrl 處理 consent 頁面的 continue 參數', async () => {
  const out = await resolveUrl(
    'https://consent.google.com/ml?continue=' + encodeURIComponent('https://www.google.com/maps/place/B/@1,2,3z'),
    async () => { throw new Error('no fetch'); });
  assert.equal(out, 'https://www.google.com/maps/place/B/@1,2,3z');
});

test('importPlace:純文字直接當名稱;連結失敗時用分享文字的名稱', async () => {
  assert.deepEqual(await importPlace('清水寺'), { name: '清水寺', lat: null, lng: null, url: null });
  const r = await importPlace('一蘭拉麵 https://www.google.com/maps?q=35.6,139.7');
  assert.equal(r.lat, 35.6);
  assert.equal(r.name, '一蘭拉麵');
  assert.match(r.url, /^https:\/\/www\.google\.com/);
});

test('parseMapsUrl:新版分享連結的各種格式(座標在路徑、只有名稱、導航路線、cid)', () => {
  const asakusa = (u) => { const r = parseMapsUrl(u); return [r.name, r.lat, r.lng]; };
  const JA = '%E3%82%B5%E3%83%B3%E3%83%AA%E3%82%AA%E3%83%94%E3%83%A5%E3%83%BC%E3%83%AD%E3%83%A9%E3%83%B3%E3%83%89';
  // 只有名稱(沒有座標):座標靠之後用名稱查
  assert.deepEqual(asakusa(`https://www.google.com/maps/place/${JA}/data=!4m2!3m1!1s0x6018e1:0xabc`), ['サンリオピューロランド', null, null]);
  assert.deepEqual(asakusa(`https://www.google.com/maps/place/${JA}/@35.6245615,139.4294453,17z`), ['サンリオピューロランド', 35.6245615, 139.4294453]);
  // 座標在路徑裡
  assert.deepEqual(asakusa('https://www.google.com/maps/search/35.6246,139.4262'), [null, 35.6246, 139.4262]);
  assert.deepEqual(asakusa('https://www.google.com/maps/place/35.6246199,139.4262303'), [null, 35.6246199, 139.4262303]);
  assert.deepEqual(asakusa('https://www.google.com/maps/@35.6246,139.4262,15z'), [null, 35.6246, 139.4262]);
  assert.deepEqual(asakusa('https://maps.google.com/?q=35.6246,139.4262'), [null, 35.6246, 139.4262]);
  assert.deepEqual(asakusa('https://maps.google.com/?q=Sanrio+Puroland&ll=35.6246,139.4262'), ['Sanrio Puroland', 35.6246, 139.4262]);
  // 導航路線:終點名稱;@ 只是畫面中心,不能當作終點座標
  assert.deepEqual(asakusa('https://www.google.com/maps/dir/Tokyo+Station/Sanrio+Puroland/@35.64,139.4,11z'), ['Sanrio Puroland', null, null]);
  assert.deepEqual(asakusa('https://www.google.com/maps/dir/?api=1&destination=35.6246,139.4262'), [null, 35.6246, 139.4262]);
  assert.deepEqual(asakusa('https://www.google.com/maps/search/?api=1&query=Sanrio%20Puroland'), ['Sanrio Puroland', null, null]);
  // cid:沒有名稱也沒有座標,但會帶出 cid 讓呼叫端給明確的錯誤訊息
  assert.equal(parseMapsUrl('https://maps.google.com/?cid=1234567890123456789').cid, '1234567890123456789');
  // 日期、價格這類不是座標的數字不會被誤判
  const noCoord = parseMapsUrl('https://www.google.com/maps/search/2026,11');
  assert.deepEqual([noCoord.lat, noCoord.lng], [null, null]);
});

test('importPlace:有座標但沒名稱時用貼上的文字,再不行用預設名稱', async () => {
  const none = async () => { throw new Error('should not fetch'); };
  const a = await importPlace('我的飯店 https://www.google.com/maps/search/35.6246,139.4262', none);
  assert.equal(a.name, '我的飯店');
  assert.equal(a.lat, 35.6246);
  const b = await importPlace('https://www.google.com/maps/search/35.6246,139.4262', none);
  assert.equal(b.name, '地圖上的地點');
});
