# CRAM Books MCP - 開発ガイド（簡潔版）

このプロジェクトは、学習塾で運用しているGoogleスプレッドシート/ドキュメントを、LLM（Claude）から「提案→承認→実行」の安全な流れで操作する仕組みです。

## 📌 開発原則（最重要）

1) DRYの徹底
- 重複コード禁止。1つだけをソースオブトゥルースにする
- 共通機能は適切に抽象化。冗長/未使用コードは即削除

2) コード品質・運用
- 必要最低限のファイルのみ。デバッグ用は使用後すぐ削除
- 簡潔で読みやすい実装。進捗・作業ログは `PROGRESS.md` に記録
- タスクは小さく分割→検証→クリーンアップ→意味ある単位でコミット

3) 禁止事項
- 冗長なコード/重複機能/不要なファイルの放置
- タスク完了の記録漏れ、ガイドの逸脱

## 🎯 目的と範囲

- 目的: 既存シートは変更せず、LLMから安全に操作
- コンセプト:
  1. LLMが呼びやすい小さなAPI群
  2. JSONで入出力を統一
  3. 承認付きの実行フロー
- 現在スコープ: 参考書データの検索・取得・登録・絞り込み

## 🏗️ 全体アーキテクチャ

```
[Claude (チャットUI)]
      │  (Remote MCP/HTTP)
      ▼
[Cloud Run 上の MCP サーバー]  ←(ENV)→  EXEC_URL
      │  (HTTP GET/POST, JSON)
      ▼
[Apps Script(GAS) Webアプリ] ──────────→ [Google スプレッドシート(参考書マスター)]
```

## ✅ 現状の進捗と仕様要約（重要）

- GAS 側の `books.get` は GET で複数IDに対応（`doGet` が `e.parameters` を解釈）。
  - 例: `?op=books.get&book_ids=gMB017&book_ids=gMB018` または `?book_id=...` を複数付与。
- MCP 側の `books_get` ツールは単一/複数ID両対応に更新済み（Cloud Run にデプロイ済）。
- POST リクエストについては、匿名公開WebAppで 302 → `googleusercontent.com/macros/echo` に転送され HTML 応答になる挙動を確認（GET は正常）。
  - 当面は GET で統一運用（複数IDもGETで可）。
  - 将来は Execution API（scripts.run, OAuth）経由のPOSTを検討（認証/HMACも並行）。


## 📁 プロジェクト構造

```
cram-books-mcp/
├── apps/
│   ├── gas/                    # Google Apps Script
│   │   ├── dist/
│   │   │   ├── book_master.js  # リモートGASの正（clasp pull/push 対象）
│   │   │   └── appsscript.json # マニフェスト
│   │   ├── .clasp*.json        # Script ID/設定
│   │   └── .claspignore        # push対象はdistのみ
│   └── mcp/                    # MCP サーバー (Python)
│       ├── server.py
│       ├── pyproject.toml
│       ├── Dockerfile
│       └── .env.example
├── AGENTS.md, README.md, PROGRESS.md, CLAUDE.md
└── .gitignore
```

## 🚀 セットアップ（最短）

前提: Node.js 18+, Python 3.12+, Googleアカウント, GCP, clasp (`npm i -g @google/clasp`)

### 1) GAS セットアップ（dist をソースオブトゥルースに）

```bash
cd apps/gas

# 依存関係のインストール
npm install

# claspでGoogleアカウントにログイン
npm run clasp:login

# Google Apps Script APIを有効化
# https://script.google.com/home/usersettings でAPIを有効化

## 既存のリモートを正として同期
clasp clone <SCRIPT_ID> --rootDir dist  # 既存ならpullだけでもOK

# Script IDを設定ファイルに記入
# .clasp.dev.json と .clasp.prod.json の scriptId を更新

# スプレッドシートIDを設定
# src/index.ts の CONFIG.BOOKS_FILE_ID を更新

# dist のみ push 対象（`.claspignore` 参照）
clasp push

## Webアプリ公開（初回のみ）
# 種類:ウェブアプリ / 実行ユーザー:自分 / アクセス:全員（匿名可）
# デプロイIDURLを控える（scriptIdURLではなくdeploymentIdURL）
```

### 2) MCP サーバーセットアップ

```bash
cd apps/mcp

# Python環境のセットアップ
uv venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 依存関係のインストール
uv sync

# 環境変数の設定
cp .env.example .env
# .env ファイルの EXEC_URL を GAS Web App URL に更新
# 例: EXEC_URL=https://script.google.com/macros/s/AKfycb.../exec

# ローカルで起動
uv run python server.py
```

## 📋 API 仕様（要点）

### GAS Web API エンドポイント

### GET

