# server.py
import os, sys, httpx
from typing import Any
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("cram-books")

def log(*a): print(*a, file=sys.stderr, flush=True)

def _exec_url() -> str:
    url = os.environ.get("EXEC_URL")         # ← ここで遅延取得（import時に落とさない）
    if not url:
        raise RuntimeError("EXEC_URL is not set")
    return url

async def _get(params: dict[str, Any]) -> dict:
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
async def books_get(book_id: Any) -> dict:
    bid = _coerce_str(book_id, ("book_id","id"))
    if not bid:
        return {"ok": False, "op":"books.get","error":{"code":"BAD_INPUT","message":"book_id is required"}}
    return await _get({"op":"books.get","book_id":bid})

# ★ Cloud Runでは“ここで起動しない”。CLI側が起動を担当するため、何も書かない。
if __name__ == "__main__":
    import os
    import uvicorn
    # Streamable HTTP の ASGI アプリを作る（エンドポイントは /mcp）
    app = mcp.streamable_http_app()
    # Cloud Run が渡す PORT で 0.0.0.0 にバインド
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
