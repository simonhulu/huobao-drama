<template>
  <section class="voice-library" aria-labelledby="voice-library-title">
    <header class="voice-head">
      <div><h2 id="voice-library-title">{{ selectedConfig ? `${providerName} 音色` : '音色库' }}</h2><p>选择声音，试听，再设为解说默认。默认音色用于新制作，不会替换已有配音母带。</p></div>
      <button class="btn" :disabled="loading || configsLoading || !configId" @click="loadVoices"><RefreshCw :size="14" />{{ loading ? '读取中…' : '刷新音色' }}</button>
    </header>

    <div v-if="configsLoading" class="voice-skeleton" role="status" aria-label="正在读取音频配置"><div v-for="n in 3" :key="n"></div></div>
    <div v-else-if="configError" class="voice-notice error" role="alert"><span>{{ configError }}</span><button class="btn btn-sm" @click="loadConfigs">重试</button></div>
    <div v-else-if="!configs.length" class="voice-empty"><h3>先连接音频服务</h3><p>启用 MiniMax 或阿里云百炼音频配置后，即可读取账号中的音色。</p><NuxtLink class="btn" to="/settings">配置音频服务</NuxtLink></div>
    <template v-else>
      <div class="voice-account">
        <label for="voice-config">音频配置<select id="voice-config" v-model="configId" class="input" :disabled="!!savingDefault" @change="changeConfig"><option v-for="config in configs" :key="config.id" :value="config.id">{{ config.name || `音频 #${config.id}` }} · {{ providerLabel(config.provider) }}{{ config.settings.useForNarration ? ' · 解说' : '' }}</option></select></label>
        <div class="voice-current"><span>{{ defaultRestartRequired ? '已保存解说默认' : '当前解说默认' }}</span><strong>{{ defaultName || '尚未设置' }}</strong></div>
      </div>
      <p v-if="defaultRestartRequired" class="voice-restart-note">音色试听可直接使用。新默认音色将在制作服务重启后生效。</p>
      <div v-if="loadError" class="voice-notice error" role="alert"><span>{{ loadError }}{{ voices.length ? '，以下保留上次读取的列表。' : '' }}</span><button class="btn btn-sm" :disabled="loading" @click="loadVoices">重新读取</button></div>
      <p v-if="saveMessage" class="voice-success" role="status">{{ saveMessage }}</p>

      <div class="voice-filters">
        <label class="voice-search"><Search :size="15" /><input v-model="query" type="search" placeholder="搜索名称、描述或 Voice ID" aria-label="搜索音色" /></label>
        <select v-model="typeFilter" class="input" aria-label="音色来源"><option value="">全部音色 · {{ voices.length }}</option><option value="system">系统音色 · {{ counts.system }}</option><option value="mine">我的音色 · {{ counts.voice_generation + counts.voice_cloning }}</option></select>
        <select v-model="languageFilter" class="input" aria-label="音色语言"><option value="">全部语言 · 中文优先</option><option v-for="language in languages" :key="language" :value="language">{{ language }}</option></select>
      </div>
      <div class="voice-list-meta"><span>{{ filtered.length }} 个音色<span v-if="fetchedAt"> · {{ formatTime(fetchedAt) }} 更新</span></span><details><summary>统一试听文稿</summary><p>{{ previewText }}</p><p>点击“试听”时生成，重复试听复用缓存。</p></details></div>

      <div v-if="loading && !voices.length" class="voice-skeleton" role="status" :aria-label="`正在从${providerName}读取音色`"><div v-for="n in 5" :key="n"></div></div>
      <div v-else-if="!filtered.length" class="voice-empty"><h3>{{ voices.length ? '没有匹配的音色' : loadError ? '暂时无法读取音色' : '当前账号没有返回音色' }}</h3><p>{{ voices.length ? '试试其他关键词、来源或语言。' : '确认所选音频配置后，点击“刷新音色”重新读取。' }}</p><button v-if="voices.length" class="btn" @click="clearFilters">清除筛选</button></div>
      <ul v-else class="voice-list" aria-label="可用音色">
        <li v-for="voice in paginated" :key="voice.voice_id" class="voice-row" :class="{ selected: currentVoice?.voice_id === voice.voice_id }">
          <div class="voice-info"><div class="voice-name"><h3>{{ voice.voice_name || voice.voice_id }}</h3><span class="voice-label">{{ languageOf(voice) }}</span><span v-if="voice.voice_type !== 'system'" class="voice-label">{{ voice.voice_type === 'voice_cloning' ? '我的复刻' : '我的设计' }}</span><span v-if="voice.voice_id === defaultVoiceId" class="voice-default"><Check :size="12" />{{ defaultRestartRequired ? '已保存默认' : '解说默认' }}</span></div><p v-if="voice.description.length" class="voice-description">{{ voice.description.join('；') }}</p><code class="voice-id">{{ voice.voice_id }}</code></div>
          <div class="voice-actions"><button class="btn btn-sm" :disabled="loading" :aria-label="`${previewLoading === voice.voice_id ? '取消等待' : '试听'} ${voice.voice_name || voice.voice_id}`" @click="previewVoice(voice)"><Loader2 v-if="previewLoading === voice.voice_id" :size="13" class="spin" /><Square v-else-if="currentVoice?.voice_id === voice.voice_id && playing" :size="13" /><Play v-else :size="13" />{{ previewLoading === voice.voice_id ? '取消等待' : currentVoice?.voice_id === voice.voice_id && playing ? '停止' : '试听' }}</button><button class="btn btn-sm" :disabled="!!savingDefault || loading || voice.voice_id === defaultVoiceId" @click="setDefault(voice)">{{ savingDefault === voice.voice_id ? '保存中…' : voice.voice_id === defaultVoiceId ? defaultRestartRequired ? '已保存默认' : '当前默认' : '设为解说默认' }}</button></div>
          <p v-if="previewLoading === voice.voice_id" class="voice-row-status" role="status">正在生成试听音频，最长等待 60 秒。</p>
          <p v-if="rowError?.voiceId === voice.voice_id" class="voice-row-error" role="alert">{{ rowError.message }}</p>
        </li>
      </ul>
      <footer v-if="filtered.length" class="voice-pagination"><span>{{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, filtered.length) }} / {{ filtered.length }}</span><div><button class="btn btn-sm" :disabled="page === 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button class="btn btn-sm" :disabled="page === pages" @click="page++">下一页</button></div></footer>
      <section v-if="currentVoice && previewUrl" class="voice-player" aria-label="音色试听播放器"><div><strong>{{ currentVoice.voice_name || currentVoice.voice_id }}</strong><span>{{ playerMessage || '统一文稿试听' }}</span></div><audio ref="player" :src="previewUrl" controls preload="auto" @loadedmetadata="playbackReady" @canplay="playbackReady" @play="playing = true" @pause="playing = false" @ended="playing = false" @error="playbackFailed()" /><button class="btn btn-sm" @click="stopPreview(true)">关闭试听</button></section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Loader2, Play, RefreshCw, Search, Square } from 'lucide-vue-next'
