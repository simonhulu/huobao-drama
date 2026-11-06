<template>
  <div class="light-editor">
    <p class="note">以完整原稿为底稿。保留讲述顺序、铺垫、转场和结尾，只调整必要词句；原句合适时可以完全不改。</p>
    <div v-if="error" class="error" role="alert">{{ error }}</div>
    <div class="comparison">
      <section><header><h3>原稿底稿</h3><span>{{ source.length }} 字</span></header><textarea ref="original" :value="source" readonly aria-label="轻改原稿底稿" @mouseup="captureSelection" @keyup="captureSelection" /><small>选中一个词组或一句话，进行局部等义修改。</small></section>
      <section><header><h3>轻改全文</h3><span>{{ output.length }} 字 · {{ patches.length }} 处修改</span></header><div class="result-text" aria-label="轻改全文" tabindex="0"><template v-for="(segment, index) in segments" :key="index"><mark v-if="segment.patch && segment.text" :title="segment.patch.reason">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></div><small>高亮显示实际修改，其他文字保持原样。</small></section>
    </div>
    <form v-if="selection.end > selection.start" class="local-edit" @submit.prevent="addPatch">
      <header><h3>局部等义修改</h3><button type="button" class="btn btn-sm btn-ghost" @click="clearSelection">收起</button></header>
      <blockquote>{{ source.slice(selection.start, selection.end) }}</blockquote>
      <label>改成<textarea :value="selection.replacement" aria-label="局部修改内容" :disabled="disabled" @input="setSelection({ replacement: inputValue($event) })" /></label>
      <label>修改理由<input :value="selection.reason" aria-label="局部修改理由" :disabled="disabled" placeholder="例如：替换不常用的词，保留原句意思" @input="setSelection({ reason: inputValue($event) })" /></label>
      <p v-if="identityKind" class="note">所选位置已标记为{{ identityKind === 'promotion' ? '营销' : identityKind === 'attribution' ? '亲历归属' : '作者身份' }}片段。清理时保留交织的故事内容。</p>
      <button type="submit" class="btn" :disabled="disabled || !selection.reason.trim() || (!selection.replacement.trim() && !['identity', 'promotion'].includes(identityKind))">加入修改清单</button>
    </form>
    <section class="patches"><header><h3>逐处修改清单</h3><span>{{ patches.length ? '保存后重新检查句义和全文' : '当前保留全部原文' }}</span></header>
      <p v-if="!patches.length" class="note">没有修改。原句可以直接保留，不要求改动比例。</p>
      <article v-for="(patch, index) in sortedPatches" :key="patch.id" class="patch-card">
        <header><button type="button" class="locate" @click="locate(patch)">第 {{ index + 1 }} 处 · 定位原句</button><button type="button" class="btn btn-sm" :aria-label="`恢复第 ${index + 1} 处原句`" :disabled="disabled" @click="removePatch(patch.id)">恢复原句</button></header>
        <dl><div><dt>原文</dt><dd><del>{{ patch.original }}</del></dd></div><div><dt>{{ patch.replacement ? '改句' : '删除' }}</dt><dd><mark>{{ patch.replacement || '已标记的身份或营销片段' }}</mark></dd></div><div><dt>理由</dt><dd>{{ patch.reason }}</dd></div></dl>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="disabled" @click="editPatch(patch)">调整这一处</button>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Analysis, Patch } from './types'

