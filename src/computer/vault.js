import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { isSecretName } from './names.js';

db.exec(
  'CREATE TABLE IF NOT EXISTS computer_secrets (' +
  'user_id TEXT NOT NULL, name TEXT NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, ' +
  'ct BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, name))'
);

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
  'INSERT INTO computer_secrets (user_id, name, iv, tag, ct, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(user_id, name) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, ct=excluded.ct, updated_at=excluded.updated_at'
);
const getRow = db.prepare('SELECT iv, tag, ct FROM computer_secrets WHERE user_id = ? AND name = ?');
const listRows = db.prepare('SELECT name FROM computer_secrets WHERE user_id = ? ORDER BY name');
const delRow = db.prepare('DELETE FROM computer_secrets WHERE user_id = ? AND name = ?');

export function setSecret(userId, name, value) {
  if (!isSecretName(name)) throw new Error('secret name is invalid');
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE) throw new Error('secret value is invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  upsert.run(userId, name, iv, cipher.getAuthTag(), ct, Date.now());
}

export function getSecret(userId, name) {
  if (!isSecretName(name)) return null;
  const row = getRow.get(userId, name);
  if (!row) return null;
  const decipher = createDecipheriv('aes-256-gcm', key(), row.iv);
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.ct), decipher.final()]).toString('utf8');
}

export function listSecretNames(userId) {
  return listRows.all(userId).map(r => r.name);
}

export function deleteSecret(userId, name) {
  delRow.run(userId, name);
}

export const vault = { setSecret, getSecret, listSecretNames, deleteSecret };
