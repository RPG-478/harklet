import { config } from './config.js';

const modelCache = { at: 0, key: '', result: null };

export function isOpenRouter(baseUrl) {
  try { return new URL(baseUrl).hostname === 'openrouter.ai'; } catch { return false; }
}

export function modelChoices(ids, shown, query = '', requestedPage = 0) {
  const matches = ids.filter(id => id !== shown && id.toLowerCase().includes(query.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(matches.length / 24));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  return { choices: [shown, ...matches.slice(page * 24, (page + 1) * 24)], page, pageCount };
}

export async function fetchModelCatalog(llm, fetchImpl = fetch) {
  if (!llm.apiKey) return { ids: [], source: 'API', error: 'APIキーが設定されていません' };
  const openRouter = llm.provider === 'openai' && isOpenRouter(llm.baseUrl);
  const path = llm.provider === 'anthropic' ? '/v1/models' : openRouter ? '/models/user' : '/models';
  const headers = llm.provider === 'anthropic'
    ? { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' }
    : llm.provider === 'google' ? { 'x-goog-api-key': llm.apiKey }
      : { Authorization: `Bearer ${llm.apiKey}` };
  try {
    const ids = [];
    let pageToken = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL(llm.baseUrl + path);
      if (pageToken) url.searchParams.set(llm.provider === 'google' ? 'pageToken' : 'after_id', pageToken);
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000) });
      if (!response.ok) return { ids: [], source: path, error: `モデル一覧API: HTTP ${response.status}` };
      const body = await response.json();
      const records = llm.provider === 'google' ? body.models : body.data;
      if (!Array.isArray(records)) return { ids: [], source: path, error: 'モデル一覧APIの応答形式が不明です' };
      ids.push(...records
        .filter(m => llm.provider !== 'google' || m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => llm.provider === 'google' ? m.name?.replace(/^models\//, '') : m.id)
        .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100));
      const next = llm.provider === 'google' ? body.nextPageToken
        : llm.provider === 'anthropic' && body.has_more ? body.last_id : null;
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    const unique = [...new Set(ids)];
    return { ids: unique, source: path, error: unique.length ? null : '利用できるモデルが見つかりません' };
  } catch {
    return { ids: [], source: path, error: 'モデル一覧APIに接続できません' };
  }
}

export async function listModels() {
  const llm = config.llm;
  const key = [llm.provider, llm.baseUrl, llm.apiKey].join('\n');
  if (modelCache.result && modelCache.key === key && Date.now() - modelCache.at < 600_000) return modelCache.result;
  const result = await fetchModelCatalog(llm);
  if (!result.error) {
    modelCache.at = Date.now();
    modelCache.key = key;
    modelCache.result = result;
  }
  return result.error && modelCache.key === key && modelCache.result
    ? { ...modelCache.result, error: result.error + '（前回取得した一覧を表示）' }
    : result;
}
