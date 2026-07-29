// 組織改編・予約変更システム — ローカル BFF (M4/M5)
// 読み取り: Base(--as user) / 組織読み: Contact(--as bot) / 書き戻し: Contact(--as bot)
const express = require('express');
const { execFile, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// lark-cli の実体パスをログインシェルで一度だけ解決（プロセスの PATH 差異による旧バージョン誤命中を防ぐ）
const LARK_BIN = (() => {
  if (process.env.LARK_CLI_PATH) return process.env.LARK_CLI_PATH;
  try { return execSync('bash -lc "which lark-cli"', { encoding: 'utf8' }).trim() || 'lark-cli'; }
  catch (_) { return 'lark-cli'; }
})();

const app = express();
app.use(express.json({ limit: '4mb' }));
const PORT = process.env.PORT || 5178;

// ---- 設定（config.json 駆動。他社が config を差し替えるだけで別テナントに移植可能）----
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return null; } }
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); CFG = cfg; refreshRefs(); }
let CFG = loadConfig();
// Base 未セットアップ = tables が揃っていない状態
const isConfigured = () => !!(CFG && CFG.baseToken && CFG.tables && CFG.tables.dept && CFG.tables.member && CFG.tables.plan && CFG.tables.op && CFG.tables.audit);
// 設定から派生する参照（既存コードの定数名を維持したまま config 駆動に）
let PROFILE, BASE, T_DEPT, T_MEM, T_PLAN, T_OP, T_AUDIT, T_CSV;
function refreshRefs() {
  PROFILE = (CFG && CFG.profile) || 'lark-intl';
  BASE = (CFG && CFG.baseToken) || '';
  const t = (CFG && CFG.tables) || {};
  T_DEPT = t.dept || ''; T_MEM = t.member || ''; T_PLAN = t.plan || '';
  T_OP = t.op || ''; T_AUDIT = t.audit || ''; T_CSV = t.csv || '';
}
refreshRefs();
const baseUrl = (table) => `${(CFG && CFG.domain) || 'https://open.larksuite.com'}/base/${BASE}${table ? `?table=${table}` : ''}`;

function larkJSON(args) {
  return new Promise((resolve, reject) => {
    execFile(LARK_BIN, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const s = String(stdout || '');
      const i = s.indexOf('{');
      if (i < 0) return reject(new Error(stderr || (err && err.message) || 'lark-cli: 出力なし'));
      try {
        const j = JSON.parse(s.slice(i));
        if (j.ok === false) return reject(new Error((j.error && j.error.message) || 'lark-cli error'));
        resolve(j);
      } catch (e) { reject(e); }
    });
  });
}

async function fetchTable(tableId) {
  // lark-cli 1.0.76+ は --limit 上限 200 → offset ページングで全件取得
  const out = [];
  let offset = 0;
  for (;;) {
    const j = await larkJSON(['base', '+record-list', '--profile', PROFILE, '--as', 'user',
      '--base-token', BASE, '--table-id', tableId, '--format', 'json', '--limit', '200', '--offset', String(offset)]);
    const d = j.data || {};
    const fields = d.fields || [];
    const ids = d.record_id_list || [];
    const rows = d.data || [];
    rows.forEach((row, i) => { const o = { record_id: ids[i] }; fields.forEach((f, k) => o[f] = row[k]); out.push(o); });
    if (rows.length < 200) break;
    offset += rows.length;
    if (offset > 10000) break;   // 暴走ガード
  }
  return out;
}
const linkIds = (v) => Array.isArray(v) ? v.map(x => x && x.id).filter(Boolean) : [];
const sel = (v) => Array.isArray(v) ? (v[0] || '') : (v || '');

function nowStr() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

