# CRAM Books MCP

LLM と Google スプレッドシート（参考書マスター／生徒マスター／スピードプランナー）を安全に接続するためのモノレポです。GAS（Google Apps Script）がWeb APIを提供し、MCP（Model Context Protocol）サーバーがHTTP/SSE経由で取りまとめます。

```
[ユーザー/Claude]
   │  (MCP over HTTP/SSE)
   ▼
[Cloud Run: MCP Server]  ←(ENV)→  EXEC_URL
   │  (HTTP GET/POST, JSON)
   ▼
[Apps Script (WebApp)] ──→ [Google Sheets: Books / Students / Planner]
```

---

## 1. 利用者向け（LLMで使う）

### 1.1 何ができる？
- 参考書マスター（Books）
  - 曖昧検索（books_find）、詳細取得（books_get）、条件絞り込み（books_filter）
  - 新規作成・更新・削除はすべてプレビュー→承認→確定の二段階
- 生徒マスター（Students）
  - 在塾が既定の list/find/get/filter と、create/update/delete
- スピードプランナー（週間管理）
  - 計画の読取（plan_get）と目安（週時間・単位処理量・目安処理量）を“統合で”取得
  - 今月の“埋めるべきセル”の自動抽出（plan_targets）＋ TOCに基づく簡易サジェスト（suggested_plan_text/numbering_symbol）
  - 計画の一括作成（planner_plan_create）。週混在OKで1コール反映。MUST: 実行前に planner_guidance を参照（create 応答にも guidance_digest を同梱）
  - propose/confirm は廃止。既存クライアント互換は維持するが、新規は create を使用
  - 確定はGAS側でバッチ書込み（`planner.plan.set` の `items[]` 最適化）
- スピードプランナー（月間管理）
  - 指定年月（B=年、C=月）の実績行を構造化して取得（planner_monthly_filter）

### 1.2 週間管理の最短フロー（まとめて作る）
1) 現状把握: `planner_plan_get(student_id=… or spreadsheet_id=…)`
   - weeks[].items[] に `plan_text` と `weekly_minutes / unit_load / guideline_amount` が入っています
2) 書込み候補の自動抽出: `planner_plan_targets(…)`
   - A非空・週間時間非空・未入力のみが targets[] に出ます。各候補に `prev_range_hint` と `suggested_plan_text`（目次/目安量に基づく推定）を付加
3) 一括プレビュー→承認: `planner_plan_propose(items=[…])` → `planner_plan_confirm(confirm_token)`
   - items は `{week_index, row|book_id, plan_text, overwrite?}` の配列
   - 週数外や52文字超の場合、`planner_plan_propose` の `data.warnings` に警告（確定時は失敗）

> 例）「二週目から五週目までまとめて作って」
> 1) targets で週2–5の候補だけ拾う → 2) items を組み立て `plan_propose(items)` → 3) effects（差分）を確認 → 4) `plan_confirm(token)`

### 1.3 計画作成の原則（LLMが必ず守る）
- 収集→計画→書込みの順
  1) ids_list / dates_get / plan_get（統合）で今月の状況を把握
  2) 過去2–3ヶ月の実績（planner_monthly_filter）と TOC（books_get）を参照
  3) plan_targets → plan_propose(items) → plan_confirm で一括反映
- 保守的に: 過去の実績ペースと目次構成に沿い、guideline_amount を守る
- 相談ポリシー（Ask-when-uncertain）: 終端到達、重複/飛び、過不足の大きな逸脱など不確実な場合は、勝手に進めずユーザーへ確認
- 終端表記: 終える週の末尾に「★完了！」、以降の週は「★相談」。ユーザー方針が出たら従う
- 週数遵守: `week_count`（4/5）にない週は作成しない
- 表記と上限: 52文字以内、範囲は「~」、複数は「,」または改行。非gIDはC/Dの文言を尊重

> これらの原則は、MCPツール `planner_guidance` にも常に含まれています。会話冒頭で参照することで、意図どおりの計画が得やすくなります。

---

