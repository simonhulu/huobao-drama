<template>
  <section class="czgts-settings" aria-label="文章采集设置">
    <strong>百家号文章 · czgts.cn</strong>
    <p>通过接口分页查找「百家号 / 历史 / 文章」，保存完整原文后调用已配置的文本模型校对与二创。</p>
    <p role="status">{{ loading ? '正在读取登录配置…' : configured ? '已保存登录 Cookie' : '尚未配置登录 Cookie' }}</p>
    <fieldset :disabled="Boolean(disabled || busy || loading)">
      <label for="czgts-cookie">登录 Cookie（仅用于 czgts.cn）</label>
      <input id="czgts-cookie" v-model="cookie" class="input" type="password" autocomplete="off" spellcheck="false" :placeholder="configured ? '已保存；输入新 Cookie 可替换' : '粘贴登录后的完整 Cookie'" />
      <div class="actions">
        <button type="button" class="btn btn-sm" :disabled="!cookie.trim()" @click="save">{{ busy === 'save' ? '保存中…' : '保存 Cookie' }}</button>
        <button type="button" class="btn btn-sm" :disabled="!configured || Boolean(cookie)" @click="check">{{ busy === 'check' ? '检测中…' : '检测文章接口' }}</button>
      </div>
      <p>Cookie 保存后不回显。更换 Cookie 后请先保存，再开始采集。</p>
      <div class="date-fields">
        <label>开始时间（北京时间）<input v-model="startTime" class="input" type="datetime-local" step="1" /></label>
        <label>结束时间（北京时间）<input v-model="endTime" class="input" type="datetime-local" step="1" /></label>
      </div>
      <p v-if="dateError" class="error">{{ dateError }}</p>
    </fieldset>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="loadFailed" class="btn btn-sm" type="button" :disabled="loading" @click="load">重新读取配置</button>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ ready: [ready: boolean]; change: [range: { startTime: string; endTime: string }] }>()
const cookie = ref('')
const configured = ref(false)
const loading = ref(true)
const loadFailed = ref(false)
const busy = ref('')
const error = ref('')
const notice = ref('')
let request = 0
// datetime-local carries an explicit Beijing wall time, regardless of the browser timezone.
function beijingTime(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)
}
const now = Date.now()
const startTime = ref(beijingTime(new Date(now - 24 * 60 * 60 * 1000)))
const endTime = ref(beijingTime(new Date(now)))
const dateError = computed(() => !startTime.value || !endTime.value ? '请选择开始和结束时间。'
  : startTime.value >= endTime.value ? '结束时间必须晚于开始时间。' : '')
watch([configured, cookie, loading, busy, dateError, error], () => {
  emit('ready', configured.value && !cookie.value && !loading.value && !busy.value && !dateError.value && !error.value)
}, { immediate: true })
watch([startTime, endTime], () => {
  const format = (value: string) => value.replace('T', ' ').padEnd(19, ':00')
  emit('change', { startTime: format(startTime.value), endTime: format(endTime.value) })
}, { immediate: true })

// Keep credentials out of the shared API helper, which logs request bodies.
async function call(path: string, method = 'GET', body?: object) {
  const response = await fetch(`/api/v1/history-scripts/czgts/${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || result.code >= 400) throw new Error(result?.message || '文章采集服务暂时不可用')
  return result.data
}
async function load() {
  const current = ++request
  loading.value = true; error.value = ''; loadFailed.value = false
  try {
    const data = await call('settings')
    if (current === request) configured.value = data?.configured === true
  } catch (err: any) {
    if (current === request) { error.value = err.message; loadFailed.value = true }
  } finally { if (current === request) loading.value = false }
}
async function save() {
  if (!cookie.value.trim() || props.disabled || busy.value) return
  const current = ++request
  busy.value = 'save'; error.value = ''; notice.value = ''
  try {
    const data = await call('settings', 'PUT', { cookie: cookie.value.trim() })
    if (current !== request) return
    configured.value = data?.configured === true
    cookie.value = ''
    notice.value = '登录 Cookie 已保存。'
  } catch (err: any) { if (current === request) error.value = err.message }
  finally { if (current === request) busy.value = '' }
}
async function check() {
  if (!configured.value || cookie.value || props.disabled || busy.value) return
  const current = ++request
  busy.value = 'check'; error.value = ''; notice.value = ''
  try {
    const data = await call('check', 'POST', {})
    if (current !== request) return
    configured.value = data?.configured === true
    notice.value = data?.message || `接口可用，共找到 ${data?.total ?? 0} 篇文章。`
  } catch (err: any) { if (current === request) error.value = err.message }
  finally { if (current === request) busy.value = '' }
}
onMounted(load)
onBeforeUnmount(() => { request++; cookie.value = '' })
</script>

<style scoped>
.czgts-settings { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
p { margin: 8px 0; font-size: 12px; line-height: 1.65; color: var(--text-secondary); }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
label { display: grid; gap: 6px; font-size: 12px; }
input { width: 100%; min-width: 0; margin-top: 6px; box-sizing: border-box; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.date-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.error { color: var(--error, #b91c1c); }
@media (max-width: 480px) { .date-fields { grid-template-columns: 1fr; } }
</style>
