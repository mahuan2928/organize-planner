# 組織プランナー for Lark（Organize Planner）

Lark の組織構造を画面上で編集し、**下書き → 予約プラン → 実行**の 3 段階で
Lark Contact API へ安全に書き戻す管理ツールです。

> 変更は「実行」を押すまで Lark に一切反映されません。いつでも取り消せます。

## 主な機能

- **3 つの表示スタイル**: 組織図（ツリー）／一覧（アウトライン）／部門ボード
- **部門・メンバーの編集**: ドラッグ移動、部門の追加/改名/削除、メンバーの異動・兼任追加・役職編集
- **Lark 準拠のデータモデル**: 主/副責任者、主部門、兼任、上長（レポートライン）、在籍ステータス、雇用形態
- **CSV 一括インポート**: 部門・メンバー（テンプレート同梱、Shift_JIS 対応）
- **予約プラン台帳**: 変更内容・実行結果・監査ログを Base（多維表格）に記録
- **dry-run**: 実際に送信される API リクエストを、書き込みせずに確認
- **退職時の資源引継**: ドキュメント・カレンダー・グループ等の移管先を指定可能

## 構成

```
public/          フロントエンド（d3-org-chart ベース・依存なしの素の JS）
server.js        ローカル開発用サーバー（Express + lark-cli）
worker/          本番用 Cloudflare Worker（SSO + 管理者限定・lark-cli 非依存）
  src/lark.js      Lark API クライアント
  src/auth.js      SSO・管理者判定・セッション
  src/service.js   中核ロジック（server.js と共通）
  src/index.js     ルーティング・認可
```

## セットアップ

### 1. Lark アプリの準備（手動）

1. 開発者コンソールでアプリを作成
2. 権限（スコープ）を付与: `contact:contact`、Base 系（`base:record:*`）ほか
3. **管理コンソール → アプリ管理 → 通訊録データ権限範囲**を「全社員」に設定
   （ここが全社になっていないと、一部の部門でメンバーを取得できません）
4. アプリを公開（社内向け）

### 2. Base（多維表格）の準備

`config.example.json` を参考に、6 つのテーブル（部門／メンバー／変更計画／
変更オペレーション／監査ログ／CSV インポート履歴）を作成し、
`config.json` にトークンとテーブル ID を設定します。

### 3. ローカル開発

```bash
npm install
npm run dev            # http://localhost:5178
```

### 4. 本番デプロイ（Cloudflare Workers）

```bash
cd worker
npm install
cp wrangler.example.toml wrangler.toml    # テーブル ID などを記入
npx wrangler login
npx wrangler kv namespace create SESSIONS # 出力された id を wrangler.toml へ
npx wrangler secret put LARK_APP_ID
npx wrangler secret put LARK_APP_SECRET
npx wrangler secret put BASE_TOKEN
npx wrangler deploy
```

デプロイ後、Lark 開発者コンソールに**リダイレクト URL**を登録してください:
`https://<デプロイ先>/auth/callback`

## セキュリティ

- **SSO ログイン必須**。Lark の `is_tenant_manager` で**管理者以外はログインを拒否**します
- すべての API に認可チェックを適用（未ログイン 401 / 権限不足 403）
- 秘密情報（App Secret 等）はリポジトリに含めず、`wrangler secret` で登録します

## Lark の仕様上の制約（実測で確認済み）

- **組織の書き込みには tenant_access_token が必要**です。ユーザートークンでは
  `99991668 user access token not support` となり書き込めません。
  そのため実行者はアプリ側の監査ログに記録します。
- `is_primary_dept` は書き込み不可の派生値です。主部門は `orders[].department_order`
  を最大にすることで設定します。
- 部門の `leaders` は全置換されるため、副責任者を失わないよう差分マージしています。
- メンバーを一括列挙する API はありません（`find_by_department` の `fetch_child` は
  効きません）。全員を取得するには部門ごとの呼び出しが必要です。

## ライセンス

社内利用を想定した非公開プロジェクトです。
