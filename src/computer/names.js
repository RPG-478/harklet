// Rules shared by the vault, the action parser and the loop.
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function isSecretName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// Replace each known secret value in text with its name. Longer values go first
// so a value that contains another value is still fully hidden.
export function redact(text, secrets) {
  let out = String(text ?? '');
  const pairs = [...secrets.entries()]
    .filter(([, v]) => typeof v === 'string' && v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of pairs) out = out.split(value).join('[secret:' + name + ']');
  return out;
}
