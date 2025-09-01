# スピードプランナー「月間管理」仕様メモ（読取のみ）

目的
- 生徒ごとのスプレッドシートにある「月間管理」シートから、指定の年月（B=年, C=月）の実績行をフィルタし、構造化して返す。
- 書き込みは不要。LLMの集計・可視化・要約のための読み口を提供する。

列定義（例）
- A: 258gET012（= 25年8月 + gET012）
- B: 25（年の下2桁）
- C: 8（1..12）
- D: 1（固定・無視）
- E/F: 空（無視）
- G: 参考書ID（非gIDもあり）
- H: 教科
- I: 参考書タイトル
- J: 進め方/目標メモ
- K: 単位処理量（数値）
- L: 月間時間（数値）
- M: 目安処理量（=K×L, 数値）
- N〜R: 1〜5週の実績（文字列）

返却スキーマ（例）
```
{
  "year": 25,
  "month": 8,
  "items": [
    {
      "row": 123,
      "raw_code": "258gET012",
      "month_code": 258,
      "year": 25,
      "month": 8,
      "book_id": "gET012",
      "subject": "英語",
      "title": "LEAP(改)…",
      "guideline_note": "33単語/1時間×2300",
      "unit_load": 33.4,
      "monthly_minutes": 16,
      "guideline_amount": 534.4,
      "weeks": [
        {"index":1, "actual":"No.1601~1700"},
        {"index":2, "actual":"No.1601~1700"},
        {"index":3, "actual":"No.1601~1700"},
        {"index":4, "actual":"No.1701~1800"},
        {"index":5, "actual":""}
      ]
    }
  ],
  "count": 1
}
```

API
- GAS op: `planner.monthly.filter`（入力: student_id? / spreadsheet_id?, year(2桁/4桁), month(1..12)）
- MCP tool: `planner_monthly_filter(year, month, student_id?, spreadsheet_id?)`

テスト
- `SPREADSHEET_ID=... YEAR=25 MONTH=8` を設定して E2E を実行。

