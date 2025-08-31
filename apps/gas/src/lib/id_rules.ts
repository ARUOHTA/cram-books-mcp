/**
 * ID規則（サブコード推定・連番採番）
 * g + サブコード(1–3文字) + 3桁連番（例: gEC062）
 * サブコードは教科/分野から推定する。
 */
import { normalize } from "./common";

// 教科/タイトルからサブコードを推定
export function decidePrefix(subject: string, title: string): string {
  const s = normalize(subject);
  const t = normalize(title);
  const has = (kw: string) => t.includes(normalize(kw));

  // 英語: 細分類
  if (s.includes("英語")) {
    if (has("英作文") || has("自由英作文") || has("作文")) return "EW"; // Writing
    if (has("リスニング") || has("聴解")) return "EL"; // Listening
    if (has("英文解釈") || has("構文") || has("パラグラフリーディング")) return "EK"; // Kaiseki
    if (has("長文") || has("リーディング") || has("読解")) return "EC"; // Comprehension
    if (has("単語") || has("語彙") || has("熟語") || has("ターゲット") || has("leap")) return "ET"; // Vocabulary
    if (has("文法") || has("スクランブル") || has("英文法")) return "EB"; // Grammar
    return "EC";
  }

  // 数学（I/A/II/B/III/C を包含）
  if (s.includes("数学")) return "MB";

  // 国語
  if (s.includes("現代文")) return "JG";
  if (s.includes("古文") || s.includes("漢文") || s.includes("古典")) return "JO";

  // 社会
  if (s.includes("日本史")) return "JH";
  if (s.includes("世界史")) return "WH";
  if (s.includes("地理")) return "GG"; // Geography
  if (s.includes("政治") || s.includes("経済") || s.includes("政治経済")) return "GE"; // Politics/Economics

  // 理科
  if (s.includes("物理基礎")) return "PHB";
  if (s.includes("物理")) return "PH";
  if (s.includes("化学基礎")) return "CHB";
  if (s.includes("化学")) return "CH";
  if (s.includes("生物基礎")) return "BIB";
  if (s.includes("生物")) return "BI";
  if (s.includes("地学基礎")) return "ESB";

  // フォールバック
  return "MB";
}

// 同じ prefix を持つ最大連番+1のIDを返す
export function nextIdForPrefix(prefix: string, allValues: any[][], idColIndex: number): string {
  let maxNum = 0;
  if (idColIndex >= 0) {
    for (let r = 1; r < allValues.length; r++) {
      const v = (allValues[r][idColIndex] ?? "").toString().trim();
      if (v && v.startsWith(prefix)) {
        const m = v.slice(prefix.length).match(/(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
        }
      }
    }
  }
  return prefix + String(maxNum + 1).padStart(3, "0");
}

