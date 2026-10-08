// DSH (DeepSeek Harness) agent-loop を in-process で組み込む層。
// 会話スコープごとに Agent を保持し、LLM 呼び出しは OpenAI互換/Anthropic/Google を
// 自前アダプタでブリッジする。
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { store } from './db.js';

const EFFORT_BUDGET = { low: 1024, medium: 4096, high: 16384 };
const REPLY_TIMEOUT_MS = 120_000;

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

// sessionId -> effort ("low"|"medium"|"high")
const effortBySession = new Map();

function parseJsonLoose(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// DSH Message -> provider wire messages
function toWire(messages, provider) {
  const out = [];
  for (const m of messages ?? []) {
    const text = (m.content ?? [])
      .filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = (m.content ?? []).filter(b => b.type === 'tool-call');
    const toolResult = (m.content ?? []).find(b => b.type === 'tool-result');
    if (provider === 'google') {
      const parts = [];
      if (text) parts.push({ text });
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
      continue;
    }
    if (provider === 'anthropic') {
      if (toolResult) {
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolResult.callId, content: text || '(result)' }] });
        continue;
      }
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id ?? tc.callId, name: tc.name, input: safeJson(tc.arguments) });
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : [{ type: 'text', text: '(empty)' }] });
      continue;
    }
    // openai-compatible
    if (toolResult) {
      out.push({ role: 'tool', tool_call_id: toolResult.callId, content: text || '(result)' });
      continue;
    }
    const msg = { role: m.role, content: text };
    if (toolCalls.length) msg.tool_calls = toolCalls.map(tc => ({ id: tc.id ?? tc.callId, type: 'function', function: { name: tc.name, arguments: tc.arguments ?? '{}' } }));
    out.push(msg);
  }
  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

