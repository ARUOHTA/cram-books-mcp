# POST と Execution API 実験メモ（詳細版）

本ドキュメントは「GAS WebApp への POST 実行」と「Apps Script Execution API（scripts.run）」を用いた書き込み経路の検証記録です。Web制限のないモデルへ共有するため、経緯・再現手順・観測ログ・判断・次アクションを詳細にまとめています。

## 目的と前提
- 目的: 参考書マスターの作成/更新系を安全に実行（LLM→MCP→GAS）。
- 方針: まずはGAS WebApp（匿名）でのPOST可否を検証。難があればExecution APIへ移行。
- リポジトリ構成（抜粋）:
  - GAS: `apps/gas`（TypeScript → `dist/book_master.js` を push/deploy）
  - MCP: `apps/mcp`（FastMCP, Cloud Run）

## 結論（現時点）
- GAS WebApp（匿名公開）へのPOSTは、302リダイレクト経由で `script.googleusercontent.com/macros/echo?...` に遷移し、最終的にHTML（Driveの404相当）になり安定せず。GETは正常。
- 回避策として GET で複数IDを扱えるようにGASの `doGet` を拡張済み（`book_ids` 複数指定を受理）。MCPの `books_get` も単一/複数対応済。
- Execution API（scripts.run）は、ユーザーADCはブランド/同意でブロック、サービスアカウント(SA)直叩きは 404（スクリプト資産の参照問題）で停止。ドメイン全体の委任（DWD）や組織資産化が必要な可能性が高い。

---

## 1) GAS WebApp への POST 実験

### 1.1 事実
- GET は正常。例: `?op=ping`, `?op=books.find`, `?op=books.get`（単一/複数）
- POST を `curl -L -X POST` で実行すると 302 → `script.googleusercontent.com/macros/echo?...` に遷移し、最終的にHTML（「ページが見つかりません」）を受け取る。

例（ヘッダ観測）:
```
HTTP/2 302
location: https://script.googleusercontent.com/macros/echo?user_content_key=...&lib=...
```

### 1.2 対策試行（すべて不安定 or 失敗）
- `curl` オプション: `--post301 --post302 --post303`、`--data-binary`、`Accept/Origin/Referer/X-Requested-With` 付与 → HTMLで終了。
- 302 Location 先に直接 POST → 無応答（多くはGET想定のエコーエンドポイント）。
- `deploy_and_test.sh` に `--post301/302/303` を追加 → 変化なし（HTML）。

### 1.3 判断
- 匿名WebAppはリダイレクト後の経路でPOSTが維持されず、実質的に `doPost` に到達しないケースがある。
- CLI 検証ではGETを使うのが安定。書き込みは別経路（Execution API or 認証付きWebApp）を推奨。

### 1.4 代替（実装済み）: GET で複数ID対応
- `apps/gas/src/index.ts` の `doGet` に `e.parameters` を取り込み、`op=books.get` で `book_ids`（繰り返し）や複数 `book_id` を配列化。
- 検証コマンド:
```
apps/gas/deploy_and_test.sh 'op=books.get&book_ids=gMB017&book_ids=gMB018'
```
- 期待レスポンス: `{ "ok": true, "data": { "books": [...] } }`

---

## 2) Execution API（scripts.run）実験

### 2.1 目的
- WebApp依存のPOST問題を回避し、Apps Script関数を直接呼ぶ安定経路を確立。

### 2.2 実装（MCP）
- 追加: `apps/mcp/exec_api.py` に `scripts_run(function, parameters, dev_mode, script_id)`
- 追加ツール（実験用）: `books_find_exec`, `books_get_exec`
- 環境変数: `SCRIPT_ID`（スクリプトID）, `GAS_ACCESS_TOKEN`（Bearer）

### 2.3 ユーザーADCでの検証
- 手順:
  1) `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/script.projects`
  2) `ACCESS_TOKEN=$(gcloud auth application-default print-access-token)`
  3) `SCRIPT_ID=<apps/gas/.clasp.json の scriptId>`
  4) `PROJECT_NUM=<紐付けたGCPのプロジェクト番号>`
  5) `curl -H "Authorization: Bearer $ACCESS_TOKEN" -H "x-goog-user-project: $PROJECT_NUM" ... :run`
