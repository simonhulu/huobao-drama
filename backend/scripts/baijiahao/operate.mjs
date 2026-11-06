#!/usr/bin/env node
import { connectBrowser, getEditorPage, requireReady, loadManifest, parseArgs, readState, writeState,
  uploadVideo, recoverUploadedVideo, fillMeta, uploadCover, coverPreview, documentToken, assertBinding, verifyStaged, screenshot, emit, fail, usageError } from './lib.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--manifest', '--step', '--recover-upload'])
  const step = args.step || 'all'
  if (!['all', 'video', 'meta', 'cover'].includes(step)) throw usageError(`未知 --step: ${step}`)
  const { manifest, file } = await loadManifest(args.manifest)
  const prior = readState(file)
  if (prior?.save_attempted_at) throw new Error('此 manifest 已尝试保存草稿；先人工核对，不得创建重复草稿')
  const browser = await connectBrowser()
  let page
  try {
    page = await getEditorPage(browser)
    await requireReady(page)
    let state = prior
    if (args['recover-upload'] && !prior) {
      state = await recoverUploadedVideo(page, manifest)
      writeState(file, state)
    }
    if (step === 'all' || step === 'video') {
      const video = await uploadVideo(page, manifest, state)
      state = video.status === 'already_uploaded' ? state : {
        session: manifest.session, video_fingerprint: manifest.video_fingerprint,
        target_id: page.target()._targetId, document_token: await documentToken(page),
        media_src: video.media_src, steps: { video },
      }
      writeState(file, state)
    }
    await assertBinding(page, manifest, state)
    if (step === 'all' || step === 'meta') {
      state.steps.meta = await fillMeta(page, manifest)
      writeState(file, state)
    }
    if (step === 'all' || step === 'cover') {
      const previousCover = state.steps.cover
      state.steps.cover = previousCover && state.cover_fingerprint === manifest.cover_fingerprint
        && await coverPreview(page) === previousCover.preview
        ? { ...previousCover, status: 'already_uploaded' } : await uploadCover(page, manifest, {
          prior: previousCover,
          onUploaded: async (cover) => {
            state.steps.cover = cover
            state.cover_fingerprint = manifest.cover_fingerprint
            state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
            writeState(file, state)
          },
        })
      state.cover_fingerprint = manifest.cover_fingerprint
      state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
      writeState(file, state)
    }
    let staged = false
    if (state.steps.meta && state.steps.cover) {
      await verifyStaged(page, manifest, state)
      staged = true
    }
    state.staged = staged
    state.screenshot = await screenshot(page, 'operate-staged')
    writeState(file, state)
    emit({ ok: true, staged, saved: false, published: false, title: manifest.title,
      work_description: state.steps.meta?.work_description?.value,
      steps: state.steps, screenshot: state.screenshot })
  } catch (error) {
    if (page) await screenshot(page, 'operate-error').catch(() => {})
    throw error
  } finally { browser.disconnect() }
}
main().catch(fail)
