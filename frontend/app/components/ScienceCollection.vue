<template>
  <section class="collection" aria-label="YouTube 频道批量采集">
    <header class="collection-head">
      <div><strong><Youtube :size="17" />YouTube 频道采集 <span>{{ settings.youtubeChannels.length }} 个频道</span></strong><p>按频道列表自动采集、跳过已有视频，批量制作成片。</p></div>
      <div class="actions"><button class="btn" :disabled="!loaded || !!busy" @click="openChannels"><ListVideo :size="15" />频道管理</button><button class="btn btn-primary" :disabled="!loaded || !!activeCollection || !!busy" @click="openStart"><Play :size="14" />批量采集 / 生产</button></div>
    </header>
    <p v-if="loading && !loaded" class="hint" role="status">正在读取频道与批次…</p>
    <p v-else-if="loaded && !settings.youtubeChannels.length" class="empty-hint">先添加常用科普频道，以后每次采集会自动沿用这份列表。<button class="text-button" @click="openChannels">添加频道</button></p>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="text-button" :disabled="loading" @click="refresh">重新读取</button></p>
    <div v-if="runs.length" ref="batchPanel" class="batch-panel" tabindex="-1" aria-label="采集批次详情">
      <div class="batch-heading"><label>采集批次 <select v-model="selectedRunId" aria-label="查看采集批次"><option v-for="run in runs" :key="run.id" :value="run.id">{{ time(run.createdAt) }} · {{ modeLabel(run.mode) }} · {{ statusLabel(run.status) }}</option></select></label><span v-if="activeRun && displayedRun?.id !== activeRun.id"><button class="text-button" @click="selectedRunId = activeRun.id">查看正在运行的批次</button></span></div>
      <template v-if="displayedRun">
        <template v-if="hasSeparatePhases">
          <div class="phase-row" aria-label="采集进度">
            <div class="batch-summary">
              <div class="batch-progress"><span :class="['batch-status', displayedRun.collection.status]"><LoaderCircle v-if="['running','stopping'].includes(displayedRun.collection.status)" :size="15" class="spin" /><Check v-else-if="displayedRun.collection.status === 'completed'" :size="15" />{{ phaseLabel('采集', displayedRun.collection.status) }}</span><strong>已入库 {{ displayedRun.counts.selected }}<span v-if="displayedRun.targetCount !== null"> / {{ displayedRun.targetCount }}</span><span v-else> · 采到频道末尾</span></strong></div>
              <div class="actions"><button v-if="displayedRun.collection.status === 'running'" class="btn btn-sm" :disabled="!!busy" @click="controlRun('collection/stop', displayedRun.id)"><Square :size="12" />停止采集</button><button v-else-if="displayedRun.collection.status === 'stopping'" class="btn btn-sm" disabled>正在停止采集…</button><button v-else-if="['stopped','interrupted','needs_attention'].includes(displayedRun.collection.status)" class="btn btn-sm" :disabled="!!busy || (!!activeCollection && activeCollection.id !== displayedRun.id)" @click="controlRun('collection/resume', displayedRun.id)"><Play :size="12" />继续采集</button></div>
            </div>
            <p class="batch-message" role="status">{{ displayedRun.collection.message }}</p>
            <p v-if="displayedRun.currentChannel" class="current-channel">当前频道：<a :href="displayedRun.currentChannel" target="_blank" rel="noreferrer">{{ displayChannel(displayedRun.currentChannel) }}<ExternalLink :size="11" /></a></p>
          </div>
          <div class="phase-row" aria-label="生产进度">
            <div class="batch-summary">
              <div class="batch-progress"><span :class="['batch-status', displayedRun.processing.status]"><LoaderCircle v-if="['running','stopping'].includes(displayedRun.processing.status)" :size="15" class="spin" /><Check v-else-if="displayedRun.processing.status === 'completed'" :size="15" />{{ phaseLabel('生产', displayedRun.processing.status) }}</span><strong v-if="displayedRun.retry">重试进度 <span>已恢复 {{ displayedRun.retry.completed }}/{{ displayedRun.retry.jobIds.length }}</span></strong><span>已完成 {{ displayedRun.counts.completed }}</span><span :class="{ warning: displayedRun.counts.failed }">失败 {{ displayedRun.counts.failed }}</span><span>待处理 {{ pendingCount }}</span></div>
              <div class="actions"><button v-if="['queued','running'].includes(displayedRun.processing.status)" class="btn btn-sm" :disabled="!!busy" @click="controlRun('processing/stop', displayedRun.id)"><Square :size="12" />停止生产</button><button v-else-if="displayedRun.processing.status === 'stopping'" class="btn btn-sm" disabled>正在停止生产…</button><button v-else-if="['stopped','interrupted','needs_attention'].includes(displayedRun.processing.status)" class="btn btn-sm" :disabled="!!busy" @click="controlRun('processing/resume', displayedRun.id)"><Play :size="12" />继续生产</button><button v-if="!['queued','running','stopping'].includes(displayedRun.processing.status) && unfinishedItems.length" class="btn btn-sm" :disabled="!!busy || !!activeRun" @click="openRetry"><RotateCcw :size="12" />重试未完成任务</button></div>
            </div>
            <p class="batch-message" role="status">{{ displayedRun.processing.message }}</p>
            <button v-if="displayedRun.currentJobId" class="text-button current-job" @click="emit('select-job', displayedRun.currentJobId)">查看当前生产任务</button>
          </div>
        </template>
        <div v-else class="batch-summary">
          <div class="batch-progress"><span :class="['batch-status', displayedRun.status]"><LoaderCircle v-if="['running','stopping'].includes(displayedRun.status)" :size="15" class="spin" /><Check v-else-if="displayedRun.status === 'completed'" :size="15" />{{ statusLabel(displayedRun.status) }}</span><strong v-if="displayedRun.retry">重试进度 <span>已恢复 {{ displayedRun.retry.completed }}/{{ displayedRun.retry.jobIds.length }}</span></strong><strong v-else>{{ outputLabel(displayedRun.mode) }} {{ displayedRun.counts.completed }}<span v-if="displayedRun.targetCount !== null"> / {{ displayedRun.targetCount }}</span><span v-else> · 采到频道末尾</span></strong></div>
          <div class="actions"><button v-if="displayedRun.status === 'running'" class="btn btn-sm" :disabled="!!busy" @click="controlRun('stop', displayedRun.id)"><Square :size="12" />{{ displayedRun.retry ? '停止本次重试' : '停止本批' }}</button><button v-else-if="displayedRun.status === 'stopping'" class="btn btn-sm" disabled>正在停止…</button><button v-else-if="['stopped','interrupted','needs_attention'].includes(displayedRun.status)" class="btn btn-sm" :disabled="!!busy || !!activeRun" @click="controlRun('resume', displayedRun.id)"><Play :size="12" />{{ displayedRun.retry ? '继续本次重试' : '继续本批' }}</button><button v-if="!['running','stopping'].includes(displayedRun.status) && unfinishedItems.length" class="btn btn-sm" :disabled="!!busy || !!activeRun" @click="openRetry"><RotateCcw :size="12" />重试未完成任务</button></div>
        </div>
        <p v-if="displayedRun.retry" class="retry-summary"><template v-if="displayedRun.targetCount !== null">原采集目标 {{ displayedRun.targetCount }} 条</template><template v-else>原采集范围：到频道末尾</template>；本批累计{{ outputLabel(displayedRun.mode) }} {{ displayedRun.counts.completed }} 条。本次只处理所选原任务。</p>
        <p v-if="!hasSeparatePhases" class="batch-message" role="status">{{ displayedRun.message }}</p>
        <p v-if="!hasSeparatePhases && displayedRun.currentChannel" class="current-channel">当前频道：<a :href="displayedRun.currentChannel" target="_blank" rel="noreferrer">{{ displayChannel(displayedRun.currentChannel) }}<ExternalLink :size="11" /></a><button v-if="displayedRun.currentJobId" class="text-button" @click="emit('select-job', displayedRun.currentJobId)">查看当前任务</button></p>
        <div class="batch-counts"><span>已扫描 {{ displayedRun.counts.scanned }}</span><span>新视频 {{ displayedRun.counts.selected }}</span><span>已跳过 {{ displayedRun.counts.skipped }}</span><span v-if="!hasSeparatePhases" :class="{ warning: displayedRun.counts.failed }">失败 {{ displayedRun.counts.failed }}</span><span>{{ displayedRun.youtubeChannels.length }} 个频道 · {{ accountLabel('huasheng', displayedRun.huashengAccountName) }}<template v-if="displayedRun.mode === 'upload'"> → {{ accountLabel('baijiahao', displayedRun.baijiahaoAccountName) }}</template></span></div>
        <details v-if="displayedRun.items.length || displayedRun.channelErrors.length" class="batch-details"><summary>本批产出与异常 <span>{{ displayedRun.items.length }} 条任务</span></summary><ul class="batch-items"><li v-for="item in displayedRun.items" :key="item.jobId"><button class="item-title" :disabled="item.status === 'deleted'" @click="emit('select-job', item.jobId)">{{ item.title || '正在处理的视频' }}<ExternalLink v-if="item.status !== 'deleted'" :size="12" /></button><span :class="{ warning: item.status === 'failed' }">{{ itemStatus(item.status) }}</span><span class="item-id">任务 ID <code>{{ item.jobId }}</code></span><p v-if="item.message && item.status === 'failed'">{{ item.message }}</p></li></ul><p v-for="(issue, index) in displayedRun.channelErrors" :key="index" class="error">{{ displayChannel(issue.url) }}：{{ issue.message }}</p><p class="hint">{{ displayedRun.retry ? '继续本次重试会沿用已保存的任务范围和原账号，已完成任务会跳过。' : '继续本批会沿用原频道、目标和账号，已完成任务会跳过。' }}</p></details>
      </template>
    </div>

    <dialog ref="retryDialog" class="collection-dialog" aria-labelledby="science-retry-title">
      <header><div><h2 id="science-retry-title">重试未完成任务</h2><p>沿用原账号和制作进度，只处理所选原任务，不采集新视频。</p></div><button class="btn btn-icon btn-ghost" aria-label="关闭任务重试" :disabled="busy === 'retry'" @click="retryDialog?.close()"><X :size="18" /></button></header>
      <form @submit.prevent="retryRun"><div class="dialog-body"><fieldset :disabled="busy === 'retry'"><ul class="retry-options"><li v-for="item in retryCandidates" :key="item.jobId"><label><input v-model="retrySelected" type="checkbox" :value="item.jobId" /><span><strong>{{ item.title || '正在处理的视频' }}</strong><span class="retry-item-state">{{ itemStatus(item.status) }}</span><code>{{ item.jobId }}</code></span></label></li></ul></fieldset><p v-if="!retryCandidates.length" class="hint">这些任务已经完成，无需重试。</p><p v-if="activeRun" class="warning">请等待正在运行的批次结束后再重试。</p><p v-if="retryError" class="error" role="alert">{{ retryError }}</p></div><footer><button class="btn btn-ghost" type="button" :disabled="busy === 'retry'" @click="retryDialog?.close()">取消</button><button class="btn btn-primary" type="submit" :disabled="!!busy || !!activeRun || !selectedRetryIds.length"><LoaderCircle v-if="busy === 'retry'" :size="14" class="spin" /><RotateCcw v-else :size="14" />重试所选 {{ selectedRetryIds.length }} 条任务</button></footer></form>
    </dialog>

    <dialog ref="channelsDialog" class="collection-dialog" aria-labelledby="science-channels-title" @close="channelsOpen = false">
      <header><div><h2 id="science-channels-title">YouTube 频道管理</h2><p>按列表顺序采集，频道主页和 videos 页都可以。</p></div><button class="btn btn-icon btn-ghost" aria-label="关闭频道管理" :disabled="busy === 'channels'" @click="channelsDialog?.close()"><X :size="18" /></button></header>
      <form @submit.prevent="saveChannels"><div class="dialog-body"><fieldset :disabled="busy === 'channels'"><div v-for="(_, index) in channelDraft" :key="index" class="channel-row"><span>{{ index + 1 }}</span><input v-model="channelDraft[index]" type="url" :aria-label="`科普 YouTube 频道 ${index + 1}`" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/@频道/videos" /><button class="btn btn-sm" type="button" :aria-label="`删除科普频道 ${index + 1}`" @click="channelDraft.splice(index, 1)">删除</button></div><p v-if="!channelDraft.length" class="hint">尚未添加频道。</p><button class="btn btn-sm" type="button" :disabled="channelDraft.length >= 30" @click="channelDraft.push('')"><Plus :size="13" />添加频道</button></fieldset><p v-if="channelValidation" class="warning" role="status">{{ channelValidation }}</p><p v-if="channelError" class="error" role="alert">{{ channelError }}</p><p class="hint">最多 30 个频道。修改只影响下一批，正在运行的批次保留原列表。</p></div><footer><button class="btn btn-ghost" type="button" :disabled="busy === 'channels'" @click="channelsDialog?.close()">取消</button><button class="btn btn-primary" type="submit" :disabled="!!busy || !!channelValidation || !channelsDirty"><Save :size="14" />{{ busy === 'channels' ? '保存中…' : '保存频道列表' }}</button></footer></form>
    </dialog>

    <dialog ref="startDialog" class="collection-dialog start-dialog" aria-labelledby="science-batch-title">
      <header><div><h2 id="science-batch-title">批量采集 / 生产</h2><p>从已保存的 {{ settings.youtubeChannels.length }} 个频道采集新视频。</p></div><button class="btn btn-icon btn-ghost" aria-label="关闭批量采集" :disabled="busy === 'start'" @click="startDialog?.close()"><X :size="18" /></button></header>
      <form @submit.prevent="startRun"><div class="dialog-body"><label class="field"><span>本批产出</span><select v-model="config.mode" :disabled="busy === 'start'" aria-label="本批产出"><option value="videos">自动制作视频</option><option value="upload">制作并直接发表</option></select></label><fieldset class="target-options" :disabled="busy === 'start'"><legend>采集目标</legend><label><input v-model="config.continuous" type="radio" :value="false" />指定采集数量</label><label><input v-model="config.continuous" type="radio" :value="true" />采到频道末尾</label></fieldset><label v-if="!config.continuous" class="field"><span>新视频采集数量</span><input v-model.number="config.targetCount" type="number" min="1" max="9999" step="1" required aria-label="目标采集数量" :disabled="busy === 'start'" /></label><p class="hint">以新视频入库计数，已有视频自动跳过；入库后进入独立生产队列。</p><div class="batch-accounts"><label class="field"><span>本批花生账号（可选）</span><select v-model="config.huashengAccountName" aria-label="本批花生账号" :disabled="busy === 'start'"><option value="">仅采集，暂不绑定</option><option v-for="account in accounts.huasheng.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.status !== 'ready' ? ' · 需登录' : '' }}</option></select></label><label v-if="config.mode === 'upload'" class="field"><span>本批百家号账号（可选）</span><select v-model="config.baijiahaoAccountName" aria-label="本批百家号账号" :disabled="busy === 'start'"><option value="">仅采集，暂不绑定</option><option v-for="account in accounts.baijiahao.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.status !== 'ready' ? ' · 需登录' : '' }}</option></select></label></div><p class="hint">未绑定账号时先完成采集；可在单条任务中选择账号后制作。</p><p v-if="startValidation" class="warning" role="status">{{ startValidation }}</p><p v-if="startError" class="error" role="alert">{{ startError }}</p></div><footer><button class="btn btn-ghost" type="button" :disabled="busy === 'start'" @click="startDialog?.close()">取消</button><button class="btn btn-primary" type="submit" :disabled="!!busy || !!startValidation || !!activeCollection"><LoaderCircle v-if="busy === 'start'" :size="14" class="spin" /><Play v-else :size="14" />{{ busy === 'start' ? '正在启动…' : '开始本批' }}</button></footer></form>
    </dialog>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Check, ExternalLink, ListVideo, LoaderCircle, Play, Plus, RotateCcw, Save, Square, X, Youtube } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = defineProps({ accounts: { type: Object, required: true } })
