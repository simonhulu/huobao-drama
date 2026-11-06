<template>
  <section class="material-update" aria-label="花生镜头素材">
    <div class="material-heading">
      <div class="material-overview">
        <h2>花生镜头素材</h2>
        <dl class="material-stats">
          <div><dt>项目</dt><dd>{{ count(overview?.stats.projects) }}</dd></div>
          <div><dt>分镜</dt><dd>{{ count(overview?.stats.clips) }}</dd></div>
          <div><dt>已下载视频</dt><dd>{{ count(overview?.stats.downloadedAssets) }}</dd></div>
        </dl>
      </div>
      <div class="material-actions">
        <button class="material-control primary" type="button" :disabled="!canStart" @click="update('start')">
          <RefreshCw :size="14" :class="{ spinning: action === 'start' || active }" />
          {{ action === 'start' ? '开始中' : active ? '更新中' : '更新素材库' }}
        </button>
        <button v-if="active" class="material-control" type="button" :disabled="!canStop" @click="update('stop')">
          <Square :size="13" />{{ stopping ? '正在中断' : '中断更新' }}
        </button>
        <button class="material-icon" type="button" title="刷新镜头素材状态" aria-label="刷新镜头素材状态" :disabled="loading || !!action" @click="loadOverview">
          <RefreshCw :size="14" :class="{ spinning: loading }" />
        </button>
      </div>
    </div>

    <div class="material-status" role="status" aria-label="素材库更新状态" aria-live="polite">
      <component :is="statusIcon" :size="15" class="status-icon" :class="statusTone" />
      <strong :class="statusTone">{{ statusLabel }}</strong>
      <span v-if="readError && task" class="previous-status">上次状态：{{ taskStatus }}</span>
      <span v-if="task && task.progressTotal > 0" class="project-progress">{{ task.progressCurrent }} / {{ task.progressTotal }} 个项目</span>
    </div>
    <div v-if="task && (active || task.progressTotal > 0)" class="progress-track" role="progressbar" aria-label="项目更新进度" :aria-valuenow="task.progressTotal > 0 ? task.progressCurrent : undefined" :aria-valuemax="task.progressTotal > 0 ? task.progressTotal : undefined" aria-valuemin="0">
      <span :class="{ indeterminate: active && !task.progressTotal }" :style="{ width: `${progressPercent}%` }"></span>
    </div>
    <p v-if="task?.progressMessage" class="material-message">{{ task.progressMessage }}</p>
    <div v-if="task" class="material-times">
      <span>开始 <time v-if="task.startedAt" :datetime="task.startedAt">{{ formatTime(task.startedAt) }}</time><span v-else>待开始</span></span>
      <span>结束 <time v-if="task.completedAt" :datetime="task.completedAt">{{ formatTime(task.completedAt) }}</time><span v-else>{{ active ? '进行中' : '—' }}</span></span>
    </div>
    <p v-if="resultSummary" class="material-result">{{ resultSummary }}</p>
    <p v-if="readError" class="material-error" role="alert">{{ readError }}</p>
    <p v-if="actionError" class="material-error" role="alert">{{ actionError }}</p>
    <p v-if="task?.errorMessage" class="material-error">{{ task.errorMessage }}</p>
    <button v-if="needsBrowser" class="material-control browser-control" type="button" :disabled="!!action" @click="openBrowser">
      <ExternalLink :size="14" />{{ action === 'browser' ? '正在打开' : '打开花生浏览器' }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CircleAlert, CircleCheck, CircleDashed, CircleStop, Clock3, ExternalLink, LoaderCircle, RefreshCw, Square } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

