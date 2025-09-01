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

# --- Simple in-memory preview cache for propose→confirm ---
_PREVIEW_CACHE: dict[str, dict] = {}
def _preview_put(payload: dict) -> str:
    import uuid
    token = str(uuid.uuid4())
    _PREVIEW_CACHE[token] = payload
    return token
def _preview_get(token: str) -> dict | None:
    return _PREVIEW_CACHE.get(token)
def _preview_pop(token: str) -> dict | None:
    return _PREVIEW_CACHE.pop(token, None)

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


# ===== Students API (MVP: master sheet only) =====

def _normkey(k: str) -> str: return k.strip().lower()

@mcp.tool()
async def students_list(limit: int | None = None, include_all: bool | None = None) -> dict:
    """生徒一覧（親行のみ、id/name/grade/linksの簡易形）。

    既定は「在塾のみ」。退塾や講師等も含める場合は include_all=true を指定。
    """
    # 既定: 在塾のみ
    if not include_all:
        try:
            data = await _post({"op": "students.filter", "where": {"Status": "在塾"}, "limit": limit or 0})
        except Exception as e:
            return {"ok": False, "op": "students.list", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}
    else:
        try:
            data = await _get({"op": "students.list", "limit": limit or 0})
        except Exception as e:
            return {"ok": False, "op": "students.list", "error": {"code": "HTTP_GET_ERROR", "message": str(e)}}
    if not isinstance(data, dict) or not data.get("ok"):
        return {"ok": False, "op": "students.list", "error": {"code": "UPSTREAM_ERROR", "message": str(data)}}
    items = ((data.get("data") or {}).get("students") or [])
    students = [{
        "id": s.get("id"),
        "name": s.get("name"),
        "grade": s.get("grade"),
        "planner_sheet_id": s.get("planner_sheet_id"),
        "meeting_doc_id": s.get("meeting_doc_id"),
    } for s in items if isinstance(s, dict)]
    return {"ok": True, "op": "students.list", "data": {"students": students, "count": len(students)}}

@mcp.tool()
async def students_find(query: Any, limit: int | None = 10, include_all: bool | None = None) -> dict:
    q = _coerce_str(query, ("query","q","text"))
    if not q: return {"ok": False, "op": "students.find", "error": {"code": "BAD_INPUT", "message": "query is required"}}
    # 既定: 在塾のみ（contains: 名前）
    if not include_all:
        try:
            return await _post({"op": "students.filter", "where": {"Status": "在塾"}, "contains": {"名前": q}, "limit": limit or 0})
        except Exception as e:
            return {"ok": False, "op": "students.find", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}
    else:
        try:
            return await _get({"op": "students.find", "query": q, "limit": limit or 0})
        except Exception as e:
            return {"ok": False, "op": "students.find", "error": {"code": "HTTP_GET_ERROR", "message": str(e)}}

@mcp.tool()
async def students_get(student_id: Any = None, student_ids: Any = None) -> dict:
    # 単一/複数対応
    def _as_list(x: Any) -> list[str]:
        if x is None: return []
        if isinstance(x, (list, tuple)):
            out = []
            for v in x:
                if isinstance(v, str): out.append(_strip_quotes(v))
                elif isinstance(v, dict):
                    s = _coerce_str(v, ("student_id","id"))
                    if s: out.append(s)
            return out
        if isinstance(x, str): return [_strip_quotes(x)]
        return []
    many = _as_list(student_ids)
    if not many and isinstance(student_id,(list,tuple)): many=_as_list(student_id)
    single = _coerce_str(student_id, ("student_id","id")) if not many else None
    params: dict[str, Any] = {"op": "students.get"}
    if many: params["student_ids"] = many
    elif single: params["student_id"] = single
    else: return {"ok": False, "op": "students.get", "error": {"code": "BAD_INPUT", "message": "student_id or student_ids is required"}}
    try:
        return await _post(params)
    except Exception as e:
        return {"ok": False, "op": "students.get", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}

@mcp.tool()
async def students_filter(where: Any = None, contains: Any = None, limit: int | None = None, include_all: bool | None = None) -> dict:
    payload: dict[str, Any] = {"op": "students.filter"}
    if isinstance(where, dict): payload["where"] = where
    if isinstance(contains, dict): payload["contains"] = contains
    if isinstance(limit, int) and limit>0: payload["limit"] = limit
    # 既定: 在塾のみ（呼び出し側で Status が指定されていなければ自動付与）
    if not include_all:
        w = payload.get("where") or {}
        # 明示的に Status が指定されていない場合のみ上書き
        if not isinstance(w, dict) or ("Status" not in w and "status" not in w):
            payload["where"] = {**(w if isinstance(w, dict) else {}), "Status": "在塾"}
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "students.filter", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}

