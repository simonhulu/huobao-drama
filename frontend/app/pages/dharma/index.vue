<template>
  <div class="dharma-page">
    <header class="page-head">
      <div class="page-identity">
        <span class="page-identity-icon" aria-hidden="true"><Flower2 :size="17" /></span>
        <div>
          <h1 class="page-title">佛学与哲学短片</h1>
          <p class="page-desc">Dharma Factory · 净稿 → Episode → 渲染</p>
        </div>
      </div>
      <div class="page-actions">
        <button class="btn btn-ghost btn-icon" type="button" title="刷新" aria-label="刷新" :disabled="loading" @click="refresh">
          <RefreshCw :size="16" :class="{ 'spin-once': loading }" />
        </button>
        <button class="btn btn-primary" type="button" title="新建剧集" @click="createOpen = true">
          <Plus :size="16" /> 新建剧集
        </button>
      </div>
    </header>

    <div v-if="error" class="notice-error" role="alert">
      <CircleX :size="16" />
      <span>{{ error }}</span>
    </div>

    <div v-if="loading && !loaded" class="loading-line">
      <LoaderCircle :size="17" class="spin" /> 正在读取剧集列表
    </div>

    <template v-else>
      <section class="production-tools card" aria-label="剧集概览与筛选">
        <div class="production-summary" aria-label="按状态筛选">
          <button
            v-for="stat in productionStats"
            :key="stat.label"
            type="button"
            class="summary-stat"
            :class="{ active: filterStatus === stat.status }"
            :aria-pressed="filterStatus === stat.status"
            @click="toggleStatusFilter(stat.status)"
          >
            <span class="stat-value">{{ stat.value }}</span>
            <span class="stat-label">{{ stat.label }}</span>
          </button>
        </div>
        <div class="filter-grid">
          <div class="filter-cell">
            <label class="filter-label">状态</label>
            <BaseSelect v-model="filterStatus" :options="statusOptions" placeholder="全部状态" :searchable="false" />
          </div>
          <div class="filter-cell search-cell">
            <label class="filter-label">搜索</label>
            <div class="search-input-wrap">
              <Search :size="14" class="search-icon" />
              <input v-model="filterQuery" class="input" placeholder="标题 / 描述" />
            </div>
          </div>
          <div class="filter-cell action-cell">
            <label class="filter-label sr-only">操作</label>
            <button class="btn btn-ghost btn-icon clear-filter" type="button" title="清除筛选" aria-label="清除筛选" :disabled="!hasFilters" @click="clearFilters">
              <FilterX :size="15" />
            </button>
          </div>
        </div>
      </section>

      <div v-if="!items.length" class="empty-state card">
        <Flower2 :size="30" aria-hidden="true" />
        <h2>没有匹配的佛学剧集</h2>
        <p>调整筛选条件，或创建第一集开始整理净稿与视觉素材。</p>
        <button v-if="!hasFilters" class="btn btn-primary" type="button" @click="createOpen = true"><Plus :size="16" /> 新建剧集</button>
      </div>

      <template v-else>
        <div class="table-wrap card">
          <table class="prod-table">
            <thead>
              <tr>
                <th class="col-title">标题</th>
                <th class="col-desc">描述</th>
                <th class="col-episodes">集数</th>
                <th class="col-status">状态</th>
                <th class="col-task">任务状态</th>
                <th class="col-publish">发布同步</th>
                <th class="col-date">创建时间</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="drama in items" :key="drama.id" class="prod-row">
                <td class="col-title">
                  <span class="truncate" :title="drama.title">{{ drama.title || '未命名剧集' }}</span>
                  <span class="drama-id mono">#{{ drama.id }}</span>
                </td>
                <td class="col-desc">
                  <span class="truncate" :title="drama.description">{{ drama.description || '等待导入净稿与生产素材' }}</span>
                </td>
                <td class="col-episodes">
                  <span class="episode-count"><Film :size="13" /> {{ (drama.episodes || []).length }}</span>
                  <span v-if="firstEpisodeId(drama)" class="episode-id mono">E#{{ firstEpisodeId(drama) }}</span>
                </td>
                <td class="col-status">
                  <span class="stage-pill" :class="stageOf(drama).kind">{{ stageOf(drama).label }}</span>
                </td>
                <td class="col-task">
                  <template v-if="taskStageOf(drama)">
                    <span class="stage-pill" :class="taskStageOf(drama).kind" :title="taskStageOf(drama).title">
                      {{ taskStageOf(drama).label }}
                    </span>
                    <span v-if="taskStageOf(drama).detail" class="task-detail truncate" :title="taskStageOf(drama).detail">
                      {{ taskStageOf(drama).detail }}
                    </span>
                  </template>
                  <span v-else class="task-none">—</span>
                </td>
                <td class="col-publish">
                  <div class="publish-checks">
                    <button
                      v-for="platform in publishPlatforms"
                      :key="platform.value"
                      type="button"
                      class="publish-check"
                      :class="{ done: publishStateOf(drama, platform.value).done }"
                      :aria-pressed="publishStateOf(drama, platform.value).done"
                      :title="publishStateOf(drama, platform.value).at ? `${platform.label} · ${publishStateOf(drama, platform.value).at}` : platform.label"
                      :disabled="publishSavingId === drama.id"
                      @click="togglePublish(drama, platform.value)"
                    >
                      <Check :size="11" />
                      {{ platform.label }}
                    </button>
                  </div>
                </td>
                <td class="col-date">
                  <span class="date-text">{{ formatDate(drama.created_at) }}</span>
                </td>
                <td class="col-actions">
                  <div class="action-group">
                    <NuxtLink v-if="firstEpisodeId(drama)" class="btn btn-sm btn-primary" :to="`/dharma/episode/${firstEpisodeId(drama)}`">
                      生产中心
                    </NuxtLink>
                    <span v-else class="pending-text">准备中</span>
                    <button class="btn btn-sm btn-ghost btn-danger" type="button" :disabled="deleting" @click="askDelete(drama)">
                      <Trash2 :size="13" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pagination-bar">
          <div class="page-range">{{ startIdx + 1 }} – {{ endIdx }} / {{ pagination.total }}</div>
          <div class="page-buttons">
            <button class="btn btn-sm" type="button" :disabled="page <= 1 || loading" @click="goPage(page - 1)">
              上一页
            </button>
            <button
              v-for="p in visiblePages"
              :key="p"
              type="button"
              class="btn btn-sm"
              :class="{ 'btn-primary': p === page }"
              :disabled="loading"
              @click="goPage(p)"
            >
              {{ p }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="page >= pagination.total_pages || loading" @click="goPage(page + 1)">
              下一页
            </button>
          </div>
        </div>
      </template>
    </template>

    <Teleport to="body">
      <div v-if="createOpen" class="modal-overlay" @click.self="closeCreate">
        <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <header class="modal-head">
            <div>
              <p class="modal-kicker">新建剧集</p>
              <h2 id="create-title">从净稿开始</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" title="关闭" :disabled="creating" @click="closeCreate"><X :size="16" /></button>
          </header>
          <label class="form-label">
            剧集标题
            <input v-model="createForm.title" type="text" placeholder="例如：金刚经在说什么" autocomplete="off" />
          </label>
          <label class="form-label">
            口播净稿
            <textarea v-model="createForm.script" rows="11" placeholder="粘贴已定稿的口播文稿"></textarea>
          </label>
          <fieldset class="speed-fieldset">
            <legend>旁白语速</legend>
            <div class="speed-control">
              <input v-model.number="createForm.narrationSpeed" type="range" min="0.8" max="2.5" step="0.05" aria-label="旁白语速" />
              <output>{{ Number(createForm.narrationSpeed).toFixed(2) }}x</output>
            </div>
            <p class="speed-note">默认 0.85x，给每一句话留出理解时间；创建后仍可在制作中心调整。</p>
          </fieldset>
          <fieldset v-if="imageStyles.length" class="style-fieldset">
            <legend>AI 图片默认风格</legend>
            <div class="style-picker" role="radiogroup" aria-label="AI 图片默认风格">
              <button
                v-for="style in imageStyles"
                :key="style.id"
                class="style-option"
                :class="{ active: createForm.style === style.id }"
                type="button"
                role="radio"
                :aria-checked="createForm.style === style.id"
                @click="createForm.style = style.id"
              >
                <img class="style-option-preview" :src="style.preview_url" alt="" />
                <strong>{{ style.name }}</strong>
                <span>{{ style.description }}</span>
              </button>
            </div>
          </fieldset>
          <p class="form-note">创建后会进入该剧集的生产中心。</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" :disabled="creating" @click="closeCreate">取消</button>
            <button class="btn btn-primary" type="button" :disabled="creating || !createForm.title.trim() || !createForm.script.trim()" @click="doCreate">
              <LoaderCircle v-if="creating" :size="16" class="spin" />
              <span v-else>创建并进入生产</span>
            </button>
          </div>
        </section>
      </div>

      <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
        <section class="modal-card modal-card-compact" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <header class="modal-head">
            <div>
              <p class="modal-kicker">不可恢复</p>
              <h2 id="delete-title">删除剧集？</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" title="关闭" :disabled="deleting" @click="deleteTarget = null"><X :size="16" /></button>
          </header>
          <p class="modal-copy">「{{ deleteTarget.title || '未命名剧集' }}」及其分镜和渲染产物将一并删除。</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" :disabled="deleting" @click="deleteTarget = null">取消</button>
            <button class="btn btn-danger" type="button" :disabled="deleting" @click="doDelete">
              <LoaderCircle v-if="deleting" :size="16" class="spin" />
              <span v-else>确认删除</span>
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, CircleX, Film, FilterX, Flower2, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import { dharmaAPI, dramaAPI, taskAPI } from '~/composables/useApi'

const PAGE_SIZE = 20

const items = ref([])
const pagination = ref({ page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0 })
const page = ref(1)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const createOpen = ref(false)
const creating = ref(false)
const createForm = ref({ title: '', script: '', style: '', narrationSpeed: 0.85 })
const deleteTarget = ref(null)
const deleting = ref(false)
const imageStyles = ref([])
const tasks = ref([])
const publishSavingId = ref(null)

const publishPlatforms = [
  { label: '抖音', value: 'douyin' },
  { label: '视频号', value: 'wechat' },
  { label: '小红书', value: 'xiaohongshu' },
]

function publishStateOf(drama, platform) {
  const entry = drama.publish_sync?.[platform]
  if (!entry) return { done: false, at: null }
  if (typeof entry === 'boolean') return { done: entry, at: null }
  return { done: !!entry.done, at: entry.at || null }
}

async function togglePublish(drama, platform) {
  if (publishSavingId.value === drama.id) return
  const prev = drama.publish_sync || {}
  const nextDone = !publishStateOf(drama, platform).done
  const next = {
    ...prev,
    [platform]: { done: nextDone, at: nextDone ? new Date().toISOString() : null },
  }
  drama.publish_sync = next
  publishSavingId.value = drama.id
  try {
    await dramaAPI.update(drama.id, { publish_sync: next })
  } catch (err) {
    drama.publish_sync = prev
    error.value = err?.message || '更新发布状态失败'
  } finally {
    publishSavingId.value = null
  }
}

const filterStatus = ref('')
const filterQuery = ref('')

const statusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '生产中', value: 'processing' },
  { label: '已完成', value: 'completed' },
  { label: '已发布', value: 'published' },
]

