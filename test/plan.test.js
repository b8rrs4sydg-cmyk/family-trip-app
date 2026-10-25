import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackPlan, normalizePlan, parseAiResponse, planTrip } from '../src/plan.js';

const items = [
  { id: 'a', name: 'A', lat: 35.0, lng: 135.0 },
  { id: 'b', name: 'B', lat: 35.01, lng: 135.01 },
  { id: 'c', name: 'C', lat: 35.7, lng: 139.7 },
  { id: 'd', name: 'D', lat: 35.71, lng: 139.71 },
  { id: 'e', name: 'E', lat: null, lng: null },
];
const allIds = (days) => days.flat().sort().join('');

test('fallbackPlan 每個地點剛好一次,附近的排在一起', () => {
  const { days } = fallbackPlan(items, 2);
  assert.equal(days.length, 2);
  assert.equal(allIds(days), 'abcde');
  const near = (x, y) => days.some((d) => d.includes(x) && d.includes(y));
  assert.ok(near('a', 'b') && near('c', 'd'));
});

test('normalizePlan 移除未知與重複 id、補上遺漏、補滿天數', () => {
  const raw = { days: [['a', 'zzz', 'a'], 'oops'], tips: ['早點出發', 5] };
  const { days, tips } = normalizePlan(raw, items, 3);
  assert.equal(days.length, 3);
  assert.equal(allIds(days), 'abcde');
  assert.equal(tips[0], '早點出發');
});

test('parseAiResponse 支援物件、字串、OpenAI 格式與夾雜文字', () => {
  assert.deepEqual(parseAiResponse({ response: { days: [] } }), { days: [] });
  assert.deepEqual(parseAiResponse({ response: '好的:{"days":[["a"]]} 完成' }), { days: [['a']] });
  assert.deepEqual(parseAiResponse({ choices: [{ message: { content: '{"days":[]}' } }] }), { days: [] });
  assert.equal(parseAiResponse({ response: 'no json' }), null);
});

test('planTrip:AI 回傳亂資料也能得到完整排程', async () => {
  const env = { AI_MODEL: 'm', AI: { run: async () => ({ response: { days: [['a', 'a', 'x']], tips: [] } }) } };
  const r = await planTrip(env, items, 2);
  assert.equal(r.usedAi, true);
  assert.equal(allIds(r.days), 'abcde');
});

test('planTrip:AI 全部失敗就用幾何保底;第一次失敗會重試不帶 schema', async () => {
  let calls = 0;
  const failing = { AI_MODEL: 'm', AI: { run: async () => { calls++; throw new Error('boom'); } } };
  const r = await planTrip(failing, items, 2);
  assert.equal(r.usedAi, false);
  assert.equal(allIds(r.days), 'abcde');
  assert.equal(calls, 2);

  const seen = [];
  const retry = { AI_MODEL: 'm', AI: { run: async (_m, o) => {
    seen.push(!!o.response_format);
    if (o.response_format) throw new Error('unsupported');
    return { response: '{"days":[["a","b"],["c","d","e"]],"tips":["x","y"]}' };
  } } };
  const r2 = await planTrip(retry, items, 2);
  assert.deepEqual(seen, [true, false]);
  assert.equal(r2.usedAi, true);
});

test('planTrip 沒有地點時不呼叫 AI', async () => {
  const env = { AI: { run: () => { throw new Error('no'); } } };
  const r = await planTrip(env, [], 3);
  assert.deepEqual(r.days, [[], [], []]);
});

test('normalizePlan: 驗證 AI 的停留時間與新增地點', () => {
  const items = [{ id: 'a', name: '淺草寺' }, { id: 'b', name: '東京鐵塔' }];
  const raw = {
    days: [['a'], ['b'], []], tips: [],
    stays: [{ id: 'a', minutes: 120 }, { id: 'zzz', minutes: 60 }, { id: 'b', minutes: 5 }, { id: 'a', minutes: 90 }],
    adds: [{ name: '淺草寺', day: 1, kind: 'place' }, { name: '澀谷 109', day: 3, kind: 'place' }, { name: '銀座', day: 9, kind: 'place' }, { name: '表參道', day: 3, kind: 'x' }],
  };
  const r = normalizePlan(raw, items, 3);
  assert.deepEqual(r.stays, [{ id: 'a', minutes: 120 }]);
  assert.deepEqual(r.adds.map((x) => [x.name, x.day, x.kind]), [['澀谷 109', 3, 'place'], ['表參道', 3, 'place']]);
});

test('insertNearest: 新地點放進最順路的一天,不動原本的順序', async () => {
  const { insertNearest } = await import('../src/schedule.js');
  const asakusa = { id: 'a', lat: 35.7148, lng: 139.7967 }, ueno = { id: 'u', lat: 35.7156, lng: 139.7745 };
  const tower = { id: 't', lat: 35.6586, lng: 139.7454 }, shibuya = { id: 's', lat: 35.658, lng: 139.7016 };
  const days = [[asakusa, ueno], [tower]];
  const before = days.map((d) => d.map((x) => x.id).join());
  insertNearest(days, { id: 'sk', lat: 35.7101, lng: 139.8107 }); // 晴空塔:在淺草一帶
  assert.ok(days[0].some((x) => x.id === 'sk'));
  assert.deepEqual(days[0].filter((x) => x.id !== 'sk').map((x) => x.id), ['a', 'u']); // 原有順序不變
  assert.equal(days[1].length, 1);
  insertNearest(days, shibuya); // 澀谷:靠近東京鐵塔那天
  assert.ok(days[1].some((x) => x.id === 's'));
  assert.equal(before[1], 't');
  insertNearest(days, { id: 'x', name: '沒座標' });
  assert.ok(days.flat().some((x) => x.id === 'x'));
});