@mcp.tool()
async def students_create(record: dict[str, Any] | None = None, id_prefix: str | None = None) -> dict:
    """生徒の新規作成。record にシート見出し→値で渡す（例: {"名前":"山田太郎","学年":"高1"}）。
    可能であれば `名前/学年` を含める。IDは s / id_prefix で自動採番。
    """
    payload = {"op": "students.create", "record": record or {}}
    if id_prefix: payload["id_prefix"] = id_prefix
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "students.create", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}

@mcp.tool()
async def students_update(student_id: Any, updates: dict[str, Any] | None = None, confirm_token: str | None = None) -> dict:
    """生徒の更新（二段階）。updates は見出し→値のマップ。"""
    sid = _coerce_str(student_id, ("student_id","id"))
    if not sid: return {"ok": False, "op": "students.update", "error": {"code": "BAD_INPUT", "message": "student_id is required"}}
    payload: dict[str, Any] = {"op": "students.update", "student_id": sid}
    if confirm_token: payload["confirm_token"] = confirm_token
    else:
        if isinstance(updates, dict): payload["updates"] = updates
        else: return {"ok": False, "op": "students.update", "error": {"code": "BAD_INPUT", "message": "updates is required for preview"}}
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "students.update", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}

@mcp.tool()
async def students_delete(student_id: Any, confirm_token: str | None = None) -> dict:
    sid = _coerce_str(student_id, ("student_id","id"))
    if not sid: return {"ok": False, "op": "students.delete", "error": {"code": "BAD_INPUT", "message": "student_id is required"}}
    payload: dict[str, Any] = {"op": "students.delete", "student_id": sid}
    if confirm_token: payload["confirm_token"] = confirm_token
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "students.delete", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


