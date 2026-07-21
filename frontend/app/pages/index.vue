<template>
  <div class="page">
    <!-- Page Header -->
    <div class="page-head">
      <div class="head-left">
        <h1 class="page-title">内容项目</h1>
        <p class="page-desc">{{ dramas.length }} 个项目 · {{ mediaAccounts.length }} 个自媒体账号</p>
      </div>
      <button class="btn btn-primary" @click="showCreate = true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        新建项目
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-state">
      <div class="loading-grid">
        <div v-for="i in 3" :key="i" class="skeleton-card card"></div>
      </div>
    </div>

    <!-- Grid -->
    <div v-else class="grid">
      <div
        v-for="(d, i) in dramas"
        :key="d.id"
        class="card project-card"
        :style="{ animationDelay: `${i * 0.06}s` }"
        @click="navigateTo(`/drama/${d.id}`)"
      >
        <!-- Card film strip decoration -->
        <div class="card-film-strip">
          <span v-for="j in 5" :key="j" class="film-hole"></span>
        </div>

        <div class="card-body">
          <div class="card-header">
            <div class="episode-badge">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
              {{ d.episodes?.length || 0 }} 集
            </div>
            <span v-if="d.media_account" class="account-badge">{{ d.media_account.name }}</span>
            <button class="btn btn-ghost btn-icon card-delete" @click.stop="delDrama(d)" title="删除">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>

          <h3 class="project-title">{{ d.title }}</h3>

          <div class="project-meta">
            <span v-if="d.style" class="style-tag">{{ styleLabel(d.style) }}</span>
            <span class="meta-item">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {{ d.characters?.length || 0 }}
            </span>
            <span class="meta-item">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
              {{ d.scenes?.length || 0 }}
            </span>
          </div>
        </div>

        <div class="card-footer">
          <div class="progress-mini">
            <div class="progress-mini-track">
              <div class="progress-mini-fill" :style="{ width: getProgress(d) + '%' }"></div>
            </div>
          </div>
          <span class="card-date">{{ fmtDate(d.updated_at || d.updatedAt) }}</span>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="!dramas.length" class="card empty-card" @click="showCreate = true">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p class="empty-title">新建第一个短剧项目</p>
        <p class="empty-desc">从剧本到成片，AI 助力的短剧制作工作台</p>
      </div>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreate" class="overlay" @click.self="showCreate = false">
      <div class="modal card">
        <div class="modal-header">
          <div class="modal-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <rect x="3" y="3" width="18" height="18" rx="3"/>
              <line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </div>
          <h2 class="modal-title">新建内容项目</h2>
          <p class="modal-desc">先绑定自媒体账号，再定义这个系列的创作方向</p>
        </div>
        <form @submit.prevent="create" class="modal-form">
          <div class="modal-form-left">
            <div class="field">
              <span class="field-label">自媒体账号 <span class="required">*</span></span>
              <div class="account-select-row">
                <BaseSelect v-model="form.media_account_id" :options="mediaAccountOptions" placeholder="选择账号" />
                <button type="button" class="btn btn-small" @click="showNewAccount = !showNewAccount">
                  {{ showNewAccount ? '收起' : '新建账号' }}
                </button>
              </div>
              <span v-if="selectedAccount" class="field-hint account-inherit-hint">
                将继承「{{ selectedAccount.name }}」的账号定位，Remotion 生产时会保存定位快照。
              </span>
            </div>

            <div v-if="showNewAccount" class="account-create-panel">
              <div class="account-panel-head">
                <div>
                  <strong>建立账号定位</strong>
                  <span>这些信息会被该账号下的所有项目继承</span>
                </div>
                <button type="button" class="btn btn-ghost btn-icon" title="关闭" aria-label="关闭" @click="showNewAccount = false">×</button>
              </div>
              <label class="field">
                <span class="field-label">账号名称 <span class="required">*</span></span>
                <input v-model="accountForm.name" class="input" placeholder="例如：历史男人志" />
              </label>
              <label class="field">
                <span class="field-label">目标受众</span>
                <input v-model="accountForm.audience" class="input" placeholder="例如：25～45 岁男性" />
              </label>
              <label class="field">
                <span class="field-label">内容承诺</span>
                <textarea v-model="accountForm.promise" class="textarea" rows="2" placeholder="观众为什么持续关注这个账号？"></textarea>
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">内容支柱</span>
                  <input v-model="accountForm.pillars" class="input" placeholder="家庭、情感、事业" />
                </label>
                <label class="field">
                  <span class="field-label">表达风格</span>
                  <input v-model="accountForm.tone" class="input" placeholder="克制、真实、深入" />
                </label>
              </div>
              <button type="button" class="btn account-save-btn" :disabled="accountSaving" @click="createMediaAccount">
                {{ accountSaving ? '保存中...' : '保存账号定位' }}
              </button>
            </div>

            <label class="field">
              <span class="field-label">内容项目名称 <span class="required">*</span></span>
              <input v-model="form.title" class="input" placeholder="例如：历史男人志 · 成败与家国" required autofocus />
            </label>
            <label class="field">
              <span class="field-label">项目定位 <span class="required">*</span></span>
              <textarea v-model="form.project_positioning.thesis" class="textarea" rows="3" placeholder="这个系列从什么角度讲什么内容？例如：从历史男性人物的家庭、情感和事业代价出发，讲他们在责任与欲望之间的选择。" required></textarea>
            </label>
            <div class="field-row">
              <label class="field">
                <span class="field-label">叙事视角</span>
                <input v-model="form.project_positioning.narrative_lens" class="input" placeholder="人物选择与代价" />
              </label>
              <label class="field">
                <span class="field-label">核心主题</span>
                <input v-model="form.project_positioning.core_themes" class="input" placeholder="家庭、情感、事业" />
              </label>
            </div>
            <label class="field">
              <span class="field-label">题材 <span class="required">*</span></span>
              <BaseSelect v-model="form.genre" :options="genreSelectOptions" placeholder="选择题材" @update:model-value="onGenreChange" />
              <span class="field-hint">选择题材后，会自动推荐对应的视觉风格</span>
            </label>
            <label class="field">
              <span class="field-label">计划集数</span>
              <input v-model.number="form.total_episodes" class="input" type="number" min="0" max="100" />
            </label>
            <div class="field">
              <span class="field-label">
                视觉风格
                <span v-if="isRecommendedStyle" class="recommendation-badge">推荐</span>
                <span v-else class="recommendation-hint">推荐：{{ styleLabel(recommendedStyle) }}</span>
              </span>
              <div class="style-breadcrumbs">
                <button
                  v-for="opt in styleSelectOptions"
                  :key="opt.value"
                  type="button"
                  class="style-crumb"
                  :class="{ active: form.style === opt.value, recommended: recommendedStyle === opt.value }"
                  @click="form.style = opt.value"
                >
                  {{ opt.label }}
                </button>
              </div>
              <span class="field-hint">点击小方块选择风格，右侧显示对应示意图</span>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn" @click="showCreate = false">取消</button>
              <button type="submit" class="btn btn-primary">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                创建项目
              </button>
            </div>
          </div>
          <div class="modal-form-right">
            <div class="style-preview">
              <span class="field-label">
                风格示意图
                <span v-if="currentStyleHasPreview" class="recommendation-hint">— {{ styleLabel(form.style) }}</span>
                <span v-else class="recommendation-hint">（当前风格暂无单独示意）</span>
              </span>
              <a :href="currentStyleImageUrl" target="_blank" rel="noopener" class="style-grid-link">
                <img
                  :src="currentStyleImageUrl"
                  :alt="`风格示意图：${styleLabel(form.style)}`"
                  class="style-grid-img"
                  :key="form.style"
                />
              </a>
              <span class="field-hint">账号定位决定表达方向，视觉风格决定画面表现；两者会一起写入生产快照。</span>
            </div>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { dramaAPI, mediaAccountAPI } from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'

