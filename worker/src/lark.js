// Lark OpenAPI クライアント（lark-cli 非依存・Cloudflare Workers 用）
// 認証の使い分け（実測で確定）:
//   - Contact 書き込み（組織変更）= tenant_access_token のみ。user_access_token は 99991668 で拒否される
//   - Contact 読み取り        = tenant_access_token（bot のデータ権限範囲で全社が見える）
//   - Base 読み書き           = ログイン中の管理者の user_access_token（台帳の「作成者」に本人が残る）

const OPEN = 'https://open.larksuite.com';

/** tenant_access_token を取得（KV に有効期限付きでキャッシュ） */
export async function tenantToken(env) {
  const KEY = 'tenant_token';
  const cached = await env.SESSIONS.get(KEY);
  if (cached) return cached;
  const r = await fetch(`${OPEN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token 取得失敗: ${j.code} ${j.msg}`);
  // expire は秒。期限切れ事故を避けて 5 分早くキャッシュを切る
  await env.SESSIONS.put(KEY, j.tenant_access_token, { expirationTtl: Math.max(60, (j.expire || 7200) - 300) });
  return j.tenant_access_token;
}

/** Lark API 共通呼び出し。token は呼び出し側が明示（bot か user かを取り違えないため） */
export async function larkFetch(token, method, path, { params, body } = {}) {
  let url = OPEN + path;
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      Array.isArray(v) ? v.forEach(x => q.append(k, x)) : q.append(k, String(v));
    }
    const s = q.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (j.code != null && j.code !== 0) {
    const e = new Error(`Lark ${j.code}: ${j.msg || ''}`);
    e.code = j.code;
    throw e;
  }
  return j;
}

// ---------------- Contact（組織）: 常に tenant_access_token ----------------
export async function contact(env, method, path, opts) {
  return larkFetch(await tenantToken(env), method, path, opts);
}

// ---------------- IM: bot 資格でグループチャット作成 ----------------
export async function createChat(env, { name, description, openIds }) {
  const ids = [...new Set((openIds || []).filter(Boolean))];
  const j = await larkFetch(await tenantToken(env), 'POST', '/open-apis/im/v1/chats', {
    params: { user_id_type: 'open_id' },
    body: {
      name,
      description: description || '',
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: ids
    }
  });
  const data = j.data || {};
  return {
    chatId: data.chat_id || data.open_chat_id || '',
    name: data.name || name,
    raw: data
  };
}

// ---------------- Base 台帳: user_access_token（実行者の資格）----------------
// 実測で確定したエンドポイント群（bitable/v1 ではなく base/v3 を使う）
const basePath = (env, table, suffix = '') =>
  `/open-apis/base/v3/bases/${env.BASE_TOKEN}/tables/${table}/records${suffix}`;

/** 全レコード取得（offset ページング） */
export async function baseList(env, userToken, table) {
  const out = [];
  let offset = 0;
  for (;;) {
    const j = await larkFetch(userToken, 'GET', basePath(env, table), { params: { limit: 200, offset } });
    const d = j.data || {};
    const fields = d.fields || [];
    const ids = d.record_id_list || [];
    const rows = d.data || [];
    rows.forEach((row, i) => {
      const o = { record_id: ids[i] };
      fields.forEach((f, k) => { o[f] = row[k]; });
      out.push(o);
    });
    if (rows.length < 200) break;
    offset += rows.length;
    if (offset > 20000) break;   // 暴走ガード
  }
  return out;
}

/** レコード作成（100件ずつ）→ record_id 配列 */
export async function baseCreate(env, userToken, table, records) {
  const ids = [];
  for (let i = 0; i < records.length; i += 100) {
    const j = await larkFetch(userToken, 'POST', basePath(env, table, '/batch_create'),
      { body: { create_records: records.slice(i, i + 100) } });
    ids.push(...((j.data || {}).record_id_list || []));
  }
  return ids;
}

/** 1件更新 */
export async function baseUpdate(env, userToken, table, recordId, fields) {
  return larkFetch(userToken, 'PATCH', basePath(env, table, `/${recordId}`), { body: fields });
}

/** 一括更新（150件ずつ・API上限200） */
export async function baseBatchUpdate(env, userToken, table, updates) {
  const items = Object.entries(updates);
  for (let i = 0; i < items.length; i += 150) {
    await larkFetch(userToken, 'POST', basePath(env, table, '/batch_update'),
      { body: { update_records: Object.fromEntries(items.slice(i, i + 150)) } });
  }
}

/** 削除 */
export async function baseDelete(env, userToken, table, recordIds) {
  const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
  return larkFetch(userToken, 'POST', basePath(env, table, '/batch_delete'), { body: { record_id_list: ids } });
}

export const baseUrl = (env, table) =>
  `${env.LARK_DOMAIN || OPEN}/base/${env.BASE_TOKEN}${table ? `?table=${table}` : ''}`;
