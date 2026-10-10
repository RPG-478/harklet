import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_scope ON history(scope, id);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS panels (
  thread_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  brief_enabled INTEGER NOT NULL DEFAULT 0,
  brief_time TEXT NOT NULL DEFAULT '08:00',
  brief_channel TEXT,
  brief_last_sent TEXT
);
CREATE TABLE IF NOT EXISTS main_channels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  set_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS home_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  emoji TEXT,
  color INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_channels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_categories (
  guild_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS specialties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  interval_days INTEGER,
  last_run_at INTEGER,
  last_suggested_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_specialties_user ON specialties(user_id);
CREATE TABLE IF NOT EXISTS workflow_observations (
  user_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task TEXT NOT NULL,
  instructions TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, task_key)
);
`);

// v2: per-user LLM prefs / v3: home message anchor
for (const col of ['model TEXT', 'effort TEXT', 'home_channel_id TEXT', 'home_message_id TEXT',
  'home_city TEXT', 'home_lat REAL', 'home_lon REAL']) {
  try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch { /* exists */ }
}
try { db.exec('ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
for (const col of ['ops TEXT', 'buttons TEXT']) {
  try { db.exec(`ALTER TABLE home_cards ADD COLUMN ${col}`); } catch { /* exists */ }
}

const q = {
  addMemory: db.prepare('INSERT INTO memories (user_id, content, created_at) VALUES (?, ?, ?)'),
  listMemories: db.prepare('SELECT id, content FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 100'),
  deleteMemory: db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?'),
  addHistory: db.prepare('INSERT INTO history (scope, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'),
  recentHistory: db.prepare('SELECT role, content FROM history WHERE scope = ? ORDER BY id DESC LIMIT ?'),
  pruneHistory: db.prepare(`DELETE FROM history WHERE scope = ? AND id NOT IN
    (SELECT id FROM history WHERE scope = ? ORDER BY id DESC LIMIT 40)`),
  addReminder: db.prepare('INSERT INTO reminders (user_id, channel_id, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)'),
  listReminders: db.prepare('SELECT id, text, due_at FROM reminders WHERE user_id = ? AND delivered = 0 ORDER BY due_at'),
  dueReminders: db.prepare('SELECT id, user_id, channel_id, text, attempts FROM reminders WHERE delivered = 0 AND due_at <= ?'),
  markDelivered: db.prepare('UPDATE reminders SET delivered = 1 WHERE id = ?'),
  cancelReminder: db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?'),
  bumpReminderAttempt: db.prepare('UPDATE reminders SET attempts = attempts + 1 WHERE id = ?'),
  addPanel: db.prepare('INSERT OR REPLACE INTO panels (thread_id, user_id, topic, created_at) VALUES (?, ?, ?, ?)'),
  getPanel: db.prepare('SELECT user_id, topic FROM panels WHERE thread_id = ?'),
  addAction: db.prepare('INSERT INTO pending_actions (user_id, payload, created_at) VALUES (?, ?, ?)'),
  getAction: db.prepare('SELECT user_id, payload FROM pending_actions WHERE id = ?'),
  delAction: db.prepare('DELETE FROM pending_actions WHERE id = ?'),
  getSettings: db.prepare('SELECT * FROM settings WHERE user_id = ?'),
  upsertSettings: db.prepare(`INSERT INTO settings (user_id, brief_enabled, brief_time, brief_channel)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET brief_enabled=excluded.brief_enabled,
      brief_time=excluded.brief_time, brief_channel=excluded.brief_channel`),
  markBriefSent: db.prepare('UPDATE settings SET brief_last_sent = ? WHERE user_id = ?'),
  briefTargets: db.prepare('SELECT user_id, brief_time, brief_channel FROM settings WHERE brief_enabled = 1'),
  setModel: db.prepare(`INSERT INTO settings (user_id, model) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET model=excluded.model`),
  setEffort: db.prepare(`INSERT INTO settings (user_id, effort) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET effort=excluded.effort`),
  setHome: db.prepare(`INSERT INTO settings (user_id, home_channel_id, home_message_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET home_channel_id=excluded.home_channel_id,
      home_message_id=excluded.home_message_id`),
  setHomeCity: db.prepare(`INSERT INTO settings (user_id, home_city, home_lat, home_lon) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET home_city=excluded.home_city,
      home_lat=excluded.home_lat, home_lon=excluded.home_lon`),
  clearHome: db.prepare('UPDATE settings SET home_channel_id=NULL, home_message_id=NULL WHERE user_id=?'),
  homeTargets: db.prepare('SELECT user_id, home_channel_id, home_message_id FROM settings WHERE home_channel_id IS NOT NULL'),
  addHomeCard: db.prepare('INSERT INTO home_cards (user_id, title, prompt, emoji, color, ops, buttons, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  getHomeCard: db.prepare('SELECT id, user_id, title, prompt, emoji, color, ops, buttons FROM home_cards WHERE id = ?'),
  updHomeCard: db.prepare('UPDATE home_cards SET title = ?, prompt = ?, emoji = ?, color = ?, ops = ?, buttons = ? WHERE id = ? AND user_id = ?'),
  listHomeCards: db.prepare('SELECT id, title, prompt, emoji, color, ops, buttons FROM home_cards WHERE user_id = ? ORDER BY id'),
  delHomeCard: db.prepare('DELETE FROM home_cards WHERE id = ? AND user_id = ?'),
  setProjectChannel: db.prepare('INSERT OR REPLACE INTO project_channels (guild_id, channel_id) VALUES (?, ?)'),
  getProjectChannel: db.prepare('SELECT channel_id FROM project_channels WHERE guild_id = ?'),
  clearProjectChannel: db.prepare('DELETE FROM project_channels WHERE guild_id = ?'),
  setMain: db.prepare('INSERT OR REPLACE INTO main_channels (guild_id, channel_id, set_by) VALUES (?, ?, ?)'),
  getMain: db.prepare('SELECT channel_id FROM main_channels WHERE guild_id = ?'),
  clearMain: db.prepare('DELETE FROM main_channels WHERE guild_id = ?'),
  setManagedCategory: db.prepare('INSERT OR REPLACE INTO managed_categories (guild_id, category_id) VALUES (?, ?)'),
  getManagedCategory: db.prepare('SELECT category_id FROM managed_categories WHERE guild_id = ?'),
  allPanels: db.prepare('SELECT thread_id FROM panels'),
  saveSpecialty: db.prepare(`INSERT INTO specialties (user_id, name, instructions, interval_days, last_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET
    instructions=excluded.instructions, interval_days=excluded.interval_days,
    last_run_at=excluded.last_run_at, last_suggested_at=NULL`),
  listSpecialties: db.prepare('SELECT * FROM specialties WHERE user_id = ? ORDER BY id DESC LIMIT 30'),
  getSpecialty: db.prepare('SELECT * FROM specialties WHERE id = ? AND user_id = ?'),
  findSpecialty: db.prepare('SELECT * FROM specialties WHERE name = ? AND user_id = ?'),
  deleteSpecialty: db.prepare('DELETE FROM specialties WHERE id = ? AND user_id = ?'),
  markSpecialtyRun: db.prepare('UPDATE specialties SET last_run_at = ?, last_suggested_at = NULL WHERE id = ? AND user_id = ?'),
  markSpecialtySuggested: db.prepare('UPDATE specialties SET last_suggested_at = ? WHERE id = ? AND user_id = ?'),
  dueSpecialties: db.prepare(`SELECT sp.* FROM specialties sp JOIN settings st ON st.user_id = sp.user_id
    WHERE st.brief_enabled = 1 AND sp.interval_days IS NOT NULL AND sp.last_run_at IS NOT NULL
      AND sp.last_run_at + sp.interval_days * 86400000 <= ?
      AND (sp.last_suggested_at IS NULL OR sp.last_suggested_at < sp.last_run_at)
    ORDER BY sp.last_run_at LIMIT 20`),
  saveObservation: db.prepare(`INSERT INTO workflow_observations (user_id, task_key, task, instructions, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, task_key) DO UPDATE SET
    instructions=excluded.instructions, updated_at=excluded.updated_at`),
  getObservation: db.prepare('SELECT * FROM workflow_observations WHERE user_id = ? AND task_key = ?'),
  latestObservation: db.prepare('SELECT * FROM workflow_observations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'),
};

export const store = {
  addMemory: (userId, content) => q.addMemory.run(userId, content, Date.now()),
  listMemories: (userId) => q.listMemories.all(userId),
  deleteMemory: (userId, id) => q.deleteMemory.run(id, userId).changes > 0,
  addHistory: (scope, userId, role, content) => {
    q.addHistory.run(scope, userId, role, content, Date.now());
    q.pruneHistory.run(scope, scope);
  },
  recentHistory: (scope, n = 12) => q.recentHistory.all(scope, n).reverse(),
  addReminder: (userId, channelId, text, dueAt) =>
    Number(q.addReminder.run(userId, channelId, text, dueAt, Date.now()).lastInsertRowid),
  listReminders: (userId) => q.listReminders.all(userId),
  dueReminders: (now) => q.dueReminders.all(now),
  markDelivered: (id) => q.markDelivered.run(id),
  cancelReminder: (userId, id) => q.cancelReminder.run(id, userId).changes > 0,
  bumpReminderAttempt: (id) => q.bumpReminderAttempt.run(id),
  addPanel: (threadId, userId, topic) => q.addPanel.run(threadId, userId, topic, Date.now()),
  getPanel: (threadId) => q.getPanel.get(threadId),
  addAction: (userId, payload) =>
    Number(q.addAction.run(userId, JSON.stringify(payload), Date.now()).lastInsertRowid),
  getAction: (id) => {
    const r = q.getAction.get(id);
    return r ? { userId: r.user_id, payload: JSON.parse(r.payload) } : null;
  },
  delAction: (id) => q.delAction.run(id),
  getSettings: (userId) => q.getSettings.get(userId),
  upsertSettings: (userId, enabled, time, channel) => q.upsertSettings.run(userId, enabled, time, channel),
  markBriefSent: (userId, day) => q.markBriefSent.run(day, userId),
  briefTargets: () => q.briefTargets.all(),
  setModel: (userId, model) => q.setModel.run(userId, model),
  setEffort: (userId, effort) => q.setEffort.run(userId, effort),
  setHome: (userId, channelId, messageId) => q.setHome.run(userId, channelId, messageId),
  setHomeCity: (userId, city, lat, lon) => q.setHomeCity.run(userId, city, lat, lon),
  clearHome: (userId) => q.clearHome.run(userId),
  homeTargets: () => q.homeTargets.all(),
  addHomeCard: (userId, title, prompt, emoji, color, ops, buttons) =>
    q.addHomeCard.run(userId, title, prompt, emoji, color, ops ?? null, buttons ?? null, Date.now()),
  getHomeCard: (id) => q.getHomeCard.get(id),
  updHomeCard: (userId, id, { title, prompt, emoji, color, ops, buttons }) =>
    q.updHomeCard.run(title, prompt, emoji, color, ops ?? null, buttons ?? null, id, userId).changes > 0,
  listHomeCards: (userId) => q.listHomeCards.all(userId),
  delHomeCard: (userId, id) => q.delHomeCard.run(id, userId).changes > 0,
  setProjectChannel: (guildId, channelId) => q.setProjectChannel.run(guildId, channelId),
  getProjectChannel: (guildId) => q.getProjectChannel.get(guildId)?.channel_id ?? null,
  clearProjectChannel: (guildId) => q.clearProjectChannel.run(guildId),
  setMain: (guildId, channelId, setBy) => q.setMain.run(guildId, channelId, setBy),
  getMain: (guildId) => q.getMain.get(guildId)?.channel_id ?? null,
  clearMain: (guildId) => q.clearMain.run(guildId),
  setManagedCategory: (guildId, categoryId) => q.setManagedCategory.run(guildId, categoryId),
  getManagedCategory: (guildId) => q.getManagedCategory.get(guildId)?.category_id ?? null,
  allPanels: () => q.allPanels.all().map(r => r.thread_id),
  saveSpecialty: (userId, name, instructions, intervalDays, now = Date.now()) =>
    q.saveSpecialty.run(userId, name, instructions, intervalDays, now, now),
  listSpecialties: (userId) => q.listSpecialties.all(userId),
  getSpecialty: (userId, id) => q.getSpecialty.get(id, userId) ?? null,
  findSpecialty: (userId, name) => q.findSpecialty.get(name, userId) ?? null,
  deleteSpecialty: (userId, id) => q.deleteSpecialty.run(id, userId).changes > 0,
  markSpecialtyRun: (userId, id, now = Date.now()) => q.markSpecialtyRun.run(now, id, userId),
  markSpecialtySuggested: (userId, id, now = Date.now()) => q.markSpecialtySuggested.run(now, id, userId),
  dueSpecialties: (now = Date.now()) => q.dueSpecialties.all(now),
  saveObservation: (userId, taskKey, task, instructions, now = Date.now()) => {
    q.saveObservation.run(userId, taskKey, task, instructions, now);
    return q.getObservation.get(userId, taskKey);
  },
  latestObservation: (userId) => q.latestObservation.get(userId) ?? null,
};

// Keep the schema so the running bot can restart after a test reset.
export function clearHarkletDatabase() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of tables) db.prepare('DELETE FROM "' + name.replaceAll('"', '""') + '"').run();
    db.exec('DELETE FROM sqlite_sequence');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return tables;
}
