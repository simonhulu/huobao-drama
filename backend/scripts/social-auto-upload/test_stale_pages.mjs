import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {cleanupStalePages} from './stale_pages.mjs';

const endpoint = 'http://127.0.0.1:9225';
const target = (targetId, pathname = '/builder/rc/edit', host = 'baijiahao.baidu.com') => ({
  targetId, type: 'page', url: `https://${host}${pathname}`,
});

async function fixture(t, targets, states = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sau-stale-pages-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const [i, state] of states.entries()) {
    const directory = path.join(root, 'jobs', String(i + 1));
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  }
  const calls = [];
  const browser = {
    target: () => ({createCDPSession: async () => ({
      async send(method, params) {
        calls.push({method, params});
        if (method === 'Target.getTargets') return {targetInfos: targets};
        if (method === 'Target.createTarget') return {targetId: 'NEW'};
        if (method === 'Target.closeTarget') return {success: true};
        throw new Error(`Unexpected CDP method: ${method}`);
      },
      async detach() {},
    })}),
    async disconnect() { calls.push({method: 'disconnect'}); },
  };
  let connectOptions;
  const connect = async options => { connectOptions = options; return browser; };
  return {root, calls, browser, connect, options: () => connectOptions,
    run: options => cleanupStalePages(endpoint, {stateRoot: root, ...options}, connect)};
}

test('closes a stuck old editor through the browser session and opens blank first', async t => {
  const h = await fixture(t, [target('OLD')]);
  const result = await h.run();
  assert.deepEqual(result.closedTargetIds, ['OLD']);
  assert.equal(result.createdTargetId, 'NEW');
  assert.equal(h.options().targetFilter({type: () => 'browser'}), true);
  assert.equal(h.options().targetFilter({type: () => 'page'}), false);
  assert.equal(h.options().targetFilter({type: () => 'service_worker'}), false);
  assert.deepEqual(h.calls.map(c => c.method), [
    'Target.getTargets', 'Target.createTarget', 'Target.closeTarget', 'disconnect',
  ]);
  assert.deepEqual(h.calls[1].params, {url: 'about:blank', background: true});
});

test('repeated cleanup leaves one fresh blank and preserves a checkpoint-bound blank', async t => {
  const inventory = [target('EDITOR1'), {targetId: 'OLD_BLANK', type: 'page', url: 'about:blank'},
    {targetId: 'BOUND_BLANK', type: 'page', url: 'about:blank'}];
  const h = await fixture(t, inventory, [{phase: 'opening', targetId: 'BOUND_BLANK'}]);
  const session = await h.browser.target().createCDPSession();
  let sequence = 0;
  h.browser.target = () => ({createCDPSession: async () => ({...session, async send(method, params) {
    if (method === 'Target.createTarget') {
      h.calls.push({method, params});
      const targetId = `FRESH${++sequence}`;
      inventory.push({targetId, type: 'page', url: 'about:blank'});
      return {targetId};
    }
    if (method === 'Target.closeTarget') {
      h.calls.push({method, params});
      const index = inventory.findIndex(item => item.targetId === params.targetId);
      if (index >= 0) inventory.splice(index, 1);
      return {success: true};
    }
    return session.send(method, params);
  }})});
  assert.deepEqual((await h.run()).closedTargetIds, ['EDITOR1', 'OLD_BLANK']);
  assert.deepEqual(inventory.map(item => item.targetId), ['BOUND_BLANK', 'FRESH1']);
  inventory.push(target('EDITOR2'));
  assert.deepEqual((await h.run()).closedTargetIds, ['EDITOR2', 'FRESH1']);
  assert.deepEqual(inventory.map(item => item.targetId), ['BOUND_BLANK', 'FRESH2']);
  const idle = await h.run();
  assert.equal(idle.createdTargetId, null);
  assert.deepEqual(idle.closedTargetIds, []);
  assert.equal(sequence, 2);
  assert.equal(h.calls.some(call => call.method === 'Target.closeTarget' && call.params.targetId === 'BOUND_BLANK'), false);
});

test('preserves all active and uncertain checkpoint targets, including nested editors', async t => {
  const h = await fixture(t, ['A', 'B', 'C', 'D', 'E'].map(id => target(id)), [
    {phase: 'staged', targetId: 'A', result: {targetId: 'B'}, preservedEditor: {targetId: 'C'}},
    {phase: 'publish_requested', result: {targetId: 'D'}},
    {phase: 'unrecognized', pendingCoverRevision: {targetId: 'E'}},
  ]);
  const result = await h.run();
  assert.equal(result.preservedCount, 5);
  assert.deepEqual(result.closedTargetIds, []);
  assert.equal(h.calls.some(c => c.method === 'Target.createTarget'), false);
});

