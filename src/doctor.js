import { config } from './config.js';

let ok = true;
const check = (name, pass, extra = '') => {
  console.log(`${pass ? 'OK' : 'NG'} ${name} ${extra}`);
  if (!pass) ok = false;
};

check('DISCORD_TOKEN', !!config.discordToken);
check('DISCORD_CLIENT_ID', !!config.clientId);
check('OPENAI_API_KEY', !!config.openai.apiKey, config.openai.apiKey ? '' : '(未設定だとLLM機能は応答不可)');

// Discord token check
try {
  const r = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${config.discordToken}` },
  });
  const body = await r.json();
  check('Botトークン有効', r.ok, r.ok ? `(@${body.username})` : JSON.stringify(body).slice(0, 200));
} catch (e) { check('Botトークン有効', false, e.message); }

// LLM check
if (config.openai.apiKey) {
  try {
    const r = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
      body: JSON.stringify({ model: config.openai.model, messages: [{ role: 'user', content: '{"reply":"ok"}' }], max_tokens: 20 }),
    });
    check('LLM接続', r.ok, r.ok ? `(model: ${config.openai.model})` : `HTTP ${r.status}`);
  } catch (e) { check('LLM接続', false, e.message); }
}

// SQLite check
try {
  const { db } = await import('./db.js');
  db.prepare('SELECT 1').get();
  check('SQLite (node:sqlite)', true, config.dbPath);
} catch (e) { check('SQLite (node:sqlite)', false, e.message); }

process.exit(ok ? 0 : 1);

