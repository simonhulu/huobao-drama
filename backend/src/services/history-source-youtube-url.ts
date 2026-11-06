import { z } from 'zod'

const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/)
export const DEFAULT_HISTORY_YOUTUBE_URL = 'https://www.youtube.com/@助眠睡前歷史故事/videos'
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'])

/** Accept only explicit YouTube videos or channels, never arbitrary extractor URLs or searches. */
export function parseHistoryYoutubeUrl(value: string): { kind: 'video' | 'channel'; url: string; videoId?: string } {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('YouTube 链接不能包含控制字符')
  let input: URL
  try { input = new URL(value.trim()) } catch { throw new Error('请输入有效的 YouTube 频道或视频链接') }
  if (input.protocol !== 'https:' || !youtubeHosts.has(input.hostname) || input.username || input.password || input.port) {
    throw new Error('仅支持 HTTPS 的 YouTube 频道或视频链接')
  }
  let pathname: string
  try { pathname = decodeURIComponent(input.pathname).replace(/\/+$/, '') } catch { throw new Error('YouTube 链接编码无效') }
  const videoId = input.hostname.endsWith('youtu.be') ? pathname.slice(1)
    : pathname === '/watch' ? input.searchParams.get('v')
      : /^\/(?:shorts|live)\//.test(pathname) ? pathname.split('/')[2] : null
  if (videoId !== null) {
    if (!videoIdSchema.safeParse(videoId).success || (/^\/(?:shorts|live)\//.test(pathname) && pathname.split('/').length !== 3)) {
      throw new Error('YouTube 视频 ID 无效')
    }
    return { kind: 'video', videoId, url: `https://www.youtube.com/watch?v=${videoId}` }
  }
  const channel = pathname.match(/^(\/@[^/\s?#]+|\/channel\/UC[A-Za-z0-9_-]{22}|\/(?:c|user)\/[^/\s?#]+)(?:\/videos)?$/)?.[1]
  if (!channel) throw new Error('请使用 YouTube 频道主页、频道 videos 页或单条视频链接')
  return { kind: 'channel', url: new URL(`${channel}/videos`, 'https://www.youtube.com').href }
}

