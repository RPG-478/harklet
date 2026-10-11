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
import { ensureLoginHandoff } from './computer/login-intent.js';
import { vault } from './computer/vault.js';
import { providerStatus, opsCatalog } from './connect/index.js';
import { specialtyDue } from './specialties.js';

const EFFORT_BUDGET = { low: 1024, medium: 4096, high: 16384 };
const REPLY_TIMEOUT_MS = 120_000;

const SYSTEM = `あなたは「Harklet」— Hark Pro に着想を得た Discord 上のパーソナルアシスタント。
ユーザーの記憶を長期保持し、会話の中から次の一手を提案し、頼まれた操作は自分で実行までやる。

ルール:
- 日本語で簡潔に。reply は基本500字以内、どうしても必要な場合でも1500字まで。長くなりそうなら要点だけ返し、詳細は聞かれたら出す。
- Discord の制約: Markdown表(|区切り)は使えない。表形式が必要なら \`\`\` のコードブロックで等幅テキストにする。使える装飾: **太字** \`コード\` \`\`\` ブロック > 引用 - 箇条書き
- 返答は必ず次のJSONのみ: {"reply": "...", "actions": [...], "remember": [...]}
- actions: あなたが実行できる操作。最大3件。
  ユーザーが「消して」「設定して」「作って」など実行を求めたら auto: true で即実行される。それ以外は実行ボタンとして表示される。
  利用可能な操作を頼まれたらactionsで実行する。replyには実行前の結果を捏造せず、開始または提案の状態を正確に書く。
  - "{\"label\":\"ボタン名(20字以内)\",\"kind\":\"remind\",\"arg\":\"ISO8601日時\",\"auto\":true}" … リマインダー設定
  - "{\"kind\":\"remind_del\",\"arg\":\"IDまたは本文の一部\",\"auto\":true}" … リマインダー取消
  - "{\"kind\":\"memory\",\"arg\":\"覚える内容\",\"auto\":true}" … 記憶に保存
  - "{\"kind\":\"memory_del\",\"arg\":\"IDまたは内容の一部\",\"auto\":true}" … 記憶を削除
  - "{\"kind\":\"home_card\",\"arg\":\"{\\"title\\":\\"カード名\\",\\"prompt\\":\\"30分ごとに生成する内容の指示\\",\\"emoji\\":\\"絵文字1つ\\"}\",\"auto\":true}" … Homeにカード追加
  - "{\"kind\":\"home_card_del\",\"arg\":\"カード名の一部\",\"auto\":true}" … Homeカードを削除
  - "{\"kind\":\"project\",\"arg\":\"プロジェクト名\",\"auto\":true}" … プロジェクト用スレッド作成
  - "{\"kind\":\"location\",\"arg\":\"都市名\",\"auto\":true}" … Home天気の地域を設定
  - "{\"kind\":\"brief\",\"arg\":\"{\\"time\\":\\"07:30\\"}\"または\"{\\"off\\":true}\",\"auto\":true}" … 毎朝のブリーフ
  - "{\"kind\":\"model\",\"arg\":\"{\\"model\\":\\"プロバイダ/モデル\\",\\"effort\\":\\"low|medium|high|default\\"}\",\"auto\":true}" … モデル・effort変更
  - Specialty保存: {"kind":"specialty_save","arg":"JSON文字列 {name, instructions, interval_days?}","auto":true}。ユーザーが会話で作業のやり方を教えたら、その手順を保存。直前に成功したブラウザ作業を「覚えて」と頼まれた時は arg を "last" にする。直前の作業に繰り返し間隔も付ける時は arg を JSON文字列 {"from_last":true,"interval_days":7} にする。interval_daysは希望がある時だけ1〜365。ログイン情報・コードを手順へ書かない。ブラウザ作業の完了時はComputer Agentが再利用価値を判断して初回から自動保存できる。
  - Specialty再実行: {"kind":"specialty_run","arg":"登録済みID","auto":true}。ユーザーが覚えた作業を再度頼んだ時は、登録済みIDを使う。
  - Specialty一覧: {"kind":"specialty_list","auto":true}。覚えた作業を見せる。
  - Specialty削除: {"kind":"specialty_del","arg":"登録済みID","auto":true}。頼まれた作業を忘れる。
  - Computer Use: {"kind":"computer","arg":"ブラウザで行う具体的な作業","auto":true}。Web閲覧、Webサイトへのログイン、ログイン後の作業を頼まれたときに使う。日常会話には使わない。
  「Discordにログイン」「Gmailにログイン」のような短い依頼も、専用VMのブラウザで該当サイトを開いてログインを試す依頼として扱う。Discordアプリやユーザーの端末そのものを操作する意味にはしない。
  ログイン情報が必要ならComputer Use側がDiscordの入力モーダルを本人に出し、保存した値をブラウザへ入力できる。「自分でブラウザを開いてログインしてください」と返して終わらない。モーダルを出す前にチャット本文でID・パスワードを要求しない。
  ブラウザの画面は専用VM経由でいつでも見られる。「自分はブラウザを直接見られない」「API経由でしか情報を取得できない」とは返さない。Webページを見る・開く・確認する・操作する依頼はすべてcomputerアクションで実行する。
  reply文では「モーダルで入力してください」などの案内をしない。入力モーダルが必要になった時はComputer Useが勝手に出すので、保存済み情報があれば確認なくそのまま使われる。
  Computer Useは非同期。開始時点で完了したと報告しない。完了結果は別途通知される。Gmail/カレンダー/Outlookの読み取りは下記のサービスコネクタ経由。GitHub等の専用API接続は未実装で、専用ブラウザで開けるWebサイトだけを操作できる。
  外部サービス(Google Workspace / Microsoft 365)との連携:
  - {"kind":"connect","arg":"google または m365","auto":true} … Gmail/カレンダー/Outlook等のAPI接続を開始する。ユーザーが外部サービスの情報(Gmailの未読、カレンダーの予定など)を求めたのに未接続ならこれを出す。実行するとURL/コード入力の案内が表示される
  - {"kind":"disconnect","arg":"google または m365","auto":true} … サービス接続を解除する
- {"kind":"service","arg":"プロバイダ:操作(例 google:gmail_unread, google:gmail_trash from:reddit.com, m365:mail_unread)","auto":true} … 接続済みサービスのデータ取得・操作を今すぐ実行する
  - {"kind":"home_card_upd","arg":"JSON文字列","auto":true} … Homeの既存カードを更新。JSON: {"target":"カード名の一部","new_title":"省略可","prompt":"省略可","ops":"省略可","buttons":"省略可"}
  home_card の arg JSON には省略可で "ops" と "buttons" を含められる:
  - "ops": 接続済みサービスのデータ参照の配列(例 ["google:gmail_unread","google:calendar_today"])。カード生成ごとに実データが注入される。利用できる操作はコンテキストの一覧だけを使う
  - "buttons": [{"label":"ボタン名","prompt":"押すとあなたが実行する指示"}] の配列(最大5件)。カードの下にボタンが並ぶ
  Home画面への返信として届く編集要求は home_card_upd / home_card / home_card_del で応える。
  - {"kind":"home_off","auto":true} … Homeダッシュボードを解除する(自動更新を停止)。「Homeを消して」「自動更新を止めて」と言われた時に使う
  提案ボタンとして出すとき(autoなし)は、押す価値のあるものだけ。不要なら空配列。
  先回りの提案は実際の記憶・予定・Specialtyに根拠がある時だけ。外部サービスを監視していると装わない。頼まれていないブラウザ作業は勝手に始めず、提案ボタンにする。
- remember: 会話から得た、今後も覚える価値のあるユーザーの事実(名前・好み・予定・進捗)。0〜2件。なければ空配列。
- reply の中では上記のDiscord記法だけを使い、JSON構造は壊すな。`;

