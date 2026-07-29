// M1 組織チャート + M2 ドラッグ編集（部門の親変更 + メンバー異動）+ 変更明細
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (s) => String(s || '?').trim().slice(0, 1);

const PALETTE = ['#7c5cff', '#2f80ed', '#17b3a3', '#f2994a', '#eb5757', '#27ae60', '#e84393', '#00a3bf', '#8e44ad', '#d98d00'];
const ROOT_ID = '__root__';
const ORPHAN_ID = '__orphan__';   // 仮想ノード: 部門未設定（無所属）メンバーの受け皿（編集対象外）

let chart = null;
let BASE_URL = '';   // Base 台帳の URL（サーバー設定から取得。テナント固有値をコードに持たない）
let COMPACT = true;
// 表示密度: simple=部門のみ / full=部門+全メンバー（全員が独立ノード）。新規ユーザーは simple で始める
const SAVED_DENSITY = localStorage.getItem('orgplanner_density');
let DENSITY = SAVED_DENSITY === 'full' ? 'full' : 'simple';
let SHOW_REPORTING = false;   // 汇报線（人→人）: 既定は隠し。ONで上長の下にネスト表示（帰属は部門ツリーで担保）
let HIDE_NOISE_DEPTS = localStorage.getItem('orgplanner_hide_noise_depts') === '1';
let SIMPLE = false;           // 旧スタート画面モード（廃止・常に部門ツリー表示）
let FOCUS = null;             // 任意の集中ドリル（部門サブツリーに絞る）
let NODES = [];              // フラット部門 working data（草稿）
const ORIG = new Map();      // deptId -> 元 parentId（基線）
const MEMBERS = new Map();   // memberId -> {id,name,title,email,empNo,status,deptIds:Set,origDeptIds:Set,color}
let dndReady = false;
let dragState = null;        // {kind:'dept'|'member', id, srcDept?}
let drawerDept = null;       // 現在ドロワーで開いている部門 id
let PLAN = null;             // 保存済み計画 {planRecId, execOps, planUrl, name, results?}
const EXPANDED = new Set();  // ユーザーが展開中の部門 id（複数可・drag/再描画をまたいで保持）
let moveState = null;        // メンバー異動モード {memId, srcDept}

// ---- ワークベンチ UI 状態（表示層のみ・業務ロジックには影響しない）----
const HIST = [];             // 操作履歴（セッション内） [{time, action, detail}]
let LAST_SYNC = null;        // 最終同期時刻
let LAST_EDIT = null;        // 草稿の最終編集時刻
let SELECTED = null;         // 詳細パネルの選択対象 {kind:'dept'|'member', id}
const fmtTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--';
function logHist(action, detail) {
  HIST.unshift({ time: new Date(), action, detail });
  if (HIST.length > 200) HIST.pop();
  renderHist();
}
function markEdited() { LAST_EDIT = new Date(); }
async function readApiJson(res, label) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`${label}: 空のレスポンスです（HTTP ${res.status}）`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const preview = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`${label}: JSON ではないレスポンスです（HTTP ${res.status}）。${preview}`);
  }
}

function softColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.14)`;
}

async function load() {
  $('error').hidden = true;
  $('syncFail').hidden = true;
  $('skeleton').hidden = false;
  $('chart').style.visibility = 'hidden';
  try {
    const res = await fetch('/api/org');
    const d = await readApiJson(res, '/api/org');
    // 本番（Worker）ではログイン必須。未ログイン/期限切れならログイン画面へ誘導する
    if (res.status === 401 && d.needLogin) { location.href = '/auth/login'; return; }
    if (res.status === 403) { showAuthError(d.error || '管理者権限が必要です'); return; }
    if (!d.ok) {
      const err = new Error(d.error || '取得に失敗しました');
      err.code = d.code;
      err.base = d.base;
      throw err;
    }
    $('baselink').href = d.base;
    BASE_URL = d.base || '';   // 台帳リンクはサーバー設定から受け取る（テナント固有値をコードに埋め込まない）
    $('stats').textContent = `部門 ${d.stats.depts}件 ・ メンバー ${d.stats.members}名`;
    LAST_SYNC = new Date();
    $('syncTime').textContent = fmtTime(LAST_SYNC);
    $('syncDot').className = 'sync-dot ok';
    logHist('同期', `Lark / Base から組織を同期（部門 ${d.stats.depts} ・ メンバー ${d.stats.members}）`);
    NODES = buildFlat(d);
    ORIG.clear(); NODES.forEach(n => { if (n.type === 'dept') ORIG.set(n.id, n.parentId); });
    MEMBERS.clear();
    d.members.forEach(m => MEMBERS.set(m.id, {
      id: m.id, name: m.name, openId: m.openId || '', title: m.title || '', email: m.email, empNo: m.empNo, status: m.status,
      leaderId: m.leaderId || null, origLeaderId: m.leaderId || null, origTitle: m.title || '',
      primaryDept: m.primaryDept || null, origPrimaryDept: m.primaryDept || null,   // Lark: 主部門（兼任時）
      statusFlags: m.statusFlags || null, deptOrders: m.deptOrders || {},           // Lark: 多状態 / 部門内並び順
      employeeType: m.employeeType || null,                                          // Lark: 雇用形態
      isNew: false, deleted: false, mobile: '',
      deptIds: new Set(m.deptIds), origDeptIds: new Set(m.deptIds)
    }));
    NODES.forEach(n => { if (n.type === 'dept') updateDeptSub(n); });   // 他部門所属の注記も含め統一計算
    render(); attachDnD(); renderDiff(); closeDrawer();
    $('skeleton').hidden = true;
    $('chart').style.visibility = '';
    scheduleOnboarding();
  } catch (e) {
    $('skeleton').hidden = true;
    $('syncDot').className = 'sync-dot ng';
    renderSyncError(e);
    $('syncFail').hidden = false;
    logHist('同期失敗', String((e && e.message) || e));
  }
}
$('retryBtn') && ($('retryBtn').onclick = load);

function apiErrorInfo(e) {
  const raw = String((e && e.message) || e || '');
  const code = (e && e.code) || ((raw.match(/Lark\s+(\d+)/) || [])[1]);
  const base = (e && e.base) || BASE_URL || '';
  if (String(code) === '91403' || /you don't have permission/i.test(raw)) {
    return {
      title: 'Base 台帳へのアクセス権限がありません',
      body: 'このツールは、ログイン中のユーザー権限で Base 台帳を読み書きします。Base の所有者または管理者に依頼して、協力者として追加してもらってください。',
      action: base ? { href: base, label: 'Base 台帳を開いて権限申請' } : null,
      detail: code ? `Lark ${code}: you don't have permission` : raw
    };
  }
  return {
    title: 'データの取得に失敗しました',
    body: '時間をおいて再度お試しください。問題が続く場合は管理者にお問い合わせください。',
    action: null,
    detail: raw
  };
}
function renderSyncError(e) {
  const info = apiErrorInfo(e);
  $('syncFailMsg').innerHTML =
    `<div class="sf-main">${esc(info.title)}</div>` +
    `<div class="sf-help">${esc(info.body)}</div>` +
    (info.action ? `<a class="sf-link" href="${esc(info.action.href)}" target="_blank" rel="noopener">${esc(info.action.label)} ↗</a>` : '') +
    `<details class="sf-detail"><summary>詳細</summary><div>${esc(info.detail)}</div></details>`;
}

// 権限エラー（管理者以外）: 再試行しても無駄なので、専用の案内を出す
function showAuthError(msg) {
  $('skeleton').hidden = true;
  $('syncDot').className = 'sync-dot ng';
  $('syncFailMsg').textContent = msg + '\nこのツールは管理者権限をお持ちの方専用です。';
  $('syncFail').hidden = false;
  const btn = $('retryBtn');
  if (btn) { btn.textContent = '別のアカウントでログイン'; btn.onclick = () => { location.href = '/auth/logout'; }; }
}

// ログイン中のユーザーを表示（本番のみ。ローカル開発では /api/me が無くても無視）
async function showSession() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return;
    const d = await r.json();
    const el = $('sessionInfo');
    if (!el || !d.loggedIn) return;
    el.hidden = false;
    el.querySelector('.si-name').textContent = d.name || '';
  } catch (_) { /* ローカル開発時は何もしない */ }
}

// ---- 新手ガイド（初回だけ自動表示・右上の「ガイド」から再表示）----
const OB_KEY = 'orgplanner_onboarding_seen_v1';
let onboardingStep = 0;
let onboardingAutoQueued = false;
let onboardingResize = null;
const ONBOARDING_STEPS = [
  {
    title: '組織プランナーへようこそ',
    body: 'このガイドでは、実際の組織変更に近い流れで使い方を確認します。',
    tasks: ['対象を検索する', '組織構造を確認する', 'ドラッグで下書きを作る', '差分とリスクを確認する', '予約プランを作成・確定する'],
    safe: '所要時間は約 1 分です。実行するまで、Lark 側の正式な組織は変更されません。'
  },
  {
    selector: '#search',
    title: '1. 変更したい部門を探す',
    body: 'まずは検索で対象部門やメンバーを見つけます。大きな組織では、全体を眺めるより検索から始めると迷いにくくなります。',
    tasks: ['部門名またはメンバー名を入力', '候補を選択して組織図へ移動', '右側の詳細パネルで所属を確認']
  },
  {
    selector: '#chartWrap',
    title: '2. 構造を確認して下書きを作る',
    body: '中央のキャンバスで、親部門・子部門・所属メンバーを確認します。',
    tasks: ['部門をクリックして展開', '必要に応じて「全員」に切り替え', '部門やメンバーをドラッグして下書きを作成'],
    safe: 'ここで作成されるのは下書きです。まだ Lark には反映されません。'
  },
  {
    selector: '#sidePanel',
    title: '3. 差分とリスクを確認する',
    body: '右側のパネルには、下書きで発生した変更が一覧化されます。',
    tasks: ['移動・責任者変更・削除予定を確認', '詳細タブで Before / After を確認', '不要な変更があれば破棄または戻す']
  },
  {
    selector: '#actionMain',
    title: '4. 予約プランを作成する',
    body: '変更があると、右上の主ボタンから予約プランを作成できます。',
    tasks: ['変更件数を確認', '予約プラン名を入力', '保存後に実行前レビューへ進む'],
    safe: '予約プラン作成だけでは Lark 組織は変更されません。'
  },
  {
    selector: '#actionMain',
    title: '5. 最後に予約を確定する',
    body: '予約の確定が、正式な Lark 反映の最終ステップです。',
    tasks: ['実行対象件数を確認', '削除や大きな異動がないか確認', '問題なければ予約を確定'],
    safe: '不安な場合は、確定前に右側の「変更内容」をもう一度確認してください。',
    finalCta: '検索へ進む'
  }
];

