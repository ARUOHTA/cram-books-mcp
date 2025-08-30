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

### MCP ツール

| ツール名 | 説明 | 主要引数 | 返り値 |
|---------|------|---------|--------|
| `books_find` | 参考書の検索 | `query: string` | books.find のレスポンス |
| `books_get` | 参考書の詳細取得 | `book_id: string` | books.get のレスポンス |
| `books_create` | 参考書の新規登録 | `book: object`, `id_prefix?: string` | 作成された参考書のID |
| `books_filter` | 条件による絞り込み | `where?: object`, `contains?: object`, `limit?: number` | フィルタ結果 |

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
```

#### テスト方法（重要）

```bash
# GAS Web App のURLを取得
clasp deployments  # 例: AKfycb... @8 がWebAppデプロイ
curl -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec?op=books.find&query=青チャート"

# POSTテスト
curl -L -X POST "https://script.google.com/macros/s/<DEPLOY_ID>/exec" \
  -H "Content-Type: application/json" \
  -d '{"op":"books.filter","where":{"教科":"数学"}}'

注意: スクリプトIDURLではなく、デプロイIDURLを使用。`-L`で302に追従。
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
# 環境変数の設定
export PROJECT_ID="your-project-id"
export REGION="asia-northeast1"
export IMAGE="cram-books-mcp"
export REPO="cram-repo"  # Artifact Registry リポジトリ
export EXEC_URL="https://script.google.com/macros/s/.../exec"

# Artifact Registry にイメージをプッシュ
gcloud builds submit \
  --tag "$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE:latest"

# Cloud Run にデプロイ
gcloud run deploy "$IMAGE" \
  --image "$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE:latest" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars EXEC_URL="$EXEC_URL" \
  --timeout=300 \
  --port=8080

# サービスURLを取得
gcloud run services describe "$IMAGE" --region "$REGION" --format='value(status.url)'

# ヘルスチェック（406が正常）
curl -i "https://<ServiceURL>/mcp"
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
