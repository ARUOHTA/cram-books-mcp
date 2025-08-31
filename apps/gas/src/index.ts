/**
 * CRAM Books API ルーター（GASエントリポイント）
 * - 役割: doGet/doPost の薄いルーティングのみ
 * - 本体ロジック: handlers/books.ts に集約（DRY）
 */

// 設定と共通ユーティリティ
import { CONFIG, ENABLE_TABLE_READ } from "./config";
import { ApiResponse, ok, ng, createJsonResponse } from "./lib/common";
// 書籍ハンドラ（実装本体）
import {
  booksFind as booksFindHandler,
  booksGet as booksGetHandler,
  booksFilter as booksFilterHandler,
  booksCreate as booksCreateHandler,
  booksUpdate as booksUpdateHandler,
  booksDelete as booksDeleteHandler,
  authorizeOnce as handlersAuthorizeOnce,
} from "./handlers/books";

/**
 * 手動承認（初回のみ実行）
 * - GAS エディタから 1 回だけ実行して、権限承認を済ませる
 */
export function authorizeOnce(): void {
  handlersAuthorizeOnce();
}

/**
 * HTTP GET 入口
 * - e.parameters を用いて `book_ids`（複数キー）を配列として解釈
 */
export function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  const p: Record<string, any> = (e && e.parameter) || {};
  const params: Record<string, string[]> = (e && (e as any).parameters) || ({} as any);

  // GET でも複数 ID を扱う（?book_ids=...&book_ids=...）
  if (p.op === "books.get") {
    if (Array.isArray(params["book_ids"]) && params["book_ids"].length > 0) {
      p["book_ids"] = params["book_ids"]; // ?book_ids=ID&book_ids=ID...
    } else if (Array.isArray(params["book_id"]) && params["book_id"].length > 1) {
      p["book_ids"] = params["book_id"]; // ?book_id=ID&book_id=ID...
    }
  }

  if (p.op) {
    const route = (req: Record<string, any>): ApiResponse => {
      switch (req.op) {
        case "books.find":   return booksFindHandler(req);
        case "books.get":    return booksGetHandler(req);
        case "books.filter": return booksFilterHandler(req);
        case "books.create": return booksCreateHandler(req);
        case "books.update": return booksUpdateHandler(req);
        case "books.delete": return booksDeleteHandler(req);
        case "table.read":   return (ENABLE_TABLE_READ ? tableRead(req) : ng("table.read","DISABLED","table.read is disabled (set ENABLE_TABLE_READ=true in ScriptProperties)"));
        case "ping":         return ok("ping", { status: "ok", timestamp: new Date().toISOString() });
        default:              return ng(req.op || "unknown", "UNKNOWN_OP", "Unsupported op");
      }
    };
    return createJsonResponse(route(p));
  }

  return createJsonResponse(ok("ping", { params: p }));
}

/**
 * HTTP POST 入口
 * - JSON ボディの `op` に応じてハンドラ関数へ委譲
 */
export function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const req = JSON.parse(e.postData?.contents || "{}");
    switch (req.op) {
      case "books.find":   return createJsonResponse(booksFindHandler(req));
      case "books.get":    return createJsonResponse(booksGetHandler(req));
      case "books.filter": return createJsonResponse(booksFilterHandler(req));
      case "books.create": return createJsonResponse(booksCreateHandler(req));
      case "books.update": return createJsonResponse(booksUpdateHandler(req));
      case "books.delete": return createJsonResponse(booksDeleteHandler(req));
      case "table.read":   return createJsonResponse(ENABLE_TABLE_READ ? tableRead(req) : ng("table.read","DISABLED","table.read is disabled (set ENABLE_TABLE_READ=true in ScriptProperties)"));
      default:               return createJsonResponse(ng(req.op || "unknown", "UNKNOWN_OP", "Unsupported op"));
    }
  } catch (err: any) {
    return createJsonResponse(ng("unknown", "UNCAUGHT", err.message, { stack: err.stack }));
  }
}

/**
 * テーブル読み取り（デバッグ用途）
 * - 注意: 本番運用では不要であれば無効化推奨
 */
function tableRead(req: Record<string, any>): ApiResponse {
  const { file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET, header_row = 1 } = req;
  try {
    const sh = SpreadsheetApp.openById(file_id).getSheetByName(sheet);
    if (!sh) return ng("table.read", "NOT_FOUND", `sheet '${sheet}' not found`);
    const values = sh.getDataRange().getValues();
    const headers = values[header_row - 1].map(String);
    const rows = values
      .slice(header_row)
      .filter((r) => r.join("") !== "")
      .map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i]])));
    return ok("table.read", { rows, columns: headers, count: rows.length });
  } catch (error: any) {
    return ng("table.read", "ERROR", error.message);
  }
}
