import os, sys, httpx
from typing import Any, Iterable
try:
    from .exec_api import scripts_run  # when running as a package
except Exception:
    from exec_api import scripts_run    # when running as a script
try:
    from mcp.server.fastmcp import FastMCP  # newer mcp package provides this helper
except Exception:
    from fastmcp import FastMCP  # fallback to external fastmcp package

mcp = FastMCP("cram-books")

def log(*a): print(*a, file=sys.stderr, flush=True)

def _exec_url() -> str:
    url = os.environ.get("EXEC_URL")
    if not url:
        raise RuntimeError("EXEC_URL is not set")
    return url

def _script_id() -> str:
    sid = os.environ.get("SCRIPT_ID")
    if not sid:
        raise RuntimeError("SCRIPT_ID is not set")
    return sid

async def _get(params: dict[str, Any] | list[tuple[str, Any]]) -> dict:
    url = _exec_url()
    log("HTTP GET", url, params)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        return r.json()

async def _post(json: dict[str, Any]) -> dict:
    url = _exec_url()
    log("HTTP POST", url, json)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.post(url, json=json)
        r.raise_for_status()
        # Apps Script WebApp may return text/html content-type on redirect chain,
        # but body should be JSON string. Attempt to parse.
        try:
            return r.json()
        except Exception:
            return {"ok": False, "error": {"code": "BAD_JSON", "message": r.text[:500]}}

def _strip_quotes(s: str) -> str:
    s = s.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    return s

def _coerce_str(x: Any, keys: tuple[str, ...] = ()) -> str | None:
    if isinstance(x, str): return _strip_quotes(x)
    if isinstance(x, dict):
        for k in keys:
            v = x.get(k)
            if isinstance(v, str): return _strip_quotes(v)
    return None

def _norm_header(s: str) -> str:
    return s.strip().lower().replace("\u3000", " ").replace(" ", "")

def _pick_col(headers: list[str], candidates: Iterable[str]) -> int:
    hn = [_norm_header(h) for h in headers]
    for c in candidates:
        k = _norm_header(c)
        try:
            i = hn.index(k)
            return i
        except ValueError:
            continue
    return -1

@mcp.tool()
async def books_find(query: Any) -> dict:
    """参考書を曖昧検索します（GAS WebApp: books.find）。

    引数:
    - query: 検索語（必須）。例: "青チャート"、"現代文" など。

    使い方（例）:
    - books_find({"query": "青チャート"})
    - books_find("青チャート")

    返り値（例）:
    {
      "ok": true,
      "op": "books.find",
      "data": {
        "query": "青チャート",
        "candidates": [{"book_id":"gMB017","title":"…","subject":"数学","score":0.95,"reason":"phrase"}],
        "top": { … },
        "confidence": 0.68
      }
    }

    注意:
    - スコア順で候補を返します。上位のみを採用したければ LLM 側で score/confidence を見てください。
    """
    q = _coerce_str(query, ("query","q","text"))
    if not q:
        return {"ok": False, "op":"books.find","error":{"code":"BAD_INPUT","message":"query is required"}}
    return await _get({"op":"books.find","query":q})

@mcp.tool()
async def books_get(book_id: Any = None, book_ids: Any = None) -> dict:
    """参考書の詳細を取得します（GAS WebApp: books.get）。

    引数:
    - book_id: 単一ID（文字列）
    - book_ids: 複数ID（配列）。どちらか必須。

    使い方（例）:
    - 単一: books_get({"book_id":"gMB017"})
    - 複数: books_get({"book_ids":["gMB017","gMB018"]})

    返り値（例）:
    - 単一: { ok:true, data: { book: { id, title, subject, monthly_goal, unit_load, structure:{chapters…} } } }
    - 複数: { ok:true, data: { books: [ {id,…}, {id,…} ] } }
    """
    # 単一ID（文字列）
    single = _coerce_str(book_id, ("book_id","id"))
    # 複数ID（配列想定）
    def _as_list(x: Any) -> list[str]:
        if x is None:
            return []
        if isinstance(x, (list, tuple)):
            out: list[str] = []
            for v in x:
                if isinstance(v, str):
                    out.append(_strip_quotes(v))
                elif isinstance(v, dict):
                    s = _coerce_str(v, ("book_id","id"))
                    if s:
                        out.append(s)
            return out
        # 文字列1つだけ来た場合も配列化
        if isinstance(x, str):
            return [_strip_quotes(x)]
        return []

    many = _as_list(book_ids)
    # book_id 自体が配列で来るケースにも対応
    if not many:
        many = _as_list(book_id) if isinstance(book_id, (list, tuple)) else []

    if many:
        # GETのクエリに同名キーを複数並べる（GAS doGetで配列解釈）
        params: list[tuple[str, Any]] = [("op", "books.get")]
        for bid in many:
            params.append(("book_ids", bid))
        return await _get(params)

    if single:
        return await _get({"op": "books.get", "book_id": single})

    return {"ok": False, "op": "books.get", "error": {"code": "BAD_INPUT", "message": "book_id or book_ids is required"}}


