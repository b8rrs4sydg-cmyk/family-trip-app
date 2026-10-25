import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass, normalizeTransit, transitAdvice } from '../src/transit.js';

const pt = { lat: 35.7148, lng: 139.7967 };
const overpass = { elements: [
  { type: 'node', lat: 35.7107, lon: 139.7967, tags: { name: '浅草', 'name:zh': '淺草', railway: 'station' } },
  { type: 'node', lat: 35.7140, lon: 139.7985, tags: { name: '浅草', railway: 'station' } },
  { type: 'relation', tags: { name: '東京メトロ銀座線: 浅草 → 渋谷', route: 'subway' } },
  { type: 'relation', tags: { name: '東京メトロ銀座線: 渋谷 → 浅草', route: 'subway' } },
] };

test('parseOverpass: 車站依距離、路線去重', () => {
  const r = parseOverpass(overpass, pt);
  assert.equal(r.stations.length, 1);
  assert.equal(r.stations[0].ja, '浅草');
  assert.deepEqual(r.lines, ['東京メトロ銀座線']);
});

test('normalizeTransit 截斷並過濾', () => {
  assert.equal(normalizeTransit({ summary: '', steps: [] }), null);
  const r = normalizeTransit({ summary: '搭銀座線', steps: ['a', '', 'b', 'c', 'd', 'e'] });
  assert.equal(r.steps.length, 4);
});

test('transitAdvice: Overpass 失敗時仍能請 AI 回答', async () => {
  const env = { AI_MODEL: 'm', AI: { run: async (_m, req) => { assert.match(req.messages[1].content, /淺草寺/); return { response: JSON.stringify({ summary: '搭銀座線', steps: ['淺草站搭銀座線'] }) }; } } };
  const fail = async () => { throw new Error('down'); };
  const r = await transitAdvice(env, { from: { ...pt, name: '淺草寺' }, to: { lat: 35.6586, lng: 139.7454, name: '東京鐵塔' } }, fail);
  assert.equal(r.summary, '搭銀座線');
  assert.equal(r.steps.length, 1);
});
