import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = '1';
const { fetchModelCatalog, modelChoices } = await import('../src/llm.js');

test('OpenRouter lists models available to the configured key', async () => {
  let url;
  const catalog = await fetchModelCatalog({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test' },
    async (request, options) => {
      url = String(request);
      assert.equal(options.headers.Authorization, 'Bearer test');
      return { ok: true, json: async () => ({ data: [{ id: 'a/model' }, { id: 'b/model' }] }) };
    });
  assert.equal(url, 'https://openrouter.ai/api/v1/models/user');
  assert.deepEqual(catalog.ids, ['a/model', 'b/model']);
});

test('model selection pages and searches the entire catalog', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `provider/model-${i}`);
  const last = modelChoices(ids, 'current/model', '', 2);
  assert.equal(last.pageCount, 3);
  assert.equal(last.choices.length, 13);
  assert.ok(last.choices.includes('provider/model-59'));
  assert.deepEqual(modelChoices(ids, 'current/model', 'model-59').choices,
    ['current/model', 'provider/model-59']);
});

test('native provider pagination and API errors are surfaced', async () => {
  const urls = [];
  const google = await fetchModelCatalog({ provider: 'google', baseUrl: 'https://example.test/v1beta', apiKey: 'test' },
    async url => {
      urls.push(String(url));
      return { ok: true, json: async () => urls.length === 1
        ? { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' }
        : { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] } };
    });
  assert.deepEqual(google.ids, ['gemini-a', 'gemini-b']);
  assert.ok(urls[1].includes('pageToken=next'));
  const failed = await fetchModelCatalog({ provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'test' },
    async () => ({ ok: false, status: 401 }));
  assert.match(failed.error, /401/);
  assert.deepEqual(failed.ids, []);
});
