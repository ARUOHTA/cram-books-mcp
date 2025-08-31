import os
import asyncio
import json
from typing import Any

# サーバ関数を直接呼ぶ（MCPサーバープロセス不要）。
from apps.mcp.server import (
    books_find,
    books_get,
    books_filter,
    books_create,
    books_update,
    books_delete,
    books_list,
    tools_help,
)


def env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise SystemExit(f"ENV {key} is not set")
    return val


async def main() -> None:
    # 事前チェック
    exec_url = env("EXEC_URL")  # 例: https://script.google.com/macros/s/<DEPLOY_ID>/exec
    print(f"EXEC_URL={exec_url}")

    # 1) Help/一覧/検索
    h = await tools_help()
    print("tools_help:", json.dumps(h, ensure_ascii=False)[:200], "...")

    lst = await books_list(limit=5)
    assert lst.get("ok"), f"books_list failed: {lst}"
    ids = [b["id"] for b in lst["data"]["books"] if b.get("id")]  # type: ignore
    print("books_list count=", lst["data"]["count"], "sample=", ids[:3])  # type: ignore

    f = await books_find("青チャート")
    assert f.get("ok"), f"books_find failed: {f}"
    print("books_find top:", f["data"].get("top"))  # type: ignore

    # 2) 詳細取得 単一/複数（一覧の先頭を利用）
    if ids:
        g1 = await books_get(book_id=ids[0])
        assert g1.get("ok"), f"books_get(single) failed: {g1}"
        print("books_get(single) id=", ids[0])
    if len(ids) >= 2:
        g2 = await books_get(book_ids=ids[:2])
        assert g2.get("ok"), f"books_get(multi) failed: {g2}"
        print("books_get(multi) ids=", ids[:2])

    # 3) フィルタ（教科=数学、上位3件）
    flt = await books_filter(where={"教科": "数学"}, limit=3)
    assert flt.get("ok"), f"books_filter failed: {flt}"
    print("books_filter(math) n=", flt["data"]["count"])  # type: ignore

    # 4) 破壊系: create → update(preview→confirm) → delete(preview→confirm)
    created = await books_create(
        title="テスト本（gTMP）",
        subject="数学",
        unit_load=1,
        monthly_goal="1日10分",
        chapters=[{"title": "第1章", "range": {"start": 1, "end": 2}}],
        id_prefix="gTMP",
    )
    assert created.get("ok"), f"books_create failed: {created}"
    new_id = created["data"]["id"]  # type: ignore
    print("books_create id=", new_id)

    preview = await books_update(book_id=new_id, updates={
        "title": "テスト本（gTMP・改）",
        "chapters": [
            {"title": "改・第1章", "range": {"start": 10, "end": 12}},
            {"title": "改・第2章", "range": {"start": 13, "end": 15}},
        ],
    })
    assert preview.get("ok"), f"books_update preview failed: {preview}"
    token = preview["data"].get("confirm_token")  # type: ignore
    assert token, "no confirm_token from preview"
    confirmed = await books_update(book_id=new_id, confirm_token=token)
    assert confirmed.get("ok"), f"books_update confirm failed: {confirmed}"
    print("books_update confirmed")

    del_prev = await books_delete(book_id=new_id)
    assert del_prev.get("ok"), f"books_delete preview failed: {del_prev}"
    del_token = del_prev["data"].get("confirm_token")  # type: ignore
    assert del_token, "no confirm_token for delete"
    del_ok = await books_delete(book_id=new_id, confirm_token=del_token)
    assert del_ok.get("ok"), f"books_delete confirm failed: {del_ok}"
    print("books_delete confirmed")

    print("ALL MCP TESTS PASSED ✔")


if __name__ == "__main__":
    asyncio.run(main())