| エンドポイント | 説明 | パラメータ |
|------------|------|----------|
| `?op=ping` | ヘルスチェック | なし |
| `?op=books.find&query={検索語}` | 参考書の検索 | query: 検索キーワード |
| `?op=books.get&book_id={ID}` | 参考書の詳細取得 | book_id: 参考書ID |
| `?op=books.get&book_ids={ID}&book_ids={ID}` | 参考書の詳細取得（複数） | book_ids: 繰り返し指定可 |
| `?op=health` | システムステータス | なし |

### POST

```json
// books.create - 参考書の新規登録
{
  "op": "books.create",
  "title": "本のタイトル",
  "subject": "教科",
  "unit_load": 2,
  "monthly_goal": "1日30分",
  "chapters": [
    {"title": "第1章", "range": {"start": 1, "end": 20}, "numbering": "問"}
  ]
}

// books.filter - 条件による絞り込み
{
  "op": "books.filter",
  "where": {"教科": "数学"},      // 完全一致
  "contains": {"参考書名": "青チャート"}, // 部分一致
  "limit": 10
}

// books.update - 参考書の更新（メタ/章の完全置換）
{
  "op": "books.update",
  "book_id": "gMB017",
  "updates": {
    "title": "新しいタイトル",
    "monthly_goal": "1日60分",
    "unit_load": 3,
    "chapters": [
      {"title": "改・第1章", "range": {"start": 1, "end": 10}, "numbering": "問"}
    ]
  }
}
```

### レスポンス例（抜粋）

#### books.find
```json
{
  "ok": true,
  "op": "books.find",
  "data": {
    "query": "青チャート",
    "candidates": [
      {
        "book_id": "gMB017",
        "title": "青チャートⅠ（新課程）",
        "subject": "数学",
        "score": 0.86,
        "reason": "partial"
      }
    ],
    "top": {"book_id": "gMB017", ...},
    "confidence": 0.645
  }
}
```

#### books.get
```json
{
  "ok": true,
  "op": "books.get",
  "data": {
    "book": {
      "id": "gMB017",
      "title": "青チャートⅠ（新課程）",
      "subject": "数学",
      "monthly_goal": {
        "text": "1例題30分",
        "per_day_minutes": null,
        "days": null,
        "total_minutes_est": null
      },
      "unit_load": 2,
      "structure": {
        "chapters": [
          {
            "idx": 1,
            "title": "数と式",
            "range": {"start": 1, "end": 43},
            "numbering": "問"
          }
        ]
      }
    }
  }
}
```

#### books.get（複数ID）
```json
{
  "ok": true,
  "op": "books.get",
  "data": {
    "books": [
      { "id": "gMB017", "title": "...", "subject": "..." },
      { "id": "gMB018", "title": "...", "subject": "..." }
    ]
  }
}
```

#### books.filter（グルーピング済み, 書籍単位）
```json
{
  "ok": true,
  "op": "books.filter",
  "data": {
    "books": [
      {
        "id": "gMB001",
        "title": "はじはじ数1新課程(確認テスト用)",
        "subject": "数学",
        "monthly_goal": {"text":"1day 3時間×17day","per_day_minutes":180, "days": null, "total_minutes_est": null},
        "unit_load": 0.34,
        "structure": {"chapters": [ {"idx":1, "title":"指数法則…", "range": {"start":1, "end":2} } ]},
        "assessment": {"book_type":"", "quiz_type":"", "quiz_id":"..."}
      }
    ],
    "count": 1,
    "limit": 10
  }
}
```

#### books.create（応答例）
```json
{
  "ok": true,
  "op": "books.create",
  "data": { "id": "gTMP001", "created_rows": 3 }
}
```

#### books.update（応答例）
```json
{
  "ok": true,
  "op": "books.update",
  "data": { "book_id": "gTMP001", "updated": true }
}
```

備考（books.filter）
- 結果は「行」ではなく「書籍単位（参考書IDごと）」にグルーピングして返します。
- 判定は、指定した列に対してその書籍の“全行（親行＋章行）”の値を集計し、
  - where: いずれかの行で完全一致
  - contains: いずれかの行で部分一致
  をすべて満たす書籍のみ採用します。
- 列名はシートの見出し（例: 参考書名, 教科, 章の名前 など）をそのまま指定してください（大文字小文字/全角半角/前後空白は吸収）。

### MCP ツール（公開中）

