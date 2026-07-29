<template>
  <template v-if="!compact">
    <button class="task-center-fab" :class="{ 'is-dragging': isDragging }"
      :style="{ right: fabRight + 'px', bottom: fabBottom + 'px' }"
      @pointerdown="onPointerDown"
      @click="onFabClick">
      <span class="task-center-fab-mark">
        <span v-if="activeCount" class="task-center-pulse" />
      </span>
      <span class="task-center-fab-copy">
        <strong>任务中心</strong>
        <small>{{ fabSubtitle }}</small>
      </span>
      <span v-if="activeCount" class="task-center-count">{{ activeCount }}</span>
    </button>
  </template>

  <button v-else class="task-center-fab is-compact" @click="panelOpen = true">
    <span class="task-center-fab-mark">
      <span v-if="activeCount" class="task-center-pulse" />
    </span>
    <strong>任务中心</strong>
    <span v-if="activeCount" class="task-center-count">{{ activeCount }}</span>
  </button>

  <Transition name="task-center-fade">
    <div v-if="panelOpen" class="task-center-layer" @click.self="panelOpen = false">
      <aside class="task-center-panel" aria-label="任务中心">
        <header class="task-center-head">
          <div>
            <div class="task-center-kicker">Task Center</div>
            <h2>正在运行</h2>
            <p>{{ activeCount ? `${activeCount} 个批量任务执行中` : '当前没有运行中的批量任务' }}</p>
          </div>
          <div class="task-center-head-actions">
            <span :class="['task-center-worker-badge', isWorkerHealthy ? 'is-online' : 'is-offline']">
              <span class="task-center-worker-dot" />
              {{ isWorkerHealthy ? 'Worker 在线' : 'Worker 离线' }}
            </span>
            <button class="btn btn-sm" :disabled="loading" @click="$emit('refresh')">
              {{ loading ? '刷新中' : '刷新' }}
            </button>
            <button class="btn btn-ghost btn-icon" @click="panelOpen = false" aria-label="关闭任务中心">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div v-if="error" class="task-center-error">{{ error }}</div>

        <div v-if="!activeCount && !loading" class="task-center-empty">
          <div class="task-center-empty-mark">✓</div>
          <div class="task-center-empty-title">暂无运行中任务</div>
          <div class="task-center-empty-desc">批量合成、拼接等带有进度的任务会在这里实时显示。</div>
        </div>

        <div v-else class="task-center-body">
          <div class="batch-tree">
            <!-- Level 1: Drama -->
            <article v-for="drama in dramaGroups" :key="drama.dramaId" class="batch-drama">
              <button class="batch-level-header batch-level-drama" @click="toggleDrama(drama.dramaId)">
                <span class="task-card-chevron" aria-hidden="true">
                  {{ isDramaExpanded(drama.dramaId) ? '▾' : '▸' }}
                </span>
                <span class="batch-level-title">{{ drama.title }}</span>
                <span class="batch-level-count">{{ drama.episodes.length }} 个剧集</span>
              </button>

              <!-- Level 2: Episode -->
              <div v-if="isDramaExpanded(drama.dramaId)" class="batch-drama-children">
                <article v-for="ep in drama.episodes" :key="episodeKey(ep)" class="batch-episode"
                  :class="{ 'is-expanded': isEpisodeExpanded(episodeKey(ep)) }">
                  <button class="batch-level-header batch-level-episode" @click="toggleEpisode(episodeKey(ep))">
                    <span class="task-card-chevron" aria-hidden="true">
                      {{ isEpisodeExpanded(episodeKey(ep)) ? '▾' : '▸' }}
                    </span>
                    <span class="batch-level-title">{{ ep.title }}</span>
                    <span class="batch-level-count">{{ ep.tasks.length }} 个任务</span>
                  </button>

                  <!-- Level 3: Task Type with progress -->
                  <div v-if="isEpisodeExpanded(episodeKey(ep))" class="batch-episode-children">
                    <article v-for="item in ep.tasks" :key="taskId(item.task)" class="batch-task-card"
                      :class="{ 'is-running': taskStatus(item.task) === 'running' }">
                      <div class="batch-task-head">
                        <span class="task-center-status-dot" :class="'is-' + taskStatus(item.task)" />
                        <span class="batch-task-title">{{ item.label }}</span>
                        <span class="batch-task-status">{{ statusLabel(item.task) }}</span>
                        <button v-if="canCancel(item.task)" class="btn btn-sm" @click="requestCancel(item.task)">取消</button>
                      </div>

                      <div class="batch-task-progress">
                        <div class="batch-progress-top">
                          <span class="batch-progress-count">
                            {{ item.progress.total > 0 ? `${item.progress.current} / ${item.progress.total}` : '阶段处理中' }}
                          </span>
                          <span v-if="item.progress.total > 0" class="batch-progress-percent">{{ item.progress.percent }}%</span>
                        </div>
                        <div v-if="item.progress.total > 0" class="task-progress-track">
                          <div class="task-progress-fill" :style="{ width: item.progress.percent + '%' }" />
                        </div>
                      </div>

                      <div v-if="taskStatusDetail(item.task) || item.progress.message" class="batch-task-meta">
                        <span v-if="taskStatusDetail(item.task)">{{ taskStatusDetail(item.task) }}</span>
                        <span v-if="item.progress.message">· {{ item.progress.message }}</span>
                      </div>

                      <div v-if="dharmaTelemetry(item.task)" class="dharma-render-telemetry">
                        <span>{{ dharmaPhaseLabels[dharmaTelemetry(item.task)?.phase || 'preflight'] }}</span>
                        <span>本阶段 {{ formatDuration(dharmaTelemetry(item.task)?.phaseElapsedMs || 0) }}</span>
                        <span>已耗时 {{ formatDuration(dharmaTelemetry(item.task)?.elapsedMs || 0) }}</span>
                        <span v-if="dharmaTelemetry(item.task)?.fps !== null">
                          {{ dharmaTelemetry(item.task)?.fps }} fps
                        </span>
                        <span v-if="dharmaTelemetry(item.task)?.etaMs !== null">
                          预计剩余 {{ formatDuration(dharmaTelemetry(item.task)?.etaMs || 0) }}
                        </span>
                      </div>
                    </article>
                  </div>
                </article>
              </div>
            </article>
          </div>
        </div>

        <footer class="task-center-foot">
          <span v-if="lastLoadedAt">上次同步 {{ formatTime(lastLoadedAt) }}</span>
          <span v-else>任务状态来自后端持久任务表</span>
        </footer>
      </aside>
    </div>
  </Transition>

  <Transition name="task-center-fade">
    <div
      v-if="cancelDialogTask"
      class="task-cancel-layer"
      @click.self="closeCancelDialog"
      @keydown.esc="closeCancelDialog"
    >
      <section
        class="task-cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-cancel-title"
        aria-describedby="task-cancel-description"
      >
        <h2 id="task-cancel-title">取消整集渲染</h2>
        <p id="task-cancel-description">该操作会终止当前 Remotion 渲染并清理其暂存文件。</p>
        <form @submit.prevent="submitDharmaCancel">
          <label class="task-cancel-field">
            <span>取消原因</span>
            <textarea ref="cancelReasonInput" v-model="cancelReason" rows="3" maxlength="500" placeholder="请输入取消原因" />
          </label>
          <label class="task-cancel-field">
            <span>操作者标签</span>
            <input v-model="cancelActor" type="text" maxlength="120" autocomplete="name" placeholder="例如：zhangshijie" />
          </label>
          <label class="task-cancel-field">
            <span>控制令牌</span>
            <input v-model="cancelControlToken" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <label class="task-cancel-field">
            <span>输入 <code>CANCEL {{ taskId(cancelDialogTask) }}</code> 以确认</span>
            <input v-model="cancelConfirmation" type="text" autocomplete="off" spellcheck="false" />
          </label>
          <p v-if="cancelSubmitError" class="task-cancel-submit-error" role="alert">{{ cancelSubmitError }}</p>
          <div class="task-cancel-actions">
            <button class="btn btn-ghost" type="button" :disabled="cancelSubmitting" @click="closeCancelDialog">返回</button>
            <button class="btn task-cancel-confirm" type="submit" :disabled="cancelSubmitting || !canSubmitDharmaCancel">
              {{ cancelSubmitting ? '提交中' : '确认取消' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  deriveBatchTaskGroups,
  isActiveTask,
  requiresDharmaFullRenderCancelConfirmation,
  taskId,
  taskStatus,
  taskStatusDetail,
  taskTitle,
  taskValue,
  type BatchEpisodeGroup,
  type CreationTask,
  type DharmaRenderTelemetry,
  type TaskStatus,
} from '~/composables/taskState'

const STORAGE_KEY = 'taskcenter-fab-pos'
const DRAG_THRESHOLD = 5

const fabRight = ref(22)
const fabBottom = ref(70)
const isDragging = ref(false)
const hasMoved = ref(false)
const dragStart = ref({ x: 0, y: 0, right: 0, bottom: 0 })
const expandedDramaKeys = ref(new Set<string>())
const expandedEpisodeKeys = ref(new Set<string>())
const cancelDialogTask = ref<CreationTask | null>(null)
const cancelReason = ref('')
const cancelActor = ref('')
const cancelControlToken = ref('')
const cancelConfirmation = ref('')
const cancelSubmitting = ref(false)
const cancelSubmitError = ref('')
const cancelReasonInput = ref<HTMLTextAreaElement | null>(null)
let cancelDialogTrigger: HTMLElement | null = null

const dharmaPhaseLabels: Record<DharmaRenderTelemetry['phase'], string> = {
  preflight: '渲染预检',
  configuration: '读取渲染配置',
  props_build: '构建素材与合成参数',
  input_fingerprint_pre_render: '核对渲染输入',
  staging_prepare: '准备交付暂存区',
  remotion_render: '启动 Remotion',
  remotion_bundle: '打包合成代码',
  remotion_composition: '读取合成配置',
  remotion_frames: '渲染画面帧',
  remotion_encode: '编码封装成片',
  output_validation: '校验交付文件',
  publish: '发布交付文件',
  staging_cleanup: '清理暂存文件',
}

const props = withDefaults(defineProps<{
  tasks: CreationTask[]
  open?: boolean
  loading?: boolean
  error?: string
  lastLoadedAt?: Date | string | null
  compact?: boolean
  workerHealth?: { healthy_count: number; total_count: number; timeout_ms: number; workers: any[] } | null
  isWorkerHealthy?: boolean
  telemetryByTaskId?: Record<number, DharmaRenderTelemetry>
}>(), {
  compact: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  refresh: []
  cancel: [
    payload: { task: CreationTask; reason?: string; confirmation?: string; actor?: string; controlToken?: string },
    complete?: (result: { ok: boolean; error?: string }) => void,
  ]
  retry: [task: any]
}>()

const panelOpen = computed({
  get: () => !!props.open,
  set: value => emit('update:open', value),
})

const dramaGroups = computed(() => deriveBatchTaskGroups(props.tasks || []))
const activeCount = computed(() => dramaGroups.value.reduce((sum, d) => sum + d.episodes.reduce((eSum, ep) => eSum + ep.tasks.length, 0), 0))
const fabSubtitle = computed(() => {
  if (!activeCount.value) return '暂无运行中任务'
  return `${activeCount.value} 个批量任务执行中`
})

function episodeKey(ep: BatchEpisodeGroup) {
  return `${ep.dramaId}:${ep.episodeId || 'project'}`
}

function isDramaExpanded(dramaId: string) {
  return expandedDramaKeys.value.has(dramaId)
}

function toggleDrama(dramaId: string) {
  if (expandedDramaKeys.value.has(dramaId)) {
    expandedDramaKeys.value.delete(dramaId)
  } else {
    expandedDramaKeys.value.add(dramaId)
  }
}

function isEpisodeExpanded(key: string) {
  return expandedEpisodeKeys.value.has(key)
}

function toggleEpisode(key: string) {
  if (expandedEpisodeKeys.value.has(key)) {
    expandedEpisodeKeys.value.delete(key)
  } else {
    expandedEpisodeKeys.value.add(key)
  }
}

function statusLabel(taskOrGroup: { status: TaskStatus } | CreationTask | undefined | null) {
  const status = ('status' in (taskOrGroup || {})
    ? taskOrGroup?.status
    : taskStatus(taskOrGroup as CreationTask | undefined | null)) as TaskStatus | string
  return {
    queued: '队列中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已取消',
    stale: '已中断',
  }[status] || status
}

function canCancel(task: CreationTask | undefined | null) {
  return isActiveTask(task) && !taskValue(task, 'cancel_requested')
}

function dharmaTelemetry(task: CreationTask | undefined | null) {
  return props.telemetryByTaskId?.[taskId(task)] || null
}

function requestCancel(task: CreationTask) {
  if (!requiresDharmaFullRenderCancelConfirmation(task)) {
    emit('cancel', { task })
    return
  }
  cancelDialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  cancelDialogTask.value = task
  cancelReason.value = ''
  cancelActor.value = ''
  cancelControlToken.value = ''
  cancelConfirmation.value = ''
  cancelSubmitting.value = false
  cancelSubmitError.value = ''
  void nextTick(() => cancelReasonInput.value?.focus())
}

const canSubmitDharmaCancel = computed(() => {
  const task = cancelDialogTask.value
  return Boolean(task
    && cancelReason.value.trim()
    && cancelActor.value.trim()
    && cancelControlToken.value.length > 0
    && cancelConfirmation.value.trim() === `CANCEL ${taskId(task)}`)
})

function closeCancelDialog() {
  if (cancelSubmitting.value) return
  cancelDialogTask.value = null
  cancelReason.value = ''
  cancelActor.value = ''
  cancelControlToken.value = ''
  cancelConfirmation.value = ''
  cancelSubmitError.value = ''
  const trigger = cancelDialogTrigger
  cancelDialogTrigger = null
  void nextTick(() => trigger?.focus())
}

function submitDharmaCancel() {
  const task = cancelDialogTask.value
  if (!task || !canSubmitDharmaCancel.value) return
  cancelSubmitting.value = true
  cancelSubmitError.value = ''
  emit('cancel', {
    task,
    reason: cancelReason.value.trim(),
    confirmation: cancelConfirmation.value.trim(),
    actor: cancelActor.value.trim(),
    controlToken: cancelControlToken.value,
  }, result => {
    if (result.ok) {
      cancelSubmitting.value = false
      closeCancelDialog()
      return
    }
    cancelSubmitting.value = false
    cancelSubmitError.value = result.error || '取消任务失败，请核对任务状态后重试'
  })
}

function formatTime(value: Date | string | null | undefined) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${minutes} 分 ${String(remainder).padStart(2, '0')} 秒` : `${remainder} 秒`
}

function clampPosition() {
  const maxRight = Math.max(0, window.innerWidth - 200)
  const maxBottom = Math.max(0, window.innerHeight - 60)
  fabRight.value = Math.max(0, Math.min(maxRight, fabRight.value))
  fabBottom.value = Math.max(0, Math.min(maxBottom, fabBottom.value))
}

function loadPosition() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const { right, bottom } = JSON.parse(saved)
      if (typeof right === 'number') fabRight.value = right
      if (typeof bottom === 'number') fabBottom.value = bottom
    }
  } catch {}
  clampPosition()
}

function cleanupDrag() {
  isDragging.value = false
}

onMounted(() => {
  loadPosition()
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointercancel', cleanupDrag)
  window.addEventListener('resize', clampPosition)
})

onUnmounted(() => {
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('pointercancel', cleanupDrag)
  window.removeEventListener('resize', clampPosition)
})

function onPointerDown(e: PointerEvent) {
  isDragging.value = true
  hasMoved.value = false
  dragStart.value = { x: e.clientX, y: e.clientY, right: fabRight.value, bottom: fabBottom.value }
  e.preventDefault()
}

function onPointerMove(e: PointerEvent) {
  if (!isDragging.value) return
  const dx = dragStart.value.x - e.clientX
  const dy = dragStart.value.y - e.clientY
  const newRight = Math.max(0, Math.min(window.innerWidth - 200, dragStart.value.right + dx))
  const newBottom = Math.max(0, Math.min(window.innerHeight - 60, dragStart.value.bottom + dy))
  fabRight.value = Math.round(newRight)
  fabBottom.value = Math.round(newBottom)
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
    hasMoved.value = true
  }
}

function onPointerUp() {
  if (!isDragging.value) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: fabRight.value, bottom: fabBottom.value }))
  } catch {}
  isDragging.value = false
}

function onFabClick(e: MouseEvent) {
  if (hasMoved.value) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  panelOpen.value = true
}
</script>

<style scoped>
.task-center-fab {
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(76,125,255,0.2);
  background: rgba(255,255,255,0.92);
  color: var(--text-0);
  box-shadow: var(--shadow-elevated);
  cursor: pointer;
  backdrop-filter: blur(14px);
}

.task-center-fab:not(.is-compact) {
  position: fixed;
  z-index: 45;
  gap: 10px;
  min-width: 178px;
  padding: 10px 12px;
  border-radius: 18px;
  touch-action: none;
}

.task-center-fab:not(.is-compact).is-dragging {
  opacity: 0.85;
  box-shadow: 0 12px 32px rgba(20, 32, 54, 0.18);
  cursor: grabbing;
  user-select: none;
}

.task-center-fab.is-compact {
  position: static;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 4px 10px;
  border-radius: 14px;
  font-size: 11px;
  white-space: nowrap;
  min-width: auto;
}

.task-center-fab.is-compact .task-center-fab-mark {
  width: 20px;
  height: 20px;
  border-radius: 7px;
}

.task-center-fab.is-compact .task-center-pulse {
  right: -1px;
  top: -1px;
  width: 7px;
  height: 7px;
}

.task-center-fab.is-compact .task-center-count {
  margin-left: 0;
  min-width: 18px;
  height: 18px;
  font-size: 10px;
}

.task-center-fab.is-compact:hover {
  transform: scale(1.02);
  filter: brightness(1.04);
}

.task-center-fab-mark {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 10px;
  background: var(--accent-gradient);
  box-shadow: 0 8px 18px rgba(53,95,206,0.2);
}

.task-center-pulse {
  position: absolute;
  right: -2px;
  top: -2px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 0 5px rgba(63,138,99,0.14);
}

.task-center-fab-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.2;
}

.task-center-fab-copy strong {
  font-size: 13px;
  color: var(--text-0);
}

.task-center-fab-copy small {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}

.task-center-count {
  margin-left: auto;
  min-width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 11px;
  font-weight: 700;
}

.task-center-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  background: rgba(24,33,50,0.2);
  backdrop-filter: blur(3px);
}

.task-center-panel {
  width: min(480px, calc(100vw - 28px));
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px;
  background:
    radial-gradient(circle at top right, rgba(76,125,255,0.14), transparent 30%),
    rgba(248,251,255,0.96);
  border-left: 1px solid rgba(86,108,150,0.16);
  box-shadow: -18px 0 46px rgba(50,74,114,0.18);
  animation: taskPanelIn 0.22s var(--ease-out);
}

.task-center-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.task-center-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-3);
}

.task-center-head h2 {
  margin-top: 2px;
  font-size: 24px;
}

.task-center-head p {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-2);
}

.task-center-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-center-error {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--error-bg);
  color: var(--error);
  font-size: 12px;
}

.task-center-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-2);
}

.task-center-empty-mark {
  width: 46px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  background: var(--success-bg);
  color: var(--success);
  font-weight: 800;
}

.task-center-empty-title {
  margin-top: 12px;
  font-weight: 700;
  color: var(--text-0);
}

.task-center-empty-desc {
  width: min(280px, 100%);
  margin-top: 4px;
  font-size: 12px;
}

.task-center-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 2px 12px 0;
}

.task-center-status-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--text-3);
}

.task-center-status-dot.is-running,
.task-center-status-dot.is-queued {
  background: var(--info);
}

.task-center-status-dot.is-succeeded {
  background: var(--success);
}

.task-center-status-dot.is-failed,
.task-center-status-dot.is-stale {
  background: var(--error);
}

.task-center-status-dot.is-canceled {
  background: var(--warning);
}

.batch-tree {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.batch-drama {
  border: 1px solid rgba(86,108,150,0.14);
  border-radius: 16px;
  background: rgba(255,255,255,0.78);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}

.batch-level-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.batch-level-drama {
  font-weight: 700;
  color: var(--text-0);
}

.batch-level-episode {
  padding: 10px 14px;
  color: var(--text-1);
}

.batch-level-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-level-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-3);
}

.task-card-chevron {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-3);
}

.batch-drama-children {
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-episode {
  border: 1px solid rgba(86,108,150,0.10);
  border-radius: 12px;
  background: rgba(255,255,255,0.62);
  overflow: hidden;
}

.batch-episode-children {
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-task-card {
  padding: 12px;
  border: 1px solid rgba(86,108,150,0.10);
  border-radius: 10px;
  background: rgba(255,255,255,0.90);
}

.batch-task-card.is-running {
  border-color: rgba(76,125,255,0.22);
  box-shadow: 0 0 0 3px rgba(76,125,255,0.06);
}

.batch-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.batch-task-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
}

.batch-task-status {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-3);
}

.batch-task-head .btn {
  flex: 0 0 auto;
}

.batch-task-progress {
  margin-top: 10px;
}

.batch-progress-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}

.batch-progress-count {
  font-weight: 700;
  color: var(--text-0);
}

.batch-progress-percent {
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  font-weight: 700;
}

.task-progress-track {
  height: 6px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-2);
}

.task-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent-gradient);
  transition: width 0.3s var(--ease-out);
}

.batch-task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-3);
}

.dharma-render-telemetry {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid rgba(86,108,150,0.10);
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dharma-render-telemetry span:first-child {
  color: var(--accent-text);
  font-weight: 700;
}

.task-cancel-layer {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(19, 25, 36, 0.45);
}

.task-cancel-dialog {
  width: min(100%, 420px);
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-1);
  box-shadow: var(--shadow-elevated);
}

.task-cancel-dialog h2 {
  margin: 0;
  color: var(--text-0);
  font-size: 16px;
}

.task-cancel-dialog p {
  margin: 8px 0 18px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.task-cancel-field {
  display: grid;
  gap: 7px;
  margin-top: 12px;
  color: var(--text-1);
  font-size: 12px;
}

.task-cancel-field textarea,
.task-cancel-field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  color: var(--text-0);
  font: inherit;
  line-height: 1.5;
  padding: 8px 9px;
}

.task-cancel-field textarea {
  resize: vertical;
}

.task-cancel-field code {
  color: var(--accent-text);
}

.task-cancel-submit-error {
  margin: 12px 0 0;
  color: var(--error);
  font-size: 12px;
  line-height: 1.5;
}

.task-cancel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.task-cancel-confirm {
  border-color: rgba(185, 67, 67, 0.3);
  background: #a33f3f;
  color: #fff;
}

.task-cancel-confirm:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.task-center-foot {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 11px;
}

.task-center-worker-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--bg-2);
  color: var(--text-2);
}

.task-center-worker-badge.is-online {
  background: rgba(63, 138, 99, 0.12);
  color: var(--success);
}

.task-center-worker-badge.is-offline {
  background: rgba(210, 79, 102, 0.12);
  color: var(--error);
}

.task-center-worker-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
}

.task-center-fade-enter-active,
.task-center-fade-leave-active {
  transition: opacity 0.18s var(--ease-out);
}

.task-center-fade-enter-from,
.task-center-fade-leave-to {
  opacity: 0;
}

@keyframes taskPanelIn {
  from { transform: translateX(20px); opacity: 0.7; }
  to { transform: translateX(0); opacity: 1; }
}

@media (max-width: 720px) {
  .task-center-fab:not(.is-compact) {
    min-width: 156px;
    padding: 9px 10px;
  }

  .task-center-layer {
    align-items: flex-end;
    justify-content: center;
  }

  .task-center-panel {
    width: 100%;
    height: min(78vh, 680px);
    border-left: 0;
    border-top: 1px solid rgba(86,108,150,0.16);
    border-radius: 24px 24px 0 0;
    animation: taskSheetIn 0.22s var(--ease-out);
  }
}

@keyframes taskSheetIn {
  from { transform: translateY(24px); opacity: 0.76; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
