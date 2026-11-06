import Database from 'better-sqlite3'
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

interface ArchiveOptions {
  dataRoot?: string
  review?: Record<string,unknown>
  assertCanRelease?: ()=>void|Promise<void>
}
interface ArchiveRecord {
  version:1
  status:'prepared'|'archived'|'restored'|'canceled'
  backupPath:string
  sha256:string
  bytes:number
  preparedAt:string
  archivedAt?:string
  restoredAt?:string
  error?:string
}
type Row=Record<string,any>
type FileInfo=Awaited<ReturnType<typeof fs.lstat>>
const defaultDataRoot=fileURLToPath(new URL('../../../data',import.meta.url))
const inside=(root:string,file:string)=>file.startsWith(root+path.sep)
function json(value:unknown):Row {
  try {const parsed=JSON.parse(String(value));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}
  catch{return {}}
}
function sameFile(a:FileInfo,b:FileInfo) {
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
}
async function regularFile(filename:string) {
  if (await fs.realpath(filename)!==filename) throw Error('Archive media cannot use a redirected path')
  const info=await fs.lstat(filename)
  if (!info.isFile()) throw Error('Archive media must be a regular file')
  return info
}
async function hashFile(filename:string) {
  const before=await regularFile(filename),hash=createHash('sha256')
  for await(const bytes of createReadStream(filename)) hash.update(bytes)
  if (!sameFile(before,await regularFile(filename))) throw Error('Archive media changed during verification')
  return hash.digest('hex')
}
async function managedPath(filename:string,dataRoot:string) {
  if (!path.isAbsolute(filename)||!inside(dataRoot,filename)||path.resolve(filename)!==filename
    ||await fs.realpath(dataRoot)!==dataRoot) throw Error('Original media is outside the canonical managed data directory')
}
async function ensureParent(filename:string,dataRoot:string) {
  let directory=dataRoot
  for (const segment of path.relative(dataRoot,path.dirname(filename)).split(path.sep).filter(Boolean)) {
    directory=path.join(directory,segment)
    await fs.mkdir(directory).catch(error=>{if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error})
    if (!(await fs.lstat(directory)).isDirectory()||await fs.realpath(directory)!==directory) throw Error('Original media directory is redirected')
  }
}
function saveReview(database:Database.Database,id:number,review:Row,archive:ArchiveRecord,state?:'present'|'archived') {
  const value=JSON.stringify({...review,archive})
  if (state) database.prepare('UPDATE storage_artifacts SET state=?,review_json=?,released_at=? WHERE id=?')
    .run(state,value,state==='archived'?archive.archivedAt:null,id)
  else database.prepare('UPDATE storage_artifacts SET review_json=? WHERE id=?').run(value,id)
}

/** The manager supplies consumer checks; the backup identity is durable before unlink. */
export async function archiveVerifiedFile(database:Database.Database,id:number,inputSHA:string,backupPath:string,options:ArchiveOptions={}) {
  const dataRoot=path.resolve(options.dataRoot||defaultDataRoot)
  const record=database.prepare('SELECT * FROM storage_artifacts WHERE id=?').get(id) as Row|undefined
  if (!record||record.state!=='present'||!/^[a-f0-9]{64}$/.test(inputSHA)) throw Error('Archive requires a present tracked file and its verified SHA-256')
  if (!database.prepare('SELECT 1 FROM storage_artifact_refs WHERE artifact_id=? LIMIT 1').get(id)) throw Error('Archive requires task ownership')
  await managedPath(record.path,dataRoot)
  if (!path.isAbsolute(backupPath)) throw Error('Archive backup path must be absolute')
  const backup=path.resolve(backupPath),original=await regularFile(record.path),copy=await regularFile(backup)
  if (backup===dataRoot||inside(dataRoot,backup)||original.dev===copy.dev&&original.ino===copy.ino
    ||await hashFile(record.path)!==inputSHA||await hashFile(backup)!==inputSHA) throw Error('Archive backup must be independent, outside managed data, and byte-identical')
  const archive:ArchiveRecord={version:1,status:'prepared',backupPath:backup,sha256:inputSHA,bytes:original.size,preparedAt:new Date().toISOString()}
  const review={...json(record.review_json),...options.review}
  saveReview(database,id,review,archive)
  try {
    await options.assertCanRelease?.()
    if (!sameFile(original,await regularFile(record.path))||!sameFile(copy,await regularFile(backup))) throw Error('Original or backup changed before archive release')
    await fs.unlink(record.path)
  } catch(error) {
    archive.status='canceled';archive.error=(error as Error).message
    saveReview(database,id,review,archive)
    throw error
  }
  archive.status='archived';archive.archivedAt=new Date().toISOString()
  saveReview(database,id,review,archive,'archived')
  return {status:'archived' as const,path:record.path as string,backupPath:backup,sha256:inputSHA,bytes:original.size}
}

