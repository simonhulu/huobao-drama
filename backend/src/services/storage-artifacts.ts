import type Database from 'better-sqlite3'

export type ArtifactRole = 'source' | 'intermediate' | 'final' | 'shared' | 'project'
export interface ArtifactOwner { ownerType: string; ownerId: string; state: string; purpose?: ArtifactRole }
export interface TrackedArtifact {
  path: string; role: ArtifactRole; bytes: number; sha256?: string; owners: ArtifactOwner[]
}

export function createStorageRegistry(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT, state TEXT NOT NULL DEFAULT 'present',
      pinned INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL, released_at TEXT, review_json TEXT
    );
    CREATE TABLE IF NOT EXISTS storage_artifact_refs (
      artifact_id INTEGER NOT NULL REFERENCES storage_artifacts(id), owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL, state TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'source', updated_at TEXT NOT NULL,
      PRIMARY KEY(artifact_id,owner_type,owner_id)
    );
    CREATE INDEX IF NOT EXISTS storage_artifact_owner ON storage_artifact_refs(owner_type,owner_id);
    CREATE TABLE IF NOT EXISTS storage_cleanup_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, report_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_policy (id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL);
  `)
  if (!(db.pragma('table_info(storage_artifact_refs)') as Array<{name:string}>).some(column=>column.name==='purpose')) {
    db.exec("ALTER TABLE storage_artifact_refs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'source'")
  }
  const put = db.prepare(`INSERT INTO storage_artifacts(path,role,bytes,sha256,last_seen_at)
    VALUES(@path,@role,@bytes,@sha256,@seen) ON CONFLICT(path) DO UPDATE SET
    role=excluded.role,bytes=excluded.bytes,sha256=COALESCE(excluded.sha256,storage_artifacts.sha256),
    state='present',released_at=NULL,last_seen_at=excluded.last_seen_at RETURNING id`)
  const ref = db.prepare(`INSERT INTO storage_artifact_refs(artifact_id,owner_type,owner_id,state,purpose,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(artifact_id,owner_type,owner_id) DO UPDATE SET state=excluded.state,purpose=excluded.purpose,updated_at=excluded.updated_at`)
  const track = db.transaction((items: TrackedArtifact[]) => {
      const seen = new Date().toISOString()
      for (const item of items) {
        const { id } = put.get({path:item.path,role:item.role,bytes:item.bytes,sha256:item.sha256 || null,seen}) as { id: number }
        for (const owner of item.owners) ref.run(id, owner.ownerType, owner.ownerId, owner.state, owner.purpose || item.role, seen)
      }
    })
  return {
    track: (items: TrackedArtifact[]): void => { track(items) },
    owners(id: number): ArtifactOwner[] {
      return db.prepare('SELECT owner_type AS ownerType,owner_id AS ownerId,state,purpose FROM storage_artifact_refs WHERE artifact_id=?').all(id) as ArtifactOwner[]
    },
    get(id: number) { return db.prepare('SELECT * FROM storage_artifacts WHERE id=?').get(id) as Record<string, any> | undefined },
    byPath(filename: string) { return db.prepare('SELECT * FROM storage_artifacts WHERE path=?').get(filename) as Record<string, any> | undefined },
    release(filename: string, evidence: unknown, state = 'released') {
      db.prepare('UPDATE storage_artifacts SET state=?,released_at=?,review_json=? WHERE path=?')
        .run(state,new Date().toISOString(),JSON.stringify(evidence),filename)
    },
    pin(id: number, value: boolean) { db.prepare('UPDATE storage_artifacts SET pinned=? WHERE id=?').run(Number(value), id) },
  }
}
