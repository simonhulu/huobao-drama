import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'
import { CREATE_URL, isEditorUrl, classifyPage, classifyUpload, parseArgs, getEditorPage,
  fingerprint, loadManifest, uploadVideo, uploadCover, fillMeta, documentToken,
  verifyStaged, assertBinding, saveDraft, clickExact, inspectPage } from './lib.mjs'
import { readMedia, recoverUploadedVideo, coverPreviews, metaMatchesManifest, writeState } from './lib.mjs'

test('only the exact videoV2 editor route is eligible', () => {
  assert.equal(isEditorUrl(CREATE_URL), true)
  for (const url of ['https://baijiahao.baidu.com.evil.example/builder/rc/edit?type=videoV2',
    'https://baijiahao.baidu.com/builder/rc/edit?type=news', 'not a URL']) {
    assert.equal(isEditorUrl(url), false)
  }
})

test('page state distinguishes login, verification and unknown layouts', () => {
  const controls = [{ type: 'file', accept: 'video/mp4', placeholder: '' }]
  assert.equal(classifyPage({ url: CREATE_URL, text: '上传视频', controls }), 'ready')
  assert.equal(classifyPage({ url: CREATE_URL, text: '请完成验证', controls }), 'verification_required')
  assert.equal(classifyPage({ url: 'https://baijiahao.baidu.com/builder/theme/bjh/login', text: '', controls: [] }), 'login_required')
  assert.equal(classifyPage({ url: CREATE_URL, text: '加载中', controls: [] }), 'unknown')
})

test('upload requires one usable preview and no active upload/processing or failure', () => {
  const videos = [{ src: 'https://example.test/uploaded.mp4', ready: 1, duration: 12 }]
  assert.equal(classifyUpload({ text: '封面预览', videos: [] }), 'unknown')
  assert.equal(classifyUpload({ text: '', videos }), 'complete')
  assert.equal(classifyUpload({ text: '', videos: [{ src: 'blob:video', ready: 1, duration: 12 }] }), 'unknown')
  assert.equal(classifyUpload({ text: '上传完成', videos: [{ src: 'blob:video', ready: 1, duration: 12 }] }), 'complete')
  assert.equal(classifyUpload({ text: '上传完成', videos, progressing: true }), 'uploading')
  assert.equal(classifyUpload({ text: '转码中', videos }), 'uploading')
  assert.equal(classifyUpload({ text: '100%', videos }), 'uploading')
  assert.equal(classifyUpload({ text: '上传失败', videos }), 'failed')
  assert.equal(classifyUpload({ text: '', videos: [videos[0], videos[0]] }), 'unknown')
  assert.equal(classifyUpload({ text: '封面预览', videos: [{ src: 'blob:video', ready: 0, duration: 0 }] }), 'unknown')
  assert.equal(classifyUpload({ text: '', videos: [{ src: 'blob:video', ready: 1, duration: 12 }], video_v2_ready: true }), 'complete')
  assert.equal(classifyUpload({ text: '38%', videos: [{ src: 'blob:video', ready: 1, duration: 12 }], video_v2_ready: true }), 'uploading')
})

