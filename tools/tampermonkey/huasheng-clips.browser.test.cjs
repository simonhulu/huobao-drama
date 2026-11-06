const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../frontend/node_modules/playwright');

const pid = '258950566158483';
const fixture = {
  project: { pid, name: '工业革命为什么先发生在英国，而不是中国？' },
  clips: [
    { id: 'b', idx: '2', content: '这个问题，不能简单归结为哪个民族更聪明、哪种文化更先进。', voice: { url: 'https://media.example/b.wav', duration: 7 }, video: { url: 'https://media.example/b.mp4', duration: 14 }, composite_video: { url: 'https://media.example/b-render.mp4', duration: 7 } },
    { id: 'a', idx: '1', content: '工业革命为什么先发生在英国，而不是中国？', voice: { url: 'https://media.example/a.mp3', duration: 5 }, video: { url: 'https://media.example/a.mp4', start_time: 3, duration: 20 }, composite_video: { url: 'https://media.example/a-render.mp4', duration: 5 } },
    { id: 'c', idx: '3', content: '一幅历史图片，也可能是分镜的源素材。', voice: { duration: 9 }, video: { url: 'https://media.example/still.png', material_type: 2 } },
    { id: 'd', idx: '4', content: '此处尚未生成素材。', voice: { duration: 6 } },
  ],
};

async function setup(t, viewport = { width: 1440, height: 1000 }, destination = 'browser', project = fixture) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
      if (url.pathname.includes('/v2/')) return route.fulfill({ json: { code: 0, data: project } });
      return route.fulfill({ json: project });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#121212;color:white;font-family:sans-serif"><h1 style="font-size:20px">花生编辑器测试页面</h1></body></html>' });
  });
  await page.goto(`https://www.huasheng.cn/video/${pid}`);
  await page.evaluate(async () => {
    window.GM_info = { downloadMode: 'browser' };
    window.GM_registerMenuCommand = () => {};
    window.testCalls = [];
    window.testAborts = 0;
    window.testActive = 0;
    window.testPeakActive = 0;
    window.testBehavior = 'success';
    window.testRoot = await navigator.storage.getDirectory();
    window.testPickerCancelled = false;
    window.showDirectoryPicker = async () => {
      if (window.testPickerCancelled) throw new DOMException('Cancelled', 'AbortError');
      return window.testRoot;
    };
    window.testBlobCalls = [];
    window.testProgress = [];
    window.GM_xmlhttpRequest = (options) => {
      window.testBlobCalls.push(options.url);
      window.testProgress.push(options.onprogress);
      window.testActive++;
      window.testPeakActive = Math.max(window.testPeakActive, window.testActive);
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true; window.testActive--; callback();
      };
      const handle = { abort() { window.testAborts++; finish(() => options.onabort()); } };
      if (window.testBehavior !== 'stall') setTimeout(() => {
        options.onprogress({ loaded: 64, total: 128 });
        finish(() => window.testBehavior === 'fail' ? options.onerror() : options.onload({
          status: 200,
          response: new Blob([`media bytes: ${options.url}`], { type: options.url.endsWith('.png') ? 'image/png' : 'video/mp4' }),
          responseHeaders: 'Content-Disposition: attachment; filename="ef0d106b-470a-4fa3-879d-3f52582dedd4.mp4"',
        }));
      }, 40);
      return handle;
    };
    window.GM_download = (options) => {
      window.testCalls.push({ url: options.url, name: options.name });
      window.testProgress.push(options.onprogress);
      window.testActive++;
      window.testPeakActive = Math.max(window.testPeakActive, window.testActive);
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true; window.testActive--; callback();
      };
      const handle = { abort() { window.testAborts++; finish(() => options.onerror({ error: 'cancelled' })); } };
      if (window.testBehavior !== 'stall') setTimeout(() => {
        options.onprogress({ loaded: 64, total: 128 });
        finish(() => window.testBehavior === 'fail' ? options.onerror({ error: 'not_succeeded' }) : options.onload());
      }, 40);
      return handle;
    };
  });
  const script = await fs.readFile(path.join(__dirname, 'huasheng-clips.user.js'), 'utf8');
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: '分镜片段下载', exact: true }).click();
  await page.getByRole('combobox', { name: '保存方式' }).selectOption(destination);
  await page.getByRole('button', { name: '读取分镜', exact: true }).click();
  await page.waitForFunction((count) => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelectorAll('tbody tr').length === count, project.clips.length);
  return { page, errors, requests };
}