- 観測エラー:
  - 初回 403: quota project 未設定 → `x-goog-user-project` 追加で回避。
  - 403: `SERVICE_DISABLED` → `gcloud services enable script.googleapis.com` で回避。
  - 別途: ブラウザの同意段階でブランド/同意画面によりブロック（個人アカウント環境）。

### 2.4 サービスアカウント（SA）での検証
- 作成: `exec-api-caller@<PROJECT_ID>.iam.gserviceaccount.com`
- 付与: 呼び出しユーザーに `roles/iam.serviceAccountTokenCreator`、SAに `roles/serviceusage.serviceUsageConsumer`
- GAS 側: スクリプト本体の「共有」で SA を「編集者」に追加。スプレッドシートも SA に編集権限を付与。
- GAS→GCP 紐付け: GASエディタ「プロジェクトの設定」→ GCPプロジェクト番号 `937384671947` に変更。
- 呼び出し:
```
ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=exec-api-caller@<PROJECT_ID>.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/script.projects)

curl -X POST "https://script.googleapis.com/v1/scripts/${SCRIPT_ID}:run" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-goog-user-project: 937384671947" \
  -H 'Content-Type: application/json' \
  -d '{"function":"booksFind","devMode":true,"parameters":[{"query":"青チャート"}]}'
```
- 観測エラー: 404 `Requested entity was not found.`（複数回）
- 判断: 個人所有のスクリプトを SA 直呼び出しする場合、スクリプト資産の参照主体が一致せず 404 になることがある。ドメイン全体の委任（DWD）でユーザー偽装、または組織資産化（共有ドライブ/組織所有）などが有効。

---

## 3) 現状の回避策と推奨案

- 短期（即日運用）
  - GETベースで書き込み系にも暫定対応（`payload`=JSON, HMAC署名ヘッダ）。MCPが署名付与→GASで検証し実行。
  - 既存: `books.get` はGET複数対応済。`books.create/update` も同様にGETで受ける設計可。

- 中長期（本命）
  - Execution API（scripts.run） + 認証:
    - ドメイン全体の委任（DWD）で SA→ユーザー偽装を許可し、scripts.run を安定化。
    - もしくは OAuth クライアント（Desktop/Web）を用意し、ユーザートークンで scripts.run を実行。
  - GAS WebApp のPOST継続利用は非推奨（匿名運用ではリダイレクト経路が安定しにくい）。

---

## 4) 参考コマンド（抜粋）

- GAS デプロイ＆テスト（GET）:
```
apps/gas/deploy_and_test.sh 'op=books.get&book_ids=gMB017&book_ids=gMB018'
```

- WebApp POST（失敗例）:
```
curl -L --post302 --post303 -X POST "$BASE" \
  -H 'Content-Type: application/json' \
  -d '{"op":"books.get","book_ids":["gMB017","gMB018"]}'
```

- Execution API（ユーザーADC, 例）:
```
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/script.projects
ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
SCRIPT_ID=...
PROJECT_NUM=...

curl -sS -X POST "https://script.googleapis.com/v1/scripts/${SCRIPT_ID}:run" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-goog-user-project: ${PROJECT_NUM}" \
  -H 'Content-Type: application/json' \
  -d '{"function":"booksFind","devMode":true,"parameters":[{"query":"青チャート"}]}'
```

- Execution API（SA, 例）:
```
ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=exec-api-caller@<PROJECT_ID>.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/script.projects)
```

---

## 5) 次アクション提案
- Option A（即効）: GETで `books.create/update` を実装し、HMACで保護。
- Option B（本命）: DWDでSAのユーザー偽装を有効化し、scripts.runへ移行。
- Option C（代替）: 専用OAuthクライアントを作成し、ユーザートークンでscripts.run。

---

## 付記: 変更・実装済み項目（要点）
- GAS: `doGet` が `book_ids` 複数に対応（`apps/gas/src/index.ts`）。
- MCP: `books_get` が単一/複数対応（GET連携）。
- MCP: Execution APIクライアント追加（`apps/mcp/exec_api.py`）と実験ツール（`books_find_exec`, `books_get_exec`）。
- Cloud Run: MCPを再デプロイ済（GET ルートは正常）。
