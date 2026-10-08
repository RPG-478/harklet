import { readFileSync, writeFileSync } from "node:fs";
const log = [];
function edit(path, pairs) {
  let s = readFileSync(path, "utf8");
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { log.push("MISS " + path + " :: " + from.slice(0, 50)); continue; }
    s = s.replace(from, to);
  }
  writeFileSync(path, s);
}

// ---------- db.js ----------
edit("src/db.js", [
  ["  set_by TEXT NOT NULL\n);\n`);",
   "  set_by TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS home_cards (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  user_id TEXT NOT NULL,\n  title TEXT NOT NULL,\n  prompt TEXT NOT NULL,\n  emoji TEXT,\n  color INTEGER,\n  created_at INTEGER NOT NULL\n);\nCREATE TABLE IF NOT EXISTS project_channels (\n  guild_id TEXT PRIMARY KEY,\n  channel_id TEXT NOT NULL\n);\n`);"],
  ["  setMain: db.prepare(",
   "  addHomeCard: db.prepare('INSERT INTO home_cards (user_id, title, prompt, emoji, color, created_at) VALUES (?, ?, ?, ?, ?, ?)'),\n  listHomeCards: db.prepare('SELECT id, title, prompt, emoji, color FROM home_cards WHERE user_id = ? ORDER BY id'),\n  delHomeCard: db.prepare('DELETE FROM home_cards WHERE id = ? AND user_id = ?'),\n  setProjectChannel: db.prepare('INSERT OR REPLACE INTO project_channels (guild_id, channel_id) VALUES (?, ?)'),\n  getProjectChannel: db.prepare('SELECT channel_id FROM project_channels WHERE guild_id = ?'),\n  clearProjectChannel: db.prepare('DELETE FROM project_channels WHERE guild_id = ?'),\n  setMain: db.prepare("],
  ["  setMain: (guildId, channelId, setBy) => q.setMain.run(guildId, channelId, setBy),",
   "  addHomeCard: (userId, title, prompt, emoji, color) => q.addHomeCard.run(userId, title, prompt, emoji, color, Date.now()),\n  listHomeCards: (userId) => q.listHomeCards.all(userId),\n  delHomeCard: (userId, id) => q.delHomeCard.run(id, userId).changes > 0,\n  setProjectChannel: (guildId, channelId) => q.setProjectChannel.run(guildId, channelId),\n  getProjectChannel: (guildId) => q.getProjectChannel.get(guildId)?.channel_id ?? null,\n  clearProjectChannel: (guildId) => q.clearProjectChannel.run(guildId),\n  setMain: (guildId, channelId, setBy) => q.setMain.run(guildId, channelId, setBy),"],
]);

// ---------- register.js : /home cards subcommand ----------
edit("src/register.js", [
  [".addSubcommand(s => s.setName('off').setDescription('Homeを解除(自動更新停止)'))",
   ".addSubcommand(s => s.setName('cards').setDescription('カスタムカードの一覧・削除'))\n    .addSubcommand(s => s.setName('off').setDescription('Homeを解除(自動更新停止)'))"],
]);

// ---------- dsh-agent.js : home_card action kind ----------
edit("src/dsh-agent.js", [
  ["  - {\"label\": \"ボタン名\", \"kind\": \"memory\", \"arg\": \"覚える内容\"} … 記憶に保存",
   "  - {\"label\": \"ボタン名\", \"kind\": \"memory\", \"arg\": \"覚える内容\"} … 記憶に保存\n  - {\"label\": \"ホームに追加\", \"kind\": \"home_card\", \"arg\": \"{\\\"title\\\":\\\"カード名\\\",\\\"prompt\\\":\\\"30分ごとに生成する内容の指示\\\",\\\"emoji\\\":\\\"絵文字1つ\\\"}\"} … ユーザーのHomeに動的カードを追加。繰り返し見たい情報・定点観測・日次レポートなど、ユーザーが望んだ時だけ"],
]);

console.log(log.length ? log.join("\n") : "all applied");
