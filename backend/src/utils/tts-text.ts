/**
 * TTS 文本预处理工具。
 *
 * 目标：移除复制粘贴、Markdown、排版软件带入的不可见/装饰字符，
 * 压缩连续空白，消除中文字符之间不应存在的停顿，让 TTS 读得更连贯。
 */

// 零宽字符、不间断空格、全角空格、控制字符（保留换行 \n、回车 \r、制表 \t 交给后续统一处理）
const INVISIBLE_CHARS = /[\u200B-\u200F\uFEFF\u00A0\u3000\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

// 装饰性分隔线、方框绘制字符、块元素（如 ──────────、████）
const DECORATIVE_LINES = /[\u2500-\u257F\u2580-\u259F]/g

// CJK 统一表意文字（基本区 + 扩展 A）
const CJK_CHAR = /[\u4e00-\u9fa5\u3400-\u4dbf]/

export interface MarkdownScriptDocument {
  body: string
  metadata: Record<string, string>
  hasFrontMatter: boolean
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Parse the deliberately small YAML front matter contract used by final scripts.
 * This is intentionally not a general YAML parser: metadata is flat scalar
 * key/value data, while the body is the only text that may reach narration.
 */
export function parseMarkdownScriptDocument(text?: string | null): MarkdownScriptDocument {
  const source = String(text ?? '').replace(/^\uFEFF/u, '')
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u)
  if (!match) return { body: source, metadata: {}, hasFrontMatter: false }

  const metadata: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u)
    if (entry) metadata[entry[1]] = parseYamlScalar(entry[2])
  }
  if (!Object.keys(metadata).length) return { body: source, metadata: {}, hasFrontMatter: false }

  return {
    body: source.slice(match[0].length).replace(/^\r?\n/u, ''),
    metadata,
    hasFrontMatter: true,
  }
}

/**
 * 清理输入文本，返回适合直接送入 TTS 引擎的字符串。
 *
 * 处理内容：
 * - 移除零宽空格、不间断空格、控制字符
 * - 移除装饰性分隔线、方框绘制字符
 * - 移除 CJK 字符之间的半角/全角空格（避免“文 字”被读成长停顿）
 * - 合并连续空白为单个空格
 */
export function normalizeTtsText(text?: string | null): string {
  if (!text) return ''
  return text
    .replace(INVISIBLE_CHARS, '')
    .replace(DECORATIVE_LINES, '')
    .replace(new RegExp(`(${CJK_CHAR.source})\\s+(?=${CJK_CHAR.source})`, 'g'), '$1')
    // Keep line boundaries so the Markdown sanitizer can distinguish metadata
    // headings from the narration that follows them. Collapsing the entire
    // document to one line makes `# Script ...` look like one metadata line
    // and can erase a complete episode before TTS.
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 移除 Markdown/HTML 排版标记，保留可朗读正文。
 *
 * 处理内容：
 * - HTML 注释 / 标签
 * - 标题 # / ## 等
 * - 分隔线 --- / *** / ___
 * - 粗体 **text** / __text__
 * - 斜体 *text* / _text_
 * - 行内代码 `text`
 * - 链接 [text](url) -> text
 * - 图片 ![alt](url) -> alt
 * - 引用 > / 列表 - * + 1.
 */
export function stripMarkdownForTts(text: string): string {
  const script = parseMarkdownScriptDocument(text)
  return script.body
    // HTML 注释（可能跨行）
    .replace(/<!--[\s\S]*?-->/g, '')
    // HTML 标签
    .replace(/<[^>]+>/g, '')
    // 标题标记：以元数据关键词开头的整行删除（不应被朗读）；其他标题仅去标记保留正文
    .replace(/^#{1,6}\s+(Script|Theme|Opening|Closing|Duration|Chars|Reference\s*base)\s*:?\s*/gim, '')
    .replace(/^#{1,6}\s*/gm, '')
    // 常见分镜元数据，如 (Beat O1-O5)
    .replace(/\(Beat [^)]+\)/g, '')
    // 常见结构前缀/词：Script / Theme / Opening / Closing（可选冒号，仅去前缀保留正文）
    .replace(/^(Script|Theme|Opening|Closing)\b[:\s]*/gim, '')
    // 纯元数据行——整行删除，不应被 TTS 朗读
    .replace(/^(Duration|Chars|Reference\s*base)[:\s]+.*$/gim, '')
    // **孤立数字/符号行**（如 "| Chars: ~7500" 在去前缀后残留的碎片）
    .replace(/^\s*\|?\s*(Chars|Duration|Reference)\b[:\s]*.*$/gim, '')
    .replace(/^\s*\|\s*[\d~]+\s*(chars)?\s*$/gim, '')
    // 分隔线
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // 图片 -> alt 文本
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 链接 -> 显示文本
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 粗体 / 斜体（先处理双标记，再处理单标记）
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    // 行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 引用标记
    .replace(/^>\s*/gm, '')
    // 列表标记
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // 合并多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * TTS 入口统一清洗：先剥离 Markdown/HTML，再做常规 normalize。
 * 任何 TTS 请求都建议经过此函数，避免 Markdown 标记进入引擎导致
 * 纯标点 chunk 或空 chunk 崩溃。
 */
export function sanitizeTtsInput(text?: string | null): string {
  return normalizeTtsText(stripMarkdownForTts(text ?? '')).replace(/\s+/g, ' ').trim()
}
