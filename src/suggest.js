// AI 推薦景點:根據旅行名稱和已加入的地點,推薦還沒去的。
import { parseAiResponse } from './plan.js';

const SYSTEM = `你是熟悉當地的旅遊顧問,使用者是帶長輩出遊的家庭。請用繁體中文推薦真實存在、知名且好找的地點。
規則:
- 從「旅行名稱」與「已加入的地點」推斷目的地城市;推薦的地點要在同一個區域,方便順路。
- 不要重複已加入的地點。
- 偏好:步行不多、有座位休息、評價穩定的地方;美食請推薦具體店名或料理類型。
- name 是地圖上搜得到的正式名稱;reason 用一句話說明為什麼適合(30 字內);kind 是 place(景點)或 meal(餐飲)。
- 只輸出 JSON。`;

const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
          kind: { type: 'string', enum: ['place', 'meal'] },
        },
        required: ['name', 'reason', 'kind'],
      },
    },
  },
  required: ['suggestions'],
};

export function normalizeSuggestions(raw, existingNames = []) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.suggestions) ? raw.suggestions : [];
  const have = existingNames.map((n) => n.toLowerCase());
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const name = String(s?.name ?? '').trim().slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key) || have.some((h) => h.includes(key) || key.includes(h))) continue;
    seen.add(key);
    out.push({ name, reason: String(s?.reason ?? '').trim().slice(0, 60), kind: s?.kind === 'meal' ? 'meal' : 'place' });
    if (out.length >= 8) break;
  }
  return out;
}

export async function suggestPlaces(env, { tripName, days, names, query }) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `旅行名稱:${tripName}\n天數:${days}\n已加入的地點:${JSON.stringify(names)}\n${query ? `使用者想找:${query}\n` : ''}請推薦 6 個,輸出 {"suggestions":[{"name":"","reason":"","kind":"place"}]}` },
  ];
  const base = { messages, max_tokens: 900, chat_template_kwargs: { enable_thinking: false } };
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: SCHEMA } }, {}]) {
    try {
      const list = normalizeSuggestions(parseAiResponse(await env.AI.run(env.AI_MODEL, { ...base, ...extra })), names);
      if (list.length) return list;
    } catch (e) {
      console.error('AI suggest failed', e);
    }
  }
  return [];
}
