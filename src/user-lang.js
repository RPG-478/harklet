// Conversation output accepts any language tag. Fixed UI has en/ja/zh catalogs.
import { store } from './db.js';
import { detectLang, normalizeLocale } from './i18n.js';

export function userLang(userId, { locale, text } = {}) {
  const s = store.getSettings(userId) ?? {};
  return normalizeLocale(s.lang || locale || s.lang_auto || detectLang(text) || 'en');
}

export function responseLanguage(userId) {
  const s = store.getSettings(userId) ?? {};
  return s.lang || s.lang_auto || 'en';
}

export function noteLocale(userId, locale) {
  if (locale && !store.getSettings(userId)?.lang) store.setLangAuto(userId, normalizeLocale(locale));
}

export function noteAutoLang(userId, text) {
  const s = store.getSettings(userId) ?? {};
  if (s.lang) return;
  let det = detectLang(text);
  // Han alone cannot distinguish Chinese from Japanese. Keep a known Japanese preference.
  if (det === 'zh' && s.lang_auto === 'ja') det = 'ja';
  if (det && s.lang_auto !== det) store.setLangAuto(userId, det);
}

export function languageTag(value) {
  try { return Intl.getCanonicalLocales(String(value).trim())[0] ?? null; } catch { return null; }
}
