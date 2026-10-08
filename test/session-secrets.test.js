import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionSecrets } from '../src/computer/session-secrets.js';
import { parseAction } from '../src/computer/actions.js';

test('one-time login codes are available only for their origin and consumed once', () => {
  const persisted = new Map([['password', 'saved-password'], ['discord_2fa_code', 'expired-code']]);
  const vault = {
    listSecretNames: () => [...persisted.keys()],
    getSecret: (_user, name) => persisted.get(name) ?? null,
    deleteSecret: (_user, name) => persisted.delete(name),
  };
  let origin = 'https://discord.com';
  const secrets = new SessionSecrets(vault, 'user', () => origin);
  assert.deepEqual(secrets.names(), ['password']);
  secrets.setOneTime('discord_2fa_code', '123456', origin);
  assert.equal(persisted.has('discord_2fa_code'), false);
  assert.deepEqual(secrets.names(), ['password', 'discord_2fa_code']);
  origin = 'https://example.com';
  assert.equal(secrets.get('discord_2fa_code'), null);
  origin = 'https://discord.com';
  assert.equal(secrets.take('discord_2fa_code'), '123456');
  assert.equal(secrets.get('discord_2fa_code'), null);
  assert.deepEqual(secrets.names(), ['password']);
  assert.equal(secrets.take('password'), 'saved-password');
  assert.equal(secrets.get('password'), 'saved-password');
});

test('verification code fields are marked as one-time even if the model omits the flag', () => {
  const parsed = parseAction({ action: 'request_secrets', fields: [
    { name: 'discord_2fa_code', label: '6桁の認証コード' },
    { name: 'discord_password', label: 'パスワード' },
  ] }, { width: 800, height: 600 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action.fields[0].one_time, true);
  assert.equal(parsed.action.fields[1].one_time, false);
});
