/**
 * 镜头设计器：先构思画面，再生成视频
 * 流程：LLM#1 画面构思（主体/色彩/光线/情绪/运镜 + 英文检索词）
 *   → Shot.Cafe 按检索词找专业电影截图（导演构图参考）
 *   → VLM 分析参考图的构图/色彩/光线
 *   → LLM#2 综合产出最终视频提示词
 * 参考来源：https://shot.cafe（免费电影截图库，/server.php?z=tags 标签联想 + /tag/<tag> 镜头页）
 * 任何环节失败都返回 null，调用方回退到模板提示词，绝不影响主流程。
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { aiFetch } from './ai-client.js'
import { getActiveTextConfig } from './grid-narrative-pipeline.js'
import { vlmChatWithImages } from './grid-review.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTCAFE = 'https://shot.cafe'

export interface ShotDesign {
  concept: string // 画面构思
  emotion: string // 要传递的情绪与载体
  colorPalette: string // 色彩搭配
  lighting: string // 光线设计
  cameraMove: string // 运镜设计
  searchQuery: string // Shot.Cafe 英文检索词
}

export interface DesignedShot {
  prompt: string
  design: ShotDesign
  refs: Array<{ url: string; alt: string; analysis?: string }>
}

async function httpGet(url: string): Promise<string> {
  const res = await aiFetch('shotcafe', url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  }).catch(() => null as any)
  if (!res || !res.ok) return ''
  return res.text()
}

/** Shot.Cafe：英文关键词 → 最相关标签 → 标签页原始剧照（专业导演构图参考）。
 *  多词查询无结果时逐级截短重试（battlefield aftermath smoke → battlefield aftermath → battlefield） */
export async function searchShotCafeStills(query: string, limit = 3): Promise<Array<{ url: string; alt: string }>> {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const candidates: string[] = []
  for (let n = words.length; n >= 1; n--) candidates.push(words.slice(0, n).join(' '))

  for (const q of candidates) {
    const tagsRaw = await httpGet(`${SHOTCAFE}/server.php?z=tags&q=${encodeURIComponent(q)}`)
    let tags: Array<{ tag_name: string; score: string }> = []
    try {
      const obj = JSON.parse(tagsRaw || '[]')
      tags = Object.values(obj).map((v: any) => ({ tag_name: String(v.tag_name || ''), score: String(v.score || '0') }))
    } catch {
      /* fallthrough */
    }
    if (!tags.length) tags = [{ tag_name: q.toLowerCase(), score: '0' }]
    tags.sort((a, b) => Number(b.score) - Number(a.score))

    for (const tag of tags.slice(0, 3)) {
      const slug = tag.tag_name.replace(/\s+/g, '+').toLowerCase()
      const html = await httpGet(`${SHOTCAFE}/tag/${slug}`)
      if (!html) continue
      const stills: Array<{ url: string; alt: string }> = []
      const imgRe = /\/images\/o\/([a-z0-9\-]+\.(?:jpg|jpeg|png))"/gi
      const altRe = /alt="(Still from [^"]*)"/gi
      const alts: string[] = []
      let m: RegExpExecArray | null
      while ((m = altRe.exec(html))) alts.push(m[1])
      let i = 0
      while ((m = imgRe.exec(html)) && stills.length < limit) {
        stills.push({ url: `${SHOTCAFE}/images/o/${m[1]}`, alt: alts[i] || '' })
        i++
      }
      if (stills.length) return stills.slice(0, limit)
    }
  }
  return []
}

function extractJson(text: string): any | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