for (const destination of ['browser', 'folder']) {
  test(`${destination} mode starts every selected transfer before any finishes`, async (t) => {
    const project = {
      project: fixture.project,
      clips: [
        ...Array.from({ length: 24 }, (_, i) => ({ id: `clip-${i}`, idx: String(i + 1), content: `片段 ${i + 1}`, video: { url: `https://media.example/${i}.mp4` } })),
        { id: 'unavailable', idx: '25', content: '未生成素材' },
      ],
    };
    const { page, errors } = await setup(t, undefined, destination, project);
    await page.getByRole('checkbox', { name: '选择分镜 24', exact: true }).uncheck();
    await page.evaluate(() => { window.testBehavior = 'stall'; });
    await page.getByRole('button', { name: '下载所选', exact: true }).click();
    await page.waitForFunction(() => window.testActive >= 2);
    const transfers = await page.evaluate(() => ({ active: window.testActive, peak: window.testPeakActive, count: window.testCalls.length + window.testBlobCalls.length }));
    assert.deepEqual(transfers, { active: 23, peak: 23, count: 23 }, 'all selected assets start without waiting for an earlier transfer');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#download').disabled);
    assert.equal(await page.evaluate(() => window.testAborts), 23);
    assert.equal(await page.evaluate(() => window.testActive), 0);
    assert.deepEqual(errors, []);
  });
}

test('coalesces a burst of progress events into one list refresh per animation frame', async (t) => {
  const { page, errors } = await setup(t, undefined, 'folder');
  await page.evaluate(() => { window.testBehavior = 'stall'; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => window.testActive >= 2);
  const refreshes = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const tbody = document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('tbody');
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(tbody, { childList: true });
    for (let i = 0; i < 100; i++) {
      for (const progress of window.testProgress) progress({ loaded: i + 1, total: 100 });
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    observer.disconnect();
    return count;
  });
  assert.equal(refreshes, 1);
  assert.match(await page.locator('tbody tr').first().innerText(), /100%/);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#download').disabled);
  assert.deepEqual(errors, []);
});

