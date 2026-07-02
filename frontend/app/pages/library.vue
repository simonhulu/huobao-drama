<template>
  <div class="page">
    <!-- Header -->
    <div class="page-head">
      <div class="head-left">
        <h1 class="page-title">素材库</h1>
        <p class="page-desc">已生成的 BGM 与本地 SFX 音效，可试听、筛选</p>
      </div>
      <div class="head-actions">
        <button class="btn" :disabled="refreshing" @click="refreshMusic">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
          </svg>
          <span>{{ refreshing ? '扫描中…' : '刷新索引' }}</span>
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span class="tab-count">{{ tabCounts[tab.key] }}</span>
      </button>
    </div>

    <!-- Filters -->
    <div class="filters">
      <input v-model="query" class="input search-input" placeholder="搜索关键词、文件名、情绪…" />
      <select v-if="activeTab === 'music'" v-model="filterEmotion" class="input">
        <option value="">全部情绪</option>
        <option v-for="e in emotionOptions" :key="e" :value="e">{{ e }}</option>
      </select>
      <select v-if="activeTab === 'music'" v-model="filterSource" class="input">
        <option value="">全部来源</option>
        <option value="minimax">MiniMax 生成</option>
        <option value="freepack">免费素材包</option>
        <option value="local">本地文件</option>
      </select>
      <select v-if="activeTab === 'sfx'" v-model="filterPack" class="input">
        <option value="">全部音效包</option>
        <option v-for="p in packOptions" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-state">
      <div class="loading-grid">
        <div v-for="i in 4" :key="i" class="skeleton-card card"></div>
      </div>
    </div>

    <!-- Music List -->
    <div v-else-if="activeTab === 'music'" class="asset-grid">
      <div v-for="item in filteredMusic" :key="item.url" class="card asset-card">
        <div class="asset-header">
          <div class="asset-tags">
            <span v-if="item.emotion_bucket" class="tag tag-emotion">{{ item.emotion_bucket }}</span>
            <span v-if="item.intensity" class="tag tag-intensity">{{ item.intensity }}</span>
            <span class="tag" :class="`tag-${item.source}`">{{ item.source }}</span>
          </div>
          <div class="asset-actions">
            <span class="asset-duration">{{ fmtDuration(item.duration) }}</span>
            <button
              class="icon-btn danger-btn"
              type="button"
              title="删除 BGM"
              :disabled="isDeletingAsset('music', item)"
              @click.stop="deleteMusic(item)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <div class="asset-body">
          <p class="asset-name" :title="item.filename">{{ item.filename }}</p>
          <p v-if="item.prompt" class="asset-prompt">{{ item.prompt }}</p>
          <div v-if="item.tags?.length" class="asset-tags-list">
            <span v-for="tag in item.tags.slice(0, 8)" :key="tag" class="asset-tag">{{ tag }}</span>
          </div>
          <audio class="asset-player" controls :src="item.url" preload="none"></audio>
        </div>
      </div>
      <div v-if="!filteredMusic.length" class="empty-state card">
        没有找到匹配的 BGM
      </div>
    </div>

    <!-- SFX List -->
    <div v-else class="asset-list">
      <div v-for="item in filteredSfx" :key="item.path" class="card asset-row">
        <div class="row-main">
          <span class="row-pack">{{ item.pack }}</span>
          <span class="row-name">{{ filename(item.path) }}</span>
          <span class="row-keywords">{{ item.keywords.slice(0, 6).join(' · ') }}</span>
        </div>
        <div class="row-actions">
          <audio class="row-player" controls :src="item.url" preload="none"></audio>
          <button
            class="icon-btn danger-btn"
            type="button"
            title="删除音效"
            :disabled="isDeletingAsset('sfx', item)"
            @click.stop="deleteSfx(item)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
      <div v-if="!filteredSfx.length" class="empty-state card">
        没有找到匹配的音效
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { Trash2 } from 'lucide-vue-next'
import { libraryAPI } from '~/composables/useApi'

const tabs = [
  { key: 'music', label: '背景音乐' },
  { key: 'sfx', label: '音效' },
]
const activeTab = ref('music')
const loading = ref(false)
const refreshing = ref(false)
const query = ref('')
const filterEmotion = ref('')
const filterSource = ref('')
const filterPack = ref('')

const musicItems = ref([])
const sfxItems = ref([])
const deletingAssetKeys = ref(new Set())

const emotionOptions = computed(() => {
  const set = new Set(musicItems.value.map(i => i.emotion_bucket).filter(Boolean))
  return Array.from(set).sort()
})
const packOptions = computed(() => {
  const set = new Set(sfxItems.value.map(i => i.pack).filter(Boolean))
  return Array.from(set).sort()
})
const tabCounts = computed(() => ({
  music: musicItems.value.length,
  sfx: sfxItems.value.length,
}))

function normalize(s) {
  return String(s || '').toLowerCase()
}

function matchesQuery(item, q) {
  if (!q) return true
  const text = normalize([item.filename, item.prompt, item.emotion_bucket, item.intensity, item.source, ...(item.tags || [])].join(' '))
  return text.includes(q.toLowerCase())
}

const filteredMusic = computed(() => {
  const q = query.value
  return musicItems.value.filter(item => {
    if (!matchesQuery(item, q)) return false
    if (filterEmotion.value && item.emotion_bucket !== filterEmotion.value) return false
    if (filterSource.value && item.source !== filterSource.value) return false
    return true
  })
})