import { aiConfigAPI, voicesAPI } from '~/composables/useApi'

type Voice = { voice_id: string; voice_name: string; description: string[]; language: string; voice_type: string; provider: string }
type AudioConfig = { id: number; name: string; provider: string; model: string; priority?: number; settings: Record<string, any> }
const emit = defineEmits<{ count: [value: number | null] }>()
const configs = ref<AudioConfig[]>([]), configId = ref<number | null>(null), configsLoading = ref(true), configError = ref('')
const voices = ref<Voice[]>([]), loading = ref(false), loadError = ref(''), fetchedAt = ref(''), defaultVoiceId = ref('')
const defaultRestartRequired = ref(false)
const counts = ref({ system: 0, voice_generation: 0, voice_cloning: 0 })
const query = ref(''), typeFilter = ref(''), languageFilter = ref(''), page = ref(1), pageSize = 24
const previewText = '公元前二百六十年，秦赵两军在长平对峙。一次换将，改变了战局，也改变了无数人的命运。'
const currentVoice = ref<Voice | null>(null), previewUrl = ref(''), player = ref<HTMLAudioElement | null>(null), playing = ref(false), playerMessage = ref('')
const previewLoading = ref(''), savingDefault = ref(''), saveMessage = ref(''), rowError = ref<{ voiceId: string; message: string } | null>(null)
const previewCache = new Map<string, string>()
let listRequest = 0, previewRequest = 0, disposed = false
let previewAbort: AbortController | undefined
let mediaLoadTimer: ReturnType<typeof setTimeout> | undefined
const selectedConfig = computed(() => configs.value.find(config => config.id === configId.value))
const providerName = computed(() => providerLabel(selectedConfig.value?.provider))
const defaultName = computed(() => voices.value.find(voice => voice.voice_id === defaultVoiceId.value)?.voice_name || defaultVoiceId.value)

