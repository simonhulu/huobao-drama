import { createHash } from 'node:crypto'

export type HistoryArtifactState = 'missing' | 'stale' | 'current'
export interface HistoryArtifactSource {
  platform: string
  sourceVideoId: string
  sourceUrl: string
  rawTranscript: string | null
  correctedTranscript: string | null
  rewrittenScript: string | null
  mediaJson: string
  asrJson: string | null
  reviewJson: string | null
}

const textSha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function getHistorySourceArtifactState(source: HistoryArtifactSource): {
  transcript: HistoryArtifactState
  corrected: HistoryArtifactState
  rewritten: HistoryArtifactState
} {
  const state = {
    transcript: source.rawTranscript?.trim() ? 'stale' : 'missing',
    corrected: source.correctedTranscript?.trim() ? 'stale' : 'missing',
    rewritten: source.rewrittenScript?.trim() ? 'stale' : 'missing',
  } as { transcript: HistoryArtifactState; corrected: HistoryArtifactState; rewritten: HistoryArtifactState }
  try {
    const media = JSON.parse(source.mediaJson)
    const asr = JSON.parse(source.asrJson ?? 'null')
    const review = JSON.parse(source.reviewJson ?? 'null')
    if (source.platform === 'baijiahao' && source.rawTranscript?.trim() && media?.kind === 'article'
      && /^\d+$/.test(source.sourceVideoId)
      && source.sourceUrl === `https://baijiahao.baidu.com/s?id=${source.sourceVideoId}`
      && media.articleId === source.sourceVideoId && media.sourceUrl === source.sourceUrl
      && media.textSha256 === textSha256(source.rawTranscript)) {
      state.transcript = 'current'
    }
    if (source.platform === 'douyin' && source.rawTranscript?.trim() && media?.kind === 'note'
      && source.sourceUrl === `https://www.douyin.com/note/${source.sourceVideoId}`
      && media.noteId === source.sourceVideoId && media.sourceUrl === source.sourceUrl
      && media.textSha256 === textSha256(source.rawTranscript)
      && Array.isArray(media.images) && media.images.length > 0
      && media.images.every((image: { sha256?: string }) => typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/.test(image.sha256))) {
      state.transcript = 'current'
    }
    const matchingAudio = Array.isArray(media?.chunks) && Array.isArray(asr?.chunks) && media.chunks.length > 0
      && media.chunks.length === asr.chunks.length
      && media.chunks.every((chunk: { start: number; duration: number; sha256: string }, index: number) => {
        const cached = asr.chunks[index]
        return cached?.index === index && cached.start === chunk.start && cached.duration === chunk.duration
          && typeof chunk.sha256 === 'string' && cached.audioSha256 === chunk.sha256
      })
    if (source.rawTranscript?.trim() && asr?.complete === true && asr.text === source.rawTranscript
      && typeof media?.videoSha256 === 'string' && /^[a-f0-9]{64}$/.test(media.videoSha256)
      && asr.sourceVideoSha256 === media.videoSha256 && matchingAudio) {
      state.transcript = 'current'
    }
    if (state.transcript === 'current' && source.correctedTranscript?.trim() && review?.factCheckStatus === 'needs_sources'
      && review.rawTranscriptSha256 === textSha256(source.rawTranscript!)
      && review.correctedTranscriptSha256 === textSha256(source.correctedTranscript)) {
      state.corrected = 'current'
    }
    if (state.corrected === 'current' && source.rewrittenScript?.trim()
      && review.rewriteInputSha256 === textSha256(source.correctedTranscript!)) {
      state.rewritten = 'current'
    }
  } catch { /* Invalid checkpoints cannot establish current provenance. */ }
  return state
}
