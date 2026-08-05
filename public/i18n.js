(function () {
  const STORAGE_KEY = 'orgplanner_locale';
  const SUPPORTED = ['ja', 'en', 'zh'];
  const DEFAULT_LOCALE = 'ja';

  function normalizeLocale(locale) {
    const raw = String(locale || '').toLowerCase();
    if (raw.startsWith('zh')) return 'zh';
    if (raw.startsWith('en')) return 'en';
    if (raw.startsWith('ja')) return 'ja';
    return '';
  }

  function detectLocale() {
    const fromQuery = new URLSearchParams(location.search).get('lang');
    const saved = localStorage.getItem(STORAGE_KEY);
    const browser = navigator.languages && navigator.languages.length ? navigator.languages[0] : navigator.language;
    return normalizeLocale(fromQuery) || normalizeLocale(saved) || normalizeLocale(browser) || DEFAULT_LOCALE;
  }

  let currentLocale = detectLocale();

  function dict(locale = currentLocale) {
    const all = window.ORG_LOCALES || {};
    return all[locale] || all[DEFAULT_LOCALE] || {};
  }

  function t(key, params) {
    const fallback = dict(DEFAULT_LOCALE);
    let text = dict()[key] ?? fallback[key] ?? key;
    if (params && typeof text === 'string') {
      Object.keys(params).forEach((name) => {
        text = text.replaceAll(`{${name}}`, String(params[name]));
      });
    }
    return text;
  }

  function applyI18n(root = document) {
    document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : currentLocale;
    document.title = t('app.title');
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });
    const selector = document.getElementById('localeSelect');
    if (selector) selector.value = currentLocale;
  }

  function setLocale(locale) {
    const next = normalizeLocale(locale);
    if (!SUPPORTED.includes(next) || next === currentLocale) return;
    currentLocale = next;
    localStorage.setItem(STORAGE_KEY, currentLocale);
    applyI18n();
    window.dispatchEvent(new CustomEvent('org-localechange', { detail: { locale: currentLocale } }));
  }

  function getLocale() {
    return currentLocale;
  }

  function collator() {
    return new Intl.Collator(currentLocale === 'zh' ? 'zh-CN' : currentLocale, { numeric: true, sensitivity: 'base' });
  }

  function init() {
    applyI18n();
    const selector = document.getElementById('localeSelect');
    if (selector) selector.addEventListener('change', (e) => setLocale(e.target.value));
  }

  window.OrgI18n = { t, applyI18n, setLocale, getLocale, collator };
  window.t = t;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
