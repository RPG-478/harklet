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
`);

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
  dueReminders: db.prepare('SELECT id, user_id, channel_id, text FROM reminders WHERE delivered = 0 AND due_at <= ?'),
  markDelivered: db.prepare('UPDATE reminders SET delivered = 1 WHERE id = ?'),
  cancelReminder: db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?'),
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
};