class HarkletAdapter extends LlmAdapter {
  async *stream(options) {
    const llm = config.llm;
    const effort = effortBySession.get(options.sessionId) || options.reasoningEffort || null;
    const wire = toWire(options.messages, llm.provider);
    const sys = [options.system, ...wire.filter(m => m.role === 'system').map(m => m.content || '')].filter(Boolean).join('\n\n');
    const convo = wire.filter(m => m.role !== 'system');
    const body = { model: options.model };

    let url, headers;
    if (llm.provider === 'anthropic') {
      url = `${llm.baseUrl}/v1/messages`;
      headers = { 'Content-Type': 'application/json', 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' };
      body.max_tokens = options.maxTokens ?? 4096;
      if (sys) body.system = sys;
      body.messages = convo;
      if (effort && EFFORT_BUDGET[effort]) {
        body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[effort] };
        body.max_tokens = Math.max(body.max_tokens, EFFORT_BUDGET[effort] + 2048);
      }
    } else if (llm.provider === 'google') {
      url = `${llm.baseUrl}/models/${encodeURIComponent(options.model)}:generateContent`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': llm.apiKey };
      body.contents = convo;
      if (sys) body.systemInstruction = { parts: [{ text: sys }] };
      if (effort && EFFORT_BUDGET[effort]) {
        body.generationConfig = { thinkingConfig: { thinkingBudget: EFFORT_BUDGET[effort] } };
      }
    } else {
      url = `${llm.baseUrl}/chat/completions`;
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` };
      body.messages = sys ? [{ role: 'system', content: sys }, ...convo] : convo;
      body.temperature = options.temperature ?? 0.7;
      if (options.maxTokens) body.max_tokens = options.maxTokens;
      if (effort) {
        if (llm.baseUrl.includes('openrouter')) body.reasoning = { effort };
        else body.reasoning_effort = effort;
      }
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();

    // 応答を DSH stream chunks に畳み込む
    let text = '', toolCalls = [];
    if (llm.provider === 'anthropic') {
      for (const b of data.content ?? []) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    } else if (llm.provider === 'google') {
      for (const p of data.candidates?.[0]?.content?.parts ?? []) {
        if (p.text) text += p.text;
        else if (p.functionCall) toolCalls.push({ id: p.functionCall.name, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) });
      }
    } else {
      const choice = data.choices?.[0]?.message ?? {};
      text = choice.content ?? '';
      toolCalls = (choice.tool_calls ?? []).map(t => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments ?? '{}' }));
    }

    let i = 0;
    if (text) {
      yield { type: 'block-start', index: i, blockType: 'text' };
      yield { type: 'text-delta', index: i, text };
      yield { type: 'block-end', index: i, block: { type: 'text', text } };
      i++;
    }
    for (const tc of toolCalls) {
      yield { type: 'block-start', index: i, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: i, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
      yield { type: 'block-end', index: i, block: { type: 'tool-call', id: tc.id, name: tc.name, arguments: tc.arguments } };
      i++;
    }
    if (data.usage) {
      yield { type: 'usage', usage: { inputTokens: data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0 } };
    }
    yield { type: 'finish', reason: toolCalls.length ? { kind: 'tool-calls' } : { kind: 'stop' } };
  }
}

// --- runtime singleton ---
let ctx = null;
let booted = null;
const agents = new Map(); // scope -> { handle, model, effort }

async function boot() {
  if (booted) return booted;
  booted = (async () => {
    const c = new Context();
    await c.plugin(LlmRuntime);
    await c.plugin(SessionStore);
    await c.plugin(AgentRegistry);
    await c.plugin(SystemPrompt, { persona: SYSTEM });
    await c.plugin(ToolRuntime, { mode: 'native' });
    await c.plugin(AgentLoop, { agents: [] });
    c.llm.registerAdapter(['harklet'], new HarkletAdapter());
    return c;
  })();
  ctx = await booted;
  return ctx;
}

async function agentFor(userId, scope) {
  const c = await boot();
  const s = store.getSettings(userId) ?? {};
  const model = s.model || config.llm.model;
  const effort = (s.effort || '').toLowerCase() || null;
  const cur = agents.get(scope);
  if (cur && cur.model === model && cur.effort === effort) return cur.handle.agent;
  if (cur) { try { await cur.handle.dispose(); } catch {} }
  const sessionId = 'harklet-' + randomUUID();
  effortBySession.set(sessionId, effort);
  const handle = await c.agents.create({
    sessionId,
    agentOptions: { provider: 'harklet', model, maxTokens: 4096 },
  });
  agents.set(scope, { handle, model, effort, userId });
  return handle.agent;
}

export async function invalidateAgent(scope) {
  const cur = agents.get(scope);
  if (cur) { try { await cur.handle.dispose(); } catch {} agents.delete(scope); }
}

export async function invalidateUserAgents(userId) {
  for (const [scope, v] of agents) {
    if (v.userId === userId) {
      try { await v.handle.dispose(); } catch {}
      agents.delete(scope);
    }
  }
}

function lastAssistantText(agent) {
  const evs = agent.session.events.filter(e => e.type === 'assistant/message');
  const last = evs.at(-1)?.data?.message;
  if (!last) return '';
  return (last.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
}

export async function chatDsh(userId, scope, userText) {
  if (!config.llm.apiKey) {
    return { reply: '⚙️ LLMが未設定です。.env にキーを設定してください。', actions: [], remember: [] };
  }
  const agent = await agentFor(userId, scope);
  const memories = store.listMemories(userId);
  const ctxBlock = [
    memories.length ? '【このユーザーについて覚えていること】\n' + memories.map(m => '- ' + m.content).join('\n') : '',
    '【現在日時】' + new Date().toISOString(),
  ].filter(Boolean).join('\n');

  agent.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: ctxBlock ? ctxBlock + '\n\n' + userText : userText }],
  }));
  await Promise.race([
    agent.whenIdle(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('応答がタイムアウトしました(120s)')), REPLY_TIMEOUT_MS)),
  ]);

  const raw = lastAssistantText(agent);
  if (!raw) throw new Error('モデルからの返信がありませんでした');
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

export async function shutdownDsh() {
  for (const [, v] of agents) { try { await v.handle.dispose(); } catch {} }
  agents.clear();
  if (ctx) { try { await ctx.fiber.dispose(); } catch {} ctx = null; booted = null; }
}