# --- Execution API based tools (experimental) ---
async def books_find_exec(query: Any, dev_mode: bool = True) -> dict:
    """[非公開/内部] Apps Script Execution API 経由の books.find（実験用）。
    通常は使用しません。WebApp 版の books_find を利用してください。
    必要時のみメンテナ向けに残しています。
    """
    q = _coerce_str(query, ("query","q","text"))
    if not q:
        return {"ok": False, "op":"books.find","error":{"code":"BAD_INPUT","message":"query is required"}}
    try:
        result = await scripts_run(
            function="booksFind",
            parameters=[{"query": q}],
            dev_mode=dev_mode,
            script_id=_script_id(),
        )
        return result
    except Exception as e:
        return {"ok": False, "op":"books.find", "error": {"code":"EXEC_API_ERROR","message": str(e)}}


async def books_get_exec(book_id: Any = None, book_ids: Any = None, dev_mode: bool = True) -> dict:
    """[非公開/内部] Apps Script Execution API 経由の books.get（実験用）。
    通常は使用しません。WebApp 版の books_get を利用してください。
    必要時のみメンテナ向けに残しています。
    """
    # Reuse normalization from GET tool
    def _as_list(x: Any) -> list[str]:
        if x is None:
            return []
        if isinstance(x, (list, tuple)):
            out: list[str] = []
            for v in x:
                if isinstance(v, str):
                    out.append(_strip_quotes(v))
                elif isinstance(v, dict):
                    s = _coerce_str(v, ("book_id","id"))
                    if s:
                        out.append(s)
            return out
        if isinstance(x, str):
            return [_strip_quotes(x)]
        return []

    many = _as_list(book_ids)
    if not many and isinstance(book_id, (list, tuple)):
        many = _as_list(book_id)
    single = _coerce_str(book_id, ("book_id","id")) if not many else None

    req: dict[str, Any] = {}
    if many:
        req["book_ids"] = many
    elif single:
        req["book_id"] = single
    else:
        return {"ok": False, "op":"books.get","error":{"code":"BAD_INPUT","message":"book_id or book_ids is required"}}

    try:
        result = await scripts_run(
            function="booksGet",
            parameters=[req],
            dev_mode=dev_mode,
            script_id=_script_id(),
        )
        return result
    except Exception as e:
        return {"ok": False, "op":"books.get", "error": {"code":"EXEC_API_ERROR","message": str(e)}}


def _normalize_key_for_sheet(k: str) -> str:
    """ユーザ入力のキー（英語/別名）をシート見出しに寄せる簡易マッピング。"""
    t = k.strip().lower()
    # 代表列
    if t in {"id", "参考書id", "参考書ｉｄ"}: return "参考書ID"
    if t in {"title", "参考書名", "書名", "名称", "名前"}: return "参考書名"
    if t in {"subject", "教科", "科目"}: return "教科"
    if t in {"book_type", "参考書のタイプ"}: return "参考書のタイプ"
    if t in {"quiz_type", "確認テストのタイプ"}: return "確認テストのタイプ"
    if t in {"quiz_id", "確認テストid", "確認テストｉｄ"}: return "確認テストID"
    # そのまま返す（シート見出しが直接指定された場合）
    return k

def _parse_where_like(x: Any) -> dict[str, Any] | None:
    """'subject = "数学"' のような簡易式を {"教科":"数学"} に変換。辞書はそのまま通す。"""
    if isinstance(x, dict):
        # キー正規化（英語→日本語見出し）
        return { _normalize_key_for_sheet(str(k)) : v for k, v in x.items() }
    if isinstance(x, str):
        s = x.strip()
        # 演算子 = / : をサポート（前後空白/引用符を吸収）
        for sep in ["=", ":"]:
            if sep in s:
                left, right = s.split(sep, 1)
                key = _normalize_key_for_sheet(left.strip())
                val = right.strip()
                if (val.startswith("\"") and val.endswith("\"")) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                if key:
                    return { key: val }
        # 解析不能
        return None
    return None

