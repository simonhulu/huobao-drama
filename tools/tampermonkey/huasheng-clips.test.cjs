const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./huasheng-clips.user.js');

// Representative API shapes from the public editor bundle; no account data.
const fixture = () => ({
  project: { pid: '258950566158483', name: '工业革命为什么先发生在英国？' },
  clips: [
    { id: 'second', idx: '2', content: '第二段', voice: { url: 'https://cdn.example/voice2.wav', duration: 7 }, video: { id: 'raw2', url: 'https://cdn.example/source2.mp4', duration: 30 }, composite_video: { id: 'render2', url: 'https://cdn.example/render2.mp4?sign=a%2Fb&token=123', duration: 12 } },
    { id: 'first', idx: '1', content: '第一段', content_edit: '修改后的第一段', voice: { url: 'https://cdn.example/voice1.mp3', duration: 5 }, video: { id: 'raw1', url: 'https://cdn.example/source1.mp4', start_time: 2, duration: 20 }, composite_video: { id: 'render1', url: 'https://cdn.example/render1.mp4', duration: 8 } },
  ],
});

test('project IDs stay as strings and only editor routes match', () => {
  assert.equal(core.projectId('/video/258950566158483'), '258950566158483');
  assert.equal(core.projectId('/video/123/'), '123');
  assert.equal(core.projectId('/video/123/other'), '');
  assert.equal(core.projectId('/'), '');
});

test('unwraps both editor API envelopes and rejects denied or malformed responses', () => {
  const data = fixture();
  assert.equal(core.unwrapProject(data), data);
  assert.equal(core.unwrapProject({ code: 0, data }), data);
  assert.throws(() => core.unwrapProject({ code: 403, message: '权限不足' }), /权限不足/);
  assert.throws(() => core.unwrapProject({ code: 0, data: {} }), /项目/);
  assert.throws(() => core.getRows({ project: {} }, '123'), /clips/);
  assert.throws(() => core.getRows({ clips: [null] }, '123'), /格式/);
});

test('sorts numeric idx, prefers edited text and preserves signed URL query', () => {
  const data = fixture();
  const rows = core.getRows(data, data.project.pid);
  assert.deepEqual(rows.map((row) => row.clipId), ['first', 'second']);
  assert.equal(data.clips[0].id, 'second', 'does not reorder raw API data');
  assert.equal(rows[0].text, '修改后的第一段');
  assert.equal(rows[0].duration, 5, 'timeline duration is the narration duration');
  assert.equal(rows[1].url, data.clips[0].composite_video.url);
  assert.equal(rows[0].filename, '001_修改后的第一段.mp4');
  assert.match(rows[1].filename, /^002_/);
  assert.doesNotMatch(rows[0].filename, /huasheng_|258950566158483|timeline/);
  assert.equal(rows[0].basis, 'composite_video');
});

test('ppt_video overrides composite media, as in the editor store', () => {
  const data = fixture();
  data.clips[1].ppt_video = { url: 'https://cdn.example/slides.mp4', duration: 5 };
  const row = core.getRows(data, '123')[0];
  assert.equal(row.url, 'https://cdn.example/slides.mp4');
  assert.equal(row.basis, 'ppt_video');
});

test('fallback to source is explicit and preserves temporal edits in their original units', () => {
  const data = fixture();
  delete data.clips[1].composite_video;
  data.clips[1].video.duration = 3;
  data.clips[1].video_clip = JSON.stringify({ trimIn: 2000000, trimOut: 3000000 });
  const row = core.getRows(data, '123')[0];
  assert.equal(row.basis, 'source');
  assert.equal(row.playback.sourceStartSeconds, 2);
  assert.equal(row.playback.playbackRate, 0.5);
  assert.equal(row.playback.loop, true);
  assert.deepEqual(row.playback.videoClipEffect, { trimIn: 2000000, trimOut: 3000000 });
  assert.equal(row.playback.effectTimeUnit, 'microseconds');
});

test('source and voice modes choose only the selected asset, never candidate media', () => {
  const data = fixture();
  data.clips[1].candidates = [{ url: 'https://cdn.example/wrong-candidate.mp4' }];
  assert.equal(core.getRows(data, '123', 'source')[0].url, 'https://cdn.example/source1.mp4');
  assert.equal(core.getRows(data, '123', 'voice')[0].url, 'https://cdn.example/voice1.mp3');
  assert.match(core.getRows(data, '123', 'voice')[0].filename, /\.mp3$/);
  assert.throws(() => core.getRows(data, '123', 'all'), /未知/);
});