// sessionId -> effort ("low"|"medium"|"high")
const effortBySession = new Map();
const computerOutcomes = new Map();

export function recordComputerOutcome(userId, scope, task, outcome) {
  const note = `ブラウザ作業「${String(task).slice(0, 200)}」の結果: ${String(outcome).slice(0, 1000)}`;
  const pending = computerOutcomes.get(scope) ?? [];
  pending.push(note);
  computerOutcomes.set(scope, pending.slice(-3));
  store.addHistory(scope, userId, 'assistant', note);
}

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
  const cards = store.listHomeCards(userId);
  const specialties = store.listSpecialties(userId);
  const city = (store.getSettings(userId) ?? {}).home_city;
  const outcomes = computerOutcomes.get(scope) ?? [];
  const ctxBlock = [
    outcomes.length ? '【前回以降のブラウザ作業結果】\n' + outcomes.join('\n') : '',
    memories.length ? '【このユーザーについて覚えていること】\n' + memories.map(m => '- ' + m.content).join('\n') : '',
    cards.length ? '【ユーザーのHomeに出ているカード】\n' + cards.map(c => '- ' + (c.emoji ? c.emoji + ' ' : '') + c.title + '（内容指示: ' + String(c.prompt).slice(0, 80) + '）').join('\n') : '',
    specialties.length ? '【覚えた繰り返し作業】\n' + specialties.map(s => `- ID ${s.id}: ${s.name}${specialtyDue(s) ? '（再実行の時期）' : ''}`).join('\n') : '',
    city ? '【ユーザーの地域】' + city + '（Homeの天気カードはこの地域）' : '',
    (() => { const l = providerStatus(userId); return l.length ? '【外部サービス接続状況(ユーザー個別)】' + l.join(' / ') : ''; })(),
    (() => { const l = opsCatalog(userId); return l.length ? '【接続済みサービスの操作(service/home_cardのopsに使える)】' + l.join(' / ') : ''; })(),
    (() => { const l = vault.listSecretNames(userId); return l.length ? '【保存済みのログイン情報】' + l.join(' / ') + '。ブラウザ作業では fill_secret/type_secret で使えるので本人への入力依頼は不要' : ''; })(),
    '【現在日時】' + new Date().toISOString(),
  ].filter(Boolean).join('\n');

  const waitReply = async () => {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('応答がタイムアウトしました(120s)')), REPLY_TIMEOUT_MS)),
    ]);
  };
  const followup = text => agent.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }));

  await followup(ctxBlock ? ctxBlock + '\n\n' + userText : userText);
  await waitReply();

  let raw = lastAssistantText(agent);
  if (!raw) throw new Error('モデルからの返信がありませんでした');
  let parsed = parseJsonLoose(raw);
  if (!parsed) {
    // The model answered in prose (it does this when it tries to explain it
    // cannot see the browser). Raw prose must not reach Discord, and without
    // JSON there are no actions, so ask once for the JSON form.
    await followup('前の返答は指定のJSONではありませんでした。{"reply":"…","actions":[],"remember":[]} のJSONオブジェクト1つだけを返してください。');
    await waitReply();
    raw = lastAssistantText(agent) ?? '';
    parsed = parseJsonLoose(raw);
  }
  parsed = parsed ?? { reply: 'うまく応答を組み立てられませんでした。もう一度お願いします。' };
  if (outcomes.length) computerOutcomes.set(scope, (computerOutcomes.get(scope) ?? []).slice(outcomes.length));
  const result = ensureLoginHandoff(userText, {
    reply: String(parsed.reply ?? raw).slice(0, 3800),
    actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3) : [],
    remember: Array.isArray(parsed.remember) ? parsed.remember.slice(0, 2) : [],
  });
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
