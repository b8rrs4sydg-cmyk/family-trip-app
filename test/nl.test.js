import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cnToNum, findTime, findDay, parseWithRules, normalizeEntries, parseNaturalLanguage, hasScheduleCue } from '../src/nl.js';
import { insertIndex, mergeFixed } from '../src/schedule.js';

test('中文數字', () => {
  assert.deepEqual(['一', '五', '十', '十二', '二十', '兩', '7'].map(cnToNum), [1, 5, 10, 12, 20, 2, 7]);
});

test('findTime 支援 13:00、全形冒號、下午一點半、早上9點30', () => {
  assert.equal(findTime('13:00從台灣').time, '13:00');
  assert.equal(findTime('9：05 出發').time, '09:05');
  assert.equal(findTime('下午一點半抵達').time, '13:30');
  assert.equal(findTime('早上9點30分').time, '09:30');
  assert.equal(findTime('晚上七點').time, '19:00');
  assert.equal(findTime('中午12點').time, '12:00');
  assert.equal(findTime('去淺草寺'), null);
});

test('findDay 支援第N天、最後一天、Day N', () => {
  assert.equal(findDay('第三天去京都', 5).day, 3);
  assert.equal(findDay('最後一天回國', 5).day, 5);
  assert.equal(findDay('第十二日', 14).day, 12);
  assert.equal(findDay('Day 2 午餐', 5).day, 2);
  assert.equal(findDay('去淺草寺', 5), null);
});

test('範例:第一天13:00從台灣飛往東京,第五天13:00從東京飛往台灣', () => {
  const r = parseWithRules('第一天13:00從台灣飛往東京,第五天13:00從東京飛往台灣', 5);
  assert.deepEqual(r, [
    { day: 1, time: '13:00', title: '航班:台灣 → 東京', kind: 'flight', note: '' },
    { day: 5, time: '13:00', title: '航班:東京 → 台灣', kind: 'flight', note: '' },
  ]);
});

test('規則解析:住宿、最後一天、沒有天數', () => {
  const r = parseWithRules('第二天下午三點入住新宿王子飯店;最後一天中午退房', 5);
  assert.equal(r[0].day, 2); assert.equal(r[0].time, '15:00'); assert.equal(r[0].kind, 'hotel');
  assert.equal(r[1].day, 5); assert.equal(r[1].time, '12:00');
  const free = parseWithRules('去淺草寺', 5);
  assert.deepEqual(free.map((x) => [x.day, x.title]), [[0, '去淺草寺']]);
});

test('normalizeEntries 擋掉壞資料', () => {
  const r = normalizeEntries({ entries: [
    { day: 9, time: '25:00', title: 'A', kind: 'bogus' },
    { day: 2, time: '9:05', title: '  B  ', kind: 'meal' },
    { day: 1, title: '' },
    'junk',
  ] }, 5);
  assert.deepEqual(r, [
    { day: 0, badDay: 9, time: null, title: 'A', kind: 'other', note: '' },
    { day: 2, badDay: null, time: '09:05', title: 'B', kind: 'meal', note: '' },
  ]);
});

test('parseNaturalLanguage:AI 成功用 AI;失敗退回規則', async () => {
  const ok = { AI_MODEL: 'm', AI: { run: async () => ({ response: { entries: [{ day: 1, time: '13:00', title: '航班:台灣 → 東京', kind: 'flight', note: '' }] } }) } };
  const a = await parseNaturalLanguage(ok, 'x', 5);
  assert.equal(a.usedAi, true);
  const bad = { AI_MODEL: 'm', AI: { run: async () => { throw new Error('down'); } } };
  const b = await parseNaturalLanguage(bad, '第一天13:00從台灣飛往東京', 5);
  assert.equal(b.usedAi, false);
  assert.equal(b.entries[0].title, '航班:台灣 → 東京');
});

test('hasScheduleCue', () => {
  assert.ok(hasScheduleCue('第二天去京都'));
  assert.ok(hasScheduleCue('13:00 出發'));
  assert.ok(!hasScheduleCue('淺草寺'));
});

test('insertIndex:第一天航班放最前、最後一天放最後、依時間插入', () => {
  const day = [{ id: 'a' }, { id: 'b' }];
  assert.equal(insertIndex(day, { time: '13:00', kind: 'flight' }, 1, 5), 0);
  assert.equal(insertIndex(day, { time: '13:00', kind: 'flight' }, 5, 5), 2);
  assert.equal(insertIndex(day, { time: '08:00', kind: 'meal' }, 3, 5), 0);
  assert.equal(insertIndex(day, { time: '19:00', kind: 'meal' }, 3, 5), 2);
  assert.equal(insertIndex(day, { time: '13:00', kind: 'meal' }, 3, 5), 1);
  assert.equal(insertIndex(day, { time: null }, 3, 5), 2);
  const timed = [{ id: 'x', time: '09:00' }, { id: 'y', time: '18:00' }];
  assert.equal(insertIndex(timed, { time: '12:00' }, 3, 5), 1);
  assert.equal(insertIndex(timed, { time: '20:00' }, 3, 5), 2);
});

test('mergeFixed 把固定項目併入 AI 排好的各天', () => {
  const days = [[{ id: 'p1' }, { id: 'p2' }], [], [], [], [{ id: 'p3' }]];
  const out = mergeFixed(days, [
    { id: 'f1', day: 1, time: '13:00', kind: 'flight' },
    { id: 'f2', day: 5, time: '13:00', kind: 'flight' },
  ]);
  assert.deepEqual(out[0].map((x) => x.id), ['f1', 'p1', 'p2']);
  assert.deepEqual(out[4].map((x) => x.id), ['p3', 'f2']);
});
