<template>
  <div class="factory-surface production-list">
    <header class="factory-header">
      <div><h1>历史视频制作</h1><p>从已确认的文稿出发，自动选取本地素材、补齐画面并交付成片。</p></div>
      <div class="factory-actions"><button class="btn" :aria-expanded="showStyles" @click="showStyles = !showStyles"><Palette :size="15" />画面风格</button><NuxtLink class="btn btn-primary" to="/history-scripts"><Plus :size="15" />从稿件开始</NuxtLink></div>
    </header>
    <section v-if="showStyles" class="factory-style-section"><StyleLibrary :projects="projects" /></section>
    <section aria-label="制作任务">
      <div class="factory-toolbar">
        <div class="status-filters" aria-label="按状态筛选"><button v-for="item in filters" :key="item.id" :aria-pressed="status === item.id" :class="{active:status === item.id}" @click="status = item.id">{{ item.label }}<span>{{ counts[item.id] }}</span></button></div>
        <button class="btn btn-sm" :disabled="loading" @click="refresh"><RefreshCw :size="14" />刷新</button>
      </div>
      <div class="factory-filters"><div class="factory-search"><Search :size="15" /><input v-model="query" aria-label="搜索制作任务" placeholder="搜索标题、项目或集数" /></div><select v-model="project" aria-label="筛选项目"><option value="">全部项目</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.title }}</option></select><select v-model="account" aria-label="筛选账号"><option value="">全部账号</option><option v-for="name in accounts" :key="name" :value="name">{{ name }}</option></select></div>
      <div v-if="error" class="factory-notice error" role="alert">{{ error }}<span v-if="loaded">，以下保留上次读取的记录。</span><button class="text-button" @click="refresh">重新读取</button></div>
      <div v-if="deleteError" class="factory-notice error" role="alert">{{ deleteError }}</div>
      <div v-if="loading && !loaded" class="factory-skeleton" role="status" aria-label="正在读取制作任务"><div v-for="n in 4" :key="n"></div></div>
      <div v-else-if="!visible.length" class="factory-empty"><Film :size="26" /><h2>{{ items.length ? '没有匹配的任务' : '从一篇现成稿件开始' }}</h2><p>{{ items.length ? '调整搜索或筛选条件，查看其他制作记录。' : '在历史稿件中选择“精细化制作”，任务与成片会保留在这里。' }}</p><button v-if="items.length" class="btn" @click="clearFilters">清除筛选</button><NuxtLink v-else class="btn" to="/history-scripts">选择稿件</NuxtLink></div>
      <div v-else class="production-table-wrap">
        <table class="production-table"><thead><tr><th>作品</th><th>当前进度</th><th>镜头</th><th>更新时间</th><th><span class="factory-sr-only">操作</span></th></tr></thead><tbody>
          <tr v-for="item in paginated" :key="item.episodeId"><td><div class="production-identity"><strong>Episode {{ item.episodeId }}</strong><span v-if="item.episodeNumber > 1">第 {{ item.episodeNumber }} 集</span><NuxtLink v-if="item.sourceId" class="production-source" :to="{ path: '/history-scripts', query: { view: 'library', script: String(item.sourceId) } }">来源稿件 #{{ item.sourceId }}</NuxtLink></div><NuxtLink class="production-title" :to="`/remotion/episode/${item.episodeId}`">{{ item.title || `第 ${item.episodeNumber} 集` }}</NuxtLink><div class="production-meta">{{ item.dramaTitle }}<span v-if="item.accountName"> · {{ item.accountName }}</span></div></td><td><span class="factory-status" :class="productionTone(item.status)">{{ item.jobId ? productionStatus(item.status) : item.videoUrl ? '已有成片' : '尚未开始' }}</span><div class="production-message">{{ item.message || (item.videoUrl ? '打开工作详情查看成片' : '可继续使用现有文稿制作') }}</div></td><td class="production-shot-count">{{ item.shotCount ? `${item.readyShotCount || 0} / ${item.shotCount}` : '待分镜' }}</td><td class="production-time">{{ productionDate(item.updatedAt) }}</td><td><div class="production-row-actions"><NuxtLink class="btn btn-sm" :to="`/remotion/episode/${item.episodeId}`">工作详情<ArrowRight :size="13" /></NuxtLink><button type="button" class="btn btn-sm production-delete" :aria-label="`删除制作任务 Episode ${item.episodeId}`" :title="!deletionSupported ? '删除功能待后端更新' : productionRunning(item.status) ? '制作中或排队的任务暂不能删除' : '删除制作任务'" :disabled="!deletionSupported || deletingId !== null || productionRunning(item.status)" @click="removeProduction(item)"><LoaderCircle v-if="deletingId === item.episodeId" :size="15" class="spin" /><Trash2 v-else :size="15" /></button></div></td></tr>
        </tbody></table>
      </div>
      <footer v-if="visible.length" class="factory-pagination"><span>共 {{ visible.length }} 集</span><div><button class="btn btn-sm" :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button class="btn btn-sm" :disabled="page >= pages" @click="page++">下一页</button></div></footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowRight, Film, LoaderCircle, Palette, Plus, RefreshCw, Search, Trash2 } from 'lucide-vue-next'
