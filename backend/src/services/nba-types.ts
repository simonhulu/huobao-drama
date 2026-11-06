export type NbaLanguage = 'zh' | 'en'
export type NbaStage = 'intake' | 'match' | 'script' | 'review' | 'media' | 'voice' | 'captions' | 'render' | 'verify' | 'completed'
export type NbaStatus = 'queued' | 'running' | 'stopped' | 'attention' | 'failed' | 'completed'

export interface NbaGame {
  id: string
  espnEventId?: string
  nbaGameId?: string
  tipoffUtc: string
  localDate: string
  localTimezone: string
  home: { name: string; abbreviation: string; score: number }
  away: { name: string; abbreviation: string; score: number }
  verified: boolean
  evidenceUrls: string[]
}

export interface NbaTopic {
  id: string
  videoId: string
  title: string
  description: string
  youtubeUrl: string
  channel?: string
  uploadDate?: string
}

export interface NbaArticle {
  id: string
  url: string
  title: string
  language: NbaLanguage
  publisher: string
  byline?: string
  publishedAt?: string
  body: string
  bodyHash: string
  wordCount: number
  characterCount: number
  collectedAt: string
  game?: NbaGame
  topic?: NbaTopic
  youtubeUrl?: string
  requestedGameDate?: string
  requestedEspnEventId?: string
  heldReason?: string
  sourceVideoId?: string
  sourceChannel?: string
}

export interface NbaSourceReport {
  id: string
  label: string
  status: 'ok' | 'partial' | 'failed'
  count: number
  error?: string
}

export interface NbaExcludedArticle {
  url: string
  title: string
  reason: string
  duplicateOf?: string
}

export interface NbaIntakeInput {
  languages: NbaLanguage[]
  limit: number
  articleUrls: string[]
  youtubeUrl?: string
  gameDate?: string
  espnEventId?: string
  topic?: NbaTopic
  signal?: AbortSignal
  existingArticles?: NbaArticle[]
  progress?: (message: string) => void
}

export interface NbaIntakeResult {
  articles: NbaArticle[]
  excluded: NbaExcludedArticle[]
  sources: NbaSourceReport[]
}

export interface NbaScript {
  title: string
  text: string
  facts: { claim: string; paragraph: number }[]
}

export interface NbaReview {
  passed: boolean
  issues: string[]
  checkedAt: string
}

export interface NbaMedia {
  id: string
  // Retain the manifest key for compatibility; topics use their own ID here.
  gameId: string
  sourceUrl: string
  path: string
  reducedAudioPath?: string
  duration: number
  fps: number
  width: number
  height: number
  sha256: string
  liveEndSeconds?: number
  closingStartSeconds?: number
  verified: boolean
  verificationNotes: string[]
}

export interface NbaDelivery {
  videoPath: string
  coverPath?: string
  portraitCoverPath?: string
  voicePath?: string
  subtitlesPath?: string
  assPath?: string
  duration: number
  bytes: number
  sha256: string
  verification: Record<string, unknown>
}

export interface NbaJob {
  id: string
  title: string
  article: NbaArticle
  game?: NbaGame
  script?: NbaScript
  review?: NbaReview
  media?: NbaMedia
  delivery?: NbaDelivery
  uploads?: NbaUpload[]
  qualityHold?: {
    reason: string
    detectedAt: string
    source: 'user-report' | 'inspection'
    originalBodyHash?: string
    cleanedBodyHash?: string
    rejectedDeliverySha256?: string
    duplicateOf?: string
  }
  status: NbaStatus
  stage: NbaStage
  message: string
  createdAt: string
  updatedAt: string
  attempts: number
  canResume: boolean
  logs: { at: string; stage: NbaStage; message: string }[]
  automaticRetryable?: boolean
}

export interface NbaSettings {
  youtubeChannels: string[]
  videosPerChannel: number
  languages: NbaLanguage[]
  limit: number
  autoProduce: boolean
  scheduleEnabled: boolean
  intervalMinutes: number
  voice: string
  speed: number
  originalGain: number
  arenaGain: number
  autoUpload: boolean
  baijiahaoAccountName?: string
}

export interface NbaUpload {
  id: string
  target: 'baijiahao-video'
  accountName: string
  accountLabel: string
  fingerprint: string
  inputDigest: string
  status: 'queued' | 'running' | 'saved' | 'blocked' | 'uncertain' | 'failed'
  message: string
  dispatched: boolean
  createdAt: string
  updatedAt: string
  payload?: import('./social-auto-upload.js').SocialUploadPayload
  publicationCopy?: { policy: 'nba-match-event-v1'; description: string }
  publishedDescriptionRevision?: {
    verification: 'original_article_server_description'
    articleId: string
    description: string
    verifiedAt: string
  }
  result?: import('./social-auto-upload.js').SocialUploadResult
  previousDraft?: {
    payload: import('./social-auto-upload.js').SocialUploadPayload
    result: import('./social-auto-upload.js').SocialUploadResult
    fingerprint: string
  }
  attempts?: import('./cba-upload-recovery.js').CbaUploadRecoveryAttempt[]
}

export interface NbaChannelVideo {
  videoId: string
  url: string
  channel: string
  title: string
  status: 'collected' | 'excluded' | 'failed'
  message: string
  articleIds: string[]
  gameId?: string
  searchedLanguages?: NbaLanguage[]
}

export interface NbaProductionInput {
  job: NbaJob
  jobDir: string
  sharedDir: string
  signal: AbortSignal
  settings: NbaSettings
  recentCoverPhotoSha256s?: string[]
  onProgress: (stage: NbaStage, message: string) => void
  checkpoint: (patch: Partial<NbaJob>) => void
}

export interface NbaRun {
  id: string
  requestId: string
  kind: 'collect' | 'produce' | 'resume' | 'upload'
  status: 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'attention' | 'failed'
  jobIds: string[]
  createdAt: string
  updatedAt: string
  message: string
  excluded: NbaExcludedArticle[]
  sources: NbaSourceReport[]
  youtubeChannels?: string[]
  collectionMode?: 'channels' | 'manual'
  videosPerChannel?: number
  videos?: NbaChannelVideo[]
  baijiahaoAccountName?: string
  baijiahaoAccountLabel?: string
  autoUpload?: boolean
  queueVersion?: 2
  collectionRunId?: string
  productionRunId?: string
  productionSettings?: NbaSettings
  resumeOnRestart?: boolean
  automaticRecovery?: { attempts: number; nextAttemptAt?: string }
}

export const NBA_DEFAULT_SETTINGS: NbaSettings = {
  youtubeChannels: ['https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ/videos'], videosPerChannel: 20,
  languages: ['en', 'zh'], limit: 6, autoProduce: true,
  scheduleEnabled: false, intervalMinutes: 60,
  voice: 'longanhuan_v3.1', speed: 1.05, originalGain: 0.32, arenaGain: 0.85,
  autoUpload: false,
}
