import os
import asyncio
import json
from typing import Any

# サーバ関数を直接呼ぶ（MCPサーバープロセス不要）。
# リポジトリ直下を import path に追加
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..")))

from apps.mcp.server import (
    books_find,
    books_get,
    books_filter,
    books_create,
    books_update,
    books_delete,
    books_list,
    tools_help,
    planner_ids_list,
    planner_dates_get,
    planner_dates_propose,
    planner_dates_confirm,
    planner_metrics_get,
    planner_plan_get,
    planner_plan_create,
    planner_monthly_filter,
    planner_plan_targets,
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

    # Planner E2E
    student_id = os.environ.get("STUDENT_ID")
    spreadsheet_id = os.environ.get("SPREADSHEET_ID")
    # 自動選定: STUDENT_ID 未指定なら在塾生から先頭1〜3名を取得
    auto_students: list[str] = []
    if not (student_id or spreadsheet_id):
        try:
            from apps.mcp.server import students_list  # type: ignore
            sl = await students_list(include_all=False, limit=20)
            if sl.get("ok"):
                cand = [s for s in sl["data"]["students"] if s.get("id")]  # type: ignore
                # planner_sheet_id を持つ生徒を優先
                with_planner = [s for s in cand if s.get("planner_sheet_id")]
                take = with_planner or cand
                auto_students = [s.get("id") for s in take[:3] if s.get("id")]
        except Exception:
            pass
    if student_id or spreadsheet_id or auto_students:
        print("\n-- Planner tests (optional) --")
        for sid in ([student_id] if student_id else auto_students) or [None]:
            ids = await planner_ids_list(student_id=sid, spreadsheet_id=spreadsheet_id)
            assert ids.get("ok"), f"planner_ids_list failed: {ids}"
            items = (ids.get("data") or {}).get("items") or []
            print(f"ids_list[{sid}] n=", len(items))

            dget = await planner_dates_get(student_id=sid, spreadsheet_id=spreadsheet_id)
            assert dget.get("ok"), f"planner_dates_get failed: {dget}"
            print("dates_get:", dget.get("data"))

            mets = await planner_metrics_get(student_id=sid, spreadsheet_id=spreadsheet_id)
            assert mets.get("ok"), f"planner_metrics_get failed: {mets}"
            print("metrics_get: weeks=", len((mets.get("data") or {}).get("weeks") or []))

            plans = await planner_plan_get(student_id=sid, spreadsheet_id=spreadsheet_id)
            assert plans.get("ok"), f"planner_plan_get failed: {plans}"
            print("plan_get: weeks=", len((plans.get("data") or {}).get("weeks") or []))

            # Write small sample (create) on one empty cell, then revert
            target = None
            weeks = (plans.get("data") or {}).get("weeks") or []
            for wk in weeks:
                for it in wk.get("items", []):
                    if not it.get("plan_text"):
                        target = (wk.get("index") or wk.get("week_index")), it.get("row")
                        break
                if target:
                    break
            if target:
                wk_index, row = target
                cr = await planner_plan_create(items=[{"week_index": int(wk_index), "row": int(row), "plan_text": "テスト"}], student_id=sid, spreadsheet_id=spreadsheet_id)
                assert cr.get("ok"), f"planner_plan_create failed: {cr}"
                # revert
                rv = await planner_plan_create(items=[{"week_index": int(wk_index), "row": int(row), "plan_text": "", "overwrite": True}], student_id=sid, spreadsheet_id=spreadsheet_id)
                assert rv.get("ok"), f"planner_plan_create(revert) failed: {rv}"
                print("plan_create single + revert ok")
            else:
                print("no empty cell found for plan_propose; skipping write preview")
        # targets & bulk create (safe round-trip)
        tg = await planner_plan_targets(student_id=student_id, spreadsheet_id=spreadsheet_id)
        if tg.get("ok"):
            titems = (tg.get("data") or {}).get("targets") or []
            # pick up to 1-2 empty cells for safe write
            pick = []
            for it in titems:
                if len(pick) >= 2: break
                pick.append({"week_index": it.get("week_index"), "row": it.get("row"), "plan_text": "テスト"})
            if pick:
                cbulk = await planner_plan_create(items=pick, student_id=student_id, spreadsheet_id=spreadsheet_id)
                assert cbulk.get("ok"), f"create(items) failed: {cbulk}"
                # revert
                ritems = [{"week_index": x["week_index"], "row": x["row"], "plan_text": "", "overwrite": True} for x in pick]
                rc = await planner_plan_create(items=ritems, student_id=student_id, spreadsheet_id=spreadsheet_id)
                assert rc.get("ok"), f"revert(items) failed: {rc}"
                print("create(items) + revert ok")
        # Stress test: create(items) many entries then revert (small N to avoid timeout)
        if spreadsheet_id:
            tg = await planner_plan_targets(student_id=student_id, spreadsheet_id=spreadsheet_id)
            if tg.get("ok"):
                titems = (tg.get("data") or {}).get("targets") or []
                # pick up to BULK_N (default 12)
                try:
                    n = int(os.environ.get("BULK_N", "12"))
                except Exception:
                    n = 12
                pick = []
                for it in titems:
                    if len(pick) >= n: break
                    pick.append({"week_index": it.get("week_index"), "row": it.get("row"), "plan_text": "テスト"})
                if pick:
                    import time
                    t0 = time.monotonic()
                    c = await planner_plan_create(items=pick, student_id=student_id, spreadsheet_id=spreadsheet_id)
                    assert c.get("ok"), f"bulk create(items) failed: {c}"
                    t1 = time.monotonic()
                    # revert
                    rc = await planner_plan_create(items=[{**x, "plan_text":"", "overwrite": True} for x in pick], student_id=student_id, spreadsheet_id=spreadsheet_id)
                    assert rc.get("ok"), f"bulk revert failed: {rc}"
                    t2 = time.monotonic()
                    print(f"bulk(items) n={len(pick)} write={t1-t0:.2f}s revert={t2-t1:.2f}s total={t2-t0:.2f}s")

        # Monthly (if SPREADSHEET_ID provided)
        if spreadsheet_id:
            ym_year = int(os.environ.get("YEAR", "25"))
            ym_month = int(os.environ.get("MONTH", "8"))
            mon = await planner_monthly_filter(year=ym_year, month=ym_month, spreadsheet_id=spreadsheet_id)
            assert mon.get("ok"), f"planner_monthly_filter failed: {mon}"
            cnt = (mon.get("data") or {}).get("count")
            print(f"monthly_filter y={ym_year} m={ym_month} count=", cnt)
    else:
        print("(planner tests skipped: set STUDENT_ID or SPREADSHEET_ID to enable)")


if __name__ == "__main__":
    asyncio.run(main())
