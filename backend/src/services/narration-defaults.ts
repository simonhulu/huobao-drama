/** 默认历史旁白音色，使用用户指定的 MiniMax 音色。 */
export const DEFAULT_NARRATION_VOICE_ID = 'ttv-voice-2026072016135626-xnywYYL4'
export const DEFAULT_NARRATION_VOICE_NAME = '北方紧弦说书男声'
export const DEFAULT_NARRATION_SPEED = 1.2
export const DEFAULT_DHARMA_NARRATION_SPEED = 0.85

export function defaultNarrationSpeedForGenre(genre?: string | null): number {
  return genre === 'dharma' ? DEFAULT_DHARMA_NARRATION_SPEED : DEFAULT_NARRATION_SPEED
}
