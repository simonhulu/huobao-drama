import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The renderer runs this source directly under Node's TypeScript support;
// compiled backend consumers resolve the emitted JavaScript instead.
const { createSourceMediaReferenceInspector } = await import(new URL(import.meta.url.endsWith('.ts')
  ? './storage-source-references.ts' : './storage-source-references.js',import.meta.url).href) as typeof import('./storage-source-references.js')

const defaultProjectRoot = fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'')
const within = (directory: string, filename: string) => filename === directory || filename.startsWith(directory+path.sep)
export interface RenderCacheReferenceOptions { projectRoot?: string; databasePath?: string }

/** One whole-group check, reused only while the database stays unchanged. No migrations. */
export function createHistoryMotionRenderCacheGuard(output: string, files: string[], options: RenderCacheReferenceOptions = {}): {
  assertUnreferenced: () => void; withCleanupLock: (cleanup: () => void) => void; close: () => void
} {
  const outputPath = path.resolve(output)
  const root = options.projectRoot ? path.resolve(options.projectRoot)
    : within(defaultProjectRoot,outputPath) ? defaultProjectRoot : undefined
  if (!root && options.databasePath) throw Error('Render reference database requires its project root')
  const relative = root && path.relative(root,outputPath)
  const motionId = relative && /^data\/storage\/history-motion\/([a-f\d-]{36})\//i.exec(relative)?.[1]
  const jobDirectory = motionId ? path.join(root!,'data/storage/history-motion',motionId) : path.dirname(outputPath)
  const preserveMarkers = [...new Set([jobDirectory,path.dirname(outputPath),outputPath+'.render'])]
    .map(directory => path.join(directory,'storage-preserve.json'))
  let database: Database.Database | undefined, checkedVersion: number | undefined
  let databaseFilename: string | undefined, databaseIdentity: fs.Stats | undefined
  let inspect: ReturnType<typeof createSourceMediaReferenceInspector> | undefined
  const prepare = () => {
    for (const marker of preserveMarkers) {
      try { fs.lstatSync(marker); throw Error('Render cache has an explicit preservation marker') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    // Standalone renders outside the application do not read its live registry.
    if (!root || !files.length) return
    if (!database) {
      const filename = path.resolve(options.databasePath || (root === defaultProjectRoot && process.env.DB_PATH) || path.join(root,'data/huobao_drama.db'))
      const info = fs.lstatSync(filename)
      if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(filename) !== filename) throw Error('Render reference database is not an ordinary local file')
      database = new Database(filename,{readonly:true,fileMustExist:true})
      databaseFilename = filename; databaseIdentity = info
      inspect = createSourceMediaReferenceInspector(database,{directory:jobDirectory,files,ownerType:'history-motion',
        ownerId:motionId || `standalone:${outputPath}`},root)
    }
  }
  const rejectReferences = (references: ReturnType<ReturnType<typeof createSourceMediaReferenceInspector>>) => {
    if (references.length) throw Error(`Render cache retained: ${references.some(ref => ref.reason === 'pinned') ? 'pinned' : 'shared input reference'}`)
  }
  const assertUnreferenced = () => {
    prepare()
    if (!database) return
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = database.pragma('data_version',{simple:true}) as number
      if (before === checkedVersion) return
      const references = inspect!()
      const after = database.pragma('data_version',{simple:true}) as number
      rejectReferences(references)
      if (before === after) { checkedVersion = after; return }
      // Other production can update progress during the first expensive scan.
      // Re-read current data; unchanged JSON reuses only its parsed reference result.
    }
    throw Error('Render cache ownership changed while checking; cache retained')
  }
  const withCleanupLock = (cleanup: () => void) => {
    prepare()
    if (!database) { cleanup(); return }
    // Expensive initial parsing never holds a write reservation. It is only a
    // warmup; the latest state is rechecked below while other writers are blocked.
    const before = database.pragma('data_version',{simple:true}) as number
    if (before !== checkedVersion) {
      rejectReferences(inspect!())
      const after = database.pragma('data_version',{simple:true}) as number
      checkedVersion = before === after ? after : undefined
    }
    const info = fs.lstatSync(databaseFilename!)
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== databaseIdentity!.dev || info.ino !== databaseIdentity!.ino) {
      throw Error('Render reference database changed; cache retained')
    }
    const reservation = new Database(databaseFilename!,{fileMustExist:true,timeout:1000})
    try {
      reservation.exec('BEGIN IMMEDIATE')
      assertUnreferenced()
      // The renderer supplies synchronous filesystem removal only. No browser,
      // network work or await may escape this short critical section.
      cleanup()
      reservation.exec('COMMIT')
    } catch (error) {
      if (reservation.inTransaction) reservation.exec('ROLLBACK')
      throw error
    } finally { reservation.close() }
  }
  return {assertUnreferenced,withCleanupLock,close:() => { database?.close() }}
}
