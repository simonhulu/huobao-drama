import { z } from 'zod'
import type { CoverJsonRequest, HistoryPublishingVariant } from './cover-prompt-enhance.js'
import { HISTORY_TITLE_GUIDELINES } from './history-publishing-copy.js'
import { normalizeVideoTitle, hasSupportedVideoTitleSymbols } from './video-title-format.js'

const promotion = /订阅|訂閱|点赞|點讚|點贊|助眠|睡前[历歷]史故事|(?:欢迎|歡迎|请|請|记得|記得|别忘了|別忘了)(?:关注|關注)|完整版|合集|会员专享|會員專享|三连|三連|公众号|公眾號|打赏|打賞|https?:\/\/|www\./iu
const word = z.string().trim().min(1).max(120)
const promotionSpan = z.string().trim().min(1).max(2000)
const keywordSchema = z.object({ text: word, kind: z.enum(['person', 'dynasty', 'place', 'time', 'number', 'topic']) }).strict()
const titleSchema = z.string().transform(normalizeVideoTitle).pipe(z.string().min(1).max(40))
  .refine(hasSupportedVideoTitleSymbols, '发布标题包含不支持的符号')
  .refine(value => /[\p{L}\p{N}]/u.test(value), '标题必须包含实际文字')
const responseSchema = z.object({ title: titleSchema, keywords: z.array(keywordSchema).min(1).max(16),
  removed_promotions: z.array(promotionSpan).max(20).default([]) }).strict()

export const sourceTitleRewriteSchema = responseSchema.extend({
  method: z.literal('source-title-rewrite-v2'), source_title: z.string().trim().min(1).max(2000),
  cleaned_title: z.string().trim().min(1).max(2000), protected_numbers: z.array(word).max(40),
}).strict()
export type SourceTitleRewrite = z.infer<typeof sourceTitleRewriteSchema>

export function cleanHistorySourceTitle(value: string) {
  const source = value.trim(), removed: string[] = []
  const remove = (match: string) => { removed.push(match.trim()); return ' ' }
  let cleaned = source.replace(/https?:\/\/\S+|www\.\S+/giu, remove)
    .replace(/[【\[（(]([^】\]）)]+)[】\]）)]/gu, (match, content: string) => promotion.test(content) ? remove(match) : match)
  // Remove explicit promotional tails without splitting dates or topic text at every hyphen.
  const segments = cleaned.split(/\s*[|｜]\s*|\s+[—–-]\s+|[-—](?=(?:助眠|睡前|睡眠|欢迎|歡迎|订阅|訂閱|关注|關注))/u)
  cleaned = segments.filter((part, index) => {
    if (index > 0 && promotion.test(part)) { removed.push(part.trim()); return false }
    return true
  }).join(' ')
  cleaned = cleaned.replace(/(?:欢迎|歡迎|请|請|记得|記得|别忘了|別忘了)(?:订阅|訂閱|关注|關注|点赞|點讚|點贊)[^。！？\n]*/gu, remove)
    .replace(/#[^\s#|｜]+/gu, match => promotion.test(match) ? remove(match) : match.slice(1))
    .replace(/\s+/gu, ' ').trim()
  return { source, cleaned, removed: [...new Set(removed.filter(Boolean))] }
}

export function sourceTitleNumbers(value: string) {
  const normalized = value.normalize('NFKC')
  const spans = normalized.match(/(?:公元前|公元)?(?:\d+(?:\.\d+)?|[零〇一二两兩三四五六七八九十百千万萬亿億]+)(?:世纪|世紀|小时|小時|分钟|分鐘|年|月|日|岁|歲|兵|人|里|次|倍|个|個|斤|天|%|％)/gu) || []
  const digits = normalized.match(/\d+(?:\.\d+)?/gu) || []
  return [...new Set([...spans, ...digits])]
}