function providerLabel(provider?: string) { return provider === 'qwen-tts' ? '阿里云百炼' : 'MiniMax' }

function languageOf(voice: Voice) {
  const language = voice.language?.trim() || ''
  if (language) return language
  if (/cantonese/i.test(voice.voice_id)) return '粤语'
  if (/mandarin/i.test(voice.voice_id)) return '普通话'
  return /^Chinese[_ (]/i.test(voice.voice_id) ? '中文' : '未标注语言'
}
const chineseLanguages = new Set(['中文', '普通话', '粤语', '汉语', '四川话', '东北话', '闽南语', '上海话', '中文（普通话）', '中文（粤语）', 'Chinese', 'Mandarin', 'Cantonese', 'Chinese (Mandarin)', 'Chinese (Cantonese)', 'zh', 'zh-CN', 'zh-TW', 'zh-HK'])
const languages = computed(() => [...new Set(voices.value.map(languageOf))].sort((a, b) => Number(chineseLanguages.has(b)) - Number(chineseLanguages.has(a)) || a.localeCompare(b, 'zh-CN')))
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return voices.value.filter(voice => (!typeFilter.value || (typeFilter.value === 'system' ? voice.voice_type === 'system' : voice.voice_type !== 'system'))
    && (!languageFilter.value || languageOf(voice) === languageFilter.value)
    && (!keyword || [voice.voice_name, voice.voice_id, ...voice.description].join(' ').toLowerCase().includes(keyword)))
    .sort((a, b) => Number(chineseLanguages.has(languageOf(b))) - Number(chineseLanguages.has(languageOf(a))) || Number(b.voice_id === defaultVoiceId.value) - Number(a.voice_id === defaultVoiceId.value) || (a.voice_name || a.voice_id).localeCompare(b.voice_name || b.voice_id, 'zh-CN'))
})
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const paginated = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([query, typeFilter, languageFilter], () => { page.value = 1 })
function clearFilters() { query.value = ''; typeFilter.value = ''; languageFilter.value = '' }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function parseSettings(value: unknown) { try { return typeof value === 'string' ? JSON.parse(value) : value || {} } catch { return {} } }

async function loadConfigs() {
  configsLoading.value = true; configError.value = ''
  try {
    const rows = await aiConfigAPI.list('audio')
    if (disposed) return
    configs.value = (rows || []).filter((row: any) => ['minimax', 'qwen-tts'].includes(row.provider?.toLowerCase()) && (row.is_active ?? row.isActive))
      .map((row: any) => ({ ...row, id: Number(row.id), provider: row.provider.toLowerCase(), settings: parseSettings(row.settings) }))
      .sort((a: AudioConfig, b: AudioConfig) => Number(!!b.settings.useForNarration) - Number(!!a.settings.useForNarration) || (b.priority || 0) - (a.priority || 0))
    configId.value = configs.value[0]?.id || null
    configsLoading.value = false
    if (configId.value) await loadVoices()
  } catch (error: any) { if (!disposed) configError.value = `读取音频配置失败：${error.message || '请重试'}` }
  finally { if (!disposed) configsLoading.value = false }
}

