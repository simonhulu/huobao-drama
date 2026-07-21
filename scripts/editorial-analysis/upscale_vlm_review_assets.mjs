#!/usr/bin/env node

import {promisify} from 'node:util'
import {execFile as execFileCallback} from 'node:child_process'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const execFile = promisify(execFileCallback)

function parseArguments(argv) {
  const result = {width: 640, height: 360, concurrency: 4}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${argument} requires a value`)
      return argv[index]
    }
    if (argument === '--input') result.inputPath = value()
    else if (argument === '--video') result.videoPath = value()
    else if (argument === '--output-input') result.outputInputPath = value()
    else if (argument === '--assets-dir') result.assetsDirectory = value()
    else if (argument === '--width') result.width = Number(value())
    else if (argument === '--height') result.height = Number(value())
    else if (argument === '--concurrency') result.concurrency = Number(value())
    else if (argument === '--help' || argument === '-h') result.help = true
    else throw new Error(`unknown option: ${argument}`)
  }
  return result
}

function usage() {
  return `Usage: node scripts/editorial-analysis/upscale_vlm_review_assets.mjs \\
  --input <selected-input.json> --video <source.mp4> --output-input <highres-input.json> \\
  --assets-dir <output-directory> [--width 640 --height 360 --concurrency 4]`
}

function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_')
}

async function extractFrame(videoPath, timeSeconds, outputPath, width, height) {
  await mkdir(path.dirname(outputPath), {recursive: true})
  await execFile('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(timeSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-q:v', '2',
    '-an',
    '-y',
    outputPath,
  ])
  const metadata = await stat(outputPath)
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`ffmpeg produced no JPEG at ${outputPath}`)
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  for (const key of ['inputPath', 'videoPath', 'outputInputPath', 'assetsDirectory']) {
    if (!arguments_[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  if (!Number.isInteger(arguments_.width) || arguments_.width < 256) throw new Error('--width must be an integer >= 256')
  if (!Number.isInteger(arguments_.height) || arguments_.height < 144) throw new Error('--height must be an integer >= 144')
  if (!Number.isInteger(arguments_.concurrency) || arguments_.concurrency < 1) throw new Error('--concurrency must be a positive integer')

  const inputPath = path.resolve(arguments_.inputPath)
  const videoPath = path.resolve(arguments_.videoPath)
  const outputInputPath = path.resolve(arguments_.outputInputPath)
  const assetsDirectory = path.resolve(arguments_.assetsDirectory)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  if (!Array.isArray(input.reviews) || input.reviews.length === 0) throw new Error('input reviews must be a non-empty array')

  const records = new Map()
  const output = structuredClone(input)
  const outputReview = (review) => {
    const baseReviewId = String(review.id).split('--')[0]
    const overviewPaths = review.overview.imagePaths.map((_, index) => {
      const sample = review.overview.samples[index]
      const key = `overview:${baseReviewId}:${sample.index}`
      const outputPath = path.join(assetsDirectory, 'overview', `${safeFileName(baseReviewId)}-${sample.index}.jpg`)
      records.set(key, {key, outputPath, timeSeconds: sample.timeSeconds})
      return outputPath
    })
    const targets = review.targets.map((target) => ({
      ...target,
      microSequence: {
        ...target.microSequence,
        imagePaths: target.microSequence.imagePaths.map((_, index) => {
          const sample = target.microSequence.samples[index]
          const key = `target:${target.targetRef.id}:${sample.index}`
          const outputPath = path.join(assetsDirectory, 'target-sequences', safeFileName(target.targetRef.id), `${sample.index}.jpg`)
          records.set(key, {key, outputPath, timeSeconds: sample.timeSeconds})
          return outputPath
        }),
      },
    }))
    return {...review, overview: {...review.overview, imagePaths: overviewPaths}, targets}
  }
  output.reviews = input.reviews.map(outputReview)

  const jobs = [...records.values()]
  let nextJob = 0
  async function worker() {
    while (true) {
      const jobIndex = nextJob
      nextJob += 1
      if (jobIndex >= jobs.length) return
      const job = jobs[jobIndex]
      await extractFrame(videoPath, job.timeSeconds, job.outputPath, arguments_.width, arguments_.height)
    }
  }
  await Promise.all(Array.from({length: Math.min(arguments_.concurrency, jobs.length)}, () => worker()))
  await mkdir(path.dirname(outputInputPath), {recursive: true})
  await writeFile(outputInputPath, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({sourceId: output.sourceId, reviewCount: output.reviews.length, imageCount: jobs.length, width: arguments_.width, height: arguments_.height, outputInput: outputInputPath, assetsDirectory}, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}

