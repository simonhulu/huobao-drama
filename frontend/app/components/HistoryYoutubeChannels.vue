<template>
  <section class="channel-settings" aria-label="YouTube 频道列表设置">
    <header><strong>YouTube 频道列表</strong><span>依次采集 · 跨频道去重</span></header>
    <p>添加频道主页或 videos 页。按列表顺序采集，达到本次产出数量后结束。</p>
    <p v-if="loading" role="status">正在读取频道…</p>
    <fieldset v-else :disabled="saving || disabled">
      <div v-for="(_, index) in draft" :key="index" class="channel-row">
        <span class="channel-order">{{ index + 1 }}</span>
        <input v-model="draft[index]" class="input" type="url" inputmode="url" autocomplete="off" spellcheck="false" :aria-label="`YouTube 频道 ${index + 1}`" maxlength="2048" placeholder="https://www.youtube.com/@频道/videos" />
        <button type="button" class="btn btn-sm" :aria-label="`删除频道 ${index + 1}`" @click="draft.splice(index, 1)">删除</button>
      </div>
      <div class="channel-actions">
        <button type="button" class="btn btn-sm" :disabled="draft.length >= 30" @click="draft.push('')">添加频道</button>
        <button type="button" class="btn btn-sm" :disabled="!dirty || Boolean(validation) || !loaded" @click="save">{{ saving ? '保存中…' : '保存频道' }}</button>
      </div>
    </fieldset>
    <p v-if="validation && dirty" class="warning" role="status">{{ validation }}</p>
    <p v-else-if="dirty" class="warning" role="status">频道列表有未保存修改，请保存后开始采集。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button type="button" class="btn btn-sm" :disabled="loading || saving" @click="load">重新读取</button></p>
    <p v-if="notice && !dirty" role="status">{{ notice }}</p>
  </section>
</template>

<script setup lang="ts">
import { historyScriptAPI } from '~/composables/useApi'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ change: [channels: string[]]; ready: [ready: boolean] }>()
const draft = ref<string[]>([])
const saved = ref<string[]>([])
const loading = ref(true)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
const notice = ref('')
let request = 0

function channelUrl(value: string): string | null {
  try {
    if (/[\u0000-\u001f\u007f]/.test(value)) return null
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '')
    const channel = pathname.match(/^(\/@[^/\s?#]+|\/channel\/UC[A-Za-z0-9_-]{22}|\/(?:c|user)\/[^/\s?#]+)(?:\/videos)?$/)?.[1]
    return channel ? new URL(`${channel}/videos`, 'https://www.youtube.com').href : null
  } catch { return null }
}
function duplicateKey(value: string) {
  const pathname = decodeURIComponent(new URL(value).pathname).normalize('NFC')
  return pathname.startsWith('/@') ? pathname.toLowerCase() : pathname
}
function validate(values: string[]) {
  if (!values.length) return '请保留至少一个频道。'
  if (values.length > 30) return '最多保存 30 个频道。'
  if (values.some(value => !value.trim())) return '频道链接不能为空。'
  const channels = values.map(channelUrl)
  if (channels.some(value => !value)) return '请填写有效的 YouTube 频道主页或 videos 页；单条视频请切换到“单条视频”。'
  if (new Set(channels.map(value => duplicateKey(value!))).size !== channels.length) return '频道不能重复，频道主页与 videos 页视为同一个频道。'
  return ''
}
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value))
const validation = computed(() => validate(draft.value))
watch([dirty, validation, loading, saving, loaded, error], () => emit('ready', loaded.value && !dirty.value && !validation.value && !loading.value && !saving.value && !error.value), { immediate: true })

function accept(data: { youtubeChannels: string[] }) {
  if (!Array.isArray(data?.youtubeChannels) || data.youtubeChannels.some(value => typeof value !== 'string') || validate(data.youtubeChannels)) throw new Error('频道配置读取失败，请重试')
  const channels = data.youtubeChannels.map(value => channelUrl(value)!)
  const display = channels.map(value => decodeURI(value))
  draft.value = [...display]
  saved.value = [...display]
  loaded.value = true
  emit('change', channels)
}
async function load() {
  const current = ++request
  loading.value = true
  error.value = ''; notice.value = ''
  try {
    const data = await historyScriptAPI.collectionSettings()
    if (current === request) accept(data)
  } catch (err: any) { if (current === request) error.value = err.message || '读取频道失败' }
  finally { if (current === request) loading.value = false }
}
async function save() {
  if (validation.value || saving.value || !loaded.value) return
  const current = ++request
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const data = await historyScriptAPI.saveCollectionSettings({ youtubeChannels: draft.value.map(value => channelUrl(value)!) })
    if (current !== request) return
    accept(data)
    notice.value = '频道列表已保存，将用于下次采集。'
  } catch (err: any) { if (current === request) error.value = err.message || '保存频道失败' }
  finally { if (current === request) saving.value = false }
}
onMounted(load)
onBeforeUnmount(() => { request++ })
</script>

<style scoped>
.channel-settings { min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px; }
header span, p { font-size: 12px; color: var(--text-2); line-height: 1.65; }
p { margin: 8px 0; overflow-wrap: anywhere; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.channel-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.channel-row input { flex: 1; min-width: 0; width: 100%; }
.channel-order { flex: 0 0 16px; color: var(--text-2); }
.channel-row button { flex-shrink: 0; }
.channel-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.error { color: var(--error, #b91c1c); }
.warning { color: #9a4c08; }
</style>
