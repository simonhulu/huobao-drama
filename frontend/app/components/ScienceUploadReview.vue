<template>
  <dialog ref="dialog" class="review-dialog" aria-labelledby="science-review-title" @close="emit('close')">
    <header class="review-header">
      <div><h2 id="science-review-title">百家号核对窗口</h2><p>{{ job.title }}<span>{{ job.accountLabel }}</span></p></div>
      <button class="review-tool" type="button" aria-label="关闭核对窗口" title="关闭核对窗口" @click="dialog?.close()"><X :size="18" /></button>
    </header>
    <div class="review-toolbar">
      <div class="review-views" role="tablist" aria-label="百家号页面"><button role="tab" :aria-selected="view === 'original'" :disabled="busy" @click="openView('original')">原编辑页</button><button role="tab" :aria-selected="view === 'content'" :disabled="busy" @click="openView('content')">内容管理</button></div>
      <div class="review-keys"><button class="review-tool" type="button" :disabled="!snapshot" :aria-label="zoomed ? '缩小百家号画面' : '放大百家号画面'" :title="zoomed ? '缩小画面' : '放大画面'" @click="zoomed = !zoomed"><ZoomOut v-if="zoomed" :size="16" /><ZoomIn v-else :size="16" /></button><button class="review-tool" type="button" :disabled="busy || !snapshot" aria-label="刷新百家号画面" title="刷新画面" @click="sendInput({ action: 'refresh' })"><RefreshCw :size="16" :class="{ spin: busy }" /></button></div>
    </div>
    <div class="review-body">
      <p v-if="error" class="review-error" role="alert">{{ error }}<button class="btn btn-sm" :disabled="busy" @click="openView(view)"><RefreshCw :size="13" />重试连接</button></p>
      <p v-if="snapshot?.message" class="review-message" role="status">{{ snapshot.message }}</p>
      <p v-if="snapshot?.url" class="review-url">{{ snapshot.url }}</p>
      <div v-if="snapshot" ref="canvas" class="review-canvas" :class="{ busy }" :style="{ aspectRatio: `${snapshot.width} / ${snapshot.height}`, width: zoomed ? 'max(100%, 900px)' : '100%' }" tabindex="0" role="application" aria-label="百家号页面，可点击、拖动和输入" :aria-busy="busy" @pointerdown="startPointer" @pointerup="endPointer" @pointercancel="pointer = null" @keydown="sendKey" @wheel.prevent="scrollPage">
        <img :src="snapshot.imageDataUrl" alt="当前任务账号的百家号页面" draggable="false" />
        <span v-if="busy" class="review-loading" role="status"><LoaderCircle :size="19" class="spin" />正在更新画面</span>
      </div>
      <div v-else-if="busy" class="review-connecting" role="status"><LoaderCircle :size="22" class="spin" />正在连接任务的百家号账号…</div>
    </div>
      <div v-if="snapshot" class="review-inputs">
        <form class="review-text" @submit.prevent="typeText"><input v-model="text" aria-label="输入到百家号页面的文字" placeholder="输入文字" :disabled="busy" autocomplete="off" /><button class="review-tool" type="submit" :disabled="busy || !text" aria-label="输入文字" title="输入文字"><SendHorizontal :size="16" /></button></form>
        <div class="review-keys"><button v-for="key in keys" :key="key.value" class="review-tool" type="button" :disabled="busy" :aria-label="key.label" :title="key.label" @click="sendInput({ action: 'key', key: key.value })"><component :is="key.icon" :size="16" /></button></div>
        <div class="review-keys"><button class="review-tool" type="button" :disabled="busy" aria-label="百家号页面向上滚动" title="向上滚动" @click="sendInput({ action: 'scroll', deltaY: -550 })"><ArrowUp :size="16" /></button><button class="review-tool" type="button" :disabled="busy" aria-label="百家号页面向下滚动" title="向下滚动" @click="sendInput({ action: 'scroll', deltaY: 550 })"><ArrowDown :size="16" /></button></div>
      </div>
    <footer><button class="btn" type="button" @click="dialog?.close()">返回任务</button><button class="btn btn-primary" type="button" :disabled="busy" @click="emit('check')"><Search :size="14" />只核对上传结果</button></footer>
  </dialog>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDown, ArrowRightToLine, ArrowUp, CornerDownLeft, Delete, LoaderCircle, RefreshCw, Search, SendHorizontal, TextSelect, X, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = defineProps({ job: { type: Object, required: true }, initialView: { type: String, default: 'original' } })
const emit = defineEmits(['close', 'check'])
const dialog = ref(null), canvas = ref(null), snapshot = ref(null), busy = ref(false), error = ref(''), text = ref(''), view = ref(props.initialView)
const zoomed = ref(false)
const keys = [{ value: 'ControlOrMeta+A', label: '全选当前输入框', icon: TextSelect }, { value: 'Enter', label: '回车', icon: CornerDownLeft }, { value: 'Tab', label: '下一个输入位置', icon: ArrowRightToLine }, { value: 'Backspace', label: '退格', icon: Delete }, { value: 'Escape', label: '关闭百家号弹层', icon: X }]
const base = `/science-pop/workflow/jobs/${encodeURIComponent(props.job.id)}/upload-review`
let disposed = false, pointer = null

