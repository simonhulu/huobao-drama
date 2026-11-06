export function historyYoutubeBinary() { return process.env.HISTORY_YOUTUBE_YTDLP_BIN?.trim() || 'yt-dlp' }

export function historyYoutubeNetworkArgs() {
  const proxy = process.env.HISTORY_YOUTUBE_PROXY?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim()
  const cookies = process.env.HISTORY_YOUTUBE_COOKIES_FILE?.trim()
  const cookiesBrowser = process.env.HISTORY_YOUTUBE_COOKIES_BROWSER?.trim()
  if (cookiesBrowser && !/^(?:chrome|chromium|edge|brave|firefox|opera|safari|vivaldi|whale)(?::[^\r\n]+)?$/.test(cookiesBrowser)) {
    throw new Error('HISTORY_YOUTUBE_COOKIES_BROWSER 需要受支持的浏览器名称，可选附带 :profile')
  }
  if (proxy) {
    let parsed: URL
    try { parsed = new URL(proxy) } catch { throw new Error('HISTORY_YOUTUBE_PROXY 代理地址无效') }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new Error('YouTube 代理需要 HTTP、HTTPS 或 SOCKS5 地址')
  }
  return ['--ignore-config', '--no-warnings', '--socket-timeout', '25', '--retries', '2', '--extractor-retries', '2',
    '--js-runtimes', `node:${process.execPath}`, ...(proxy ? ['--proxy', proxy] : []),
    ...(cookies ? ['--cookies', cookies] : cookiesBrowser ? ['--cookies-from-browser', cookiesBrowser] : [])]
}
