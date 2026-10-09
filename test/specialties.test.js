import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnCompletedWorkflow, parseSpecialtyDefinition, specialtyCandidate, specialtyDefinitionFromArg, specialtyDue, specialtyTask } from '../src/specialties.js';
import { runComputerTask } from '../src/computer/loop.js';

test('a repeatable recipe omits typed values, secret values, coordinates and URL queries', async () => {
  const script = [
    { action: 'navigate', url: 'https://example.com/work?session=private-token' },
    { action: 'click_element', index: 0 },
    { action: 'type', text: 'personal-input' },
    { action: 'type_secret', name: 'site_password' },
    { action: 'done', summary: 'finished' },
  ];
  const browser = {
    screenshot: async () => ({ png_base64: 'AAAA', width: 800, height: 600 }),
    elements: async () => ({ elements: [{ index: 0, role: 'button', label: 'Next', x: 20, y: 20 }] }),
    act: async () => {},
  };
  const result = await runComputerTask({ userId: 'u', task: 'weekly report', sessionId: 's', browser,
    vault: { listSecretNames: () => ['site_password'], getSecret: () => 'password-secret', takeSecret: () => 'password-secret' },
    decide: async () => script.shift(), requestSecrets: async () => null, settleMs: 0, sleep: async () => {},
  });
  const candidate = specialtyCandidate('weekly report', result);
  assert.equal(result.status, 'done');
  assert.match(candidate.instructions, /example.com/);
  assert.match(candidate.instructions, /ボタンかリンク/);
  for (const value of ['private-token', 'personal-input', 'password-secret', '(20,20)'])
    assert.equal(candidate.instructions.includes(value), false);
  assert.match(specialtyTask(candidate), /画面を必ず見直し/);
});

test('specialty definitions validate their name, instructions and interval', () => {
  assert.deepEqual(parseSpecialtyDefinition({ name: 'weekly', instructions: 'open site', interval_days: 7 }),
    { name: 'weekly', instructions: 'open site', interval_days: 7 });
  assert.equal(parseSpecialtyDefinition('{broken'), null);
  assert.equal(parseSpecialtyDefinition({ name: 'x', instructions: 'y', interval_days: 0 }), null);
  assert.equal(specialtyCandidate('x', { status: 'failed', stepsTaken: ['a', 'b'] }), null);
  assert.equal(specialtyDue({ interval_days: 7, last_run_at: 0 }, 7 * 86400000), true);
});

test('specialties are user-scoped and proactive suggestions require an enabled brief', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harklet-specialties-'));
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.DISCORD_CLIENT_ID = '1';
  process.env.HARKLET_DB = join(dir, 'test.db');
  const { store, db } = await import('../src/db.js');
  try {
    const completed = { status: 'done', stepsTaken: ['サイトを開く', '対象を選択'] };
    assert.equal(learnCompletedWorkflow(store, 'u1', 'weekly report', completed).promoted, false);
    assert.deepEqual(specialtyDefinitionFromArg(store, 'u1', '{"from_last":true,"interval_days":7}'),
      { name: 'weekly report', instructions: '1. サイトを開く\n2. 対象を選択', interval_days: 7 });
    assert.equal(specialtyDefinitionFromArg(store, 'u2', 'last'), null);
    assert.equal(store.findSpecialty('u1', 'weekly report'), null);
    assert.equal(learnCompletedWorkflow(store, 'u1', 'Weekly  report!', completed).promoted, true);
    assert.ok(store.findSpecialty('u1', 'weekly report'));
    assert.equal(learnCompletedWorkflow(store, 'u1', 'weekly report', completed).promoted, false);
    assert.equal(store.listSpecialties('u2').length, 0);
    const start = Date.now() - 8 * 86400000;
    store.saveSpecialty('u1', 'weekly', 'open example.com', 7, start);
    const own = store.findSpecialty('u1', 'weekly');
    assert.ok(own);
    assert.equal(store.getSpecialty('u2', own.id), null);
    assert.equal(store.dueSpecialties().length, 0);
    store.upsertSettings('u1', 1, '08:00', null);
    assert.equal(store.dueSpecialties().length, 1);
    store.markSpecialtySuggested('u1', own.id);
    assert.equal(store.dueSpecialties().length, 0);
    store.markSpecialtyRun('u1', own.id);
    assert.equal(store.dueSpecialties().length, 0);
    assert.equal(store.deleteSpecialty('u2', own.id), false);
    assert.equal(store.deleteSpecialty('u1', own.id), true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
