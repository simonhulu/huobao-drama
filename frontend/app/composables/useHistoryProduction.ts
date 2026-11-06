import { api } from '~/composables/useApi'

export interface HistoryProductionItem {
  episodeId: number; dramaId: number; episodeNumber: number; title: string; dramaTitle: string
  accountName?: string; status: string; stage: string; message?: string; updatedAt?: string
  jobId?: string; sourceId?: number; videoUrl?: string; shotCount?: number; readyShotCount?: number
}
export interface HistoryProductionDetail {
  deletionSupported?: boolean
  episode: { id: number; title: string; script: string; profile: string; dramaId: number; episodeNumber: number; videoUrl?: string; audioUrl?: string }
  job: { id: string; profile?: string; status: string; stage: string; message?: string; error?: string; updatedAt?: string; plan?: Record<string, any>; scriptRevision?: string; candidates?: Record<string, Array<{assetId: string; description: string; shotText?: string}>> } | null
  shots: Array<{ shotId: string; narration: string; duration: number; purpose?: string; visualType?: string; status?: string; sourceNote?: string; candidatesCount?: number; selection?: { assetId: string; inPoint: number; outPoint: number; crop: string; reason?: string } }>
  outputs: Array<{ id: string; url: string; createdAt?: string; kind: string; filename?: string }>
  sourceId?: number
  links: { episode: string; source?: string }
}
export const historyProductionAPI = {
  list: () => api.get<{ items: HistoryProductionItem[]; deletionSupported?: boolean }>('/remotion/history-productions'),
  detail: (id: number) => api.get<HistoryProductionDetail>(`/remotion/episodes/${id}/history-production`),
  start: (id: number, profile: string) => api.post<HistoryProductionDetail>(`/remotion/episodes/${id}/history-production/start`, { profile }),
  retry: (id: number, profile: string) => api.post<HistoryProductionDetail>(`/remotion/episodes/${id}/history-production/retry`, { profile }),
  rebuild: (id: number) => api.post<HistoryProductionDetail>(`/remotion/episodes/${id}/history-production/rebuild`, {}),
  remove: (id: number) => api.del<{ episodeId: number; deleted: true }>(`/remotion/episodes/${id}/history-production`),
}
const statusNames: Record<string, string> = { queued: '等待开始', planning: '准备文稿与分镜', selecting: '准备镜头素材', needs_review: '待继续制作', rendering: '合成中', validating: '检查与交付中', completed: '制作完成', failed: '制作未完成', draft: '尚未开始', pending: '尚未开始', ready: '待制作', done: '已有成片', working: '制作中' }
export const productionStatus = (status?: string) => statusNames[status || ''] || '尚未开始'
export const productionRunning = (status?: string) => ['queued', 'planning', 'selecting', 'rendering', 'validating'].includes(status || '')
export function productionTone(status?: string) {
  return status === 'failed' ? 'error' : ['completed', 'done'].includes(status || '') ? 'success' : productionRunning(status) ? 'active' : 'neutral'
}
export function productionDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
export function productionDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return '—'
  const value = Math.max(0, Math.round(seconds!))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