@mcp.tool()
async def books_create(title: str, subject: str, unit_load: Any = None, monthly_goal: str | None = None, chapters: Any = None, id_prefix: str | None = None) -> dict:
    """参考書を新規作成（GAS WebApp: books.create）。LLM向け・重要ルール:

    1) 章の配列は「最終形」を完全指定すること（追記ではない）。
    2) numbering（番号の数え方）は必ず埋めること（空欄にしない）。代表例:
       - 問題集/演習系 → "問"、語彙/単語集 → "No.", 英作文/講義系 → "講" or "Lesson" など。
       - 迷ったら問題番号なら "問"、英単語なら "No." を推奨。
    3) 章またぎの番号の扱い（range.start）:
       - 原則は章ごとにリセット（各章の start=1）。
       - 書籍が章をまたいで連番の場合のみ、次章の start=前章 end+1 に設定（例: 1章1-20 → 2章21-40）。
    4) 最初の章はシートの「親行」に入り、第2章以降は下行に追加される（GAS側仕様）。
    5) 数値は数値型で渡す（unit_load: 2 など）。id は自動採番（id_prefix で接頭辞指定可）。

    例（章ごとにリセット）:
    {"title":"語彙テスト","subject":"英語","unit_load":1,
     "chapters":[
       {"title":"第1章", "range":{"start":1, "end":200}, "numbering":"No."},
       {"title":"第2章", "range":{"start":1, "end":180}, "numbering":"No."}
     ]}

    例（章をまたいで連番）:
    {"title":"標準問題精講","subject":"数学","unit_load":2,
     "chapters":[
       {"title":"第1章", "range":{"start":1,  "end":20}, "numbering":"問"},
       {"title":"第2章", "range":{"start":21, "end":40}, "numbering":"問"}
     ]}
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

    入力の注意（LLM向け）:
    - updates.chapters は「完全置換」（追記ではない）。最終形の配列を渡す。
    - numbering（番号の数え方）は必ず埋める（空欄禁止）。例: 問/No./講/Lesson など。
    - 章またぎ番号の扱い: 原則リセット（各章 start=1）。連番が正しい書籍のみ carry-over（次章 start=前章 end+1）。
    - 第1章は親行、2章目以降は下行へ書き込み（create と同等）。
    - 変更しない項目は updates に含めない（空文字上書きを避ける）。
    - 数値は数値型で渡す（unit_load 等）。
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
    """参考書を簡易一覧（id/subject/title のみ）。

    実装: books.filter（条件なし）で全件を取得し、必要最小項目に整形。
    - limit 指定時はその件数に切り詰め。
    - 依存: WebAppの books.filter（POST）。table.read には依存しない。
    """
    payload: dict[str, Any] = {"op": "books.filter"}
    if isinstance(limit, int) and limit > 0:
        payload["limit"] = limit
    try:
        data = await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "books.list", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}

    if not isinstance(data, dict) or not data.get("ok"):
        return {"ok": False, "op": "books.list", "error": {"code": "UPSTREAM_ERROR", "message": str(data)}}

    items = ((data.get("data") or {}).get("books") or [])
    books = [
        {"id": b.get("id"), "subject": b.get("subject"), "title": b.get("title")}
        for b in items if isinstance(b, dict)
    ]
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
            "example": {"title":"テスト本","subject":"数学","unit_load":2,"chapters":[{"title":"第1章","range":{"start":1,"end":20},"numbering":"問"}]},
            "notes": "chaptersは最終形（完全指定）。numberingは必ず埋める（問/No./講など）。原則は章ごとにstart=1、連番書籍のみcarry。第1章は親行、2章以降は下行。数値は数値型で。"
        },
        {
            "name": "books_update",
            "desc": "二段階更新（preview→confirm）",
            "args": {"book_id":"string","updates":"object?","confirm_token":"string?"},
            "example_preview": {"book_id":"gMB017","updates":{"title":"（改）"}},
            "example_confirm": {"book_id":"gMB017","confirm_token":"…"},
            "notes": "updates.chaptersは完全置換。numberingは必ず埋める。章またぎは原則リセット（start=1）、連番書籍のみcarry。章1は親行、章2以降は下行。未変更項目は含めない。"
        },
        {
            "name": "books_delete",
            "desc": "二段階削除（preview→confirm）",
            "args": {"book_id":"string","confirm_token":"string?"},
            "example_preview": {"book_id":"gMB017"},
            "example_confirm": {"book_id":"gMB017","confirm_token":"…"},
        },
        {
            "name": "planner_ids_list",
            "desc": "A4:D30のID+教科+タイトル+進め方メモを取得（単一月シート）",
            "args": {"student_id": "string?", "spreadsheet_id": "string?"},
            "example": {"student_id": "S123"},
        },
        {
            "name": "planner_dates_get",
            "desc": "週開始日 D1/L1/T1/AB1/AJ1 を取得",
            "args": {"student_id": "string?", "spreadsheet_id": "string?"},
        },
        {
            "name": "planner_dates_propose",
            "desc": "D1 の変更プレビュー（confirm で確定）",
            "args": {"start_date": "YYYY-MM-DD", "student_id": "string?", "spreadsheet_id": "string?"},
        },
        {
            "name": "planner_dates_confirm",
            "desc": "D1 変更の確定",
            "args": {"confirm_token": "string"},
        },
        {
            "name": "planner_metrics_get",
            "desc": "週ごとの E/F/G（週間時間/単位処理量/目安処理量）を取得",
            "args": {"student_id": "string?", "spreadsheet_id": "string?"},
        },
        {
            "name": "planner_plan_get",
            "desc": "計画セル（H/P/X/AF/AN, 行4〜30）を取得（改行保持）",
            "args": {"student_id": "string?", "spreadsheet_id": "string?"},
        },
        {
            "name": "planner_plan_propose",
            "desc": "計画セルのプレビュー（overwrite規則と52文字上限を前提）",
            "args": {"week_index": "1..5", "plan_text": "string", "overwrite": "bool?", "book_id": "string?", "row": "number?", "student_id": "string?", "spreadsheet_id": "string?"},
        },
        {
            "name": "planner_plan_confirm",
            "desc": "計画セルの確定（proposeトークン必須）",
            "args": {"confirm_token": "string"},
        },
        {
            "name": "planner_guidance",
            "desc": "LLM向け：週間管理の計画作成ガイド（書式/上限/前提/手順）",
            "args": {},
        },
    ]
    return {"ok": True, "op": "tools.help", "data": {"tools": tools}}


# ===== Planner (weekly) tools =====

@mcp.tool()
async def planner_ids_list(student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    """A4:D30 を読み取り、raw_code/月コード/book_id/教科/タイトル/進め方メモを返します。

    引数: student_id か spreadsheet_id（どちらか必須）
    """
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    if not (sid or spid):
        return {"ok": False, "op": "planner.ids_list", "error": {"code": "BAD_INPUT", "message": "student_id or spreadsheet_id is required"}}
    payload = {"op": "planner.ids_list"}
    if sid: payload["student_id"] = sid
    if spid: payload["spreadsheet_id"] = spid
    return await _post(payload)

@mcp.tool()
async def planner_dates_get(student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    payload: dict[str, Any] = {"op": "planner.dates.get"}
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    if sid: payload["student_id"] = sid
    if spid: payload["spreadsheet_id"] = spid
    return await _post(payload)

@mcp.tool()
async def planner_dates_propose(start_date: str, student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    """D1 を変更するプレビューを作成（差分だけを返し、確定は confirm で）。"""
    get = await planner_dates_get(student_id=student_id, spreadsheet_id=spreadsheet_id)
    if not isinstance(get, dict) or not get.get("ok"):
        return {"ok": False, "op": "planner.dates.propose", "error": {"code": "UPSTREAM", "message": str(get)}}
    before = (get.get("data") or {}).get("week_starts")
    token = _preview_put({
        "op": "planner.dates.set",
        "student_id": _coerce_str(student_id, ("student_id","id")),
        "spreadsheet_id": _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id")),
        "start_date": start_date,
    })
    return {"ok": True, "op": "planner.dates.propose", "data": {"confirm_token": token, "effects": [{"cell": "D1", "before": before[0] if isinstance(before, list) else None, "after": start_date}]}}

@mcp.tool()
async def planner_dates_confirm(confirm_token: str) -> dict:
    payload = _preview_pop(confirm_token)
    if not payload:
        return {"ok": False, "op": "planner.dates.confirm", "error": {"code": "CONFIRM_EXPIRED", "message": "invalid token"}}
    payload["op"] = "planner.dates.set"
    return await _post(payload)

@mcp.tool()
async def planner_metrics_get(student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    payload: dict[str, Any] = {"op": "planner.metrics.get"}
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    if sid: payload["student_id"] = sid
    if spid: payload["spreadsheet_id"] = spid
    return await _post(payload)

@mcp.tool()
async def planner_plan_get(student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    # 1) plans
    payload: dict[str, Any] = {"op": "planner.plan.get"}
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    if sid: payload["student_id"] = sid
    if spid: payload["spreadsheet_id"] = spid
    plans = await _post(payload)
    if not plans.get("ok"):
        return plans
    # 2) metrics（同じ入力で取得）
    mets = await planner_metrics_get(student_id=sid, spreadsheet_id=spid)
    if not mets.get("ok"):
        # metricsが落ちてもプランは返す（後方互換）
        return plans
    # 3) 結合: week×row で weekly_minutes/unit_load/guideline_amount を付与
    def index_by_row(items: list[dict]):
        out = {}
        for it in items or []:
            try:
                out[int(it.get("row"))] = it
            except Exception:
                pass
        return out
    mets_by_wk = {int(w.get("week_index")): index_by_row((w.get("items") or [])) for w in ((mets.get("data") or {}).get("weeks") or [])}
    weeks = ((plans.get("data") or {}).get("weeks") or [])
    for w in weeks:
        wi = int(w.get("week_index") or w.get("index") or 0)
        rowmap = mets_by_wk.get(wi, {})
        for it in (w.get("items") or []):
            try:
                r = int(it.get("row"))
            except Exception:
                continue
            m = rowmap.get(r) or {}
            if m:
                it["weekly_minutes"] = m.get("weekly_minutes")
                it["unit_load"] = m.get("unit_load")
                it["guideline_amount"] = m.get("guideline_amount")
    return {"ok": True, "op": "planner.plan.get", "data": {"weeks": weeks}}

@mcp.tool()
async def planner_plan_propose(week_index: int | None = None, plan_text: str | None = None, overwrite: bool | None = None, *, book_id: str | None = None, row: int | None = None, student_id: Any = None, spreadsheet_id: Any = None, items: Any = None) -> dict:
    """計画セルのプレビューを作成（単体/複数どちらも）。

    ルール（重要）:
    - 既定: overwrite=false（空欄のみ埋める）。明示時のみ上書き。
    - 文字数上限: 52文字（Unicode）。超える場合は要約・分割を検討。
    - 書込前提: 行Aが非空、かつその週の「週間時間」が非空のセルのみ対象。
    - 書式ガイド（例）: 「No.951~1050」「Lesson11~12」「数A：9~21,29~46」「英文1~2 演習・精読・音読」。
    - 記述は簡潔に。波線「~」で範囲、カンマで複数範囲、必要なら改行を使用。
    - 非gID行ではC列のタイトル・D列の進め方メモを参考に、無理に正規化しない。

    提案のみを作成し、最終反映は planner_plan_confirm で行います（単体/一括いずれも）。
    """

    async def _propose_single(wi: int, txt: str, target_row: int | None, target_book_id: str | None) -> dict:
        if not (target_book_id or target_row):
            return {"ok": False, "error": {"code": "MISSING_TARGET", "message": "row or book_id required"}}
        # 現在値を取得して diff を作成
        current = await planner_plan_get(student_id=student_id, spreadsheet_id=spreadsheet_id)
        if not isinstance(current, dict) or not current.get("ok"):
            return {"ok": False, "error": {"code": "UPSTREAM", "message": str(current)}}
        weeks = (current.get("data") or {}).get("weeks") or []
        before_text: str | None = None
        cell = None
        try:
            # book_id 指定時は ids_list で行を解決
            tgt_row = target_row
            if target_book_id and not tgt_row:
                ids = await planner_ids_list(student_id=student_id, spreadsheet_id=spreadsheet_id)
                if ids.get("ok"):
                    for it in (ids["data"]["items"] or []):  # type: ignore
                        if it.get("book_id") == target_book_id:
                            tgt_row = it.get("row")
                            break
            wk = next(w for w in weeks if int(w.get("index", w.get("week_index"))) == int(wi))
            col = wk.get("column")
            if tgt_row:
                for item in wk.get("items", []):
                    if int(item.get("row")) == int(tgt_row):
                        before_text = item.get("plan_text")
                        break
                cell = f"{col}{tgt_row}"
        except Exception:
            pass
        payload = {
            "op": "planner.plan.set",
            "student_id": _coerce_str(student_id, ("student_id","id")),
            "spreadsheet_id": _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id")),
            "week_index": wi,
            "plan_text": txt,
            "overwrite": bool(overwrite) if overwrite is not None else False,
        }
        if target_book_id: payload["book_id"] = target_book_id
        if target_row: payload["row"] = target_row
        token = _preview_put(payload)
        return {"ok": True, "data": {"confirm_token": token, "effects": [{"cell": cell, "before": {"plan_text": before_text}, "after": {"plan_text": txt}}]}}

    # 複数（items）の場合
    if isinstance(items, list) and items:
        child_tokens: list[str] = []
        effects_all: list[dict] = []
        warnings: list[str] = []
        for it in items:
            try:
                wi = int(it.get("week_index"))
                txt = str(it.get("plan_text") or "")
            except Exception:
                warnings.append(f"bad item: {it}")
                continue
            ow_local = it.get("overwrite")
            if ow_local is not None:
                # 一時的にoverwriteをローカル上書き
                old_overwrite = overwrite
                overwrite = bool(ow_local)
            res = await _propose_single(wi, txt, it.get("row"), it.get("book_id"))
            if ow_local is not None:
                overwrite = old_overwrite
            if not res.get("ok"):
                warnings.append(str(res))
                continue
            child_tokens.append(res["data"]["confirm_token"])
            eff = (res["data"] or {}).get("effects") or []
            if isinstance(eff, list): effects_all.extend(eff)
        if not child_tokens:
            return {"ok": False, "op": "planner.plan.propose", "error": {"code": "NO_EFFECTS", "message": "no valid items"}, "data": {"effects": [], "warnings": warnings}}
        bulk_token = _preview_put({"bulk_children": child_tokens})
        return {"ok": True, "op": "planner.plan.propose", "data": {"confirm_token": bulk_token, "effects": effects_all, "warnings": warnings}}

    # 単体（従来互換）
    if week_index is None or plan_text is None:
        return {"ok": False, "op": "planner.plan.propose", "error": {"code": "BAD_INPUT", "message": "week_index and plan_text are required for single propose"}}
    res = await _propose_single(int(week_index), str(plan_text), row, book_id)
    if not res.get("ok"):
        return {"ok": False, "op": "planner.plan.propose", "error": res.get("error")}
    return {"ok": True, "op": "planner.plan.propose", "data": res["data"]}

@mcp.tool()
async def planner_plan_confirm(confirm_token: str) -> dict:
    saved = _preview_pop(confirm_token)
    if not saved:
        return {"ok": False, "op": "planner.plan.confirm", "error": {"code": "CONFIRM_EXPIRED", "message": "invalid token"}}
    # 一括トークン
    if isinstance(saved, dict) and saved.get("bulk_children"):
        children = saved.get("bulk_children") or []
        results: list[dict] = []
        for tok in children:
            pay = _preview_pop(tok)
            if not pay:
                results.append({"ok": False, "error": {"code": "CHILD_EXPIRED"}})
                continue
            pay["op"] = "planner.plan.set"
            res = await _post(pay)
            results.append({"ok": bool(res.get("ok")), "data": res.get("data"), "error": res.get("error")})
        ok_count = sum(1 for r in results if r.get("ok"))
        return {"ok": True, "op": "planner.plan.confirm", "data": {"confirmed": ok_count, "results": results}}
    # 単体
    saved["op"] = "planner.plan.set"
    res = await _post(saved)
    return res

@mcp.tool()
async def planner_monthly_filter(year: int | str, month: int | str, student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    """月間管理から指定年月(B=年下2桁, C=月)の実績を取得（読み取り専用）。

    引数:
    - year: 25 または 2025（4桁可: 2000を引いて2桁に正規化）
    - month: 1..12
    - student_id または spreadsheet_id のいずれか
    """
    payload: dict[str, Any] = {"op": "planner.monthly.filter", "year": year, "month": month}
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    if sid: payload["student_id"] = sid
    if spid: payload["spreadsheet_id"] = spid
    try:
        return await _post(payload)
    except Exception as e:
        return {"ok": False, "op": "planner.monthly.filter", "error": {"code": "HTTP_POST_ERROR", "message": str(e)}}


# ===== Weekly Planner: targets（自動抽出） =====

def _week_count_from_dates(dget: dict) -> int:
    ws = ((dget.get("data") or {}).get("week_starts")) if isinstance(dget, dict) else None
    if isinstance(ws, list):
        cnt = sum(1 for x in ws if str(x or "").strip() != "")
        return cnt if cnt in (4,5) else len(ws)
    return 5

def _index_by_row(items: list[dict], key: str = "row") -> dict[int, dict]:
    out: dict[int, dict] = {}
    for it in items or []:
        try:
            r = int(it.get(key))
            out[r] = it
        except Exception:
            continue
    return out

@mcp.tool()
async def planner_plan_targets(student_id: Any = None, spreadsheet_id: Any = None) -> dict:
    """書込み候補セル（A非空・週間時間非空・計画未入力）を週×行で自動抽出します。

    返却: { week_count, targets:[{week_index,row,book_id,weekly_minutes,guideline_amount,prev_range_hint?}] }
    """
    sid = _coerce_str(student_id, ("student_id","id"))
    spid = _coerce_str(spreadsheet_id, ("spreadsheet_id","sheet_id","id"))
    # 1) 基本情報
    ids = await planner_ids_list(student_id=sid, spreadsheet_id=spid)
    if not ids.get("ok"):
        return {"ok": False, "op": "planner.plan.targets", "error": {"code": "UPSTREAM_IDS", "message": str(ids)}}
    dates = await planner_dates_get(student_id=sid, spreadsheet_id=spid)
    if not dates.get("ok"):
        return {"ok": False, "op": "planner.plan.targets", "error": {"code": "UPSTREAM_DATES", "message": str(dates)}}
    week_count = _week_count_from_dates(dates)
    mets = await planner_metrics_get(student_id=sid, spreadsheet_id=spid)
    if not mets.get("ok"):
        return {"ok": False, "op": "planner.plan.targets", "error": {"code": "UPSTREAM_METRICS", "message": str(mets)}}
    plans = await planner_plan_get(student_id=sid, spreadsheet_id=spid)
    if not plans.get("ok"):
        return {"ok": False, "op": "planner.plan.targets", "error": {"code": "UPSTREAM_PLANS", "message": str(plans)}}

    id_items = (ids.get("data") or {}).get("items") or []
    rows_with_book = set(int(it.get("row")) for it in id_items if it.get("row"))
    row_to_book = {int(it["row"]): it.get("book_id") for it in id_items if it.get("row")}

    # 週ごとの maps
    wk_metrics: dict[int, dict[int, dict]] = {}
    for wk in ((mets.get("data") or {}).get("weeks") or []):
        wi = int(wk.get("week_index"))
        wk_metrics[wi] = _index_by_row(wk.get("items") or [])
    wk_plans: dict[int, dict[int, dict]] = {}
    for wk in ((plans.get("data") or {}).get("weeks") or []):
        wi = int(wk.get("week_index"))
        wk_plans[wi] = _index_by_row(wk.get("items") or [])

    targets: list[dict] = []
    for wi in range(1, week_count + 1):
        metrics_rows = wk_metrics.get(wi, {})
        plans_rows = wk_plans.get(wi, {})
        for r in sorted(rows_with_book):
            m = metrics_rows.get(r) or {}
            p = plans_rows.get(r) or {}
            weekly_minutes = m.get("weekly_minutes")
            plan_text = (p.get("plan_text") or "").strip()
            if weekly_minutes is None or str(weekly_minutes) == "":
                continue  # 週間時間が空 → 対象外
            if plan_text != "":
                continue  # 既に埋まっている
            # 直前週のヒント（prev_range_hint）
            prev_hint = ""
            for wj in range(wi-1, 0, -1):
                pj = wk_plans.get(wj, {}).get(r)
                if pj and str(pj.get("plan_text") or "").strip():
                    prev_hint = str(pj.get("plan_text"))
                    break
            targets.append({
                "week_index": wi,
                "row": r,
                "book_id": row_to_book.get(r),
                "weekly_minutes": weekly_minutes,
                "guideline_amount": (metrics_rows.get(r) or {}).get("guideline_amount"),
                "prev_range_hint": prev_hint,
            })

    return {"ok": True, "op": "planner.plan.targets", "data": {"week_count": week_count, "targets": targets}}



@mcp.tool()
async def planner_guidance() -> dict:
    """LLM向け：週間管理シートの計画作成ガイドを返します。

    概要:
    - シート: 「週間管理」。行4〜30、A列= <月コード><book_id>（例: 258gET007）。月コードは3/4桁（261/2601）。単一月のみ。
    - 週列: 週1=E/F/G/H、週2=M/N/O/P、週3=U/V/W/X、週4=AC/AD/AE/AF、週5=AK/AL/AM/AN。計画は H/P/X/AF/AN。
    - 開始日: D1→+7でL1/T1/AB1/AJ1。
    - 前提: A[row]非空、かつ対象週の「週間時間」非空のときのみ計画を作成。
    - 書込既定: 空欄のみ埋める（overwrite=false）。上書きは明示時のみ。
    - 上限: 52文字/セル。超過は要約・分割（次週など）で調整。
    - 書式: 範囲は「~」、複数はカンマ/改行、自由記述は簡潔に。
    - 非gID: C列タイトル/D列ガイドラインを尊重（無理な正規化をしない）。
    - 推奨手順: ids_list→metrics_get→plan_get→plan_propose→（承認後）plan_confirm。
    """
    return {
        "ok": True,
        "op": "planner.guidance",
        "data": {
            "sheet": {
                "name": "週間管理",
                "rows": "4-30",
                "id_column": "A: <month_code><book_id> (3/4桁月コード許容)",
                "weeks": {
                    "1": {"time":"E","unit":"F","guide":"G","plan":"H"},
                    "2": {"time":"M","unit":"N","guide":"O","plan":"P"},
                    "3": {"time":"U","unit":"V","guide":"W","plan":"X"},
                    "4": {"time":"AC","unit":"AD","guide":"AE","plan":"AF"},
                    "5": {"time":"AK","unit":"AL","guide":"AM","plan":"AN"}
                },
                "week_starts": ["D1","L1","T1","AB1","AJ1"]
            },
            "policy": {
                "preconditions": ["A[row]非空","週間時間セル非空"],
                "overwrite_default": False,
                "max_chars": 52
            },
            "format": {
                "range": "~ を用いる (No.951~1050, Lesson11~12)",
                "multi": "カンマ/改行で複数範囲 (9~21,29~46)",
                "freeform": "短く具体的に (演習・精読・音読)"
            },
            "nongid": {"respect_title": True, "use_guideline_note": True}
        }
    }

if __name__ == "__main__":
    import uvicorn
    app = mcp.streamable_http_app()
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
