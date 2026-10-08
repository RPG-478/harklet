// Hark の Home に相当する常駐ダッシュボード。
// 1ユーザー1メッセージを Embed カードで構成し、
// ボタン操作と定期タイマーで更新(edit)する。
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import { chatDsh } from './dsh-agent.js';
import { fmtTs } from './schedule.js';

const HOME_COLOR = 0x5865f2;

// ---------- card builders ----------

async function briefCard(userId) {
  const rs = store.listReminders(userId);
  const prompt = [
    'ホーム画面の「今日の一手」カードを書いて。',
    'ユーザーの予定・記憶を踏まえて、今日やると良いことを2〜4項目+励ましの一文。',
    '各項目は短く、冒頭に絵文字を1つ。全体で300文字以内。',
    'リマインダー: ' + (rs.length ? rs.map(r => r.text + '@' + new Date(r.due_at).toISOString()).join(', ') : 'なし'),
  ].join('\n');
  const r = await chatDsh(userId, 'home:' + userId, prompt).catch(e => ({ reply: '生成に失敗: ' + e.message, actions: [] }));
  const embed = new EmbedBuilder()
    .setTitle('💡 今日の一手')
    .setColor(HOME_COLOR)
    .setDescription(r.reply.slice(0, 900));
  return { embed, actions: r.actions ?? [] };
}

function remindersCard(userId) {
  const rs = store.listReminders(userId);
  if (!rs.length) return null;
  const lines = rs.slice(0, 8).map(r => `• ${r.text} — ${fmtTs(r.due_at)}`);
  return new EmbedBuilder().setTitle('⏰ 予定').setColor(0xfee75c).setDescription(lines.join('\n'));
}

export async function geocodeCity(name) {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=ja`)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  return geo?.results?.find(r => r.country_code === 'JP') ?? geo?.results?.[0] ?? null;
}

// ユーザーの登録地域(home_city/lat/lon)を優先。未設定時は env の HOME_CITY、
// それも無ければ「📍 地域ボタンで設定してください」の誘導カードを返す。
async function weatherCard(userId) {
  const s = store.getSettings(userId) ?? {};
  let name = s.home_city, lat = s.home_lat, lon = s.home_lon;
  if (lat == null && config.home.city) {
    const p = await geocodeCity(config.home.city);
    if (!p) return null;
    name = `${p.name}, ${p.country_code ?? ''}`;
    lat = p.latitude;
    lon = p.longitude;
  }
  if (lat == null) {
    return new EmbedBuilder()
      .setTitle('🌤️ 天気')
      .setColor(0x57f287)
      .setDescription('地域が未設定です。下の「📍 地域」ボタンから地名を入れるだけで毎日ここに出ます');
  }
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=sunset&timezone=auto`)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!w?.current) return null;
  return new EmbedBuilder()
    .setTitle(`🌤️ ${name}`)
    .setColor(0x57f287)
    .addFields(
      { name: weatherLabel(w.current.weather_code), value: `${w.current.temperature_2m}°C`, inline: true },
      { name: '日没', value: (w.daily?.sunset?.[0] ?? '').slice(11, 16) || '—', inline: true },
    );
}

const WMO = { 0: '快晴', 1: '晴れ', 2: '一部曇り', 3: '曇り', 45: '霧', 48: '霧', 51: '霧雨', 61: '小雨', 63: '雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: 'にわか雨', 95: '雷雨' };
function weatherLabel(code) { return WMO[code] ?? '天気'; }

async function githubCard() {
  const user = config.home.githubUser;
  if (!user) return null;
  const headers = { 'User-Agent': 'harklet', Accept: 'application/vnd.github+json' };
  if (config.home.githubToken) headers.Authorization = `Bearer ${config.home.githubToken}`;
  const repos = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=updated`, { headers })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!Array.isArray(repos) || !repos.length) return null;
  const total = repos.reduce((a, r) => a + (r.stargazers_count || 0), 0);
  const open = repos.reduce((a, r) => a + (r.open_issues_count || 0), 0);
  const top = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 5);
  const lines = top.map(r => `${r.name} — ⭐${r.stargazers_count} (${(r.updated_at ?? '').slice(0, 10)})`);
  return new EmbedBuilder()
    .setTitle(`🐙 GitHub概要 — ${user}`)
    .setColor(0x24292f)
    .setDescription(`合計 ⭐${total} / 未解決issue+PR ${open}\n\n` + lines.join('\n'));
}

function memoryCard(userId) {
  const ms = store.listMemories(userId).slice(0, 4);
  if (!ms.length) return null;
  return new EmbedBuilder()
    .setTitle('🧠 最近の記憶')
    .setColor(0xeb459e)
    .setDescription(ms.map(m => `• ${m.content.slice(0, 80)}`).join('\n'))
    .setFooter({ text: '/memory list で全件・forget で削除' });
}

// ユーザーのカスタムカード: 登録プロンプトを毎回LLMに投げて内容を生成
async function customCard(userId, c) {
  const r = await chatDsh(userId, `card:${c.id}`, c.prompt).catch(() => null);
  if (!r) return null;
  return new EmbedBuilder()
    .setTitle(`${c.emoji ?? `📊`} ${c.title}`.slice(0, 100))
    .setColor(c.color ?? 0x9b59b6)
    .setDescription(r.reply.slice(0, 900));
}

// ---------- payload ----------

export async function homePayload(userId, actionRows) {
  const customs = store.listHomeCards(userId).slice(0, 4);
  const [brief, weather, gh, ...customEmbeds] = await Promise.all([briefCard(userId), weatherCard(userId), githubCard(), ...customs.map(c => customCard(userId, c))]);
  const embeds = [brief.embed, ...customEmbeds, weather, gh, remindersCard(userId), memoryCard(userId)]
    .filter(Boolean).slice(0, 10);
  const newProj = new ButtonBuilder().setCustomId('home_newproj').setLabel('プロジェクト作成').setEmoji('📁').setStyle(ButtonStyle.Primary);
  const region = new ButtonBuilder().setCustomId('home_region').setLabel('地域').setEmoji('📍').setStyle(ButtonStyle.Secondary);
  const refresh = new ButtonBuilder().setCustomId('home_refresh').setLabel('更新').setEmoji('🔄').setStyle(ButtonStyle.Secondary);
  const rows = [new ActionRowBuilder().addComponents(newProj, region, refresh)];
  if (brief.actions?.length) rows.push(...actionRows(userId, brief.actions));
  return {
    content: '🏠 **Harklet Home**',
    embeds,
    components: rows.slice(0, 5),
  };
}
