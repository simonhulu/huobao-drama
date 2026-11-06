#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { composePublishingCovers } from './compose-covers.mjs'
import { fail, fingerprint, isMain, loadPackage, readJson, verifyVideo, withPackageLock, writeJson } from './lib.mjs'

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function previewHtml(packaging, covers) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(packaging.cover_design.main_title)}</title>
<style>*{box-sizing:border-box}body{margin:0;padding:24px;font:16px system-ui;background:#f4f5f6;color:#202424;letter-spacing:0}h1{font-size:24px}main{display:flex;flex-wrap:wrap;gap:24px;align-items:start}figure{margin:0;width:min(100%,560px)}figure:last-child{width:min(100%,360px)}img{display:block;width:100%;height:auto}figcaption{padding:8px 0}p{max-width:70ch;overflow-wrap:anywhere}</style>
<h1>${escapeHtml(packaging.title)}</h1><p>${escapeHtml(packaging.platforms.baijiahao?.description || packaging.opening_hook)}</p><main>${Object.entries(covers).map(([key, item]) => `<figure><img src="${escapeHtml(path.basename(item.path))}" alt="${escapeHtml(packaging.cover_design.main_title)}"><figcaption>${key} · ${item.width} × ${item.height}</figcaption></figure>`).join('')}</main></html>`
}

export async function verifyCovers(covers) {
  for (const cover of Object.values(covers)) {
    if (await fingerprint(cover.path) !== cover.sha256) throw new Error('Frozen cover fingerprint changed')
    const metadata = await sharp(cover.path).metadata()
    if (metadata.width !== cover.width || metadata.height !== cover.height) throw new Error('Cover dimensions do not match the frozen record')
  }
}

export async function finalizePackage(directory) {
  return withPackageLock(directory, async () => {
    const { dir, state, packaging, video } = loadPackage(directory)
    await verifyVideo(video)
    if (state.covers) {
      await verifyCovers(state.covers)
      for (const [platform, manifest] of Object.entries(state.manifests || {})) {
        const existing = readJson(manifest)
        if (existing.publish_package_id !== state.package_id || existing.package_sha256 !== state.packaging_sha256
          || existing.video_path !== video.path) throw new Error('Frozen manifest identity changed')
        if (await fingerprint(manifest) !== state.manifest_sha256?.[platform]) throw new Error('Frozen manifest fingerprint changed; preserve its upload session and inspect the intended change')
      }
      return { ok: true, reused: true, directory: dir, covers: state.covers, manifests: state.manifests, preview: path.join(dir, 'covers/preview.html') }
    }
    // Check all platform sessions before rendering any fixed-path cover files.
    for (const platform of Object.keys(packaging.platforms)) {
      const output = path.join(dir, 'manifests', `${platform}.json`)
      if (fs.existsSync(output) || fs.existsSync(`${output}.staged.json`)) {
        throw new Error(`Existing manifest/upload state found: ${output}; inspect interrupted finalization before changing any cover`)
      }
    }
    const background = state.backgrounds
    for (const name of ['landscape', 'portrait']) {
      if (!background[name]?.sha256 || await fingerprint(background[name].path) !== background[name].sha256) {
        throw new Error(`Missing or changed ${name} background; run backgrounds.mjs first`)
      }
    }
    const { covers } = await composePublishingCovers({ designPath: path.join(dir, 'publishing-package.json'),
      landscapePath: background.landscape.path, portraitPath: background.portrait.path, outputDir: path.join(dir, 'covers') })
    for (const item of Object.values(covers)) item.sha256 = await fingerprint(item.path)
    const common = { source_type: 'history_script', publish_package_id: state.package_id,
      history_source_id: state.history_source_id, script_sha256: state.script_sha256, package_sha256: state.packaging_sha256 }
    const manifests = {}
    fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true })
    for (const [platform, copy] of Object.entries(packaging.platforms)) {
      const output = path.join(dir, 'manifests', `${platform}.json`)
      if (fs.existsSync(`${output}.staged.json`)) throw new Error('Existing upload state found; do not replace its manifest or session')
      if (fs.existsSync(output)) throw new Error(`Existing manifest found: ${output}; inspect interrupted finalization before replacing it`)
      if (platform === 'baijiahao') {
        const { prepareManifest } = await import('../baijiahao/prepare.mjs')
        const { manifest_path, ...manifest } = await prepareManifest({ video: video.path, title: packaging.title,
          description: packaging.description || packaging.opening_hook, workDescription: copy.description,
          cover: covers.landscape_16x9.path, portraitCover: covers.portrait_3x4.path, output })
        writeJson(output, { ...manifest, ...common })
      } else {
        writeJson(output, { platform: 'wechat_channels', provider: 'history_package', ...common,
          session: randomUUID(), title: copy.title, description: copy.description,
          opening_hook: packaging.opening_hook, cliffhanger: packaging.cliffhanger || '',
          video_path: video.path, video_sha256: video.sha256,
          cover_3x4_path: covers.portrait_3x4.path, cover_3x4_sha256: covers.portrait_3x4.sha256,
          cover_4x3_path: covers.landscape_4x3.path, cover_4x3_sha256: covers.landscape_4x3.sha256,
          prepared_at: new Date().toISOString() })
      }
      manifests[platform] = output
    }
    fs.writeFileSync(path.join(dir, 'covers/preview.html'), previewHtml(packaging, covers))
    state.covers = covers
    state.manifests = manifests
    state.manifest_sha256 = Object.fromEntries(await Promise.all(Object.entries(manifests).map(async ([name, filename]) => [name, await fingerprint(filename)])))
    state.materials_frozen_at = new Date().toISOString()
    writeJson(path.join(dir, 'state.json'), state)
    return { ok: true, reused: false, directory: dir, covers, manifests, preview: path.join(dir, 'covers/preview.html') }
  })
}

async function main() {
  const { values } = parseArgs({ options: { package: { type: 'string' } } })
  if (!values.package) throw new Error('Missing --package <directory>')
  process.stdout.write(`${JSON.stringify(await finalizePackage(values.package), null, 2)}\n`)
}
if (isMain(import.meta.url)) main().catch(fail)
