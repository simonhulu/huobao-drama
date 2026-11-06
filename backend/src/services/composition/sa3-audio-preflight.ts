/**
 * SA3 音频预生成层
 *
 * 策略：优先使用 SA3 本地模型生成的 BGM / ambience；
 * 本地库缺位时，调用 Stable Audio 3 MLX 生成并缓存，再让 grid-audio-mix 使用。
 *
 * 这个模块在 grid-episode 渲染流程的 mixBgmIfAvailable 之前执行，
 * 确保 buildGridAudioPlan 调用时所需素材已落地。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AMBIENCE_RULES,
  type AmbienceSceneRule,
} from './grid-audio-mix.js'
import {
  generateSa3Sfx,
  generateSa3Music,
} from '../adapters/stable-audio-adapter.js'
import { recordGeneratedMusic, loadMusicLibrary, type MusicLibraryEntry } from '../music-library.js'
import { loadMapping, saveMapping, type SfxMapping } from '../sfx-library.js'
import { inferEpisodeAudioProfiles, type EmotionBucket } from '../audio-profile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../../..')

function isSa3Path(p: string): boolean {
  return p.includes('/sa3-generated/') || path.basename(p).startsWith('sa3_')
}

function firstExistingCandidate(rule: AmbienceSceneRule): string | null {
  for (const rel of rule.candidates) {
    const abs = path.resolve(PROJECT_ROOT, rel)
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return rel
  }
  return null
}

const AMBIENCE_PROMPTS: Record<string, string> = {
  battle: 'ancient battlefield ambience, clashing swords, war cries, distant drums, chaotic combat, no music',
  carriage: 'wooden carriage wheels creaking and rolling on cobblestone, horse drawn cart, steady rhythmic rattle, no music',
  march: 'many horses galloping, thundering hoofbeats, cavalry charge, herd of horses running on dirt battlefield, powerful rumble, no music',
  camp: 'campfire crackling at night, tent fabric rustling, distant crickets, cozy outdoor camp ambience, no music',
  steppe: 'cold wind blowing across vast grassland, desolate steppe ambience, howling gusts, no music',
  water: 'gentle river water flowing, stream babbling, soft water lapping, no music',
  rural: 'peaceful rural village, birds chirping, gentle breeze through trees, farm ambience, no music',
  crowd: 'busy crowd murmur, people talking and debating in a large hall, court assembly ambience, no music',
}

/**
 * 为每个 AMBIENCE_RULES 场景确保至少有一条 SA3 生成的 ambience bed。
 * 已有 SA3 候选（路径含 /sa3-generated/ 或以 sa3_ 开头）则跳过。
 */
export async function ensureSa3AmbienceLoops(): Promise<string[]> {
  const generated: string[] = []
  for (const rule of AMBIENCE_RULES) {
    const first = firstExistingCandidate(rule)
    if (first && isSa3Path(first)) continue

    const prompt = AMBIENCE_PROMPTS[rule.scene]
    if (!prompt) continue

    const rel = await generateSa3Sfx(prompt, 30, rule.scene)
    generated.push(rel)

    // 把生成的素材注册进 sfx-mapping
    const mapping: SfxMapping = loadMapping() ?? { version: 1, generatedAt: new Date().toISOString(), entries: [] }
    const entry = {
      pack: 'sa3-generated',
      relativePath: rel,
      keywords: [...rule.keywords],
      source: 'Stability AI Stable Audio 3',
      sourceUrl: 'https://huggingface.co/stabilityai/stable-audio-3-small-sfx',
      license: 'Stability AI Community License',
      roles: ['ambience', rule.scene],
    }
    const existingIdx = mapping.entries.findIndex((e) => e.relativePath === rel)
    if (existingIdx < 0) {
      mapping.entries.unshift(entry)
    } else {
      mapping.entries[existingIdx] = entry
    }
    mapping.generatedAt = new Date().toISOString()
    saveMapping(mapping)

    // 把 SA3 路径插入规则 candidates 首位，让同进程内的 buildGridAudioPlan 立即使用
    rule.candidates.unshift(rel)
  }
  return generated
}

function bestSa3BgmForBucket(bucket: EmotionBucket): MusicLibraryEntry | null {
  const lib = loadMusicLibrary()
  const entries = lib.entries
    .filter((e) => e.emotionBucket === bucket && e.source === 'sa3')
    .sort((a, b) => b.duration - a.duration)
  return entries[0] || null
}

const BGM_PROMPTS: Record<EmotionBucket, string> = {
  tense: 'ancient Chinese court intrigue, tense guzheng and erhu, low strings, subtle percussion, building suspense, cinematic, no vocals',
  neutral: 'vast grassland journey, ambient strings, lonely flute, subtle horse hoof rhythm, atmospheric ancient Chinese, no vocals',
  epic: 'epic ancient Chinese battlefield, thunderous war drums, brass fanfare, intense strings, heroic cinematic charge, no vocals',
  romantic: 'tender ancient Chinese romance, soft guzheng and bamboo flute, warm strings, delicate emotional melody, no vocals',
  sad: 'melancholic ancient Chinese scene, solo erhu, sparse strings, grey mood, no vocals',
  happy: 'bright ancient Chinese celebration, joyful pipa and flute, light percussion, uplifting, no vocals',
  calm: 'calm ancient Chinese meditation, gentle guzheng, soft pads, peaceful atmosphere, no vocals',
  action: 'fast paced ancient Chinese action, intense percussion, driving strings, urgent chase, no vocals',
  mysterious: 'mysterious ancient Chinese night, dark ambient drones, subtle guzheng, secretive mood, no vocals',
}

/**
 * 为指定 episode 的音频画像所需情绪桶，确保每个桶都有 SA3 生成 BGM。
 */
export async function ensureSa3BgmForEpisode(episodeId: number): Promise<string[]> {
  const profiles = inferEpisodeAudioProfiles(episodeId)
  const buckets = new Set<EmotionBucket>()
  for (const p of profiles.values()) {
    buckets.add(p.emotionBucket)
  }

  const generated: string[] = []
  for (const bucket of buckets) {
    if (bestSa3BgmForBucket(bucket)) continue
    const prompt = BGM_PROMPTS[bucket]
    if (!prompt) continue
    const rel = await generateSa3Music(prompt, 120, bucket)
    generated.push(rel)
    recordGeneratedMusic(rel, {
      prompt,
      emotionBucket: bucket,
      intensity: bucket === 'epic' || bucket === 'action' ? 'high' : 'medium',
      source: 'sa3',
      tags: [bucket, 'chinese', 'orchestral', 'cinematic'],
    })
  }
  return generated
}

/**
 * 完整预生成入口：ambience loops + episode 所需 BGM。
 */
export async function ensureSa3AudioAssetsForEpisode(episodeId: number): Promise<{
  ambienceLoops: string[]
  bgmTracks: string[]
}> {
  const [ambienceLoops, bgmTracks] = await Promise.all([
    ensureSa3AmbienceLoops(),
    ensureSa3BgmForEpisode(episodeId),
  ])
  return { ambienceLoops, bgmTracks }
}

