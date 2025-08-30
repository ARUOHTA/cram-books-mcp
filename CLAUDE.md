# CRAM Books MCP - 開発ガイド

このプロジェクトは、Google Apps Script (GAS) と MCP サーバーを統合したモノレポ構造です。

## 📁 プロジェクト構造

```
cram-books-mcp/
├── apps/
│   ├── gas/              # Google Apps Script (TypeScript)
│   │   ├── src/          # TypeScriptソースコード
│   │   │   └── index.ts  # メインエントリーポイント
│   │   ├── dist/         # ビルド出力（GASにpushされる）
│   │   ├── package.json  # Node.js依存関係
│   │   ├── tsconfig.json # TypeScript設定
│   │   ├── esbuild.mjs   # ビルドスクリプト
│   │   ├── appsscript.json # GASマニフェスト
│   │   ├── .clasp.dev.json  # 開発環境のScript ID
│   │   ├── .clasp.prod.json # 本番環境のScript ID
│   │   └── .claspignore  # clasp pushの除外設定
│   └── mcp/              # MCP サーバー (Python)
│       ├── server.py     # MCPサーバー実装
│       ├── pyproject.toml # Python依存関係
│       ├── Dockerfile    # Cloud Run用
│       └── .env.example  # 環境変数テンプレート
├── .gitignore
├── CLAUDE.md (このファイル)
└── README.md
```

## 🚀 セットアップ

### 前提条件

- Node.js 18以上
- Python 3.12以上
- Google アカウント
- clasp CLI (`npm install -g @google/clasp`)

### 1. GAS (Google Apps Script) セットアップ

```bash
cd apps/gas

# 依存関係のインストール
npm install

# claspでGoogleアカウントにログイン
npm run clasp:login

# 新規GASプロジェクトを作成（または既存のものをクローン）
npm run clasp:create
# または
clasp clone <SCRIPT_ID> --rootDir dist

# Script IDを設定ファイルに記入
# .clasp.dev.json と .clasp.prod.json の scriptId を更新

# スプレッドシートIDを設定
# src/index.ts の CONFIG.BOOKS_FILE_ID を更新
```

### 2. MCP サーバーセットアップ

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
```

## 💻 開発フロー

### GAS開発

#### 基本コマンド

```bash
cd apps/gas

# TypeScriptをビルド
npm run build

# 開発環境にデプロイ
npm run push:dev

# 本番環境にデプロイ
npm run push:prod

# 開発環境でウォッチモード（ファイル変更を自動検知）
npm run watch
# 別ターミナルで
clasp push --watch

# GASエディタを開く
npm run open:dev  # 開発環境
npm run open:prod # 本番環境
```

#### 開発の流れ

1. **TypeScriptで実装** (`src/index.ts`)
   - 型安全な開発が可能
   - VS Code/Cursorの補完機能を活用

2. **ビルド & デプロイ**
   ```bash
   npm run build && npm run push:dev
   ```

3. **テスト**
   ```bash
   # GAS Web App のURLを取得
   clasp open --webapp
   
   # curlでテスト
   curl "https://script.google.com/macros/s/SCRIPT_ID/exec?op=books.find&query=test"
   ```

4. **デバッグ**
   - GASエディタでログを確認: `npm run open:dev`
   - Stackdriver Loggingでエラーを確認

### MCP サーバー開発

#### ローカル実行

```bash
cd apps/mcp
source .venv/bin/activate

# サーバー起動
python server.py
# または
uv run python server.py
```

#### 新しいツールの追加

`server.py` に新しいツールを追加:

```python
@mcp.tool()
async def books_search(query: Any, category: Any = None) -> dict:
    """
    本を検索する
    """
    q = _coerce_str(query, ("query", "q", "text"))
    cat = _coerce_str(category, ("category", "cat"))
    
    params = {"op": "books.search", "query": q}
    if cat:
        params["category"] = cat
    
    return await _get(params)
```

#### Docker ビルド & Cloud Run デプロイ

```bash
cd apps/mcp

