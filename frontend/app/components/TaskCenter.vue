<template>
  <template v-if="!compact">
    <button class="task-center-fab" :class="{ 'has-failed': failedCount > 0, 'is-dragging': isDragging }"
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
      <span v-if="visibleCount" class="task-center-count">{{ visibleCount }}</span>
    </button>
  </template>

  <button v-else class="task-center-fab is-compact" :class="{ 'has-failed': failedCount > 0 }" @click="panelOpen = true">
    <span class="task-center-fab-mark">
      <span v-if="activeCount" class="task-center-pulse" />
    </span>
    <strong>任务中心</strong>
    <span v-if="visibleCount" class="task-center-count">{{ visibleCount }}</span>
  </button>

  <Transition name="task-center-fade">
    <div v-if="panelOpen" class="task-center-layer" @click.self="panelOpen = false">
      <aside class="task-center-panel" aria-label="任务中心">
        <header class="task-center-head">
          <div>
            <div class="task-center-kicker">Task Center</div>
            <h2>后台任务</h2>
            <p>{{ activeCount ? `${activeCount} 个任务正在执行` : '当前没有进行中的任务' }}</p>
          </div>
          <div class="task-center-head-actions">
            <button class="btn btn-sm" :disabled="loading" @click="$emit('refresh')">
              {{ loading ? '刷新中' : '刷新' }}
            </button>
            <button class="btn btn-ghost btn-icon" @click="panelOpen = false" aria-label="关闭任务中心">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div v-if="error" class="task-center-error">{{ error }}</div>

        <div v-if="!visibleCount && !loading" class="task-center-empty">
          <div class="task-center-empty-mark">✓</div>
          <div class="task-center-empty-title">暂无后台任务</div>
          <div class="task-center-empty-desc">新发起的图片、视频、配音、合成和拼接任务会出现在这里。</div>
        </div>

        <div v-else class="task-center-body">
          <article v-for="group in episodeGroups" :key="group.key" class="task-card">
            <div class="task-card-main">
              <div class="task-card-title-row">
                <span class="task-card-title">{{ group.title }}</span>
                <span :class="['tag', statusTagClass(group)]">{{ statusLabel(group) }}</span>
              </div>

              <div v-if="group.progress.total" class="task-progress">
                <div class="task-progress-top">
                  <span>总进度</span>
                  <span>{{ groupPercent(group) }}%</span>
                </div>
                <div class="task-progress-track">
                  <div class="task-progress-fill" :style="{ width: groupPercent(group) + '%' }" />
                </div>
              </div>

              <div v-if="!isExpanded(group.key) && failedChildren(group).length" class="task-card-failures">
                <div v-for="task in failedChildren(group)" :key="'collapsed-fail-' + taskId(task)" class="task-card-failure">
                  <div class="task-card-failure-title">{{ taskTitle(task) }}</div>
                  <div class="task-card-failure-msg">{{ taskFailure(task) }}</div>
                  <div class="task-card-failure-actions">
                    <button v-if="canCancel(task)" class="btn btn-sm" @click="$emit('cancel', task)">取消</button>
                    <button v-if="canRetry(task)" class="btn btn-sm btn-primary" @click="$emit('retry', task)">重试</button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="isExpanded(group.key) && group.grouped.roots.length" class="task-children">
              <div class="task-children-title">执行步骤</div>
              <div v-for="task in group.grouped.roots" :key="taskId(task)" class="task-child-row">
                <span :class="['task-center-status-dot', `is-${taskStatus(task)}`]" />
                <span class="task-child-title">{{ taskTitle(task) }}</span>
                <span class="task-child-status">{{ statusLabel(task) }}</span>
                <button v-if="canCancel(task)" class="btn btn-sm" @click="$emit('cancel', task)">取消</button>
                <button v-if="canRetry(task)" class="btn btn-sm btn-primary" @click="$emit('retry', task)">重试</button>
              </div>

              <template v-for="task in group.grouped.roots" :key="'children-of-' + taskId(task)">
                <div v-if="childrenForGroup(group, task).length" v-for="child in childrenForGroup(group, task)" :key="taskId(child)" class="task-child-row is-nested">
                  <span :class="['task-center-status-dot', `is-${taskStatus(child)}`]" />
                  <span class="task-child-title">{{ taskTitle(child) }}</span>
                  <span class="task-child-status">{{ statusLabel(child) }}</span>
                  <button v-if="canCancel(child)" class="btn btn-sm" @click="$emit('cancel', child)">取消</button>
                  <button v-if="canRetry(child)" class="btn btn-sm btn-primary" @click="$emit('retry', child)">重试</button>
                </div>
              </template>

              <div v-for="task in group.grouped.roots" :key="'failure-' + taskId(task)">
                <div v-if="taskFailure(task)" class="task-card-failure">{{ taskFailure(task) }}</div>
              </div>
            </div>

            <button class="task-card-toggle" @click="toggleGroup(group.key)">
              {{ isExpanded(group.key) ? '收起详情' : '查看详情' }}
            </button>
          </article>
        </div>

        <footer class="task-center-foot">
          <span v-if="lastLoadedAt">上次同步 {{ formatTime(lastLoadedAt) }}</span>
          <span v-else>任务状态来自后端持久任务表</span>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  deriveEpisodeTaskGroups,
  isActiveTask,
  isFailedTask,
  taskFailureMessage,
  taskId,
  taskStatus,
  taskTitle,
  taskValue,
  type CreationTask,
  type EpisodeTaskGroup,
  type TaskStatus,
} from '~/composables/taskState'

