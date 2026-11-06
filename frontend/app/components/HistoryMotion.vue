<template>
  <section class="history-motion" :class="{ 'source-panel': isSource }" role="region" :aria-label="isSource ? '当前稿精细化制作' : '精细化制作队列'">
    <header class="toolbar">
      <div class="heading"><h2>精细化制作</h2><p class="muted">与花生版并行制作；每版完成后自动发表百家号。在 Remotion 查看精细化版进度与成片。</p></div>
      <div class="actions">
        <label v-if="isSource" class="profile-label">画幅<select v-model="profile" :disabled="!!action" aria-label="精细化视频画幅"><option value="16:9">横屏 16:9 · 1080p</option><option value="9:16">竖屏 9:16 · 1080p</option></select></label>
        <button v-if="isSource" class="control primary" :disabled="!canProduce" @click="produce"><Clapperboard :size="15" />{{ produceLabel }}</button>
        <button v-else class="control" @click="emit('open-library')"><FileText :size="15" />选择稿件</button>
        <NuxtLink class="control" to="/remotion">制作工作台</NuxtLink>
        <button class="control icon-control" aria-label="刷新精细化制作任务" title="刷新任务" :disabled="loading || !!action" @click="load"><RefreshCw :size="16" :class="{ spinning: loading }" /></button>
      </div>
    </header>

    <div v-if="unavailableReason || error || actionError" class="notices">
      <p v-if="unavailableReason" class="warning">{{ unavailableReason }}</p>
      <p v-if="error" class="error" role="alert">{{ publicText(error) }}<button class="text-command" :disabled="loading" @click="load">重新读取</button></p>
      <p v-if="actionError" class="error" role="alert">{{ publicText(actionError) }}</p>
    </div>

    <div class="content">
      <div v-if="!loaded && loading" class="empty" role="status">正在读取精细化制作任务…</div>
      <div v-else-if="loaded && !jobs.length" class="empty"><Film :size="30" /><h3>暂无精细化视频</h3></div>
      <ol v-else class="jobs" aria-label="精细化制作任务">
        <li v-for="job in jobs" :key="job.id" class="job">
          <div class="job-summary">
            <div class="job-identity">
              <button v-if="!isSource" class="text-command job-title" @click="emit('open-script', job.scriptId, 'motion')">{{ job.title || `稿件 #${job.scriptId}` }}</button>
              <strong v-else>{{ job.scriptRevision === scriptRevision ? '当前已保存版本' : '其他已保存版本' }}</strong>
              <span class="muted">{{ job.profile }} · {{ formatTime(job.updatedAt) }}</span>
            </div>
            <span class="status" :class="job.status">{{ jobStatusLabel(job) }}</span>
            <div class="actions">
              <NuxtLink v-if="job.factory?.episodeId" class="control primary" :to="`/remotion/episode/${job.factory.episodeId}`">打开制作详情</NuxtLink>
              <button v-if="!job.factory && shots(job).length" class="control" :aria-expanded="expandedJob === job.id" @click="toggleJob(job)"><ListChecks :size="14" />{{ expandedJob === job.id ? '收起分镜' : '查看分镜' }}</button>
              <button v-if="!job.factory && ['failed', 'needs_review'].includes(job.status) && !hasRenderedVideo(job)" class="control primary" :disabled="mutationBlocked(job)" @click="runAction(job, 'retry')"><RefreshCw :size="14" />{{ job.status === 'needs_review' ? '继续自动制作' : '重试制作' }}</button>
              <a v-if="job.status === 'completed' || hasRenderedVideo(job)" class="control primary" :href="videoUrl(job)" target="_blank" rel="noopener noreferrer"><Film :size="14" />查看本次成片</a>
              <button v-if="hasRenderedVideo(job) && job.status !== 'completed'" class="control" :disabled="mutationBlocked(job)" @click="runAction(job, 'deliver')"><RefreshCw :size="14" />{{ isAssociating(job) ? '关联中…' : job.plan?.deliveryAssociation?.status === 'failed' || job.status === 'failed' ? '重试关联成片' : '关联成片' }}</button>
            </div>
          </div>
          <p v-if="job.message || job.status === 'needs_review'" class="job-message" role="status">{{ job.status === 'needs_review' ? hasRenderedVideo(job) ? '成片已生成，可直接关联。' : '可继续自动制作。' : publicText(job.message) }}</p>
          <p v-if="job.error" class="error job-message">{{ publicText(job.error) }}</p>
          <div v-if="job.plan" class="production-summary" aria-label="制作编排概况"><span>{{ shots(job).length }} 个分镜</span><span :title="soundNames(job)"><Volume2 :size="14" />{{ job.plan.soundEffects?.length || 0 }} 处音效</span></div>
          <details v-if="job.plan?.fallbacks?.length" class="fallback-records">
            <summary>自动降级记录（{{ job.plan.fallbacks.length }}）</summary>
            <ul><li v-for="(fallback, index) in job.plan.fallbacks" :key="index"><strong>{{ shotLabel(job, fallback.shotId) }} · {{ fallbackStage(fallback.stage) }}</strong><p>{{ publicText(fallback.reason) }}</p></li></ul>
          </details>
          <div v-if="job.plan?.deliveryAssociation" class="delivery-association" :class="isAssociating(job) ? 'pending' : job.plan.deliveryAssociation.status" role="status" aria-label="成片交付状态">
            <strong>{{ isAssociating(job) ? '正在关联成片' : deliveryLabels[job.plan.deliveryAssociation.status] }}</strong>
            <p>{{ isAssociating(job) ? '成片已保留' : publicText(job.plan.deliveryAssociation.message || deliveryMessages[job.plan.deliveryAssociation.status]) }}</p>
            <p v-if="!isAssociating(job) && job.plan.deliveryAssociation.status === 'existing_preserved'">“成片与封面”保留原有视频；本次输出请点击“查看本次成片”。</p>
            <button class="control" @click="emit('open-script', job.scriptId, 'delivery')"><Film :size="14" />打开成片与封面</button>
          </div>
          <p v-if="isSource && job.scriptRevision !== scriptRevision" class="muted job-message">这是其他稿件版本的制作记录。请使用当前稿创建新任务。</p>
          <section v-if="expandedJob === job.id" class="shot-review" :aria-label="`任务 ${job.id} 分镜选材`">
            <div class="shot-list" role="group" aria-label="选择分镜">
              <button v-for="(shot, index) in shots(job)" :key="shot.shotId" :class="{ selected: selectedShot === shot.shotId }" :aria-pressed="selectedShot === shot.shotId" @click="selectShot(job, shot)"><span class="shot-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="shot-copy">{{ shot.narration || shot.shotId }}<small>{{ typeof shot.duration === 'number' ? `${shot.duration.toFixed(1)} 秒 · ` : '' }}{{ visualLabel(shot) }}</small></span><CircleCheck v-if="shotReady(shot)" :size="15" class="ready-icon" /><CircleAlert v-else-if="job.status === 'failed'" :size="15" class="warning" /></button>
            </div>
            <div v-if="activeShot(job)" class="shot-detail">
              <p class="shot-narration">{{ activeShot(job)!.narration || activeShot(job)!.shotId }}</p>
              <p class="visual-kind" :class="visualType(activeShot(job)!)" aria-label="实际画面类型"><component :is="visualIcon(activeShot(job)!)" :size="15" />{{ visualLabel(activeShot(job)!) }}</p>
              <p v-if="activeShot(job)!.fallbackReason" class="warning fallback-reason">自动降级：{{ publicText(activeShot(job)!.fallbackReason) }}</p>
              <p v-if="activeShot(job)!.reason || activeShot(job)!.selection?.reason" class="muted">选镜理由：{{ publicText(activeShot(job)!.reason || activeShot(job)!.selection?.reason) }}</p>
              <p v-if="job.status === 'failed' && activeShot(job)!.reviewReason" class="warning">{{ publicText(activeShot(job)!.reviewReason) }}</p>
              <p v-if="shotQuery(job)" class="muted">检索：{{ publicText(shotQuery(job)) }}</p>
              <p v-if="activeShot(job)!.mapReason && visualType(activeShot(job)!) === 'map'" class="muted">{{ publicText(activeShot(job)!.mapReason) }}</p>
              <details v-if="canEdit(job)" class="manual-adjustment">
                <summary>手动调整素材（可选）</summary>
              <p v-if="!candidates(job).length" class="empty-candidates">暂无候选素材</p>
              <form v-if="canEdit(job)" class="search-form" @submit.prevent="searchShot(job)"><label>重新检索素材<input v-model="searchQuery" type="search" maxlength="500" placeholder="人物、地点、年代或画面内容" :disabled="mutationBlocked(job)" /></label><button class="control" type="submit" :disabled="mutationBlocked(job) || !searchQuery.trim()"><Search :size="14" />检索</button></form>
              <div v-if="candidates(job).length" class="candidates">
                <article v-for="candidate in candidates(job)" :key="candidate.assetId" class="candidate" :class="{ chosen: candidate.assetId === chosenAsset }">
                  <video :src="assetUrl(job, candidate.assetId)" controls playsinline preload="none" :aria-label="`候选 ${candidate.rank} 预览`" />
                  <div class="candidate-copy"><strong>候选 {{ candidate.rank }}</strong>
                    <p v-if="candidate.description?.trim()" class="candidate-description">画面描述：{{ publicText(candidate.description) }}</p><p v-else class="muted">未提供画面描述</p>
                    <p v-if="candidate.query?.trim()" class="candidate-annotation"><span>原检索标注（非画面描述）：</span>{{ publicText(candidate.query) }}</p>
                    <p v-if="candidate.shotText?.trim()" class="candidate-context"><span>原分镜文稿（非画面描述）：</span>{{ publicText(candidate.shotText) }}</p>
                    <small class="muted">{{ candidate.duration ? `${candidate.duration.toFixed(1)} 秒` : '时长待核验' }} · {{ candidate.width || '—' }} × {{ candidate.height || '—' }}<template v-if="candidate.fps"> · {{ candidate.fps }} fps</template></small>
                    <button v-if="canEdit(job)" class="control" :disabled="mutationBlocked(job) || !candidate.duration" :aria-pressed="chosenAsset === candidate.assetId" @click="chooseCandidate(job, candidate)">{{ chosenAsset === candidate.assetId ? '已选择此候选' : '使用此镜头' }}</button>
                  </div>
                </article>
              </div>
              <form v-if="chosenCandidate(job) && canEdit(job)" class="trim-form" @submit.prevent="saveSelection(job)">
                <div class="trim-fields"><label>入点（秒）<input v-model.number="inPoint" type="number" step="0.1" min="0" :max="chosenCandidate(job)!.duration || undefined" :disabled="mutationBlocked(job)" /></label><label>出点（秒）<input v-model.number="outPoint" type="number" step="0.1" min="0.1" :max="chosenCandidate(job)!.duration || undefined" :disabled="mutationBlocked(job)" /></label><label>取景<select v-model="crop" :disabled="mutationBlocked(job)"><option value="center">居中裁切</option><option value="contain">完整画面</option><option value="left">保留左侧</option><option value="right">保留右侧</option></select></label></div>
                <label>选择理由（可选）<input v-model="reason" type="text" maxlength="500" :disabled="mutationBlocked(job)" /></label>
                <label class="freeze-option"><input v-model="freezeShortfall" type="checkbox" :disabled="mutationBlocked(job)" />片段不足时尾帧停留</label>
                <div class="actions"><button class="control primary" type="submit" :disabled="mutationBlocked(job) || !validRange(job)"><Check :size="14" />{{ action === `select:${job.id}` ? '正在保存…' : '保存素材调整' }}</button><span v-if="!validRange(job)" class="warning">请填写素材时长以内的有效入点和出点。</span></div>
              </form>
              </details>
            </div>
          </section>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, CircleAlert, CircleCheck, Clapperboard, FileText, Film, Image as ImageIcon, ListChecks, Map as MapIcon, RefreshCw, Search, Shapes, Volume2 } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