function acceptSnapshot(result) {
  if (result.jobId !== props.job.id || !result.targetId || !/^data:image\/(?:png|jpeg);base64,/.test(result.imageDataUrl || '')
    || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) throw new Error('百家号画面未确认，请重新连接')
  snapshot.value = result
}
async function request(path, body) {
  if (busy.value || disposed) return
  busy.value = true; error.value = ''
  try {
    const result = await api.post(path, body)
    if (!disposed) acceptSnapshot(result)
  } catch (failure) { if (!disposed) error.value = failure.message || '暂时无法连接百家号，请重试' }
  finally { if (!disposed) busy.value = false }
}
async function openView(next) {
  if (busy.value) return
  view.value = next
  await request(base, { view: next })
}
async function sendInput(input) {
  if (!snapshot.value) return
  await request(`${base}/input`, { targetId: snapshot.value.targetId, ...input })
}
function position(event) {
  const rect = canvas.value.getBoundingClientRect()
  return { x: Math.max(0, Math.min(snapshot.value.width - 1, Math.round((event.clientX - rect.left) * snapshot.value.width / rect.width))),
    y: Math.max(0, Math.min(snapshot.value.height - 1, Math.round((event.clientY - rect.top) * snapshot.value.height / rect.height))) }
}
function startPointer(event) {
  if (busy.value || event.button !== 0) return
  pointer = { ...position(event), id: event.pointerId }
  canvas.value.setPointerCapture(event.pointerId)
  canvas.value.focus({ preventScroll: true })
}
async function endPointer(event) {
  const start = pointer; pointer = null
  if (!start || start.id !== event.pointerId || busy.value) return
  const end = position(event)
  await sendInput(Math.hypot(end.x - start.x, end.y - start.y) > 8
    ? { action: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y }
    : { action: 'click', x: end.x, y: end.y })
}
async function sendKey(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); await sendInput({ action: 'key', key: 'ControlOrMeta+A' }); return }
  if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape' || event.key === 'Tab') return
  event.preventDefault()
  if (event.key.length === 1) await sendInput({ action: 'type', text: event.key })
  else if (['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) await sendInput({ action: 'key', key: event.key })
}
async function typeText() {
  if (!text.value || busy.value) return
  const value = text.value
  await sendInput({ action: 'type', text: value })
  if (!error.value) text.value = ''
}
async function scrollPage(event) {
  if (Math.abs(event.deltaY) < 15 || busy.value) return
  await sendInput({ action: 'scroll', deltaY: Math.round(Math.max(-1000, Math.min(1000, event.deltaY))) })
}
onMounted(() => { dialog.value.showModal(); void openView(view.value) })
onBeforeUnmount(() => { disposed = true })
</script>

<style scoped>
.review-dialog { position: fixed; inset: 0; width: min(1180px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); box-sizing: border-box; padding: 0; margin: auto; overflow: auto; color: var(--text-1); background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-elevated); font-size: 13px; letter-spacing: 0; }
.review-dialog::backdrop { background: rgb(9 9 11 / 42%); }
.review-dialog[open] { display: flex; flex-direction: column; height: min(940px, calc(100dvh - 32px)); overflow: hidden; }
.review-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.review-header > div { min-width: 0; }.review-header h2 { font-size: 17px; margin: 0; letter-spacing: 0; }.review-header p { margin: 6px 0 0; color: var(--text-2); overflow-wrap: anywhere; }.review-header p span { display: inline-block; margin-left: 12px; }
.review-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
.review-views { display: flex; gap: 4px; }.review-views button { border: 0; border-bottom: 2px solid transparent; padding: 7px 10px; color: var(--text-2); background: transparent; font: inherit; cursor: pointer; }.review-views button[aria-selected="true"] { border-color: var(--info); color: var(--text-1); font-weight: 600; }
.review-tool { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-0); color: var(--text-1); flex-shrink: 0; cursor: pointer; }.review-tool:hover:not(:disabled) { background: var(--bg-1); }.review-tool:disabled { opacity: .5; cursor: default; }
.review-body { padding: 14px 20px; flex: 1; min-height: 0; overflow: auto; }.review-message { margin: 0 0 10px; color: var(--text-2); line-height: 1.7; }.review-url { margin: 0 0 8px; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }
.review-canvas { position: relative; width: 100%; background: var(--bg-1); border: 1px solid var(--border); box-sizing: border-box; touch-action: none; cursor: default; }.review-canvas img { display: block; position: absolute; inset: 0; width: 100%; height: 100%; user-select: none; pointer-events: none; }.review-canvas.busy { cursor: progress; }.review-loading { position: absolute; right: 12px; top: 12px; display: flex; align-items: center; gap: 7px; padding: 6px 9px; background: var(--bg-0); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
.review-connecting { min-height: 280px; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--text-2); }
.review-error { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; color: var(--error); background: var(--error-bg); padding: 10px 12px; margin: 0 0 12px; overflow-wrap: anywhere; }
.review-inputs { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 10px 20px; border-top: 1px solid var(--border); }.review-text { display: flex; align-items: center; flex: 1; min-width: 180px; gap: 6px; }.review-text input { width: 100%; min-width: 0; height: 34px; padding: 6px 9px; box-sizing: border-box; color: var(--text-1); background: var(--bg-0); border: 1px solid var(--border); border-radius: 5px; font: inherit; }.review-keys { display: flex; gap: 5px; }
.review-header,.review-toolbar,.review-inputs,.review-dialog footer { flex-shrink: 0; }
.review-dialog footer { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border); }.review-dialog .btn { display: inline-flex; gap: 6px; align-items: center; border-radius: 6px; }.review-dialog :is(button,input,[tabindex]):focus-visible { outline: 2px solid var(--info); outline-offset: 2px; }
.spin { animation: science-review-spin 1s linear infinite; }@keyframes science-review-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .review-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }.review-header,.review-toolbar,.review-dialog footer { padding: 12px; }.review-body { padding: 12px; }.review-header h2 { font-size: 15px; }.review-text { flex-basis: 100%; }.review-header p span { display: block; margin: 4px 0 0; } }
</style>
