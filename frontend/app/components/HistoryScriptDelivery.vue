<template>
  <section :id="'history-delivery-' + scriptId" class="delivery" aria-label="成片与封面">
    <header><h2>成片与封面</h2><span>脚本 #{{ scriptId }}</span></header>
    <p v-if="loading" role="status">正在读取成片与封面…</p>
    <p v-if="error && !coverActionError" class="error" role="alert">{{ error }} <button v-if="!delivery" type="button" class="btn btn-sm" @click="load">重试</button></p>
    <template v-if="delivery">
      <p v-if="delivery.scriptChanged" class="warning">脚本在素材准备后发生了变化，请核对两版成片，并重新整理标题。</p>
      <p v-if="delivery.coversChanged" class="warning">标题已更新，下面的图片仍是旧版，请重新生成截图封面。</p>

      <section class="video-section" :aria-labelledby="'history-video-heading-' + scriptId">
        <div class="video-heading">
          <div>
            <h3 :id="'history-video-heading-' + scriptId">成片版本</h3>
            <p class="hint">花生版和精细化版各自保留，可切换回看与下载。</p>
          </div>
          <label class="btn video-picker" :class="{ 'btn-primary': !videoItems.length, 'is-disabled': busy }">
            <Upload :size="16" aria-hidden="true" />
            <span>{{ videoItems.length ? '补充手动成片' : '提交成片' }}</span>
            <input class="video-input" type="file" aria-label="提交手动成片" accept="video/*,.mp4,.mov,.m4v,.webm" :disabled="busy" @change="uploadVideo" />
          </label>
        </div>
        <div v-if="videoItems.length" class="video-versions" role="group" aria-label="成片版本">
          <button v-for="videoItem in videoItems" :key="videoItem.id" type="button" class="version-tab"
            :class="{ selected: selectedVideo?.id === videoItem.id }"
            :disabled="!!action" :aria-pressed="selectedVideo?.id === videoItem.id" @click="selectVideo(videoItem.id)">
            <strong>{{ producerLabel(videoItem.producer) }}</strong><span>{{ videoItem.videoName }}</span><span class="version-status">{{ packagingStatus(videoItem.id) }}</span>
          </button>
        </div>
        <div v-if="selectedVideo" class="video-preview">
          <video :key="selectedVideo.videoUrl" :src="selectedVideo.videoUrl" :aria-label="producerLabel(selectedVideo.producer) + '预览'" controls preload="metadata" />
          <div class="video-meta">
            <strong>{{ producerLabel(selectedVideo.producer) }}</strong>
            <span>{{ selectedVideo.videoName }}<span v-if="selectedVideo.duration"> · {{ formatDuration(selectedVideo.duration) }}</span></span>
            <a :href="selectedVideo.videoUrl" :download="selectedVideo.videoName">下载此版本</a>
          </div>
        </div>
        <p v-else class="empty-output">暂未关联成片。完成花生制作或精细化制作后，成片会出现在这里。</p>
        <p v-if="action === 'upload'" role="status">{{ uploadProgress === 100 ? '上传完成，正在校验视频…' : '正在上传 ' + uploadProgress + '%' }}</p>
        <progress v-if="action === 'upload'" :value="uploadProgress" max="100" aria-label="成片上传进度" />
        <p v-if="action === 'reconcile-upload'" role="status">正在核对成片提交结果…</p>
        <p v-if="videoError" class="error" role="alert">{{ videoError }}</p>
        <p v-if="videoNotice" class="video-notice" role="status">{{ videoNotice }}</p>
        <details v-if="archivedVideos.length" class="video-history">
          <summary>查看旧稿与历史版本（{{ archivedVideos.length }}）</summary>
          <ul><li v-for="videoItem in archivedVideos" :key="videoItem.id">
            <span><strong>{{ producerLabel(videoItem.producer) }}</strong> · {{ videoItem.videoName }}</span>
            <a :href="videoItem.videoUrl" :download="videoItem.videoName">下载</a>
          </li></ul>
        </details>
      </section>

      <fieldset :disabled="busy" class="cover-editor">
        <legend>{{ selectedVideo ? producerLabel(selectedVideo.producer) + ' · ' : '' }}百家号发布标题与封面</legend>
        <button class="btn btn-sm" type="button" @click="run('design')">{{ action === 'design' || designGenerating ? '正在整理原标题…' : '整理原标题' }}</button>
        <p v-if="designGenerating" role="status">正在整理原标题…</p>
        <p v-if="delivery.designStatus === 'failed'" class="error" role="alert">标题整理失败：{{ delivery.designError || '请重试' }}</p>
        <label>百家号视频标题<textarea v-model="publishingTitle" rows="2" :aria-describedby="'publishing-title-hint-' + scriptId" /></label>
        <p :id="'publishing-title-hint-' + scriptId" class="hint">{{ characterCount(publishingTitle) }} / 40 字，含标点和空格。</p>
        <div v-if="publishingWarnings.length" class="warning publishing-warnings" role="status" aria-label="发布格式提醒">
          <p>标题内容已保留，请在发布前调整格式。</p>
          <ul><li v-for="warning in publishingWarnings" :key="warning">{{ warning }}</li></ul>
        </div>
        <div class="actions">
          <button class="btn" type="button" @click="run('save')">{{ action === 'save' ? '保存中…' : '保存标题' }}</button>
          <button class="btn btn-primary" type="button" :disabled="!canGenerate" @click="run('covers')">{{ generating ? '截图封面生成中…' : delivery.coverStatus === 'failed' ? '重试生成截图封面' : '生成截图封面' }}</button>
        </div>
        <div v-if="coverActionError" class="error cover-action-error" role="alert"><p>{{ coverActionError }}</p></div>
      </fieldset>

      <p v-if="generating" role="status">正在生成截图封面…</p>
      <p v-if="delivery.coverStatus === 'failed'" class="error" role="alert">截图封面生成失败：{{ delivery.error || '请重试' }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="covers">
        <figure v-for="cover in formats" :key="cover.ratio">
          <a v-if="delivery.covers?.[cover.ratio]" :href="delivery.covers[cover.ratio]" target="_blank" rel="noopener"><img :src="delivery.covers[cover.ratio]" :alt="cover.label + '封面'" :style="{ aspectRatio: cover.ratio.replace(':', '/') }" /></a>
          <div v-else class="cover-placeholder" :style="{ aspectRatio: cover.ratio.replace(':', '/') }">尚未生成</div>
          <figcaption><strong>{{ cover.label }}</strong><a v-if="delivery.covers?.[cover.ratio]" :href="delivery.covers[cover.ratio]" :download="'script-' + scriptId + '-' + cover.ratio.replace(':', 'x') + '.png'">下载封面</a></figcaption>
        </figure>
      </div>
      <details v-if="delivery.covers?.['4:3']" class="legacy-cover"><summary>其他已保存封面</summary><a :href="delivery.covers['4:3']" download>下载横版 4:3</a></details>

      <details v-if="selectedCandidate && delivery.coverPlan" class="plan-details" aria-label="封面策划依据">
        <summary>{{ hasCurrentPlan ? '原标题整理记录' : '上次原标题整理记录' }}</summary>
        <dl v-if="delivery.coverPlan.source_title_cleanup" class="plan-reasons source-title-record">
          <dt>采集原标题</dt><dd>{{ delivery.coverPlan.source_title_cleanup.source_title }}</dd>
          <dt>整理后标题</dt><dd>{{ delivery.coverPlan.source_title_cleanup.cleaned_title }}</dd>
        </dl>
        <dl v-else-if="delivery.coverPlan.source_title_rewrite" class="plan-reasons source-title-record">
          <dt>采集原标题</dt><dd>{{ delivery.coverPlan.source_title_rewrite.source_title }}</dd>
          <dt>整理后标题</dt><dd>{{ delivery.coverPlan.source_title_rewrite.title }}</dd>
          <dt>保留关键词</dt><dd>{{ delivery.coverPlan.source_title_rewrite.keywords.map(item => item.text).join('、') }}</dd>
          <dt v-if="delivery.coverPlan.source_title_rewrite.removed_promotions.length">移除推广</dt><dd v-if="delivery.coverPlan.source_title_rewrite.removed_promotions.length">{{ delivery.coverPlan.source_title_rewrite.removed_promotions.join('、') }}</dd>
        </dl>
        <dl v-if="delivery.coverPlan.publishing_version !== 'source-screenshot-v3'" class="plan-reasons">
          <dt>为什么想点</dt><dd>{{ selectedCandidate.why_click }}</dd>
          <dt>观众会追问</dt><dd>{{ selectedCandidate.viewer_question }}</dd>
          <dt>看完得到什么</dt><dd>{{ selectedCandidate.payoff }}</dd>
          <dt>正文依据</dt><dd><ul><li v-for="(quote, index) in selectedCandidate.evidence" :key="index">{{ quote }}</li></ul></dd>
          <dt>画面构思</dt><dd>{{ selectedCandidate.visual_concept }}</dd>
        </dl>
        <details v-if="delivery.coverPlan.publishing_version !== 'source-screenshot-v3' && delivery.coverPlan.title_rewrites"><summary>旧版标题改写记录</summary><ol class="research-references"><li v-for="rewrite in delivery.coverPlan.title_rewrites.rewrites" :key="rewrite.id"><p>原题：<a v-if="referenceFor(rewrite.reference_id)" :href="referenceFor(rewrite.reference_id)?.url" target="_blank" rel="noopener noreferrer">{{ rewrite.original_title }}</a><span v-else>{{ rewrite.original_title }}</span></p><p>改写：{{ rewrite.title }}</p><p>{{ rewrite.adaptation }}</p></li></ol></details>
        <details v-if="delivery.coverPlan.publishing_version !== 'source-screenshot-v3' && delivery.coverPlan.title_research"><summary>旧版标题检索记录</summary><ul class="research-references"><li v-for="reference in delivery.coverPlan.title_research.references" :key="reference.id"><a :href="reference.url" target="_blank" rel="noopener noreferrer">{{ reference.title }}</a><p>{{ reference.snippet }}</p></li></ul></details>
        <details v-if="delivery.coverPlan.publishing_version !== 'source-screenshot-v3' && (delivery.coverPlan.candidates.length > 1 || delivery.coverPlan.reviews.length)" class="candidate-history">
          <summary>候选与审核记录（{{ delivery.coverPlan.candidates.length }} 个方案）</summary>
          <article v-for="candidate in delivery.coverPlan.candidates" :key="candidate.id" class="candidate">
            <h4>{{ candidate.main_title }} <span class="candidate-status">{{ candidate.id === delivery.coverPlan.selected_id ? '选中' : selectionOnly ? '备选' : reviewPassed(candidate.id) ? '通过 · 未选中' : '淘汰' }}</span></h4>
            <p v-if="candidate.baijiahao_title">百家号标题：{{ candidate.baijiahao_title }}</p><p>{{ candidate.rationale }}</p>
            <ul v-if="reviewFor(candidate.id)" class="review-checks"><li v-for="check in reviewChecks" :key="check.key">{{ check.label }}：{{ reviewFor(candidate.id)?.[check.key] ? '通过' : '未通过' }}</li></ul>
            <p v-if="reviewFor(candidate.id)">{{ reviewFor(candidate.id)?.reason }}</p>
            <p v-else-if="!selectionOnly" class="warning">缺少审核记录。</p>
          </article>
        </details>
      </details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Upload } from 'lucide-vue-next'