| ツール名 | 説明 | 主要引数 | 返り値 |
|---------|------|---------|--------|
| `books_find` | 参考書の検索 | `query: string` | books.find のレスポンス |
| `books_get` | 参考書の詳細取得 | `book_id: string` または `book_ids: string[]` | books.get のレスポンス |
| `books_create` | 参考書の新規登録 | `title: string`, `subject: string`, `unit_load?: number`, `monthly_goal?: string`, `chapters?: any[]`, `id_prefix?: string` | 作成ID ほか |
| `books_filter` | 条件による絞り込み | `where?: object|string`, `contains?: object|string`, `limit?: number` | フィルタ結果（書籍単位, books配列） |
| `books_update` | 参考書の更新（二段階） | `book_id: string`, `updates?: object`, `confirm_token?: string` | プレビュー or 確定結果 |
| `books_delete` | 参考書の削除（二段階） | `book_id: string`, `confirm_token?: string` | プレビュー or 確定結果 |
| `books_list` | 全参考書の親行を一覧 | `limit?: number` | `{ books:[{id,subject,title}], count }` |
| `tools_help` | 公開ツールの使い方ガイド | なし | ツール一覧（引数/例/注意） |

### 生徒マスター（Students）

目的: 生徒マスター（スプレッドシート: STUDENTS_FILE_ID）をLLMから読み書きできる最小APIを提供し、今後スピードプランナー/面談メモとの連携に発展させる。

#### GAS エンドポイント（students.*）
- `students.list(limit?)`: 親行一覧（id/name/grade/planner_sheet_id/meeting_doc_id/tags と row原文）
- `students.find(query, limit?)`: 氏名/IDの曖昧検索（単純 exact/partial）
- `students.get(student_id | student_ids[])`: 単一/複数IDで取得
- `students.filter(where?, contains?, limit?)`: where=完全一致 / contains=部分一致（見出し名はシート見出し。大文字/全角半角は吸収）
- `students.create(record, id_prefix?)`: 末尾に1行追加（ID自動採番。既定接頭辞 's'、`id_prefix`で上書き可）。`record` は「見出し→値」の柔軟入力
- `students.update(student_id, updates? | confirm_token?)`: 二段階（プレビューで差分/トークン→確定で上書き）
- `students.delete(student_id, confirm_token?)`: 二段階（プレビュー→確定で該当行を削除）

見出しのゆらぎ（例）
- id: 生徒ID/ID/id、name: 氏名/名前/生徒名/name、grade: 学年/grade
- planner_sheet_id: スピードプランナーID/PlannerSheetId/プランナーID、meeting_doc_id: 面談メモID/MeetingDocId/面談ドキュメントID

#### MCP ツール（students_*）
- `students_list(limit?, include_all?)`: 既定は「在塾のみ」。退塾・講師を含む全件は `include_all=true`。
- `students_find(query, limit?, include_all?)`: 既定は在塾のみ（名前の contains）。`include_all=true` で全件。
- `students_get(student_id | student_ids[])`: 単/複IDで取得（スコープ制限なし）。
- `students_filter(where?, contains?, limit?, include_all?)`: 既定は在塾のみ（呼び出し側で Status が指定されていない場合に自動付与）。`include_all=true` で全件。
- `students_create(record, id_prefix?)`, `students_update(...)`, `students_delete(...)`: GAS と同様の二段階/採番規則。

実装メモ
- 既定スコープ（在塾のみ）は MCP 側で実現（LLMに優しい既定値）。`include_all=true` 明示時にだけ全件に拡張。
- 将来、スピードプランナー/面談メモには resolver API を追加予定（students_overview, planner_get, notes_get/summarize など）。

### デプロイ運用（Cloud Run）

トラブルを減らすコツ
- PROJECT_ID の自動検出: `scripts/deploy_mcp.sh` は `PROJECT_ID` が未設定/placeholder の場合、`gcloud config get-value project` を自動採用。`source scripts/gcloud_env.example` で上書きしてしまってもフォールバック。
- 406は正常: `/mcp` をブラウザ/curlで叩くと `406 Not Acceptable`（SSE必須）。MCPクライアントやInspectorではOK。
- 302/303の追従: GAS WebApp はリダイレクトするため、クライアントは follow_redirects を有効化（httpxは True、curl は `-L`）。
- EXEC_URL は `.prod_deploy_id` から自動解決（スクリプト内）。必要なら手動で `export EXEC_URL=.../exec`。
- 起動失敗の調査: Cloud Run リビジョンのログで SyntaxError/ImportError を確認し、修正→再デプロイ。
  - 例: `gcloud logging read --limit 200 "resource.type=cloud_run_revision AND resource.labels.service_name='cram-books-mcp'"`

手順（最短）
```
# 推奨: current project に設定済みなら env不要
scripts/deploy_mcp.sh

# 明示したい場合
PROJECT_ID="cram-books-mcp-0830" REGION="asia-northeast1" SERVICE="cram-books-mcp" scripts/deploy_mcp.sh

# 確認（406ならOK）
SERVICE_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
curl -i "$SERVICE_URL/mcp"
```

### LLM向けガイド: books.create / books.update の安全な使い方

LLMから作成・更新を行う際に起きやすい入力ミスを防ぐため、以下のルールと手順に従ってください。