const hasFilters = computed(() => filterStatus.value || filterQuery.value.trim())

const statusCounts = computed(() => {
  const counts = { draft: 0, processing: 0, completed: 0, published: 0 }
  for (const item of items.value) {
    const key = item.status || 'draft'
    if (counts[key] !== undefined) counts[key]++
  }
  return counts
})

const productionStats = computed(() => [
  { label: '总剧集', value: pagination.value.total, status: '' },
  { label: '草稿', value: statusCounts.value.draft, status: 'draft' },
  { label: '生产中', value: statusCounts.value.processing, status: 'processing' },
  { label: '已完成', value: statusCounts.value.completed, status: 'completed' },
])

const totalPages = computed(() => Math.max(1, pagination.value.total_pages || 1))
const startIdx = computed(() => (page.value - 1) * PAGE_SIZE)
const endIdx = computed(() => Math.min(startIdx.value + items.value.length, pagination.value.total))

const visiblePages = computed(() => {
  const pages = []
  const maxVisible = 7
  let start = Math.max(1, page.value - Math.floor(maxVisible / 2))
  let end = Math.min(totalPages.value, start + maxVisible - 1)
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1)
  }
  for (let i = start; i <= end; i++) pages.push(i)
  return pages
})

function stageOf(drama) {
  switch (drama.status) {
    case 'completed':
      return { kind: 'done', label: '已完成' }
    case 'published':
      return { kind: 'ready', label: '已发布' }
    case 'processing':
    case 'running':
      return { kind: 'working', label: '生产中' }
    default:
      return { kind: 'pending', label: '草稿' }
  }
}

