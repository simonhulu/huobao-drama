import assert from 'node:assert/strict';
import test from 'node:test';
import {captureVisibleStorage, storageTargetAllowed} from './visible_storage.mjs';

test('only platform home targets are initialized; editors and browser UI are skipped', () => {
  const target = (type, url) => ({type: () => type, url: () => url});
  for (const type of ['tab', 'page']) {
    assert.equal(storageTargetAllowed(target(type, 'https://baijiahao.baidu.com/builder/rc/home'), 'baijiahao'), true);
    assert.equal(storageTargetAllowed(target(type, 'https://baijiahao.baidu.com/builder/rc/edit?type=video'), 'baijiahao'), false);
    assert.equal(storageTargetAllowed(target(type, 'https://channels.weixin.qq.com/platform'), 'tencent'), true);
    assert.equal(storageTargetAllowed(target(type, 'https://baijiahao.baidu.com.evil.test/builder/rc/home'), 'baijiahao'), false);
  }
  assert.equal(storageTargetAllowed(target('other', 'chrome://omnibox-popup/'), 'baijiahao'), false);
  assert.equal(storageTargetAllowed(target('browser', ''), 'baijiahao'), true);
});

test('snapshot reads only homepage storage and disconnects without closing or navigating', async () => {
  let disconnected = false;
  const page = {
    url: () => 'https://baijiahao.baidu.com/builder/rc/home',
    evaluate: async () => ({origin: 'https://baijiahao.baidu.com', localStorage: [{name: 'fixture', value: 'private'}]}),
  };
  const browser = {
    browserContexts: () => [{}],
    defaultBrowserContext: () => ({cookies: async () => [{name: 'fixture', value: 'private', domain: '.baidu.com',
      path: '/', expires: -1, httpOnly: true, secure: true, priority: 'High', sourceScheme: 'Secure'}]}),
    pages: async () => [page],
    disconnect: async () => {disconnected = true;},
  };
  const storage = await captureVisibleStorage('http://127.0.0.1:9225', 'baijiahao', async options => {
    assert.equal(options.defaultViewport, null);
    assert.equal(options.networkEnabled, false);
    return browser;
  });
  assert.deepEqual(storage.cookies, [{name: 'fixture', value: 'private', domain: '.baidu.com', path: '/',
    expires: -1, httpOnly: true, secure: true}]);
  assert.equal(storage.origins[0].localStorage.length, 1);
  assert.equal(disconnected, true);
});

test('unresponsive homepage storage cannot block browser cookie import', async () => {
  let disconnected = false;
  const browser = {
    browserContexts: () => [{}],
    defaultBrowserContext: () => ({cookies: async () => []}),
    pages: async () => [{url: () => 'https://baijiahao.baidu.com/builder/rc/home', evaluate: async () => {throw new Error('renderer timeout');}}],
    disconnect: async () => {disconnected = true;},
  };
  assert.deepEqual(await captureVisibleStorage('http://127.0.0.1:9225', 'baijiahao', async () => browser), {cookies: [], origins: []});
  assert.equal(disconnected, true);
});

test('snapshot refuses remote endpoints before connecting', async () => {
  let connected = false;
  for (const endpoint of ['https://example.com:9225', 'http://user:secret@127.0.0.1:9225', 'http://127.0.0.1:9225/other']) {
    await assert.rejects(captureVisibleStorage(endpoint, 'baijiahao', async () => {connected = true;}), /endpoint/);
  }
  assert.equal(connected, false);
});