- 基本ルール（共通）
  - JSONのキーは指定どおり（小文字＋アンダースコア）を使用する。例: `unit_load`, `monthly_goal`, `chapters`。
  - 数値は数値型で渡す（文字列ではなく）。例: `unit_load: 2`（× `"2"`）。
  - 章は「完全置換」です。`updates.chapters` を渡すと既存の章構成は全て置き換わります。
  - 章の配列は最小でも1章からを推奨（空配列も可だが、目的が「章の全消去」でない限り避ける）。
  - 章の各要素は以下の最小形を守る:
    - `{"title":"第1章","range":{"start":1,"end":20}}`（`numbering` は任意）
  - 本シートでは「親行に第1章の情報」が入ります（以降の章は下の行に続きます）。

- books.create（新規作成）
  - 最小例（自動ID付与）
    ```json
    {
      "op": "books.create",
      "title": "テスト本",
      "subject": "数学",
      "unit_load": 2,
      "monthly_goal": "1日30分",
      "chapters": [
        {"title": "第1章", "range": {"start": 1, "end": 20}}
      ]
    }
    ```
  - 任意で `id_prefix` を付与可能（例: `"gTMP"`）。未指定の場合は教科/題名から推定し、`gMB001` のように採番。
  - 作成結果: `{ ok:true, data: { id: "gXXnnn", created_rows: N } }`。最初の章は親行に入り、以降は子行として追記されます。

- books.update（二段階・安全）
  - 手順:
    1) プレビュー（差分確認）
       ```json
       {"op":"books.update","book_id":"gMB017","updates":{"title":"（改）","unit_load":3}}
       ```
       → `requires_confirmation: true` と `confirm_token` が返る。
    2) 確定（トークン使用）
       ```json
       {"op":"books.update","book_id":"gMB017","confirm_token":"..."}
       ```
  - 章構成の置換（要注意）：
    - 例：章を2→3章に差し替える
      ```json
      {"op":"books.update","book_id":"gMB017",
       "updates": {"chapters": [
          {"title":"第1章（改）","range":{"start":1,"end":10}},
          {"title":"第2章（改）","range":{"start":11,"end":20}},
          {"title":"第3章（新）","range":{"start":21,"end":30}}
       ]}}
      ```
      - 親行に第1章、子行に第2章以降が入ります。
      - プレビューでは「子行の増減」を `chapters.from_count/to_count` として提示します。

- よくある誤りと回避策
  - 誤: `updates` を渡さずに確定リクエストを行う → 正: まずプレビューで `confirm_token` を取得し、確定では `confirm_token` のみ送る。
  - 誤: `book_ids`（複数）で update → 正: update は単一ID（`book_id`）。複数更新は個別に実行。
  - 誤: 章の `range` を `{start:"1", end:"10"}` と文字列で渡す → 正: 数値で。
  - 誤: `chapters` を差分（追記）と思って一部だけ渡す → 正: 完全置換。全章を配列に展開して送る。
  - 誤: `title` を空文字で上書き → 正: 変更しないキーは `updates` に含めない（未指定）。

- LLMプロンプト指針（推奨）
  - 「提案→確認→実行」の順で、必ずプレビュー結果（差分/行数）をユーザーに提示して承認を得る。
  - 章を編集する際は、「最終的な章一覧」を自然言語で整えた上で、JSONに落としてからプレビュー。
  - 既存データの誤破壊を防ぐため、`updates` は最小限の差分だけに限定する（不要な空文字上書きを避ける）。


#### MCP ツール詳細（二段階フロー）

- books_update:
  - プレビュー: `book_id`, `updates` → `requires_confirmation: true`, `preview.meta_changes`, `preview.chapters`, `confirm_token`
  - 確定: `book_id`, `confirm_token` → `{ updated: true/false }`
  - updates: `title`, `subject`, `monthly_goal`, `unit_load`, `chapters: Chapter[]`（完全置換）
  - 備考: confirm_token は5分有効
- books_delete:
  - プレビュー: `book_id` → `requires_confirmation: true`, `preview.delete_rows`, `preview.range`, `confirm_token`
  - 確定: `book_id`, `confirm_token` → `{ deleted_rows }`

#### 自動ID付与（books.create）

- 規則: `g` + サブコード(1–3文字) + 3桁連番（例: gEC062）
- サブコード推定（subject/title から）:
  - 英語: EB(文法)/EC(長文)/EK(解釈)/ET(語彙)/EW(英作文)/EL(リスニング)
  - 数学: MB, 国語: JG/JO, 社会: JH/WH/GG/GE, 理科: CH/CHB/PH/PHB/BI/BIB/ESB
- 同サブコード内で最大番号+1を採番。`id_prefix` 指定時はそれを優先。

#### MCP からの実行例（プレビュー→確定）

