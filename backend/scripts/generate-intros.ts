/**
 * 片头动画批量生成脚本
 *
 * 实际实现已迁移到 Remotion（remotion/ 目录）。
 * 此脚本作为入口，调用 remotion 的渲染命令，一次生成三个开场动画。
 *
 * 运行：npx tsx backend/scripts/generate-intros.ts
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REMOTION_DIR = path.resolve(__dirname, '../../remotion')

const proc = spawn('npm', ['run', 'render'], {
  cwd: REMOTION_DIR,
  stdio: 'inherit',
})

proc.on('close', (code) => {
  process.exit(code ?? 0)
})