test('unknown options and invalid upload steps cannot quietly succeed', () => {
  assert.throws(() => parseArgs(['--bogus'], ['--manifest']), /未知参数/)
  assert.throws(() => parseArgs(['--manifest'], ['--manifest']), /缺少/)
  assert.deepEqual(parseArgs(['--confirm-save'], ['--confirm-save']), { 'confirm-save': true })
  assert.deepEqual(parseArgs(['--recover-upload'], ['--recover-upload']), { 'recover-upload': true })
  const script = fileURLToPath(new URL('./operate.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--step', 'publish'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /未知 --step/)
})

test('verify refuses to connect to Chrome without explicit save confirmation', () => {
  const script = fileURLToPath(new URL('./verify.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...process.env, BAIJIAHAO_CDP_URL: 'http://127.0.0.1:1' },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /确认保存草稿/)
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/)
})

test('open does not overwrite unrelated edits or select from multiple editor tabs', async () => {
  let created = 0
  const browser = { pages: async () => [{ url: () => 'https://baijiahao.baidu.com/builder/rc/edit?type=news' }],
    newPage: async () => { created++; throw new Error('unexpected navigation') } }
  await assert.rejects(getEditorPage(browser), /找不到/)
  assert.equal(created, 0)
  browser.pages = async () => [{ url: () => CREATE_URL }, { url: () => CREATE_URL }]
  await assert.rejects(getEditorPage(browser, { open: true }), /多个/)
  assert.equal(created, 0)
})

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'baijiahao-dom-'))
  let browser
  t.after(async () => {
    try { if (browser) await browser.close() }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  const video = path.join(root, 'video.mp4')
  const cover = path.join(root, 'cover.png')
  fs.writeFileSync(video, 'offline mock upload bytes')
  const initial = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#cc2038' } }).png().toBuffer()
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#148357' } }).png().toFile(cover)
  const manifest = { platform: 'baijiahao', version: 1, session: 'test-session', title: '既有标题不重写',
    description: '既有开头\n\n既有结尾', video_path: video, cover_path: cover,
    video_fingerprint: await fingerprint(video), cover_fingerprint: await fingerprint(cover) }
  const file = path.join(root, 'manifest.json')
  fs.writeFileSync(file, JSON.stringify(manifest))
  browser = await puppeteer.launch({
    executablePath: process.env.BAIJIAHAO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, userDataDir: path.join(root, 'chrome'), args: ['--no-first-run'],
  })
  const page = await browser.newPage()
  await page.setContent(`<input id="video-file" type="file" accept="video/mp4">
    <video id="video" style="display:none;width:320px;height:180px"></video>
    <input placeholder="请输入视频标题" maxlength="40"><textarea placeholder="视频简介"></textarea>
    <input id="cover-file" type="file" accept="image/png"><div class="cover"><img width="160" height="90" src="data:image/png;base64,${initial.toString('base64')}"></div>
    <button id="draft">保存草稿</button><button id="publish">发布</button>
    <script>
      window.publishCount=0; window.saveCount=0;
      document.querySelector('#publish').onclick=()=>window.publishCount++;
      document.querySelector('#video-file').onchange=()=>{
        const video=document.querySelector('#video'); video.style.display='block';
        video.src=URL.createObjectURL(document.querySelector('#video-file').files[0]);
        Object.defineProperty(video,'readyState',{value:1,configurable:true});
        Object.defineProperty(video,'duration',{value:12,configurable:true});
        const notice=document.createElement('div'); notice.textContent='上传完成'; document.body.appendChild(notice);
      };
      document.querySelector('#cover-file').onchange=()=>{
        const reader=new FileReader(); reader.onload=()=>document.querySelector('.cover img').src=reader.result;
        reader.readAsDataURL(document.querySelector('#cover-file').files[0]);
      };
      document.querySelector('#draft').onclick=()=>{
        window.saveCount++;
        const notice=document.createElement('div'); notice.setAttribute('role','alert');
        notice.textContent='草稿保存成功'; document.body.appendChild(notice);
      };
    </script>`)
  return { root, browser, page, manifest, file, video, cover }
}

test('manifest validation rejects changed video or cover bytes', async (t) => {
  const { manifest, file, video, cover } = await fixture(t)
  assert.equal((await loadManifest(file)).manifest.video_fingerprint, manifest.video_fingerprint)
  fs.writeFileSync(video, 'different upload')
  await assert.rejects(loadManifest(file), /video 素材已变化/)
  fs.writeFileSync(video, 'offline mock upload bytes')
  fs.writeFileSync(cover, 'different cover')
  await assert.rejects(loadManifest(file), /cover 素材已变化/)
})

async function stage(page, manifest) {
  const video = await uploadVideo(page, manifest, null, { timeoutMs: 3000 })
  const state = { session: manifest.session, video_fingerprint: manifest.video_fingerprint,
    cover_fingerprint: manifest.cover_fingerprint, target_id: page.target()._targetId,
    document_token: await documentToken(page), media_src: video.media_src, steps: { video } }
  state.steps.meta = await fillMeta(page, manifest)
  state.steps.cover = await uploadCover(page, manifest)
  return state
}

test('offline upload stages video, exact metadata and changed cover without saving/publishing', async (t) => {
  const { page, manifest } = await fixture(t)
  const state = await stage(page, manifest)
  await verifyStaged(page, manifest, state)
  assert.equal((await uploadVideo(page, manifest, state)).status, 'already_uploaded')
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [0, 0])
  await assert.rejects(assertBinding(page, { ...manifest, session: 'other' }, state), /不属于/)
  await page.$eval('video', (video) => { video.src = 'blob:replaced' })
  await assert.rejects(assertBinding(page, manifest, state), /已变化/)
})