import { getVideoTitleWarnings } from '../../../backend/src/services/video-title-format.js'

type CoverDesign = { main_title: string; sub_title: string; kicker: string; ai_prompt: string; accent_color?: string; thumbnail_layout?: 'text-left' | 'text-right'; highlight_text?: string }
type CoverCandidate = { id: string; method: string; main_title: string; sub_title: string; kicker: string; image_prompt: string; accent_color: string; enhanced_prompt: string; rationale: string; why_click: string; viewer_question: string; payoff: string; evidence: string[]; visual_concept: string; thumbnail_layout?: 'text-left' | 'text-right'; highlight_text?: string; video_title?: string; baijiahao_title?: string; video_description?: string; reference_ids?: string[]; reference_adaptation?: string }
type TitleResearchPlatform = 'toutiao' | 'baijiahao'
type TitleResearch = { references: { id: string; title: string; url: string; platform: TitleResearchPlatform; snippet: string }[] }
type TitleRewrites = { prompt: string; model?: string; shortlist: { reference_id: string; reason: string }[]; rewrites: { id: string; reference_id: string; original_title: string; title: string; adaptation: string }[] }
type SourceTitleRewrite = { source_title: string; title: string; keywords: { text: string; kind: string }[]; removed_promotions: string[] }
type SourceTitleCleanup = { source_title: string; cleaned_title: string }
type ReviewKey = 'natural' | 'understandable' | 'curiosity' | 'faithful' | 'visual_faithful' | 'coherent'
type CoverReview = Record<ReviewKey, boolean> & { candidate_id: string; reason: string; title_hook?: { specific: boolean; curiosity_gap: boolean; beats_summary: boolean; neutral_summary: string; reason: string }; title_emotion?: { feeling: string; trigger_span: string; tension: string; felt: boolean; grounded: boolean; reason: string } }
type CoverPlan = { version: string; publishing_version?: 'platform-v1' | 'source-title-v2' | 'source-screenshot-v3'; selected_id: string; selection_reason: string; selection_mode?: 'curiosity' | 'source-title'; candidates: CoverCandidate[]; reviews: CoverReview[]; script_sha256: string; design_sha256: string; title_research?: TitleResearch; title_rewrites?: TitleRewrites; source_title_rewrite?: SourceTitleRewrite; source_title_cleanup?: SourceTitleCleanup }
type VideoDelivery = { id: number | string; scriptId?: number; scriptSha256?: string; producer: 'huasheng' | 'motion' | 'manual' | 'legacy'; producerJobId?: string | null; videoUrl: string; videoName: string; duration?: number; sha256?: string; createdAt?: string }
type Delivery = { title: string; baijiahaoTitle?: string; description?: string; publishingWarnings?: string[]; videoId?: number | null; producer?: VideoDelivery['producer']; videoUrl?: string; videoName?: string; duration?: number; videos?: VideoDelivery[]; videoHistory?: VideoDelivery[]; videoPackagings?: VideoPackaging[]; coverDesign?: CoverDesign; coverPlanStatus?: 'approved' | 'selected' | 'outdated' | 'missing'; coverPlan?: CoverPlan | null; covers: Record<string, string>; coverStatus: string; error?: string; designStatus?: 'idle' | 'generating' | 'completed' | 'failed'; designRunId?: string | null; designError?: string | null; scriptChanged?: boolean; coversChanged?: boolean }
type VideoPackaging = Omit<Delivery, 'videos' | 'videoHistory' | 'videoPackagings'> & { videoId: number; producer: VideoDelivery['producer'] }
const props = defineProps<{ scriptId: number | string; scriptRevision?: string; refreshRevision?: number }>()
const emit = defineEmits<{ 'video-change': [] }>()
const formats = [{ ratio: '16:9', label: '横版 16:9' }, { ratio: '3:4', label: '竖版 3:4' }]
const emptyDesign = (): CoverDesign => ({ main_title: '', sub_title: '', kicker: '', ai_prompt: '' })
const delivery = ref<Delivery | null>(null)
const catalog = ref<Delivery | null>(null)
const form = reactive({ baijiahaoTitle: '', coverDesign: emptyDesign() })
const drafts = new Map<number | string, { baijiahaoTitle: string; coverDesign: CoverDesign }>()
const characterCount = (value: string) => value.length
const publishingWarnings = computed(() => getVideoTitleWarnings(form.baijiahaoTitle, 40, '百家号标题'))
const publishingTitle = computed({
  get: () => form.baijiahaoTitle,
  set: (value: string) => { form.baijiahaoTitle = value },
})
const selectedVideoId = ref<number | string | null>(null)
const requestedVideoId = ref<number | null>(null)
const playable = (video: VideoDelivery) => typeof video.videoUrl === 'string' && Boolean(video.videoUrl.trim())
const producerLabel = (producer: VideoDelivery['producer']) => ({ huasheng: '花生版', motion: '精细化版', manual: '手动成片', legacy: '历史成片' })[producer]
const videoItems = computed<VideoDelivery[]>(() => {
  const data = catalog.value
  if (!data) return []
  const current = (data.videos || []).filter(playable)
  if (current.length) return current
  if (typeof data.videoUrl !== 'string' || !data.videoUrl.trim()) return []
  // Older deliveries have only a single pointer; keep those files accessible.
  return [{ id: `legacy:${data.videoUrl}`, producer: 'legacy', videoUrl: data.videoUrl, videoName: data.videoName || '已保存成片', duration: data.duration }]
})
const selectedVideo = computed(() => videoItems.value.find(video => video.id === selectedVideoId.value) || videoItems.value[0])
const archivedVideos = computed(() => {
  const currentUrls = new Set(videoItems.value.map(video => video.videoUrl))
  const history = (catalog.value?.videoHistory || []).filter(video => playable(video) && !currentUrls.has(video.videoUrl))
  const data = catalog.value
  if (data?.videoUrl && !currentUrls.has(data.videoUrl) && !history.some(video => video.videoUrl === data.videoUrl)) {
    history.push({ id: `legacy:${data.videoUrl}`, producer: 'legacy', videoUrl: data.videoUrl, videoName: data.videoName || '已保存成片', duration: data.duration })
  }
  return history
})
const formatDuration = (duration: number) => `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`
const loading = ref(false)
const action = ref('')
const error = ref('')
const coverActionError = ref('')
const notice = ref('')
const videoNotice = ref('')
const videoError = ref('')
const uploadProgress = ref(0)
const generating = computed(() => delivery.value?.coverStatus === 'generating')
const designGenerating = computed(() => delivery.value?.designStatus === 'generating')
const busy = computed(() => loading.value || !!action.value || generating.value || designGenerating.value
  || requestedVideoId.value !== null && selectedVideoId.value !== requestedVideoId.value)
