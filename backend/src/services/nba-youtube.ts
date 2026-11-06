import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { historyYoutubeBinary, historyYoutubeNetworkArgs } from './history-source-youtube-options.js'
import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import type { NbaCommand } from './nba-production.js'

export type NbaYoutubeRecoveryCode = 'youtube_login_required' | 'youtube_network' | 'youtube_unavailable'
export class NbaYoutubeFailure extends Error {
  constructor(message: string, readonly recoveryCode: NbaYoutubeRecoveryCode, readonly retryable = false) {
    super(message); this.name = 'NbaYoutubeFailure'
  }
}

export interface NbaYoutubeTransportOptions {
  directory: string
  signal: AbortSignal
  run: NbaCommand
  onProgress: (message: string) => void
  refreshSession?: (sourceUrl: string, signal: AbortSignal) => Promise<void>
  networkArgs?: () => string[]
}
const loginError = (message: string) => /sign in to confirm|not a bot|login required|cookies are no longer valid|cookies.+rotated|YouTube 要求登录|已保存的 YouTube 会话未通过|无法读取浏览器的 YouTube 登录/i.test(message)
const browserError = (message: string) => /could not find .+ cookies database|failed to decrypt|cannot decrypt|could not copy.+cookies|keyring|keychain/i.test(message)
function failureDetail(error: unknown) {
  const failure = error as { stderr?: string; message?: string; code?: string }
  return [failure.code, failure.message, failure.stderr, String(error)].filter(Boolean).join('\n')
}
function classify(error: unknown): NbaYoutubeFailure {
  if (error instanceof NbaYoutubeFailure) return error
  const message = failureDetail(error)
  if (loginError(message) || browserError(message)) return new NbaYoutubeFailure('YouTube 会话刷新后仍需要登录或验证。请在 Chrome 打开该比赛视频完成验证，再点击继续制作；原稿、已保存译稿和下载进度已保留。', 'youtube_login_required')
  if (/HTTP Error 40[34]/i.test(message)) return new NbaYoutubeFailure('该比赛视频当前不可访问，已保留原任务；请检查视频页面或补充同场官方视频。', 'youtube_unavailable')
  if (/timeout|timed out|超时|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UNEXPECTED_EOF|temporary failure|connection|unable to download|HTTP Error 50[0234]|remote end closed/i.test(message)) {
    return new NbaYoutubeFailure('YouTube 下载遇到临时网络故障，正在保留断点并等待自动恢复。', 'youtube_network', true)
  }
  if (/ENOENT/.test(message)) return new NbaYoutubeFailure('YouTube 下载器无法启动，请检查已配置的 yt-dlp 安装；制作检查点已保留。', 'youtube_unavailable')
  if (/requested format|no video formats|no suitable formats/i.test(message)) return new NbaYoutubeFailure('该视频尚未提供所需的 1080p 画面与英文原声音轨，已保留检查点。', 'youtube_unavailable')
  if (/unavailable|private video|removed|not available|copyright/i.test(message)) return new NbaYoutubeFailure('该比赛视频当前不可访问，已保留原任务；请检查视频页面或补充同场官方视频。', 'youtube_unavailable')
  return new NbaYoutubeFailure('YouTube 下载未完成，已保留原任务和下载断点，请检查视频可用性后继续制作。', 'youtube_unavailable')
}

export async function createNbaYoutubeTransport(options: NbaYoutubeTransportOptions) {
  let network: string[] = [], refreshed = false, anonymous = false, cookieCopy: string | undefined
  const cleanup = async () => { if (cookieCopy) { const file = cookieCopy; cookieCopy = undefined; await fs.unlink(file).catch(() => {}) } }
  const configure = async () => {
    await cleanup()
    network = [...(options.networkArgs || historyYoutubeNetworkArgs)()]
    const index = network.indexOf('--cookies')
    if (index < 0) return
    const source = network[index + 1]
    cookieCopy = path.join(options.directory, `.cookies-${randomUUID()}.txt`)
    try {
      await fs.copyFile(source, cookieCopy); await fs.chmod(cookieCopy, 0o600)
      network[index + 1] = cookieCopy
    } catch (error) {
      await cleanup()
      if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      network.splice(index, 2)
    }
  }
  options.signal.throwIfAborted()
  await fs.mkdir(options.directory, { recursive: true })
  try { await configure() } catch (error) { await cleanup(); throw classify(error) }
  return {
    async run(operation: string[], commandOptions: Parameters<NbaCommand>[2]) {
      const args = [...operation]
      if (args.includes('--dump-single-json') && !args.includes('--flat-playlist')) args.splice(args.indexOf('--'), 0, '--ignore-no-formats-error')
      for (;;) {
        options.signal.throwIfAborted()
        try { return await options.run(historyYoutubeBinary(), [...network, '--no-playlist', '--no-progress', '--continue', ...args], commandOptions) }
        catch (error) {
          options.signal.throwIfAborted()
          const message = failureDetail(error), browser = network.indexOf('--cookies-from-browser')
          if (!anonymous && browser >= 0 && browserError(message)) {
            anonymous = true; network.splice(browser, 2)
            options.onProgress('浏览器会话暂不可读，保留代理检查该公开视频的下载权限')
            continue
          }
          if (!refreshed && (loginError(message) || browserError(message))) {
            refreshed = true
            let sourceUrl: string
            try {
              const source = parseHistoryYoutubeUrl(operation.at(-1) || '')
              if (source.kind !== 'video') throw error
              sourceUrl = source.url
            } catch { throw classify(error) }
            options.onProgress('YouTube 要求更新会话，正在刷新现有 Chrome 登录并检测本场视频下载权限')
            try {
              if (options.refreshSession) await options.refreshSession(sourceUrl, options.signal)
              else await (await import('./history-source-youtube.js')).refreshHistoryYoutubeSession(sourceUrl, { signal: options.signal })
              options.signal.throwIfAborted(); await configure()
            } catch (refreshError) {
              options.signal.throwIfAborted()
              const failure = classify(refreshError)
              if (failure.retryable) throw failure
              throw new NbaYoutubeFailure('无法自动恢复 YouTube 下载权限。请在 Chrome 打开该比赛视频完成登录或验证，再点击继续制作；已保存译稿和下载断点不会丢失。', 'youtube_login_required')
            }
            options.onProgress('YouTube 会话已刷新，继续原视频下载')
            continue
          }
          throw classify(error)
        }
      }
    },
    close: cleanup,
  }
}