test('staged checks reject metadata or cover changes and unknown pre-existing video', async (t) => {
  const { page, manifest } = await fixture(t)
  const state = await stage(page, manifest)
  await assert.rejects(uploadVideo(page, manifest, null), /不属于/)
  await page.$eval('textarea', (input) => { input.value = 'changed' })
  await assert.rejects(verifyStaged(page, manifest, state), /标题\/简介已变化/)
  await fillMeta(page, manifest)
  state.steps.cover.preview = 'different cover'
  await assert.rejects(verifyStaged(page, manifest, state), /封面已变化/)
})

test('limits and ambiguous inputs stop without truncation, even for optional description', async (t) => {
  const { page, manifest } = await fixture(t)
  await assert.rejects(fillMeta(page, { ...manifest, title: '太'.repeat(41) }), /超过页面上限/)
  assert.equal(await page.$eval('input[placeholder]', (input) => input.value), '')
  await page.evaluate(() => document.body.appendChild(document.querySelector('textarea').cloneNode()))
  await assert.rejects(fillMeta(page, { ...manifest, description: '' }), /匹配 2 个/)
})

test('exact dialog confirmation is scoped and never selects publish', async (t) => {
  const { page } = await fixture(t)
  await page.evaluate(() => {
    window.confirmed = 0
    const outside = document.createElement('button'); outside.textContent = '确认'; outside.onclick = () => { window.confirmed += 100 }
    const modal = document.createElement('div'); modal.className = 'ant-modal-content'
    const inside = document.createElement('button'); inside.textContent = '确认'; inside.onclick = () => { window.confirmed++ }
    modal.appendChild(inside); document.body.append(outside, modal)
  })
  await clickExact(page, ['确认'], '[role="dialog"],.ant-modal-content')
  assert.equal(await page.evaluate(() => window.confirmed), 1)
  assert.equal(await page.evaluate(() => window.publishCount), 0)
})

test('saving requires a fresh success notice, and cannot click publish as a fallback', async (t) => {
  const { page, manifest } = await fixture(t)
  const state = await stage(page, manifest)
  await verifyStaged(page, manifest, state)
  const result = await saveDraft(page, { timeoutMs: 1000 })
  assert.equal(result.saved, true)
  await assert.rejects(saveDraft(page), /旧保存提示/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [1, 0])
  await page.evaluate(() => { document.querySelector('[role="alert"]').remove(); document.querySelector('#draft').remove() })
  await assert.rejects(saveDraft(page, { timeoutMs: 1000 }), /未找到唯一控件/)
  assert.equal(await page.evaluate(() => window.publishCount), 0)
})

test('unknown save result fails after one attempt, rather than pretending navigation is success', async (t) => {
  const { page } = await fixture(t)
  await page.$eval('#draft', (button) => { button.onclick = () => { window.saveCount++ } })
  await assert.rejects(saveDraft(page, { timeoutMs: 400 }), /保存结果不明确/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [1, 0])
  const snapshot = await inspectPage(page)
  assert.ok(snapshot.controls.some((control) => control.text === '保存草稿'))
})