test('closes a submitted original tab only with a consistent platform receipt', async t => {
  const receipt = {submitted: true, saved: false, published: false, publicationStatus: 'submitted',
    articleId: '123', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123'};
  const h = await fixture(t, [target('DONE', '/builder/rc/clue'), target('UNKNOWN')], [
    {phase: 'submitted', targetId: 'DONE', result: {...receipt, targetId: 'DONE'}},
    {phase: 'submitted', targetId: 'UNKNOWN', result: {...receipt, articleId: '999', targetId: 'UNKNOWN'}},
  ]);
  const result = await h.run();
  assert.deepEqual(result.closedTargetIds, ['DONE']);
  assert.equal(result.preservedCount, 1);
});

test('preserves terminal checkpoints that still have a pending cover revision', async t => {
  const h = await fixture(t, [target('REVISION')], [{phase: 'saved', targetId: 'REVISION',
    result: {saved: true, targetId: 'REVISION', draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123'},
    pendingCoverRevision: {targetId: 'REVISION'},
  }]);
  assert.deepEqual((await h.run()).closedTargetIds, []);
});

test('a successful task never disposes its separately preserved original editor', async t => {
  const h = await fixture(t, [target('DONE'), target('ORIGINAL')], [{
    phase: 'submitted', targetId: 'DONE', preservedEditor: {previous: {targetId: 'ORIGINAL'}},
    result: {targetId: 'DONE', submitted: true, saved: false, published: false,
      publicationStatus: 'submitted', articleId: '123', publishedUrl: 'https://baijiahao.baidu.com/s?id=123'},
  }]);
  const result = await h.run();
  assert.deepEqual(result.closedTargetIds, ['DONE']);
  assert.equal(result.preservedCount, 1);
});

test('keeps login, unrelated platform, unknown paths, and non-page targets', async t => {
  const h = await fixture(t, [
    target('LOGIN', '/v2/', 'passport.baidu.com'), target('OTHER', '/platform', 'channels.weixin.qq.com'),
    target('ARTICLE', '/builder/rc/settings'), {targetId: 'WORKER', type: 'worker', url: 'https://baijiahao.baidu.com/service-worker.js'},
    target('HOME', '/builder/rc/home'),
  ]);
  assert.deepEqual((await h.run()).closedTargetIds, ['HOME']);
});

test('malformed checkpoints preserve unknown editors but allow stale read-only lists', async t => {
  const h = await fixture(t, [target('EDITOR'), target('LIST', '/builder/rc/clue')], ['{broken']);
  const result = await h.run();
  assert.deepEqual(result.closedTargetIds, ['LIST']);
  assert.equal(result.malformedCheckpoints, 1);
  assert.equal(result.preservedCount, 1);
});

test('a per-target close error does not stop cleanup of other eligible pages', async t => {
  const h = await fixture(t, [target('FAIL'), target('OK')]);
  const session = await h.browser.target().createCDPSession();
  const original = session.send;
  h.browser.target = () => ({createCDPSession: async () => ({...session, async send(method, params) {
    if (method === 'Target.closeTarget' && params.targetId === 'FAIL') throw new Error('renderer unavailable');
    return original(method, params);
  }})});
  const result = await h.run();
  assert.deepEqual(result.failedTargetIds, ['FAIL']);
  assert.deepEqual(result.closedTargetIds, ['OK']);
});

test('does not close anything when opening the replacement page fails', async t => {
  const h = await fixture(t, [target('OLD')]);
  const session = await h.browser.target().createCDPSession();
  h.browser.target = () => ({createCDPSession: async () => ({...session, async send(method, params) {
    if (method === 'Target.createTarget') throw new Error('cannot create page');
    return session.send(method, params);
  }})});
  await assert.rejects(h.run(), /cannot create page/);
  assert.equal(h.calls.some(c => c.method === 'Target.closeTarget'), false);
});

test('a hanging close respects the overall budget and does not start further closes', async t => {
  const h = await fixture(t, [target('HANG'), target('NEXT')]);
  const session = await h.browser.target().createCDPSession();
  h.browser.target = () => ({createCDPSession: async () => ({...session, async send(method, params) {
    if (method === 'Target.closeTarget') {
      h.calls.push({method, params});
      return new Promise(() => {});
    }
    return session.send(method, params);
  }})});
  const start = Date.now();
  const result = await h.run({timeoutMs: 30});
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.failedTargetIds, ['HANG']);
  assert.equal(h.calls.filter(c => c.method === 'Target.closeTarget').length, 1);
  assert.ok(Date.now() - start < 1000);
});

test('rejects remote endpoints before connecting', async t => {
  const h = await fixture(t, [target('OLD')]);
  for (const invalid of ['https://127.0.0.1:9225', 'http://example.com:9225', 'http://127.0.0.1:9225/json/list', 'http://user@127.0.0.1:9225']) {
    await assert.rejects(cleanupStalePages(invalid, {stateRoot: h.root}, h.connect), /Invalid/);
  }
  assert.equal(h.options(), undefined);
});
