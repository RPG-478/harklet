// Retries only failures that a later attempt can fix. A model that rejects the request
// (for example, no image input) never gets a turn to act on the error, so it is not retried.
export function isTransient(err) {
  const status = err?.status;
  if (status === undefined) return true; // network error or timeout
  return status === 429 || status >= 500;
}

export async function withRetry(fn, { attempts = 3, retryIf = isTransient, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts || !retryIf(err)) break;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
  throw lastError;
}

export function retrying(fn, options) {
  return args => withRetry(() => fn(args), options);
}

// Only the screenshot is retried. Actions are not, because repeating a click or a
// typed value could do it twice.
export function retryingSidecar(browser, options) {
  return { ...browser, screenshot: id => withRetry(() => browser.screenshot(id), options) };
}
