import { config } from './config.js';

// モデル一覧をプロバイダAPIから自動取得(10分キャッシュ)
const modelCache = { at: 0, list: [] };

export async function listModels() {
  if (Date.now() - modelCache.at < 600_000 && modelCache.list.length) return modelCache.list;
  const llm = config.llm;
  let ids = [];
  try {
    if (llm.provider === 'openai') {
      const r = await fetch(`${llm.baseUrl}/models`, { headers: { Authorization: `Bearer ${llm.apiKey}` } });
      if (r.ok) ids = (await r.json()).data?.map(m => m.id) ?? [];
    } else if (llm.provider === 'anthropic') {
      const r = await fetch(`${llm.baseUrl}/v1/models`, {
        headers: { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (r.ok) ids = (await r.json()).data?.map(m => m.id) ?? [];
    } else if (llm.provider === 'google') {
      const r = await fetch(`${llm.baseUrl}/models`, { headers: { 'x-goog-api-key': llm.apiKey } });
      if (r.ok) ids = (await r.json()).models?.map(m => m.name?.replace(/^models\//, '')) ?? [];
    }
  } catch { /* 取得失敗時は前回値かフォールバックを使う */ }
  if (ids.length) {
    modelCache.at = Date.now();
    modelCache.list = ids;
  }
  return modelCache.list;
}
