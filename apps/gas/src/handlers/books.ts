/**
 * 書籍ハンドラ群（find/get/filter/create/update/delete）
 * ルーター（index.ts）から呼ばれる純粋関数として実装。
 */
import { CONFIG, isFindDebugEnabled } from "../config";
import { ApiResponse, ok, ng, normalize, toNumberOrNull } from "../lib/common";
import { decidePrefix, nextIdForPrefix } from "../lib/id_rules";

export type ChapterInfo = {
  idx: number | null;
  title: string | null;
  range: { start: number | null; end: number | null } | null;
  numbering: string | null;
};

export type BookDetails = {
  id: string;
  title: string;
  subject: string;
  monthly_goal: { text: string; per_day_minutes: number | null; days: number | null; total_minutes_est: number | null };
  unit_load: number | null;
  structure: { chapters: ChapterInfo[] };
  assessment: { book_type: string; quiz_type: string; quiz_id: string };
};

// 以降は index.ts から移植したロジック（必要箇所のみ）

export function authorizeOnce(): void {
  const ss = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID);
  const name = ss.getSheets()[0].getName();
  console.log("authorized OK, first sheet:", name);
}

/**
 * books.find（曖昧検索）
 * - クエリを正規化し、タイトル/別名などへの一致度から候補を返す
 */