// ---- Base 書き込みヘルパ（--as user）----
async function baseCreate(tableId, fields, rows) {
  const j = await larkJSON(['base', '+record-batch-create', '--profile', PROFILE, '--as', 'user',
    '--base-token', BASE, '--table-id', tableId, '--json', JSON.stringify({ fields, rows })]);
  return j.data.record_id_list;
}
async function baseUpsert(tableId, recordId, patch) {
  return larkJSON(['base', '+record-upsert', '--profile', PROFILE, '--as', 'user',
    '--base-token', BASE, '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(patch)]);
}
async function baseDelete(tableId, recordId) {
  return larkJSON(['base', '+record-delete', '--profile', PROFILE, '--as', 'user',
    '--base-token', BASE, '--table-id', tableId, '--record-id', recordId, '--yes']);
}
// ---- Contact 書き戻し（--as bot）----
async function contactCall(method, apiPath, data, params) {
  const args = ['api', method, apiPath, '--profile', PROFILE, '--as', 'bot'];
  if (data != null) args.push('--data', JSON.stringify(data));
  if (params) args.push('--params', JSON.stringify(params));
  const j = await larkJSON(args);
  // 旧CLI: Lark 生レスポンス {code,msg,data} ／ 新CLI(1.0.76+): {ok,identity,data}（ok:false は larkJSON 側で reject 済み）
  if ('code' in j && j.code !== 0) throw new Error(`Lark ${j.code}: ${j.msg || (j.error && j.error.message) || ''}`);
  return j;
}
const contactPatch = (apiPath, data, params) => contactCall('PATCH', apiPath, data, params);

// ---- テナント名（tenant:tenant:readonly が無ければフォールバック名を使用）----
const TENANT_NAME_FALLBACK = 'Lark Japan';
let tenantNameCache = null;
async function getTenantName() {
  if (tenantNameCache) return tenantNameCache;
  try {
    const j = await contactCall('GET', '/open-apis/tenant/v2/tenant/query', null, null);
    const nm = j.data && j.data.tenant && j.data.tenant.name;
    if (nm) { tenantNameCache = nm; return nm; }
  } catch (_) { /* スコープ未付与など → フォールバック */ }
  return TENANT_NAME_FALLBACK;
}

// Lark Contact からユーザーを一括補完（役職 / orders=主部門・並び順 / status=多状態フラグ / 上長）
async function contactUsersBatch(openIds) {
  const map = {};
  for (let i = 0; i < openIds.length; i += 50) {
    const chunk = openIds.slice(i, i + 50);
    try {
      const j = await contactCall('GET', '/open-apis/contact/v3/users/batch', null,
        { user_ids: chunk, user_id_type: 'open_id', department_id_type: 'open_department_id' });
      ((j.data && j.data.items) || []).forEach(u => {
        if (!u.open_id) return;
        map[u.open_id] = {
          jobTitle: (u.job_title || '').trim(),
          employeeType: (u.employee_type != null ? String(u.employee_type) : null),   // 雇用形態（enum値）
          orders: u.orders || [],            // [{department_id(open), is_primary_dept, department_order, user_order}]（主部門=department_order 最大）
          status: u.status || {},            // {is_resigned, is_frozen, is_exited, is_unjoin, is_activated}
          leaderOpenId: u.leader_user_id || null
        };
      });
    } catch (_) { /* best-effort */ }
  }
  return map;
}
// Lark Contact から部門を一括補完（leaders=主/副負責人 / member_count=再帰 / primary_member_count=直属 / order）
async function contactDeptsBatch(openDeptIds) {
  const map = {};
  for (let i = 0; i < openDeptIds.length; i += 50) {
    const chunk = openDeptIds.slice(i, i + 50);
    try {
      const j = await contactCall('GET', '/open-apis/contact/v3/departments/batch', null,
        { department_ids: chunk, department_id_type: 'open_department_id', user_id_type: 'open_id' });
      ((j.data && j.data.items) || []).forEach(d => {
        if (!d.open_department_id) return;
        map[d.open_department_id] = {
          leaders: d.leaders || [],          // [{leaderID(open), leaderType 1=主/2=副}]
          memberCount: d.member_count,       // 再帰（子部門含む）
          primaryCount: d.primary_member_count, // 直属
          order: d.order != null ? Number(d.order) : null
        };
      });
    } catch (_) { /* best-effort */ }
  }
  return map;
}

// ================= 組織読み取り =================
app.get('/api/org', async (req, res) => {
  try {
    const [depts, members, tenantName] = await Promise.all([fetchTable(T_DEPT), fetchTable(T_MEM), getTenantName()]);
    const dOut = depts.map(d => ({
      id: d.record_id, name: d['部門名'] || '(無名)',
      parentId: linkIds(d['親部門'])[0] || null, leaderId: linkIds(d['部門長'])[0] || null,
      leaders: [], count: d['メンバー数'] || 0, recursiveCount: null, order: null,
      path: d['階層パス'] || '', openId: d['open_department_id'] || ''
    }));
    const mOut = members.map(m => ({
      id: m.record_id, name: m['氏名'] || '(無名)', openId: m['open_id'] || '',
      deptIds: linkIds(m['所属部門']), leaderId: linkIds(m['上長'])[0] || null,
      title: m['役職'] || '', email: m['メールアドレス'] || '', empNo: m['社員番号'] || '', status: sel(m['在籍ステータス']),
      primaryDept: null, statusFlags: null, deptOrders: {}, employeeType: null
    }));
    // ---- Lark 準拠: Contact から主/副負責人・直属人数・主部門・状態・並び順を補完（Lark が真源）----
    try {
      const openMember = {}; mOut.forEach(m => { if (m.openId) openMember[m.openId] = { id: m.id, name: m.name }; });
      const openDept = {}; dOut.forEach(d => { if (d.openId) openDept[d.openId] = d.id; });
      const [du, uu] = await Promise.all([
        contactDeptsBatch(dOut.map(d => d.openId).filter(Boolean)),
        contactUsersBatch(mOut.map(m => m.openId).filter(Boolean))
      ]);
      // 部門: leaders（主/副）・直属人数・再帰人数・order
      dOut.forEach(d => {
        const e = du[d.openId]; if (!e) return;
        d.leaders = (e.leaders || []).map(l => { const mm = openMember[l.leaderID]; return { id: mm ? mm.id : null, name: mm ? mm.name : null, type: l.leaderType }; });
        const main = d.leaders.find(l => l.type === 1 && l.id);
        if (main) d.leaderId = main.id;                 // 主担当を部門長として維持（後方互換）
        if (e.primaryCount != null) d.count = e.primaryCount;   // カード数字＝直属（Lark 準拠）
        if (e.memberCount != null) d.recursiveCount = e.memberCount;
        if (e.order != null) d.order = e.order;
      });
      // メンバー: 役職・主部門・状態フラグ・部門内並び順
      mOut.forEach(m => {
        const e = uu[m.openId]; if (!e) return;
        if (e.jobTitle) m.title = e.jobTitle;
        if (e.employeeType) m.employeeType = e.employeeType;
        if (e.status) m.statusFlags = e.status;
        (e.orders || []).forEach(o => {
          const drec = openDept[o.department_id];
          if (drec) {
            if (o.is_primary_dept) m.primaryDept = drec;
            m.deptOrders[drec] = o.user_order || 0;
          }
        });
      });
    } catch (_) { /* best-effort: 補完失敗でも Base の値で動作 */ }
    res.json({ ok: true, base: baseUrl(), tenantName, stats: { depts: dOut.length, members: mOut.length }, depts: dOut, members: mOut });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String((e && e.message) || e),
      code: e && e.code,
      base: baseUrl()
    });
  }
});

