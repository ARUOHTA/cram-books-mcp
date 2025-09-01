# 進捗ログ

## 2025-08-31

- feat: POST 検証スクリプトを修正（`apps/gas/deploy_and_test.sh`）
  - 302/303 追従時に POST を維持しないよう `--post302/--post303` と `-X POST` を外し、`-L` + `-d` + `Content-Type: application/json` で安定化。
- docs: POST トラブルシュートに「curl 正しい使い方」を追記（`docs/POST_and_ExecutionAPI_Troubleshooting.md`）。
- docs: `AGENTS.md` の POST サンプルを更新（`-X` 不要化）。
- docs: `AGENTS.md` に「出力のチェック（GET/POSTの実例）」を追記（複数IDのPOST例含む）。
- feat: books.filter を「書籍単位のグルーピング応答」に変更（行→書籍）。
  - 仕様: where=完全一致, contains=部分一致を“書籍の全行”に対して評価し、合致した書籍のみ返却。
  - 応答形: { books: BookDetails[], count, limit }（books.getの複数形式に準拠）。
  - ドキュメント: AGENTS.md にレスポンス例と備考を追加。
- feat: books.create / books.update を実装（POST）。
  - create: id_prefix で採番、親行＋章行を末尾に追加、応答に新IDを返却。
  - update: 指定IDブロックを検出し、メタ更新＋章の完全置換に対応（必要なら行の挿入/削除）。
  - バグ修正: 空文字が数値0扱いになる不具合を修正（toNumberOrNull）。
  - E2E: 作成→取得→更新→再取得まで確認済み（固定デプロイID）。
- feat: 削除/更新を二段階化（プレビュー→confirm）。confirm_token を 5 分間 Cache に保存。
- chore: GASコード分割の下地追加（config.ts, lib/common.ts, lib/id_rules.ts, handlers/books.ts）。
- chore: MCP デプロイスクリプト追加（scripts/deploy_mcp.sh, scripts/gcloud_env.example）。
- docs: AGENTS.md に Cloud Run デプロイ手順と環境変数、POST運用の極小サマリ、コード配置マップを追記。
- docs: POST トラブルシュート文書を AGENTS へ要約移植したため削除。
- refactor: books.find/get/filter/create/update/delete を handlers/books.ts に移設。index.ts は薄いルーター化。
- fix(mcp): Dockerfile に uvicorn/fastmcp を追加し、`server.py` で `uvicorn.run` 起動。Cloud Run での PORT 待受エラーを解消。
 - docs(mcp): 各ツールに日本語ドキュメント（引数/例/返り値）を追加。文字列式 where/contains のサポートを実装（英語→シート見出しへ自動マッピング）。
 - chore(mcp): 実行API版ツール（books_find_exec/books_get_exec）を非公開化（@mcp.tool を外し、実験用として残置）。
 - feat(mcp): `books_list`（親行だけの id/subject/title 一覧）を追加。
 - feat(mcp): `tools_help`（公開ツールの簡易ヘルプ）を追加。

次の候補タスク:
- ローカル実行で `apps/gas/deploy_and_test.sh -d '{"op":"books.find","query":"青チャート"}'` を用い、`doPost` 到達と JSON 応答を確認。
- 確認後、`books.create/update/filter` の POST 実装とテストケースを追加。

## 2025-09-01

- feat(mcp): planner_plan_propose に早期警告を追加（`data.warnings`）。`week_index` 範囲外と `plan_text` 52文字超を検知。
- feat(mcp): planner_plan_targets を強化。Books TOCから `numbering_symbol`/`max_end` を把握し、`suggested_plan_text` を付与（prev_range_hint と guideline_amount から推定）。`end_of_book` を同梱。
- docs: tools_help/README/AGENTS を更新（targetsのサジェスト/ proposeのwarnings を明記）。
- chore: 作業ブランチ `feat/llm-ux-improvements` を作成。
- feat(gas): planner.plan.set に `items[]` を追加し、週列ごとに連続ブロックへバッチ書込み（単体互換維持）。
- feat(mcp): planner_plan_confirm が一括トークンを単一GASリクエスト（items[]）へ集約し、GAS側のバッチ書込みを活用。
- feat(mcp): 新ツール `planner_plan_create` を追加（提案/確定を統合）。週混在の一括作成を1コールで反映。応答に `guidance_digest` と `warnings` を同梱。
- docs: README/AGENTS/tools_help を `planner_plan_create` 中心に更新。旧 propose/confirm は deprecated と明記。
 - breaking(mcp docs): propose/confirm の実装は互換向けstubのみにし、ドキュメント上は完全廃止。今後は create に一本化。
