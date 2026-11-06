import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'

const exec = promisify(execFile)
const sentinel = 'CBA_EXECUTOR_READY'
const prompt = `Production readiness check only. Run exactly this shell command from the project directory: node scripts/cba-video/executor-check.mjs. It checks task temporary files, local IPC, and access to the public Migu homepage. Do not start production, edit project files, or read credentials. Do not delegate. If the command exits 0 and prints CBA_EXECUTOR_TOOLS_READY, reply exactly ${sentinel}. Otherwise report the failure briefly; do not claim success.`
export interface ProductionReadiness { ready: boolean; message: string }
export function buildCbaExecutorCommand(projectRoot: string, taskRoot: string, input = '-', environment: NodeJS.ProcessEnv = process.env) {
  const temporaryDirectory = path.join(taskRoot, '.tmp')
  return {
    file: 'codex',
    // Pin CBA's research, editing, audit and readiness probe independently of
    // the user/project defaults so every stage receives the requested model.
    args: ['exec', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"',
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true',
      '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
      '--json', '--ephemeral', '-C', projectRoot, input],
    env: { ...environment, TMPDIR: temporaryDirectory } as NodeJS.ProcessEnv,
    temporaryDirectory,
  }
}
type Execute = (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
export const runCbaExecutorCommand: Execute = (file, args, options) => {
  const pending = exec(file, args, options)
  // Codex appends piped stdin even when a prompt argument is present. Explicit
  // EOF prevents the readiness probe from waiting indefinitely for more input.
  pending.child.stdin?.on('error', () => {})
  pending.child.stdin?.end()
  return pending
}

function failure(error: unknown, checkingInstall = false): ProductionReadiness {
  const value = error as { code?: string | number; killed?: boolean; signal?: string; stderr?: string; stdout?: string }
  if (value?.code === 'ENOENT') return { ready: false, message: '后台找不到 Codex 命令，请检查本机安装和服务的 PATH' }
  if (value?.killed || value?.signal === 'SIGTERM') return { ready: false, message: '生产执行器检查超时，请检查模型服务或网络后重试' }
  // Classify locally; never return CLI output, which can contain credentials.
  const output = `${value?.stderr || ''}\n${value?.stdout || ''}`
  if (/401|403|unauthorized|authentication|not logged in|invalid.api.key|missing.*api.key/i.test(output)) return { ready: false, message: '模型服务认证未通过，请检查 Codex 登录或自定义模型服务凭据后重试' }
  if (/config\.toml|error loading config|failed to.*config|toml.*parse/i.test(output)) return { ready: false, message: 'Codex 配置无法加载，请修正本机配置后重试' }
  return { ready: false, message: checkingInstall ? 'Codex 命令检查失败，请检查本机安装' : '生产执行器无法连接模型服务，请检查当前模型配置和网络后重试' }
}

/** Verify model and actual tool access under the same settings as production. */
export async function inspectCbaProductionExecutor(projectRoot: string, execute: Execute = runCbaExecutorCommand): Promise<ProductionReadiness> {
  const options = { cwd: projectRoot, timeout: 5000, maxBuffer: 1024 * 1024 }
  try { await execute('codex', ['--version'], options) } catch (error) { return failure(error, true) }
  try {
    const command = buildCbaExecutorCommand(projectRoot, path.join(projectRoot, 'data/cba-video'), prompt)
    // Injected runners are used in pure tests and do not need a real directory.
    if (execute === runCbaExecutorCommand) await fs.mkdir(command.temporaryDirectory, { recursive: true })
    const result = await execute(command.file, command.args, { ...options, env: command.env, timeout: 90000 })
    const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const response = events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim() === sentinel)
    const completed = events.some(event => event.type === 'turn.completed')
    const toolsReady = events.some(event => event.type === 'item.completed' && event.item?.type === 'command_execution'
      && event.item.exit_code === 0 && String(event.item.aggregated_output || '').split(/\r?\n/).includes('CBA_EXECUTOR_TOOLS_READY'))
    if (response && completed && toolsReady && !events.some(event => ['error', 'turn.failed'].includes(event.type))) return { ready: true, message: '生产执行器、素材网络与临时目录检查通过' }
    return { ready: false, message: '生产工具检查未通过，请检查执行器网络、临时目录与命令权限后重试' }
  } catch (error) { return failure(error) }
}
