import ffmpeg from 'fluent-ffmpeg'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

const inputImage = path.resolve(repoRoot, 'data/static/images/ea7a1bc8-ca84-4834-95f8-e115b53c7696.png')
const kenburnsOutput = path.resolve(repoRoot, 'data/temp/kenburns_demo.mp4')
const parallaxOutput = path.resolve(repoRoot, 'data/temp/parallax_demo.mp4')

function generateKenBurns(input: string, output: string, width: number, height: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const scaledW = Math.round(width * 1.15)
    const scaledH = Math.round(height * 1.15)
    ffmpeg()
      .input(input)
      .inputOptions(['-loop', '1', '-framerate', '24'])
      .complexFilter([
        {
          filter: 'scale',
          options: `${scaledW}:${scaledH}`,
          inputs: '0:v',
          outputs: 'scaled',
        },
        {
          filter: 'crop',
          options: `${width}:${height}:'(${scaledW}-${width})/2 + 40*t/${duration}':'(${scaledH}-${height})/2 + 20*sin(2*PI*t/${duration})'`,
          inputs: 'scaled',
          outputs: 'out',
        },
      ], 'out')
      .outputOptions(['-r', '24', '-t', `${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart'])
      .output(output)
      .on('end', () => resolve())
      .on('error', reject)
      .run()
  })
}

async function main() {
  console.log('Generating Ken Burns version...')
  await generateKenBurns(inputImage, kenburnsOutput, 1280, 720, 5)
  console.log('Ken Burns:', kenburnsOutput)
  console.log('Parallax:', parallaxOutput)
}

main().catch(console.error)
