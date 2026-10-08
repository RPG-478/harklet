import { config } from './config.js';

let ok = true;
const check = (name, pass, extra = '') => {
  console.log(`${pass ? 'OK' : 'NG'} ${name} ${extra}`);
  if (!pass) ok = false;
};
const warn = (name, extra = '') => console.log(`-- ${name} ${extra}`);

check('DISCORD_TOKEN', !!config.discordToken);
check('DISCORD_CLIENT_ID', !!config.clientId);
const llm = config.llm;
check('LLM provider', !!llm.apiKey, `${llm.provider} / ${llm.model}`);
if (!llm.apiKey) warn('LLM', '(キー未設定: /ask・パネル会話・ブリーフ生成は応答不可)');

// Discord token check
try {
  const r = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${config.discordToken}` },
  });
  const body = await r.json();
  check('Botトークン有効', r.ok, r.ok ? `(@${body.username})` : JSON.stringify(body).slice(0, 200));
} catch (e) { check('Botトークン有効', false, e.message); }

// LLM check (OpenAI-compatible endpoint; native providers are checked implicitly on first /ask)
if (llm.apiKey && llm.provider === 'openai') {
  try {
    const r = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages: [{ role: 'user', content: '{"reply":"ok"}' }], max_tokens: 20 }),
    });
    check('LLM接続', r.ok, r.ok ? `(model: ${llm.model})` : `HTTP ${r.status}`);
  } catch (e) { check('LLM接続', false, e.message); }
}

// SQLite check
try {
  const { db } = await import('./db.js');
  db.prepare('SELECT 1').get();
  check('SQLite (node:sqlite)', true, config.dbPath);
} catch (e) { check('SQLite (node:sqlite)', false, e.message); }

process.exitCode = ok ? 0 : 1;
