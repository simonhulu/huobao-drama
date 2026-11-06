import type Database from 'better-sqlite3'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { MysteryStory, MysteryChannel, MysteryCollection } from './mystery-types.js'

export class MysteryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'MysteryError' }
}
export const mysteryCategorySchema = z.enum(['case', 'event', 'person'])
const account = z.string().trim().min(1).max(100).nullable().optional()
export const mysteryCreateSchema = z.object({ sourceUrl: z.string().trim().min(1).max(2048), title: z.string().trim().max(160).optional(),
  category: mysteryCategorySchema.default('case'), downloadMode: z.enum(['video', 'audio']).default('video') }).strict()
export const mysteryPatchSchema = z.object({ expectedVersion: z.number().int().positive(), title: z.string().trim().min(1).max(160).optional(),
  category: mysteryCategorySchema.optional(), correctedTranscript: z.string().min(1).max(300_000).optional(),
  narrator: z.string().trim().min(1).max(3000).optional(), notes: z.string().max(30_000).optional(),
  relatedStoryIds: z.array(z.number().int().positive()).max(100).optional() }).strict()
export const mysteryPublicationSchema = z.object({ title: z.string().trim().min(1).max(50), description: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(80)).max(20), creationDeclaration: z.string().trim().min(1).max(100), watermark: z.string().trim().min(1).max(100) }).strict()
export const mysteryRunSchema = z.object({ requestId: z.string().min(8).max(100), target: z.enum(['draft','video','publish']).default('video'),
  huashengAccountName: account, baijiahaoAccountName: account, revisionId: z.number().int().positive().optional(), editionId: z.string().max(100).optional(),
  action: z.enum(['workflow','covers','review']).default('workflow'), coverInstruction: z.string().max(1000).optional(),
  publication: mysteryPublicationSchema.optional() }).strict()
export const mysteryChannelSchema = z.object({ url: z.string().trim().min(1).max(2048), name: z.string().trim().min(1).max(100),
  category: mysteryCategorySchema.default('case'), enabled: z.boolean().default(true) }).strict()
export const mysteryCollectionSchema = z.object({ requestId: z.string().min(8).max(100), channelIds: z.array(z.string().max(100)).max(30).default([]),
  urls: z.array(z.string().trim().max(2048)).max(30).default([]), category: mysteryCategorySchema.default('case'),
  targetCount: z.number().int().min(1).max(100).default(5), target: z.enum(['draft','video','publish']).default('video'),
  downloadMode: z.enum(['video','audio']).default('video'), huashengAccountName: account, baijiahaoAccountName: account,
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).default([]), minSeconds: z.number().min(0).default(0),
  maxSeconds: z.number().min(0).default(0), afterDate: z.string().regex(/^(?:\d{4}-?\d{2}-?\d{2})?$/).default(''),
  publication: mysteryPublicationSchema.optional(),
  publicationSettings: mysteryPublicationSchema.pick({creationDeclaration:true,watermark:true}).optional() }).strict()

