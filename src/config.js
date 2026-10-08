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
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() || '',
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
  },
  dbPath: process.env.HARKLET_DB?.trim() || new URL('../harklet.db', import.meta.url).pathname,
};