const designKeys = ['main_title', 'sub_title', 'kicker', 'ai_prompt', 'accent_color', 'thumbnail_layout', 'highlight_text'] as const
const designChanged = computed(() => designKeys.some(key => (form.coverDesign[key] || '') !== (delivery.value?.coverDesign?.[key] || '')))
const formChanged = computed(() => form.baijiahaoTitle !== (delivery.value?.baijiahaoTitle || delivery.value?.title || '') || designChanged.value)
const hasDesign = computed(() => !!form.baijiahaoTitle.trim())
const canGenerate = computed(() => hasDesign.value)
const hasCurrentReview = computed(() => delivery.value?.coverPlanStatus === 'approved' && !designChanged.value)
const hasCurrentPlan = computed(() => ['approved', 'selected'].includes(delivery.value?.coverPlanStatus || '') && !designChanged.value)
const selectionOnly = computed(() => ['curiosity', 'source-title'].includes(delivery.value?.coverPlan?.selection_mode || ''))
const selectedCandidate = computed(() => delivery.value?.coverPlan?.candidates.find(candidate => candidate.id === delivery.value?.coverPlan?.selected_id))
const referenceFor = (id: string) => delivery.value?.coverPlan?.title_research?.references.find(reference => reference.id === id)
const reviewChecks: { key: ReviewKey; label: string }[] = [{ key: 'natural', label: '通顺自然' }, { key: 'understandable', label: '一眼理解' }, { key: 'curiosity', label: '求知吸引力' }, { key: 'faithful', label: '正文一致' }, { key: 'visual_faithful', label: '画面忠实' }, { key: 'coherent', label: '图文配合' }]
const reviewFor = (id: string) => delivery.value?.coverPlan?.reviews.find(review => review.candidate_id === id)
const reviewPassed = (id: string) => {
  const review = reviewFor(id)
  const hook = review?.title_hook
  const emotion = review?.title_emotion
  return reviewChecks.every(check => review?.[check.key] === true) && (!hook || (hook.specific && hook.curiosity_gap && hook.beats_summary)) &&
    (!emotion || (emotion.felt && emotion.grounded))
}
let controller: AbortController | undefined
let upload: XMLHttpRequest | undefined
let poll: ReturnType<typeof setTimeout> | undefined
let generation = 0
let loadSequence = 0
let requestedDesign = false
const base = () => `/api/v1/history-scripts/${props.scriptId}/delivery`
const scopeId = () => typeof selectedVideo.value?.id === 'number' ? selectedVideo.value.id : null

