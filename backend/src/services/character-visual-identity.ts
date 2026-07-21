const SCENE_STATE_PATTERN = /(?:躺在|躺于|站在|站于|立于|坐在|坐于|跪|行走|走向|走在|奔跑|骑乘|驾驶|手中|双手|拿着|握着|主持|表演|身处|位于|棺材|棺木|墓穴|病床|桌前|门口|窗前|正在|此刻|当前|嘴角|表情|神情|目光|看向|凝视|哭泣|哭喊|微笑|大笑)/u

/** Keep stable identity/costume cues while removing one-shot blocking and emotion. */
export function sanitizeCharacterVisualIdentity(appearance: string | null | undefined): string {
  const source = String(appearance || '').trim()
  if (!source) return ''
  return source
    .split(/(?<=[，,。；;！？!?])/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !SCENE_STATE_PATTERN.test(part))
    .join('')
    .replace(/[，,；;]+$/u, '')
    .trim()
}
