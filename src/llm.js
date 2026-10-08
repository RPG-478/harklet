import { config } from './config.js';
import { store } from './db.js';

const EFFORT_BUDGET = { low: 1024, medium: 4096, high: 16384 };

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

function resolveOpts(userId) {
  const s = store.getSettings(userId) ?? {};
  return {
    model: s.model || config.llm.model,
    effort: (s.effort || '').toLowerCase() || null,
  };
}

// Returns { url, init, extract } for the configured provider.
// effort mapping:
//   openai/openrouter -> reasoning_effort / reasoning:{effort}
//   anthropic         -> thinking:{type:"enabled",budget_tokens}
//   google            -> generationConfig.thinkingConfig.thinkingBudget
function buildRequest(messages, llm, opts) {
  const effort = opts.effort;

  if (llm.provider === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    const body = { model: opts.model, max_tokens: 4096, messages: rest };
    if (system) body.system = system;
    if (effort && EFFORT_BUDGET[effort]) {
      body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[effort] };
      body.max_tokens = Math.max(body.max_tokens, EFFORT_BUDGET[effort] + 2048);
    }
    return {
      url: `${llm.baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': llm.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      extract: (d) => (d.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(''),
    };
  }

  if (llm.provider === 'google') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    const body = {
      contents: rest.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (effort && EFFORT_BUDGET[effort]) {
      body.generationConfig = { thinkingConfig: { thinkingBudget: EFFORT_BUDGET[effort] } };
    }
    return {
      url: `${llm.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': llm.apiKey },
        body: JSON.stringify(body),
      },
      extract: (d) => (d.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join(''),
    };
  }

  // openai-compatible (OpenAI / OpenRouter / local servers)
  const body = { model: opts.model, messages, temperature: 0.7 };
  if (effort) {
    if (llm.baseUrl.includes('openrouter')) body.reasoning = { effort };
    else body.reasoning_effort = effort;
  }
  return {
    url: `${llm.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(body),
    },
    extract: (d) => d.choices?.[0]?.message?.content ?? '',
  };
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

  if (!config.llm.apiKey) {
    return {
      reply: '⚙️ LLMが未設定です。.env に `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` のいずれかを設定してください。',
      actions: [], remember: [],
    };
  }

  const { url, init, extract } = buildRequest(messages, config.llm, resolveOpts(userId));
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = extract(data);
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
