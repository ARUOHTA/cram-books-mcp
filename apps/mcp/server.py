import os, sys, httpx
from typing import Any, Iterable
from .exec_api import scripts_run
from mcp.server.fastmcp import FastMCP

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

@mcp.tool()
async def books_find(query: Any) -> dict:
    q = _coerce_str(query, ("query","q","text"))
    if not q:
        return {"ok": False, "op":"books.find","error":{"code":"BAD_INPUT","message":"query is required"}}
    return await _get({"op":"books.find","query":q})

@mcp.tool()
async def books_get(book_id: Any = None, book_ids: Any = None) -> dict:
    """
    参考書情報を取得する（単一IDまたは複数ID）
    - 単一: book_id: str
    - 複数: book_ids: list[str] または book_id を配列で渡してもOK
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
@mcp.tool()
async def books_find_exec(query: Any, dev_mode: bool = True) -> dict:
    """books.find via Apps Script Execution API (scripts.run)
    Requires env: SCRIPT_ID, GAS_ACCESS_TOKEN
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


@mcp.tool()
async def books_get_exec(book_id: Any = None, book_ids: Any = None, dev_mode: bool = True) -> dict:
    """books.get via Apps Script Execution API (scripts.run)
    Accepts single or multiple IDs.
    Requires env: SCRIPT_ID, GAS_ACCESS_TOKEN
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

if __name__ == "__main__":
    import uvicorn
    app = mcp.streamable_http_app()
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
