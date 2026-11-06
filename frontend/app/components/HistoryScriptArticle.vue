<template>
  <section class="article-panel" aria-label="微信公众号文章">
    <header><h2>微信公众号文章</h2><button type="button" class="btn btn-sm" :disabled="loading || submitting" @click="load"><RefreshCw :size="15" />刷新文章</button></header>
    <div class="article-actions">
      <button type="button" class="btn btn-primary" :disabled="busy || loading || !state?.canGenerate" @click="generate"><Newspaper :size="16" />{{ phase === 'queued' ? '等待生成…' : busy ? '正在改写与排版…' : article ? '重新生成公众号文章' : '生成公众号文章' }}</button>
    </div>
    <p v-if="loading && !state" role="status">正在读取文章…</p>
    <p v-if="state?.unavailableReason && !busy" class="hint">{{ state.unavailableReason }}</p>
    <p v-if="busy" role="status">{{ phase === 'queued' ? '成片已关联，文章等待生成。' : '正在生成公众号文章。' }}</p>
    <p v-if="error || generationError" class="error" role="alert">{{ error || generationError }}</p>
    <p v-if="state?.stale" class="warning" role="status">文章需要重新生成后才能复制或导出。{{ state.staleReasons?.join('；') }}</p>
    <template v-if="article">
      <div class="article-result-head"><div><h3>{{ article.title }}</h3><p class="hint">正文 {{ article.articleLength }} 字 · {{ article.screenshots.length }} 张配图</p></div></div>
      <div class="article-actions">
        <button type="button" class="btn" :disabled="state?.stale || busy || copying" @click="copyArticle"><Copy :size="15" />{{ copying ? '复制中…' : '复制到公众号' }}</button>
        <a v-if="!state?.stale && !busy" class="btn" :href="`${base}/export?format=html`" download><Download :size="15" />下载图文 HTML</a>
        <a v-if="!state?.stale && !busy" class="btn" :href="`${base}/export?format=markdown`" download><Download :size="15" />下载 Markdown</a>
        <button type="button" class="btn btn-sm" :aria-pressed="showText" @click="showText = !showText"><FileText :size="15" />{{ showText ? '查看排版' : '查看文字' }}</button>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <details v-if="article.notices?.length" class="generation-notes"><summary>生成记录</summary><p v-for="message in article.notices" :key="message" class="hint">{{ message }}</p></details>
      <pre v-if="showText" class="article-text">{{ article.markdown }}</pre>
      <iframe v-else title="公众号文章排版预览" class="article-preview" sandbox="" :srcdoc="preview" />
      <details class="article-images"><summary>配图与截取时间（仅供编辑核对，{{ article.screenshots.length }} 张）</summary><div class="image-grid"><figure v-for="shot in article.screenshots" :key="shot.url"><a :href="shot.url" target="_blank" rel="noopener"><img :src="shot.url" loading="lazy" :alt="`配图，截取时间 ${timestamp(shot.timestamp)}`" /></a><figcaption>{{ timestamp(shot.timestamp) }}</figcaption></figure></div></details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { Copy, Download, FileText, Newspaper, RefreshCw } from 'lucide-vue-next'

interface Article {
  title: string; markdown: string; html: string; sourceLength: number; articleLength: number
  screenshots: { url: string; timestamp: number; sectionIndex: number }[]; notices?: string[]
}
interface ArticleState {
  status: 'idle' | 'queued' | 'generating' | 'completed' | 'failed'; error: string | null; article: Article | null
  stale: boolean; staleReasons: string[]; canGenerate: boolean; unavailableReason: string | null
  articleGeneration?: { status: 'queued' | 'generating' | 'completed' | 'failed'; message: string } | null
}
const props = defineProps<{ scriptId: number | string; scriptRevision?: string; videoRevision?: number }>()
const base = computed(() => `/api/v1/history-scripts/${props.scriptId}/article`)
const state = ref<ArticleState | null>(null)
const article = computed(() => state.value?.article)
const loading = ref(false)
const submitting = ref(false)
const copying = ref(false)
const phase = computed(() => state.value?.status === 'generating' ? 'generating'
  : ['queued', 'generating'].includes(state.value?.articleGeneration?.status || '') ? state.value!.articleGeneration!.status
    : state.value?.status)
const busy = computed(() => submitting.value || ['queued', 'generating'].includes(phase.value || ''))
const generationError = computed(() => busy.value ? '' : state.value?.error
  || (state.value?.articleGeneration?.status === 'failed' ? state.value.articleGeneration.message : ''))
