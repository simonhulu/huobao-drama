<template>
  <div class="dharma-page">
    <header class="page-head">
      <div class="page-identity">
        <span class="page-identity-icon" aria-hidden="true"><Flower2 :size="18" /></span>
        <div>
          <p class="page-kicker">佛学工厂</p>
          <h1 class="page-title">佛学与哲学短片</h1>
        </div>
      </div>
      <div class="page-actions">
        <button class="btn btn-ghost btn-icon" type="button" title="刷新剧集列表" :disabled="loading" @click="refresh">
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

    <section class="collection-head" aria-labelledby="collection-title">
      <div>
        <h2 id="collection-title">作品库</h2>
        <p>{{ pagination.total }} 个佛学剧集</p>
      </div>
      <span v-if="loaded && pagination.total_pages > 1" class="collection-page">
        第 {{ pagination.page }} / {{ pagination.total_pages }} 页
      </span>
    </section>

    <div v-if="loading && !loaded" class="loading-state">
      <LoaderCircle :size="18" class="spin" /> 正在加载剧集列表
    </div>

    <section v-else-if="items.length" class="drama-grid" aria-label="佛学剧集">
      <article
        v-for="drama in items"
        :key="drama.id"
        class="drama-card"
        :class="{ 'is-openable': firstEpisodeId(drama) }"
        :tabindex="firstEpisodeId(drama) ? 0 : undefined"
        :role="firstEpisodeId(drama) ? 'link' : undefined"
        @click="goDrama(drama)"
        @keydown.enter.prevent="goDrama(drama)"
        @keydown.space.prevent="goDrama(drama)"
      >
        <div class="card-topline">
          <span class="status-dot" :class="`status-${drama.status || 'draft'}`" aria-hidden="true"></span>
          <span class="drama-date">{{ formatDate(drama.created_at) }}</span>
          <button
            class="icon-btn delete-btn"
            type="button"
            :aria-label="`删除 ${drama.title || '未命名剧集'}`"
            title="删除剧集"
            @click.stop="askDelete(drama)"
          >
            <Trash2 :size="15" />
          </button>
        </div>
        <h3>{{ drama.title || '未命名剧集' }}</h3>
        <p class="drama-summary">{{ drama.description || '等待导入净稿与生产素材' }}</p>
        <footer class="card-footer">
          <span class="episode-count">
            <Film :size="14" /> {{ (drama.episodes || []).length }} 集
          </span>
          <span v-if="firstEpisodeId(drama)" class="open-action">进入生产 <ArrowUpRight :size="15" /></span>
          <span v-else class="card-pending">准备中</span>
        </footer>
      </article>
    </section>

    <section v-else-if="loaded" class="empty-state">
      <Flower2 :size="24" aria-hidden="true" />
      <h2>还没有佛学剧集</h2>
      <p>创建第一集，开始整理净稿与视觉素材。</p>
      <button class="btn btn-primary" type="button" @click="createOpen = true"><Plus :size="16" /> 新建剧集</button>
    </section>

    <nav v-if="loaded && pagination.total_pages > 1" class="pager" aria-label="剧集列表分页">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="page <= 1 || loading" @click="goPage(page - 1)">
        <ChevronLeft :size="14" /> 上一页
      </button>
      <span class="pager-info">共 {{ pagination.total }} 条</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="page >= pagination.total_pages || loading" @click="goPage(page + 1)">
        下一页 <ChevronRight :size="14" />
      </button>
    </nav>

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
import { ref, onMounted } from 'vue'
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleX, Film, Flower2, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next'
import { dharmaAPI, dramaAPI } from '~/composables/useApi'

const items = ref([])
const pagination = ref({ page: 1, page_size: 12, total: 0, total_pages: 0 })
const page = ref(1)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const createOpen = ref(false)
const creating = ref(false)
const createForm = ref({ title: '', script: '', style: '' })
const deleteTarget = ref(null)
const deleting = ref(false)
const imageStyles = ref([])

