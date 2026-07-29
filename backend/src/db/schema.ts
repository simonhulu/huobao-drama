/**
 * Drizzle schema — 精确匹配现有 SQLite 数据库列名
 * 从 PRAGMA table_info() 逆向生成
 */
import { sqliteTable, text, integer, real, primaryKey, unique, customType } from 'drizzle-orm/sqlite-core'
import { decryptSecret, encryptSecret } from '../services/secret-crypto.js'

const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text'
  },
  fromDriver(value) {
    return decryptSecret(value)
  },
  toDriver(value) {
    return encryptSecret(value)
  },
})

export const mediaAccounts = sqliteTable('media_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  handle: text('handle'),
  positioningJson: text('positioning_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mediaAccountId: integer('media_account_id'),
  title: text('title').notNull(),
  videoTitle: text('video_title'),
  description: text('description'),
  genre: text('genre'),
  style: text('style').default('realistic'),
  workflowType: text('workflow_type').default('story_rewrite'),
  pacingMode: text('pacing_mode').default('tight'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  hook: text('hook'),
  metadata: text('metadata'),
  projectPositioningJson: text('project_positioning_json'),
  introTemplateId: text('intro_template_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const introTemplates = sqliteTable('intro_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  videoTitle: text('video_title'),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  sourceVideoUrl: text('source_video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  audioConfigId: integer('audio_config_id'),
  aspectRatio: text('aspect_ratio'),
  renderMode: text('render_mode').default('image_story'),
  autoMode: integer('auto_mode', { mode: 'boolean' }).default(false),
  enableAiRewrite: integer('enable_ai_rewrite', { mode: 'boolean' }).default(true),
  workflowType: text('workflow_type').default('story_rewrite'),
  narrationVoiceId: text('narration_voice_id'),
  narrationSpeed: real('narration_speed').default(1.0),
  subtitleEnabled: integer('subtitle_enabled', { mode: 'boolean' }).default(true),
  subtitleFont: text('subtitle_font').default('PingFang SC'),
  subtitleColor: text('subtitle_color').default('#FFFFFF'),
  subtitleSize: integer('subtitle_size').default(48),
  subtitlePosition: text('subtitle_position').default('bottom'),
  subtitleMargin: integer('subtitle_margin').default(60),
  subtitleMarginV: integer('subtitle_margin_v').default(40),
  subtitleBackgroundColor: text('subtitle_background_color'),
  subtitleStrokeColor: text('subtitle_stroke_color'),
  subtitleStrokeWidth: integer('subtitle_stroke_width').default(2),
  pacingMode: text('pacing_mode').default('tight'),
  dialogueMode: text('dialogue_mode').default('narration_only'),
  narrationMode: text('narration_mode').default('rewrite'),
  openingHook: text('opening_hook'),
  cliffhanger: text('cliffhanger'),
  creativeBriefJson: text('creative_brief_json'),
  directorPlanJson: text('director_plan_json'),
  metadata: text('metadata'),
  recapScript: text('recap_script'),
  recapVideoUrl: text('recap_video_url'),
  introVideoUrl: text('intro_video_url'),
  // 开场视频的独立 storyboard 设计（designOpeningStoryboard 产出）：蒙太奇/建立镜头规划，
  // 与逐镜 designVideoShot 分开，作为开场 ~8s 视频的生产依据。
  openingStoryboardJson: text('opening_storyboard_json'),
  seriesHook: text('series_hook'),
  retentionBeats: text('retention_beats'),
  energyCurve: text('energy_curve'),
  bgmAudioUrl: text('bgm_audio_url'),
  dharmaInputRevision: integer('dharma_input_revision').notNull().default(0),
  secondaryBgmAudioUrl: text('secondary_bgm_audio_url'),
  bgmPlanJson: text('bgm_plan_json'),
  preTtsAudioUrl: text('pre_tts_audio_url'),
  preTtsTitlesJson: text('pre_tts_titles_json'),
  coverPrompt: text('cover_prompt'),
  coverImage4x3Url: text('cover_image_4x3_url'),
  coverImage3x4Url: text('cover_image_3x4_url'),
  coverImage4x3GenId: integer('cover_image_4x3_gen_id'),
  coverImage3x4GenId: integer('cover_image_3x4_gen_id'),
  coverDesignJson: text('cover_design_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  appearance: text('appearance'),
  personality: text('personality'),
  voiceStyle: text('voice_style'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  seed: integer('seed'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  voiceSampleUrl: text('voice_sample_url'),
  voiceProvider: text('voice_provider'),
  voicePitch: integer('voice_pitch'),
  voiceSpeed: real('voice_speed'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  seed: integer('seed'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  action: text('action'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  imagePrompt: text('image_prompt'),
  imagePromptFinal: integer('image_prompt_final', { mode: 'boolean' }).default(false),
  videoPrompt: text('video_prompt'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  bgmAudioUrl: text('bgm_audio_url'),
  sfxAudioUrl: text('sfx_audio_url'),
  ambientAudioUrl: text('ambient_audio_url'),
  dialogue: text('dialogue'),
  narration: text('narration'),
  description: text('description'),
  duration: integer('duration').default(8),
  energyLevel: text('energy_level').default('medium'),
  composedImage: text('composed_image'),
  firstFrameImage: text('first_frame_image'),
  lastFrameImage: text('last_frame_image'),
  referenceImages: text('reference_images'),
  gridSheetImage: text('grid_sheet_image'),
  gridCells: text('grid_cells'),
  videoUrl: text('video_url'),
  ttsAudioUrl: text('tts_audio_url'),
  narrationAudioUrl: text('narration_audio_url'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const gridDrafts = sqliteTable('grid_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  mode: text('mode').notNull(),
  rows: integer('rows'),
  cols: integer('cols'),
  prompt: text('prompt'),
  cellPrompts: text('cell_prompts'),
  referenceImages: text('reference_images'),
  activeImagePath: text('active_image_path'),
  imageGenerationId: integer('image_generation_id'),
  status: text('status').default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.storyboardId, table.characterId] }),
}))

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: encryptedText('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const aiVoices = sqliteTable('ai_voices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceId: text('voice_id').notNull().unique(),   // MiniMax voice_id
  voiceName: text('voice_name').notNull(),         // 中文名
  description: text('description'),                // 描述数组 JSON
  language: text('language'),                     // 语言标签
  provider: text('provider').notNull(),           // minimax
  voiceType: text('voice_type').notNull().default('system'), // system / voice_generation / voice_cloning
  createdAt: text('created_at').notNull(),
})

export const agentConfigs = sqliteTable('agent_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentType: text('agent_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  model: text('model'),
  systemPrompt: text('system_prompt'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  maxIterations: integer('max_iterations'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const imageGenerations = sqliteTable('image_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id'),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  imageType: text('image_type'),
  frameType: text('frame_type'),
  provider: text('provider'),
  prompt: text('prompt'),
  negativePrompt: text('negative_prompt'),
  model: text('model'),
  size: text('size'),
  quality: text('quality'),
  style: text('style'),
  steps: integer('steps'),
  cfgScale: real('cfg_scale'),
  seed: integer('seed'),
  imageUrl: text('image_url'),
  minioUrl: text('minio_url'),
  localPath: text('local_path'),
  status: text('status').default('pending'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  attempts: integer('attempts').default(0),
  lastErrorCode: text('last_error_code'),
  lastErrorDetail: text('last_error_detail'),
  width: integer('width'),
  height: integer('height'),
  referenceImages: text('reference_images'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const videoGenerations = sqliteTable('video_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id'),
  dramaId: integer('drama_id'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  imageGenId: integer('image_gen_id'),
  referenceMode: text('reference_mode'),
  imageUrl: text('image_url'),
  firstFrameUrl: text('first_frame_url'),
  lastFrameUrl: text('last_frame_url'),
  referenceImageUrls: text('reference_image_urls'),
  duration: integer('duration'),
  fps: integer('fps'),
  resolution: text('resolution'),
  aspectRatio: text('aspect_ratio'),
  style: text('style'),
  motionLevel: integer('motion_level'),
  cameraMotion: text('camera_motion'),
  seed: integer('seed'),
  videoUrl: text('video_url'),
  minioUrl: text('minio_url'),
  localPath: text('local_path'),
  status: text('status').default('pending'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

// 可复用视频素材库：Grok/egaki 生成的视频片段，按年代/场景/事件打标签供跨集复用
export const videoAssets = sqliteTable('video_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  prompt: text('prompt'),
  model: text('model'),
  provider: text('provider'),
  mode: text('mode'), // t2v | i2v
  sourceImage: text('source_image'), // i2v 首帧图
  era: text('era'), // 年代标签，如 清末1850s
  sceneTag: text('scene_tag'), // 场景标签，如 战场/朝堂/市井
  eventTag: text('event_tag'), // 事件标签，如 金田起义/攻城
  mood: text('mood'),
  durationSec: real('duration_sec'),
  resolution: text('resolution'),
  aspectRatio: text('aspect_ratio'),
  localPath: text('local_path'),
  status: text('status').default('pending'), // pending | completed | failed
  errorMsg: text('error_msg'),
  useCount: integer('use_count').default(0),
  lastUsedAt: text('last_used_at'),
  designJson: text('design_json'), // 镜头设计稿（构思/色彩/光线/情绪/运镜）
  refsJson: text('refs_json'), // Shot.Cafe 专业构图参考
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const workerHeartbeats = sqliteTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  pid: integer('pid'),
  startedAt: text('started_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export const creationTasks = sqliteTable('creation_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  status: text('status').notNull().default('queued'),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  scopeType: text('scope_type'),
  scopeId: integer('scope_id'),
  idempotencyKey: text('idempotency_key'),
  parentTaskId: integer('parent_task_id'),
  payloadJson: text('payload_json'),
  resultJson: text('result_json'),
  progressCurrent: integer('progress_current').default(0),
  progressTotal: integer('progress_total').default(0),
  progressMessage: text('progress_message'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  attempts: integer('attempts').default(0),
  maxAttempts: integer('max_attempts').default(1),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).default(false),
  commitClaimedAt: text('commit_claimed_at'),
  priority: integer('priority').default(0),
  scheduledAt: text('scheduled_at'),
  provider: text('provider'),
  retryReason: text('retry_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
})

export const creationTaskEvents = sqliteTable('creation_task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  eventType: text('event_type').notNull(),
  dataJson: text('data_json'),
  createdAt: text('created_at').notNull(),
})

export const creationTaskDependencies = sqliteTable('creation_task_dependencies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  dependsOnTaskId: integer('depends_on_task_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const episodePublishRecords = sqliteTable('episode_publish_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  platform: text('platform').notNull(),
  status: text('status').notNull().default('pending'),
  taskId: integer('task_id'),
  draftUrl: text('draft_url'),
  errorMessage: text('error_message'),
  sessionKey: text('session_key'),
  checkpointJson: text('checkpoint_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  uniqEpisodePlatform: unique().on(table.episodeId, table.platform),
}))

// Remotion has its own production domain. These tables intentionally do not
// reuse storyboard media columns: a Remotion project can be regenerated from
// the same source episode without changing the legacy episode pipeline.
export const remotionProjects = sqliteTable('remotion_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  sourceType: text('source_type').notNull(),
  sourceEpisodeId: integer('source_episode_id'),
  sourceDramaId: integer('source_drama_id'),
  mediaAccountId: integer('media_account_id'),
  title: text('title').notNull(),
  sourceSnapshotJson: text('source_snapshot_json').notNull(),
  positioningSnapshotJson: text('positioning_snapshot_json'),
  sourceHash: text('source_hash').notNull(),
  status: text('status').notNull().default('draft'),
  currentStage: text('current_stage').notNull().default('source_snapshot'),
  schemaVersion: integer('schema_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  progressCurrent: integer('progress_current').default(0),
  progressTotal: integer('progress_total').default(0),
  progressMessage: text('progress_message'),
  finalVideoUrl: text('final_video_url'),
  metadataJson: text('metadata_json'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const remotionStageRuns = sqliteTable('remotion_stage_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  stage: text('stage').notNull(),
  stageVersion: integer('stage_version').notNull().default(1),
  status: text('status').notNull().default('pending'),
  inputHash: text('input_hash'),
  inputJson: text('input_json'),
  outputJson: text('output_json'),
  taskId: integer('task_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
}, (table) => ({
  uniqProjectStageVersion: unique().on(table.projectId, table.stage, table.stageVersion),
}))

export const remotionShots = sqliteTable('remotion_shots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  sourceStoryboardId: integer('source_storyboard_id'),
  shotNumber: integer('shot_number').notNull(),
  title: text('title'),
  narration: text('narration'),
  dialogue: text('dialogue'),
  durationMs: integer('duration_ms').notNull(),
  shotType: text('shot_type').notNull(),
  visualPlanJson: text('visual_plan_json').notNull(),
  sourceEvidenceJson: text('source_evidence_json'),
  status: text('status').notNull().default('planned'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => ({
  uniqProjectShotNumber: unique().on(table.projectId, table.shotNumber),
}))

export const remotionAssets = sqliteTable('remotion_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  shotId: integer('shot_id'),
  assetKey: text('asset_key').notNull(),
  assetType: text('asset_type').notNull(),
  provider: text('provider'),
  status: text('status').notNull().default('planned'),
  promptJson: text('prompt_json'),
  sourceUrl: text('source_url'),
  localPath: text('local_path'),
  thumbnailPath: text('thumbnail_path'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  imageGenerationId: integer('image_generation_id'),
  taskId: integer('task_id'),
  licenseJson: text('license_json'),
  contentHash: text('content_hash'),
  version: integer('version').notNull().default(1),
  metadataJson: text('metadata_json'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
}, (table) => ({
  uniqProjectAssetKey: unique().on(table.projectId, table.assetKey, table.version),
}))

export const remotionRenders = sqliteTable('remotion_renders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  shotId: integer('shot_id'),
  renderKind: text('render_kind').notNull(),
  status: text('status').notNull().default('queued'),
  inputHash: text('input_hash'),
  propsJson: text('props_json'),
  outputPath: text('output_path'),
  outputUrl: text('output_url'),
  width: integer('width'),
  height: integer('height'),
  fps: integer('fps'),
  durationMs: integer('duration_ms'),
  qaJson: text('qa_json'),
  taskId: integer('task_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
}, (table) => ({
  idxProjectRender: unique().on(table.projectId, table.renderKind, table.shotId),
}))

/* ===== v8 叙事层级（Sequence → Event → Beat → Panel/Shot） ===== */

export const narrativePlans = sqliteTable('narrative_plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  remotionProjectId: integer('remotion_project_id'),
  kind: text('kind').notNull().default('full'),
  styleProfile: text('style_profile'),
  durationMs: integer('duration_ms'),
  timingSource: text('timing_source'),
  sourcePath: text('source_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  uniqEpisodeKind: unique().on(table.episodeId, table.kind),
}))

export const narrativeSequences = sqliteTable('narrative_sequences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull(),
  seqKey: text('seq_key').notNull(),
  seqIndex: integer('seq_index').notNull(),
  title: text('title'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  // 叙事画格连续性设计（designSequenceBeats 产出）：JSON，含本 Sequence 统一屏幕轴线
  // 与逐 Panel 的相机角度/景别/屏幕方向/连续性锚点/单 Beat 目标。供生图阶段消费。
  designJson: text('design_json'),
}, (table) => ({
  uniqPlanSeq: unique().on(table.planId, table.seqKey),
}))

export const narrationEvents = sqliteTable('narration_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sequenceId: integer('sequence_id').notNull(),
  eventKey: text('event_key').notNull(),
  eventIndex: integer('event_index').notNull(),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  text: text('text'),
}, (table) => ({
  uniqSeqEvent: unique().on(table.sequenceId, table.eventKey),
}))

export const visualBeats = sqliteTable('visual_beats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: integer('event_id').notNull(),
  beatKey: text('beat_key').notNull(),
  kind: text('kind'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  anchorId: text('anchor_id'),
  anchorVerified: integer('anchor_verified', { mode: 'boolean' }),
  description: text('description'),
}, (table) => ({
  uniqEventBeat: unique().on(table.eventId, table.beatKey),
}))

export const storyboardSheets = sqliteTable('storyboard_sheets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull(),
  sequenceId: integer('sequence_id'),
  sheetKey: text('sheet_key').notNull(),
  title: text('title'),
  imageUrl: text('image_url'),
}, (table) => ({
  uniqPlanSheet: unique().on(table.planId, table.sheetKey),
}))

export const storyboardPanels = sqliteTable('storyboard_panels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  beatId: integer('beat_id'),
  eventId: integer('event_id'),
  sheetId: integer('sheet_id'),
  planId: integer('plan_id').notNull(),
  panelKey: text('panel_key').notNull(),
  description: text('description'),
  cropPath: text('crop_path'),
  finalPath: text('final_path'),
  genStatus: text('gen_status').notNull().default('pending'),
  generationId: integer('generation_id'),
  taskId: integer('task_id'),
  prompt: text('prompt'),
  referenceMode: text('reference_mode'),
  error: text('error'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  uniqPlanPanel: unique().on(table.planId, table.panelKey),
}))

export const renderShots = sqliteTable('render_shots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: integer('event_id'),
  planId: integer('plan_id').notNull(),
  shotKey: text('shot_key').notNull(),
  sourceKind: text('source_kind'),
  sourceBeatKey: text('source_beat_key'),
  description: text('description'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
}, (table) => ({
  uniqPlanShotBeat: unique().on(table.planId, table.shotKey, table.sourceBeatKey),
}))

export const soundBeats = sqliteTable('sound_beats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull(),
  sequenceId: integer('sequence_id'),
  eventId: integer('event_id'),
  soundKey: text('sound_key').notNull(),
  type: text('type'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  sourceQuery: text('source_query'),
  volume: real('volume'),
  tagsJson: text('tags_json'),
}, (table) => ({
  uniqPlanSound: unique().on(table.planId, table.soundKey),
}))
