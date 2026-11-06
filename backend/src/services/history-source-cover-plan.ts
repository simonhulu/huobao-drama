import type { CoverPromptEnhanceResult } from './cover-prompt-enhance.js'
import { cleanHistorySourceTitle } from './history-title-source.js'
import { normalizeVideoTitle } from './video-title-format.js'

export function cleanHistoryOriginalTitle(sourceTitle: string) {
  const episodes = /(?:第\s*[0-9０-９零〇一二两兩三四五六七八九十百千]+\s*[集期话話回]|[0-9０-９零〇一二两兩三四五六七八九十百千]+\s*集|[上中下]\s*集|\b(?:ep(?:isode)?)[.\s]*\d+\b)/giu
  const parts = sourceTitle.replace(episodes, ' ')
    .replace(/\s*@[\p{L}\p{N}_.-]+|#[^\s#|｜]+#?/gu, ' ')
    .split(/[|｜]/u).map(part => part.trim()).filter(Boolean)
  const main = parts[0] || ''
  // Short pipe-separated labels after a full headline are source tags. Keep
  // complete clauses and dates, which may carry part of the original subject.
  const headline = parts.filter((part, index) => index === 0 || main.length < 15 || part.length > 12
    || /[?？!！:：\d０-９]/u.test(part) || (!/[?？]/u.test(main) && parts.length < 3)).join('｜')
  const cleaned = cleanHistorySourceTitle(headline).cleaned
    .replace(/[【\[（(]\s*[】\]）)]/gu, ' ')
    .replace(/^[\s:：|｜—–-]+|[\s:：|｜—–-]+$/gu, '')
    .replace(/\s+/gu, ' ').trim()
  const title = normalizeVideoTitle(cleaned)
  if (!/[\p{L}\p{N}]/u.test(title)) throw new Error('缺少有效的原标题，请先补齐来源标题')
  return title
}

export function createHistorySourceCoverPlan(sourceTitle: string, script: string): CoverPromptEnhanceResult {
  const title = cleanHistoryOriginalTitle(sourceTitle)
  const candidate = {
    id: 'source-screenshot', method: '原标题清洗', main_title: title, sub_title: '', kicker: '', image_prompt: '',
    accent_color: '#FFFFFF', thumbnail_layout: 'text-left' as const,
    enhanced_prompt: '从真实视频素材选取清晰截图，叠加清洗后的原标题。', rationale: '保留原标题措辞，只去除集数和无关信息。',
    why_click: '沿用原标题主题', viewer_question: '原标题所述内容', payoff: '观看原题对应内容',
    evidence: [script.trim().slice(0, 1200)], visual_concept: '真实视频素材截图与原标题',
    video_title: title, baijiahao_title: title, video_description: '',
  }
  return { ...candidate, editorial_plan: {
    version: 'history-cover-plan-v1', publishing_version: 'source-screenshot-v3', selection_mode: 'source-title',
    source_title_cleanup: { source_title: sourceTitle, cleaned_title: title },
    selected_id: candidate.id, selection_reason: candidate.rationale, candidates: [candidate], reviews: [],
  } }
}
