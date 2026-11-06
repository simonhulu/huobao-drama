#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { tsImport } from 'tsx/esm/api'

const usage = 'node backend/scripts/history-video-publish/compose-covers.mjs --design <json> --landscape <image> --portrait <image> --out-dir <directory>'

export async function composePublishingCovers({ designPath, landscapePath, portraitPath, outputDir }) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(designPath), 'utf8'))
  const design = parsed?.cover_design ?? parsed
  if (!design || typeof design !== 'object' || Array.isArray(design)
    || typeof design.main_title !== 'string' || !design.main_title.trim()) {
    throw new Error('Cover design must contain a nonempty main_title')
  }
  const { composeCoverVariants } = await tsImport('../../src/services/cover-image-composer.ts', import.meta.url)
  const variants = await composeCoverVariants({
    design,
    outputDir: path.resolve(outputDir),
    variants: [
      { key: 'landscape_16x9', baseImagePath: landscapePath, width: 1280, height: 720 },
      { key: 'landscape_4x3', baseImagePath: landscapePath, width: 1200, height: 900 },
      { key: 'portrait_3x4', baseImagePath: portraitPath, width: 900, height: 1200 },
    ],
  })
  return {
    ok: true,
    covers: Object.fromEntries(variants.map(({ key, ...cover }) => [key, cover])),
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      design: { type: 'string' },
      landscape: { type: 'string' },
      portrait: { type: 'string' },
      'out-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(`${usage}\n`)
    return
  }
  for (const flag of ['design', 'landscape', 'portrait', 'out-dir']) {
    if (!values[flag]) throw new Error(`Missing --${flag}. ${usage}`)
  }
  const result = await composePublishingCovers({
    designPath: values.design,
    landscapePath: values.landscape,
    portraitPath: values.portrait,
    outputDir: values['out-dir'],
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
