<template>
  <section class="batch-outcomes" aria-label="批次生产结果">
    <header class="outcome-heading">
      <h3>批次生产结果<span v-if="data">{{ data.total }} 份稿件</span></h3>
      <div class="outcome-actions">
        <select v-model="filter" aria-label="筛选批次稿件"><option value="all">全部稿件</option><option value="collected">本次采集存稿</option><option value="recovered">失败后已恢复</option><option value="pending">尚未全部发表</option></select>
        <button type="button" class="outcome-icon" title="刷新批次结果" aria-label="刷新批次结果" :disabled="loading" @click="load(offset)"><RefreshCw :size="15" :class="{ spinning: loading }" /></button>
      </div>
    </header>
    <p v-if="error" class="outcome-error" role="alert">{{ error }}</p>
    <p v-if="!data" class="outcome-empty">{{ loading ? '正在读取批次结果…' : '暂无批次结果' }}</p>
    <template v-else>
      <div class="outcome-totals" role="status">
        <span v-if="data.total > data.items.length">本页 {{ data.items.length }} 份</span>
        <span>已成稿 <strong>{{ data.summary.draftsReady }}</strong></span>
        <span>已成片 <strong>{{ data.summary.producedVideos }}/{{ data.summary.expectedVideos }}</strong></span>
        <span>已发表 <strong>{{ data.summary.publishedVideos }}/{{ data.summary.expectedVideos }}</strong></span>
        <span>失败后恢复 <strong>{{ data.summary.recoveredSources }}</strong></span>
        <span>本地已回收 <strong>{{ data.summary.releasedVideos }}</strong></span>
      </div>
      <p v-if="data.recovery?.state === 'scheduled'" class="outcome-wait">服务限流 · {{ formatTime(data.recovery.nextAttemptAt) }} 自动继续 · {{ data.recovery.attempts }}/{{ data.recovery.maxAttempts }} 次</p>
      <p v-else-if="data.recovery?.state === 'exhausted'" class="outcome-error">自动恢复次数已用完，保留原任务等待处理</p>
      <div v-for="item in visibleItems" :key="item.sourceId" class="outcome-source" :data-source-id="item.sourceId">
        <div class="outcome-source-heading">
          <button type="button" class="source-command" :disabled="item.deleted" @click="emit('open-script', item.sourceId)">#{{ item.sourceId }} · {{ item.title }}</button>
          <span v-if="item.deleted" class="outcome-muted">已删除</span>
          <span v-else-if="item.collectedInBatch" class="outcome-muted">本次采集存稿</span>
          <span v-else-if="item.recovered" class="outcome-success">失败后已恢复</span>
          <span v-else class="outcome-muted">关联稿件</span>
        </div>
        <div v-if="!item.deleted" class="outcome-draft"><span :class="item.draftState === 'current' ? 'outcome-success' : 'outcome-warning'">{{ draftLabel(item.draftState) }}</span><span class="outcome-muted">{{ reviewLabel(item.reviewStatus) }}</span><span v-if="item.sourceMediaReleased" class="outcome-muted">来源媒体已回收</span></div>
        <div v-for="version in item.versions" :key="version.key" class="outcome-version">
          <strong>{{ producerLabel(version.producer) }}</strong>
          <span :class="stateClass(version.state)">{{ stateLabel(version.state) }}</span>
          <span class="outcome-version-detail">{{ version.state === 'published' ? `发表任务 #${version.jobId}` : version.error || version.message }}</span>
          <span v-if="version.videoId" class="outcome-muted outcome-media">{{ mediaLabel(version.localMedia) }}</span>
          <a v-if="version.publicationUrl" class="outcome-icon" :href="version.publicationUrl" target="_blank" rel="noopener noreferrer" :title="`查看${producerLabel(version.producer)}作品`" :aria-label="`查看稿件 ${item.sourceId} ${producerLabel(version.producer)}作品`"><ExternalLink :size="15" /></a>
        </div>
        <p v-if="!item.deleted && !item.versions.length" class="outcome-muted outcome-no-production">尚无当前稿件版本的制作任务</p>
        <p v-for="activity in item.health.filter(value => value.stalled)" :key="activity.producer" class="outcome-warning outcome-stall">{{ producerLabel(activity.producer) }} · {{ activity.waitingMinutes }} 分钟无新进展 · {{ activity.message }}</p>
        <p v-if="item.lastError" class="outcome-error">{{ item.lastError }}</p>
        <details v-if="item.historicalFailure" class="outcome-history"><summary>{{ item.recovered ? '已恢复的采集错误' : '采集错误记录' }}</summary><p>{{ item.historicalFailure.message }}</p></details>
      </div>
      <p v-if="!visibleItems.length" class="outcome-empty">{{ data.total > data.limit ? '本页没有匹配的稿件' : '没有匹配的稿件' }}</p>
      <footer v-if="data.total > data.limit" class="outcome-pagination">
        <span>{{ offset + 1 }}–{{ Math.min(offset + data.items.length, data.total) }} / {{ data.total }}</span>
        <button type="button" class="outcome-icon" title="上一页稿件" aria-label="上一页稿件" :disabled="loading || offset === 0" @click="load(Math.max(0, offset - data.limit))"><ChevronLeft :size="16" /></button>
        <button type="button" class="outcome-icon" title="下一页稿件" aria-label="下一页稿件" :disabled="loading || !data.hasMore" @click="load(offset + data.limit)"><ChevronRight :size="16" /></button>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = withDefaults(defineProps<{ jobId: string | number; active?: boolean }>(), { active: true })
