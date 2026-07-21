import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

const python = process.env.DEPTH_PARALLAX_PYTHON || 'python3'
const warpScript = path.join(repoRoot, 'backend/scripts/depth_parallax_warp.py')
const propsPath = path.join(repoRoot, 'data/static/temp/grid-story-props-564-pilot-30s.json')
const originalVideo = path.join(repoRoot, 'data/static/remotion/grid-story-ep564-pilot-30s-korean-crime.mp4')
const outDir = path.join(repoRoot, 'data/static/remotion/depth-ken-burns-ep564-warp-demo')
const visualOutput = path.join(outDir, 'depth-ken-burns-ep564-pilot-30s-warp-visual.mp4')
const finalOutput = path.join(outDir, 'depth-ken-burns-ep564-pilot-30s-warp-demo.mp4')

type Shot = {
  durationInFrames: number
  cells: Array<{ src: string; move?: string }>
}

function run(command: string, args: string[], cwd = repoRoot): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`))
    })
  })
}

function strengthFor(move: string | undefined): number {
  if (move === 'push') return 26
  if (move === 'pull') return 22
  return 18
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8')) as { shots: Shot[] }
  const shots = props.shots.slice(0, 6)
  const concatLines: string[] = []
  const stats: string[] = []
  const started = Date.now()

  for (const [index, shot] of shots.entries()) {
    const cell = shot.cells[0]
    const inputImage = path.join(repoRoot, 'remotion/public', cell.src)
    const outputPath = path.join(outDir, `shot-${String(index + 1).padStart(2, '0')}.mp4`)
    const duration = shot.durationInFrames / 30
    const direction = index % 2 === 0 ? 1 : -1

    const stdout = await run(python, [
      warpScript,
      inputImage,
      outputPath,
      '--width', '1280',
      '--height', '720',
      '--duration', String(duration),
      '--fps', '24',
      '--strength', String(strengthFor(cell.move)),
      '--direction', String(direction),
    ])
    const lastLine = stdout.trim().split('\n').at(-1) || '{}'
    const result = JSON.parse(lastLine)
    stats.push(`${index + 1}:${result.mode}:${result.elapsed_seconds}s`)
    concatLines.push(`file '${outputPath.replaceAll("'", "'\\''")}'`)
    console.log(`[DepthKenBurnsWarp] shot ${index + 1}/${shots.length}`, result)
  }

  const concatList = path.join(outDir, 'concat.txt')
  fs.writeFileSync(concatList, concatLines.join('\n') + '\n')

  await run('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    visualOutput,
  ])

  await run('ffmpeg', [
    '-y',
    '-i', visualOutput,
    '-i', originalVideo,
    '-map', '0:v:0',
    '-map', '1:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    '-movflags', '+faststart',
    finalOutput,
  ])

  console.log(JSON.stringify({
    finalOutput,
    visualOutput,
    stats,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