function packagingStatus(videoId: number | string) {
  const data = videoId === delivery.value?.videoId ? delivery.value
    : catalog.value?.videoPackagings?.find(item => item.videoId === videoId)
  if (data?.designStatus === 'generating') return '原标题整理中'
  if (data?.coverStatus === 'generating') return '截图封面生成中'
  if (data?.designStatus === 'failed' || data?.coverStatus === 'failed') return '包装待重试'
  return data?.baijiahaoTitle && data.coverStatus === 'completed' && !data.coversChanged ? '标题与封面已就绪' : '标题与封面待生成'
}

function selectedPackaging(data: Delivery): Delivery {
  const video = selectedVideo.value
  if (typeof video?.id !== 'number') return data
  if (data.videoId === video.id) return data
  const saved = data.videoPackagings?.find(item => item.videoId === video.id)
  if (saved) return { ...data, ...saved }
  // Never display the shared legacy title or covers as a producer's own package.
  return { videoId: video.id, producer: video.producer, title: '', baijiahaoTitle: '', description: '',
    coverDesign: emptyDesign(), coverPlan: null, coverPlanStatus: 'missing', covers: {},
    coverStatus: 'idle', designStatus: 'idle', videoUrl: video.videoUrl, videoName: video.videoName,
    videos: data.videos, videoHistory: data.videoHistory, videoPackagings: data.videoPackagings }
}