const emit = defineEmits(['changed', 'select-job', 'context'])
const BASE = '/science-pop/workflow/collection'
const settings = ref({ youtubeChannels: [], targetCount: 5, mode: 'upload', huashengAccountName: null, baijiahaoAccountName: null })
const runs = ref([])
const activeRun = ref(null)
const activeCollection = ref(null)
const selectedRunId = ref('')
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
const contextError = ref('')
const batchPanel = ref(null)
const busy = ref('')
const channelsDialog = ref(null)
const channelsOpen = ref(false)
const channelDraft = ref([])
const channelSaved = ref([])
const channelError = ref('')
const startDialog = ref(null)
const startError = ref('')
const retryDialog = ref(null)
const retryRunId = ref('')
const retrySelected = ref([])
const retryError = ref('')
const config = reactive({ mode: 'upload', targetCount: 5, continuous: false, huashengAccountName: '', baijiahaoAccountName: '' })
const displayedRun = computed(() => runs.value.find(run => run.id === selectedRunId.value) || activeRun.value || runs.value[0])
const hasSeparatePhases = computed(() => !!(displayedRun.value?.collection && displayedRun.value?.processing))
const pendingCount = computed(() => (displayedRun.value?.items || []).filter(item => ['queued', 'paused'].includes(item.status)).length)
const unfinishedItems = computed(() => (displayedRun.value?.items || []).filter(item => !['completed', 'deleted'].includes(item.status)))
const retryCandidates = computed(() => (runs.value.find(run => run.id === retryRunId.value)?.items || []).filter(item => !['completed', 'deleted'].includes(item.status)))
const selectedRetryIds = computed(() => retryCandidates.value.filter(item => retrySelected.value.includes(item.jobId)).map(item => item.jobId))
const channelsDirty = computed(() => JSON.stringify(channelDraft.value) !== JSON.stringify(channelSaved.value))
const channelValidation = computed(() => validateChannels(channelDraft.value))
const startValidation = computed(() => {
  if (!settings.value.youtubeChannels.length) return '请先在频道管理中保存至少一个频道。'
  if (!config.continuous && (!Number.isInteger(config.targetCount) || config.targetCount < 1 || config.targetCount > 9999)) return '目标采集数量应为 1–9999。'
  return ''
})
let disposed = false
let timer
let generation = 0
let lastProgress = ''
let startRequest