async function videoV2Fixture(t) {
  const context = await fixture(t)
  const { page, manifest, cover, root } = context
  const initial = await sharp(cover).png().toBuffer()
  const portrait = path.join(root, 'portrait.png')
  await sharp({ create: { width: 90, height: 120, channels: 3, background: '#148357' } }).png().toFile(portrait)
  manifest.cover_portrait_path = portrait
  manifest.cover_portrait_fingerprint = await fingerprint(portrait)
  await page.setRequestInterception(true)
  page.on('request', (request) => request.respond(request.resourceType() === 'image' || request.url().startsWith('https://baijiahao.baidu.com/bjh/picproxy?')
    ? { status: 200, contentType: 'image/png', body: initial }
    : { status: 200, contentType: 'text/html', body: '<body></body>' }))
  await page.goto(CREATE_URL)
  await page.setContent(`<div id="cover-tabs-container"><section class="mock-selected"></section></div>
    <div class="mock-phonebg"><video style="display:none"></video></div>
    <div class="videov2-title-wrap"><div contenteditable="true" data-lexical-editor="true" role="textbox">old</div><div class="mock-count ">3/50</div></div>
    <div class="form-cover">
      <div class="mock-cover-container"><input type="file" accept="image/*"><div data-testid="cover-preview" style="width:221px;height:124px"><img width="221" height="124" src="https://baijiahao.baidu.com/bjh/picproxy?horizontal"></div></div>
      <div class="mock-cover-container"><input type="file" accept="image/*"><div data-testid="cover-preview" style="width:93px;height:124px"><img width="93" height="124" src="https://baijiahao.baidu.com/bjh/picproxy?portrait"></div></div>
    </div>
    <button id="draft">存草稿</button><button id="publish">发布</button>
    <script>
      window.saveCount=0; window.publishCount=0; window.realInput=false;
      document.querySelector('#draft').onclick=()=>window.saveCount++;
      document.querySelector('#publish').onclick=()=>window.publishCount++;
      document.querySelector('[contenteditable]').oninput=(event)=>{window.realInput ||= event.isTrusted};
      const video=document.querySelector('video');
      video.src=URL.createObjectURL(new Blob(['offline mock upload bytes']));
      Object.defineProperty(video,'readyState',{value:4,configurable:true});
      Object.defineProperty(video,'duration',{value:12,configurable:true});
      document.querySelectorAll('.form-cover input').forEach((input,index)=>input.onchange=()=>{
        const src=URL.createObjectURL(input.files[0]);
        const modal=document.createElement('div'); modal.setAttribute('role','dialog');
        const label=index?'竖版封面预览 (3:4)':'横版封面预览 (16:9)';
        modal.innerHTML='<div class="mock-sc-cover"><img src="'+src+'"></div><div id="drawCoverTab-preview"><img src="'+src+'">'+label+'</div><button>确定</button>';
        modal.querySelector('button').onclick=()=>{
          input.parentElement.querySelector('img').src='https://baijiahao.baidu.com/bjh/picproxy?'+input.files[0].name;
          modal.remove();
        };
        document.body.appendChild(modal);
      });
    </script>`)
  await page.waitForFunction(() => [...document.querySelectorAll('.form-cover img')].every((img) => img.complete && img.naturalWidth > 0))
  return context
}

test('videoV2 recovery binds an existing blob by SHA256 without uploading again', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  assert.equal(classifyUpload(await readMedia(page)), 'complete')
  await assert.rejects(recoverUploadedVideo(page, { ...manifest, video_fingerprint: 'wrong' }), /指纹不一致/)
  const state = await recoverUploadedVideo(page, manifest)
  assert.equal(state.steps.video.recovered_by, 'browser_blob_sha256')
  await assertBinding(page, manifest, state)
  assert.equal((await uploadVideo(page, manifest, state)).status, 'already_uploaded')
  await page.$eval('.form-cover img', (image) => { image.src = 'data:image/png;base64,' })
  await assert.rejects(recoverUploadedVideo(page, manifest), /未能确认/)
})