function formatDate(iso) {
  if (!iso) return '未记录日期'
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function firstEpisodeId(drama) {
  const episodes = drama.episodes || []
  return episodes.length ? episodes[0].id : null
}

function goDrama(drama) {
  const id = firstEpisodeId(drama)
  if (id) navigateTo(`/dharma/episode/${id}`)
}

function closeCreate() {
  if (!creating.value) createOpen.value = false
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const res = await dramaAPI.list({ page: page.value, page_size: 12, genre: 'dharma' })
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
  if (nextPage < 1 || (pagination.value.total_pages && nextPage > pagination.value.total_pages)) return
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

onMounted(() => {
  refresh()
  loadImageStyles()
})
</script>

<style scoped>
.dharma-page {
  height: 100%;
  overflow-y: auto;
  padding: clamp(20px, 3vw, 40px);
}
.page-head, .page-actions, .page-identity, .card-topline, .card-footer, .modal-head, .modal-actions, .pager {
  display: flex;
  align-items: center;
}
.page-head { justify-content: space-between; gap: 20px; margin-bottom: 36px; }
.page-identity { gap: 12px; min-width: 0; }
.page-identity-icon {
  width: 38px; height: 38px; display: grid; place-items: center; flex: 0 0 auto;
  border: 1px solid var(--border); border-radius: var(--radius); color: var(--accent-text); background: var(--bg-1);
}
.page-kicker, .modal-kicker {
  color: var(--text-3); font-size: 12px; font-weight: 600; letter-spacing: 0; line-height: 1.25;
}
.page-title { font-family: var(--font-body); font-size: 22px; font-weight: 650; letter-spacing: 0; margin-top: 2px; }
.page-actions { gap: 8px; flex: 0 0 auto; }
.notice-error {
  display: flex; align-items: center; gap: 8px; margin-bottom: 20px; padding: 10px 12px;
  color: var(--error); background: var(--error-bg); border: 1px solid color-mix(in srgb, var(--error) 18%, transparent); border-radius: var(--radius); font-size: 13px;
}
.collection-head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 14px; }
.collection-head h2 { font-family: var(--font-body); font-size: 14px; font-weight: 600; letter-spacing: 0; }
.collection-head p, .collection-page { color: var(--text-3); font-size: 12px; margin-top: 2px; }
.collection-page { font-variant-numeric: tabular-nums; }
.drama-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.drama-card {
  min-height: 180px; padding: 17px; display: flex; flex-direction: column; gap: 14px;
  background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius-lg); transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
.drama-card.is-openable { cursor: pointer; }
.drama-card.is-openable:hover, .drama-card.is-openable:focus-visible { border-color: var(--border-strong); box-shadow: var(--shadow); outline: none; transform: translateY(-1px); }
.card-topline { gap: 7px; min-height: 18px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
.status-dot.status-completed, .status-dot.status-published { background: var(--success); }
.status-dot.status-processing, .status-dot.status-running { background: var(--warning); }
.drama-date { color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.delete-btn { margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center; color: var(--text-3); background: transparent; border: 0; border-radius: var(--radius-sm); cursor: pointer; opacity: 0; transition: opacity .16s ease, background .16s ease, color .16s ease; }
.drama-card:hover .delete-btn, .delete-btn:focus-visible { opacity: 1; }
.delete-btn:hover { color: var(--error); background: var(--error-bg); }
.drama-card h3 { font-family: var(--font-body); font-size: 15px; font-weight: 600; letter-spacing: 0; line-height: 1.4; }
.drama-summary { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--text-2); font-size: 12px; line-height: 1.65; }
.card-footer { justify-content: space-between; gap: 10px; margin-top: auto; color: var(--text-3); font-size: 11px; }
.episode-count, .open-action { display: inline-flex; align-items: center; gap: 5px; }
.open-action { color: var(--text-1); font-size: 12px; font-weight: 500; }
.card-pending { color: var(--text-3); }
.loading-state, .empty-state { min-height: 260px; display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--text-3); font-size: 13px; }
.empty-state { flex-direction: column; text-align: center; border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); }
.empty-state h2 { font-family: var(--font-body); font-size: 15px; font-weight: 600; letter-spacing: 0; color: var(--text-1); }
.empty-state p { font-size: 13px; margin-top: -5px; }
.empty-state .btn { margin-top: 8px; }
.pager { justify-content: center; gap: 14px; margin-top: 28px; }
.pager-info { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.modal-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(9, 9, 11, .4); backdrop-filter: blur(3px); }
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
.modal-head { justify-content: space-between; gap: 16px; }
.modal-head h2 { font-family: var(--font-body); font-size: 16px; font-weight: 600; letter-spacing: 0; margin-top: 2px; }
.form-label { display: flex; flex-direction: column; gap: 7px; color: var(--text-2); font-size: 12px; font-weight: 500; }
.form-label input, .form-label textarea { width: 100%; padding: 9px 11px; color: var(--text-0); font: inherit; line-height: 1.6; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); outline: none; resize: vertical; }
.form-label input:focus, .form-label textarea:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-glow); }
.style-fieldset { min-width: 0; padding: 0; margin: 0; border: 0; }
.style-fieldset legend { padding: 0; margin-bottom: 7px; color: var(--text-2); font-size: 12px; font-weight: 500; }
.style-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.style-option { min-width: 0; padding: 8px; color: var(--text-2); text-align: left; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.style-option:hover, .style-option:focus-visible { border-color: var(--border-strong); background: var(--bg-2); outline: none; }
.style-option.active { color: var(--text-0); border-color: var(--border-focus); background: var(--accent-bg); box-shadow: 0 0 0 2px var(--accent-glow); }
.style-option-preview { display: block; width: 100%; aspect-ratio: 16 / 9; margin-bottom: 9px; object-fit: cover; border-radius: calc(var(--radius-sm) - 1px); background: var(--bg-2); }
.style-option strong, .style-option span { display: block; }
.style-option strong { font-size: 12px; font-weight: 600; line-height: 1.35; }
.style-option span { margin-top: 3px; color: var(--text-3); font-size: 11px; line-height: 1.45; }
.form-note, .modal-copy { color: var(--text-2); font-size: 12px; line-height: 1.7; }
.modal-actions { justify-content: flex-end; gap: 8px; margin-top: 2px; }
.btn-danger { color: #fff; background: var(--error); border-color: var(--error); }
.btn-danger:hover { color: #fff; background: #b91c1c; border-color: #b91c1c; }
@media (max-width: 640px) {
  .dharma-page { padding: 18px 16px; }
  .page-head { align-items: flex-start; margin-bottom: 28px; }
  .page-actions .btn-primary { width: 38px; padding: 0; font-size: 0; }
  .page-actions .btn-primary :deep(svg) { margin: 0; }
  .collection-head { align-items: flex-start; }
  .drama-grid { grid-template-columns: minmax(0, 1fr); }
  .delete-btn { opacity: 1; }
  .pager { flex-wrap: wrap; }
  .pager-info { order: -1; flex: 0 0 100%; text-align: center; }
  .modal-card { padding: 16px; }
  .style-picker { grid-template-columns: minmax(0, 1fr); }
}
</style>
