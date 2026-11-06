<template>
  <div class="publication-status" aria-live="polite">
    <div class="publication-heading">
      <span :class="{ warning: needsAttention }">{{ label }}</span>
      <button class="text-button" type="button" :disabled="loading" aria-label="刷新百家号发表状态" title="刷新百家号发表状态" @click="refresh"><RefreshCw :size="13" :class="{ spin: loading }" /></button>
    </div>
    <p v-if="message">{{ message }}</p>
    <p v-if="articleId">作品 ID：{{ articleId }}</p>
    <p v-if="error" role="status">{{ error }}</p>
    <NuxtLink :to="publicationLink">{{ linkLabel }}<ArrowRight :size="12" /></NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowRight, RefreshCw } from 'lucide-vue-next'
import { api } from '~/composables/useApi'
import type { HistoryProductionState, HistoryProductionVersion } from '../../../../backend/src/services/history-production-state'

const props = defineProps<{ sourceId: number; videoId?: number; historicalOutput?: boolean }>()
type UploadJob = { id: string; videoId?: number; target: string; mode?: string; status: string; message?: string; error?: string; result?: { articleId?: string } }
type Queue = { paused?: boolean; reason?: string; runningJobId?: string }
type PublicationSnapshot = { production: HistoryProductionState; jobs: UploadJob[]; queue?: Queue }
const snapshot = ref<PublicationSnapshot | null>(null), loading = ref(false), error = ref('')
const version = computed<HistoryProductionVersion | undefined>(() => props.historicalOutput ? undefined : snapshot.value?.production.versions.find(item =>
  item.producer === 'motion' && (props.videoId === undefined || item.videoId === props.videoId)))
const historical = computed(() => props.historicalOutput || !!snapshot.value && props.videoId !== undefined && !version.value)
const job = computed(() => version.value?.jobId ? snapshot.value?.jobs.find(item => String(item.id) === version.value!.jobId
  && item.target === 'baijiahao-video' && item.mode === 'publish'
  && (item.videoId == null || item.videoId === version.value!.videoId)) : undefined)
const articleId = computed(() => ['submitted', 'published'].includes(version.value?.state || '') ? job.value?.result?.articleId : undefined)
const needsAttention = computed(() => ['attention', 'uncertain', 'stale'].includes(version.value?.state || ''))
const publicationLink = computed(() => {
  const videoId = props.historicalOutput ? undefined : props.videoId ?? version.value?.videoId
  return `/history-scripts?view=uploads&script=${props.sourceId}${videoId ? `&videoId=${videoId}` : ''}`
})
const linkLabel = computed(() => {
  if (!needsAttention.value) return '查看发表队列'
  if (version.value?.stage === 'packaging') return '查看并继续发布准备'
  return version.value?.previousJobId && version.value.action === 'none' ? '查看原发表任务' : '查看并继续原发表任务'
})
const label = computed(() => {
  if (historical.value) return '历史成片'
  if (!snapshot.value) return error.value ? '发表状态暂不可用' : '正在读取发表状态'
  const edition = version.value
  if (!edition) return '尚未登记本版成片'
  if (edition.state === 'ready') return edition.revisionOfVideoId ? '修订成片待提交' : edition.automatic ? '等待自动发表' : '材料齐备，可发表'
  if (edition.state === 'attention') return ({ production: '制作需处理', export: '导出需处理', packaging: '发布材料需处理', publication: edition.previousJobId ? '原发表任务需处理' : '发表需处理' })[edition.stage]
  if (edition.state === 'queued') return edition.automatic ? '等待自动上传' : '等待提交'
  if (edition.state === 'uploading') return edition.automatic ? '正在自动发表' : '正在发表'
  return ({ pending: '等待制作', producing: '制作中', exporting: '成片导出中', packaging: '发布材料准备中', submitted: '已提交，等待审核', published: '已发表', uncertain: '发表结果待核对', stale: '版本待核对' } as Record<string, string>)[edition.state] || '发表状态待核对'
})
const message = computed(() => {
  if (historical.value) return '当前预览不是本版最新成片，请在发表工作台核对对应记录。'
  if (version.value?.state === 'queued') {
    const queue = snapshot.value?.queue
    if (queue?.paused) return queue.reason || '发表队列暂停，请查看队列处理'
    if (queue?.runningJobId && queue.runningJobId !== version.value.jobId) return version.value.automatic ? '前序作品正在上传，轮到本片会自动继续' : '前序作品正在上传，当前成片正在排队'
  }
  return version.value?.error || version.value?.message || ''
})
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, generation = 0
async function refresh() {
  clearTimeout(timer)
  if (loading.value) return
  const current = generation
  loading.value = true
  try {
    const result = await api.get<PublicationSnapshot>(`/history-scripts/uploads/sources/${props.sourceId}/state`)
    if (disposed || current !== generation) return
    if (result.production?.scriptId !== props.sourceId || !Array.isArray(result.production.versions) || !Array.isArray(result.jobs)
      || result.production.versions.some(item => item.scriptId !== props.sourceId)) throw Error('发表状态响应不完整')
    snapshot.value = result
    error.value = ''
  } catch {
    if (!disposed && current === generation) error.value = snapshot.value ? '刷新失败，保留上次发表状态' : '读取失败，请刷新发表状态或打开队列'
  } finally {
    if (!disposed && current === generation) {
      loading.value = false
      timer = setTimeout(refresh, 12000)
    }
  }
}
watch(() => [props.sourceId, props.videoId], () => { generation++; snapshot.value = null; loading.value = false; error.value = ''; void refresh() })
onMounted(refresh)
onUnmounted(() => { disposed = true; generation++; clearTimeout(timer) })
</script>

<style scoped>
.publication-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.publication-heading>span{min-width:0;overflow-wrap:anywhere}.publication-heading .text-button{display:grid;place-items:center;min-width:26px;min-height:26px;padding:4px;flex-shrink:0}.publication-status p{margin:4px 0;font-size:12px;color:var(--text-2);overflow-wrap:anywhere}.publication-status a{display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:12px;color:var(--text-0)}.warning{color:#9a4c08}
</style>