function initOnboarding() {
  const btn = $('guideBtn');
  if (btn) btn.onclick = () => startOnboarding(true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.ob-layer')) closeOnboarding(false);
  });
}
function initReviewEmptyActions() {
  const search = $('reviewSearch');
  if (search) search.onclick = () => { showPanel(); switchTab('review'); $('search').focus(); };
  const fit = $('reviewFit');
  if (fit) fit.onclick = () => { chart && chart.fit(); };
  const guide = $('reviewGuide');
  if (guide) guide.onclick = () => startOnboarding(true);
}
function scheduleOnboarding() {
  if (onboardingAutoQueued || localStorage.getItem(OB_KEY) === '1') return;
  onboardingAutoQueued = true;
  setTimeout(() => startOnboarding(false), 650);
}
function startOnboarding(manual) {
  if (!manual && localStorage.getItem(OB_KEY) === '1') return;
  onboardingStep = 0;
  renderOnboarding();
}
function closeOnboarding(markSeen) {
  const layer = document.querySelector('.ob-layer');
  if (layer) layer.remove();
  if (markSeen) localStorage.setItem(OB_KEY, '1');
  if (onboardingResize) window.removeEventListener('resize', onboardingResize);
  onboardingResize = null;
}
function visibleRect(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el || el.hidden || el.getClientRects().length === 0) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  el.scrollIntoView && el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return el.getBoundingClientRect();
}
function renderOnboarding() {
  const step = ONBOARDING_STEPS[onboardingStep];
  if (!step) { closeOnboarding(true); return; }
  const rect = visibleRect(step.selector);
  if (step.selector && !rect) {
    onboardingStep += 1;
    renderOnboarding();
    return;
  }
  closeOnboarding(false);
  const layer = document.createElement('div');
  layer.className = 'ob-layer';
  const dots = ONBOARDING_STEPS.map((_, i) => `<span class="ob-dot ${i === onboardingStep ? 'on' : ''}"></span>`).join('');
  layer.innerHTML = `
    <div class="ob-backdrop"></div>
    <div class="ob-highlight" aria-hidden="true"></div>
    <section class="ob-card" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div class="ob-kicker">はじめてガイド ${onboardingStep + 1} / ${ONBOARDING_STEPS.length}</div>
      <div id="ob-title" class="ob-title">${esc(step.title)}</div>
      <div class="ob-body">${esc(step.body)}</div>
      ${step.tasks ? `<ol class="ob-tasklist">${step.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
      ${step.safe ? `<div class="ob-safe">${esc(step.safe)}</div>` : ''}
      <div class="ob-footer">
        <div class="ob-progress" aria-hidden="true">${dots}</div>
        <div class="ob-actions">
          ${onboardingStep > 0 ? '<button class="ob-prev" type="button">戻る</button>' : ''}
          <button class="ob-skip" type="button">スキップ</button>
          <button class="ob-next" type="button">${step.finalCta || (onboardingStep === ONBOARDING_STEPS.length - 1 ? '完了' : '次へ')}</button>
        </div>
      </div>
    </section>`;
  document.body.appendChild(layer);
  positionOnboarding(rect);
  const prev = layer.querySelector('.ob-prev');
  if (prev) prev.onclick = () => { onboardingStep -= 1; renderOnboarding(); };
  layer.querySelector('.ob-skip').onclick = () => closeOnboarding(true);
  layer.querySelector('.ob-next').onclick = () => {
    if (step.finalCta) {
      closeOnboarding(true);
      $('search') && $('search').focus();
      return;
    }
    onboardingStep += 1;
    if (onboardingStep >= ONBOARDING_STEPS.length) closeOnboarding(true);
    else renderOnboarding();
  };
  onboardingResize = () => positionOnboarding(visibleRect(step.selector));
  window.addEventListener('resize', onboardingResize);
  layer.querySelector('.ob-next').focus();
}
function positionOnboarding(rect) {
  const layer = document.querySelector('.ob-layer');
  if (!layer) return;
  const hi = layer.querySelector('.ob-highlight');
  const card = layer.querySelector('.ob-card');
  const margin = 16;
  if (!rect) {
    hi.hidden = true;
    card.style.left = `${Math.max(margin, (window.innerWidth - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.max(margin, (window.innerHeight - card.offsetHeight) / 2)}px`;
    return;
  }
  hi.hidden = false;
  hi.style.left = `${Math.max(8, rect.left - 6)}px`;
  hi.style.top = `${Math.max(8, rect.top - 6)}px`;
  hi.style.width = `${rect.width + 12}px`;
  hi.style.height = `${rect.height + 12}px`;
  const cardW = card.offsetWidth || 336;
  const cardH = card.offsetHeight || 220;
  let left = rect.right + 16;
  if (left + cardW + margin > window.innerWidth) left = rect.left - cardW - 16;
  if (left < margin) left = Math.min(window.innerWidth - cardW - margin, margin);
  let top = rect.top;
  if (top + cardH + margin > window.innerHeight) top = window.innerHeight - cardH - margin;
  if (top < margin) top = margin;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function buildFlat(d) {
  const memById = {}; d.members.forEach(m => memById[m.id] = m);
  const deptById = {}; d.depts.forEach(x => deptById[x.id] = x);
  const topOf = (id) => { let c = deptById[id]; while (c && c.parentId && deptById[c.parentId]) c = deptById[c.parentId]; return c ? c.id : id; };
  const roots = d.depts.filter(x => !x.parentId || !deptById[x.parentId]).map(x => x.id).sort();
  const colorOfRoot = {}; roots.forEach((rid, i) => colorOfRoot[rid] = PALETTE[i % PALETTE.length]);

  const rootName = d.tenantName || '組織全体';
  const nodes = [{ id: ROOT_ID, parentId: '', type: 'root', deptName: rootName, name: rootName, sub: 'テナント全体', avatarChar: initials(rootName), hasLeader: false, count: d.stats.members, color: '#4b4b6b' }];
  d.depts.forEach(x => {
    const leader = x.leaderId && memById[x.leaderId] ? memById[x.leaderId] : null;
    nodes.push({
      id: x.id,
      parentId: x.parentId && deptById[x.parentId] ? x.parentId : ROOT_ID,
      type: 'dept', deptName: x.name, name: x.name, origName: x.name, isNew: false, deleted: false,
      sub: '', hasLeader: !!leader, leaderId: x.leaderId || null, origLeaderId: x.leaderId || null,
      leaders: (x.leaders || []).map(l => ({ ...l })), origLeaders: (x.leaders || []).map(l => ({ ...l })),   // Lark: 主/副負責人リスト
      // 副責任者(leaderType2)のうちアプリで識別できる(=Base 同期済み)メンバーのみ編集対象として保持
      deputyIds: new Set((x.leaders || []).filter(l => l.type === 2 && l.id).map(l => l.id)),
      origDeputyIds: new Set((x.leaders || []).filter(l => l.type === 2 && l.id).map(l => l.id)),
      recursiveCount: x.recursiveCount != null ? x.recursiveCount : null,   // 子部門含む
      order: x.order != null ? x.order : null,                              // Lark 並び順
      avatarChar: initials(x.name), openId: x.openId || '', path: x.path || '',
      count: x.count || 0, baseCount: x.count || 0, color: colorOfRoot[topOf(x.id)] || '#7c5cff'
    });
  });
  return nodes;
}

// ---- 可視ノードを自前で制御（展開＝子ノードを含める / 折りたたみ＝含めない）----
// 部門が見えるか＝全ての祖先が EXPANDED（ルート直下は常に表示）
function isDeptShown(deptId) {
  let cur = NODES.find(n => n.id === deptId);
  while (cur && cur.parentId && cur.parentId !== ROOT_ID) {
    if (!EXPANDED.has(cur.parentId)) return false;
    cur = NODES.find(n => n.id === cur.parentId);
  }
  return true;
}
// 部門に展開できる子（子部門 or メンバー）があるか
function hasKids(deptId) {
  if (NODES.some(n => isDisplayDept(n) && n.parentId === deptId)) return true;
  for (const m of MEMBERS.values()) if (memberInVisibleDept(m) && m.deptIds.has(deptId)) return true;
  return false;
}
// 表示する部門スコープを決定: focus=選択部門(＋上位＋直下) / simple=トップ階層のみ / full=従来（展開ベース）
function visibleScope() {
  if (FOCUS && NODES.some(n => n.id === FOCUS && isDisplayDept(n))) {
    const f = NODES.find(n => n.id === FOCUS);
    const set = new Set([FOCUS]);
    const pid = (f.parentId && f.parentId !== ROOT_ID) ? f.parentId : null;
    if (pid) set.add(pid);
    NODES.forEach(n => { if (isDisplayDept(n) && n.parentId === FOCUS) set.add(n.id); });
    return { mode: 'focus', set, top: pid || FOCUS };
  }
  return { mode: 'full', set: null, top: null };   // 常に部門ツリー（メンバー表示は DENSITY で制御）
}
function buildChartData() {
  const rootN = NODES.find(n => n.type === 'root');
  const data = [rootN];
  const scope = visibleScope();
  // Lark 準拠: 部門は order（管理コンソールの並び順）でソート。集中時は表示最上位を仮想ルート直下へ付け替え（データ上のみ）。
  const deptList = (scope.mode === 'full')
    ? NODES.filter(n => isDisplayDept(n) && isDeptShown(n.id))
    : NODES.filter(n => isDisplayDept(n) && scope.set.has(n.id))
        .map(n => (scope.top && n.id === scope.top) ? { ...n, parentId: ROOT_ID } : n);
  deptList.sort((a, b) => (a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity))
    .forEach(n => data.push(n));
  // 部門未設定（無所属）メンバー: 迷子にしないため仮想部門ノードとしてルート直下に出す
  const orphans = unassignedMembers();
  if (orphans.length && (!FOCUS || scope.mode !== 'focus')) {
    data.push({ id: ORPHAN_ID, parentId: ROOT_ID, type: 'dept', deptName: '部門未設定', name: '部門未設定',
      sub: 'どの部門にも所属していません', hasLeader: false, isNew: false, deleted: false, virtual: true,
      avatarChar: '未', color: '#F79009', count: orphans.length, openId: '', path: '' });
    if (DENSITY !== 'simple' && EXPANDED.has(ORPHAN_ID)) {
      orphans.forEach(m => data.push({
        id: `m|${m.id}|${ORPHAN_ID}`, parentId: ORPHAN_ID, type: 'member', memId: m.id, srcDept: ORPHAN_ID,
        name: m.name, sub: m.title || '', multi: false, extLeaderName: '', cycle: false,
        avatarChar: initials(m.name), color: '#F79009', status: m.status
      }));
    }
  }
  // メンバー配置は DENSITY で制御: simple=なし / leader=責任者(主+副)のみ+「他N名」/ full=全員(SHOW_REPORTINGで汇报ネスト)
  if (DENSITY === 'simple') return data;
  NODES.forEach(dept => {
    const did = dept.id;
    if (!isDisplayDept(dept)) return;
    const deptVisible = scope.mode === 'full' ? isDeptShown(did) : (scope.set && scope.set.has(did));
    const deptOpen = scope.mode === 'focus' ? (did === FOCUS) : EXPANDED.has(did);
    if (!deptVisible || !deptOpen) return;   // メンバーは「展開した部門」だけ表示（既定は畳んでスッキリ）
    const inDept = [...MEMBERS.values()].filter(m => memberInVisibleDept(m) && m.deptIds.has(did))
      .sort((a, b) => ((a.deptOrders && a.deptOrders[did]) || 0) - ((b.deptOrders && b.deptOrders[did]) || 0));   // Lark: 部門内並び順
    if (!inDept.length) return;
    const inDeptIds = new Set(inDept.map(m => m.id));
    const mkNode = (m, parentId) => {
      const hasLeader = m.leaderId && m.leaderId !== m.id;
      const extLeaderName = (hasLeader && !inDeptIds.has(m.leaderId)) ? (MEMBERS.get(m.leaderId)?.name || '未同期') : '';
      return {
        id: `m|${m.id}|${did}`, parentId, type: 'member', memId: m.id, srcDept: did, name: m.name, sub: m.title || '',
        multi: m.deptIds.size > 1, extLeaderName, cycle: false, avatarChar: initials(m.name), color: dept.color, status: m.status
      };
    };
    // full: 全員を独立ノードで配置（折りたたみは部門単位）。責任者も通常ノード＋ラベルのみ（重複ノードを作らない）。
    // 帰属＝部門ツリー（member の親＝部門）が既定。SHOW_REPORTING ON のときだけ上長の下にネスト（汇报線）。
    const leaderId = dept.leaderId && inDeptIds.has(dept.leaderId) ? dept.leaderId : null;
    const parentOf = (m) => {
      if (!SHOW_REPORTING) return did;                         // 汇报off: 全員を部門直下に平坦配置
      if (m.id === leaderId) return did;
      const boss = m.leaderId && m.leaderId !== m.id && inDeptIds.has(m.leaderId) ? m.leaderId : null;
      if (boss) return `m|${boss}|${did}`;
      return leaderId ? `m|${leaderId}|${did}` : did;
    };
    const parentMap = new Map(inDept.map(m => [m.id, parentOf(m)]));
    const cycleSet = new Set();
    if (SHOW_REPORTING) {
      inDept.forEach(m => {
        const seen = new Set([m.id]); let cur = parentMap.get(m.id);
        while (cur && cur !== did) { const mid = cur.split('|')[1]; if (seen.has(mid)) { cycleSet.add(m.id); parentMap.set(m.id, leaderId && m.id !== leaderId ? `m|${leaderId}|${did}` : did); break; } seen.add(mid); cur = parentMap.get(mid); }
      });
    }
    inDept.forEach(m => { const n = mkNode(m, parentMap.get(m.id)); n.cycle = cycleSet.has(m.id); data.push(n); });
  });
  return data;
}

// ---- 人数 = 基線メンバー数 + 異動の増減（Base 表示値を保ちつつライブ更新）----
let HEADCOUNT = {};        // deptId -> Set(memberId)：部門+子孫の重複なし所属（草稿反映）
let DIRECTCOUNT = {};      // deptId -> Set(memberId)：直属のみ
function recountDepts() {
  const orig = {}, draft = {};
  DIRECTCOUNT = {};
  NODES.forEach(n => { if (n.type === 'dept' && !n.deleted) DIRECTCOUNT[n.id] = new Set(); });
  MEMBERS.forEach(m => {
    m.origDeptIds.forEach(id => orig[id] = (orig[id] || 0) + 1);
    if (!m.deleted) m.deptIds.forEach(id => { draft[id] = (draft[id] || 0) + 1; if (DIRECTCOUNT[id]) DIRECTCOUNT[id].add(m.id); });
  });
  NODES.forEach(n => {
    if (n.type === 'dept') n.count = (n.baseCount || 0) + ((draft[n.id] || 0) - (orig[n.id] || 0));
  });
  // 再帰ヘッドカウント: 部門+全子孫の重複なしメンバー（＝カードに出す「部門人数」）
  HEADCOUNT = {};
  const childrenOf = {};
  NODES.forEach(n => { if (n.type === 'dept' && !n.deleted) (childrenOf[n.parentId] = childrenOf[n.parentId] || []).push(n.id); });
  const rec = (id) => {
    if (HEADCOUNT[id]) return HEADCOUNT[id];
    const set = new Set(DIRECTCOUNT[id] || []);
    (childrenOf[id] || []).forEach(c => rec(c).forEach(x => set.add(x)));
    HEADCOUNT[id] = set; return set;
  };
  NODES.forEach(n => { if (n.type === 'dept' && !n.deleted) rec(n.id); });
}
function deptHeadcount(id) { return HEADCOUNT[id] ? HEADCOUNT[id].size : 0; }        // 部門全体（子部門含む）
function deptDirectCount(id) { return DIRECTCOUNT[id] ? DIRECTCOUNT[id].size : 0; }   // 直属のみ
function displayDeptHeadcount(id) {
  if (!HIDE_NOISE_DEPTS) return deptHeadcount(id);
  const deptSet = new Set();
  const walk = (did) => {
    const d = NODES.find(n => n.id === did);
    if (!isDisplayDept(d)) return;
    deptSet.add(did);
    NODES.filter(n => isDisplayDept(n) && n.parentId === did).forEach(c => walk(c.id));
  };
  walk(id);
  const memSet = new Set();
  MEMBERS.forEach(m => {
    if (memberInVisibleDept(m) && [...m.deptIds].some(did => deptSet.has(did))) memSet.add(m.id);
  });
  return memSet.size;
}

// ---- 親子ヘルパ（草稿）----
const parentOf = (id) => { const n = NODES.find(x => x.id === id); return n ? n.parentId : null; };
const NOISE_DEPT_RE = /(test|demo|テスト|デモ|検証|検証用|测试|測試)/i;
function isNoiseDeptName(name) { return NOISE_DEPT_RE.test(String(name || '')); }
function isNoiseDeptId(deptId) {
  let cur = NODES.find(n => n.id === deptId && n.type === 'dept');
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (isNoiseDeptName(cur.deptName) || isNoiseDeptName(cur.name)) return true;
    cur = NODES.find(n => n.id === cur.parentId && n.type === 'dept');
  }
  return false;
}
function isDisplayDept(n) {
  return n && n.type === 'dept' && !n.deleted && (!HIDE_NOISE_DEPTS || !isNoiseDeptId(n.id));
}
function visibleDeptIds() {
  return new Set(NODES.filter(isDisplayDept).map(n => n.id));
}
function memberInVisibleDept(m) {
  if (!m || m.deleted) return false;
  if (!HIDE_NOISE_DEPTS) return true;
  const ids = visibleDeptIds();
  return [...m.deptIds].some(id => ids.has(id));
}
function isDescendant(target, ancestor) {
  let cur = target;
  while (cur && cur !== ROOT_ID && cur !== '') { if (cur === ancestor) return true; cur = parentOf(cur); }
  return false;
}
// 上長チェーンをたどって循環になるか（memId の新しい上長を newLeaderId にした場合）
function leaderCycle(memId, newLeaderId) {
  let cur = newLeaderId; const seen = new Set();
  while (cur && !seen.has(cur)) {
    if (cur === memId) return true;
    seen.add(cur);
    cur = MEMBERS.get(cur)?.leaderId || null;
  }
  return false;
}
const deptChanged = (n) => n.type === 'dept' && !n.isNew && !n.deleted && ORIG.get(n.id) !== n.parentId;
const deptRenamed = (n) => n.type === 'dept' && !n.isNew && !n.deleted && n.origName != null && n.deptName !== n.origName;
const deptLeaderChanged = (n) => n.type === 'dept' && !n.isNew && !n.deleted &&
  ((n.leaderId || null) !== (n.origLeaderId || null) || sig(n.deputyIds || new Set()) !== sig(n.origDeputyIds || new Set()));
// 部門ノードの「責任者: ◯◯」表示を現在の下書き状態から再計算
function updateDeptSub(n) {
  // Lark 準拠: 部門負責人は 主(leaderType1)+副(leaderType2) のリスト。主=n.leaderId、副=n.deputyIds（いずれも編集可）
  const leader = n.leaderId ? MEMBERS.get(n.leaderId) : null;
  const deputies = [...(n.deputyIds || [])]
    .filter(id => id !== n.leaderId && MEMBERS.get(id) && !MEMBERS.get(id).deleted)
    .map(id => MEMBERS.get(id).name);
  if (!leader || leader.deleted) { n.sub = deputies.length ? `責任者 未設定 ・ 副 ${deputies.join('、')}` : '責任者 未設定'; n.hasLeader = false; return; }
  const inDept = leader.deptIds.has(n.id);
  n.sub = `責任者: ${leader.name}${leader.title ? `（${leader.title}）` : ''}${inDept ? '' : ' ・ 他部門所属'}${deputies.length ? ` ・ 副 ${deputies.join('、')}` : ''}`;
  n.hasLeader = true;
}
// 部門内の「最上位の上司」を推定: 上長が部門外/未設定のメンバーのうち、部門内の配下が最多の人
function topBossOf(deptId) {
  const members = [...MEMBERS.values()].filter(m => !m.deleted && m.deptIds.has(deptId));
  if (!members.length) return null;
  const ids = new Set(members.map(m => m.id));
  const roots = members.filter(m => !m.leaderId || !ids.has(m.leaderId));
  const descCount = (id, seen) => {
    let c = 0;
    members.forEach(m => { if (m.leaderId === id && !seen.has(m.id)) { seen.add(m.id); c += 1 + descCount(m.id, seen); } });
    return c;
  };
  const pool = roots.length ? roots : members;
  let best = null, bestC = -1;
  pool.forEach(m => { const c = descCount(m.id, new Set([m.id])); if (c > bestC) { best = m; bestC = c; } });
  return best;
}
const sig = (set) => [...set].sort().join(',');
const memChanged = (m) => !m.isNew && !m.deleted && sig(m.deptIds) !== sig(m.origDeptIds);
const memUpdated = (m) => !m.isNew && !m.deleted && ((m.title || '') !== (m.origTitle || '') || (m.leaderId || null) !== (m.origLeaderId || null));
// 主部門の変更（兼任時のみ・選択部門が実所属であること）。Lark: department_order 最大化で書き戻す
const memPrimaryChanged = (m) => !m.isNew && !m.deleted && m.deptIds.size > 1 && (m.primaryDept || null) !== (m.origPrimaryDept || null) && m.deptIds.has(m.primaryDept);
const deptNameById = (id) => NODES.find(n => n.id === id)?.deptName || '?';

function cardHTML(n) {
  const soft = softColor(n.color);
  if (n.type === 'member') {
    const m = MEMBERS.get(n.memId);
    const st = m ? (m.isNew ? 'added' : (memChanged(m) || memUpdated(m) || memPrimaryChanged(m)) ? 'changed' : '') : '';
    const srcDeptNode = NODES.find(x => x.id === n.srcDept);
    const isDeptLeader = !!(srcDeptNode && srcDeptNode.leaderId === n.memId);   // この部門の責任者のみ（兼任先では非表示）
    // 関係マーカー: 主部門 / 循環 / 部門外上長 / 兼任 / 状態 を「隠さず」明示する
    const marks = [];
    if (m && m.deptIds.size > 1 && m.primaryDept === n.srcDept) marks.push('<span class="oc-flag flag-primary" data-tip="主部門（Lark で primary に設定）">主</span>');
    if (n.cycle) marks.push('<span class="oc-flag flag-err" data-tip="上長関係が循環しています。データをご確認ください">⚠ 循環</span>');
    else if (n.extLeaderName) marks.push(`<span class="oc-flag flag-ext" data-tip="上長「${esc(n.extLeaderName)}」は別部門に所属しています（部門をまたぐ報告関係）">上長 部門外</span>`);
    if (n.multi) marks.push('<span class="oc-flag flag-multi" data-tip="複数部門に兼任。Lark の上長はテナント全体で1名のため、部門ごとの上長設定はできません">兼任</span>');
    const sf = m && m.statusFlags;
    let resigned = n.status === '退職';
    if (sf) {
      if (sf.is_resigned) { resigned = true; marks.push('<span class="oc-flag flag-err" data-tip="退職済み">退職</span>'); }
      else if (sf.is_frozen) marks.push('<span class="oc-flag flag-frozen" data-tip="アカウント凍結中">凍結</span>');
      else if (sf.is_unjoin || sf.is_exited) marks.push('<span class="oc-flag flag-multi" data-tip="未参加 / 退出">未参加</span>');
    }
    const subLine = (n.sub || marks.length)
      ? `<div class="oc-sub oc-msub">${n.sub ? `<span class="oc-subtxt">${esc(n.sub)}</span>` : ''}${marks.join('')}</div>` : '';
    const canPrimary = m && !m.isNew && m.deptIds.size > 1 && m.primaryDept !== n.srcDept;   // 兼任・非主部門のみ「主部門にする」
    return `
  <div class="oc-card oc-member ${st}" draggable="true" data-kind="member" data-id="${n.id}" data-mid="${n.memId}" data-srcdept="${n.srcDept}" style="--c:${n.color}">
    <div class="oc-avatar" style="color:${n.color};background:${soft}">${esc(n.avatarChar)}</div>
    <div class="oc-id">
      <div class="oc-name ${resigned ? 'st-r' : ''}">${esc(n.name)}${isDeptLeader ? '<span class="lead-badge">責任者</span>' : ''}</div>
      ${subLine}
    </div>
    <button class="oc-detail-btn" data-detail="${n.memId}" data-tip="社員の詳細を見る" aria-label="社員の詳細を見る"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/></svg></button>
    <span class="oc-handles">${canPrimary ? '<span class="oc-primary-handle" data-tip="この部門を主部門にする">☆</span>' : ''}<span class="oc-del-handle" data-tip="この部門から外す"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></span></span>
  </div>`;
  }
  if (n.type === 'more') {   // 「他 N 名」= 折りたたまれた一般メンバー。クリックで部門の全員リストを右パネルに開く
    return `
  <div class="oc-card oc-more" data-kind="more" data-dept="${n.deptId}" style="--c:${n.color}">
    <span class="oc-more-plus">+${n.count}</span>
    <span class="oc-more-tx">他 ${n.count} 名を表示</span>
  </div>`;
  }
  const kids = n.type === 'dept' && (n.virtual ? n.count > 0 : hasKids(n.id));
  const chevron = kids ? (EXPANDED.has(n.id) ? '▾' : '▸') : '';
  const state = n.virtual ? '' : n.isNew ? 'added' : (deptChanged(n) || deptRenamed(n) || deptLeaderChanged(n)) ? 'changed' : '';
  const childDepts = n.type === 'dept' && !n.virtual ? NODES.filter(x => x.type === 'dept' && !x.deleted && x.parentId === n.id).length : 0;
  const memCnt = n.virtual ? n.count : n.type === 'dept' ? displayDeptHeadcount(n.id) : n.count;   // カード数字＝表示中の部門全体人数（子部門含む・重複なし）
  const directCnt = n.type === 'dept' && !n.virtual ? deptDirectCount(n.id) : 0;
  const cntTip = n.virtual ? '部門未設定のメンバー' : n.type === 'dept' ? `部門全体 ${memCnt} 名（子部門含む）・ 直属 ${directCnt} 名` : '';
  return `
  <div class="oc-card ${n.type === 'root' ? 'oc-root' : ''} ${n.virtual ? 'oc-virtual' : ''} ${state} ${kids ? 'has-kids' : ''}" draggable="${n.type === 'dept' && !n.virtual}" data-kind="${n.virtual ? 'virtual' : n.type}" data-id="${n.id}" style="--c:${n.color}">
    ${n.type === 'dept' && n.virtual ? '' : n.type === 'dept' ? `<span class="oc-handles"><span class="oc-info-handle" data-detail-dept="${n.id}" data-tip="部門の詳細"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg></span><span class="oc-move-handle" data-tip="別の部門へ移動">⇄</span><span class="oc-add-handle" data-tip="配下に部門を追加">＋</span><span class="oc-del-handle" data-tip="部門を削除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></span></span>` : ''}
    ${n.type === 'root' ? '<span class="oc-handles"><span class="oc-add-handle" data-tip="部門を追加">＋</span></span>' : ''}
    <div class="oc-avatar" style="color:${n.color};background:${soft}">${esc(n.avatarChar)}</div>
    <div class="oc-id">
      <div class="oc-name">${esc(n.name)}</div>
      <div class="oc-sub ${n.hasLeader ? '' : 'muted'} ${n.type === 'dept' && !n.virtual ? 'oc-leader' : ''}" ${n.type === 'dept' && !n.virtual ? 'data-tip="クリックで責任者を設定"' : ''}>${esc(n.sub)}</div>
    </div>
    <div class="oc-count" ${n.type === 'dept' ? `data-tip="${cntTip}"` : ''}>${memCnt} 名${childDepts ? `<span class="oc-kidcnt" title="子部門">・${childDepts}部門</span>` : ''} <span class="oc-chevron"${kids ? ` data-expand="${n.id}"` : ''}>${chevron}</span></div>
  </div>`;
}
function buttonHTML(node) {
  const cnt = node.data._directSubordinates || 0;
  const expanded = node.children && node.children.length;
  return `<div class="oc-toggle">${expanded ? '折りたたむ' : '展開する'} ${cnt} 名の直属下位</div>`;
}

// ---- 接続線（表現層のみ）: 角丸エルボー ----
// 直交折れ線の内側コーナーを二次ベジェで丸める汎用レンダラ。
// 退化ケース（連続同一点・ゼロ長セグメント）は半径0にフォールバックし NaN を出さない。
const LINK_RADIUS = 14;
const R05 = (v) => Math.round(v * 2) / 2;   // 全キーポイントを 0.5px グリッドへスナップ（サブピクセルずれ防止・共有点は完全一致）
function roundedPolyline(points) {
  const P = [];
  points.forEach(p => {   // 連続重複を除去
    const last = P[P.length - 1];
    if (!last || Math.abs(p[0] - last[0]) > 0.25 || Math.abs(p[1] - last[1]) > 0.25) P.push(p);
  });
  if (!P.length) return '';
  if (P.length === 1) return `M ${R05(P[0][0])} ${R05(P[0][1])}`;
  let d = `M ${R05(P[0][0])} ${R05(P[0][1])}`;
  for (let i = 1; i < P.length - 1; i++) {
    const [x0, y0] = P[i - 1], [x1, y1] = P[i], [x2, y2] = P[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(LINK_RADIUS, l1 / 2, l2 / 2);
    if (r < 0.75) { d += ` L ${R05(x1)} ${R05(y1)}`; continue; }
    const u1x = (x1 - x0) / l1, u1y = (y1 - y0) / l1, u2x = (x2 - x1) / l2, u2y = (y2 - y1) / l2;
    d += ` L ${R05(x1 - u1x * r)} ${R05(y1 - u1y * r)} Q ${R05(x1)} ${R05(y1)} ${R05(x1 + u2x * r)} ${R05(y1 + u2y * r)}`;
  }
  d += ` L ${R05(P[P.length - 1][0])} ${R05(P[P.length - 1][1])}`;
  return d;
}
// d3-org-chart の diagonal 差し替え（top レイアウト）。
//   s: 幹側アンカー（通常=子上端 / compact=幹の基準点）, t: 親下端, m: 始点（compact=カード側面）
//   通常   : 子上端 → 上へ → 中間バス（角丸）→ 親x → 親下端
//   compact: カード側面 → 幹へ水平 → 角丸で上に曲がり幹を上昇 → 親下端（平らな貫通線を作らない）
function linkPath(s, t, m, offsets = { sy: 0 }) {
  const sy = (offsets && offsets.sy) || 0;
  const mx = (m && m.x != null) ? m.x : s.x;
  const my = (m && m.y != null) ? m.y : (s.y + sy);
  if (Math.abs(mx - s.x) > 0.5) {
    // ===== compact（2カラム）: 直交ルート =====
    // 親中心(t.x)からハブへ垂直 → ハブ(全行共有の hubY)で水平分配 → カラム幹線(s.x)を垂直降下
    // → 角丸でカード側面(m)へ。hubY は共有値(t.y と firstCompactNode.y)のみから算出するため
    // 全行のパスが完全に重なり、継ぎ目・段差・斜め線が出ない。
    const hubY = R05((t.y + s.y) / 2);            // 親下端と第1行上端の中点＝ハブ（親中心線の直下）
    const sx = R05(s.x), tx = R05(t.x), ty = R05(t.y), mmx = R05(mx), mmy = R05(my);
    const vGap = Math.max(0, mmy - hubY);          // 幹線の縦区間
    const hd1 = (sx - mmx) >= 0 ? 1 : -1;
    const r1 = Math.max(0, Math.min(LINK_RADIUS, Math.abs(sx - mmx) / 2, vGap / 2));
    let d = `M ${mmx} ${mmy}`;
    if (r1 > 0.75) d += ` L ${R05(sx - hd1 * r1)} ${mmy} Q ${sx} ${mmy} ${sx} ${R05(mmy - r1)}`;
    else d += ` L ${sx} ${mmy}`;
    if (Math.abs(tx - sx) > 0.5) {
      const hd2 = (tx - sx) >= 0 ? 1 : -1;
      const r2 = Math.max(0, Math.min(LINK_RADIUS, vGap / 2, Math.abs(tx - sx) / 2));
      const r3 = Math.max(0, Math.min(LINK_RADIUS, Math.abs(tx - sx) / 2, Math.max(0, hubY - ty) / 2));
      if (r2 > 0.75) d += ` L ${sx} ${R05(hubY + r2)} Q ${sx} ${hubY} ${R05(sx + hd2 * r2)} ${hubY}`;
      else d += ` L ${sx} ${hubY}`;
      if (r3 > 0.75) d += ` L ${R05(tx - hd2 * r3)} ${hubY} Q ${tx} ${hubY} ${tx} ${R05(hubY - r3)}`;
      else d += ` L ${tx} ${hubY}`;
      d += ` L ${tx} ${ty}`;
    } else {
      d += ` L ${sx} ${ty}`;
    }
    return d;
  }
  // ===== 通常ツリー: 親中心 → ハブ（水平分配・兄弟全員同一 y）→ 子カード上端中心へ垂直入線 =====
  // 同一親の兄弟は子上端 y が揃うため hubY は全員一致する。
  const startY = my + sy;                          // sy 分はカード内に隠れる（デフォルト実装と同じ扱い）
  const pts = [];
  if (Math.abs(t.x - s.x) > 0.5) {
    const hubY = R05((my + t.y) / 2);
    pts.push([s.x, startY], [s.x, hubY], [t.x, hubY], [t.x, t.y]);
  } else {
    pts.push([s.x, startY], [s.x, t.y]);
  }
  return roundedPolyline(pts);
}

function render() {
  recountDepts();
  if (typeof closeMemberDetail === 'function') closeMemberDetail();   // 再描画でカード位置が変わるため詳細を閉じる
  if (!chart) { chart = new OrgChart(); chart.diagonal(linkPath); }
  chart
    .container('#chart').data(buildChartData())
    .nodeWidth((d) => d.data.type === 'member' ? 210 : d.data.type === 'more' ? 180 : 250)
    .nodeHeight((d) => d.data.type === 'member' ? 58 : d.data.type === 'more' ? 46 : 92)
    .childrenMargin(() => 60).siblingsMargin(() => 24).neighbourMargin(() => 40)
    .compact(COMPACT).initialExpandLevel(99)
    .nodeContent((d) => cardHTML(d.data))
    .buttonContent(() => '')
    .render();
  if (typeof updateFocusBar === 'function') updateFocusBar();   // 集中バーを状態に同期
  requestAnimationFrame(classifyLinks);                         // 連線を関係別にスタイル分け（部門/帰属/汇报）
  setTimeout(classifyLinks, 450);                               // トランジション後にも再適用
  const startMode = SIMPLE && !FOCUS;                           // スタート画面（選んで始める）
  const sp = $('startPanel');
  if (sp) { sp.hidden = !startMode; if (startMode) renderStartPanel($('sp-search') ? $('sp-search').value : ''); }
}

// 連線を関係別に分類: 部門→部門=灰実線 / 部門→メンバー(帰属)=灰 / メンバー→メンバー(汇报)=青虚線
function classifyLinks() {
  document.querySelectorAll('#chart path.link').forEach(el => {
    const d = el.__data__; if (!d || !d.data) return;
    el.classList.remove('lk-dept', 'lk-member', 'lk-report');
    const ct = d.data.type, pt = d.parent && d.parent.data && d.parent.data.type;
    if (ct === 'member' && pt === 'member') el.classList.add('lk-report');   // 汇报（人→人）
    else if (ct === 'member' || ct === 'more') el.classList.add('lk-member'); // 帰属（部門→人）
    else el.classList.add('lk-dept');                                         // 部門階層
  });
}

// ================= ドラッグ&ドロップ =================
function attachDnD() {
  if (dndReady) return; dndReady = true;
  const root = $('chart');
  root.addEventListener('mousedown', (e) => { if (e.target.closest('.oc-card[draggable="true"]')) e.stopPropagation(); }, true);

  // カードのドラッグ開始（部門 / メンバー共通）
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.oc-card[draggable="true"]');
    if (!card) return;
    if (moveState) cancelMove();   // ドラッグを始めたら保留中のクリック移動は破棄（後続クリックでの誤確定を防止）
    dragState = card.dataset.kind === 'member'
      ? { kind: 'member', id: card.dataset.mid, srcDept: card.dataset.srcdept }
      : { kind: 'dept', id: card.dataset.id };
    card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  root.addEventListener('dragend', () => { clearDnDStyles(); hideDragHint(); });
  root.addEventListener('dragover', (e) => {
    const card = e.target.closest('.oc-card'); if (!card || !dragState) return;
    e.preventDefault(); clearDropOnly();
    const ok = dropValidCard(card);
    e.dataTransfer.dropEffect = ok ? 'move' : 'none';
    card.classList.add(ok ? 'drop-target' : 'drop-invalid');
    showDragHint(ok ? dropActionLabel(card) : ('✕ ' + dropInvalidReason(card)), ok);
  });
  root.addEventListener('drop', (e) => {
    const card = e.target.closest('.oc-card'); if (!card || !dragState) return;
    e.preventDefault();
    hideDragHint();
    if (!dropValidCard(card)) { clearDnDStyles(); return; }
    if (dragState.kind === 'member' && card.dataset.kind === 'member') applyLeaderDrop(card.dataset.mid);
    else applyDrop(card.dataset.id);
  });

  // カードのクリック
  root.addEventListener('click', (e) => {
    const leaderLine = e.target.closest('.oc-leader');
    if (leaderLine) {                                  // 「責任者: …」行 = 責任者ピッカーを開く
      if (moveState) return;                           // 移動モード中は誤操作防止のため無効
      clearTimeout(clickTimer);                        // 展開/折りたたみの保留をキャンセル
      const c = leaderLine.closest('.oc-card');
      if (c && c.dataset.kind === 'dept') { openLeaderBar(c.dataset.id); return; }
    }
    const add = e.target.closest('.oc-add-handle');
    if (add) {
      if (moveState) return;   // 移動モード中は誤操作防止のため無効
      const c = add.closest('.oc-card');
      if (c.dataset.kind === 'root') { openAddBar(ROOT_ID); return; }   // ルートは部門のみ
      openAddMenu(add, c.dataset.id);                                    // 部門カードは 部門/メンバー 選択
      return;
    }
    const info = e.target.closest('.oc-info-handle');
    if (info) {   // ⓘ = 部門の詳細を右パネルに開く
      e.stopPropagation();
      clearTimeout(clickTimer);
      showDetail('dept', info.dataset.detailDept); switchTab('detail');
      return;
    }
    const detail = e.target.closest('.oc-detail-btn');
    if (detail) {   // 人形ボタン = 社員詳細（右パネル）
      e.stopPropagation();
      clearTimeout(clickTimer);
      openMemberDetail(detail.dataset.detail);
      return;
    }
    const moreCard = e.target.closest('.oc-card[data-kind="more"]');
    if (moreCard) {   // 「他 N 名」= 部門の全員リストを右パネルに開く
      if (moveState) return;
      clearTimeout(clickTimer);
      showDetail('dept', moreCard.dataset.dept); switchTab('detail');
      return;
    }
    const del = e.target.closest('.oc-del-handle');
    if (del) {
      if (moveState) return;   // 移動モード中は誤操作防止のため無効
      const c = del.closest('.oc-card');
      if (c.dataset.kind === 'member') removeMemberFromDept(c.dataset.mid, c.dataset.srcdept); else requestDeleteDept(c.dataset.id);
      return;
    }
    const prim = e.target.closest('.oc-primary-handle');
    if (prim) {
      if (moveState) return;   // 移動モード中は無効
      const c = prim.closest('.oc-card');
      setPrimaryDept(c.dataset.mid, c.dataset.srcdept);
      return;
    }
    const handle = e.target.closest('.oc-move-handle');
    if (handle && !moveState) { startMoveDept(handle.closest('.oc-card').dataset.id); return; }
    const expandEl = e.target.closest('[data-expand]');
    if (expandEl && !moveState) { clearTimeout(clickTimer); toggleDept(expandEl.dataset.expand); return; }   // chevron = 展開/折りたたみ
    const card = e.target.closest('.oc-card[data-id]');
    if (!card) { closeMemberDetail(); return; }   // 画布の空白クリック = 選択解除
    const kind = card.dataset.kind;
    if (moveState) {                                   // 移動モード：部門クリック=異動先 ／ 人クリック=上長に設定
      if (kind === 'dept') completeMove(card.dataset.id);
      else if (kind === 'member' && moveState.kind === 'member') completeLeaderSet(card.dataset.mid);
      return;
    }
    if (kind === 'member') {   // クリック = 人員詳細パネル（ダブルクリック役職編集と競合しないよう遅延）
      clearTimeout(clickTimer);
      const mid = card.dataset.mid;
      clickTimer = setTimeout(() => { showDetail('member', mid); switchTab('detail'); }, 230);
      return;
    }
    if (kind === 'dept') {   // クリック = 展開/折りたたみ（詳細は ⓘ ボタン）。ダブルクリック改名と競合しないよう遅延
      clearTimeout(clickTimer);
      const id = card.dataset.id;
      clickTimer = setTimeout(() => toggleDept(id), 250);
    }
  });

  // ダブルクリック: 部門=改名 / メンバー=役職編集
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('.oc-leader') || moveState) return;   // 責任者行はピッカー専用 / 移動中は無効
    clearTimeout(clickTimer);   // 保留中の展開・移動モードを取り消し
    const deptCard = e.target.closest('.oc-card[data-kind="dept"]');
    if (deptCard) { startRenameDept(deptCard); return; }
    const memCard = e.target.closest('.oc-card[data-kind="member"]');
    if (memCard) startEditMemberTitle(memCard);
  });
}
let clickTimer = null;

function startRenameDept(card) {
  const id = card.dataset.id;
  const n = NODES.find(x => x.id === id); if (!n || n.type !== 'dept' || n.deleted) return;
  const nameEl = card.querySelector('.oc-name');
  if (!nameEl || nameEl.querySelector('input')) return;
  card.draggable = false;   // 編集中はドラッグ無効（再描画で元に戻る）
  const old = n.deptName;
  nameEl.innerHTML = `<input class="oc-rename-input" value="${esc(old)}">`;
  const inp = nameEl.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const val = (inp.value || '').trim();
    if (commit && val && val !== old) {
      if (NODES.some(x => x.type === 'dept' && !x.deleted && x.id !== id && x.deptName === val)) {
        showToast(`「${val}」は既に存在します`, true);
      } else {
        n.deptName = val; n.name = val; n.avatarChar = initials(val);
        if (n.isNew) n.origName = val;   // 未保存の新規部門は作成名を変えるだけ（改名opにしない）
        PLAN = null; markEdited();
        logHist('下書き編集', `部門「${old}」を「${val}」に改名`);
        showToast(n.isNew ? `新規部門の名前を「${val}」にしました`
          : val === n.origName ? `「${val}」に戻しました（変更なし）`
          : `部門名の変更（${old} → ${val}）を下書きに追加しました。`);
      }
    }
    render(); renderDiff();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('mousedown', (e) => e.stopPropagation());
  inp.addEventListener('click', (e) => e.stopPropagation());
  inp.addEventListener('dragstart', (e) => e.preventDefault());
}

// メンバーカードをダブルクリック → その場で役職を編集（役職が空でも入力可）
function startEditMemberTitle(card) {
  const memId = card.dataset.mid;
  const m = MEMBERS.get(memId); if (!m || m.deleted) return;
  const idEl = card.querySelector('.oc-id');
  if (!idEl || idEl.querySelector('input.oc-title-input')) return;
  card.draggable = false;
  const old = m.title || '';
  let sub = idEl.querySelector('.oc-sub');
  if (!sub) { sub = document.createElement('div'); sub.className = 'oc-sub oc-msub'; idEl.appendChild(sub); }
  sub.innerHTML = `<input class="oc-rename-input oc-title-input" placeholder="役職を入力" value="${esc(old)}">`;
  const inp = sub.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const val = (inp.value || '').trim();
    if (commit && val !== old) {
      m.title = val;
      if (m.isNew) m.origTitle = val;   // 未保存の新規メンバーは作成内容を変えるだけ（更新opにしない）
      PLAN = null; markEdited();
      logHist('下書き編集', `「${m.name}」の役職 → ${val || '(なし)'}`);
      showToast(`「${m.name}」の役職を「${val || 'なし'}」に変更する内容を下書きに追加しました。`);
    }
    render(); renderDiff();
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('mousedown', (e) => e.stopPropagation());
  inp.addEventListener('click', (e) => e.stopPropagation());
  inp.addEventListener('dragstart', (e) => e.preventDefault());
}

// ================= 移動モード（クリック2ステップ・遠距離対応）=================
// メンバー異動 と 部門移動 を共通化。moveState = {kind:'member'|'dept', id, srcDept?}
function startMoveMember(memId, srcDept) {
  const m = MEMBERS.get(memId); if (!m) return;
  closeAddBar(); closeLeaderBar();   // 他バーと同時表示しない
  moveState = { kind: 'member', id: memId, srcDept, concurrent: false };
  $('move-label').textContent = `「${m.name}」：`;
  $('move-top').hidden = true;
  $('move-clear').hidden = !m.leaderId;   // 上長がいる人だけ「解除」を出す
  const cc = $('move-concurrent'); cc.hidden = false; cc.classList.remove('active'); cc.setAttribute('aria-pressed', 'false');
  openMoveBar(`[data-mid="${memId}"]`, '部門名・メンバー名で検索', moveMemberHint(false));
}
// 兼任モードのヒント文（false=異動 / true=兼任追加）
function moveMemberHint(concurrent) {
  return concurrent
    ? '部門をクリック: 兼任先として追加（元の部門は残す）'
    : '部門をクリック: 異動（元の部門から移動） ／ メンバーをクリック: 上長に設定';
}
function toggleConcurrent() {
  if (!moveState || moveState.kind !== 'member') return;
  moveState.concurrent = !moveState.concurrent;
  const cc = $('move-concurrent');
  cc.classList.toggle('active', moveState.concurrent);
  cc.setAttribute('aria-pressed', String(moveState.concurrent));
  document.querySelector('.move-hint').textContent = moveMemberHint(moveState.concurrent);
}
function startMoveDept(deptId) {
  const d = NODES.find(n => n.id === deptId); if (!d || d.type !== 'dept') return;
  closeAddBar(); closeLeaderBar();   // 他バーと同時表示しない
  moveState = { kind: 'dept', id: deptId };
  $('move-label').textContent = `「${d.deptName}」を移動：`;
  $('move-top').hidden = false;    // 部門はトップ階層へも移動可
  $('move-clear').hidden = true;
  $('move-concurrent').hidden = true;   // 兼任トグルは部門移動では非表示
  openMoveBar(`[data-id="${deptId}"]`, '移動先の部門名で検索', 'または移動先の部門カードをクリック');
}
function openMoveBar(srcSel, placeholder, hint) {
  $('moveBar').hidden = false;
  $('move-search').value = ''; $('move-results').hidden = true;
  $('move-search').placeholder = placeholder || '検索…';
  document.querySelector('.move-hint').textContent = hint || '';
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
  document.querySelectorAll(`.oc-card${srcSel}`).forEach(el => el.classList.add('move-src'));
  $('move-search').focus();
}
function cancelMove() {
  moveState = null; $('moveBar').hidden = true; $('move-concurrent').hidden = true;
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
}
function moveValid(targetId) {
  if (!moveState) return false;
  if (targetId !== ROOT_ID) { const t = NODES.find(n => n.id === targetId); if (!t || t.deleted) return false; }
  if (moveState.kind === 'member') {
    if (targetId === ROOT_ID) return false;
    const m = MEMBERS.get(moveState.id);
    if (moveState.concurrent) return !!m && !m.deptIds.has(targetId);   // 兼任追加: まだ所属していない部門のみ
    return targetId !== moveState.srcDept;                             // 異動
  }
  // dept: 自分・子孫へは不可（循環）。ROOT はOK
  if (targetId === moveState.id) return false;
  if (targetId !== ROOT_ID && isDescendant(targetId, moveState.id)) return false;
  return true;
}
function completeMove(targetId) {
  if (!moveState || !moveValid(targetId)) return;
  const concurrent = moveState.kind === 'member' && moveState.concurrent;
  if (moveState.kind === 'member') {
    const m = MEMBERS.get(moveState.id);
    if (!concurrent && moveState.srcDept) m.deptIds.delete(moveState.srcDept);   // 兼任追加時は元部門を残す
    m.deptIds.add(targetId);
    const note = concurrent ? '' : leaderMoveOutNote(m, moveState.srcDept);
    if (note) showToast(note, true);
  } else {
    NODES.find(n => n.id === moveState.id).parentId = targetId;   // ROOT_ID = トップ階層
  }
  PLAN = null;
  markEdited();
  logHist('下書き編集', moveState.kind === 'member'
    ? `${MEMBERS.get(moveState.id)?.name} を ${deptNameById(targetId)} ${concurrent ? 'に兼任追加' : 'へ異動'}`
    : `部門「${NODES.find(n => n.id === moveState.id)?.deptName}」を ${parentName(targetId)} 配下へ移動`);
  if (targetId !== ROOT_ID) { EXPANDED.add(targetId); expandAncestorsOf(targetId); }  // 折りたたみ中の祖先も開いて可視化
  const center = moveState.kind === 'member' ? targetId : moveState.id;
  revealDept(center);   // 簡潔モードでは移動/異動先に集中
  cancelMove();
  render(); renderDiff();
  try { chart.setCentered(center).render(); flashCard(center); } catch (_) {}
}
function completeLeaderSet(leaderMid) {
  if (!moveState || moveState.kind !== 'member') return;
  const m = MEMBERS.get(moveState.id);
  const lead = MEMBERS.get(leaderMid);
  if (!m || !lead || lead.deleted) return;
  if (leaderMid === m.id || m.leaderId === leaderMid || leaderCycle(m.id, leaderMid)) return;
  m.leaderId = leaderMid;
  PLAN = null;
  markEdited();
  logHist('下書き編集', `${m.name} の上長を ${lead.name} に設定`);
  const srcDept = moveState.srcDept;
  cancelMove();
  render(); renderDiff();
  const did = lead.deptIds.has(srcDept) ? srcDept : ([...m.deptIds][0] || srcDept);
  try { chart.setCentered(`m|${m.id}|${did}`).render(); flashCard(`m|${m.id}|${did}`); } catch (_) {}
}
function completeLeaderClear() {
  if (!moveState || moveState.kind !== 'member') return;
  const m = MEMBERS.get(moveState.id);
  if (!m || !m.leaderId) return;
  const oldName = MEMBERS.get(m.leaderId)?.name || '?';
  m.leaderId = null;
  PLAN = null;
  markEdited();
  logHist('下書き編集', `${m.name} の上長（${oldName}）を解除`);
  const srcDept = moveState.srcDept;
  cancelMove();
  render(); renderDiff();
  const did = srcDept || [...m.deptIds][0];
  try { chart.setCentered(`m|${m.id}|${did}`).render(); flashCard(`m|${m.id}|${did}`); } catch (_) {}
  showToast(`「${m.name}」の上長（${oldName}）の解除を下書きに追加しました。`);
}
function renderMoveResults(q) {
  const box = $('move-results');
  q = (q || '').trim().toLowerCase();
  const items = [];
  if (q) {
    let res = NODES.filter(n => isDisplayDept(n) && n.deptName.toLowerCase().includes(q));
    if (moveState) res = res.filter(d => moveValid(d.id));  // 無効な移動先（自分・子孫・現所属）を除外
    res.forEach(d => items.push({ kind: 'dept', id: d.id, name: d.deptName, sub: d.path || '', badge: moveState?.kind === 'member' ? '異動' : '' }));
    if (moveState && moveState.kind === 'member') {   // 人も候補に（上長に設定）
      MEMBERS.forEach(p => {
        if (!memberInVisibleDept(p) || p.id === moveState.id) return;
        if (!(p.name || '').toLowerCase().includes(q)) return;
        if (leaderCycle(moveState.id, p.id)) return;
        items.push({ kind: 'leader', id: p.id, name: p.name, sub: [...p.deptIds].map(deptNameById).join('、'), badge: '上長に設定' });
      });
    }
  }
  const res = items.slice(0, 12);
  if (!res.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = res.map(r =>
    `<div class="sr-item" data-kind="${r.kind}" data-id="${r.id}">
       <span class="sr-icon">${r.kind === 'dept' ? '部' : '人'}</span>
       <span class="sr-body"><span class="sr-name">${esc(r.name)}</span><span class="sr-sub">${esc(r.sub)}</span></span>
       ${r.badge ? `<span class="sr-badge">${esc(r.badge)}</span>` : ''}
     </div>`).join('');
  [...box.querySelectorAll('.sr-item')].forEach(el =>
    el.onclick = () => el.dataset.kind === 'leader' ? completeLeaderSet(el.dataset.id) : completeMove(el.dataset.id));
}
$('move-search').addEventListener('input', (e) => renderMoveResults(e.target.value));
$('move-top').onclick = () => completeMove(ROOT_ID);
$('move-concurrent').onclick = toggleConcurrent;
$('move-clear').onclick = completeLeaderClear;
$('move-cancel').onclick = cancelMove;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('cfmOverlay').hidden) { closeConfirm(); return; }
  if (!$('planOverlay').hidden) { closePlanList(); return; }
  if (!$('memberOverlay').hidden) { closeMemberModal(); return; }
  if (!$('csvOverlay').hidden) { csvClose(); return; }
  if (!$('addMenu').hidden) { closeAddMenu(); return; }
  if (!$('leaderBar').hidden) { closeLeaderBar(); return; }
  if (!$('addBar').hidden) { closeAddBar(); return; }
  if (moveState) cancelMove();
});
function toggleDept(deptId) {
  if (!hasKids(deptId)) return;
  if (EXPANDED.has(deptId)) EXPANDED.delete(deptId); else EXPANDED.add(deptId);
  render();
}
// ---- 集中モード（簡潔ビュー＋部門ドリル） ----
let RECENT = (() => { try { return JSON.parse(localStorage.getItem('orgplanner_recent') || '[]'); } catch (_) { return []; } })();
function pushRecent(deptId) {
  RECENT = [deptId, ...RECENT.filter(x => x !== deptId)].slice(0, 8);
  try { localStorage.setItem('orgplanner_recent', JSON.stringify(RECENT)); } catch (_) {}
}
function setFocus(deptId) {
  const n = NODES.find(x => x.id === deptId && x.type === 'dept' && !x.deleted);
  if (!n) return;
  if (moveState) cancelMove();
  if (VIEW !== 'chart') setView('chart');
  if (FOCUS === deptId) return;   // 既に集中中
  FOCUS = deptId; pushRecent(deptId);
  render(); updateFocusBar();
  try { chart.fit(); } catch (_) {}
}
function focusUp() {
  if (!FOCUS) return;
  const n = NODES.find(x => x.id === FOCUS);
  const pid = n && n.parentId && n.parentId !== ROOT_ID ? n.parentId : null;
  if (pid) setFocus(pid); else clearFocus();   // トップ階層ならスタート画面へ
}
function clearFocus() {
  FOCUS = null;
  render(); updateFocusBar();
  try { chart.fit(); } catch (_) {}
}
// 簡潔モードで編集対象の部門を可視化する（集中を当該部門へ移す）。全体モードでは何もしない
function revealDept(deptId) { if (SIMPLE && deptId && NODES.some(n => n.id === deptId && n.type === 'dept' && !n.deleted)) setFocus(deptId); }
function toggleSimple() {
  SIMPLE = !SIMPLE;
  localStorage.setItem('orgplanner_simple', SIMPLE ? '1' : '0');
  if (!SIMPLE) FOCUS = null;
  updateSimpleLabel();
  render(); updateFocusBar();
  try { chart.fit(); } catch (_) {}
}
function updateSimpleLabel() {
  const el = $('simpleToggle'); if (el) el.textContent = SIMPLE ? '表示範囲: 全体に切替' : '表示範囲: 簡潔に切替';
  const vs = $('viewScope'); if (vs) vs.textContent = SIMPLE ? '全体表示' : '簡潔表示';
}
function deptPath(deptId) {   // ルート→対象 の {id,name} 配列
  const path = []; let cur = NODES.find(n => n.id === deptId);
  while (cur && cur.type === 'dept') { path.unshift({ id: cur.id, name: cur.deptName }); cur = NODES.find(n => n.id === cur.parentId); }
  return path;
}
function siblingsOf(deptId) {   // 同じ親を持つ部門（自分含む）
  const n = NODES.find(x => x.id === deptId); if (!n) return [];
  return NODES.filter(x => x.type === 'dept' && !x.deleted && x.parentId === n.parentId)
    .sort((a, b) => (a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity));
}
function updateFocusBar() {
  const bar = $('focusBar'); if (!bar) return;
  bar.hidden = !(SIMPLE && FOCUS);            // スタート画面ではバー非表示（パネル側で誘導）
  if (!(SIMPLE && FOCUS)) return;
  $('fb-back').hidden = false;
  // パンくず（各階層クリックで移動）
  const path = deptPath(FOCUS);
  $('fb-crumb').innerHTML = path.map((p, i) =>
    `<span class="fb-seg${i === path.length - 1 ? ' fb-cur' : ''}" data-focus="${p.id}">${esc(p.name)}</span>`
  ).join('<span class="fb-arr">›</span>');
  // 兄弟スイッチャー（同階層を1クリックで行き来）
  const sibs = siblingsOf(FOCUS);
  const sel = $('fb-siblings');
  if (sibs.length > 1) {
    sel.hidden = false;
    sel.innerHTML = sibs.map(s => `<option value="${s.id}"${s.id === FOCUS ? ' selected' : ''}>${esc(s.deptName)}</option>`).join('');
  } else { sel.hidden = true; }
}
// ---- スタート画面（簡潔モードで未選択のとき: 34枚を並べず、選んで始める） ----
function renderStartPanel(q) {
  const panel = $('startPanel'); if (!panel) return;
  const kw = (q || '').trim().toLowerCase();
  const allDepts = NODES.filter(n => n.type === 'dept' && !n.deleted);
  const memCount = (id) => { let c = 0; MEMBERS.forEach(m => { if (!m.deleted && m.deptIds.has(id)) c++; }); return c; };
  const chip = (n) => `<button class="sp-chip" data-focus="${n.id}"><span class="sp-chip-name">${esc(n.deptName)}</span><span class="sp-chip-n">${memCount(n.id)}名</span></button>`;
  const recentWrap = $('sp-recent-wrap'), topWrap = $('sp-top-wrap'), resWrap = $('sp-result-wrap');
  if (kw) {
    // 検索: 一致部門をチップで
    const hits = allDepts.filter(n => n.deptName.toLowerCase().includes(kw)).slice(0, 24);
    recentWrap.hidden = true; topWrap.hidden = true; resWrap.hidden = false;
    $('sp-result').innerHTML = hits.length ? hits.map(chip).join('') : `<div class="sp-empty">「${esc(q)}」に一致する部門はありません</div>`;
  } else {
    resWrap.hidden = true;
    // 最近見た部門
    const recent = RECENT.map(id => NODES.find(n => n.id === id && n.type === 'dept' && !n.deleted)).filter(Boolean);
    if (recent.length) { recentWrap.hidden = false; $('sp-recent').innerHTML = recent.map(chip).join(''); }
    else recentWrap.hidden = true;
    // 人数の多い部門トップ12
    const top = [...allDepts].sort((a, b) => memCount(b.id) - memCount(a.id)).slice(0, 12);
    topWrap.hidden = false; $('sp-top').innerHTML = top.map(chip).join('');
  }
}

// ================= 表示スタイル切替（組織図 / 一覧 / 部門ボード） =================
let VIEW = 'chart';           // chart | outline | board
let ALT_Q = '';               // 一覧/ボードの絞り込み文字列
const ALT_EXPANDED = new Set();
let JOB_CHAT_FILTER = localStorage.getItem('orgplanner_job_chat_filter') || '店長';
let JOB_CHAT_BUSY = false;
let JOB_CHAT_RESULT = null;
let JOB_CHAT_MODAL_OPEN = false;
let JOB_CHAT_SELECTED = null;
const byOrder = (a, b) => (a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity);
// 部門未設定（どの部門にも所属していない／参照先部門が存在しない）メンバー
function unassignedMembers() {
  const alive = (id) => NODES.some(n => n.id === id && isDisplayDept(n));
  return [...MEMBERS.values()]
    .filter(m => memberInVisibleDept(m) && ![...m.deptIds].some(alive))
    .sort((a, b) => String(a.name).localeCompare(b.name, 'ja'));
}
function deptMembers(did) {
  return [...MEMBERS.values()].filter(m => memberInVisibleDept(m) && m.deptIds.has(did))
    .sort((a, b) => ((a.deptOrders && a.deptOrders[did]) || 0) - ((b.deptOrders && b.deptOrders[did]) || 0));
}
function memberStatusShort(m) {
  const sf = m.statusFlags || {};
  if (sf.is_resigned || m.status === '退職') return { resigned: true, badge: '退職', cls: 'flag-err' };
  if (sf.is_frozen) return { badge: '凍結', cls: 'flag-frozen' };
  if (sf.is_unjoin || sf.is_exited) return { badge: '未参加', cls: 'flag-multi' };
  if (m.isNew) return { badge: '追加予定', cls: 'flag-primary' };
  return {};
}
function setView(name) {
  if (!['chart', 'outline', 'board'].includes(name)) return;
  VIEW = name;
  document.querySelectorAll('#viewSeg .vseg').forEach(b => { const on = b.dataset.view === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  const isChart = name === 'chart';
  $('chart').hidden = !isChart;
  $('altView').hidden = isChart;
  $('densitySeg').hidden = !isChart;
  $('reportToggleWrap').hidden = !(isChart && DENSITY === 'full');
  const zc = document.querySelector('.zoom-ctrl'); if (zc) zc.hidden = !isChart;
  closeMemberDetail();
  if (isChart) { $('altView').innerHTML = ''; render(); }
  else { $('focusBar').hidden = true; $('startPanel').hidden = true; renderAltView(); }
}
function renderAltView() {
  const el = $('altView');
  el.innerHTML =
    `<div class="alt-bar">
       <input id="alt-search" class="alt-search" type="text" placeholder="部門・メンバーで絞り込み…" autocomplete="off">
       <span id="alt-tools" class="alt-tools"></span>
     </div>${VIEW === 'outline' ? '<div id="job-chat-panel"></div>' : ''}<div id="alt-body" class="alt-body"></div>`;
  const s = $('alt-search'); s.value = ALT_Q;
  s.oninput = (e) => { ALT_Q = e.target.value.trim().toLowerCase(); renderAltBody(); };
  // ツールは一度だけ（一覧のみ 展開/折りたたみ）
  if (VIEW === 'outline') {
    $('alt-tools').innerHTML = `<button id="alt-expand" class="alt-btn">すべて展開</button><button id="alt-collapse" class="alt-btn">折りたたむ</button>`;
    $('alt-expand').onclick = () => { NODES.forEach(n => { if (isDisplayDept(n)) ALT_EXPANDED.add(n.id); }); renderAltBody(); };
    $('alt-collapse').onclick = () => { ALT_EXPANDED.clear(); renderAltBody(); };
  }
  renderAltBody();
}
function renderAltBody() {
  const body = $('alt-body'); if (!body) return;
  recountDepts();   // HEADCOUNT（部門人数）を最新化（一覧/ボードでもカードと同じ数字にする）
  renderJobChatPanel();
  body.innerHTML = VIEW === 'outline' ? outlineListHTML() : boardHTML();
}
function memberDeptNames(m) {
  return [...(m.deptIds || [])].map(deptNameById).filter(Boolean);
}
function jobChatMembers() {
  const q = String(JOB_CHAT_FILTER || '').trim().toLowerCase();
  if (!q) return [];
  return [...MEMBERS.values()]
    .filter(m => memberInVisibleDept(m) && !memberStatusShort(m).resigned && String(m.title || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.name).localeCompare(b.name, 'ja'));
}
function renderJobChatPanel() {
  const panel = $('job-chat-panel');
  if (!panel || VIEW !== 'outline') return;
  const result = JOB_CHAT_RESULT ? `<div class="jc-result ${JOB_CHAT_RESULT.ok ? 'ok' : 'ng'}">${esc(JOB_CHAT_RESULT.message)}</div>` : '';
  panel.innerHTML = `
    <section class="job-chat-entry">
      <div>
        <div class="jc-kicker">役職からチャットグループ作成</div>
        <div class="jc-entry-title">例: 店長・部長など、同じ役職のメンバーを Lark チャットグループに招待します。</div>
      </div>
      <button id="jobChatOpen" class="jc-open" type="button">チャットグループ作成</button>
      ${result}
    </section>`;
  const open = $('jobChatOpen');
  if (open) open.onclick = openJobChatModal;
  if (JOB_CHAT_MODAL_OPEN) renderJobChatModal();
}
function openJobChatModal() {
  JOB_CHAT_MODAL_OPEN = true;
  JOB_CHAT_RESULT = null;
  renderJobChatModal();
}
function closeJobChatModal() {
  JOB_CHAT_MODAL_OPEN = false;
  const overlay = document.querySelector('.jc-overlay');
  if (overlay) overlay.remove();
}
function renderJobChatModal() {
  let overlay = document.querySelector('.jc-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'jc-overlay';
    document.body.appendChild(overlay);
  }
  const defaultName = `${String(JOB_CHAT_FILTER || '役職').trim()}チャットグループ`;
  overlay.innerHTML = `
    <div class="jc-modal" role="dialog" aria-modal="true" aria-labelledby="jc-title">
      <div class="jc-head">
        <div>
          <div class="jc-kicker">役職からチャットグループ作成</div>
          <div id="jc-title" class="jc-title">同じ役職のメンバーを Lark チャットグループに招待</div>
        </div>
        <button id="jobChatClose" class="jc-close" type="button" aria-label="閉じる">×</button>
      </div>
      <div class="jc-controls">
        <label class="jc-field"><span>役職フィルター</span><input id="jobChatFilter" type="text" value="${esc(JOB_CHAT_FILTER)}" placeholder="例: 店長"></label>
        <label class="jc-field jc-name"><span>チャットグループ名</span><input id="jobChatName" type="text" value="${esc(defaultName)}" placeholder="チャットグループ名"></label>
      </div>
      <div id="jobChatPreview"></div>
      <div class="jc-modal-actions">
        <button id="jobChatCancel" class="jc-secondary" type="button">キャンセル</button>
        <button id="jobChatCreate" class="jc-create" type="button">チャットグループを作成</button>
      </div>
    </div>`;
  $('jobChatClose').onclick = closeJobChatModal;
  $('jobChatCancel').onclick = closeJobChatModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeJobChatModal(); };
  const input = $('jobChatFilter');
  if (input) {
    input.oncompositionstart = () => { input.dataset.composing = '1'; };
    input.oncompositionend = (e) => {
      input.dataset.composing = '';
      updateJobChatFilter(e.target.value);
    };
    input.oninput = (e) => {
      if (input.dataset.composing === '1') return;
      updateJobChatFilter(e.target.value);
    };
  }
  const nameInput = $('jobChatName');
  if (nameInput) nameInput.oninput = () => { nameInput.dataset.touched = '1'; };
  const btn = $('jobChatCreate');
  if (btn) btn.onclick = () => createJobChatGroup();
  renderJobChatPreview();
  input && input.focus();
}
function updateJobChatFilter(value) {
  JOB_CHAT_FILTER = value;
  localStorage.setItem('orgplanner_job_chat_filter', JOB_CHAT_FILTER);
  JOB_CHAT_RESULT = null;
  JOB_CHAT_SELECTED = null;
  const nameInput = $('jobChatName');
  if (nameInput && !nameInput.dataset.touched) nameInput.value = `${String(JOB_CHAT_FILTER || '役職').trim()}チャットグループ`;
  renderJobChatPreview();
}
function renderJobChatPreview() {
  const preview = $('jobChatPreview');
  if (!preview) return;
  const members = jobChatMembers();
  const withOpen = members.filter(m => m.openId);
  const missing = members.filter(m => !m.openId);
  if (!JOB_CHAT_SELECTED) JOB_CHAT_SELECTED = new Set(withOpen.map(m => m.id));
  const selected = withOpen.filter(m => JOB_CHAT_SELECTED.has(m.id));
  preview.innerHTML = `
    <div class="jc-meta">
      <span class="jc-count">${members.length}名</span>
      <span>招待可能 ${withOpen.length}名</span>
      <span>選択中 ${selected.length}名</span>
      ${missing.length ? `<span class="jc-warn">招待用IDなし ${missing.length}名は招待対象外</span>` : '<span>全員招待可能</span>'}
    </div>
    <div class="jc-list">
      ${members.map(m => `<div class="jc-member">
        <label class="jc-select"><input type="checkbox" data-select-member="${m.id}" ${m.openId && JOB_CHAT_SELECTED.has(m.id) ? 'checked' : ''} ${m.openId ? '' : 'disabled'}></label>
        <span class="jc-av">${esc(initials(m.name))}</span>
        <button class="jc-main" data-detail="${m.id}" type="button"><b>${esc(m.name)}</b><small>${esc([m.title || '役職なし', memberDeptNames(m).join('、') || '部門未設定'].join(' ・ '))}</small></button>
        ${m.openId ? '<span class="jc-ok">招待可</span>' : '<span class="jc-miss">招待不可</span>'}
      </div>`).join('')}
      ${!members.length ? '<div class="jc-empty">該当するメンバーがいません。役職名を変更してください。</div>' : ''}
    </div>
    ${JOB_CHAT_RESULT ? `<div class="jc-result ${JOB_CHAT_RESULT.ok ? 'ok' : 'ng'}">${esc(JOB_CHAT_RESULT.message)}</div>` : ''}`;
  const btn = $('jobChatCreate');
  if (btn) btn.disabled = !selected.length || JOB_CHAT_BUSY;
  preview.querySelectorAll('[data-select-member]').forEach(input => input.onchange = () => {
    if (!JOB_CHAT_SELECTED) JOB_CHAT_SELECTED = new Set();
    if (input.checked) JOB_CHAT_SELECTED.add(input.dataset.selectMember);
    else JOB_CHAT_SELECTED.delete(input.dataset.selectMember);
    renderJobChatPreview();
  });
  preview.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => showDetail('member', b.dataset.detail));
}
async function createJobChatGroup() {
  const members = jobChatMembers();
  const withOpen = members.filter(m => m.openId && (!JOB_CHAT_SELECTED || JOB_CHAT_SELECTED.has(m.id)));
  const name = ($('jobChatName') && $('jobChatName').value.trim()) || `${String(JOB_CHAT_FILTER || '役職').trim()}チャットグループ`;
  if (!withOpen.length) { showToast('招待できるメンバーがいません。'); return; }
  openConfirm({
    title: 'Lark チャットグループを作成しますか？',
    body: `<div class="cfm-lead">「${esc(name)}」を作成し、${withOpen.length}名を招待します。</div>
      <div class="cfm-meta">現在ログイン中の管理者も参加者に含まれます。</div>`,
    okLabel: '作成する',
    okClass: 'act-primary',
    onOk: () => doCreateJobChatGroup(name, withOpen)
  });
}
async function doCreateJobChatGroup(name, withOpen) {
  JOB_CHAT_BUSY = true; JOB_CHAT_RESULT = null; renderJobChatPreview();
  try {
    const r = await postJSON('/api/chatgroups/create', {
      title: name,
      memberOpenIds: withOpen.map(m => m.openId),
      members: withOpen.map(m => ({ openId: m.openId, email: m.email, name: m.name })),
      source: { filterField: 'title', filterValue: JOB_CHAT_FILTER }
    });
    if (!r.ok) throw new Error(r.error || 'チャットグループ作成に失敗しました');
    JOB_CHAT_RESULT = { ok: true, message: `作成しました: ${r.name || name}${r.chatId ? `（${r.chatId}）` : ''} / ${r.memberCount || withOpen.length}名` };
    showToast('Lark チャットグループを作成しました。');
  } catch (e) {
    JOB_CHAT_RESULT = { ok: false, message: chatGroupErrorMessage(e) };
  } finally {
    JOB_CHAT_BUSY = false;
    renderJobChatPreview();
    renderJobChatPanel();
  }
}
function chatGroupErrorMessage(e) {
  const raw = String((e && e.message) || e || '');
  if (/232025/.test(raw) || /Bot ability is not activated/i.test(raw)) {
    return '作成できませんでした: Lark アプリの Bot 機能が有効化されていません。開発者コンソールで Bot 機能を有効化し、アプリを再公開してください。（詳細: Lark 232025）';
  }
  if (/99992361/.test(raw) || /open_id cross app/i.test(raw)) {
    return '作成できませんでした: メンバーIDをこのアプリ用に変換できませんでした。メールアドレスと Contact 権限を確認してください。（詳細: Lark 99992361）';
  }
  return `作成できませんでした: ${raw}`;
}
// ---- 一覧（アウトライン）: カラーアバター＋責任者チップ＋人数バッジ＋階層ガイド線 ----
const CHEV_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
function outlineListHTML() {
  const q = ALT_Q;
  const roots = NODES.filter(n => isDisplayDept(n) && (!n.parentId || n.parentId === ROOT_ID)).sort(byOrder);
  const html = roots.map(d => outlineDept(d)).filter(Boolean).join('');
  // 部門未設定（無所属）メンバーを末尾グループとして明示
  const orphans = unassignedMembers().filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q));
  const orphanHtml = orphans.length ? `<div class="olx-node olx-orphan">
      <div class="olx-drow">
        <span class="olx-chev olx-chev-empty"></span>
        <span class="olx-av olx-av-d" style="color:var(--warning);background:var(--warning-bg)">未</span>
        <span class="olx-dname">部門未設定</span>
        <span class="olx-leader">どの部門にも所属していません</span>
        <span class="olx-spacer"></span>
        <span class="olx-count">${orphans.length}<span class="olx-count-u">名</span></span>
      </div>
      <div class="olx-children">${orphans.map(m => {
        const st = memberStatusShort(m);
        return `<div class="olx-mrow" data-detail="${m.id}">
          <span class="olx-av olx-av-m" style="color:var(--warning);background:var(--warning-bg)">${esc(initials(m.name))}</span>
          <span class="olx-mname ${st.resigned ? 'st-r' : ''}">${esc(m.name)}</span>
          ${m.title ? `<span class="olx-title">${esc(m.title)}</span>` : ''}
          <span class="olx-spacer"></span>${st.badge ? `<span class="oc-flag ${st.cls}">${st.badge}</span>` : ''}
        </div>`;
      }).join('')}</div></div>` : '';
  return `<div class="olx-list">${html || (orphanHtml ? '' : '<div class="ol-empty">該当する部門・メンバーがありません</div>')}${orphanHtml}</div>`;
}
function outlineDept(d) {
  const q = ALT_Q;
  const members = deptMembers(d.id);
  const childDepts = NODES.filter(n => isDisplayDept(n) && n.parentId === d.id).sort(byOrder);
  const selfMatch = !q || d.deptName.toLowerCase().includes(q);
  const memMatch = members.filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q));
  const childHtml = childDepts.map(c => outlineDept(c)).filter(Boolean);
  if (q && !selfMatch && !memMatch.length && !childHtml.length) return '';
  const hasKids = members.length || childDepts.length;
  const expanded = q ? true : ALT_EXPANDED.has(d.id);
  const leader = d.leaderId ? (MEMBERS.get(d.leaderId) || {}).name : null;
  const soft = softColor(d.color);
  const shown = q ? memMatch : members;
  const children = expanded && hasKids
    ? `<div class="olx-children">${shown.map(m => memberOutlineRow(m, d)).join('')}${childHtml.join('')}</div>`
    : '';
  return `<div class="olx-node">
    <div class="olx-drow">
      ${hasKids
        ? `<button class="olx-chev${expanded ? ' open' : ''}" data-toggle="${d.id}" aria-label="開閉">${CHEV_SVG}</button>`
        : '<span class="olx-chev olx-chev-empty"></span>'}
      <span class="olx-av olx-av-d" style="color:${d.color};background:${soft}">${esc(initials(d.deptName))}</span>
      <span class="olx-dname" data-jump="${d.id}">${esc(d.deptName)}</span>
      ${leader ? `<span class="olx-leader"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>${esc(leader)}</span>` : ''}
      <span class="olx-spacer"></span>
      ${childDepts.length ? `<span class="olx-subcount">部門 ${childDepts.length}</span>` : ''}
      <span class="olx-count">${displayDeptHeadcount(d.id)}<span class="olx-count-u">名</span></span>
    </div>${children}</div>`;
}
function memberOutlineRow(m, dept) {
  const st = memberStatusShort(m);
  const soft = softColor(dept.color);
  const isLeader = dept.leaderId === m.id;
  const badges =
    (isLeader ? '<span class="olx-badge olx-badge-lead">責任者</span>' : '') +
    (st.badge ? `<span class="oc-flag ${st.cls}">${st.badge}</span>` : '');
  return `<div class="olx-mrow" data-detail="${m.id}">
    <span class="olx-av olx-av-m" style="color:${dept.color};background:${soft}">${esc(initials(m.name))}</span>
    <span class="olx-mname ${st.resigned ? 'st-r' : ''}">${esc(m.name)}</span>
    ${m.title ? `<span class="olx-title">${esc(m.title)}</span>` : ''}
    <span class="olx-spacer"></span>
    ${badges}
  </div>`;
}
// ---- 部門ボード（カードのグリッド）----
function boardHTML() {
  const q = ALT_Q;
  const cards = NODES.filter(isDisplayDept)
    .map(d => ({ d, members: deptMembers(d.id), head: displayDeptHeadcount(d.id), subs: NODES.filter(n => isDisplayDept(n) && n.parentId === d.id).sort(byOrder) }))
    .filter(x => x.head > 0)   // 配下（子部門含む）に人がいる部門はすべて表示（親部門も欠落させない）
    .filter(x => !q || x.d.deptName.toLowerCase().includes(q) || x.members.some(m => (m.name || '').toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q)) || x.subs.some(s => s.deptName.toLowerCase().includes(q)))
    .sort((a, b) => b.head - a.head)
    .map(({ d, members, head, subs }) => {
      const leader = d.leaderId ? (MEMBERS.get(d.leaderId) || {}).name : null;
      // 子部門チップ（クリックでその部門にドリル）
      const subChips = subs.map(s => `<button class="bd-subchip" data-detail-dept="${s.id}"><span class="bd-subav" style="color:${s.color};background:${softColor(s.color)}">${esc(initials(s.deptName))}</span><span class="bd-subname">${esc(s.deptName)}</span><span class="bd-subn">${displayDeptHeadcount(s.id)}名</span></button>`).join('');
      const subSection = subs.length ? `<div class="bd-sec-h">子部門 ${subs.length}</div><div class="bd-subdepts">${subChips}</div>` : '';
      // 直属メンバーチップ
      const chips = members.map(m => {
        const st = memberStatusShort(m);
        return `<button class="bd-chip${st.resigned ? ' bd-resigned' : ''}" data-detail="${m.id}"><span class="bd-av" style="color:${d.color}">${esc(initials(m.name))}</span><span class="bd-cname">${esc(m.name)}</span></button>`;
      }).join('');
      const memSection = members.length ? `${subs.length ? '<div class="bd-sec-h">直属メンバー</div>' : ''}<div class="bd-members">${chips}</div>`
        : (subs.length ? '' : '<div class="bd-empty">メンバーがいません</div>');
      const sub = `${leader ? `責任者 ${esc(leader)} ・ ` : ''}全体 ${head} 名${members.length !== head ? ` ・ 直属 ${members.length}` : ''}`;
      return `<div class="bd-card" style="--c:${d.color}">
        <div class="bd-head" data-jump="${d.id}"><div class="bd-name">${esc(d.deptName)}</div><div class="bd-sub">${esc(sub)}</div></div>
        <div class="bd-body">${subSection}${memSection}</div></div>`;
    }).join('');
  // 部門未設定（無所属）メンバー: 見落とすと迷子になるため必ず末尾に出す
  const orphans = unassignedMembers().filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q));
  const orphanCard = orphans.length ? `<div class="bd-card bd-card-warn" style="--c:var(--warning)">
      <div class="bd-head" data-orphans="1"><div class="bd-name">部門未設定</div><div class="bd-sub">どの部門にも所属していません ・ ${orphans.length} 名</div></div>
      <div class="bd-body"><div class="bd-members">${orphans.map(m => {
        const st = memberStatusShort(m);
        return `<button class="bd-chip${st.resigned ? ' bd-resigned' : ''}" data-detail="${m.id}"><span class="bd-av" style="color:var(--warning);background:var(--warning-bg)">${esc(initials(m.name))}</span><span class="bd-cname">${esc(m.name)}</span></button>`;
      }).join('')}</div></div></div>` : '';
  return `<div class="bd-grid">${cards || (orphanCard ? '' : '<div class="ol-empty">該当する部門がありません（絞り込み条件をご確認ください）</div>')}${orphanCard}</div>`;
}
// ビュー切替タブ + 一覧/ボード内のクリック委譲（部門=組織図へジャンプ / メンバー=詳細 / ▸=展開）
document.querySelectorAll('#viewSeg .vseg').forEach(b => b.onclick = () => setView(b.dataset.view));
$('altView').addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) { const id = t.dataset.toggle; if (ALT_EXPANDED.has(id)) ALT_EXPANDED.delete(id); else ALT_EXPANDED.add(id); renderAltBody(); return; }
  const sd = e.target.closest('[data-detail-dept]');
  if (sd) { showDetail('dept', sd.dataset.detailDept); switchTab('detail'); return; }   // 子部門チップ = その部門の詳細へ
  const j = e.target.closest('[data-jump]');
  if (j) { locateDept(j.dataset.jump); showDetail('dept', j.dataset.jump); return; }   // 組織図へ＝祖先を展開して定位（集中モードには入らない）
  const d = e.target.closest('[data-detail]');
  if (d) { openMemberDetail(d.dataset.detail, d); return; }
});

// ================= 画面上の部門追加（＋ハンドル → 名前入力バー） =================
let addParent = null;   // 追加先の親部門 id（ROOT_ID = トップ階層）
function openAddBar(parentId) {
  if (moveState) return;
  closeLeaderBar();
  addParent = parentId;
  $('add-label').textContent = `「${parentId === ROOT_ID ? 'トップ階層' : deptNameById(parentId)}」配下に部門を追加：`;
  $('addBar').hidden = false;
  $('add-name').value = '';
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
  const card = document.querySelector(`.oc-card[data-id="${parentId === ROOT_ID ? ROOT_ID : parentId}"]`);
  if (card) card.classList.add('move-src');
  $('add-name').focus();
}
function closeAddBar() {
  addParent = null; $('addBar').hidden = true;
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
}
function confirmAdd() {
  if (addParent == null) return;
  const name = $('add-name').value.trim();
  if (!name) { showToast('部門名を入力してください', true); $('add-name').focus(); return; }
  if (NODES.some(n => n.type === 'dept' && !n.deleted && n.deptName === name)) { showToast(`「${name}」は既に存在します`, true); return; }
  const pid = addParent;
  const parent = NODES.find(n => n.id === pid);
  const id = `new|${NEWSEQ++}`;
  NODES.push({
    id, parentId: pid, type: 'dept', deptName: name, name, origName: name, isNew: true, deleted: false,
    sub: '責任者 未設定', hasLeader: false, avatarChar: initials(name), openId: '', path: '',
    count: 0, baseCount: 0, color: parent && parent.type === 'dept' ? parent.color : PALETTE[NODES.length % PALETTE.length]
  });
  if (pid !== ROOT_ID) EXPANDED.add(pid);
  expandAncestorsOf(id);
  closeAddBar();
  PLAN = null; markEdited();
  logHist('下書き編集', `新規部門「${name}」を ${parentName(pid)} 配下に追加`);
  render(); renderDiff();
  try { chart.setCentered(id).render(); flashCard(id); } catch (_) {}
  showToast(`部門「${name}」の追加を下書きに追加しました。`);
}
$('add-ok').onclick = confirmAdd;
$('add-cancel').onclick = closeAddBar;
$('add-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmAdd(); });

// ---- ＋ハンドルのミニメニュー（部門 / メンバー）: ハンドル位置から固定配置（SVG にクリップされない）----
let addMenuDept = null;
function openAddMenu(anchorEl, deptId) {
  cancelMove(); closeAddBar(); closeLeaderBar();
  addMenuDept = deptId;
  const menu = $('addMenu');
  menu.hidden = false;
  const r = anchorEl.getBoundingClientRect(), mw = 200;
  menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))) + 'px';
  menu.style.top = Math.round(r.bottom + 4) + 'px';
}
function closeAddMenu() { $('addMenu').hidden = true; addMenuDept = null; }
$('addmenu-dept').onclick = () => { const d = addMenuDept; closeAddMenu(); openAddBar(d); };
$('addmenu-member').onclick = () => { const d = addMenuDept; closeAddMenu(); openMemberModal(d); };
document.addEventListener('click', (e) => { if (!$('addMenu').hidden && !e.target.closest('#addMenu') && !e.target.closest('.oc-add-handle')) closeAddMenu(); });

// ================= 画面からメンバー追加（モーダル） =================
let memberDept = null;   // 追加先部門 id
// 雇用形態(employee_type)enum をテナントから一度だけ取得してキャッシュ（移植性）
let EMP_TYPES = null;
async function loadEmpTypes() {
  if (EMP_TYPES) return EMP_TYPES;
  try { const r = await (await fetch('/api/employee-types')).json(); EMP_TYPES = (r.items && r.items.length) ? r.items : [{ value: '1', name: '正社員' }]; }
  catch (_) { EMP_TYPES = [{ value: '1', name: '正社員' }]; }
  const sel = $('mm-emptype');
  if (sel) sel.innerHTML = EMP_TYPES.map(t => `<option value="${esc(t.value)}">${esc(t.name)}</option>`).join('');
  return EMP_TYPES;
}
function openMemberModal(deptId) {
  const n = NODES.find(x => x.id === deptId); if (!n || n.type !== 'dept' || n.deleted) return;
  cancelMove(); closeAddBar(); closeLeaderBar();
  memberDept = deptId;
  $('mm-dept').textContent = `追加先: ${n.deptName}`;
  ['mm-name', 'mm-email', 'mm-mobile', 'mm-title'].forEach(id => $(id).value = '');
  loadEmpTypes().then(() => { const s = $('mm-emptype'); if (s) s.value = '1'; });   // 既定=正社員(1)
  $('mm-err').hidden = true;
  $('memberOverlay').hidden = false;
  $('mm-name').focus();
}
function closeMemberModal() { $('memberOverlay').hidden = true; memberDept = null; }
function submitMember() {
  const name = $('mm-name').value.trim();
  const email = $('mm-email').value.trim();
  const mobile = $('mm-mobile').value.trim();
  const title = $('mm-title').value.trim();
  const fail = (msg) => { const el = $('mm-err'); el.hidden = false; el.textContent = msg; };
  if (!name) return fail('氏名を入力してください');
  if (!email) return fail('メールアドレスを入力してください（招待の送付先）');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('メールアドレスの形式が正しくありません');
  if (!mobile) return fail('携帯番号を入力してください（Lark アカウントの識別子）');
  const dup = [...MEMBERS.values()].some(m => !m.deleted && (m.email || '').toLowerCase() === email.toLowerCase());
  if (dup) return fail(`メール「${email}」は既に使われています`);
  const id = `newm|${NEWMSEQ++}`;
  const did = memberDept;
  const empType = ($('mm-emptype') && $('mm-emptype').value) || '1';
  MEMBERS.set(id, {
    id, name, openId: '', title, email, empNo: '', status: '', mobile, employeeType: empType,
    leaderId: null, origLeaderId: null, origTitle: '',
    isNew: true, deleted: false, deptIds: new Set([did]), origDeptIds: new Set()
  });
  EXPANDED.add(did); expandAncestorsOf(did);
  PLAN = null; markEdited();
  logHist('下書き編集', `新規メンバー「${name}」を ${deptNameById(did)} に追加`);
  closeMemberModal();
  revealDept(did);   // 簡潔モードでは追加先部門に集中して新メンバーを可視化
  render(); renderDiff();
  try { chart.setCentered(`m|${id}|${did}`).render(); flashCard(`m|${id}|${did}`); } catch (_) {}
  showToast(`メンバー「${name}」の追加を下書きに追加しました。`);
}
$('mm-ok').onclick = submitMember;
$('mm-cancel').onclick = closeMemberModal;
$('memberOverlay').addEventListener('click', (e) => { if (e.target.id === 'memberOverlay') closeMemberModal(); });
['mm-name', 'mm-email', 'mm-mobile', 'mm-title'].forEach(id => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitMember(); }));

// ================= 責任者ピッカー（部門カードの「責任者」行クリック） =================
let leaderTarget = null;   // 設定対象の部門 id
function openLeaderBar(deptId) {
  const n = NODES.find(x => x.id === deptId);
  if (!n || n.type !== 'dept' || n.deleted) return;
  cancelMove(); closeAddBar();               // 他のコマンドバーと同時表示しない
  leaderTarget = deptId;
  $('leader-label').textContent = `「${n.deptName}」の責任者（主・副）：`;
  $('leader-clear').hidden = !(n.leaderId || (n.deputyIds && n.deputyIds.size));
  $('leaderBar').hidden = false;
  $('leader-search').value = '';
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
  const card = document.querySelector(`.oc-card[data-id="${deptId}"]`);
  if (card) card.classList.add('move-src');
  renderLeaderResults('');
  $('leader-search').focus();
}
function closeLeaderBar() {
  leaderTarget = null; $('leaderBar').hidden = true;
  $('leader-results').hidden = true; $('leader-results').innerHTML = '';
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
}
function renderLeaderResults(q) {
  const box = $('leader-results');
  if (!leaderTarget) { box.hidden = true; return; }
  const n = NODES.find(x => x.id === leaderTarget); if (!n) { box.hidden = true; return; }
  q = (q || '').trim().toLowerCase();
  // 部門メンバー + 現在の主・副（部門外でも外せるよう必ず含める）
  const extra = new Set([n.leaderId, ...(n.deputyIds || [])].filter(Boolean));
  const members = [...MEMBERS.values()].filter(m => !m.deleted && (m.deptIds.has(leaderTarget) || extra.has(m.id)));
  if (!members.length) {
    box.hidden = false;
    box.innerHTML = `<div class="sr-empty">同期済みのメンバーがいません。先にメンバーを異動してから設定してください。</div>`;
    return;
  }
  const boss = topBossOf(leaderTarget);
  const dep = n.deputyIds || new Set();
  let list = members.filter(m => !q || (m.name || '').toLowerCase().includes(q));
  // 並び: 主 → 副 → 推奨（最上位の上司）→ 名前順
  list.sort((a, b) => {
    const w = (m) => (m.id === n.leaderId ? 0 : dep.has(m.id) ? 1 : boss && m.id === boss.id ? 2 : 3);
    return w(a) - w(b) || String(a.name).localeCompare(b.name, 'ja');
  });
  list = list.slice(0, 12);
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = list.map(m => {
    const isMain = m.id === n.leaderId, isDep = dep.has(m.id);
    const roleBadge = isMain ? '<span class="sr-badge sr-badge-now">主責任者</span>'
      : isDep ? '<span class="sr-badge sr-badge-dep">副責任者</span>'
      : (boss && m.id === boss.id ? '<span class="sr-badge">推奨</span>' : '');
    const actions = isMain ? ''
      : `<button class="lb-btn" data-act="main" data-id="${m.id}">主にする</button>`
        + (isDep
          ? `<button class="lb-btn lb-btn-off" data-act="dep" data-id="${m.id}">副を外す</button>`
          : `<button class="lb-btn" data-act="dep" data-id="${m.id}"${n.leaderId ? '' : ' disabled title="先に主責任者を設定してください"'}>副に追加</button>`);
    const up = m.leaderId && MEMBERS.get(m.leaderId) ? `上長: ${MEMBERS.get(m.leaderId).name}` : '上長なし';
    return `<div class="sr-item" data-id="${m.id}">
       <span class="sr-icon">人</span>
       <span class="sr-body"><span class="sr-name">${esc(m.name)}</span><span class="sr-sub">${esc([m.title, up].filter(Boolean).join(' ・ '))}</span></span>
       <span class="lb-role">${roleBadge}${actions}</span>
     </div>`;
  }).join('');
  [...box.querySelectorAll('.lb-btn')].forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    if (el.disabled) return;
    if (el.dataset.act === 'main') setMainLeader(el.dataset.id);
    else toggleDeputy(el.dataset.id);
  });
}
// 責任者編集の共通後処理（ピッカーは開いたまま最新化）
function applyLeaderEdit(n, logMsg, toastMsg) {
  updateDeptSub(n);
  PLAN = null; markEdited();
  logHist('下書き編集', `${n.deptName}: ${logMsg}`);
  render(); renderDiff();
  refreshLeaderBar();
  if (toastMsg) showToast(toastMsg);
}
function refreshLeaderBar() {
  const n = NODES.find(x => x.id === leaderTarget); if (!n) return;
  $('leader-clear').hidden = !(n.leaderId || (n.deputyIds && n.deputyIds.size));
  document.querySelectorAll('.oc-card.move-src').forEach(el => el.classList.remove('move-src'));
  const card = document.querySelector(`.oc-card[data-id="${leaderTarget}"]`);
  if (card) card.classList.add('move-src');
  renderLeaderResults($('leader-search').value);
}
function setMainLeader(memId) {
  const n = NODES.find(x => x.id === leaderTarget); const m = MEMBERS.get(memId);
  if (!n || !m || m.deleted || n.leaderId === memId) return;
  if (n.deputyIds) n.deputyIds.delete(memId);   // 主に昇格したら副からは外す（重複不可）
  n.leaderId = memId;
  applyLeaderEdit(n, `主責任者 → ${m.name}`, `「${n.deptName}」の主責任者を「${m.name}」に設定する変更を下書きに追加しました。`);
}
function toggleDeputy(memId) {
  const n = NODES.find(x => x.id === leaderTarget); const m = MEMBERS.get(memId);
  if (!n || !m || m.deleted) return;
  if (n.leaderId === memId) { showToast('主責任者は副に追加できません。', true); return; }
  if (!n.deputyIds) n.deputyIds = new Set();
  if (n.deputyIds.has(memId)) {
    n.deputyIds.delete(memId);
    applyLeaderEdit(n, `副責任者から外す: ${m.name}`, `「${m.name}」を副責任者から外す変更を下書きに追加しました。`);
  } else {
    if (!n.leaderId) { showToast('先に主責任者を設定してください。', true); return; }
    n.deputyIds.add(memId);
    applyLeaderEdit(n, `副責任者に追加: ${m.name}`, `「${m.name}」を副責任者に追加する変更を下書きに追加しました。`);
  }
}
function clearLeader() {
  const n = NODES.find(x => x.id === leaderTarget);
  if (!n) { closeLeaderBar(); return; }
  const depCount = n.deputyIds ? n.deputyIds.size : 0;
  const unmapped = (n.origLeaders || []).filter(l => l.type === 2 && (!l.id || !MEMBERS.get(l.id))).length;
  const totalDep = depCount + unmapped;
  if (!n.leaderId && !totalDep) { closeLeaderBar(); return; }
  const doClear = () => {
    n.leaderId = null; n.deputyIds = new Set();
    updateDeptSub(n); PLAN = null; closeLeaderBar();
    markEdited(); logHist('下書き編集', `${n.deptName} の責任者（主・副）を全解除`);
    render(); renderDiff();
    showToast(`「${n.deptName}」の責任者（主・副）を解除する変更を下書きに追加しました。`);
  };
  // Lark 制約: 主なしで副のみは保持不可 → 副がいれば「一緒に解除される」ことを明示（silent 破壊の防止）
  if (totalDep) {
    openConfirm({
      title: '責任者を解除しますか？',
      body: `<div class="act-note act-warn">Lark では主責任者なしで副責任者だけを残すことはできません。解除すると<b>副責任者（${totalDep}名）も一緒に解除</b>されます。</div>`,
      okLabel: '主・副とも解除', okClass: 'act-danger', onOk: doClear
    });
  } else doClear();
}
$('leader-search').addEventListener('input', (e) => renderLeaderResults(e.target.value));
$('leader-clear').onclick = clearLeader;
$('leader-cancel').onclick = closeLeaderBar;

// ================= 画面上の削除（草稿マーク → 変更明細から取消可） =================
let toastTimer = null;
function showToast(msg, isErr) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function flashInvalid(cardId) {
  const card = document.querySelector(`.oc-card[data-id="${cardId}"]`);
  if (card) { card.classList.add('drop-invalid'); setTimeout(() => card.classList.remove('drop-invalid'), 900); }
}
function requestDeleteDept(deptId) {
  const n = NODES.find(x => x.id === deptId);
  if (!n || n.type !== 'dept' || n.deleted) return;
  if (NODES.some(x => x.type === 'dept' && !x.deleted && x.parentId === deptId)) {
    showToast('子部門があるため削除できません（先に移動または削除してください）', true); flashInvalid(deptId); return;
  }
  let mc = 0; MEMBERS.forEach(m => { if (!m.deleted && m.deptIds.has(deptId)) mc++; });
  if (mc > 0) { showToast(`${mc} 名のメンバーが所属しているため削除できません（先に異動してください）`, true); flashInvalid(deptId); return; }
  const name = n.deptName;
  if (n.isNew) NODES = NODES.filter(x => x.id !== deptId);   // 草稿追加はその場で取り消し
  else n.deleted = true;
  PLAN = null; markEdited();
  logHist('下書き編集', n.isNew ? `新規部門「${name}」を取り消し` : `部門「${name}」を削除予定に`);
  render(); renderDiff();
  showToast(n.isNew ? `「${name}」（未保存の新規部門）を取り消しました` : `部門「${name}」の削除を下書きに追加しました（変更内容から取り消せます）。`);
}
// メンバーの 🗑 = この部門から外す（全社からの退職ではない。退職は CSV で処理）
function removeMemberFromDept(memId, deptId) {
  const m = MEMBERS.get(memId); if (!m || m.deleted) return;
  const dname = deptNameById(deptId);
  if (m.deptIds.size <= 1) {
    // 唯一の所属を外すと無所属になる → 新規メンバーは追加取消、既存はブロック
    if (m.isNew) {
      MEMBERS.delete(memId);
      NODES.forEach(n => { if (n.type === 'dept' && n.leaderId === memId) updateDeptSub(n); });
      PLAN = null; markEdited();
      logHist('下書き編集', `新規メンバー「${m.name}」を取り消し`);
      render(); renderDiff();
      showToast(`「${m.name}」（未保存の新規メンバー）を取り消しました`);
      return;
    }
    showToast(`「${m.name}」の所属はこの部門だけです。別の部門へ異動するか、退職は CSV で処理してください。`, true);
    flashInvalid(`m|${memId}|${deptId}`);
    return;
  }
  m.deptIds.delete(deptId);
  const dept = NODES.find(n => n.id === deptId);
  let extra = '';
  if (dept && dept.leaderId === memId) { dept.leaderId = null; updateDeptSub(dept); extra = '（責任者も解除）'; }
  PLAN = null; markEdited();
  logHist('下書き編集', `「${m.name}」を「${dname}」から外す${extra}`);
  render(); renderDiff();
  showToast(`「${m.name}」を「${dname}」から外す変更を下書きに追加しました${extra}。`);
}
// メンバーの ☆ = この部門を主部門にする（Lark: 兼任先のうち department_order 最大が主部門。書き戻しでライブ orders をマージ）
function setPrimaryDept(memId, deptId) {
  const m = MEMBERS.get(memId); if (!m || m.deleted) return;
  if (m.isNew) { showToast('新規メンバーの主部門は、追加を反映した後に設定してください。', true); return; }
  if (m.deptIds.size <= 1) { showToast('主部門は「兼任（複数部門所属）」のメンバーにのみ設定できます。', true); return; }
  if (!m.deptIds.has(deptId) || m.primaryDept === deptId) return;
  const dname = deptNameById(deptId);
  m.primaryDept = deptId;
  PLAN = null; markEdited();
  logHist('下書き編集', `「${m.name}」の主部門を「${dname}」に変更`);
  render(); renderDiff();
  showToast(`「${m.name}」の主部門を「${dname}」に設定する変更を下書きに追加しました。`);
}
// ---- 社員詳細ポップオーバー（人形ボタン → 従業員の詳細情報） ----
// メンバー詳細は右パネルに一本化（浮层は廃止）。全ビューの人員クリック/人形ボタンから呼ばれる
function openMemberDetail(memId) { if (MEMBERS.get(memId)) showDetail('member', memId); }
function _openMemberDetail_unused(memId, anchorEl) {
  const m = MEMBERS.get(memId); if (!m) return;
  const pop = $('memberDetail'); if (!pop) return;
  const sf = m.statusFlags || {};
  let status = '在職', statusCls = 'md-st-ok';
  if (sf.is_resigned || m.status === '退職') { status = '退職'; statusCls = 'md-st-err'; }
  else if (sf.is_frozen) { status = '凍結'; statusCls = 'md-st-warn'; }
  else if (sf.is_unjoin || sf.is_exited) { status = '未参加'; statusCls = 'md-st-warn'; }
  else if (m.isNew) { status = '追加予定（未反映）'; statusCls = 'md-st-warn'; }
  const empName = (EMP_TYPES && (EMP_TYPES.find(t => t.value === String(m.employeeType)) || {}).name) || (m.employeeType ? `区分 ${m.employeeType}` : '—');
  const depts = [...m.deptIds].map(id => ({ name: deptNameById(id), primary: m.primaryDept === id && m.deptIds.size > 1 }));
  const deptHtml = depts.length ? depts.map(d => `${esc(d.name)}${d.primary ? ' <span class="md-badge">主部門</span>' : ''}`).join('、') : '—';
  const leader = m.leaderId ? MEMBERS.get(m.leaderId) : null;
  const leads = NODES.filter(n => n.type === 'dept' && !n.deleted && n.leaderId === memId).map(n => n.deptName);
  const deputyOf = NODES.filter(n => n.type === 'dept' && !n.deleted && n.deputyIds && n.deputyIds.has(memId)).map(n => n.deptName);
  const rows = [
    ['役職', esc(m.title || '—')],
    ['雇用形態', esc(empName)],
    ['在籍ステータス', `<span class="md-st ${statusCls}">${status}</span>`],
    ['所属部門', deptHtml],
    ['上長', leader ? esc(leader.name) : '—'],
  ];
  if (leads.length) rows.push(['部門責任者', leads.map(esc).join('、')]);
  if (deputyOf.length) rows.push(['副責任者', deputyOf.map(esc).join('、')]);
  if (m.email) rows.push(['メール', esc(m.email)]);
  if (m.mobile) rows.push(['携帯番号', esc(m.mobile)]);
  pop.innerHTML =
    `<div class="md-head" style="--c:${anchorColor(memId)}">
       <div class="md-avatar">${esc(initials(m.name))}</div>
       <div class="md-idwrap"><div class="md-name">${esc(m.name)}</div><div class="md-sub">${esc(m.title || '社員')}</div></div>
       <button class="md-close" aria-label="閉じる">✕</button>
     </div>
     <div class="md-body">${rows.map(([k, v]) => `<div class="md-row"><span class="md-k">${k}</span><span class="md-v">${v}</span></div>`).join('')}</div>`;
  pop.hidden = false;
  // 固定配置: アンカーの右→入らなければ左、画面外補正
  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right + 8; if (left + pw > window.innerWidth - 8) left = r.left - pw - 8; if (left < 8) left = 8;
  let top = r.top - 4; if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8; if (top < 8) top = 8;
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.querySelector('.md-close').onclick = closeMemberDetail;
}
function anchorColor(memId) {   // カードの帯色に合わせる（見つからなければ主色）
  const card = document.querySelector(`.oc-card[data-mid="${memId}"]`);
  return (card && card.style.getPropertyValue('--c')) || '#2563EB';
}
function closeMemberDetail() { const p = $('memberDetail'); if (p) p.hidden = true; }
document.addEventListener('click', (e) => {
  if (e.target.closest('#memberDetail') || e.target.closest('[data-detail]')) return;   // 詳細を開くボタン/行のクリックでは閉じない
  closeMemberDetail();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMemberDetail(); });
function undoDelete(kind, id) {
  if (kind === 'dept') { const n = NODES.find(x => x.id === id); if (n) n.deleted = false; }
  else { const m = MEMBERS.get(id); if (m) { m.deleted = false; NODES.forEach(n => { if (n.type === 'dept' && n.leaderId === id) updateDeptSub(n); }); } }
  PLAN = null; render(); renderDiff();
}
// ---- ドラッグ中のガイダンス（可 / 不可の理由を表示） ----
function showDragHint(msg, ok) { const h = $('dragHint'); h.hidden = false; h.textContent = msg; h.classList.toggle('ng', !ok); }
function hideDragHint() { $('dragHint').hidden = true; }
function dropActionLabel(card) {
  if (dragState.kind === 'dept') return `ここへ移動（下書きに追加されます）`;
  if (card.dataset.kind === 'member') return `「${MEMBERS.get(card.dataset.mid)?.name || ''}」の配下に（上長に設定）`;
  if (card.dataset.id === dragState.srcDept) return `部門直下へ（上長を解除）`;
  return `この部門へ異動（下書きに追加されます）`;
}
function dropInvalidReason(card) {
  const kind = card.dataset.kind;
  if (dragState.kind === 'dept') {
    if (kind === 'member') return '部門は人の上に置けません';
    if (card.dataset.id === dragState.id) return '自分自身へは移動できません';
    if (card.dataset.id !== ROOT_ID && isDescendant(card.dataset.id, dragState.id)) return '自部門の配下へは移動できません（循環）';
    return 'ここへは移動できません';
  }
  if (kind === 'member') {
    const m = MEMBERS.get(dragState.id);
    if (card.dataset.mid === dragState.id) return '自分自身は上長にできません';
    if (m && m.leaderId === card.dataset.mid) return '既にこの人の配下です';
    return '上長の循環になるため設定できません';
  }
  if (kind === 'root') return 'メンバーはトップ階層に置けません';
  if (card.dataset.id === dragState.srcDept) return '上長がいないため、この操作は不要です';
  return 'ここへは移動できません';
}
function clearDropOnly() { document.querySelectorAll('.drop-target,.drop-invalid').forEach(el => el.classList.remove('drop-target', 'drop-invalid')); }
function clearDnDStyles() { clearDropOnly(); document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging')); dragState = null; }

function dropValid(targetId) {   // ドロワーからのドラッグ等、id ベースの検証
  if (!dragState) return false;
  if (dragState.kind === 'dept') {
    if (targetId === dragState.id) return false;
    if (targetId !== ROOT_ID && isDescendant(targetId, dragState.id)) return false;
    return true;
  }
  if (targetId === ROOT_ID) return false;
  if (targetId === dragState.srcDept) {   // 自部門カードへのドロップ = 上長解除（部門直下 = 上長と同列に）
    const m = MEMBERS.get(dragState.id);
    return !!(m && m.leaderId);
  }
  return true;
}
function dropValidCard(card) {   // チャート上のカードベースの検証
  if (!dragState) return false;
  const kind = card.dataset.kind;
  if (dragState.kind === 'dept' && kind === 'member') return false; // 部門は人の上には落とせない
  if (dragState.kind === 'member' && kind === 'member') {           // 人 → 人 = 上長に設定
    const tgt = card.dataset.mid;
    const m = MEMBERS.get(dragState.id);
    return !!m && tgt !== dragState.id && m.leaderId !== tgt && !leaderCycle(dragState.id, tgt);
  }
  if (dragState.kind === 'member' && kind !== 'dept') return false; // 人はそれ以外 部門カードのみ
  return dropValid(card.dataset.id);
}
// メンバーが自分の責任部門から抜けるときの注意喚起（Lark では跨部門責任者は合法 → ブロックせず通知のみ）
function leaderMoveOutNote(m, srcDeptId) {
  if (!srcDeptId) return '';
  const sd = NODES.find(x => x.id === srcDeptId);
  if (sd && sd.type === 'dept' && sd.leaderId === m.id && !m.deptIds.has(srcDeptId)) {
    updateDeptSub(sd);   // 「他部門所属」注記を即時反映
    return `※「${m.name}」は「${sd.deptName}」の責任者です。移動後は部門外の責任者になります（必要に応じて再設定してください）。`;
  }
  return '';
}
function applyLeaderDrop(leaderMid) {   // 人 → 人 ドロップ = 上長に設定
  const m = MEMBERS.get(dragState && dragState.id);
  clearDnDStyles();
  if (!m) return;
  m.leaderId = leaderMid;
  markEdited();
  logHist('下書き編集', `${m.name} の上長を ${MEMBERS.get(leaderMid)?.name || '?'} に設定`);
  showToast(`「${m.name}」の上長を「${MEMBERS.get(leaderMid)?.name || '?'}」に設定しました（下書き）。`);
  PLAN = null;
  render(); renderDiff();
}
function applyDrop(targetId) {
  if (!dropValid(targetId)) { clearDnDStyles(); return; }
  if (dragState.kind === 'dept') {
    NODES.find(n => n.id === dragState.id).parentId = targetId;
  } else {
    const m = MEMBERS.get(dragState.id);
    if (targetId === dragState.srcDept) {
      // 自部門カードへドロップ = 部門直下へ = 上長解除（上長と同列になる）
      const old = MEMBERS.get(m.leaderId)?.name || '?';
      m.leaderId = null;
      showToast(`「${m.name}」を部門直下へ移動し、上長（${old}）を解除しました（下書き）。`);
      logHist('下書き編集', `${m.name} の上長（${old}）を解除`);
    } else {
      if (dragState.srcDept) m.deptIds.delete(dragState.srcDept);
      m.deptIds.add(targetId);
      const note = leaderMoveOutNote(m, dragState.srcDept);
      showToast(note ? `「${m.name}」の異動を下書きに追加しました。${note}` : `「${m.name}」の異動を下書きに追加しました。正式な組織にはまだ反映されていません。`, !!note);
      logHist('下書き編集', `${m.name} を ${deptNameById(targetId)} へ異動`);
    }
  }
  if (dragState.kind === 'dept') logHist('下書き編集', `部門「${NODES.find(n => n.id === dragState.id)?.deptName}」を ${parentName(targetId)} 配下へ移動`);
  clearDnDStyles();
  markEdited();
  PLAN = null; // 編集したら保存済み計画は無効化
  render(); renderDiff();
  if (drawerDept) openDrawer(drawerDept); // ドロワー再描画
}

// ================= メンバードロワー =================
function openDrawer(deptId, highlightMemId) {
  drawerDept = deptId;
  const node = NODES.find(n => n.id === deptId);
  const list = [...MEMBERS.values()].filter(m => !m.deleted && m.deptIds.has(deptId)).sort((a, b) => String(a.name).localeCompare(b.name, 'ja'));
  $('drawer-dept').textContent = node ? node.deptName : '';
  $('drawer-count').textContent = `${list.length} 名`;
  const body = $('drawer-list');
  body.innerHTML = list.length ? '' : '<div class="drawer-empty">直属メンバーなし</div>';
  list.forEach(m => body.appendChild(memberRow(m, deptId)));
  $('drawer').hidden = false;
  if (highlightMemId) {
    const row = body.querySelector(`.mrow[data-mid="${highlightMemId}"]`);
    if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'nearest' }); setTimeout(() => row.classList.remove('flash'), 1600); }
  }
}
function closeDrawer() { $('drawer').hidden = true; drawerDept = null; }

function memberRow(m, deptId) {
  const el = document.createElement('div');
  el.className = 'mrow' + (memChanged(m) ? ' changed' : '');
  el.dataset.mid = m.id;
  el.draggable = true;
  const others = [...m.deptIds].filter(x => x !== deptId).map(deptNameById);
  el.innerHTML =
    `<span class="mgrip">⠿</span>` +
    `<span class="mavatar">${esc(initials(m.name))}</span>` +
    `<span class="mbody"><span class="mname ${m.status === '退職' ? 'st-r' : ''}">${esc(m.name)}</span>` +
    `<span class="mmeta">${esc([m.title, others.length ? '兼任: ' + others.join('、') : ''].filter(Boolean).join(' ・ '))}</span></span>`;
  el.addEventListener('dragstart', (e) => {
    dragState = { kind: 'member', id: m.id, srcDept: deptId };
    el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', m.id);
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); clearDnDStyles(); });
  return el;
}
$('drawer-close').onclick = closeDrawer;

// ================= 変更明細 =================
function operations() {
  const ops = [];
  NODES.forEach(n => {
    if (n.type !== 'dept') return;
    if (n.isNew && !n.deleted) {
      ops.push({ type: 'DEPT_CREATE', name: n.deptName, to: parentName(n.parentId), _to: n.parentId, _id: n.id, _kind: 'dept' });
      if (n.leaderId) ops.push({ type: 'DEPT_SET_LEADER', name: n.deptName, from: 'なし', to: `責任者: なし → ${MEMBERS.get(n.leaderId)?.name || '?'}`, _id: n.id, _kind: 'dept' });
      return;
    }
    if (n.deleted && !n.isNew) { ops.push({ type: 'DEPT_DELETE', name: n.deptName, _id: n.id, _kind: 'dept' }); return; }
    if (n.deleted) return;  // 同一草稿内で 追加→削除 は相殺
    if (deptRenamed(n)) ops.push({ type: 'DEPT_RENAME', name: n.origName, to: n.deptName, _id: n.id, _kind: 'dept' });
    if (deptChanged(n)) ops.push({ type: 'DEPT_MOVE', name: n.deptName, from: parentName(ORIG.get(n.id)), to: parentName(n.parentId), _from: ORIG.get(n.id), _to: n.parentId, _id: n.id, _kind: 'dept' });
    if (deptLeaderChanged(n)) {
      const dep = (s) => [...(s || [])].map(id => MEMBERS.get(id)?.name).filter(Boolean).join('、') || 'なし';
      const mainChanged = (n.leaderId || null) !== (n.origLeaderId || null);
      const depChanged = sig(n.deputyIds || new Set()) !== sig(n.origDeputyIds || new Set());
      const parts = [];
      if (mainChanged) parts.push(`主: ${MEMBERS.get(n.origLeaderId)?.name || 'なし'} → ${MEMBERS.get(n.leaderId)?.name || 'なし'}`);
      if (depChanged) parts.push(`副: ${dep(n.origDeputyIds)} → ${dep(n.deputyIds)}`);
      ops.push({ type: 'DEPT_SET_LEADER', name: n.deptName, from: MEMBERS.get(n.origLeaderId)?.name || 'なし', to: parts.join(' ／ '), _id: n.id, _kind: 'dept' });
    }
  });
  MEMBERS.forEach(m => {
    if (m.isNew && !m.deleted) { ops.push({ type: 'MEMBER_CREATE', name: m.name, to: [...m.deptIds].map(deptNameById).join('、'), title: m.title, _id: m.id, _kind: 'member' }); return; }
    if (m.deleted && !m.isNew) { ops.push({ type: 'MEMBER_DELETE', name: m.name, _id: m.id, _kind: 'member' }); return; }
    if (m.deleted) return;  // 追加→削除 は相殺
    if (memChanged(m)) ops.push({ type: 'MEMBER_MOVE', name: m.name, from: [...m.origDeptIds].map(deptNameById).join('、') || 'なし', to: [...m.deptIds].map(deptNameById).join('、') || 'なし', _id: m.id, _kind: 'member' });
    if (memUpdated(m)) {
      const parts = [];
      if ((m.title || '') !== (m.origTitle || '')) parts.push(`役職: ${m.origTitle || 'なし'} → ${m.title || 'なし'}`);
      if ((m.leaderId || null) !== (m.origLeaderId || null)) parts.push(`上長: ${MEMBERS.get(m.origLeaderId)?.name || 'なし'} → ${MEMBERS.get(m.leaderId)?.name || 'なし'}`);
      ops.push({ type: 'MEMBER_UPDATE', name: m.name, to: parts.join(' ／ '), _id: m.id, _kind: 'member' });
    }
    if (memPrimaryChanged(m)) ops.push({ type: 'MEMBER_SET_PRIMARY', name: m.name, from: deptNameById(m.origPrimaryDept) || 'なし', to: deptNameById(m.primaryDept) || 'なし', _id: m.id, _kind: 'member' });
  });
  return ops;
}
const parentName = (pid) => (pid === ROOT_ID || !pid) ? (NODES.find(n => n.type === 'root')?.name || 'ルート') : (NODES.find(n => n.id === pid)?.deptName || '?');

const OP_LABEL = { DEPT_CREATE: '追加', DEPT_RENAME: '改名', DEPT_MOVE: '移動', DEPT_SET_LEADER: '更新', DEPT_DELETE: '削除', MEMBER_CREATE: '追加', MEMBER_MOVE: '異動', MEMBER_UPDATE: '更新', MEMBER_SET_PRIMARY: '主部門', MEMBER_DELETE: '削除' };
const OP_CHIP = { DEPT_CREATE: '部門追加', DEPT_RENAME: '改名', DEPT_MOVE: '部門移動', DEPT_SET_LEADER: '責任者変更', DEPT_DELETE: '部門削除', MEMBER_CREATE: 'メンバー追加', MEMBER_MOVE: '異動', MEMBER_UPDATE: '更新', MEMBER_SET_PRIMARY: '主部門変更', MEMBER_DELETE: 'メンバー削除' };
const OP_CLS = { DEPT_CREATE: 'create', DEPT_RENAME: 'rename', DEPT_MOVE: 'move', DEPT_SET_LEADER: 'rename', DEPT_DELETE: 'del', MEMBER_CREATE: 'create', MEMBER_MOVE: 'transfer', MEMBER_UPDATE: 'rename', MEMBER_SET_PRIMARY: 'transfer', MEMBER_DELETE: 'del' };

// ---- リスク判定（表示用の軽量指標）----
function subtreeMembers(deptId) {   // 部門とその配下の（同期済み）メンバー数
  const deptSet = new Set([deptId]);
  let grew = true;
  while (grew) { grew = false; NODES.forEach(n => { if (n.type === 'dept' && !n.deleted && deptSet.has(n.parentId) && !deptSet.has(n.id)) { deptSet.add(n.id); grew = true; } }); }
  let c = 0; MEMBERS.forEach(m => { if (!m.deleted && [...m.deptIds].some(d => deptSet.has(d))) c++; });
  return { depts: deptSet.size, members: c };
}
function riskOf(o) {
  if (o.type === 'DEPT_DELETE' || o.type === 'MEMBER_DELETE') return 'high';
  if (o.type === 'DEPT_MOVE') { const s = subtreeMembers(o._id); return (s.depts > 1 || s.members >= 5) ? 'medium' : 'low'; }
  if (o.type === 'MEMBER_CREATE') return 'medium';   // 招待が飛ぶ
  return 'low';
}
const RISK_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
function riskCounts(ops) { const c = { low: 0, medium: 0, high: 0 }; ops.forEach(o => c[riskOf(o)]++); return c; }

// ---- 変更行の Before / After ----
function opBeforeAfter(o) {
  if (o.type === 'DEPT_CREATE') return { b: '（なし）', a: `${o.to} 配下に新設` };
  if (o.type === 'DEPT_RENAME') return { b: o.name, a: o.to };
  if (o.type === 'DEPT_MOVE') return { b: `親: ${parentName(o._from)}`, a: `親: ${parentName(o._to)}` };
  if (o.type === 'DEPT_SET_LEADER') { const n = NODES.find(x => x.id === o._id); return { b: `責任者: ${MEMBERS.get(n?.origLeaderId)?.name || 'なし'}`, a: `責任者: ${MEMBERS.get(n?.leaderId)?.name || 'なし'}` }; }
  if (o.type === 'DEPT_DELETE' || o.type === 'MEMBER_DELETE') return { b: '在籍', a: '削除' };
  if (o.type === 'MEMBER_CREATE') return { b: '（なし）', a: `${o.to}${o.title ? ` ・ ${o.title}` : ''}` };
  if (o.type === 'MEMBER_UPDATE') return { b: '現状', a: o.to };
  return { b: o.from, a: o.to };   // MEMBER_MOVE
}
// 1オブジェクト分の草稿変更を元に戻す（既存の状態モデルの範囲内で復元）
function revertOp(kind, id) {
  if (kind === 'dept') {
    const n = NODES.find(x => x.id === id); if (!n) return;
    if (n.isNew) { NODES = NODES.filter(x => x.id !== id); }
    else {
      n.deleted = false; n.parentId = ORIG.get(n.id);
      if (n.origName != null && n.deptName !== n.origName) { n.deptName = n.origName; n.name = n.origName; n.avatarChar = initials(n.origName); }
      if (deptLeaderChanged(n)) { n.leaderId = n.origLeaderId || null; n.deputyIds = new Set(n.origDeputyIds || []); updateDeptSub(n); }
    }
  } else {
    const m = MEMBERS.get(id); if (!m) return;
    if (m.isNew) MEMBERS.delete(id);
    else { m.deleted = false; m.handoverRecId = null; m.deptIds = new Set(m.origDeptIds); m.title = m.origTitle || ''; m.leaderId = m.origLeaderId || null; }
    NODES.forEach(n => { if (n.type === 'dept' && n.leaderId === id) updateDeptSub(n); });
  }
  PLAN = null;
  render(); renderDiff();
}
function locateObj(kind, id) {
  if (kind === 'dept') { const n = NODES.find(x => x.id === id); if (n && !n.deleted) locateDept(id); }
  else { const m = MEMBERS.get(id); if (m && !m.deleted && m.deptIds.size) locateMember(id, ''); }
  showDetail(kind, id);
}

// ---- ヘッダー状態チップ + メインアクション ----
function planPhase() {
  if (!PLAN) return 'none';
  if (!PLAN.results) return 'saved';
  const remaining = PLAN.execOps.length - (PLAN.doneCount || 0);
  if (PLAN.results.fail > 0) return 'failed';
  return remaining > 0 ? 'partial' : 'done';
}
function renderHeaderState(opsLen) {
  const cd = $('chip-draft');
  if (opsLen) { cd.className = 'stchip st-amber'; cd.textContent = `未保存の変更 ${opsLen}件${LAST_EDIT ? ` ・ ${fmtTime(LAST_EDIT)}` : ''}`; }
  else { cd.className = 'stchip st-gray'; cd.textContent = '変更なし'; }
  // 常駐の安全条: 下書きがある時だけ表示（実行前は Lark に反映されない・撤销可能を明示）
  const ds = $('draftSafe');
  if (ds) { ds.hidden = !opsLen; if (opsLen) $('ds-count').textContent = `${opsLen}件`; }
  const cp = $('chip-plan'); const ph = planPhase();
  const map = {
    none: ['st-gray', '予約プラン未作成'],
    saved: ['st-amber', '予約プラン作成済み・確定待ち'],
    partial: ['st-amber', '一部実行済み'],
    failed: ['st-red', '実行に失敗した項目あり'],
    done: ['st-green', '実行済み']
  };
  cp.className = 'stchip ' + map[ph][0]; cp.textContent = map[ph][1];
  // メインアクション（状態機械）
  const btn = $('actionMain');
  if (ph === 'done') { btn.disabled = false; btn.textContent = '再読み込みして反映'; btn.onclick = load; btn.title = 'Lark に反映済み。最新の組織を再読み込みします'; }
  else if (ph === 'saved' || ph === 'partial') { btn.disabled = false; btn.textContent = '予約を確定…'; btn.onclick = () => { switchTab('review'); confirmExec(); }; btn.title = '確定するまで Lark は変更されません。押すと確認画面が開きます'; }
  else if (opsLen) { btn.disabled = false; btn.textContent = `予約プランを作成（${opsLen}件）`; btn.onclick = () => { switchTab('review'); showSaveForm(); }; btn.title = '下書きを予約プランとして保存します（この時点では Lark に未反映）'; }
  else { btn.disabled = true; btn.textContent = '変更なし'; btn.onclick = null; btn.title = '部門を選んで組織を編集できます'; }
}

function renderDiff() {
  const ops = operations();
  // 保存済みプランを読み込んだ状態（下書きなし）→ プラン内容を読み取り専用で表示
  if (PLAN && PLAN.loaded && !ops.length) { renderLoadedPlan(); return; }
  const cnt = {}; ops.forEach(o => cnt[o.type] = (cnt[o.type] || 0) + 1);
  const risks = riskCounts(ops);
  const memberIds = new Set(ops.filter(o => o._kind === 'member').map(o => o._id));
  $('reset').disabled = ops.length === 0;
  $('sp-count').hidden = ops.length === 0;
  $('sp-count').textContent = ops.length;
  $('pt-count').hidden = ops.length === 0;
  $('pt-count').textContent = ops.length;
  $('review-empty').hidden = ops.length > 0;
  $('review-summary').innerHTML = ops.length
    ? `<div class="rs-grid">
         <div class="rs-cell"><span class="rs-num">${ops.length}</span><span class="rs-lbl">変更件数</span></div>
         <div class="rs-cell"><span class="rs-num">${(cnt.DEPT_MOVE || 0) + (cnt.DEPT_CREATE || 0) + (cnt.DEPT_RENAME || 0) + (cnt.DEPT_DELETE || 0)}</span><span class="rs-lbl">部門</span></div>
         <div class="rs-cell"><span class="rs-num">${memberIds.size}</span><span class="rs-lbl">対象メンバー</span></div>
         <div class="rs-cell ${risks.high ? 'rs-risk' : ''}"><span class="rs-num">${risks.high + risks.medium}</span><span class="rs-lbl">要注意（High ${risks.high}）</span></div>
       </div>
       <div class="rs-chips">${Object.keys(OP_CHIP).filter(k => cnt[k]).map(k => `<span class="chip chip-${OP_CLS[k]}">${OP_CHIP[k]} ${cnt[k]}</span>`).join('')}</div>
       <div class="rs-note">下書きの変更です。予約プランの作成 → 予約の確定までは、正式な組織には反映されません。</div>`
    : '';
  $('diff-list').innerHTML = ops.map(o => {
    const risk = riskOf(o);
    const ba = opBeforeAfter(o);
    const impact = o._kind === 'dept' && (o.type === 'DEPT_MOVE' || o.type === 'DEPT_DELETE')
      ? (() => { const s = subtreeMembers(o._id); return `影響: 部門 ${s.depts} ・ メンバー ${s.members} 名`; })()
      : '';
    return `<div class="diff-item">
      <div class="di-head">
        <span class="tag tag-${OP_CLS[o.type]}">[${OP_LABEL[o.type]}]</span>
        <span class="di-name">${esc(o.name)}</span>
        <span class="risk risk-${risk}">${RISK_LABEL[risk]}</span>
      </div>
      <div class="di-ba"><span class="di-b">${esc(ba.b)}</span><span class="arrow">→</span><span class="di-a">${esc(ba.a)}</span></div>
      ${impact ? `<div class="di-impact">${esc(impact)}</div>` : ''}
      <div class="di-ops">
        <button class="di-btn di-locate" data-kind="${o._kind}" data-id="${esc(o._id)}">表示</button>
        <button class="di-btn di-undo" data-kind="${o._kind}" data-id="${esc(o._id)}">取り消す</button>
      </div>
    </div>`;
  }).join('');
  $('diff-list').querySelectorAll('.di-undo').forEach(b => b.onclick = () => { revertOp(b.dataset.kind, b.dataset.id); logHist('取り消し', '変更を1件取り消しました'); });
  $('diff-list').querySelectorAll('.di-locate').forEach(b => b.onclick = () => locateObj(b.dataset.kind, b.dataset.id));
  renderHeaderState(ops.length);
  renderActions();
}

// 読み込んだ予約プランを読み取り専用でレビュー欄に表示
function renderLoadedPlan() {
  const p = PLAN;
  $('reset').disabled = true;
  $('sp-count').hidden = false; $('sp-count').textContent = p.execOps.length;
  $('pt-count').hidden = false; $('pt-count').textContent = p.execOps.length;
  $('review-empty').hidden = true;
  $('diffPanel') && ($('diffPanel').hidden = false);
  $('review-summary').innerHTML =
    `<div class="rs-note" style="color:var(--primary);background:var(--primary-soft);border-color:#D6E4FD;display:flex;gap:8px;align-items:center;justify-content:space-between;">
       <span>読み込んだ予約プラン「${esc(p.name || '')}」・${p.execOps.length} 件</span>
       <button id="loaded-close" class="di-btn">閉じる</button></div>`;
  const lc = $('loaded-close'); if (lc) lc.onclick = () => { PLAN = null; render(); renderDiff(); };
  $('diff-list').innerHTML = p.execOps.map(o => `
    <div class="diff-item">
      <div class="di-head">
        <span class="tag tag-${OP_CLS[o.opType] || 'move'}">[${OP_LABEL[o.opType] || o.opType}]</span>
        <span class="di-name">${esc(o.targetName || '')}</span>
        ${o.deleteFlag ? '<span class="risk risk-high">High</span>' : ''}
      </div>
      <div class="di-ba"><span class="di-b">${esc(o.beforeText || o.fromName || '—')}</span><span class="arrow">→</span><span class="di-a">${esc(o.afterText || o.toName || '—')}</span></div>
    </div>`).join('');
  renderHeaderState(0);
  renderActions();
}
// ⋯メニュー → 予約プラン一覧
async function openPlanList() {
  closeMore();
  cancelMove(); closeAddBar(); closeLeaderBar();
  $('planOverlay').hidden = false;
  $('plan-list').innerHTML = '<div class="sr-empty">読み込み中…</div>';
  try {
    const r = await (await fetch('/api/plans')).json();
    if (!r.ok) throw new Error(r.error);
    renderPlanRows(r.plans || []);
  } catch (e) { $('plan-list').innerHTML = `<div class="act-note act-err">一覧の取得に失敗しました：${esc(String(e.message || e))}</div>`; }
}
function closePlanList() { $('planOverlay').hidden = true; }
const PLAN_STATUS_CLS = { '予約済み': 'st-amber', '実行中': 'st-amber', '完了': 'st-green', '部分失敗': 'st-red', '失敗': 'st-red' };
function renderPlanRows(plans) {
  const box = $('plan-list');
  if (!plans.length) { box.innerHTML = '<div class="sr-empty">保存された予約プランはありません。</div>'; return; }
  box.innerHTML = plans.map((p, i) => {
    const done = p.status === '完了' || p.status === '実行中' || p.status === '部分失敗';
    const stCls = PLAN_STATUS_CLS[p.status] || 'st-gray';
    return `<div class="plan-row">
      <div class="plan-main">
        <div class="plan-name">${esc(p.name)}<span class="stchip ${stCls}" style="margin-left:8px;">${esc(p.status || '—')}</span></div>
        <div class="plan-meta">${esc(p.summary || `${p.opCount} 件`)}${p.effectiveDate ? ` ・ 予定 ${esc(p.effectiveDate)}` : ''}${p.createdBy ? ` ・ ${esc(p.createdBy)}` : ''}${p.result ? ` ・ ${esc(p.result)}` : ''}</div>
      </div>
      <button class="act ${done || !p.opCount ? '' : 'act-primary'} plan-open" data-i="${i}" ${(done || !p.opCount) ? 'disabled' : ''}>${done ? '実行済み' : (p.opCount ? 'この画面で開く' : '再開不可')}</button>
    </div>`;
  }).join('');
  [...box.querySelectorAll('.plan-open')].forEach(b => b.onclick = () => loadSavedPlan(plans[+b.dataset.i]));
}
function loadSavedPlan(p) {
  if (!p || !p.opCount) return;
  if (operations().length) { showToast('未保存の下書きがあります。先に破棄または保存してください。', true); return; }
  PLAN = { planRecId: p.recId, name: p.name, planUrl: BASE_URL, execOps: p.ops.map(o => ({ ...o })), loaded: true };
  closePlanList();
  switchTab('review'); renderDiff();
  showToast(`予約プラン「${p.name}」を読み込みました。内容を確認して実行できます。`);
}
$('planList').onclick = openPlanList;
$('plan-close').onclick = closePlanList;
$('planOverlay').addEventListener('click', (e) => { if (e.target.id === 'planOverlay') closePlanList(); });

function resetDraft() {
  NODES = NODES.filter(n => !(n.type === 'dept' && n.isNew));   // 草稿で追加した部門を破棄
  NODES.forEach(n => {
    if (n.type !== 'dept') return;
    n.parentId = ORIG.get(n.id); n.deleted = false;
    if (n.origName != null && n.deptName !== n.origName) { n.deptName = n.origName; n.name = n.origName; n.avatarChar = initials(n.origName); }
    n.leaderId = n.origLeaderId || null; n.deputyIds = new Set(n.origDeputyIds || []); updateDeptSub(n);
  });
  [...MEMBERS.keys()].forEach(id => { if (MEMBERS.get(id).isNew) MEMBERS.delete(id); });   // 草稿で追加したメンバーを破棄
  MEMBERS.forEach(m => {
    m.deptIds = new Set(m.origDeptIds); m.deleted = false; m.handoverRecId = null;
    m.title = m.origTitle || ''; m.leaderId = m.origLeaderId || null;
  });
  // メンバー復元後に部門 sub を再計算（他部門所属の注記は deptIds 依存のため順序が重要）
  NODES.forEach(n => { if (n.type === 'dept') updateDeptSub(n); });
  PLAN = null;
  render(); renderDiff();
  if (drawerDept) openDrawer(drawerDept);
}

// ================= M4/M5: 計画保存 + 実行 =================
function buildExecOps() {
  const nodeById = (id) => NODES.find(n => n.id === id);
  const depth = (id) => { let d = 0, cur = nodeById(id); while (cur && cur.parentId && cur.parentId !== ROOT_ID) { d++; cur = nodeById(cur.parentId); } return d; };
  // 親参照: 新規部門(new|x)は openId/recId が未確定 → 仮IDをそのまま渡し、サーバ側で実行時に解決
  const refOpen = (pid) => { if (pid === ROOT_ID || !pid) return '0'; const p = nodeById(pid); return p?.isNew ? pid : (p?.openId || '0'); };
  const refRec = (pid) => (pid === ROOT_ID || !pid) ? null : pid;
  const memRefOpen = (mid) => { const b = MEMBERS.get(mid); return b ? (b.isNew ? b.id : b.openId) : null; };
  const ops = [];
  // 1) 部門追加（親 → 子の順）
  NODES.filter(n => n.type === 'dept' && n.isNew && !n.deleted)
    .sort((a, b) => depth(a.id) - depth(b.id))
    .forEach(n => ops.push({ opType: 'DEPT_CREATE', objType: '部門', targetName: n.deptName, tmpId: n.id, toOpenId: refOpen(n.parentId), toRecId: refRec(n.parentId), fromName: '（新規）', toName: `親: ${parentName(n.parentId)}`,
      beforeText: '（存在しない）', afterText: `部門「${n.deptName}」を新設 ／ 親部門: ${parentName(n.parentId)}` }));
  // 2) 改名
  NODES.filter(deptRenamed).forEach(n =>
    ops.push({ opType: 'DEPT_RENAME', objType: '部門', targetName: n.origName, newName: n.deptName, targetOpenId: n.openId, targetRecId: n.id, fromName: n.origName, toName: n.deptName,
      beforeText: `部門名: ${n.origName}`, afterText: `部門名: ${n.deptName}` }));
  // 3) 部門移動
  NODES.filter(deptChanged).forEach(n =>
    ops.push({ opType: 'DEPT_MOVE', objType: '部門', targetName: n.deptName, targetOpenId: n.openId, targetRecId: n.id, toOpenId: refOpen(n.parentId), toRecId: refRec(n.parentId), fromName: parentName(ORIG.get(n.id)), toName: parentName(n.parentId),
      beforeText: `親部門: ${parentName(ORIG.get(n.id))}`, afterText: `親部門: ${parentName(n.parentId)}` }));
  // 4) メンバー追加（新規メンバーは仮ID newm|x で参照）
  const deptOpenIds = (m) => [...m.deptIds].map(id => { const n = nodeById(id); return n?.isNew ? id : n?.openId; }).filter(Boolean);
  MEMBERS.forEach(m => {
    if (!m.isNew || m.deleted) return;
    const op = { opType: 'MEMBER_CREATE', objType: 'メンバー', targetName: m.name, tmpId: m.id, email: m.email || '', mobile: m.mobile || '', title: m.title || '', employeeType: m.employeeType || '1', toOpenIds: deptOpenIds(m), toRecIds: [...m.deptIds], fromName: '（新規）', toName: [...m.deptIds].map(deptNameById).join('、'),
      beforeText: '（存在しない）', afterText: `メンバー「${m.name}」を追加 ／ 所属: ${[...m.deptIds].map(deptNameById).join('、')}${m.title ? ` ／ 役職: ${m.title}` : ''}${m.leaderId ? ` ／ 上長: ${MEMBERS.get(m.leaderId)?.name || ''}` : ''}` };
    if (m.leaderId) { op.leaderOpenId = memRefOpen(m.leaderId); op.leaderRecId = m.leaderId; }
    ops.push(op);
  });
  // 4.5) 部門責任者の変更（主 + 副）。新規メンバー/新規部門があるため MEMBER_CREATE の後・仮IDはサーバで解決
  NODES.filter(n => n.type === 'dept' && !n.deleted && (deptLeaderChanged(n) || (n.isNew && (n.leaderId || (n.deputyIds && n.deputyIds.size))))).forEach(n => {
    const origName = n.isNew ? null : (MEMBERS.get(n.origLeaderId)?.name || null);
    const origDep = n.isNew ? new Set() : (n.origDeputyIds || new Set());
    const depNames = (s) => [...(s || [])].map(id => MEMBERS.get(id)?.name).filter(Boolean).join('、') || 'なし';
    const op = { opType: 'DEPT_SET_LEADER', objType: '部門', targetName: n.deptName,
                 targetOpenId: n.isNew ? n.id : n.openId,   // 新規部門は new|x 仮ID → サーバで解決
                 targetRecId: n.id,
                 fromName: `責任者: ${origName || 'なし'}`, toName: `責任者: ${MEMBERS.get(n.leaderId)?.name || 'なし'}`,
                 beforeText: `主: ${origName || '未設定'} ／ 副: ${depNames(origDep)}`,
                 afterText: `主: ${MEMBERS.get(n.leaderId)?.name || '未設定（解除）'} ／ 副: ${depNames(n.deputyIds)}` };
    if (n.leaderId) { op.newLeaderOpenId = memRefOpen(n.leaderId); op.newLeaderRecId = n.leaderId; }
    else { op.newLeaderOpenId = ''; op.newLeaderRecId = null; }   // 主解除（Lark 制約により副も全解除）
    // 副責任者の差分（アプリで識別できる副のみ。アンマップの副はサーバのライブマージで温存）
    op.addDeputyOpenIds = [...(n.deputyIds || [])].filter(id => !origDep.has(id)).map(memRefOpen).filter(Boolean);
    op.removeDeputyOpenIds = [...origDep].filter(id => !(n.deputyIds || new Set()).has(id)).map(id => MEMBERS.get(id)?.openId).filter(Boolean);
    ops.push(op);
  });
  // 5) メンバー異動（from 側の部門も渡す — 実行後のメンバー数リフレッシュ用）
  MEMBERS.forEach(m => {
    if (!memChanged(m)) return;
    const fromOpenIds = [...m.origDeptIds].map(id => nodeById(id)?.openId).filter(Boolean);
    ops.push({ opType: 'MEMBER_MOVE', objType: 'メンバー', targetName: m.name, targetOpenId: m.openId, targetRecId: m.id, toRecIds: [...m.deptIds], fromRecIds: [...m.origDeptIds], fromOpenIds, fromName: [...m.origDeptIds].map(deptNameById).join('、') || 'なし', toName: [...m.deptIds].map(deptNameById).join('、') || 'なし', toOpenIds: deptOpenIds(m),
      beforeText: `所属部門: ${[...m.origDeptIds].map(deptNameById).join('、') || 'なし'}`, afterText: `所属部門: ${[...m.deptIds].map(deptNameById).join('、') || 'なし'}` });
  });
  // 6) メンバー更新（役職・上長 — 変更のあったフィールドだけ送る。上長クリアは leader_user_id: "" で解除）
  MEMBERS.forEach(m => {
    if (!memUpdated(m)) return;
    const parts = [];
    const op = { opType: 'MEMBER_UPDATE', objType: 'メンバー', targetName: m.name, targetOpenId: m.openId, targetRecId: m.id, fromName: '現状' };
    if ((m.title || '') !== (m.origTitle || '')) { op.newTitle = m.title || ''; parts.push(`役職: ${m.title || 'なし'}`); }
    if ((m.leaderId || null) !== (m.origLeaderId || null)) {
      if (m.leaderId) {
        op.newLeaderOpenId = memRefOpen(m.leaderId); op.newLeaderRecId = m.leaderId;
        parts.push(`上長: ${MEMBERS.get(m.leaderId)?.name || '?'}`);
      } else {
        op.newLeaderOpenId = ''; op.newLeaderRecId = null;   // "" = Lark 側で上長解除（検証済み）
        parts.push('上長: 解除');
      }
    }
    op.toName = parts.join(' / ') || '変更なし';
    {
      const b = [], a = [];
      if ((m.title || '') !== (m.origTitle || '')) { b.push(`役職: ${m.origTitle || 'なし'}`); a.push(`役職: ${m.title || 'なし'}`); }
      if ((m.leaderId || null) !== (m.origLeaderId || null)) { b.push(`上長: ${MEMBERS.get(m.origLeaderId)?.name || 'なし'}`); a.push(`上長: ${MEMBERS.get(m.leaderId)?.name || 'なし（解除）'}`); }
      op.beforeText = b.join(' ／ '); op.afterText = a.join(' ／ ');
    }
    if (parts.length) ops.push(op);
  });
  // 6.5) 主部門の設定（Lark: department_order を最大化。is_primary_dept は派生で書込不可。execute でライブ orders をマージ）
  MEMBERS.forEach(m => {
    if (!memPrimaryChanged(m)) return;
    const primOpen = nodeById(m.primaryDept)?.openId;
    if (!primOpen) return;   // 主部門に open_department_id が無い（未反映の新規部門など）はスキップ
    ops.push({ opType: 'MEMBER_SET_PRIMARY', objType: 'メンバー', targetName: m.name, targetOpenId: m.openId, targetRecId: m.id,
      primaryDeptOpenId: primOpen, primaryDeptRecId: m.primaryDept,
      fromName: deptNameById(m.origPrimaryDept) || 'なし', toName: deptNameById(m.primaryDept) || 'なし',
      beforeText: `主部門: ${deptNameById(m.origPrimaryDept) || 'なし'}`, afterText: `主部門: ${deptNameById(m.primaryDept) || 'なし'}` });
  });
  // 7) メンバー削除（削除系フラグ付き・from 側の部門はメンバー数リフレッシュ用）
  MEMBERS.forEach(m => {
    if (!m.deleted || m.isNew) return;
    const fromOpenIds = [...m.origDeptIds].map(id => nodeById(id)?.openId).filter(Boolean);
    const hand = m.handoverRecId ? MEMBERS.get(m.handoverRecId) : null;
    const op = { opType: 'MEMBER_DELETE', objType: 'メンバー', targetName: m.name, targetOpenId: m.openId, targetRecId: m.id, deleteFlag: true, fromRecIds: [...m.origDeptIds], fromOpenIds, fromName: [...m.origDeptIds].map(deptNameById).join('、') || 'なし', toName: '削除',
      beforeText: `在籍 ／ 所属: ${[...m.origDeptIds].map(deptNameById).join('、') || 'なし'}${m.title ? ` ／ 役職: ${m.title}` : ''}`, afterText: `退職・アカウント削除${hand ? ` ／ 資源引継: ${hand.name}` : ''}` };
    if (hand && hand.openId) { op.handoverOpenId = hand.openId; op.handoverRecId = m.handoverRecId; }
    ops.push(op);
  });
  // 8) 部門削除（深い階層 → 浅い階層の順・削除系フラグ付き）
  NODES.filter(n => n.type === 'dept' && n.deleted && !n.isNew)
    .sort((a, b) => depth(b.id) - depth(a.id))
    .forEach(n => ops.push({ opType: 'DEPT_DELETE', objType: '部門', targetName: n.deptName, targetOpenId: n.openId, targetRecId: n.id, deleteFlag: true, fromName: parentName(n.parentId), toName: '削除',
      beforeText: `部門「${n.deptName}」 ／ 親部門: ${parentName(n.parentId)}`, afterText: '部門を削除' }));
  ops.forEach((o, i) => o.order = i + 1);
  return ops;
}
function summaryText() {
  const o = operations();
  const cnt = {}; o.forEach(x => cnt[x.type] = (cnt[x.type] || 0) + 1);
  return Object.keys(OP_CHIP).filter(k => cnt[k]).map(k => `${OP_CHIP[k]} ${cnt[k]}`).join(' / ');
}
function showSaveForm() {
  const el = $('diff-actions');
  el.innerHTML =
    `<div class="act-form">
       <label class="act-lbl">プラン名</label>
       <input id="f-name" class="act-input" value="組織変更 ${new Date().toISOString().slice(0, 10)}">
       <label class="act-lbl">反映予定日時</label>
       <input id="f-date" class="act-input" type="datetime-local" value="${nowLocalInput()}">
       <div class="act-hint">※ 指定時刻の自動実行には現在対応していません。時刻になったら「予約を確定」を押してください（台帳には予定として記録されます）。</div>
       <div class="act-row"><button id="f-save" class="act act-primary">予約プランを作成</button><button id="f-cancel" class="act">キャンセル</button></div>
     </div>`;
  $('f-name').focus();
  $('f-save').onclick = doSave;
  $('f-cancel').onclick = renderActions;
}
async function doSave() {
  const ops = buildExecOps(); if (!ops.length) return;
  const name = ($('f-name').value || '').trim() || '組織変更';
  // datetime-local の "YYYY-MM-DDTHH:mm" を台帳の "YYYY-MM-DD HH:mm:ss" 表記へ整形（送信内容の意味は不変）
  let eff = ($('f-date').value || '').trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(eff)) eff += ':00';
  setAct('予約プランを作成しています…');
  try {
    const r = await postJSON('/api/plan', { name, effectiveDate: eff, summary: summaryText(), operations: ops });
    if (!r.ok) throw new Error(r.error);
    PLAN = { planRecId: r.planRecId, planUrl: r.planUrl, name, execOps: ops.map((o, i) => ({ ...o, opRecId: r.opRecIds[i] })) };
    logHist('プラン作成', `「${name}」（${ops.length} 件）を Base 台帳に保存`);
    renderDiff();
  } catch (e) { setAct('予約プランの作成に失敗しました: ' + (e.message || e), true); logHist('プラン作成失敗', String((e && e.message) || e)); }
}
function confirmExec(limit) {
  const start = PLAN.doneCount || 0;                       // 実行済み件数（部分実行のカーソル）
  const n = limit || (PLAN.execOps.length - start);
  const batch = PLAN.execOps.slice(start, start + n);
  const del = batch.filter(o => o.deleteFlag).length;
  const depts = new Set(batch.filter(o => o.objType === '部門').map(o => o.targetName)).size;
  const mems = new Set(batch.filter(o => o.objType === 'メンバー').map(o => o.targetName)).size;
  openConfirm({
    title: '予約の確定',
    body:
      `<div class="cfm-lead">この操作で<b>初めて Lark の正式な組織が変更されます</b>。ここまでの下書き・予約はすべて未反映でした。</div>
       <div class="cfm-grid">
         <div><span class="cfm-num">${n}</span><span class="cfm-lbl">実行する変更</span></div>
         <div><span class="cfm-num">${depts}</span><span class="cfm-lbl">対象部門</span></div>
         <div><span class="cfm-num">${mems}</span><span class="cfm-lbl">対象メンバー</span></div>
         <div class="${del ? 'cfm-danger' : ''}"><span class="cfm-num">${del}</span><span class="cfm-lbl">削除（復元不可）</span></div>
       </div>
       <div class="cfm-meta">プラン: ${esc(PLAN.name || '組織変更')} ・ 反映タイミング: <b>今すぐ</b></div>
       <div class="act-note act-warn">確定すると、Lark の正式な組織データに反映されます。移動・改名はあとから変更できますが、<b>削除は元に戻せません</b>。</div>`,
    checkLabel: '変更内容と影響範囲を確認しました。確定すると正式な組織データに反映されることを理解しています。',
    okLabel: `予約を確定（${n}件）`,
    onOk: () => execNow(limit)
  });
}

// ---- 汎用確認モーダル ----
function openConfirm({ title, body, checkLabel, okLabel, okClass, onOk }) {
  $('cfm-title').textContent = title;
  $('cfm-stats').innerHTML = body || '';
  const cw = $('cfm-checkwrap'); const agree = $('cfm-agree'); const ok = $('cfm-ok');
  agree.checked = false;
  if (checkLabel) { cw.hidden = false; $('cfm-checklabel').textContent = checkLabel; ok.disabled = true; }
  else { cw.hidden = true; ok.disabled = false; }
  ok.textContent = okLabel || 'OK';
  ok.className = 'act ' + (okClass || 'act-danger');
  agree.onchange = () => { ok.disabled = checkLabel ? !agree.checked : false; };
  ok.onclick = () => { closeConfirm(); onOk && onOk(); };
  $('cfm-cancel').onclick = closeConfirm;
  $('cfmOverlay').hidden = false;
  $('cfm-cancel').focus();   // キーボード操作の起点をモーダル内へ（安全側=キャンセル）
}
function closeConfirm() { $('cfmOverlay').hidden = true; }
$('cfmOverlay').addEventListener('click', (e) => { if (e.target.id === 'cfmOverlay') closeConfirm(); });
async function execNow(limit) {
  setAct('実行中です。Lark へ反映しています…');
  try {
    // 実行済み分を除いた「残り」だけ送る（再実行による二重作成・二重削除を防止）
    const start = PLAN.doneCount || 0;
    const body = { planRecId: PLAN.planRecId, ops: PLAN.execOps.slice(start) };
    if (limit) body.limit = limit;
    const r = await postJSON('/api/execute', body);
    if (!r.ok) throw new Error(r.error);
    PLAN.doneCount = start + r.results.length;
    PLAN.results = r;
    logHist('実行', `成功 ${r.success}件 ・ 失敗 ${r.fail}件（プラン: ${r.planStatus}）`);
    renderDiff();
    // 全件成功で完了したら自動で再同期（失敗あり・部分実行時は結果を残して手動のまま）
    if (r.fail === 0 && PLAN.doneCount >= PLAN.execOps.length) {
      showToast(`${r.success}件の変更を実行しました。最新の組織を再読み込みしています…`);
      setTimeout(load, 1400);
    }
  } catch (e) { setAct('実行に失敗しました: ' + (e.message || e), true); logHist('実行失敗', String((e && e.message) || e)); }
}
async function postJSON(url, body) { return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
function nowLocal() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function nowLocalInput() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function setAct(msg, err) { $('diff-actions').innerHTML = `<div class="act-note ${err ? 'act-err' : ''}">${esc(msg)}</div>`; }

function renderActions() {
  const el = $('diff-actions'); const ops = operations();
  if (!ops.length && !(PLAN && PLAN.loaded)) { el.innerHTML = ''; return; }
  if (!PLAN) {
    el.innerHTML =
      `<button id="btn-save" class="act act-primary">予約プランを作成</button>` +
      `<div class="act-hint">保存しても <b>Lark には反映されません</b>（規划器内の下書き）。次の「実行」で初めて反映されます。</div>`;
    $('btn-save').onclick = showSaveForm;
  } else if (!PLAN.results) {
    // 新規作成を含む計画は一括実行のみ（部分実行だと仮ID new|x の解決マップがリクエストをまたげないため）
    const hasCreate = PLAN.execOps.some(o => o.opType === 'DEPT_CREATE' || o.opType === 'MEMBER_CREATE');
    el.innerHTML =
      `<div class="act-note">予約プランを作成しました（<b>まだ Lark に未反映</b>）<a href="${PLAN.planUrl}" target="_blank">台帳を開く ↗</a></div>` +
      (hasCreate ? `<div class="act-hint">新規作成を含むプランのため、まとめて実行のみになります</div>`
                 : `<button id="btn-test" class="act act-primary">まず1件のみ実行</button>`) +
      `<button id="btn-all" class="act act-danger">すべて実行（${PLAN.execOps.length}件）</button>` +
      `<div class="act-hint">「実行」を押すと、この時点で初めて Lark の組織に反映されます。</div>`;
    const bt = $('btn-test'); if (bt) bt.onclick = () => confirmExec(1);
    $('btn-all').onclick = () => confirmExec();
  } else {
    const r = PLAN.results;
    const rows = r.results.map(x => `<div class="res ${x.ok ? 'ok' : 'ng'}">${x.ok ? '✓' : '✗'} ${esc(x.name)}${x.error ? '：' + esc(x.error) : ''}</div>`).join('');
    const remaining = PLAN.execOps.length - (PLAN.doneCount || 0);
    el.innerHTML =
      `<div class="act-note">実行結果: <b>成功 ${r.success}件 ・ 失敗 ${r.fail}件</b>（プラン: ${esc(r.planStatus)}）</div>${rows}` +
      (remaining > 0 ? `<button id="btn-all" class="act act-danger">残りを実行（${remaining}件）</button>` : '') +
      `<button id="btn-refresh" class="act act-primary">再読み込みして反映</button>` +
      `<div class="act-hint">Lark の組織と Base の台帳を更新しました。再読み込みで最新の状態を表示します。</div>`;
    const ba = $('btn-all'); if (ba) ba.onclick = () => confirmExec();
    $('btn-refresh').onclick = load;
  }
}

// ---- toolbar / more メニュー ----
const closeMore = () => { $('moreMenu').hidden = true; };
$('moreBtn').onclick = (e) => { e.stopPropagation(); $('moreMenu').hidden = !$('moreMenu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) closeMore(); });
$('reload').onclick = () => { closeMore(); guardUnsaved('再読み込みすると、未保存の変更は破棄されます。', load); };
$('reset').onclick = () => {
  closeMore();
  const n = operations().length; if (!n) return;
  openConfirm({
    title: '変更を破棄',
    body: `<div class="act-note act-warn">未保存の変更 <b>${n}件</b> をすべて破棄し、同期済みの組織の状態に戻します。この操作は下書きのみに影響し、正式な組織には影響しません。</div>`,
    okLabel: `${n}件を破棄`,
    onOk: () => { resetDraft(); logHist('破棄', `下書きの変更 ${n}件をすべて破棄`); }
  });
};
$('expandAll').onclick = () => { closeMore(); NODES.forEach(n => { if (isDisplayDept(n)) EXPANDED.add(n.id); }); render(); };
$('collapseAll').onclick = () => { closeMore(); EXPANDED.clear(); render(); };
$('fit').onclick = () => { closeMore(); chart && chart.fit(); };
function setNoiseFilter(on) {
  HIDE_NOISE_DEPTS = !!on;
  localStorage.setItem('orgplanner_hide_noise_depts', HIDE_NOISE_DEPTS ? '1' : '0');
  const cb = $('hideNoiseDepts'); if (cb) cb.checked = HIDE_NOISE_DEPTS;
  if (FOCUS && isNoiseDeptId(FOCUS)) FOCUS = null;
  if (VIEW === 'chart') render();
  else renderAltBody();
  showToast(HIDE_NOISE_DEPTS ? 'テスト/デモ部門を非表示にしました。' : 'テスト/デモ部門を表示しました。');
}
if ($('hideNoiseDepts')) {
  $('hideNoiseDepts').checked = HIDE_NOISE_DEPTS;
  $('hideNoiseDepts').onchange = (e) => setNoiseFilter(e.target.checked);
}
// キャンバス左下のズームコントロール
$('zoom-in').onclick = () => chart && chart.zoomIn();
$('zoom-out').onclick = () => chart && chart.zoomOut();
$('zoom-fit').onclick = () => chart && chart.fit();
$('layout').onclick = () => { COMPACT = !COMPACT; $('layout').textContent = COMPACT ? '表示: コンパクト' : '表示: ツリー'; render(); };
// 表示密度（簡潔 / 責任者 / 完全）
function setDensity(name) {
  if (!['simple', 'full'].includes(name)) return;
  DENSITY = name; localStorage.setItem('orgplanner_density', name);
  document.querySelectorAll('#densitySeg .dseg').forEach(b => { const on = b.dataset.density === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  $('reportToggleWrap').hidden = !(VIEW === 'chart' && name === 'full');
  render();
}
document.querySelectorAll('#densitySeg .dseg').forEach(b => b.onclick = () => setDensity(b.dataset.density));
$('reportToggle').onchange = (e) => { SHOW_REPORTING = e.target.checked; render(); };
// 部門詳細パネルの所属メンバー行 → 人員詳細へ
$('detail-body').addEventListener('click', (e) => {
  const c = e.target.closest('.dt-crow[data-detail-dept]'); if (c) { showDetail('dept', c.dataset.detailDept); return; }   // 子部門へドリル
  const r = e.target.closest('.dt-mrow[data-detail]'); if (r) showDetail('member', r.dataset.detail);
});
$('fb-back').onclick = focusUp;
$('fb-siblings').onchange = (e) => setFocus(e.target.value);
$('focusBar').addEventListener('click', (e) => { const c = e.target.closest('.fb-seg[data-focus]'); if (c) setFocus(c.dataset.focus); });
// 初期密度セグメントの active 反映
document.querySelectorAll('#densitySeg .dseg').forEach(b => { const on = b.dataset.density === DENSITY; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
function guardUnsaved(msg, fn) {
  const n = operations().length;
  if (!n) return fn();
  openConfirm({ title: '未保存の変更があります', body: `<div class="act-note act-warn">${esc(msg)}（現在 ${n}件）</div>`, okLabel: '続行', onOk: fn });
}
window.addEventListener('beforeunload', (e) => { if (operations().length) { e.preventDefault(); e.returnValue = ''; } });

// ---- サイドパネル: タブ ----
const isNarrow = () => window.innerWidth <= 860;
// パネルの表示/折りたたみでキャンバス幅が変わるため、組織図を新しい幅で再描画（右側の空白防止）
function reflowChart() {
  if (!chart) return;
  requestAnimationFrame(() => { try { chart.render(); } catch (_) {} });
}
// どの画面幅でもパネルを確実に表示（折りたたみ解除 + 狭い画面はスライドオーバーで開く）
function showPanel() {
  const sp = $('sidePanel');
  const wasCollapsed = sp.classList.contains('collapsed');
  sp.classList.remove('collapsed');
  $('panelToggle').classList.remove('show');
  if (isNarrow()) sp.classList.add('open');
  else if (wasCollapsed) reflowChart();   // 広い画面で再表示＝キャンバスが狭くなる → 再描画
}
function switchTab(name) {
  document.querySelectorAll('.sp-tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ['review', 'detail', 'hist'].forEach(k => { $('tab-' + k).hidden = k !== name; });
  showPanel();
}
document.querySelectorAll('.sp-tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
$('ds-review').onclick = () => switchTab('review');   // 安全条→変更レビューを開く
// パネル開閉: 広い画面=折りたたみ（collapsed）／狭い画面=スライドオーバー（open）
$('sp-hide').onclick = () => {
  if (isNarrow()) { $('sidePanel').classList.remove('open'); return; }
  $('sidePanel').classList.add('collapsed');
  $('panelToggle').classList.add('show');
  reflowChart();   // 折りたたみでキャンバスが広がる → 組織図を全幅で再描画
};
$('panelToggle').onclick = () => {
  const sp = $('sidePanel');
  const visible = isNarrow() ? sp.classList.contains('open') : !sp.classList.contains('collapsed');
  if (visible && isNarrow()) sp.classList.remove('open');   // 狭い画面はトグルとして閉じる
  else showPanel();                                          // それ以外は常に「表示」に倒す
};
// キャンバスの余白クリックでのみ閉じる（ヘッダー操作やカードクリックでは閉じない）
document.addEventListener('click', (e) => {
  if (window.innerWidth > 860) return;
  if (e.target.closest('#chartWrap') && !e.target.closest('.oc-card')) $('sidePanel').classList.remove('open');
});

// ---- 操作履歴タブ ----
function renderHist() {
  const box = $('hist-list'); if (!box) return;
  $('hist-empty').hidden = HIST.length > 0;
  box.innerHTML = HIST.map(h =>
    `<div class="hist-item"><span class="hist-time">${fmtTime(h.time)}</span><span class="hist-act">${esc(h.action)}</span><span class="hist-detail">${esc(h.detail)}</span></div>`).join('');
}

// ---- 詳細タブ（Before / After 対比） ----
// 部門詳細パネルの「所属メンバー」全員リスト（責任者/副/在籍バッジ付き・クリックで人員詳細へ）
// 部門詳細パネルの「子部門」一覧（親部門の中に子部門を入れる・クリックで下位部門へドリル）
function deptChildListHTML(deptId) {
  const kids = NODES.filter(n => isDisplayDept(n) && n.parentId === deptId).sort(byOrder);
  if (!kids.length) return '';
  const rows = kids.map(c => {
    const leader = c.leaderId ? (MEMBERS.get(c.leaderId) || {}).name : null;
    const grand = NODES.filter(n => isDisplayDept(n) && n.parentId === c.id).length;
    return `<div class="dt-crow" data-detail-dept="${c.id}">
      <span class="dt-cav" style="color:${c.color};background:${softColor(c.color)}">${esc(initials(c.deptName))}</span>
      <span class="dt-cbody"><span class="dt-cname">${esc(c.deptName)}</span>${leader ? `<span class="dt-csub">責任者 ${esc(leader)}</span>` : ''}</span>
      <span class="olx-spacer"></span>
      ${grand ? `<span class="dt-csubcnt">部門 ${grand}</span>` : ''}
      <span class="dt-ccount">${displayDeptHeadcount(c.id)} 名</span>
    </div>`;
  }).join('');
  return `<div class="dt-mlist"><div class="dt-mlist-h">子部門 <b>${kids.length}</b></div>${rows}</div>`;
}
function deptMemberListHTML(deptId) {
  const dept = NODES.find(n => n.id === deptId); if (!dept) return '';
  const ms = deptMembers(deptId); if (!ms.length) return '<div class="dt-mlist"><div class="dt-mlist-h">直属メンバー <b>0</b> 名</div></div>';
  const rows = ms.map(m => {
    const st = memberStatusShort(m);
    const role = dept.leaderId === m.id ? '<span class="olx-badge olx-badge-lead">責任者</span>'
      : (dept.deputyIds && dept.deputyIds.has(m.id)) ? '<span class="oc-flag flag-primary">副</span>' : '';
    return `<div class="dt-mrow" data-detail="${m.id}">
      <span class="dt-mav" style="color:${dept.color};background:${softColor(dept.color)}">${esc(initials(m.name))}</span>
      <span class="dt-mname ${st.resigned ? 'st-r' : ''}">${esc(m.name)}</span>
      ${m.title ? `<span class="dt-mtitle">${esc(m.title)}</span>` : ''}
      <span class="olx-spacer"></span>${role}${st.badge ? `<span class="oc-flag ${st.cls}">${st.badge}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="dt-mlist"><div class="dt-mlist-h">所属メンバー <b>${ms.length}</b> 名</div>${rows}</div>`;
}
function showDetail(kind, id) {
  SELECTED = { kind, id };
  const box = $('detail-body');
  const row = (lbl, val) => `<div class="dt-row"><span class="dt-lbl">${lbl}</span><span class="dt-val">${val}</span></div>`;
  const baRow = (lbl, b, a) => b === a
    ? row(lbl, esc(a || 'なし'))
    : `<div class="dt-row dt-changed"><span class="dt-lbl">${lbl}</span><span class="dt-val"><s>${esc(b || 'なし')}</s> <span class="arrow">→</span> <b>${esc(a || 'なし')}</b></span></div>`;
  if (kind === 'dept') {
    const n = NODES.find(x => x.id === id);
    if (!n) { box.innerHTML = '<div class="sp-empty"><div class="spe-title">対象が見つかりません</div></div>'; switchTab('detail'); return; }
    const kids = NODES.filter(x => isDisplayDept(x) && x.parentId === id).length;
    const leader = n.leaderId && MEMBERS.get(n.leaderId);
    const state = n.isNew ? '<span class="stchip st-green">新規（下書き）</span>' : n.deleted ? '<span class="stchip st-red">削除予定（下書き）</span>' : (deptChanged(n) || deptRenamed(n)) ? '<span class="stchip st-amber">変更あり（下書き）</span>' : '<span class="stchip st-gray">変更なし</span>';
    box.innerHTML =
      `<div class="dt-head"><span class="dt-avatar" style="color:${n.color};background:${softColor(n.color)}">${esc(n.avatarChar)}</span>
         <div><div class="dt-name">${esc(n.deptName)}</div><div class="dt-sub">部門 ${state}</div></div></div>` +
      baRow('部門名', n.origName, n.deptName) +
      baRow('親部門', n.isNew ? 'なし' : parentName(ORIG.get(n.id)), parentName(n.parentId)) +
      row('部門責任者', leader ? (esc(leader.name) + (leader.deptIds.has(n.id) ? '' : ' <span class="stchip st-gray">他部門所属</span>')) : '未設定') +
      row('部門人数', `${displayDeptHeadcount(id)} 名（表示中の子部門含む）`) + row('うち直属', `${deptDirectCount(id)} 名`) + row('子部門数', `${kids}`) +
      (n.path ? row('パス', esc(n.path)) : '') +
      `<div class="dt-ops"><button class="di-btn" onclick="locateDept('${id}')">組織図で表示</button></div>` +
      deptChildListHTML(id) +
      deptMemberListHTML(id);
  } else {
    const m = MEMBERS.get(id);
    if (!m) { box.innerHTML = '<div class="sp-empty"><div class="spe-title">対象が見つかりません</div></div>'; switchTab('detail'); return; }
    const state = m.isNew ? '<span class="stchip st-green">新規（下書き）</span>' : m.deleted ? '<span class="stchip st-red">削除予定（下書き）</span>' : (memChanged(m) || memUpdated(m)) ? '<span class="stchip st-amber">変更あり（下書き）</span>' : '<span class="stchip st-gray">変更なし</span>';
    box.innerHTML =
      `<div class="dt-head"><span class="dt-avatar">${esc(initials(m.name))}</span>
         <div><div class="dt-name">${esc(m.name)}</div><div class="dt-sub">メンバー ${state}${m.status === '退職' ? ' <span class="stchip st-red">退職</span>' : ''}</div></div></div>` +
      baRow('所属部門', [...m.origDeptIds].map(deptNameById).join('、') || 'なし', [...m.deptIds].map(deptNameById).join('、') || 'なし') +
      baRow('役職', m.origTitle || 'なし', m.title || 'なし') +
      baRow('上長', MEMBERS.get(m.origLeaderId)?.name || 'なし', MEMBERS.get(m.leaderId)?.name || 'なし') +
      (m.email ? row('メール', esc(m.email)) : '') +
      `<div class="dt-ops"><button class="di-btn" onclick="locateMember('${id}','')">組織図で表示</button>${m.isNew || m.deleted ? '' : `<button class="di-btn" onclick="startMoveMember('${id}','${[...m.deptIds][0] || ''}')">異動…</button>`}</div>`;
  }
  switchTab('detail');
}

// ================= 検索 & 定位 =================
function searchMatches(q) {
  q = (q || '').trim().toLowerCase(); if (!q) return [];
  const res = [];
  NODES.forEach(n => { if (isDisplayDept(n) && n.deptName.toLowerCase().includes(q)) res.push({ kind: 'dept', id: n.id, name: n.deptName, sub: n.path || '' }); });
  MEMBERS.forEach(m => {
    if (!memberInVisibleDept(m) || !(m.name || '').toLowerCase().includes(q)) return;
    const depts = HIDE_NOISE_DEPTS ? [...m.deptIds].filter(did => isDisplayDept(NODES.find(n => n.id === did))) : [...m.deptIds];
    if (!depts.length) { res.push({ kind: 'member', id: m.id, deptId: '', name: m.name, sub: [m.title, '未所属'].filter(Boolean).join(' ・ ') }); return; }
    const multi = depts.length > 1;              // 兼任: 部門ごとに1件（それぞれ精確に定位）
    depts.forEach(did => res.push({ kind: 'member', id: m.id, deptId: did, name: m.name, sub: [m.title, deptNameById(did) + (multi ? '（兼任）' : '')].filter(Boolean).join(' ・ ') }));
  });
  return res.slice(0, 12);
}
function renderSearch(q) {
  const box = $('search-results'); const res = searchMatches(q);
  if (!res.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  // グループ分け: 変更あり / 部門 / メンバー
  const isChanged = (r) => {
    if (r.kind === 'dept') { const n = NODES.find(x => x.id === r.id); return !!n && (n.isNew || n.deleted || deptChanged(n) || deptRenamed(n)); }
    const m = MEMBERS.get(r.id); return !!m && (m.isNew || m.deleted || memChanged(m) || memUpdated(m));
  };
  const groups = [
    { label: '変更あり（下書き）', items: res.filter(isChanged) },
    { label: '部門', items: res.filter(r => r.kind === 'dept' && !isChanged(r)) },
    { label: 'メンバー', items: res.filter(r => r.kind === 'member' && !isChanged(r)) }
  ].filter(g => g.items.length);
  box.innerHTML = groups.map(g =>
    `<div class="sr-group">${esc(g.label)}</div>` +
    g.items.map(r =>
      `<div class="sr-item" data-kind="${r.kind}" data-id="${r.id}" data-deptid="${r.deptId || ''}">
         <span class="sr-icon sr-${r.kind}">${r.kind === 'dept' ? '部' : '人'}</span>
         <span class="sr-body"><span class="sr-name">${esc(r.name)}</span>${r.sub ? `<span class="sr-sub">${esc(r.sub)}</span>` : ''}</span>
       </div>`).join('')).join('');
  [...box.querySelectorAll('.sr-item')].forEach(el => el.onclick = () => pickResult(el.dataset.kind, el.dataset.id, el.dataset.deptid));
}
function pickResult(kind, id, deptId) {
  $('search').value = ''; $('search-results').hidden = true;
  if (kind === 'dept') locateDept(id);
  else locateMember(id, deptId);
  showDetail(kind, id);   // 検索 → 定位 + 詳細パネル連動
}
function flashCard(deptId) {
  setTimeout(() => {
    const card = document.querySelector(`.oc-card[data-id="${deptId}"]`);
    if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1700); }
  }, 420);
}
function expandAncestorsOf(deptId) {  // 対象部門までの祖先を EXPANDED に（部門自体は含めない）
  let cur = NODES.find(n => n.id === deptId);
  while (cur && cur.parentId && cur.parentId !== ROOT_ID) { EXPANDED.add(cur.parentId); cur = NODES.find(n => n.id === cur.parentId); }
}
function locateDept(deptId) {
  if (VIEW !== 'chart') setView('chart');   // 一覧/ボードから検索した時は組織図へ
  if (SIMPLE) { setFocus(deptId); flashCard(deptId); return; }   // 簡潔モード: 検索選択＝その部門に集中
  expandAncestorsOf(deptId); render();
  chart.setCentered(deptId).render();
  flashCard(deptId);
}
function locateMember(memId, deptId) {
  const m = MEMBERS.get(memId); if (!m) return;
  const did = deptId || [...m.deptIds][0]; if (!did) return;
  if (VIEW !== 'chart') setView('chart');   // 一覧/ボードから検索した時は組織図へ
  if (SIMPLE) { setFocus(did); try { chart.setCentered(`m|${memId}|${did}`).render(); } catch (_) {} flashCard(`m|${memId}|${did}`); return; }
  expandAncestorsOf(did); EXPANDED.add(did); render();  // 人を出すため部門自体も展開
  chart.setCentered(`m|${memId}|${did}`).render();
  flashCard(`m|${memId}|${did}`);
}
$('search').addEventListener('input', (e) => renderSearch(e.target.value));
// ドロップダウンの ↑↓/Enter ナビゲーション（ヘッダー検索・移動バー検索 共通）
function listNav(boxEl, e) {
  const items = [...boxEl.querySelectorAll('.sr-item')];
  if (!items.length) return false;
  const key = e.key === 'Down' ? 'ArrowDown' : e.key === 'Up' ? 'ArrowUp' : e.key;   // 旧キー名の別名も許容
  let idx = items.findIndex(el => el.classList.contains('active'));
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    e.preventDefault();
    idx = key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter') { items[idx >= 0 ? idx : 0].click(); return true; }
  return false;
}
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('search').value = ''; $('search-results').hidden = true; return; }
  listNav($('search-results'), e);
});
$('move-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return;   // Escape は既存の移動モード解除に委ねる
  listNav($('move-results'), e);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) $('search-results').hidden = true; });