test('retains every timeline occurrence when two shots share a source', () => {
  const data = fixture();
  data.clips[0].video.url = data.clips[1].video.url;
  const rows = core.getRows(data, '123', 'source');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].filename, rows[1].filename);
});

test('images remain images; missing media and stream playlists are not fake MP4s', () => {
  const data = fixture();
  delete data.clips[1].composite_video;
  data.clips[1].video = { url: 'https://cdn.example/still.png', material_type: 2 };
  const row = core.getRows(data, '123')[0];
  assert.equal(row.kind, 'image');
  assert.match(row.filename, /\.png$/);
  assert.ok(core.mediaInfo('https://cdn.example/unknown-image', 'image').reason);
  for (const value of ['', 'blob:https://www.huasheng.cn/123', 'javascript:alert(1)', 'https://cdn.example/file.m3u8?sign=x']) {
    assert.ok(core.mediaInfo(value).reason);
  }
  assert.equal(core.mediaInfo('//cdn.example/a.webm?token=xyz').url, 'https://cdn.example/a.webm?token=xyz');
});

test('legacy CDN aliases match the editor helper without changing signatures', () => {
  assert.equal(core.mediaInfo('http://shjd-boss.bilibili.co/a.mp4?x=a%2Fb&y=2').url, 'https://boss.hdslb.com/a.mp4?x=a%2Fb&y=2');
  assert.equal(core.mediaInfo('https://jssz-boss.bilibili.co/a.mp4').url, 'https://jssz-boss.hdslb.com/a.mp4');
});