## 2. 開発者向け（セットアップ/運用/テスト）

### 2.1 ディレクトリ構成
```
apps/
 ├─ gas/        # GAS (TypeScript → esbuild → dist)
 │   ├─ src/    # ルーター/ハンドラ/ユーティリティ/テスト
 │   └─ dist/   # clasp push 対象（生成物）
 └─ mcp/        # MCP Server (Python FastMCP)
     ├─ server.py
     ├─ tests/run_tests.py
     └─ Dockerfile
scripts/
 ├─ deploy_mcp.sh         # Cloud Run デプロイ
 └─ gcloud_env.example    # PROJECT_ID/REGION/SERVICE 例
docs/
 ├─ speed_planner_weekly.md
 └─ planner_monthly.md
```

### 2.2 依存環境
- Node.js 18+ / npm
- Python 3.12+ / `uv`
- @google/clasp（GAS）、gcloud（Cloud Run）

### 2.3 GAS（WebApp）
```
cd apps/gas
npm install
npm run clasp:login

# 既存WebAppを dist を正として clone/pull する場合:
clasp clone <SCRIPT_ID> --rootDir dist

# ビルド→push→デプロイ（固定デプロイID運用推奨）
npm run build
clasp push
clasp deployments            # 既存ID確認
clasp deploy -i <DEPLOY_ID>  # 既存IDへ再デプロイ
```
- WebApp 公開: 実行ユーザー=自分 / アクセス=全員（匿名）
- ENV は ScriptProperties を併用（必要時）

### 2.4 MCP（Cloud Run）
```
# ローカル
cd apps/mcp
uv run python server.py   # http://localhost:8080/mcp

# デプロイ（EXEC_URLは apps/gas/.prod_deploy_id を参照）
cd ../..
source scripts/gcloud_env.example
scripts/deploy_mcp.sh
```
- ENV: `EXEC_URL`（必須, GAS WebAppの/exec）/ `SCRIPT_ID`（任意: Execution API 実験用）

### 2.5 テスト
- GAS（GASエディタ）
  - testBooksAll / testPlannerReadSample / testPlannerBulkSpeedGAS（週2の空欄10件程度を write→revert）
- MCP（E2E; EXEC_URL 必須）
  - `uv run python apps/mcp/tests/run_tests.py`
  - SPREADSHEET_ID を与えれば planner 系も実行（まとめ処理の所要時間をログ）

### 2.6 Claude / ChatGPT
- Claude: 本mainの多機能MCPをそのまま利用（任意ツール呼び出し）
- ChatGPT: コネクタの仕様上 `search`/`fetch` のみ。別ブランチで最小I/Fを用意（詳細は AGENTS.md の「ChatGPT コネクタ対応」）

### 2.7 トラブルシューティング
- 302/303: WebAppのリダイレクト特性。HTTPクライアントは follow_redirects を有効化
- /mcp 直叩きは 406: SSE必須の正常応答
- `EXEC_URL is not set`: Cloud Run の環境変数に設定
- pickCol エラー: GAS 側をビルド→push→再デプロイ

---

## 3. 主なMCPツール（抜粋）

### 3.1 Books
- books_find(query) / books_get(book_id|book_ids[]) / books_filter / books_create / books_update / books_delete / books_list

### 3.2 Students
- students_list/find/get/filter/create/update/delete

### 3.3 Planner（週間管理）
- planner_ids_list / planner_dates_get|propose|confirm / planner_plan_get|propose|confirm / planner_plan_targets / planner_guidance
  - plan_get は metrics 同梱、plan_propose は items[] 一括対応、plan_confirm は単体/一括を自動判別

### 3.4 Planner（月間管理）
- planner_monthly_filter(year, month, student_id?|spreadsheet_id?)
  - B=年(下2桁)/C=月(1..12) で実績を抽出

---

## 4. ライセンス/免責
- このリポジトリは学習塾内の運用を前提にしています。固有のデータ構造・命名があります。
- 個人情報・機微情報の取り扱いに注意し、アクセス権限や公開範囲を十分に管理してください。
