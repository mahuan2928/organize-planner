// open_id 解決の安全化を検証する（Lark には接続せず、client を mock する）
//   実行: node --test worker/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';

const TABLES = { dept: 'tblD', member: 'tblM', plan: 'tblP', op: 'tblO', audit: 'tblA', csv: 'tblC', chat: 'tblChat' };

/**
 * @param members 台帳のメンバー行
 * @param emailToOpen batch_get_id が返す「メール → 現アプリ open_id」
 * @param aliveOpenIds users/batch で有効と確認できる open_id
 * @param failLookup true なら batch_get_id が例外を投げる（スコープ不足の再現）
 */
function mockClient({ members, chatRows = [], emailToOpen = {}, aliveOpenIds = [], failLookup = false, failChatTable = false }) {
  const calls = [];
  return {
    calls,
    tables: TABLES,
    nowStr: () => '2026-07-29 12:00:00',
    baseUrl: () => 'https://example.test/base',
    fetchTable: async (t) => {
      if (t === TABLES.member) return members;
      if (t === TABLES.chat && failChatTable) throw new Error('Base table permission denied');
      if (t === TABLES.chat) return chatRows;
      return [];
    },
    baseCreate: async () => ['recNEW'],
    baseCreateRecords: async (table, records) => {
      calls.push({ method: 'BASE_CREATE', path: table, data: records });
      return records.map((_, i) => `rec_created_${i}`);
    },
    baseUpsert: async () => ({}),
    baseDelete: async () => ({}),
    chatAddMembers: async (chatId, openIds) => { calls.push({ method: 'CHAT_ADD', path: chatId, data: openIds }); return {}; },
    chatRemoveMembers: async (chatId, openIds) => { calls.push({ method: 'CHAT_REMOVE', path: chatId, data: openIds }); return {}; },
    contactCall: async (method, path, data, params) => {
      calls.push({ method, path, data, params });
      if (path.includes('/users/batch_get_id')) {
        if (failLookup) throw new Error('Lark 99991679: missing scope');
        const list = (data.emails || [])
          .filter(e => emailToOpen[e.toLowerCase()])
          .map(e => ({ email: e, user_id: emailToOpen[e.toLowerCase()] }));
        return { code: 0, data: { user_list: list } };
      }
      if (path.includes('/users/batch')) {
        const ids = [].concat(params.user_ids || []);
        return { code: 0, data: { items: ids.filter(id => aliveOpenIds.includes(id)).map(id => ({ open_id: id })) } };
      }
      return { code: 0, data: {} };
    }
  };
}

/** 役職だけ変える最小の op（メンバー1名を参照する） */
const memberUpdateOp = (openId, recId, extra = {}) => ({
  opType: 'MEMBER_UPDATE', objType: 'メンバー', targetName: 'テスト太郎',
  targetOpenId: openId, targetRecId: recId, oldTitle: '主任', newTitle: '課長',
  ...extra
});

test('メールで現アプリの open_id に解決できる場合、新しい open_id で書き込む', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' }
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1')], dryRun: true });

  assert.equal(r.ok, true);
  assert.deepEqual(r.unresolvedMembers, [], '未解決は無いはず');
  const patch = r.ops.find(o => o.method === 'PATCH');
  assert.ok(patch.path.includes('ou_NEW'), `新 open_id を使うべき: ${patch.path}`);
});

test('メールが無くても、台帳の open_id が現アプリで有効なら使う', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '佐藤', メールアドレス: '', open_id: 'ou_SAME' }],
    aliveOpenIds: ['ou_SAME']
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_SAME', 'rec1')], dryRun: true });

  assert.deepEqual(r.unresolvedMembers, []);
  assert.ok(r.ops.find(o => o.method === 'PATCH').path.includes('ou_SAME'));
});

test('メールが無く open_id も無効なら、書き込まずに失敗させる（旧IDを送らない）', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '鈴木', メールアドレス: '', open_id: 'ou_STALE' }],
    aliveOpenIds: []   // 別アプリ由来 → 現アプリでは無効
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_STALE', 'rec1')], dryRun: true });

  assert.equal(r.results[0].ok, false, 'op は失敗しているべき');
  assert.match(r.results[0].error, /特定できませんでした/);
  assert.equal(r.unresolvedMembers.length, 1);
  assert.equal(r.unresolvedMembers[0].name, '鈴木');
  assert.equal(r.ops.filter(o => o.method === 'PATCH').length, 0, '旧 open_id で書き込んではいけない');
});

test('batch_get_id が失敗しても握り潰さず lookupErrors に残す', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '高橋', メールアドレス: 'takahashi@example.com', open_id: 'ou_X' }],
    failLookup: true,
    aliveOpenIds: ['ou_X']   // 照会は失敗したが台帳の ID は有効
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_X', 'rec1')], dryRun: true });

  assert.ok(r.lookupErrors.length > 0, '照会失敗を記録するべき');
  assert.match(r.lookupErrors[0], /missing scope/);
  assert.deepEqual(r.unresolvedMembers, [], '台帳の ID が有効なら実行はできる');
});

test('部門だけの op はメンバー照会を必要としない', async () => {
  const client = mockClient({ members: [] });
  const svc = createService(client);
  const r = await svc.execute({
    ops: [{ opType: 'DEPT_RENAME', objType: '部門', targetName: '旧名', newName: '新名', targetOpenId: 'od-1' }],
    dryRun: true
  });
  assert.equal(r.results[0].ok, true);
  assert.deepEqual(r.unresolvedMembers, []);
  assert.equal(client.calls.filter(c => c.path.includes('batch_get_id')).length, 0);
});

