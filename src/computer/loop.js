import { parseAction } from './actions.js';
import { redact } from './names.js';

// Stop only after this many turns in a row without a model reply or a screen.
const MAX_CONSECUTIVE_FAILURES = 3;
// Actions that need a screenshot to aim at. Without an image they are refused.
const COORDINATE_ACTIONS = new Set(['click', 'double_click', 'right_click', 'move', 'scroll']);

function toBridge(a) {
  switch (a.action) {
    case 'navigate': return { type: 'navigate', url: a.url };
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
      return { type: a.action, x: a.x, y: a.y };
    case 'click_element':
      return { type: 'click_element', index: a.index };
    case 'fill':
      return { type: 'fill', index: a.index, text: a.text };
    case 'scroll':
      return { type: 'scroll', x: a.x, y: a.y, dy: a.dy };
    case 'type':
      return { type: 'type', text: a.text };
    case 'key':
      return { type: 'key', keys: a.keys };
    default:
      throw new Error('no bridge mapping for ' + a.action);
  }
}

async function readElements(browser, sessionId) {
  try {
    return await browser.elements(sessionId);
  } catch {
    return null;
  }
}

function describe(a) {
  switch (a.action) {
    case 'navigate': return 'navigate ' + a.url;
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
      return a.action + ' (' + a.x + ',' + a.y + ')';
    case 'click_element':
      return 'click_element #' + a.index;
    case 'fill':
      return 'fill #' + a.index + ' "' + String(a.text).slice(0, 30) + '"';
    case 'scroll':
      return 'scroll (' + a.x + ',' + a.y + ') dy=' + a.dy;
    case 'type':
      return 'type "' + a.text.slice(0, 40) + '"';
    case 'key':
      return 'key ' + a.keys.join('+');
    default:
      return a.action;
  }
}

