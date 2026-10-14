// Hark の Home に相当する常駐ダッシュボード。
// 1ユーザー1メッセージを Embed カードで構成し、
// ボタン操作と定期タイマーで更新(edit)する。
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import { t } from './i18n.js';
import { userLang } from './user-lang.js';
import { store } from './db.js';
import { chatDsh } from './dsh-agent.js';
import { fmtTs } from './schedule.js';
import { fetchOps } from './connect/index.js';
import { specialtyDue } from './specialties.js';

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
  const r = await chatDsh(userId, 'home:' + userId, prompt).catch(e => ({ reply: t(userLang(userId), 'home.briefFail', { msg: e.message }), actions: [] }));
  const embed = new EmbedBuilder()
    .setTitle(t(userLang(userId), 'home.briefTitle'))
    .setColor(HOME_COLOR)
    .setDescription(r.reply.slice(0, 900));
  return { embed, actions: r.actions ?? [] };
}

function remindersCard(userId) {
  const rs = store.listReminders(userId);
  if (!rs.length) return null;
  const lines = rs.slice(0, 8).map(r => `• ${r.text} — ${fmtTs(r.due_at)}`);
  return new EmbedBuilder().setTitle(t(userLang(userId), 'home.reminders')).setColor(0xfee75c).setDescription(lines.join('\n'));
}

export async function geocodeCity(name, lang = 'en') {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=${lang}`)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  return (lang === 'ja' ? geo?.results?.find(r => r.country_code === 'JP') : null) ?? geo?.results?.[0] ?? null;
}

// ユーザーの登録地域(home_city/lat/lon)を優先。未設定時は env の HOME_CITY、
// それも無ければ「📍 地域ボタンで設定してください」の誘導カードを返す。
async function weatherCard(userId) {
  const s = store.getSettings(userId) ?? {};
  let name = s.home_city, lat = s.home_lat, lon = s.home_lon;
  if (lat == null && config.home.city) {
    const p = await geocodeCity(config.home.city, userLang(userId));
    if (!p) return null;
    name = `${p.name}, ${p.country_code ?? ''}`;
    lat = p.latitude;
    lon = p.longitude;
  }
  if (lat == null) {
    return new EmbedBuilder()
      .setTitle(t(userLang(userId), 'home.weather'))
      .setColor(0x57f287)
      .setDescription(t(userLang(userId), 'home.noRegion'));
  }
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=sunset&timezone=auto`)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!w?.current) return null;
  return new EmbedBuilder()
    .setTitle(`🌤️ ${name}`)
    .setColor(0x57f287)
    .addFields(
      { name: weatherLabel(w.current.weather_code, userLang(userId)), value: `${w.current.temperature_2m}°C`, inline: true },
      { name: t(userLang(userId), 'home.sunset'), value: (w.daily?.sunset?.[0] ?? '').slice(11, 16) || '—', inline: true },
    );
}