test('panel downloads sorted selected assets, retries failures and exports complete manifest', async (t) => {
  const { page, errors } = await setup(t);
  assert.match(await page.locator('#summary').innerText(), /可下载 3/);
  assert.match(await page.locator('tbody tr').first().innerText(), /工业革命/);
  for (const selector of ['h2', 'tbody tr:first-child td:nth-child(3)']) {
    const channels = await page.locator(selector).evaluate((element) => getComputedStyle(element).color.match(/\d+/g).slice(0, 3).map(Number));
    assert.ok(channels.every((value) => value >= 180), 'panel text remains readable on its dark background');
  }
  assert.equal(await page.getByRole('checkbox', { name: '选择分镜 4', exact: true }).isDisabled(), true);
  assert.match(await page.locator('#notice').innerText(), /源文件/);
  await page.evaluate(() => { window.testBehavior = 'fail'; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#summary').textContent.includes('失败 3'));
  await page.evaluate(() => { window.testBehavior = 'success'; });
  await page.getByRole('button', { name: '重试失败', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#summary').textContent.includes('完成 3'));
  const calls = await page.evaluate(() => window.testCalls);
  assert.equal(calls.length, 6);
  assert.match(calls[0].name, /^001_/);
  assert.equal(calls[0].url, 'https://media.example/a-render.mp4');
  assert.equal(calls[2].url, 'https://media.example/still.png');
  assert.equal(await page.evaluate(() => window.testPeakActive), 3);
  assert.equal(await page.getByRole('button', { name: '下载所选', exact: true }).isDisabled(), true);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出清单', exact: true }).click();
  const download = await downloadEvent;
  const manifest = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(manifest.clips.length, 4);
  assert.equal(manifest.clips[0].clipId, 'a');
  assert.equal(manifest.clips[0].metadata.video.start_time, 3);
  assert.equal(manifest.clips[3].status, 'unavailable');
  assert.deepEqual(errors, []);
});

test('stop aborts active transfers and leaves the queue available for another attempt', async (t) => {
  const { page, errors } = await setup(t);
  await page.evaluate(() => { window.testBehavior = 'stall'; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => window.testActive === 3);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#download').disabled);
  assert.equal(await page.evaluate(() => window.testAborts), 3);
  assert.equal(await page.evaluate(() => window.testCalls.length), 3, 'all selected downloads were started and aborted');
  assert.match(await page.locator('#summary').innerText(), /失败 0/);
  await page.evaluate(() => { window.testBehavior = 'success'; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#summary').textContent.includes('完成 3'));
  assert.deepEqual(errors, []);
});

test('voice mode and SPA project navigation do not mix project state', async (t) => {
  const { page, errors } = await setup(t);
  await page.getByRole('combobox', { name: '素材类型' }).selectOption('voice');
  assert.match(await page.locator('#summary').innerText(), /可下载 2/);
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#summary').textContent.includes('完成 2'));
  const calls = await page.evaluate(() => window.testCalls);
  assert.equal(calls[0].url, 'https://media.example/a.mp3');
  await page.evaluate(() => history.pushState({}, '', '/video/111'));
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#project').textContent.includes('111'));
  assert.equal(await page.locator('tbody tr').count(), 0);
  await page.evaluate(() => history.pushState({}, '', '/'));
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').hidden);
  assert.deepEqual(errors, []);
});

test('sandbox API selection, denied login and mobile layout are handled', async (t) => {
  const { page, errors } = await setup(t, { width: 390, height: 844 });
  const requests = [];
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    return route.fulfill({ json: pathname.includes('/v2/') ? { code: 0, data: fixture } : { project: { ...fixture.project, is_agent_sandbox: true } } });
  });
  await page.getByRole('button', { name: '读取分镜', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#scan').disabled);
  assert.deepEqual(requests, ['/api/innovideo/project/info', '/api/v2/innovideo/project/info']);
  const panel = await page.locator('#panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390);
  assert.ok(panel.y >= 0 && panel.y + panel.height <= 844);
  const overflow = await page.locator('#panel').evaluate((element) => element.scrollWidth > element.clientWidth);
  assert.equal(overflow, false);
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'huasheng-clips-qa-'));
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  t.diagnostic(`Screenshots: ${artifacts}`);
  await page.route('**/api/**', (route) => route.fulfill({ json: { code: 403, message: '权限不足' } }));
  await page.getByRole('button', { name: '读取分镜', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#notice').textContent.includes('权限不足'));
  assert.equal(await page.locator('tbody tr').count(), 0);
  assert.equal(await page.getByRole('button', { name: '下载所选', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('folder mode writes exact ordered names and bytes despite UUID attachment headers', async (t) => {
  const { page, errors } = await setup(t, { width: 1440, height: 1000 }, 'folder');
  await page.evaluate(() => { window.GM_info.downloadMode = 'disabled'; });
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#notice').textContent.includes('3 个成功'));
  const saved = await page.evaluate(async () => {
    const projects = [];
    for await (const [name] of window.testRoot.entries()) projects.push(name);
    const project = await window.testRoot.getDirectoryHandle(projects[0]);
    const directory = await project.getDirectoryHandle('时间轴片段');
    const files = {};
    for await (const [name, handle] of directory.entries()) files[name] = await (await handle.getFile()).text();
    return { projects, files, nativeDownloads: window.testCalls, peak: window.testPeakActive };
  });
  assert.equal(saved.projects.length, 1);
  assert.match(saved.projects[0], new RegExp(`_${pid}$`));
  const filenames = Object.keys(saved.files).sort();
  assert.deepEqual(filenames.filter((name) => /^\d/.test(name)), [
    '001_工业革命为什么先发生在英国，而不是中国？.mp4',
    '002_这个问题，不能简单归结为哪个民族更聪明、哪种文化更先进。.mp4',
    '003_一幅历史图片，也可能是分镜的源素材。.png',
  ]);
  assert.equal(saved.files[filenames[0]], 'media bytes: https://media.example/a-render.mp4');
  assert.deepEqual(saved.nativeDownloads, [], 'folder mode bypasses browser download naming entirely');
  assert.equal(saved.peak, 3);
  const manifest = JSON.parse(saved.files['分镜清单.json']);
  assert.equal(manifest.clips[0].savedFilename, filenames[0]);
  assert.equal(manifest.clips[3].status, 'unavailable');
  await page.getByRole('button', { name: '更换文件夹', exact: true }).click();
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#notice').textContent.includes('3 个成功'));
  const duplicates = await page.evaluate(async () => {
    const names = [];
    for await (const [, project] of window.testRoot.entries()) {
      const directory = await project.getDirectoryHandle('时间轴片段');
      for await (const [name] of directory.entries()) names.push(name);
    }
    return names;
  });
  assert.ok(duplicates.includes('001_工业革命为什么先发生在英国，而不是中国？ (2).mp4'));
  assert.ok(duplicates.includes('分镜清单 (2).json'));
  assert.deepEqual(errors, []);
});

test('folder picker cancellation starts no downloads; stopping requests leaves no partial media', async (t) => {
  const { page, errors } = await setup(t, { width: 1440, height: 1000 }, 'folder');
  await page.evaluate(() => { window.testPickerCancelled = true; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#notice').textContent.includes('未更换'));
  assert.equal(await page.evaluate(() => window.testBlobCalls.length + window.testCalls.length), 0);
  await page.evaluate(() => { window.testPickerCancelled = false; window.testBehavior = 'stall'; });
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.waitForFunction(() => window.testActive === 3);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#huasheng-clip-downloader').shadowRoot.querySelector('#download').disabled);
  assert.equal(await page.evaluate(() => window.testAborts), 3);
  const files = await page.evaluate(async () => {
    const names = [];
    for await (const [, project] of window.testRoot.entries()) {
      const directory = await project.getDirectoryHandle('时间轴片段');
      for await (const [name] of directory.entries()) names.push(name);
    }
    return names;
  });
  assert.deepEqual(files, ['分镜清单.json']);
  assert.deepEqual(errors, []);
});
