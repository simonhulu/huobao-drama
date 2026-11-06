#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = path.join(root, 'data/storage/history-source-downloader');
const checkout = path.join(runtime, 'repo');
const connectionPath = path.join(runtime, 'connection.json');
const logPath = path.join(runtime, 'deployment.log');
const revision = '31d56df1462e99f24621eb2c6f060af183bf24fd';
const browserRevision = 'f04c23da285b3b3d3cf10c8f9d282e7adc1d52ce';
const baseUrl = 'http://127.0.0.1:9125';
const composeArgs = ['compose', '-p', 'dtk-history', '-f', 'docker/compose.yml', '-f', 'compose.host.yml', '--profile', 'browser', '--profile', 'downloader'];
const commandEnv = { ...process.env, COMPOSE_ENV_FILES: '.env' };
delete commandEnv.GITHUB_TOKEN;
delete commandEnv.GH_TOKEN;

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function privateWrite(file, value) {
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
}

function run(command, args, cwd = checkout, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (capture) output += chunk.toString();
      else appendFileSync(logPath, chunk, { mode: 0o600 });
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}; see the private deployment log`)));
  });
}

async function request(route, { method = 'GET', json, apiKey, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`${method} ${route}: HTTP ${response.status} ${body.error?.code ?? ''}`);
  return { data: body.data, response };
}

async function poll(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const found = await check(); if (found) return found; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function bootstrap(connection) {
  const initialized = (await request('/api/setup/status')).data.initialized;
  if (!initialized) {
    const logs = await run('docker', [...composeArgs, 'logs', '--no-color', 'api'], checkout, { capture: true });
    const token = logs.match(/\/setup\?token=([^\s]+)/)?.[1];
    if (!token) throw new Error('Initialization token was absent from the private API log');
    await request('/api/setup/init', { method: 'POST', json: { token, username: connection.adminUsername, password: connection.adminPassword } });
  }
  if (!connection.apiKey) {
    const login = await request('/api/v1/auth/login', { method: 'POST', json: { username: connection.adminUsername, password: connection.adminPassword } });
    const cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (!cookie) throw new Error('Administrator login did not return a session cookie');
    const key = await request('/api/v1/admin/api-keys', { method: 'POST', cookie, json: {
      name: 'history-pipeline', rate_limit: 60,
      scopes: ['douyin:read', 'archive:read', 'media:read', 'media:write', 'identity:manage'],
    } });
    connection.apiKey = key.data.key;
    connection.apiKeyId = key.data.id;
  }
  connection.status = 'api-ready';
  await privateWrite(connectionPath, `${JSON.stringify(connection, null, 2)}\n`);
  return connection;
}

async function main() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  await privateWrite(logPath, 'History downloader deployment\n');
  let connection = await readJson(connectionPath);
  if (!connection) {
    connection = {
      baseUrl, project: 'dtk-history', revision, browserRevision,
      adminUsername: 'history-admin', adminPassword: randomBytes(24).toString('hex'),
      status: 'initializing', createdAt: new Date().toISOString(),
    };
    await privateWrite(connectionPath, `${JSON.stringify(connection, null, 2)}\n`);
  }
  if (connection.baseUrl !== baseUrl || connection.revision !== revision) throw new Error('Existing deployment connection differs from this pinned instance');

  console.log('Preparing the pinned downloader checkout.');
  try { await readFile(path.join(checkout, 'pyproject.toml')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run('gh', ['repo', 'clone', 'Evil0ctal/Douyin_TikTok_Download_API', checkout, '--', '--depth', '1', '--branch', 'v5.1.3'], root);
  }
  const actualRevision = (await run('git', ['rev-parse', 'HEAD'], checkout, { capture: true })).trim();
  if (actualRevision !== revision) throw new Error('Downloader checkout revision does not match the pinned release');

  const envPath = path.join(checkout, '.env');
  try { await readFile(envPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const postgres = randomBytes(24).toString('hex');
    const redis = randomBytes(24).toString('hex');
    await privateWrite(envPath, [
      `DTK_SECRET_KEY=${randomBytes(48).toString('base64')}`,
      `POSTGRES_PASSWORD=${postgres}`, `REDIS_PASSWORD=${redis}`,
      `DTK_DATABASE_URL=postgresql+asyncpg://dtk:${postgres}@postgres:5432/dtk`,
      `DTK_REDIS_URL=redis://:${redis}@redis:6379/0`,
      'DTK_BIND_HOST=127.0.0.1', 'DTK_BIND_PORT=9125',
      'DTK_IMAGE=evil0ctal/douyin_tiktok_download_api',
      'DTK_DOWNLOADER_IMAGE=evil0ctal/douyin_tiktok_download_api-downloader',
      `DTK_IMAGE_TAG=sha-${revision}`, `CLOAKBROWSER_COMMIT=${browserRevision}`,
      'DTK_BROWSER_RPC_URL=http://browser-rpc:9000',
      'DTK_DOWNLOADER_URL=http://downloader:9100',
      `DTK_DOWNLOADER_TOKEN=${randomBytes(24).toString('hex')}`,
      'DTK_BROWSER_PREWARM=false', 'DTK_BROWSER_MAX_CONCURRENT_MINTS=1',
      'DTK_BROWSER_WARM_CONTEXTS=1', 'DTK_BROWSER_DEFAULT_COUNTRY=CN',
      'DTK_POOL_DOUYIN_MIN_SIZE=1', 'DTK_POOL_DOUYIN_TARGET_SIZE=1',
      'DTK_POOL_TIKTOK_MIN_SIZE=0', 'DTK_POOL_TIKTOK_TARGET_SIZE=0',
      'DTK_DOWNLOADER_WORKERS=1', 'DTK_DOWNLOADER_ITEM_WORKERS=1',
      'DTK_REDIS_MAXMEMORY=64mb', '',
    ].join('\n'));
  }
  await chmod(envPath, 0o600);
  const browserDockerfile = await readFile(path.join(checkout, 'docker/Dockerfile.browser'), 'utf8');
  const browserNetworkDockerfile = browserDockerfile.replace('ENV PYTHONUNBUFFERED=1',
    "RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources\n\nENV PYTHONUNBUFFERED=1");
  if (browserNetworkDockerfile === browserDockerfile) throw new Error('Pinned browser Dockerfile layout changed');
  await privateWrite(path.join(checkout, 'docker/Dockerfile.browser.local'), browserNetworkDockerfile);
  // Keep the desktop VM's existing workloads isolated from the optional browser.
  await privateWrite(path.join(checkout, 'compose.host.yml'), [
    'services:',
    '  postgres: { mem_limit: 384m, memswap_limit: 768m }',
    '  redis: { mem_limit: 128m, memswap_limit: 128m }',
    '  api: { mem_limit: 256m, memswap_limit: 512m, cpus: 1.0 }',
    '  worker: { mem_limit: 256m, memswap_limit: 512m, cpus: 1.0 }',
    '  browser-rpc:',
    '    build:', '      dockerfile: docker/Dockerfile.browser.local',
    '    mem_limit: 768m', '    memswap_limit: 1536m', '    cpus: 1.5',
    '    tmpfs:', '      - /tmp:size=1g,mode=1777',
    '      - /profiles:size=256m,mode=0700,uid=10001,gid=10001',
    '  downloader: { mem_limit: 96m, memswap_limit: 192m, cpus: 1.0 }', '',
  ].join('\n'));
  await run('docker', [...composeArgs, 'config', '--quiet']);
  if (!process.argv.includes('--skip-pull')) {
    console.log('Pulling the pinned API, database, Redis and downloader images.');
    await run('docker', [...composeArgs, 'pull', 'api', 'worker', 'downloader', 'postgres', 'redis']);
  }
  console.log('Starting core services on 127.0.0.1:9125.');
  await run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '300', 'api', 'worker', 'downloader']);
  await poll(async () => (await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })).ok, 60000, 'API readiness');
  connection = await bootstrap(connection);
  console.log('API ready; the private connection file contains its access key.');
  console.log('Building the pinned browser component.');
  await run('docker', [...composeArgs, 'build', 'browser-rpc']);
  console.log('Starting the isolated Docker project on 127.0.0.1:9125.');
  await run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '300']);
  await poll(async () => (await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })).ok, 60000, 'API readiness');

  console.log('Waiting for a real Douyin guest identity.');
  const existing = (await request('/api/v1/admin/identities?platform=douyin&state=active', { apiKey: connection.apiKey })).data;
  if (!existing.length) {
    const minted = await request('/api/v1/admin/identities/mint', {
      method: 'POST', apiKey: connection.apiKey, json: { platform: 'douyin', count: 1 },
    });
    connection.guestMintTaskId = minted.data.task_ids?.[0];
    await privateWrite(connectionPath, `${JSON.stringify(connection, null, 2)}\n`);
  }
  const identities = await poll(async () => {
    const { data } = await request('/api/v1/admin/identities?platform=douyin&state=active', { apiKey: connection.apiKey });
    return data.length ? data : null;
  }, 360000, 'Douyin guest identity');
  connection.status = 'ready';
  connection.identityId = identities[0].id;
  connection.readyAt = new Date().toISOString();
  await privateWrite(connectionPath, `${JSON.stringify(connection, null, 2)}\n`);
  console.log(JSON.stringify({ baseUrl, project: connection.project, revision, browserRevision, identityId: connection.identityId, status: connection.status }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
