/**
 * 共通ユーティリティ（レスポンス・正規化・数値変換など）
 */

export type ApiResponse = {
  ok: boolean;
  op?: string;
  meta?: { ts: string };
  data?: any;
  error?: { code: string; message: string; details?: any };
};

export const ok = (op: string, data: any = {}): ApiResponse => ({
  ok: true,
  op,
  meta: { ts: new Date().toISOString() },
  data,
});

export const ng = (op: string, code: string, message: string, details: any = {}): ApiResponse => ({
  ok: false,
  op,
  error: { code, message, details },
});

// JSONレスポンス化
export function createJsonResponse(response: ApiResponse): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

// 文字列正規化（大小/全半角/空白）
export function normalize(s: any): string {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

// 数値変換（空/非数は null）
export function toNumberOrNull(x: any): number | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

