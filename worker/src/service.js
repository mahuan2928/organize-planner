// 組織プランナー: 環境非依存のサービス層（Express / Cloudflare Workers 共用）
// ※ このファイルは server.js から機械生成しています（中核ロジックはバイト等価）。
//    client 経由で Base / Contact にアクセスするため、lark-cli にも Node API にも依存しません。

const __ok = (x) => x;   // 旧 res.json(...) を戻り値に変換するための恒等関数

/**
 * @param {object} client
 *   fetchTable(tableId)                       -> [{record_id, ...fields}]
 *   baseCreate(tableId, fields, rows)         -> [recordId]
 *   baseUpsert(tableId, recordId, patch)      -> any
 *   baseDelete(tableId, recordId)             -> any
 *   contactCall(method, path, data, params)   -> Lark レスポンス（tenant token）
 *   chatAddMembers(chatId, openIds)           -> any
 *   chatRemoveMembers(chatId, openIds)        -> any
 *   baseUrl(tableId?)                         -> Base の URL
 *   nowStr()                                  -> "YYYY-MM-DD HH:MM:SS"
 *   tables: { dept, member, plan, op, audit, csv }
 */
export function createService(client) {
  const { fetchTable, baseCreate, baseUpsert, baseDelete, contactCall, baseUrl, nowStr, chatAddMembers, chatRemoveMembers } = client;
  const { dept: T_DEPT, member: T_MEM, plan: T_PLAN, op: T_OP, audit: T_AUDIT, csv: T_CSV, chat: T_CHAT } = client.tables;
  const contactPatch = (apiPath, data, params) => contactCall('PATCH', apiPath, data, params);
  const linkIds = (v) => Array.isArray(v) ? v.map(x => x && x.id).filter(Boolean) : [];
  const sel = (v) => Array.isArray(v) ? (v[0] || '') : (v || '');
  const cellText = (v) => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join('、');
    if (typeof v === 'object') {
      if ('text' in v) return cellText(v.text);
      if ('name' in v) return cellText(v.name);
      if ('value' in v) return cellText(v.value);
      if ('text_arr' in v) return cellText(v.text_arr);
      if ('link' in v) return cellText(v.link);
    }
    return '';
  };
  const normRole = (v) => cellText(v).trim().toLowerCase();
  const chunksOf = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  };
  async function mapLimit(items, limit, fn) {
    const out = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ---- テナント名（scope 未付与ならフォールバック）----
  let tenantNameCache = null;
  async function getTenantName() {
    if (tenantNameCache) return tenantNameCache;
    try {
      const j = await contactCall('GET', '/open-apis/tenant/v2/tenant/query', null, null);
      const nm = j.data && j.data.tenant && j.data.tenant.name;
      if (nm) { tenantNameCache = nm; return nm; }
    } catch (_) { /* フォールバック */ }
    return client.tenantNameFallback || 'テナント';
  }

  async function contactUsersBatch(openIds) {
    const map = {};
    const chunks = chunksOf([...new Set((openIds || []).map(x => String(x || '').trim()).filter(Boolean))], 50);
    await mapLimit(chunks, 4, async (chunk) => {
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
    });
    return map;
  }
  async function contactDeptsBatch(openDeptIds) {
    const map = {};
    const chunks = chunksOf([...new Set((openDeptIds || []).map(x => String(x || '').trim()).filter(Boolean))], 50);
    await mapLimit(chunks, 4, async (chunk) => {
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
    });
    return map;
  }
  async function getRoleChatMap() {
    if (!T_CHAT) return new Map();
    let rows;
    try { rows = await fetchTable(T_CHAT); }
    catch (e) { throw new Error(`チャットグループ管理テーブルの読み取りに失敗: ${String((e && e.message) || e)}`); }
    const map = new Map();
    rows.forEach(r => {
      const role = normRole(r['役職フィルター'] || r['役職'] || r['職位'] || r['职位']);
      const groupNameValue = r['チャットグループ名'] || r['グループ名'] || r['群名'] || r['チャット名'] || r['名称'] || r['名前'] || r['Name'] || r['聊天群名称'] || r['群聊名称'];
      const chatId = cellText(r['chat_id'] || r['チャットID'] || r['Chat ID'] || r['chatId'] || r['群ID'] || r['群聊ID'] || r['聊天群ID'] || groupNameValue).trim();
      if (!role || !chatId) return;
      if (!map.has(role)) map.set(role, []);
      map.get(role).push({ chatId, name: cellText(groupNameValue) || chatId });
    });
    return map;
  }
  async function syncRoleChatMembership(roleChatMap, oldTitle, newTitle, userOpenId) {
    if (!userOpenId || !chatAddMembers || !chatRemoveMembers) return '';
    if (!T_CHAT) return 'チャットグループ管理テーブルが未設定/未検出のため、役職チャットグループは同期していません。';
    if (!roleChatMap) return '';
    const oldRole = normRole(oldTitle);
    const newRole = normRole(newTitle);
    if (oldRole === newRole) return '';
    const notes = [];
    const oldGroups = oldRole ? (roleChatMap.get(oldRole) || []) : [];
    const newGroups = newRole ? (roleChatMap.get(newRole) || []) : [];
    if (oldRole && !oldGroups.length) notes.push(`旧役職「${oldTitle}」のチャットグループ記録なし`);
    if (newRole && !newGroups.length) notes.push(`新役職「${newTitle}」のチャットグループ記録なし`);
    const byChatId = (groups) => new Map(groups.map(g => [g.chatId, g]));
    const oldById = byChatId(oldGroups);
    const newById = byChatId(newGroups);
    const removeGroups = [...oldById.values()].filter(g => !newById.has(g.chatId));
    const addGroups = [...newById.values()].filter(g => !oldById.has(g.chatId));
    for (const g of removeGroups) {
      try {
        await chatRemoveMembers(g.chatId, [userOpenId]);
        notes.push(`旧役職グループ「${g.name}」から退出`);
      } catch (e) {
        notes.push(`旧役職グループ「${g.name}」退出失敗: ${String((e && e.message) || e)}`);
      }
    }
    for (const g of addGroups) {
      try {
        await chatAddMembers(g.chatId, [userOpenId]);
        notes.push(`新役職グループ「${g.name}」へ参加`);
      } catch (e) {
        notes.push(`新役職グループ「${g.name}」参加失敗: ${String((e && e.message) || e)}`);
      }
    }
    return notes.join(' / ');
  }

  async function getOrg() {
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
      return __ok({ ok: true, base: baseUrl(), tenantName, stats: { depts: dOut.length, members: mOut.length }, depts: dOut, members: mOut });
    } catch (e) {
      return __ok({
        ok: false,
        error: String((e && e.message) || e),
        code: e && e.code,
        base: baseUrl()
      });
    }
  }

  async function savePlan(body) {
    try {
      const { name, effectiveDate, summary, operations } = body;
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
      return __ok({ ok: true, planRecId, opRecIds, planUrl: baseUrl(T_PLAN) });
    } catch (e) { throw e; }
  }

  async function listPlans() {
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
      return __ok({ ok: true, plans });
    } catch (e) { throw e; }
  }

  // メールから現アプリの open_id を引く。open_id はアプリごとの名前空間なので、
  // 台帳に保存された open_id が別アプリ由来だと書き戻しに使えない。
  // 照会に失敗したかどうかを呼び出し側が判定できるよう、握り潰さず errors を返す。
  async function batchGetOpenIdsByEmail(emails) {
    const uniq = [...new Set((emails || []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
    const out = {};
    const errors = [];
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      try {
        const j = await contactCall('POST', '/open-apis/contact/v3/users/batch_get_id',
          { emails: chunk }, { user_id_type: 'open_id' });
        const list = (j.data && (j.data.user_list || j.data.users)) || [];
        list.forEach(u => {
          const email = String(u.email || '').trim().toLowerCase();
          const id = u.user_id || u.open_id;
          if (email && id) out[email] = id;
        });
      } catch (e) {
        errors.push(String((e && e.message) || e));
      }
    }
    return { map: out, errors };
  }

  /** 台帳の open_id が現アプリで有効かを一括確認（有効な open_id の Set を返す） */
  async function verifyOpenIds(openIds) {
    const uniq = [...new Set((openIds || []).map(x => String(x || '').trim()).filter(Boolean))];
    const alive = new Set();
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      try {
        const j = await contactCall('GET', '/open-apis/contact/v3/users/batch', null,
          { user_ids: chunk, user_id_type: 'open_id' });
        ((j.data && j.data.items) || []).forEach(u => { if (u.open_id) alive.add(u.open_id); });
      } catch (_) { /* 確認できなかった分は未解決として扱う（安全側） */ }
    }
    return alive;
  }

  /**
   * 台帳の open_id → 現アプリの open_id へ解決する仕組みを作る。
   * ① メールがあれば batch_get_id で現アプリの open_id を引く（最も確実）
   * ② メールが無い／引けなかった場合は、台帳の open_id が現アプリで有効かを確認する
   * ③ どちらも駄目なら「未解決」として記録し、書き戻しをブロックする
   *    （以前は古い open_id をそのまま送っていたため、原因不明のエラーになっていた）
   * @returns {{ resolve: (oldOpen, recId) => string, unresolved: Array, lookupErrors: Array }}
   */
  async function buildAppOpenResolver(todo) {
    const memberRows = await fetchTable(T_MEM).catch(() => []);
    const recEmail = new Map();     // recordId -> email
    const openEmail = new Map();    // 台帳の open_id -> email
    const openName = new Map();     // 台帳の open_id -> 氏名（エラー文で誰か分かるように）
    const recName = new Map();      // recordId -> 氏名
    memberRows.forEach(r => {
      const name = String(r['氏名'] || '').trim();
      const oldOpen = String(r['open_id'] || '').trim();
      if (r.record_id && name) recName.set(r.record_id, name);
      if (oldOpen && name) openName.set(oldOpen, name);
      const email = String(r['メールアドレス'] || '').trim().toLowerCase();
      if (!email) return;
      if (r.record_id) recEmail.set(r.record_id, email);
      if (oldOpen) openEmail.set(oldOpen, email);
    });

    // 今回の op で参照されるメンバーだけを対象にする（全件照会は無駄なので）
    const refs = [];   // {oldOpen, recId}
    (todo || []).forEach(o => {
      const add = (oldOpen, recId) => { if (oldOpen || recId) refs.push({ oldOpen: oldOpen || '', recId: recId || '' }); };
      add(o.objType === 'メンバー' ? o.targetOpenId : '', o.objType === 'メンバー' ? o.targetRecId : '');
      add(o.newLeaderOpenId, o.newLeaderRecId);
      add(o.leaderOpenId, o.leaderRecId);
      add(o.handoverOpenId, o.handoverRecId);
      (o.addDeputyOpenIds || []).forEach(id => add(id, ''));
      (o.removeDeputyOpenIds || []).forEach(id => add(id, ''));
    });

    const wantedEmails = new Set();
    refs.forEach(({ oldOpen, recId }) => {
      const email = (recId && recEmail.get(recId)) || (oldOpen && openEmail.get(oldOpen));
      if (email) wantedEmails.add(email);
    });
    const { map: emailOpen, errors: lookupErrors } = await batchGetOpenIdsByEmail([...wantedEmails]);

    const emailOf = (oldOpen, recId) => (recId && recEmail.get(recId)) || (oldOpen && openEmail.get(oldOpen)) || '';
    // メール経由で解決できなかった分は、台帳の open_id が現アプリで通用するか確認する
    const needVerify = refs
      .filter(({ oldOpen, recId }) => oldOpen && !isTmpId(oldOpen) && !emailOpen[emailOf(oldOpen, recId)])
      .map(x => x.oldOpen);
    const verified = needVerify.length ? await verifyOpenIds(needVerify) : new Set();

    const unresolved = [];   // {name, reason}
    const seenBad = new Set();
    const resolve = (oldOpen, recId) => {
      const email = emailOf(oldOpen, recId);
      const byEmail = email && emailOpen[email];
      if (byEmail) return byEmail;
      if (oldOpen && verified.has(oldOpen)) return oldOpen;   // 台帳の ID がそのまま通用する
      const key = oldOpen || recId;
      if (key && !seenBad.has(key)) {
        seenBad.add(key);
        unresolved.push({
          name: recName.get(recId) || openName.get(oldOpen) || '(氏名不明)',
          reason: email ? 'メールアドレスで照会できませんでした' : 'メールアドレスが台帳に未登録です'
        });
      }
      return '';   // 未解決＝空文字。呼び出し側でブロックする
    };
    return { resolve, unresolved, lookupErrors };
  }
  const isTmpId = (v) => typeof v === 'string' && (v.startsWith('new|') || v.startsWith('newm|'));

  async function execute(body) {
    try {
      const { planRecId, ops, limit, dryRun, __actor } = body;
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
      const appOpen = await buildAppOpenResolver(todo);
      // 未解決のメンバーは「古い open_id で書き込む」のではなく明示的に失敗させる。
      // 別アプリ由来の open_id を送っても Lark 側で原因不明のエラーになるだけで、実行者が対処できない。
      const rMemberOpen = (openId, recId, label) => {
        if (!openId) return '';
        if (isTmp(openId)) return rOpen(openId);
        const resolved = appOpen.resolve(openId, recId);
        if (!resolved) {
          const who = (appOpen.unresolved.find(u => u.name !== '(氏名不明)') || {}).name || '';
          throw new Error(`${label || 'メンバー'}を Lark 上で特定できませんでした${who ? `（${who} など）` : ''}。台帳のメールアドレスをご確認ください。`);
        }
        return resolved;
      };
      const needsRoleChatSync = !isDry && todo.some(o => o.opType === 'MEMBER_UPDATE' && 'newTitle' in o);
      let roleChatMap = new Map();
      let roleChatMapError = '';
      if (needsRoleChatSync) {
        try { roleChatMap = await getRoleChatMap(); }
        catch (e) { roleChatMapError = String((e && e.message) || e); }
      }
      const currentMemberTitle = new Map();
      if (needsRoleChatSync && todo.some(o => !('oldTitle' in o))) {
        const memberRows = await fetchTable(T_MEM).catch(() => []);
        memberRows.forEach(r => {
          const title = cellText(r['役職']);
          if (r.record_id) currentMemberTitle.set(`rec:${r.record_id}`, title);
          const open = cellText(r['open_id']).trim();
          if (open) currentMemberTitle.set(`open:${open}`, title);
        });
      }
      for (const o of todo) {
        let ok = false, error = '', chatSync = '';
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
            const mainOpen = o.newLeaderOpenId ? rMemberOpen(o.newLeaderOpenId, o.newLeaderRecId, '責任者') : '';
            if (o.newLeaderOpenId && isTmp(o.newLeaderOpenId) && !mainOpen) throw new Error('責任者（新規メンバー）が未作成のため実行できません');
            let data;
            if (mainOpen) {
              const addDep = (o.addDeputyOpenIds || []).map(id => rMemberOpen(id, '', '副責任者')).filter(Boolean);
              const removeDep = new Set((o.removeDeputyOpenIds || []).map(id => rMemberOpen(id, '', '副責任者')).filter(Boolean));
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
              const lo = rMemberOpen(o.leaderOpenId, o.leaderRecId, '上長');
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
              const lo = rMemberOpen(o.newLeaderOpenId, o.newLeaderRecId, '責任者');
              if (isTmp(o.newLeaderOpenId) && !lo) throw new Error('上長（新規メンバー）が未作成のため実行できません');
              data.leader_user_id = lo;
            }
            const targetUserOpen = rMemberOpen(o.targetOpenId, o.targetRecId, '対象メンバー');
            await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
              data, { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_UPDATE ${o.targetName}`);
            if (!isDry && 'newTitle' in o) {
              const oldTitle = ('oldTitle' in o) ? o.oldTitle : (currentMemberTitle.get(`rec:${o.targetRecId}`) || currentMemberTitle.get(`open:${o.targetOpenId}`) || '');
              chatSync = roleChatMapError || await syncRoleChatMembership(roleChatMap, oldTitle, o.newTitle, targetUserOpen);
              if (/失敗|同期していません|読み取りに失敗/.test(chatSync)) throw new Error(chatSync);
            }
          } else if (o.opType === 'MEMBER_SET_PRIMARY') {
            // 主部門の設定。Lark では is_primary_dept は書込不可（派生値）で、department_order が最大の部門が主部門。
            // ユーザーのライブ orders/department_ids を取得し、全部門を保持したまま対象部門の order を最大化（隠れ部門の脱落防止）。
            const primOpen = rOpen(o.primaryDeptOpenId);
            if (isTmp(o.primaryDeptOpenId) && !primOpen) throw new Error('主部門（新規）が未作成のため実行できません');
            const targetUserOpen = rMemberOpen(o.targetOpenId, o.targetRecId, '対象メンバー');
            const g = await contactCall('GET', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
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
            await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
              { department_ids: liveDeptIds, orders: newOrders }, { user_id_type: 'open_id', department_id_type: 'open_department_id' }, `MEMBER_SET_PRIMARY ${o.targetName}`);
          } else if (o.opType === 'MEMBER_DELETE') {
            // 資源引継(handover): 引継先が指定されていれば、グループ/ドキュメント/カレンダー/アプリ等を移管してから削除
            let body = null;
            if (o.handoverOpenId) {
              const h = rMemberOpen(o.handoverOpenId, o.handoverRecId, '引継先');
              if (h) body = {
                department_chat_acceptor_user_id: h, external_chat_acceptor_user_id: h,
                docs_acceptor_user_id: h, calendar_acceptor_user_id: h,
                application_acceptor_user_id: h, minutes_acceptor_user_id: h, survey_acceptor_user_id: h
              };
            }
            const targetUserOpen = rMemberOpen(o.targetOpenId, o.targetRecId, '対象メンバー');
            await sendOrRecord('DELETE', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
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
            const targetUserOpen = rMemberOpen(o.targetOpenId, o.targetRecId, '対象メンバー');
            const g = await contactCall('GET', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
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
            await sendOrRecord('PATCH', `/open-apis/contact/v3/users/${encodeURIComponent(targetUserOpen)}`,
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
        results.push({ opRecId: o.opRecId, name: o.targetName, type: o.opType, ok, error, chatSync });
      }
      // dry-run: Base/監査への書き込みは一切せず、構築した Contact リクエストのみ返す
      // dry-run では「Lark 上で特定できないメンバー」も返す → 実行前に画面で警告できる
      if (isDry) return __ok({
        ok: true, dryRun: true, count: dryOps.length, ops: dryOps, results,
        unresolvedMembers: appOpen.unresolved, lookupErrors: appOpen.lookupErrors
      });
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
        // 組織変更は Lark 仕様上 bot 名義で書き込まれるため、実行者はアプリ側で明示的に記録する
        const actorLine = __actor ? `実行者: ${__actor}\n` : '';
        await baseCreate(T_AUDIT, ['詳細', '日時', 'アクション', '結果', '関連計画'],
          [[`実行: ${success}件成功 / ${fail}件失敗\n${actorLine}${detailLines.join('\n')}`, nowStr(), '実行', fail === 0 ? '成功' : '失敗', planRecId ? [{ id: planRecId }] : null]]);
      } catch (_) {}
      return __ok({
        ok: fail === 0, results, success, fail, planStatus,
        unresolvedMembers: appOpen.unresolved   // 失敗した op の原因追跡用
      });
    } catch (e) { throw e; }
  }

  async function csvImport(body) {
    try {
      const { kind, content, rows, applied, summary } = body;
      const ids = await baseCreate(T_CSV,
        ['ファイル名/概要', '種別', '内容(CSV)', '行数', '反映件数'],
        [[summary || '', kind === 'member' ? 'メンバー' : '部門', (content || '').slice(0, 100000), rows || 0, applied || 0]]);
      return __ok({ ok: true, recId: ids[0], url: baseUrl(T_CSV) });
    } catch (e) { throw e; }
  }

  async function employeeTypes() {
    try {
      const j = await contactCall('GET', '/open-apis/contact/v3/employee_type_enums', null, { page_size: 100 });
      const items = ((j.data && j.data.items) || [])
        .filter(e => e.enum_status === 1)
        .map(e => {
          const jp = (e.i18n_content || []).find(x => (x.locale || '').toLowerCase().startsWith('ja'));
          return { value: String(e.enum_value), name: (jp && jp.value) || e.content || String(e.enum_value) };
        });
      return __ok({ ok: true, items: items.length ? items : [{ value: '1', name: '正社員' }] });
    } catch (e) { return __ok({ ok: true, items: [{ value: '1', name: '正社員' }] }); }
  }

  return { getOrg, savePlan, listPlans, execute, csvImport, employeeTypes, getTenantName };
}
