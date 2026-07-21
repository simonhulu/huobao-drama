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
    .replace(/\s+/g, ' ')
    .trim()
}
