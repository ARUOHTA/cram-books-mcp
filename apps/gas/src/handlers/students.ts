/**
 * 生徒マスター ハンドラ（find/get/list/filter/create/update/delete）
 * - まずはスプレッドシート「生徒マスター」本体のみを対象（リンク先は扱わない）
 */
import { CONFIG } from "../config";
import { ApiResponse, ok, ng } from "../lib/common";
import { nextIdForPrefix } from "../lib/id_rules";
import { pickCol, headerKey } from "../lib/sheet_utils";

type RowMap = Record<string, any>;

function openStudentsSheet(file_id?: string, sheetName?: string): GoogleAppsScript.Spreadsheet.Sheet | null {
  const fid = file_id || CONFIG.STUDENTS_FILE_ID;
  const ss = SpreadsheetApp.openById(fid);
  if (sheetName && sheetName.trim()) return ss.getSheetByName(sheetName) as any;
  return ss.getSheets()[0];
}

function headersOf(sh: GoogleAppsScript.Spreadsheet.Sheet): string[] {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

// よく使う列候補（見出しゆれを吸収）
const COLS = {
  id: ["生徒ID", "ID", "id"],
  name: ["氏名", "名前", "生徒名", "name"],
  grade: ["学年", "grade"],
  planner: ["スピードプランナーID", "PlannerSheetId", "planner_sheet_id", "プランナーID"],
  meeting: ["面談メモID", "MeetingDocId", "meeting_doc_id", "面談ドキュメントID"],
  tags: ["タグ", "tags"],
};

function rowToStudent(headers: string[], row: any[]): RowMap {
  const idx = (cands: string[]) => pickCol(headers, cands);
  const get = (i: number) => (i >= 0 ? (row[i] ?? "") : "");
  const m: RowMap = {};
  headers.forEach((h, i) => (m[h] = row[i]));
  return {
    id: String(get(idx(COLS.id))).trim(),
    name: String(get(idx(COLS.name))).trim(),
    grade: String(get(idx(COLS.grade))).trim(),
    planner_sheet_id: String(get(idx(COLS.planner))).trim(),
    meeting_doc_id: String(get(idx(COLS.meeting))).trim(),
    tags: String(get(idx(COLS.tags))).trim(),
    row: m,
  };
}

export function studentsList(req: RowMap): ApiResponse {
  const { limit, file_id, sheet } = req;
  const sh = openStudentsSheet(file_id, sheet);
  if (!sh) return ng("students.list", "NOT_FOUND", "students sheet not found");
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return ok("students.list", { students: [], count: 0 });
  const headers = values[0].map(String);
  const out = values.slice(1)
    .filter(r => r.join("") !== "")
    .map(r => rowToStudent(headers, r));
  const sliced = (typeof limit === 'number' && limit > 0) ? out.slice(0, limit) : out;
  return ok("students.list", { students: sliced, count: sliced.length });
}

export function studentsFind(req: RowMap): ApiResponse {
  const { query, limit, file_id, sheet } = req;
  if (!query) return ng("students.find", "BAD_REQUEST", "query is required");
  const sh = openStudentsSheet(file_id, sheet);
  if (!sh) return ng("students.find", "NOT_FOUND", "students sheet not found");
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return ok("students.find", { query, candidates: [], top: null, confidence: 0 });
  const headers = values[0].map(String);
  const idxName = pickCol(headers, COLS.name);
  const idxId = pickCol(headers, COLS.id);
  const q = String(query).toLowerCase().normalize("NFKC").trim();
  const cands: any[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const id = String(idxId >= 0 ? row[idxId] : "").trim();
    const name = String(idxName >= 0 ? row[idxName] : "").trim();
    if (!id && !name) continue;
    const hay = [id, name].map(s => s.toLowerCase().normalize("NFKC"));
    let score = 0; let reason = "";
    if (hay.some(h => h === q)) { score = 1.0; reason = "exact"; }
    else if (hay.some(h => h.includes(q))) { score = 0.9; reason = "partial"; }
    if (score > 0) cands.push({ student_id: id, name, score, reason });
  }
  cands.sort((a,b) => b.score - a.score);
  const sliced = (typeof limit === 'number' && limit > 0) ? cands.slice(0, limit) : cands;
  return ok("students.find", { query, candidates: sliced, top: sliced[0] || null, confidence: (sliced[0]?.score || 0) });
}

export function studentsGet(req: RowMap): ApiResponse {
  const { student_id, student_ids, file_id, sheet } = req;
  const list = Array.isArray(student_ids) ? student_ids : (Array.isArray(student_id) ? student_id : null);
  const sh = openStudentsSheet(file_id, sheet);
  if (!sh) return ng("students.get", "NOT_FOUND", "students sheet not found");
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const idxId = pickCol(headers, COLS.id);
  if (list && list.length > 0) {
    const want = new Set(list.map((x:any)=>String(x).trim()));
    const out: any[] = [];
    for (let r = 1; r < values.length; r++) {
      const id = String(idxId >= 0 ? values[r][idxId] : "").trim();
      if (id && want.has(id)) out.push(rowToStudent(headers, values[r]));
    }
    return ok("students.get", { students: out });
  }
  const single = String(student_id || "").trim();
  if (!single) return ng("students.get", "BAD_REQUEST", "student_id or student_ids is required");
  for (let r = 1; r < values.length; r++) {
    const id = String(idxId >= 0 ? values[r][idxId] : "").trim();
    if (id === single) return ok("students.get", { student: rowToStudent(headers, values[r]) });
  }
  return ng("students.get", "NOT_FOUND", `student '${single}' not found`);
}

export function studentsFilter(req: RowMap): ApiResponse {
  const { where = {}, contains = {}, limit, file_id, sheet } = req;
  const sh = openStudentsSheet(file_id, sheet);
  if (!sh) return ng("students.filter", "NOT_FOUND", "students sheet not found");
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return ok("students.filter", { students: [], count: 0 });
  const headers = values[0].map(String);
  // キーはヘッダそのまま想定。英語キー等はそのままマッチ（headerKeyで比較）
  const norm = headerKey;
  const wherePairs = Object.entries(where as RowMap).map(([k,v]) => [norm(k), String(v)] as const);
  const containsPairs = Object.entries(contains as RowMap).map(([k,v]) => [norm(k), String(v)] as const);
  const HN = headers.map(headerKey);
  const colIndexFor = (kNorm: string) => HN.indexOf(kNorm);
  const result: any[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    let okAll = true;
    for (const [k,v] of wherePairs) {
      const ci = colIndexFor(k); if (ci < 0) { okAll=false; break; }
      const raw = String(row[ci] ?? "");
      if (headerKey(raw) !== headerKey(v)) { okAll=false; break; }
    }
    if (!okAll) continue;
    for (const [k,v] of containsPairs) {
      const ci = colIndexFor(k); if (ci < 0) { okAll=false; break; }
      const raw = String(row[ci] ?? "");
      if (!headerKey(raw).includes(headerKey(v))) { okAll=false; break; }
    }
    if (!okAll) continue;
    result.push(rowToStudent(headers, row));
  }
  const sliced = (typeof limit === 'number' && limit > 0) ? result.slice(0, limit) : result;
  return ok("students.filter", { students: sliced, count: sliced.length });
}

export function studentsCreate(req: RowMap): ApiResponse {
  const { record = {}, id_prefix } = req; // 推奨: record に見出し→値で渡す
  const sh = openStudentsSheet(req.file_id, req.sheet);
  if (!sh) return ng("students.create", "NOT_FOUND", "students sheet not found");
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const idxId = pickCol(headers, COLS.id);
  const prefix = (typeof id_prefix === 'string' && id_prefix.trim()) ? id_prefix.trim() : 's';
  const newId = nextIdForPrefix(prefix, values, idxId);
  const row: any[] = new Array(headers.length).fill("");
  if (idxId >= 0) row[idxId] = newId;
  // header名でコピー
  const normMap: Record<string, number> = {}; headers.forEach((h,i)=> normMap[headerKey(h)] = i);
  Object.entries(record as RowMap).forEach(([k,v]) => {
    const ci = normMap[headerKey(k)]; if (ci >= 0) row[ci] = v;
  });
  // name/grade 等の別名を補完
  const setIf = (cands: string[], v: any) => { const ci = pickCol(headers, cands); if (ci>=0 && (row[ci]===""||row[ci]==null)) row[ci]=v; };
  if (req.name) setIf(COLS.name, req.name);
  if (req.grade) setIf(COLS.grade, req.grade);
  if (req.planner_sheet_id) setIf(COLS.planner, req.planner_sheet_id);
  if (req.meeting_doc_id) setIf(COLS.meeting, req.meeting_doc_id);
  // 末尾に追加
  sh.insertRowsAfter(sh.getLastRow(), 1);
  sh.getRange(sh.getLastRow(), 1, 1, headers.length).setValues([row]);
  return ok("students.create", { id: newId, created: true });
}

export function studentsUpdate(req: RowMap): ApiResponse {
  const { student_id, updates = {}, confirm_token } = req;
  if (!student_id) return ng("students.update", "BAD_REQUEST", "student_id is required");
  const sh = openStudentsSheet(req.file_id, req.sheet);
  if (!sh) return ng("students.update", "NOT_FOUND", "students sheet not found");
  const headers = headersOf(sh);
  const idxId = pickCol(headers, COLS.id);
  let rowIndex = -1;
  const last = sh.getLastRow();
  for (let r = 2; r <= last; r++) {
    const v = String(idxId>=0 ? sh.getRange(r, idxId+1).getValue() : "").trim();
    if (v === String(student_id)) { rowIndex = r; break; }
  }
  if (rowIndex < 0) return ng("students.update", "NOT_FOUND", `student '${student_id}' not found`);

  const cache = CacheService.getScriptCache();
  if (!confirm_token) {
    // プレビュー: 変更差分を計算
    const current: RowMap = {};
    headers.forEach((h,i)=> current[h] = sh.getRange(rowIndex, i+1).getValue());
    const diffs: RowMap = {};
    const normMap: Record<string, number> = {}; headers.forEach((h,i)=> normMap[headerKey(h)] = i);
    Object.entries(updates as RowMap).forEach(([k,v]) => {
      const ci = normMap[headerKey(k)]; if (ci>=0) {
        const from = current[headers[ci]]; const to = v;
        if (String(from) !== String(to)) diffs[headers[ci]] = { from, to };
      }
    });
    const token = Utilities.getUuid();
    cache.put(`stu_upd:${token}`, JSON.stringify({ student_id, updates }), 300);
    return ok("students.update", { requires_confirmation: true, preview: { diffs }, confirm_token: token, expires_in_seconds: 300 });
  }
  // 確定
  const raw = cache.get(`stu_upd:${confirm_token}`);
  if (!raw) return ng("students.update", "CONFIRM_EXPIRED", "confirm_token is invalid or expired");
  let saved: any; try { saved = JSON.parse(raw); } catch { return ng("students.update", "CONFIRM_PARSE", "invalid payload"); }
  if (String(saved.student_id) !== String(student_id)) return ng("students.update", "CONFIRM_MISMATCH", "student_id mismatch");
  const updatesMap = saved.updates as RowMap;
  const normMap: Record<string, number> = {}; headers.forEach((h,i)=> normMap[headerKey(h)] = i);
  Object.entries(updatesMap).forEach(([k,v]) => { const ci = normMap[headerKey(k)]; if (ci>=0) sh.getRange(rowIndex, ci+1).setValue(v); });
  cache.remove(`stu_upd:${confirm_token}`);
  return ok("students.update", { updated: true });
}

export function studentsDelete(req: RowMap): ApiResponse {
  const { student_id, confirm_token } = req;
  if (!student_id) return ng("students.delete", "BAD_REQUEST", "student_id is required");
  const sh = openStudentsSheet(req.file_id, req.sheet);
  if (!sh) return ng("students.delete", "NOT_FOUND", "students sheet not found");
  const headers = headersOf(sh);
  const idxId = pickCol(headers, COLS.id);
  let rowIndex = -1;
  const last = sh.getLastRow();
  for (let r = 2; r <= last; r++) {
    const v = String(idxId>=0 ? sh.getRange(r, idxId+1).getValue() : "").trim();
    if (v === String(student_id)) { rowIndex = r; break; }
  }
  if (rowIndex < 0) return ng("students.delete", "NOT_FOUND", `student '${student_id}' not found`);
  const cache = CacheService.getScriptCache();
  if (!confirm_token) {
    const token = Utilities.getUuid();
    cache.put(`stu_del:${token}`, JSON.stringify({ student_id, rowIndex }), 300);
    return ok("students.delete", { requires_confirmation: true, preview: { row: rowIndex }, confirm_token: token, expires_in_seconds: 300 });
  }
  const raw = cache.get(`stu_del:${confirm_token}`);
  if (!raw) return ng("students.delete", "CONFIRM_EXPIRED", "confirm_token is invalid or expired");
  let saved: any; try { saved = JSON.parse(raw); } catch { return ng("students.delete", "CONFIRM_PARSE", "invalid payload"); }
  if (String(saved.student_id) !== String(student_id)) return ng("students.delete", "CONFIRM_MISMATCH", "student_id mismatch");
  sh.deleteRow(Number(saved.rowIndex));
  cache.remove(`stu_del:${confirm_token}`);
  return ok("students.delete", { deleted: true });
}