- 更新プレビュー: `books_update({"book_id":"gEC063","updates":{"title":"更新テスト（改）","unit_load":2}})`
- 更新確定: `books_update({"book_id":"gEC063","confirm_token":"..."})`
- 削除プレビュー: `books_delete({"book_id":"gEC063"})`
- 削除確定: `books_delete({"book_id":"gEC063","confirm_token":"..."})`

## 💻 開発フロー（チートシート）

### GAS

```bash
cd apps/gas

# TypeScriptをビルド
clasp pull                    # リモート→ローカル同期（dist）
clasp push                    # ローカル→リモート反映（dist）
clasp deployments             # デプロイID一覧
clasp deploy -i <DEPLOY_ID>   # 既存デプロイIDを維持して再デプロイ
clasp open                    # エディタを開く

#### ソースオブトゥルースとビルド
- ソースの正: `apps/gas/src`（TypeScript）
- ビルド出力: `apps/gas/dist/book_master.js`（GASにpushされるファイル）
- 禁止: `dist/`の手編集（常に`npm run build`で生成）
- `.gitignore`: `apps/gas/dist/` はビルド成果物として無視（Gitに載せない）

#### 標準の検証フロー（毎回これを実行）
- 変更→ビルド→push→新規デプロイ→curlで検証をワンコマンド化
- スクリプト: `apps/gas/deploy_and_test.sh`
  - GET 例: `apps/gas/deploy_and_test.sh 'op=books.find&query=現代文レベル別'`
  - POST例: `apps/gas/deploy_and_test.sh -d '{"op":"books.find","query":"青チャート"}'`
  - 役割: `npm run build` → `clasp push` → `clasp deploy`（新規） → `curl -L`
  - 出力: `DEPLOY_ID/BASE_URL`（stderr）とJSONレスポンス（stdout）

#### デプロイ前提の自動テスト（標準運用）
- 方針: 「関数を変更→毎回、新規デプロイを作成→curlで叩いて確認」
- スクリプト: `apps/gas/deploy_and_test.sh`
  - 役割: 最新HEADをpush→新規デプロイ作成→WebAppをcurlで叩く
  - GET例: `apps/gas/deploy_and_test.sh 'op=books.find&query=現代文レベル別'`
  - POST例: `apps/gas/deploy_and_test.sh -d '{"op":"books.find","query":"青チャート"}'`
  - 出力: `DEPLOY_ID` と APIのJSONレスポンス
```

#### テスト方法（重要）

```bash
# GAS Web App のURLを取得
clasp deployments  # 例: AKfycb... @8 がWebAppデプロイ
curl -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec?op=books.find&query=青チャート"
## 推奨: 上記スクリプトで一発実行（毎回これを使う）
apps/gas/deploy_and_test.sh 'op=books.find&query=青チャート'

# POSTテスト（書き方の例）
# どちらも可：a) -d だけ（推奨）、b) -X POST と -d を併用

# a) -d だけでPOST（推奨）
curl -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec" \
  -H "Content-Type: application/json" \
  -d '{"op":"books.find","query":"青チャート"}'

# b) -X POST 指定でも可（スクリプト付属のヘルパー）
apps/gas/deploy_and_test.sh -X POST -d '{"op":"books.find","query":"青チャート"}'

## 出力のチェック（GET/POSTの実例）

# 1) GET: books.get 複数ID（e.parametersを活用）
apps/gas/deploy_and_test.sh 'op=books.get&book_ids=gMB017&book_ids=gMB018'

# 2) POST: books.get 複数ID（JSONで配列）
apps/gas/deploy_and_test.sh -X POST -d '{"op":"books.get","book_ids":["gMB017","gMB018"]}'

# 3) POST: books.find（クエリ検索）
apps/gas/deploy_and_test.sh -d '{"op":"books.find","query":"青チャート"}'

# 4) POST: books.filter（条件フィルタ）
apps/gas/deploy_and_test.sh -d '{"op":"books.filter","where":{"教科":"数学"},"limit":3}'

# ヘッダ込みで確認したいときは -i を付与（ステータス/リダイレクト観測用）
curl -i -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec?op=ping"

注意: スクリプトIDURLではなく、デプロイIDURLを使用。`-L`で302に追従。

補足:
- `clasp run` は環境によって出力取得が不安定なため、標準運用は「新規デプロイ→curl検証」とする
- devMode（`&devMode=true`）はログイン済みブラウザでのみ有効。CLI検証はデプロイURL推奨
```

### MCP

#### ローカル実行

```bash
cd apps/mcp
source .venv/bin/activate

# サーバー起動
python server.py
# または
uv run python server.py

# MCP Inspector でテスト
npx @modelcontextprotocol/inspector
# URL: http://localhost:8080/mcp
```

#### 新しいツールの追加

`server.py` に新しいツールを追加:

