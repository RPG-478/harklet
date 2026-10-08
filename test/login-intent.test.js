import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLoginHandoff } from '../src/computer/login-intent.js';

test('a direct Discord login request reaches the browser despite a model refusal', () => {
  const out = ensureLoginHandoff('Discordにログイン', { reply: '手動ログインしてください', actions: [] });
  assert.deepEqual(out.actions, [{ kind: 'computer', arg: 'Discordにログイン', auto: true }]);
  assert.match(out.reply, /モーダル/);
});

test('login questions and existing browser actions are left alone', () => {
  const base = { reply: 'できます', actions: [] };
  assert.equal(ensureLoginHandoff('Discordにログインできる？', base), base);
  assert.equal(ensureLoginHandoff('Discordのログイン方法を教えて', base), base);
  const already = { reply: '始めます', actions: [{ kind: 'computer', arg: 'Discordにログイン' }] };
  assert.equal(ensureLoginHandoff('Discordにログイン', already), already);
});
