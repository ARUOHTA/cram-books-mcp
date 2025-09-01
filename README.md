# CRAM Books MCP

学習塾で運用している「参考書マスター（Google スプレッドシート）」を、LLM から安全に「提案→承認→実行」で操作するためのモノレポです。GAS（Google Apps Script）で Web API を提供し、MCP（Model Context Protocol）サーバーからHTTPで呼び出します。

```
[LLM (Claude 等)]
      │  (Remote MCP/HTTP)
      ▼
[Cloud Run 上の MCP サーバー]  ←(ENV)→  EXEC_URL
      │  (HTTP GET/POST, JSON)
      ▼
[Apps Script(GAS) WebApp] ──────────→ [Google スプレッドシート(参考書マスター)]
```

## 主な機能
- 参考書の検索・取得・絞り込み・新規作成・更新・削除
- 複数IDの GET（GETクエリの配列対応）
- 更新/削除はプレビュー→承認（トークン）→確定の二段階
- 章配置の統一仕様（親行に第1章、続きは下行）
- 検索は双方向カバレッジ（Q⊆T, T⊆Q + IDF）で表記ゆれに強い
- MCP 側にツール一覧ヘルプ（tools_help）、軽量一覧（books_list）

## ディレクトリ構成
```
cram-books-mcp/
├── apps/
│   ├── gas/                    # Google Apps Script (TypeScript → esbuild → dist)
│   │   ├── src/
│   │   │   ├── index.ts       # doGet/doPost の薄いルーター
│   │   │   ├── handlers/books.ts
│   │   │   ├── lib/{common,id_rules,sheet_utils}.ts
│   │   │   └── tests/dev_tests.ts
│   │   └── dist/               # GAS へ push される成果物（自動生成）
│   └── mcp/                    # MCP サーバー (Python, FastMCP)
│       ├── server.py
│       ├── tests/run_tests.py  # MCP E2E テスト（EXEC_URL を使用）
│       └── Dockerfile
├── scripts/
│   ├── deploy_mcp.sh           # Cloud Run へデプロイ
│   └── gcloud_env.example      # PROJECT_ID, REGION, SERVICE 例
├── AGENTS.md, PROGRESS.md
└── README.md（本ファイル）
```

## セットアップ（最短）
事前: Node.js 18+, Python 3.12+, `uv`, Google アカウント, GCP, clasp

### 1) GAS（WebApp）
```
cd apps/gas
npm install
npm run clasp:login

# 既存 WebApp を dist を正として clone/pull
clasp clone <SCRIPT_ID> --rootDir dist

# スクリプトID/スプレッドシートIDを設定
# apps/gas/.clasp*.json, src/config.ts の BOOKS_FILE_ID

# ビルド→push→デプロイ
npm run build
clasp push
clasp deploy -d prod

# WebApp 公開: 実行ユーザー=自分 / アクセス=全員（匿名）
```

### 2) MCP（Cloud Run）
```
cd apps/mcp

# （ローカル実行）
uv run python server.py  # http://localhost:8080/mcp

# （Cloud Run デプロイ）
cd ../..
source scripts/gcloud_env.example  # PROJECT_ID/REGION/SERVICE を設定
scripts/deploy_mcp.sh              # EXEC_URL は apps/gas/.prod_deploy_id を参照
```

## 環境変数（MCP）
- EXEC_URL（必須）: GAS WebApp のデプロイURL（/exec）
- SCRIPT_ID（任意/実験）: Execution API を使う場合のみ

## MCP ツール（抜粋）
- books_find(query) 検索（曖昧）
- books_get(book_id | book_ids[]) 詳細取得（単/複）
- books_filter(where?, contains?, limit?) 条件絞り込み（書籍単位）
- books_create(title, subject, unit_load?, monthly_goal?, chapters[], id_prefix?) 新規作成
- books_update(book_id, updates? | confirm_token?) 更新（プレビュー→確定）
- books_delete(book_id, confirm_token?) 削除（プレビュー→確定）
- books_list(limit?) 親行一覧（id/subject/title のみ）
- tools_help() 公開ツールの簡易ヘルプ

### Planner（週間管理）
- planner_ids_list / planner_dates_get|propose|confirm / planner_plan_get|propose|confirm / planner_plan_targets / planner_guidance
  - plan_get は metrics（weekly_minutes/unit_load/guideline_amount）を同梱
  - plan_propose は単体/複数（items[]）の両方に対応、confirm は単体/一括を自動判別
  - 書込制約: A非空・週間時間非空・最大52文字、overwrite=falseが既定

注意（create/update; LLM向け）
- chapters は「最終形」を完全指定（追記ではない）
- numbering（番号の数え方）は必ず埋める（空欄禁止）
  - 例: 問/No./講/Lesson など。迷ったら問題番号=「問」／単語=「No.」
- 章またぎの番号の扱い:
  - 原則リセット（各章 start=1）
  - 書籍が連番なら carry-over（次章 start=前章 end+1）
- 第1章は親行、2章以降は下行（GAS 仕様）

## GAS API（内部仕様）
- GET: op=books.find|books.get|health ほか
- GET（配列）: op=books.get&book_ids=ID&book_ids=ID...
- POST: JSON の op に応じて実行（books.*）

## 章配置の仕様（重要）
- 親行（参考書IDのある行）に「第1章」を記入
- 第2章以降は下の行へ追記
- update のプレビューは、子行（第2章以降）の増減を表示

## 検索仕様（books.find）
- exact/phrase/partial に加え、双方向カバレッジ（Q⊆T, T⊆Q）をIDF加重で評価
- 表記ゆれ（助詞/区切り）に頑健。スコア/confidence を返却

## テスト
### GAS（GASエディタの実行メニュー）
- testBooksFind / testBooksGetSingle / testBooksGetMultiple / testBooksFilterMath
- testBooksCreateUpdateDelete（gTMP 作成→更新→削除）

### MCP（E2E; EXEC_URL を使用）
```
export EXEC_URL="https://script.google.com/macros/s/<DEPLOY_ID>/exec"
uv run python apps/mcp/tests/run_tests.py
```
内容: tools_help, books_list, find, get(単/複), filter, create→update(プレビュー→確定)→delete(プレビュー→確定)
および planner（ids/dates/plan_get(統合) / plan_propose(items) / plan_confirm）の疎通

### まとめ処理の小ベンチ（任意）
- GAS: `testPlannerBulkSpeedGAS()`（週2の空欄最大10件を write→revert。所要時間をログ）
- MCP: `BULK_N=12 uv run python apps/mcp/tests/run_tests.py`（targets→itemsで一括 propose→confirm→revert。所要時間を出力）

## 運用トグル（ScriptProperties; GAS）
- ENABLE_FIND_DEBUG=true|false（既定 false）: find 上位候補をログに出力
- ENABLE_TABLE_READ=true|false（既定 false）: table.read を開発時のみ有効化

## トラブルシューティング
- 302/303 リダイレクト: HTTPクライアントは follow_redirects を有効化（curl は -L）
- Cloud Run の 406: /mcp 直叩き時の想定挙動（Accept: text/event-stream が必要）
- EXEC_URL is not set: Cloud Run の環境変数を再設定
- pickCol is not defined: GAS 側のビルド/デプロイを最新に（esbuild→clasp push→deploy）

## 開発メモ
- 変更→ビルド→push→既存デプロイIDで再デプロイ（GAS）
- MCP は scripts/deploy_mcp.sh でワンコマンド