const dramas = ref([])
const mediaAccounts = ref([])
const loading = ref(false)
const showCreate = ref(false)
const showNewAccount = ref(false)
const accountSaving = ref(false)
const form = ref({
  title: '',
  total_episodes: 0,
  genre: 'generic',
  style: 'cinematic',
  media_account_id: null,
  project_positioning: {
    thesis: '',
    narrative_lens: '',
    core_themes: '',
  },
})
const accountForm = ref({
  name: '',
  audience: '',
  promise: '',
  pillars: '',
  tone: '',
})

// 风格示意图 URL（用变量绑定避免 Vite 把 /static 路径解析为本地模块）
const styleGridUrl = '/static/style_grid.jpg'

// 已有单独示意图的风格（与 data/static/style-chart/ 下的单图保持一致）
// 生成脚本：backend/scripts/generate-style-chart-direct.ts
const styleKeysWithPreview = [
  'generic', 'realistic', 'cinematic', 'anime', 'ghibli', 'comic', 'watercolor',
  'wes_anderson', 'film_noir', 'rembrandt', 'villeneuve', 'wong_kar_wai', 'documentary', 'vintage_film',
  'oil_painting', 'pastel', 'ink_wash', 'ukiyo_e', 'impressionist', 'pop_art', 'renaissance', 'baroque', 'neoclassical',
  'cyberpunk', 'steampunk', 'fantasy', 'noir', 'vintage', 'minimalist', 'dark_academia',
  'digital_art', 'concept_art', 'pixel_art', 'line_art', '3d_render', 'isometric',
  'chinese_ink', 'chinese_gongbi', 'wuxia', 'chinese_palace', 'eastern_fantasy', 'ukiyo_samurai',
  'historical', 'historical_epic', 'roman_fresco', 'byzantine', 'medieval_manuscript', 'dutch_golden_age', 'victorian', 'prohibition_era', 'wwii_photo',
  'scifi', 'mythology', 'space', 'deepsea', 'ancient', 'wasteland',
]
const currentStyleImageUrl = computed(() => {
  if (styleKeysWithPreview.includes(form.value.style)) {
    return `/static/style-chart/${form.value.style}.png`
  }
  return styleGridUrl
})
const currentStyleHasPreview = computed(() => styleKeysWithPreview.includes(form.value.style))