function channelUrl(value) {
  try {
    if (/[\u0000-\u001f\u007f]/.test(value)) return null
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)) return null
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '')
    const channel = pathname.match(/^(\/@[^/\s?#]+|\/channel\/UC[A-Za-z0-9_-]{22}|\/(?:c|user)\/[^/\s?#]+)(?:\/videos)?$/)?.[1]
    return channel ? new URL(`${channel}/videos`, 'https://www.youtube.com').href : null
  } catch { return null }
}
function validateChannels(values) {
  if (values.length > 30) return '最多保存 30 个频道。'
  const urls = values.map(channelUrl)
  if (urls.some(value => !value)) return '请填写有效的 YouTube 频道主页或 videos 页，不能填写单条视频。'
  const ids = urls.map(value => { const pathname = decodeURIComponent(new URL(value).pathname).normalize('NFC'); return pathname.startsWith('/@') ? pathname.toLowerCase() : pathname })
  return new Set(ids).size === ids.length ? '' : '频道不能重复，频道主页和 videos 页视为同一个频道。'
}
function displayChannel(value) { try { return decodeURI(value) } catch { return value } }
function time(value) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function modeLabel(mode) { return ({ drafts: '自动制作视频', videos: '自动制作视频', upload: '制作并直接发表' })[mode] || '采集' }
function outputLabel(mode) { return ({ drafts: '已生成成片', videos: '已生成成片', upload: '已发表作品' })[mode] || '已完成' }
function statusLabel(status) { return ({ queued: '排队中', running: '进行中', stopping: '正在停止', stopped: '已停止', interrupted: '执行中断', completed: '已完成', needs_attention: '需要处理' })[status] || status }
function phaseLabel(phase, status) { return `${phase}${statusLabel(status)}` }
function itemStatus(status) { return ({ queued: '等待处理', paused: '已暂停', running: '处理中', completed: '已完成', failed: '失败待续做', deleted: '已删除' })[status] || status }
function accountLabel(platform, name) { return props.accounts[platform]?.accounts.find(account => account.accountName === name)?.label || (name ? '已绑定账号' : '未选择账号') }
function emitContext() { emit('context', { runs: runs.value, loaded: loaded.value, error: contextError.value }) }
function acceptRun(run) {
  const index = runs.value.findIndex(item => item.id === run.id)
  if (index < 0) runs.value.unshift(run)
  else runs.value[index] = run
  activeRun.value = ['running', 'stopping'].includes(run.status) ? run : activeRun.value?.id === run.id ? null : activeRun.value
  activeCollection.value = ['running', 'stopping'].includes(run.collection?.status || (!run.collection && !run.retry ? run.status : '')) ? run : activeCollection.value?.id === run.id ? null : activeCollection.value
  selectedRunId.value = run.id
  contextError.value = ''; emitContext()
}
async function refresh() {
  if (loading.value || disposed) return
  loading.value = true
  const version = generation
  try {
    const result = await api.get(BASE)
    if (disposed || version !== generation) return
    settings.value = result.settings; runs.value = result.runs || []; activeRun.value = result.activeRun || null; loaded.value = true; error.value = ''; contextError.value = ''
    activeCollection.value = Object.hasOwn(result, 'activeCollection') ? result.activeCollection : activeRun.value?.collection ? (['running', 'stopping'].includes(activeRun.value.collection.status) ? activeRun.value : null) : activeRun.value?.retry ? null : activeRun.value
    if (!runs.value.some(run => run.id === selectedRunId.value)) selectedRunId.value = activeRun.value?.id || runs.value[0]?.id || ''
    emitContext()
    const progress = JSON.stringify(runs.value.map(run => [run.id, run.status, run.currentJobId, run.counts, run.message, run.retry, run.collection, run.processing]))
    if (lastProgress && lastProgress !== progress) emit('changed')
    lastProgress = progress
  } catch (err) { if (!disposed && version === generation) { error.value = err.message || '频道与批次读取失败'; contextError.value = error.value; emitContext() } }
  finally { loading.value = false }
}
async function revealRun(id) {
  if (!runs.value.some(run => run.id === id)) await refresh()
  if (disposed) return false
  if (!runs.value.some(run => run.id === id)) { error.value ||= '未找到所属批次记录，请重新读取批次。'; return false }
  selectedRunId.value = id
  await nextTick()
  batchPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  batchPanel.value?.focus({ preventScroll: true })
  return true
}
async function openChannels() {
  if (!loaded.value || busy.value) return
  channelDraft.value = settings.value.youtubeChannels.map(displayChannel); channelSaved.value = [...channelDraft.value]; channelError.value = ''; channelsOpen.value = true
  await nextTick(); channelsDialog.value?.showModal()
}
async function saveChannels() {
  if (busy.value || channelValidation.value || !channelsDirty.value) return
  busy.value = 'channels'; channelError.value = ''; generation++
  try {
    const result = await api.put(`${BASE}/settings`, { youtubeChannels: channelDraft.value.map(channelUrl) })
    if (disposed) return
    settings.value = result; channelDraft.value = result.youtubeChannels.map(displayChannel); channelSaved.value = [...channelDraft.value]; channelsDialog.value?.close()
  } catch (err) { if (!disposed) channelError.value = err.message || '频道保存失败，修改仍保留在此处' }
  finally { busy.value = '' }
}
async function openStart() {
  if (!loaded.value || activeCollection.value) return
  config.mode = settings.value.mode === 'drafts' ? 'videos' : settings.value.mode || 'upload'; config.continuous = settings.value.targetCount === null; config.targetCount = settings.value.targetCount ?? 5
  config.huashengAccountName = settings.value.huashengAccountName || props.accounts.huasheng.defaultAccountName || ''
  config.baijiahaoAccountName = settings.value.baijiahaoAccountName || props.accounts.baijiahao.defaultAccountName || ''
  startError.value = ''
  await nextTick(); startDialog.value?.showModal()
}
async function startRun() {
  if (busy.value || startValidation.value || activeCollection.value) return
  const preferences = { targetCount: config.continuous ? null : config.targetCount, mode: config.mode,
    huashengAccountName: config.huashengAccountName || null, baijiahaoAccountName: config.baijiahaoAccountName || null }
  const fingerprint = JSON.stringify([settings.value.youtubeChannels, preferences])
  if (!startRequest || startRequest.fingerprint !== fingerprint) startRequest = { fingerprint, requestId: crypto.randomUUID() }
  busy.value = 'start'; startError.value = ''; generation++
  try {
    settings.value = await api.put(`${BASE}/settings`, preferences)
    if (disposed) return
    const run = await api.post(`${BASE}/runs`, { requestId: startRequest.requestId, ...preferences })
    if (disposed) return
    acceptRun(run); startDialog.value?.close(); startRequest = undefined; emit('changed')
  } catch (err) { if (!disposed) startError.value = err.message || '批次启动未确认，请重试以核对原请求' }
  finally { busy.value = '' }
}
async function controlRun(action, id) {
  if (busy.value) return
  busy.value = action; error.value = ''; generation++
  try {
    const run = await api.post(`${BASE}/runs/${encodeURIComponent(id)}/${action}`, {})
    if (!disposed) { acceptRun(run); emit('changed') }
  } catch (err) { if (!disposed) error.value = err.message || '批次操作失败，请稍后重试' }
  finally { busy.value = '' }
}
async function openRetry() {
  if (busy.value || activeRun.value || !unfinishedItems.value.length) return
  retryRunId.value = displayedRun.value.id
  retrySelected.value = unfinishedItems.value.map(item => item.jobId)
  retryError.value = ''
  await nextTick(); retryDialog.value?.showModal()
}
async function retryRun() {
  if (busy.value || activeRun.value || !selectedRetryIds.value.length) return
  retryError.value = ''
  try {
    await retryJobs(retryRunId.value, selectedRetryIds.value)
    if (disposed) return
    retryDialog.value?.close()
  } catch (err) { if (!disposed) retryError.value = err.message || '重试未确认，所选任务已保留，请稍后核对' }
}
async function retryJobs(id, jobIds) {
  if (busy.value || activeRun.value) throw new Error(activeRun.value ? '已有科普批次正在执行，请等待完成后重试' : '批次操作正在进行，请稍后重试')
  const selected = [...new Set(jobIds)].filter(Boolean)
  if (!selected.length) throw new Error('没有可重试的任务')
  busy.value = 'retry'; generation++
  try {
    const run = await api.post(`${BASE}/runs/${encodeURIComponent(id)}/retry`, { jobIds: selected })
    if (!disposed) { acceptRun(run); emit('changed') }
    return run
  } finally {
    if (busy.value === 'retry') busy.value = ''
  }
}
function beforeUnload(event) { if (channelsOpen.value && channelsDirty.value) { event.preventDefault(); event.returnValue = '' } }
defineExpose({ openChannels, openStart, refresh, revealRun, retryJobs })
onMounted(async () => { window.addEventListener('beforeunload', beforeUnload); await refresh(); if (!disposed) timer = window.setInterval(refresh, 4000) })
onBeforeUnmount(() => { disposed = true; generation++; if (timer) window.clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<style scoped>
.collection { flex-shrink: 0; border-block: 1px solid var(--border); padding: 14px 0; color: var(--text-1); font-size: 12px; }
.phase-row + .phase-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }.current-job { display: inline-block; margin-top: 6px; }
.retry-summary { color: var(--text-2); margin: 8px 0 0; line-height: 1.65; }.retry-options { list-style: none; padding: 0; margin: 0; }.retry-options li + li { border-top: 1px solid var(--border); }.retry-options label { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: start; gap: 10px; padding: 12px 0; cursor: pointer; }.retry-options input { margin-top: 4px; }.retry-options strong { font-weight: 550; overflow-wrap: anywhere; }.retry-item-state { display: inline-block; margin-left: 10px; color: var(--text-2); font-size: 11px; }.retry-options code { display: block; margin-top: 4px; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }
.item-id { grid-column: 1/-1; min-width: 0; color: var(--text-2); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }.item-id code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: inherit; white-space: normal; }
.collection-head,.actions,.batch-summary,.batch-progress,.batch-counts,.batch-heading { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }.collection-head { justify-content: space-between; }.collection-head strong { display: flex; gap: 7px; align-items: center; font-size: 14px; }.collection-head strong span { color: var(--text-2); font-size: 12px; font-weight: 400; }.collection-head p { margin: 5px 0 0; color: var(--text-2); }.actions { gap: 8px; }.hint,.empty-hint,.mode-note { color: var(--text-2); font-size: 12px; line-height: 1.65; margin: 10px 0 0; }.empty-hint .text-button { margin-left: 10px; }.error { color: var(--error); margin: 10px 0 0; overflow-wrap: anywhere; }.warning { color: var(--warning); }.text-button { padding: 0; border: 0; background: transparent; color: var(--info); font: inherit; cursor: pointer; }.text-button:disabled { opacity: .5; cursor: default; }.collection :is(button,input,select,summary):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.batch-panel { margin-top: 14px; padding: 12px 14px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 8px; }.batch-heading { justify-content: space-between; margin-bottom: 12px; color: var(--text-2); }.batch-heading label { display: flex; align-items: center; gap: 10px; min-width: 0; }.batch-heading select { min-width: 0; max-width: 100%; padding: 4px 7px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-1); background: var(--bg-0); font: inherit; }.batch-summary { justify-content: space-between; }.batch-progress strong { font-size: 14px; }.batch-progress strong span { font-weight: 400; color: var(--text-2); }.batch-status { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }.batch-status.running { color: var(--info); }.batch-status.completed { color: var(--success); }.batch-status.needs_attention,.batch-status.interrupted { color: var(--warning); }.batch-message { margin: 8px 0 0; line-height: 1.65; overflow-wrap: anywhere; }.current-channel { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; color: var(--text-2); }.current-channel a { display: inline-flex; align-items: center; gap: 3px; overflow-wrap: anywhere; color: var(--info); text-decoration: none; }.current-channel .text-button { margin-left: 6px; }.batch-counts { gap: 6px 16px; margin-top: 8px; color: var(--text-2); font-size: 11px; }.batch-details { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 9px; }.batch-details summary { cursor: pointer; }.batch-details summary span { color: var(--text-2); margin-left: 6px; }.batch-items { list-style: none; padding: 0; margin: 7px 0; max-height: 240px; overflow: auto; }.batch-items li { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 5px 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }.item-title { display: inline-flex; align-items: center; gap: 5px; width: fit-content; padding: 0; text-align: left; color: var(--text-1); border: 0; background: transparent; font: inherit; cursor: pointer; overflow-wrap: anywhere; }.item-title:hover { color: var(--info); }.item-title svg { flex-shrink: 0; }.batch-items p { grid-column: 1/-1; color: var(--warning); margin: 0; overflow-wrap: anywhere; }
.collection-dialog { position: fixed; inset: 0; margin: auto; width: min(680px,calc(100vw - 32px)); max-height: calc(100dvh - 48px); box-sizing: border-box; padding: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif; overflow: auto; box-shadow: var(--shadow-elevated); }.collection-dialog::backdrop { background: rgb(9 9 11 / 32%); }.collection-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 20px 22px 16px; border-bottom: 1px solid var(--border); }.collection-dialog h2 { margin: 0; font-size: 18px; }.collection-dialog header p { margin: 5px 0 0; font-size: 12px; color: var(--text-2); }.dialog-body { padding: 20px 22px; }.collection-dialog footer { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border); padding: 14px 22px; }.collection-dialog fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }.channel-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }.channel-row > span { flex: 0 0 15px; color: var(--text-2); }.channel-row input { flex: 1; min-width: 0; }.channel-row .btn { flex-shrink: 0; }.collection-dialog input:not([type=radio]):not([type=checkbox]),.collection-dialog select { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); color: var(--text-1); padding: 9px 10px; font: inherit; }.field { display: grid; gap: 7px; margin-bottom: 14px; }.field > span { font-weight: 550; }.start-dialog { width: min(560px,calc(100vw - 32px)); }.mode-note { margin-top: -5px; margin-bottom: 18px; }.target-options { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 12px !important; }.target-options legend { margin-bottom: 8px; font-weight: 550; }.target-options label { display: inline-flex; align-items: center; gap: 6px; }.target-options input { margin: 0; }.batch-accounts { margin-top: 18px; }.spin { animation: spin 1s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width:760px) { .collection-head { align-items: flex-start; gap: 10px; }.collection-head > .actions { width: 100%; }.collection-head .btn { flex: 1; justify-content: center; }.batch-panel { padding: 11px; }.batch-heading label { width: 100%; }.batch-heading select { flex: 1; }.batch-progress { gap: 8px; }.batch-counts > span:last-child { width: 100%; }.collection-dialog > header,.dialog-body { padding-inline: 16px; }.collection-dialog footer { padding-inline: 16px; }.channel-row { gap: 6px; }.channel-row > span { flex-basis: 10px; }.channel-row input { font-size: 12px !important; }.current-channel a { max-width: 100%; word-break: break-all; } }
</style>
