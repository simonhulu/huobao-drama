import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const CREATE_URL = 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&is_from_cms=1'
export const CDP_URL = process.env.BAIJIAHAO_CDP_URL || 'http://127.0.0.1:9225'
export const PROFILE_DIR = path.join(PROJECT_ROOT, 'data/baijiahao-profile')
export const DEBUG_DIR = path.join(PROFILE_DIR, 'debug')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
export function fail(error) {
  process.stderr.write(`[baijiahao] ${error.message || error}\n`)
  process.exitCode = error.exitCode || 1
}
export function usageError(message) {
  return Object.assign(new Error(message), { exitCode: 2 })
}
export function parseArgs(argv, allowed) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]
    if (!allowed.includes(option)) throw usageError(`未知参数: ${option}`)
    if (['--confirm-save', '--inspect', '--recover-upload'].includes(option)) result[option.slice(2)] = true
    else {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw usageError(`缺少 ${option} 的值`)
      result[option.slice(2)] = value
    }
  }
  return result
}
export function isEditorUrl(value) {
  try {
    const url = new URL(value)
    return url.origin === 'https://baijiahao.baidu.com'
      && url.pathname === '/builder/rc/edit' && url.searchParams.get('type') === 'videoV2'
  } catch { return false }
}
export async function fingerprint(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function loadManifest(reference) {
  if (!reference) throw usageError('需要 --manifest <path>')
  const candidate = path.resolve(reference)
  const file = fs.existsSync(candidate) ? candidate : path.resolve(PROJECT_ROOT, reference)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (manifest.platform !== 'baijiahao' || manifest.version !== 1 || !manifest.session
    || !manifest.title?.trim() || typeof manifest.description !== 'string'
    || manifest.work_description !== undefined && (typeof manifest.work_description !== 'string' || !manifest.work_description.trim())) {
    throw usageError('不是有效的百家号 manifest，请重新运行 prepare')
  }
  for (const kind of ['video', 'cover', ...(manifest.cover_portrait_path ? ['cover_portrait'] : [])]) {
    const asset = manifest[`${kind}_path`]
    if (!asset || !path.isAbsolute(asset) || !fs.statSync(asset).isFile()) {
      throw usageError(`${kind} 文件不存在或不是绝对路径`)
    }
    if (await fingerprint(asset) !== manifest[`${kind}_fingerprint`]) {
      throw usageError(`${kind} 素材已变化，请重新运行 prepare，不得沿用旧上传状态`)
    }
  }
  return { manifest, file }
}
export function statePath(file) { return `${file}.staged.json` }
export function readState(file) {
  return fs.existsSync(statePath(file)) ? JSON.parse(fs.readFileSync(statePath(file), 'utf8')) : null
}
export function writeState(file, state) {
  fs.writeFileSync(statePath(file), `${JSON.stringify(state, null, 2)}\n`)
}
export async function screenshot(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  const file = path.join(DEBUG_DIR, `${Date.now()}-${label}.png`)
  await page.screenshot({ path: file })
  return file
}
export async function connectBrowser() {
  return puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
}
export async function getEditorPage(browser, { open = false } = {}) {
  const pages = await browser.pages()
  const candidates = pages.filter((page) => isEditorUrl(page.url()))
  if (candidates.length > 1) throw new Error('发现多个百家号视频编辑页，请保留目标页后重试')
  if (candidates.length === 1) return candidates[0]
  if (!open) throw new Error('找不到百家号视频编辑页，请先运行 open；不会导航覆盖其他编辑内容')
  const loginPages = pages.filter((page) => page.url().startsWith('https://baijiahao.baidu.com/builder/theme/bjh/login'))
  if (loginPages.length === 1) return loginPages[0]
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  // Reject navigation that could discard an existing edit; never auto-accept beforeunload.
  page.on('dialog', async (dialog) => { await dialog.dismiss() })
  await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  return page
}

// Keep DOM discovery in one place; unknown or ambiguous layouts stop instead of guessing.
export async function inspectPage(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const controls = [...document.querySelectorAll('input,textarea,[contenteditable="true"],button,[role="button"]')]
      .filter((element) => visible(element) || element.type === 'file')
      .map((element) => ({
        tag: element.tagName, type: element.type || '', accept: element.accept || '',
        placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '',
        label: element.getAttribute('aria-label') || '', text: element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'
          ? element.textContent?.trim() : '', maxlength: element.getAttribute('maxlength'),
        id: element.id, class: element.className, html: element.outerHTML.slice(0, 2000),
        parent_html: element.parentElement?.outerHTML.slice(0, 5000),
        files: element.type === 'file' ? [...(element.files || [])].map((file) => ({ name: file.name, size: file.size })) : undefined,
      }))
    const media = [...document.querySelectorAll('video')].map((video) => ({
      src: video.currentSrc || video.src, ready: video.readyState, duration: video.duration,
      html: video.outerHTML.slice(0, 2000),
      parent_html: video.parentElement?.outerHTML.slice(0, 10000),
      ancestors: [video.parentElement?.parentElement?.outerHTML.slice(0, 12000)],
    }))
    const covers = [...document.querySelectorAll('[class*="cover"]')]
      .filter((element) => visible(element) && /选择封面|设置封面/.test(element.textContent || ''))
      .map((element) => element.outerHTML.slice(0, 9000)).slice(-10)
    const formItems = [...document.querySelectorAll('.form-item-line-content-24')]
      .filter((element) => visible(element)).map((element) => element.outerHTML.slice(0, 12000))
    const uploadCards = [...document.querySelectorAll('[data-testid]')]
      .map((element) => ({ testid: element.getAttribute('data-testid'), html: element.outerHTML.slice(0, 5000) }))
    const uploadArea = document.querySelector('[data-testid="video-upload-btn"]')?.parentElement?.parentElement?.parentElement?.outerHTML.slice(0, 12000)
    return { url: location.href, text: document.body?.innerText || '', controls, media, covers, formItems, uploadCards, uploadArea }
  })
}
export function classifyPage(snapshot) {
  if (/验证码|安全验证|滑块验证|完成验证/.test(snapshot.text)) return 'verification_required'
  const hasVideoInput = snapshot.controls.some((control) => control.type === 'file'
    && /video|\.mp4|\.mov/i.test(control.accept))
  const hasTitle = snapshot.controls.some((control) => /标题/.test(control.placeholder + control.label))
  if (isEditorUrl(snapshot.url) && (hasVideoInput || hasTitle)) return 'ready'
  if (/passport\.baidu\.com|\/login|\/register/.test(snapshot.url)
    || /扫码登录|账号密码登录|登录百家号|立即登录|注册百家号/.test(snapshot.text)) return 'login_required'
  return 'unknown'
}
export async function waitForPage(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let snapshot
  while (Date.now() < deadline) {
    snapshot = await inspectPage(page)
    if (classifyPage(snapshot) !== 'unknown') return snapshot
    await wait(500)
  }
  return snapshot
}
export async function requireReady(page) {
  const phase = classifyPage(await inspectPage(page))
  if (phase !== 'ready') throw usageError(`页面状态 ${phase}；请先登录并检查编辑页，禁止自动处理验证码`)
}