test('videoV2 uploads both covers when default server covers are missing', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  await page.evaluate(() => {
    for (const slot of document.querySelectorAll('.form-cover [class$="-cover-container"]')) {
      const preview = slot.querySelector('[data-testid="cover-preview"]')
      preview.removeAttribute('data-testid')
      preview.className = 'mock-default'
      preview.innerHTML = '<span data-testid="select-cover">选择封面</span>'
      const input = slot.querySelector('input')
      const original = input.onchange
      input.onchange = () => {
        original()
        const button = document.querySelector('[role="dialog"] button')
        const confirm = button.onclick
        button.onclick = () => {
          preview.className = ''
          preview.dataset.testid = 'cover-preview'
          preview.innerHTML = '<img>'
          confirm()
        }
      }
    }
  })
  assert.deepEqual(await coverPreviews(page), { layout: 'videoV2' })
  const cover = await uploadCover(page, manifest)
  assert.equal(cover.landscape.status, 'uploaded')
  assert.equal(cover.portrait.status, 'uploaded')
  assert.equal(await page.$$eval('[role="dialog"]', (dialogs) => dialogs.length), 0)
})

test('videoV2 maps exact title to Lexical field, reports unsupported description and verifies both covers', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  const state = await recoverUploadedVideo(page, manifest)
  await assert.rejects(fillMeta(page, { ...manifest, title: '太'.repeat(51) }), /超过页面上限/)
  assert.equal(await page.$eval('[contenteditable]', (input) => input.innerText), 'old')
  state.steps.meta = await fillMeta(page, manifest)
  assert.equal(state.steps.meta.description.status, 'not_supported')
  assert.equal(state.steps.meta.description.source_value, manifest.description)
  assert.equal(await page.evaluate(() => window.realInput), true)
  state.steps.cover = await uploadCover(page, manifest)
  state.cover_fingerprint = manifest.cover_fingerprint
  state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
  assert.equal(state.steps.cover.portrait.status, 'uploaded')
  assert.notEqual((await coverPreviews(page)).landscape, (await coverPreviews(page)).portrait)
  await verifyStaged(page, manifest, state)
  await page.$eval('[contenteditable]', (input) => { input.textContent = 'changed' })
  await assert.rejects(verifyStaged(page, manifest, state), /标题\/简介已变化/)
  await fillMeta(page, manifest)
  state.steps.cover.portrait.preview = 'changed'
  await assert.rejects(verifyStaged(page, manifest, state), /封面已变化/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [0, 0])
})

test('videoV2 uses the explicit opening hook as work description without changing the cover title', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  manifest.work_description = '乾隆真的不知道和珅贪吗？嘉庆十五天就能拿下的人，为什么在乾隆身边舒坦了二十多年？'
  const state = await recoverUploadedVideo(page, manifest)
  await assert.rejects(fillMeta(page, { ...manifest, work_description: '太'.repeat(51) }), /超过页面上限/)
  assert.equal(await page.$eval('[contenteditable]', (input) => input.innerText), 'old')
  state.steps.meta = await fillMeta(page, manifest)
  assert.equal(state.steps.meta.title.value, manifest.title)
  assert.equal(state.steps.meta.work_description.value, manifest.work_description)
  assert.equal(await page.$eval('[contenteditable]', (input) => input.innerText), manifest.work_description)
  assert.equal(metaMatchesManifest(state.steps.meta, manifest), true)
  assert.equal(metaMatchesManifest(state.steps.meta, { ...manifest, work_description: '另一条钩子' }), false)
  state.steps.cover = await uploadCover(page, manifest)
  state.cover_fingerprint = manifest.cover_fingerprint
  state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
  await verifyStaged(page, manifest, state)
  await page.$eval('[contenteditable]', (input, title) => { input.textContent = title }, manifest.title)
  await assert.rejects(verifyStaged(page, manifest, state), /标题\/简介已变化/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [0, 0])
})

test('separate title and description layout does not replace its title with the videoV2 hook', async (t) => {
  const { page, manifest } = await fixture(t)
  const meta = await fillMeta(page, { ...manifest, work_description: '给新版作品描述的钩子' })
  assert.equal(meta.title.value, manifest.title)
  assert.equal(meta.description.value, manifest.description)
  assert.equal(meta.work_description, undefined)
})