// 题材：内容主题，只影响推荐视觉风格
const genres = ['generic', 'history', 'scifi', 'mythology', 'space', 'deepsea', 'ancient', 'wasteland']
const genreLabels = {
  generic: '通用',
  history: '历史 / 历史人物',
  scifi: '科幻',
  mythology: '神话 / 奇幻',
  space: '天文 / 太空',
  deepsea: '深海',
  ancient: '古文明',
  wasteland: '末日废土',
}
const genreSelectOptions = computed(() => genres.map(g => ({ label: genreLabels[g] || g, value: g })))

// 视觉风格：精选适合连续分镜的高频风格；旧风格仍由后端兼容
const styles = [
  'historical_systems', 'period_crime_35mm', 'institutional_tableau',
  'republican_shanghai', 'showa_nostalgia', 'northwest_epic', 'korean_crime',
  'studio_wuxia', 'location_kungfu', 'ink_wuxia', 'old_color_wuxia',
  'guofeng_editorial', 'night_flash_snapshot', 'commercial_teal_orange',
  'cinematic', 'documentary', 'chinese_gongbi', 'wuxia', 'eastern_fantasy',
  'anime', 'watercolor', 'cyberpunk',
]
const styleLabels = {
  // 基础风格
  generic: '通用（电影感）',
  realistic: '写实',
  cinematic: '电影写实',
  anime: '动漫插画',
  ghibli: '吉卜力',
  comic: '漫画',
  watercolor: '水彩',
  // 电影摄影风格
  wes_anderson: '韦斯·安德森',
  film_noir: '黑色电影',
  rembrandt: '伦勃朗光',
  villeneuve: '维伦纽瓦史诗',
  wong_kar_wai: '王家卫',
  documentary: '纪录片',
  vintage_film: '复古胶片',
  historical_systems: '现实系统史诗',
  period_crime_35mm: '复古犯罪凝视',
  institutional_tableau: '制度剧场',
  republican_shanghai: '民国上海复古',
  showa_nostalgia: '昭和生活怀旧',
  northwest_epic: '西北乡土史诗',
  korean_crime: '冷峻现实犯罪',
  studio_wuxia: '邵氏棚拍武侠',
  location_kungfu: '七十年代实景功夫',
  ink_wuxia: '东方水墨武侠',
  old_color_wuxia: '旧彩浪漫武侠',
  guofeng_editorial: '古风暗场时尚',
  night_flash_snapshot: '夜街直闪快照',
  commercial_teal_orange: '现代青橙商业',
  // 艺术绘画
  oil_painting: '油画',
  pastel: '色粉画',
  ink_wash: '水墨',
  ukiyo_e: '浮世绘',
  impressionist: '印象派',
  pop_art: '波普艺术',
  renaissance: '文艺复兴',
  baroque: '巴洛克',
  neoclassical: '新古典主义',
  // 视觉氛围
  cyberpunk: '赛博科幻',
  steampunk: '蒸汽朋克',
  fantasy: '奇幻',
  noir: '黑色电影',
  vintage: '复古',
  minimalist: '极简',
  dark_academia: '暗黑学院',
  // 媒介渲染
  digital_art: '数字艺术',
  concept_art: '概念艺术',
  pixel_art: '像素风',
  line_art: '线稿',
  '3d_render': '3D 渲染',
  isometric: '等距插画',
  // 中式 / 东方历史
  chinese_ink: '中式水墨',
  chinese_gongbi: '中式工笔',
  wuxia: '武侠国风',
  chinese_palace: '宫廷国风',
  eastern_fantasy: '东方奇幻',
  ukiyo_samurai: '浮世绘武士',
  // 西方 / 世界历史
  historical: '历史史诗',
  historical_epic: '历史史诗',
  roman_fresco: '古罗马壁画',
  byzantine: '拜占庭圣像',
  medieval_manuscript: '中世纪手抄本',
  dutch_golden_age: '荷兰黄金时代',
  victorian: '维多利亚',
  prohibition_era: '禁酒令时代',
  wwii_photo: '二战纪实',
  // 高级主题风格（兼容旧数据）
  scifi: '科幻',
  mythology: '神话 / 奇幻',
  space: '太空',
  deepsea: '深海',
  ancient: '古文明',
  wasteland: '末日废土',
}
const styleSelectOptions = computed(() => styles.map(s => ({ label: styleLabels[s] || s, value: s })))