// ================= M4: 計画を Base 台帳に保存 =================
app.post('/api/plan', async (req, res) => {
  try {
    const { name, effectiveDate, summary, operations } = req.body;
    // 実行ペイロード（execOps 全体）を保存 → 再読み込み後も計画一覧から再開できる
    let payload = '';
    try { payload = JSON.stringify(operations || []); } catch (_) { payload = ''; }
    const planIds = await baseCreate(T_PLAN,
      ['計画名', 'ステータス', '発効日時', '承認ステータス', '変更サマリー', '実行ペイロード'],
      [[name || '組織変更', '予約済み', effectiveDate || null, '承認不要', summary || '', payload]]);
    const planRecId = planIds[0];
    // 対象レコードへのリンク（既存オブジェクトのみ。新規 new|x / newm|x は実行時にバックフィル）
    const isReal = (id) => typeof id === 'string' && id.startsWith('rec');
    const opRows = (operations || []).map((o, i) => [
      [{ id: planRecId }], o.order != null ? o.order : (i + 1), o.opType, o.objType,
      o.targetName, `${o.fromName} → ${o.toName}`, o.deleteFlag === true, '未実行',
      o.beforeText || '', o.afterText || '',
      (o.objType === '部門' && isReal(o.targetRecId)) ? [{ id: o.targetRecId }] : [],
      (o.objType === 'メンバー' && isReal(o.targetRecId)) ? [{ id: o.targetRecId }] : []
    ]);
    const opRecIds = opRows.length ? await baseCreate(T_OP,
      ['関連計画', '順番', 'オペレーション種別', '対象種別', '対象', '変更内容', '削除系フラグ', '実行ステータス',
       '変更前', '変更後', '対象部門', '対象メンバー'], opRows) : [];
    res.json({ ok: true, planRecId, opRecIds, planUrl: baseUrl(T_PLAN) });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ================= 保存済み計画の一覧（再読み込み後の再開用）=================
app.get('/api/plans', async (req, res) => {
  try {
    const rows = await fetchTable(T_PLAN);
    const plans = rows.map(r => {
      let ops = [];
      try { ops = JSON.parse(r['実行ペイロード'] || '[]'); } catch (_) { ops = []; }
      const ct = r['作成日時'];
      return {
        recId: r.record_id, name: r['計画名'] || '(無題)', status: sel(r['ステータス']) || '',
        effectiveDate: r['発効日時'] || null, summary: r['変更サマリー'] || '', result: r['実行結果'] || '',
        createdBy: (Array.isArray(r['作成者']) ? (r['作成者'][0] || {}).name : '') || '',
        createdAt: typeof ct === 'number' ? ct : null,
        opCount: ops.length, ops
      };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, plans });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ================= M5: 実行エンジン（Contact へ書き戻し）=================
app.post('/api/execute', async (req, res) => {
  try {
    const { planRecId, ops, limit, dryRun } = req.body;
    const isDry = dryRun === true;   // dry-run: Contact/Base へ一切書き込まず、構築した Contact リクエストのみ返す
    const dryOps = [];
    let drySeq = 0;
    // dry-run では write(POST/PATCH/DELETE) を送らず記録。read(GET) は実データ取得のため実行。create は合成IDを返して後続 op の仮ID解決を維持
    const sendOrRecord = async (method, apiPath, data, params, opLabel) => {
      if (isDry) {
        dryOps.push({ op: opLabel, method, path: apiPath, params: params || null, data: data || null });
        if (method === 'POST' && /\/departments$/.test(apiPath)) return { data: { department: { open_department_id: `DRYRUN-DEPT-${++drySeq}` } } };
        if (method === 'POST' && /\/users$/.test(apiPath)) return { data: { user: { open_id: `DRYRUN-USER-${++drySeq}` } } };
        return { data: {} };
      }
      return contactCall(method, apiPath, data, params);
    };
    const todo = (typeof limit === 'number') ? (ops || []).slice(0, limit) : (ops || []);
    const results = []; let success = 0, fail = 0;
    // メンバー変動があった部門（openId -> recId）: 実行後に Contact の member_count で メンバー数 を更新
    const touchedDepts = new Map();
    // 同一計画内で新規作成した部門/メンバーの仮ID（new|x / newm|x）→ 実ID の解決マップ
    const created = {};   // tmpId -> { openId, recId }
    const isTmp = (v) => typeof v === 'string' && (v.startsWith('new|') || v.startsWith('newm|'));
    const rOpen = (v) => isTmp(v) ? (created[v] && created[v].openId) : v;
    const rRec = (v) => isTmp(v) ? (created[v] && created[v].recId) : v;
    for (const o of todo) {
      let ok = false, error = '';
      try {
        if (o.opType === 'DEPT_CREATE') {
          const pOpen = rOpen(o.toOpenId);
          if (o.toOpenId && String(o.toOpenId).startsWith('new|') && !pOpen) throw new Error('親部門（新規）が未作成のため作成できません');
          const j = await sendOrRecord('POST', '/open-apis/contact/v3/departments',
            { name: o.targetName, parent_department_id: pOpen || '0' }, { department_id_type: 'open_department_id' }, `DEPT_CREATE ${o.targetName}`);
          const newOpen = j.data && j.data.department && j.data.department.open_department_id;
          created[o.tmpId] = { openId: newOpen, recId: isDry ? `DRYRUN-REC-${drySeq}` : null };
          if (!isDry) try {
            const pRec = rRec(o.toRecId);
            const ids = await baseCreate(T_DEPT, ['部門名', '親部門', 'open_department_id'],
              [[o.targetName, pRec ? [{ id: pRec }] : null, newOpen || '']]);
            created[o.tmpId].recId = ids[0];
          } catch (_) { /* スナップショット同期は best-effort */ }
        } else if (o.opType === 'DEPT_RENAME') {
          await sendOrRecord('PATCH', `/open-apis/contact/v3/departments/${encodeURIComponent(o.targetOpenId)}`,
            { name: o.newName }, { department_id_type: 'open_department_id' }, `DEPT_RENAME ${o.targetName}`);
        } else if (o.opType === 'DEPT_DELETE') {
          await sendOrRecord('DELETE', `/open-apis/contact/v3/departments/${encodeURIComponent(o.targetOpenId)}`,
            null, { department_id_type: 'open_department_id' }, `DEPT_DELETE ${o.targetName}`);
        } else if (o.opType === 'DEPT_MOVE') {
          const pOpen = rOpen(o.toOpenId);
          if (isTmp(o.toOpenId) && !pOpen) throw new Error('移動先（新規部門）が未作成のため実行できません');
          await sendOrRecord('PATCH', `/open-apis/contact/v3/departments/${encodeURIComponent(o.targetOpenId)}`,
            { parent_department_id: pOpen || '0' }, { department_id_type: 'open_department_id' }, `DEPT_MOVE ${o.targetName}`);
        } else if (o.opType === 'DEPT_SET_LEADER') {
          // 部門責任者の設定/解除。Lark の leaders は「全置換」。ライブ leaders を取得し、
          // 主(type1)を差し替え、副(type2)は「明示除去分だけ外し、残りは温存、追加分を足す」差分適用。
          // → アプリが認識しない副（権限範囲外＝アンマップ）は removeDep に載らないため温存される。
          const tgtOpen = rOpen(o.targetOpenId);
          if (isTmp(o.targetOpenId) && !tgtOpen) throw new Error('対象部門（新規）が未作成のため実行できません');
          const mainOpen = o.newLeaderOpenId ? rOpen(o.newLeaderOpenId) : '';
          if (o.newLeaderOpenId && isTmp(o.newLeaderOpenId) && !mainOpen) throw new Error('責任者（新規メンバー）が未作成のため実行できません');
          let data;
          if (mainOpen) {
            const addDep = (o.addDeputyOpenIds || []).map(rOpen).filter(Boolean);
            const removeDep = new Set(o.removeDeputyOpenIds || []);
            let existing = [];
            if (!isTmp(o.targetOpenId)) {   // 新規部門は既存 leaders なし
              try {
                const g = await contactCall('GET', `/open-apis/contact/v3/departments/${encodeURIComponent(tgtOpen)}`,
                  null, { department_id_type: 'open_department_id', user_id_type: 'open_id' });
                existing = (g.data && g.data.department && g.data.department.leaders) || [];
              } catch (_) { existing = []; }
            }
            const deputyOpen = []; const seen = new Set();
            existing.filter(l => Number(l.leaderType) === 2 && l.leaderID).forEach(l => {
              if (!removeDep.has(l.leaderID) && l.leaderID !== mainOpen && !seen.has(l.leaderID)) { seen.add(l.leaderID); deputyOpen.push(l.leaderID); }
            });
            addDep.forEach(id => { if (id !== mainOpen && !seen.has(id)) { seen.add(id); deputyOpen.push(id); } });
            // leader_user_id と type1 leaderID は常に一致させる（Lark 制約）
            data = { leaders: [{ leaderType: 1, leaderID: mainOpen }, ...deputyOpen.map(id => ({ leaderType: 2, leaderID: id }))], leader_user_id: mainOpen };
          } else {
            data = { leaders: [] };   // 主解除 = 主・副とも全解除（Lark は主なしで副のみを保持できない）
          }
          await sendOrRecord('PATCH', `/open-apis/contact/v3/departments/${encodeURIComponent(tgtOpen)}`,
            data, { department_id_type: 'open_department_id', user_id_type: 'open_id' }, `DEPT_SET_LEADER ${o.targetName}`);
        } else if (o.opType === 'MEMBER_CREATE') {
          const rawDeps = o.toOpenIds || [];
          const deps = rawDeps.map(rOpen);
          if (rawDeps.some((v, i) => isTmp(v) && !deps[i])) throw new Error('所属先（新規部門）が未作成のため実行できません');
          const data = {
            name: o.targetName, mobile: o.mobile, employee_type: Number(o.employeeType) || 1,
            department_ids: deps.filter(Boolean)
          };
          if (o.email) data.email = o.email;
          if (o.title) data.job_title = o.title;
          if (o.leaderOpenId) {
            const lo = rOpen(o.leaderOpenId);
            if (isTmp(o.leaderOpenId) && !lo) throw new Error('上長（新規メンバー）が未作成のため実行できません');
            data.leader_user_id = lo;
          }
          const j = await sendOrRecord('POST', '/open-apis/contact/v3/users', data,
            { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_CREATE ${o.targetName}`);
          const newOpen = j.data && j.data.user && j.data.user.open_id;
          created[o.tmpId] = { openId: newOpen, recId: isDry ? `DRYRUN-REC-${drySeq}` : null };
          if (!isDry) try {
            const fields = ['氏名', 'メールアドレス', '所属部門', '役職', 'open_id'];
            const row = [o.targetName, o.email || '', (o.toRecIds || []).map(rRec).filter(Boolean).map(id => ({ id })), o.title || '', newOpen || ''];
            if (o.leaderRecId) { fields.push('上長'); row.push([{ id: rRec(o.leaderRecId) }]); }
            const ids = await baseCreate(T_MEM, fields, [row]);
            created[o.tmpId].recId = ids[0];
          } catch (_) { /* スナップショット同期は best-effort */ }
        } else if (o.opType === 'MEMBER_UPDATE') {
          const data = {};
          if ('newTitle' in o) data.job_title = o.newTitle;
          if ('newLeaderOpenId' in o) {
            const lo = rOpen(o.newLeaderOpenId);
            if (isTmp(o.newLeaderOpenId) && !lo) throw new Error('上長（新規メンバー）が未作成のため実行できません');
            data.leader_user_id = lo;
          }
          await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            data, { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_UPDATE ${o.targetName}`);
        } else if (o.opType === 'MEMBER_SET_PRIMARY') {
          // 主部門の設定。Lark では is_primary_dept は書込不可（派生値）で、department_order が最大の部門が主部門。
          // ユーザーのライブ orders/department_ids を取得し、全部門を保持したまま対象部門の order を最大化（隠れ部門の脱落防止）。
          const primOpen = rOpen(o.primaryDeptOpenId);
          if (isTmp(o.primaryDeptOpenId) && !primOpen) throw new Error('主部門（新規）が未作成のため実行できません');
          const g = await contactCall('GET', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            null, { user_id_type: 'open_id', department_id_type: 'open_department_id' });
          const u = (g.data && g.data.user) || {};
          const liveOrders = u.orders || [];
          const liveDeptIds = u.department_ids || [];
          if (!liveDeptIds.includes(primOpen)) throw new Error('対象メンバーは指定部門に所属していません');
          const maxOrder = liveOrders.reduce((mx, x) => Math.max(mx, Number(x.department_order) || 0), 0);
          const newOrders = liveOrders.map(x => ({
            department_id: x.department_id,
            user_order: Number(x.user_order) || 0,
            department_order: x.department_id === primOpen ? (maxOrder + 1) : (Number(x.department_order) || 0)
          }));
          // orders に未掲載の所属部門を補完（保険）
          liveDeptIds.forEach(did => {
            if (!newOrders.some(x => x.department_id === did)) newOrders.push({ department_id: did, user_order: 0, department_order: did === primOpen ? (maxOrder + 1) : 0 });
          });
          await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            { department_ids: liveDeptIds, orders: newOrders }, { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_SET_PRIMARY ${o.targetName}`);
        } else if (o.opType === 'MEMBER_DELETE') {
          // 資源引継(handover): 引継先が指定されていれば、グループ/ドキュメント/カレンダー/アプリ等を移管してから削除
          let body = null;
          if (o.handoverOpenId) {
            const h = rOpen(o.handoverOpenId);
            if (h) body = {
              department_chat_acceptor_user_id: h, external_chat_acceptor_user_id: h,
              docs_acceptor_user_id: h, calendar_acceptor_user_id: h,
              application_acceptor_user_id: h, minutes_acceptor_user_id: h, survey_acceptor_user_id: h
            };
          }
          await sendOrRecord('DELETE', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            body, { user_id_type: 'open_id' }, `MEMBER_DELETE ${o.targetName}`);
        } else {
          // メンバー異動。department_ids は Lark 側で全置換されるため、そのまま toOpenIds を送ると
          // アプリのスナップショット外の兼任部門（例: Rey の od-a913）が丸ごと脱落する。
          // ユーザーのライブ department_ids を取得し、「アプリが認識する部門(from)のうち異動先(to)に
          // 無いものだけを除外し、異動先を追加」という差分適用にして認識外の部門は温存する
          // （MEMBER_SET_PRIMARY と同じライブマージ方針）。
          const rawTo = o.toOpenIds || [];
          const toOpen = rawTo.map(rOpen);
          if (rawTo.some((v, i) => isTmp(v) && !toOpen[i])) throw new Error('異動先（新規部門）が未作成のため実行できません');
          const toDeps = toOpen.filter(Boolean);
          const toSet = new Set(toDeps);
          // 異動元はスナップショット既存部門のみ（同一計画内の新規部門になることはない）→ tmp 解決不要
          const fromOpen = (o.fromOpenIds || []).map(rOpen).filter(Boolean);
          const removed = new Set(fromOpen.filter(d => !toSet.has(d)));   // アプリ認識かつ異動先に無い＝今回外す部門
          const g = await contactCall('GET', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            null, { user_id_type: 'open_id', department_id_type: 'open_department_id' });
          const u = (g.data && g.data.user) || {};
          const liveDeptIds = u.department_ids || [];
          const liveOrders = u.orders || [];
          const newDeptIds = liveDeptIds.filter(d => !removed.has(d));    // 外す部門だけ除去（認識外の兼任部門は温存）
          toDeps.forEach(d => { if (!newDeptIds.includes(d)) newDeptIds.push(d); });   // 異動先を追加
          // orders も温存: 残す部門の並び順(department_order/user_order)をそのまま持ち越す。
          // department_ids だけ変えて orders を省くと Lark 側で並び順・主部門(=order 最大)が
          // リセットされうるため（MEMBER_SET_PRIMARY と同じく orders 同送で状態を保護）。
          const orders = liveOrders
            .filter(x => newDeptIds.includes(x.department_id))
            .map(x => ({ department_id: x.department_id, user_order: Number(x.user_order) || 0, department_order: Number(x.department_order) || 0 }));
          newDeptIds.forEach(did => {   // 新規追加した異動先で orders 未掲載のものを補完（保険）
            if (!orders.some(x => x.department_id === did)) orders.push({ department_id: did, user_order: 0, department_order: 0 });
          });
          await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(o.targetOpenId)}`,
            { department_ids: newDeptIds, orders }, { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_MOVE ${o.targetName}`);
        }
        ok = true; success++;
      } catch (e) { error = String((e && e.message) || e); fail++; }
      // Contact 成功後、Base スナップショット（部門/メンバー表）も同期して整合を保つ（dry-run は書かない）
      if (ok && !isDry) {
        try {
          if (o.opType === 'DEPT_MOVE') {
            const tr = rRec(o.toRecId);
            await baseUpsert(T_DEPT, o.targetRecId, { '親部門': tr ? [{ id: tr }] : null });
          } else if (o.opType === 'DEPT_RENAME') {
            await baseUpsert(T_DEPT, o.targetRecId, { '部門名': o.newName });
          } else if (o.opType === 'DEPT_SET_LEADER') {
            const lr = o.newLeaderRecId ? rRec(o.newLeaderRecId) : null;
            const tr = rRec(o.targetRecId);   // 新規部門は new|x → 作成時の recId に解決
            if (tr) await baseUpsert(T_DEPT, tr, { '部門長': lr ? [{ id: lr }] : [] });
          } else if (o.opType === 'DEPT_DELETE') {
            await baseDelete(T_DEPT, o.targetRecId);
          } else if (o.opType === 'MEMBER_MOVE') {
            await baseUpsert(T_MEM, o.targetRecId, { '所属部門': (o.toRecIds || []).map(rRec).filter(Boolean).map(id => ({ id })) });
          } else if (o.opType === 'MEMBER_UPDATE') {
            const patch = {};
            if ('newTitle' in o) patch['役職'] = o.newTitle;
            if ('newLeaderRecId' in o) patch['上長'] = o.newLeaderRecId ? [{ id: rRec(o.newLeaderRecId) }] : [];   // null = 解除
            if (Object.keys(patch).length) await baseUpsert(T_MEM, o.targetRecId, patch);
          } else if (o.opType === 'MEMBER_DELETE') {
            await baseDelete(T_MEM, o.targetRecId);
          } // DEPT_CREATE / MEMBER_CREATE は作成時に同期済み
        } catch (_) { /* スナップショット同期は best-effort */ }
      }
      if (o.opRecId && !isDry) {
        try {
          const patch = { '実行ステータス': ok ? '成功' : '失敗', 'エラー情報': error };
          // 新規作成オブジェクトは作成後に台帳の対象リンクをバックフィル
          if (ok && o.tmpId && created[o.tmpId] && created[o.tmpId].recId) {
            if (o.opType === 'DEPT_CREATE') patch['対象部門'] = [{ id: created[o.tmpId].recId }];
            if (o.opType === 'MEMBER_CREATE') patch['対象メンバー'] = [{ id: created[o.tmpId].recId }];
          }
          await baseUpsert(T_OP, o.opRecId, patch);
        } catch (_) {}
      }
      // メンバーが増減した部門を記録（from / to 両側）
      if (ok && (o.opType === 'MEMBER_MOVE' || o.opType === 'MEMBER_CREATE' || o.opType === 'MEMBER_DELETE')) {
        const pairs = [
          ...((o.toOpenIds || []).map((oid, i) => [rOpen(oid), rRec((o.toRecIds || [])[i])])),
          ...((o.fromOpenIds || []).map((oid, i) => [rOpen(oid), rRec((o.fromRecIds || [])[i])]))
        ];
        pairs.forEach(([oid, rid]) => { if (oid && rid) touchedDepts.set(oid, rid); });
      }
      results.push({ opRecId: o.opRecId, name: o.targetName, type: o.opType, ok, error });
    }
    // dry-run: Base/監査への書き込みは一切せず、構築した Contact リクエストのみ返す
    if (isDry) return res.json({ ok: true, dryRun: true, count: dryOps.length, ops: dryOps, results });
    // 影響部門の メンバー数 を Contact の実数でリフレッシュ（best-effort）
    for (const [oid, rid] of touchedDepts) {
      try {
        const g = await contactCall('GET', `/open-apis/contact/v3/departments/${encodeURIComponent(oid)}`,
          null, { department_id_type: 'open_department_id' });
        const mc = g.data && g.data.department && g.data.department.member_count;
        if (typeof mc === 'number') await baseUpsert(T_DEPT, rid, { 'メンバー数': mc });
      } catch (_) { /* best-effort */ }
    }
    const planStatus = fail === 0 ? (todo.length < (ops || []).length ? '実行中' : '完了') : (success > 0 ? '部分失敗' : '失敗');
    if (planRecId) { try { await baseUpsert(T_PLAN, planRecId, { 'ステータス': planStatus, '実行日時': nowStr(), '実行結果': `${success}件成功 / ${fail}件失敗` }); } catch (_) {} }
    try {
      // 監査ログにも「何がどう変わったか」を1行ずつ残す（誰が=作成者フィールドで自動記録）
      const detailLines = todo.map((o, i) => {
        const r = results[i] || {};
        const ba = (o.beforeText || o.afterText) ? `${o.beforeText || '—'} → ${o.afterText || '—'}` : `${o.fromName || '—'} → ${o.toName || '—'}`;
        return `${r.ok ? '✓' : '✗'} [${o.opType}] ${o.targetName}: ${ba}${r.ok ? '' : `（${(r.error || '').slice(0, 80)}）`}`;
      });
      await baseCreate(T_AUDIT, ['詳細', '日時', 'アクション', '結果', '関連計画'],
        [[`実行: ${success}件成功 / ${fail}件失敗\n${detailLines.join('\n')}`, nowStr(), '実行', fail === 0 ? '成功' : '失敗', planRecId ? [{ id: planRecId }] : null]]);
    } catch (_) {}
    res.json({ ok: true, results, success, fail, planStatus });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// ================= CSVインポート履歴を Base に保存 =================
app.post('/api/csv-import', async (req, res) => {
  try {
    const { kind, content, rows, applied, summary } = req.body;
    const ids = await baseCreate(T_CSV,
      ['ファイル名/概要', '種別', '内容(CSV)', '行数', '反映件数'],
      [[summary || '', kind === 'member' ? 'メンバー' : '部門', (content || '').slice(0, 100000), rows || 0, applied || 0]]);
    res.json({ ok: true, recId: ids[0], url: baseUrl(T_CSV) });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

app.post('/api/chatgroups/create', async (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'ローカル開発サーバーではグループ作成に対応していません。本番 Worker でお試しください。'
  });
});

// セットアップ状態（config が揃っているか）: フロントの初回セットアップ画面判定用
app.get('/api/setup/status', (req, res) => {
  res.json({ ok: true, configured: isConfigured(), profile: (CFG && CFG.profile) || null, domain: (CFG && CFG.domain) || null, baseUrl: BASE ? baseUrl() : null });
});

// テナントの雇用形態(employee_type)enum を動的取得（移植性: ハードコードせず実テナントの設定を使う）
app.get('/api/employee-types', async (req, res) => {
  try {
    const j = await contactCall('GET', '/open-apis/contact/v3/employee_type_enums', null, { page_size: 100 });
    const items = ((j.data && j.data.items) || [])
      .filter(e => e.enum_status === 1)
      .map(e => {
        const jp = (e.i18n_content || []).find(x => (x.locale || '').toLowerCase().startsWith('ja'));
        return { value: String(e.enum_value), name: (jp && jp.value) || e.content || String(e.enum_value) };
      });
    res.json({ ok: true, items: items.length ? items : [{ value: '1', name: '正社員' }] });
  } catch (e) { res.json({ ok: true, items: [{ value: '1', name: '正社員' }] }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`[org-editor] http://localhost:${PORT}  (M4/M5: 計画保存 + 実行エンジン)`));