const filteredSfx = computed(() => {
  const q = query.value.toLowerCase()
  return sfxItems.value.filter(item => {
    if (!q) return true
    const text = normalize([item.path, item.pack, ...(item.keywords || [])].join(' '))
    return text.includes(q)
  }).filter(item => !filterPack.value || item.pack === filterPack.value)
})

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function filename(path) {
  return String(path || '').split('/').pop()
}

function assetKey(type, item) {
  return `${type}:${item?.url || item?.path || item?.filename || ''}`
}

function isDeletingAsset(type, item) {
  return deletingAssetKeys.value.has(assetKey(type, item))
}

function markDeleting(key, deleting) {
  const next = new Set(deletingAssetKeys.value)
  if (deleting) next.add(key)
  else next.delete(key)
  deletingAssetKeys.value = next
}

async function load() {
  loading.value = true
  try {
    const [music, sfx] = await Promise.all([libraryAPI.music(), libraryAPI.sfx()])
    musicItems.value = music.items || []
    sfxItems.value = sfx.items || []
  } catch (e) {
    toast.error(e.message)
  } finally {
    loading.value = false
  }
}

async function refreshMusic() {
  refreshing.value = true
  try {
    await libraryAPI.refresh()
    await load()
    toast.success('素材索引已刷新')
  } catch (e) {
    toast.error(e.message)
  } finally {
    refreshing.value = false
  }
}

async function deleteMusic(item) {
  const name = item.filename || filename(item.url)
  if (!globalThis.confirm(`确定删除 BGM「${name}」？\n文件会从本地素材库中移除。`)) return
  const key = assetKey('music', item)
  markDeleting(key, true)
  try {
    await libraryAPI.deleteMusic(item.url)
    musicItems.value = musicItems.value.filter(entry => entry.url !== item.url)
    toast.success('BGM 已删除')
  } catch (e) {
    toast.error(e.message)
  } finally {
    markDeleting(key, false)
  }
}

async function deleteSfx(item) {
  const name = filename(item.path)
  if (!globalThis.confirm(`确定删除音效「${name}」？\n文件会从本地音效库中移除。`)) return
  const key = assetKey('sfx', item)
  markDeleting(key, true)
  try {
    await libraryAPI.deleteSfx(item.path)
    sfxItems.value = sfxItems.value.filter(entry => entry.path !== item.path)
    toast.success('音效已删除')
  } catch (e) {
    toast.error(e.message)
  } finally {
    markDeleting(key, false)
  }
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
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
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
.head-actions { display: flex; gap: 10px; }

.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}
.tab {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.tab:hover { background: var(--bg-hover); color: var(--text-0); }
.tab.active {
  background: var(--accent-bg);
  color: var(--accent-text);
  border-color: rgba(76,125,255,0.18);
  font-weight: 600;
}
.tab-count {
  font-size: 10px; font-weight: 600;
  padding: 2px 6px; border-radius: 99px;
  background: var(--bg-3); color: var(--text-3);
}
.tab.active .tab-count { background: rgba(76,125,255,0.12); color: var(--accent-text); }

.filters {
  display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
}
.search-input { flex: 1; min-width: 240px; }
.filters .input { max-width: 180px; }

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
.asset-card {
  display: flex; flex-direction: column;
  padding: 16px; gap: 12px;
}
.asset-header {
  display: flex; justify-content: space-between; align-items: center;
  gap: 10px;
}
.asset-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.asset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-1);
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-0);
  border-color: var(--border-strong);
}
.icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.danger-btn:hover:not(:disabled) {
  color: var(--error);
  border-color: rgba(210, 79, 102, 0.32);
  background: var(--error-bg);
}
.tag {
  font-size: 10px; font-weight: 600;
  padding: 3px 8px; border-radius: 99px;
  background: var(--bg-2); color: var(--text-3);
  border: 1px solid var(--border);
  text-transform: uppercase;
}
.tag-emotion { background: var(--accent-bg); color: var(--accent-text); border-color: rgba(184,120,20,0.12); }
.tag-intensity { background: var(--bg-2); color: var(--text-2); text-transform: capitalize; }
.tag-minimax { background: rgba(76,125,255,0.08); color: var(--accent-text); }
.tag-freepack { background: rgba(129,199,132,0.08); color: #81c784; }
.tag-local { background: rgba(16,185,129,0.08); color: #10b981; }
.asset-tags-list { display: flex; flex-wrap: wrap; gap: 5px; }
.asset-tag { font-size: 10px; padding: 1px 6px; border-radius: 99px; background: rgba(255,255,255,0.06); color: var(--text-3); }
.asset-duration { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.asset-body { display: flex; flex-direction: column; gap: 10px; }
.asset-name {
  font-size: 13px; font-weight: 600; color: var(--text-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.asset-prompt {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.asset-player { width: 100%; height: 32px; margin-top: 4px; }

.asset-list {
  display: flex; flex-direction: column; gap: 10px;
}
.asset-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; gap: 16px;
}
.row-main {
  display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;
}
.row-pack {
  font-size: 10px; font-weight: 600;
  padding: 2px 8px; border-radius: 99px;
  background: var(--accent-bg); color: var(--accent-text);
  white-space: nowrap;
}
.row-name {
  font-size: 13px; font-weight: 500; color: var(--text-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 120px; max-width: 260px;
}
.row-keywords {
  font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.row-player { width: 280px; height: 28px; flex-shrink: 0; }

.empty-state {
  padding: 40px; text-align: center; color: var(--text-3); font-size: 13px;
}

.loading-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
.skeleton-card {
  height: 160px;
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-hover) 50%, var(--bg-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border: none;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
