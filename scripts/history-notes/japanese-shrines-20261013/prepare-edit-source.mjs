import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '../../..')
const workDir = path.join(root, 'data/temp/japanese-shrines-20261013')
const sourcePath = path.join(workDir, 'source.json')
const outputPath = path.join(workDir, 'edit-source.json')
const titlesPath = path.join(workDir, 'titles.json')
const titlesOutputPath = path.join(workDir, 'titles-timeline.json')

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const storyboards = source.storyboards.map((shot) => ({
  ...shot,
  firstFrameImage: `temp/japanese-shrines-20261013/images-normalized/${String(shot.storyboardNumber).padStart(3, '0')}.png`,
}))

const snapshot = {
  ...source,
  storyboards,
  timingSource: {
    titles: 'titles.json',
    narration: 'data/static/audio/8b1466e8-9ccc-4b4e-a24d-a07eb42a2978_pre_episode1047.mp3',
  },
}

fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`)
const titlesPayload = JSON.parse(fs.readFileSync(titlesPath, 'utf8'))
const titles = Array.isArray(titlesPayload) ? titlesPayload : titlesPayload.titles
if (!Array.isArray(titles) || titles.length === 0) throw new Error('titles.json does not contain a nonempty titles array')
fs.writeFileSync(titlesOutputPath, `${JSON.stringify(titles, null, 2)}\n`)
console.log(JSON.stringify({ outputPath, titlesOutputPath, episodeId: snapshot.episode.id, storyboards: storyboards.length, titles: titles.length }, null, 2))
