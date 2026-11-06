export type Category = 'case' | 'event' | 'person'
export type Target = 'draft' | 'video' | 'publish'
export interface Patch { id: string; start: number; end: number; original: string; replacement: string; reason: string; kind: 'wording' | 'identity' | 'promotion' | 'attribution' }
export interface Analysis {
  sourceHash: string; theme: string; purpose: string; stance: string; audienceNeeds: string[]; endingPayoff: string
  evidence: Array<{ id?: string; start: number; end: number; quote: string; note: string }>
  beats: Array<{ id: string; start: number; end: number; purpose: string; emotion: string; method: string; reveal: string }>
  identitySpans: Array<{ start: number; end: number; text: string; kind: string; reason: string }>
  dossier: {
    people: Array<{ name: string; aliases: string[]; role: string; evidenceIds: string[] }>
    timeline: Array<{ when: string; event: string; evidenceIds: string[] }>
    claims: Array<{ claim: string; basis: string; certainty: string; evidenceIds: string[] }>; uncertainties: string[]
  }
}
export interface Revision { id: number; createdAt: string; source: string; sourceHash: string; narrator: string; analysis: Analysis; patches: Patch[]; text: string; textHash: string; review: { passed: boolean; issues: Array<{ patchId?: string; kind: string; message: string }>; checkedAt: string; sourceHash: string; textHash: string } | null }
export interface Edition {
  id: string; revisionId: number; scriptHash: string; accountName: string; createdAt: string; status: string
  projectUrl: string | null; checkpoint: string | null; exportTask: { taskId: string; projectHash: string } | null
  requestedSettings: { aspect: string; voice: string; subtitle: string; visual: string }; confirmedSettings: { scheme: string }; message: string
  videoUrl?: string; videoPath?: string; duration?: number; width?: number; height?: number; bytes?: number
  landscapeCoverUrl?: string; portraitCoverUrl?: string; coverRevision: number; coverInstruction: string; coverPending?: boolean
  title: string; titleCandidates?: string[]; description: string; tags: string[]
  publication?: { accountName: string; status: string; title: string; description: string; tags: string[]; creationDeclaration: string; watermark: string; message: string; attempt?: { dispatched?: boolean } | null; result: Record<string, unknown> | null }
}
export interface Run { id: string; target: Target; taskId: number | null; revisionId: number | null; editionId: string | null; status: string; stage: string; accountName: string | null; baijiahaoAccountName: string | null; stopped: boolean; action: string; message: string; createdAt: string }
export interface Story {
  id: number; title: string; category: Category; sourceUrl: string; videoId: string; sourceChannel: string; sourceTitle: string; downloadMode: 'video' | 'audio'
  transcript: string; correctedTranscript: string; chunks: Array<{ start: number; duration: number; text: string }>; transcriptVersion: number
  narrator: string; analysis: Analysis | null; revisions: Revision[]; currentRevisionId: number | null; editions: Edition[]; runs: Run[]
  status: string; stage: string; message: string; version: number; notes: string; relatedStoryIds: number[]
  translation?: { text: string; sourceHash: string; textHash: string; segments: Array<{ id: string; sourceStart: number; sourceEnd: number; sourceText: string; textStart: number; textEnd: number; text: string }>; review: { passed: boolean; issues: Array<{ unitId: string; message: string }>; checkedAt: string } }
  createdAt: string; updatedAt: string; logs: Array<{ at: string; message: string; stage: string }>; sourceVideoUrl?: string
}
export interface Channel { id: string; url: string; name: string; category: Category; enabled: boolean }
export interface Collection { counts?: { selected: number; transcribed: number; drafts: number; videos: number; failed: number; published: number }; id: string; status: string; stopped: boolean; taskId: number | null; scanned: number; skipped: number; storyIds: number[]; errors: string[]; message: string; targetCount: number; target: Target; createdAt: string }
export interface Account { accountName: string; label: string; status: string; isDefault?: boolean }
export interface Accounts { accounts: Account[]; defaultAccountName?: string | null }