// 题材 → 推荐视觉风格（两者独立，不再混在一起）
const genreStyleRecommendations = {
  generic: 'cinematic',
  history: 'historical_systems',
  scifi: 'cyberpunk',
  mythology: 'eastern_fantasy',
  space: 'cinematic',
  deepsea: 'documentary',
  ancient: 'chinese_gongbi',
  wasteland: 'cinematic',
}
const recommendedStyle = computed(() => genreStyleRecommendations[form.value.genre] || 'cinematic')
const isRecommendedStyle = computed(() => form.value.style === recommendedStyle.value)
const mediaAccountOptions = computed(() => mediaAccounts.value.map(account => ({
  label: account.name,
  value: account.id,
})))
const selectedAccount = computed(() => mediaAccounts.value.find(account => account.id === form.value.media_account_id) || null)

function styleLabel(value) {
  return styleLabels[value] || value || ''
}

function genreLabel(value) {
  return genreLabels[value] || value || ''
}

function onGenreChange() {
  form.value.style = recommendedStyle.value
}

async function load() {
  loading.value = true
  try {
    const [dramaResult, accountResult] = await Promise.all([dramaAPI.list(), mediaAccountAPI.list()])
    dramas.value = dramaResult.items || []
    mediaAccounts.value = Array.isArray(accountResult) ? accountResult : []
    if (!form.value.media_account_id && mediaAccounts.value.length) {
      form.value.media_account_id = mediaAccounts.value[0].id
    }
  } catch (e) {
    toast.error(e.message)
  } finally {
    loading.value = false
  }
}