function evidenceIssue(record: SourceTitleRewrite) {
  const clean = cleanHistorySourceTitle(record.source_title)
  if (record.cleaned_title !== clean.cleaned) return '原标题清理记录不一致'
  if (record.removed_promotions.some(term => !record.source_title.includes(term) || !promotion.test(term))) return '只能记录原标题中实际出现的推广内容'
  if (record.keywords.some(item => !record.cleaned_title.includes(item.text) || !record.title.includes(item.text))) return '原标题的保留关键词必须原样出现在发布标题中'
  if (new Set(record.keywords.map(item => item.text)).size !== record.keywords.length) return '关键词不能重复'
  const expected = sourceTitleNumbers(record.cleaned_title), actual = sourceTitleNumbers(record.title)
  if (JSON.stringify(record.protected_numbers) !== JSON.stringify(expected)) return '原标题的时间数字记录不一致'
  if (expected.some(value => !actual.includes(value))) return '必须保留原标题中的时间与数字，不能替换或删减'
  if (actual.some(value => !expected.includes(value))) return '改写标题不能添加原标题中没有的时间与数字'
  if (promotion.test(record.title)) return '发布标题仍包含推广内容'
}

export function hasCompleteSourceTitleRewrite(value: SourceTitleRewrite) {
  const parsed = sourceTitleRewriteSchema.safeParse(value)
  return parsed.success && !evidenceIssue(parsed.data)
}

export function historyPackagingTextKey(value: string) {
  return value.normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\s]/gu, '').toLowerCase()
    .replace(/(?:花生版|精细化版|精细版|huasheng版?|remotion版?)$/u, '')
}

export async function rewriteHistorySourceTitle(input: { sourceTitle: string; script: string; publishingVariant?: HistoryPublishingVariant }, request: CoverJsonRequest): Promise<SourceTitleRewrite> {
  const cleaned = cleanHistorySourceTitle(input.sourceTitle)
  if (!cleaned.source || !cleaned.cleaned) throw new Error('缺少可改写的原标题，请先补齐来源标题')
  const protectedNumbers = sourceTitleNumbers(cleaned.cleaned)
  let failure = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await request([
      { role: 'system', content: `${HISTORY_TITLE_GUIDELINES}\nkeywords 列出原标题中需要保留的全部主要人物/朝代、时间、数字及核心主题，每项text逐字取自cleanedTitle且必须出现在title中。removed_promotions只列原标题中实际出现的无关推广片段，不列历史关键词。protectedNumbers必须全部保留。${input.publishingVariant ? '\npublishingVariant说明当前成片归属：huasheng为花生版，motion为精细化版，manual为手动版；它只约束表达，不提供任何新事实。为本版采用与otherPackages已有标题不同表达的问题或句式，不能只改标点、空格、添加版名后缀。保留原标题人物、时间数字和核心主题，所有事实仍以原标题和正文为准。' : ''}\n只输出JSON：{"title":"改写标题","keywords":[{"text":"原题关键词","kind":"person|dynasty|place|time|number|topic"}],"removed_promotions":["去除的推广片段"]}` },
      { role: 'user', content: JSON.stringify({ purpose: 'history-source-title-rewrite', sourceTitle: cleaned.source, cleanedTitle: cleaned.cleaned,
        protectedNumbers, removedPromotions: cleaned.removed, script: input.script,
        ...(input.publishingVariant ? { publishingVariant: input.publishingVariant } : {}), ...(failure ? { correction: failure } : {}) }) },
    ], { maxTokens: 1800, temperature: .4 })
    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) { failure = parsed.error.issues.slice(0, 3).map(issue => issue.message).join('；'); continue }
    const result: SourceTitleRewrite = { ...parsed.data, method: 'source-title-rewrite-v2', source_title: cleaned.source,
      cleaned_title: cleaned.cleaned, protected_numbers: protectedNumbers,
      removed_promotions: [...new Set([...cleaned.removed, ...parsed.data.removed_promotions])] }
    failure = evidenceIssue(result) || ''
    if (!failure && input.publishingVariant?.otherPackages.some(other => other.title.trim()
      && historyPackagingTextKey(other.title) === historyPackagingTextKey(result.title))) {
      failure = '发布标题与另一版成片重复，必须采用不同表达，不能只改标点、空格或添加版名后缀'
    }
    if (!failure) return result
  }
  throw new Error(`原标题改写未完成：${failure}；保留原方案，未截断标题`)
}
