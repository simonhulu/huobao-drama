import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkSourceMediaReferences, type SourceMediaReference, type SourceReferenceOptions } from './storage-source-references.js'

interface ReleasedFile {
  path: string
  bytes: number
  sha256?: string
  status: 'pending' | 'released' | 'missing' | 'failed' | 'retained'
  releasedAt?: string
  error?: string
}
interface SourceReleaseRecord {
  version: 1
  ownerType: 'history-source' | 'science-job'
  ownerId: string
  reason: 'complete-transcript'
  sourceSha256: string
  transcriptSha256: string
  files: ReleasedFile[]
  status: 'planned' | 'partial' | 'completed' | 'retained'
  createdAt: string
  updatedAt: string
  releasedAt?: string
  previousReleases?: SourceReleaseRecord[]
  retention?: { code: string; references?: SourceMediaReference[]; message?: string }
}
interface SourceReleaseInput {
  directory: string
  ownerType: SourceReleaseRecord['ownerType']
  ownerId: string
  sourceSha256: string
  transcriptSha256: string
  matchesFile: (name: string) => boolean
  fileHashes?: Record<string, string>
  referenceOptions?: SourceReferenceOptions
}

async function saveManifest(filename: string, manifest: SourceReleaseRecord) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(manifest, null, 2))
    await handle.sync()
    await handle.close(); handle = undefined
    await fs.rename(temporary, filename)
    const directory = await fs.open(path.dirname(filename), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await handle?.close()
    await fs.rm(temporary, { force: true })
  }
}

async function hashFile(filename: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}

async function preservedFiles(directory: string): Promise<Set<string>> {
  try {
    const marker = path.join(directory, 'storage-preserve.json')
    const info = await fs.lstat(marker)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid preservation marker')
    const value = JSON.parse(await fs.readFile(marker, 'utf8'))
    if (value?.version !== 1 || !Array.isArray(value.files)
      || value.files.some((name: unknown) => typeof name !== 'string' || !name || path.basename(name) !== name
        || name === '.' || name === '..' || name.includes('\\'))) throw new Error('Invalid preservation marker')
    return new Set(value.files)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw Object.assign(new Error('Source preservation settings are invalid; media was retained'), { code: 'SOURCE_PRESERVATION_INVALID' })
  }
}

/** Persist ownership and transcript evidence before removing any source bytes. */
export async function releaseSourceMediaFiles(input: SourceReleaseInput, unlinkFile = fs.unlink) {
  if (!input.ownerId || !/^[a-f0-9]{64}$/.test(input.sourceSha256) || !/^[a-f0-9]{64}$/.test(input.transcriptSha256)) {
    throw new Error('Source release requires owner and complete transcript hashes')
  }
  const directory = path.resolve(input.directory)
  if (await fs.realpath(directory) !== directory) throw new Error('Source release directory is redirected')
  const initialPreserved = await preservedFiles(directory)
  const filename = path.join(directory, 'storage-release.json')
  let previous: SourceReleaseRecord | undefined
  try { previous = JSON.parse(await fs.readFile(filename, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (previous && (previous.version !== 1 || previous.ownerType !== input.ownerType || previous.ownerId !== input.ownerId
    || !Array.isArray(previous.files))) throw new Error('Source release manifest owner does not match this task')

  const files: ReleasedFile[] = []
  const snapshots = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>()
  for (const name of await fs.readdir(directory)) {
    if (!input.matchesFile(name)) continue
    const filePath = path.join(directory, name)
    const info = await fs.lstat(filePath)
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Source release entry is not a file')
    snapshots.set(filePath, info)
    const sha256 = info.isFile() ? input.fileHashes?.[name] : undefined
    files.push({ path: filePath, bytes: info.isFile() ? info.size : 0, ...(sha256 ? { sha256 } : {}), status: 'pending' })
  }
  if (!files.length && previous?.status === 'completed') return { releasedBytes: 0, releasedAt: previous.releasedAt }
  const sameRelease = previous && previous.status !== 'completed' && previous.sourceSha256 === input.sourceSha256
    && previous.transcriptSha256 === input.transcriptSha256
  if (sameRelease && previous) for (const file of previous.files) {
    if (path.dirname(file.path) !== directory || !input.matchesFile(path.basename(file.path))) throw new Error('Source release manifest contains an invalid file path')
    if (!files.some(current => current.path === file.path)) files.push(file)
  }
  const now = new Date().toISOString()
  const manifest: SourceReleaseRecord = { version: 1, ownerType: input.ownerType, ownerId: input.ownerId,
    reason: 'complete-transcript', sourceSha256: input.sourceSha256, transcriptSha256: input.transcriptSha256,
    files, status: 'planned', createdAt: sameRelease && previous ? previous.createdAt : now, updatedAt: now,
    ...(previous ? { previousReleases: sameRelease ? previous.previousReleases : [...previous.previousReleases || [], { ...previous, previousReleases: undefined }] } : {}) }
  await saveManifest(filename, manifest)

  let releasedBytes = 0
  let retention: SourceReleaseRecord['retention'] = files.some(file => !['released', 'missing'].includes(file.status)
    && initialPreserved.has(path.basename(file.path))) ? { code: 'SOURCE_MEDIA_PINNED' } : undefined
  const referenceRetention = async (): Promise<SourceReleaseRecord['retention']> => {
    try {
      const references = await checkSourceMediaReferences({directory,ownerType:input.ownerType,ownerId:input.ownerId,
        files:files.filter(file => !['released','missing'].includes(file.status)).map(file => file.path)},input.referenceOptions)
      return references.length ? {code:references.some(ref => ref.reason === 'pinned') ? 'SOURCE_MEDIA_PINNED' : 'SOURCE_MEDIA_SHARED',references} : undefined
    } catch (error) { return {code:'SOURCE_MEDIA_GUARD_FAILED',message:(error as Error).message} }
  }
  retention ||= await referenceRetention()
  const errors: string[] = []
  for (const file of files) {
    if (retention) break
    if (file.status === 'released' || file.status === 'missing') continue
    try {
      const before = snapshots.get(file.path)
      const current = await fs.lstat(file.path)
      if (!before || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs
        || current.isFile() && file.sha256 && await hashFile(file.path) !== file.sha256) throw new Error('Source media changed after its transcript was saved')
      const preserved = await preservedFiles(directory)
      if (files.some(entry => !['released', 'missing'].includes(entry.status) && preserved.has(path.basename(entry.path)))) {
        retention = {code:'SOURCE_MEDIA_PINNED'}
        break
      }
      retention = await referenceRetention()
      if (retention) break
      await unlinkFile(file.path)
      file.status = 'released'; file.releasedAt = new Date().toISOString(); delete file.error
      releasedBytes += file.bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') file.status = 'missing'
      else {
        file.status = 'failed'; file.error = (error as NodeJS.ErrnoException).code || 'SOURCE_MEDIA_CHANGED'
        errors.push(file.error)
      }
    }
  }
  if (retention) {
    errors.push(retention.code)
    manifest.retention = retention
    for (const file of files) if (!['released', 'missing'].includes(file.status)) { file.status = 'retained'; file.error = retention.code }
  }
  manifest.status = retention ? 'retained' : errors.length ? 'partial' : 'completed'
  manifest.updatedAt = new Date().toISOString()
  if (!errors.length) manifest.releasedAt = files.filter(file => file.status === 'released').at(-1)?.releasedAt || manifest.updatedAt
  await saveManifest(filename, manifest)
  return { releasedBytes, releasedAt: manifest.releasedAt, ...(errors.length ? { error: errors.join(', ') } : {}) }
}
