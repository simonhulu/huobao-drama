import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { ScienceWorkflowService } from '../src/services/science-workflow.js'
import { recreateScienceScript, scienceNarrationLength, stripScienceNarrationIntroduction, SCIENCE_WRITING_VERSION, type SciencePlan } from '../src/services/science-script.js'
import { callTextModel } from '../src/services/ai.js'
import { callScienceWritingModel } from '../src/services/science-writing-model.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const jobsRoot = path.join(root, 'data/science-pop/jobs')
const readJob = (id: string) => JSON.parse(fs.readFileSync(path.join(jobsRoot, id, 'job.json'), 'utf8'))
const eligible = (job: ReturnType<typeof readJob>) => !job.deletedAt && !job.productionScriptHash && !job.productionCompleted
  && !job.projectUrl && !job.checkpoint && !job.videoPath && !job.uploadAttempt && !job.upload && !job.automaticDelivery
  && ['review', 'queued', 'draft', 'paused', 'needs_attention'].includes(job.status) && !job.ownerPid && !job.automaticProduction && Boolean(job.transcript?.trim())
const resumeDirectory = process.argv[2] === '--resume' ? path.resolve(process.argv[3] || '.') : undefined
const savedRun = resumeDirectory ? JSON.parse(fs.readFileSync(path.join(resumeDirectory, 'report.json'), 'utf8')) : undefined
if (savedRun && savedRun.writingVersion !== SCIENCE_WRITING_VERSION)
  throw Error('旧版对照不能作为新版缩写继续，请用任务 ID 启动新的对照，旧记录已保留')
const ids: string[] = savedRun ? savedRun.records.map((item: { id: string }) => item.id) : process.argv.slice(2)
for (const id of ids) if (!/^science-[a-f0-9-]{36}$/.test(id)) throw Error(`无效任务编号：${id}`)
const selected = (ids.length ? ids : fs.readdirSync(jobsRoot).filter(id => /^science-[a-f0-9-]{36}$/.test(id)))
  .map(readJob).filter(eligible)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
if (!selected.length) throw Error('没有具备原稿且尚未进入制作的任务')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const directory = resumeDirectory || path.join(root, 'data/static/science-recreation-study', `pending-${stamp}`)
fs.mkdirSync(directory, { recursive: true })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const records: Array<{ id: string; oldTitle: string; title: string; sourceCharacters: number; previousCharacters: number;
  characters: number; status: string; error: string; sourceHash: string; previousHash: string; revisionInstruction?: string }> = savedRun?.records || selected.map(job => ({ id: job.id as string, oldTitle: job.title as string, title: job.title as string,
  sourceCharacters: job.transcript.length as number, previousCharacters: job.script.length as number,
  characters: 0, status: 'queued', error: '', sourceHash: digest(job.transcript), previousHash: digest(job.script) }))