const taskTypeLabels = {
  'dharma.episode_render': '渲染',
  'dharma.footage_generate': '素材',
}

const tasksByDrama = computed(() => {
  const map = new Map()
  for (const task of tasks.value) {
    if (task.drama_id == null) continue
    if (!map.has(task.drama_id)) map.set(task.drama_id, [])
    map.get(task.drama_id).push(task)
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.id - a.id)
  }
  return map
})

function taskStageOf(drama) {
  const list = tasksByDrama.value.get(drama.id)
  if (!list || !list.length) return null
  const running = list.find((task) => task.status === 'running')
  const queued = list.find((task) => task.status === 'queued')
  const task = running || queued || list[0]
  const typeLabel = taskTypeLabels[task.type] || '任务'
  let progress = ''
  if (task.status === 'running' && task.progress_total > 0) {
    progress = ` ${task.progress_current}/${task.progress_total}`
  }
  const detail = task.progress_message || ''
  switch (task.status) {
    case 'running':
      return { kind: 'working', label: `运行中 · ${typeLabel}${progress}`, title: detail, detail }
    case 'queued':
      return { kind: 'queued', label: `排队中 · ${typeLabel}${task.queue_position ? ` #${task.queue_position}` : ''}`, title: detail, detail: '' }
    case 'succeeded':
      return { kind: 'ready', label: `成功 · ${typeLabel}`, title: '', detail: '' }
    case 'failed':
      return { kind: 'failed', label: `失败 · ${typeLabel}`, title: detail, detail }
    case 'canceled':
      return { kind: 'canceled', label: `已取消 · ${typeLabel}`, title: detail, detail: '' }
    case 'stale':
      return { kind: 'stale', label: `停滞 · ${typeLabel}`, title: detail, detail: '' }
    default:
      return { kind: 'pending', label: `${task.status} · ${typeLabel}`, title: detail, detail: '' }
  }
}

function toggleStatusFilter(status) {
  filterStatus.value = status && filterStatus.value === status ? '' : status
}

function clearFilters() {
  filterStatus.value = ''
  filterQuery.value = ''
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function firstEpisodeId(drama) {
  const episodes = drama.episodes || []
  return episodes.length ? episodes[0].id : null
}

function closeCreate() {
  if (!creating.value) createOpen.value = false
}

async function loadTasks() {
  try {
    const res = await taskAPI.list()
    tasks.value = Array.isArray(res) ? res : (res?.items ?? [])
  } catch {
    // Task status is auxiliary; leave the previous snapshot in place on failure.
  }
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const [res] = await Promise.all([
      dramaAPI.list({
        page: page.value,
        page_size: PAGE_SIZE,
        genre: 'dharma',
        status: filterStatus.value || undefined,
        keyword: filterQuery.value.trim() || undefined,
      }),
      loadTasks(),
    ])
    items.value = res.items || []
    if (res.pagination) pagination.value = res.pagination
    loaded.value = true
  } catch (err) {
    error.value = err?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadImageStyles() {
  try {
    const response = await dharmaAPI.imageStyles()
    imageStyles.value = Array.isArray(response?.items)
      ? response.items.filter(style => style?.production === true)
      : []
    if (response?.default_style_id && !imageStyles.value.some((style) => style.id === createForm.value.style)) {
      createForm.value.style = response.default_style_id
    }
  } catch {
    // The built-in default remains usable while the catalog is unavailable.
  }
}

function goPage(nextPage) {
  if (nextPage < 1 || (totalPages.value && nextPage > totalPages.value)) return
  page.value = nextPage
  refresh()
}

async function doCreate() {
  creating.value = true
  error.value = ''
  try {
    const title = createForm.value.title.trim()
    const drama = await dramaAPI.create({
      title,
      genre: 'dharma',
      ...(createForm.value.style ? { style: createForm.value.style } : {}),
      total_episodes: 0,
    })
    const result = await dramaAPI.importScript(drama.id, {
      script_content: createForm.value.script.trim(),
      title,
      clean: false,
      narration_speed: Number(createForm.value.narrationSpeed),
    })
    let episodeId = result?.episodes?.[0]?.id
    if (!episodeId) {
      const detail = await dramaAPI.get(drama.id)
      episodeId = detail?.episodes?.[0]?.id
    }
    if (!episodeId) throw new Error('导入成功但未找到剧集 ID')
    await navigateTo(`/dharma/episode/${episodeId}`)
  } catch (err) {
    error.value = err?.message || '创建失败'
  } finally {
    creating.value = false
  }
}

function askDelete(drama) {
  deleteTarget.value = drama
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  error.value = ''
  try {
    await dramaAPI.del(deleteTarget.value.id)
    deleteTarget.value = null
    if (items.value.length === 1 && page.value > 1) page.value -= 1
    await refresh()
  } catch (err) {
    error.value = err?.message || '删除失败'
  } finally {
    deleting.value = false
  }
}

let filterTimer = null
watch([filterStatus, filterQuery], () => {
  page.value = 1
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => refresh(), 250)
})

let taskPollTimer = null
onMounted(() => {
  refresh()
  loadImageStyles()
  taskPollTimer = setInterval(() => {
    if (!document.hidden) loadTasks()
  }, 10000)
})

onUnmounted(() => {
  if (taskPollTimer) clearInterval(taskPollTimer)
  if (filterTimer) clearTimeout(filterTimer)
})
</script>

<style scoped>
.dharma-page {
  height: 100%;
  overflow-x: clip;
  overflow-y: auto;
  padding: 16px 20px 32px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 40px;
  margin-bottom: 12px;
}
.page-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.page-identity-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-1);
  color: var(--accent-text);
}
.page-title {
  min-width: 0;
  margin: 0;
  font-size: 20px;
  letter-spacing: 0;
  line-height: 1.15;
  overflow-wrap: anywhere;
}
.page-desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-2);
}
.page-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.notice-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--error);
  border-radius: 8px;
  color: var(--error);
  font-size: 13px;
  margin-bottom: 12px;
}
.loading-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
  padding: 32px 0;
  justify-content: center;
}
.spin { animation: dharma-spin 1s linear infinite; }
.spin-once { animation: dharma-spin 0.8s linear 1; }
@keyframes dharma-spin { to { transform: rotate(360deg); } }