export function booksFind(req: Record<string, any>): ApiResponse {
  const { query, limit = 20, file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET } = req;
  if (!query) return ng("books.find", "BAD_REQUEST", "query が必要です");

  // --- 小ヘルパ（関数内スコープ） ---
  // 文字列正規化（最小限）: NFKC + 小文字 + 空白削除 + ローマ数字/丸数字の正規化
  const norm = (s: any): string => (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    // roman numerals → ascii (simplified)
    .replace(/[Ⅰ]/g, "1").replace(/[Ⅱ]/g, "2").replace(/[Ⅲ]/g, "3")
    .replace(/[Ⅳ]/g, "4").replace(/[Ⅴ]/g, "5").replace(/[Ⅵ]/g, "6")
    .replace(/[Ⅶ]/g, "7").replace(/[Ⅷ]/g, "8").replace(/[Ⅸ]/g, "9").replace(/[Ⅹ]/g, "10")
    // circled digits and zenkaku digits → ascii
    .replace(/[①１]/g, "1").replace(/[②２]/g, "2").replace(/[③３]/g, "3")
    .replace(/[④４]/g, "4").replace(/[⑤５]/g, "5").replace(/[⑥６]/g, "6")
    .replace(/[⑦７]/g, "7").replace(/[⑧８]/g, "8").replace(/[⑨９]/g, "9")
    .replace(/[⑩０]/g, "10")
    .replace(/\s+/g, "");

  const STOPWORDS = new Set(["問題集","入試","演習","講座","ノート","完全","総合","実戦","実践"]);
  // トークナイズ（最小限）: 非単語区切りで分割（漢字・かな・英数を保持）
  const tokenize = (s: any): string[] => {
    const n = (s ?? "").toString().normalize("NFKC")
      .replace(/[Ⅰ]/g, "1").replace(/[Ⅱ]/g, "2").replace(/[Ⅲ]/g, "3")
      .replace(/[Ⅳ]/g, "4").replace(/[Ⅴ]/g, "5").replace(/[Ⅵ]/g, "6")
      .replace(/[Ⅶ]/g, "7").replace(/[Ⅷ]/g, "8").replace(/[Ⅸ]/g, "9").replace(/[Ⅹ]/g, "10")
      // 漢字—ひらがな(1-2)—漢字 の連結はひらがなを境界として分割
      .replace(/([一-龯])[ぁ-ん]{1,2}([一-龯])/g, "$1 $2")
      .toLowerCase();
    const parts = n.split(/[^\w一-龯ぁ-んァ-ン]+/).filter(Boolean);
    const toks: string[] = [];
    for (const p of parts) {
      const t = p.trim();
      if (t.length >= 2 && !STOPWORDS.has(t)) toks.push(t);
    }
    return toks;
  };
    
  const colIdx = (headers: string[], candidates: string[]): number => {
    const Hn = headers.map(h => norm(h));
    for (const c of candidates) {
      const i = Hn.indexOf(norm(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  
  const parseAliases = (val: any): string[] => {
    if (val == null || val === "") return [];
    // JSON配列 or カンマ/読点区切りの両対応
    try {
      const x = JSON.parse(String(val));
      if (Array.isArray(x)) return x.map(v => String(v));
    } catch (_) {}
    return String(val).split(/[,\u3001]/).map(s => s.trim()).filter(Boolean);
  };
  
  const estimateConfidence = (sorted: any[]): number => {
    if (!sorted.length) return 0;
    const s1 = sorted[0].score || 0;
    const s2 = sorted[1]?.score || 0;
    // 1位と2位の差で確信度を補正（差が小さいほど低く）
    return Math.max(0, Math.min(1, s1 - 0.25 * s2));
  };

  try {
    // --- シート読み込み ---
    const sh = SpreadsheetApp.openById(file_id).getSheetByName(sheet);
    if (!sh) return ng("books.find", "NOT_FOUND", `sheet '${sheet}' not found`);

    const values = sh.getDataRange().getValues();
    if (!values.length) return ok("books.find", { query, candidates: [], top: null, confidence: 0 });

    const headers = values.shift()!.map(h => String(h).trim());
    // 列インデックス（表記ゆれを吸収）
    const idxId      = colIdx(headers, ["参考書ID", "ID", "id"]);
    const idxTitle   = colIdx(headers, ["参考書名", "タイトル", "書名", "title", "名称"]);
    const idxSubject = colIdx(headers, ["教科", "科目", "subject"]);
    const idxAlias   = colIdx(headers, ["別名", "別称", "aliases"]); // 任意

    if (idxId < 0 || idxTitle < 0 || idxSubject < 0) {
      return ng("books.find", "BAD_HEADER", "必要な列（参考書ID/参考書名/教科）が見つかりません", { headers });
    }

    // クエリの事前処理
    const q = norm(query);
    const qTokens = tokenize(query);
    const SUBJECT_KEYS = ["現代文","古文","漢文","古文漢文","英語","数学","化学","化学基礎","物理","生物","生物基礎","日本史","世界史","地理","地学"];
    const querySubject = SUBJECT_KEYS.find(k => qTokens.includes(k.toLowerCase()));

    const seen = new Set<string>();           // 同一IDの重複を抑制（章の続き行を除外）
    const df: Record<string, number> = {};    // token -> doc freq
    const parentRows: { id: string; title: string; subject: string; aliases: string[] }[] = [];

    for (const row of values) {
      const idRaw = (row[idxId] ?? "").toString().trim();
      const titleRaw = (row[idxTitle] ?? "").toString().trim();
      const subjectRaw = (row[idxSubject] ?? "").toString().trim();

      if (!idRaw && !titleRaw && !subjectRaw) continue; // 完全空行
      if (!idRaw) continue;                              // 子行は除外
      if (seen.has(idRaw)) continue;                     // 同一IDの重複除外
      seen.add(idRaw);

      const aliases = idxAlias >= 0 ? parseAliases(row[idxAlias]) : [];
      parentRows.push({ id: idRaw, title: titleRaw, subject: subjectRaw, aliases });

      const tokSet = new Set(tokenize([titleRaw, ...aliases].join(" ")));
      for (const t of tokSet) df[t] = (df[t] ?? 0) + 1;
    }

    const N = parentRows.length || 1;
    const idf = (t: string): number => {
      const d = df[t] ?? 0;
      return Math.log(((N - d + 0.5) / (d + 0.5)) + 1);
    };

    const uniqQToks = Array.from(new Set(qTokens));
    const sumIdfQ = uniqQToks.reduce((acc, t) => acc + idf(t), 0) || 1;

    const candidates: any[] = [];
    for (const r of parentRows) {
      const aliasTexts = r.aliases;
      const hay = [r.id, r.title, r.subject, ...aliasTexts]
        .map(norm)
        .filter(t => t && t.length >= 2);

      const combinedTitle = [r.title, ...aliasTexts].join(" ");
      const combinedNorm = norm(combinedTitle);
      const titleTokSet = new Set(tokenize(combinedTitle));

      // 双方向カバレッジ（IDF加重）
      // - Q→T: クエリ側の情報がどれだけタイトルに含まれるか
      // - T→Q: タイトル側の情報がどれだけクエリに含まれるか（逆包含）
      let idfHitFwd = 0; for (const t of uniqQToks) if (titleTokSet.has(t)) idfHitFwd += idf(t);
      const covIdfFwd = idfHitFwd / sumIdfQ; // 0..1
      const titleToks = Array.from(titleTokSet);
      const sumIdfT = titleToks.reduce((acc, t) => acc + idf(t), 0) || 1;
      let idfHitRev = 0; for (const t of titleToks) if (uniqQToks.includes(t)) idfHitRev += idf(t);
      const covIdfRev = idfHitRev / sumIdfT; // 0..1

      let score = 0; let reason: any = "";
      if (hay.some(t => t === q)) { score = 1.0; reason = "exact"; }
      else if (combinedNorm.includes(q)) { score = 0.95; reason = "phrase"; }
      else if (hay.some(t => t.includes(q))) { score = 0.90; reason = "partial_target"; }
      else if (covIdfFwd > 0) { score = 0.80; reason = "coverage_q_in_title"; }
      // 逆包含（タイトル側がクエリに含まれる）も評価: 余分な語（接続詞など）があってもヒットさせる
      else if (covIdfRev >= 0.6) { score = 0.78; reason = "coverage_title_in_q"; }
      else {
        const short = q.length >= 3 ? q.slice(0,3) : "";
        if (short && hay.some(t => t.includes(short))) { score = 0.72; reason = "fuzzy3"; }
      }

      let bonus = 0;
      if (covIdfFwd > 0) bonus += Math.min(0.12, 0.12 * covIdfFwd);
      if (norm(r.title).startsWith(q)) bonus += 0.02;
      if (querySubject) {
        const subjN = norm(r.subject);
        if (subjN && norm(querySubject) === subjN) bonus += 0.02;
      }

      const finalScore = Math.min(1, score + bonus);
      if (finalScore > 0) {
        candidates.push({
          book_id: r.id,
          title: r.title,
          subject: r.subject,
          score: finalScore,
          reason
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const minGap = 0.05; let cutIndex = candidates.length;
    for (let i = 0; i < candidates.length - 1; i++) {
      const d = candidates[i].score - candidates[i+1].score;
      if (d >= minGap) { cutIndex = i + 1; break; }
    }

    const sliced = candidates.slice(0, typeof limit === 'number' ? Math.min(limit, cutIndex) : cutIndex);
    if (isFindDebugEnabled()) {
      try {
        console.log("[find.debug] query=", query, " topN=", Math.min(5, sliced.length));
        sliced.slice(0, 5).forEach((c, i) => console.log(`[${i+1}]`, c.book_id, c.title, c.score.toFixed(3), c.reason));
      } catch (_) {}
    }
    const top = sliced[0] || null;
    const confidence = estimateConfidence(sliced);

    return ok("books.find", { query, candidates: sliced, top, confidence });
  } catch (error: any) {
    return ng("books.find", "ERROR", error.message);
  }
}

/**
 * books.get（単一/複数ID対応）
 * - ID行を起点にメタ情報を確定し、続き行から章情報を収集
 */
export function booksGet(req: Record<string, any>): ApiResponse {
  const { book_id, book_ids, file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET } = req;
  const listParam: any = (Array.isArray(book_ids) ? book_ids : (Array.isArray(book_id) ? book_id : null));
  if (!book_id && !listParam) return ng("books.get", "BAD_REQUEST", "book_id または book_ids が必要です");

  const norm = (s: any): string => (s ?? "").toString().trim().toLowerCase().normalize("NFKC");

  const parseMonthlyGoal = (txt: any) => {
    if (!txt) return null;
    const s = String(txt);
    const hm = s.match(/(\d+(?:\.\d+)?)\s*時間/);
    const per_day_minutes = hm ? Math.round(parseFloat(hm[1]) * 60) : null;
    return { per_day_minutes, days: null, total_minutes_est: null, text: s };
  };

  try {
    const sh = SpreadsheetApp.openById(file_id).getSheetByName(sheet);
    if (!sh) return ng("books.get", "NOT_FOUND", `sheet '${sheet}' not found`);

    const values = sh.getDataRange().getValues();
    if (!values.length) return ng("books.get", "EMPTY", "シートが空です");

    const headers = values.shift()!.map(String);
    const IDX = {
      id      : pickCol(headers, ["参考書ID", "ID", "id"]),
      title   : pickCol(headers, ["参考書名", "タイトル", "書名", "title"]),
      subject : pickCol(headers, ["教科", "科目", "subject"]),
      goal    : pickCol(headers, ["月間目標", "goal"]),
      unit    : pickCol(headers, ["単位当たり処理量", "単位処理量", "unit_load"]),
      chapIdx : pickCol(headers, ["章立て"]),
      chapName: pickCol(headers, ["章の名前", "章名"]),
      chapBeg : pickCol(headers, ["章のはじめ", "開始", "begin", "start"]),
      chapEnd : pickCol(headers, ["章の終わり", "終了", "end"]),
      numStyle: pickCol(headers, ["番号の数え方", "番号", "numbering"]),
      btype   : pickCol(headers, ["参考書のタイプ", "book_type"]),
      qtype   : pickCol(headers, ["確認テストのタイプ", "quiz_type"]),
      qid     : pickCol(headers, ["確認テストID", "quiz_id"])
    };

    if (IDX.id < 0 || IDX.title < 0 || IDX.subject < 0) {
      return ng("books.get", "BAD_HEADER", "必要な列（参考書ID/参考書名/教科）が見つかりません", { headers });
    }

    // 複数IDが指定された場合
    if (listParam && Array.isArray(listParam) && listParam.length > 0) {
      const targetIds = new Set(listParam.map((x: any) => String(x).trim()));
      const booksMap: Record<string, { meta: any | null; chapters: ChapterInfo[] }> = {};
      for (const id of targetIds) booksMap[id] = { meta: null, chapters: [] };

      let currentId: string | null = null;
      for (const r of values) {
        const idCell = (r[IDX.id] ?? "").toString().trim();
        if (idCell) currentId = idCell;
        if (!currentId || !targetIds.has(currentId)) continue;

        const bucket = booksMap[currentId];
        if (bucket.meta === null && idCell) {
          bucket.meta = {
            id: currentId,
            title: (r[IDX.title] ?? "").toString(),
            subject: (r[IDX.subject] ?? "").toString(),
            monthly_goal_text: (IDX.goal >= 0 ? (r[IDX.goal] ?? "").toString() : ""),
            unit_load: (IDX.unit >= 0 ? toNumberOrNull(r[IDX.unit]) : null),
            book_type: (IDX.btype >= 0 ? (r[IDX.btype] ?? "").toString() : ""),
            quiz_type: (IDX.qtype >= 0 ? (r[IDX.qtype] ?? "").toString() : ""),
            quiz_id  : (IDX.qid >= 0 ? (r[IDX.qid] ?? "").toString() : ""),
          };
        }

        const chName = (IDX.chapName >= 0 ? (r[IDX.chapName] ?? "").toString().trim() : "");
        const chBeg  = (IDX.chapBeg >= 0 ? toNumberOrNull(r[IDX.chapBeg]) : null);
        const chEnd  = (IDX.chapEnd >= 0 ? toNumberOrNull(r[IDX.chapEnd]) : null);
        const chIdx  = (IDX.chapIdx >= 0 ? toNumberOrNull(r[IDX.chapIdx]) : null);
        const numSty = (IDX.numStyle >= 0 ? (r[IDX.numStyle] ?? "").toString().trim() : "");
        if (chName || chBeg != null || chEnd != null) {
          booksMap[currentId].chapters.push({
            idx: chIdx ?? (booksMap[currentId].chapters.length + 1),
            title: chName || null,
            range: (chBeg != null || chEnd != null) ? { start: chBeg, end: chEnd } : null,
            numbering: numSty || null,
          });
        }
      }

      const books = Array.from(targetIds).map(id => {
        const b = booksMap[id];
        if (!b || !b.meta) return null;
        const goal = parseMonthlyGoal(b.meta.monthly_goal_text);
        const book: BookDetails = {
          id: b.meta.id,
          title: b.meta.title,
          subject: b.meta.subject,
          monthly_goal: goal ?? { text: b.meta.monthly_goal_text, per_day_minutes: null, days: null, total_minutes_est: null },
          unit_load: b.meta.unit_load,
          structure: { chapters: b.chapters },
          assessment: { book_type: b.meta.book_type, quiz_type: b.meta.quiz_type, quiz_id: b.meta.quiz_id },
        };
        return book;
      }).filter(Boolean);

      return ok("books.get", { books });
    }

    // 単一ID
    const targetId = String(book_id).trim();
    let meta: any | null = null;
    const chapters: ChapterInfo[] = [];
    let currentId: string | null = null;
    for (const r of values) {
      const idCell = (r[IDX.id] ?? "").toString().trim();
      if (idCell) currentId = idCell;
      if (currentId !== targetId) continue;

      if (meta === null && idCell) {
        meta = {
          id: currentId,
          title: (r[IDX.title] ?? "").toString(),
          subject: (r[IDX.subject] ?? "").toString(),
          monthly_goal_text: (IDX.goal >= 0 ? (r[IDX.goal] ?? "").toString() : ""),
          unit_load: (IDX.unit >= 0 ? toNumberOrNull(r[IDX.unit]) : null),
          book_type: (IDX.btype >= 0 ? (r[IDX.btype] ?? "").toString() : ""),
          quiz_type: (IDX.qtype >= 0 ? (r[IDX.qtype] ?? "").toString() : ""),
          quiz_id  : (IDX.qid >= 0 ? (r[IDX.qid] ?? "").toString() : ""),
        };
      }

      const chName = (IDX.chapName >= 0 ? (r[IDX.chapName] ?? "").toString().trim() : "");
      const chBeg  = (IDX.chapBeg >= 0 ? toNumberOrNull(r[IDX.chapBeg]) : null);
      const chEnd  = (IDX.chapEnd >= 0 ? toNumberOrNull(r[IDX.chapEnd]) : null);
      const chIdx  = (IDX.chapIdx >= 0 ? toNumberOrNull(r[IDX.chapIdx]) : null);
      const numSty = (IDX.numStyle >= 0 ? (r[IDX.numStyle] ?? "").toString().trim() : "");
      if (chName || chBeg != null || chEnd != null) {
        chapters.push({
          idx: chIdx ?? (chapters.length + 1),
          title: chName || null,
          range: (chBeg != null || chEnd != null) ? { start: chBeg, end: chEnd } : null,
          numbering: numSty || null,
        });
      }
    }

    if (!meta) return ng("books.get", "NOT_FOUND", `book '${targetId}' not found`);
    const goal = parseMonthlyGoal(meta.monthly_goal_text);
    const book: BookDetails = {
      id: meta.id,
      title: meta.title,
      subject: meta.subject,
      monthly_goal: goal ?? { text: meta.monthly_goal_text, per_day_minutes: null, days: null, total_minutes_est: null },
      unit_load: meta.unit_load,
      structure: { chapters },
      assessment: { book_type: meta.book_type, quiz_type: meta.quiz_type, quiz_id: meta.quiz_id },
    };

    return ok("books.get", { book });
  } catch (error: any) {
    return ng("books.get", "ERROR", error.message);
  }
}

/**
 * books.filter（書籍単位でグルーピングして返却）
 */
export function booksFilter(req: Record<string, any>): ApiResponse {
  // デフォルト挙動（2025-08-31 変更）:
  // - limit未指定のときは常に上限なし（全件）とする（データ規模は数百冊想定）
  // - 大量データでの利用時はクライアント側で limit 指定を推奨
  const { where = {}, contains = {}, limit, file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET } = req;
  try {
    const sh = SpreadsheetApp.openById(file_id).getSheetByName(sheet);
    if (!sh) return ng("books.filter", "NOT_FOUND", `sheet '${sheet}' not found`);

    const values = sh.getDataRange().getValues();
    if (!values.length) return ok("books.filter", { books: [], count: 0, limit });

    const headers = values.shift()!.map(h => String(h).trim());
    const norm = (s: any): string => (s ?? "").toString().trim().toLowerCase().normalize("NFKC");
    const pickCol = (headersArr: string[], candidates: string[]): number => {
      const Hn = headersArr.map(h => norm(h).replace(/\s+/g, ""));
      for (const c of candidates) {
        const i = Hn.indexOf(norm(c).replace(/\s+/g, ""));
        if (i >= 0) return i;
      }
      return -1;
    };

    const IDX = {
      id      : pickCol(headers, ["参考書ID", "ID", "id"]),
      title   : pickCol(headers, ["参考書名", "タイトル", "書名", "title"]),
      subject : pickCol(headers, ["教科", "科目", "subject"]),
      goal    : pickCol(headers, ["月間目標", "goal"]),
      unit    : pickCol(headers, ["単位当たり処理量", "単位処理量", "unit_load"]),
      chapIdx : pickCol(headers, ["章立て"]),
      chapName: pickCol(headers, ["章の名前", "章名"]),
      chapBeg : pickCol(headers, ["章のはじめ", "開始", "begin", "start"]),
      chapEnd : pickCol(headers, ["章の終わり", "終了", "end"]),
      numStyle: pickCol(headers, ["番号の数え方", "番号", "numbering"]),
      btype   : pickCol(headers, ["参考書のタイプ", "book_type"]),
      qtype   : pickCol(headers, ["確認テストのタイプ", "quiz_type"]),
      qid     : pickCol(headers, ["確認テストID", "quiz_id"])
    };

    const wherePairs = Object.entries(where as Record<string, any>);
    const containsPairs = Object.entries(contains as Record<string, any>);
    const colIndexFor = (k: string) => pickCol(headers, [k]);
    const needCols = new Set<number>();
    const whereIdx: [number, string][] = wherePairs.map(([k, v]) => {
      const i = colIndexFor(k);
      needCols.add(i);
      return [i, String(v)];
    });
    const containsIdx: [number, string][] = containsPairs.map(([k, v]) => {
      const i = colIndexFor(k);
      needCols.add(i);
      return [i, String(v)];
    });

    type BookBucket = {
      meta: null | {
        id: string;
        title: string;
        subject: string;
        monthly_goal_text: string;
        unit_load: number | null;
        book_type: string;
        quiz_type: string;
        quiz_id: string;
      };
      chapters: ChapterInfo[];
      cols: Record<number, string[]>;
    };

    const booksMap: Record<string, BookBucket> = {};
    let currentId: string | null = null;

    for (const r of values) {
      const idCell = (IDX.id >= 0 ? (r[IDX.id] ?? "").toString().trim() : "");
      if (idCell) currentId = idCell;
      if (!currentId) continue;

      const bucket = booksMap[currentId] || (booksMap[currentId] = {
        meta: null,
        chapters: [],
        cols: {},
      });

      if (bucket.meta === null && idCell) {
        bucket.meta = {
          id: currentId,
          title: (IDX.title >= 0 ? (r[IDX.title] ?? "").toString() : ""),
          subject: (IDX.subject >= 0 ? (r[IDX.subject] ?? "").toString() : ""),
          monthly_goal_text: (IDX.goal >= 0 ? (r[IDX.goal] ?? "").toString() : ""),
          unit_load: (IDX.unit >= 0 ? toNumberOrNull(r[IDX.unit]) : null),
          book_type: (IDX.btype >= 0 ? (r[IDX.btype] ?? "").toString() : ""),
          quiz_type: (IDX.qtype >= 0 ? (r[IDX.qtype] ?? "").toString() : ""),
          quiz_id  : (IDX.qid >= 0 ? (r[IDX.qid] ?? "").toString() : ""),
        };
      }

      const chName = (IDX.chapName >= 0 ? (r[IDX.chapName] ?? "").toString().trim() : "");
      const chBeg  = (IDX.chapBeg >= 0 ? toNumberOrNull(r[IDX.chapBeg]) : null);
      const chEnd  = (IDX.chapEnd >= 0 ? toNumberOrNull(r[IDX.chapEnd]) : null);
      const chIdx  = (IDX.chapIdx >= 0 ? toNumberOrNull(r[IDX.chapIdx]) : null);
      const numSty = (IDX.numStyle >= 0 ? (r[IDX.numStyle] ?? "").toString().trim() : "");
      if (chName || chBeg != null || chEnd != null) {
        bucket.chapters.push({
          idx: chIdx ?? (bucket.chapters.length + 1),
          title: chName || null,
          range: (chBeg != null || chEnd != null) ? { start: chBeg, end: chEnd } : null,
          numbering: numSty || null,
        });
      }

      for (const ci of needCols) {
        if (ci < 0) continue;
        const raw = r[ci];
        if (raw == null || raw === "") continue;
        (bucket.cols[ci] ||= []).push(String(raw));
      }
    }

    const matchesBook = (b: BookBucket): boolean => {
      for (const [ci, v] of whereIdx) {
        if (ci < 0) return false;
        const vals = b.cols[ci] || [];
        if (!vals.some(x => normalize(x) === normalize(v))) return false;
      }
      for (const [ci, v] of containsIdx) {
        if (ci < 0) return false;
        const vals = b.cols[ci] || [];
        if (!vals.some(x => normalize(x).includes(normalize(v)))) return false;
      }
      return true;
    };

    const results: any[] = [];
    const max = (typeof limit === 'number' && isFinite(limit) && limit > 0)
      ? Number(limit)
      : Number.POSITIVE_INFINITY;
    for (const id of Object.keys(booksMap)) {
      const b = booksMap[id];
      if (!b.meta) continue;
      if (!matchesBook(b)) continue;
      results.push({
        id: b.meta.id,
        title: b.meta.title,
        subject: b.meta.subject,
        monthly_goal: {
          text: b.meta.monthly_goal_text,
          per_day_minutes: null,
          days: null,
          total_minutes_est: null,
        },
        unit_load: b.meta.unit_load,
        structure: { chapters: b.chapters },
        assessment: { book_type: b.meta.book_type, quiz_type: b.meta.quiz_type, quiz_id: b.meta.quiz_id },
      });
      if (results.length >= max) break;
    }

    return ok("books.filter", { books: results, count: results.length, limit: isFinite(max) ? max : null });
  } catch (error: any) {
    return ng("books.filter", "ERROR", error.message);
  }
}

/**
 * books.create（自動ID付与）
 */
export function booksCreate(req: Record<string, any>): ApiResponse {
  const { title, subject, unit_load = null, monthly_goal = "", chapters = [], id_prefix } = req;
  if (!title || !subject) return ng("books.create", "BAD_REQUEST", "title と subject が必要です");
  try {
    const sh = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID).getSheetByName(CONFIG.BOOKS_SHEET);
    if (!sh) return ng("books.create", "NOT_FOUND", `sheet '${CONFIG.BOOKS_SHEET}' not found`);
    const values = sh.getDataRange().getValues();
    if (!values.length) return ng("books.create", "EMPTY", "シートが空です");
    const headers = values[0].map(String);
    const pick = (cands: string[]): number => pickCol(headers, cands);
    const IDX = {
      id      : pickCol(["参考書ID", "ID", "id"]),
      title   : pickCol(["参考書名", "タイトル", "書名", "title"]),
      subject : pickCol(["教科", "科目", "subject"]),
      goal    : pickCol(["月間目標", "goal"]),
      unit    : pickCol(["単位当たり処理量", "単位処理量", "unit_load"]),
      chapIdx : pickCol(["章立て"]),
      chapName: pickCol(["章の名前", "章名"]),
      chapBeg : pickCol(["章のはじめ", "開始", "begin", "start"]),
      chapEnd : pickCol(["章の終わり", "終了", "end"]),
      numStyle: pickCol(["番号の数え方", "番号", "numbering"]),
    } as const;

    const subPrefix = decidePrefix(String(subject), String(title));
    const basePrefix = (typeof id_prefix === 'string' && id_prefix.trim()) ? id_prefix.trim() : ("g" + subPrefix);
    const newId = nextIdForPrefix(basePrefix, values, IDX.id);

    const rows: any[][] = [];
    const parent: any[] = new Array(headers.length).fill("");
    if (IDX.id >= 0) parent[IDX.id] = newId;
    if (IDX.title >= 0) parent[IDX.title] = String(title);
    if (IDX.subject >= 0) parent[IDX.subject] = String(subject);
    if (IDX.goal >= 0) parent[IDX.goal] = String(monthly_goal);
    if (IDX.unit >= 0) parent[IDX.unit] = (unit_load == null ? "" : Number(unit_load));
    const chs: any[] = Array.isArray(chapters) ? chapters : [];
    if (chs.length > 0) {
      // 親行に第1章を格納（既存運用に合わせる）
      const ch0 = chs[0] || {};
      if (IDX.chapIdx   >= 0) parent[IDX.chapIdx]   = 1;
      if (IDX.chapName  >= 0) parent[IDX.chapName]  = (ch0?.title ?? "");
      if (IDX.chapBeg   >= 0) parent[IDX.chapBeg]   = (ch0?.range?.start ?? "");
      if (IDX.chapEnd   >= 0) parent[IDX.chapEnd]   = (ch0?.range?.end ?? "");
      if (IDX.numStyle  >= 0) parent[IDX.numStyle]  = (ch0?.numbering ?? "");
      rows.push(parent);
      // 残りの章は下の行へ 2..N
      let idx = 2;
      for (let i = 1; i < chs.length; i++) {
        const ch = chs[i] || {};
        const line: any[] = new Array(headers.length).fill("");
        if (IDX.chapIdx   >= 0) line[IDX.chapIdx]   = idx++;
        if (IDX.chapName  >= 0) line[IDX.chapName]  = (ch?.title ?? "");
        if (IDX.chapBeg   >= 0) line[IDX.chapBeg ]  = (ch?.range?.start ?? "");
        if (IDX.chapEnd   >= 0) line[IDX.chapEnd ]  = (ch?.range?.end ?? "");
        if (IDX.numStyle  >= 0) line[IDX.numStyle]  = (ch?.numbering ?? "");
        rows.push(line);
      }
    } else {
      // 章情報が無ければ親行のみ追加
      rows.push(parent);
    }

    const startRow = sh.getLastRow() + 1;
    if (rows.length > 1) sh.insertRowsAfter(sh.getLastRow(), rows.length);
    const range = sh.getRange(startRow, 1, rows.length, headers.length);
    range.setValues(rows);

    return ok("books.create", { id: newId, created_rows: rows.length });
  } catch (error: any) {
    return ng("books.create", "ERROR", error.message);
  }
}

/**
 * books.update（二段階: preview -> confirm）
 */
export function booksUpdate(req: Record<string, any>): ApiResponse {
  const { book_id, updates = {}, confirm_token } = req;
  if (!book_id) return ng("books.update", "BAD_REQUEST", "book_id が必要です");
  if (!updates || (typeof updates !== 'object' && !confirm_token)) return ng("books.update", "BAD_REQUEST", "updates が必要です");
  try {
    const sh = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID).getSheetByName(CONFIG.BOOKS_SHEET);
    if (!sh) return ng("books.update", "NOT_FOUND", `sheet '${CONFIG.BOOKS_SHEET}' not found`);
    const values = sh.getDataRange().getValues();
    if (!values.length) return ng("books.update", "EMPTY", "シートが空です");

    const headers = values[0].map(String);
    const norm = (s: any): string => (s ?? "").toString().trim().toLowerCase().normalize("NFKC");
    const pickCol = (cands: string[]): number => {
      const Hn = headers.map(h => norm(h).replace(/\s+/g, ""));
      for (const c of cands) {
        const i = Hn.indexOf(norm(c).replace(/\s+/g, ""));
        if (i >= 0) return i;
      }
      return -1;
    };

    const IDX = {
      id      : pick(["参考書ID", "ID", "id"]),
      title   : pick(["参考書名", "タイトル", "書名", "title"]),
      subject : pick(["教科", "科目", "subject"]),
      goal    : pick(["月間目標", "goal"]),
      unit    : pick(["単位当たり処理量", "単位処理量", "unit_load"]),
      chapIdx : pick(["章立て"]),
      chapName: pick(["章の名前", "章名"]),
      chapBeg : pick(["章のはじめ", "開始", "begin", "start"]),
      chapEnd : pick(["章の終わり", "終了", "end"]),
      numStyle: pick(["番号の数え方", "番号", "numbering"])
    } as const;

    // book_id のブロック範囲を特定
    let parentRow = -1;
    for (let r = 1; r < values.length; r++) {
      const v = (IDX.id >= 0 ? (values[r][IDX.id] ?? "").toString().trim() : "");
      if (v === String(book_id)) { parentRow = r + 1; break; }
    }
    if (parentRow < 0) return ng("books.update", "NOT_FOUND", `book_id '${book_id}' が見つかりません`);

    // ブロック終端（次のID行の直前）
    let endRow = sh.getLastRow();
    for (let r = parentRow; r <= sh.getLastRow(); r++) {
      const cell = (IDX.id >= 0 ? sh.getRange(r, IDX.id + 1).getValue() : "");
      if (r > parentRow && String(cell || "").trim() !== "") { endRow = r - 1; break; }
    }

    const cache = CacheService.getScriptCache();

    // プレビュー（confirm_token 無し）
    if (!confirm_token) {
      const metaCurrent = {
        title: (IDX.title >= 0 ? String(sh.getRange(parentRow, IDX.title + 1).getValue() ?? "") : ""),
        subject: (IDX.subject >= 0 ? String(sh.getRange(parentRow, IDX.subject + 1).getValue() ?? "") : ""),
        monthly_goal: (IDX.goal >= 0 ? String(sh.getRange(parentRow, IDX.goal + 1).getValue() ?? "") : ""),
        unit_load: (IDX.unit >= 0 ? toNumberOrNull(sh.getRange(parentRow, IDX.unit + 1).getValue()) : null),
      };
      const u = updates as Record<string, any>;
      const metaChanges: Record<string, { from: any; to: any }> = {};
      const applyIfChanged = (key: keyof typeof metaCurrent) => {
        if (u[key] === undefined) return;
        const to = key === 'unit_load' ? (u[key] == null ? null : Number(u[key])) : String(u[key] ?? "");
        const from = metaCurrent[key];
        const eq = (key === 'unit_load') ? (from === to) : (String(from ?? "") === String(to ?? ""));
        if (!eq) metaChanges[key] = { from, to };
      };
      applyIfChanged('title');
      applyIfChanged('subject');
      applyIfChanged('monthly_goal');
      applyIfChanged('unit_load');

      let chaptersPreview: null | { from_count: number; to_count: number } = null;
      if (Array.isArray(u.chapters)) {
        // 既存: 子行数（親行より下の章行数）
        const existingChildRows = Math.max(0, endRow - parentRow);
        // 変更後: 親行に第1章を載せ、子行は (新章数 - 1)
        const nextChildRows = Math.max(0, (u.chapters.length || 0) - 1);
        chaptersPreview = { from_count: existingChildRows, to_count: nextChildRows };
      }

      const token = Utilities.getUuid();
      const payload = { book_id, updates: u };
      cache.put(`upd:${token}`, JSON.stringify(payload), 300);
      return ok("books.update", {
        requires_confirmation: true,
        preview: { book_id, meta_changes: metaChanges, chapters: chaptersPreview },
        confirm_token: token,
        expires_in_seconds: 300,
      });
    }

    // 確定（confirm_token あり）
    const raw = cache.get(`upd:${confirm_token}`);
    if (!raw) return ng("books.update", "CONFIRM_EXPIRED", "confirm_token が無効または期限切れです");
    let saved: any;
    try { saved = JSON.parse(raw); } catch { return ng("books.update", "CONFIRM_PARSE", "confirm_token の読み取りに失敗しました"); }
    if (saved.book_id !== book_id) return ng("books.update", "CONFIRM_MISMATCH", "book_id が一致しません");
    const metaUpdates: Record<string, any> = saved.updates || {};
    let touched = false;

    if (Object.keys(metaUpdates).length > 0) {
      if (metaUpdates.title !== undefined && IDX.title >= 0) { sh.getRange(parentRow, IDX.title + 1).setValue(String(metaUpdates.title ?? "")); touched = true; }
      if (metaUpdates.subject !== undefined && IDX.subject >= 0) { sh.getRange(parentRow, IDX.subject + 1).setValue(String(metaUpdates.subject ?? "")); touched = true; }
      if (metaUpdates.monthly_goal !== undefined && IDX.goal >= 0) { sh.getRange(parentRow, IDX.goal + 1).setValue(String(metaUpdates.monthly_goal ?? "")); touched = true; }
      if (metaUpdates.unit_load !== undefined && IDX.unit >= 0) { sh.getRange(parentRow, IDX.unit + 1).setValue(metaUpdates.unit_load == null ? "" : Number(metaUpdates.unit_load)); touched = true; }
    }

    if (Array.isArray(metaUpdates.chapters)) {
      const newChs: any[] = metaUpdates.chapters;
      const existingChildRows = Math.max(0, endRow - parentRow);
      const needChildRows = Math.max(0, newChs.length - 1); // 親行に第1章、残りは子行
      const delta = needChildRows - existingChildRows;
      if (delta > 0) { sh.insertRowsAfter(endRow, delta); endRow += delta; }
      else if (delta < 0) { sh.deleteRows(parentRow + 1 + needChildRows, -delta); endRow = parentRow + needChildRows; }

      // 親行に第1章を書く
      if (newChs.length > 0) {
        const ch0 = newChs[0] || {};
        if (IDX.chapIdx  >= 0) sh.getRange(parentRow, IDX.chapIdx + 1).setValue(1);
        if (IDX.chapName >= 0) sh.getRange(parentRow, IDX.chapName + 1).setValue(String(ch0.title ?? ""));
        if (IDX.chapBeg  >= 0) sh.getRange(parentRow, IDX.chapBeg + 1).setValue(ch0?.range?.start ?? "");
        if (IDX.chapEnd  >= 0) sh.getRange(parentRow, IDX.chapEnd + 1).setValue(ch0?.range?.end ?? "");
        if (IDX.numStyle>= 0) sh.getRange(parentRow, IDX.numStyle + 1).setValue(String(ch0.numbering ?? ""));
      } else {
        // 章を全消去する場合は親行の章列を空に
        if (IDX.chapIdx  >= 0) sh.getRange(parentRow, IDX.chapIdx + 1).setValue("");
        if (IDX.chapName >= 0) sh.getRange(parentRow, IDX.chapName + 1).setValue("");
        if (IDX.chapBeg  >= 0) sh.getRange(parentRow, IDX.chapBeg + 1).setValue("");
        if (IDX.chapEnd  >= 0) sh.getRange(parentRow, IDX.chapEnd + 1).setValue("");
        if (IDX.numStyle>= 0) sh.getRange(parentRow, IDX.numStyle + 1).setValue("");
      }

      // 子行に第2章以降を書く
      let row = parentRow + 1;
      for (let i = 1; i < newChs.length; i++) {
        const ch = newChs[i] || {};
        if (IDX.chapIdx >= 0) sh.getRange(row, IDX.chapIdx + 1).setValue(i + 1);
        if (IDX.chapName >= 0) sh.getRange(row, IDX.chapName + 1).setValue(String(ch.title ?? ""));
        if (IDX.chapBeg >= 0) sh.getRange(row, IDX.chapBeg + 1).setValue(ch?.range?.start ?? "");
        if (IDX.chapEnd >= 0) sh.getRange(row, IDX.chapEnd + 1).setValue(ch?.range?.end ?? "");
        if (IDX.numStyle >= 0) sh.getRange(row, IDX.numStyle + 1).setValue(String(ch.numbering ?? ""));
        row += 1;
      }
      touched = true;
    }

    cache.remove(`upd:${confirm_token}`);
    return ok("books.update", { book_id, updated: touched });
  } catch (error: any) {
    return ng("books.update", "ERROR", error.message);
  }
}

/**
 * books.delete（二段階: preview -> confirm）
 */
export function booksDelete(req: Record<string, any>): ApiResponse {
  const { book_id, confirm_token } = req;
  if (!book_id) return ng("books.delete", "BAD_REQUEST", "book_id が必要です");
  try {
    const sh = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID).getSheetByName(CONFIG.BOOKS_SHEET);
    if (!sh) return ng("books.delete", "NOT_FOUND", `sheet '${CONFIG.BOOKS_SHEET}' not found`);
    const values = sh.getDataRange().getValues();
    if (!values.length) return ng("books.delete", "EMPTY", "シートが空です");

    const headers = values[0].map(String);
    const norm = (s: any): string => (s ?? "").toString().trim().toLowerCase().normalize("NFKC");
    const pickCol = (cands: string[]): number => {
      const Hn = headers.map(h => norm(h).replace(/\s+/g, ""));
      for (const c of cands) {
        const i = Hn.indexOf(norm(c).replace(/\s+/g, ""));
        if (i >= 0) return i;
      }
      return -1;
    };
    const idCol = pick(["参考書ID", "ID", "id"]);

    // 対象ブロック探索
    let parentRow = -1;
    for (let r = 1; r < values.length; r++) {
      const v = (idCol >= 0 ? (values[r][idCol] ?? "").toString().trim() : "");
      if (v === String(book_id)) { parentRow = r + 1; break; }
    }
    if (parentRow < 0) return ng("books.delete", "NOT_FOUND", `book_id '${book_id}' が見つかりません`);

    let endRow = sh.getLastRow();
    for (let r = parentRow; r <= sh.getLastRow(); r++) {
      const cell = (idCol >= 0 ? sh.getRange(r, idCol + 1).getValue() : "");
      if (r > parentRow && String(cell || "").trim() !== "") { endRow = r - 1; break; }
    }

    const cache = CacheService.getScriptCache();

    // プレビュー
    if (!confirm_token) {
      const token = Utilities.getUuid();
      const payload = { book_id, parentRow, endRow };
      cache.put(`del:${token}`, JSON.stringify(payload), 300);
      return ok("books.delete", {
        requires_confirmation: true,
        preview: { book_id, delete_rows: endRow - parentRow + 1, range: { start_row: parentRow, end_row: endRow } },
        confirm_token: token,
        expires_in_seconds: 300,
      });
    }

    // 確定
    const raw = cache.get(`del:${confirm_token}`);
    if (!raw) return ng("books.delete", "CONFIRM_EXPIRED", "confirm_token が無効または期限切れです");
    let saved: any;
    try { saved = JSON.parse(raw); } catch { return ng("books.delete", "CONFIRM_PARSE", "confirm_token の読み取りに失敗しました"); }
    if (saved.book_id !== book_id) return ng("books.delete", "CONFIRM_MISMATCH", "book_id が一致しません");

    const delCount = Number(saved.endRow) - Number(saved.parentRow) + 1;
    sh.deleteRows(Number(saved.parentRow), delCount);
    cache.remove(`del:${confirm_token}`);
    return ok("books.delete", { deleted_rows: delCount });
  } catch (error: any) {
    return ng("books.delete", "ERROR", error.message);
  }
}
