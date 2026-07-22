import {spawn} from 'node:child_process';

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  exitCode: 5,
  ...fields,
});

export const runPythonWorker = ({
  maxStderrBytes = 1024 * 1024,
  maxStdoutBytes = 10 * 1024 * 1024,
  operation,
  packageRoot,
  params,
  pythonPath = 'python3.12',
  signal,
  timeoutMs,
}) => new Promise((resolve, reject) => {
  const child = spawn(
    pythonPath,
    ['-m', 'remotion_editorial_director.workers.json_worker'],
    {
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        PATH: process.env.PATH,
        PYTHONPATH: packageRoot,
        TMPDIR: process.env.TMPDIR,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminalError = null;
  const terminate = (error) => {
    terminalError ??= error;
    child.kill('SIGTERM');
  };
  const timeout = setTimeout(() => terminate(codedError(
    'PYTHON_WORKER_TIMEOUT',
    `Python worker exceeded ${timeoutMs}ms`,
    {retryable: true},
  )), timeoutMs);
  timeout.unref?.();
  const onAbort = () => terminate(codedError('CANCELLED', 'Python worker cancelled', {exitCode: 130}));
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      terminate(codedError('PYTHON_WORKER_STDOUT_LIMIT', 'Python worker stdout exceeded its limit'));
    } else {
      stdout.push(chunk);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderrBytes) stderr.push(chunk);
  });
  child.on('error', (error) => terminate(codedError('PYTHON_WORKER_SPAWN_FAILED', error.message, {cause: error})));
  child.on('close', (exitCode) => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    if (terminalError) {
      reject(terminalError);
      return;
    }
    const lines = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/u).filter(Boolean);
    if (exitCode !== 0 || lines.length !== 1) {
      reject(codedError('PYTHON_WORKER_PROTOCOL_FAILED', 'Python worker did not return exactly one JSON line', {
        stderr: Buffer.concat(stderr).toString('utf8'),
        workerExitCode: exitCode,
      }));
      return;
    }
    let response;
    try {
      response = JSON.parse(lines[0]);
    } catch (error) {
      reject(codedError('PYTHON_WORKER_PROTOCOL_FAILED', 'Python worker returned malformed JSON', {cause: error}));
      return;
    }
    if (response?.ok !== true) {
      reject(codedError('PYTHON_WORKER_FAILED', response?.error?.message ?? 'Python worker failed', {
        workerError: response?.error,
      }));
      return;
    }
    resolve(response);
  });
  child.stdin.end(`${JSON.stringify({operation, params})}\n`);
});
