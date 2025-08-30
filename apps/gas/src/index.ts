// Type definitions
type Json = Record<string, any>;
type ApiResponse = {
  ok: boolean;
  op?: string;
  meta?: { ts: string };
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
};

type BookFindCandidate = {
  book_id: string;
  title: string;
  subject: string;
  score: number;
  reason: "exact" | "partial" | "fuzzy3";
};

type ChapterInfo = {
  idx: number | null;
  title: string | null;
  range: { start: number | null; end: number | null } | null;
  numbering: string | null;
};

type BookDetails = {
  id: string;
  title: string;
  subject: string;
  monthly_goal: {
    text: string;
    per_day_minutes: number | null;
    days: number | null;
    total_minutes_est: number | null;
  };
  unit_load: number | null;
  structure: { chapters: ChapterInfo[] };
  assessment: {
    book_type: string;
    quiz_type: string;
    quiz_id: string;
  };
};

/*******************************
 * 設定（あなたの環境に合わせて）
 *******************************/
const CONFIG = {
  BOOKS_FILE_ID: "1Z0mMUUchd9BT6r5dB6krHjPWETxOJo7pJuf2VrQ_Pvs",
  BOOKS_SHEET: "参考書マスター",
};

/*******************************
 * 共通ユーティリティ
 *******************************/
const ok = (op: string, data: any = {}): ApiResponse => ({ 
  ok: true, 
  op, 
  meta: { ts: new Date().toISOString() }, 
  data 
});

const ng = (op: string, code: string, message: string, details: any = {}): ApiResponse => ({ 
  ok: false, 
  op, 
  error: { code, message, details } 
});

function createJsonResponse(response: ApiResponse): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// 全角/半角, 大小, スペースの揺れを軽減（曖昧検索用）
function normalize(s: any): string {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

/*******************************
 * 入口（HTTP GET/POSTの両対応）
 *******************************/

export function authorizeOnce(): void {
  // 参考書マスターを一度開いて、権限承認を発生させる
  const ss = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID);
  const name = ss.getSheets()[0].getName();
  console.log("authorized OK, first sheet:", name);
}

export function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  const p: Record<string, any> = (e && e.parameter) || {};
  const params: Record<string, string[]> = (e && (e as any).parameters) || {} as any;

  // GETでも複数IDを扱えるように、e.parameters を取り込む
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
        case "books.find": return booksFind(req);
        case "books.get":  return booksGet(req);
        case "table.read": return tableRead(req);
        case "ping": return ok("ping", { status: "ok", timestamp: new Date().toISOString() });
        default: return ng(req.op || "unknown", "UNKNOWN_OP", "Unsupported op");
      }
    };
    return createJsonResponse(route(p));
  }
  
  return createJsonResponse(ok("ping", { params: p }));
}

export function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  console.log("doPost hit:", e && e.postData && e.postData.contents);
  
  try {
    const req = JSON.parse(e.postData?.contents || "{}");
    
    switch (req.op) {
      case "books.find": return createJsonResponse(booksFind(req));
      case "books.get":  return createJsonResponse(booksGet(req));
      case "table.read": return createJsonResponse(tableRead(req));
      default: return createJsonResponse(ng(req.op || "unknown", "UNKNOWN_OP", "Unsupported op"));
    }
  } catch (err: any) {
    return createJsonResponse(ng("unknown", "UNCAUGHT", err.message, { stack: err.stack }));
  }
}

/*******************************
 * テーブル読み取り（デバッグ・確認用）
 *******************************/
function tableRead(req: Record<string, any>): ApiResponse {
  const { file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET, header_row = 1 } = req;
  
  try {
    const sh = SpreadsheetApp.openById(file_id).getSheetByName(sheet);
    if (!sh) return ng("table.read", "NOT_FOUND", `sheet '${sheet}' not found`);
    
    const values = sh.getDataRange().getValues();
    const headers = values[header_row - 1].map(String);
    const rows = values.slice(header_row).filter(r => r.join("") !== "")
      .map(r => Object.fromEntries(headers.map((k, i) => [k, r[i]])));
    
    return ok("table.read", { rows, columns: headers, count: rows.length });
  } catch (error: any) {
    return ng("table.read", "ERROR", error.message);
  }
}

/*******************************
 * 参考書マスター：検索（曖昧可）
 *******************************/
