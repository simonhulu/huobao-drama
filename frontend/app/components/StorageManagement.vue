<template>
  <div class="storage-management">
    <header class="storage-heading">
      <div class="heading-title">
        <HardDrive :size="21" :stroke-width="1.7" />
        <h2>磁盘管理</h2>
      </div>
      <div class="heading-actions">
        <span v-if="report?.running" class="run-status"><Loader2 :size="14" class="spinning" /> 正在回收</span>
        <button type="button" class="storage-icon" title="刷新磁盘状态" aria-label="刷新磁盘状态" :disabled="pending !== ''" @click="load">
          <RefreshCw :size="16" :class="{ spinning: pending === 'load' }" />
        </button>
      </div>
    </header>

    <div v-if="error" role="alert" class="storage-error">
      <AlertCircle :size="16" />
      <span>{{ error }}</span>
    </div>

    <div v-if="!report && pending === 'load'" class="storage-empty" role="status"><Loader2 :size="18" class="spinning" /> 正在读取磁盘状态</div>

    <template v-if="report">
      <section class="disk-section" aria-label="磁盘占用">
        <div class="disk-overview">
          <div><span class="metric-label">可用空间</span><strong class="disk-free">{{ bytes(report.disk.freeBytes) }}</strong></div>
          <dl class="disk-stats">
            <div><dt>总容量</dt><dd>{{ bytes(report.disk.totalBytes) }}</dd></div>
            <div><dt>已使用</dt><dd>{{ usagePercent.toFixed(1) }}%</dd></div>
          </dl>
        </div>
        <div class="disk-meter" :class="{ critical: usagePercent >= 90, warning: usagePercent >= 80 && usagePercent < 90 }" role="meter" aria-label="磁盘使用率" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="usagePercent">
          <span :style="{ width: `${usagePercent}%` }" />
        </div>
      </section>

      <section class="storage-section">
        <div class="section-heading">
          <h3>可回收项目</h3>
          <div class="section-actions">
            <button type="button" class="storage-button secondary" :disabled="busy" @click="loadReview">
              <Loader2 v-if="pending === 'review-list'" :size="14" class="spinning" /><ClipboardCheck v-else :size="14" />人工核验
            </button>
            <button type="button" class="storage-button secondary" :disabled="busy" @click="scan">
              <Loader2 v-if="pending === 'scan'" :size="14" class="spinning" /><Search v-else :size="14" />
              {{ pending === 'scan' ? '扫描中' : '扫描' }}
            </button>
          </div>
        </div>
        <div v-if="report.groups.length" class="group-list">
          <div class="group-row group-head" aria-hidden="true"><span>类别</span><span>项目</span><span>预计回收</span></div>
          <label v-for="group in report.groups" :key="group.kind" class="group-row" :class="{ unavailable: !group.count }">
            <span class="group-name"><input v-model="selected" type="checkbox" :value="group.kind" :disabled="busy || !group.count" />{{ group.label || kindLabels[group.kind] || group.kind }}</span>
            <span class="number">{{ group.count.toLocaleString() }}</span>
            <span class="number">{{ bytes(group.bytes) }}</span>
          </label>
        </div>
        <div v-else class="storage-empty"><CheckCircle2 v-if="scanned" :size="18" /><Search v-else :size="18" />{{ scanned ? '暂无可回收项目' : '尚未扫描' }}</div>
        <div class="cleanup-bar">
          <span class="selection-summary">已选 {{ selectedCount.toLocaleString() }} 项<span v-if="selectedCount"> · {{ bytes(selectedBytes) }}</span></span>
          <button type="button" class="storage-button primary" :disabled="busy || selectedCount === 0" @click="cleanup">
            <Loader2 v-if="pending === 'cleanup' || report.running" :size="14" class="spinning" /><Trash2 v-else :size="14" />
            {{ pending === 'cleanup' || report.running ? '回收中' : '回收安全项目' }}
          </button>
        </div>
        <details v-if="report.items.length" class="file-details">
          <summary>文件清单<span>{{ report.items.length.toLocaleString() }} 项</span></summary>
          <div class="file-line file-head" aria-hidden="true"><span>归属任务</span><span>文件</span><span class="number">预计回收</span></div>
          <ul class="file-list">
            <li v-for="item in report.items.slice(0, visibleItems)" :key="item.id">
              <div class="file-line"><div class="file-owner"><span>{{ ownerLabels[item.ownerType] || item.ownerType }} #{{ item.ownerId }}</span><small>{{ roleLabels[item.role] || item.role }} · {{ stateLabels[item.state] || item.state }}</small></div><span class="file-path" :title="item.path">{{ item.path }}</span><span class="number">{{ bytes(item.bytes) }}</span></div>
              <p>{{ item.reason }}</p>
            </li>
          </ul>
          <button v-if="visibleItems < report.items.length" type="button" class="storage-button secondary more-files" @click="visibleItems += 50">查看更多</button>
        </details>
      </section>

      <section v-if="reviewLoaded || pending === 'review-list'" ref="reviewSection" class="storage-section">
        <div class="section-heading"><h3>待核验产物</h3><span class="review-count">{{ reviewItems.length }}<template v-if="reviewTotal !== null"> / {{ reviewTotal }}</template> 项</span></div>
        <form class="review-filters" @submit.prevent="loadReview">
          <label><span>任务 ID</span><input v-model="reviewFilters.ownerId" type="search" :disabled="busy" placeholder="全部任务" /></label>
          <label><span>任务类型</span><select v-model="reviewFilters.ownerType" :disabled="busy" aria-label="任务类型"><option value="">全部任务类型</option><option v-for="(label, value) in ownerLabels" :key="value" :value="value">{{ label }}</option></select></label>
          <label><span>产物类型</span><select v-model="reviewFilters.role" :disabled="busy" aria-label="产物类型"><option value="">全部类型</option><option v-for="(label, value) in roleLabels" :key="value" :value="value">{{ label }}</option></select></label>
          <button type="submit" class="storage-button secondary" :disabled="busy"><Search :size="14" />查找产物</button>
        </form>
        <div v-if="reviewResult" class="review-result" role="status"><CheckCircle2 :size="15" />{{ reviewResult }}</div>
        <div v-if="reviewError" class="storage-error" role="alert"><AlertCircle :size="15" /><span>{{ reviewError }}</span></div>
        <div v-if="pending === 'review-list'" class="storage-empty"><Loader2 :size="17" class="spinning" />正在读取产物</div>
        <template v-else>
          <div v-if="reviewItems.length" class="review-list">
            <article v-for="item in reviewItems" :key="item.id" class="review-item">
              <div class="review-item-main">
                <div class="review-item-heading"><span>{{ ownerLabels[item.ownerType] || item.ownerType }} #{{ item.ownerId }}</span><span class="number">{{ bytes(item.bytes) }}</span></div>
                <div class="file-path">{{ item.path }}</div>
                <p>{{ roleLabels[item.role] || item.role }} · {{ stateLabels[item.state] || item.state }}<span v-if="item.reason"> · {{ item.reason }}</span></p>
              </div>
              <button type="button" class="storage-icon" :title="`核验 #${item.id}`" :aria-label="`核验文件 ${item.id}`" :disabled="busy" @click="inspectArtifact(item.id)"><Eye :size="15" /></button>
            </article>
          </div>
          <div v-else class="storage-empty"><CheckCircle2 :size="18" />暂无待核验产物</div>
          <div v-if="reviewHasMore" class="review-pagination"><button type="button" class="storage-button secondary" :disabled="busy" @click="loadMoreReview"><Loader2 v-if="pending === 'review-more'" :size="14" class="spinning" /><ChevronDown v-else :size="14" />{{ pending === 'review-more' ? '加载中' : '加载更多' }}</button></div>
        </template>
      </section>

      <section class="storage-section">
        <div class="section-heading"><h3>回收策略</h3><span v-if="policySaved" class="saved-status"><Check :size="13" /> 已保存</span></div>
        <form class="policy-form" @submit.prevent="savePolicy">
          <label class="policy-row"><span>自动回收</span><input v-model="policy.autoCleanup" class="policy-check" type="checkbox" :disabled="busy" @change="policySaved = false" /></label>
          <label class="policy-row"><span>成片保留天数（0 天为确认发表后回收）</span><div class="number-field"><input v-model.number="policy.retentionDays" type="number" min="0" max="90" step="1" required :disabled="busy" aria-label="成片保留天数" @input="policySaved = false" /><span>天</span></div></label>
          <div class="policy-actions"><button type="submit" class="storage-button secondary" :disabled="busy || !policyDirty"><Loader2 v-if="pending === 'policy'" :size="14" class="spinning" /><Save v-else :size="14" />保存策略</button></div>
        </form>
      </section>

      <section v-if="protectionEntries.length" class="storage-section">
        <div class="section-heading"><h3><ShieldCheck :size="16" /> 受保护项目</h3></div>
        <dl class="protection-list"><div v-for="entry in protectionEntries" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ entry.key === 'bytes' ? bytes(entry.count) : entry.count.toLocaleString() }}</dd></div></dl>
      </section>

      <section v-if="report.lastRun" class="storage-section last-run" aria-live="polite">
        <div class="section-heading"><h3>最近回收</h3><time :datetime="report.lastRun.finishedAt">{{ timestamp(report.lastRun.finishedAt) }}</time></div>
        <div class="run-result"><CheckCircle2 :size="17" /><strong>{{ bytes(report.lastRun.reclaimedFileBytes ?? report.lastRun.freedBytes) }}</strong><span>回收占用</span><span>{{ report.lastRun.removedCount.toLocaleString() }} 项</span></div>
        <div v-if="lastRunDiskChange !== null" class="run-space-change"><span>可用空间增加</span><strong>{{ signedBytes(lastRunDiskChange) }}</strong></div>
        <ul v-if="report.lastRun.errors?.length" class="run-errors"><li v-for="(message, index) in report.lastRun.errors" :key="index">{{ message }}</li></ul>
      </section>
    </template>

    <Teleport to="body">
      <dialog ref="reviewDialog" class="artifact-dialog" aria-labelledby="artifact-review-title" @close="inspectedArtifact = null" @cancel="cancelReviewDialog">
        <header class="artifact-dialog-head"><h2 id="artifact-review-title">产物核验</h2><button type="button" class="storage-icon" title="关闭核验" aria-label="关闭核验" :disabled="reviewMutationPending" @click="reviewDialog?.close()"><X :size="17" /></button></header>
        <div v-if="pending === 'inspect'" class="storage-empty"><Loader2 :size="18" class="spinning" />正在核验文件</div>
        <form v-else-if="inspectedArtifact" class="artifact-review-form" @submit.prevent="submitReview">
          <div class="artifact-dialog-body">
            <dl class="artifact-facts">
              <div><dt>文件</dt><dd class="file-path">{{ inspectedArtifact.path }}</dd></div>
              <div><dt>大小</dt><dd>{{ bytes(inspectedArtifact.bytes) }}</dd></div>
              <div><dt>类型</dt><dd>{{ roleLabels[inspectedArtifact.role] || inspectedArtifact.role }}</dd></div>
              <div><dt>状态</dt><dd>{{ stateLabels[inspectedArtifact.state] || inspectedArtifact.state }}</dd></div>
              <div><dt>SHA-256</dt><dd class="file-path">{{ inspectedArtifact.sha256 }}</dd></div>
            </dl>
            <section v-if="previewKind && inspectedArtifact.previewUrl" class="artifact-preview">
              <div class="artifact-preview-heading"><h3>媒体预览</h3><a class="storage-icon" :href="previewDownloadUrl" download title="下载产物" aria-label="下载产物"><Download :size="15" /></a></div>
              <div v-if="previewKind !== 'audio'" class="artifact-preview-frame">
                <video v-if="previewKind === 'video'" :key="inspectedArtifact.id" :src="inspectedArtifact.previewUrl" controls playsinline preload="metadata" aria-label="产物视频" @loadedmetadata="previewState = 'ready'" @error="previewState = 'error'" />
                <img v-else :key="inspectedArtifact.id" :src="inspectedArtifact.previewUrl" alt="产物预览" @load="previewState = 'ready'" @error="previewState = 'error'" />
              </div>
              <audio v-else :key="inspectedArtifact.id" :src="inspectedArtifact.previewUrl" controls preload="metadata" aria-label="产物音频" @loadedmetadata="previewState = 'ready'" @error="previewState = 'error'" />
              <p v-if="previewState === 'loading'" class="artifact-preview-status" role="status"><Loader2 :size="13" class="spinning" />正在加载媒体</p>
              <p v-else-if="previewState === 'error'" class="artifact-preview-status preview-error" role="alert"><AlertCircle :size="13" />媒体预览失败</p>
            </section>
            <div class="artifact-owners"><h3>关联任务</h3><ul><li v-for="(owner, index) in artifactOwners" :key="`${owner.ownerType}:${owner.ownerId}:${index}`"><span>{{ ownerLabels[owner.ownerType] || owner.ownerType }} #{{ owner.ownerId }}</span><small>{{ stateLabels[owner.state] || owner.state }}</small></li></ul></div>
            <fieldset v-if="inspectedArtifact.ownershipUnconfirmed" class="artifact-association" :disabled="busy">
              <legend>确认归属</legend>
              <div class="association-controls">
                <label><span>任务类型</span><select v-model="associationForm.ownerType" aria-label="任务类型"><option v-for="type in associationOwnerTypes" :key="type" :value="type">{{ ownerLabels[type] || type }}</option></select></label>
                <label><span>任务 ID</span><input v-model="associationForm.ownerId" type="text" placeholder="任务 ID" autocomplete="off" @keydown.enter.prevent="associateArtifact" /></label>
                <button type="button" class="storage-button secondary" :disabled="!canAssociate" @click="associateArtifact"><Loader2 v-if="pending === 'associate'" :size="14" class="spinning" /><Link2 v-else :size="14" />关联任务</button>
              </div>
            </fieldset>
            <div v-if="associationNotice" class="association-notice review-result" role="status"><CheckCircle2 :size="15" />{{ associationNotice }}</div>
            <div v-if="inspectedArtifact.blockers.length" class="artifact-blockers" role="status"><strong>阻止回收</strong><ul><li v-for="(blocker, index) in inspectedArtifact.blockers" :key="index">{{ blocker }}</li></ul></div>
            <template v-if="inspectedArtifact.state !== 'archived'">
            <fieldset class="review-actions" :disabled="pending === 'review-save'">
              <legend>处理方式</legend>
              <label><input v-model="reviewForm.action" type="radio" name="artifact-action" value="archive" :disabled="inspectedArtifact.blockers.length > 0 || inspectedArtifact.archiveAllowed === false || inspectedArtifact.ownershipUnconfirmed" /><Archive :size="15" />归档保留</label>
              <label><input v-model="reviewForm.action" type="radio" name="artifact-action" value="delete" :disabled="inspectedArtifact.role !== 'final' || inspectedArtifact.blockers.length > 0 || inspectedArtifact.ownershipUnconfirmed" /><Trash2 :size="15" />删除成片</label>
              <label><input v-model="reviewForm.action" type="radio" name="artifact-action" value="keep" /><Pin :size="15" />保留文件</label>
            </fieldset>
            <p v-if="inspectedArtifact.archiveAllowed === false && (!inspectedArtifact.archiveBlocker || !inspectedArtifact.blockers.includes(inspectedArtifact.archiveBlocker))" class="archive-blocker" role="status"><ShieldCheck :size="14" />{{ inspectedArtifact.archiveBlocker || '该产物暂不支持安全归档' }}</p>
            <label v-if="reviewForm.action === 'archive'" class="review-field"><span>独立备份文件</span><input v-model="reviewForm.backupPath" type="text" required placeholder="/Volumes/Archive/video.mp4" :disabled="pending === 'review-save' || inspectedArtifact.archiveAllowed === false || inspectedArtifact.ownershipUnconfirmed" autocomplete="off" /></label>
            <div v-if="reviewForm.action === 'delete'" class="review-evidence">
              <label class="review-check"><input v-model="reviewForm.productionVerified" type="checkbox" :disabled="pending === 'review-save'" />制作结果已核验</label>
              <label class="review-check"><input v-model="reviewForm.uploadVerified" type="checkbox" :disabled="pending === 'review-save'" />所有必需平台上传结果已核验</label>
              <label class="review-field"><span>上传凭证链接</span><textarea v-model="reviewForm.receiptText" rows="3" required placeholder="https://..." :disabled="pending === 'review-save'" /></label>
              <p v-if="reviewForm.receiptText.trim() && !validReceiptUrls" class="receipt-error">凭证需为完整的 http 或 https 链接，每行一条。</p>
            </div>
            </template>
            <div v-if="inspectionError" class="storage-error" role="alert"><AlertCircle :size="15" /><span>{{ inspectionError }}</span></div>
          </div>
          <footer class="artifact-dialog-foot"><button type="button" class="storage-button secondary" :disabled="reviewMutationPending" @click="reviewDialog?.close()">取消</button><button v-if="inspectedArtifact.state === 'archived'" type="button" class="storage-button primary" :disabled="busy" @click="restoreArtifact"><Loader2 v-if="pending === 'restore'" :size="14" class="spinning" /><RotateCcw v-else :size="14" />恢复素材</button><button v-else type="submit" class="storage-button" :class="reviewForm.action === 'delete' ? 'danger' : 'primary'" :disabled="!canSubmitReview"><Loader2 v-if="pending === 'review-save'" :size="14" class="spinning" /><Check v-else :size="14" />{{ reviewForm.action === 'delete' ? '确认删除成片' : reviewForm.action === 'keep' ? '保留文件' : '核验并归档' }}</button></footer>
        </form>
        <div v-else-if="inspectionError" class="inspection-error storage-error" role="alert"><AlertCircle :size="15" /><span>{{ inspectionError }}</span></div>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { AlertCircle, Archive, Check, CheckCircle2, ChevronDown, ClipboardCheck, Download, Eye, HardDrive, Link2, Loader2, Pin, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

type Kind = 'transcribed-source' | 'render-cache' | 'duplicate-material' | 'published-video'
type Policy = { autoCleanup: boolean; retentionDays: number }
type ArtifactOwner = { ownerType: string; ownerId: string; state: string }
type ReviewArtifact = ArtifactOwner & { id: number; path: string; bytes: number; role: string; reason: string; owners?: ArtifactOwner[] }
type ReviewPage = { items: ReviewArtifact[]; total?: number; offset?: number; limit?: number }
type ReviewFilters = { ownerId: string; ownerType: string; role: string }
type InspectedArtifact = ReviewArtifact & { sha256: string; blockers: string[]; review?: unknown; previewUrl?: string; mimeType?: string; archiveAllowed?: boolean; archiveBlocker?: string; ownershipUnconfirmed?: boolean }
type AssociationOwnerType = 'history-source' | 'history-motion' | 'cba' | 'science' | 'remotion' | 'episode'
type StorageReport = {
  disk: { totalBytes: number; freeBytes: number; usedPercent: number }
  policy: Policy
  groups: Array<{ kind: Kind; label: string; count: number; bytes: number }>
  items: Array<{ id: string; kind: Kind; path: string; bytes: number; reason: string; ownerType: string; ownerId: string; role: string; state: string }>
  protected?: Record<string, number>
  lastRun?: { finishedAt: string; freedBytes: number; reclaimedFileBytes?: number; diskBeforeFreeBytes?: number; diskAfterFreeBytes?: number; removedCount: number; errors: string[] } | null
  running: boolean
  scannedAt?: string
}

const kindLabels: Record<Kind, string> = {
  'transcribed-source': '已转录原件',
  'render-cache': '渲染缓存',
  'duplicate-material': '重复素材',
  'published-video': '已上传成片',
}
const ownerLabels: Record<string, string> = { 'history-source': '采集来源', 'history-motion': '历史制作', 'history-video': '历史视频', 'huasheng-material': '花生素材', 'huasheng-project': '花生工程', 'creation-task': '创作任务', 'episode': '剧集', 'remotion': 'Remotion', 'cba': 'CBA 视频', 'science': '科普制作', 'unassigned': '归属待确认' }
const roleLabels: Record<string, string> = { source: '原始素材', intermediate: '中间产物', final: '最终视频', shared: '共享素材', project: '工程文件' }
const stateLabels: Record<string, string> = { eligible: '可回收', current: '已保存', saved: '已保存', transcribed: '已转录', completed: '已完成', succeeded: '已完成', rendered: '已合成', published: '已发布', verified: '已核验', pinned: '保留', archived: '已归档', protected: '受保护', failed: '失败', running: '运行中', pending: '待处理', queued: '排队中', deleted: '已删除', upload_pending: '待上传', needs_review: '待核验', present: '本地保留' }
const protectionLabels: Record<string, string> = {
  artifacts: '关联产物', files: '受保护文件', bytes: '受保护空间', failedTasks: '失败任务',
  activeSources: '正在处理的来源', sources: '来源素材', incompleteSources: '未完成转录',
  cba: 'CBA 素材', cbaSources: 'CBA 素材', pendingUploads: '待上传视频',
  activeJobs: '运行中任务', projects: '工程', unpublishedVideos: '待确认成片',
  draftVideos: '平台草稿', lockedSources: '已锁定来源',
}
const report = ref<StorageReport | null>(null)
const pending = ref('')
const error = ref('')
const selected = ref<Kind[]>([])
const scanned = ref(false)
const visibleItems = ref(50)
const policy = reactive<Policy>({ autoCleanup: true, retentionDays: 0 })
const policySaved = ref(false)
const reviewItems = ref<ReviewArtifact[]>([])
const reviewTotal = ref<number | null>(null)
const reviewHasMore = ref(false)
const reviewLoaded = ref(false)
const reviewError = ref('')
const reviewResult = ref('')
const reviewSection = ref<HTMLElement | null>(null)
const reviewDialog = ref<HTMLDialogElement | null>(null)
const inspectedArtifact = ref<InspectedArtifact | null>(null)
const inspectionError = ref('')
const previewState = ref<'loading' | 'ready' | 'error'>('loading')
const associationOwnerTypes: AssociationOwnerType[] = ['history-source', 'history-motion', 'cba', 'science', 'remotion', 'episode']
const associationForm = reactive({ ownerType: 'history-source' as AssociationOwnerType, ownerId: '' })
const associationNotice = ref('')
const reviewForm = reactive({ action: 'archive' as 'keep' | 'delete' | 'archive', backupPath: '', productionVerified: false, uploadVerified: false, receiptText: '' })
const reviewFilters = reactive<ReviewFilters>({ ownerId: '', ownerType: '', role: '' })
const appliedReviewFilters = ref<ReviewFilters>({ ...reviewFilters })
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

const busy = computed(() => pending.value !== '' || report.value?.running === true)
const reviewMutationPending = computed(() => ['review-save', 'restore', 'associate'].includes(pending.value))
const usagePercent = computed(() => Math.max(0, Math.min(100, report.value?.disk.usedPercent || 0)))
const selectedGroups = computed(() => (report.value?.groups || []).filter(group => selected.value.includes(group.kind)))
const selectedCount = computed(() => selectedGroups.value.reduce((sum, group) => sum + group.count, 0))
const selectedBytes = computed(() => selectedGroups.value.reduce((sum, group) => sum + group.bytes, 0))
const policyDirty = computed(() => report.value !== null && (Object.keys(policy) as Array<keyof Policy>).some(key => policy[key] !== report.value!.policy[key]))
const protectionEntries = computed(() => Object.entries(report.value?.protected || {}).filter(([, count]) => typeof count === 'number' && count > 0).map(([key, count]) => ({ key, label: protectionLabels[key] || key, count })))
const lastRunDiskChange = computed(() => {
  const before = report.value?.lastRun?.diskBeforeFreeBytes, after = report.value?.lastRun?.diskAfterFreeBytes
  return typeof before === 'number' && typeof after === 'number' && Number.isFinite(before) && Number.isFinite(after) ? after - before : null
})
const artifactOwners = computed(() => inspectedArtifact.value?.owners?.length ? inspectedArtifact.value.owners : inspectedArtifact.value ? [inspectedArtifact.value] : [])
const canAssociate = computed(() => !busy.value && inspectedArtifact.value?.ownershipUnconfirmed === true && /^[a-f\d]{64}$/i.test(inspectedArtifact.value.sha256) && associationOwnerTypes.includes(associationForm.ownerType) && associationForm.ownerId.trim().length > 0)
const previewKind = computed(() => {
  const kind = inspectedArtifact.value?.mimeType?.split('/')[0]
  return kind && ['video', 'audio', 'image'].includes(kind) ? kind : ''
})
const previewDownloadUrl = computed(() => {
  if (!inspectedArtifact.value?.previewUrl) return ''
  const url = new URL(inspectedArtifact.value.previewUrl, window.location.origin)
  url.searchParams.set('download', '1')
  return `${url.pathname}${url.search}`
})
const receiptUrls = computed(() => reviewForm.receiptText.split(/\r?\n/).map(value => value.trim()).filter(Boolean))
const validReceiptUrls = computed(() => receiptUrls.value.length > 0 && receiptUrls.value.every(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}))
const canSubmitReview = computed(() => {
  const item = inspectedArtifact.value
  if (!item || item.state === 'archived' || pending.value || report.value?.running || !/^[a-f\d]{64}$/i.test(item.sha256)) return false
  if (reviewForm.action === 'keep') return true
  if (item.blockers.length || item.ownershipUnconfirmed) return false
  if (reviewForm.action === 'archive') return item.archiveAllowed !== false && reviewForm.backupPath.trim().startsWith('/')
  return item.role === 'final' && reviewForm.productionVerified && reviewForm.uploadVerified && validReceiptUrls.value
})

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit >= 3 ? 2 : 1 })} ${units[unit]}`
}

function timestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function signedBytes(value: number) { return `${value < 0 ? '-' : value > 0 ? '+' : ''}${bytes(Math.abs(value))}` }

function applyReport(value: StorageReport, resetSelection = false) {
  const preservePolicy = policyDirty.value
  const firstReport = report.value === null
  report.value = value
  if (!preservePolicy) assignPolicy(value.policy)
  if (value.scannedAt || value.items.length || value.groups.length) scanned.value = true
  if (resetSelection || firstReport) selected.value = value.groups.filter(group => group.count > 0).map(group => group.kind)
  else selected.value = selected.value.filter(kind => value.groups.some(group => group.kind === kind && group.count > 0))
  clearTimeout(pollTimer)
  if (value.running && !disposed) pollTimer = setTimeout(load, 3000)
}

function assignPolicy(value: Policy) { policy.autoCleanup = value.autoCleanup; policy.retentionDays = value.retentionDays }

async function perform(action: string, request: () => Promise<StorageReport>, resetSelection = false) {
  if (pending.value) return
  pending.value = action
  error.value = ''
  try { applyReport(await request(), resetSelection) }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '读取磁盘状态失败' }
  finally { pending.value = '' }
}

function load() { return perform('load', () => api.get<StorageReport>('/storage')) }
async function scan() {
  await perform('scan', () => api.post<StorageReport>('/storage/scan'), true)
  if (!error.value) { scanned.value = true; visibleItems.value = 50 }
}
function cleanup() { return perform('cleanup', () => api.post<StorageReport>('/storage/cleanup', { kinds: [...selected.value] })) }
async function savePolicy() {
  await perform('policy', () => api.patch<StorageReport>('/storage/policy', { ...policy }))
  if (!error.value && report.value) { assignPolicy(report.value.policy); policySaved.value = true }
}

async function loadReview() {
  if (busy.value) return
  pending.value = 'review-list'
  reviewError.value = ''
  appliedReviewFilters.value = { ownerId: reviewFilters.ownerId.trim(), ownerType: reviewFilters.ownerType, role: reviewFilters.role }
  reviewItems.value = []
  reviewTotal.value = null
  reviewHasMore.value = false
  try { applyReviewPage(await api.get<ReviewPage>(reviewPath())); reviewLoaded.value = true }
  catch (failure) { reviewError.value = failure instanceof Error ? failure.message : '读取产物失败'; reviewLoaded.value = true }
  finally { pending.value = '' }
  await nextTick()
  reviewSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function reviewPath(offset = 0) {
  const filters = appliedReviewFilters.value
  const params = new URLSearchParams()
  if (filters.ownerId) params.set('ownerId', filters.ownerId)
  if (filters.ownerType) params.set('ownerType', filters.ownerType)
  if (filters.role) params.set('role', filters.role)
  if (offset > 0) params.set('offset', String(offset))
  return `/storage/review${params.size ? `?${params}` : ''}`
}

function applyReviewPage(page: ReviewPage, append = false) {
  const previous = append ? reviewItems.value : []
  const seen = new Set(previous.map(item => item.id))
  const added = page.items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  reviewItems.value = [...previous, ...added]
  reviewTotal.value = typeof page.total === 'number' && Number.isSafeInteger(page.total) && page.total >= 0 ? page.total : null
  reviewHasMore.value = (!append || added.length > 0) && (reviewTotal.value !== null ? reviewItems.value.length < reviewTotal.value : page.items.length >= (page.limit || 150))
}

async function loadMoreReview() {
  if (busy.value || !reviewHasMore.value) return
  pending.value = 'review-more'
  reviewError.value = ''
  try { applyReviewPage(await api.get<ReviewPage>(reviewPath(reviewItems.value.length)), true) }
  catch (failure) { reviewError.value = failure instanceof Error ? failure.message : '读取更多产物失败' }
  finally { pending.value = '' }
}

async function refreshReview() {
  const [updatedReport, updatedReview] = await Promise.all([api.get<StorageReport>('/storage'), api.get<ReviewPage>(reviewPath())])
  applyReport(updatedReport)
  applyReviewPage(updatedReview)
}

async function inspectArtifact(id: number) {
  if (busy.value) return
  pending.value = 'inspect'
  inspectedArtifact.value = null
  inspectionError.value = ''
  previewState.value = 'loading'
  associationNotice.value = ''
  Object.assign(associationForm, { ownerType: 'history-source', ownerId: '' })
  Object.assign(reviewForm, { action: 'archive', backupPath: '', productionVerified: false, uploadVerified: false, receiptText: '' })
  reviewDialog.value?.showModal()
  try { inspectedArtifact.value = await api.get<InspectedArtifact>(`/storage/artifacts/${id}`) }
  catch (failure) { inspectionError.value = failure instanceof Error ? failure.message : '核验文件失败' }
  finally { pending.value = '' }
}

function cancelReviewDialog(event: Event) { if (reviewMutationPending.value) event.preventDefault() }

async function associateArtifact() {
  if (!canAssociate.value || !inspectedArtifact.value) return
  const item = inspectedArtifact.value
  pending.value = 'associate'
  inspectionError.value = ''
  associationNotice.value = ''
  let associated = false
  try {
    const result = await api.post<{ status: string; message?: string }>(`/storage/artifacts/${item.id}/associate`, { sha256: item.sha256, ownerType: associationForm.ownerType, ownerId: associationForm.ownerId.trim() })
    associated = true
    associationNotice.value = result.message || '任务已关联'
    inspectedArtifact.value = await api.get<InspectedArtifact>(`/storage/artifacts/${item.id}`)
    await refreshReview()
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : '关联任务失败'
    inspectionError.value = associated ? `任务已关联，刷新失败：${message}` : message
  } finally { pending.value = '' }
}

async function restoreArtifact() {
  if (busy.value || inspectedArtifact.value?.state !== 'archived') return
  pending.value = 'restore'
  inspectionError.value = ''
  let restored = false
  try {
    const result = await api.post<{ status: string; message?: string }>(`/storage/artifacts/${inspectedArtifact.value.id}/restore`, {})
    reviewResult.value = result.message || '素材已恢复'
    restored = true
    reviewDialog.value?.close()
    await refreshReview()
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : '恢复素材失败'
    if (restored) reviewError.value = `素材已恢复，刷新失败：${message}`
    else inspectionError.value = message
  } finally { pending.value = '' }
}

async function submitReview() {
  if (!canSubmitReview.value || !inspectedArtifact.value) return
  const item = inspectedArtifact.value
  pending.value = 'review-save'
  inspectionError.value = ''
  let saved = false
  try {
    const result = await api.post<{ status: string; message: string }>(`/storage/artifacts/${item.id}/review`, {
      action: reviewForm.action, sha256: item.sha256,
      productionVerified: reviewForm.productionVerified, uploadVerified: reviewForm.uploadVerified,
      receiptUrls: receiptUrls.value,
      ...(reviewForm.action === 'archive' ? { backupPath: reviewForm.backupPath.trim() } : {}),
    })
    reviewResult.value = result.message || '核验结果已保存'
    saved = true
    reviewDialog.value?.close()
    await refreshReview()
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : '保存核验结果失败'
    if (saved) reviewError.value = `核验结果已保存，刷新失败：${message}`
    else inspectionError.value = message
  } finally { pending.value = '' }
}

onMounted(load)
onBeforeUnmount(() => { disposed = true; clearTimeout(pollTimer) })
</script>

<style scoped>
/* Keep the scroll area above the floating task center. */
.storage-management { height: calc(100% - 136px); overflow-y: auto; padding: 30px 36px 32px; max-width: 1040px; margin: 0 auto; color: var(--text-1); letter-spacing: 0; }
.storage-heading, .heading-title, .heading-actions, .section-heading, .section-heading h3, .run-status, .saved-status { display: flex; align-items: center; }
.storage-heading { justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.heading-title { gap: 10px; }
h2 { font-size: 20px; line-height: 1.4; font-weight: 650; }
.heading-actions { gap: 12px; }
.storage-icon { width: 34px; height: 34px; padding: 0; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-base); color: var(--text-2); cursor: pointer; }
.storage-icon:hover { background: var(--bg-2); color: var(--text-0); }
.run-status, .saved-status { gap: 6px; font-size: 12px; color: var(--success); white-space: nowrap; }
.storage-error { display: flex; align-items: flex-start; gap: 8px; padding: 12px; margin-bottom: 16px; color: var(--error); background: var(--error-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.storage-error svg { flex-shrink: 0; margin-top: 2px; }
.disk-section { padding: 0 0 26px; }
.disk-overview { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
.metric-label { display: block; font-size: 12px; color: var(--text-2); margin-bottom: 5px; }
.disk-free { font-size: 29px; line-height: 1.25; font-weight: 600; font-variant-numeric: tabular-nums; }
.disk-stats { display: flex; gap: 30px; }
.disk-stats dt { font-size: 12px; color: var(--text-2); margin-bottom: 5px; }
.disk-stats dd { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.disk-meter { height: 8px; background: var(--bg-2); border-radius: 3px; overflow: hidden; margin-top: 18px; }
.disk-meter span { display: block; height: 100%; background: var(--success); transition: width .2s ease; }
.disk-meter.warning span { background: var(--warning); }
.disk-meter.critical span { background: var(--error); }
.storage-section { padding: 22px 0; border-top: 1px solid var(--border); }
.section-heading { justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.section-heading h3 { font-size: 14px; font-weight: 600; gap: 7px; }
.section-actions { display: flex; align-items: center; gap: 8px; }
.section-heading time { font-size: 11px; color: var(--text-2); text-align: right; }
.storage-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; font-weight: 500; line-height: 1.4; cursor: pointer; font-family: inherit; white-space: nowrap; }
.storage-button.secondary { color: var(--text-1); background: var(--bg-base); }
.storage-button.secondary:hover { background: var(--bg-2); }
.storage-button.primary { background: var(--accent); color: var(--bg-base); border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
.group-row { display: grid; grid-template-columns: minmax(0, 1fr) 70px 110px; align-items: center; gap: 12px; min-height: 47px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.group-head { min-height: 32px; font-size: 11px; color: var(--text-2); padding-top: 0; }
.group-head span:not(:first-child) { text-align: right; }
.group-name { display: flex; align-items: center; gap: 10px; line-height: 1.6; }
input[type='checkbox'] { width: 16px; height: 16px; margin: 0; flex-shrink: 0; accent-color: var(--accent); cursor: pointer; }
.number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.unavailable { color: var(--text-3); }
.cleanup-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 16px; }
.selection-summary { font-size: 12px; color: var(--text-2); line-height: 1.6; }
.storage-empty { display: flex; justify-content: center; align-items: center; gap: 9px; min-height: 84px; font-size: 13px; color: var(--text-2); }
.file-details { margin-top: 20px; }
.file-details summary { cursor: pointer; font-size: 12px; color: var(--text-2); padding: 8px 0; }
.file-details summary span { margin-left: 10px; font-variant-numeric: tabular-nums; }
.file-list { list-style: none; }
.file-list li { padding: 12px 0; border-bottom: 1px solid var(--border); }
.file-line { display: grid; grid-template-columns: minmax(100px, .36fr) minmax(0, 1fr) 82px; gap: 14px; font-size: 11px; line-height: 1.6; }
.file-head { padding: 8px 0; color: var(--text-2); border-bottom: 1px solid var(--border); }
.file-owner { min-width: 0; overflow-wrap: anywhere; }
.file-owner small { display: block; color: var(--text-2); font-size: 10px; margin-top: 3px; }
.file-path { font-family: var(--font-mono); overflow-wrap: anywhere; }
.file-list p { font-size: 11px; line-height: 1.6; color: var(--text-2); margin-top: 4px; overflow-wrap: anywhere; }
.more-files { margin-top: 12px; }
.policy-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 48px; font-size: 13px; }
.number-field { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--text-2); }
.number-field input { width: 76px; height: 33px; padding: 6px 8px; color: var(--text-1); background: var(--bg-input); border: 1px solid var(--border); border-radius: 5px; font: inherit; font-variant-numeric: tabular-nums; }
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 3px; }
.policy-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
.protection-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 32px; }
.protection-list div { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; font-size: 12px; }
.protection-list dt { color: var(--text-2); overflow-wrap: anywhere; }
.protection-list dd { font-variant-numeric: tabular-nums; }
.run-result { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; color: var(--success); font-size: 13px; }
.run-result strong { font-weight: 600; font-variant-numeric: tabular-nums; }
.run-result span { color: var(--text-2); margin-left: 4px; font-size: 12px; }
.run-space-change { display: flex; justify-content: space-between; gap: 16px; margin-top: 12px; font-size: 12px; line-height: 1.6; color: var(--text-2); }
.run-space-change strong { font-weight: 500; font-variant-numeric: tabular-nums; color: var(--text-1); }
.run-errors { margin-top: 12px; padding-left: 18px; color: var(--warning); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.review-count { font-size: 12px; color: var(--text-2); }
.review-filters { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; gap: 12px; margin-bottom: 16px; }
.review-filters label, .association-controls label { display: grid; gap: 7px; min-width: 0; font-size: 12px; color: var(--text-2); }
.review-filters input, .review-filters select, .association-controls input, .association-controls select { width: 100%; min-width: 0; height: 34px; padding: 6px 9px; color: var(--text-1); background: var(--bg-input); border: 1px solid var(--border); border-radius: 5px; font: inherit; }
.review-result { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; font-size: 12px; color: var(--success); line-height: 1.7; overflow-wrap: anywhere; }
.review-result svg { flex-shrink: 0; margin-top: 2px; }
.review-item { display: grid; grid-template-columns: minmax(0, 1fr) 34px; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--border); align-items: start; }
.review-item-heading { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 7px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.review-item-main .file-path { font-size: 11px; line-height: 1.6; }
.review-item-main p { margin-top: 6px; color: var(--text-2); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.review-pagination { display: flex; justify-content: flex-end; margin-top: 14px; }
.review-pagination .storage-button { min-width: 96px; }
.artifact-dialog { width: min(720px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-base); color: var(--text-1); font-family: var(--font-body); letter-spacing: 0; }
.artifact-dialog[open] { display: flex; flex-direction: column; }
.artifact-dialog::backdrop { background: rgba(0, 0, 0, .36); }
.artifact-dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.artifact-dialog-head h2 { font-size: 17px; font-weight: 600; }
.artifact-review-form { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.artifact-dialog-body { padding: 20px; overflow-y: auto; min-height: 0; }
.artifact-facts { display: grid; gap: 12px; font-size: 12px; line-height: 1.7; }
.artifact-facts > div { display: grid; grid-template-columns: 65px minmax(0, 1fr); gap: 12px; }
.artifact-facts dt { color: var(--text-2); }
.artifact-facts dd { font-variant-numeric: tabular-nums; }
.artifact-preview { margin-top: 20px; }
.artifact-preview-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
.artifact-preview-heading h3 { font-size: 12px; font-weight: 600; }
.artifact-preview-frame { width: 100%; aspect-ratio: 16 / 9; max-height: 300px; overflow: hidden; background: var(--bg-2); border: 1px solid var(--border); border-radius: 4px; }
.artifact-preview-frame video, .artifact-preview-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
.artifact-preview audio { display: block; width: 100%; min-height: 54px; }
.artifact-preview-status { display: flex; align-items: flex-start; gap: 7px; min-height: 18px; margin-top: 8px; font-size: 11px; line-height: 1.6; color: var(--text-2); overflow-wrap: anywhere; }
.artifact-preview-status svg { flex-shrink: 0; margin-top: 2px; }
.artifact-preview-status.preview-error { color: var(--error); }
.artifact-owners { margin-top: 20px; }
.artifact-owners h3 { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.artifact-owners ul { list-style: none; }
.artifact-owners li { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 7px 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.artifact-owners small { color: var(--text-2); font-size: 11px; flex-shrink: 0; }
.artifact-association { border: 0; padding: 0; min-width: 0; margin-top: 20px; }
.artifact-association legend { font-size: 12px; font-weight: 600; margin-bottom: 12px; }
.association-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) auto; align-items: end; gap: 10px; }
.association-notice { margin-top: 16px; margin-bottom: 0; }
.artifact-blockers { margin-top: 16px; background: var(--warning-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; color: var(--warning); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.artifact-blockers strong { font-weight: 600; }
.artifact-blockers ul { padding-left: 18px; margin-top: 4px; }
.review-actions { border: 0; padding: 0; margin: 22px 0 18px; min-width: 0; display: flex; flex-wrap: wrap; gap: 10px 24px; }
.review-actions legend { font-size: 12px; font-weight: 600; margin-bottom: 12px; }
.review-actions label, .review-check { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.6; cursor: pointer; }
.review-actions input[type='radio'] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.review-actions label:has(input:disabled) { color: var(--text-3); cursor: default; }
.archive-blocker { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 16px; color: var(--warning); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.archive-blocker svg { flex-shrink: 0; margin-top: 3px; }
.review-field { display: flex; flex-direction: column; gap: 8px; font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
.review-field > span { font-weight: 500; }
.review-field input, .review-field textarea { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-1); background: var(--bg-input); font: inherit; font-family: var(--font-mono); }
.review-field textarea { resize: vertical; min-height: 76px; }
.review-evidence { display: grid; gap: 14px; }
.receipt-error { font-size: 11px; color: var(--error); line-height: 1.6; margin-top: -6px; }
.artifact-dialog-body .storage-error { margin-top: 16px; margin-bottom: 0; }
.artifact-dialog-foot { display: flex; justify-content: flex-end; align-items: center; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border); flex-shrink: 0; }
.storage-button.danger { color: #fff; background: var(--error); border-color: var(--error); }
.inspection-error { margin: 20px; }
.spinning { animation: storage-spin 1s linear infinite; }
@keyframes storage-spin { to { transform: rotate(360deg); } }
:global(.storage-settings.settings-layout .settings-content) { min-width: 0; min-height: 0; }
@media (max-width: 900px) { .storage-management { padding: 24px 22px 32px; } .disk-stats { gap: 18px; } }
@media (max-width: 640px) {
  :global(.storage-settings.settings-layout) { flex-direction: column; }
  :global(.storage-settings.settings-layout .settings-nav) { width: 100%; flex-direction: row; padding: 8px 12px; gap: 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  :global(.storage-settings.settings-layout .settings-nav .nav-group) { flex-direction: row; flex-shrink: 0; }
  :global(.storage-settings.settings-layout .settings-nav .nav-group-label), :global(.storage-settings.settings-layout .settings-nav .nav-advanced) { display: none; }
  :global(.storage-settings.settings-layout .settings-nav .nav-item) { width: auto; white-space: nowrap; padding: 8px 10px; }
  .storage-management { padding: 22px 16px 32px; }
  .storage-heading { gap: 8px; }
  .heading-title { gap: 8px; }
  .heading-actions { gap: 8px; }
  .run-status { font-size: 11px; }
  h2 { font-size: 18px; }
  .disk-overview { gap: 18px; flex-wrap: wrap; }
  .disk-stats { gap: 24px; }
  .disk-free { font-size: 27px; }
  .group-row { grid-template-columns: minmax(0, 1fr) 42px 86px; gap: 8px; font-size: 12px; }
  .group-name { gap: 8px; }
  .file-line { grid-template-columns: minmax(76px, .55fr) minmax(0, 1fr); column-gap: 10px; row-gap: 4px; }
  .file-line > .number { grid-column: 2; text-align: left; color: var(--text-2); }
  .file-head > .number { display: none; }
  .cleanup-bar { flex-wrap: wrap; }
  .protection-list { grid-template-columns: 1fr; }
  .section-heading time { max-width: 160px; line-height: 1.5; }
  .section-actions { gap: 6px; }
  .section-actions .storage-button { padding-inline: 9px; }
  .review-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 10px; }
  .review-filters .storage-button { justify-self: end; }
  .association-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .association-controls .storage-button { grid-column: 1 / -1; justify-self: end; }
  .review-item { gap: 10px; }
  .review-item-heading { flex-wrap: wrap; gap: 4px 14px; }
  .artifact-dialog-head { padding: 12px 14px; }
  .artifact-dialog-body { padding: 16px 14px; }
  .artifact-facts > div { grid-template-columns: 58px minmax(0, 1fr); gap: 8px; }
  .review-actions { gap: 12px 18px; }
  .artifact-dialog-foot { padding: 12px 14px; }
}
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } .disk-meter span { transition: none; } }
</style>
