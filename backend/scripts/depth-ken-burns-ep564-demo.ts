import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { generateParallaxVideo } from '../src/services/depth-parallax.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

const propsPath = path.join(repoRoot, 'data/static/temp/grid-story-props-564-pilot-30s.json')
const originalVideo = path.join(repoRoot, 'data/static/remotion/grid-story-ep564-pilot-30s-korean-crime.mp4')
const outDir = path.join(repoRoot, 'data/static/remotion/depth-ken-burns-ep564-demo')
const visualOutput = path.join(outDir, 'depth-ken-burns-ep564-pilot-30s-visual.mp4')
const finalOutput = path.join(outDir, 'depth-ken-burns-ep564-pilot-30s-demo.mp4')

type Shot = {
  durationInFrames: number
  cells: Array<{ src: string; move?: string }>
}

function run(command: string, args: string[], cwd = repoRoot): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

function motionRangeFor(move: string | undefined, index: number): number {
  if (move === 'push') return 130
  if (move === 'pull') return 110
  return index % 2 === 0 ? 85 : 65
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })

  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8')) as { shots: Shot[] }
  const shots = props.shots.slice(0, 6)
  const start = Date.now()
  const modes: string[] = []
  const concatLines: string[] = []

  for (const [index, shot] of shots.entries()) {
    const cell = shot.cells[0]
    const inputImage = path.join(repoRoot, 'remotion/public', cell.src)
    if (!fs.existsSync(inputImage)) {
      throw new Error(`Missing shot image: ${inputImage}`)
    }

    const duration = shot.durationInFrames / 30
    const outputPath = path.join(outDir, `shot-${String(index + 1).padStart(2, '0')}.mp4`)
    const result = await generateParallaxVideo(inputImage, outputPath, {
      width: 1280,
      height: 720,
      duration,
      motionRange: motionRangeFor(cell.move, index),
      mock: false,
    })

    modes.push(`${index + 1}:${result.mode}:${result.elapsedSeconds}s`)
    concatLines.push(`file '${outputPath.replaceAll("'", "'\\''")}'`)
    console.log(`[DepthKenBurns] shot ${index + 1}/${shots.length}`, result)
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
    modes,
    elapsedSeconds: Number(((Date.now() - start) / 1000).toFixed(2)),
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
