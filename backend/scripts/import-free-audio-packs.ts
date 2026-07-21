/**
 * 一键导入精选的免费影视级音频素材包。
 *
 * 运行：
 *   npx tsx scripts/import-free-audio-packs.ts
 *
 * 参数：
 *   --music          只导入音乐包
 *   --sfx            只导入音效包
 *   --manual         只打印需要手动下载的高质量资源清单
 *   --dry-run        不真正下载/解压，只展示将要做什么
 *   --packs=a,b      只导入指定名称的包（逗号分隔）
 *
 * 环境变量：
 *   STORAGE_PATH     音乐库存放目录，默认 data/static
 *   SFX_LIBRARY_PATH 音效库存放目录，默认 data/sfx
 */
import {
  FREE_MUSIC_PACKS,
  FREE_SFX_PACKS,
  MANUAL_RESOURCE_LINKS,
  formatSize,
  importMusicPack,
  importSfxPack,
  tagImportedMusic,
  rebuildSfxMapping,
  listAllRecommendedPacks,
  type FreePack,
} from '../src/services/free-audio-packs.js'

const MUSIC_PACK_BY_NAME = new Map(FREE_MUSIC_PACKS.map(p => [p.name, p]))
import { refreshMusicLibrary } from '../src/services/music-library.js'

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    musicOnly: args.includes('--music'),
    sfxOnly: args.includes('--sfx'),
    manualOnly: args.includes('--manual'),
    dryRun: args.includes('--dry-run'),
    packFilter: (() => {
      const raw = args.find(a => a.startsWith('--packs='))
      return raw ? raw.replace('--packs=', '').split(',').map(s => s.trim()).filter(Boolean) : null
    })(),
  }
}

function printManualResources() {
  console.log('\n=== 需要手动下载的高质量影视级素材（无法自动拉取）===')
  for (const pack of MANUAL_RESOURCE_LINKS) {
    console.log(`\n${pack.title}`)
    console.log(`  类型: ${pack.type === 'music' ? '音乐' : '音效'}`)
    console.log(`  授权: ${pack.license}`)
    console.log(`  大小: ${formatSize(pack.sizeBytes)}`)
    console.log(`  主页: ${pack.homepage}`)
    if (pack.description) console.log(`  说明: ${pack.description}`)
    console.log(`  操作: 手动下载后放到对应目录，再运行本脚本 --music/--sfx 刷新索引`)
  }
}

function printRecommendedPacks() {
  console.log('\n=== 可自动下载的免费素材包 ===')
  for (const pack of [...FREE_MUSIC_PACKS, ...FREE_SFX_PACKS]) {
    console.log(`- ${pack.title} (${pack.type}, ${pack.license}, ${formatSize(pack.sizeBytes)})`)
  }
  console.log(`\n可手动下载的精选素材：${MANUAL_RESOURCE_LINKS.length} 个`)
}

function matchesFilter(pack: FreePack, filter: string[] | null): boolean {
  if (!filter) return true
  return filter.includes(pack.name)
}

async function importMusicPacks(filter: string[] | null, dryRun: boolean) {
  const packs = FREE_MUSIC_PACKS.filter(p => matchesFilter(p, filter))
  if (packs.length === 0) return
  console.log(`\n=== 导入音乐包（${dryRun ? '模拟' : '真实'}）===`)
  for (const pack of packs) {
    console.log(`\n-> ${pack.title} (${formatSize(pack.sizeBytes)})`)
    if (dryRun) continue
    await importMusicPack(pack)
    await refreshMusicLibrary()
    tagImportedMusic(
      pack.name,
      {
        emotionBucket: pack.emotionBuckets?.[0] ?? 'neutral',
        intensity: pack.intensity ?? 'medium',
        prompt: pack.description,
      },
      MUSIC_PACK_BY_NAME.get(pack.name),
    )
  }
  if (!dryRun && packs.length > 0) {
    console.log('[FreeAudio] Music library index refreshed.')
  }
}

async function importSfxPacks(filter: string[] | null, dryRun: boolean) {
  const packs = FREE_SFX_PACKS.filter(p => matchesFilter(p, filter))
  if (packs.length === 0) return
  console.log(`\n=== 导入音效包（${dryRun ? '模拟' : '真实'}）===`)
  for (const pack of packs) {
    console.log(`-> ${pack.title} (${formatSize(pack.sizeBytes)})`)
    if (dryRun) continue
    await importSfxPack(pack)
  }
  if (!dryRun) {
    rebuildSfxMapping()
  }
}

async function main() {
  const { musicOnly, sfxOnly, manualOnly, dryRun, packFilter } = parseArgs()

  if (manualOnly) {
    printManualResources()
    return
  }

  if (packFilter && packFilter.length > 0) {
    const known = new Set(listAllRecommendedPacks().map(p => p.name))
    const unknown = packFilter.filter(n => !known.has(n))
    if (unknown.length > 0) {
      console.error(`[FreeAudio] Unknown pack names: ${unknown.join(', ')}`)
      process.exit(1)
    }
  }

  printRecommendedPacks()

  if (!sfxOnly) await importMusicPacks(packFilter, dryRun)
  if (!musicOnly) await importSfxPacks(packFilter, dryRun)

  if (dryRun) {
    console.log('\n[FreeAudio] Dry run complete. No files were downloaded.')
  } else {
    console.log('\n[FreeAudio] Import complete. Open /library in the frontend to browse new assets.')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
