import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a missing Python binary is an error for the caller, not a crash', async () => {
  process.env.HARKLET_CUA_PYTHON = 'C:/definitely/missing/python.exe';
  process.env.HARKLET_CUA_PORT = '7897';
  const { sidecar } = await import('../src/computer/sidecar.js');
  await assert.rejects(sidecar.screenshot('x'), /起動しませんでした/);
});

test('a provider error surfaces its message and does not escape', async () => {
  const { makeDecider } = await import('../src/computer/vision.js');
  const decide = makeDecider({
    provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'text-only',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'image input is not supported' } }) }),
  });
  await assert.rejects(
    decide({ task: 't', history: [], pngBase64: 'AAAA', width: 1, height: 1, secretNames: [] }),
    /LLM 400: image input is not supported/,
  );
});