type Task = {
  id: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'stale'
  cancelRequested: boolean
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  errorMessage: string | null
  result: Record<string, unknown> | null
}
type Overview = { stats: { projects: number; clips: number; files: number; downloadedAssets: number }; task: Task | null }
const overview = ref<Overview | null>(null)
const loading = ref(false)
const readError = ref('')
const action = ref('')
const actionError = ref('')
const uncertain = ref(false)
const task = computed(() => overview.value?.task)
const active = computed(() => !!task.value && ['queued', 'running'].includes(task.value.status))
const stopping = computed(() => action.value === 'stop' || !!task.value?.cancelRequested)
const canStart = computed(() => !!overview.value && !readError.value && !uncertain.value && !action.value && !active.value)
const canStop = computed(() => active.value && !stopping.value && !action.value)
const taskStatus = computed(() => {
  if (active.value && stopping.value) return '正在中断'
  return task.value ? { queued: '待开始', running: '更新中', succeeded: '已完成', failed: '更新失败', canceled: '已中断', stale: '已中断' }[task.value.status] : '尚未更新'
})
const statusLabel = computed(() => readError.value ? '状态待刷新' : action.value === 'start' ? '开始中' : !overview.value && loading.value ? '读取中' : taskStatus.value)
const statusTone = computed(() => readError.value ? 'error' : active.value || action.value === 'start' ? 'active' : task.value?.status === 'failed' ? 'error' : task.value?.status === 'succeeded' ? 'success' : '')
const statusIcon = computed(() => readError.value || task.value?.status === 'failed' ? CircleAlert : active.value || action.value === 'start' ? LoaderCircle : task.value?.status === 'succeeded' ? CircleCheck : ['canceled', 'stale'].includes(task.value?.status || '') ? CircleStop : task.value ? Clock3 : CircleDashed)
const progressPercent = computed(() => task.value?.progressTotal ? Math.min(100, Math.max(0, task.value.progressCurrent / task.value.progressTotal * 100)) : 0)
const resultSummary = computed(() => {
  const result = task.value?.result
  if (!result) return ''
  const entries: [string, string][] = [['downloaded', '新增视频'], ['reused', '复用视频'], ['unavailableClips', '候选不足分镜'], ['metadataWarnings', '标注提醒'], ['failedProjects', '失败项目'], ['failedClips', '失败分镜']]
  return entries.filter(([key]) => typeof result[key] === 'number' && (['downloaded', 'reused'].includes(key) || Number(result[key]) > 0)).map(([key, label]) => `${label} ${count(Number(result[key]))}`).join(' · ')
})
const needsBrowser = computed(() => /登录|浏览器|browser|CDP|Chrome|log[ -]?in/i.test([task.value?.errorMessage, actionError.value].join(' ')))
let requestVersion = 0
let mounted = false
let timer: ReturnType<typeof setTimeout> | undefined