test('insertNearest: 已有樂園的那天不再排另一個樂園,就算它比較順路', async () => {
  const { insertNearest } = await import('../src/schedule.js');
  const park = { id: 'p1', name: 'Sanrio Puroland', kind: 'place', lat: 35.6245, lng: 139.4294 };
  const days = [[park], [{ id: 'far', name: '淺草寺', kind: 'place', lat: 35.713, lng: 139.795 }]];
  insertNearest(days, { id: 'p2', name: '東京迪士尼樂園', kind: 'place', lat: 35.6329, lng: 139.8804 });
  assert.ok(days[1].some((x) => x.id === 'p2') && !days[0].some((x) => x.id === 'p2'));
});
test('insertNearest: 早餐市場排前面、燒肉排後面', async () => {
  const { insertNearest } = await import('../src/schedule.js');
  const mk = (id, lat) => ({ id, name: id, kind: 'place', lat, lng: 139.77 });
  const day = () => [[mk('a', 35.66), mk('b', 35.67), mk('c', 35.68)]];
  const d1 = day(); insertNearest(d1, { id: 'm', name: '築地場外市場', kind: 'meal', lat: 35.669, lng: 139.77 });
  const d2 = day(); insertNearest(d2, { id: 'y', name: '敘敘苑燒肉', kind: 'meal', lat: 35.669, lng: 139.77 });
  assert.ok(d1[0].findIndex((x) => x.id === 'm') < d2[0].findIndex((x) => x.id === 'y'));
  assert.equal(d2[0].at(-1).id, 'y');
});
test('insertNearest: 一天排太滿就換別天', async () => {
  const { insertNearest } = await import('../src/schedule.js');
  const busy = [1, 2, 3, 4, 5].map((n) => ({ id: `b${n}`, name: `館${n}`, kind: 'place', stay: 120, lat: 35.7, lng: 139.7 }));
  const days = [busy, [{ id: 'z', name: 'Z', kind: 'place', lat: 35.9, lng: 139.9 }]];
  insertNearest(days, { id: 'n', name: '新景點', kind: 'place', stay: 120, lat: 35.7, lng: 139.7 });
  assert.ok(days[1].some((x) => x.id === 'n'));
});
test('spreadHeavy: 同一天兩個樂園會拆開', async () => {
  const { spreadHeavy } = await import('../src/schedule.js');
  const days = [[{ id: 'a', name: '迪士尼樂園', kind: 'place', lat: 35.63, lng: 139.88 }, { id: 'b', name: '環球影城', kind: 'place', lat: 34.66, lng: 135.43 }], [{ id: 'c', name: '淺草寺', kind: 'place', lat: 35.71, lng: 139.79 }]];
  spreadHeavy(days);
  assert.equal(days[0].filter((x) => /樂園|影城/.test(x.name)).length, 1);
  assert.equal(days.flat().length, 3);
});

test('insertNearest: 新地點不會插進第一天的兩個機場之間', async () => {
  const { insertNearest } = await import('../src/schedule.js');
  const days = [[{ id: 'tpe', name: '桃園國際機場', kind: 'flight', lat: 25.08, lng: 121.23 }, { id: 'nrt', name: '成田機場', kind: 'flight', lat: 35.77, lng: 140.39 }], [], [{ id: 'nrt2', name: '成田機場', kind: 'flight', lat: 35.77, lng: 140.39 }, { id: 'tpe2', name: '桃園國際機場', kind: 'flight', lat: 25.08, lng: 121.23 }]];
  insertNearest(days, { id: 'm', name: '築地場外市場', kind: 'meal', lat: 35.665, lng: 139.77 });
  const where = days.findIndex((l) => l.some((x) => x.id === 'm'));
  const ids = days[where].map((x) => x.id);
  if (where === 0) assert.ok(ids.indexOf('m') > ids.indexOf('nrt'));
  if (where === 2) assert.ok(ids.indexOf('m') < ids.indexOf('nrt2'));
});
test('placeMeals: 燒肉移到最後、市場移到最前,出入口不動', async () => {
  const { placeMeals } = await import('../src/schedule.js');
  const l = [{ id: 'g', name: '成田機場', kind: 'flight' }, { id: 'y', name: '敘敘苑燒肉', kind: 'meal' }, { id: 'p', name: '迪士尼樂園', kind: 'place' }, { id: 'm', name: '築地場外市場', kind: 'meal' }];
  assert.deepEqual(placeMeals(l).map((x) => x.id), ['g', 'm', 'p', 'y']);
});
