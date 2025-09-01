/**
 * スピードプランナー（週間計画）ハンドラ
 * - 最小権限I/Oのみを提供（読み: A/B/C/D, 日付, メトリクス, 計画; 書き: D1, 計画セル）
 * - 業務ロジック（プレビュー/確定、上書き方針など）は MCP 側で実装
 */
import { CONFIG } from "../config";
import { ApiResponse, ok, ng, toNumberOrNull } from "../lib/common";
import { pickCol, headerKey } from "../lib/sheet_utils";

type RowMap = Record<string, any>;

const SHEET_NAME = "週間管理"; // 正式: 週間管理

// 週→列マッピング（時間/単位/目安/計画）
const WEEK_COLS = [
  /*1*/ { time: "E", unit: "F", guide: "G", plan: "H" },
  /*2*/ { time: "M", unit: "N", guide: "O", plan: "P" },
  /*3*/ { time: "U", unit: "V", guide: "W", plan: "X" },
  /*4*/ { time: "AC", unit: "AD", guide: "AE", plan: "AF" },
  /*5*/ { time: "AK", unit: "AL", guide: "AM", plan: "AN" },
];

// D1/L1/T1/AB1/AJ1（週開始日）
const WEEK_START_ADDR = ["D1", "L1", "T1", "AB1", "AJ1"] as const;

// A/B/C/D 列（4〜30行）を 2 次元配列で取得
function readABCD(sh: GoogleAppsScript.Spreadsheet.Sheet): any[][] {
  return sh.getRange(4, 1, 27, 4).getDisplayValues(); // A4:D30
}

// A列の displayValue から {month_code, book_id} を抽出（261/2601揺れに両対応）
function parseBookCode(raw: string): { month_code: number | null; book_id: string } {
  const s = String(raw || "").trim();
  if (!s) return { month_code: null, book_id: "" };
  const m = s.match(/^(\d{3,4})(.+)$/);
  if (!m) return { month_code: null, book_id: s };
  const code = Number(m[1]);
  const id = m[2];
  return { month_code: Number.isFinite(code) ? code : null, book_id: id };
}

