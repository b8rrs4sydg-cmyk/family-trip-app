import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, normalizeCode, formatCode, CODE_CHARS } from '../src/code.js';

test('newCode: 8 碼且只用不易混淆的字元', () => {
  for (let i = 0; i < 50; i++) { const c = newCode(); assert.equal(c.length, 8); assert.ok([...c].every((x) => CODE_CHARS.includes(x))); }
  assert.ok(!/[01OIL]/.test(CODE_CHARS));
});

test('normalizeCode: 容忍大小寫、空白、橫線、全形', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' ABCD EFGH '), 'ABCDEFGH');
  assert.equal(normalizeCode('ＡＢＣＤ－ＥＦＧＨ'), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD-EFG'), null);
  assert.equal(normalizeCode('ABCD-EFG0'), null); // 0 不在字元表
  assert.equal(normalizeCode(null), null);
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
});