const emit = defineEmits<{ 'open-script': [id: number] }>()
const data = ref<any>(null)
const error = ref('')
const loading = ref(false)
const offset = ref(0)
const filter = ref('all')
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
const visibleItems = computed(() => (data.value?.items || []).filter((item: any) => filter.value === 'all'
  || filter.value === 'collected' && item.collectedInBatch || filter.value === 'recovered' && item.recovered
  || filter.value === 'pending' && !item.deleted && !item.publicationComplete))

async function load(nextOffset = offset.value) {
  if (!props.active || !props.jobId || loading.value) return
  controller?.abort()
  controller = new AbortController()
  const current = ++generation
  loading.value = true
  try {
    const result = await api.get(`/history-scripts/jobs/${encodeURIComponent(props.jobId)}/outcomes?limit=50&offset=${nextOffset}`, controller.signal)
    if (current !== generation) return
    if (!result || !Array.isArray(result.items) || !result.summary) throw new Error('批次结果格式无效，请刷新重试')
    data.value = result
    offset.value = nextOffset
    error.value = ''
  } catch (cause: any) {
    if (current === generation && cause.name !== 'AbortError') error.value = cause.message || '批次结果读取失败'
  } finally { if (current === generation) loading.value = false }
}

watch(() => [props.jobId, props.active], ([id], [previousId] = []) => {
  controller?.abort(); generation++; loading.value = false
  if (id !== previousId) { data.value = null; offset.value = 0; filter.value = 'all'; error.value = '' }
  if (props.active) void load()
}, { immediate: true })
onMounted(() => { timer = setInterval(() => { if (props.active && document.visibilityState === 'visible') void load() }, 15000) })
onBeforeUnmount(() => { generation++; controller?.abort(); clearInterval(timer) })

