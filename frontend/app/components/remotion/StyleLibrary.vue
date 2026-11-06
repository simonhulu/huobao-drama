<template>
  <section class="style-library" aria-label="画面风格库">
    <div v-if="loading" class="catalog-state" role="status">正在加载画面风格…</div>
    <div v-else-if="error" class="catalog-state"><h2>画面风格加载失败</h2><p role="alert">{{ error }}</p><button class="btn" @click="load">重试加载风格</button></div>
    <div v-else-if="!selected" class="catalog-state"><h2>暂无画面风格</h2><p>添加风格后，已保存的预览会显示在这里。</p></div>
    <template v-else>
      <div class="catalog-head">
        <div><h2>画面风格</h2><p>用于补充图片和视觉统一。浏览风格不会修改项目。</p></div>
        <div class="style-tabs" role="tablist" aria-label="风格查看模式" @keydown="modeKeydown">
          <button v-for="item in modes" :id="`style-${item.id}-tab`" :key="item.id" role="tab" :aria-selected="mode === item.id" :tabindex="mode === item.id ? 0 : -1" :class="{active: mode === item.id}" @click="mode = item.id">{{ item.label }}</button>
        </div>
      </div>
      <div class="catalog-layout">
        <nav class="style-rail" aria-label="选择画面风格">
          <button v-for="(style, index) in styles" :key="style.id" class="rail-style" :class="{active: selected.id === style.id}" :aria-pressed="selected.id === style.id" @click="selectedId = style.id" @keydown="railKeydown($event, index)"><strong>{{ style.name }}</strong><span>{{ style.mood }} · {{ style.lens }}</span></button>
        </nav>
        <div v-if="mode === 'preview'" class="style-preview" role="tabpanel" aria-labelledby="style-preview-tab">
          <div class="video-shell">
            <div v-if="selected.mediaType !== 'prompt' && (!selected.url || mediaErrors[selected.id])" class="catalog-state"><strong>预览文件暂不可用</strong><p>风格信息仍然保留。</p><button v-if="selected.url" class="btn" @click="retryPreview(selected.id)">重试预览</button></div>
            <img v-else-if="selected.mediaType === 'image'" :key="previewUrl(selected)" class="style-image" :src="previewUrl(selected)" :alt="`${selected.name}示意图`" @error="mediaErrors[selected.id] = true" />
            <div v-else-if="selected.mediaType === 'prompt'" class="style-prompt-preview"><strong>{{ selected.name }}</strong><p>{{ selected.prompt }}</p></div>
            <video v-else :key="previewUrl(selected)" :src="previewUrl(selected)" controls playsinline preload="metadata" @error="mediaErrors[selected.id] = true" />
          </div>
          <p class="style-description">{{ selected.desc || selected.profile }} <span>{{ selected.aspectRatio }}</span></p>
          <a v-if="selected.url && !mediaErrors[selected.id]" :href="selected.url" target="_blank" rel="noreferrer">打开预览文件</a>
        </div>
        <div v-else class="style-compare" role="tabpanel" aria-labelledby="style-compare-tab">
          <button v-for="style in styles" :key="style.id" class="compare-style" :class="{active: selected.id === style.id}" :aria-pressed="selected.id === style.id" @click="selectedId = style.id">
            <span class="compare-media"><span v-if="style.mediaType !== 'prompt' && (!style.url || mediaErrors[style.id])">预览文件暂不可用</span><img v-else-if="style.mediaType === 'image'" :src="previewUrl(style)" :alt="`${style.name}示意图`" @error="mediaErrors[style.id] = true" /><span v-else-if="style.mediaType === 'prompt'">{{ style.prompt }}</span><video v-else :src="previewUrl(style)" muted playsinline preload="metadata" @error="mediaErrors[style.id] = true" /></span><strong>{{ style.name }}</strong>
          </button>
        </div>
      </div>
      <div class="style-apply"><label for="style-project">应用到项目</label><select id="style-project" v-model="projectId"><option value="">选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }}</option></select><button class="btn" :disabled="!projectId || saving" @click="apply">{{ saving ? '保存中…' : '应用当前风格' }}</button><span v-if="feedback" role="status">{{ feedback }}</span></div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { dramaAPI, remotionAPI } from '~/composables/useApi'
