function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return v.trim();
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  // Set to a guild ID during development for instant command registration.
  guildId: process.env.DISCORD_GUILD_ID?.trim() || null,
  dbPath: process.env.HARKLET_DB?.trim() || new URL('../harklet.db', import.meta.url).pathname,
};

// --- LLM provider detection ---
// openai  : OpenAI-compatible /chat/completions (OpenAI, OpenRouter, LM Studio,
//           Ollama, Gemini OpenAI-compat endpoint, ...)
// anthropic: native POST {base}/v1/messages
// google  : native {base}/models/{model}:generateContent
const env = process.env;
const provider = (env.LLM_PROVIDER?.trim().toLowerCase()) ||
  (env.OPENROUTER_API_KEY || env.OPENAI_API_KEY ? 'openai'
    : env.ANTHROPIC_API_KEY ? 'anthropic'
    : (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) ? 'google' : 'openai');

const PROVIDER_DEFAULTS = {
  openai:    { baseUrl: 'https://api.openai.com/v1',        model: 'gpt-4.1-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com',        model: 'claude-sonnet-4-5' },
  google:    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
};

const openaiBaseUrl = env.OPENAI_BASE_URL || env.OPENROUTER_BASE_URL ||
  (!env.OPENAI_API_KEY && env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : PROVIDER_DEFAULTS.openai.baseUrl);
const isOpenRouter = (() => {
  try { return new URL(openaiBaseUrl).hostname === 'openrouter.ai'; } catch { return false; }
})();
config.llm = {
  provider,
  apiKey:
    (provider === 'openai' ? (env.LLM_API_KEY || (isOpenRouter ? env.OPENROUTER_API_KEY || env.OPENAI_API_KEY : env.OPENAI_API_KEY || env.OPENROUTER_API_KEY))
     : provider === 'anthropic' ? (env.LLM_API_KEY || env.ANTHROPIC_API_KEY)
     : (env.LLM_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY))?.trim() || '',
  baseUrl: (
    (provider === 'openai' ? openaiBaseUrl
     : provider === 'anthropic' ? env.ANTHROPIC_BASE_URL
     : env.GOOGLE_BASE_URL) || PROVIDER_DEFAULTS[provider].baseUrl
  ).replace(/\/+$/, ''),
  model: (env.LLM_MODEL || env.OPENAI_MODEL || (isOpenRouter && provider === 'openai' ? 'openai/gpt-4.1-mini' : PROVIDER_DEFAULTS[provider].model)).trim(),
};

// --- Home dashboard cards ---
config.home = {
  city: env.HOME_CITY?.trim() || null,        // 天気カード (Open-Meteo, キー不要)
  githubUser: env.GITHUB_USER?.trim() || null, // GitHub概要カード
  githubToken: env.GITHUB_TOKEN?.trim() || null, // 任意: レート制限緩和
};

// --- External service connectors (OAuth, optional) ---
config.connect = {
  googleClientId: env.GOOGLE_CLIENT_ID?.trim() || null,     // GCP OAuth client (Desktop app type)
  googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || null,
  m365ClientId: env.M365_CLIENT_ID?.trim() || null,         // Entra app, device code flow enabled
  m365Tenant: env.M365_TENANT?.trim() || 'common',
};