export class MysteryStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mystery_stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mystery_channels (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS mystery_collections (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS mystery_resource_locks (resource TEXT PRIMARY KEY, task_id INTEGER NOT NULL, lease_token TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mystery_story_state ON mystery_stories(archived_at,json_extract(data,'$.status'));
    `)
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate() }
  get(id: number): MysteryStory {
    const row = this.db.prepare('SELECT data FROM mystery_stories WHERE id=?').get(id) as {data:string}|undefined
    if (!row) throw new MysteryError('故事不存在', 404)
    return JSON.parse(row.data)
  }
  findVideo(videoId: string): MysteryStory | null {
    const row = this.db.prepare('SELECT data FROM mystery_stories WHERE video_id=?').get(videoId) as {data:string}|undefined
    return row ? JSON.parse(row.data) : null
  }
  create(input: Omit<MysteryStory,'id'>): MysteryStory {
    return this.transaction(() => {
      const found = this.findVideo(input.videoId)
      if (found) return found
      const result = this.db.prepare('INSERT INTO mystery_stories(video_id,data,version,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(input.videoId, JSON.stringify(input), input.version, input.createdAt, input.updatedAt)
      const story = { ...input, id: Number(result.lastInsertRowid) }
      this.db.prepare('UPDATE mystery_stories SET data=? WHERE id=?').run(JSON.stringify(story), story.id)
      return story
    })
  }
  update(id: number, change: (story: MysteryStory) => void, expectedVersion?: number): MysteryStory {
    return this.transaction(() => {
      const story = this.get(id)
      if (expectedVersion !== undefined && story.version !== expectedVersion) throw new MysteryError('故事已更新；你的未保存内容仍保留，请载入最新版本后再保存')
      change(story)
      story.version++; story.updatedAt = new Date().toISOString()
      this.db.prepare('UPDATE mystery_stories SET data=?,version=?,updated_at=?,archived_at=? WHERE id=?')
        .run(JSON.stringify(story), story.version, story.updatedAt, story.archivedAt, id)
      return story
    })
  }
  list(input: {search?:string;category?:string;status?:string;hasEdition?:boolean;page?:number;pageSize?:number} = {}) {
    const page = Math.max(1, input.page || 1), pageSize = Math.min(100, Math.max(1,input.pageSize || 20))
    const where = ['archived_at IS NULL'], params: string[] = []
    if(input.search) { where.push("(json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(data,'$.sourceChannel') LIKE ? ESCAPE '\\')"); const term = `%${input.search.replace(/[\\%_]/g,'\\$&')}%`; params.push(term,term) }
    if(input.category) { where.push("json_extract(data,'$.category')=?"); params.push(input.category) }
    if(input.status) { where.push("json_extract(data,'$.status')=?"); params.push(input.status) }
    if(input.hasEdition)where.push("json_array_length(data,'$.editions') > 0")
    const clause = where.join(' AND ')
    const total = (this.db.prepare(`SELECT count(*) AS n FROM mystery_stories WHERE ${clause}`).get(...params) as {n:number}).n
    const items = (this.db.prepare(`SELECT data FROM mystery_stories WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize) as {data:string}[]).map(row=>JSON.parse(row.data) as MysteryStory)
    const counts: Record<string,number> = { total:0,draft:0,queued:0,running:0,ready:0,needs_attention:0,paused:0,completed:0 }
    const rows = this.db.prepare("SELECT json_extract(data,'$.status') AS status,count(*) AS n FROM mystery_stories WHERE archived_at IS NULL GROUP BY status").all() as {status:string;n:number}[]
    for(const row of rows) { counts[row.status]=row.n; counts.total+=row.n }
    return {items,total,page,pageSize,counts}
  }
  channels(): MysteryChannel[] { return (this.db.prepare('SELECT data FROM mystery_channels ORDER BY rowid').all() as {data:string}[]).map(row=>JSON.parse(row.data)) }
  saveChannel(input: z.infer<typeof mysteryChannelSchema>, id?: string) {
    const current = id ? this.channels().find(c=>c.id===id) : this.channels().find(c=>c.url===input.url)
    if(id && !current) throw new MysteryError('频道不存在',404)
    const channel: MysteryChannel = { ...input, id: current?.id || randomUUID(), createdAt:current?.createdAt || new Date().toISOString() }
    this.db.prepare('INSERT INTO mystery_channels(id,url,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,data=excluded.data').run(channel.id, channel.url,JSON.stringify(channel))
    return channel
  }
  collections(): MysteryCollection[] { return (this.db.prepare('SELECT data FROM mystery_collections ORDER BY rowid DESC').all() as {data:string}[]).map(row=>JSON.parse(row.data)) }
  collection(id: string): MysteryCollection { const result = this.collections().find(c=>c.id===id); if(!result) throw new MysteryError('采集批次不存在',404); return result }
  saveCollection(value: MysteryCollection) { this.db.prepare('INSERT INTO mystery_collections(id,request_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,value.requestId,JSON.stringify(value)); return value }
  updateCollection(id: string, change: (value:MysteryCollection)=>void) { return this.transaction(()=> { const value=this.collection(id); change(value); value.updatedAt=new Date().toISOString(); return this.saveCollection(value) }) }
}