const producerLabel = (value: string) => ({ huasheng: '花生版', motion: '精细化版', huasheng_upload: '花生版上传', motion_upload: '精细化版上传', manual: '手动版', legacy: '历史成片' }[value] || value)
const draftLabel = (value: string) => ({ current: '稿件已完成', stale: '稿件版本待核对', missing: '待生成稿件' }[value] || value)
const reviewLabel = (value: string) => ({ needs_review: '审稿待审', approved: '审稿通过', rejected: '审稿退回' }[value] || '审稿未确认')
const mediaLabel = (value: string) => ({ available: '本地可用', released: '本地已回收', missing: '本地不可用' }[value] || value)
const stateLabel = (value: string) => ({ pending: '等待制作', producing: '制作中', exporting: '导出中', packaging: '准备封面', ready: '待发表', queued: '发表排队', uploading: '上传中', submitted: '已提交审核', published: '已发表', attention: '需要处理', uncertain: '结果待核对', stale: '版本待核对' }[value] || value)
const stateClass = (value: string) => ['published', 'submitted'].includes(value) ? 'outcome-success' : ['attention', 'uncertain', 'stale'].includes(value) ? 'outcome-warning' : 'outcome-muted'
const formatTime = (value: string | number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
</script>

<style scoped>
.batch-outcomes { border-block: 1px solid var(--border-color, #e2e4e8); padding-block: 16px; margin-block: 16px; font-size: 13px; min-width: 0; }
.outcome-heading, .outcome-actions, .outcome-totals, .outcome-source-heading, .outcome-draft, .outcome-pagination { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.outcome-heading { justify-content: space-between; }
.outcome-heading h3 { font-size: 14px; margin: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.outcome-heading h3 span { font-size: 12px; font-weight: 400; color: #646a73; }
.outcome-actions select { max-width: 190px; padding: 5px 24px 5px 8px; border: 1px solid var(--border-color, #d9dde2); border-radius: 4px; background: var(--bg-card, #fff); color: inherit; font: inherit; }
.outcome-icon { display: inline-flex; flex: 0 0 30px; width: 30px; height: 30px; justify-content: center; align-items: center; border: 1px solid var(--border-color, #d9dde2); border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }
.outcome-icon:disabled { opacity: .4; cursor: default; }
.outcome-totals { margin-block: 12px; color: #646a73; gap: 8px 16px; }
.outcome-totals strong { color: var(--text-primary, #252930); font-variant-numeric: tabular-nums; }
.outcome-source { padding-block: 12px; border-top: 1px solid var(--border-color, #e2e4e8); min-width: 0; }
.outcome-source-heading { align-items: baseline; gap: 6px 12px; }
.source-command { padding: 0; border: 0; background: none; color: inherit; text-align: left; line-height: 1.6; font: inherit; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; min-width: 0; }
.source-command:hover { color: #2563eb; }
.source-command:disabled { cursor: default; color: #646a73; }
.outcome-draft { margin-block: 6px; gap: 6px 12px; font-size: 12px; }
.outcome-version { display: grid; grid-template-columns: 72px 84px minmax(0, 1fr) 84px 30px; align-items: center; gap: 8px; padding-block: 4px; min-width: 0; }
.outcome-version strong { font-weight: 500; }
.outcome-version-detail { overflow-wrap: anywhere; min-width: 0; line-height: 1.6; }
.outcome-muted { color: #646a73; }
.outcome-success { color: #15803d; }
.outcome-warning { color: #a15c08; }
.outcome-error { color: #b42318; overflow-wrap: anywhere; }
.outcome-wait, .outcome-stall, .outcome-no-production, .outcome-empty { margin-block: 8px; line-height: 1.7; }
.outcome-history { margin-top: 8px; color: #646a73; font-size: 12px; }
.outcome-history summary { cursor: pointer; }
.outcome-history p { margin-block: 6px; overflow-wrap: anywhere; }
.outcome-pagination { justify-content: flex-end; padding-top: 10px; color: #646a73; }
.spinning { animation: outcome-spin 1s linear infinite; }
@keyframes outcome-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .outcome-version { grid-template-columns: 64px minmax(0, 1fr) 30px; gap: 4px 8px; padding-block: 8px; }
  .outcome-version-detail { grid-column: 1 / 3; grid-row: 2; }
  .outcome-version > .outcome-media { grid-column: 1 / 3; grid-row: 3; }
  .outcome-version > a { grid-column: 3; grid-row: 1; }
}
</style>
