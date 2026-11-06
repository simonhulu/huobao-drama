<template>
  <section class="keyword-settings" aria-label="采集关键词设置">
    <header><strong>采集关键词</strong><span>逐个搜索 · 跨关键词去重</span></header>
    <p>按列表顺序分别搜索，例如先搜「历史」，再搜「明朝」。达到本次产出数量后结束。</p>
    <p v-if="loading" role="status">正在读取关键词…</p>
    <fieldset v-else :disabled="saving || disabled">
      <div v-for="(keyword, index) in draft" :key="index" class="keyword-row">
        <span class="keyword-order">{{ index + 1 }}</span>
        <input v-model="draft[index]" class="input" :aria-label="`采集关键词 ${index + 1}`" maxlength="80" />
        <button type="button" class="btn btn-sm" :aria-label="`删除关键词 ${index + 1}`" @click="draft.splice(index, 1)">删除</button>
      </div>
      <div class="keyword-actions">
        <button type="button" class="btn btn-sm" :disabled="draft.length >= 30" @click="draft.push('')">添加关键词</button>
        <button type="button" class="btn btn-sm" :disabled="!dirty || Boolean(validation)" @click="save">{{ saving ? '保存中…' : '保存关键词' }}</button>
      </div>
    </fieldset>
    <p v-if="validation && dirty" class="warning" role="status">{{ validation }}</p>
    <p v-else-if="dirty" class="warning" role="status">关键词有未保存修改，请保存后开始采集。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button type="button" class="btn btn-sm" :disabled="loading || saving" @click="load">重新读取</button></p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<script setup lang="ts">
import { historyScriptAPI } from '~/composables/useApi'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ change: [keywords: string[]]; ready: [ready: boolean] }>()
const draft = ref<string[]>([])
const saved = ref<string[]>([])
const loading = ref(true)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
const notice = ref('')
let request = 0
const normalized = computed(() => draft.value.map(value => value.trim()))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value))
const validation = computed(() => !draft.value.length ? '请保留至少一个关键词。'
  : normalized.value.some(value => !value) ? '关键词不能为空。'
  : new Set(normalized.value).size !== normalized.value.length ? '关键词不能重复。' : '')
watch([dirty, loading, saving, loaded, error], () => emit('ready', loaded.value && !dirty.value && !loading.value && !saving.value && !error.value), { immediate: true })

function accept(data: { keywords: string[] }) {
  if (!Array.isArray(data?.keywords) || !data.keywords.length || data.keywords.some(value => typeof value !== 'string')) throw new Error('关键词配置读取失败，请重试')
  draft.value = [...data.keywords]
  saved.value = [...data.keywords]
  loaded.value = true
  emit('change', [...data.keywords])
}
async function load() {
  const current = ++request
  loading.value = true
  error.value = ''; notice.value = ''
  try {
    const data = await historyScriptAPI.collectionSettings()
    if (current === request) accept(data)
  } catch (err: any) { if (current === request) error.value = err.message || '读取关键词失败' }
  finally { if (current === request) loading.value = false }
}
async function save() {
  if (validation.value || saving.value) return
  const current = ++request
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const data = await historyScriptAPI.saveCollectionSettings({ keywords: normalized.value })
    if (current !== request) return
    accept(data)
    notice.value = '关键词已保存，将用于下次采集。'
  } catch (err: any) { if (current === request) error.value = err.message || '保存关键词失败' }
  finally { if (current === request) saving.value = false }
}
onMounted(load)
onBeforeUnmount(() => { request++ })
</script>

<style scoped>
.keyword-settings { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px; }
header span, p { font-size: 12px; color: var(--text-secondary); line-height: 1.65; }
p { margin: 8px 0; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.keyword-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.keyword-row input { flex: 1; min-width: 0; }
.keyword-order { color: var(--text-secondary); width: 16px; }
.keyword-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.error { color: var(--error, #b91c1c); }
.warning { color: #9a4c08; }
</style>