@mcp.tool()
async def books_filter(where: Any = None, contains: Any = None, limit: int | None = 50) -> dict:
    """条件で参考書をフィルタします（GAS WebApp: books.filter）。

    引数:
    - where: 完全一致の条件（辞書 or 文字列式）。例: {"教科":"数学"} / "subject='数学'"
    - contains: 部分一致の条件（辞書 or 文字列式）。例: {"参考書名":"青チャート"}
    - limit: 上限件数（既定 50）

    キーの自動マッピング:
    - subject→教科, title→参考書名, id→参考書ID など、英語キーはシート見出しへ自動変換します。

    返り値（例）:
    { ok:true, data:{ books:[ {id,title,subject,…} ], count, limit } }
    """
    payload: dict[str, Any] = {"op": "books.filter"}
    w = _parse_where_like(where) if where is not None else None
    c = _parse_where_like(contains) if contains is not None else None
    if isinstance(w, dict) and w:
        payload["where"] = w
    if isinstance(c, dict) and c:
        payload["contains"] = c
    if isinstance(limit, int) and limit > 0:
        payload["limit"] = limit
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "books.filter", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


@mcp.tool()
async def books_create(title: str, subject: str, unit_load: Any = None, monthly_goal: str | None = None, chapters: Any = None, id_prefix: str | None = None) -> dict:
    """参考書を新規作成（GAS WebApp: books.create）。簡潔なルール:

    - 数値は数値型で（unit_load: 2 など）。
    - chapters は最終形の配列（完全指定）。最初の章は「親行」に入り、2章目以降は下行に追加。
    - 章の最小形: {"title":"第1章","range":{"start":1,"end":20}}（numbering は任意）。
    - 未指定の項目は作成されません。id は自動採番（id_prefix で接頭辞指定可）。

    例:
    {"title":"テスト本","subject":"数学","unit_load":2,
     "monthly_goal":"1日30分","chapters":[{"title":"第1章","range":{"start":1,"end":20}}]}
    返り値例: { ok:true, data:{ id:"gMB123", created_rows: 2 } }
    """
    payload: dict[str, Any] = {"op": "books.create", "title": title, "subject": subject}
    if unit_load is not None:
        try:
            payload["unit_load"] = float(unit_load)
        except Exception:
            payload["unit_load"] = unit_load
    if monthly_goal is not None:
        payload["monthly_goal"] = monthly_goal
    if isinstance(chapters, list):
        payload["chapters"] = chapters
    if id_prefix:
        payload["id_prefix"] = id_prefix
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "books.create", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


@mcp.tool()
async def books_update(book_id: Any, updates: Any | None = None, confirm_token: str | None = None) -> dict:
    """参考書の更新（GAS WebApp: books.update）。安全な2段階:

    1) プレビュー: {book_id, updates} → 差分と confirm_token
    2) 確定: {book_id, confirm_token} → { updated }

    入力の注意:
    - updates.chapters は「完全置換」。配列は最終状態を渡す（追記ではない）。
    - 章1は親行、章2以降は下行へ書き込み（create と同等）。
    - 変更しない項目は updates に含めない（空文字での上書きを避ける）。
    - 数値は数値型で（unit_load など）。
    """
    bid = _coerce_str(book_id, ("book_id","id"))
    if not bid:
        return {"ok": False, "op": "books.update", "error": {"code": "BAD_INPUT", "message": "book_id is required"}}
    payload: dict[str, Any] = {"op": "books.update", "book_id": bid}
    if confirm_token:
        payload["confirm_token"] = confirm_token
    else:
        if isinstance(updates, dict):
            payload["updates"] = updates
        else:
            return {"ok": False, "op": "books.update", "error": {"code": "BAD_INPUT", "message": "updates is required for preview"}}
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "books.update", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


@mcp.tool()
async def books_delete(book_id: Any, confirm_token: str | None = None) -> dict:
    """参考書の削除（2段階）を行います（GAS WebApp: books.delete）。

    ワークフロー:
    1) プレビュー: book_id のブロック行数・範囲と confirm_token を返す
    2) 確定: book_id と confirm_token を渡す → { deleted_rows }
    """
    bid = _coerce_str(book_id, ("book_id","id"))
    if not bid:
        return {"ok": False, "op": "books.delete", "error": {"code": "BAD_INPUT", "message": "book_id is required"}}
    payload: dict[str, Any] = {"op": "books.delete", "book_id": bid}
    if confirm_token:
        payload["confirm_token"] = confirm_token
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "books.delete", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


