import { generateParallaxVideo } from '../src/services/depth-parallax.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

const inputImage = path.resolve(repoRoot, 'data/static/images/ea7a1bc8-ca84-4834-95f8-e115b53c7696.png')
const outputVideo = path.resolve(repoRoot, 'data/temp/parallax_demo.mp4')

async function main() {
  console.log('Generating parallax video...')
  console.log('Input:', inputImage)
  console.log('Output:', outputVideo)

  const result = await generateParallaxVideo(inputImage, outputVideo, {
    width: 1280,
    height: 720,
    duration: 5,
    motionRange: 120,
    mock: false,
  })

  console.log('Done:', result)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
