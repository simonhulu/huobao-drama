import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ArticleScreenshot } from './history-script-article-renderer.js'

const preparationScript = fileURLToPath(new URL('../../scripts/social-auto-upload/article_cover_selection.py', import.meta.url))
const PREPARATION_TIMEOUT_MS = 20_000
const manifestSchema = z.object({
  version: z.literal(1),
  images: z.array(z.object({
    url: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    quality: z.record(z.string(), z.number()),
  })).length(2),
})
export type PreparedHistoryArticleImages = z.infer<typeof manifestSchema>

/** Prepare reusable body-cover choices locally, before the article is completed.
 * No uploader, browser, main cover, image rewriting or SAU installation is needed.
 */
export async function prepareHistoryArticleImages(directory: string, screenshots: ArticleScreenshot[], signal?: AbortSignal): Promise<PreparedHistoryArticleImages> {
  if (signal?.aborted) throw new Error('配图准备已取消，请重新生成文章')
  // Match the renderer's section order; original image files remain untouched.
  const images = [...screenshots].sort((a, b) => a.sectionIndex - b.sectionIndex).map(image => {
    const match = /^\/static\/history-articles\/\d+\/[a-f0-9-]+\/(frame-\d+\.jpg)$/.exec(image.url)
    if (!match) throw new Error('正文配图路径无效，请重新生成文章')
    return { url: image.url, path: path.resolve(directory, match[1]) }
  })
  const localPython = path.join(os.homedir(), '.local/share/social-auto-upload/.venv/bin/python')
  const python = process.env.SOCIAL_AUTO_UPLOAD_PYTHON || (fs.existsSync(localPython) ? localPython : 'python3')
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = childProcess.execFile(python, [preparationScript, 'prepare'], {
      timeout: PREPARATION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8', signal,
    }, (error, output, stderr) => {
      if (signal?.aborted) { reject(new Error('配图准备已取消，请重新生成文章')); return }
      if (error?.killed) { reject(new Error('配图准备超时（20 秒），请重试')); return }
      let result: { error?: unknown } | null = null
      try { result = JSON.parse(output) } catch { /* Report a concrete interpreter or protocol failure below. */ }
      if (typeof result?.error === 'string' && result.error.trim()) { reject(new Error(result.error)); return }
      if (error) {
        reject(new Error(error.code === 'ENOENT'
          ? '找不到配图处理 Python，请配置 SOCIAL_AUTO_UPLOAD_PYTHON'
          : /ModuleNotFoundError|ImportError/.test(stderr)
            ? '配图处理 Python 缺少图像依赖（cv2 / numpy），请配置已有的 SOCIAL_AUTO_UPLOAD_PYTHON 环境'
            : `配图处理程序异常退出（${error.code ?? '未知退出码'}），请检查 Python 图像处理环境`))
        return
      }
      resolve(output)
    })
    // A missing interpreter can close stdin before its spawn error is delivered.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify({ images, articleHtml: images.map(image => `<img src="${image.url}">`).join('') }))
  })
  signal?.throwIfAborted()
  let manifest: PreparedHistoryArticleImages
  try {
    manifest = manifestSchema.parse(JSON.parse(stdout))
    const persisted = manifestSchema.parse(JSON.parse(fs.readFileSync(path.join(directory, 'body-cover-selection.json'), 'utf8')))
    if (!isDeepStrictEqual(manifest, persisted)) throw new Error('Manifest mismatch')
  } catch { throw new Error('配图选择清单未正确保存，请重新生成文章') }
  if (new Set(manifest.images.map(image => image.url)).size !== 2
    || manifest.images.some(image => !images.some(candidate => candidate.url === image.url))) {
    throw new Error('配图选择清单未包含两张不同的正文图片，请重新生成文章')
  }
  return manifest
}
