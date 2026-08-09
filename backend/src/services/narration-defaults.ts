/** 默认历史旁白音色，来自用户提供参考音频的 MiniMax Voice Clone。 */
export const DEFAULT_NARRATION_VOICE_ID = 'voice-clone-aug7-1786117023178'
export const DEFAULT_NARRATION_VOICE_NAME = '史蒂夫参考音色·沉稳有力说书男声'
export const DEFAULT_NARRATION_SPEED = 1.2
export const DEFAULT_DHARMA_NARRATION_SPEED = 0.85

export function defaultNarrationSpeedForGenre(genre?: string | null): number {
  return genre === 'dharma' ? DEFAULT_DHARMA_NARRATION_SPEED : DEFAULT_NARRATION_SPEED
}