const STORAGE_KEY = 'taskcenter-fab-pos'
const DRAG_THRESHOLD = 5

const fabRight = ref(22)
const fabBottom = ref(70)
const isDragging = ref(false)
const hasMoved = ref(false)
const dragStart = ref({ x: 0, y: 0, right: 0, bottom: 0 })
const expandedKeys = ref(new Set<string>())

function isExpanded(key: string) {
  return expandedKeys.value.has(key)
}

function toggleGroup(key: string) {
  if (expandedKeys.value.has(key)) {
    expandedKeys.value.delete(key)
  } else {
    expandedKeys.value.add(key)
  }
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

const props = withDefaults(defineProps<{
  tasks: CreationTask[]
  open?: boolean
  loading?: boolean
  error?: string
  lastLoadedAt?: Date | string | null
  compact?: boolean
}>(), {
  compact: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  refresh: []
  cancel: [task: any]
  retry: [task: any]
}>()

const panelOpen = computed({
  get: () => !!props.open,
  set: value => emit('update:open', value),
})

const episodeGroups = computed(() => deriveEpisodeTaskGroups(props.tasks || []))
const activeCount = computed(() => episodeGroups.value.filter(g => g.status === 'running' || g.status === 'queued').length)
const failedCount = computed(() => episodeGroups.value.filter(g => g.status === 'failed' || g.status === 'stale').length)
const visibleCount = computed(() => episodeGroups.value.length)
const fabSubtitle = computed(() => {
  if (failedCount.value) return `${failedCount.value} 个失败待处理`
  if (activeCount.value) return `${activeCount.value} 个执行中`
  return visibleCount.value ? `${visibleCount.value} 个历史任务` : '查看后台状态'
})

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

function statusTagClass(taskOrGroup: { status: TaskStatus } | CreationTask | undefined | null) {
  const status = ('status' in (taskOrGroup || {})
    ? taskOrGroup?.status
    : taskStatus(taskOrGroup as CreationTask | undefined | null)) as TaskStatus | string
  if (status === 'succeeded') return 'tag-success'
  if (status === 'failed' || status === 'stale') return 'tag-error'
  if (status === 'running' || status === 'queued') return 'tag-info'
  return ''
}

function taskFailure(task: CreationTask | undefined | null) {
  return isFailedTask(task) ? taskFailureMessage(task) : ''
}

function childrenForGroup(group: EpisodeTaskGroup, task: CreationTask | undefined | null) {
  return group.grouped.childrenByParent[String(taskId(task))] || []
}

function failedChildren(group: EpisodeTaskGroup): CreationTask[] {
  const failed: CreationTask[] = []
  for (const root of group.grouped.roots) {
    if (isFailedTask(root)) failed.push(root)
    for (const child of childrenForGroup(group, root)) {
      if (isFailedTask(child)) failed.push(child)
    }
  }
  return failed
}

function groupPercent(group: EpisodeTaskGroup) {
  if (!group.progress.total) return 0
  return Math.max(0, Math.min(100, Math.round((group.progress.terminal / group.progress.total) * 100)))
}

function canCancel(task: CreationTask | undefined | null) {
  return isActiveTask(task) && !taskValue(task, 'cancel_requested')
}

function canRetry(task: CreationTask | undefined | null) {
  return ['failed', 'stale'].includes(taskStatus(task))
}

function formatTime(value: Date | string | null | undefined) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
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

.task-center-fab.has-failed {
  border-color: rgba(210,79,102,0.35);
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
  width: min(440px, calc(100vw - 28px));
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

.task-center-section + .task-center-section {
  margin-top: 14px;
}

.task-center-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
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

.task-center-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-card {
  padding: 12px;
  border: 1px solid rgba(86,108,150,0.14);
  border-radius: 16px;
  background: rgba(255,255,255,0.78);
  box-shadow: var(--shadow-xs);
}

.task-card-main {
  min-width: 0;
}

.task-card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-0);
  font-size: 13px;
  font-weight: 700;
}

.task-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.task-progress {
  margin-top: 10px;
}

.task-progress-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
}

.task-progress-track {
  height: 5px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-2);
}

.task-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent-gradient);
}

.task-card-failure {
  margin-top: 9px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--error-bg);
  color: var(--error);
  font-size: 12px;
  line-height: 1.5;
}

.task-card-failures {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-card-failure-title {
  font-weight: 700;
  color: var(--text-0);
}

.task-card-failure-msg {
  margin-top: 2px;
  color: var(--error);
  font-size: 12px;
  line-height: 1.5;
}

.task-card-failure-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.task-card-toggle {
  width: 100%;
  margin-top: 10px;
  padding: 6px 0;
  border: 0;
  border-top: 1px dashed var(--border);
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.18s var(--ease-out);
}

.task-card-toggle:hover {
  color: var(--accent);
}

.task-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.task-children {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.task-children-title {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.task-child-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 24px;
  font-size: 11px;
  color: var(--text-2);
}

.task-child-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-child-status {
  color: var(--text-3);
}

.task-child-row.is-nested {
  padding-left: 18px;
  font-size: 10px;
}

.task-center-foot {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 11px;
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