test('file names remove path separators and control characters', () => {
  assert.doesNotMatch(core.cleanName('../a/b\\c:*?\n'), /[<>:"/\\|?*\u0000-\u001f]/);
  assert.equal(core.cleanName('... '), '分镜');
  assert.equal(core.cleanName('长'.repeat(90), 45).length, 45);
  assert.equal(core.cleanName('a\u0000b'), 'a_b');
});

test('source startTime uses milliseconds; composite playback has no source start or loop', () => {
  const clip = { voice: { duration: 10 }, video: { startTime: 1500, duration: 9 } };
  assert.equal(core.playbackInfo(clip, false).sourceStartSeconds, 1.5);
  assert.equal(core.playbackInfo(clip, false).playbackRate, 0.75);
  assert.equal(core.playbackInfo(clip, true).sourceStartSeconds, 0);
  assert.equal(core.playbackInfo(clip, true).playbackRate, 1);
  assert.equal(core.playbackInfo(clip, true).loop, false);
});

test('zero or exhausted source duration matches the editor playback fallback', () => {
  for (const video of [{ duration: 0 }, { duration: 2, start_time: 2 }, { duration: 2, start_time: 3 }]) {
    const playback = core.playbackInfo({ voice: { duration: 5 }, video }, false);
    assert.equal(playback.playbackRate, 1);
    assert.equal(playback.loop, false);
  }
});

test('download completion is reported only after Tampermonkey onload', async () => {
  let callbacks;
  let complete = false;
  const row = core.getRows(fixture(), '123')[0];
  const pending = core.downloadFile((options) => { callbacks = options; return { abort() {} }; }, row).then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(callbacks.url, row.url);
  assert.equal(callbacks.name, row.filename);
  assert.equal(callbacks.conflictAction, 'uniquify');
  callbacks.onload();
  callbacks.onerror({ error: 'not_succeeded' });
  await pending;
  assert.equal(complete, true);
});

test('download cancellation settles once and aborts the native transfer', async () => {
  let cancel;
  let callbacks;
  let aborts = 0;
  const pending = core.downloadFile((options) => { callbacks = options; return { abort() { aborts++; callbacks.onerror({ error: 'cancelled' }); } }; }, { url: 'https://cdn.example/a.mp4', filename: 'a.mp4' }, { register: (value) => { cancel = value; } });
  cancel();
  cancel();
  await assert.rejects(pending, /已停止/);
  assert.equal(aborts, 1);
});

test('download timeouts abort the transfer and permission errors are actionable', async () => {
  let aborts = 0;
  await assert.rejects(core.downloadFile(() => ({ abort() { aborts++; } }), { url: 'https://cdn.example/a.mp4', filename: 'a.mp4' }, { timeout: 10 }), /超时/);
  assert.equal(aborts, 1);
  await assert.rejects(core.downloadFile((options) => { options.onerror({ error: 'not_whitelisted' }); }, { url: 'https://cdn.example/a.mp4', filename: 'a.mp4' }), /白名单/);
});

test('project folder names are bounded, sanitized and retain the project ID', () => {
  const data = fixture();
  assert.equal(core.folderName(data, '123'), `${data.project.name}_123`);
  assert.equal(core.folderName({ project: { name: 'a/b:c', title: 'unused' } }, '123'), 'a_b_c_123');
  assert.equal(core.folderName({ project: { title: '旧项目' } }, '123'), '旧项目_123');
  assert.equal(core.folderName({ project: {} }, '123'), '花生项目_123');
  assert.equal(core.folderName({ project: { name: '长'.repeat(70) } }, '123'), `${'长'.repeat(50)}_123`);
});

test('blob requests keep signed URLs and report progress before resolving validated media', async () => {
  let callbacks;
  const progress = [];
  const row = core.getRows(fixture(), '123')[1];
  const blob = new Blob(['video bytes'], { type: 'video/mp4' });
  const pending = core.requestBlob((options) => { callbacks = options; return { abort() {} }; }, row, {
    timeout: 12345,
    progress: (value) => progress.push(value),
  });
  assert.equal(callbacks.method, 'GET');
  assert.equal(callbacks.url, row.url);
  assert.equal(callbacks.responseType, 'blob');
  assert.equal(callbacks.timeout, 12345);
  callbacks.onprogress({ loaded: 5, total: 10, lengthComputable: true });
  callbacks.onload({ status: 200, response: blob, responseHeaders: 'Content-Type: video/mp4\r\n' });
  assert.equal(await pending, blob);
  assert.deepEqual(progress, [50]);
  callbacks.onerror({ error: 'late error' });
});

test('blob requests reject HTTP failures, empty files and HTML or JSON error documents', async () => {
  const row = { url: 'https://cdn.example/a.mp4' };
  const responses = [
    { status: 403, response: new Blob(['denied'], { type: 'video/mp4' }) },
    { status: 200, response: new Blob([], { type: 'video/mp4' }) },
    { status: 200, response: new Blob(['<html>login</html>'], { type: 'text/html' }) },
    { status: 200, response: new Blob(['{"code":403}'], { type: 'application/json' }) },
    { status: 200, response: new Blob(['<html>login</html>']), responseHeaders: 'content-type: text/html; charset=UTF-8\r\n' },
    { status: 200, response: new Blob(['{"code":403}']), responseHeaders: 'Content-Type: application/json\r\n' },
  ];
  for (const response of responses) {
    await assert.rejects(core.requestBlob((options) => {
      queueMicrotask(() => options.onload(response));
      return { abort() {} };
    }, row));
  }
});

test('blob requests cancel once and reject pre-aborted signals without starting a transfer', async () => {
  const controller = new AbortController();
  let callbacks;
  let aborts = 0;
  const pending = core.requestBlob((options) => {
    callbacks = options;
    return { abort() { aborts++; options.onabort?.(); } };
  }, { url: 'https://cdn.example/a.mp4' }, { signal: controller.signal });
  controller.abort();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(aborts, 1);
  callbacks.onload({ status: 200, response: new Blob(['late'], { type: 'video/mp4' }) });
  let requests = 0;
  await assert.rejects(core.requestBlob(() => { requests++; }, { url: 'https://cdn.example/a.mp4' }, { signal: controller.signal }));
  assert.equal(requests, 0);
});

test('blob request timeout callbacks reject without accepting late success', async () => {
  let callbacks;
  const pending = core.requestBlob((options) => { callbacks = options; return { abort() {} }; }, { url: 'https://cdn.example/a.mp4' });
  callbacks.ontimeout();
  await assert.rejects(pending);
  callbacks.onload({ status: 200, response: new Blob(['late'], { type: 'video/mp4' }) });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeDirectory(initial = {}, behavior = {}) {
  const files = new Map(Object.entries(initial).map(([name, value]) => [name, new Blob([value])]));
  const events = [];
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      events.push(['lookup', name, create]);
      if (!files.has(name)) {
        if (!create) throw new DOMException('File does not exist', 'NotFoundError');
        files.set(name, new Blob());
      }
      return {
        async createWritable() {
          events.push(['open', name]);
          if (behavior.openError) throw behavior.openError;
          let content;
          return {
            async write(blob) {
              events.push(['write', name]);
              if (behavior.write) await behavior.write(blob);
              if (behavior.writeError) throw behavior.writeError;
              content = blob;
            },
            async close() {
              events.push(['close', name]);
              if (behavior.close) await behavior.close();
              if (behavior.closeError) throw behavior.closeError;
              files.set(name, content);
            },
            async abort() {
              events.push(['abort', name]);
              if (behavior.abort) await behavior.abort();
            },
          };
        },
      };
    },
    async removeEntry(name) {
      events.push(['remove', name]);
      files.delete(name);
    },
  };
  return { directory, files, events };
}

test('folder saving picks a free ordered filename and never opens existing files for writing', async () => {
  const { directory, files, events } = fakeDirectory({ '001_text.mp4': 'original', '001_text (2).mp4': 'other original' });
  const blob = new Blob(['new media'], { type: 'video/mp4' });
  assert.equal(await core.saveBlob(directory, '001_text.mp4', blob), '001_text (3).mp4');
  assert.equal(await files.get('001_text.mp4').text(), 'original');
  assert.equal(await files.get('001_text (2).mp4').text(), 'other original');
  assert.equal(await files.get('001_text (3).mp4').text(), 'new media');
  assert.deepEqual(events.filter(([action]) => action === 'open'), [['open', '001_text (3).mp4']]);
  assert.equal(events.some(([action]) => action === 'remove'), false);
});

test('folder saving resolves only after the writable has closed', async () => {
  const closing = deferred();
  const allowClose = deferred();
  const { directory, files } = fakeDirectory({}, { close: () => { closing.resolve(); return allowClose.promise; } });
  let settled = false;
  const pending = core.saveBlob(directory, '001_text.mp4', new Blob(['media'])).then((filename) => { settled = true; return filename; });
  await closing.promise;
  assert.equal(settled, false);
  allowClose.resolve();
  assert.equal(await pending, '001_text.mp4');
  assert.equal(await files.get('001_text.mp4').text(), 'media');
});

test('failed folder writes remove only their new file and preserve colliding existing files', async () => {
  for (const stage of ['openError', 'writeError', 'closeError']) {
    const { directory, files, events } = fakeDirectory({ '001_text.mp4': 'original' }, { [stage]: new Error('disk failure') });
    await assert.rejects(core.saveBlob(directory, '001_text.mp4', new Blob(['media'])), /disk failure/);
    assert.equal(await files.get('001_text.mp4').text(), 'original');
    assert.equal(files.has('001_text (2).mp4'), false);
    assert.deepEqual(events.filter(([action]) => action === 'remove'), [['remove', '001_text (2).mp4']]);
    if (stage !== 'openError') assert.equal(events.filter(([action]) => action === 'abort').length, 1);
  }
});

test('folder save cancellation aborts and removes the partial new file', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const writing = deferred();
  const allowWrite = deferred();
  const { directory, files, events } = fakeDirectory({ '001_text.mp4': 'original' }, {
    write: () => { writing.resolve(); return allowWrite.promise; },
    abort: () => allowWrite.reject(new DOMException('Cancelled', 'AbortError')),
  });
  const pending = core.saveBlob(directory, '001_text.mp4', new Blob(['partial']), { signal: controller.signal });
  await writing.promise;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(await files.get('001_text.mp4').text(), 'original');
  assert.equal(files.has('001_text (2).mp4'), false);
  const aborted = events.filter(([action]) => action === 'abort');
  assert.ok(aborted.length > 0);
  assert.ok(aborted.every(([, name]) => name === '001_text (2).mp4'));
  assert.deepEqual(events.filter(([action]) => action === 'remove'), [['remove', '001_text (2).mp4']]);
});

test('cancelling while a file closes rejects and removes only the fresh file', async () => {
  const controller = new AbortController();
  const closing = deferred();
  const allowClose = deferred();
  const { directory, files, events } = fakeDirectory({ '001_text.mp4': 'original' }, {
    close: () => { closing.resolve(); return allowClose.promise; },
  });
  const pending = core.saveBlob(directory, '001_text.mp4', new Blob(['media']), { signal: controller.signal });
  await closing.promise;
  controller.abort();
  allowClose.resolve();
  await assert.rejects(pending);
  assert.equal(await files.get('001_text.mp4').text(), 'original');
  assert.equal(files.has('001_text (2).mp4'), false);
  assert.deepEqual(events.filter(([action]) => action === 'remove'), [['remove', '001_text (2).mp4']]);
});

test('pre-aborted folder saves do not create or remove any files', async () => {
  const controller = new AbortController();
  controller.abort();
  const { directory, files, events } = fakeDirectory({ '001_text.mp4': 'original' });
  await assert.rejects(core.saveBlob(directory, '001_text.mp4', new Blob(['media']), { signal: controller.signal }));
  assert.equal(await files.get('001_text.mp4').text(), 'original');
  assert.equal(events.some(([action, , create]) => action === 'remove' || action === 'open' || create), false);
});
