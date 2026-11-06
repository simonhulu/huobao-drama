export const VIDEO_TITLE_SYMBOL_RULE = '标题不能包含特殊字符，符号仅支持书名号、引号、冒号、加号、问号、百分号、摄氏度，逗号可用空格代替'

export function normalizeVideoTitle(title) {
  return title.replace(/[,，]/gu, ' ').trim()
}

export function hasSupportedVideoTitleSymbols(title) {
  return /^[\p{L}\p{N} 《》〈〉“”‘’「」『』"':：+＋?？%％℃]*$/u.test(title)
}

// Platform constraints warn while editing; publishing still validates them strictly.
export function getVideoTitleWarnings(title, maxLength, label) {
  const value = normalizeVideoTitle(title)
  const warnings = []
  if (value.length > maxLength) warnings.push(`${label}共${value.length}字，超过${maxLength}字上限，请在发布前修改。`)
  if (!hasSupportedVideoTitleSymbols(value)) warnings.push(`${label}包含平台不支持的符号、换行或隐藏字符，请在发布前修改。${VIDEO_TITLE_SYMBOL_RULE}。`)
  return warnings
}
