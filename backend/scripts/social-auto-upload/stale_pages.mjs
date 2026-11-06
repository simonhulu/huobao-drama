import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';

const readablePaths = new Set(['/builder/rc/home', '/builder/rc/clue', '/builder/rc/content']);

function confirmedTerminal(state) {
  const result = state.result;
  if (!result || state.pendingCoverRevision || typeof result.targetId !== 'string'
      || (state.targetId && state.targetId !== result.targetId)) return false;
  try {
    if (state.phase === 'saved' && result.saved === true && !result.submitted && !result.published) {
      const url = new URL(result.draftUrl);
      return url.protocol === 'https:' && url.hostname === 'baijiahao.baidu.com'
        && !url.username && !url.password && !url.port && !url.hash
        && url.pathname === '/builder/rc/edit' && /^\d+$/.test(url.searchParams.get('article_id') || '');
    }
    if (!['submitted', 'published'].includes(state.phase) || result.submitted !== true || result.saved !== false
        || result.publicationStatus !== state.phase || result.published !== (state.phase === 'published')
        || typeof result.articleId !== 'string' || !/^\d+$/.test(result.articleId)) return false;
    const url = new URL(result.publishedUrl);
    return url.protocol === 'https:' && url.hostname === 'baijiahao.baidu.com'
      && !url.username && !url.password && !url.port && !url.hash
      && ['/s', '/builder/preview/s'].includes(url.pathname)
      && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === result.articleId;
  } catch {
    return false;
  }
}

function collectTargetIds(value, targets) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'targetId' || key.endsWith('TargetId')) && typeof item === 'string') targets.add(item);
    else if (key === 'targetIds' && Array.isArray(item)) {
      for (const id of item) if (typeof id === 'string') targets.add(id);
    } else if (item && typeof item === 'object') collectTargetIds(item, targets);
  }
}

async function checkpointProtection(stateRoot, preserved) {
  const jobs = path.join(path.resolve(stateRoot), 'jobs');
  let directories;
  try {
    if ((await fs.lstat(jobs)).isSymbolicLink()) throw new Error('Invalid upload checkpoint directory');
    directories = await fs.readdir(jobs, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return {checkpointCount: 0, malformedCheckpoints: 0};
    throw error;
  }
  let checkpointCount = 0;
  let malformedCheckpoints = 0;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const file = path.join(jobs, directory.name, 'state.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid checkpoint');
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.phase !== 'string') throw new Error('Invalid checkpoint');
      checkpointCount++;
      collectTargetIds(state.preservedEditor, preserved);
      if (!confirmedTerminal(state)) collectTargetIds(state, preserved);
    } catch (error) {
      if (error.code !== 'ENOENT') malformedCheckpoints++;
    }
  }
  return {checkpointCount, malformedCheckpoints};
}

/** Caller must hold the existing account/browser operation lock. */
export async function cleanupStalePages(endpoint, options, connect = puppeteer.connect.bind(puppeteer)) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !options || typeof options.stateRoot !== 'string' || !options.stateRoot
      || (options.platform && options.platform !== 'baijiahao')) throw new Error('Invalid browser cleanup configuration');
  const preserved = new Set(options.preserveTargetIds || []);
  const checkpoint = await checkpointProtection(options.stateRoot, preserved);
  const deadline = Date.now() + Math.max(1, Math.min(Number(options.timeoutMs) || 10000, 10000));
  const bounded = async action => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Browser page cleanup timed out');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser page cleanup timed out')), Math.min(2000, remaining));
      })]);
    } finally { clearTimeout(timer); }
  };
  const outcome = {closedTargetIds: [], failedTargetIds: [], preservedCount: 0, createdTargetId: null,
    timedOut: false, ...checkpoint};
  let browser;
  try {
    // Browser-level CDP does not initialize a retained, possibly stuck page.
    browser = await bounded(() => connect({browserURL: endpoint, defaultViewport: null, protocolTimeout: 2000,
      networkEnabled: false, issuesEnabled: false, targetFilter: target => target.type() === 'browser'}));
    const session = await bounded(() => browser.target().createCDPSession());
    const {targetInfos} = await bounded(() => session.send('Target.getTargets'));
    if (!Array.isArray(targetInfos)) throw new Error('Invalid browser target inventory');
    const candidates = [];
    const oldBlankTargets = [];
    for (const target of targetInfos) {
      if (target.type !== 'page' || typeof target.targetId !== 'string') continue;
      if (target.url === 'about:blank') {
        if (preserved.has(target.targetId)) outcome.preservedCount++;
        else oldBlankTargets.push(target.targetId);
        continue;
      }
      let location;
      try { location = new URL(target.url); } catch { continue; }
      if (location.protocol !== 'https:' || location.hostname !== 'baijiahao.baidu.com'
          || location.username || location.password || location.port
          || (!readablePaths.has(location.pathname) && location.pathname !== '/builder/rc/edit')) continue;
      if (preserved.has(target.targetId) || (checkpoint.malformedCheckpoints && location.pathname === '/builder/rc/edit')) {
        outcome.preservedCount++;
      } else candidates.push(target.targetId);
    }
    if (!candidates.length) return outcome;
    const replacement = await bounded(() => session.send('Target.createTarget', {url: 'about:blank', background: true}));
    if (typeof replacement.targetId !== 'string' || !replacement.targetId) throw new Error('Replacement browser page was not created');
    outcome.createdTargetId = replacement.targetId;
    for (const targetId of [...candidates, ...oldBlankTargets]) {
      if (Date.now() >= deadline) { outcome.timedOut = true; break; }
      try {
        const result = await bounded(() => session.send('Target.closeTarget', {targetId}));
        (result.success === true ? outcome.closedTargetIds : outcome.failedTargetIds).push(targetId);
      } catch {
        outcome.failedTargetIds.push(targetId);
        if (Date.now() >= deadline) outcome.timedOut = true;
      }
    }
    return outcome;
  } finally {
    if (browser) await browser.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Invalid browser cleanup input');
    }
    const {endpoint, ...options} = JSON.parse(input);
    process.stdout.write(JSON.stringify(await cleanupStalePages(endpoint, options)));
  } catch {
    process.stderr.write('Stale browser page cleanup failed\n');
    process.exitCode = 1;
  }
}
