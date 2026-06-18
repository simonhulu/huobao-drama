/**
 * 对白解析工具（旁白/对白 TTS 共用）
 * 一个镜头的 dialogue 可能多行、多角色，每行形如「角色：台词」。
 * 必须逐行解析，否则只剥掉首行说话人标签，后续行的人名会被 TTS 念出来。
 */

// 说话人标签为环境音/音效类 → 不配音
export const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
// 台词内容本身表示「无需配音」→ 不配音
export const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

export interface DialogueLine {
  speaker: string
  text: string
}

/** 去掉括号内的舞台提示（如「（哼唱）」「(小声)」），这些不该被念出来 */
function stripParentheticals(s: string): string {
  return s.replace(/[（(].+?[)）]/g, '').trim()
}

/** 单行是否应跳过配音 */
function isIgnorableLine(speaker: string, text: string): boolean {
  if (!text) return true
  if (speaker && IGNORE_TTS_SPEAKERS.test(speaker)) return true
  if (IGNORE_TTS_TEXT.test(text)) return true
  return false
}

/**
 * 按行解析对白，返回每行的 { speaker, text }（已去标签、去舞台提示、过滤不可配音行）。
 * 无说话人标签的续行，继承上一行的说话人。
 */
export function parseDialogueLines(dialogue?: string | null): DialogueLine[] {
  const raw = dialogue?.trim() || ''
  if (!raw) return []

  const out: DialogueLine[] = []
  let lastSpeaker = ''

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const m = line.match(/^(.+?)[:：]\s*/)
    let speaker = ''
    let text = ''
    if (m) {
      speaker = stripParentheticals(m[1])
      text = stripParentheticals(line.slice(m[0].length))
    } else {
      // 续行：无标签，继承上一说话人
      speaker = lastSpeaker
      text = stripParentheticals(line)
    }
    if (speaker) lastSpeaker = speaker

    if (isIgnorableLine(speaker, text)) continue
    out.push({ speaker, text })
  }

  return out
}

/**
 * 兼容旧接口：返回首个有效说话人 + 全部台词合并（纯文本）。
 * ignorable 表示整段无任何可配音内容。
 */
export function parseDialogueForTTS(dialogue?: string | null) {
  const lines = parseDialogueLines(dialogue)
  const speaker = lines[0]?.speaker || ''
  const pureText = lines.map(l => l.text).join(' ')
  return { speaker, pureText, ignorable: lines.length === 0, lines }
}
