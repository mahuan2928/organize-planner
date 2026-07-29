// SSO ログイン（Lark OAuth）＋ 管理者判定 ＋ セッション
// 方針: 管理者（is_tenant_manager）以外はログインを拒否する。
//       セッション実体は KV に置き、Cookie にはランダムなセッションIDだけを入れる。

import { contact } from './lark.js';

const ACCOUNTS = 'https://accounts.larksuite.com';
const OPEN = 'https://open.larksuite.com';
const COOKIE = 'orgp_sid';
const SESSION_TTL = 60 * 60 * 8;   // 8時間

const rnd = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

// ---------- Cookie ----------
export function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
const setCookie = (name, val, maxAge) =>
  `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---------- OAuth ----------
/** 認可画面の URL を作る。state は CSRF 対策として KV に控える */
export async function buildLoginUrl(env, redirectUri) {
  const state = rnd();
  await env.SESSIONS.put(`state:${state}`, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.LARK_APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    // Base 台帳を本人資格で読み書きするためのスコープ（組織書き込みは bot 側で行う）
    scope: [
      'offline_access',
      'contact:contact.base:readonly',
      'base:record:create', 'base:record:read', 'base:record:update', 'base:record:delete',
      'base:table:read', 'base:app:read'
    ].join(' ')
  });
  return { url: `${ACCOUNTS}/open-apis/authen/v1/authorize?${q}`, state };
}

// OAuth v2 は code を「文字列」で返す（成功は "0"）。v1 系は数値 0 なので両方を許容する
const isOk = (j) => String(j.code ?? '0') === '0' && !j.error;

// 失敗コードを利用者に伝わる日本語へ（公式のエラーコード表に対応）
const TOKEN_ERRORS = {
  '20002': 'アプリの認証に失敗しました。App ID / App Secret をご確認ください。',
  '20003': '認可コードが無効です（一度しか使用できません）。もう一度ログインしてください。',
  '20004': '認可コードの有効期限が切れました（5分）。もう一度ログインしてください。',
  '20009': 'このアプリがテナントにインストールされていません。',
  '20010': 'このアプリを利用する権限がありません。管理者にアプリの可用範囲をご確認ください。',
  '20024': '認可コードとアプリが一致しません。'
};

/** 認可コード → user_access_token */
export async function exchangeCode(env, code, redirectUri) {
  const r = await fetch(`${OPEN}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: env.LARK_APP_ID,
      client_secret: env.LARK_APP_SECRET,
      code, redirect_uri: redirectUri   // 認可時と完全一致させる必要がある（Web アプリでは必須）
    })
  });
  const j = await r.json();
  if (!isOk(j)) {
    const msg = TOKEN_ERRORS[String(j.code)] || j.error_description || j.error || `コード ${j.code}`;
    throw new Error(`ログインに失敗しました: ${msg}`);
  }
  return j;   // { access_token, expires_in, refresh_token, refresh_token_expires_in, scope, token_type }
}

/** ログイン中ユーザーの基本情報 */
export async function fetchUserInfo(userToken) {
  const r = await fetch(`${OPEN}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  const j = await r.json();
  if (!isOk(j)) throw new Error(`ユーザー情報の取得に失敗しました: ${j.msg || j.error_description || j.code}`);
  return j.data || {};   // { open_id, name, ... }
}

/** 管理者かどうか（Lark の is_tenant_manager が唯一の根拠） */
export async function isTenantManager(env, openId) {
  const j = await contact(env, 'GET', `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
    { params: { user_id_type: 'open_id' } });
  return !!((j.data || {}).user || {}).is_tenant_manager;
}

// ---------- セッション ----------
export async function createSession(env, data) {
  const sid = rnd();
  await env.SESSIONS.put(`sess:${sid}`, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return { sid, cookie: setCookie(COOKIE, sid, SESSION_TTL) };
}
export async function getSession(env, req) {
  const sid = readCookie(req, COOKIE);
  if (!sid) return null;
  const raw = await env.SESSIONS.get(`sess:${sid}`);
  if (!raw) return null;
  try { return { sid, ...JSON.parse(raw) }; } catch { return null; }
}
export async function destroySession(env, req) {
  const sid = readCookie(req, COOKIE);
  if (sid) await env.SESSIONS.delete(`sess:${sid}`);
  return setCookie(COOKIE, '', 0);
}
export const stateOk = async (env, state) => {
  if (!state) return false;
  const hit = await env.SESSIONS.get(`state:${state}`);
  if (hit) await env.SESSIONS.delete(`state:${state}`);
  return !!hit;
};
