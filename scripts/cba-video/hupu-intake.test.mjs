import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fetchHupuHomepage, HUPU_HOME_API_URL} from './hupu-intake.mjs';

const raw = fs.readFileSync(new URL('./fixtures/hupu-homepage-2026-10-24.json', import.meta.url), 'utf8');
const fixture = () => JSON.parse(raw);
const response = payload => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
  status: 200, headers: {'content-type': 'application/json', date: 'Sat, 24 Oct 2026 15:24:39 GMT'},
});

test('snapshot contains every actual homepage news item in display order, including positions after 20', async () => {
  let calls = 0;
  const snapshot = await fetchHupuHomepage({fetchImpl: async (url, options) => {
    calls++; assert.equal(url, HUPU_HOME_API_URL); assert.match(url, /page=1&num=24/);
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.ok(options.signal instanceof AbortSignal);
    return response(raw);
  }});
  assert.equal(calls, 1); assert.equal(snapshot.total, 24); assert.equal(snapshot.rawCount, 24);
  assert.equal(snapshot.duplicateCount, 0);
  assert.deepEqual(snapshot.items.map(item => item.apiIndex), [0, 1, 6, 7, 8, 9, 10, 11, 2, 3, 12, 13, 14, 15, 16, 17, 4, 5, 18, 19, 20, 21, 22, 23]);
  assert.equal(snapshot.items[0].url, 'https://bbs.hupu.com/643239523.html');
  assert.match(snapshot.items[0].title, /李昂.*首次两连胜/);
  assert.match(snapshot.items[3].title, /赵柏清/);
  assert.match(snapshot.items[20].title, /古德温/);
  assert.match(snapshot.items[23].title, /广东.*防守/);
  assert.equal(snapshot.evidence.rawBody, raw);
  assert.equal(snapshot.evidence.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(snapshot.evidence.responseDate, 'Sat, 24 Oct 2026 15:24:39 GMT');
  assert.ok(Number.isFinite(Date.parse(snapshot.retrievedAt)));
});

test('uptime is retained as update time and never invented as publication or match date', async () => {
  const snapshot = await fetchHupuHomepage({fetchImpl: async () => response(raw)});
  const item = snapshot.items.find(item => item.postId === '643239011');
  assert.equal(item.newsId, '4988188');
  assert.equal(item.publishedAt, null);
  assert.equal(item.updatedAt, '2026-10-24T13:31:59.000Z');
  assert.equal(item.matchDate, undefined);
});

test('only canonical URL duplicates are merged; same-game distinct stories remain separate', async () => {
  const payload = fixture();
  payload.result.data[1].originLink = payload.result.data[0].originLink.replace('https:', 'http:') + '?from=share#top';
  const snapshot = await fetchHupuHomepage({fetchImpl: async () => response(payload)});
  assert.equal(snapshot.total, 23); assert.equal(snapshot.rawCount, 24); assert.equal(snapshot.duplicateCount, 1);
  assert.deepEqual(snapshot.items[0].duplicatePositions, [2]);
  assert.ok(snapshot.items.some(item => item.postId === '643240475'), '李昂采访保留');
  assert.ok(snapshot.items.some(item => item.postId === '643238746'), '同场塔克最后一投保留');
  assert.equal(JSON.parse(snapshot.evidence.rawBody).result.data.length, 24);
});

test('HTTP, business, malformed JSON, and partial lists cannot masquerade as a completed scan', async () => {
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => new Response('unavailable', {status: 503})}), /HTTP 503/);
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response({status: 500, result: {data: []}})}), /业务失败/);
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response('<html>login</html>')}), /有效 JSON/);
  for (const count of [0, 20, 23, 25]) {
    const payload = fixture(); payload.result.data = payload.result.data.slice(0, count);
    if (count === 25) payload.result.data.push(payload.result.data[0]);
    await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response(payload)}), /预期24条/);
  }
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response({status: 200})}), /无列表/);
});

test('a non-news or missing link/title cannot be silently dropped from coverage', async () => {
  for (const link of ['', 'kanqiu://bbs/topic/643239523', 'https://bbs.hupu.com/', 'https://bbs.hupu.com/cba',
    'https://bbs.hupu.com/643239523-2.html', 'https://bbs.hupu.com.evil.example/643239523.html',
    'https://user:pass@bbs.hupu.com/643239523.html', 'https://bbs.hupu.com:8443/643239523.html']) {
    const payload = fixture(); payload.result.data[0].originLink = link;
    await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response(payload)}), /不是可读取的新闻正文链接/);
  }
  for (const field of ['title', 'nid']) {
    const payload = fixture(); delete payload.result.data[0][field];
    await assert.rejects(fetchHupuHomepage({fetchImpl: async () => response(payload)}), /缺少标题或新闻标识/);
  }
});

test('network and timeout errors explain that no fresh scan completed', async () => {
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => { throw Error('ECONNRESET'); }}), /连接或读取失败.*未完成扫描/);
  // An external fetch can fail with TimeoutError as well as the local abort signal.
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); }}), /获取超时/);
  await assert.rejects(fetchHupuHomepage({fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(Error('body interrupted')); },
  }))}), /连接或读取失败/);
});