/** Restore missing originals as regular files, keeping engineering path guards intact. */
export async function restoreArchivedArtifacts(database:Database.Database,ownerType:string,ownerId:string,options:Pick<ArchiveOptions,'dataRoot'>={}) {
  const dataRoot=path.resolve(options.dataRoot||defaultDataRoot)
  const records=database.prepare(`SELECT a.* FROM storage_artifacts a JOIN storage_artifact_refs r ON r.artifact_id=a.id
    WHERE r.owner_type=? AND r.owner_id=? AND a.review_json IS NOT NULL`).all(ownerType,ownerId) as Row[]
  const result={restored:0,alreadyPresent:0,errors:[] as Array<{id:number;path:string;message:string}>}
  for (const record of records) {
    const review=json(record.review_json),archive=review.archive as ArchiveRecord|undefined
    if (!archive||archive.status==='canceled') continue
    try {
      if (archive.version!==1||!/^[a-f0-9]{64}$/.test(archive.sha256)||typeof archive.backupPath!=='string') throw Error('Archive evidence is incomplete')
      await managedPath(record.path,dataRoot)
      const existing=await fs.lstat(record.path).catch(error=>{if ((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error})
      if (archive.status==='restored'&&record.state==='present'&&existing) {result.alreadyPresent++;continue}
      if (existing) {
        if (await hashFile(record.path)!==archive.sha256) throw Error('Existing original differs; restoration will not overwrite it')
        archive.status='restored';archive.restoredAt=new Date().toISOString();saveReview(database,record.id,review,archive,'present')
        result.alreadyPresent++;continue
      }
      const backup=path.resolve(archive.backupPath)
      if (!path.isAbsolute(archive.backupPath)||backup===dataRoot||inside(dataRoot,backup)
        ||await hashFile(backup)!==archive.sha256) throw Error('Archive backup is missing, redirected, or changed')
      await ensureParent(record.path,dataRoot)
      const {assertMediaDiskSpace}=await import(new URL(import.meta.url.endsWith('.ts') ? './storage-space.ts' : './storage-space.js',import.meta.url).href)
      await assertMediaDiskSpace(path.dirname(record.path),archive.bytes)
      const temporary=record.path+'.storage-restore-'+randomUUID()
      try {
        await fs.copyFile(backup,temporary,fs.constants.COPYFILE_EXCL)
        if (await hashFile(temporary)!==archive.sha256) throw Error('Restored media hash does not match the archive')
        // link publishes atomically and fails if a producer recreated the path.
        await fs.link(temporary,record.path)
      } finally {await fs.unlink(temporary).catch(()=>{})}
      archive.status='restored';archive.restoredAt=new Date().toISOString();saveReview(database,record.id,review,archive,'present')
      result.restored++
    } catch(error) {result.errors.push({id:record.id,path:record.path,message:(error as Error).message})}
  }
  return result
}

export async function restoreTaskArchivedMedia(ownerType:string,ownerId:string,projectRoot=fileURLToPath(new URL('../../../',import.meta.url))) {
  const filename=process.env.DB_PATH||path.join(projectRoot,'data/huobao_drama.db')
  const empty={restored:0,alreadyPresent:0,errors:[] as Array<{id:number;path:string;message:string}>}
  if (filename===':memory:'||!await fs.lstat(filename).then(info=>info.isFile(),error=>{if (error.code==='ENOENT') return false;throw error})) return empty
  const database=new Database(filename,{fileMustExist:true,timeout:30_000})
  try {
    const tables=new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name))
    if (!tables.has('storage_artifacts')||!tables.has('storage_artifact_refs')) return empty
    const result=await restoreArchivedArtifacts(database,ownerType,ownerId,{dataRoot:path.resolve(projectRoot,'data')})
    if (result.errors.length) throw Error(result.errors.map(error=>`${path.basename(error.path)}: ${error.message}`).join('; '))
    return result
  } finally {database.close()}
}