async function loadVoices() {
  if (!configId.value) return
  const request = ++listRequest, requestedConfig = configId.value, requestedProvider = selectedConfig.value?.provider
  loading.value = true; loadError.value = ''
  try {
    const result = await voicesAPI.available(requestedConfig)
    if (disposed || request !== listRequest || configId.value !== requestedConfig) return
    voices.value = (result.voices || []).filter((voice: Voice) => voice.provider?.toLowerCase() === requestedProvider)
      .map((voice: Voice) => ({ ...voice, description: Array.isArray(voice.description) ? voice.description : [] }))
    counts.value = { system: 0, voice_generation: 0, voice_cloning: 0 }
    for (const voice of voices.value) {
      if (voice.voice_type in counts.value) counts.value[voice.voice_type as keyof typeof counts.value]++
    }
    defaultVoiceId.value = result.default_voice_id || ''
    defaultRestartRequired.value = result.default_restart_required === true
    fetchedAt.value = result.fetched_at || ''
    page.value = Math.min(page.value, pages.value)
    emit('count', voices.value.length)
  } catch (error: any) { if (!disposed && request === listRequest) loadError.value = `读取${providerLabel(requestedProvider)}音色失败：${error.message || '请重试'}` }
  finally { if (!disposed && request === listRequest) loading.value = false }
}