function schedulePoll() {
  clearTimeout(poll)
  poll = undefined
  const data = delivery.value
  if (data?.coverStatus === 'generating' || data?.designStatus === 'generating'
    || catalog.value?.videoPackagings?.some(item => item.coverStatus === 'generating' || item.designStatus === 'generating')) {
    poll = setTimeout(() => load(false), 3000)
  }
}

function accept(data: Delivery, updateForm = true) {
  const previous = delivery.value
  const refreshCleanForm = !formChanged.value
  const videoChanged = !!catalog.value && (JSON.stringify(catalog.value.videos) !== JSON.stringify(data.videos)
    || (!data.videos?.length && catalog.value.videoUrl !== data.videoUrl))
  catalog.value = data
  if (!videoItems.value.some(video => video.id === selectedVideoId.value)) selectedVideoId.value = videoItems.value[0]?.id ?? null
  const selected = selectedPackaging(data)
  const switched = previous?.videoId !== selected.videoId
  const completedDesign = previous?.designStatus === 'generating' && selected.designStatus === 'completed'
  delivery.value = selected
  if (completedDesign && requestedDesign && selectedVideoId.value !== null) drafts.delete(selectedVideoId.value)
  if (switched || updateForm || refreshCleanForm || (completedDesign && requestedDesign)) {
    const draft = (switched || !previous) && selectedVideoId.value !== null ? drafts.get(selectedVideoId.value) : undefined
    form.baijiahaoTitle = draft?.baijiahaoTitle ?? selected.baijiahaoTitle ?? selected.title ?? ''
    form.coverDesign = { ...emptyDesign(), ...(draft?.coverDesign ?? selected.coverDesign) }
  }
  if (completedDesign) notice.value = '原标题已整理并保存。'
  if (selected.designStatus !== 'generating') requestedDesign = false
  schedulePoll()
  return videoChanged
}

