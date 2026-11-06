import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCbaExecutorCommand, inspectCbaProductionExecutor, runCbaExecutorCommand } from './cba-production-executor.js'

const reply = [
  { type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'CBA_EXECUTOR_TOOLS_READY\n' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'CBA_EXECUTOR_READY' } },
  { type: 'turn.completed' },
].map(event => JSON.stringify(event)).join('\n')

test('native command runner closes stdin so a noninteractive CLI can finish reading its prompt', async () => {
  const result = await runCbaExecutorCommand(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("stdin-ended"))'], { cwd: process.cwd(), timeout: 1000, maxBuffer: 1024 })
  assert.equal(result.stdout, 'stdin-ended')
})

test('CBA executors cannot fan out into additional production agents', () => {
  const command = buildCbaExecutorCommand('/fixture/project', '/fixture/tasks')
  for (const feature of ['multi_agent', 'multi_agent_v2']) {
    const index = command.args.indexOf(feature)
    assert.ok(index > 0, `${feature} must be explicitly disabled for CBA`)
    assert.equal(command.args[index - 1], '--disable')
  }
})

test('custom provider works without OpenAI login and probe uses the production working directory', async () => {
  const calls: string[][] = []
  const result = await inspectCbaProductionExecutor('/fixture/project', async (file, args, options) => {
    assert.equal(file, 'codex'); assert.equal(options.cwd, '/fixture/project'); calls.push(args)
    if (args[0] === 'login') throw Object.assign(new Error('Not logged in'), { code: 1 })
    return { stdout: args[0] === 'exec' ? reply : 'codex-cli 0.163.0', stderr: '' }
  })
  assert.equal(result.ready, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.slice(0, -1), ['exec', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true', '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--json', '--ephemeral', '-C', '/fixture/project'])
})

test('a working login without tool execution cannot claim production readiness', async () => {
  const calls: string[][] = []
  const result = await inspectCbaProductionExecutor('/fixture', async (_file, args) => { calls.push(args); return { stdout: '', stderr: '' } })
  assert.equal(result.ready, false); assert.equal(calls[1]![0], 'exec')
})

test('installation errors are distinct from login and do not expose CLI output', async () => {
  const result = await inspectCbaProductionExecutor('/fixture', async () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }) })
  assert.equal(result.ready, false); assert.match(result.message, /找不到 Codex/); assert.doesNotMatch(result.message, /private/)
})

for (const [error, hint] of [
  [{ killed: true }, /超时/],
  [{ stderr: '401 Unauthorized Bearer private-secret' }, /认证未通过/],
  [{ stderr: 'error loading config.toml private-secret' }, /配置无法加载/],
  [{ stderr: 'connection refused private-secret' }, /无法连接模型服务/],
] as const) test(`failed provider probe reports ${hint}`, async () => {
  const result = await inspectCbaProductionExecutor('/fixture', async (_file, args) => {
    if (args[0] === '--version') return { stdout: '', stderr: '' }
    throw Object.assign(new Error('private-secret'), args[0] === 'exec' ? error : { code: 1 })
  })
  assert.equal(result.ready, false); assert.match(result.message, hint); assert.doesNotMatch(result.message, /private-secret/)
})

test('partial or failed turns cannot masquerade as a successful provider probe', async () => {
  for (const stdout of [reply.split('\n')[0]!, reply.split('\n').slice(1).join('\n'), reply.replace('"exit_code":0', '"exit_code":1'), reply + '\n{"type":"turn.failed"}', '{"type":"turn.completed"}', 'not JSON']) {
    const result = await inspectCbaProductionExecutor('/fixture', async (_file, args) => {
      if (args[0] === 'login') throw Error('Not logged in')
      return { stdout, stderr: '' }
    })
    assert.equal(result.ready, false)
  }
})
