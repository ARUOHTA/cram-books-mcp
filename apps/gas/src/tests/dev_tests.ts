/**
 * 開発用の簡易テスト関数（GAS エディタから実行可能）
 * - 破壊的テスト（create/update/delete）は gTMP 接頭辞で作成し、最後に削除します
 */
import { CONFIG } from "../config";
import { booksFind, booksGet, booksFilter, booksCreate, booksUpdate, booksDelete } from "../handlers/books";

function logJson(label: string, x: any) {
  try { console.log(label + ":\n" + JSON.stringify(x, null, 2)); } catch (_) { console.log(label, x); }
}

function firstBookIds(n = 2): string[] {
  const sh = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID).getSheetByName(CONFIG.BOOKS_SHEET);
  if (!sh) return [];
  const last = Math.min(sh.getLastRow(), 1000);
  const values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  const header = values[0].map(String);
  const idCol = header.findIndex(h => String(h).trim() === "参考書ID");
  const out: string[] = [];
  for (let r = 1; r < values.length && out.length < n; r++) {
    const v = (idCol >= 0 ? values[r][idCol] : "").toString().trim();
    if (v) out.push(v);
  }
  return out;
}

export function testBooksFind(): void {
  logJson("books.find(青チャート)", booksFind({ query: "青チャート" }));
  logJson("books.find(軌跡と領域)", booksFind({ query: "軌跡と領域" }));
}

export function testBooksGetSingle(): void {
  const [id] = firstBookIds(1);
  if (!id) { console.log("no id found"); return; }
  logJson(`books.get(${id})`, booksGet({ book_id: id }));
}

export function testBooksGetMultiple(): void {
  const ids = firstBookIds(2);
  if (ids.length < 2) { console.log("need >=2 ids"); return; }
  logJson(`books.get(${ids.join(",")})`, booksGet({ book_ids: ids }));
}

export function testBooksFilterMath(): void {
  logJson("books.filter(教科=数学, limit=3)", booksFilter({ where: { "教科": "数学" }, limit: 3 }));
}

export function testBooksCreateUpdateDelete(): void {
  // 1) create
  const created = booksCreate({
    title: "テスト本（gTMP）",
    subject: "数学",
    unit_load: 2,
    monthly_goal: "1日30分",
    chapters: [{ title: "第1章", range: { start: 1, end: 5 } }, { title: "第2章", range: { start: 6, end: 10 } }],
    id_prefix: "gTMP"
  });
  logJson("create", created);
  const id = created?.data?.id as string | undefined;
  if (!id) { console.log("create failed (no id)" ); return; }

  // 2) update (preview → confirm)
  const preview = booksUpdate({ book_id: id, updates: { title: "テスト本（gTMP・改）", chapters: [
    { title: "改・第1章", range: { start: 10, end: 12 } },
    { title: "改・第2章", range: { start: 13, end: 15 } },
    { title: "改・第3章", range: { start: 16, end: 18 } },
  ]}});
  logJson("update.preview", preview);
  const token = preview?.data?.confirm_token as string | undefined;
  if (token) {
    const confirmed = booksUpdate({ book_id: id, confirm_token: token });
    logJson("update.confirm", confirmed);
  }

  // 3) delete (preview → confirm)
  const delPreview = booksDelete({ book_id: id });
  logJson("delete.preview", delPreview);
  const delToken = delPreview?.data?.confirm_token as string | undefined;
  if (delToken) {
    const del = booksDelete({ book_id: id, confirm_token: delToken });
    logJson("delete.confirm", del);
  }
}

export function testBooksAll(): void {
  testBooksFind();
  testBooksGetSingle();
  testBooksGetMultiple();
  testBooksFilterMath();
}

