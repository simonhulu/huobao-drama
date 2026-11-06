#!/usr/bin/env node
import { connectBrowser, getEditorPage, requireReady, loadManifest, parseArgs, readState, writeState,
  verifyStaged, metaMatchesManifest, saveDraft, screenshot, emit, fail, usageError } from './lib.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--manifest', '--confirm-save'])
  if (!args['confirm-save']) throw usageError('只有用户确认保存草稿后，才可传 --confirm-save')
  const { manifest, file } = await loadManifest(args.manifest)
  const state = readState(file)
  if (!state || state.session !== manifest.session || state.video_fingerprint !== manifest.video_fingerprint
    || state.cover_fingerprint !== manifest.cover_fingerprint
    || manifest.cover_portrait_fingerprint && state.cover_portrait_fingerprint !== manifest.cover_portrait_fingerprint
    || !metaMatchesManifest(state.steps?.meta, manifest)) {
    throw new Error('manifest 与准备完成的页面状态不一致，请先运行 operate')
  }
  if (state?.saved) { emit({ ok: true, saved: true, published: false, already_saved: true, title: manifest.title }); return }
  if (state?.save_attempted_at) throw new Error('之前保存结果不明确；禁止重试，请人工核对草稿箱')
  const browser = await connectBrowser()
  let page
  try {
    page = await getEditorPage(browser)
    await requireReady(page)
    await verifyStaged(page, manifest, state)
    // Record before clicking: a timeout or crash must not silently create a second draft.
    state.save_attempted_at = new Date().toISOString()
    writeState(file, state)
    const result = await saveDraft(page)
    state.saved = true
    state.save_evidence = result
    state.screenshot = await screenshot(page, 'verify-saved')
    writeState(file, state)
    emit({ ok: true, saved: true, published: false, title: manifest.title, ...result, screenshot: state.screenshot })
  } catch (error) {
    if (page) await screenshot(page, 'verify-error').catch(() => {})
    throw error
  } finally { browser.disconnect() }
}
main().catch(fail)
