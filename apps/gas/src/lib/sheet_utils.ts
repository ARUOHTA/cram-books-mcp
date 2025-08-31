/**
 * シート操作の共通ヘルパ（列名→インデックス解決 など）
 */

/**
 * 見出し文字列の正規化（大小/全半角/空白除去）
 */
export function headerKey(s: string): string {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

/**
 * 見出し候補リストから一致する列インデックスを返す（最初に一致したもの）
 */
export function pickCol(headers: string[], candidates: string[]): number {
  const H = headers.map(headerKey);
  for (const c of candidates) {
    const i = H.indexOf(headerKey(c));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 月間目標（文字列）を簡易パース
 * - 「1日N時間」「N時間/1日」などの表現から分に変換（ざっくり）。
 * - 厳密な日数推定は行わない。
 */
export function parseMonthlyGoal(txt: any): { text: string; per_day_minutes: number | null; days: number | null; total_minutes_est: number | null } | null {
  if (txt == null || txt === "") return null;
  const s = String(txt);
  const hm = s.match(/(\d+(?:\.\d+)?)\s*時間/);
  const perDay = hm ? Math.round(parseFloat(hm[1]) * 60) : null;
  return { text: s, per_day_minutes: perDay, days: null, total_minutes_est: null };
}