function changeConfig() {
  cancelPreviewWait(); stopPreview(true); rowError.value = null; saveMessage.value = ''
  voices.value = []; fetchedAt.value = ''; defaultVoiceId.value = ''; counts.value = { system: 0, voice_generation: 0, voice_cloning: 0 }
  defaultRestartRequired.value = false
  page.value = 1; emit('count', null); clearFilters(); loadVoices()
}
function cacheKey(voice: Voice) { return `voice-library-preview:${JSON.stringify([configId.value, selectedConfig.value?.model, voice.voice_id, previewText])}` }
function cachedPreview(key: string) { try { return previewCache.get(key) || sessionStorage.getItem(key) || '' } catch { return previewCache.get(key) || '' } }
function rememberPreview(key: string, url: string) { previewCache.set(key, url); try { sessionStorage.setItem(key, url) } catch {} }
function cancelPreviewWait() {
  ++previewRequest; previewAbort?.abort(); previewAbort = undefined; previewLoading.value = ''
}
function stopPreview(clear = false) {
  clearTimeout(mediaLoadTimer)
  player.value?.pause(); playing.value = false
  if (clear) {
    currentVoice.value = null; previewUrl.value = ''; playerMessage.value = ''
    player.value?.removeAttribute('src'); player.value?.load()
  }
}
async function previewVoice(voice: Voice) {
  if (!configId.value) return
  if (previewLoading.value === voice.voice_id) { cancelPreviewWait(); return }
  if (currentVoice.value?.voice_id === voice.voice_id && playing.value) { stopPreview(); return }
  cancelPreviewWait()
  stopPreview(true); rowError.value = null
  const request = ++previewRequest, requestedConfig = configId.value, key = cacheKey(voice)
  const controller = new AbortController()
  previewAbort = controller
  previewLoading.value = voice.voice_id
  try {
    let url = cachedPreview(key)
    if (!url) {
      const result = await voicesAPI.preview({ voice_id: voice.voice_id, config_id: requestedConfig, text: previewText }, controller.signal)
      if (!result.audio_url) throw new Error('接口未返回试听音频')
      url = /^(?:https?:\/\/|\/)/.test(result.audio_url) ? result.audio_url : `/${result.audio_url}`
      rememberPreview(key, url)
    }
    if (disposed || request !== previewRequest || requestedConfig !== configId.value) return
    currentVoice.value = voice; previewUrl.value = url; previewLoading.value = ''; previewAbort = undefined
    await nextTick()
    if (disposed || request !== previewRequest) return
    if (player.value && player.value.readyState < 2) {
      playerMessage.value = '正在加载试听音频…'
      player.value.load()
      mediaLoadTimer = setTimeout(() => {
        if (!disposed && request === previewRequest) playbackFailed('试听音频加载超时，请重新试听。')
      }, 15_000)
    }
    void player.value?.play().catch(() => {
      if (!disposed && request === previewRequest && currentVoice.value) playerMessage.value = '音频已就绪，点击播放即可试听。'
    })
  } catch (error: any) {
    if (!disposed && request === previewRequest) rowError.value = { voiceId: voice.voice_id,
      message: error.name === 'TimeoutError' ? '试听生成超时，请稍后重新试听；若持续失败，请检查音频服务或更换音色。' : `试听失败：${error.message || '请重试'}` }
  } finally { if (!disposed && request === previewRequest) { previewLoading.value = ''; previewAbort = undefined } }
}
function playbackReady() { clearTimeout(mediaLoadTimer); playerMessage.value = '' }
function playbackFailed(message = '试听文件无法播放，请再次点击“试听”重新生成。') {
  if (!currentVoice.value) return
  const voice = currentVoice.value, key = cacheKey(voice)
  previewCache.delete(key); try { sessionStorage.removeItem(key) } catch {}
  rowError.value = { voiceId: voice.voice_id, message }
  stopPreview(true)
}
async function setDefault(voice: Voice) {
  if (!configId.value || savingDefault.value || voice.voice_id === defaultVoiceId.value) return
  const requestedConfig = configId.value
  savingDefault.value = voice.voice_id; rowError.value = null; saveMessage.value = ''
  try {
    const result = await voicesAPI.setDefault({ config_id: requestedConfig, voice_id: voice.voice_id })
    if (disposed || requestedConfig !== configId.value) return
    defaultVoiceId.value = result.voice_id
    defaultRestartRequired.value = result.default_restart_required === true
    saveMessage.value = defaultRestartRequired.value
      ? `已保存“${voice.voice_name || voice.voice_id}”为解说默认，将在制作服务重启后生效。已有配音母带保持不变。`
      : `已将“${voice.voice_name || voice.voice_id}”设为新制作的解说默认，已有配音母带保持不变。`
  } catch (error: any) { if (!disposed && requestedConfig === configId.value) rowError.value = { voiceId: voice.voice_id, message: `设置默认音色失败：${error.message || '请重试'}` } }
  finally { if (!disposed) savingDefault.value = '' }
}
onMounted(loadConfigs)
onBeforeUnmount(() => { disposed = true; ++listRequest; cancelPreviewWait(); stopPreview(true) })
</script>