test('役職変更時、旧役職グループから退出し新役職グループへ参加する', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [
      { record_id: 'chat1', '役職フィルター': '主任', chat_id: 'oc_old', 'チャットグループ名': '主任チャット' },
      { record_id: 'chat2', '役職フィルター': '課長', chat_id: 'oc_new', 'チャットグループ名': '課長チャット' }
    ]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1')] });

  assert.equal(r.results[0].ok, true);
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_REMOVE'), { method: 'CHAT_REMOVE', path: 'oc_old', data: ['ou_NEW'] });
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_ADD'), { method: 'CHAT_ADD', path: 'oc_new', data: ['ou_NEW'] });
  assert.match(r.results[0].chatSync, /旧役職グループ/);
  assert.match(r.results[0].chatSync, /新役職グループ/);
});

test('役職を空にした場合、旧役職グループから退出し新規参加はしない', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [{ record_id: 'chat1', '役職フィルター': '主任', chat_id: 'oc_old', 'チャットグループ名': '主任チャット' }]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: '主任', newTitle: '' })] });

  assert.equal(r.results[0].ok, true);
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_REMOVE'), { method: 'CHAT_REMOVE', path: 'oc_old', data: ['ou_NEW'] });
  assert.equal(client.calls.filter(c => c.method === 'CHAT_ADD').length, 0);
});

test('役職を新規設定した場合、新役職グループへ参加し旧グループ退出はしない', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [{ record_id: 'chat2', '役職フィルター': '課長', chat_id: 'oc_new', 'チャットグループ名': '課長チャット' }]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: '', newTitle: '課長' })] });

  assert.equal(r.results[0].ok, true);
  assert.equal(client.calls.filter(c => c.method === 'CHAT_REMOVE').length, 0);
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_ADD'), { method: 'CHAT_ADD', path: 'oc_new', data: ['ou_NEW'] });
});

test('旧役職と新役職が同じ chat_id を共有する場合、退出も参加もしない', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [
      { record_id: 'chat1', '役職フィルター': '主任', chat_id: 'oc_shared', 'チャットグループ名': '共有チャット' },
      { record_id: 'chat2', '役職フィルター': '課長', chat_id: 'oc_shared', 'チャットグループ名': '共有チャット' }
    ]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: '主任', newTitle: '課長' })] });

  assert.equal(r.results[0].ok, true);
  assert.equal(client.calls.filter(c => c.method === 'CHAT_REMOVE').length, 0);
  assert.equal(client.calls.filter(c => c.method === 'CHAT_ADD').length, 0);
});

test('チャットグループ名が group_chat 値の場合、その chat_id で同期する', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [{ record_id: 'chat1', '役職フィルター': '主任', 'チャットグループ名': [{ id: 'oc_group_field', name: '主任チャット' }] }]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: '主任', newTitle: '' })] });

  assert.equal(r.results[0].ok, true);
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_REMOVE'), { method: 'CHAT_REMOVE', path: 'oc_group_field', data: ['ou_NEW'] });
});

test('group_chat フィールド名でも旧役職グループから退出できる', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    chatRows: [{ record_id: 'chat1', '役職フィルター': 'Presales Manager', group_chat: [{ id: 'oc_group_chat', name: 'Presales Manager Chat' }] }]
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: 'Ｐｒｅｓａｌｅｓ　Ｍａｎａｇｅｒ', newTitle: '' })] });

  assert.equal(r.results[0].ok, true);
  assert.deepEqual(client.calls.find(c => c.method === 'CHAT_REMOVE'), { method: 'CHAT_REMOVE', path: 'oc_group_chat', data: ['ou_NEW'] });
});

test('チャットグループ管理テーブルを読めない場合、職位更新を成功扱いにしない', async () => {
  const client = mockClient({
    members: [{ record_id: 'rec1', 氏名: '田中', メールアドレス: 'tanaka@example.com', open_id: 'ou_OLD' }],
    emailToOpen: { 'tanaka@example.com': 'ou_NEW' },
    failChatTable: true
  });
  const svc = createService(client);
  const r = await svc.execute({ ops: [memberUpdateOp('ou_OLD', 'rec1', { oldTitle: '主任', newTitle: '' })] });

  assert.equal(r.ok, false);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /チャットグループ管理テーブルの読み取りに失敗/);
});

test('予約プラン保存は日付をミリ秒、リンクをrecord_id配列で書き込む', async () => {
  const client = mockClient({ members: [] });
  const svc = createService(client);
  const r = await svc.savePlan({
    name: 'テスト計画',
    effectiveDate: '2026-08-03 10:20:30',
    summary: 'summary',
    operations: [{
      order: 1, opType: 'MEMBER_UPDATE', objType: 'メンバー', targetName: '佐藤',
      targetRecId: 'rec_member_1', fromName: '役職: A', toName: '役職: B',
      beforeText: 'A', afterText: 'B'
    }]
  });
  const planCall = client.calls.find(c => c.method === 'BASE_CREATE' && c.path === TABLES.plan);
  const opCall = client.calls.find(c => c.method === 'BASE_CREATE' && c.path === TABLES.op);

  assert.equal(r.ok, true);
  assert.equal(typeof planCall.data[0]['発効日時'], 'number');
  assert.deepEqual(opCall.data[0]['関連計画'], ['rec_created_0']);
  assert.deepEqual(opCall.data[0]['対象メンバー'], ['rec_member_1']);
  assert.equal('対象部門' in opCall.data[0], false);
});
