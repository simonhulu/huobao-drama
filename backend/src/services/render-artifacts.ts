import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RenderArtifact {
  name: string
  url: string
  size_mb: number
  mtime: string
  kind: string
  kind_label: string
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function classifyArtifact(name: string) {
  if (name.includes('delivery')) return 'delivery'
  if (name.includes('visual')) return 'visual'
  if (name.includes('final')) return 'final'
  if (/smoke|pilot|proof|preview|check|demo|validation|gap/.test(name)) return 'test'
  return 'other'
}

const KIND_LABELS = {
  delivery: '交付版',
  visual: '视觉版',
  final: '完整版',
  test: '验证片段',
  other: '其他',
}

export function listProjectRenderArtifacts(
  projectId: number,
  options?: { episodeVideoUrl?: string | null },
): RenderArtifact[] {
  const dir = path.join(repoRoot, 'data/static/remotion')
  if (!fs.existsSync(dir)) return []
  const prefix = `project-${projectId}-`
  const artifacts = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.mp4'))
    .map(f => {
      const st = fs.statSync(path.join(dir, f))
      const kind = classifyArtifact(f)
      return {
        name: f,
        url: `/static/remotion/${f}`,
        size_mb: Math.round((st.size / 1024 / 1024) * 10) / 10,
        mtime: st.mtime.toISOString(),
        kind,
        kind_label: KIND_LABELS[kind] ?? kind,
      }
    })
  // history-comic delivery files use a hash rather than a project ID in the filename.
  const deliveryUrl = options?.episodeVideoUrl?.trim()
  if (deliveryUrl && deliveryUrl.startsWith('static/remotion/')) {
    const name = deliveryUrl.split('/').pop()
    if (name && name.endsWith('.mp4')) {
      const abs = path.join(dir, name)
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs)
        const kind = classifyArtifact(name)
        artifacts.push({
          name,
          url: `/static/remotion/${name}`,
          size_mb: Math.round((st.size / 1024 / 1024) * 10) / 10,
          mtime: st.mtime.toISOString(),
          kind,
          kind_label: KIND_LABELS[kind] ?? kind,
        })
      }
    }
  }
  return artifacts.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

/** 项目镜头级 Grok 视频。 */
export function listProjectShotVideos(projectId: number) {
  const dir = path.join(repoRoot, `data/static/remotion/project-${projectId}/narrative-storyboard/video`)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.mp4'))
    .map(f => {
      const st = fs.statSync(path.join(dir, f))
      return {
        name: f,
        url: `/static/remotion/project-${projectId}/narrative-storyboard/video/${f}`,
        size_mb: Math.round((st.size / 1024 / 1024) * 10) / 10,
        mtime: st.mtime.toISOString(),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 优先交付版，其次视觉/完整版，最后任意产物。 */
export function findProjectFinalArtifact(projectId: number): RenderArtifact | null {
  const artifacts = listProjectRenderArtifacts(projectId)
  if (!artifacts.length) return null
  return artifacts.find(a => a.kind === 'delivery') ??
    artifacts.find(a => a.kind === 'visual') ??
    artifacts.find(a => a.kind === 'final') ??
    artifacts[0]
}
