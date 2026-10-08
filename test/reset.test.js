import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'harklet-reset-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = '123';
process.env.HARKLET_DB = join(dir, 'test.db');
process.env.HARKLET_SECRET_KEY = 'reset-test-secret-key-0123456789';
const { db, store, clearHarkletDatabase } = await import('../src/db.js');
const { vault } = await import('../src/computer/vault.js');

test('test reset clears bot data including credentials and keeps the schema usable', async () => {
  try {
    store.addMemory('u', 'remember me');
    store.setMain('guild', 'channel', 'u');
    store.setManagedCategory('guild', 'category');
    vault.setSecret('u', 'site_password', 'password-value', 'https://example.com');
    const cleared = clearHarkletDatabase();
    assert.ok(cleared.includes('computer_secrets'));
    assert.equal(store.listMemories('u').length, 0);
    assert.equal(store.getMain('guild'), null);
    assert.equal(store.getManagedCategory('guild'), null);
    assert.equal(vault.getSecret('u', 'site_password', 'https://example.com'), null);
    store.addMemory('u', 'new start');
    assert.equal(store.listMemories('u')[0].content, 'new start');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
