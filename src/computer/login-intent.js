// A direct site-login request must reach Computer Use even when the chat model
// responds with a generic manual-login refusal and omits the action.
export function ensureLoginHandoff(userText, result) {
  const task = String(userText ?? '').trim();
  if (result.actions?.some(a => a?.kind === 'computer')) return result;
  if (/[?？]/.test(task) || /(?:できる|方法|どうやって|教えて)/.test(task)) return result;
  if (!/^(?:https?:\/\/\S+|[\p{L}\p{N}._ -]{2,80})(?:に|へ|で)ログイン(?:して.*|する|してください)?[。!！]?$/u.test(task)) return result;
  return {
    ...result,
    reply: '専用ブラウザでログインを始めます。必要な入力はDiscordのモーダルでお願いします。',
    actions: [...(result.actions ?? []).slice(0, 2), { kind: 'computer', arg: task, auto: true }],
  };
}