async function request(path = '', method = 'GET', body?: unknown, videoId = scopeId()): Promise<Delivery> {
  const response = await fetch(`${base()}${path}${videoId === null ? '' : `?video_id=${videoId}`}`, { method, signal: controller?.signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok || result.success === false || result.code >= 400) throw new Error(result.message || '请求失败，请重试')
  return result.data ?? result
}

async function load(initial = true) {
  if (!initial && action.value) { schedulePoll(); return }
  const current = generation
  const currentLoad = ++loadSequence
  if (initial) loading.value = true
  try {
    let data = await request()
    const currentVideos = (data.videos || []).filter(playable)
    const chosen = currentVideos.find(video => video.id === selectedVideoId.value) || currentVideos[0]
    if (typeof chosen?.id === 'number' && data.videoId !== chosen.id && !data.videoPackagings?.some(item => item.videoId === chosen.id)) {
      data = await request('', 'GET', undefined, chosen.id)
    }
    if (current !== generation || currentLoad !== loadSequence) return
    error.value = ''
    if (accept(data, initial)) emit('video-change')
  } catch (err: any) {
    if (current !== generation || currentLoad !== loadSequence || err.name === 'AbortError') return
    error.value = err.message
    if (!initial) poll = setTimeout(() => load(false), 10000)
  } finally { if (current === generation && currentLoad === loadSequence) loading.value = false }
}

async function selectVideo(videoId: number | string) {
  if (action.value || !videoItems.value.some(video => video.id === videoId)) return
  requestedVideoId.value = null
  videoError.value = ''
  if (videoId === selectedVideoId.value) return
  if (selectedVideoId.value !== null) {
    if (formChanged.value) drafts.set(selectedVideoId.value, { baijiahaoTitle: form.baijiahaoTitle, coverDesign: { ...form.coverDesign } })
    else drafts.delete(selectedVideoId.value)
  }
  generation++
  loadSequence++
  clearTimeout(poll)
  controller?.abort()
  controller = new AbortController()
  requestedDesign = false
  selectedVideoId.value = videoId
  loading.value = false
  error.value = ''; coverActionError.value = ''; notice.value = ''
  if (catalog.value) accept(catalog.value, true)
  await load(false)
}

async function focusVideo(videoId: number) {
  if (action.value) {
    videoError.value = '当前成片正在处理，完成后再打开此任务的标题。'
    return
  }
  requestedVideoId.value = videoId
  await load(false)
  if (requestedVideoId.value !== videoId) return
  if (!videoItems.value.some(video => video.id === videoId)) {
    videoError.value = '此任务的成片暂不可用，请刷新后再编辑标题。'
    return
  }
  await selectVideo(videoId)
}
defineExpose({ focusVideo })

async function run(kind: 'save' | 'design' | 'covers') {
  if (busy.value || (kind === 'covers' && !canGenerate.value)) return
  const current = generation
  loadSequence++
  clearTimeout(poll)
  action.value = kind
  error.value = ''; coverActionError.value = ''; notice.value = ''
  try {
    const payload = { title: form.baijiahaoTitle, baijiahaoTitle: form.baijiahaoTitle,
      coverDesign: { main_title: form.baijiahaoTitle, sub_title: '', kicker: '', ai_prompt: '',
        accent_color: form.coverDesign.accent_color, thumbnail_layout: 'text-left' } }
    const path = kind === 'save' ? '' : `/${kind}`
    const data = await request(path, kind === 'save' ? 'PUT' : 'POST', kind === 'design' ? {} : payload)
    if (current !== generation) return
    if (selectedVideoId.value !== null && (kind !== 'design' || data.designStatus === 'completed')) drafts.delete(selectedVideoId.value)
    if (kind === 'design') requestedDesign = data.designStatus === 'generating'
    if (accept(data, kind !== 'design' || data.designStatus === 'completed')) emit('video-change')
    notice.value = kind === 'save' ? '标题已保存' : kind === 'design' && data.designStatus === 'completed' ? '原标题已整理并保存。' : ''
  } catch (err: any) {
    if (current === generation && err.name !== 'AbortError') {
      error.value = err.message
      if (kind === 'design') coverActionError.value = err.message
    }
  }
  finally { if (current === generation) { action.value = ''; schedulePoll() } }
}

function uploadVideo(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  const current = generation
  const sourceId = props.scriptId
  const previousVideoUrl = catalog.value?.videoUrl
  loadSequence++
  clearTimeout(poll)
  action.value = 'upload'; uploadProgress.value = 0; error.value = ''; notice.value = ''; videoNotice.value = ''; videoError.value = ''
  const xhr = new XMLHttpRequest()
  upload = xhr
  const isCurrentUpload = () => current === generation && sourceId === props.scriptId && upload === xhr
  const finish = () => {
    if (!isCurrentUpload()) return
    action.value = ''; upload = undefined; schedulePoll()
  }
  const reconcile = async (message: string) => {
    if (!isCurrentUpload() || action.value !== 'upload') return
    action.value = 'reconcile-upload'
    videoError.value = message
    try {
      const data = await request('', 'GET', undefined, null)
      if (!isCurrentUpload()) return
      accept(data, false)
      if (typeof data.videoUrl === 'string' && data.videoUrl.trim() && data.videoUrl !== previousVideoUrl) {
        videoError.value = ''
        videoNotice.value = '成片已关联到当前脚本'
        emit('video-change')
      }
    } catch (err: any) {
      if (!isCurrentUpload() || err.name === 'AbortError') return
      videoError.value = '上传结果未确认，请刷新成片与封面后核对，暂勿重复提交。'
    }
  }
  xhr.open('PUT', `${base()}/video`)
  xhr.setRequestHeader('Content-Type', 'application/octet-stream')
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
  xhr.upload.onprogress = event => { if (isCurrentUpload() && action.value === 'upload' && event.lengthComputable) uploadProgress.value = Math.round(event.loaded / event.total * 100) }
  xhr.onload = async () => {
    if (!isCurrentUpload() || action.value !== 'upload') return
    try {
      const result = JSON.parse(xhr.responseText)
      if (xhr.status < 200 || xhr.status >= 300 || result.success === false || result.code >= 400) throw new Error(result.message || '上传失败')
      const data: Delivery = result.data ?? result
      if (typeof data?.videoUrl !== 'string' || !data.videoUrl.trim()) throw new Error('上传响应未包含有效的成片链接')
      accept(data, false)
      videoNotice.value = '成片已关联到当前脚本'
      emit('video-change')
    } catch (err: any) { if (isCurrentUpload()) await reconcile(err.message) }
    finally { finish() }
  }
  xhr.onerror = async () => {
    if (!isCurrentUpload() || action.value !== 'upload') return
    try { await reconcile('视频上传连接中断，未收到上传结果') }
    finally { finish() }
  }
  xhr.send(file)
}

function cancel() {
  generation++
  requestedDesign = false
  clearTimeout(poll)
  controller?.abort()
  upload?.abort()
  upload = undefined
}
watch(() => props.scriptId, () => {
  cancel()
  controller = new AbortController()
  delivery.value = null; catalog.value = null; drafts.clear(); action.value = ''; error.value = ''; coverActionError.value = ''; notice.value = ''; videoNotice.value = ''; videoError.value = ''
  form.baijiahaoTitle = ''; form.coverDesign = emptyDesign(); selectedVideoId.value = null; requestedVideoId.value = null
  load()
}, { immediate: true })
watch([() => props.scriptRevision, () => props.refreshRevision], () => { if (delivery.value) load(false) })
onBeforeUnmount(cancel)
</script>

<style scoped>
.delivery { border-top: 1px solid var(--border, #ddd); padding: 24px; display: grid; gap: 18px; min-width: 0; letter-spacing: 0; }
header { display: flex; gap: 16px; justify-content: space-between; align-items: start; }
h2 { font-size: 18px; margin: 0; } h3, p { margin: 0; } header > span, .hint, figcaption span { color: var(--text-2, #777); font-size: 13px; line-height: 1.6; }
.video-section, .cover-editor, label { display: grid; gap: 12px; }
.video-section { min-width: 0; }
.video-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.video-heading > div { min-width: 0; display: grid; gap: 4px; }
.video-versions { display: flex; gap: 4px; min-width: 0; border-bottom: 1px solid var(--border, #e4e4e7); }
.version-tab { display: grid; gap: 4px; min-width: 0; max-width: 240px; padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-2, #71717a); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.version-tab.selected { border-bottom-color: var(--accent, #2563eb); color: var(--text-0, #27272a); }
.version-tab:hover { background: var(--bg-2, #f4f4f5); }
.version-tab:disabled { cursor: wait; opacity: .6; }
.version-status { font-size: 11px; }
.version-tab > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.video-preview { display: grid; gap: 8px; min-width: 0; }
video { display: block; max-width: 100%; width: 560px; max-height: 360px; background: #111; border-radius: 8px; }
.video-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; min-width: 0; font-size: 13px; line-height: 1.6; }
.video-meta > span { min-width: 0; overflow-wrap: anywhere; color: var(--text-2, #71717a); }
.video-meta a, .video-history a, .legacy-cover a { color: var(--accent, #2563eb); text-underline-offset: 3px; }
.video-history ul { padding: 0; margin: 12px 0 0; list-style: none; display: grid; gap: 8px; }
.video-history li { display: flex; gap: 12px; justify-content: space-between; font-size: 13px; line-height: 1.6; }
.video-history li > span { min-width: 0; overflow-wrap: anywhere; }
.video-history a { flex-shrink: 0; }
.empty-output { color: var(--text-2, #71717a); padding: 16px 0; font-size: 13px; line-height: 1.7; }
.btn { letter-spacing: 0; }
.video-picker { position: relative; display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 36px; box-sizing: border-box; border-radius: 6px; font-size: 13px; white-space: normal; }
.video-picker.btn-primary { color: #fafafa; }
.video-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.video-picker:focus-within, .delivery :is(button, a, summary, input, textarea):focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.video-picker.is-disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.video-picker svg { flex-shrink: 0; }
.video-notice { font-size: 13px; overflow-wrap: anywhere; }
fieldset { min-width: 0; border: 0; border-top: 1px solid var(--border, #e4e4e7); padding: 20px 0 0; margin: 0; } legend { padding: 0 12px 0 0; font-weight: 600; }
label { font-size: 13px; color: var(--text-1, #444); }
input:not([type=file]), textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--bg-0, #fff); color: var(--text-0, #222); font: inherit; }
textarea { resize: vertical; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; } .cover-editor > .btn { justify-self: start; }
.cover-action-error { display: grid; gap: 8px; padding: 12px; border: 1px solid currentColor; border-radius: 8px; line-height: 1.6; overflow-wrap: anywhere; }
.publishing-warnings { display: grid; gap: 8px; line-height: 1.6; overflow-wrap: anywhere; } .publishing-warnings ul { margin: 0; padding-left: 20px; }
.plan-details { min-width: 0; padding-top: 16px; border-top: 1px solid var(--border, #e4e4e7); overflow-wrap: anywhere; }
.plan-details > :not(summary) { margin-top: 12px; }
.plan-reasons { display: grid; grid-template-columns: 7em minmax(0, 1fr); gap: 10px 16px; margin: 0; font-size: 13px; line-height: 1.7; }
.plan-reasons dt { font-weight: 600; } .plan-reasons dd { margin: 0; } .plan-reasons ul { margin: 0; padding-left: 20px; }
summary { cursor: pointer; font-size: 13px; line-height: 1.7; } .candidate { display: grid; gap: 10px; border-top: 1px solid var(--border, #ddd); margin-top: 14px; padding-top: 14px; font-size: 13px; line-height: 1.7; }
.candidate h4 { margin: 0; font-size: 14px; } .candidate-status { font-size: 12px; font-weight: 400; color: var(--text-2, #777); } .review-checks { display: flex; flex-wrap: wrap; gap: 6px 16px; list-style: none; margin: 0; padding: 0; }
.research-references { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; min-width: 0; font-size: 13px; line-height: 1.7; }
.research-references > li { display: grid; gap: 4px; min-width: 0; }
.research-references a { color: var(--accent, #2563eb); }
.covers { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; max-width: 700px; }
figure { margin: 0; min-width: 0; } img, .cover-placeholder { display: block; width: 100%; object-fit: contain; border-radius: 8px; background: var(--bg-2, #eee); } .cover-placeholder { display: grid; place-content: center; color: var(--text-2, #777); font-size: 13px; }
figcaption { display: grid; gap: 5px; margin-top: 10px; font-size: 13px; } figcaption a { color: var(--accent, #4f46e5); }
.error { color: #b42318; font-size: 13px; } .warning { padding: 12px; color: #925b12; background: #fff5dc; border-radius: 8px; font-size: 13px; } progress { width: min(420px, 100%); }
@media (max-width: 700px) { .delivery { padding: 16px; } header { flex-direction: column; } .covers { gap: 10px; } .plan-reasons { grid-template-columns: minmax(0, 1fr); gap: 4px; } .plan-reasons dd { margin-bottom: 8px; } }
</style>