// ================= M3.1: CSVインポート（部門） =================
let CSV_RESULT = null;   // 検証結果 [{line,action,name,...,ok,msg,op}]
let CSV_META = null;     // 取込メタ {kind, raw, rows, applied, summary}（Base 保存用）
let NEWSEQ = 1;          // 新規部門の仮ID連番（new|x）
let NEWMSEQ = 1;         // 新規メンバーの仮ID連番（newm|x）

function csvOpen() {
  closeMore();
  cancelMove(); closeAddBar(); closeLeaderBar();   // 移動モード・部門追加バーとは同時に使わせない（放置すると適用後に誤クリック確定の恐れ）
  $('csvOverlay').hidden = false; $('csv-paste').focus();
}
function csvClose() {
  $('csvOverlay').hidden = true; $('csv-paste').value = ''; $('csv-file').value = '';
  $('csv-preview').hidden = true; $('csv-preview').innerHTML = '';
  $('csv-summary').textContent = ''; $('csv-apply').disabled = true; $('csv-apply').textContent = '下書きに反映';
  CSV_RESULT = null; CSV_META = null;
}
function dlDeptTemplate() {
  const csv = ['アクション,部門名,親部門,新部門名',
    '追加,セールス推進部,Sales,',
    '移動,（対象部門名）,（移動先の部門名）,',
    '改名,（対象部門名）,,（新しい部門名）',
    '削除,（対象部門名）,,'].join('\r\n');
  dlCsv(csv, '部門インポート_テンプレート.csv');
}
function dlMemTemplate() {
  const csv = ['アクション,氏名,所属部門,役職,上長,メールアドレス,携帯番号,引継先',
    '異動,（対象者名）,Sales;Presales,,,,,',
    '更新,（対象者名）,,シニアSA,（上長の氏名）,,,',
    '追加,新人太郎,（部門名）,SA,（上長の氏名）,taro@example.com,+819012345678,',
    '削除,（対象者名）,,,,,,（引継先の氏名・任意）'].join('\r\n');
  dlCsv(csv, 'メンバーインポート_テンプレート.csv');
}
function dlCsv(csv, filename) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });   // BOM 付き = 日本語 Excel で文字化けしない
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