function count(value?: number) { return typeof value === 'number' ? value.toLocaleString('zh-CN') : '--' }
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : value
}
function scheduleRefresh() {
  clearTimeout(timer)
  if (mounted && !document.hidden) timer = setTimeout(() => { void loadOverview() }, 2500)
}
function applyOverview(value: Overview) {
  overview.value = value
  readError.value = ''
  if (uncertain.value) actionError.value = ''
  uncertain.value = false
}
async function loadOverview() {
  if (!mounted || action.value) return
  clearTimeout(timer)
  const version = ++requestVersion
  loading.value = true
  try {
    const value = await api.get<Overview>('/huasheng-materials')
    if (mounted && version === requestVersion) applyOverview(value)
  } catch (error: any) {
    if (mounted && version === requestVersion) readError.value = `无法读取素材库状态：${error.message || '连接失败'}`
  } finally {
    if (mounted && version === requestVersion) {
      loading.value = false
      scheduleRefresh()
    }
  }
}
async function update(command: 'start' | 'stop') {
  if (command === 'start' ? !canStart.value : !canStop.value) return
  const version = ++requestVersion
  clearTimeout(timer)
  loading.value = false
  action.value = command
  actionError.value = ''
  let reconcile = false
  try {
    const path = command === 'start' ? '/huasheng-materials/updates' : `/huasheng-materials/updates/${task.value!.id}/stop`
    const value = await api.post<Overview>(path, {})
    if (mounted && version === requestVersion) applyOverview(value)
  } catch (error: any) {
    if (mounted && version === requestVersion) {
      uncertain.value = !error.status || error.status >= 500
      actionError.value = uncertain.value ? `请求结果待确认：${error.message || '连接中断'}` : error.message || '操作失败'
      reconcile = true
    }
  } finally {
    if (mounted && version === requestVersion) {
      action.value = ''
      if (reconcile) await loadOverview()
      else scheduleRefresh()
    }
  }
}
async function openBrowser() {
  if (action.value) return
  action.value = 'browser'
  actionError.value = ''
  try {
    await api.post('/history-scripts/huasheng/browser/open', {})
  } catch (error: any) {
    if (mounted) actionError.value = error.message || '无法打开浏览器'
  } finally {
    if (mounted) {
      action.value = ''
      scheduleRefresh()
    }
  }
}
function visibilityChanged() {
  if (document.hidden) clearTimeout(timer)
  else void loadOverview()
}
onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', visibilityChanged)
  void loadOverview()
})
onBeforeUnmount(() => {
  mounted = false
  requestVersion++
  clearTimeout(timer)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<style scoped>
.material-update { padding: 0 0 24px; margin-bottom: 24px; border-bottom: 1px solid var(--border); min-width: 0; letter-spacing: 0; }
.material-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.material-overview { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-0); letter-spacing: 0; }
.material-stats { display: flex; gap: 24px; flex-wrap: wrap; margin: 0; }
.material-stats div { display: flex; gap: 8px; align-items: baseline; }
dt { font-size: 12px; color: var(--text-3); }
dd { margin: 0; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text-1); }
.material-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.material-control, .material-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); color: var(--text-2); cursor: pointer; font: inherit; font-size: 12px; }
.material-control { padding: 0 12px; white-space: nowrap; }
.material-icon { width: 34px; padding: 0; flex: 0 0 34px; }
.material-control svg { flex-shrink: 0; }
.material-control.primary { background: var(--accent-bg); color: var(--accent-text); border-color: var(--border-strong); }
.material-control:hover:not(:disabled), .material-icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-0); }
.material-control:disabled, .material-icon:disabled { cursor: not-allowed; opacity: .5; }
.material-control:focus-visible, .material-icon:focus-visible { outline: 2px solid var(--accent-text); outline-offset: 2px; }
.material-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 18px; min-height: 20px; font-size: 12px; color: var(--text-2); }
.material-status strong { font-weight: 600; }
.status-icon { flex: 0 0 15px; }
.success { color: var(--success); }
.error { color: var(--error); }
.active { color: var(--accent-text); }
.previous-status, .project-progress { color: var(--text-3); font-variant-numeric: tabular-nums; }
.project-progress { margin-left: auto; }
.progress-track { height: 4px; margin-top: 10px; background: var(--bg-3); border-radius: 2px; overflow: hidden; }
.progress-track > span { display: block; height: 100%; background: var(--accent-text); transition: width .2s; }
.progress-track > .indeterminate { width: 30% !important; animation: progress 1.6s ease-in-out infinite; }
.material-message, .material-result, .material-error { margin: 10px 0 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.material-message, .material-result { color: var(--text-2); }
.material-times { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 8px; font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.material-times > span { display: inline-flex; gap: 6px; }
.material-error { color: var(--error); }
.browser-control { margin-top: 10px; }
.spinning { animation: spin 1.5s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(440%); } }
@media (max-width: 640px) {
  .material-heading { align-items: flex-start; }
  .material-overview, .material-actions { width: 100%; }
  .material-stats { gap: 12px 18px; }
  .project-progress { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .spinning, .progress-track > .indeterminate { animation: none; }
}
</style>
