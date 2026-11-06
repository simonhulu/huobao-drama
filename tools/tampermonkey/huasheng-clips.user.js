// ==UserScript==
// @name         花生 AI 分镜片段下载
// @namespace    huobao-drama/huasheng-clips
// @version      1.2.0
// @description  全部并发下载当前项目的分镜片段、原始画面或配音，按时间轴顺序命名并导出素材清单。
// @match        https://www.huasheng.cn/*
// @match        https://huasheng.cn/*
// @run-at       document-idle
// @noframes
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const MODES = { timeline: '时间轴片段', source: '原始画面素材', voice: '分镜配音' };
  const EXTENSIONS = {
    video: new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']),
    audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']),
    image: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']),
  };

  function projectId(pathname) {
    return /^\/video\/(\d+)\/?$/.exec(pathname)?.[1] || '';
  }

  function cleanName(value, limit = 60) {
    return Array.from(String(value ?? '').normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim())
      .slice(0, limit).join('') || '分镜';
  }

  function folderName(data, pid) {
    return `${cleanName(data.project.name || data.project.title || '花生项目', 50)}_${pid}`;
  }

  function unwrapProject(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('项目接口未返回 JSON 对象。');
    if (payload.code !== undefined && ![0, 200, '0', '200'].includes(payload.code)) {
      throw new Error(payload.message || payload.reason || `项目接口错误：${payload.code}`);
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!data.project || typeof data.project !== 'object') throw new Error('未找到项目数据，请确认登录和项目权限。');
    return data;
  }

  function mediaInfo(value, fallbackKind = 'video') {
    if (typeof value !== 'string' || !value.trim()) return { url: '', kind: fallbackKind, extension: '', reason: '暂无可下载地址' };
    let url;
    try { url = new URL(value.startsWith('//') ? `https:${value}` : value); }
    catch { return { url: '', kind: fallbackKind, extension: '', reason: '素材地址格式无效' }; }
    if (!['https:', 'http:'].includes(url.protocol)) {
      return { url: '', kind: fallbackKind, extension: '', reason: '素材不是可直接下载的 HTTP 文件' };
    }
    // Use the same legacy CDN aliases as the editor's playback URL helper.
    url.protocol = 'https:';
    if (url.hostname === 'shjd-boss.bilibili.co') url.hostname = 'boss.hdslb.com';
    if (url.hostname === 'jssz-boss.bilibili.co') url.hostname = 'jssz-boss.hdslb.com';
    // Preserve the original query string: CDN signatures are sensitive to rewrites.
    const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1].toLowerCase() || '';
    if (['m3u8', 'mpd', 'm4s', 'ts'].includes(extension)) {
      return { url: url.href, kind: fallbackKind, extension, reason: '流媒体地址，不能直接另存为完整视频' };
    }
    const kind = Object.keys(EXTENSIONS).find((key) => EXTENSIONS[key].has(extension)) || fallbackKind;
    if (kind === 'image' && !EXTENSIONS.image.has(extension)) {
      return { url: url.href, kind, extension: '', reason: '图片地址没有可识别的文件扩展名，请从清单查看源地址' };
    }
    return { url: url.href, kind, extension: extension && EXTENSIONS[kind].has(extension) ? extension : (kind === 'audio' ? 'mp3' : 'mp4'), reason: '' };
  }

  function parseEffect(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  function playbackInfo(clip, composite) {
    const video = clip.video || {};
    const duration = Number(clip.voice?.duration) || null;
    const start = Number(video.start_time) > 0 ? Number(video.start_time) : Math.max(0, Number(video.startTime) / 1000 || 0);
    const available = Number(video.duration) - start;
    const ratio = duration > 0 && Number.isFinite(available) && available > 0 ? available / duration : 1;
    return {
      timelineDurationSeconds: duration,
      sourceStartSeconds: composite ? 0 : start,
      playbackRate: composite ? 1 : Math.min(1, Math.max(ratio, 0.5)),
      loop: !composite && ratio < 0.5,
      videoClipEffect: parseEffect(clip.video_clip),
      audioClipEffect: parseEffect(clip.audio_clip),
      effectTimeUnit: 'microseconds',
    };
  }

  function getRows(data, pid, mode = 'timeline') {
    if (!Array.isArray(data.clips)) throw new Error('项目响应缺少 clips 分镜列表，未执行下载。');
    if (!(mode in MODES)) throw new Error('未知的素材模式。');
    // The editor store sorts by idx; API array order is not necessarily timeline order.
    const clips = data.clips.slice();
    if (clips.some((clip) => !clip || typeof clip !== 'object')) throw new Error('分镜数据格式无效。');
    clips.sort((a, b) => (Number.parseFloat(a.idx) - Number.parseFloat(b.idx)) || 0);
    return clips.map((clip, position) => {
      const composite = clip.ppt_video || clip.composite_video;
      const source = clip.video;
      const voice = clip.voice;
      const useComposite = Boolean(composite?.url);
      const selected = mode === 'voice' ? voice : mode === 'source' ? source : useComposite ? composite : source;
      const media = mediaInfo(selected?.url, mode === 'voice' ? 'audio' : Number(selected?.material_type) === 2 ? 'image' : 'video');
      const order = position + 1;
      const text = String(clip.content_edit ?? clip.content ?? '');
      const clipId = String(clip.id ?? clip.clip_id ?? position);
      return {
        key: `${pid}:${mode}:${clipId}:${position}`,
        order, clipId, text, mode, ...media,
        assetId: String(selected?.id ?? ''),
        basis: mode === 'voice' ? 'voice' : mode === 'source' || !useComposite ? 'source' : clip.ppt_video ? 'ppt_video' : 'composite_video',
        duration: Number(voice?.duration ?? selected?.duration ?? clip.duration) || null,
        sourceUrl: source?.url || '',
        compositeUrl: composite?.url || '',
        voiceUrl: voice?.url || '',
        filename: `${String(order).padStart(Math.max(3, String(clips.length).length), '0')}_${cleanName(text, 45)}.${media.extension || 'mp4'}`,
        selected: Boolean(media.url && !media.reason),
        status: media.reason ? 'unavailable' : 'pending',
        message: media.reason || '',
        playback: playbackInfo(clip, mode === 'timeline' && useComposite),
        metadata: clip,
      };
    });
  }

  function describeDownloadError(error) {
    const code = error?.error || error?.message || String(error || '下载失败');
    const descriptions = {
      not_enabled: '请在 Tampermonkey 设置中启用下载功能，选择“浏览器 API”模式。',
      not_whitelisted: '请在 Tampermonkey 的下载扩展名白名单中加入该文件扩展名。',
      not_permitted: '请为 Tampermonkey 授予浏览器“下载”权限。',
      not_supported: '当前浏览器不支持 Tampermonkey 下载，请使用桌面 Chrome 或 Edge。',
      not_succeeded: '下载失败；地址可能过期，请重新读取分镜后重试，并检查浏览器下载记录。',
    };
    return descriptions[code] || String(code);
  }

  function downloadFile(download, row, { progress = () => {}, register = () => {}, timeout = 180000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const cancel = () => {
        if (settled) return;
        finish(new Error('已停止'));
        try { handle?.abort?.(); } catch { /* Already completed. */ }
      };
      const timer = setTimeout(() => {
        finish(new Error('下载超时，请检查网络后重试。'));
        try { handle?.abort?.(); } catch { /* Already completed. */ }
      }, timeout);
      try {
        handle = download({
          url: row.url, name: row.filename, saveAs: false, conflictAction: 'uniquify',
          headers: { Referer: 'https://www.huasheng.cn/' },
          onload: () => finish(),
          onerror: (error) => finish(new Error(describeDownloadError(error))),
          ontimeout: () => finish(new Error('下载超时，请重新读取分镜后重试。')),
          onprogress: (event) => {
            if (!settled && event.total > 0) progress(Math.min(100, Math.round(event.loaded / event.total * 100)));
          },
        });
        register(cancel);
      } catch (error) { finish(error); }
    });
  }

  function requestBlob(request, row, { signal, progress = () => {}, timeout = 180000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('已停止')); return; }
      let settled = false;
      let handle;
      const finish = (error, blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(blob);
      };
      const cancel = () => {
        if (settled) return;
        finish(new Error('已停止'));
        try { handle?.abort?.(); } catch { /* Already completed. */ }
      };
      const timer = setTimeout(() => {
        finish(new Error('下载超时，请检查网络后重试。'));
        try { handle?.abort?.(); } catch { /* Already completed. */ }
      }, timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        handle = request({
          method: 'GET', url: row.url, responseType: 'blob', timeout,
          headers: { Referer: 'https://www.huasheng.cn/' },
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              finish(new Error(`素材下载失败（HTTP ${response.status}），请重新读取分镜后重试。`)); return;
            }
            const blob = response.response;
            if (!blob || !(blob.size > 0)) { finish(new Error('素材返回空文件。')); return; }
            if (/text\/html|application\/(?:[\w.+-]*\+)?json/i.test(`${blob.type || ''}\n${response.responseHeaders || ''}`)) {
              finish(new Error('素材返回了网页或错误信息，请重新读取分镜后重试。')); return;
            }
            finish(null, blob);
          },
          onerror: () => finish(new Error('素材请求失败，请检查网络和 Tampermonkey 的网站访问权限。')),
          onabort: () => finish(new Error('已停止')),
          ontimeout: () => finish(new Error('下载超时，请重新读取分镜后重试。')),
          onprogress: (event) => {
            if (!settled && event.total > 0) progress(Math.min(100, Math.round(event.loaded / event.total * 100)));
          },
        });
        if (signal?.aborted) handle?.abort?.();
      } catch (error) { finish(error); }
    });
  }

  async function saveBlob(directory, filename, blob, { signal } = {}) {
    const checkStopped = () => { if (signal?.aborted) throw new Error('已停止'); };
    checkStopped();
    const match = /^(.*)(\.[^.]+)$/.exec(filename);
    const stem = match ? match[1] : filename;
    const extension = match ? match[2] : '';
    let target = filename;
    for (let suffix = 2; ; suffix++) {
      checkStopped();
      try { await directory.getFileHandle(target); }
      catch (error) {
        if (error.name === 'NotFoundError') break;
        if (error.name !== 'TypeMismatchError') throw error;
      }
      target = `${stem} (${suffix})${extension}`;
    }
    checkStopped();
    let created = false;
    let writer;
    const abortWriter = () => {
      try { if (writer) Promise.resolve(writer.abort()).catch(() => {}); } catch { /* Already closed. */ }
    };
    try {
      const file = await directory.getFileHandle(target, { create: true });
      created = true;
      checkStopped();
      writer = await file.createWritable();
      signal?.addEventListener('abort', abortWriter, { once: true });
      checkStopped();
      await writer.write(blob);
      checkStopped();
      await writer.close();
      checkStopped();
      return target;
    } catch (error) {
      try { await writer?.abort(); } catch { /* The stream may already be aborted. */ }
      if (created) {
        try { await directory.removeEntry(target); } catch { /* Preserve the original write error. */ }
      }
      if (signal?.aborted) throw new Error('已停止');
      throw error;
    } finally { signal?.removeEventListener('abort', abortWriter); }
  }

  const core = { projectId, cleanName, folderName, unwrapProject, mediaInfo, parseEffect, playbackInfo, getRows, describeDownloadError, downloadFile, requestBlob, saveBlob };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }

  const state = { pid: '', mode: 'timeline', destination: 'folder', root: null, choosing: false, data: null, rows: [], scanning: false, running: false, stopped: false, scanToken: 0, active: new Map() };
  const host = document.createElement('div');
  host.id = 'huasheng-clip-downloader';
  host.style.cssText = 'position:fixed;top:84px;right:16px;z-index:2147483647;color-scheme:dark;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; color:#f0f0f2; }
      * { box-sizing:border-box; } [hidden] { display:none !important; }
      button,select,input { font:inherit; } button,select { border:1px solid #555; border-radius:5px; color:#f6f6f6; background:#303033; padding:6px 10px; }
      button { cursor:pointer; } button:hover:enabled { background:#454549; } button:disabled { opacity:.45; cursor:default; }
      button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid #bf9cff; outline-offset:2px; }
      #toggle { display:flex;align-items:center;gap:7px;box-shadow:0 2px 10px #0005; }
      .icon { width:17px;height:20px;font:20px/20px sans-serif;text-align:center;flex-shrink:0; }
      #panel { width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 144px);margin-top:8px;display:flex;flex-direction:column;border:1px solid #555;border-radius:7px;background:#202022;box-shadow:0 8px 32px #0006; }
      header { display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #414143;gap:12px; }
      h2 { margin:0;font-size:15px;line-height:1.4; } #project { color:#aaa;font-size:11px;overflow-wrap:anywhere; }
      #close { width:30px;height:30px;padding:5px;flex-shrink:0; }
      .controls { display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:10px 14px; }
      .destination { padding-top:0; } #location { margin:0;padding:0 14px 10px;color:#bcdcc9;font-size:12px;overflow-wrap:anywhere; }
      #download { background:#7652a6;border-color:#9a73ca; } #download:hover:enabled { background:#8962bb; }
      #summary { padding:0 14px 8px;color:#c5c5c8; } #notice { margin:0;padding:0 14px 10px;overflow-wrap:anywhere;white-space:pre-wrap;color:#ddd; }
      .table { overflow:auto;min-height:80px;max-height:48dvh;border-top:1px solid #414143; }
      table { border-collapse:collapse;width:100%;table-layout:fixed; } th,td { border-bottom:1px solid #38383c;padding:8px 5px;text-align:left;vertical-align:top;overflow-wrap:anywhere; }
      th { font-weight:500;color:#bbb;position:sticky;top:0;background:#29292c;z-index:1; } th:first-child,td:first-child { width:32px;text-align:center; } th:nth-child(2) { width:48px; } th:nth-child(4) { width:56px; } th:last-child { width:130px; }
      input[type=checkbox] { width:15px;height:15px;margin:3px 0;accent-color:#b78be9;cursor:pointer; }
      .text { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal; } .kind { font-size:11px;color:#aaa; }
      .done { color:#77d6a5; } .failed { color:#ffb38e; } .unavailable { color:#aaa; } .downloading { color:#c7adf1; }
      footer { padding:9px 14px;color:#aaa;font-size:11px; } #empty { padding:24px 14px;text-align:center;color:#aaa; }
      @media (max-width:480px) { :host { font-size:12px; } .controls { gap:6px;padding:10px; } th:last-child { width:98px; } th:nth-child(4) { width:45px; } #project { max-width:240px; } }
    </style>
    <button id="toggle" title="分镜片段下载" aria-label="分镜片段下载" aria-expanded="false">
      <span class="icon" aria-hidden="true">&#8595;</span>分镜下载
    </button>
    <section id="panel" hidden aria-label="花生分镜下载">
      <header><div><h2>分镜下载</h2><div id="project"></div></div><button id="close" title="收起" aria-label="收起下载面板"><span class="icon" aria-hidden="true">&#215;</span></button></header>
      <div class="controls">
        <button id="scan">读取分镜</button>
        <select id="mode" aria-label="素材类型"><option value="timeline">时间轴片段</option><option value="source">原始画面素材</option><option value="voice">分镜配音</option></select>
        <button id="download" disabled>下载所选</button><button id="retry" disabled>重试失败</button><button id="stop" disabled>停止</button><button id="manifest" disabled>导出清单</button>
      </div>
      <div class="controls destination"><select id="destination" aria-label="保存方式"><option value="folder">指定文件夹</option><option value="browser">浏览器下载目录</option></select><button id="choose">选择文件夹</button></div>
      <p id="location"></p>
      <div id="summary" role="status" aria-live="polite">尚未读取分镜</div><p id="notice" role="status"></p>
      <div class="table"><table hidden><thead><tr><th><input id="all" type="checkbox" aria-label="全选分镜"></th><th>分镜</th><th>文稿</th><th>时长</th><th>下载状态</th></tr></thead><tbody></tbody></table><div id="empty">尚无分镜</div></div>
      <footer id="footer"></footer>
    </section>`;
  document.documentElement.append(host);
  const $ = (selector) => shadow.querySelector(selector);
  const notice = (text) => { $('#notice').textContent = text; };
  const statusLabels = { pending: '待下载', done: '已下载', failed: '失败', unavailable: '不可下载', downloading: '下载中' };
  const folderSupported = typeof window.showDirectoryPicker === 'function';
  if (!folderSupported) { state.destination = 'browser'; $('#destination').value = 'browser'; }

  function setOpen(open) {
    $('#panel').hidden = !open;
    $('#toggle').setAttribute('aria-expanded', String(open));
  }

  let renderFrame = 0;
  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
  }

  function render() {
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
    const available = state.rows.filter((row) => row.status !== 'unavailable');
    const selected = available.filter((row) => row.selected);
    const done = state.rows.filter((row) => row.status === 'done').length;
    const failed = state.rows.filter((row) => row.status === 'failed').length;
    $('#project').textContent = state.data ? String(state.data.project.name || state.data.project.title || `项目 ${state.pid}`) : `项目 ${state.pid}`;
    $('#summary').textContent = state.scanning ? '正在读取项目…' : `共 ${state.rows.length} 个分镜 · 可下载 ${available.length} · 已选 ${selected.length} · 完成 ${done} · 失败 ${failed}`;
    $('#scan').disabled = state.scanning || state.running || state.choosing;
    $('#mode').disabled = state.scanning || state.running || state.choosing;
    $('#destination').disabled = state.running || state.choosing;
    $('#choose').disabled = !folderSupported || state.destination !== 'folder' || state.running || state.choosing;
    $('#choose').textContent = state.choosing ? '正在选择…' : state.root ? '更换文件夹' : '选择文件夹';
    $('#download').disabled = state.scanning || state.running || state.choosing || !selected.some((row) => row.status !== 'done');
    $('#retry').disabled = state.scanning || state.running || state.choosing || !failed;
    $('#stop').disabled = !state.running || state.stopped;
    $('#manifest').disabled = !state.data || state.scanning || state.running || state.choosing;
    $('#all').disabled = state.running || !available.length;
    $('#all').checked = available.length > 0 && selected.length === available.length;
    $('#all').indeterminate = selected.length > 0 && selected.length < available.length;
    $('table').hidden = !state.rows.length;
    $('#empty').hidden = Boolean(state.rows.length);
    $('#footer').textContent = `${MODES[state.mode]} · 项目 ${state.pid} · ${state.running ? '正在下载' : '001、002… 按时间轴顺序命名'}`;
    $('#location').textContent = state.destination === 'folder'
      ? state.root ? `${state.root.name || '所选文件夹'}/${state.data ? `${folderName(state.data, state.pid)}/${MODES[state.mode]}/` : ''}` : '尚未选择文件夹'
      : folderSupported ? '浏览器下载目录' : '指定文件夹保存需要桌面 Chrome 或 Edge';
    const fragment = document.createDocumentFragment();
    for (const row of state.rows) {
      const tr = document.createElement('tr');
      const checkboxCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = row.selected;
      checkbox.disabled = state.running || row.status === 'unavailable';
      checkbox.setAttribute('aria-label', `选择分镜 ${row.order}`);
      checkbox.addEventListener('change', () => { row.selected = checkbox.checked; render(); });
      checkboxCell.append(checkbox); tr.append(checkboxCell);
      const values = [String(row.order).padStart(3, '0'), row.text || '（无文稿）', row.duration == null ? '—' : `${row.duration.toFixed(1)}s`, row.message || statusLabels[row.status]];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        const text = document.createElement('span'); text.textContent = value; td.append(text);
        if (index === 1) {
          text.className = 'text'; text.title = row.text;
          const kind = document.createElement('div'); kind.className = 'kind';
          kind.textContent = row.kind === 'image' ? '图片源文件' : row.kind === 'audio' ? '音频' : row.basis === 'source' ? '视频源文件（未裁切）' : '时间轴合成片段'; td.append(kind);
        }
        if (index === 3) { td.className = row.status; td.title = row.savedFilename || value; }
        tr.append(td);
      });
      fragment.append(tr);
    }
    $('tbody').replaceChildren(fragment);
  }

  async function readEndpoint(path, pid) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${path}?pid=${encodeURIComponent(pid)}`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`读取项目失败（HTTP ${response.status}），请确认已登录并且能打开当前项目。`);
      return unwrapProject(await response.json());
    } finally { clearTimeout(timer); }
  }

  async function scan() {
    if (state.scanning || state.running || !state.pid) return;
    const token = ++state.scanToken;
    const pid = state.pid;
    state.scanning = true; notice(''); render();
    try {
      let data = await readEndpoint('/api/innovideo/project/info', pid);
      if (data.project.is_agent_sandbox) data = await readEndpoint('/api/v2/innovideo/project/info', pid);
      if (token !== state.scanToken || pid !== state.pid) return;
      const oldRows = new Map(state.rows.map((row) => [row.key, row]));
      state.data = data;
      state.rows = getRows(data, pid, state.mode);
      for (const row of state.rows) {
        const old = oldRows.get(row.key);
        if (old && row.status !== 'unavailable') {
          row.selected = old.selected;
          if (old.status === 'done' && old.url === row.url) { row.status = 'done'; row.savedFilename = old.savedFilename; }
        }
      }
      const unavailable = state.rows.filter((row) => row.status === 'unavailable').length;
      const originals = state.rows.filter((row) => row.basis === 'source' && row.url).length;
      const notes = [];
      if (unavailable) notes.push(`${unavailable} 个分镜暂无可直接下载的文件。`);
      if (state.mode === 'timeline' && originals) notes.push(`${originals} 个分镜使用源文件，需在剪映按清单裁切或变速。`);
      if (!state.rows.length) notes.push('当前项目尚无分镜，请等待生成完成后重新读取。');
      notice(notes.join('\n'));
    } catch (error) {
      if (token !== state.scanToken) return;
      state.data = null; state.rows = [];
      notice(`读取失败：${error.message}。请先确认此页面能正常播放项目视频。`);
    } finally {
      if (token === state.scanToken) { state.scanning = false; render(); }
    }
  }

  function stop() {
    state.stopped = true;
    for (const cancel of state.active.values()) cancel();
    state.active.clear();
    notice('已停止下载；已完成的文件保留在保存目录。');
    render();
  }

  async function chooseFolder() {
    if (state.choosing || state.running) return false;
    if (!folderSupported) { notice('指定文件夹保存需要桌面 Chrome 或 Edge。'); return false; }
    state.choosing = true; render();
    try {
      state.root = await window.showDirectoryPicker({ id: 'huasheng-clips', mode: 'readwrite' });
      for (const row of state.rows) {
        if (row.status === 'done') row.status = 'pending';
        delete row.savedFilename;
      }
      notice('');
      return true;
    } catch (error) {
      notice(error.name === 'AbortError' ? '未更换保存文件夹。' : `无法选择文件夹：${error.message}`);
      return false;
    } finally { state.choosing = false; render(); }
  }

  async function outputDirectory() {
    const project = await state.root.getDirectoryHandle(folderName(state.data, state.pid), { create: true });
    return project.getDirectoryHandle(MODES[state.mode], { create: true });
  }

  function manifestBlob() {
    return new Blob([JSON.stringify({
      projectId: state.pid, title: state.data.project.name || state.data.project.title || '',
      projectUrl: `${location.origin}/video/${state.pid}`, exportedAt: new Date().toISOString(), mode: state.mode,
      clips: state.rows.map(({ key, selected, ...row }) => row),
    }, null, 2)], { type: 'application/json;charset=utf-8' });
  }

  async function start(retry = false) {
    if (state.running || state.scanning || state.choosing) return;
    const queue = state.rows.filter((row) => retry ? row.status === 'failed' : row.selected && !['done', 'unavailable'].includes(row.status));
    if (!queue.length) return;
    const pid = state.pid;
    if (state.destination === 'folder') {
      if (typeof GM_xmlhttpRequest !== 'function') { notice('请更新并保存完整的 1.2.0 脚本，授予 Tampermonkey 素材网站访问权限。'); return; }
      if (!state.root && !await chooseFolder()) return;
      if (pid !== state.pid) return;
    } else if (typeof GM_download !== 'function' || (typeof GM_info !== 'undefined' && GM_info.downloadMode === 'disabled')) {
      notice('请在 Tampermonkey 设置中启用下载功能，并选择“浏览器 API”下载模式。'); return;
    }
    state.running = true; state.stopped = false; notice(''); render();
    let directory;
    let batchError;
    const transfer = async (row) => {
      row.status = 'downloading'; row.message = '下载中'; scheduleRender();
      try {
        const progress = (percent) => { row.message = `${percent}%`; scheduleRender(); };
        if (directory) {
          const controller = new AbortController();
          state.active.set(row.key, () => controller.abort());
          const blob = await requestBlob(GM_xmlhttpRequest, row, { signal: controller.signal, progress });
          row.message = '正在写入文件'; scheduleRender();
          row.savedFilename = await saveBlob(directory, row.filename, blob, { signal: controller.signal });
        } else {
          await downloadFile(GM_download, row, { register: (cancel) => state.active.set(row.key, cancel), progress });
        }
        row.status = 'done'; row.message = '';
      } catch (error) {
        row.status = state.stopped ? 'pending' : 'failed'; row.message = state.stopped ? '' : error.message;
      } finally { state.active.delete(row.key); scheduleRender(); }
    };
    try {
      if (state.destination === 'folder') directory = await outputDirectory();
      if (!state.stopped && pid === state.pid) await Promise.all(queue.map(transfer));
      if (directory && pid === state.pid) await saveBlob(directory, '分镜清单.json', manifestBlob());
    } catch (error) { batchError = error; notice(`保存失败：${error.message}`); }
    finally {
      state.running = false;
      if (!state.stopped && !batchError) notice(`本次下载完成：${queue.filter((row) => row.status === 'done').length} 个成功，${queue.filter((row) => row.status === 'failed').length} 个失败。`);
      render();
    }
  }

  async function exportManifest() {
    if (!state.data || state.running || state.choosing) return;
    if (state.destination === 'folder') {
      if (!state.root && !await chooseFolder()) return;
      try {
        await saveBlob(await outputDirectory(), '分镜清单.json', manifestBlob());
        notice('素材清单已保存到片段所在的文件夹。');
      } catch (error) { notice(`清单保存失败：${error.message}`); }
      return;
    }
    const url = URL.createObjectURL(manifestBlob());
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `huasheng_${state.pid}_${state.mode}_manifest.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notice('素材清单已导出。');
  }

  $('#toggle').addEventListener('click', () => { setOpen($('#panel').hidden); });
  $('#close').addEventListener('click', () => setOpen(false));
  $('#scan').addEventListener('click', scan);
  $('#choose').addEventListener('click', chooseFolder);
  $('#download').addEventListener('click', () => start());
  $('#retry').addEventListener('click', () => start(true));
  $('#stop').addEventListener('click', stop);
  $('#manifest').addEventListener('click', exportManifest);
  $('#destination').addEventListener('change', () => {
    state.destination = $('#destination').value;
    for (const row of state.rows) if (row.status === 'done') { row.status = 'pending'; delete row.savedFilename; }
    notice(''); render();
  });
  $('#all').addEventListener('change', (event) => {
    for (const row of state.rows) if (row.status !== 'unavailable') row.selected = event.target.checked;
    render();
  });
  $('#mode').addEventListener('change', () => {
    state.mode = $('#mode').value;
    state.rows = state.data ? getRows(state.data, state.pid, state.mode) : [];
    notice(''); render();
  });
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开花生分镜下载', () => { if (state.pid) setOpen(true); });
  }

  function checkRoute() {
    const pid = projectId(location.pathname);
    host.hidden = !pid;
    if (pid === state.pid) return;
    if (state.running) stop();
    ++state.scanToken; state.scanning = false;
    state.pid = pid; state.data = null; state.rows = [];
    notice(''); render();
  }
  checkRoute();
  setInterval(checkRoute, 1000);
})();
