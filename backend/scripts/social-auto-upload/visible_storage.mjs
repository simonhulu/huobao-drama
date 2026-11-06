import puppeteer from 'puppeteer-core';
import {pathToFileURL} from 'node:url';

const homes = {
  baijiahao: {host: 'baijiahao.baidu.com', path: '/builder/rc/home'},
  tencent: {host: 'channels.weixin.qq.com', path: '/platform'},
};

export function storageTargetAllowed(target, platform) {
  if (target.type() === 'browser') return true;
  if (!['tab', 'page'].includes(target.type())) return false;
  try {
    const url = new URL(target.url());
    const home = homes[platform];
    return url.protocol === 'https:' && url.hostname === home.host && url.pathname === home.path;
  } catch {
    return false;
  }
}

export async function captureVisibleStorage(endpoint, platform, connect = puppeteer.connect.bind(puppeteer)) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !homes[platform]) {
    throw new Error('Invalid visible browser endpoint');
  }
  // Playwright initializes every existing page before connecting. A retained
  // unresponsive editor must not prevent reading browser-level login cookies.
  const browser = await connect({browserURL: endpoint, defaultViewport: null, protocolTimeout: 4000,
    networkEnabled: false, issuesEnabled: false, targetFilter: target => storageTargetAllowed(target, platform)});
  try {
    if (browser.browserContexts().length !== 1) throw new Error('Visible browser context is not unique');
    const cookies = (await browser.defaultBrowserContext().cookies()).map(cookie => {
      const result = {};
      for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']) {
        if (cookie[key] !== undefined) result[key] = cookie[key];
      }
      const partitionKey = typeof cookie.partitionKey === 'string' ? cookie.partitionKey : cookie.partitionKey?.sourceOrigin;
      if (partitionKey) result.partitionKey = partitionKey;
      return result;
    });
    const origins = [];
    for (const page of await browser.pages()) {
      if (!storageTargetAllowed({type: () => 'page', url: () => page.url()}, platform)) continue;
      try {
        const state = await page.evaluate(() => ({origin: location.origin,
          localStorage: Object.keys(localStorage).map(name => ({name, value: localStorage.getItem(name)}))}));
        if (!origins.some(item => item.origin === state.origin)) origins.push(state);
      } catch {
        // Cookie import can still be validated in the isolated background
        // browser when a homepage renderer is temporarily unresponsive.
      }
    }
    return {cookies, origins};
  } finally {
    await browser.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(await captureVisibleStorage(process.argv[2], process.argv[3])));
  } catch {
    process.stderr.write('Visible browser login snapshot failed\n');
    process.exitCode = 1;
  }
}
