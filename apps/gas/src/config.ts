// GAS 用の設定（開発ではここを編集。機微情報は ScriptProperties へ）
export const CONFIG = {
  BOOKS_FILE_ID: "1Z0mMUUchd9BT6r5dB6krHjPWETxOJo7pJuf2VrQ_Pvs",
  BOOKS_SHEET: "参考書マスター",
  // 生徒マスター（指定がない場合は最初のシートを使用）
  STUDENTS_FILE_ID: "1hLQe1TO6bfmdk3kvyV3RNkWmBuHhMfr9y01lIs7FVVI",
  STUDENTS_SHEET: "",
} as const;

// ScriptProperties から真偽を取得（"true"/"1"/"on" を真と解釈）
function getBool(key: string, fallback: boolean): boolean {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(key);
    if (!v) return fallback;
    return /^(true|1|on|yes)$/i.test(String(v).trim());
  } catch {
    return fallback;
  }
}

// 開発時の補助フラグ（デフォルトはfalse。必要に応じてScriptPropertiesで上書き）
export function isFindDebugEnabled(): boolean {
  return getBool("ENABLE_FIND_DEBUG", false);
}
export function isTableReadEnabled(): boolean {
  return getBool("ENABLE_TABLE_READ", false);
}