// ---- パース（カンマ/タブ自動判定・引用符対応・BOM除去）----
function parseTable(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const delim = (text.split('\n')[0] || '').includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* CRLF は \n 側で処理 */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
function csvParseText(text) {
  const table = parseTable(text);
  if (!table.length) return { error: 'データがありません' };
  const head = table[0].map(s => String(s).trim());
  const col = (name) => head.indexOf(name);
  const iAct = col('アクション');
  if (iAct < 0) return { error: 'ヘッダー行に「アクション」列が必要です。テンプレートをご利用ください' };
  const cell = (r, i) => i >= 0 ? String(r[i] || '').trim() : '';
  if (col('氏名') >= 0) {   // メンバーCSV
    const iName = col('氏名'), iDepts = col('所属部門'), iTitle = col('役職'), iLeader = col('上長'), iMail = col('メールアドレス'), iMob = col('携帯番号'), iHand = col('引継先');
    const rows = table.slice(1)
      .map((r, k) => ({ line: k + 2, action: cell(r, iAct), name: cell(r, iName), depts: cell(r, iDepts), title: cell(r, iTitle), leader: cell(r, iLeader), email: cell(r, iMail), mobile: cell(r, iMob), handover: cell(r, iHand) }))
      .filter(r => r.action || r.name);
    return { kind: 'member', rows };
  }
  if (col('部門名') >= 0) {  // 部門CSV
    const iName = col('部門名'), iParent = col('親部門'), iNew = col('新部門名');
    const rows = table.slice(1)
      .map((r, k) => ({ line: k + 2, action: cell(r, iAct), name: cell(r, iName), parent: cell(r, iParent), newName: cell(r, iNew) }))
      .filter(r => r.action || r.name);
    return { kind: 'dept', rows };
  }
  return { error: 'ヘッダー行に「部門名」（部門CSV）または「氏名」（メンバーCSV）が必要です' };
}

// ---- メンバーCSV 検証（読み取り専用・投影状態で逐行シミュレーション）----
function validateMemberRows(rows) {
  const proj = new Map();   // id -> {name, email, deptIds, title, leaderId, deleted}
  MEMBERS.forEach(m => proj.set(m.id, { name: m.name, email: (m.email || '').toLowerCase(), deptIds: new Set(m.deptIds), title: m.title || '', leaderId: m.leaderId || null, deleted: !!m.deleted }));
  let newK = 0;
  const findMem = (nm, email) => {
    let hits = []; proj.forEach((v, id) => { if (!v.deleted && v.name === nm) hits.push(id); });
    if (hits.length > 1 && email) { const e = email.toLowerCase(); hits = hits.filter(id => proj.get(id).email === e); }
    return hits;
  };
  const resolveLeader = (nm) => {
    const h = findMem(nm, '');
    if (!h.length) return { err: `上長「${nm}」が見つかりません` };
    if (h.length > 1) return { err: `上長「${nm}」が複数います（特定できません）` };
    return { ref: h[0] };
  };
  const resolveDeptList = (s) => {
    const names = s.split(/[;；]/).map(x => x.trim()).filter(Boolean);
    if (!names.length) return { err: '所属部門が空です（複数は ; 区切り）' };
    const refs = [];
    for (const nm of names) {
      const hits = NODES.filter(n => n.type === 'dept' && !n.deleted && n.deptName === nm);
      if (!hits.length) return { err: `部門「${nm}」が見つかりません` };
      if (hits.length > 1) return { err: `部門「${nm}」が複数あります` };
      refs.push(hits[0].id);
    }
    return { refs, names };
  };
  const results = [];
  for (const r of rows) {
    const out = { ...r, ok: false, msg: '', op: null };
    results.push(out);
    if (!['異動', '更新', '追加', '削除'].includes(r.action)) { out.msg = `アクション「${r.action}」は不正です（異動 / 更新 / 追加 / 削除）`; continue; }
    if (!r.name) { out.msg = '氏名が空です'; continue; }
    if (r.action === '追加') {
      if (!r.email) { out.msg = 'メールアドレスは必須です（招待の送付先）'; continue; }
      let dupMail = false; proj.forEach(v => { if (!v.deleted && v.email && v.email === r.email.toLowerCase()) dupMail = true; });
      if (dupMail) { out.msg = `メール「${r.email}」は既に使われています`; continue; }
      if (!r.mobile) { out.msg = '携帯番号は必須です（Lark アカウントの識別子）'; continue; }
      const d = resolveDeptList(r.depts); if (d.err) { out.msg = d.err; continue; }
      let leaderRef = null;
      if (r.leader) { const l = resolveLeader(r.leader); if (l.err) { out.msg = l.err; continue; } leaderRef = l.ref; }
      const tmp = `csvm#${newK++}`;
      proj.set(tmp, { name: r.name, email: r.email.toLowerCase(), deptIds: new Set(d.refs), title: r.title || '', leaderId: leaderRef, deleted: false });
      out.ok = true; out.msg = `「${d.names.join('、')}」に追加（招待が送信されます）`;
      out.op = { kind: 'mcreate', tmp, name: r.name, email: r.email, mobile: r.mobile, title: r.title || '', deptRefs: d.refs, leaderRef };
      continue;
    }
    const hits = findMem(r.name, r.email);
    if (!hits.length) { out.msg = `メンバー「${r.name}」が見つかりません`; continue; }
    if (hits.length > 1) { out.msg = `「${r.name}」が複数います（メールアドレス列で特定してください）`; continue; }
    const id = hits[0];
    if (r.action === '異動') {
      const d = resolveDeptList(r.depts); if (d.err) { out.msg = d.err; continue; }
      const cur = proj.get(id);
      if ([...cur.deptIds].sort().join() === [...d.refs].sort().join()) { out.ok = true; out.msg = '変更なし（スキップ）'; continue; }
      cur.deptIds = new Set(d.refs);
      out.ok = true; out.msg = `「${d.names.join('、')}」へ異動`; out.op = { kind: 'mmove', id, deptRefs: d.refs };
      continue;
    }
    if (r.action === '更新') {
      const cur = proj.get(id); const op = { kind: 'mupdate', id }; const parts = [];
      if (r.title) { if (r.title !== cur.title) { op.title = r.title; parts.push(`役職→${r.title}`); cur.title = r.title; } }
      if (r.leader) {
        if (/^(なし|無し|クリア)$/.test(r.leader)) {   // 上長を解除
          if (cur.leaderId) { op.leaderClear = true; parts.push('上長→解除'); cur.leaderId = null; }
        } else {
          const l = resolveLeader(r.leader); if (l.err) { out.msg = l.err; continue; }
          if (l.ref === id) { out.msg = '自分自身を上長にはできません'; continue; }
          if (l.ref !== cur.leaderId) { op.leaderRef = l.ref; parts.push(`上長→${proj.get(l.ref).name}`); cur.leaderId = l.ref; }
        }
      }
      if (!r.title && !r.leader) { out.msg = '更新内容がありません（役職 または 上長 を入力）'; continue; }
      if (!parts.length) { out.ok = true; out.msg = '変更なし（スキップ）'; continue; }
      out.ok = true; out.msg = parts.join(' / '); out.op = op;
      continue;
    }
    // 削除（退職）: 任意で資源引継先を指定
    const warns = [];
    if (NODES.some(n => n.type === 'dept' && !n.deleted && n.leaderId === id)) warns.push('部門長に設定中');
    let isBoss = false; proj.forEach((v, k) => { if (k !== id && !v.deleted && v.leaderId === id) isBoss = true; });
    if (isBoss) warns.push('他メンバーの上長');
    let handoverRef = null, handoverName = '';
    if (r.handover) {
      const h = findMem(r.handover, '');
      if (!h.length) { out.msg = `引継先「${r.handover}」が見つかりません`; continue; }
      if (h.length > 1) { out.msg = `引継先「${r.handover}」が複数います（特定できません）`; continue; }
      if (h[0] === id) { out.msg = '引継先に本人は指定できません'; continue; }
      handoverRef = h[0]; handoverName = proj.get(h[0]).name;
    }
    proj.get(id).deleted = true;
    out.ok = true;
    out.msg = '退職・アカウント削除' + (handoverName ? ` ／ 引継先: ${handoverName}` : '') + (warns.length ? `（注意: ${warns.join('・')}）` : '');
    out.op = { kind: 'mdelete', id, handoverRef };
  }
  return results;
}

// ---- 検証（読み取り専用・投影状態で逐行シミュレーション）----
const ROOT_WORDS = ['', '組織全体', 'ルート', 'トップ', 'root', 'ROOT'];
// テナント名（ルートカードの表示名）でもトップ階層を指定できるようにする
const isRootWord = (nm) => ROOT_WORDS.includes(nm) || nm === (NODES.find(n => n.type === 'root')?.name || '');
function validateDeptRows(rows) {
  const proj = new Map();   // id -> {name, parentId, deleted}（同一ファイル内の行を順に反映した投影）
  NODES.forEach(n => { if (n.type === 'dept') proj.set(n.id, { name: n.deptName, parentId: n.parentId, deleted: !!n.deleted }); });
  let newK = 0;
  const findByName = (nm) => { const hits = []; proj.forEach((v, id) => { if (!v.deleted && v.name === nm) hits.push(id); }); return hits; };
  const nameOf = (ref) => ref === ROOT_ID ? 'トップ階層' : (proj.get(ref)?.name || '?');
  const isDescProj = (target, anc) => { let cur = target; const seen = new Set(); while (cur && cur !== ROOT_ID && !seen.has(cur)) { if (cur === anc) return true; seen.add(cur); cur = proj.get(cur)?.parentId; } return false; };
  const hasChildProj = (id) => { let f = false; proj.forEach(v => { if (!v.deleted && v.parentId === id) f = true; }); return f; };
  const memberCountOf = (id) => { let c = 0; MEMBERS.forEach(m => { if (!m.deleted && m.deptIds.has(id)) c++; }); return c; };
  const resolveParent = (nm) => {
    if (isRootWord(nm)) return { ref: ROOT_ID };
    const h = findByName(nm);
    if (!h.length) return { err: `親部門「${nm}」が見つかりません` };
    if (h.length > 1) return { err: `親部門「${nm}」が複数あります（画面上で操作してください）` };
    return { ref: h[0] };
  };
  const results = [];
  for (const r of rows) {
    const out = { ...r, ok: false, msg: '', op: null };
    results.push(out);
    if (!['追加', '移動', '改名', '削除'].includes(r.action)) { out.msg = `アクション「${r.action}」は不正です（追加 / 移動 / 改名 / 削除）`; continue; }
    if (!r.name) { out.msg = '部門名が空です'; continue; }
    if (r.action === '追加') {
      if (findByName(r.name).length) { out.msg = `「${r.name}」は既に存在します`; continue; }
      const p = resolveParent(r.parent); if (p.err) { out.msg = p.err; continue; }
      const tmp = `csv#${newK++}`;
      proj.set(tmp, { name: r.name, parentId: p.ref, deleted: false });
      out.ok = true; out.msg = `「${nameOf(p.ref)}」配下に新設`; out.op = { kind: 'create', tmp, name: r.name, parentRef: p.ref };
      continue;
    }
    const hits = findByName(r.name);
    if (!hits.length) { out.msg = `部門「${r.name}」が見つかりません`; continue; }
    if (hits.length > 1) { out.msg = `「${r.name}」が複数あります（画面上で操作してください）`; continue; }
    const id = hits[0];
    if (r.action === '移動') {
      const p = resolveParent(r.parent); if (p.err) { out.msg = p.err; continue; }
      if (p.ref === id) { out.msg = '自分自身の配下へは移動できません'; continue; }
      if (p.ref !== ROOT_ID && isDescProj(p.ref, id)) { out.msg = '自部門の配下へは移動できません（循環）'; continue; }
      if (proj.get(id).parentId === p.ref) { out.ok = true; out.msg = '変更なし（スキップ）'; continue; }
      proj.get(id).parentId = p.ref;
      out.ok = true; out.msg = `「${nameOf(p.ref)}」配下へ移動`; out.op = { kind: 'move', id, parentRef: p.ref };
      continue;
    }
    if (r.action === '改名') {
      if (!r.newName) { out.msg = '新部門名が空です'; continue; }
      if (r.newName === proj.get(id).name) { out.ok = true; out.msg = '変更なし（スキップ）'; continue; }
      if (findByName(r.newName).length) { out.msg = `「${r.newName}」は既に存在します`; continue; }
      proj.get(id).name = r.newName;
      out.ok = true; out.msg = `「${r.newName}」に改名`; out.op = { kind: 'rename', id, newName: r.newName };
      continue;
    }
    // 削除
    if (hasChildProj(id)) { out.msg = `「${r.name}」には子部門があります（先に移動/削除してください）`; continue; }
    const mc = memberCountOf(id);
    if (mc > 0) { out.msg = `「${r.name}」には ${mc} 名のメンバーがいます（先に異動してください）`; continue; }
    const node = NODES.find(n => n.id === id);
    const warn = node && (node.count || 0) > mc ? '（注意: Lark 側に未同期メンバーがいる可能性）' : '';
    proj.get(id).deleted = true;
    out.ok = true; out.msg = `削除${warn}`; out.op = { kind: 'delete', id };
  }
  return results;
}

// ---- 反映（検証済み op 列を実際の草稿状態に適用）----
function applyCsvOps(results) {
  const tmpMap = {};   // csv#k -> new|x
  const real = (ref) => ref === ROOT_ID ? ROOT_ID : (tmpMap[ref] || ref);
  let firstFocus = null;
  results.forEach(r => {
    if (!r.ok || !r.op) return;
    const op = r.op;
    if (op.kind === 'create') {
      const id = `new|${NEWSEQ++}`; tmpMap[op.tmp] = id;
      const pid = real(op.parentRef);
      const parent = NODES.find(n => n.id === pid);
      NODES.push({
        id, parentId: pid, type: 'dept', deptName: op.name, name: op.name, origName: op.name, isNew: true, deleted: false,
        sub: '責任者 未設定', hasLeader: false, avatarChar: initials(op.name), openId: '', path: '',
        count: 0, baseCount: 0, color: parent && parent.type === 'dept' ? parent.color : PALETTE[NODES.length % PALETTE.length]
      });
      expandAncestorsOf(id);
      if (!firstFocus) firstFocus = id;
    } else if (op.kind === 'move') {
      const n = NODES.find(x => x.id === real(op.id)); if (!n) return;
      n.parentId = real(op.parentRef);
      expandAncestorsOf(n.id);
      if (!firstFocus) firstFocus = n.id;
    } else if (op.kind === 'rename') {
      const n = NODES.find(x => x.id === real(op.id)); if (!n) return;
      n.deptName = op.newName; n.name = op.newName; n.avatarChar = initials(op.newName);
      if (!firstFocus) firstFocus = n.id;
    } else if (op.kind === 'delete') {
      const n = NODES.find(x => x.id === real(op.id)); if (n) n.deleted = true;
    } else if (op.kind === 'mcreate') {
      const id = `newm|${NEWMSEQ++}`; tmpMap[op.tmp] = id;
      const deptIds = op.deptRefs.map(real);
      MEMBERS.set(id, {
        id, name: op.name, openId: '', title: op.title || '', email: op.email, empNo: '', status: '', mobile: op.mobile || '',
        leaderId: op.leaderRef ? real(op.leaderRef) : null, origLeaderId: null, origTitle: '',
        isNew: true, deleted: false, deptIds: new Set(deptIds), origDeptIds: new Set()
      });
      deptIds.forEach(did => { EXPANDED.add(did); expandAncestorsOf(did); });
      if (!firstFocus) firstFocus = deptIds[0];
    } else if (op.kind === 'mmove') {
      const m = MEMBERS.get(real(op.id)); if (!m) return;
      m.deptIds = new Set(op.deptRefs.map(real));
      [...m.deptIds].forEach(did => { EXPANDED.add(did); expandAncestorsOf(did); });
      if (!firstFocus) firstFocus = [...m.deptIds][0];
    } else if (op.kind === 'mupdate') {
      const m = MEMBERS.get(real(op.id)); if (!m) return;
      if ('title' in op) m.title = op.title;
      if (op.leaderClear) m.leaderId = null;
      else if (op.leaderRef) m.leaderId = real(op.leaderRef);
    } else if (op.kind === 'mdelete') {
      const m = MEMBERS.get(real(op.id)); if (m) { m.deleted = true; m.handoverRecId = op.handoverRef ? real(op.handoverRef) : null; }
    }
  });
  PLAN = null;
  render(); renderDiff();
  if (firstFocus) { try { chart.setCentered(firstFocus).render(); flashCard(firstFocus); } catch (_) {} }
}

function runCsvCheck() {
  const pv = $('csv-preview');
  const fail = (msg) => { pv.hidden = false; pv.innerHTML = `<div class="act-note act-err">${esc(msg)}</div>`; $('csv-summary').textContent = ''; $('csv-apply').disabled = true; CSV_RESULT = null; };
  const parsed = csvParseText($('csv-paste').value);
  if (parsed.error) return fail(parsed.error);
  if (!parsed.rows.length) return fail('データ行がありません');
  const results = parsed.kind === 'member' ? validateMemberRows(parsed.rows) : validateDeptRows(parsed.rows);
  CSV_RESULT = results;
  const okN = results.filter(r => r.ok && r.op).length;
  const fileEl = $('csv-file');
  const fname = fileEl.files && fileEl.files[0] ? fileEl.files[0].name : '貼り付け';
  CSV_META = { kind: parsed.kind, content: $('csv-paste').value, rows: parsed.rows.length, applied: okN,
    summary: `${parsed.kind === 'member' ? 'メンバー' : '部門'}CSV ・ ${fname} ・ ${okN}件反映` };
  const skipN = results.filter(r => r.ok && !r.op).length;
  const ngN = results.filter(r => !r.ok).length;
  const nameCol = parsed.kind === 'member' ? '氏名' : '部門名';
  pv.hidden = false;
  pv.innerHTML = `<table class="csv-table"><thead><tr><th>行</th><th>アクション</th><th>${nameCol}</th><th>チェック結果</th></tr></thead><tbody>` +
    results.map(r => `<tr class="${r.ok ? 'row-ok' : 'row-ng'}"><td>${r.line}</td><td>${esc(r.action)}</td><td>${esc(r.name)}</td><td>${r.ok ? '✓' : '✗'} ${esc(r.msg)}</td></tr>`).join('') +
    `</tbody></table>`;
  $('csv-summary').textContent = `${parsed.kind === 'member' ? 'メンバー' : '部門'}CSV ・ 反映可能 ${okN}件` + (skipN ? ` ・ スキップ ${skipN}件` : '') + (ngN ? ` ・ エラー ${ngN}件（反映されません）` : '');
  $('csv-apply').disabled = okN === 0;
  $('csv-apply').textContent = okN ? `${okN}件を下書きに反映` : '下書きに反映';
}

$('csvImport').onclick = csvOpen;
$('csv-close').onclick = csvClose;
$('csvOverlay').addEventListener('click', (e) => { if (e.target.id === 'csvOverlay') csvClose(); });
$('tpl-dept').onclick = dlDeptTemplate;
$('tpl-mem').onclick = dlMemTemplate;
$('csv-check').onclick = runCsvCheck;
$('csv-apply').onclick = async () => {
  if (!CSV_RESULT) return;
  const meta = CSV_META;
  applyCsvOps(CSV_RESULT);
  csvClose();
  // 取り込んだ CSV を Base に保存（監査・追跡用・best-effort）
  if (meta && meta.applied > 0) {
    try { await postJSON('/api/csv-import', meta); } catch (_) {}
  }
};
$('csv-paste').addEventListener('input', () => { $('csv-apply').disabled = true; CSV_RESULT = null; CSV_META = null; $('csv-summary').textContent = '内容が変わりました。再チェックしてください'; });
$('csv-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const buf = await f.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { text = new TextDecoder('shift_jis').decode(buf); }   // 日本語 Excel の CSV は Shift_JIS が多い
  $('csv-paste').value = text;
  runCsvCheck();
});

load();
loadEmpTypes();   // 雇用形態 enum を先読み（メンバー追加モーダルを開く前にセレクトを用意）
showSession();    // 本番: ログイン中のユーザー名とログアウトを表示
initOnboarding();
initReviewEmptyActions();