```python
@mcp.tool()
async def books_update(book_id: Any, updates: Any) -> dict:
    """
    参考書情報を更新する
    """
    bid = _coerce_str(book_id, ("book_id", "id"))
    if not bid:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": "book_id is required"}}
    
    # updatesをJSONとして扱う
    update_data = updates if isinstance(updates, dict) else {}
    
    return await _post({
        "op": "books.update",
        "book_id": bid,
        **update_data
    })
```

## 🚢 Cloud Run デプロイ（要点）

### Docker ビルド

```bash
cd apps/mcp

# Dockerイメージをビルド
docker build -t cram-books-mcp .

# ローカルでテスト
docker run -p 8080:8080 -e EXEC_URL=$EXEC_URL cram-books-mcp
```

### Cloud Run デプロイ

```bash
# よく使う環境変数（scripts/gcloud_env.example にも保存）
export PROJECT_ID="your-project-id"
export REGION="asia-northeast1"
export SERVICE="cram-books-mcp"
# EXEC_URL は apps/gas/.prod_deploy_id から自動生成されます（スクリプト内）。必要なら上書き:
# export EXEC_URL="https://script.google.com/macros/s/<DEPLOY_ID>/exec"

# ソースデプロイ（Dockerfile利用）
source scripts/gcloud_env.example  # または PROJECT_ID/REGION/SERVICE を export
scripts/deploy_mcp.sh

# 出力例
# SERVICE_URL=https://<CloudRunService>.a.run.app
# curl -i "$SERVICE_URL/mcp"   # 406=正常（Accept指定なし）

補足: 過去の起動失敗（PORT未待受）は `uvicorn` 不足が原因。Dockerfile に `uvicorn`/`fastmcp` を追加し、`server.py` で `uvicorn.run(mcp.streamable_http_app(), host="0.0.0.0", port=$PORT)` 起動で解消。
```

## 🔌 Claude 接続

### カスタムコネクタの作成

1. Claude の設定画面を開く
2. 「カスタムコネクタ」を選択
3. 以下を設定:
   - **名前**: CRAM Books
   - **リモートMCPサーバーURL**: `https://<Cloud Run ServiceURL>/mcp`
   - **認証**: なし（今後HMAC実装予定）
4. 有効化

### 使用例

```
Claude: 青チャートの数学の参考書を検索してください

> books_find を使用して検索します...
> 青チャートⅠ（新課程）が見つかりました

Claude: その参考書の詳細を教えてください

> books_get を使用して詳細を取得します...
> 章構成: 第1章 数と式（問1-43）...
```

## 🛠️ トラブルシューティング（抜粋）

### よくあるエラーと対処法

| エラー | 原因 | 対処法 |
|--------|------|--------|
| `404/アクセス不可` | GASの公開設定が「自分のみ」 | Webアプリを「全員」に変更し再デプロイ |
| `Moved Temporarily (302)` | Google Apps Script の仕様 | curl/HTTPクライアントで `-L` or `follow_redirects=True` |
| `PORT=8080で待受失敗` | コンテナがポートバインドしない | `uvicorn.run(..., host="0.0.0.0", port=$PORT)` で自前起動 |
| `EXEC_URL is not set` | ENV 未設定/変数名ミス | `--set-env-vars EXEC_URL=<実URL>` を再設定 |
| `/mcp` 叩いて `406` | Accept ヘッダ不一致 | 正常。MCPクライアントで接続すればOK |
| ツールが見えない | MCP側に未登録/再デプロイ漏れ | `@mcp.tool()` 追加→再ビルド→再デプロイ |
| `User has not enabled the Apps Script API` | Apps Script API未有効 | https://script.google.com/home/usersettings で有効化 |
| TypeScriptの型エラー | 型定義不足 | `npm install @types/google-apps-script` を実行 |
| デプロイしても変更が反映されない | キャッシュ | `npm run deploy:dev` で新しいデプロイメントを作成 |
| ImportError | Python依存関係不足 | `uv sync` で依存関係を再インストール |

### デバッグ方法

#### GAS
- GASエディタでログを確認: `npm run open:dev`
- Stackdriver Loggingでエラーを確認
- `console.error()` でエラーログ出力

#### MCP
- ローカルで `python server.py` を実行してログ確認
- Cloud Run のログ: `gcloud run logs read --service=$IMAGE`
- `print(..., file=sys.stderr)` でエラーログ出力

#### MCP/EXEC_URL 運用（固定URL方式・推奨）
- 目的: MCPは`EXEC_URL`へGAS WebAppをフォワードするため、URL（デプロイIDURL）が変わらないように運用する
- 方針: 本番のWebAppデプロイは「既存デプロイIDを維持して再デプロイ」する（`clasp deploy -i <PROD_DEPLOY_ID>`）
- 初期設定（本番Cloud Run; 初回のみ）:
  - 固定デプロイIDURLを`EXEC_URL`に設定してデプロイ
  - 例:
    - `gcloud run deploy cram-books-mcp \
       --region asia-northeast1 \
       --image <現行の本番イメージ> \
       --set-env-vars EXEC_URL="https://script.google.com/macros/s/<PROD_DEPLOY_ID>/exec" \
       --allow-unauthenticated --timeout=300 --port=8080`
