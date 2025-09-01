/**
 * スピードプランナー「月間管理」読取ハンドラ
 * - 読み取り専用: 指定 (year, month) の行をフィルタして返す
 */
import { ApiResponse, ok, ng, toNumberOrNull } from "../lib/common";
import { pickCol, headerKey } from "../lib/sheet_utils";
import { CONFIG } from "../config";

type RowMap = Record<string, any>;

const SHEET_NAME = "月間管理";

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
    const idxLink = pickCol(headers, ["スプレッドシート", "スピードプランナー", "PlannerLink", "プランナーリンク", "スプレッドシートURL"]);
    for (let r = 1; r < values.length; r++) {
      const id = String(idxId >= 0 ? values[r][idxId] : "").trim();
      if (!id) continue;
      if (id === student_id) {
        const plannerId = idxPlannerId >= 0 ? String(values[r][idxPlannerId]).trim() : "";
        if (plannerId) return plannerId;
        if (idxLink >= 0) {
          try {
            const rich = shStu.getRange(r + 1, idxLink + 1).getRichTextValue();
            const url = (rich && rich.getLinkUrl()) || String(values[r][idxLink]).trim();
            const m = String(url).match(/[-\w]{25,}/);
            if (m) return m[0];
          } catch (_) {
            const raw = String(values[r][idxLink]).trim();
            const m = raw.match(/[-\w]{25,}/);
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

function openMonthlySheet(req: RowMap): GoogleAppsScript.Spreadsheet.Sheet | null {
  const fid = req.spreadsheet_id || resolveSpreadsheetIdByStudent(req);
  if (!fid) return null;
  const ss = SpreadsheetApp.openById(fid);
  const sh = ss.getSheetByName(SHEET_NAME);
  return sh || null;
}

function normYear2(y: any): number | null {
  const n = Number(String(y).trim());
  if (!Number.isFinite(n)) return null;
  if (n >= 2000) return n - 2000; // 2025→25
  if (n >= 0 && n <= 99) return n; // 0..99はそのまま
  return null;
}

/**
 * planner.monthly.filter
 * 入力: student_id? or spreadsheet_id?, year(2桁/4桁), month(1..12)
 */
export function plannerMonthlyFilter(req: RowMap): ApiResponse {
  const { year, month } = req;
  const yy = normYear2(year);
  const mm = Number(String(month || "").trim());
  if (yy == null || !Number.isFinite(mm) || mm < 1 || mm > 12) {
    return ng("planner.monthly.filter", "BAD_REQUEST", "year(2桁/4桁) と month(1..12) を指定してください");
  }
  const sh = openMonthlySheet(req);
  if (!sh) return ng("planner.monthly.filter", "NOT_FOUND", "monthly sheet not found (月間管理)");

  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return ok("planner.monthly.filter", { year: yy, month: mm, items: [], count: 0 });

  // 2行目〜最終行の A..R を display で取得
  const numRows = lastRow - 1;
  const values = sh.getRange(2, 1, numRows, 18).getDisplayValues();

  const items: any[] = [];
  for (let i = 0; i < values.length; i++) {
    const r = i + 2; // シート上の行番号
    const row = values[i];
    const A = String(row[0] || "");
    const B = String(row[1] || "").trim();
    const C = String(row[2] || "").trim();
    if (!A && !B && !C) continue; // 完全空行
    const bNum = Number(B);
    const cNum = Number(C);
    if (bNum !== yy || cNum !== mm) continue;
    const K = toNumberOrNull(row[10]);
    const L = toNumberOrNull(row[11]);
    const M = toNumberOrNull(row[12]);
    const weeks = [13,14,15,16,17].map((colIdx, j) => ({ index: j+1, actual: String(row[colIdx] || "") }));
    const monthCode = (Number.isFinite(bNum) && Number.isFinite(cNum)) ? (bNum*10 + cNum) : null;
    items.push({
      row: r,
      raw_code: A,
      month_code: monthCode,
      year: bNum,
      month: cNum,
      book_id: String(row[6] || ""), // G
      subject: String(row[7] || ""), // H
      title: String(row[8] || ""),   // I
      guideline_note: String(row[9] || ""), // J
      unit_load: K,
      monthly_minutes: L,
      guideline_amount: M,
      weeks,
    });
  }
  return ok("planner.monthly.filter", { year: yy, month: mm, items, count: items.length });
}