@mcp.tool()
async def books_list(limit: int | None = None) -> dict:
    """参考書の親行だけを一覧します（ID/教科/参考書名）。

    引数:
    - limit: 返す上限件数（任意）。指定がなければ全件。

    実装メモ:
    - GAS の `table.read` を叩いて、ヘッダー行から列位置を特定。
    - IDセルが空の行（章行）は除外。親行のみ採用。
    - 返り値は { books:[{id,subject,title}], count } の簡易形。
    """
    try:
        data = await _get({"op": "table.read"})
    except Exception as e:
        return {"ok": False, "op": "books.list", "error": {"code": "HTTP_GET_ERROR", "message": str(e)}}

    if not isinstance(data, dict) or not data.get("ok"):
        return {"ok": False, "op": "books.list", "error": {"code": "UPSTREAM_ERROR", "message": str(data)}}

    payload = data.get("data") or {}
    headers: list[str] = payload.get("columns") or []
    rows: list[list[Any]] = payload.get("rows") or []

    idx_id = _pick_col(headers, ["参考書ID","ID","id"]) 
    idx_title = _pick_col(headers, ["参考書名","タイトル","書名","title"]) 
    idx_subject = _pick_col(headers, ["教科","科目","subject"]) 

    if min(idx_id, idx_title, idx_subject) < 0:
        return {"ok": False, "op": "books.list", "error": {"code": "BAD_HEADER", "message": "必要な列（参考書ID/参考書名/教科）が見つかりません"}}

    books: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        bid = str(r[idx_id]).strip() if idx_id < len(r) else ""
        if not bid or bid in seen:
            continue
        seen.add(bid)
        title = str(r[idx_title]).strip() if idx_title < len(r) else ""
        subject = str(r[idx_subject]).strip() if idx_subject < len(r) else ""
        books.append({"id": bid, "subject": subject, "title": title})

    if isinstance(limit, int) and limit > 0:
        books = books[:limit]

    return {"ok": True, "op": "books.list", "data": {"books": books, "count": len(books)}}


@mcp.tool()
async def tools_help() -> dict:
    """このMCPで公開中のツール一覧と使い方を返します（簡易ヘルプ）。

    目的:
    - LLM/ユーザーが最小構成の正しいツールを選びやすくするためのガイド。

    備考:
    - 実行API版（*_exec）は公開していません。通常はWebApp経由のツールを使用してください。
    """
    tools = [
        {
            "name": "books_find",
            "desc": "参考書の曖昧検索",
            "args": {"query": "string"},
            "example": {"query": "青チャート"},
            "returns": "candidates/top/confidence を含む検索結果",
        },
        {
            "name": "books_get",
            "desc": "参考書の詳細取得（単一/複数）",
            "args": {"book_id": "string | optional", "book_ids": "string[] | optional"},
            "example": {"book_ids": ["gMB017", "gMB018"]},
            "returns": "{ book } または { books }",
        },
        {
            "name": "books_filter",
            "desc": "条件で参考書を絞り込み（書籍単位）",
            "args": {"where": "object|string", "contains": "object|string", "limit": "number"},
            "example": {"where": {"教科": "数学"}, "limit": 10},
            "notes": "文字列式 subject='数学' や英語キー（subject/title/id）も可",
        },
        {
            "name": "books_list",
            "desc": "全参考書の親行を一覧（id/subject/title のみ）",
            "args": {"limit": "number | optional"},
            "example": {"limit": 50},
            "returns": "{ books:[{id,subject,title}], count }",
        },
        {
            "name": "books_create",
            "desc": "参考書の新規作成（自動ID付与）",
            "args": {"title":"string","subject":"string","unit_load":"number?","monthly_goal":"string?","chapters":"Chapter[]?","id_prefix":"string?"},
            "example": {"title":"テスト本","subject":"数学","unit_load":2,"chapters":[{"title":"第1章","range":{"start":1,"end":20}}]},
            "notes": "chaptersは最終形（完全指定）。第1章は親行、2章以降は下行。数値は数値型で。"
        },
        {
            "name": "books_update",
            "desc": "二段階更新（preview→confirm）",
            "args": {"book_id":"string","updates":"object?","confirm_token":"string?"},
            "example_preview": {"book_id":"gMB017","updates":{"title":"（改）"}},
            "example_confirm": {"book_id":"gMB017","confirm_token":"…"},
            "notes": "updates.chaptersは完全置換。章1は親行、章2以降は下行。未変更項目は含めない。"
        },
        {
            "name": "books_delete",
            "desc": "二段階削除（preview→confirm）",
            "args": {"book_id":"string","confirm_token":"string?"},
            "example_preview": {"book_id":"gMB017"},
            "example_confirm": {"book_id":"gMB017","confirm_token":"…"},
        },
    ]
    return {"ok": True, "op": "tools.help", "data": {"tools": tools}}

if __name__ == "__main__":
    import uvicorn
    app = mcp.streamable_http_app()
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