- 本番GAS更新（毎回）:
  - `cd apps/gas && npm run build && clasp push && clasp deploy -i <PROD_DEPLOY_ID>`
  - URLは不変のため、Cloud Run側の再デプロイや`EXEC_URL`更新は不要（MCPコード更新時のみ再デプロイ）
- ローカルMCP（任意）:
  - `apps/mcp/.env`の`EXEC_URL`を固定URLに設定し、`uv run python server.py`
- 確認:
  - `gcloud run services describe cram-books-mcp --region asia-northeast1 \
     --format='value(spec.template.spec.containers[0].env)'`

## 📝 ベストプラクティス（抜粋）

### TypeScript (GAS)

1. **型定義を活用**
   ```typescript
   type BookData = {
     id: string;
     title: string;
     author?: string;
     subject: string;
     unit_load: number;
   };
   ```

2. **エラーハンドリング**
   ```typescript
   try {
     const sheet = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID)
       .getSheetByName(CONFIG.BOOKS_SHEET);
     if (!sheet) {
       return createErrorResponse("SHEET_NOT_FOUND", "Books sheet not found");
     }
     // 処理
   } catch (error) {
     console.error("Error:", error);
     return createErrorResponse("ERROR_CODE", String(error));
   }
   ```

3. **レスポンスの統一**
   ```typescript
   function createSuccessResponse(data: any): ApiResponse {
     return { ok: true, data };
   }
   
   function createErrorResponse(code: string, message: string): ApiResponse {
     return { ok: false, error: { code, message } };
   }
   ```

### Python (MCP)

1. **入力検証とエラーハンドリング**
   ```python
   def _coerce_str(x: Any, keys: tuple[str, ...] = ()) -> str | None:
       """文字列への変換と引用符の除去"""
       if isinstance(x, str): 
           return _strip_quotes(x)
       if isinstance(x, dict):
           for k in keys:
               v = x.get(k)
               if isinstance(v, str): 
                   return _strip_quotes(v)
       return None
   ```

2. **環境変数の遅延取得**
   ```python
   def _exec_url() -> str:
       url = os.environ.get("EXEC_URL")
       if not url:
           raise RuntimeError("EXEC_URL is not set")
       return url
   ```

3. **HTTPクライアントの設定**
   ```python
   async with httpx.AsyncClient(
       timeout=30, 
       follow_redirects=True  # 302リダイレクト対策
   ) as client:
       r = await client.get(url, params=params)
       r.raise_for_status()
       return r.json()
   ```

## 🔒 ロードマップ（要約）

### 実装予定

1. **認証機能**
   - 固定トークン or HMAC をHTTPヘッダーに付与
   - GAS側で検証
   - Claude側のコネクタに固定ヘッダーを追加

2. **承認フロー**
   - 「提案→差分表示→承認→書き込み」のUIテンプレート
   - `books.update` / `students.update` に dry-run モード追加

3. **観測性の向上**
   - Cloud Run のログに `mcp-session-id` や `op` を付与
   - 失敗レスポンスに一意の `error_id` を付与
   - 相関ログの実装

4. **パフォーマンス最適化**
   - Cloud Run 最小インスタンス=1 でコールドスタート低減
   - シートアクセスのヘッダー列キャッシュ
   - バッチ処理の実装

5. **機能拡張**
   - 生徒マスター API (`students.find/get/create/update/filter`)
   - 参考書→学習計画への Resolver
   - Playbook（YAML）によるノウハウの構造化
   - RAG との併用

## 📚 参考リンク