for (const record of records) {
  const job = readJob(record.id), itemDir = path.join(directory, record.id)
  if (digest(job.transcript) !== record.sourceHash) throw Error(`原稿已改变，不能恢复对照：${record.id}`)
  fs.mkdirSync(itemDir, { recursive: true })
  if (!fs.existsSync(path.join(itemDir, 'source.txt'))) fs.writeFileSync(path.join(itemDir, 'source.txt'), job.transcript)
  if (!fs.existsSync(path.join(itemDir, 'previous.txt'))) {
    let previous = job.script
    if (digest(previous) !== record.previousHash) {
      const revisions = path.join(jobsRoot, record.id, 'revisions')
      const backup = fs.existsSync(revisions) ? fs.readdirSync(revisions).sort().flatMap(name => {
        const file = path.join(revisions, name, 'job-before.json')
        return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, 'utf8'))] : []
      }).find(value => digest(value.script) === record.previousHash && digest(value.transcript) === record.sourceHash) : undefined
      if (!backup) throw Error(`未找到原始旧稿备份：${record.id}`)
      previous = backup.script
    }
    fs.writeFileSync(path.join(itemDir, 'previous.txt'), previous)
  }
}
const save = () => {
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ writingVersion: SCIENCE_WRITING_VERSION,
    productionTriggered: false, directory, records }, null, 2))
  fs.writeFileSync(path.join(directory, 'index.md'), [
    '# 新版冷知识二创稿',
    '沿原文情绪弧线和故事推进缩写，保留完整论证，目标约1000至1500字。本轮只更新文稿，没有触发视频制作或发表。',
    '[集中阅读全部新稿](manuscripts.md)',
    '| 任务 | 进度 | 原稿/旧稿/新稿字数 | 对照 |', '| --- | --- | --- | --- |',
    ...records.map(item => `| ${item.title.replace(/\|/g, ' ')} | ${({ queued: '排队中', running: '生成中', completed: '已完成', failed: '需重试' } as Record<string, string>)[item.status]} | ${item.sourceCharacters}/${item.previousCharacters}/${item.characters || '-'} | [新稿](${item.id}/new-script.md) · [原稿](${item.id}/source.txt) · [旧稿](${item.id}/previous.txt) · [讲法分析](${item.id}/reading.md) |`),
  ].join('\n'))
  fs.writeFileSync(path.join(directory, 'manuscripts.md'), ['# 全部新版二创文稿', ...records.filter(item => item.status === 'completed')
    .map(item => `## ${item.title}\n\n任务：${item.id}\n\n${fs.readFileSync(path.join(directory, item.id, 'new-script.txt'), 'utf8')}`)].join('\n\n'))
}
function saveReading(id: string, plan: SciencePlan) {
  const content = [`# 原稿讲法分析`,
    ...Object.entries(plan.sourceTelling || {}).map(([key, value]) => `${({ knowledge: '讲什么知识', form: '讲述形式', openingDevice: '开头抓人方法', whyEngaging: '为什么愿意听', voiceAndHumor: '声音与幽默', endingPayoff: '结尾兑现' } as Record<string, string>)[key]}：${value}`),
    ...(plan.narrativeBeats || []).map((beat, index) => [
      `## ${index + 1}. ${beat.tellingMethod}`, beat.content,
      `观众原先想知道：${beat.questionBefore}`, `此处揭晓：${beat.reveal}`, `留到后面：${beat.questionAfter}`,
      ...(beat.humorOrImage ? [`幽默或画面：${beat.humorOrImage}`] : []),
    ].join('\n\n')),
  ].join('\n\n')
  fs.writeFileSync(path.join(directory, id, 'reading.md'), `${content}\n`)
  fs.writeFileSync(path.join(directory, id, 'plan.json'), JSON.stringify(plan, null, 2))
}
save()
console.log(JSON.stringify({ event: 'selected', directory, total: records.length, ids: records.map(item => item.id) }))
let next = 0
async function worker() {
  while (next < records.length) {
    const record = records[next++]!
    const itemDir = path.join(directory, record.id)
    let service: ScienceWorkflowService | undefined
    try {
      const original = readJob(record.id)
      const savedScriptFile = path.join(itemDir, 'new-script.txt')
      const priorDraft = resumeDirectory && fs.existsSync(savedScriptFile) ? fs.readFileSync(savedScriptFile, 'utf8') : undefined
      const narration = stripScienceNarrationIntroduction(original.script)
      const cleanNarration = Boolean(narration) && narration === original.script.trim()
        && !/(?:原稿|原作者|来源视频|分析大纲|写作大纲|narrativeBeats|sourcePassages)|原文(?:提到|举过|说|认为|引用)/.test(original.script)
        && original.script.replace(/\s/g, '').length >= scienceNarrationLength(original.transcript).minimum
      if (resumeDirectory && record.status === 'completed' && priorDraft === original.script && cleanNarration
        && original.plan?.writingVersion === SCIENCE_WRITING_VERSION && original.plan?.writingModel && !record.revisionInstruction) continue
      const expectedScriptHash = priorDraft === undefined ? record.previousHash : digest(priorDraft)
      if (!eligible(original) || digest(original.transcript) !== record.sourceHash || digest(original.script) !== expectedScriptHash)
        throw Error('任务已变化或已进入制作，跳过本轮改稿')
      const backupDir = path.join(jobsRoot, record.id, 'revisions', `${SCIENCE_WRITING_VERSION}-${stamp}`)
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(backupDir, 'job-before.json'), JSON.stringify(original, null, 2), { mode: 0o600 })
      fs.mkdirSync(itemDir, { recursive: true })
      if (!resumeDirectory) {
        fs.writeFileSync(path.join(itemDir, 'source.txt'), original.transcript)
        fs.writeFileSync(path.join(itemDir, 'previous.txt'), original.script)
      }
      const previousFailure = record.error
      record.status = 'running'; record.error = ''; save()
      service = new ScienceWorkflowService({ rewrite: async (input, options) => recreateScienceScript(input, {
        ...options,
        review: callTextModel,
        ...(priorDraft || previousFailure.startsWith('讲述节点') ? { call: async (messages: Parameters<typeof callTextModel>[0], callOptions: Parameters<typeof callTextModel>[1]) => {
          const instruction = JSON.parse(messages[1]!.content)
          if ('referenceScript' in instruction) {
            instruction.correctionInstruction = [instruction.correctionInstruction,
              `上一轮分析未通过引用核验：${previousFailure}。重新核对每个讲述节点的证据引用。被省略的材料不能仍在讲述节点中使用；若只需修正限定而故事可以保留，应保留并准确讲述，不能一边省略一边引用。`,
            ].filter(Boolean).join('\n')
          }
          return callTextModel([messages[0]!, { ...messages[1]!, content: JSON.stringify(instruction) }], callOptions)
        }, write: async (messages: Parameters<typeof callTextModel>[0], callOptions: Parameters<typeof callTextModel>[1]) => {
            const instruction = JSON.parse(messages[1]!.content)
            if (priorDraft) instruction.previousDraft ||= { title: original.title, script: priorDraft }
            instruction.revisionInstruction = [instruction.revisionInstruction,
              '沿原文的情绪弧线和故事推进缩写，保留完整论证、关键转折和代表性细节，目标约1000至1500字，不强行凑字数。表达自然通顺，去掉“原稿提到、原文举过、原作者”等改稿说明；需要交代实验时自然说研究人员。',
              record.revisionInstruction,
            ].filter(Boolean).join('\n')
          return callScienceWritingModel([messages[0]!, { ...messages[1]!, content: JSON.stringify(instruction) }], callOptions)
        } } : {}),
        onPlan: plan => {
          options.onPlan?.(plan); saveReading(record.id, plan)
          console.log(JSON.stringify({ event: 'plan_saved', id: record.id, beats: plan.narrativeBeats?.length }))
        },
      }) })
      console.log(JSON.stringify({ event: 'started', id: record.id, title: record.title }))
      if (service.detail(record.id).status === 'queued') service.cancel(record.id)
      service.prepare(record.id)
      await service.waitForIdle()
      const job = service.detail(record.id)
      if (job.status !== 'draft' || job.plan?.writingVersion !== SCIENCE_WRITING_VERSION) throw Error(job.message)
      const stored = readJob(record.id)
      if (stored.productionScriptHash || stored.projectUrl || stored.checkpoint || stored.videoPath || stored.uploadAttempt)
        throw Error('任务已有制作检查点，请核对当前任务')
      fs.writeFileSync(path.join(itemDir, 'new-script.txt'), job.script)
      fs.writeFileSync(path.join(itemDir, 'new-script.md'), `# ${job.title}\n\n${job.script}\n`)
      saveReading(record.id, job.plan)
      record.title = job.title; record.characters = job.script.length; record.status = 'completed'
      delete record.revisionInstruction
      console.log(JSON.stringify({ event: 'completed', id: record.id, characters: job.script.length }))
    } catch (error) {
      record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error)
      console.error(JSON.stringify({ event: 'failed', id: record.id, error: record.error }))
    } finally { await service?.stop(); save() }
  }
}
await Promise.all([worker(), worker(), worker()])
console.log(JSON.stringify({ directory, completed: records.filter(item => item.status === 'completed').length,
  failed: records.filter(item => item.status === 'failed').length, productionTriggered: false }))
if (records.some(item => item.status === 'failed')) process.exitCode = 1
