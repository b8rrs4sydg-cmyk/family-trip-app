import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderDay, pathKm } from '../public/route-order.js';

const P = (name, lat, lng, time = null) => ({ name, lat, lng, time });
test('順路排序:不再「淺草→築地→淺草」折返,有時間的留在原本的時間順序', () => {
  const day = [P('雷門', 35.709, 139.7966), P('仲見世', 35.7122, 139.7965), P('築地', 35.6649, 139.7669, '16:00'), P('淺草寺', 35.7134, 139.7955), P('小網神社', 35.6842, 139.7804)];
  const out = orderDay(day);
  assert.ok(pathKm(out) < pathKm(day));
  const names = out.map((x) => x.name);
  assert.ok(names.indexOf('築地') > names.indexOf('淺草寺') && names.indexOf('築地') > names.indexOf('雷門'));
});
test('順路排序:有時間的項目順序不變、沒座標的跟著前一個', () => {
  const day = [P('A', 35.7, 139.7, '09:00'), { name: '備忘', time: null }, P('B', 35.6, 139.7, '15:00')];
  assert.deepEqual(orderDay(day).map((x) => x.name), ['A', '備忘', 'B']);
});
