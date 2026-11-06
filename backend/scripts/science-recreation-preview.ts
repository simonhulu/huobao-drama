import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { recreateScienceScript, type SciencePlan } from '../src/services/science-script.js'
import { callTextModel } from '../src/services/ai.js'
import { callScienceWritingModel } from '../src/services/science-writing-model.js'

const id = process.argv[2]
if (!id || !/^science-[a-f0-9-]{36}$/.test(id)) throw Error('Usage: science-recreation-preview.ts <science-job-id> [saved-plan.json] [draft-checkpoint.json]')
const savedPlan = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) as SciencePlan : undefined
const savedDraft = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) as { title: string; script: string } : undefined
const root = fileURLToPath(new URL('../../', import.meta.url))
const sourcePath = path.join(root, 'data/science-pop/jobs', id, 'job.json')
if (!fs.existsSync(sourcePath)) throw Error(`科普任务不存在：${id}`)
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as { id: string; title: string; sourceUrl: string; sourceTitle?: string; transcript: string; script?: string }
if (!source.transcript?.trim()) throw Error('任务没有可用的原视频转写')
const directory = path.join(root, 'data/static/science-recreation-study', `${id}-${Date.now()}`)
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(directory, 'source.txt'), source.transcript)
fs.writeFileSync(path.join(directory, 'previous.txt'), source.script || '')
function saveReadingOutline(value: SciencePlan) {
  const evidence = new Map(value.evidence?.map(item => [item.id, item.material]))
  const materials = new Map(value.tellingMaterials?.map(item => [item.id, item.detail]))
  const emotions = new Map(value.emotionalArc?.map(item => [item.id, `${item.from} → ${item.to}`]))
  const quotes = (ids: string[]) => ids.map(id => `> ${evidence.get(id)}`).join('\n\n')
  const content = [
    `# 原文理解与正式大纲：${source.sourceTitle || source.title}`,
    '这是本次模型在写正文之前实际提交并保存的分析记录。原文摘录已核对确实出自转写稿；这不等于外部科学事实核验。',
    `## 原文主题\n\n${value.sourceTheme}`,
    `## 原文立场与表达欲\n\n${value.authorStance}`,
    `## 情绪弧线\n\n${value.emotionalArc?.map((item, i) => `${i + 1}. **${item.from} → ${item.to}**：${item.trigger}\n\n${quotes(item.evidenceIds)}`).join('\n\n')}`,
    `## 材料与讲述作用\n\n${value.tellingMaterials?.map(item => `### ${item.disposition === 'retain' ? '保留' : '省略'}：${item.detail}\n\n讲述作用：${item.role}\n\n取舍理由：${item.reason}\n\n${quotes(item.evidenceIds)}`).join('\n\n')}`,
    `## 正式写作大纲\n\n主线：${value.writingOutline?.thesis}\n\n讲述立场：${value.writingOutline?.stance}`,
    ...value.writingOutline?.sections.map((section, i) => [
      `### ${i + 1}. ${section.purpose}`, section.newInformation,
      `先让观众看见：${section.telling.sceneOrAction}`, `再解释：${section.telling.explanation}`,
      `使用材料：${section.telling.materialIds.map(id => materials.get(id)).join('；')}`,
      `情绪承接：${section.telling.emotionIds.map(id => emotions.get(id)).join('；')}`,
      `接到下一步：${section.telling.nextQuestion}`,
    ].join('\n\n')) || [],
    `### 结尾兑现\n\n${value.writingOutline?.endingPayoff}`,
    `## 留在分析端的事实疑点\n\n${value.factChecks.map(item => `- ${item.claim}：${item.note}`).join('\n') || '本次分析未列出额外疑点。'}`,
    '## 对照文件\n\n[原稿](source.txt) · [旧二创稿](previous.txt) · [新对照稿](new-script.md) · [完整结构化分析](plan.json)',
  ].join('\n\n')
  fs.writeFileSync(path.join(directory, 'reading-and-outline.md'), `${content}\n`)
}
let plan: SciencePlan | undefined
let requestNumber = 0
try {
  const result = await recreateScienceScript({ transcript: source.transcript, title: source.sourceTitle || source.title, sourceUrl: source.sourceUrl, plan: savedPlan }, {
    signal: AbortSignal.timeout(600_000),
    draft: savedDraft,
    onDraft: draft => fs.writeFileSync(path.join(directory, 'draft-checkpoint.json'), JSON.stringify(draft, null, 2)),
    call: async (messages, options) => {
      const response = await callTextModel(messages, options)
      fs.writeFileSync(path.join(directory, `tool-response-${++requestNumber}.json`), response)
      return response
    },
    write: async (messages, options) => {
      const response = await callScienceWritingModel(messages, options)
      fs.writeFileSync(path.join(directory, `writing-response-${++requestNumber}.json`), response)
      return response
    },
    review: async (messages, options) => {
      const response = await callTextModel(messages, options)
      fs.writeFileSync(path.join(directory, `review-response-${++requestNumber}.json`), response)
      return response
    },
    onPlan(value) { plan = value; fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(value, null, 2)); saveReadingOutline(value); console.log(JSON.stringify({ phase: 'plan_saved', directory, sourceTheme: value.sourceTheme, emotionalBeats: value.emotionalArc?.length, materials: value.tellingMaterials?.length })) },
  })
  plan = result.plan
  fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2))
  saveReadingOutline(plan)
  fs.writeFileSync(path.join(directory, 'new-script.txt'), result.script)
  fs.writeFileSync(path.join(directory, 'new-script.md'), `# ${result.title}\n\n${result.script}\n`)
  const report = {
    sourceId: id, title: result.title, originalTitle: source.sourceTitle || source.title, writingVersion: result.plan.writingVersion, model: result.plan.model, writingModel: result.plan.writingModel, sourceCharacters: source.transcript.length,
    previousCharacters: source.script?.length || 0, newCharacters: result.script.length,
    mechanisms: result.plan.mechanisms?.length || 0, evidence: result.plan.evidence?.length || 0,
    curiosityArc: result.plan.curiosityArc?.length || 0, emotionalBeats: result.plan.emotionalArc?.length || 0, tellingMaterials: result.plan.tellingMaterials?.filter(item => item.disposition === 'retain').length || 0, outlineSections: result.plan.writingOutline?.sections.length || 0,
    sourceSha256: createHash('sha256').update(source.transcript).digest('hex'), productionTriggered: false,
    qualityReview: 'source_comparison_passed_requires_editorial_reading', savedJobUnchanged: true,
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ directory, model: result.plan.model, writingModel: result.plan.writingModel, characters: result.script.length, planSaved: Boolean(plan) }, null, 2))
} catch (error) {
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), hasPlan: Boolean(plan), productionTriggered: false }, null, 2))
  console.error(JSON.stringify({ directory, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