async function createMediaAccount() {
  if (!accountForm.value.name.trim()) {
    toast.error('请填写账号名称')
    return
  }
  accountSaving.value = true
  try {
    const account = await mediaAccountAPI.create({
      name: accountForm.value.name,
      positioning: {
        audience: accountForm.value.audience,
        promise: accountForm.value.promise,
        pillars: accountForm.value.pillars.split(/[，,]/).map(item => item.trim()).filter(Boolean),
        tone: accountForm.value.tone,
      },
    })
    mediaAccounts.value = [account, ...mediaAccounts.value]
    form.value.media_account_id = account.id
    showNewAccount.value = false
    accountForm.value = { name: '', audience: '', promise: '', pillars: '', tone: '' }
    toast.success('账号定位已保存')
  } catch (e) {
    toast.error(e.message)
  } finally {
    accountSaving.value = false
  }
}

async function create() {
  if (!form.value.title?.trim()) return
  if (!form.value.media_account_id) {
    toast.error('请先选择自媒体账号')
    return
  }
  if (!form.value.project_positioning.thesis?.trim()) {
    toast.error('请填写项目定位')
    return
  }
  try {
    const d = await dramaAPI.create(form.value)
    showCreate.value = false
    navigateTo(`/drama/${d.id}`)
  } catch (e) {
    toast.error(e.message)
  }
}

async function delDrama(d) {
  if (!confirm(`确定删除「${d.title}」？此操作不可恢复。`)) return
  try {
    await dramaAPI.del(d.id)
    toast.success('已删除')
    load()
  } catch (e) {
    toast.error(e.message)
  }
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function getProgress(d) {
  // Rough progress based on episodes with scripts
  if (!d.episodes?.length) return 0
  const scripted = d.episodes.filter(e => e.script_content || e.scriptContent).length
  return Math.round((scripted / d.episodes.length) * 100)
}

onMounted(load)
</script>

<style scoped>
.page {
  padding: 28px 48px 40px;
  overflow-y: auto;
  height: 100%;
  animation: fadeUp 0.35s var(--ease-out) both;
}

/* Page Head */
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 28px;
}
.head-left { display: flex; flex-direction: column; gap: 4px; }
.page-title {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-0);
}
.page-desc { font-size: 13px; color: var(--text-3); font-weight: 400; }

/* Grid */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}

/* Project Card */
.project-card {
  padding: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fadeUp 0.4s var(--ease-out) both;
  transition: transform 0.22s var(--ease-out), box-shadow 0.22s var(--ease-out), border-color 0.2s;
}
.project-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-lg);
  transform: translateY(-3px);
}

/* Film strip decoration */
.card-film-strip {
  display: flex;
  justify-content: space-around;
  align-items: center;
  padding: 6px 16px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}
.film-hole {
  width: 10px; height: 8px;
  background: var(--bg-3);
  border-radius: 2px;
  transition: background 0.2s;
}
.project-card:hover .film-hole:nth-child(2) { background: var(--accent); }
.project-card:hover .film-hole:nth-child(4) { background: var(--accent); opacity: 0.5; }

.card-body { padding: 18px 18px 14px; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.episode-badge {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.episode-badge svg { color: var(--accent); }

.card-delete { opacity: 0; transition: opacity 0.15s; }
.project-card:hover .card-delete { opacity: 1; }

.project-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text-0);
}

.project-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.account-badge {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border: 1px solid rgba(76,125,255,.18);
  border-radius: 4px;
  background: rgba(76,125,255,.08);
  color: var(--accent-text);
  font-size: 10px;
  font-weight: 600;
}
.style-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  background: var(--accent-bg);
  color: var(--accent-text);
  border-radius: 99px;
  border: 1px solid rgba(184,120,20,0.12);
}
.meta-item {
  display: flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--text-3);
}

.card-footer {
  padding: 10px 18px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
}
.progress-mini { flex: 1; }
.progress-mini-track {
  height: 3px; background: var(--bg-3);
  border-radius: 99px; overflow: hidden;
}
.progress-mini-fill {
  height: 100%;
  background: var(--accent-gradient);
  border-radius: 99px;
  transition: width 0.6s var(--ease-out);
}
.card-date { font-size: 11px; color: var(--text-3); white-space: nowrap; }