/* Summary + filters */
.production-tools {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(420px, 1.4fr);
  align-items: stretch;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px;
  border-radius: 8px;
}
.production-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-1);
}
.summary-stat {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 0;
  min-width: 0;
  min-height: 52px;
  padding: 4px 8px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out), transform 100ms var(--ease-out);
}
.summary-stat:last-child { border-right: 0; }
.summary-stat.active { background: var(--accent-bg); color: var(--accent-text); }
.summary-stat:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.summary-stat:active { transform: translateY(1px); }
@media (hover: hover) and (pointer: fine) {
  .summary-stat:hover { background: var(--bg-hover); }
}
.stat-value {
  color: var(--text-0);
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.stat-label {
  overflow: hidden;
  max-width: 100%;
  color: var(--text-2);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary-stat.active .stat-value,
.summary-stat.active .stat-label { color: var(--accent-text); }
.filter-grid {
  display: grid;
  grid-template-columns: 140px minmax(180px, 1fr) 36px;
  align-items: end;
  gap: 8px;
  min-width: 0;
}
.filter-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.filter-label { font-size: 10px; font-weight: 600; color: var(--text-2); letter-spacing: 0; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.search-input-wrap { position: relative; }
.search-input-wrap .input { padding-left: 30px; }
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.action-cell { justify-content: flex-end; }
.clear-filter { width: 36px; height: 36px; }

/* Empty */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 44px 20px;
  border-radius: 8px;
  text-align: center;
  color: var(--text-2);
}
.empty-state h2 { font-size: 16px; margin: 0; color: var(--text-1); }
.empty-state p { font-size: 13px; margin: 0; }
.empty-state .btn { margin-top: 8px; }

/* Table */
.table-wrap { overflow-x: auto; border-radius: 8px; }
.prod-table {
  width: 100%;
  min-width: 860px;
  border-collapse: collapse;
  font-size: 13px;
}
.prod-table .col-actions {
  position: sticky;
  right: 0;
  background: var(--bg-0);
  box-shadow: -8px 0 12px -8px rgba(50, 74, 114, 0.25);
}
.prod-table th,
.prod-table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.prod-table th {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0;
  background: var(--bg-1);
  white-space: nowrap;
}
.prod-table tbody tr:last-child td { border-bottom: none; }
.prod-row:hover td { background: var(--bg-hover); }
.col-title { min-width: 200px; max-width: 280px; }
.col-desc { min-width: 160px; max-width: 320px; }
.col-episodes { width: 72px; text-align: center; }
.col-status { width: 100px; }
.col-task { width: 170px; }
.col-publish { width: 190px; }
.col-date { width: 120px; }
.col-actions { width: 150px; text-align: right; white-space: nowrap; }
.truncate {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-desc .truncate { color: var(--text-2); font-size: 12px; }
.drama-id { display: block; margin-top: 2px; font-size: 10px; color: var(--text-3); }
.episode-count { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
.episode-id { display: block; margin-top: 2px; font-size: 10px; color: var(--text-3); }
.stage-pill {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  white-space: nowrap;
}
.stage-pill.working { background: var(--info-bg); color: var(--info); }
.stage-pill.ready { background: var(--success-bg); color: var(--success); }
.stage-pill.pending { background: var(--bg-2); color: var(--text-3); }
.stage-pill.done { background: var(--accent-bg); color: var(--accent-text); }
.stage-pill.queued { background: var(--warning-bg); color: var(--warning); }
.stage-pill.failed { background: var(--error-bg); color: var(--error); }
.stage-pill.canceled,
.stage-pill.stale { background: var(--bg-2); color: var(--text-2); }
.date-text { color: var(--text-2); font-variant-numeric: tabular-nums; }
.task-detail { display: block; margin-top: 3px; max-width: 170px; color: var(--text-3); font-size: 10px; }
.task-none { color: var(--text-3); }
.publish-checks { display: inline-flex; gap: 5px; flex-wrap: wrap; }
.publish-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-1);
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out), color 150ms var(--ease-out);
}
.publish-check svg { opacity: 0; }
.publish-check:hover { border-color: var(--border-strong); color: var(--text-1); }
.publish-check:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.publish-check:disabled { opacity: 0.6; cursor: wait; }
.publish-check.done {
  border-color: var(--success);
  background: var(--success-bg);
  color: var(--success);
}
.publish-check.done svg { opacity: 1; }
.pending-text { color: var(--text-3); font-size: 12px; }
.action-group { display: inline-flex; gap: 6px; justify-content: flex-end; }
.action-group .btn { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.btn-danger { color: var(--error); border-color: var(--error); background: transparent; }
.btn-danger:hover { background: var(--error); color: #fff; }

/* Pagination */
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding: 0 2px;
}
.page-range { font-size: 13px; color: var(--text-3); }
.page-buttons { display: inline-flex; gap: 5px; }
.page-buttons .btn { min-width: 32px; }

/* Modals */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(9, 9, 11, .4);
  backdrop-filter: blur(3px);
}
.modal-card {
  width: min(600px, 100%);
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px;
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
}
.modal-card-compact { width: min(400px, 100%); }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.modal-head h2 { font-family: var(--font-body); font-size: 16px; font-weight: 600; letter-spacing: 0; margin-top: 2px; }
.modal-kicker { color: var(--text-3); font-size: 12px; font-weight: 600; letter-spacing: 0; line-height: 1.25; }
.form-label { display: flex; flex-direction: column; gap: 7px; color: var(--text-2); font-size: 12px; font-weight: 500; }
.form-label input, .form-label textarea { width: 100%; padding: 9px 11px; color: var(--text-0); font: inherit; line-height: 1.6; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); outline: none; resize: vertical; }
.form-label input:focus, .form-label textarea:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-glow); }
.style-fieldset, .speed-fieldset { min-width: 0; padding: 0; margin: 0; border: 0; }
.style-fieldset legend, .speed-fieldset legend { padding: 0; margin-bottom: 7px; color: var(--text-2); font-size: 12px; font-weight: 500; }
.speed-control { display: grid; grid-template-columns: minmax(0, 1fr) 58px; align-items: center; gap: 12px; }
.speed-control input[type='range'] { width: 100%; accent-color: var(--accent); }
.speed-control output { min-height: 34px; display: grid; place-items: center; color: var(--text-0); background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; font-variant-numeric: tabular-nums; }
.speed-note { margin: 7px 0 0; color: var(--text-3); font-size: 11px; line-height: 1.5; }
.style-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.style-option { min-width: 0; padding: 8px; color: var(--text-2); text-align: left; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.style-option:hover, .style-option:focus-visible { border-color: var(--border-strong); background: var(--bg-2); outline: none; }
.style-option.active { color: var(--text-0); border-color: var(--border-focus); background: var(--accent-bg); box-shadow: 0 0 0 2px var(--accent-glow); }
.style-option-preview { display: block; width: 100%; aspect-ratio: 16 / 9; margin-bottom: 9px; object-fit: cover; border-radius: calc(var(--radius-sm) - 1px); background: var(--bg-2); }
.style-option strong, .style-option span { display: block; }
.style-option strong { font-size: 12px; font-weight: 600; line-height: 1.35; }
.style-option span { margin-top: 3px; color: var(--text-3); font-size: 11px; line-height: 1.45; }
.form-note, .modal-copy { color: var(--text-2); font-size: 12px; line-height: 1.7; }
.modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.modal-actions .btn-danger { color: #fff; background: var(--error); border-color: var(--error); }
.modal-actions .btn-danger:hover { color: #fff; background: #b91c1c; border-color: #b91c1c; }

@media (max-width: 900px) {
  .production-tools { grid-template-columns: 1fr; gap: 8px; }
}
@media (max-width: 760px) {
  .dharma-page { padding: 12px 12px 28px; }
  .page-head { margin-bottom: 8px; }
  .page-actions .btn-primary { width: 38px; padding: 0; font-size: 0; }
  .page-actions .btn-primary :deep(svg) { margin: 0; }
  .filter-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .search-cell { grid-column: span 2; }
  .action-cell { grid-column: span 2; align-items: flex-end; }
  .prod-table .col-desc,
  .prod-table .col-date { display: none; }
  .pagination-bar { flex-wrap: wrap; gap: 8px; }
  .style-picker { grid-template-columns: minmax(0, 1fr); }
}
@media (pointer: coarse) {
  .summary-stat, .clear-filter { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .summary-stat { transition-duration: 1ms; }
  .spin, .spin-once { animation-duration: 1ms; animation-iteration-count: 1; }
}
</style>
