import { config } from './config.js';
import { store } from './db.js';

const SYSTEM = `あなたは「Harklet」— Hark Pro に着想を得た Discord 上のパーソナルアシスタント。
ユーザーの記憶を長期保持し、会話の中から次の一手を提案して実行ボタンで支援する。

ルール:
- 日本語で、簡潔に。Discord向けに段落は短く。
- 返答は必ず次のJSONのみ: {"reply": "...", "actions": [...], "remember": [...]}
- actions: ユーザーがワンクリックで実行できる次の一手。0〜3件。
  - {"label": "ボタン名(20字以内)", "kind": "remind", "arg": "ISO8601日時"} … リマインダー
  - {"label": "ボタン名", "kind": "memory", "arg": "覚える内容"} … 記憶に保存
  - 不要なら空配列。押す価値のあるものだけ提案する。
- remember: 会話から得た、今後も覚える価値のあるユーザーの事実(名前・好み・予定・進捗)。0〜2件。なければ空配列。
- reply に Markdown は使ってよいが、JSON構造は壊すな。`;

function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function chat(userId, scope, userText) {
  const memories = store.listMemories(userId);
  const memoryBlock = memories.length
    ? '\n\nこのユーザーについて覚えていること:\n' + memories.map(m => `- ${m.content}`).join('\n')
    : '';
  const system = SYSTEM + memoryBlock + `\n\n現在日時: ${new Date().toISOString()}`;

  const history = store.recentHistory(scope, 12);
  const messages = [
    { role: 'system', content: system },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];

  if (!config.openai.apiKey) {
    return {
      reply: '⚙️ LLMが未設定です。`OPENAI_API_KEY` を .env に設定してください。Discord側の動作確認はこのまま可能です。',
      actions: [], remember: [],
    };
  }

  const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
    body: JSON.stringify({ model: config.openai.model, messages, temperature: 0.7 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonLoose(raw) ?? { reply: raw };

  const result = {
    reply: String(parsed.reply ?? raw).slice(0, 3800),
    actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
    remember: Array.isArray(parsed.remember) ? parsed.remember.slice(0, 2) : [],
  };

  for (const fact of result.remember) {
    if (typeof fact === 'string' && fact.trim()) store.addMemory(userId, fact.trim());
  }
  store.addHistory(scope, userId, 'user', userText);
  store.addHistory(scope, userId, 'assistant', result.reply);
  return result;
}