const showText = ref(false)
const error = ref('')
const notice = ref('')
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let reading = false
const preview = computed(() => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:12px;background:#fff">${article.value?.html || ''}</body></html>`)
function timestamp(seconds: number) { return `${Math.floor(seconds / 60)}：${String(Math.floor(seconds % 60)).padStart(2, '0')}` }
async function request(method = 'GET', body?: unknown): Promise<ArticleState> {
  const response = await fetch(base.value, { method, signal: controller?.signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  let result
  try { result = await response.json() }
  catch (err: any) {
    if (err.name === 'AbortError') throw err
    throw new Error(`文章服务响应不完整或格式无效（HTTP ${response.status}），请点击“刷新文章”确认任务状态。`)
  }
  if (!result || typeof result !== 'object') throw new Error('文章服务响应格式无效，请点击“刷新文章”确认任务状态。')
  if (!response.ok || result.code >= 400) throw new Error(result.message || '文章请求失败')
  if (!['idle', 'queued', 'generating', 'completed', 'failed'].includes(result.data?.status)) throw new Error('文章状态读取失败，请刷新重试')
  return result.data
}
function accept(data: ArticleState) {
  state.value = data
  clearTimeout(timer)
  if (['queued', 'generating'].includes(phase.value || '')) timer = setTimeout(load, 2500)
}
async function load() {
  if (reading || submitting.value) return
  const current = generation
  reading = true; loading.value = true
  try { const data = await request(); if (current === generation) { error.value = ''; accept(data); return true } }
  catch (err: any) {
    if (current !== generation || err.name === 'AbortError') return
    error.value = err.message
    if (['queued', 'generating'].includes(phase.value || '')) timer = setTimeout(load, 6000)
  } finally { if (current === generation) { reading = false; loading.value = false } }
}
async function generate() {
  if (busy.value || loading.value || !state.value?.canGenerate) return
  const current = generation
  submitting.value = true; error.value = ''; notice.value = ''
  let needsRefresh = false
  try { const data = await request('POST', {}); if (current === generation) accept(data) }
  catch (err: any) {
    if (current === generation && err.name !== 'AbortError') {
      error.value = err.message
      needsRefresh = true
    }
  } finally {
    if (current === generation) {
      submitting.value = false
      // A lost response or another tab may already have started the job.
      // Read its status without repeating the paid generation request.
      if (needsRefresh) {
        const message = error.value
        const refreshed = await load()
        if (current === generation && refreshed && !generationError.value && !['queued', 'generating', 'completed'].includes(phase.value || '')) error.value = message
      }
    }
  }
}
async function copyArticle() {
  if (!article.value || state.value?.stale || busy.value || copying.value) return
  const current = generation
  copying.value = true; notice.value = ''; error.value = ''
  try {
    if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('浏览器不支持富文本复制，请下载图文 HTML 后打开并复制正文。')
    const html = fetch(`${base.value}/export?format=html`, { signal: controller?.signal }).then(async response => {
      if (!response.ok) throw new Error('图文读取失败，请刷新后重试')
      return new Blob([await response.text()], { type: 'text/html' })
    })
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': new Blob([article.value.markdown], { type: 'text/plain' }) })])
    if (current === generation) notice.value = '图文已复制，可粘贴到公众号编辑器。发布前请确认图片已上传并检查正文。'
  } catch (err: any) { if (current === generation && err.name !== 'AbortError') error.value = err.message || '复制失败，请下载图文 HTML' }
  finally { if (current === generation) copying.value = false }
}
function reset(clear: boolean) {
  generation++; controller?.abort(); clearTimeout(timer)
  controller = new AbortController(); reading = false; submitting.value = false; copying.value = false
  error.value = ''; notice.value = ''
  if (clear) { state.value = null; showText.value = false }
  load()
}
watch(() => props.scriptId, () => reset(true), { immediate: true })
watch(() => [props.scriptRevision, props.videoRevision], () => { if (!submitting.value && !copying.value) reset(false) })
onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
</script>

<style scoped>
.article-panel { border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin: 16px 20px; background: var(--bg-0); min-width: 0; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 16px; line-height: 1.6; margin: 16px 0 4px; overflow-wrap: anywhere; }
header p, .hint { color: var(--text-secondary); font-size: 12px; line-height: 1.7; }
.article-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
.article-preview { display: block; width: 100%; height: 680px; border: 1px solid var(--border); border-radius: 8px; background: white; }
.article-text { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 17px; line-height: 1.9; max-height: 680px; overflow-y: auto; padding: 16px; }
.article-images { margin-top: 16px; } summary { cursor: pointer; font-size: 13px; }
.generation-notes { margin: 12px 0; }
.image-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
figure { margin: 0; min-width: 0; } img { width: 100%; border-radius: 6px; } figcaption { font-size: 12px; color: var(--text-secondary); text-align: center; }
.error { color: var(--error, #b91c1c); } .warning { color: #9a4c08; }
@media (max-width: 640px) { .article-panel { margin: 12px; padding: 14px; } header { flex-wrap: wrap; } .article-preview { height: 560px; } }
</style>
