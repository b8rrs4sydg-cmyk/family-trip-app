import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlightInput, flightItem, flightMinutes } from '../src/flights.js';

const trip = { startDate: '2027-01-15', nDays: 5 };

test('IT202 1/15 14:25-18:35 → 第 1 天、台北→東京、含飛行時間', () => {
  const f = parseFlightInput('IT202 1/15 14:25-18:35', trip);
  assert.equal(f.code, 'IT202'); assert.equal(f.airline, '台灣虎航');
  assert.equal(f.from, 'TPE'); assert.equal(f.to, 'NRT'); assert.equal(f.day, 1);
  assert.equal(f.time, '14:25'); assert.equal(f.arrive, '18:35');
  assert.equal(f.minutes, 190); // 日本比台灣快 1 小時:當地 4h10 = 實際 3h10
});
test('IT201 回程在最後一天:2027/1/19 → 第 5 天,飛行時間加時差', () => {
  const f = parseFlightInput('IT201 2027/1/19 13:30 16:25', trip);
  assert.equal(f.day, 5); assert.equal(f.from, 'NRT'); assert.equal(f.to, 'TPE');
  assert.equal(f.minutes, 235);
  const it = flightItem(f, { nDays: 5 });
  assert.equal(it.kind, 'flight'); assert.equal(it.time, '13:30'); assert.equal(it.stay, 235);
  assert.ok(Math.abs(it.lat - 35.77) < 0.01); // 回程釘在成田
});
test('去程釘在目的地機場,只有航班號時提醒補資料', () => {
  const it = flightItem(parseFlightInput('IT202', trip), { nDays: 5 });
  assert.ok(Math.abs(it.lat - 35.77) < 0.01);
  assert.match(it.note, /起飛時間/); assert.equal(it.time, null);
});
test('不認得的前綴或一般文字不會被當成航班', () => {
  assert.equal(parseFlightInput('第二天 Zz9 逛街', trip), null);
  assert.equal(parseFlightInput('淺草寺 14:30', trip), null);
  assert.equal(parseFlightInput('Day 2', trip), null);
});
test('自己寫 IATA 起訖:BR198 TPE→KIX 2027/1/16 09:00-12:30', () => {
  const f = parseFlightInput('BR198 TPE→KIX 1/16 09:00-12:30', trip);
  assert.equal(f.from, 'TPE'); assert.equal(f.to, 'KIX'); assert.equal(f.day, 2); assert.ok(f.minutes === 150);
});
test('flightMinutes 跨日', () => { assert.equal(flightMinutes('23:30', '03:10', 8, 9), 160); });
