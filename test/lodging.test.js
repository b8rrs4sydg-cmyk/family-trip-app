import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lodgingPlan } from '../src/lodging.js';
import { isLodging } from '../public/geo.js';

test('isLodging', () => {
  assert.ok(isLodging({ name: '新宿王子飯店' }));
  assert.ok(isLodging({ name: 'APA Hotel' }));
  assert.ok(isLodging({ name: '某處', kind: 'hotel' }));
  assert.ok(!isLodging({ name: '新宿御苑' }));
  assert.ok(!isLodging({ name: '淺草寺' }));
});

test('一間住宿:第1天只有回住宿、中間每天出發與回住宿、最後一天只有出發', () => {
  const p = lodgingPlan([{ id: 'h', day: 0 }], 4);
  assert.deepEqual(p.head.map((x) => x.length), [0, 1, 1, 1]);
  assert.deepEqual(p.tail.map((x) => x.length), [1, 1, 1, 0]);
  assert.equal(p.tail[0][0].copy, false); // 第一次住進去用原本的項目
  assert.equal(p.tail[1][0].copy, true);
  assert.ok(p.head.flat().every((s) => s.copy));
});

test('兩間住宿:依天數換', () => {
  const p = lodgingPlan([{ id: 'a', day: 1 }, { id: 'b', day: 3 }], 5);
  assert.deepEqual(p.tail.map((x) => x[0]?.hotel.id), ['a', 'a', 'b', 'b', undefined]);
  assert.deepEqual(p.head.map((x) => x[0]?.hotel.id), [undefined, 'a', 'a', 'b', 'b']);
  assert.equal(p.tail[2][0].copy, false); // b 第一次住
});

test('沒有住宿 / 只住最後一天', () => {
  assert.deepEqual(lodgingPlan([], 3).head.flat(), []);
  const p = lodgingPlan([{ id: 'x', day: 3 }], 3);
  // 第 1、2 天都用 x(最早的一間),所以 x 第 1 天就被放進去
  assert.equal(p.tail[0][0].hotel.id, 'x');
});