<style scoped>
.voice-library { color: var(--text-1); }
.voice-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin: 26px 0 22px; }
.voice-head h2 { margin: 0 0 8px; color: var(--text-0); font-size: 18px; font-weight: 650; }
.voice-head p { margin: 0; max-width: 68ch; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.voice-head > .btn { flex-shrink: 0; }
.voice-account { display: flex; align-items: flex-end; gap: 28px; padding-bottom: 20px; }
.voice-account label, .voice-current { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 12px; color: var(--text-2); }
.voice-account select { min-width: 230px; max-width: 340px; }
.voice-current { padding-bottom: 7px; }
.voice-current strong { font-size: 13px; font-weight: 500; color: var(--text-1); overflow-wrap: anywhere; }
.voice-restart-note { margin: -6px 0 18px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.voice-filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.voice-search { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 12px; background: var(--bg-input); color: var(--text-2); }
.voice-search input { width: 100%; min-width: 0; padding: 10px 0; border: 0; outline: 0; background: transparent; color: var(--text-1); font-size: 13px; }
.voice-search input::placeholder { color: var(--text-2); }
.voice-search:focus-within { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.voice-filters select { width: auto; max-width: 240px; }
.voice-list-meta { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; color: var(--text-2); font-size: 12px; line-height: 1.6; margin-bottom: 12px; }
.voice-list-meta details { max-width: 58ch; text-align: right; }
.voice-list-meta summary { cursor: pointer; color: var(--text-1); text-underline-offset: 3px; }
.voice-list-meta p { margin: 8px 0 0; text-align: left; }
.voice-list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
.voice-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px 24px; padding: 17px 12px; border-bottom: 1px solid var(--border); }
.voice-row:hover, .voice-row.selected { background: var(--bg-1); }
.voice-name { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.voice-name h3 { margin: 0; color: var(--text-0); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.voice-label { color: var(--text-2); font-size: 11px; }
.voice-default { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: var(--accent-bg); color: var(--accent-text); border-radius: var(--radius-sm); font-size: 11px; }
.voice-description { margin: 7px 0 5px; color: var(--text-2); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.voice-id { display: block; margin-top: 5px; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }
.voice-actions { display: flex; gap: 8px; flex-shrink: 0; }
.voice-actions .btn { min-width: 74px; }
.voice-actions .btn:last-child { min-width: 112px; }
.voice-row-error { grid-column: 1 / -1; margin: 0; color: #b91c1c; font-size: 12px; }
.voice-row-status { grid-column: 1 / -1; margin: 0; color: var(--text-2); font-size: 12px; }
.voice-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; font-size: 13px; }
.voice-notice.error { color: #b91c1c; }
.voice-success { margin: 0 0 14px; color: #15803d; font-size: 13px; line-height: 1.6; }
.voice-empty { padding: 44px 16px; text-align: center; border-top: 1px solid var(--border); }
.voice-empty h3 { margin: 0 0 8px; font-size: 15px; color: var(--text-1); }
.voice-empty p { margin: 0 0 16px; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.voice-pagination { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.voice-pagination > div { display: flex; align-items: center; gap: 12px; }
.voice-player { position: sticky; bottom: 88px; z-index: 5; display: flex; align-items: center; gap: 20px; padding: 16px 0; margin-top: 20px; border-top: 1px solid var(--border-strong); background: var(--bg-0); }
.voice-player > div { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.voice-player strong { font-size: 13px; overflow-wrap: anywhere; }
.voice-player span { color: var(--text-2); font-size: 12px; }
.voice-player audio { flex: 1; min-width: 160px; height: 36px; }
.voice-player > .btn { flex-shrink: 0; }
.voice-skeleton { display: grid; gap: 1px; }
.voice-skeleton > div { height: 82px; background: var(--bg-2); border-bottom: 1px solid var(--bg-0); }
.voice-library :is(button, select, summary, audio):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 3px; }
.spin { animation: voice-spin 1s linear infinite; }
@keyframes voice-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
@media (max-width: 760px) {
  .voice-head { gap: 12px; flex-wrap: wrap; }
  .voice-account { flex-direction: column; align-items: stretch; gap: 16px; }
  .voice-account select { width: 100%; min-width: 0; max-width: none; }
  .voice-search { flex-basis: 100%; min-width: 0; }
  .voice-filters select { flex: 1; min-width: 0; max-width: 100%; }
  .voice-list-meta { flex-direction: column; gap: 8px; }
  .voice-list-meta details { text-align: left; }
  .voice-row { grid-template-columns: minmax(0, 1fr); gap: 12px; padding-inline: 0; }
  .voice-actions { justify-content: flex-start; }
  .voice-player { flex-wrap: wrap; gap: 12px; }
  .voice-player > div { flex: 1; }
  .voice-player audio { order: 3; flex-basis: 100%; width: 100%; }
}
</style>