test('videoV2 crop confirms only the matching local image and resumes a verified open dialog', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  const state = await recoverUploadedVideo(page, manifest)
  await page.evaluate(() => {
    window.coverUploadCount = 0; window.coverConfirmCount = 0
    document.querySelectorAll('.form-cover input').forEach((input, index) => {
      input.onchange = () => {
        window.coverUploadCount++
        const src = URL.createObjectURL(input.files[0])
        const modal = document.createElement('div'); modal.setAttribute('role', 'dialog')
        const label = index === 0 ? '横版封面预览 (16:9)' : '竖版封面预览 (3:4)'
        modal.innerHTML = `<div class="mock-sc-cover"><img src="${src}"></div><div id="drawCoverTab-preview"><img src="${src}">${label}</div><video src="${document.querySelector('video').src}"></video><button>确定</button>`
        modal.querySelector('button').onclick = () => {
          window.coverConfirmCount++
          input.parentElement.querySelector('img').src = 'https://baijiahao.baidu.com/bjh/picproxy?crop-' + input.files[0].name
          modal.remove()
        }
        document.body.appendChild(modal)
      }
    })
  })
  await assert.rejects(uploadCover(page, { ...manifest, cover_fingerprint: 'wrong' }, { timeoutMs: 3000 }), /图片指纹不一致/)
  assert.equal(await page.evaluate(() => window.coverConfirmCount), 0)
  await assertBinding(page, manifest, state)
  const cover = await uploadCover(page, manifest, { timeoutMs: 3000 })
  assert.equal(cover.landscape.status, 'uploaded')
  assert.equal(cover.portrait.status, 'uploaded')
  assert.deepEqual(await page.evaluate(() => [window.coverUploadCount, window.coverConfirmCount]), [2, 2])
  const repeated = await uploadCover(page, manifest, { prior: cover, timeoutMs: 3000 })
  assert.equal(repeated.landscape.status, 'already_uploaded')
  assert.equal(repeated.portrait.status, 'already_uploaded')
  assert.deepEqual(await page.evaluate(() => [window.coverUploadCount, window.coverConfirmCount, window.saveCount, window.publishCount]), [2, 2, 0, 0])
})

