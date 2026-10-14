import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebUi } from '../src/web/server.js';

test('web dashboard requires a one-time user link and keeps actions user-scoped', async () => {
  const called = [];
  const web = await startWebUi({
    port: 0,
    state: userId => ({ userId }),
    chat: (userId, text) => ({ userId, reply: text, buttons: [], events: [] }),
    action: (userId, id) => { called.push([userId, id]); return { message: 'done' }; },
    panel: (userId, id) => ({ content: `${userId}:${id}` }),
  });
  const base = `http://127.0.0.1:${web.port}`;
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const link = web.issueLink('user-a');
    const open = await fetch(link, { redirect: 'manual' });
    assert.equal(open.status, 303);
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 403);
    const cookie = open.headers.get('set-cookie').split(';')[0];
    const headers = { cookie };
    const state = await fetch(base + '/api/state', { headers }).then(r => r.json());
    assert.equal(state.userId, 'user-a');
    assert.equal((await fetch(base + '/app.js', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers: { ...headers, origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{"text":"hi"}' })).status, 403);
    const reply = await fetch(base + '/api/chat', { method: 'POST', headers: { ...headers, origin: base, 'content-type': 'application/json' }, body: '{"text":"hi"}' }).then(r => r.json());
    assert.equal(reply.reply, 'hi');
    const action = await fetch(base + '/api/action', { method: 'POST', headers: { ...headers, origin: base, 'content-type': 'application/json' }, body: '{"id":7}' }).then(r => r.json());
    assert.equal(action.message, 'done');
    assert.deepEqual(called, [['user-a', 7]]);
    const panel = await fetch(base + '/api/panel', { method: 'POST', headers: { ...headers, origin: base, 'content-type': 'application/json' }, body: '{"id":3}' }).then(r => r.json());
    assert.equal(panel.content, 'user-a:3');
  } finally { await web.close(); }
});