function booksFind(req: Record<string, any>): ApiResponse {
  const { query, limit = 20, file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET } = req;
  if (!query) return ng("books.find", "BAD_REQUEST", "query が必要です");

  // --- 小ヘルパ（関数内スコープ） ---
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
  const tokenize = (s: any): string[] => {
    const n = (s ?? "").toString().normalize("NFKC")
      .replace(/[Ⅰ]/g, "1").replace(/[Ⅱ]/g, "2").replace(/[Ⅲ]/g, "3")
      .replace(/[Ⅳ]/g, "4").replace(/[Ⅴ]/g, "5").replace(/[Ⅵ]/g, "6")
      .replace(/[Ⅶ]/g, "7").replace(/[Ⅷ]/g, "8").replace(/[Ⅸ]/g, "9").replace(/[Ⅹ]/g, "10")
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
  
  const estimateConfidence = (sorted: BookFindCandidate[]): number => {
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
    // シリーズ個別のハードコードは避け、一般的な一致（フレーズ/被覆率）を重視する
    // 親行（参考書IDのある行）のみを対象に、DF（各トークンの出現ドキュメント数）を収集
    const seen = new Set<string>();           // 同一IDの重複を抑制（章の続き行を除外）
    const df: Record<string, number> = {};    // token -> doc freq
    const parentRows: { id: string; title: string; subject: string; aliases: string[] }[] = [];

    for (const row of values) {
      const idRaw = (row[idxId] ?? "").toString().trim();
      const titleRaw = (row[idxTitle] ?? "").toString().trim();
      const subjectRaw = (row[idxSubject] ?? "").toString().trim();

      // "章だけの行"（ID/タイトル/教科 全て空）はスキップ
      if (!idRaw && !titleRaw && !subjectRaw) continue;

      // 1冊=複数行の表に対応：IDのある「親行」だけ採用
      if (!idRaw) continue;
      if (seen.has(idRaw)) continue;
      seen.add(idRaw);
      const aliases = idxAlias >= 0 ? parseAliases(row[idxAlias]) : [];
      parentRows.push({ id: idRaw, title: titleRaw, subject: subjectRaw, aliases });

      // DF更新（タイトル+別名のトークンユニーク集合でカウント）
      const tokSet = new Set(tokenize([titleRaw, ...aliases].join(" ")));
      for (const t of tokSet) {
        df[t] = (df[t] ?? 0) + 1;
      }
    }

    // IDF（薄い重み）：idf = log((N - df + 0.5)/(df + 0.5) + 1)
    const N = parentRows.length || 1;
    const idf = (t: string): number => {
      const d = df[t] ?? 0;
      return Math.log(((N - d + 0.5) / (d + 0.5)) + 1);
    };

    // クエリ側トークンのIDF合計（正規化係数）
    const uniqQToks = Array.from(new Set(qTokens));
    const sumIdfQ = uniqQToks.reduce((acc, t) => acc + idf(t), 0) || 1;

    // 候補スコア算出
    const candidates: BookFindCandidate[] = [];
    for (const r of parentRows) {
      const aliasTexts = r.aliases;
      const hay = [r.id, r.title, r.subject, ...aliasTexts]
        .map(norm)
        .filter(t => t && t.length >= 2);

      // 一般的な一致評価（フレーズ/部分一致優先）
      const combinedTitle = [r.title, ...aliasTexts].join(" ");
      const combinedNorm = norm(combinedTitle);
      const titleTokSet = new Set(tokenize(combinedTitle));

      // IDF加重被覆率（query側の希少トークンほど寄与が大きい）
      let idfHit = 0;
      for (const t of uniqQToks) if (titleTokSet.has(t)) idfHit += idf(t);
      const covIdf = idfHit / sumIdfQ; // 0..1

      // ベーススコア（シンプル）
      let score = 0; let reason: any = "";
      if (hay.some(t => t === q)) { score = 1.0; reason = "exact"; }
      else if (combinedNorm.includes(q)) { score = 0.95; reason = "phrase"; }
      else if (hay.some(t => t.includes(q))) { score = 0.90; reason = "partial_target"; }
      else if (covIdf > 0) { score = 0.80; reason = "coverage_idf"; }
      else {
        const short = q.length >= 3 ? q.slice(0,3) : "";
        if (short && hay.some(t => t.includes(short))) { score = 0.72; reason = "fuzzy3"; }
      }

      // 薄いボーナス（IDF被覆率と前方一致、教科一致）
      let bonus = 0;
      if (covIdf > 0) bonus += Math.min(0.12, 0.12 * covIdf); // 最大+0.12
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

    // 降順ソート
    candidates.sort((a, b) => b.score - a.score);

    // 動的しきい値決定：スコアの大きな落差（ギャップ）で切る
    // - 連続スコア差の最大値が minGap 以上の箇所を境に上位のみ採用
    const minGap = 0.05; // 例: 0.05 以上下がる所で分割
    let cutIndex = candidates.length; // デフォルトは全件
    for (let i = 0; i < candidates.length - 1; i++) {
      const d = candidates[i].score - candidates[i+1].score;
      if (d >= minGap) { cutIndex = i + 1; break; }
    }

    // しきい値適用後、limitで上限（指定時）
    const sliced = candidates.slice(0, typeof limit === 'number' ? Math.min(limit, cutIndex) : cutIndex);
    const top = sliced[0] || null;
    const confidence = estimateConfidence(sliced);

    return ok("books.find", {
      query,
      candidates: sliced,
      top,
      confidence
    });
  } catch (error: any) {
    return ng("books.find", "ERROR", error.message);
  }
}

/*******************************
 * 参考書マスター：IDで取得（正規化して返す）
 *******************************/
function booksGet(req: Record<string, any>): ApiResponse {
  const { book_id, book_ids, file_id = CONFIG.BOOKS_FILE_ID, sheet = CONFIG.BOOKS_SHEET } = req;
  // 複数ID対応: book_ids (string[]) または book_id が配列の場合
  const listParam: any = (Array.isArray(book_ids) ? book_ids : (Array.isArray(book_id) ? book_id : null));
  if (!book_id && !listParam) return ng("books.get", "BAD_REQUEST", "book_id または book_ids が必要です");

  // ---- 小ヘルパ ----
  const norm = (s: any): string => (s ?? "").toString().trim().toLowerCase().normalize("NFKC");
  const pickCol = (headers: string[], candidates: string[]): number => {
    const Hn = headers.map(h => norm(h).replace(/\s+/g, ""));
    for (const c of candidates) {
      const i = Hn.indexOf(norm(c).replace(/\s+/g, ""));
      if (i >= 0) return i;
    }
    return -1;
  };
  const toNumberOrNull = (x: any): number | null => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  
  // "1day 3時間×17day" / "50語/1時間" 等を軽くパース（時間→分のみ確定）
  const parseMonthlyGoal = (txt: any) => {
    if (!txt) return null;
    const s = String(txt);
    const hm = s.match(/(\d+(?:\.\d+)?)\s*時間/);
    const per_day_minutes = hm ? Math.round(parseFloat(hm[1]) * 60) : null;
    // day数は書式が多様なので無理に推定しない（必要なら後で拡張）
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
      // 収集用マップ: id -> { meta, chapters[] }
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
          bucket.chapters.push({
            idx: chIdx ?? (bucket.chapters.length + 1),
            title: chName || null,
            range: (chBeg != null || chEnd != null) ? { start: chBeg, end: chEnd } : null,
            numbering: numSty || null,
          });
        }
      }

      // 結果整形
      const books: BookDetails[] = [];
      for (const id of targetIds) {
        const bucket = booksMap[id];
        if (!bucket || !bucket.meta) continue;
        const mg = parseMonthlyGoal(bucket.meta.monthly_goal_text);
        books.push({
          id: bucket.meta.id,
          title: bucket.meta.title,
          subject: bucket.meta.subject,
          monthly_goal: {
            text: bucket.meta.monthly_goal_text || "",
            per_day_minutes: mg?.per_day_minutes ?? null,
            days: mg?.days ?? null,
            total_minutes_est: mg?.total_minutes_est ?? null,
          },
          unit_load: bucket.meta.unit_load ?? null,
          structure: { chapters: bucket.chapters },
          assessment: {
            book_type: bucket.meta.book_type || "",
            quiz_type: bucket.meta.quiz_type || "",
            quiz_id: bucket.meta.quiz_id || "",
          },
        });
      }
      return ok("books.get", { books });
    }

    // 単一ID：従来どおり
    let currentId: string | null = null;
    let started = false;
    let meta: any = null;
    const chapters: ChapterInfo[] = [];

    for (const r of values) {
      const idCell = (r[IDX.id] ?? "").toString().trim();
      if (idCell) currentId = idCell;                   // 新しい本ブロック開始

      if (!started) {
        if (currentId === book_id && idCell) {
          // ターゲットの"親行"でメタ情報を確定
          started = true;
          meta = {
            id: currentId,
            title: (r[IDX.title] ?? "").toString(),
            subject: (r[IDX.subject] ?? "").toString(),
            monthly_goal_text: (IDX.goal >= 0 ? (r[IDX.goal] ?? "").toString() : ""),
            unit_load: (IDX.unit >= 0 ? toNumberOrNull(r[IDX.unit]) : null),
            book_type: (IDX.btype >= 0 ? (r[IDX.btype] ?? "").toString() : ""),
            quiz_type: (IDX.qtype >= 0 ? (r[IDX.qtype] ?? "").toString() : ""),
            quiz_id  : (IDX.qid >= 0 ? (r[IDX.qid] ?? "").toString() : "")
          };
          // 親行にも章が入っている場合があるので、その場で拾う
        } else {
          continue;
        }
      } else {
        // すでに対象ブロック中：別のIDが来たら終了
        if (idCell && idCell !== book_id) break;
      }

      // この行の章情報を収集（親行／続き行どちらも）
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
          numbering: numSty || null
        });
      }
    }

    if (!meta) return ng("books.get", "NOT_FOUND", `book_id '${book_id}' が見つかりません`);

    const mg = parseMonthlyGoal(meta.monthly_goal_text);
    const book: BookDetails = {
      id: meta.id,
      title: meta.title,
      subject: meta.subject,
      monthly_goal: {
        text: meta.monthly_goal_text || "",
        per_day_minutes: mg?.per_day_minutes ?? null,
        days: mg?.days ?? null,
        total_minutes_est: mg?.total_minutes_est ?? null
      },
      unit_load: meta.unit_load ?? null,
      structure: { chapters },
      assessment: {
        book_type: meta.book_type || "",
        quiz_type: meta.quiz_type || "",
        quiz_id: meta.quiz_id || ""
      }
    };

    return ok("books.get", { book });
  } catch (error: any) {
    return ng("books.get", "ERROR", error.message);
  }
}