async function stableCoverFixture(t, { mismatch = false } = {}) {
  const context = await videoV2Fixture(t)
  const { page, manifest } = context
  const landscape = await sharp(manifest.cover_path).jpeg({ quality: 80 }).toBuffer()
  const portrait = await sharp(manifest.cover_portrait_path).jpeg({ quality: 80 }).toBuffer()
  const wrong = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#cc2038' } }).jpeg().toBuffer()
  await page.setCacheEnabled(false)
  page.removeAllListeners('request')
  page.on('request', (request) => request.respond({ status: 200, contentType: 'image/jpeg',
    body: mismatch ? wrong : request.url().includes('portrait') ? portrait : landscape }))
  await page.evaluate(() => {
    window.coverUploadCount = 0; window.coverConfirmCount = 0
    document.querySelectorAll('.form-cover input').forEach((input, index) => {
      input.parentElement.querySelector('img').src = 'https://baijiahao.baidu.com/bjh/picproxy?stable-' + (index ? 'portrait' : 'landscape')
      input.onchange = () => {
        window.coverUploadCount++
        const src = URL.createObjectURL(input.files[0])
        const modal = document.createElement('div'); modal.setAttribute('role', 'dialog')
        const label = index ? '竖版封面预览 (3:4)' : '横版封面预览 (16:9)'
        modal.innerHTML = `<div class="mock-sc-cover"><img src="${src}"></div><div id="drawCoverTab-preview"><img src="${src}">${label}</div><button>确定</button>`
        modal.querySelector('button').onclick = () => { window.coverConfirmCount++; modal.remove() }
        document.body.appendChild(modal)
      }
    })
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.form-cover img')].every((img) => img.complete && img.naturalWidth > 0))
  return context
}

test('videoV2 accepts stable cover URLs only after verified confirmation and matching JPEG pixels', async (t) => {
  const { page, manifest } = await stableCoverFixture(t)
  const state = await recoverUploadedVideo(page, manifest)
  state.steps.meta = await fillMeta(page, manifest)
  const before = await coverPreviews(page)
  const result = await uploadCover(page, manifest, { timeoutMs: 3000 })
  assert.equal(result.landscape.preview, before.landscape)
  assert.equal(result.portrait.preview, before.portrait)
  assert.equal(result.portrait.status, 'uploaded')
  const repeated = await uploadCover(page, manifest, { prior: result, timeoutMs: 3000 })
  assert.equal(repeated.portrait.status, 'already_uploaded')
  assert.deepEqual(await page.evaluate(() => [window.coverUploadCount, window.coverConfirmCount, window.saveCount, window.publishCount]), [2, 2, 0, 0])
  state.steps.cover = repeated
  state.cover_fingerprint = manifest.cover_fingerprint
  state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
  await verifyStaged(page, manifest, state)
  await page.evaluate(() => document.querySelectorAll('.form-cover input')[1].dispatchEvent(new Event('change')))
  await assert.rejects(verifyStaged(page, manifest, state), /未关闭的弹窗/)
  const resumed = await uploadCover(page, manifest, { prior: repeated, timeoutMs: 3000 })
  assert.equal(resumed.landscape.status, 'already_uploaded')
  assert.equal(resumed.portrait.status, 'uploaded')
  assert.deepEqual(await page.evaluate(() => [window.coverUploadCount, window.coverConfirmCount, window.saveCount, window.publishCount]), [3, 3, 0, 0])
  state.steps.cover = resumed
  await verifyStaged(page, manifest, state)
})

test('videoV2 rejects unchanged server images that differ from the verified crop', async (t) => {
  const { page, manifest } = await stableCoverFixture(t, { mismatch: true })
  await assert.rejects(uploadCover(page, manifest, { timeoutMs: 3000 }), /图像内容与已确认裁剪不匹配/)
  assert.deepEqual(await page.evaluate(() => [window.coverUploadCount, window.coverConfirmCount, window.saveCount, window.publishCount]), [1, 1, 0, 0])
})

test('videoV2 rejects URL changes without a verified crop confirmation', async (t) => {
  const { page, manifest } = await videoV2Fixture(t)
  await page.evaluate(() => {
    document.querySelectorAll('.form-cover input').forEach((input) => {
      input.onchange = () => { input.parentElement.querySelector('img').src = 'https://baijiahao.baidu.com/bjh/picproxy?unverified-change' }
    })
  })
  await assert.rejects(uploadCover(page, manifest, { timeoutMs: 400 }), /上传结果不明确/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [0, 0])
})

test('save preflight accepts explicit videoV2 unsupported description but rejects stale source metadata', async (t) => {
  const { page, manifest, file } = await videoV2Fixture(t)
  const state = await recoverUploadedVideo(page, manifest)
  state.steps.meta = await fillMeta(page, manifest)
  assert.equal(metaMatchesManifest(state.steps.meta, manifest), true)
  assert.equal(metaMatchesManifest(state.steps.meta, { ...manifest, description: 'new text' }), false)
  assert.equal(metaMatchesManifest({ ...state.steps.meta, title: { value: manifest.title } }, manifest), false)
  assert.equal(metaMatchesManifest(undefined, manifest), false)
  state.cover_fingerprint = manifest.cover_fingerprint
  state.cover_portrait_fingerprint = manifest.cover_portrait_fingerprint
  fs.writeFileSync(file, JSON.stringify(manifest))
  writeState(file, state)
  const script = fileURLToPath(new URL('./verify.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--manifest', file, '--confirm-save'], {
    encoding: 'utf8', env: { ...process.env, BAIJIAHAO_CDP_URL: 'http://127.0.0.1:1' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Failed to fetch browser|ECONNREFUSED|fetch failed/)
  assert.doesNotMatch(result.stderr, /准备完成的页面状态不一致/)
  assert.deepEqual(await page.evaluate(() => [window.saveCount, window.publishCount]), [0, 0])
})