interface Style { id: string; name: string; desc?: string; mood?: string; lens?: string; profile?: string; url?: string; mediaType: string; aspectRatio?: string; prompt?: string }
defineProps<{ projects: Array<{id: number; title: string}> }>()
const styles = ref<Style[]>([]), selectedId = ref(''), loading = ref(true), error = ref('')
const mediaErrors = ref<Record<string, boolean>>({}), versions = ref<Record<string, number>>({})
const mode = ref('preview'), projectId = ref<number | ''>(''), saving = ref(false), feedback = ref('')
const modes = [{ id: 'preview', label: '预览' }, { id: 'compare', label: '对比' }]
const selected = computed(() => styles.value.find(s => s.id === selectedId.value) || styles.value[0])
async function load() { loading.value = true; error.value = ''; try { styles.value = (await remotionAPI.stylePilots()).items; mediaErrors.value = {} } catch (e: any) { error.value = e.message || '读取画面风格失败' } finally { loading.value = false } }
function previewUrl(style: Style) { return style.url ? `${style.url}${versions.value[style.id] ? `${style.url.includes('?') ? '&' : '?'}previewRetry=${versions.value[style.id]}` : ''}` : undefined }
function retryPreview(id: string) { versions.value[id] = Date.now(); delete mediaErrors.value[id] }
function modeKeydown(event: KeyboardEvent) { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); mode.value = ['ArrowLeft','Home'].includes(event.key) ? 'preview' : 'compare'; nextTick(() => document.getElementById(`style-${mode.value}-tab`)?.focus()) }
function railKeydown(event: KeyboardEvent, index: number) { if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? styles.value.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + styles.value.length) % styles.value.length; selectedId.value = styles.value[next]!.id; (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus() }
async function apply() { if (!projectId.value || !selected.value || saving.value) return; saving.value = true; feedback.value = ''; try { await dramaAPI.update(projectId.value, {style:selected.value.id}); feedback.value = '项目风格已保存' } catch(e: any) { feedback.value = e.message || '保存失败，请重试' } finally { saving.value = false } }
onMounted(load)
</script>
<style scoped>
.style-library{font-size:13px}.catalog-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.catalog-head h2{font:600 17px var(--font-body);margin:0 0 4px}.catalog-head p,.style-description{margin:0;color:var(--text-2);line-height:1.6}.catalog-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px}.style-rail{display:flex;flex-direction:column;gap:4px;max-height:440px;overflow:auto}.rail-style{padding:12px;text-align:left;background:none;border:1px solid transparent;border-radius:6px;cursor:pointer}.rail-style strong,.rail-style span{display:block}.rail-style span{font-size:12px;color:var(--text-2);margin-top:4px}.rail-style.active{background:var(--bg-2);border-color:var(--border-strong)}.rail-style:hover{background:var(--bg-1)}.style-tabs{display:flex;gap:4px}.style-tabs button{padding:8px 14px;border:0;background:none;cursor:pointer;color:var(--text-2);border-bottom:2px solid transparent}.style-tabs button.active{color:var(--text-0);border-bottom-color:var(--text-0)}.video-shell{height:320px;background:var(--bg-2);display:grid;place-items:center;border-radius:8px;overflow:hidden}.video-shell img,.video-shell video{width:100%;height:100%;object-fit:contain}.style-description{margin:12px 0 8px}.style-description span{margin-left:12px}.style-prompt-preview{padding:24px;line-height:1.8;max-width:65ch}.style-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-height:440px;overflow:auto}.compare-style{text-align:left;border:1px solid var(--border);background:none;border-radius:8px;overflow:hidden;padding:0;cursor:pointer}.compare-style.active{border-color:var(--text-0)}.compare-style>strong{display:block;padding:12px}.compare-media{display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;background:var(--bg-2);overflow:hidden}.compare-media img,.compare-media video{width:100%;height:100%;object-fit:contain}.compare-media>span{padding:16px}.catalog-state{padding:32px;text-align:center;color:var(--text-2)}.catalog-state h2{font:600 17px var(--font-body)}.style-apply{display:flex;align-items:center;gap:12px;border-top:1px solid var(--border);padding-top:16px;margin-top:24px;flex-wrap:wrap}.style-apply select{max-width:300px;min-width:160px;height:34px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-0);padding:0 8px;color:var(--text-0)}button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:760px){.catalog-head{align-items:flex-start}.catalog-head p{max-width:26ch}.catalog-layout{grid-template-columns:1fr;gap:16px}.style-rail{max-height:160px}.video-shell{height:240px}.style-compare{gap:8px}}
</style>
