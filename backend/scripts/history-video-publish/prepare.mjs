#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PROJECT_ROOT, api, execFileAsync, fail, isMain, loadPackage, packageIdentity, parseScriptReference, probeVideo, readJson, sha256, validatePackaging, verifyVideo, writeJson } from './lib.mjs'

export async function preparePackage({ script, video, packagingPath, scriptFile, origin, outputRoot = path.join(PROJECT_ROOT, 'data/history-video-publish') }) {
  const reference = parseScriptReference(script, origin)
  const source = await api(reference.origin, `/history-scripts/${reference.id}`)
  if (source?.id !== reference.id || source.deletedAt) throw new Error('History script does not match the requested ID')
  if (!scriptFile && source.artifactState?.rewritten !== 'current') throw new Error('Rewritten script is missing or stale; provide the actual production snapshot with --script-file')
  const production = scriptFile ? fs.readFileSync(path.resolve(scriptFile), 'utf8') : source.rewrittenScript
  if (!production?.trim()) throw new Error('Production script is empty')
  const packaging = validatePackaging(readJson(packagingPath))
  const media = await probeVideo(video)
  let sourceMedia
  try { sourceMedia = JSON.parse(source.mediaJson || '{}') } catch { sourceMedia = {} }
  if (sourceMedia.videoSha256 === media.sha256) throw new Error('This is the collected source video, not the external production video')
  const scriptHash = sha256(production)
  const packagingHash = sha256(JSON.stringify(packaging))
  const id = packageIdentity(source.id, scriptHash, media.sha256, packagingHash)
  const directory = path.join(path.resolve(outputRoot), id)
  if (fs.existsSync(path.join(directory, 'state.json'))) {
    const existing = loadPackage(directory)
    await verifyVideo(existing.video)
    return { ok: true, reused: true, package_id: id, directory }
  }
  if (fs.existsSync(directory)) throw new Error(`Incomplete package exists: ${directory}; inspect it before recovery`)
  fs.mkdirSync(path.join(directory, 'frames'), { recursive: true })
  writeJson(path.join(directory, 'source-snapshot.json'), {
    fetched_at: new Date().toISOString(), script_url: reference.url, source,
    production_script_source: scriptFile ? path.resolve(scriptFile) : 'current_rewritten_script',
    script_sha256: scriptHash,
    correspondence: 'User supplied this script/video pairing; representative frames are not a full transcript audit.',
  })
  fs.writeFileSync(path.join(directory, 'production-script.txt'), production, { flag: 'wx' })
  writeJson(path.join(directory, 'video-reference.json'), media)
  writeJson(path.join(directory, 'publishing-package.json'), packaging)
  const times = [Math.min(2, media.duration_seconds / 4), media.duration_seconds / 2, Math.max(0, media.duration_seconds - 3)]
  const frames = []
  for (const [index, seconds] of times.entries()) {
    const filename = path.join(directory, 'frames', `${index + 1}.jpg`)
    await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', media.path, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', filename])
    frames.push({ path: filename, seconds })
  }
  writeJson(path.join(directory, 'state.json'), {
    version: 1, package_id: id, history_source_id: source.id, script_url: reference.url,
    source_revision: source.revision, script_sha256: scriptHash, video_sha256: media.sha256,
    packaging_sha256: packagingHash, api_origin: reference.origin, frames,
    created_at: new Date().toISOString(), backgrounds: {},
    platforms: Object.fromEntries(Object.keys(packaging.platforms).map((name) => [name, { status: 'not_started' }])),
  })
  return { ok: true, reused: false, package_id: id, directory, frames }
}

async function main() {
  const { values } = parseArgs({ options: {
    script: { type: 'string' }, video: { type: 'string' }, packaging: { type: 'string' },
    'script-file': { type: 'string' }, origin: { type: 'string' }, 'output-root': { type: 'string' },
  } })
  for (const flag of ['script', 'video', 'packaging']) if (!values[flag]) throw new Error(`Missing --${flag}`)
  const result = await preparePackage({ script: values.script, video: values.video, packagingPath: values.packaging,
    scriptFile: values['script-file'], origin: values.origin, outputRoot: values['output-root'] })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
if (isMain(import.meta.url)) main().catch(fail)