# Dockerイメージをビルド
docker build -t cram-books-mcp .

# ローカルでテスト
docker run -p 8080:8080 -e EXEC_URL=$EXEC_URL cram-books-mcp

# Cloud Run にデプロイ
gcloud builds submit --tag gcr.io/PROJECT_ID/cram-books-mcp
gcloud run deploy cram-books-mcp \
  --image gcr.io/PROJECT_ID/cram-books-mcp \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars EXEC_URL=$EXEC_URL
```

## 🔄 API 仕様

### GAS エンドポイント

#### GET リクエスト

- `op=books.find&query={検索語}` - 本を検索
- `op=books.get&book_id={ID}` - 本の詳細を取得
- `op=health` - ヘルスチェック

#### POST リクエスト

```json
{
  "op": "books.create",
  "title": "本のタイトル",
  "author": "著者名",
  "isbn": "ISBN",
  "category": "カテゴリ"
}
```

### MCPツール

- `books_find(query)` - 本を検索
- `books_get(book_id)` - 本の詳細を取得

## 🛠️ トラブルシューティング

### GAS関連

**Q: clasp push で「User has not enabled the Apps Script API」エラー**
A: https://script.google.com/home/usersettings で Apps Script API を有効化

**Q: TypeScriptの型エラー**
A: `npm install @types/google-apps-script` を実行

**Q: デプロイしても変更が反映されない**
A: `npm run deploy:dev` で新しいデプロイメントを作成

### MCP関連

**Q: EXEC_URL is not set エラー**
A: `.env` ファイルに `EXEC_URL` を設定

**Q: ImportError**
A: `uv sync` で依存関係を再インストール

## 📝 開発のベストプラクティス

### TypeScript (GAS)

1. **型定義を活用**
   ```typescript
   type BookData = {
     id: string;
     title: string;
     author?: string;
   };
   ```

2. **エラーハンドリング**
   ```typescript
   try {
     // 処理
   } catch (error) {
     console.error("Error:", error);
     return createErrorResponse("ERROR_CODE", String(error));
   }
   ```

3. **関数の分離**
   - API操作は専用関数に分離
   - 共通処理はヘルパー関数に

### Python (MCP)

1. **入力検証**
   ```python
   def _coerce_str(x: Any, keys: tuple[str, ...] = ()) -> str | None:
       # 型チェックと変換
   ```

2. **非同期処理**
   ```python
   async def _get(params: dict[str, Any]) -> dict:
       async with httpx.AsyncClient() as client:
           # ...
   ```

3. **エラーレスポンス**
   ```python
   return {"ok": False, "error": {"code": "ERROR_CODE", "message": "詳細"}}
   ```

## 🔒 セキュリティ

1. **環境変数**
   - 本番URLは環境変数で管理
   - `.env` ファイルはGitにコミットしない

2. **アクセス制御**
   - GAS: `webapp.access` で制御
   - Cloud Run: IAMで制御

3. **入力検証**
   - 全ての入力をサニタイズ
   - SQLインジェクション対策

## 📚 参考リンク

- [clasp公式ドキュメント](https://github.com/google/clasp)
- [Google Apps Script リファレンス](https://developers.google.com/apps-script/reference)
- [MCP (Model Context Protocol)](https://github.com/anthropics/mcp)
- [Cloud Run ドキュメント](https://cloud.google.com/run/docs)

## 🤖 Claude での利用

このプロジェクトで作業する際は、以下の情報を Claude に伝えてください：

1. **プロジェクト構造**: モノレポ構造（apps/gas と apps/mcp）
2. **技術スタック**: TypeScript (GAS), Python (MCP), esbuild, clasp
3. **環境**: 開発(dev)と本番(prod)の分離
4. **ビルドプロセス**: esbuild → clasp push

### よく使うコマンド

```bash
# GAS開発
cd apps/gas && npm run dev

# MCPローカル実行
cd apps/mcp && uv run python server.py

# 全体のテスト
curl "GAS_URL?op=books.find&query=test"
```