import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { isSecretName } from './names.js';

const schema = 'CREATE TABLE computer_secrets (' +
  'user_id TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, ' +
  'ct BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, origin, name))';
const columns = db.prepare('PRAGMA table_info(computer_secrets)').all();
if (!columns.length) {
  db.exec(schema);
} else if (!columns.some(c => c.name === 'origin' && c.pk === 2)) {
  // The Docker prototype keyed secrets only by user and name. Keep its rows
  // unscoped (and inaccessible) until the user enters them for a site again.
  const origin = columns.some(c => c.name === 'origin') ? 'origin' : "''";
  db.exec('BEGIN');
  try {
    db.exec(schema.replace('computer_secrets (', 'computer_secrets_new ('));
    db.exec(`INSERT INTO computer_secrets_new (user_id,name,origin,iv,tag,ct,updated_at) ` +
      `SELECT user_id,name,${origin},iv,tag,ct,updated_at FROM computer_secrets`);
    db.exec('DROP TABLE computer_secrets; ALTER TABLE computer_secrets_new RENAME TO computer_secrets; COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

const MAX_VALUE = 1000;

// Values are encrypted with AES-256-GCM. The key is derived from HARKLET_SECRET_KEY,
// which must stay in .env and never be committed.
export function vaultReady() {
  return (process.env.HARKLET_SECRET_KEY?.trim().length ?? 0) >= 16;
}

function key() {
  const raw = process.env.HARKLET_SECRET_KEY?.trim() ?? '';
  if (raw.length < 16) {
    throw new Error('HARKLET_SECRET_KEY が未設定か短すぎます（16文字以上の .env 値が必要です）');
  }
  return createHash('sha256').update(raw).digest();
}

const upsert = db.prepare(
  'INSERT INTO computer_secrets (user_id, name, iv, tag, ct, origin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(user_id, origin, name) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, ct=excluded.ct, updated_at=excluded.updated_at'
);
const getRow = db.prepare('SELECT iv, tag, ct FROM computer_secrets WHERE user_id = ? AND name = ? AND origin = ?');
const listRows = db.prepare('SELECT name FROM computer_secrets WHERE user_id = ? AND origin = ? ORDER BY name');
const delRow = db.prepare('DELETE FROM computer_secrets WHERE user_id = ? AND name = ?');

export function setSecret(userId, name, value, origin) {
  if (!isSecretName(name)) throw new Error('secret name is invalid');
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE) throw new Error('secret value is invalid');
  try {
    const u = new URL(origin);
    if (u.origin !== origin || u.protocol !== 'https:') throw new Error();
  } catch { throw new Error('secret origin is invalid'); }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  upsert.run(userId, name, iv, cipher.getAuthTag(), ct, origin, Date.now());
}

export function getSecret(userId, name, origin) {
  if (!isSecretName(name) || !origin) return null;
  const row = getRow.get(userId, name, origin);
  if (!row) return null;
  const decipher = createDecipheriv('aes-256-gcm', key(), row.iv);
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.ct), decipher.final()]).toString('utf8');
}

export function listSecretNames(userId, origin) {
  return origin ? listRows.all(userId, origin).map(r => r.name) : [];
}

export function deleteSecret(userId, name) {
  delRow.run(userId, name);
}

export const vault = { setSecret, getSecret, listSecretNames, deleteSecret };
