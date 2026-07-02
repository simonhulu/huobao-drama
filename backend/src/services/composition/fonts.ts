/**
 * 字体管理：优先使用本地下载的 Noto Sans SC，否则回退到系统字体。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR = path.resolve(__dirname, '../../../../data/fonts')
const NOTO_SANS_SC_URL = 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'

function systemFontPath(): string | null {
  const candidates = [
    // macOS 常见中文字体（优先，避免下载）
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
    // Linux 常见中文字体
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export async function ensureFont(): Promise<string> {
  fs.mkdirSync(FONT_DIR, { recursive: true })
  const localPath = path.join(FONT_DIR, 'NotoSansCJKsc-Regular.otf')

  if (fs.existsSync(localPath)) {
    return localPath
  }

  try {
    const res = await fetch(NOTO_SANS_SC_URL, { signal: AbortSignal.timeout(60_000) })
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(localPath, buffer)
      return localPath
    }
  } catch (err: any) {
    console.warn(`[Font] Failed to download Noto Sans SC: ${err.message}`)
  }

  const fallback = systemFontPath()
  if (fallback) return fallback

  throw new Error('No suitable font found for text overlays')
}
