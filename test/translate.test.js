import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, normalizeImage, translateText, translateImage, IMAGE_RE, DIRECTIONS } from '../src/translate.js';
import { PHRASES } from '../public/phrases.js';

test('normalizeText / normalizeImage:缺翻譯就視為失敗', () => {
  assert.deepEqual(normalizeText({ translation: ' お手洗いはどこですか? ', reading: 'おてあらいはどこですか', note: '' }), { translation: 'お手洗いはどこですか?', reading: 'おてあらいはどこですか', note: '' });
  assert.equal(normalizeText({ translation: '' }), null);
  assert.equal(normalizeText(null), null);
  assert.equal(normalizeImage({ original: 'ラーメン 900円', translation: '拉麵 900 日圓', note: '含小麥' }).translation, '拉麵 900 日圓');
  assert.equal(normalizeImage({ original: 'x', translation: '' }), null);
});

test('translateText:成功、JSON 模式失敗後退回純文字、全失敗回 null', async () => {
  const ok = { AI_MODEL: 'm', AI: { run: async () => ({ response: '{"translation":"これはいくらですか?","reading":"これはいくらですか","note":""}' }) } };
  assert.equal((await translateText(ok, '這個多少錢?', 'zh2ja')).translation, 'これはいくらですか?');
  const seen = [];
  const retry = { AI_MODEL: 'm', AI: { run: async (_m, o) => { seen.push(!!o.response_format); if (o.response_format) throw new Error('unsupported'); return { response: { translation: '拉麵', reading: '', note: '' } }; } } };
  assert.equal((await translateText(retry, 'ラーメン', 'ja2zh')).translation, '拉麵');
  assert.deepEqual(seen, [true, false]);
  const bad = { AI_MODEL: 'm', AI: { run: async () => { throw new Error('down'); } } };
  assert.equal(await translateText(bad, 'x', 'zh2ja'), null);
});

test('translateImage:先用 image_url,失敗再用 image 欄位', async () => {
  const calls = [];
  const env = { AI_MODEL: 'm', AI: { run: async (_m, input) => {
    calls.push(input);
    if (Array.isArray(input.messages[1].content)) throw new Error('bad input');
    return { response: '{"original":"禁煙","translation":"禁止吸菸","note":""}' };
  } } };
  const r = await translateImage(env, 'data:image/jpeg;base64,AAAA');
  assert.equal(r.translation, '禁止吸菸');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(calls[1].image, 'data:image/jpeg;base64,AAAA');
  const blank = { AI_MODEL: 'm', AI: { run: async () => ({ response: '{"original":"","translation":"","note":""}' }) } };
  assert.equal(await translateImage(blank, 'data:image/png;base64,AAAA'), null);
});

test('IMAGE_RE 只接受 jpeg/png/webp 的 data URL', () => {
  assert.ok(IMAGE_RE.test('data:image/jpeg;base64,/9j/4AAQ=='));
  assert.ok(IMAGE_RE.test('data:image/webp;base64,UklGRg=='));
  assert.ok(!IMAGE_RE.test('data:image/svg+xml;base64,PHN2Zz4='));
  assert.ok(!IMAGE_RE.test('https://example.com/a.jpg'));
  assert.ok(!IMAGE_RE.test('data:image/jpeg;base64,<script>'));
  assert.deepEqual(DIRECTIONS, ['zh2ja', 'ja2zh']);
});

test('常用句:每句都有中文與日文,日文含假名,沒有重複', () => {
  const all = PHRASES.flatMap((g) => g.items);
  assert.ok(all.length >= 20);
  for (const p of all) {
    assert.ok(p.zh.length > 1 && p.ja.length > 1, p.zh);
    assert.match(p.ja, /[぀-ヿ]/, `日文要有假名:${p.ja}`);
  }
  assert.equal(new Set(all.map((p) => p.ja)).size, all.length);
  assert.ok(PHRASES.every((g) => g.group && g.items.length));
});