- [clasp公式ドキュメント](https://github.com/google/clasp)
- [Google Apps Script リファレンス](https://developers.google.com/apps-script/reference)
- [MCP (Model Context Protocol)](https://github.com/anthropics/mcp)
- [Cloud Run ドキュメント](https://cloud.google.com/run/docs)
- [FastMCP](https://github.com/jlowin/fastmcp)

## 🤖 Claude での利用（伝達用メモ）

このプロジェクトで作業する際は、以下の情報を Claude に伝えてください：

1. **プロジェクトの目的**: 学習塾のスプレッドシート管理システム
2. **プロジェクト構造**: モノレポ構造（apps/gas と apps/mcp）
3. **技術スタック**: TypeScript (GAS), Python (MCP), esbuild, clasp
4. **環境**: 開発(dev)と本番(prod)の分離
5. **デプロイ先**: Cloud Run（MCP）、Google Apps Script（API）

### よく使うコマンド

```bash
# GAS開発
cd apps/gas && npm run dev

# MCPローカル実行
cd apps/mcp && uv run python server.py

# APIテスト（リダイレクト追従必須）
curl -L "https://script.google.com/macros/s/.../exec?op=books.find&query=test"

# Cloud Run デプロイ
gcloud run deploy cram-books-mcp \
  --source . \
  --region asia-northeast1 \
  --set-env-vars EXEC_URL=$EXEC_URL

# ログ確認
gcloud run logs read --service=cram-books-mcp
```

## 📝 開発履歴メモ

## 🧭 Git/GitHub 運用（簡易）

- ブランチ: 原則 `main`。小粒にコミットし、意味のあるメッセージにする
- 基本コマンド:
  - 状態確認: `git status`
  - 差分確認: `git diff` / `git diff --staged`
  - 追加: `git add -A`
  - コミット: `git commit -m "feat: ... | fix: ... | docs: ..."`
  - 取得・整列: `git pull --rebase origin main`
  - 送信: `git push origin main`
- 初回リモート設定（必要時）: `git remote add origin <git@github.com:ORG/REPO.git>`
- 方針: DRYとクリーンアップの徹底。不要/重複/一時ファイルはコミットしない


- 302リダイレクト問題: `follow_redirects=True` で解決
- Cloud Run ヘルスチェック: `uvicorn.run()` で0.0.0.0:$PORTバインド
- EXEC_URL設定: プレースホルダ混入に注意（実URLを設定）
- Claude接続: `/mcp` エンドポイントを指定（406は正常）

### POST 運用・極小サマリ（重要）
- WebApp 公開: 「全員（匿名可）」＋固定デプロイID運用（`clasp deploy -i <ID>`）
- OAuth 同意画面: テストモードの場合は実行ユーザーをテスターに追加（403 access_denied 回避）
- 初回承認: エディタから `authorizeOnceEntry` 実行
- curl: `-L + -d`（`-X POST` 強制しない）。302/303後のPOST維持を強制しない
- MCP/HTTPクライアント: follow_redirects=True（httpx）

### コード配置マップ（GAS）
- ルーター: `apps/gas/src/index.ts`（doGet/doPost の薄いルーティング＋table.read。authorizeOnce はハンドラへ委譲）
- 設定: `apps/gas/src/config.ts`
- 共通: `apps/gas/src/lib/common.ts`（ok/ng/normalize/toNumberOrNull など）
- ID規則: `apps/gas/src/lib/id_rules.ts`（サブコード推定・連番採番）
- ハンドラ: `apps/gas/src/handlers/books.ts`
  - 実装済み: `booksFind`, `booksGet`, `booksFilter`, `booksCreate`, `booksUpdate`, `booksDelete`
  - ルーターは `apps/gas/src/index.ts`（doGet/doPost）。実体はすべてハンドラに集約。

移設完了: `books.*` の実装はすべて `handlers/books.ts`。`index.ts` は薄いルーターのみ（将来は `students.*` など他ドメインも同様の分割方針）。

### 仕様の要点（最新）
- books.filter のデフォルト件数: limit 未指定＝無制限（全件）
  - 以前の「条件なしは50件」のガードは撤廃。必要時のみ limit を指定。
- 章の配置（create/update）:
  - 親行に「第1章」を記載し、2章目以降を下の行へ追加。
  - update のプレビューでは、子行（第2章以降）の増減数を `chapters.from_count/to_count` に表示。
- 検索の正規化改善（books.find）:
  - 「・／/＋+＆&」などの結合記号を除去して比較。
  - 「漢字 と 漢字」は接続子「と」を除去して比較（例: 「軌跡と領域」≒「軌跡・領域」）。

### 実行API版ツールについて（整理）
- `books_find_exec` / `books_get_exec` は、Apps Script Execution API（scripts.run）経由の実験用エンドポイントでした。
- 現在は MCP から「公開されていません」（ツール一覧に出ない）ため、通常は使用不可です。
- 目的: WebApp POST の挙動検証や将来の認証付き実行のための保守用コード。ユーザー向けの最小構成維持のため非公開化しました。
# 5) POST: books.create（作成→確認）
apps/gas/deploy_and_test.sh -d '{"op":"books.create","id_prefix":"gTMP","title":"テスト本","subject":"数学","unit_load":2,"monthly_goal":"1日30分","chapters":[{"title":"第1章","range":{"start":1,"end":20}}]}'
# 取得確認
apps/gas/deploy_and_test.sh -d '{"op":"books.get","book_id":"gTMP001"}'

# 6) POST: books.update（タイトル変更と章の置換）
apps/gas/deploy_and_test.sh -d '{"op":"books.update","book_id":"gTMP001","updates":{"title":"テスト本（改）","chapters":[{"title":"改・第1章","range":{"start":1,"end":10}}]}}'
