// 行程分享短碼:8 個字(去掉容易看錯的 0 O 1 I L),顯示成 ABCD-EFGH。
// 短碼和行程網址一樣,知道的人就能加入編輯,所以只分享給旅伴。
export const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newCode(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let out = '';
  for (const b of rand(8)) out += CODE_CHARS[b % CODE_CHARS.length];
  return out;
}

// 使用者輸入的短碼(可能小寫、有空白、橫線、全形)轉成標準 8 碼;不合法回傳 null
export function normalizeCode(input) {
  const s = String(input ?? '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 && [...s].every((c) => CODE_CHARS.includes(c)) ? s : null;
}

export const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
