import {spawn} from 'node:child_process';

const defaultEnvironmentNames = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
const exitByErrorCategory = Object.freeze({
  internal: 1,
  invalid_input: 2,
  protocol_mismatch: 3,
  asset_failure: 4,
  adapter_failure: 5,
  inspection_failure: 6,
  protocol_failure: 7,
  cancelled: 130,
});
const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});

const allowlistedEnvironment = (names, explicit) => {
  const environment = {};
  for (const name of new Set([...defaultEnvironmentNames, ...names])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (!names.includes(name) && !defaultEnvironmentNames.includes(name)) {
      throw codedError('ENVIRONMENT_NOT_ALLOWLISTED', `Environment variable is not allowlisted: ${name}`);
    }
    environment[name] = String(value);
  }
  return environment;
};

const sendSignal = (child, signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and signal delivery.
    }
  }
};

const validateIdentity = (request, response) => {
  if (
    response.adapterProtocolVersion !== request.adapterProtocolVersion ||
    response.operationId !== request.operationId ||
    response.operation !== request.operation
  ) {
    throw codedError(
      'SUBPROCESS_IDENTITY_MISMATCH',
      'Subprocess response identity does not match the request',
      {category: 7, exitCode: 7},
    );
  }
};

export const runJsonSubprocess = ({
  command,
  cwd,
  request,
  timeoutMs,
  signal,
  environmentNames = [],
  environment = {},
  maxStdoutBytes = 10 * 1024 * 1024,
  maxStderrBytes = 50 * 1024 * 1024,
  terminationGraceMs = 5000,
}) => new Promise((resolve, reject) => {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) {
    reject(codedError('INVALID_SUBPROCESS_COMMAND', 'Command must be a non-empty argument array'));
    return;
  }

  let child;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      env: allowlistedEnvironment(environmentNames, environment),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    reject(codedError('SUBPROCESS_SPAWN_FAILED', error.message, {category: 5, cause: error, exitCode: 5}));
    return;
  }

  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminalError = null;
  let killTimer = null;
  let settled = false;

  const terminate = (error) => {
    if (terminalError) return;
    terminalError = error;
    sendSignal(child, 'SIGTERM');
    killTimer = setTimeout(() => sendSignal(child, 'SIGKILL'), terminationGraceMs);
    killTimer.unref?.();
  };

  const timeout = setTimeout(() => terminate(codedError(
    'SUBPROCESS_TIMEOUT',
    `Subprocess exceeded its ${timeoutMs}ms deadline`,
    {category: 5, exitCode: 5, retryable: true},
  )), timeoutMs);
  timeout.unref?.();

  const onAbort = () => terminate(codedError(
    'CANCELLED',
    'Subprocess cancelled',
    {category: 130, exitCode: 130, retryable: false},
  ));
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();

  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      terminate(codedError(
        'SUBPROCESS_STDOUT_LIMIT',
        `Subprocess stdout exceeded ${maxStdoutBytes} bytes`,
        {category: 7, exitCode: 7},
      ));
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderrBytes) stderr.push(chunk);
  });
  child.on('error', (error) => terminate(codedError(
    'SUBPROCESS_SPAWN_FAILED',
    error.message,
    {category: 5, cause: error, exitCode: 5},
  )));
  child.on('close', (exitCode, exitSignal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
    if (terminalError) {
      reject(terminalError);
      return;
    }

    const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
    let response;
    try {
      response = JSON.parse(stdoutText);
    } catch (error) {
      reject(codedError(
        'SUBPROCESS_MALFORMED_OUTPUT',
        'Subprocess stdout must contain exactly one JSON value',
        {category: 7, cause: error, exitCode: 7},
      ));
      return;
    }
    if (response === null || Array.isArray(response) || typeof response !== 'object') {
      reject(codedError(
        'SUBPROCESS_MALFORMED_OUTPUT',
        'Subprocess response must be one JSON object',
        {category: 7, exitCode: 7},
      ));
      return;
    }
    try {
      validateIdentity(request, response);
    } catch (error) {
      reject(error);
      return;
    }

    const responseIsOk = response.status === 'ok' && response.error === null;
    if ((exitCode === 0) !== responseIsOk) {
      reject(codedError(
        'SUBPROCESS_STATUS_EXIT_MISMATCH',
        'Subprocess status does not match its process exit',
        {category: 7, exitCode: 7},
      ));
      return;
    }
    if (!responseIsOk) {
      const category = response.error?.category;
      if (exitByErrorCategory[category] !== exitCode) {
        reject(codedError(
          'SUBPROCESS_STATUS_EXIT_MISMATCH',
          'Subprocess error category does not match its process exit',
          {category: 7, exitCode: 7},
        ));
        return;
      }
    }
    resolve({
      ...response,
      diagnostics: {
        exitCode,
        exitSignal,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stderrBytes,
      },
    });
  });

  child.stdin.end(`${JSON.stringify(request)}\n`);
});