// 学生IDからプランナーの Spreadsheet ID を解決
// - req.spreadsheet_id があれば優先
// - なければ Students Master から「スプレッドシート」URL もしくは「スピードプランナーID」を探す
function resolveSpreadsheetIdByStudent(req: RowMap): string | null {
  if (req.spreadsheet_id) return String(req.spreadsheet_id);
  const student_id = String(req.student_id || "").trim();
  if (!student_id) return null;
  try {
    const ssStu = SpreadsheetApp.openById(req.students_file_id || CONFIG.STUDENTS_FILE_ID);
    const shStu = ssStu.getSheetByName(req.students_sheet || CONFIG.STUDENTS_SHEET) || ssStu.getSheets()[0];
    if (!shStu) return null;
    const values = shStu.getDataRange().getValues();
    if (values.length < 2) return null;
    const headers = values[0].map(String);
    const idxId = pickCol(headers, ["生徒ID", "ID", "id"]);
    const idxPlannerId = pickCol(headers, ["スピードプランナーID", "PlannerSheetId", "planner_sheet_id", "プランナーID"]);
    let idxLink = pickCol(headers, ["スプレッドシート", "スピードプランナー", "PlannerLink", "プランナーリンク", "スプレッドシートURL"]);
    if (idxLink < 0) {
      // 部分一致のフォールバック（見出しにカッコ書き等が付いている場合）
      const HN = headers.map(h => headerKey(h));
      const pos = HN.findIndex(hk => hk.includes(headerKey("スプレッドシート")) || hk.includes("planner") || hk.includes(headerKey("プランナー")));
      if (pos >= 0) idxLink = pos;
    }
    for (let r = 1; r < values.length; r++) {
      const id = String(idxId >= 0 ? values[r][idxId] : "").trim();
      if (!id) continue;
      if (id === student_id) {
        const plannerId = idxPlannerId >= 0 ? String(values[r][idxPlannerId]).trim() : "";
        if (plannerId) return plannerId;
        let link = "";
        if (idxLink >= 0) {
          try {
            const rich = shStu.getRange(r + 1, idxLink + 1).getRichTextValue();
            link = (rich && rich.getLinkUrl()) || String(values[r][idxLink]).trim();
          } catch (_) {
            link = String(values[r][idxLink]).trim();
          }
          if (link) {
            const m = String(link).match(/[-\w]{25,}/); // スプレッドシートURLからID抽出
            if (m) return m[0];
          }
        }
        return null;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function openPlannerSheet(req: RowMap): GoogleAppsScript.Spreadsheet.Sheet | null {
  const fid = req.spreadsheet_id || resolveSpreadsheetIdByStudent(req);
  if (!fid) return null;
  const ss = SpreadsheetApp.openById(fid);
  // 1) 既定名で取得
  const named = ss.getSheetByName(SHEET_NAME);
  if (named) return named;
  // 2) 代替候補名（現場で使われることがある別名）
  const altNames = ["週間計画", "週刊計画", "週刊管理"]; // ゆらぎ吸収
  for (const nm of altNames) {
    const sh = ss.getSheetByName(nm);
    if (sh) return sh;
  }
  // 3) スキャン: A4 が 月コード+ID 形式（^\d{3,4}.+）のシートを探す
  const sheets = ss.getSheets();
  for (const sh of sheets) {
    try {
      const a4 = String(sh.getRange(4, 1).getDisplayValue() || "").trim();
      if (/^\d{3,4}.+/.test(a4)) {
        return sh;
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

// === ids_list: A/B/C/D（行4〜30）の読み取り ===
export function plannerIdsList(req: RowMap): ApiResponse {
  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.ids_list", "NOT_FOUND", "planner sheet not found (resolve by student_id or spreadsheet_id)");
  const abcd = readABCD(sh);
  const items: any[] = [];
  for (let i = 0; i < abcd.length; i++) {
    const r = 4 + i;
    const [a, b, c, d] = abcd[i];
    if (!String(a).trim()) break; // Aが空なら以降打ち切り
    const parsed = parseBookCode(a);
    items.push({
      row: r,
      raw_code: a,
      month_code: parsed.month_code,
      book_id: parsed.book_id,
      subject: String(b || ""), // B列: 教科
      title: String(c || ""),   // C列: タイトル（非gID時に重要）
      guideline_note: String(d || ""), // D列: 進め方の目安（文字列）
    });
  }
  return ok("planner.ids_list", { count: items.length, items });
}

// === dates_get: 週開始日 D1/L1/T1/AB1/AJ1 の読み取り ===
export function plannerDatesGet(req: RowMap): ApiResponse {
  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.dates.get", "NOT_FOUND", "planner sheet not found");
  const values = WEEK_START_ADDR.map((addr) => sh.getRange(addr).getDisplayValue());
  return ok("planner.dates.get", { week_starts: values });
}

// === dates_set: D1 のみ書き込み ===
export function plannerDatesSet(req: RowMap): ApiResponse {
  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.dates.set", "NOT_FOUND", "planner sheet not found");
  const { start_date } = req; // 期待: "YYYY-MM-DD"
  if (!start_date) return ng("planner.dates.set", "BAD_REQUEST", "start_date is required (YYYY-MM-DD)");
  try {
    const d = new Date(String(start_date));
    if (isNaN(d.getTime())) return ng("planner.dates.set", "BAD_DATE", "invalid start_date");
    sh.getRange("D1").setValue(d);
    return ok("planner.dates.set", { updated: true });
  } catch (e: any) {
    return ng("planner.dates.set", "ERROR", e.message);
  }
}

// === metrics_get: 各週の E/F/G（行4〜30）を取得 ===
export function plannerMetricsGet(req: RowMap): ApiResponse {
  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.metrics.get", "NOT_FOUND", "planner sheet not found");
  const rows = sh.getMaxRows();
  const lastRow = Math.min(Math.max(rows, 30), 30); // 4..30 固定
  const outWeeks: any[] = [];
  for (let wi = 0; wi < 5; wi++) {
    const m = WEEK_COLS[wi];
    const range = sh.getRange(`${m.time}4:${m.guide}${lastRow}`);
    const vals = range.getDisplayValues();
    const items = vals.map((v, j) => {
      const r = 4 + j;
      return {
        row: r,
        weekly_minutes: toNumberOrNull(v[0]),
        unit_load: toNumberOrNull(v[1]),
        guideline_amount: toNumberOrNull(v[2]),
      };
    });
    outWeeks.push({ week_index: wi + 1, column_time: m.time, column_unit: m.unit, column_guide: m.guide, items });
  }
  return ok("planner.metrics.get", { weeks: outWeeks });
}

// === plan_get: 計画セル（H/P/X/AF/AN, 行4〜30） ===
export function plannerPlanGet(req: RowMap): ApiResponse {
  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.plan.get", "NOT_FOUND", "planner sheet not found");
  const outWeeks: any[] = [];
  for (let wi = 0; wi < 5; wi++) {
    const m = WEEK_COLS[wi];
    const vals = sh.getRange(`${m.plan}4:${m.plan}30`).getDisplayValues();
    const items = vals.map((v, j) => ({ row: 4 + j, plan_text: String(v[0] || "") }));
    outWeeks.push({ week_index: wi + 1, column: m.plan, items });
  }
  return ok("planner.plan.get", { weeks: outWeeks });
}

// 文字数上限（仕様: 例の約1.3倍=52文字）
const PLAN_TEXT_MAX = 52;

// === plan_set: 計画セルへの書込み（前提: A非空 かつ 対象週のE/M/U/AC/AKが非空） ===
export function plannerPlanSet(req: RowMap): ApiResponse {
  const { week_index, plan_text, overwrite } = req;
  if (!week_index || week_index < 1 || week_index > 5) return ng("planner.plan.set", "BAD_REQUEST", "week_index must be 1..5");
  const text = String(plan_text ?? "");
  if (text.length > PLAN_TEXT_MAX) return ng("planner.plan.set", "TOO_LONG", `plan_text must be <= ${PLAN_TEXT_MAX} chars`);

  const sh = openPlannerSheet(req);
  if (!sh) return ng("planner.plan.set", "NOT_FOUND", "planner sheet not found");

  // 行の特定: book_id（A列由来）または row 指定
  let targetRow = Number(req.row || 0) || null;
  const week = WEEK_COLS[week_index - 1];

  if (!targetRow && req.book_id) {
    const abcd = readABCD(sh); // A4:D30
    for (let i = 0; i < abcd.length; i++) {
      const a = String(abcd[i][0] || "");
      if (!a.trim()) break;
      const parsed = parseBookCode(a);
      if (String(parsed.book_id) === String(req.book_id)) { targetRow = 4 + i; break; }
    }
  }
  if (!targetRow) return ng("planner.plan.set", "ROW_NOT_FOUND", "row or book_id did not match any row");

  // 前提条件: A列非空、週間時間セル非空
  const aVal = sh.getRange(targetRow, 1).getDisplayValue();
  if (!String(aVal).trim()) return ng("planner.plan.set", "PRECONDITION_A_EMPTY", "A[row] must not be empty");
  const timeVal = sh.getRange(`${week.time}${targetRow}`).getDisplayValue();
  if (!String(timeVal).trim()) return ng("planner.plan.set", "PRECONDITION_TIME_EMPTY", `weekly_minutes cell (${week.time}${targetRow}) must not be empty`);

  // 既定: 空欄のみ書き込み（overwrite=false）
  const planCell = sh.getRange(`${week.plan}${targetRow}`);
  const cur = String(planCell.getDisplayValue() || "");
  if (!overwrite && cur.trim() !== "") {
    return ng("planner.plan.set", "ALREADY_EXISTS", `cell already has text; set overwrite=true to replace`);
  }

  planCell.setValue(text);
  return ok("planner.plan.set", { updated: true, cell: `${week.plan}${targetRow}` });
}
