# server.py
import os, sys, httpx
from dataclasses import dataclass
from typing import Any, List
import math

# 可能なら埋め込みモデルを読み込む（Cloud Run 本番ではイメージに同梱推奨）
_EMBEDDER = None
try:
    from sentence_transformers import SentenceTransformer
    import numpy as np
    def _load_embedder():
        global _EMBEDDER
        if _EMBEDDER is None:
            # 軽量・日本語対応モデル（初回のみダウンロードされる）
            _EMBEDDER = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
        return _EMBEDDER
except Exception as e:  # noqa: BLE001
    np = None  # type: ignore
    def _load_embedder():
        return None
    pass
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

# ===== セマンティック検索（埋め込み）インデックス =====

@dataclass
class _BookItem:
    id: str
    title: str
    subject: str
    text: str  # タイトル + 別名


class _SemanticIndex:
    """GASのtable.readから親行（IDあり）を抽出し、タイトル+別名を埋め込み化して常駐。

    注意:
    - 本番はコンテナにモデル同梱推奨（初回ダウンロード回避）
    - Nが数千規模ならCPU全探索で十分高速
    """

    def __init__(self) -> None:
        self.items: list[_BookItem] = []
        self.embeddings = None  # np.ndarray shape=(N, d)
        self.ready = False

    async def build(self) -> None:
        # GASから全行取得
        data = await _get({"op": "table.read"})
        rows: List[dict] = data.get("data", {}).get("rows", [])

        # 親行のみ抽出（参考書IDが非空）
        seen: set[str] = set()
        items: list[_BookItem] = []
        for r in rows:
            bid = str(r.get("参考書ID", "") or "").strip()
            title = str(r.get("参考書名", "") or "").strip()
            subj = str(r.get("教科", "") or "").strip()
            if not bid or not title:
                continue
            if bid in seen:
                continue
            seen.add(bid)
            # 別名が存在すれば加える（JSON/CSVの両方に対応）
            aliases_raw = r.get("別名")
            aliases: list[str] = []
            if aliases_raw:
                try:
                    arr = list(aliases_raw) if isinstance(aliases_raw, list) else []
                    if not arr:
                        import json as _json
                        arr = _json.loads(str(aliases_raw))
                        if not isinstance(arr, list):
                            arr = []
                except Exception:
                    # カンマ/読点区切り対応
                    arr = [s.strip() for s in str(aliases_raw).split("，") for s in s.split(",") if s.strip()]
                aliases = [str(a) for a in arr if a]
            text = " ".join([title, *aliases])
            items.append(_BookItem(bid, title, subj, text))

        # 埋め込み作成
        embedder = _load_embedder()
        if embedder is None or np is None:
            raise RuntimeError("Embedding model not available. Ensure sentence-transformers (and numpy) are installed.")
        mat = embedder.encode([it.text for it in items], normalize_embeddings=True)
        self.items = items
        self.embeddings = np.array(mat)  # (N, d)
        self.ready = True

    async def ensure(self) -> None:
        if not self.ready:
            await self.build()

    async def search(self, query: str, top_k: int = 50) -> list[dict]:
        await self.ensure()
        embedder = _load_embedder()
        if embedder is None or np is None:
            raise RuntimeError("Embedding model not available.")
        qv = embedder.encode([query], normalize_embeddings=True)[0]
        sims = (self.embeddings @ qv)  # cos類似（正規化済み） shape=(N,)
        idx = np.argsort(-sims)[:top_k]
        out = []
        for i in idx:
            it = self.items[int(i)]
            out.append({
                "book_id": it.id,
                "title": it.title,
                "subject": it.subject,
                "score": float(sims[int(i)]),
                "reason": "semantic",
            })
        return out


_SEM_INDEX = _SemanticIndex()


@mcp.tool()
async def books_find_semantic(query: Any, top_k: int = 20) -> dict:
    """埋め込み（semantic）による検索。

    - GASの`table.read`から親行（参考書IDあり）をインデックス化
    - クエリの埋め込みとコサイン類似でTop-kを返す
    - 既存のレスポンス形式に近い形で返却（後方互換のため op 名は違う）
    """
    q = _coerce_str(query, ("query", "q", "text"))
    if not q:
        return {"ok": False, "op": "books.find_semantic", "error": {"code": "BAD_INPUT", "message": "query is required"}}

    try:
        cands = await _SEM_INDEX.search(q, top_k=top_k)
        top = cands[0] if cands else None
        s1 = cands[0]["score"] if cands else 0.0
        s2 = cands[1]["score"] if len(cands) > 1 else 0.0
        conf = max(0.0, min(1.0, s1 - 0.25 * s2))
        return {
            "ok": True,
            "op": "books.find_semantic",
            "data": {
                "query": q,
                "candidates": cands,
                "top": top,
                "confidence": conf,
            },
        }
    except Exception as e:  # noqa: BLE001
        log("semantic search error:", e)
        return {"ok": False, "op": "books.find_semantic", "error": {"code": "SEM_ERROR", "message": str(e)}}

# ★ Cloud Runでは“ここで起動しない”。CLI側が起動を担当するため、何も書かない。
if __name__ == "__main__":
    import os
    import uvicorn
    # Streamable HTTP の ASGI アプリを作る（エンドポイントは /mcp）
    app = mcp.streamable_http_app()
    # Cloud Run が渡す PORT で 0.0.0.0 にバインド
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
