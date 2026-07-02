import { callTextModel } from './ai.js'
import type { SmartSplitResult } from './episode-splitter.js'

const TITLE_SYSTEM_PROMPT = `你是短视频/漫画推文标题专家，专门写“高点击、强情绪、留悬念”的标题。

合格标题示例：
“她用一纸离婚协议，终结了十年的婚姻——当妻子不再发疯，丈夫才真正开始失去她。”

标题必须遵循以下格式：
1. 只用一句话，不要分段，不要换行。
2. 不要任何标签（如【】、｜、完结漫画、反套路），不要书名号《》。
3. 前半句写一个具体动作或事件，后半句用“——”引出反转、悬念或真相。
4. 要口语化、有情绪、有画面感，能让观众立刻想知道后续。
5. 总长度控制在 30-50 个汉字之间。
6. 不要写“第 X 集”。
7. 只输出标题文本，不要解释。`

function cleanTitle(raw: string): string {
  return raw.replace(/^["\“\']|["\”\']$/g, '').trim()
}

export interface TitleGenerationInput {
  dramaTitle: string
  sourceText: string
  splitResult: SmartSplitResult
  style?: string
}

export interface GeneratedTitles {
  dramaTitle: string
  episodeTitles: string[]
}

export async function generateRetentionTitles(input: TitleGenerationInput): Promise<GeneratedTitles> {
  const { dramaTitle, sourceText, splitResult, style } = input

  const episodesInfo = splitResult.episodes.map((ep, idx) => ({
    number: idx + 1,
    summary: ep.summary,
    openingHook: ep.openingHook,
    cliffhanger: ep.cliffhangerHook,
  }))

  const userPrompt = `请为以下漫画/短剧项目生成一个项目主标题，以及每一集的吸睛标题。

项目原名：${dramaTitle}
项目视觉风格：${style || '未指定'}

剧情推进链：
${splitResult.plotProgressionChain.map(b => `- ${b.phase}: ${b.summary}`).join('\n')}

分集信息：
${episodesInfo.map(e => `第${e.number}集\n- 开场钩子：${e.openingHook}\n- 结尾悬念：${e.cliffhanger}\n- 本集摘要：${e.summary}`).join('\n\n')}

原文摘要（前 2000 字）：
${sourceText.slice(0, 2000)}

请按以下格式输出，不要有多余内容：
项目标题：<项目主标题>
第1集：<第1集标题>
第2集：<第2集标题>
...`

  const content = await callTextModel([
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.85, maxTokens: 1200 })

  const dramaMatch = content.match(/项目标题[:：]\s*(.+)/)
  const dramaVideoTitle = dramaMatch ? cleanTitle(dramaMatch[1]) : splitResult.hook

  const episodeTitles: string[] = []
  const episodeRegex = /第\s*(\d+)\s*集[:：]\s*(.+)/g
  let m
  while ((m = episodeRegex.exec(content)) !== null) {
    const idx = Number(m[1]) - 1
    episodeTitles[idx] = cleanTitle(m[2])
  }

  // 如果某些集没有生成到，用 opening_hook 兜底
  for (let i = 0; i < splitResult.episodes.length; i++) {
    if (!episodeTitles[i]) {
      const fallback = splitResult.episodes[i]?.openingHook
      episodeTitles[i] = fallback && fallback.length >= 10 ? fallback : `${dramaTitle} 第${i + 1}集`
    }
  }

  return {
    dramaTitle: dramaVideoTitle,
    episodeTitles: episodeTitles.slice(0, splitResult.episodes.length),
  }
}