import StyleLibrary from '~/components/remotion/StyleLibrary.vue'
import { historyProductionAPI, productionDate, productionRunning, productionStatus, productionTone, type HistoryProductionItem } from '~/composables/useHistoryProduction'
import '~/assets/remotion-workspace.css'
const items = ref<HistoryProductionItem[]>([]), loading = ref(false), loaded = ref(false), error = ref('')
const deletingId = ref<number | null>(null), deleteError = ref(''), deletionSupported = ref(false)
const showStyles = ref(false), query = ref(''), project = ref<number | ''>(''), account = ref(''), status = ref('all'), page = ref(1)
const filters = [{id:'all',label:'全部'},{id:'running',label:'制作中'},{id:'attention',label:'待处理'},{id:'complete',label:'已有成片'}]
const projects = computed(() => [...new Map(items.value.map(i => [i.dramaId,{id:i.dramaId,title:i.dramaTitle}])).values()])
const accounts = computed(() => [...new Set(items.value.map(i => i.accountName).filter(Boolean))] as string[])
const matches = (item: HistoryProductionItem, key: string) => key === 'all' || (key === 'running' && productionRunning(item.status)) || (key === 'attention' && ['failed','needs_review'].includes(item.status)) || (key === 'complete' && !!item.videoUrl)
const counts = computed(() => Object.fromEntries(filters.map(f => [f.id,items.value.filter(i => matches(i,f.id)).length])))
const visible = computed(() => items.value.filter(i => matches(i,status.value) && (!project.value || i.dramaId === Number(project.value)) && (!account.value || i.accountName === account.value) && (!query.value.trim() || `${i.title} ${i.dramaTitle} ${i.episodeNumber}`.toLowerCase().includes(query.value.trim().toLowerCase()))))
const pages = computed(() => Math.max(1,Math.ceil(visible.value.length / 20)))
const paginated = computed(() => visible.value.slice((page.value - 1)*20,page.value*20))
let poll: ReturnType<typeof setTimeout> | undefined, disposed = false, changeVersion = 0
async function refresh() { if (loading.value || deletingId.value !== null) return; const version = changeVersion; loading.value = true; try { const result = await historyProductionAPI.list(); if (disposed || version !== changeVersion) return; items.value = result.items; deletionSupported.value = result.deletionSupported === true; error.value = ''; loaded.value = true; page.value = Math.min(page.value,pages.value) } catch(e:any) { if (!disposed && version === changeVersion) error.value = e.message || '读取制作任务失败' } finally { loading.value = false; clearTimeout(poll); if (!disposed) poll = setTimeout(refresh,12000) } }
async function removeProduction(item: HistoryProductionItem) {
  if (!deletionSupported.value || deletingId.value !== null || productionRunning(item.status)) return
  if (!window.confirm(`删除制作任务 Episode ${item.episodeId}“${item.title || `第 ${item.episodeNumber} 集`}”？\n\n任务将从制作列表移除，原稿、成片文件和发布记录保留。`)) return
  deletingId.value = item.episodeId; deleteError.value = ''; changeVersion++; clearTimeout(poll)
  try {
    const result = await historyProductionAPI.remove(item.episodeId)
    if (result.deleted !== true || result.episodeId !== item.episodeId) throw Error('删除结果未确认，请刷新列表核对')
    if (disposed) return
    items.value = items.value.filter(value => value.episodeId !== item.episodeId)
    page.value = Math.min(page.value,pages.value)
  } catch(e:any) { if (!disposed) deleteError.value = e.message || '删除制作任务失败，原记录已保留' }
  finally { deletingId.value = null; if (!disposed) {clearTimeout(poll); poll = setTimeout(refresh,12000)} }
}
function clearFilters() { query.value = ''; project.value = ''; account.value = ''; status.value = 'all' }
watch([query,project,account,status],() => {page.value = 1})
onMounted(refresh)
onUnmounted(() => {disposed = true; clearTimeout(poll)})
</script>