const WMO = { 0: '快晴', 1: '晴れ', 2: '一部曇り', 3: '曇り', 45: '霧', 48: '霧', 51: '霧雨', 61: '小雨', 63: '雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: 'にわか雨', 95: '雷雨' };
const WEATHER = {
  en: { 0: 'Clear', 1: 'Sunny', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 95: 'Thunderstorm' },
  zh: { 0: '晴朗', 1: '晴', 2: '局部多云', 3: '多云', 45: '雾', 48: '雾', 51: '毛毛雨', 61: '小雨', 63: '雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: '阵雨', 95: '雷雨' },
};
function weatherLabel(code, lang) { return (lang === 'ja' ? WMO : WEATHER[lang] || WEATHER.en)[code] ?? t(lang, 'home.weather'); }

async function githubCard(lang) {
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
    .setTitle(t(lang, 'home.ghTitle', { user }))
    .setColor(0x24292f)
    .setDescription(t(lang, 'home.ghBody', { total, open }) + '\n\n' + lines.join('\n'));
}

function memoryCard(userId) {
  const ms = store.listMemories(userId).slice(0, 4);
  if (!ms.length) return null;
  return new EmbedBuilder()
    .setTitle(t(userLang(userId), 'home.memoryTitle'))
    .setColor(0xeb459e)
    .setDescription(ms.map(m => `• ${m.content.slice(0, 80)}`).join('\n'))
    .setFooter({ text: t(userLang(userId), 'home.memoryFooter') });
}

function specialtiesCard(userId) {
  const list = store.listSpecialties(userId);
  if (!list.length) return null;
  const due = list.filter(s => specialtyDue(s)).slice(0, 3);
  const shown = due.length ? due : list.slice(0, 3);
  const lines = shown.map(s => `• ${s.name}${specialtyDue(s) ? t(userLang(userId), 'home.specDue') : ''}`);
  return new EmbedBuilder().setTitle(t(userLang(userId), 'home.specTitle'))
    .setColor(0x57f287)
    .setDescription(lines.join('\n') + '\n' + t(userLang(userId), 'home.specHint'));
}

// ユーザーのカスタムカード(パネル): 接続サービスのデータ(ops)を先に取得し、
// それを材料に登録プロンプトで内容を生成。ボタン定義があればインタラクション用に返す。
export async function customCard(userId, c) {
  let ops = [];
  try { ops = JSON.parse(c.ops ?? '[]'); } catch {}
  if (!Array.isArray(ops)) ops = [];
  const dataBlock = ops.length
    ? await fetchOps(userId, ops.slice(0, 4)).catch(() => '')
    : '';
  const prompt = dataBlock
    ? '【取得済みデータ】\n' + dataBlock + '\n\n【このカードの表示指示】\n' + c.prompt
    : c.prompt;
  const r = await chatDsh(userId, `card:${c.id}`, prompt).catch(() => null);
  if (!r) return null;
  const embed = new EmbedBuilder()
    .setTitle(`${c.emoji ?? `📊`} ${c.title}`.slice(0, 100))
    .setColor(c.color ?? 0x9b59b6)
    .setDescription(r.reply.slice(0, 900));
  let buttons = [];
  try { buttons = JSON.parse(c.buttons ?? '[]'); } catch {}
  return { embed, buttons: Array.isArray(buttons) ? buttons.slice(0, 5) : [] };
}

// ---------- payload ----------

export async function homePayload(userId, actionRows) {
  const customs = store.listHomeCards(userId).slice(0, 4);
  const [brief, weather, gh, ...customEmbeds] = await Promise.all([briefCard(userId), weatherCard(userId), githubCard(userLang(userId)), ...customs.map(c => customCard(userId, c))]);
  const embeds = [brief.embed, ...customEmbeds.map(x => x?.embed), specialtiesCard(userId), weather, gh, remindersCard(userId), memoryCard(userId)]
    .filter(Boolean).slice(0, 10);
  const newProj = new ButtonBuilder().setCustomId('home_newproj').setLabel(t(userLang(userId), 'home.newProj')).setEmoji('📁').setStyle(ButtonStyle.Primary);
  const region = new ButtonBuilder().setCustomId('home_region').setLabel(t(userLang(userId), 'home.region')).setEmoji('📍').setStyle(ButtonStyle.Secondary);
  const refresh = new ButtonBuilder().setCustomId('home_refresh').setLabel(t(userLang(userId), 'home.refresh')).setEmoji('🔄').setStyle(ButtonStyle.Secondary);
  const rows = [new ActionRowBuilder().addComponents(newProj, region, refresh)];
  if (brief.actions?.length) rows.push(...actionRows(userId, brief.actions));
  // カスタムカード(パネル)固有のボタン: 押すとエージェントがその指示を実行
  customs.forEach((c, ci) => {
    const btns = customEmbeds[ci]?.buttons ?? [];
    if (!btns.length || rows.length >= 5) return;
    const row = new ActionRowBuilder();
    btns.forEach((b, bi) => {
      if (!b?.label || !b?.prompt || row.components.length >= 5) return;
      row.addComponents(new ButtonBuilder()
        .setCustomId(`hcbtn:${c.id}:${bi}`)
        .setLabel(String(b.label).slice(0, 40))
        .setStyle(ButtonStyle.Secondary));
    });
    if (row.components.length) rows.push(row);
  });
  return {
    content: t(userLang(userId), 'home.head'),
    embeds,
    components: rows.slice(0, 5),
  };
}