type Status = 'queued' | 'planning' | 'selecting' | 'needs_review' | 'rendering' | 'validating' | 'completed' | 'failed'
type Crop = 'center' | 'cover' | 'contain' | 'left' | 'right'
type VisualType = 'video' | 'map' | 'image' | 'graphic'
type Candidate = { assetId: string; rank: number; description: string; query?: string; shotText?: string; duration: number | null; width: number | null; height: number | null; fps: number | null }
type Shot = { shotId: string; narration: string; duration: number; status?: string; visualType?: VisualType | 'auto'; fallbackReason?: string; assetId?: string; hasImage?: boolean; hasVideo?: boolean; graphic?: unknown; inPoint?: number; outPoint?: number; crop?: Crop; reason?: string; reviewReason?: string | null; map?: unknown; mapPackId?: string; mapReason?: string; search?: { query?: string }; selection?: { assetId: string; inPoint: number; outPoint: number; crop: Crop; reason: string; shortfallPolicy?: 'freeze' | 'reject' } }
type DeliveryAssociation = { status: 'attached' | 'existing_preserved' | 'failed'; videoUrl?: string; message?: string }
type Job = { id: string; scriptId: number; title?: string; scriptRevision: string; profile: '16:9' | '9:16'; status: Status; stage?: string; message?: string; videoUrl?: string; error?: string | null; updatedAt: string; factory?: { episodeId: number; projectId: number }; plan?: { shots?: Shot[]; soundEffects?: { sourceName?: string }[]; fallbacks?: { shotId: string; stage: string; reason: string }[]; deliveryAssociation?: DeliveryAssociation } | null; candidates?: Record<string, Candidate[]>; requested?: { shots?: Shot[] } }
const props = defineProps<{ sourceId?: number | string; scriptText?: string; scriptRevision?: string; scriptCurrent?: boolean; dirty?: boolean; sourceBusy?: boolean; blockedSourceId?: number | string; active?: boolean }>()
const emit = defineEmits<{ 'open-script': [sourceId: number, tab: 'motion' | 'delivery']; 'open-library': []; 'delivery-change': [sourceId: number]; overview: [value: { total: number; attention: number }] }>()
const statusLabels: Record<Status, string> = { queued: '等待制作', planning: '规划分镜', selecting: '自动编排画面', needs_review: '可继续自动制作', rendering: '渲染中', validating: '交付处理中', completed: '制作完成', failed: '制作失败' }
const deliveryLabels: Record<DeliveryAssociation['status'], string> = { attached: '已关联成片与封面', existing_preserved: '已保留原有交付成片', failed: '交付关联失败' }
const deliveryMessages: Record<DeliveryAssociation['status'], string> = { attached: '本次成片已加入稿件交付，可继续准备封面与发布内容。', existing_preserved: '该稿件已有其他交付成片，本次制作已完成，原有交付内容保留。', failed: '本次视频已保留，请重试关联成片。' }
const isSource = computed(() => props.sourceId !== undefined)
const jobs = ref<Job[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const action = ref('')
const actionError = ref('')
const conflict = ref(false)
const profile = ref<'16:9' | '9:16'>('16:9')
const expandedJob = ref('')
const selectedShot = ref('')
const chosenAsset = ref('')
const inPoint = ref(0)
const outPoint = ref(0)
const crop = ref<Crop>('center')
const reason = ref('')
const searchQuery = ref('')
const freezeShortfall = ref(false)
let requestVersion = 0
let timer: ReturnType<typeof setTimeout> | undefined
let mounted = false
const base = '/history-scripts/motion'
const unavailableReason = computed(() => {
  if (!isSource.value) return ''
  if (props.dirty) return '请先保存文稿修改，再开始制作。'
  if (props.sourceBusy) return '稿件正在读取或处理，完成后可继续制作。'
  if (conflict.value) return '稿件版本已更新，请刷新稿件后再制作。'
  if (!props.scriptText?.trim() || !props.scriptRevision) return '请先生成并保存二创稿。'
  if (!props.scriptCurrent) return '当前稿件版本已过期，请先完成二创并保存。'
  return ''
})
const currentJob = computed(() => jobs.value.find(job => job.scriptRevision === props.scriptRevision && job.profile === profile.value && !['failed', 'completed'].includes(job.status)))
const completedCurrentJob = computed(() => jobs.value.find(job => job.scriptRevision === props.scriptRevision && job.profile === profile.value && job.status === 'completed'))
const produceLabel = computed(() => action.value === 'produce' ? '正在创建…' : completedCurrentJob.value ? '本稿已制作' : '制作当前稿')
const canProduce = computed(() => isSource.value && loaded.value && !loading.value && !action.value && !error.value && !unavailableReason.value && !currentJob.value && !completedCurrentJob.value)
function jobBase(job: Job) { return `${base}/${job.scriptId}/jobs/${encodeURIComponent(job.id)}` }
function jobStatusLabel(job: Job) { return isAssociating(job) ? job.status === 'queued' ? '等待关联' : '关联成片中' : job.plan?.deliveryAssociation?.status === 'failed' ? '交付关联失败' : statusLabels[job.status] || job.status }
function hasRenderedVideo(job: Job) { return job.stage === 'rendered' }
function isAssociating(job: Job) { return hasRenderedVideo(job) && ['queued', 'validating'].includes(job.status) }
function videoUrl(job: Job) { return `/api/v1${jobBase(job)}/video` }
function assetUrl(job: Job, assetId: string) { return `/api/v1${jobBase(job)}/assets/${encodeURIComponent(assetId)}` }
function shots(job: Job) { return Array.isArray(job.plan?.shots) && job.plan.shots.length ? job.plan.shots : job.requested?.shots || [] }
function activeShot(job: Job) { return shots(job).find(shot => shot.shotId === selectedShot.value) }
function candidates(job: Job) { return job.candidates?.[selectedShot.value] || [] }
function chosenCandidate(job: Job) { return candidates(job).find(candidate => candidate.assetId === chosenAsset.value) }
function shotQuery(job: Job) { return job.requested?.shots?.find(shot => shot.shotId === selectedShot.value)?.search?.query || '' }
function visualType(shot: Shot): VisualType | undefined { return shot.visualType && shot.visualType !== 'auto' ? shot.visualType : shot.map ? 'map' : shot.hasImage ? 'image' : shot.graphic ? 'graphic' : shot.hasVideo || shot.assetId || shot.selection ? 'video' : undefined }
function visualLabel(shot: Shot) { const kind = visualType(shot); return kind ? { video: '素材视频', map: '地图推演', image: '生成图片', graphic: '信息动效' }[kind] : '自动编排中' }
function visualIcon(shot: Shot) { const kind = visualType(shot); return kind ? { video: Film, map: MapIcon, image: ImageIcon, graphic: Shapes }[kind] : Clapperboard }
function shotReady(shot: Shot) { return shot.status ? shot.status === 'ready' : !!visualType(shot) }
function shotLabel(job: Job, shotId: string) { const index = shots(job).findIndex(shot => shot.shotId === shotId); return index < 0 ? '制作' : `分镜 ${String(index + 1).padStart(2, '0')}` }
function fallbackStage(stage: string) { return ({ map: '地图推演', image: '图片生成', graphic: '信息动效', sound: '音效', soundEffects: '音效', sfx: '音效', video: '素材视频', selection: '素材检索', search: '素材检索' } as Record<string, string>)[stage] || '画面与声音' }
function soundNames(job: Job) { return job.plan?.soundEffects?.map(sound => publicText(sound.sourceName)).filter(Boolean).join('、') || '' }
function publicText(value?: string | null) {
  return (value || '').replace(/(?:file:\/\/)?\/(?:Users|Volumes|private|var|tmp|home|mnt|opt|srv|data|workspace|Applications|usr)(?:\/[^\s"'<>，。；]*)?/g, '[本地文件]').replace(/[A-Za-z]:\\[^\s"'<>，。；]*/g, '[本地文件]')
}
function canEdit(job: Job) { return ['needs_review', 'failed'].includes(job.status) && !hasRenderedVideo(job) }
function mutationBlocked(job: Job) {
  return !!action.value || !!error.value || !loaded.value || ['queued', 'planning', 'selecting', 'rendering', 'validating'].includes(job.status) || String(props.blockedSourceId) === String(job.scriptId)
    || (isSource.value && (!!unavailableReason.value || job.scriptRevision !== props.scriptRevision))
}
function validRange(job: Job) {
  const candidate = chosenCandidate(job)
  return !!candidate?.duration && Number.isFinite(inPoint.value) && Number.isFinite(outPoint.value)
    && inPoint.value >= 0 && outPoint.value > inPoint.value && outPoint.value <= candidate.duration + .001
}
function formatTime(time: string) { const date = new Date(time); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : time }
function selectShot(job: Job, shot: Shot) {
  selectedShot.value = shot.shotId
  chosenAsset.value = shot.assetId || shot.selection?.assetId || ''
  inPoint.value = shot.inPoint ?? shot.selection?.inPoint ?? 0
  outPoint.value = shot.outPoint ?? shot.selection?.outPoint ?? 0
  crop.value = shot.crop || shot.selection?.crop || 'center'
  reason.value = shot.reason || shot.selection?.reason || ''
  searchQuery.value = job.requested?.shots?.find(item => item.shotId === shot.shotId)?.search?.query || ''
  freezeShortfall.value = shot.selection?.shortfallPolicy === 'freeze'
}
function toggleJob(job: Job) {
  if (expandedJob.value === job.id) { expandedJob.value = ''; return }
  expandedJob.value = job.id
  const first = shots(job).find(shot => !shotReady(shot)) || shots(job)[0]
  if (first) selectShot(job, first)
}
function chooseCandidate(job: Job, candidate: Candidate) {
  if (mutationBlocked(job) || !canEdit(job)) return
  chosenAsset.value = candidate.assetId
  inPoint.value = 0
  outPoint.value = Math.min(candidate.duration || 0, activeShot(job)?.duration || candidate.duration || 0)
  reason.value = ''
  freezeShortfall.value = false
}
function updateJobs(next: Job[]) {
  // Initial reads establish the baseline; only later completions refresh delivery.
  const previous = new Map(jobs.value.map(job => [job.id, job.status]))
  const completed = loaded.value ? new Set(next.filter(job => job.status === 'completed' && previous.get(job.id) !== 'completed').map(job => job.scriptId)) : new Set<number>()
  jobs.value = next
  loaded.value = true
  emitOverview()
  for (const scriptId of completed) emit('delivery-change', scriptId)
}
function rememberJob(job: Job) { updateJobs([job, ...jobs.value.filter(item => item.id !== job.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) }
function emitOverview() { emit('overview', { total: jobs.value.length, attention: jobs.value.filter(job => ['failed', 'needs_review'].includes(job.status)).length }) }
function schedule() {
  if (timer) clearTimeout(timer)
  if (!mounted) return
  timer = setTimeout(async () => { if (props.active !== false && !action.value) await load(); else schedule() }, 5000)
}
async function load() {
  if (loading.value) return
  const version = ++requestVersion
  loading.value = true
  try {
    const response = await api.get<{ jobs: Job[] }>(isSource.value ? `${base}/${encodeURIComponent(String(props.sourceId))}` : `${base}/jobs`)
    if (version !== requestVersion) return
    updateJobs(response.jobs || [])
    error.value = ''
  } catch (cause: any) { if (version === requestVersion) error.value = cause.message || '任务读取失败。' }
  finally { if (version === requestVersion) loading.value = false; schedule() }
}
async function mutate(label: string, endpoint: string, body: object) {
  if (action.value) return null
  action.value = label
  actionError.value = ''
  // A pending status read must not replace a newer mutation response.
  requestVersion++
  loading.value = false
  try {
    const response = await api.post<Job | { job: Job }>(endpoint, body)
    const job = 'job' in response ? response.job : response
    if (!job?.id) throw new Error('未收到任务记录，请刷新状态核对。')
    rememberJob(job)
    return job
  } catch (cause: any) {
    actionError.value = cause.message || '操作失败，请刷新任务状态后重试。'
    if ([400, 409].includes(cause.status) && /稿件.*(?:更新|版本)|版本|revision|stale/i.test(cause.message || '')) conflict.value = true
    await load()
    return null
  } finally { action.value = ''; schedule() }
}
async function produce() {
  if (!canProduce.value) return
  const job = await mutate('produce', `${base}/${props.sourceId}/produce`, { scriptRevision: props.scriptRevision, profile: profile.value })
  if (job?.factory?.episodeId) await navigateTo(`/remotion/episode/${job.factory.episodeId}`)
}
async function runAction(job: Job, kind: 'retry' | 'deliver') {
  if (mutationBlocked(job)) return
  await mutate(`${kind}:${job.id}`, `${jobBase(job)}/${kind}`, {})
}
async function saveSelection(job: Job) {
  if (mutationBlocked(job) || !validRange(job) || !canEdit(job)) return
  const saved = await mutate(`select:${job.id}`, `${jobBase(job)}/select`, { shotId: selectedShot.value, assetId: chosenAsset.value, inPoint: inPoint.value, outPoint: outPoint.value, crop: crop.value, reason: reason.value.trim(), shortfallPolicy: freezeShortfall.value ? 'freeze' : 'reject' })
  const shot = saved && activeShot(saved)
  if (saved && shot) selectShot(saved, shot)
}
async function searchShot(job: Job) {
  if (mutationBlocked(job) || !canEdit(job) || !searchQuery.value.trim()) return
  const saved = await mutate(`search:${job.id}`, `${jobBase(job)}/search`, { shotId: selectedShot.value, query: searchQuery.value.trim() })
  const shot = saved && activeShot(saved)
  if (saved && shot) selectShot(saved, shot)
}
watch(() => props.scriptRevision, () => { conflict.value = false })
watch(() => props.active, active => { if (active && mounted) void load() })
onMounted(() => { mounted = true; void load() })
onBeforeUnmount(() => { mounted = false; requestVersion++; if (timer) clearTimeout(timer) })
</script>

<style scoped>
.history-motion { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: #fff; color: #27272a; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
.history-motion *, .history-motion *::before, .history-motion *::after { box-sizing: border-box; }
.history-motion :is(button, a, input, select):focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.history-motion button, .history-motion input, .history-motion select { font: inherit; }
.history-motion svg { flex-shrink: 0; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; border-bottom: 1px solid #e4e4e7; }
.heading h2 { margin: 0; font-size: 16px; font-weight: 650; }
.heading { min-width: 0; overflow-wrap: anywhere; }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; }
.control { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; max-width: 100%; padding: 5px 10px; border: 1px solid #d4d4d8; border-radius: 5px; background: #fff; color: #3f3f46; line-height: 20px; text-decoration: none; cursor: pointer; }
.control:hover:not(:disabled) { background: #f4f4f5; border-color: #a1a1aa; }
.control.primary { background: #18181b; border-color: #18181b; color: #fff; }
.control.primary:hover:not(:disabled) { background: #3f3f46; }
.control:disabled { color: #a1a1aa; background: #f4f4f5; border-color: #e4e4e7; cursor: not-allowed; }
.icon-control { width: 32px; padding: 0; }
.profile-label { display: inline-flex; align-items: center; gap: 6px; }
input, select { min-height: 32px; border: 1px solid #d4d4d8; border-radius: 5px; padding: 5px 8px; background: #fff; color: #27272a; max-width: 100%; }
.notices { padding: 8px 24px; border-bottom: 1px solid #e4e4e7; }
p { margin: 0; }
.notices p + p { margin-top: 6px; }
.muted { color: #71717a; }
.warning { color: #a16207; }
.error { color: #b91c1c; }
.content { flex: 1; min-height: 0; overflow: auto; }
.empty { padding: 60px 24px; color: #71717a; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; }
.empty h3 { margin: 0; color: #3f3f46; font-size: 16px; }
.jobs { list-style: none; margin: 0; padding: 0; }
.job { padding: 18px 24px; border-bottom: 1px solid #e4e4e7; overflow-wrap: anywhere; }
.job-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.job-identity { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 180px; }
.job-identity strong { font-weight: 600; }
.text-command { border: 0; padding: 0; background: none; color: #1d4ed8; font: inherit; cursor: pointer; text-align: left; }
.notices .text-command { margin-left: 12px; }
.job-title { color: #27272a; font-weight: 600; }
.job-title:hover { text-decoration: underline; }
.job-message { margin-top: 9px; overflow-wrap: anywhere; }
.production-summary { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; color: #71717a; font-size: 12px; }
.production-summary span { display: inline-flex; align-items: center; gap: 5px; }
.fallback-records { margin-top: 10px; color: #a16207; font-size: 12px; }
.fallback-records summary, .manual-adjustment summary { cursor: pointer; padding-block: 4px; }
.fallback-records ul { list-style: none; padding: 0; margin: 8px 0 0; }
.fallback-records li + li { margin-top: 8px; }
.fallback-records strong { font-weight: 550; }
.delivery-association { margin-top: 12px; padding: 12px; background: #fafafa; border: 1px solid #e4e4e7; border-radius: 5px; }
.delivery-association p { margin: 6px 0; overflow-wrap: anywhere; }
.delivery-association.attached > strong { color: #15803d; }
.delivery-association.existing_preserved > strong { color: #a16207; }
.delivery-association.failed > strong { color: #b91c1c; }
.status { padding: 3px 8px; border-radius: 4px; background: #f4f4f5; color: #52525b; font-size: 12px; white-space: nowrap; }
.status.needs_review { background: #fffbeb; color: #a16207; }
.status.completed { background: #f0fdf4; color: #15803d; }
.status.failed { background: #fef2f2; color: #b91c1c; }
.status.planning, .status.selecting, .status.rendering, .status.validating { background: #eff6ff; color: #1d4ed8; }
.shot-review { display: grid; grid-template-columns: minmax(160px, 230px) minmax(0, 1fr); border: 1px solid #e4e4e7; border-radius: 6px; margin-top: 16px; overflow: hidden; }
.shot-list { border-right: 1px solid #e4e4e7; background: #fafafa; max-height: 670px; overflow: auto; }
.shot-list button { width: 100%; display: flex; align-items: flex-start; gap: 8px; padding: 12px; background: transparent; border: 0; border-bottom: 1px solid #e4e4e7; text-align: left; cursor: pointer; color: #52525b; }
.shot-list button.selected { background: #eff6ff; box-shadow: inset 3px 0 #2563eb; color: #1e3a8a; }
.shot-number { color: #a1a1aa; font-variant-numeric: tabular-nums; }
.shot-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.shot-copy small { display: block; margin-top: 5px; font-size: 11px; color: #71717a; }
.ready-icon { color: #15803d; }
.shot-detail { min-width: 0; padding: 16px; }
.shot-detail > p { margin-bottom: 10px; }
.shot-narration { font-size: 14px; font-weight: 550; }
.visual-kind { display: flex; align-items: center; gap: 5px; color: #52525b; font-size: 12px; }
.visual-kind.map { color: #526443; }
.visual-kind.image { color: #9f1239; }
.visual-kind.graphic { color: #0369a1; }
.manual-adjustment { border-top: 1px solid #e4e4e7; padding-top: 10px; margin-top: 16px; }
.empty-candidates { padding: 24px; background: #fafafa; color: #71717a; }
.candidates { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.candidate { min-width: 0; border: 1px solid #e4e4e7; border-radius: 5px; overflow: hidden; }
.candidate.chosen { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb; }
.candidate video { display: block; width: 100%; aspect-ratio: 16/9; object-fit: contain; background: #18181b; }
.candidate-copy { padding: 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
.candidate-copy p { font-size: 12px; overflow-wrap: anywhere; }
.candidate-annotation span, .candidate-context span { color: #71717a; }
.candidate-copy small { font-size: 11px; }
.trim-form { margin-top: 16px; padding-top: 14px; border-top: 1px solid #e4e4e7; display: flex; flex-direction: column; gap: 12px; }
.trim-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.trim-form label { display: flex; flex-direction: column; gap: 5px; color: #52525b; font-size: 12px; }
.trim-form input { width: 100%; }
.trim-form .freeze-option { flex-direction: row; align-items: center; }
.trim-form .freeze-option input { width: 16px; min-height: 16px; }
.search-form { display: flex; align-items: flex-end; gap: 8px; margin: 12px 0; }
.search-form label { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; font-size: 12px; color: #52525b; }
.source-panel { height: auto; }
.source-panel .toolbar, .source-panel .notices { padding-inline: 0; }
.source-panel .job { padding-inline: 0; }
.source-panel .content { overflow: visible; }
.spinning { animation: motion-spin 1s linear infinite; }
@keyframes motion-spin { to { transform: rotate(360deg); } }
@media(max-width: 900px) { .shot-review { grid-template-columns: 1fr; } .shot-list { display: flex; max-height: 150px; border-right: 0; border-bottom: 1px solid #e4e4e7; } .shot-list button { min-width: 180px; max-width: 220px; flex-shrink: 0; border-bottom: 0; border-right: 1px solid #e4e4e7; } }
@media(max-width: 600px) { .toolbar, .job, .notices { padding-inline: 14px; } .job-summary > .actions { flex-basis: 100%; } .profile-label { flex-wrap: wrap; } .trim-fields { grid-template-columns: 1fr; } .candidates { grid-template-columns: 1fr; } }
</style>
