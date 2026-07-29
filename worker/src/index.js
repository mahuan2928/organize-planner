// 組織プランナー for Lark — Cloudflare Worker 本番エントリ
// ・SSO（Lark OAuth）でログイン。管理者（is_tenant_manager）以外は拒否
// ・組織の書き込みは tenant_access_token（Lark 仕様上ユーザートークン不可）
// ・Base 台帳の読み書きはログイン中の管理者の user_access_token（台帳の作成者に本人が残る）

import { createService } from './service.js';
import * as lark from './lark.js';
import {
  buildLoginUrl, exchangeCode, fetchUserInfo, isTenantManager,
  createSession, getSession, destroySession, stateOk
} from './auth.js';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const redirect = (loc, headers = {}) => new Response(null, { status: 302, headers: { Location: loc, ...headers } });

/** ログイン失敗を利用者に読める形で返す（JSON を画面に出さない） */
const htmlError = (title, detail) => new Response(
  shell(title + ' — 組織プランナー', `
    <h1 class="err">${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <a class="btn" href="/auth/login">もう一度ログイン</a>`),
  { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** サービス層に渡すクライアント（Base=ユーザー資格 / Contact=bot 資格） */
function makeClient(env, userToken) {
  const tables = {
    dept: env.T_DEPT, member: env.T_MEM, plan: env.T_PLAN,
    op: env.T_OP, audit: env.T_AUDIT, csv: env.T_CSV
  };
  return {
    tables,
    tenantNameFallback: env.TENANT_NAME_FALLBACK || 'テナント',
    nowStr: () => {
      // 日本時間で記録（台帳の見た目を既存と揃える）
      const d = new Date(Date.now() + 9 * 3600 * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    },
    baseUrl: (table) => lark.baseUrl(env, table),
    fetchTable: (table) => lark.baseList(env, userToken, table),
    baseCreate: (table, fields, rows) =>
      lark.baseCreate(env, userToken, table, rows.map(row =>
        Object.fromEntries(fields.map((f, i) => [f, row[i]]))
      )),
    baseUpsert: (table, recordId, patch) => lark.baseUpdate(env, userToken, table, recordId, patch),
    baseDelete: (table, recordId) => lark.baseDelete(env, userToken, table, recordId),
    contactCall: (method, path, data, params) => lark.contact(env, method, path, { body: data, params })
  };
}

/** ログイン必須＋管理者必須。未ログインは 401、非管理者は 403 */
async function requireAdmin(env, req) {
  const s = await getSession(env, req);
  if (!s) return { error: json({ ok: false, error: 'ログインが必要です', needLogin: true }, 401) };
  if (!s.isAdmin) return { error: json({ ok: false, error: '管理者権限が必要です' }, 403) };
  if (s.tokenExpiresAt && Date.now() > s.tokenExpiresAt) {
    return { error: json({ ok: false, error: 'セッションの有効期限が切れました。再ログインしてください', needLogin: true }, 401) };
  }
  return { session: s };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const redirectUri = `${url.origin}/auth/callback`;

    try {
      // ---------- 認証系 ----------
      if (path === '/auth/login') {
        const { url: loginUrl } = await buildLoginUrl(env, redirectUri);
        return redirect(loginUrl);
      }

      if (path === '/auth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        // Lark 側でエラーになった場合はクエリで返ってくる
        const oauthErr = url.searchParams.get('error');
        if (oauthErr) return htmlError('ログインできませんでした', url.searchParams.get('error_description') || oauthErr);
        if (!code) return htmlError('ログインできませんでした', '認可コードが取得できませんでした。もう一度お試しください。');
        if (!(await stateOk(env, state))) {
          return htmlError('ログインできませんでした', 'リクエストの検証に失敗しました（時間が経ちすぎた可能性があります）。もう一度ログインしてください。');
        }

        let tok, info;
        try {
          tok = await exchangeCode(env, code, redirectUri);
          info = await fetchUserInfo(tok.access_token);
        } catch (e) {
          return htmlError('ログインできませんでした', String((e && e.message) || e));
        }
        const userToken = tok.access_token;
        const openId = info.open_id;
        if (!openId) return htmlError('ログインできませんでした', 'ユーザー情報を取得できませんでした。');

        // 管理者以外はここで弾く（セッションを作らない）
        const admin = await isTenantManager(env, openId);
        if (!admin) {
          return new Response(denyHtml(info.name || ''), {
            status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        const { cookie } = await createSession(env, {
          openId, name: info.name || '', isAdmin: true,
          userToken, refreshToken: tok.refresh_token || '',
          tokenExpiresAt: Date.now() + ((tok.expires_in || 7200) - 300) * 1000
        });
        return redirect('/', { 'Set-Cookie': cookie });
      }

      if (path === '/auth/logout') {
        const cookie = await destroySession(env, req);
        return redirect('/', { 'Set-Cookie': cookie });
      }

      if (path === '/api/me') {
        const s = await getSession(env, req);
        return json({ ok: true, loggedIn: !!s, name: s ? s.name : '', openId: s ? s.openId : '', isAdmin: !!(s && s.isAdmin) });
      }

      if (path === '/api/health') return json({ ok: true });

      // ---------- API（全て管理者必須）----------
      if (path.startsWith('/api/')) {
        const gate = await requireAdmin(env, req);
        if (gate.error) return gate.error;
        const s = gate.session;
        const svc = createService(makeClient(env, s.userToken));

        // 変更系は CSRF 対策（同一オリジンからのリクエストのみ許可）
        if (req.method === 'POST') {
          const origin = req.headers.get('Origin');
          if (origin && origin !== url.origin) return json({ ok: false, error: '不正なリクエスト元です' }, 403);
        }

        const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;

        if (path === '/api/org') return json(await svc.getOrg());
        if (path === '/api/plans') return json(await svc.listPlans());
        if (path === '/api/employee-types') return json(await svc.employeeTypes());
        if (path === '/api/setup/status') {
          return json({ ok: true, configured: !!(env.BASE_TOKEN && env.T_DEPT), profile: 'worker', domain: env.LARK_DOMAIN || '', baseUrl: lark.baseUrl(env) });
        }
        if (path === '/api/plan' && req.method === 'POST') return json(await svc.savePlan(body));
        if (path === '/api/csv-import' && req.method === 'POST') return json(await svc.csvImport(body));
        if (path === '/api/chatgroups/create' && req.method === 'POST') {
          const title = String((body && body.title) || '').trim();
          const memberOpenIds = Array.isArray(body && body.memberOpenIds) ? body.memberOpenIds : [];
          const members = Array.isArray(body && body.members) ? body.members : [];
          const emails = members.map(m => String((m && m.email) || '').trim()).filter(Boolean);
          const emailOpenIds = await lark.batchGetOpenIdsByEmail(env, emails).catch(() => ({}));
          const resolved = members.map(m => {
            const email = String((m && m.email) || '').trim();
            return emailOpenIds[email] || '';
          }).filter(Boolean);
          // Base 台帳の open_id は別 App 由来の場合があるため、email で現在 App の open_id に引き直す。
          // email が無いメンバーだけ従来値にフォールバックする。
          const fallback = members.filter(m => !String((m && m.email) || '').trim()).map(m => m && m.openId).filter(Boolean);
          const ids = [...new Set([...resolved, ...fallback, s.openId].map(x => String(x || '').trim()).filter(Boolean))];
          if (!title) return json({ ok: false, error: 'グループ名を入力してください' }, 400);
          if (!memberOpenIds.length && !members.length) return json({ ok: false, error: '追加するメンバーがありません' }, 400);
          if (!resolved.length && emails.length) {
            return json({ ok: false, error: '選択メンバーの open_id を現在の App 用に変換できませんでした。メールアドレスと Contact 権限を確認してください。' }, 400);
          }
          if (ids.length > 500) return json({ ok: false, error: 'メンバー数が多すぎます。500名以下に絞り込んでください' }, 400);
          const result = await lark.createChat(env, {
            name: title,
            description: `組織プランナーで作成: ${s.name || s.openId}`,
            openIds: ids
          });
          return json({ ok: true, chatId: result.chatId, name: result.name, memberCount: ids.length, resolvedCount: resolved.length, operatorIncluded: true });
        }
        if (path === '/api/execute' && req.method === 'POST') {
          // 誰が実行したかをサービス層の監査ログへ渡す
          const r = await svc.execute({ ...body, __actor: `${s.name}（${s.openId}）` });
          return json(r);
        }
        return json({ ok: false, error: 'not found' }, 404);
      }

      // ---------- 静的ファイル（未ログインはログイン画面へ）----------
      const s = await getSession(env, req);
      if (!s) {
        if (path === '/' || path === '/index.html') {
          return new Response(loginHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        // CSS/JS などは配信して構わない（データは API 側で保護）
      }
      return env.ASSETS.fetch(req);

    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  }
};

// ---------- 最小限の HTML（アプリ本体は public/ 側）----------
const shell = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
   font-family:Inter,"Noto Sans JP",-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;
   background:#F5F7FB;color:#1C2333}
 .card{background:#fff;border:1px solid #E4E7EE;border-radius:16px;box-shadow:0 8px 32px rgba(28,35,51,.08);
   padding:40px;max-width:420px;text-align:center}
 h1{font-size:20px;margin:0 0 8px}
 p{font-size:13.5px;line-height:1.7;color:#4A5163;margin:0 0 24px}
 a.btn{display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-size:14px;font-weight:600;
   padding:12px 28px;border-radius:10px}
 a.btn:hover{opacity:.9}
 .err{color:#D92D20;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;

const loginHtml = () => shell('ログイン — 組織プランナー', `
  <h1>組織プランナー for Lark</h1>
  <p>組織の閲覧・変更には Lark アカウントでのログインが必要です。<br>
     <b>管理者権限をお持ちの方のみ</b >ご利用いただけます。</p>
  <a class="btn" href="/auth/login">Lark でログイン</a>`);

const denyHtml = (name) => shell('権限がありません — 組織プランナー', `
  <h1 class="err">ご利用いただけません</h1>
  <p>${name ? escapeHtml(name) + ' さま：' : ''}このツールは<b>管理者権限をお持ちの方専用</b>です。<br>
     権限が必要な場合は、貴社の Lark 管理者にお問い合わせください。</p>
  <a class="btn" href="/auth/logout">別のアカウントでログイン</a>`);
