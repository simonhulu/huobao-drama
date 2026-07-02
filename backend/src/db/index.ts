import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../../data/huobao_drama.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH, { timeout: 30000 })
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('busy_timeout = 30000')

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    video_title TEXT,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT 'realistic',
    workflow_type TEXT DEFAULT 'story_rewrite',
    pacing_mode TEXT DEFAULT 'tight',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    hook TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    video_title TEXT,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    audio_config_id INTEGER,
    aspect_ratio TEXT,
    render_mode TEXT DEFAULT 'image_story',
    auto_mode INTEGER DEFAULT 0,
    enable_ai_rewrite INTEGER DEFAULT 1,
    workflow_type TEXT DEFAULT 'story_rewrite',
    narration_voice_id TEXT,
    narration_speed REAL DEFAULT 1.0,
    subtitle_enabled INTEGER DEFAULT 1,
    subtitle_font TEXT DEFAULT 'PingFang SC',
    subtitle_color TEXT DEFAULT '#FFFFFF',
    subtitle_size INTEGER DEFAULT 48,
    subtitle_position TEXT DEFAULT 'bottom',
    pacing_mode TEXT DEFAULT 'tight',
    dialogue_mode TEXT DEFAULT 'narration_only',
    narration_mode TEXT DEFAULT 'rewrite',
    opening_hook TEXT,
    cliffhanger TEXT,
    retention_beats TEXT,
    energy_curve TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    personality TEXT,
    voice_style TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    seed INTEGER,
    sort_order INTEGER,
    local_path TEXT,
    voice_sample_url TEXT,
    voice_provider TEXT,
    voice_pitch INTEGER,
    voice_speed REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    seed INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    action TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    image_prompt_final INTEGER DEFAULT 0,
    video_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    bgm_audio_url TEXT,
    sfx_audio_url TEXT,
    dialogue TEXT,
    narration TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    energy_level TEXT DEFAULT 'medium',
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    tts_audio_url TEXT,
    narration_audio_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS grid_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    rows INTEGER,
    cols INTEGER,
    prompt TEXT,
    cell_prompts TEXT,
    reference_images TEXT,
    active_image_path TEXT,
    image_generation_id INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id
    ON episode_characters (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id
    ON episode_characters (character_id);

  CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id
    ON episode_scenes (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id
    ON episode_scenes (scene_id);

  CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_storyboard_id
    ON storyboard_characters (storyboard_id);
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id
    ON storyboard_characters (character_id);

  CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL UNIQUE,
    voice_name TEXT NOT NULL,
    description TEXT,
    language TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    model TEXT,
    system_prompt TEXT,
    temperature REAL,
    max_tokens INTEGER,
    max_iterations INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS image_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    image_type TEXT,
    frame_type TEXT,
    provider TEXT,
    prompt TEXT,
    negative_prompt TEXT,
    model TEXT,
    size TEXT,
    quality TEXT,
    style TEXT,
    steps INTEGER,
    cfg_scale REAL,
    seed INTEGER,
    image_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    reference_images TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    image_gen_id INTEGER,
    reference_mode TEXT,
    image_url TEXT,
    first_frame_url TEXT,
    last_frame_url TEXT,
    reference_image_urls TEXT,
    duration INTEGER,
    fps INTEGER,
    resolution TEXT,
    aspect_ratio TEXT,
    style TEXT,
    motion_level INTEGER,
    camera_motion TEXT,
    seed INTEGER,
    video_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    pid INTEGER,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last_seen
    ON worker_heartbeats (last_seen_at);

  CREATE TABLE IF NOT EXISTS creation_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    drama_id INTEGER,
    episode_id INTEGER,
    scope_type TEXT,
    scope_id INTEGER,
    idempotency_key TEXT,
    parent_task_id INTEGER,
    payload_json TEXT,
    result_json TEXT,
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    progress_message TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 1,
    error_code TEXT,
    error_message TEXT,
    cancel_requested INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_drama_episode
    ON creation_tasks (drama_id, episode_id);
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_status
    ON creation_tasks (status);
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_type
    ON creation_tasks (type);
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_idempotency
    ON creation_tasks (type, idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_parent
    ON creation_tasks (parent_task_id);
  CREATE INDEX IF NOT EXISTS idx_creation_tasks_lease
    ON creation_tasks (lease_owner, lease_expires_at);

  CREATE TABLE IF NOT EXISTS creation_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creation_task_events_task_id
    ON creation_task_events (task_id);

  CREATE TABLE IF NOT EXISTS creation_task_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    depends_on_task_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creation_task_dependencies_task
    ON creation_task_dependencies (task_id);
  CREATE INDEX IF NOT EXISTS idx_creation_task_dependencies_depends_on
    ON creation_task_dependencies (depends_on_task_id);
`)

function ensureColumn(table: string, column: string, definition: string) {
  const tableExists = sqlite.prepare(
    `SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(table) as { ok: number } | undefined
  if (!tableExists) return
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(col => col.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('episodes', 'image_config_id', 'INTEGER')
ensureColumn('episodes', 'video_config_id', 'INTEGER')
ensureColumn('episodes', 'audio_config_id', 'INTEGER')
ensureColumn('episodes', 'aspect_ratio', 'TEXT')
ensureColumn('episodes', 'render_mode', "TEXT DEFAULT 'image_story'")
ensureColumn('episodes', 'auto_mode', "INTEGER DEFAULT 0")
ensureColumn('episodes', 'enable_ai_rewrite', "INTEGER DEFAULT 1")
ensureColumn('episodes', 'narration_voice_id', 'TEXT')
ensureColumn('episodes', 'narration_speed', 'REAL DEFAULT 1.0')
ensureColumn('episodes', 'video_title', 'TEXT')
ensureColumn('dramas', 'video_title', 'TEXT')
ensureColumn('dramas', 'workflow_type', "TEXT DEFAULT 'story_rewrite'")
ensureColumn('episodes', 'workflow_type', "TEXT DEFAULT 'story_rewrite'")

// Migrate legacy workflow_type values to new naming
sqlite.exec(`UPDATE dramas SET workflow_type = 'story_rewrite' WHERE workflow_type = 'short_drama'`)
sqlite.exec(`UPDATE dramas SET workflow_type = 'direct_script' WHERE workflow_type = 'finished_script'`)
sqlite.exec(`UPDATE episodes SET workflow_type = 'story_rewrite' WHERE workflow_type = 'short_drama'`)
sqlite.exec(`UPDATE episodes SET workflow_type = 'direct_script' WHERE workflow_type = 'finished_script'`)
ensureColumn('episodes', 'subtitle_enabled', 'INTEGER DEFAULT 1')
ensureColumn('episodes', 'subtitle_font', "TEXT DEFAULT 'PingFang SC'")
ensureColumn('episodes', 'subtitle_color', "TEXT DEFAULT '#FFFFFF'")
ensureColumn('episodes', 'subtitle_size', 'INTEGER DEFAULT 48')
ensureColumn('episodes', 'subtitle_position', "TEXT DEFAULT 'bottom'")
ensureColumn('episodes', 'subtitle_margin', 'INTEGER DEFAULT 60')
ensureColumn('episodes', 'subtitle_margin_v', 'INTEGER DEFAULT 40')
ensureColumn('episodes', 'subtitle_background_color', 'TEXT')
ensureColumn('episodes', 'subtitle_stroke_color', 'TEXT')
ensureColumn('episodes', 'subtitle_stroke_width', 'INTEGER DEFAULT 2')
ensureColumn('episodes', 'narration_mode', "TEXT DEFAULT 'rewrite'")
ensureColumn('episodes', 'retention_beats', 'TEXT')
ensureColumn('storyboards', 'narration', 'TEXT')
ensureColumn('storyboards', 'narration_audio_url', 'TEXT')
ensureColumn('storyboards', 'image_prompt_final', 'INTEGER DEFAULT 0')
ensureColumn('storyboards', 'bgm_audio_url', 'TEXT')
ensureColumn('storyboards', 'sfx_audio_url', 'TEXT')
ensureColumn('storyboards', 'ambient_audio_url', 'TEXT')

ensureColumn('characters', 'seed', 'INTEGER')
ensureColumn('characters', 'voice_pitch', 'INTEGER')
ensureColumn('characters', 'voice_speed', 'REAL')
ensureColumn('scenes', 'seed', 'INTEGER')

ensureColumn('creation_tasks', 'priority', 'INTEGER DEFAULT 0')
ensureColumn('creation_tasks', 'scheduled_at', 'TEXT')
ensureColumn('creation_tasks', 'provider', 'TEXT')
ensureColumn('creation_tasks', 'retry_reason', 'TEXT')

ensureColumn('image_generations', 'attempts', 'INTEGER DEFAULT 0')
ensureColumn('image_generations', 'last_error_code', 'TEXT')
ensureColumn('image_generations', 'last_error_detail', 'TEXT')

export const db = drizzle(sqlite, { schema })
export { schema }
export type DB = typeof db
