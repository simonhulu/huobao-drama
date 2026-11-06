// Run inside the production Codex sandbox: login alone cannot verify tool access.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cba-check-'));
let server;
try {
  await fs.writeFile(path.join(directory, 'write-check'), 'ok');
  server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(directory, 'ipc.sock'), resolve);
  });
  await new Promise(resolve => server.close(resolve));
  server = null;
  const condaPython = path.join(os.homedir(), 'miniconda3/bin/python');
  const python = process.env.VIDEODL_PYTHON || (await fs.access(condaPython).then(() => true, () => false) ? condaPython : 'python3');
  const checked = await promisify(execFile)(python,
    [fileURLToPath(new URL('./migu_resolve.py', import.meta.url)), '--check-runtime'],
    {timeout: 20000, maxBuffer: 1024 * 1024});
  if (JSON.parse(checked.stdout).ok !== true) throw Error('videodl runtime failed');
  const response = await fetch('https://www.miguvideo.com/p/home', {signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw Error(`Migu HTTP ${response.status}`);
  await response.body?.cancel();
  console.log('CBA_EXECUTOR_TOOLS_READY');
} catch (error) {
  console.error(`CBA_EXECUTOR_CHECK_FAILED ${error.code || error.cause?.code || error.name}`);
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, {recursive: true, force: true});
}