async function uniqueHandle(page, selector, predicateSource, argument) {
  const handle = await page.evaluateHandle((css, source, value) => {
    const predicate = new Function('element', 'value', source)
    const elements = [...document.querySelectorAll(css)].filter((element) => predicate(element, value))
    return elements.length === 1 ? elements[0] : { matches: elements.length }
  }, selector, predicateSource, argument)
  const element = handle.asElement()
  if (!element) {
    const { matches } = await handle.jsonValue()
    await handle.dispose()
    throw Object.assign(new Error(`未找到唯一控件 (${selector}, 匹配 ${matches} 个)，请用 open --inspect 检查页面`), { matches })
  }
  return element
}
const visibleCode = `const r = element.getBoundingClientRect(); const s = getComputedStyle(element);
  if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return false;`

export async function clickExact(page, labels, scope = 'body') {
  const selector = scope.split(',').flatMap((root) => [`${root.trim()} button`, `${root.trim()} [role="button"]`]).join(',')
  const element = await uniqueHandle(page, selector, `${visibleCode}
    return !element.disabled && value.includes((element.textContent || '').trim());`, labels)
  try { await element.click() } finally { await element.dispose() }
}
async function fillField(page, kind, value, { optional = false } = {}) {
  let element
  try {
    element = await uniqueHandle(page, 'input:not([type="file"]),textarea,[contenteditable="true"]', `${visibleCode}
      const hint = [element.getAttribute('placeholder'), element.getAttribute('data-placeholder'),
        element.getAttribute('aria-label')].filter(Boolean).join(' ');
      const unified = element.matches('[contenteditable="true"][data-lexical-editor="true"]') && element.closest('.videov2-title-wrap');
      return value === 'title' ? /标题/.test(hint) || !!unified : !unified && /简介|描述/.test(hint);`, kind)
  } catch (error) {
    if (optional && error.matches === 0) return { status: 'not_present', value: '' }
    throw error
  }
  try {
    const limits = await element.evaluate((input) => {
      const unified = input.closest('.videov2-title-wrap')
      const counter = unified?.querySelector('[class*="-count"]')?.textContent?.match(/^\s*[\d.]+\s*\/\s*(\d+)\s*$/)
      return { max: unified ? Number(counter?.[1]) : input.maxLength, min: input.minLength,
        lexical: input.hasAttribute('data-lexical-editor'), unified: !!unified }
    })
    if (limits.unified && !limits.max) throw new Error('作品描述长度上限无法确认，请检查页面')
    const length = limits.unified ? [...value].reduce((total, char) => total + (char.charCodeAt(0) <= 127 ? 0.5 : 1), 0) : value.length
    if (limits.max > 0 && length > limits.max) throw new Error(`${kind} 超过页面上限 ${limits.max}，不会自动截断`)
    if (limits.min > 0 && value.length < limits.min) throw new Error(`${kind} 少于页面下限 ${limits.min}，不会自动补写`)
    if (limits.lexical) {
      await element.focus()
      const modifier = await page.evaluate(() => /Mac/i.test(navigator.platform) ? 'Meta' : 'Control')
      await page.keyboard.down(modifier)
      await page.keyboard.press('KeyA', { commands: ['selectAll'] })
      await page.keyboard.up(modifier)
      await page.keyboard.press('Backspace')
      await page.keyboard.sendCharacter(value)
      await element.evaluate((input) => input.blur())
    } else await element.evaluate((input, text) => {
      input.focus()
      if (input.isContentEditable) input.textContent = text
      else {
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text)
      }
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.blur()
    }, value)
    const actual = await element.evaluate((input) => input.isContentEditable ? input.innerText : input.value)
    if (actual !== value) throw new Error(`${kind} 输入后校验不一致`)
    return { status: 'filled', value: actual, ...(limits.unified ? { field: '作品描述', layout: 'videoV2' } : {}) }
  } finally { await element.dispose() }
}
export async function fillMeta(page, manifest) {
  const fields = await readMeta(page)
  if (fields.unified) {
    if (fields.unified !== 1 || fields.title.length !== 1 || fields.description.length) {
      throw new Error('新版页面出现额外标题/简介入口，请先核对，不会跳过')
    }
    const workDescription = await fillField(page, 'title', manifest.work_description ?? manifest.title)
    return { title: { status: 'source_only', value: manifest.title, layout: 'videoV2' }, work_description: workDescription,
      description: { status: 'not_supported', value: '', source_value: manifest.description,
        reason: '当前 videoV2 只有作品描述字段，没有独立长简介入口' } }
  }
  return { title: await fillField(page, 'title', manifest.title),
    description: await fillField(page, 'description', manifest.description, { optional: !manifest.description }) }
}
export function metaMatchesManifest(meta, manifest) {
  if (meta?.title?.value !== manifest.title) return false
  if (meta.description?.status === 'not_supported') {
    return meta.title.layout === 'videoV2' && meta.description.source_value === manifest.description
      && (meta.work_description?.value ?? meta.title.value) === (manifest.work_description ?? manifest.title)
  }
  return meta.description?.value === manifest.description
}
async function readMeta(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
      .filter((element) => element.getBoundingClientRect().width > 0)
    const title = []; const description = []
    let unified = 0
    for (const element of controls) {
      const hint = [element.getAttribute('placeholder'), element.getAttribute('data-placeholder'), element.getAttribute('aria-label')].join(' ')
      const isUnified = element.matches('[contenteditable="true"][data-lexical-editor="true"]') && element.closest('.videov2-title-wrap')
      const value = element.isContentEditable ? element.innerText : element.value
      if (/标题/.test(hint) || isUnified) title.push(value)
      if (isUnified) unified++
      else if (/简介|描述/.test(hint)) description.push(value)
    }
    return { title, description, unified }
  })
}
export async function readMedia(page) {
  return page.evaluate(() => {
    const videos = [...document.querySelectorAll('video')].filter((element) => {
      if (element.closest('[role="dialog"],.ant-modal-content,.cheetah-modal-content')) return false
      const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 || !!element.closest('[class$="-phonebg"]')
    }).map((element) => ({ src: element.currentSrc || element.src, selected_src: element.src, ready: element.readyState,
      duration: Number.isFinite(element.duration) ? element.duration : 0 }))
    const covers = [...document.querySelectorAll('.form-cover [data-testid="cover-preview"] img')]
    const serverCovers = covers.length === 2 && covers.every((image) => {
      if (!image.complete || !image.naturalWidth) return false
      try { const url = new URL(image.currentSrc || image.src); return url.hostname === 'baijiahao.baidu.com' && url.pathname === '/bjh/picproxy' }
      catch { return false }
    })
    const uniqueVideos = [...new Map(videos.map((video) => [video.src || video.selected_src, video])).values()]
    return {
      text: document.body?.innerText || '',
      video_v2_ready: !!document.querySelector('.videov2-title-wrap') && serverCovers
        && document.querySelectorAll('#cover-tabs-container section').length === 1
        && document.querySelectorAll('#cover-tabs-container section[class$="-selected"]').length === 1,
      progressing: [...document.querySelectorAll('[role="progressbar"],progress')].some((element) => {
        const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0
      }),
      videos: uniqueVideos,
      files: [...document.querySelectorAll('input[type="file"]')]
        .flatMap((input) => [...(input.files || [])].map((file) => ({ name: file.name, size: file.size, type: file.type }))),
    }
  })
}
export function classifyUpload(media) {
  if (/上传失败|转码失败|格式不支持|视频不符合|文件过大/.test(media.text)) return 'failed'
  if (media.progressing || /上传中|转码中|处理中|取消上传|\b(?:100|[1-9]?\d)%/.test(media.text)) return 'uploading'
  return media.videos.length === 1 && media.videos[0].src
    && (!media.videos[0].selected_src || media.videos[0].selected_src === media.videos[0].src)
    && (!media.videos[0].src.startsWith('blob:') || media.video_v2_ready || /上传成功|上传完成/.test(media.text))
    && (media.videos[0].ready >= 1 && media.videos[0].duration > 0 || /上传成功|上传完成/.test(media.text))
    ? 'complete' : 'unknown'
}
export async function documentToken(page) {
  return page.evaluate((token) => {
    window.__baijiahaoPublishDocument ||= token
    return window.__baijiahaoPublishDocument
  }, randomUUID())
}
export async function recoverUploadedVideo(page, manifest) {
  const media = await readMedia(page)
  if (classifyUpload(media) !== 'complete' || !media.videos[0].src.startsWith('blob:')) {
    throw new Error('未能确认已上传的本地视频，不会猜测或重新上传')
  }
  const src = media.videos[0].src
  const digest = await blobFingerprint(page, src)
  if (digest !== manifest.video_fingerprint) throw new Error('当前预览视频与成片指纹不一致，不会修改编辑页')
  const state = { session: manifest.session, video_fingerprint: manifest.video_fingerprint,
    target_id: page.target()._targetId, document_token: await documentToken(page), media_src: src,
    steps: { video: { status: 'uploaded', media_src: src, recovered_by: 'browser_blob_sha256' } } }
  await assertBinding(page, manifest, state)
  return state
}
async function blobFingerprint(page, src) {
  if (!src.startsWith('blob:')) throw new Error('不是可核验的本地 blob 预览')
  return page.evaluate(async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('无法读取当前视频预览')
    const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }, src)
}
export async function assertBinding(page, manifest, state) {
  if (!state || state.session !== manifest.session || state.video_fingerprint !== manifest.video_fingerprint
    || state.target_id !== page.target()._targetId || state.document_token !== await documentToken(page)) {
    throw new Error('上传状态不属于当前素材/编辑页，请检查并重新运行 operate，不能沿用未知视频')
  }
  const media = await readMedia(page)
  if (classifyUpload(media) !== 'complete' || media.videos[0].src !== state.media_src) {
    throw new Error('当前编辑页的视频已变化或未上传完成')
  }
}
export async function uploadVideo(page, manifest, state, { timeoutMs = 20 * 60_000 } = {}) {
  const previous = await readMedia(page)
  if (previous.videos.length || classifyUpload(previous) === 'uploading') {
    await assertBinding(page, manifest, state)
    return { status: 'already_uploaded', media_src: previous.videos[0].src }
  }
  const input = await uniqueHandle(page, 'input[type="file"]',
    'return /video|\\.mp4|\\.mov/i.test(element.accept || "");')
  try { await input.uploadFile(manifest.video_path) } finally { await input.dispose() }
  const deadline = Date.now() + timeoutMs
  let lastProgress = 0
  while (Date.now() < deadline) {
    const media = await readMedia(page)
    const phase = classifyUpload(media)
    if (phase === 'failed') throw new Error('百家号视频上传/转码失败，请检查页面提示')
    if (phase === 'complete') return { status: 'uploaded', media_src: media.videos[0].src }
    if (Date.now() - lastProgress > 15_000) {
      process.stderr.write(`[baijiahao] 等待视频上传/转码: ${phase}\n`)
      lastProgress = Date.now()
    }
    await wait(1000)
  }
  throw new Error('视频上传超时；先检查页面，不要自动重新上传')
}
export async function uploadCover(page, manifest, { prior, onUploaded = async () => {}, timeoutMs = 60_000 } = {}) {
  const previews = await coverPreviews(page)
  if (previews.layout === 'videoV2') {
    if (!manifest.cover_portrait_path) throw new Error('新版页面需要横竖双封面，请先补齐本地 3:4 封面')
    const result = { layout: 'videoV2' }
    for (const kind of ['landscape', 'portrait']) {
      const file = kind === 'landscape' ? manifest.cover_path : manifest.cover_portrait_path
      const digest = kind === 'landscape' ? manifest.cover_fingerprint : manifest.cover_portrait_fingerprint
      const current = (await coverPreviews(page))[kind]
      const dialogs = await readCoverDialogs(page)
      const label = kind === 'landscape' ? /横版封面预览\s*\(16:9\)/ : /竖版封面预览\s*\(3:4\)/
      const pendingCrop = dialogs.some((dialog) => label.test(dialog.text))
      if (!pendingCrop && prior?.[kind]?.fingerprint === digest && prior[kind].preview === current) {
        result[kind] = { ...prior[kind], status: 'already_uploaded' }
      } else {
        if (!dialogs.length) {
          const input = await uniqueHandle(page, '.form-cover input[type="file"]', `
          if (!/image/i.test(element.accept || '')) return false;
          const container = element.closest('[class$="-cover-container"]');
          const preview = container?.querySelector('[data-testid="cover-preview"]')
            || container?.querySelector('[data-testid="select-cover"]')?.closest('[class$="-default"]');
          const rect = preview?.getBoundingClientRect();
          return rect && rect.width > 0 && rect.height > 0 && (value === 'landscape' ? rect.width > rect.height : rect.height > rect.width);`, kind)
          try { await input.uploadFile(file) } finally { await input.dispose() }
        }
        const uploaded = await waitForCover(page, kind, digest, timeoutMs)
        result[kind] = { status: 'uploaded', preview: uploaded, fingerprint: digest }
      }
      await onUploaded({ ...result })
    }
    return result
  }
  // Only explicit cover controls are permitted; a missing control never falls back to video input.
  let input
  try {
    input = await uniqueHandle(page, 'input[type="file"]',
      'return /image|\\.png|\\.jpg|\\.jpeg/i.test(element.accept || "");')
  } catch {
    await clickExact(page, ['上传封面', '设置封面', '更换封面', '选择封面'])
    input = await uniqueHandle(page, 'input[type="file"]',
      'return /image|\\.png|\\.jpg|\\.jpeg/i.test(element.accept || "");')
  }
  const before = await coverPreview(page)
  try { await input.uploadFile(manifest.cover_path) } finally { await input.dispose() }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await coverPreview(page)
    if (current && current !== before) return { status: 'uploaded', preview: current }
    const dialogs = await page.$$('[role="dialog"],.ant-modal-content')
    try {
      if (dialogs.length === 1) {
        const ready = await dialogs[0].evaluate((dialog) => [...dialog.querySelectorAll('img')]
          .some((image) => image.complete && image.naturalWidth > 0)
          && /确定|确认/.test(dialog.innerText || ''))
        if (ready) await clickExact(page, ['确定', '确认'], '[role="dialog"],.ant-modal-content')
      }
    } finally { for (const dialog of dialogs) await dialog.dispose() }
    await wait(500)
  }
  throw new Error('封面上传结果不明确；请检查弹窗/封面预览，不会假报成功')
}
async function readCoverDialogs(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
    .filter((dialog) => dialog.getBoundingClientRect().width > 0)
    .map((dialog) => {
      const sources = [...dialog.querySelectorAll('[class*="-sc-cover"] img')]
      const previews = [...dialog.querySelectorAll('#drawCoverTab-preview img')]
      return { text: dialog.innerText, source: sources.length === 1 && sources[0].complete && sources[0].naturalWidth
        ? sources[0].currentSrc || sources[0].src : null,
        preview: previews.length === 1 && previews[0].complete && previews[0].naturalWidth
          ? { src: previews[0].currentSrc || previews[0].src, width: previews[0].naturalWidth, height: previews[0].naturalHeight } : null }
    }))
}
async function coverPixels(page, src) {
  const encoded = await page.evaluate(async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('无法读取封面预览，不能确认')
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result.split(',')[1])
      reader.onerror = () => reject(new Error('无法读取封面预览，不能确认'))
      reader.readAsDataURL(blob)
    })
  }, src)
  return sharp(Buffer.from(encoded, 'base64')).flatten({ background: '#ffffff' })
    .toColourspace('srgb').resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer()
}
function matchingCoverPixels(expected, actual) {
  if (expected.length !== actual.length) return false
  let difference = 0
  let squared = 0
  for (let index = 0; index < expected.length; index++) {
    const delta = Math.abs(expected[index] - actual[index])
    difference += delta
    squared += delta * delta
  }
  // Allow server JPEG compression only after a SHA-verified crop was explicitly confirmed.
  return difference / expected.length <= 3 && Math.sqrt(squared / expected.length) <= 5
}
async function waitForCover(page, kind, digest, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let confirmed = false
  let confirmedPixels
  while (Date.now() < deadline) {
    const dialogs = await readCoverDialogs(page)
    if (dialogs.length && !confirmed) {
      const label = kind === 'landscape' ? /横版封面预览\s*\(16:9\)/ : /竖版封面预览\s*\(3:4\)/
      if (dialogs.length !== 1 || !label.test(dialogs[0].text)) throw new Error('封面弹窗类型/比例不匹配，请检查页面')
      if (dialogs[0].source && dialogs[0].preview) {
        const ratio = kind === 'landscape' ? 16 / 9 : 3 / 4
        if (Math.abs(dialogs[0].preview.width / dialogs[0].preview.height / ratio - 1) > 0.02) {
          throw new Error('封面裁剪预览比例不匹配，不会确认')
        }
        if (await blobFingerprint(page, dialogs[0].source) !== digest) throw new Error('封面弹窗图片指纹不一致，不会确认')
        confirmedPixels = await coverPixels(page, dialogs[0].preview.src)
        await clickExact(page, ['确定'], '[role="dialog"]')
        confirmed = true
      }
    }
    const current = (await coverPreviews(page))[kind]
    if (!dialogs.length && current && confirmed) {
      if (matchingCoverPixels(confirmedPixels, await coverPixels(page, current))) return current
      throw new Error('封面图像内容与已确认裁剪不匹配，不能确认上传')
    }
    await wait(500)
  }
  throw new Error(`${kind} 封面上传结果不明确，请检查页面`)
}
export async function coverPreviews(page) {
  return page.evaluate(() => {
    const images = [...document.querySelectorAll('.form-cover [data-testid="cover-preview"] img')]
    const slots = [...document.querySelectorAll('.form-cover [class$="-cover-container"]')]
    const emptyDualSlots = slots.length === 2 && slots.every((slot) =>
      slot.querySelector('input[type="file"][accept*="image"]')
      && slot.querySelector('[data-testid="cover-preview"],[data-testid="select-cover"]'))
    if (images.length !== 2 && !emptyDualSlots) return { layout: 'single' }
    const result = { layout: 'videoV2' }
    for (const image of images) {
      const r = image.closest('[data-testid="cover-preview"]').getBoundingClientRect()
      if (!r.width || !r.height || !image.complete || !image.naturalWidth) continue
      const kind = r.width > r.height ? 'landscape' : 'portrait'
      if (result[kind]) throw new Error('封面比例控件重复，无法确认')
      result[kind] = image.currentSrc || image.src
    }
    return result
  })
}
export async function coverPreview(page) {
  return page.evaluate(() => {
    const images = [...document.querySelectorAll('[class*="cover"] img,[data-testid*="cover"] img')]
      .filter((image) => image.getBoundingClientRect().width > 0 && image.complete && image.naturalWidth > 0
        && !image.closest('[role="dialog"],.ant-modal-content'))
    return images.length === 1 ? images[0].currentSrc || images[0].src : null
  })
}
export async function verifyStaged(page, manifest, state) {
  await assertBinding(page, manifest, state)
  if ((await readCoverDialogs(page)).length) throw new Error('仍有未关闭的弹窗，不能确认编辑页已全部完成')
  if (!state.steps?.meta || !state.steps?.cover || state.cover_fingerprint !== manifest.cover_fingerprint) {
    throw new Error('标题/简介/封面未全部完成，请先完成 operate --step all')
  }
  if (!metaMatchesManifest(state.steps.meta, manifest)) throw new Error('页面标题/简介已变化，不能保存')
  const text = await readMeta(page)
  const unsupported = text.unified === 1 && text.description.length === 0
    && state.steps.meta.description.status === 'not_supported'
    && state.steps.meta.description.source_value === manifest.description
  const expectedTitle = text.unified === 1 ? manifest.work_description ?? manifest.title : manifest.title
  if (text.title.length !== 1 || text.title[0] !== expectedTitle
    || manifest.description && !unsupported && (text.description.length !== 1 || text.description[0] !== manifest.description)) {
    throw new Error('页面标题/简介已变化，不能保存')
  }
  const previews = await coverPreviews(page)
  if (previews.layout === 'videoV2') {
    if (state.steps.cover.layout !== 'videoV2' || state.cover_portrait_fingerprint !== manifest.cover_portrait_fingerprint
      || !manifest.cover_portrait_fingerprint || ['landscape', 'portrait'].some((kind) => !previews[kind]
        || previews[kind] !== state.steps.cover[kind]?.preview
        || state.steps.cover[kind]?.fingerprint !== (kind === 'landscape' ? manifest.cover_fingerprint : manifest.cover_portrait_fingerprint))) {
      throw new Error('页面封面已变化或无法确认横竖双封面')
    }
  } else if (state.steps.cover.layout === 'videoV2' || await coverPreview(page) !== state.steps.cover.preview) {
    throw new Error('页面封面已变化或无法确认')
  }
}
export async function saveDraft(page, { timeoutMs = 30_000 } = {}) {
  const successSelector = '[role="alert"],.ant-message-notice,.toast,.message-success,.el-message'
  const successText = (text) => /草稿保存成功|保存草稿成功|已保存到草稿箱|保存成功/.test(text)
  const before = await page.$$eval(successSelector, (elements) => elements.map((element) => element.textContent || ''))
  if (before.some(successText)) throw new Error('存在旧保存提示，不能据此验证本次保存')
  await clickExact(page, ['保存草稿', '存草稿'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const notices = await page.$$eval(successSelector, (elements) => elements
      .filter((element) => element.getBoundingClientRect().width > 0).map((element) => element.textContent || ''))
    if (notices.some(successText)) return { saved: true, evidence: notices.find(successText), url: page.url() }
    await wait(300)
  }
  throw new Error('保存结果不明确；已尝试一次，禁止盲目重试。请在百家号草稿箱人工核对')
}
