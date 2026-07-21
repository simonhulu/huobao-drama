/**
 * 一键下载并解压 Kenney / OpenGameArt 免费 CC0 音效包，生成本地关键词映射。
 *
 * 运行：
 *   npx tsx scripts/setup-sfx-library.ts
 *
 * 环境变量：
 *   SFX_LIBRARY_PATH - 库存放目录，默认 data/sfx
 */
import { setupSfxLibrary, getSfxLibraryStats } from '../src/services/sfx-library.js'

async function main() {
  console.log('Setting up local SFX library...')
  const mapping = await setupSfxLibrary()
  const stats = getSfxLibraryStats()
  console.log(`Done. Total audio files: ${stats.totalFiles}`)
  console.log(`Mapping written to: ${process.env.SFX_LIBRARY_PATH || 'data/sfx'}/sfx-mapping.json`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
