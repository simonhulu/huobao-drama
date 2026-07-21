<template>
  <div class="remotion-page">
    <header class="page-head">
      <div class="page-identity">
        <span class="page-identity-icon" aria-hidden="true"><Film :size="17" /></span>
        <div>
        <h1 class="page-title">镜头生产</h1>
          <p class="page-desc">Remotion History Factory · 账号 → 项目 → Episode</p>
        </div>
      </div>
      <button class="btn btn-ghost btn-icon" type="button" title="刷新" aria-label="刷新" :disabled="loading" @click="refresh">
        <RefreshCw :size="16" :class="{ 'spin-once': loading }" />
      </button>
    </header>

    <div v-if="error" class="notice-error">
      <CircleX :size="16" />
      <span>{{ error }}</span>
    </div>

    <div v-if="loading && !loaded" class="loading-line">
      <LoaderCircle :size="17" class="spin" /> 正在读取生产状态
    </div>

    <template v-else>
      <section class="style-console" aria-labelledby="style-preview-title">
        <div class="style-console-head">
          <div class="style-heading">
            <span class="style-heading-icon" aria-hidden="true"><Palette :size="16" /></span>
            <div>
              <h2 id="style-preview-title">画面风格库</h2>
              <p>Episode 564 样片 · 当前选择 <strong>{{ selectedStyle.name }}</strong></p>
            </div>
          </div>
          <div class="style-head-actions">
            <span class="style-unity"><CheckCircle2 :size="14" /> 项目级统一</span>
            <div class="style-mode-tabs" role="tablist" aria-label="风格查看模式" @keydown="onStyleModeKeydown">
              <button
                id="style-preview-tab"
                type="button"
                class="style-mode"
                :class="{ active: styleMode === 'preview' }"
                :aria-selected="styleMode === 'preview'"
                :tabindex="styleMode === 'preview' ? 0 : -1"
                role="tab"
                @click="setStyleMode('preview')"
              >
                <Eye :size="14" /> 预览
              </button>
              <button
                id="style-compare-tab"
                type="button"
                class="style-mode"
                :class="{ active: styleMode === 'compare' }"
                :aria-selected="styleMode === 'compare'"
                :tabindex="styleMode === 'compare' ? 0 : -1"
                role="tab"
                @click="setStyleMode('compare')"
              >
                <LayoutGrid :size="14" /> 对比
              </button>
            </div>
          </div>
        </div>

        <div class="style-console-body">
          <nav class="style-rail" aria-label="选择画面风格">
            <div class="style-rail-head">
              <span>风格目录</span>
              <span>{{ stylePilots.length }}</span>
            </div>
            <button
              v-for="(style, index) in stylePilots"
              :key="style.id"
              type="button"
              class="rail-style"
              :class="{ active: style.id === selectedStyleId }"
              :aria-pressed="style.id === selectedStyleId"
              @click="selectStyle(style.id)"
              @keydown="onStyleRailKeydown($event, index)"
            >
              <span class="rail-index">{{ pad2(index + 1) }}</span>
              <span class="rail-copy">
                <strong>{{ style.name }}</strong>
                <span>{{ style.mood }} · {{ style.lens }}</span>
              </span>
              <CheckCircle2 v-if="style.id === selectedStyleId" :size="15" />
            </button>
          </nav>

          <div
            v-if="styleMode === 'preview'"
            class="style-preview-pane"
            role="tabpanel"
            aria-labelledby="style-preview-tab"
          >
            <figure class="preview-video-panel">
              <figcaption class="screen-toolbar">
                <div>
                  <span class="screen-label">当前预览</span>
                  <strong>{{ selectedStyle.name }}</strong>
                </div>
                <a class="btn btn-sm btn-ghost screen-open" :href="selectedStyle.url" target="_blank" rel="noreferrer">
                  <ExternalLink :size="13" /> 打开视频
                </a>
              </figcaption>
              <div class="video-shell">
                <video
                  :key="selectedStyle.id"
                  class="style-video"
                  :src="selectedStyle.url"
                  controls
                  preload="metadata"
                  playsinline
                />
              </div>
            </figure>

            <aside class="style-inspector" aria-label="当前风格信息">
              <div class="inspector-title">
                <span class="inspector-kicker">风格档案</span>
                <h3>{{ selectedStyle.name }}</h3>
                <p>{{ selectedStyle.desc }}</p>
              </div>
              <dl class="style-facts">
                <div>
                  <dt>样片</dt>
                  <dd>60s · 12镜 · 720p</dd>
                </div>
                <div>
                  <dt>审查</dt>
                  <dd>12/12 通过</dd>
                </div>
                <div>
                  <dt>镜头策略</dt>
                  <dd>{{ selectedStyle.profile }}</dd>
                </div>
              </dl>
              <div class="project-style-state" aria-live="polite">
                <CheckCircle2 :size="16" />
                <span>
                  <strong>已选为项目风格</strong>
                  <small>后续镜头统一继承此档案</small>
                </span>
              </div>
            </aside>
          </div>

          <div v-else class="style-compare-pane" role="tabpanel" aria-labelledby="style-compare-tab">
            <button
              v-for="(style, index) in stylePilots"
              :key="style.id"
              type="button"
              class="compare-style"
              :class="{ active: style.id === selectedStyleId }"
              :aria-pressed="style.id === selectedStyleId"
              @click="selectStyle(style.id)"
              @mouseenter="playPilotPreview"
              @mouseleave="pausePilotPreview"
              @focus="playPilotPreview"
              @blur="pausePilotPreview"
            >
              <span class="compare-media">
                <video :src="style.url" muted loop playsinline preload="metadata" @loadedmetadata="primePilotFrame" />
                <span class="compare-index">{{ pad2(index + 1) }}</span>
                <span v-if="style.id === selectedStyleId" class="compare-check"><CheckCircle2 :size="15" /></span>
              </span>
              <span class="compare-copy">
                <strong>{{ style.name }}</strong>
                <small>{{ style.mood }} · {{ style.lens }}</small>
              </span>
            </button>
          </div>
        </div>
      </section>

      <section class="production-tools card" aria-label="生产概览与筛选">
        <div class="production-summary" aria-label="按生产状态筛选">
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
            <label class="filter-label">账号</label>
            <BaseSelect v-model="filterAccountId" :options="accountOptions" placeholder="全部账号" :searchable="true" />
          </div>
          <div class="filter-cell">
            <label class="filter-label">项目</label>
            <BaseSelect v-model="filterDramaId" :options="dramaOptions" placeholder="全部项目" :searchable="true" />
          </div>
          <div class="filter-cell">
            <label class="filter-label">状态</label>
            <BaseSelect v-model="filterStatus" :options="statusOptions" placeholder="全部状态" :searchable="false" />
          </div>
          <div class="filter-cell search-cell">
            <label class="filter-label">搜索</label>
            <div class="search-input-wrap">
              <Search :size="14" class="search-icon" />
              <input v-model="filterQuery" class="input" placeholder="标题 / 项目 / 集数" />
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

      <!-- Table -->
      <div v-if="!items.length" class="empty-state card">
        <Layers3 :size="30" />
        <h2>没有匹配的生产记录</h2>
        <p>调整筛选条件，或先在 Drama 项目下创建 Episode 并完成拆镜。</p>
      </div>

      <template v-else>
        <div class="table-wrap card">
          <table class="prod-table">
            <thead>
              <tr>
                <th class="col-account">账号</th>
                <th class="col-drama">项目</th>
                <th class="col-ep">集</th>
                <th class="col-title">标题</th>
                <th class="col-status">状态</th>
                <th class="col-shots">分镜</th>
                <th class="col-review">三审</th>
                <th class="col-render">渲染时间</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="item.episode_id" class="prod-row">
                <td class="col-account">
                  <div class="cell-account">
                    <UserRound :size="13" />
                    <span class="truncate">{{ item.account_name || '未设置账号' }}</span>
                  </div>
                </td>
                <td class="col-drama">
                  <span class="truncate">{{ item.drama_title }}</span>
                </td>
                <td class="col-ep">
                  <span class="ep-code">E{{ pad2(item.episode_number) }}</span>
                </td>
                <td class="col-title">
                  <span class="truncate" :title="item.title">{{ item.title }}</span>
                </td>
                <td class="col-status">
                  <span class="stage-pill" :class="stageOf(item).kind">{{ stageOf(item).label }}</span>
                </td>
                <td class="col-shots">
                  <span v-if="item.cells_ready > 0 && item.cells_ready < item.shot_count" class="mono">{{ item.cells_ready }}/{{ item.shot_count }}</span>
                  <span v-else class="mono">{{ item.shot_count }}</span>
                </td>
                <td class="col-review">
                  <span v-if="item.review_total" :class="['review-text', item.review_passed === item.review_total ? 'review-pass' : '']">
                    {{ item.review_passed }}/{{ item.review_total }}
                  </span>
                  <span v-else class="review-none">—</span>
                </td>
                <td class="col-render">
                  <span v-if="item.has_render && item.render_at" class="render-time">{{ fmtTime(item.render_at) }}</span>
                  <span v-else class="render-none">—</span>
                </td>
                <td class="col-actions">
                  <div class="action-group">
                    <a v-if="item.has_render && item.render_url" class="btn btn-sm btn-primary" :href="item.render_url" target="_blank">
                      <Play :size="13" /> 播放
                    </a>
                    <a class="btn btn-sm btn-ghost" :href="episodeUrl(item)">
                      {{ item.has_render ? '分镜' : '去生产' }}
                    </a>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div class="pagination-bar">
          <div class="page-size">
            <span>每页</span>
            <BaseSelect v-model="pageSize" :options="pageSizeOptions" :searchable="false" />
            <span>条</span>
          </div>
          <div class="page-range">{{ startIdx + 1 }} – {{ endIdx }} / {{ total }}</div>
          <div class="page-buttons">
            <button class="btn btn-sm" type="button" :disabled="currentPage <= 1" @click="currentPage--">
              上一页
            </button>
            <button
              v-for="p in visiblePages"
              :key="p"
              type="button"
              class="btn btn-sm"
              :class="{ 'btn-primary': p === currentPage }"
              @click="currentPage = p"
            >
              {{ p }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="currentPage >= totalPages" @click="currentPage++">
              下一页
            </button>
          </div>
        </div>
      </template>

      <!-- Legacy records -->
      <details v-if="legacyItems.length" class="legacy-block">
        <summary>
          旧版生产记录
          <span class="count-badge">{{ legacyItems.length }}</span>
        </summary>
        <div class="legacy-table-wrap">
          <table class="legacy-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in legacyItems" :key="p.id">
                <td>{{ p.title }}</td>
                <td><span class="stage-pill pending">{{ p.status }}</span></td>
                <td class="mono">{{ fmtTime(p.updated_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { CheckCircle2, CircleX, ExternalLink, Eye, Film, FilterX, Layers3, LayoutGrid, LoaderCircle, Palette, Play, RefreshCw, Search, UserRound } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import { gridEpisodeAPI, remotionAPI } from '~/composables/useApi'

interface ProductionItem {
  episode_id: number
  drama_id: number
  drama_title: string
  account_id: number | null
  account_name: string | null
  episode_number: number
  title: string
  shot_count: number
  cells_ready: number
  review_passed: number | null
  review_total: number | null
  has_render: boolean
  render_url: string | null
  render_at: string | null
  updated_at: string
  status: string
}

const items = ref<ProductionItem[]>([])
const total = ref(0)
const legacyItems = ref<any[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

const currentPage = ref(1)
const pageSize = ref(20)
const filterAccountId = ref<number | string>('')
const filterDramaId = ref<number | string>('')
const filterStatus = ref('')
const filterQuery = ref('')
const selectedStyleId = ref('republican-shanghai')
const styleMode = ref<'preview' | 'compare'>('preview')
const PILOT_PREVIEW_TIME = 1

const PAGE_SIZE_OPTIONS = [10, 20, 50]
const statusOptions = [
  { label: '已渲染', value: 'done' },
  { label: '待渲染', value: 'ready' },
  { label: '生产中', value: 'working' },
  { label: '已拆镜', value: 'pending' },
]
const pageSizeOptions = PAGE_SIZE_OPTIONS.map((n) => ({ label: String(n), value: n }))
const stylePilots = [
  {
    id: 'republican-shanghai',
    name: '民国上海复古',
    desc: '端正、精致、旧时代都市感。',
    mood: '都市',
    lens: '50mm',
    profile: '正面调度、暖人物与冷环境对比',
    url: '/static/remotion/grid-story-ep564-pilot-60s-republican-shanghai.mp4',
  },
  {
    id: 'northwest-epic',
    name: '西北乡土史诗',
    desc: '粗粝、开阔、土地史诗感。',
    mood: '土地',
    lens: '低机位',
    profile: '低角度自然光、粗粝材料和大地尺度',
    url: '/static/remotion/grid-story-ep564-pilot-60s-northwest-epic.mp4',
  },
  {
    id: 'studio-wuxia',
    name: '邵氏棚拍武侠',
    desc: '旧彩、舞台化、强烈棚拍感。',
    mood: '棚拍',
    lens: '硬光',
    profile: '三层布景、正面硬光和顶部轮廓光',
    url: '/static/remotion/grid-story-ep564-pilot-60s-studio-wuxia.mp4',
  },
  {
    id: 'location-kungfu',
    name: '七十年代实景功夫',
    desc: '外景、日光、老港片实拍感。',
    mood: '实景',
    lens: '变焦',
    profile: '全身调度、直射日光和轻微手持',
    url: '/static/remotion/grid-story-ep564-pilot-60s-location-kungfu.mp4',
  },
  {
    id: 'ink-wuxia',
    name: '东方水墨武侠',
    desc: '留白、雾感、低饱和诗意。',
    mood: '留白',
    lens: '长焦',
    profile: '长焦压缩、雾白层次和低饱和真人画面',
    url: '/static/remotion/grid-story-ep564-pilot-60s-ink-wuxia.mp4',
  },
  {
    id: 'old-color-wuxia',
    name: '旧彩浪漫武侠',
    desc: '柔光、旧胶片、浪漫色偏。',
    mood: '旧彩',
    lens: '球面',
    profile: '柔和高光辉光、舞台化前中后景',
    url: '/static/remotion/grid-story-ep564-pilot-60s-old-color-wuxia.mp4',
  },
  {
    id: 'guofeng-editorial',
    name: '古风暗场时尚',
    desc: '暗调、遮挡、编辑大片感。',
    mood: '暗场',
    lens: '遮挡',
    profile: '真实前景遮挡、局部高光扩散',
    url: '/static/remotion/grid-story-ep564-pilot-60s-guofeng-editorial.mp4',
  },
  {
    id: 'night-flash-snapshot',
    name: '夜街直闪快照',
    desc: '直闪、颗粒、抓拍瞬间感。',
    mood: '夜街',
    lens: '直闪',
    profile: '近距离直闪、强颗粒和现场抓拍',
    url: '/static/remotion/grid-story-ep564-pilot-60s-night-flash-snapshot.mp4',
  },
  {
    id: 'commercial-teal-orange',
    name: '现代青橙商业',
    desc: '冷暖分离、干净、商业预告片感。',
    mood: '商业',
    lens: '青橙',
    profile: '冷暖分离、干净肤色和预告片节奏',
    url: '/static/remotion/grid-story-ep564-pilot-60s-commercial-teal-orange.mp4',
  },
]

const allItems = computed(() => items.value)
const selectedStyle = computed(() => stylePilots.find((style) => style.id === selectedStyleId.value) ?? stylePilots[0])

const accountOptions = computed(() => {
  const map = new Map<number | null, string>()
  for (const item of allItems.value) {
    map.set(item.account_id, item.account_name || '未设置账号')
  }
  return [...map.entries()]
    .filter(([id]) => id !== null)
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

const dramaOptions = computed(() => {
  const map = new Map<number, string>()
  for (const item of allItems.value) {
    map.set(item.drama_id, item.drama_title)
  }
  return [...map.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

const hasFilters = computed(() => filterAccountId.value || filterDramaId.value || filterStatus.value || filterQuery.value.trim())

const statusCounts = computed(() => {
  const counts = { done: 0, ready: 0, working: 0, pending: 0 }
  for (const item of allItems.value) {
    if (counts[item.status as keyof typeof counts] !== undefined) counts[item.status as keyof typeof counts]++
  }
  return counts
})

const doneCount = computed(() => statusCounts.value.done)
const readyCount = computed(() => statusCounts.value.ready)
const workingCount = computed(() => statusCounts.value.working)
const productionStats = computed(() => [
  { label: '总集数', value: total.value, status: '' },
  { label: '已渲染', value: doneCount.value, status: 'done' },
  { label: '生产中', value: workingCount.value, status: 'working' },
  { label: '待渲染', value: readyCount.value, status: 'ready' },
])

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const startIdx = computed(() => (currentPage.value - 1) * pageSize.value)
const endIdx = computed(() => Math.min(startIdx.value + pageSize.value, total.value))

const visiblePages = computed(() => {
  const pages: number[] = []
  const maxVisible = 7
  let start = Math.max(1, currentPage.value - Math.floor(maxVisible / 2))
  let end = Math.min(totalPages.value, start + maxVisible - 1)
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1)
  }
  for (let i = start; i <= end; i++) pages.push(i)
  return pages
})

function episodeUrl(item: ProductionItem) {
  return `/drama/${item.drama_id}/episode/${item.episode_number}`
}

function stageOf(item: ProductionItem) {
  if (item.has_render) {
    return { kind: 'done', label: '已渲染' }
  }
  if (item.cells_ready > 0 && item.cells_ready < item.shot_count) {
    return { kind: 'working', label: `单图 ${item.cells_ready}/${item.shot_count}` }
  }
  if (item.cells_ready > 0 && item.cells_ready >= item.shot_count) {
    return { kind: 'ready', label: '待渲染' }
  }
  return { kind: 'pending', label: `已拆镜 ${item.shot_count} 镜` }
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function selectStyle(styleId: string) {
  selectedStyleId.value = styleId
}

function setStyleMode(mode: 'preview' | 'compare') {
  styleMode.value = mode
}

function onStyleModeKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const nextMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'preview' : 'compare'
  setStyleMode(nextMode)
  nextTick(() => {
    document.getElementById(`style-${nextMode}-tab`)?.focus({ preventScroll: true })
  })
}

function onStyleRailKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const lastIndex = stylePilots.length - 1
  let nextIndex = index
  if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = lastIndex
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = index <= 0 ? lastIndex : index - 1
  else nextIndex = index >= lastIndex ? 0 : index + 1

  selectStyle(stylePilots[nextIndex].id)
  nextTick(() => {
    const rail = (event.currentTarget as HTMLElement).parentElement
    const options = rail?.querySelectorAll<HTMLButtonElement>('.rail-style')
    options?.[nextIndex]?.focus({ preventScroll: true })
    options?.[nextIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

function playPilotPreview(event: Event) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const video = (event.currentTarget as HTMLElement).querySelector<HTMLVideoElement>('video')
  void video?.play().catch(() => undefined)
}

function primePilotFrame(event: Event) {
  const video = event.currentTarget as HTMLVideoElement
  if (!Number.isFinite(video.duration)) return
  video.currentTime = Math.min(PILOT_PREVIEW_TIME, Math.max(0, video.duration - 0.1))
}

function pausePilotPreview(event: Event) {
  const video = (event.currentTarget as HTMLElement).querySelector<HTMLVideoElement>('video')
  if (!video) return
  video.pause()
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    video.currentTime = Math.min(PILOT_PREVIEW_TIME, Math.max(0, video.duration - 0.1))
  }
}

function toggleStatusFilter(status: string) {
  filterStatus.value = status && filterStatus.value === status ? '' : status
}

function fmtTime(value: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function clearFilters() {
  filterAccountId.value = ''
  filterDramaId.value = ''
  filterStatus.value = ''
  filterQuery.value = ''
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [prod, legacy] = await Promise.all([
      gridEpisodeAPI.productions(0, pageSize.value, {
        account_id: filterAccountId.value ? Number(filterAccountId.value) : null,
        drama_id: filterDramaId.value ? Number(filterDramaId.value) : null,
        status: filterStatus.value || null,
        q: filterQuery.value.trim() || null,
      }),
      remotionAPI.list().catch(() => [] as any[]),
    ])
    items.value = prod?.items ?? []
    total.value = prod?.total ?? 0
    legacyItems.value = Array.isArray(legacy) ? legacy : []
    currentPage.value = 1
  } catch (err: any) {
    error.value = err?.message || '读取失败'
  } finally {
    loading.value = false
    loaded.value = true
  }
}

async function loadPage() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const prod = await gridEpisodeAPI.productions(startIdx.value, pageSize.value, {
      account_id: filterAccountId.value ? Number(filterAccountId.value) : null,
      drama_id: filterDramaId.value ? Number(filterDramaId.value) : null,
      status: filterStatus.value || null,
      q: filterQuery.value.trim() || null,
    })
    items.value = prod?.items ?? []
    total.value = prod?.total ?? total.value
  } catch (err: any) {
    error.value = err?.message || '读取失败'
  } finally {
    loading.value = false
  }
}

watch([filterAccountId, filterDramaId, filterStatus, filterQuery], () => {
  currentPage.value = 1
  refresh()
}, { deep: true })

watch([currentPage, pageSize], () => {
  loadPage()
})

onMounted(refresh)
</script>

<style scoped>
/* Hallmark · macrostructure: Split Studio · genre: modern-minimal · tone: utilitarian · anchor hue: blue · theme: existing studio tokens
 * Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V5 · contrast: pass (40-41) · slop: pass (42-49) · mobile: pass (34, 49-57)
 */
.remotion-page {
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
.page-identity-icon,
.style-heading-icon {
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
.spin { animation: rhf-spin 1s linear infinite; }
.spin-once { animation: rhf-spin 0.8s linear 1; }
@keyframes rhf-spin { to { transform: rotate(360deg); } }

/* Style console */
.style-console {
  --style-ink: var(--text-0);
  --style-ink-soft: var(--text-1);
  --style-ink-rule: var(--text-2);
  --style-ink-text: var(--bg-0);
  --style-ink-muted: var(--bg-3);
  --style-ink-tint: var(--text-1);
  overflow: hidden;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-card);
}
.style-console-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.style-heading,
.style-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.style-heading-icon {
  width: 32px;
  height: 32px;
}
.style-heading h2 {
  min-width: 0;
  margin: 0;
  color: var(--text-0);
  font-size: 15px;
  letter-spacing: 0;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.style-heading p {
  overflow: hidden;
  margin: 0;
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.style-heading p strong {
  color: var(--text-1);
  font-weight: 700;
}
.style-unity {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.style-mode-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-1);
}
.style-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 68px;
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out), transform 100ms var(--ease-out);
}
.style-mode:focus-visible,
.rail-style:focus-visible,
.compare-style:focus-visible,
.summary-stat:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.style-mode:active,
.rail-style:active,
.compare-style:active,
.summary-stat:active {
  transform: translateY(1px);
}
.style-mode:disabled,
.rail-style:disabled,
.compare-style:disabled,
.summary-stat:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
.style-mode.active {
  background: var(--bg-0);
  color: var(--accent-text);
  box-shadow: var(--shadow-sm);
}
.style-console-body {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  height: clamp(320px, 38dvh, 356px);
  min-height: 320px;
  max-height: 356px;
}
.style-rail {
  display: grid;
  align-content: start;
  grid-template-rows: 24px repeat(9, minmax(32px, 1fr));
  gap: 1px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  border-right: 1px solid var(--border);
  background: var(--bg-1);
}
.style-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  color: var(--text-2);
  font-size: 10px;
  font-weight: 700;
}
.style-rail-head span:last-child {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.rail-style {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  touch-action: manipulation;
  transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out), color 150ms var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .style-mode:hover,
  .rail-style:hover,
  .compare-style:hover,
  .summary-stat:hover {
    background: var(--bg-hover);
  }
}
.rail-style.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.rail-index {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.rail-copy {
  min-width: 0;
}
.rail-copy strong,
.rail-copy span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-copy strong {
  color: var(--text-0);
  font-size: 11px;
  line-height: 1.2;
}
.rail-copy span {
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.2;
}
.rail-style.active .rail-copy strong,
.rail-style.active .rail-copy span {
  color: var(--accent-text);
}
.style-preview-pane {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 248px;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--style-ink);
  color: var(--style-ink-text);
}
.preview-video-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  margin: 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 8px;
}
.screen-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--style-ink-text);
}
.screen-toolbar > div {
  min-width: 0;
}
.screen-label {
  display: block;
  color: var(--style-ink-muted);
  font-size: 10px;
}
.screen-toolbar strong {
  display: block;
  overflow: hidden;
  color: var(--style-ink-text);
  font-size: 13px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.screen-open {
  min-height: 32px;
  border-color: var(--style-ink-rule);
  color: var(--style-ink-text);
  white-space: nowrap;
}
.video-shell {
  position: relative;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--style-ink-rule);
  border-radius: 4px;
  background: var(--style-ink-soft);
}
.style-video {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--style-ink-soft);
}
.style-inspector {
  display: grid;
  grid-template-rows: auto auto auto;
  align-content: space-between;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  border-left: 1px solid var(--style-ink-rule);
  color: var(--style-ink-text);
}
.inspector-title {
  display: grid;
  gap: 4px;
}
.inspector-kicker {
  color: var(--style-ink-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
}
.style-inspector h3 {
  min-width: 0;
  margin: 0;
  color: var(--style-ink-text);
  font-size: 18px;
  letter-spacing: 0;
  line-height: 1.15;
  overflow-wrap: anywhere;
}
.style-inspector p {
  margin: 0;
  color: var(--style-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}
.style-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--style-ink-rule);
  border-radius: 8px;
}
.style-facts div {
  display: grid;
  gap: 4px;
  padding: 4px 8px;
  background: var(--style-ink-tint);
}
.style-facts div:last-child {
  grid-column: 1 / -1;
}
.style-facts dt {
  color: var(--style-ink-muted);
  font-size: 10px;
}
.style-facts dd {
  margin: 0;
  color: var(--style-ink-text);
  font-size: 12px;
  line-height: 1.3;
}
.project-style-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--style-ink-rule);
  color: var(--style-ink-text);
}
.project-style-state > svg {
  flex: 0 0 auto;
}
.project-style-state span,
.project-style-state strong,
.project-style-state small {
  display: block;
}
.project-style-state strong {
  font-size: 11px;
}
.project-style-state small {
  color: var(--style-ink-muted);
  font-size: 10px;
}
.style-compare-pane {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: minmax(96px, 1fr);
  gap: 4px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  background: var(--bg-0);
}
.compare-style {
  display: grid;
  grid-template-rows: 64px minmax(0, 1fr);
  gap: 4px;
  min-width: 0;
  min-height: 96px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-1);
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out), transform 100ms var(--ease-out);
}
.compare-style.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.compare-media {
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  border-radius: 4px;
  background: var(--style-ink);
}
.compare-media video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.compare-index,
.compare-check {
  position: absolute;
  top: 4px;
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  border-radius: 4px;
  background: var(--style-ink);
  color: var(--style-ink-text);
}
.compare-index {
  left: 4px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.compare-check {
  right: 4px;
  color: var(--style-ink-text);
}
.compare-copy,
.compare-copy strong,
.compare-copy small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compare-copy strong {
  color: var(--text-0);
  font-size: 11px;
  line-height: 1.2;
}
.compare-copy small {
  color: var(--text-2);
  font-size: 9px;
  line-height: 1.2;
}
.compare-style.active .compare-copy strong,
.compare-style.active .compare-copy small {
  color: var(--accent-text);
}

/* Production summary + filters */
.production-tools {
  display: grid;
  grid-template-columns: minmax(260px, 0.7fr) minmax(620px, 1.7fr);
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
.summary-stat:last-child {
  border-right: 0;
}
.summary-stat.active {
  background: var(--accent-bg);
  color: var(--accent-text);
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
.summary-stat.active .stat-label {
  color: var(--accent-text);
}
.filter-grid {
  display: grid;
  grid-template-columns: minmax(108px, 0.8fr) minmax(148px, 1.2fr) 104px minmax(160px, 1.35fr) 36px;
  align-items: end;
  gap: 8px;
  min-width: 0;
}
.filter-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.filter-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0;
}
.search-input-wrap {
  position: relative;
}
.search-input-wrap .input {
  padding-left: 30px;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.action-cell {
  justify-content: flex-end;
}
.clear-filter {
  width: 36px;
  height: 36px;
}

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

/* Table */
.table-wrap {
  overflow: hidden;
  border-radius: 8px;
}
.prod-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
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
.prod-table tbody tr:last-child td {
  border-bottom: none;
}
.prod-row:hover td {
  background: var(--bg-hover);
}
.col-account { width: 12%; min-width: 120px; }
.col-drama { width: 16%; min-width: 140px; }
.col-ep { width: 48px; text-align: center; }
.col-title { min-width: 180px; }
.col-status { width: 110px; }
.col-shots { width: 64px; text-align: center; }
.col-review { width: 72px; text-align: center; }
.col-render { width: 110px; }
.col-actions { width: 150px; text-align: right; white-space: nowrap; }

.cell-account {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
}
.ep-code {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-2);
  border-radius: 5px;
  padding: 1px 6px;
  font-family: var(--font-mono);
}
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
.review-text { font-weight: 500; color: var(--text-2); }
.review-pass { color: var(--success); }
.review-none,
.render-none { color: var(--text-3); }
.render-time { color: var(--text-2); }
.action-group {
  display: inline-flex;
  gap: 6px;
  justify-content: flex-end;
}
.action-group .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
}

/* Pagination */
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding: 0 2px;
}
.page-size {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-3);
}
.page-size :deep(.base-select) {
  width: 64px;
}
.page-range {
  font-size: 13px;
  color: var(--text-3);
}
.page-buttons {
  display: inline-flex;
  gap: 5px;
}
.page-buttons .btn {
  min-width: 32px;
}

