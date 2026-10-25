// 翻譯:文字(中↔日)與照片(菜單、招牌、車站看板 → 繁體中文)。固定的常用句在 public/phrases.js,不走 AI。
import { parseAiResponse } from './plan.js';

export const DIRECTIONS = ['zh2ja', 'ja2zh'];

const SYSTEM = {
  zh2ja: `你是旅行口譯。把使用者的繁體中文翻成自然、有禮貌的日文,適合對店員、司機、飯店人員說。
只輸出 JSON:{"translation":"日文","reading":"日文的平假名讀法","note":"需要時補充一句繁體中文提醒,否則空字串"}`,
  ja2zh: `你是旅行口譯。把使用者給的日文翻成通順的繁體中文。
只輸出 JSON:{"translation":"繁體中文","reading":"","note":"若有該注意的(例如過敏原、價格、時間),用一句繁體中文提醒,否則空字串"}`,
};

const IMAGE_SYSTEM = `圖片是日本旅遊時拍的菜單、招牌、車站看板或說明牌。請讀出圖片上的日文文字,並翻成繁體中文。
只輸出 JSON:{"original":"辨識出的日文,保留換行,最多 20 行","translation":"對應的繁體中文翻譯,逐行","note":"重要提醒:過敏原、價格、營業時間、注意事項;沒有就空字串"}
如果看不清楚或圖片裡沒有文字,translation 請留空字串。`;

const str = (v, n) => String(v ?? '').trim().slice(0, n);

export function normalizeText(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const translation = str(raw.translation, 600);
  if (!translation) return null;
  return { translation, reading: str(raw.reading, 600), note: str(raw.note, 200) };
}

export function normalizeImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const translation = str(raw.translation, 2000);
  if (!translation) return null;
  return { original: str(raw.original, 2000), translation, note: str(raw.note, 300) };
}

export async function translateText(env, text, direction) {
  const messages = [{ role: 'system', content: SYSTEM[direction] }, { role: 'user', content: text }];
  const base = { messages, max_tokens: 700, chat_template_kwargs: { enable_thinking: false } };
  // 先要求 JSON 格式;模型不支援就退回純文字再解析
  for (const extra of [{ response_format: { type: 'json_object' } }, {}]) {
    try {
      const r = normalizeText(parseAiResponse(await env.AI.run(env.AI_MODEL, { ...base, ...extra })));
      if (r) return r;
    } catch (e) { console.error('translate failed', e); }
  }
  return null;
}

// 圖片輸入的格式在不同模型不一樣:先用 OpenAI 風格的 image_url,不行再用 image 欄位
export async function translateImage(env, dataUrl) {
  const prompt = '請翻譯這張圖片。';
  const attempts = [
    { messages: [{ role: 'system', content: IMAGE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }] },
    { messages: [{ role: 'system', content: IMAGE_SYSTEM }, { role: 'user', content: prompt }], image: dataUrl },
  ];
  for (const a of attempts) {
    try {
      const r = normalizeImage(parseAiResponse(await env.AI.run(env.AI_MODEL, { ...a, max_tokens: 1500, chat_template_kwargs: { enable_thinking: false } })));
      if (r) return r;
    } catch (e) { console.error('translate image failed', e); }
  }
  return null;
}

export const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_IMAGE_CHARS = 2_000_000; // 約 1.5 MB;前端會先縮圖
