import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('old secret rows migrate without becoming available to a website', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harklet-vault-test-'));
  const file = join(dir, 'harklet.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE computer_secrets (user_id TEXT NOT NULL, name TEXT NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, ct BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, name))');
  old.prepare('INSERT INTO computer_secrets VALUES (?,?,?,?,?,?)').run('u', 'password', Buffer.alloc(12), Buffer.alloc(16), Buffer.from('old'), 1);
  old.close();
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.DISCORD_CLIENT_ID = '1';
  process.env.HARKLET_DB = file;
  process.env.HARKLET_SECRET_KEY = 'unit-test-secret-key-0123456789';
  try {
    const vault = await import('../src/computer/vault.js');
    assert.deepEqual(vault.listSecretNames('u', 'https://example.com'), []);
    vault.setSecret('u', 'password', 'new', 'https://example.com');
    assert.equal(vault.getSecret('u', 'password', 'https://example.com'), 'new');
    assert.equal(vault.getSecret('u', 'password', 'https://other.example'), null);
  } finally {
    const { db } = await import('../src/db.js');
    db.close();
    const target = resolve(dir);
    if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