async function textLlmJson(systemPrompt: string, userPrompt: string, temperature = 0.7): Promise<any | null> {
  const llm = getActiveTextConfig()
  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    response_format: { type: 'json_object' },
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await aiFetch(llm.provider, `${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(attempt === 1 ? body : { ...body, response_format: undefined }),
    }).catch(() => null as any)
    if (!res || !res.ok) return null
    const json = await res.json().catch(() => null)
    const content = String(json?.choices?.[0]?.message?.content || '')
    const parsed = extractJson(content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim())
    if (parsed) return parsed
  }
  return null
}

const DESIGN_PROMPT = `你是历史纪录片的镜头导演。为一个视频镜头做画面设计，输出严格 JSON：
{
 "concept": "画面构思：主体是谁/什么，前中后景分别是什么，观众视线怎么被引导",
 "emotion": "要传递的情绪，以及通过什么画面元素传递（色彩/光线/主体姿态/环境细节）",
 "colorPalette": "色彩搭配方案（主色+点缀色+明暗基调）",
 "lighting": "光线设计（光源方向、质感、时间感）",
 "cameraMove": "运镜设计（一种主运镜+速度感，如缓慢推进/横移揭示/升镜拉远）",
 "searchQuery": "1-3个英文单词，用于在电影截图库检索同类构图参考（如 battlefield aftermath / war room / candlelit portrait）"
}
要求：构图要具体（拒绝"大气""震撼"这类空话），每个字段一句话。
时代自洽是硬约束：道具、服饰、建筑、兵器必须符合剧集所处年代，禁止出现任何该年代不存在的物品（如近代以前的场景里出现弹壳、玻璃器皿、现代家具）。`

const FINAL_PROMPT_SYS = `你是 AI 视频生成提示词专家。把镜头导演的画面设计和专业电影截图的构图分析，综合成一段视频生成提示词。
要求：
- 中文描述画面内容，电影术语保留英文（如 low angle, shallow depth of field, golden hour）
- 必须包含：主体与动作、构图（景别/机位/前后景关系）、色彩基调、光线、缓慢电影感运镜
- 画面绝对不要出现任何文字、字幕、水印
- 输出严格 JSON：{"prompt": "一段连贯的提示词，200字以内"}`

/** 为视频镜头做完整画面设计；失败返回 null（调用方回退模板提示词） */
export async function designVideoShot(input: {
  theme: string
  narration: string
  cellDescriptions: string[]
  dramaTitle: string
}): Promise<DesignedShot | null> {
  try {
    // 1) LLM#1 画面构思
    const design = (await textLlmJson(
      DESIGN_PROMPT,
      `剧集：《${input.dramaTitle}》\n镜头主题：${input.theme}\n旁白：${input.narration.slice(0, 200)}\n画面要点：${input.cellDescriptions.join('；')}`,
    )) as ShotDesign | null
    if (!design?.searchQuery || !design?.concept) return null

    // 2) Shot.Cafe 找专业构图参考
    const refs = await searchShotCafeStills(design.searchQuery, 3)

    // 3) VLM 分析参考图构图（下载前两张）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotrefs-'))
    const localRefs: string[] = []
    for (const ref of refs.slice(0, 2)) {
      try {
        const res = await aiFetch('shotcafe', ref.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        if (!res.ok) continue
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 10_000) continue
        const p = path.join(tmpDir, `ref-${localRefs.length}.jpg`)
        fs.writeFileSync(p, buf)
        localRefs.push(p)
      } catch {
        /* skip */
      }
    }
    let refAnalysis = ''
    if (localRefs.length) {
      refAnalysis =
        (await vlmChatWithImages(
          '你是电影摄影分析员。分析这些电影截图的构图手法，供 AI 视频生成参考。',
          `请用中文简洁分析每张图：①景别与机位角度 ②主体位置与前后景层次 ③色彩基调与光线方向 ④情绪氛围。每张图3-4句话。`,
          localRefs,
          500,
        )) || ''
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })

    // 4) LLM#2 综合产出最终视频提示词
    const finalJson = await textLlmJson(
      FINAL_PROMPT_SYS,
      `镜头主题：${input.theme}\n旁白：${input.narration.slice(0, 150)}\n\n画面设计：\n构思：${design.concept}\n情绪：${design.emotion}\n色彩：${design.colorPalette}\n光线：${design.lighting}\n运镜：${design.cameraMove}\n\n专业电影截图构图参考分析：\n${refAnalysis || '（未获取到参考图，按设计稿执行）'}`,
      0.5,
    )
    const prompt = String(finalJson?.prompt || '').trim()
    if (!prompt) return null

    return {
      prompt: `${prompt}。画面中不要出现任何文字、字幕、水印`,
      design,
      refs: refs.map((r, i) => ({ ...r, ...(i === 0 && refAnalysis ? { analysis: refAnalysis } : {}) })),
    }
  } catch {
    return null
  }
}