export interface LocalSelection { start: number; end: number; replacement: string; reason: string; patchId: string }
const props = defineProps<{ source: string; patches: Patch[]; analysis: Analysis | null; selection: LocalSelection; disabled?: boolean }>()
const emit = defineEmits<{ 'update:patches': [Patch[]]; 'update:selection': [LocalSelection] }>()
const original = ref<HTMLTextAreaElement | null>(null)
const localError = ref('')
const sortedPatches = computed(() => [...props.patches].sort((a, b) => a.start - b.start))
const validationError = computed(() => {
  let previousEnd = 0
  for (const patch of sortedPatches.value) {
    if (patch.start < previousEnd || patch.start < 0 || patch.end <= patch.start || props.source.slice(patch.start, patch.end) !== patch.original) return '修改与原稿位置不一致或存在重叠，请恢复对应原句后重新选择。'
    previousEnd = patch.end
  }
  return ''
})
const error = computed(() => localError.value || validationError.value)
const segments = computed(() => {
  if (validationError.value) return [{ text: props.source, patch: null as Patch | null }]
  const result: Array<{ text: string; patch: Patch | null }> = []
  let cursor = 0
  for (const patch of sortedPatches.value) {
    result.push({ text: props.source.slice(cursor, patch.start), patch: null }, { text: patch.replacement, patch })
    cursor = patch.end
  }
  result.push({ text: props.source.slice(cursor), patch: null })
  return result
})
const output = computed(() => segments.value.map(segment => segment.text).join(''))
const identityKind = computed(() => props.analysis?.identitySpans?.find(span => span.start <= props.selection.start && span.end >= props.selection.end)?.kind || 'wording')
function inputValue(event: Event) { return (event.target as HTMLInputElement).value }
function setSelection(patch: Partial<LocalSelection>) { emit('update:selection', { ...props.selection, ...patch }) }
function clearSelection() { emit('update:selection', { start: 0, end: 0, replacement: '', reason: '', patchId: '' }); localError.value = '' }
function captureSelection() {
  if (props.disabled || !original.value) return
  const start = original.value.selectionStart, end = original.value.selectionEnd
  if (end <= start) return
  const existing = props.patches.find(patch => patch.start === start && patch.end === end)
  emit('update:selection', { start, end, replacement: existing?.replacement ?? props.source.slice(start, end), reason: existing?.reason || '', patchId: existing?.id || '' })
  localError.value = ''
}
function locate(patch: Pick<Patch, 'start' | 'end'>) {
  original.value?.focus()
  original.value?.setSelectionRange(patch.start, patch.end)
}
function editPatch(patch: Patch) { locate(patch); emit('update:selection', { start: patch.start, end: patch.end, replacement: patch.replacement, reason: patch.reason, patchId: patch.id }); localError.value = '' }
function removePatch(id: string) { emit('update:patches', props.patches.filter(patch => patch.id !== id)); if (props.selection.patchId === id) clearSelection() }
function addPatch() {
  const { start, end, replacement, reason, patchId } = props.selection
  const selected = props.source.slice(start, end)
  localError.value = ''
  if (replacement === selected) { if (patchId) removePatch(patchId); clearSelection(); return }
  if (props.patches.some(patch => patch.id !== patchId && patch.start < end && patch.end > start)) { localError.value = '所选文字与已有修改重叠，请使用“调整这一处”或先恢复原句。'; return }
  if (identityKind.value === 'wording' && (/\n\s*\n/.test(selected) || /[。！？!?][”’」』"']?\s*\S/.test(selected))) { localError.value = '普通轻改每次只选择一个词组或一句话，保留原稿的完整推进。'; return }
  const patch: Patch = { id: patchId || crypto.randomUUID(), start, end, original: selected, replacement, reason: reason.trim(), kind: identityKind.value as Patch['kind'] }
  emit('update:patches', [...props.patches.filter(item => item.id !== patchId), patch].sort((a, b) => a.start - b.start))
  clearSelection()
}
</script>

<style scoped>
.light-editor{min-width:0}.note,small{color:var(--text-2);font-size:12px;line-height:1.8}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}.comparison section{min-width:0}header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}h3{font-size:14px;margin:0}header span{font-size:12px;color:var(--text-2)}textarea,input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-0);color:var(--text-1);font:inherit;line-height:1.95;resize:vertical}.comparison textarea,.result-text{min-height:350px;height:48vh;max-height:680px;overflow:auto;font-size:14px}.result-text{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;border:1px solid var(--border);border-radius:6px;line-height:1.95;box-sizing:border-box}.local-edit{display:grid;gap:12px;padding:16px;border:1px solid var(--border);background:var(--bg-1);border-radius:6px;margin:18px 0}.local-edit label{display:grid;gap:6px}.local-edit button[type=submit]{justify-self:start}.local-edit textarea{min-height:85px}blockquote{margin:0;padding:8px 12px;border-left:2px solid var(--info);white-space:pre-wrap;overflow-wrap:anywhere}.patches{margin-top:24px}.patch-card{border-top:1px solid var(--border);padding:16px 0}.patch-card dl{display:grid;gap:8px;margin:10px 0}.patch-card dl>div{display:grid;grid-template-columns:36px minmax(0,1fr);gap:10px}.patch-card dt{color:var(--text-2);font-size:12px}.patch-card dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}.locate{border:0;padding:0;color:var(--info);background:transparent;font:inherit;cursor:pointer}mark{background:var(--warning-bg,#fff5d8);color:inherit;border-radius:2px}.removed{font-size:11px;color:var(--text-2);text-decoration:line-through}del{color:var(--text-2)}.error{padding:10px;border:1px solid var(--warning);border-radius:6px;color:var(--warning)}@media(max-width:900px){.comparison{grid-template-columns:1fr}.comparison textarea,.result-text{height:310px;min-height:250px}}
</style>