/* Loading Skeleton */
.loading-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}
.skeleton-card {
  height: 180px;
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-hover) 50%, var(--bg-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border: none;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* Empty Card */
.empty-card {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 56px 32px;
  cursor: pointer;
  border-style: dashed; border-width: 1.5px;
  text-align: center;
  transition: all 0.2s var(--ease-out);
}
.empty-card:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  transform: translateY(-2px);
}
.empty-icon {
  width: 56px; height: 56px; border-radius: var(--radius-lg);
  background: var(--bg-2);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3);
  margin-bottom: 4px;
  transition: all 0.2s;
}
.empty-card:hover .empty-icon { background: var(--accent-bg); color: var(--accent); }
.empty-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.empty-desc { font-size: 12px; color: var(--text-3); max-width: 220px; line-height: 1.6; }

/* Modal */
.modal { padding: 32px; width: 760px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); box-shadow: var(--shadow-elevated); animation: scaleIn 0.2s var(--ease-out); display: flex; flex-direction: column; overflow: auto; }
.modal-header { margin-bottom: 24px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.modal-icon {
  width: 44px; height: 44px; border-radius: var(--radius);
  background: var(--accent-bg); color: var(--accent);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 4px;
}
.modal-title { font-family: var(--font-display); font-size: 19px; font-weight: 700; }
.modal-desc { font-size: 13px; color: var(--text-3); }
.modal-form { display: grid; grid-template-columns: 1fr 280px; gap: 24px; }
.modal-form-left { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.modal-form-right { display: flex; flex-direction: column; min-width: 0; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); display: inline-flex; align-items: center; gap: 8px; }
.required { color: var(--error); }
.field-hint { font-size: 12px; color: var(--text-3); }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.account-select-row { display: flex; align-items: center; gap: 8px; }
.account-select-row > :first-child { min-width: 0; flex: 1; }
.btn-small { min-height: 34px; padding: 0 10px; font-size: 11px; white-space: nowrap; }
.account-inherit-hint { color: var(--accent-text); }
.account-create-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(76,125,255,.2);
  border-radius: var(--radius);
  background: rgba(76,125,255,.045);
}
.account-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.account-panel-head div { display: flex; flex-direction: column; gap: 3px; }
.account-panel-head strong { color: var(--text-1); font-size: 12px; }
.account-panel-head span { color: var(--text-3); font-size: 11px; }
.account-save-btn { align-self: flex-start; }
.recommendation-badge {
  display: inline-flex; align-items: center;
  font-size: 10px; font-weight: 600;
  padding: 2px 6px; border-radius: 999px;
  background: var(--accent-bg); color: var(--accent);
}
.recommendation-hint {
  font-size: 11px; font-weight: 500; color: var(--text-3);
}
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 6px; margin-top: auto; }
.style-breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  margin: -4px;
}
.style-crumb {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-2);
  border-radius: var(--radius);
  padding: 5px 10px;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: all 0.15s var(--ease-out);
  text-align: left;
}
.style-crumb:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.style-crumb.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: var(--shadow);
}
.style-crumb.recommended:not(.active) {
  border-color: rgba(184, 120, 20, 0.45);
  color: var(--accent);
}
.style-preview { display: flex; flex-direction: column; gap: 8px; height: 480px; }
.style-preview .field-label { margin-bottom: 0; flex-shrink: 0; }
.style-grid-link {
  display: block;
  border-radius: var(--radius);
  overflow: hidden;
  transition: box-shadow 0.2s var(--ease-out), transform 0.2s var(--ease-out);
  flex: 1;
  min-height: 0;
  position: relative;
}
.style-grid-link:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-1px);
}
.style-grid-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  display: block;
  background: var(--bg-2);
}
@media (max-width: 720px) {
  .modal { padding: 24px; width: 100%; max-width: calc(100vw - 32px); }
  .modal-form { grid-template-columns: 1fr; gap: 16px; }
  .modal-form-right { max-height: 240px; }
  .style-preview { height: auto; }
  .modal-actions { margin-top: 0; }
}
</style>