/* Legacy */
.legacy-block {
  margin-top: 24px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.legacy-block summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  user-select: none;
}
.legacy-block summary::-webkit-details-marker { display: none; }
.count-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-3);
  font-weight: 400;
}
.legacy-table-wrap {
  margin-top: 10px;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
}
.legacy-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.legacy-table th,
.legacy-table td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.legacy-table th {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  background: var(--bg-1);
}
.legacy-table tbody tr:last-child td { border-bottom: none; }

@media (max-width: 1100px) {
  .style-console-body {
    grid-template-columns: 1fr;
    height: auto;
    min-height: 0;
    max-height: none;
  }
  .style-rail {
    grid-template-rows: 44px;
    grid-auto-flow: column;
    grid-auto-columns: minmax(180px, 1fr);
    height: 56px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 4px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .style-rail-head {
    display: none;
  }
  .rail-style {
    min-height: 44px;
  }
  .style-preview-pane {
    height: 340px;
  }
  .style-compare-pane {
    height: 340px;
  }
  .production-tools {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .filter-grid {
    grid-template-columns: minmax(120px, 0.8fr) minmax(160px, 1.2fr) 112px minmax(180px, 1.4fr) 36px;
  }
}

@media (max-width: 760px) {
  .remotion-page { padding: 12px 12px 28px; }
  .page-head {
    margin-bottom: 8px;
  }
  .page-desc {
    overflow: hidden;
    max-width: 62vw;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .style-console-head {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    padding: 8px;
  }
  .style-head-actions {
    justify-content: space-between;
  }
  .style-mode-tabs {
    flex: 0 0 auto;
  }
  .style-mode {
    min-height: 36px;
  }
  .style-rail {
    grid-auto-columns: minmax(172px, 70vw);
  }
  .style-preview-pane {
    grid-template-columns: 1fr;
    height: auto;
  }
  .preview-video-panel {
    height: 260px;
  }
  .preview-video-panel,
  .style-inspector {
    padding: 8px;
  }
  .style-inspector {
    grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
    grid-template-rows: auto auto;
    align-content: start;
    border-top: 1px solid var(--style-ink-rule);
    border-left: 0;
  }
  .inspector-title,
  .style-facts {
    min-width: 0;
  }
  .project-style-state {
    grid-column: 1 / -1;
  }
  .screen-open {
    min-height: 44px;
  }
  .style-compare-pane {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    height: 360px;
  }
  .compare-style {
    min-height: 96px;
  }
  .filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .search-cell { grid-column: span 2; }
  .action-cell {
    grid-column: span 2;
    align-items: flex-end;
  }
  .prod-table .col-account,
  .prod-table .col-drama,
  .prod-table .col-review,
  .prod-table .col-render { display: none; }
  .pagination-bar {
    flex-wrap: wrap;
    gap: 8px;
  }
}

@media (max-width: 420px) {
  .page-identity-icon {
    display: none;
  }
  .style-unity {
    font-size: 10px;
  }
  .style-mode {
    min-width: 64px;
    padding-inline: 7px;
  }
  .preview-video-panel {
    height: 236px;
  }
  .production-tools {
    padding: 8px;
  }
  .filter-grid {
    grid-template-columns: 1fr;
  }
  .search-cell,
  .action-cell {
    grid-column: span 1;
  }
}

@media (pointer: coarse) {
  .style-mode,
  .rail-style,
  .compare-style,
  .summary-stat,
  .clear-filter {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .style-mode,
  .rail-style,
  .compare-style,
  .summary-stat {
    transition-duration: 1ms;
  }
  .spin,
  .spin-once {
    animation-duration: 1ms;
    animation-iteration-count: 1;
  }
}
</style>
