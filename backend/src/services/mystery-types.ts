import type { MysteryAnalysis, MysteryPatch, MysteryReview, translateMysterySource } from './mystery-script.js'
import type { SourceMedia } from './history-source-pipeline.js'
import type { CbaUploadRecoveryCurrent } from './cba-upload-recovery.js'
import type { SocialUploadResult } from './social-auto-upload.js'

export type MysteryCategory = 'case' | 'event' | 'person'
export type MysteryTarget = 'draft' | 'video' | 'publish'
export type MysteryStage = 'download' | 'transcribe' | 'analyze' | 'edit' | 'review' | 'produce' | 'export' | 'covers' | 'publish' | 'completed'
export type MysteryStatus = 'draft' | 'queued' | 'running' | 'paused' | 'needs_attention' | 'ready' | 'completed'
export { MYSTERY_NARRATOR } from './mystery-script.js'
export interface MysteryRevision {
  id: number; createdAt: string; source: string; sourceHash: string; narrator: string
  analysis: MysteryAnalysis; patches: MysteryPatch[]; text: string; textHash: string
  review: MysteryReview | null
}
export interface MysteryEdition {
  id: string; revisionId: number; scriptHash: string; accountName: string
  createdAt: string; status: 'queued' | 'producing' | 'assets_ready' | 'exporting' | 'video_ready' | 'package_ready' | 'needs_attention'
  projectUrl: string | null; checkpoint: string | null; exportDispatched: boolean
  exportTask: { taskId: string; projectHash: string } | null
  requestedSettings: { aspect: string; voice: string; subtitle: string; visual: string }
  confirmedSettings: { scheme?: string }; message: string
  videoPath?: string; videoSha256?: string; duration?: number; width?: number; height?: number; bytes?: number
  videoUrl?: string; landscapePath?: string; portraitPath?: string; landscapeCoverUrl?: string; portraitCoverUrl?: string
  coverRevision: number; coverInstruction: string; coverPending?: boolean
  title: string; description: string; tags: string[]; publication?: MysteryPublication
  titleCandidates?: string[]
  publishingCopy?: Awaited<ReturnType<typeof import('./mystery-publishing-copy.js').generateMysteryPublishingCopy>>
}
export interface MysteryPublication {
  accountName: string; status: 'pending' | 'uploading' | 'submitted' | 'published' | 'uncertain' | 'paused' | 'failed'
  title: string; description: string; tags: string[]; creationDeclaration: string; watermark: string
  attempt: CbaUploadRecoveryCurrent | null; result: SocialUploadResult | null; message: string
}
export interface MysteryRun {
  id: string; requestId: string; target: MysteryTarget; taskId: number | null
  revisionId: number | null; editionId: string | null; status: MysteryStatus; stage: MysteryStage
  accountName: string | null; baijiahaoAccountName: string | null; stopped: boolean
  action: 'workflow' | 'covers' | 'review'; message: string; createdAt: string; updatedAt: string
}
export interface MysteryStory {
  id: number; title: string; category: MysteryCategory; sourceUrl: string; videoId: string
  sourceChannel: string; sourceTitle: string; downloadMode: 'video' | 'audio'; media: SourceMedia
  transcript: string; correctedTranscript: string; chunks: Array<{ start: number; duration: number; text: string }>
  transcriptVersion: number; narrator: string; analysis: MysteryAnalysis | null
  translation?: Awaited<ReturnType<typeof translateMysterySource>> | null
  revisions: MysteryRevision[]; currentRevisionId: number | null; editions: MysteryEdition[]; runs: MysteryRun[]
  status: MysteryStatus; stage: MysteryStage; message: string; version: number
  notes: string; relatedStoryIds: number[]; createdAt: string; updatedAt: string; archivedAt: string | null
  logs: Array<{ at: string; message: string; stage: MysteryStage }>; sourceVideoUrl?: string
}
export interface MysteryChannel { id: string; url: string; name: string; category: MysteryCategory; enabled: boolean; createdAt: string }
export interface MysteryCollection {
  id: string; requestId: string; channelIds: string[]; urls: string[]; category: MysteryCategory; targetCount: number
  target: MysteryTarget; downloadMode: 'video' | 'audio'; accountName: string | null; baijiahaoAccountName: string | null
  keywords: string[]; minSeconds: number; maxSeconds: number; afterDate: string
  status: MysteryStatus; stopped: boolean; taskId: number | null; scanned: number; skipped: number
  storyIds: number[]; errors: string[]; message: string; createdAt: string; updatedAt: string
}