// Runs observe -> decide -> act until the model says done/fail, or a limit is hit.
// Problems on the model or screen side are written into the history, so the next
// turn can see them. A rejected image switches the run to element-only control.
// The run stops only after several turns in a row fail.
// Secret values only ever go from the vault to the browser action (type_secret). They are
// never passed to decide(), never put in history and never returned in the result.
export async function runComputerTask(opts) {
  const {
    userId, task, sessionId, browser, vault, decide, requestSecrets, chooseAuthMethod, shareAuthQr, requestHuman, progress,
    signal, maxSteps = 40, deadlineMs = 15 * 60 * 1000, settleMs = 700,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = opts;
  const started = Date.now();
  const history = [];
  const stepsTaken = [];
  const rememberStep = (step) => {
    if (step && stepsTaken.length < 25) stepsTaken.push(step);
  };
  const note = line => {
    history.push(line);
    if (history.length > 30) history.splice(0, history.length - 30);
  };
  let useImage = true;
  let failures = 0;
  let size = { width: 0, height: 0 };
  const recentActs = [];
  const PASSIVE_ACTIONS = new Set(['click', 'double_click', 'right_click', 'move', 'click_element']);
  let lastObsKey = '';
  let lastMeaningfulStep = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return { status: 'stopped' };
    if (Date.now() - started > deadlineMs) return { status: 'timeout' };

    const tObserve = Date.now();
    // Screenshot and element listing are independent; run them together.
    const [shotRes, elementList] = await Promise.all([
      browser.screenshot(sessionId).then(r => ({ r })).catch(err => ({ err })),
      readElements(browser, sessionId),
    ]);
    // Stall key: page URL plus a fingerprint of the element list. Titles
    // flicker on captcha pages, which would reset the counter every step.
    const els = elementList?.elements;
    const obsKey = (elementList?.window?.url ?? '') + '|' + (els ? els.length + ':' + els.slice(0, 12).map(e => e.role + ' ' + e.label).join(';') : (elementList?.window?.title ?? ''));
    if (obsKey !== lastObsKey) { lastObsKey = obsKey; lastMeaningfulStep = step; }
    const observeMs = Date.now() - tObserve;
    let shot = null;
    if (shotRes.r) {
      shot = shotRes.r;
      size = { width: shot.width, height: shot.height };
    } else {
      note(step + '. 画面を取得できませんでした（' + shotRes.err.message + '）。今回は要素一覧で操作します');
    }
    const imageSent = useImage && shot !== null;
    if (!imageSent && !elementList) {
      return { status: 'failed', reason: '画像も要素一覧もないので操作できませんでした', steps: step };
    }

    const secretNames = vault.listSecretNames(userId);
    const known = new Map();
    for (const name of secretNames) {
      const v = vault.getSecret(userId, name);
      if (v) known.set(name, v);
    }

    let raw;
    const tDecide = Date.now();
    try {
      raw = await decide({
        task,
        history: history.slice(-12).map(h => redact(h, known)),
        pngBase64: imageSent ? shot.png_base64 : null,
        width: size.width,
        height: size.height,
        secretNames,
        elements: elementList ? elementList.elements : null,
        window: elementList?.window ?? null,
      });
    } catch (err) {
      failures++;
      if (useImage && err.status === 400) {
        useImage = false;
        note(step + '. 画像付きの送信が拒否されました（' + err.message + '）。以後は要素一覧だけで操作します');
      } else {
        note(step + '. モデルへの送信が失敗しました（' + err.message + '）');
      }
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return { status: 'failed', reason: '連続して応答を得られませんでした: ' + err.message, steps: step };
      }
      continue;
    }
    const decideMs = Date.now() - tDecide;

    failures = shot ? 0 : failures + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      return { status: 'failed', reason: '画面を取得できない状態が続いたので止めました', steps: step };
    }

    const parsed = parseAction(raw, {
      width: size.width,
      height: size.height,
      elementCount: elementList ? elementList.elements.length : 0,
    });
    if (!parsed.ok) {
      note(step + '. 無効な応答: ' + parsed.error);
      continue;
    }
    const a = parsed.action;
    console.log('[cu] step', step, 'observe=' + observeMs + 'ms decide=' + decideMs + 'ms action=' + a.action);

    if (!imageSent && COORDINATE_ACTIONS.has(a.action)) {
      note(step + '. 画像がないので座標操作は使えません。要素番号（click_element）で操作してください');
      continue;
    }

    if (a.action === 'done') return { status: 'done', summary: a.summary, rememberSpecialty: a.remember, steps: step, stepsTaken };
    if (a.action === 'fail') return { status: 'failed', reason: a.reason, steps: step };

    // No visible page change for a while: nudge, then hand to the human.
    const stale = step - lastMeaningfulStep;
    if (stale >= 15) {
      const result = await requestHuman?.({ message: '画面操作が進みません。表示されている確認（CAPTCHAや人間確認）を解いてください' });
      lastMeaningfulStep = step;
      if (result === 'unavailable') return { status: 'failed', reason: '画面が長時間変化せず、人間確認も依頼できませんでした', steps: step };
      if (signal?.aborted) return { status: 'stopped' };
      note(step + '. 画面が ' + stale + ' ステップ変化しないため本人に確認を依頼しました');
      continue;
    }
    if (stale >= 8 && PASSIVE_ACTIONS.has(a.action)) {
      note(step + '. 画面が ' + stale + ' ステップ変化していません。クリックでは進めないようなら request_human を使ってください');
      continue;
    }

    // Repeating the exact same action three times in a row means the model is
    // stuck on something that does not change the page. Break the loop.
    const signature = a.action + ':' + JSON.stringify({ x: a.x, y: a.y, index: a.index, url: a.url, text: a.text?.slice(0, 30) });
    recentActs.push(signature);
    if (recentActs.length > 3) recentActs.shift();
    if (recentActs.length === 3 && recentActs[0] === signature && recentActs[1] === signature) {
      note(step + '. 同じ操作が3回続きました。別の手段（fillで入力、scroll、要素番号、またはURL直接移動）を試してください');
      continue;
    }

    if (a.action === 'request_secrets') {
      const saved = await requestSecrets({ message: a.message, fields: a.fields });
      if (!saved) return { status: 'credentials_timeout', steps: step };
      lastMeaningfulStep = step;
      note(step + '. ログイン情報を保存 (' + saved.join(', ') + ', 値は非表示)');
      rememberStep('必要なログイン情報を本人に確認');
    } else if (a.action === 'choose_auth_method') {
      const selected = await chooseAuthMethod?.({ message: a.message, options: a.options });
      if (!selected) return { status: 'credentials_timeout', steps: step };
      const chosen = a.options.find(o => o.id === selected);
      if (!chosen) { note(step + '. 認証方法の選択が無効でした'); continue; }
      note(step + '. 利用者が選んだ認証方法: ' + chosen.label + ' (' + chosen.id + ')。画面上でこの方法を選択してください');
      rememberStep('利用者が認証方法を選択');
    } else if (a.action === 'share_auth_qr') {
      if (!imageSent) { note(step + '. 画像がないため認証画面を送れませんでした'); continue; }
      const shared = await shareAuthQr?.({ png: Buffer.from(shot.png_base64, 'base64'), message: a.message });
      if (!shared) return { status: 'failed', reason: '認証画面のDM確認ができませんでした', steps: step };
      note(step + '. 認証画面を本人のDiscord DMで確認しました。画面の変化を確認してください');
      rememberStep('認証用の画面を本人に確認');
    } else if (a.action === 'request_human') {
      const result = await requestHuman?.({ message: a.message });
      if (result === 'unavailable') {
        return { status: 'failed', reason: '人間確認が出ましたが、画面ビューアが操作できない設定なので解けませんでした', steps: step };
      }
      if (signal?.aborted) return { status: 'stopped' };
      if (result) {
        note(step + '. 本人が画面の確認を解決しました。変化を確認してください');
        rememberStep('画面の人間確認を本人が解決');
      } else {
        note(step + '. 人間確認の依頼に回答がありませんでした。画面を再確認してください');
      }
    } else if (a.action === 'type_secret') {
      try {
        const value = vault.takeSecret ? vault.takeSecret(userId, a.name) : vault.getSecret(userId, a.name);
        if (value === null) {
          note(step + '. type_secret ' + a.name + ' は未保存のため失敗');
        } else {
          await browser.act(sessionId, { type: 'type', text: value });
          lastMeaningfulStep = step;
          note(step + '. type_secret ' + a.name + ' を入力');
          rememberStep('保存済みのログイン情報を入力');
        }
      } catch {
        note(step + '. type_secret ' + a.name + ' は失敗');
      }
    } else if (a.action === 'wait') {
      lastMeaningfulStep = step;
      await sleep(a.seconds * 1000);
      note(step + '. wait ' + a.seconds + '秒');
    } else {
      try {
        if (!PASSIVE_ACTIONS.has(a.action)) lastMeaningfulStep = step;
        await browser.act(sessionId, toBridge(a));
        note(step + '. ' + describe(a));
        if (a.action === 'navigate') rememberStep('サイト ' + new URL(a.url).origin + ' を開く');
        else if (a.action === 'click_element') {
          const el = elementList?.elements?.[a.index];
          const kind = ['button', 'a', 'link'].includes(el?.role) ? 'ボタンかリンク' : '要素';
          rememberStep(`画面の${kind}を選択`);
        } else if (['click', 'double_click', 'right_click'].includes(a.action)) rememberStep('画面上の対象を選択');
        else if (a.action === 'fill') rememberStep('入力欄に必要な文字を入力');
        else if (a.action === 'type') rememberStep('通常の入力欄に必要な文字を入力');
        else if (a.action === 'scroll') rememberStep('画面をスクロール');
        else if (a.action === 'key') rememberStep('キーボード操作で次へ進む');
      } catch (err) {
        note(step + '. ' + describe(a) + ' は失敗: ' + err.message);
      }
    }

    if (progress && step % 5 === 0) await progress('⏳ ' + step + ' 手目まで進みました');
    await sleep(settleMs);
  }
  return { status: 'max_steps', steps: maxSteps };
}
