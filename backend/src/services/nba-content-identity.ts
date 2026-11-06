import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import type { NbaArticle, NbaJob } from './nba-types.js'

type FootageInput = Pick<Partial<NbaJob>, 'game' | 'media'> & { article: NbaArticle }

export function nbaSourceVideoId(input: FootageInput) {
  for (const url of [input.article.youtubeUrl, input.article.topic?.youtubeUrl]) {
    if (!url) continue
    try { const parsed = parseHistoryYoutubeUrl(url); if (parsed.kind === 'video') return parsed.videoId } catch { /* Continue to saved metadata. */ }
  }
  for (const id of [input.article.topic?.videoId, input.article.sourceVideoId]) if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id
  if (input.media?.sourceUrl) {
    try { const parsed = parseHistoryYoutubeUrl(input.media.sourceUrl); if (parsed.kind === 'video') return parsed.videoId } catch { /* Unknown source. */ }
  }
  return undefined
}

/** Different interviews remain distinct even when they belong to the same game. */
export function sameNbaFootage(first: FootageInput, second: FootageInput) {
  const firstId = nbaSourceVideoId(first), secondId = nbaSourceVideoId(second)
  if (firstId && secondId) return firstId === secondId
  if (first.article.topic || second.article.topic) return false
  const firstGame = first.game || first.article.game, secondGame = second.game || second.article.game
  return Boolean(firstGame?.verified && secondGame?.verified && firstGame.id === secondGame.id)
}
