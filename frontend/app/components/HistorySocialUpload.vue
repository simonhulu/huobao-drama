<template>
  <section class="social-upload" aria-label="百家号视频发表">
    <header class="upload-heading">
      <div><h2>百家号视频发表</h2><span>已选 {{ selectedVersions.length }} 个版本</span></div>
      <button class="upload-control icon-control" type="button" aria-label="刷新上传状态" title="刷新上传状态" :disabled="refreshing" @click="refresh"><RefreshCw :size="17" :class="{ spinning: refreshing }" aria-hidden="true" /></button>
    </header>

    <div v-if="focusRequested" class="publication-focus" role="status" aria-label="当前视频定位">
      <span v-if="focusScriptId && (!videoFocusRequested || focusVideoId)">稿件 #{{ focusScriptId }}<template v-if="videoFocusRequested"> · 成片 #{{ focusVideoId }}<template v-if="versions[0]"> · {{ producerLabel(versions[0].producer) }}</template></template><template v-else> · 全部成片版本</template></span>
      <span v-else>定位链接中的稿件或成片编号无效</span>
      <button class="upload-control" type="button" :disabled="busy || !!jobAction" @click="clearFocus"><X :size="15" aria-hidden="true" />清除定位</button>
    </div>

    <div class="runtime-state" role="status" aria-live="polite">
      <span v-if="runtimeLoading"><LoaderCircle :size="15" class="spinning" aria-hidden="true" />正在检查运行环境…</span>
      <div v-else-if="!runtime || !runtime.installed" class="runtime-error error">
        <span><CircleAlert :size="15" aria-hidden="true" />{{ runtimeFeedback.text }}</span>
        <details v-if="runtimeFeedback.detail" class="technical-details"><summary>技术详情</summary><pre>{{ runtimeFeedback.detail }}</pre></details>
      </div>
      <template v-else>
        <span><CircleCheck :size="15" aria-hidden="true" />运行环境就绪<template v-if="backgroundExecution"> · 后台上传</template></span>
        <div v-for="platform in platformStates" :key="platform.id" class="runtime-platform">
          <span :class="platform.ready ? 'ready' : 'warning'"><CircleCheck v-if="platform.ready" :size="14" aria-hidden="true" /><CircleAlert v-else :size="14" aria-hidden="true" />{{ platform.name }}：{{ platform.feedback.text }}</span>
          <button v-if="!platform.ready && (platform.retryConnection || !backgroundExecution)" class="upload-control" type="button" :disabled="busy || !!jobAction || runtimeLoading" :aria-busy="loginPlatform === platform.id" :aria-label="platform.retryConnection ? `重试连接${platform.name}` : undefined" @click="platform.retryConnection ? loadRuntime() : openLogin(platform.id)">
            <LoaderCircle v-if="loginPlatform === platform.id" :size="15" class="spinning" aria-hidden="true" /><RefreshCw v-else-if="platform.retryConnection" :size="15" aria-hidden="true" /><LogIn v-else :size="15" aria-hidden="true" />
            <template v-if="platform.retryConnection">重试连接</template><template v-else-if="platform.issue === 'verification_required'">验证{{ platform.name }}</template><template v-else-if="platform.issue === 'browser_unavailable'">打开{{ platform.name }}浏览器</template><template v-else>登录{{ platform.name }}</template>
          </button>
          <button v-if="backgroundExecution" class="upload-control" type="button" :disabled="busy || !!jobAction || runtimeLoading" :aria-busy="loginPlatform === platform.id" title="打开原专用 Chrome，可先完成登录或安全验证" @click="openLogin(platform.id)"><LoaderCircle v-if="loginPlatform === platform.id" :size="15" class="spinning" aria-hidden="true" /><LogIn v-else :size="15" aria-hidden="true" />打开{{ platform.name }}登录窗口</button>
          <button v-if="backgroundExecution" class="upload-control" type="button" :disabled="busy || !!jobAction || runtimeLoading || !!syncWaitMessage" :aria-busy="syncPlatform === platform.id" @click="syncLogin(platform.id)"><LoaderCircle v-if="syncPlatform === platform.id" :size="15" class="spinning" aria-hidden="true" /><RefreshCw v-else :size="15" aria-hidden="true" />同步{{ platform.name }}登录</button>
          <small v-if="backgroundExecution" class="muted">复用原{{ platform.name }}登录</small>
          <details v-if="platform.feedback.detail" class="technical-details"><summary>技术详情</summary><pre>{{ platform.feedback.detail }}</pre></details>
        </div>
        <p v-if="syncWaitMessage" class="runtime-help">{{ syncWaitMessage }}</p>
      </template>
    </div>
    <div v-if="loginError" class="operation-error" role="alert"><span>{{ feedback(loginError).text }}</span><details v-if="feedback(loginError).detail" class="technical-details"><summary>技术详情</summary><pre>{{ feedback(loginError).detail }}</pre></details></div>
    <p v-if="syncError" class="operation-error" role="alert">{{ syncError }}</p>
    <p v-else-if="syncMessage" class="runtime-help" role="status" aria-live="polite">{{ syncMessage }}</p>

    <fieldset class="candidate-section" :disabled="busy || candidatesLoading">
      <legend>视频版本</legend>
      <div class="queue-filters" role="group" aria-label="视频版本筛选">
        <button v-for="filter in candidateFilters" :key="filter.id" class="upload-control" type="button" :aria-pressed="candidateFilter === filter.id" @click="selectCandidateFilter(filter.id)">{{ filter.label }}（{{ candidateCounts[filter.id] }}）</button>
      </div>
      <div class="candidate-toolbar">
        <input :value="candidateSearch" class="candidate-search" type="search" aria-label="搜索视频版本" placeholder="标题或稿件编号" @input="candidateSearch = ($event.target as HTMLInputElement).value" />
        <label class="candidate-choice"><input type="checkbox" :checked="allCandidatesSelected" :indeterminate="!allCandidatesSelected && selectedVersions.length > 0" :disabled="!selectableCandidates.length" @change="toggleAllCandidates" /><span>选择可发表版本（{{ Math.min(selectableCandidates.length, 100) }}）</span></label>
      </div>
      <p v-if="candidatesLoading" class="empty-state" role="status">正在读取视频版本…</p>
      <div v-else-if="candidatesError" class="operation-error" role="alert">{{ candidatesError }}<button class="upload-control" type="button" @click="loadCandidates">重试项目</button></div>
      <p v-else-if="!versions.length" class="empty-state">{{ focusRequested ? '未找到指定视频版本，请核对原稿件或清除定位。' : '暂无视频生产记录' }}</p>
      <p v-else-if="!filteredCandidates.length" class="empty-state">{{ candidateSearch.trim() ? '没有匹配的视频版本' : '当前分类暂无视频版本' }}</p>
      <div v-else class="candidate-list">
        <article v-for="candidate in filteredCandidates" :key="candidate.key" class="version-row" :data-state="candidate.state">
          <label class="candidate-choice"><input type="checkbox" :aria-label="`选择${producerLabel(candidate.producer)}：${candidate.title} 稿件 #${candidate.scriptId}`" :checked="selectedVersionKeys.includes(candidate.key)" :disabled="!candidate.canPublish || selectedVersions.length >= 100 && !selectedVersionKeys.includes(candidate.key)" @change="toggleVersion(candidate.key)" /><span>{{ candidate.title }}<small>稿件 #{{ candidate.scriptId }} · {{ producerLabel(candidate.producer) }}</small></span></label>
          <div class="version-progress"><span class="job-status" :class="versionTone(candidate.state)">{{ versionLabel(candidate.state) }}</span><p v-if="candidate.error || candidate.message">{{ feedback(candidate.error || candidate.message || '').text }}</p></div>
          <div class="version-actions">
            <button v-if="['retry_export', 'retry_packaging', 'retry_upload', 'reconcile'].includes(candidate.action)" class="upload-control" type="button" :disabled="!!jobAction" @click="continueVersion(candidate)"><RefreshCw :size="15" :class="{ spinning: jobAction === `version:${candidate.key}` }" aria-hidden="true" />{{ versionActionLabel(candidate.action) }}</button>
            <a v-if="['continue_production', 'review_legacy'].includes(candidate.action)" class="upload-control" :href="`/history-scripts?view=library&script=${candidate.scriptId}`"><ExternalLink :size="15" aria-hidden="true" />{{ candidate.action === 'review_legacy' ? '核对稿件' : '查看生产' }}</a>
            <button v-if="candidate.previousJobId" class="upload-control" type="button" @click="locateJob(candidate.previousJobId)"><ArrowDown :size="15" aria-hidden="true" />查看原发表任务</button>
          </div>
        </article>
      </div>
    </fieldset>

    <div v-if="storageError" class="operation-error" role="alert">{{ storageError }}<button class="upload-control" type="button" @click="restore">重试读取凭据</button></div>
    <div v-if="preflightError" class="operation-error" role="alert">{{ preflightError }}<button class="upload-control" type="button" :disabled="busy || !selectedTargets.length" @click="checkPreflight()">重试预检</button></div>
    <div v-if="queueError" class="operation-error" role="alert">{{ queueError }}<button class="upload-control" type="button" :disabled="refreshing" @click="refresh">重试状态</button></div>
    <div v-if="actionError" class="operation-error" role="alert"><span>{{ feedback(actionError).text }}</span><details v-if="feedback(actionError).detail" class="technical-details"><summary>技术详情</summary><pre>{{ feedback(actionError).detail }}</pre></details></div>
    <div v-for="pending in visibleRequests" :key="pending.requestId" class="pending-request" role="status"><LoaderCircle :size="16" class="spinning" aria-hidden="true" /><span>正在读取提交结果，请勿重复提交 · {{ pending.scriptIds.map(id => `#${id}`).join('、') }}</span><button class="upload-control" type="button" :disabled="refreshing" @click="loadJobs">刷新状态</button></div>

    <div class="target-scroll">
      <table class="target-table">
        <caption class="sr-only">项目平台与格式预检</caption>
        <thead><tr><th scope="col" class="project-heading">项目</th><th v-for="target in targetOptions" :key="target.id" scope="col"><label class="target-choice"><input :checked="selectedTargets.includes(target.id)" type="checkbox" :disabled="busy" @change="toggleTarget(target.id)" /><span>{{ target.label }}<small>{{ target.engine }}</small></span></label></th></tr></thead>
        <tbody>
          <tr v-for="project in projects" :key="project.key">
            <th scope="row" class="project-title"><span>{{ project.title }}</span><small>稿件 #{{ project.scriptId }} · {{ project.version }}</small></th>
            <td v-for="target in targetOptions" :key="target.id" :data-target="target.id" :data-label="target.label">
              <span v-if="!selectedTargets.includes(target.id)" class="muted">未选择</span>
              <span v-else-if="preflighting" class="check-state muted"><LoaderCircle :size="15" class="spinning" aria-hidden="true" />检查中…</span>
              <template v-else-if="project.checks[target.id]">
                <span class="check-state" :class="project.checks[target.id]!.ready ? 'ready' : 'warning'"><CircleCheck v-if="project.checks[target.id]!.ready" :size="15" aria-hidden="true" /><CircleAlert v-else :size="15" aria-hidden="true" />{{ project.checks[target.id]!.ready ? '可发表' : '已阻塞' }}</span>
                <ul v-if="project.checks[target.id]!.missing.length" class="missing-list"><li v-for="(reason, index) in project.checks[target.id]!.missing" :key="index">{{ reason }}</li></ul>
                <ul v-if="project.checks[target.id]!.warnings?.length" class="preflight-warnings" aria-label="非阻塞提醒"><li v-for="(warning, index) in project.checks[target.id]!.warnings" :key="index">提醒：{{ warning }}</li></ul>
              </template>
              <span v-else class="muted">待预检</span>
            </td>
          </tr>
          <tr v-if="!projects.length"><td :colspan="targetOptions.length + 1" class="empty-state">没有可检查的项目</td></tr>
        </tbody>
      </table>
    </div>

    <div class="submit-actions">
      <button class="upload-control primary" type="button" :disabled="!canSubmit" @click="submit('publish')"><Save :size="16" aria-hidden="true" />{{ submittingMode === 'publish' ? '正在提交…' : `发表所选版本（${selectedVersions.length}）` }}</button>
      <button class="upload-control text-control" type="button" :disabled="busy || !projectIds.length || !selectedTargets.length" @click="checkPreflight()"><ClipboardCheck :size="16" aria-hidden="true" />预检素材</button>
      <span v-if="hasPreflight" class="preflight-count" role="status">{{ readyCount }} 版可发表 · {{ blockedCount }} 版阻塞<template v-if="uploadedCount"> · {{ uploadedCount }} 版已提交</template></span>
    </div>
    <p class="submit-feedback" role="status" aria-live="polite">{{ (busy ? submitDisabledReason : submitMessage || submitDisabledReason) }}</p>

    <section class="upload-queue" aria-label="发表队列">
      <header class="queue-heading"><h3>发表队列</h3><span>按提交时间倒序<span v-if="lastCheckedAt"> · {{ queueError ? '上次读取' : '状态刷新' }} {{ formatTime(lastCheckedAt) }}</span></span></header>
      <div class="queue-toolbar">
        <div class="queue-filters" role="group" aria-label="发表队列筛选">
          <button class="upload-control" type="button" :aria-pressed="queueFilter === 'all'" @click="queueFilter = 'all'">全部（{{ visibleJobs.length }}）</button>
          <button class="upload-control" type="button" :aria-pressed="queueFilter === 'attention'" @click="queueFilter = 'attention'">{{ hasPublicationAttention ? '需要处理' : '发表失败' }}（{{ attentionJobs.length }}）</button>
        </div>
        <button class="upload-control" type="button" :disabled="!!jobAction || !retryableJobs.length" :aria-busy="jobAction === 'retry:batch'" @click="retryFailedJobs"><RefreshCw :size="15" :class="{ spinning: jobAction === 'retry:batch' }" aria-hidden="true" />{{ hasPublicationRetry ? '批量继续任务' : '批量重新上传' }}（{{ retryableJobs.length }}）</button>
      </div>
      <p v-if="retryableJobs.length" class="queue-activity">{{ hasPublicationRetry ? `继续当前列表中的 ${retryableJobs.length} 个原任务；已提交审核或已发表的目标会自动跳过。` : `重新上传当前列表中的 ${retryableJobs.length} 个失败项；已保存成功的目标会自动跳过。` }}</p>
      <div v-if="retryMessage" class="retry-result" role="status" aria-live="polite">
        <p>{{ retryMessage }}</p>
        <ul v-if="retrySkipped.length"><li v-for="item in retrySkipped" :key="item.id">{{ retryJobIdentity(item.id) }}：{{ feedback(item.message).text }}<details v-if="feedback(item.message).detail" class="technical-details"><summary>技术详情</summary><pre>{{ feedback(item.message).detail }}</pre></details></li></ul>
      </div>
      <div v-if="queuePauseMessage" class="queue-pause warning" role="status" aria-live="polite"><CircleAlert :size="16" aria-hidden="true" /><span>{{ queuePauseMessage }}</span><a v-if="!globalMode" class="upload-control" href="/history-scripts?view=uploads" target="_blank" rel="noopener noreferrer"><ExternalLink :size="15" aria-hidden="true" />发表队列</a></div>
      <p v-else-if="queueActivityMessage" class="queue-activity" role="status" aria-live="polite">{{ queueActivityMessage }}</p>
      <p v-if="!queueLoaded && queueLoading" class="empty-state" role="status">正在读取发表队列…</p>
      <p v-else-if="!filteredJobs.length && !visibleRequests.length" class="empty-state">{{ queueError ? '队列暂不可用' : queueFilter === 'attention' ? '暂无发表失败的任务' : '暂无上传任务' }}</p>
      <ol v-else class="queue-list">
        <li v-for="job in filteredJobs" :id="jobAnchor(job.id)" :key="job.id" class="queue-row" :data-status="job.status" :data-job-id="job.id" :data-focused="focusedJobId === job.id" tabindex="-1" :aria-label="`发表任务 #${job.id}`">
          <div class="job-identity">
            <strong>{{ job.title || `稿件 #${job.scriptId}` }}</strong><span>稿件 #{{ job.scriptId }} · {{ producerLabel(job.videoProducer) }} · {{ targetLabel(job.target) }}</span><small>{{ jobModeLabel(job) }} · {{ engineLabel(job.target) }}</small>
            <small class="job-time">提交时间：{{ formatJobTime(job.createdAt) }}</small>
            <small v-if="job.updatedAt && (job.status === 'saved' || job.updatedAt !== job.createdAt)" class="job-time">{{ job.status === 'saved' ? '草稿保存确认' : '状态更新' }}：{{ formatJobTime(job.updatedAt) }}</small>
          </div>
          <div class="job-progress" role="status" aria-live="polite">
            <span class="job-status" :class="statusTone(job.status)"><LoaderCircle v-if="job.status === 'running'" :size="15" class="spinning" aria-hidden="true" />{{ jobStatusLabel(job) }}</span>
            <template v-if="jobFeedback(job).text"><p :data-step="job.progress?.step">{{ jobFeedback(job).text }}</p><details v-if="jobFeedback(job).detail" class="technical-details"><summary>技术详情</summary><pre>{{ jobFeedback(job).detail }}</pre></details></template>
            <p v-if="hasMaterialBlockers(job)" class="muted">素材缺失或尚未就绪，请打开项目检查并补齐后重新上传。</p>
            <p v-if="jobRetryHint(job)" class="muted">{{ jobRetryHint(job) }}</p>
            <p v-if="needsJobLogin(job) && syncWaitMessage" class="warning">{{ syncWaitMessage }}</p>
            <p v-if="pendingActions[job.id]" class="warning">{{ pendingActionLabel(pendingActions[job.id]!) }}</p>
          </div>
          <div class="job-actions">
            <template v-if="needsJobLogin(job)">
              <button class="upload-control" type="button" :disabled="busy || !!jobAction || runtimeLoading" :aria-busy="loginPlatform === jobPlatform(job)" @click="openLogin(jobPlatform(job), job)"><LoaderCircle v-if="loginPlatform === jobPlatform(job)" :size="15" class="spinning" aria-hidden="true" /><LogIn v-else :size="15" aria-hidden="true" />打开{{ platformName(jobPlatform(job)) }}登录窗口</button>
              <button v-if="backgroundExecution" class="upload-control" type="button" :disabled="busy || !!jobAction || runtimeLoading || !!syncWaitMessage" :aria-busy="syncPlatform === jobPlatform(job)" @click="syncLogin(jobPlatform(job))"><LoaderCircle v-if="syncPlatform === jobPlatform(job)" :size="15" class="spinning" aria-hidden="true" /><RefreshCw v-else :size="15" aria-hidden="true" />同步登录</button>
            </template>
            <button v-if="canRetry(job)" class="upload-control primary" type="button" :disabled="!!jobAction || hasPendingRetry(job)" :aria-busy="jobAction === `retry:${job.id}` || hasPendingRetry(job) || jobAction === 'retry:batch'" @click="retryJob(job)"><LoaderCircle v-if="jobAction === `retry:${job.id}` || hasPendingRetry(job) || jobAction === 'retry:batch'" :size="15" class="spinning" aria-hidden="true" /><RefreshCw v-else :size="15" aria-hidden="true" />{{ jobRetryLabel(job) }}</button>
            <a v-if="hasMaterialBlockers(job)" class="upload-control" :href="`/history-scripts?script=${job.scriptId}&view=library`">查看并补齐材料</a>
            <button v-if="job.status === 'awaiting_confirmation'" class="upload-control" type="button" :disabled="!!jobAction || !!pendingActions[job.id] || !!storageError" @click="confirmJob(job)"><Save :size="15" aria-hidden="true" />{{ jobAction === `confirm:${job.id}` ? '正在保存…' : '保存草稿' }}</button>
            <a v-if="hasBackgroundResult(job)" class="upload-control" :href="backgroundJobUrl(job)" target="_blank" rel="noopener noreferrer"><ExternalLink :size="15" aria-hidden="true" />{{ jobOpenLabel(job) }}</a>
            <button v-else class="upload-control" type="button" :disabled="!job.result || !!jobAction" @click="openJob(job)"><ExternalLink :size="15" aria-hidden="true" />{{ jobAction === `open:${job.id}` ? '正在打开…' : jobOpenLabel(job) }}</button>
            <a v-if="!job.result" class="upload-control" :href="platformHome(job.target)" target="_blank" rel="noopener noreferrer">平台后台</a>
            <button v-if="canCancel(job)" class="upload-control icon-control" type="button" :aria-label="`取消排队：稿件 #${job.scriptId} ${targetLabel(job.target)}`" title="取消排队" :disabled="!!jobAction || !!pendingActions[job.id] || !!storageError" @click="cancelJob(job)"><X :size="16" aria-hidden="true" /></button>
          </div>
        </li>
      </ol>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ArrowDown, CircleAlert, CircleCheck, ClipboardCheck, ExternalLink, LoaderCircle, LogIn, RefreshCw, Save, X } from 'lucide-vue-next'

type SocialTarget = 'baijiahao-video' | 'baijiahao-article' | 'tencent-video'
type UploadMode = 'stage' | 'draft' | 'publish'
type JobStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'saved' | 'submitted' | 'published' | 'blocked' | 'failed' | 'uncertain' | 'cancelled'
type PendingAction = 'confirm' | 'cancel' | 'resume' | 'reconcile' | 'retry'
type Platform = 'baijiahao' | 'tencent'
type RuntimeIssue = 'login_required' | 'verification_required' | 'browser_unavailable' | 'connection_failed' | 'check_failed'
type PlatformRuntime = { ready: boolean; message: string; issue?: RuntimeIssue; sessionMode?: 'background'; accountName?: 'history_baijiahao' | 'history_tencent' }
type Runtime = { installed: boolean; message: string; version: string | null; execution?: 'background'; platforms: Record<Platform, PlatformRuntime> }
type Uploaded = { status: 'saved' | 'submitted' | 'published'; confirmedAt: string; confirmation: 'platform' | 'manual' }
type VersionState = 'pending' | 'producing' | 'exporting' | 'packaging' | 'ready' | 'queued' | 'uploading' | 'submitted' | 'published' | 'attention' | 'uncertain' | 'stale'
type VersionAction = 'none' | 'continue_production' | 'retry_export' | 'retry_packaging' | 'retry_upload' | 'reconcile' | 'publish' | 'review_legacy'
type ProductionVersion = { key: string; scriptId: number; scriptSha256: string; producer: string; videoId: number | null; state: VersionState; stage: string; message: string; error: string | null; action: VersionAction; jobId: string | null; exportJobId: number | null; automatic: boolean; canPublish: boolean; revisionOfVideoId?: number | null; previousJobId?: string | null }
type Candidate = { scriptId: number; title: string; uploads?: Partial<Record<SocialTarget, Uploaded>>; versions?: ProductionVersion[] }
type VersionCandidate = ProductionVersion & { title: string }
type Check = { videoId?: number | null; videoProducer?: string; scriptId: number; title: string; target: SocialTarget; ready: boolean; missing: string[]; warnings?: string[]; engine?: string; uploaded?: Uploaded }
type Preflight = { runtime?: Runtime; items: Check[] }
type UploadBlocker = { code: string; field: string; message: string }
type UploadJob = {
  videoId?: number | null; videoProducer?: string; id: string; scriptId: number; title: string; target: SocialTarget; status: JobStatus; mode: UploadMode
  createdAt?: string; updatedAt?: string
  requestId?: string; message?: string; error?: string | null
  blockers?: UploadBlocker[]
  operation?: string | null
  progress?: { step: string; message: string } | null
  recovery?: { attempts: number; maxAttempts: number; nextAttemptAt: string | null; action: string | null } | null
  result?: { publishedUrl?: string; articleId?: string; publicationStatus?: string; submitted?: boolean; published?: boolean; editorUrl?: string; draftUrl?: string; targetId?: string; accountName?: string } | null
}
type PendingRequest = { requestId: string; scriptIds: number[]; videoIds?: number[]; targets: SocialTarget[]; mode: UploadMode }
type QueueState = { paused: boolean; reason: string | null; jobId: string | null; runningJobId?: string | null; attentionCount?: number; recoveringCount?: number }
type QueueResponse = { jobs: UploadJob[]; requestId?: string; blocked?: Check[]; items?: Check[]; queue?: QueueState }
type StoredState = { targets: SocialTarget[]; selectedVersionKeys?: string[]; requests: PendingRequest[]; actions: Record<string, PendingAction>; jobs: UploadJob[] }

const props = defineProps<{ scriptId?: number | string; scriptRevision?: string; scriptIds?: number[]; focusScriptId?: unknown; focusVideoId?: unknown }>()
const emit = defineEmits<{ 'clear-focus': [] }>()
const queueAnchor = `history-upload-${useId()}`
const base = '/api/v1/history-scripts/uploads'
const storageKey = 'huobao.history-social-upload.v1'
const storageEvent = 'huobao:history-social-upload'
const instanceToken = Symbol('social-upload')
const targetOptions: { id: SocialTarget; label: string; engine: string; platform: 'baijiahao' | 'tencent' }[] = [
  { id: 'baijiahao-video', label: '百家号视频', engine: '原生视频', platform: 'baijiahao' },
]
const selectedTargets = ref<SocialTarget[]>(targetOptions.map(target => target.id))
const selectedVersionKeys = ref<string[]>([])
const focusCleared = ref(false)
const focusedJobId = ref('')
const candidates = ref<Candidate[]>([])
const candidatesLoading = ref(false)
const candidatesLoaded = ref(false)
const candidatesError = ref('')
const candidateFilters = [{ id: 'attention', label: '需处理' }, { id: 'processing', label: '进行中' }, { id: 'ready', label: '可发表' }, { id: 'submitted', label: '审核中' }, { id: 'published', label: '已发表' }, { id: 'all', label: '全部' }] as const
const candidateFilter = ref<typeof candidateFilters[number]['id']>(props.focusScriptId === undefined && props.focusVideoId === undefined ? 'attention' : 'all')
const candidateSearch = ref('')
const runtime = ref<Runtime | null>(null)
const runtimeLoading = ref(true)
const runtimeError = ref('')
const loginPlatform = ref<Platform | ''>('')
const loginError = ref('')
const syncPlatform = ref<Platform | ''>('')
const syncError = ref('')
const syncMessage = ref('')
const queueState = ref<QueueState | null>(null)
const queueLoading = ref(false)
const queueLoaded = ref(false)
const queueError = ref('')
const storageError = ref('')
const preflightError = ref('')
const actionError = ref('')
const submitMessage = ref('')
const preflighting = ref(false)
const submittingMode = ref<UploadMode | ''>('')
const jobAction = ref('')
const queueFilter = ref<'all' | 'attention'>('all')
const retryMessage = ref('')
const retrySkipped = ref<{ id: string; message: string }[]>([])
const report = ref<Preflight | null>(null)
const jobs = ref<UploadJob[]>([])
const pendingRequests = ref<PendingRequest[]>([])
const pendingActions = ref<Record<string, PendingAction>>({})
const lastCheckedAt = ref('')
const mounted = ref(false)
let storageReadable = true
let generation = 0
let queueSequence = 0
let runtimeSequence = 0
let preflightSequence = 0
let candidateSequence = 0
let queueController: AbortController | undefined
let runtimeController: AbortController | undefined
let preflightController: AbortController | undefined
let candidateController: AbortController | undefined
let poll: ReturnType<typeof setTimeout> | undefined
const requestControllers = new Set<AbortController>()
const requestTimeoutMs = 60_000
// Browser checks and focus can use the full 75s bridge budget plus process cleanup.
const browserRequestTimeoutMs = 90_000

const globalMode = computed(() => props.scriptId === undefined && props.scriptIds === undefined)
const scopedScriptIds = computed(() => [...new Set((props.scriptIds ?? [Number(props.scriptId)]).filter(id => Number.isSafeInteger(id) && id > 0))])
function positiveFocusId(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
const focusRequested = computed(() => (props.focusScriptId !== undefined || props.focusVideoId !== undefined) && !focusCleared.value)
const videoFocusRequested = computed(() => props.focusVideoId !== undefined)
const focusScriptId = computed(() => positiveFocusId(props.focusScriptId))
const focusVideoId = computed(() => positiveFocusId(props.focusVideoId))
const scopeKey = computed(() => `${globalMode.value ? 'global' : scopedScriptIds.value.join(',')}${focusRequested.value ? `|focus:${String(props.focusScriptId)}:${String(props.focusVideoId)}` : ''}`)
const versions = computed<VersionCandidate[]>(() => candidates.value.filter(candidate => (globalMode.value || scopedScriptIds.value.includes(candidate.scriptId))
  && (!focusRequested.value || candidate.scriptId === focusScriptId.value)).flatMap(candidate => {
  const editions: ProductionVersion[] = candidate.versions ?? [{ key: `${candidate.scriptId}:legacy`, scriptId: candidate.scriptId, scriptSha256: '', producer: 'legacy', videoId: null, state: 'stale', stage: 'production', message: '版本资料尚未核实', error: null, action: 'review_legacy', jobId: null, exportJobId: null, automatic: false, canPublish: false }]
  return editions.filter(edition => !focusRequested.value || !videoFocusRequested.value || focusVideoId.value !== null && edition.videoId === focusVideoId.value)
    .map(edition => ({ ...edition, title: candidate.title, canPublish: edition.canPublish === true && edition.state === 'ready' && Number.isSafeInteger(edition.videoId) && edition.videoId! > 0 }))
}))
const relatedJobIds = computed(() => new Set(versions.value.flatMap(version => [version.jobId, version.previousJobId]).filter((id): id is string => typeof id === 'string' && !!id)))
function versionGroup(state: VersionState) { return ['attention', 'uncertain', 'stale'].includes(state) ? 'attention' : ['ready', 'submitted', 'published'].includes(state) ? state : 'processing' }
const candidateCounts = computed(() => Object.fromEntries(candidateFilters.map(filter => [filter.id, filter.id === 'all' ? versions.value.length : versions.value.filter(version => versionGroup(version.state) === filter.id).length])) as Record<typeof candidateFilter.value, number>)
const selectedVersions = computed(() => versions.value.filter(version => version.canPublish && selectedVersionKeys.value.includes(version.key)))
const selectedVideoIds = computed(() => selectedVersions.value.map(version => version.videoId!))
const projectIds = computed(() => globalMode.value ? [...new Set(selectedVersions.value.map(version => version.scriptId))] : scopedScriptIds.value)
const filteredCandidates = computed(() => versions.value.filter(candidate => {
  const search = candidateSearch.value.trim().toLocaleLowerCase()
  return (!search || `${candidate.title} #${candidate.scriptId} ${producerLabel(candidate.producer)}`.toLocaleLowerCase().includes(search))
    && (candidateFilter.value === 'all' || versionGroup(candidate.state) === candidateFilter.value)
}))
const selectableCandidates = computed(() => filteredCandidates.value.filter(candidate => candidate.canPublish))
const allCandidatesSelected = computed(() => selectableCandidates.value.length > 0 && selectableCandidates.value.slice(0, 100).every(candidate => selectedVersionKeys.value.includes(candidate.key)))
const visibleJobs = computed(() => jobs.value.filter(job => (globalMode.value || projectIds.value.includes(job.scriptId))
  && (!focusRequested.value || job.scriptId === focusScriptId.value && (!videoFocusRequested.value || focusVideoId.value !== null && (job.videoId === focusVideoId.value || relatedJobIds.value.has(job.id))))).sort((left, right) => {
  const createdOrder = jobTimestamp(right.createdAt) - jobTimestamp(left.createdAt)
  if (createdOrder) return createdOrder
  const leftId = Number(left.id), rightId = Number(right.id)
  return Number.isSafeInteger(leftId) && Number.isSafeInteger(rightId) ? rightId - leftId : 0
}))
const attentionJobs = computed(() => visibleJobs.value.filter(isFailedJob))
const filteredJobs = computed(() => queueFilter.value === 'attention' ? attentionJobs.value : visibleJobs.value)
const retryableJobs = computed(() => filteredJobs.value.filter(job => canRetry(job) && !hasPendingRetry(job)))
const hasPublicationAttention = computed(() => attentionJobs.value.some(job => job.mode === 'publish'))
const hasPublicationRetry = computed(() => retryableJobs.value.some(job => job.mode === 'publish'))
const visibleRequests = computed(() => focusRequested.value ? pendingRequests.value.filter(request => request.scriptIds.includes(focusScriptId.value!)
  && (!videoFocusRequested.value || !request.videoIds || request.videoIds.some(id => id === focusVideoId.value || versions.value.some(version => version.revisionOfVideoId === id))))
  : globalMode.value ? pendingRequests.value : pendingRequests.value.filter(request => request.scriptIds.some(id => projectIds.value.includes(id))))
const runtimeFeedback = computed(() => feedback(runtimeError.value || runtime.value?.message || '运行环境未确认', '运行环境检查失败，请刷新上传状态'))
const backgroundExecution = computed(() => runtime.value?.execution === 'background')
const syncWaitMessage = computed(() => backgroundExecution.value && (queueState.value?.runningJobId || jobs.value.some(job => job.status === 'running'))
  ? '请等待当前上传任务结束后再同步登录；可先打开登录窗口完成登录或安全验证。' : '')
const platformStates = computed(() => (['baijiahao', 'tencent'] as const).filter(id => targetOptions.some(target => target.platform === id && selectedTargets.value.includes(target.id))).map(id => {
  const state = runtime.value?.platforms[id]
  const fallback = state?.ready ? '已就绪' : state?.issue ? ({
    login_required: '需要登录，请打开登录窗口',
    verification_required: '需要完成平台验证',
    browser_unavailable: '本机浏览器尚未就绪，请打开浏览器',
    connection_failed: '本机浏览器连接失败，不代表登录过期，请重试连接',
    check_failed: '平台状态检查失败，请重试连接',
  })[state.issue] : '登录未就绪'
  return { id, name: id === 'baijiahao' ? '百家号' : '视频号', ready: state?.ready === true, issue: state?.issue, retryConnection: needsConnectionRetry(state), feedback: feedback(state?.message || fallback, fallback) }
}))
const busy = computed(() => preflighting.value || !!submittingMode.value || !!loginPlatform.value || !!syncPlatform.value)
const refreshing = computed(() => runtimeLoading.value || queueLoading.value || candidatesLoading.value || !!loginPlatform.value || !!syncPlatform.value)
const submitDisabledReason = computed(() => {
  if (!mounted.value) return '正在初始化上传状态…'
  if (preflighting.value) return '正在重新检查所选平台和素材，请稍候…'
  if (submittingMode.value) return '正在提交上传请求，请勿重复点击。'
  if (jobAction.value.startsWith('retry:') || visibleJobs.value.some(job => selectedTargets.value.includes(job.target) && hasPendingRetry(job))) return '正在读取重新上传结果，请刷新状态，勿重复提交。'
  if (loginPlatform.value) return '正在打开登录窗口并检查状态，请稍候…'
  if (syncPlatform.value) return '正在同步后台账号登录状态，请稍候…'
  if (runtimeLoading.value) return '正在检查运行环境，请稍候…'
  if (globalMode.value) {
    if (candidatesLoading.value) return '正在读取成片项目，请稍候…'
    if (candidatesError.value || !candidatesLoaded.value) return candidatesError.value || '成片项目尚未读取，请重试项目。'
  }
  if (storageError.value) return storageError.value
  if (visibleRequests.value.length) return '正在读取上次提交结果，请刷新状态，勿重复提交。'
  if (!selectedVersions.value.length) return '请选择可发表的视频版本。'
  if (selectedVersions.value.length > 100 || projectIds.value.length > 100) return '每批最多选择 100 个视频版本。'
  if (!selectedTargets.value.length) return '请至少选择一个上传平台与格式。'
  if (!runtime.value?.installed) return `${runtimeFeedback.value.text}，请刷新上传状态。`
  return ''
})
const canSubmit = computed(() => !submitDisabledReason.value)
const hasPreflight = computed(() => report.value !== null)
const readyCount = computed(() => report.value?.items.filter(item => item.ready && !item.uploaded).length ?? 0)
const blockedCount = computed(() => report.value?.items.filter(item => !item.ready && !item.uploaded).length ?? 0)
const uploadedCount = computed(() => report.value?.items.filter(item => item.uploaded).length ?? 0)
const queuePauseMessage = computed(() => {
  const state = queueState.value
  if (!state?.paused) return ''
  const reason = state.reason === 'awaiting_confirmation' ? '等待保存草稿' : state.reason === 'uncertain' ? '发表结果待核对，请继续原任务' : '请刷新上传状态查看原因'
  return `队列暂停：${state.jobId ? `任务 #${state.jobId} ` : ''}${reason}`
})
const queueActivityMessage = computed(() => {
  const state = queueState.value
  if (!state || state.paused) return ''
  const attention = state.attentionCount ?? attentionJobs.value.length
  const messages = [state.runningJobId ? `正在处理任务 #${state.runningJobId}` : '', attention ? `${attention} 项${hasPublicationAttention.value ? '需要处理' : '发表失败'}` : ''].filter(Boolean)
  return messages.length ? `${messages.join(' · ')}；队列未暂停` : ''
})
const projects = computed(() => selectedVersions.value.map(version => ({ scriptId: version.scriptId, key: version.key, title: version.title, version: producerLabel(version.producer), checks: Object.fromEntries((report.value?.items || []).filter(item => item.scriptId === version.scriptId && item.videoId === version.videoId).map(item => [item.target, item])) as Partial<Record<SocialTarget, Check>> })))

function versionLabel(state: VersionState) { return ({ pending: '等待制作', producing: '制作中', exporting: '导出下载中', packaging: '发布材料准备中', ready: '可发表', queued: '等待提交', uploading: '提交中', submitted: '审核中', published: '已发表', attention: '需处理', uncertain: '发表结果待核对', stale: '版本待核对' })[state] || '状态待核对' }
function versionTone(state: VersionState) { return ['attention', 'uncertain', 'stale'].includes(state) ? 'warning' : ['submitted', 'published', 'ready'].includes(state) ? 'ready' : 'active' }
function versionActionLabel(action: VersionAction) { return ({ retry_export: '继续导出', retry_packaging: '继续发布准备', retry_upload: '继续原发表任务', reconcile: '核对原发表结果' } as Partial<Record<VersionAction, string>>)[action] || '继续处理' }

function producerLabel(producer?: string) { return ({huasheng:'花生版',motion:'精细化版',manual:'手动成片',legacy:'历史成片'} as Record<string,string>)[producer || 'legacy'] || '成片' }
function targetLabel(target: SocialTarget) { return targetOptions.find(option => option.id === target)?.label || '平台待确认' }
function isUploaded(value: any): value is Uploaded { return ['submitted','published'].includes(value?.status) && typeof value.confirmedAt === 'string' && value.confirmation === 'platform' }
function allUploaded(items: any, pending: PendingRequest) {
  return Array.isArray(items) && !!pending.videoIds?.length && pending.videoIds.every(id => pending.targets.every(target => items.some(item => item.videoId === id && pending.scriptIds.includes(Number(item.scriptId ?? item.sourceId)) && item.target === target && isUploaded(item.uploaded))))
}
function engineLabel(target: SocialTarget) { return targetOptions.find(option => option.id === target)?.engine || '引擎待确认' }
function statusLabel(status: JobStatus) { return ({ queued: '排队中', running: '上传中', awaiting_confirmation: '待保存草稿', saved: '旧草稿已保存', submitted: '已提交审核', published: '已发表', blocked: '发表失败', failed: '发表失败', uncertain: '发表结果待核对', cancelled: '已取消' })[status] || '状态待确认' }
// Legacy server operations can remain active after a frontend update. Reading
// their progress must not reintroduce a client-side recovery workflow.
function hasPendingServerOperation(job: UploadJob) { return (job.status === 'queued' || job.status === 'running') && !!job.recovery?.action }
function jobStatusLabel(job: UploadJob) {
  if (job.status === 'running') return job.mode === 'publish' ? (job.operation === 'publish' ? '发表中' : '上传中') : '上传中'
  return statusLabel(job.status)
}
function jobFeedback(job: UploadJob) {
  if (job.mode === 'publish' && job.status === 'uncertain') {
    return { text: '发表结果待核对，请继续原任务。',
      detail: [...new Set([job.message, job.error, ...(job.blockers || []).map(issue => issue.message)].filter(Boolean))].join('\n') }
  }
  if (isFailedJob(job)) {
    // Show the concrete cause, retaining technical evidence but omitting obsolete
    // instructions to resume, reconcile or wait for another automatic attempt.
    const causes = [...(job.blockers || []).map(issue => issue.message), job.message, job.error].filter(Boolean) as string[]
    const blockers = [...new Set((job.blockers || []).map(issue => uploadFeedback(issue.message).text).filter(Boolean))]
    const text = blockers.join('；') || uploadFeedback(job.message).text || uploadFeedback(job.error).text || '未能保存到草稿箱，请重新上传。'
    const details = [...new Set(causes.map(cause => {
      const formatted = uploadFeedback(cause)
      return formatted.detail || (formatted.text && !text.includes(formatted.text) ? cause : '')
    }).filter(Boolean))]
    return { text, detail: details.join('\n\n') }
  }
  if (job.status === 'queued') return { text: job.mode === 'publish' ? '等待发表' : job.mode === 'stage' ? '等待上传' : '等待上传到草稿箱', detail: '' }
  if (job.status === 'running') return { text: uploadFeedback(job.progress?.message || job.message, jobStatusLabel(job)).text, detail: '' }
  if (job.status === 'submitted') return { text: '百家号已接收发表请求，正在审核', detail: '' }
  if (job.status === 'published') return { text: '已发表到百家号', detail: '' }
  if (job.status === 'saved') return { text: '已保存到草稿箱，未发布', detail: '' }
  if (job.status === 'awaiting_confirmation') return { text: '预览已准备好，可保存草稿', detail: '' }
  return uploadFeedback(job.error || job.message)
}
function jobOpenLabel(job: UploadJob) { return ['submitted','published'].includes(job.status) ? '查看发表记录' : job.status === 'saved' ? job.target === 'tencent-video' ? '查看视频号草稿' : '查看百家号草稿' : '打开平台' }
function hasBackgroundResult(job: UploadJob) { return typeof job.result?.accountName === 'string' && !!job.result.accountName.trim() }
function backgroundJobUrl(job: UploadJob) {
  if (['submitted','published'].includes(job.status)) return 'https://baijiahao.baidu.com/builder/rc/content'
  const fallback = job.status === 'saved' && job.target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform/post/draftListManager' : platformHome(job.target)
  if (job.status !== 'saved' || !job.result?.draftUrl) return fallback
  try {
    const url = new URL(job.result.draftUrl)
    if (url.origin !== new URL(platformHome(job.target)).origin || url.username || url.password) return fallback
    // Never turn an unbound editor URL into an invitation to create another copy.
    const draftIds = url.searchParams.getAll('article_id')
    const savedDraft = job.target === 'tencent-video'
      ? url.pathname === '/platform/post/draftListManager' && !url.search
      : url.pathname === '/builder/rc/edit' && draftIds.length === 1 && /^\d+$/.test(draftIds[0]!)
    return savedDraft ? url.href : fallback
  } catch { return fallback }
}
function jobModeLabel(job: UploadJob) { return job.mode === 'publish' ? '直接发表' : job.mode === 'draft' ? '上传到草稿箱' : job.status === 'saved' ? '预览后已保存草稿' : '仅上传预览' }
function isBrowserConnectionTimeout(value = '') { return /connect_over_cdp|connectOverCDP/i.test(value) && /timeout|timed out/i.test(value) }
function needsConnectionRetry(state?: PlatformRuntime) {
  if (!state || state.ready) return false
  return state.issue ? state.issue === 'connection_failed' || state.issue === 'check_failed' : isBrowserConnectionTimeout(state.message)
}
function feedback(value?: string | null, fallback?: string) {
  const raw = (value || '').replaceAll('history_baijiahao', '百家号').replaceAll('history_tencent', '视频号')
  if (isBrowserConnectionTimeout(raw)) return { text: '本机浏览器连接超时，不代表登录过期，请重试连接', detail: raw }
  const coverFailures = [...raw.matchAll(/\b(portrait|landscape) cover edit dialog did not open\b/gi)]
  if (coverFailures.length) return { text: [...new Set(coverFailures.map(match => `${match[1]!.toLowerCase() === 'portrait' ? '竖版' : '横版'}封面窗口未打开`))].join('；'), detail: raw }
  if (/WeChat upload failed/i.test(raw) && /网络|network|net::ERR_/i.test(raw)) return { text: '视频上传网络失败，可点击重新上传', detail: raw }
  if (/net::ERR_|Network request failed/i.test(raw)) return { text: '上传网络连接失败，请检查网络后重新上传', detail: raw }
  if (/verification required/i.test(raw)) return { text: '需要完成平台安全验证', detail: raw }
  if (!/[A-Za-z]/.test(raw) || /[\u3400-\u9fff]/.test(raw)) return { text: raw, detail: '' }
  const text = fallback || (raw.includes('Expected a unique initialized WeChat editor')
    ? '视频号编辑页尚未加载完成，请重新上传'
    : /timeout|timed out/i.test(raw)
      ? '平台响应超时，请重新上传'
      : '平台操作失败，请重新上传')
  return { text, detail: raw }
}
function uploadFeedback(value?: string | null, fallback = '') {
  const raw = value?.trim() || ''
  if (/正在.*核对.*保存结果/.test(raw)) return { text: '正在确认草稿保存结果', detail: '' }
  const formatted = feedback(raw)
  const parts = formatted.text.split(/[；;，,。\n]+/).map(part => part.trim()).filter(Boolean)
  const causes = parts.filter(part => !/恢复|自动重试|核对|待确认|尚未确认|(?:不会|不再|勿|无需).*重(?:传|复|新)|(?:请|可|将).*原(?:页|任务)|从中断|其他上传继续|需要处理原编辑页/.test(part))
  const hasCause = causes.some(part => !/^(?:发表失败|上传失败|操作失败|平台操作失败|未能保存到草稿箱|请重新上传|请人工处理后继续)$/.test(part))
  const text = (hasCause ? causes.length === parts.length ? formatted.text : causes.join('；') : '').replaceAll('重试上传', '重新上传')
  return { text: text || fallback, detail: formatted.detail }
}
function statusTone(status: JobStatus) { return ['saved','submitted','published'].includes(status) ? 'ready' : ['blocked', 'uncertain', 'failed'].includes(status) ? 'error' : status === 'awaiting_confirmation' ? 'warning' : status === 'running' ? 'active' : 'muted' }
function formatTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
function jobTimestamp(value?: string) { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0 }
function formatJobTime(value?: string) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }) : '未记录'
}
function platformHome(target: SocialTarget) { return target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform' : 'https://baijiahao.baidu.com/builder/rc/home' }
function isFailedJob(job: UploadJob) { return ['blocked', 'failed', 'uncertain'].includes(job.status) }
function canRetry(job: UploadJob) { return isFailedJob(job) && !versions.value.some(version => version.videoId === job.videoId && ['submitted', 'published'].includes(version.state)) }
function jobRetryLabel(job: UploadJob) { return job.mode === 'publish' ? '继续原任务' : '重新上传' }
function hasPendingRetry(job: UploadJob) { return pendingActions.value[job.id] === 'retry' }
function jobPlatform(job: UploadJob): Platform { return job.target === 'tencent-video' ? 'tencent' : 'baijiahao' }
function platformName(platform: Platform) { return platform === 'tencent' ? '视频号' : '百家号' }
function hasMaterialBlockers(job: UploadJob) {
  return canRetry(job) && !!job.blockers?.some(issue => /^(video|covers|article|script|title|description|delivery)(\.|$)/.test(issue.field))
}
function jobFailureReasons(job: UploadJob) {
  return [job.message || '', job.error || '', ...(job.blockers || []).map(issue => issue.message)]
}
function needsJobLogin(job: UploadJob) {
  if (!canRetry(job)) return false
  const reasons = jobFailureReasons(job)
  if (reasons.some(reason => !/不代表登录过期/.test(reason) && /未登录|登录(?:已)?(?:失效|过期)|(?:重新|需要|请先|完成)[^；。:：\n]*登录|扫码|安全验证|验证码|登录验证|login_required|verification_required|login required|login expired|verification required/i.test(reason))) return true
  if (reasons.some(reason => isBrowserConnectionTimeout(reason) || /网络|network|net::ERR_/i.test(reason))) return false
  const state = runtime.value?.platforms[jobPlatform(job)]
  return !!job.blockers?.some(issue => issue.code === 'platform_not_ready') && state?.ready === false
    && (state.issue === 'login_required' || state.issue === 'verification_required')
}
function jobRetryHint(job: UploadJob) {
  if (job.mode === 'publish' && job.status === 'uncertain') return '继续原任务会先检查原回执，保留已完成步骤；不会重传或重复发表。'
  if (!canRetry(job)) return ''
  const label = jobRetryLabel(job)
  if (needsJobLogin(job)) return `请打开${platformName(jobPlatform(job))}登录窗口完成登录或安全验证，${backgroundExecution.value ? '同步登录后' : '完成后'}点击“${label}”。`
  const reason = jobFailureReasons(job).join('；')
  if (job.blockers?.some(issue => issue.code === 'runtime_check_pending') || /(?:本机|后台)浏览器连接|connect_over_cdp|connectOverCDP/i.test(reason)) return `请刷新上传状态检查后台浏览器连接，连接正常后点击“${label}”；连接失败不代表登录过期。`
  if (/网络|network|net::ERR_/i.test(reason)) return `请检查网络，网络正常后点击“${label}”。`
  return hasMaterialBlockers(job) ? '' : `处理上述原因后，点击“${label}”${job.mode === 'publish' ? '。' : '重新开始。'}`
}
function retryJobIdentity(id: string) {
  const job = jobs.value.find(job => job.id === id)
  return job ? `稿件 #${job.scriptId} · ${targetLabel(job.target)}` : `任务 #${id}`
}
function canCancel(job: UploadJob) {
  return job.status === 'queued' && !job.recovery?.action
    && !(job.mode === 'publish' && (job.operation === 'recover' || job.result))
}
function pendingActionLabel(action: PendingAction) { return action === 'retry' ? '正在读取重新上传结果，请刷新状态，勿重复提交' : '正在读取操作结果，请勿重复提交。' }

function clearFocus() {
  if (busy.value || jobAction.value) return
  focusCleared.value = true
  selectedVersionKeys.value = []
  candidateFilter.value = 'all'
  candidateSearch.value = ''
  focusedJobId.value = ''
  invalidatePreflight()
  emit('clear-focus')
}
function jobAnchor(id: string) { return `${queueAnchor}-job-${id}` }
async function locateJob(id: string) {
  queueFilter.value = 'all'
  focusedJobId.value = id
  await nextTick()
  if (typeof document === 'undefined') return
  const row = document.getElementById(jobAnchor(id))
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row?.focus({ preventScroll: true })
}

function persist() {
  if (!mounted.value || !storageReadable) return false
  try {
    const state: StoredState = { targets: selectedTargets.value, selectedVersionKeys: selectedVersionKeys.value, requests: pendingRequests.value, actions: pendingActions.value, jobs: jobs.value }
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    storageError.value = ''
    window.dispatchEvent(new CustomEvent(storageEvent, { detail: instanceToken }))
    return true
  } catch {
    storageError.value = '无法保留提交凭据，请恢复浏览器存储后重试。'
    return false
  }
}

function restore() {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw) {
      const state = JSON.parse(raw) as StoredState
      if (!Array.isArray(state.targets) || !Array.isArray(state.requests) || !Array.isArray(state.jobs) || !state.actions || typeof state.actions !== 'object') throw new Error('invalid receipt')
      selectedTargets.value = ['baijiahao-video']
      if (!focusRequested.value) {
        const revisions = new Set(versions.value.filter(version => version.revisionOfVideoId != null).map(version => version.key))
        selectedVersionKeys.value = Array.isArray(state.selectedVersionKeys) ? state.selectedVersionKeys.filter(key => typeof key === 'string' && !revisions.has(key)).slice(0, 100) : []
      }
      pendingRequests.value = state.requests.filter(request => typeof request.requestId === 'string' && Array.isArray(request.scriptIds) && Array.isArray(request.targets) && ['stage', 'draft', 'publish'].includes(request.mode))
      pendingActions.value = Object.fromEntries(Object.entries(state.actions).filter(([, value]) => value === 'confirm' || value === 'cancel' || value === 'resume' || value === 'reconcile' || value === 'retry'))
      jobs.value = normalizeJobs(state.jobs)
    }
    storageReadable = true
    storageError.value = ''
  } catch { storageReadable = false; storageError.value = '提交凭据暂不可读取，请恢复浏览器存储后重试。' }
}

function syncStoredState(event: Event) {
  if (event instanceof CustomEvent && event.detail === instanceToken || 'key' in event && event.key !== storageKey) return
  const selection = JSON.stringify([selectedTargets.value, selectedVersionKeys.value])
  restore()
  if (selection !== JSON.stringify([selectedTargets.value, selectedVersionKeys.value])) invalidatePreflight()
  schedulePoll()
}

function toggleTarget(target: SocialTarget) {
  if (busy.value) return
  selectedTargets.value = targetOptions.map(option => option.id).filter(id => id === target ? !selectedTargets.value.includes(id) : selectedTargets.value.includes(id))
  invalidatePreflight()
  persist()
}

function toggleVersion(key: string) {
  if (busy.value || jobAction.value || candidatesLoading.value || !versions.value.some(version => version.key === key && version.canPublish)) return
  if (!selectedVersionKeys.value.includes(key) && selectedVersionKeys.value.length >= 100) return
  selectedVersionKeys.value = selectedVersionKeys.value.includes(key) ? selectedVersionKeys.value.filter(value => value !== key) : [...selectedVersionKeys.value, key]
  invalidatePreflight()
  persist()
}

function toggleAllCandidates() {
  if (busy.value || candidatesLoading.value) return
  selectedVersionKeys.value = allCandidatesSelected.value ? [] : selectableCandidates.value.slice(0, 100).map(candidate => candidate.key)
  invalidatePreflight()
  persist()
}

function normalizeJobs(input: unknown): UploadJob[] {
  if (!Array.isArray(input)) throw new Error('发表队列响应不完整，请刷新状态')
  return input.filter(job => job?.target === 'baijiahao-video').map(job => {
    const scriptId = Number(job?.scriptId ?? job?.sourceId)
    const status = job?.status === 'completed' ? (job.result?.published ? 'published' : job.result?.submitted ? 'submitted' : 'saved') : job?.status === 'canceled' ? 'cancelled' : job?.status
    if (!job || !['string', 'number'].includes(typeof job.id) || !Number.isSafeInteger(scriptId) || scriptId <= 0 || !targetOptions.some(target => target.id === job.target) || !['queued', 'running', 'awaiting_confirmation', 'saved', 'submitted', 'published', 'blocked', 'failed', 'uncertain', 'cancelled'].includes(status)) throw new Error('发表队列响应不完整，请刷新状态')
    return { ...job, id: String(job.id), scriptId, title: job.title ?? job.sourceTitle, status }
  })
}

async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw signal.reason
  const controller = new AbortController()
  requestControllers.add(controller)
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const route = path.split('?')[0] || path
  const browserDependent = route === '/runtime' || route === '/runtime/login' || route === '/runtime/sync' || route === '/preflight'
    || method === 'POST' && (route === '/jobs' || /^\/jobs\/[^/]+\/(open|confirm)$/.test(route))
  const timeoutMs = browserDependent ? browserRequestTimeoutMs : requestTimeoutMs
  const timeoutMessage = route === '/preflight' ? '素材预检超时，尚未提交上传，请重试预检'
    : method === 'GET' ? '上传状态读取超时，请重试状态'
      : route === '/runtime/login' ? '打开登录窗口超时，请检查平台窗口和登录状态后刷新'
        : route === '/runtime/sync' ? '同步登录超时，请确认专用窗口已完成扫码后重试同步'
          : '操作响应超时，正在读取服务端结果，请刷新状态，勿重复提交'
  let timer: ReturnType<typeof setTimeout>
  let onAbort: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { clearTimeout(timer); reject(controller.signal.reason) }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs)
  })
  try {
    // Bound both headers and body reads, including transports that ignore abort.
    const response = await Promise.race([fetch(path.startsWith('/api/') ? path : `${base}${path}`, { method, signal: controller.signal, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), cancelled])
    let result
    try { result = await Promise.race([response.json(), cancelled]) }
    catch {
      if (controller.signal.aborted) throw controller.signal.reason
      throw new Error(`上传服务响应不完整（${response.status || '网络'}），请刷新状态`)
    }
    if (!response.ok || result?.success === false || Number(result?.code) >= 400) throw new Error(result?.message || '上传服务暂不可用，请刷新状态')
    if (!result || typeof result !== 'object') throw new Error('上传服务响应不完整，请刷新状态')
    return result.data ?? result
  } finally {
    clearTimeout(timer!)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort!)
    requestControllers.delete(controller)
  }
}

function mergeJobs(incoming: UploadJob[]) {
  const merged = new Map(jobs.value.map(job => [job.id, job]))
  const newlySaved = incoming.some(job => ['saved','submitted','published'].includes(job.status) && merged.get(job.id)?.status !== job.status)
  for (const job of incoming) {
    merged.set(job.id, job)
    const action = pendingActions.value[job.id]
    if (isFailedJob(job) && action !== 'retry') delete pendingActions.value[job.id]
    // A queue poll can overlap the POST. It must not unlock a pending reupload
    // until that request finishes and a fresh state can resolve its receipt.
    if (action === 'retry' && jobAction.value !== `retry:${job.id}` && jobAction.value !== 'retry:batch') delete pendingActions.value[job.id]
    if (action === 'confirm' && ['saved', 'submitted', 'published', 'failed', 'uncertain', 'cancelled'].includes(job.status) || action === 'cancel' && job.status !== 'queued') delete pendingActions.value[job.id]
    if (action === 'resume' && (!!job.result || ['awaiting_confirmation', 'saved', 'submitted', 'published', 'blocked', 'failed', 'cancelled'].includes(job.status))) delete pendingActions.value[job.id]
    if (action === 'reconcile' && ['awaiting_confirmation', 'saved', 'submitted', 'published', 'blocked', 'failed', 'cancelled'].includes(job.status)) delete pendingActions.value[job.id]
    if (job.status === 'queued' && hasPendingServerOperation(job) || job.status === 'running' && job.operation) delete pendingActions.value[job.id]
  }
  jobs.value = [...merged.values()]
  const confirmed = new Set(incoming.map(job => job.requestId).filter(Boolean))
  pendingRequests.value = pendingRequests.value.filter(request => !confirmed.has(request.requestId))
  persist()
  if (newlySaved && !candidatesLoading.value) void loadCandidates()
}

function updateQueueState(input: unknown) {
  if (input === undefined) return
  if (!input || typeof input !== 'object' || !('paused' in input) || typeof input.paused !== 'boolean') throw new Error('队列暂停状态响应不完整，请刷新状态')
  const value = input as QueueState
  if (value.reason != null && typeof value.reason !== 'string' || value.jobId != null && !['string', 'number'].includes(typeof value.jobId)) throw new Error('队列暂停状态响应不完整，请刷新状态')
  queueState.value = {
    paused: value.paused, reason: value.reason ?? null, jobId: value.jobId == null ? null : String(value.jobId),
    runningJobId: value.runningJobId == null ? null : String(value.runningJobId),
    attentionCount: Number.isSafeInteger(value.attentionCount) && value.attentionCount! >= 0 ? value.attentionCount : undefined,
    recoveringCount: Number.isSafeInteger(value.recoveringCount) && value.recoveringCount! >= 0 ? value.recoveringCount : undefined,
  }
}

function schedulePoll() {
  clearTimeout(poll)
  poll = undefined
  if (!mounted.value) return
  if (queueState.value?.paused || queueState.value?.runningJobId || queueState.value?.recoveringCount || visibleRequests.value.length || versions.value.some(version => ['producing', 'exporting', 'packaging', 'queued', 'uploading'].includes(version.state)) || visibleJobs.value.some(job => ['queued', 'running', 'awaiting_confirmation'].includes(job.status) || pendingActions.value[job.id])) {
    poll = setTimeout(() => Promise.all([loadJobs(), loadCandidates()]), 3000)
  }
}

async function loadJobs() {
  const current = generation
  const sequence = ++queueSequence
  queueController?.abort()
  const controller = new AbortController()
  queueController = controller
  clearTimeout(poll)
  queueLoading.value = true
  try {
    const sourceId = focusRequested.value ? focusScriptId.value : !globalMode.value && projectIds.value.length === 1 ? projectIds.value[0] : null
    const query = sourceId ? `?sourceId=${sourceId}` : ''
    const data: QueueResponse | UploadJob[] = await request(`/jobs${query}`, 'GET', undefined, controller.signal)
    if (!mounted.value || current !== generation || sequence !== queueSequence) return
    if (!Array.isArray(data)) updateQueueState(data.queue)
    mergeJobs(normalizeJobs(Array.isArray(data) ? data : data.jobs))
    for (const pending of [...visibleRequests.value]) {
      const receipt = await request(`/jobs?requestId=${encodeURIComponent(pending.requestId)}`, 'GET', undefined, controller.signal)
      if (!mounted.value || current !== generation || sequence !== queueSequence) return
      const recovered = normalizeJobs(Array.isArray(receipt) ? receipt : receipt.jobs)
      if (!Array.isArray(receipt)) updateQueueState(receipt.queue)
      mergeJobs(recovered)
      const alreadyUploaded = allUploaded(receipt.items, pending)
      if (receipt.requestId === pending.requestId && (recovered.length || Array.isArray(receipt.blocked) && receipt.blocked.length || alreadyUploaded)) {
        if (alreadyUploaded) { void loadCandidates(); actionError.value = ''; submitMessage.value = '所选版本均已提交，无需重复提交。' }
        pendingRequests.value = pendingRequests.value.filter(item => item.requestId !== pending.requestId)
        persist()
      }
    }
    queueLoaded.value = true
    queueError.value = ''
    lastCheckedAt.value = new Date().toISOString()
  } catch (error: any) {
    if (mounted.value && current === generation && sequence === queueSequence && error.name !== 'AbortError') queueError.value = error.message || '发表队列暂不可用，请重试状态'
  } finally {
    if (mounted.value && current === generation && sequence === queueSequence) { queueLoading.value = false; schedulePoll() }
  }
}

async function loadRuntime() {
  const sequence = ++runtimeSequence
  runtimeController?.abort()
  const controller = new AbortController()
  runtimeController = controller
  runtimeLoading.value = true
  try {
    const data: Runtime = await request('/runtime?refresh=true', 'GET', undefined, controller.signal)
    if (!mounted.value || sequence !== runtimeSequence) return
    if (typeof data.installed !== 'boolean' || !data.platforms) throw new Error('运行环境响应不完整，请刷新状态')
    runtime.value = data
    runtimeError.value = ''
  } catch (error: any) {
    if (mounted.value && sequence === runtimeSequence && error.name !== 'AbortError') { runtime.value = null; runtimeError.value = error.message || '运行环境未确认' }
  } finally { if (mounted.value && sequence === runtimeSequence) runtimeLoading.value = false }
}

async function loadCandidates() {
  const sequence = ++candidateSequence
  candidateController?.abort()
  const controller = new AbortController()
  candidateController = controller
  candidatesLoading.value = true
  try {
    const data = await request('/candidates', 'GET', undefined, controller.signal)
    if (!mounted.value || sequence !== candidateSequence) return
    if (!Array.isArray(data.items) || data.items.some((item: Candidate) => !Number.isSafeInteger(item.scriptId) || item.scriptId <= 0 || typeof item.title !== 'string')) throw new Error('成片项目响应不完整，请重试项目')
    const previousVideos = new Map(versions.value.map(version => [version.key, version.videoId]))
    candidates.value = data.items
    const available = new Map(versions.value.filter(version => version.canPublish).map(version => [version.key, version]))
    selectedVersionKeys.value = selectedVersionKeys.value.filter(key => {
      const version = available.get(key)
      return !!version && (previousVideos.has(key) ? previousVideos.get(key) === version.videoId : version.revisionOfVideoId == null)
    })
    if (!globalMode.value && !focusRequested.value && !candidatesLoaded.value && !selectedVersionKeys.value.length) selectedVersionKeys.value = versions.value.filter(version => version.canPublish && version.revisionOfVideoId == null).slice(0, 100).map(version => version.key)
    candidatesLoaded.value = true
    candidatesError.value = ''
    persist()
    if (focusRequested.value) {
      try {
        for (const id of relatedJobIds.value) {
          if (jobs.value.some(job => job.id === id && job.scriptId === focusScriptId.value)) continue
          const result = await request(`/jobs/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal)
          if (!mounted.value || sequence !== candidateSequence) return
          const [job] = normalizeJobs([result.job])
          if (!job || job.id !== id || job.scriptId !== focusScriptId.value) throw new Error('原发表任务与当前稿件不一致，请刷新状态核对')
          mergeJobs([job])
        }
      } catch (error: any) {
        if (mounted.value && sequence === candidateSequence && error.name !== 'AbortError') queueError.value = error.message || '原发表任务暂不可读取，请刷新状态'
      }
    }
  } catch (error: any) {
    if (mounted.value && sequence === candidateSequence && error.name !== 'AbortError') candidatesError.value = error.message || '成片项目暂不可用'
  } finally { if (mounted.value && sequence === candidateSequence) { candidatesLoading.value = false; schedulePoll() } }
}

async function selectCandidateFilter(filter: typeof candidateFilter.value) {
  if (busy.value || candidatesLoading.value) return
  candidateFilter.value = filter
  invalidatePreflight()
  // Another tab or an automatic worker may have advanced these editions.
  await loadCandidates()
}

function refreshCandidatesOnFocus() {
  if (mounted.value && !busy.value && !jobAction.value && !candidatesLoading.value) void loadCandidates()
}

async function refresh() { await Promise.all([loadRuntime(), loadJobs(), loadCandidates()]) }

async function continueVersion(version: VersionCandidate) {
  if (!mounted.value || busy.value || jobAction.value) return
  const latest = versions.value.find(item => item.key === version.key)
  if (!latest || latest.state === 'submitted' || latest.state === 'published') return
  if (['retry_upload', 'reconcile'].includes(latest.action) && latest.jobId) {
    const job = jobs.value.find(item => item.id === latest.jobId)
    if (job) { await retryJob(job); await loadCandidates(); return }
  }
  jobAction.value = `version:${latest.key}`
  actionError.value = ''
  try {
    if (latest.action === 'retry_export' && latest.exportJobId) await request(`/api/v1/history-scripts/huasheng/exports/${latest.exportJobId}/resume`, 'POST', {})
    else if (latest.videoId && ['retry_packaging', 'retry_upload', 'reconcile'].includes(latest.action)) await request(`/versions/${latest.videoId}/continue`, 'POST', { sourceId: latest.scriptId, expectedScriptSha256: latest.scriptSha256 })
    else return
    if (mounted.value) submitMessage.value = '已继续原任务'
  } catch (error: any) { if (mounted.value) actionError.value = error.message || '继续任务结果待核对，请刷新状态' }
  finally { jobAction.value = ''; if (mounted.value) await Promise.all([loadCandidates(), loadJobs()]) }
}

async function openLogin(platform: Platform, job?: UploadJob) {
  if (!mounted.value || busy.value || jobAction.value || runtimeLoading.value || !runtime.value?.installed || !['baijiahao', 'tencent'].includes(platform)) return
  // A task's concrete login failure can be newer than the cached runtime check.
  const current = job && jobs.value.find(item => item.id === job.id)
  const recovering = current && jobPlatform(current) === platform && needsJobLogin(current)
  if (job && !recovering) return
  if (!recovering && !backgroundExecution.value && (runtime.value.platforms[platform]?.ready !== false || needsConnectionRetry(runtime.value.platforms[platform]))) return
  loginPlatform.value = platform
  loginError.value = ''
  syncMessage.value = ''
  syncError.value = ''
  try {
    const data = await request('/runtime/login', 'POST', { platform })
    if (data.opened !== true) throw new Error('登录窗口打开结果未确认，请刷新状态')
  } catch (error: any) {
    if (mounted.value) loginError.value = error.message || '无法打开平台登录窗口'
  } finally {
    if (mounted.value) { await refresh(); loginPlatform.value = '' }
  }
}

async function syncLogin(platform: Platform) {
  if (!mounted.value || !backgroundExecution.value || !runtime.value?.installed || !['baijiahao', 'tencent'].includes(platform) || busy.value || jobAction.value || runtimeLoading.value) return
  if (syncWaitMessage.value) { syncError.value = syncWaitMessage.value; syncMessage.value = ''; return }
  syncPlatform.value = platform
  syncError.value = ''
  syncMessage.value = ''
  try {
    const data = await request('/runtime/sync', 'POST', { platform })
    if (data.synced !== true || data.platform !== platform) throw new Error('登录同步结果未确认，请刷新状态后重试同步')
    if (mounted.value) syncMessage.value = data.message || '登录已同步到后台'
  } catch (error: any) {
    if (mounted.value) syncError.value = error.message || '登录同步失败，请确认专用窗口已完成扫码后重试'
  } finally {
    syncPlatform.value = ''
    if (mounted.value) await loadRuntime()
  }
}

function invalidatePreflight() {
  preflightSequence++
  preflightController?.abort()
  preflighting.value = false
  report.value = null
  preflightError.value = ''
  submitMessage.value = ''
}

async function checkPreflight(mode: UploadMode = 'publish'): Promise<Preflight | null> {
  if (preflighting.value || !selectedVersions.value.length || !selectedTargets.value.length) return null
  const current = generation
  const sequence = ++preflightSequence
  preflightController?.abort()
  const controller = new AbortController()
  preflightController = controller
  const selection = { sourceIds: [...new Set(selectedVersions.value.map(version => version.scriptId))], videoIds: [...selectedVideoIds.value], targets: [...selectedTargets.value] }
  preflighting.value = true
  preflightError.value = ''
  submitMessage.value = ''
  try {
    const query = new URLSearchParams({ sourceIds: selection.sourceIds.join(','), videoIds: selection.videoIds.join(','), targets: selection.targets.join(','), mode, refreshRuntime: 'true' })
    const data: Preflight = await request(`/preflight?${query}`, 'GET', undefined, controller.signal)
    if (!mounted.value || current !== generation || sequence !== preflightSequence) return null
    if (!Array.isArray(data.items)) throw new Error('预检响应不完整，请重试预检')
    const items: Check[] = []
    const identities = new Set<string>()
    for (const check of data.items as any[]) {
      const scriptId = Number(check.scriptId ?? check.sourceId)
      if (!selection.sourceIds.includes(scriptId) || check.target !== 'baijiahao-video') throw new Error('预检返回了未选择的项目')
      if (!selection.videoIds.includes(check.videoId) || !selectedVersions.value.some(version => version.scriptId === scriptId && version.videoId === check.videoId)) throw new Error('预检返回了未选择的视频版本')
      const identity = `${scriptId}:${check.target}:${check.videoId ?? 'legacy'}`
      if (identities.has(identity) || check.videoId != null && (!Number.isSafeInteger(check.videoId) || check.videoId < 1)) throw new Error('成片预检结果重复或编号无效')
      identities.add(identity)
      const missing = check.missing ?? check.blockers?.map((issue: any) => issue.message || issue.field)
      if (typeof check.ready !== 'boolean' || !Array.isArray(missing) || missing.some(reason => typeof reason !== 'string') || check.ready && missing.length) throw new Error('成片预检结果不完整，请重试')
      items.push({...check,scriptId,title:check.title ?? check.sourceTitle,missing})
    }
    if (selection.videoIds.some(id => !items.some(item => item.videoId === id))) throw new Error('成片预检结果缺少所选视频版本')
    report.value = { ...data, items }
    if (data.runtime) runtime.value = data.runtime
    return report.value
  } catch (error: any) {
    if (mounted.value && current === generation && sequence === preflightSequence && error.name !== 'AbortError') { report.value = null; preflightError.value = error.message || '素材预检失败，请重试' }
    return null
  } finally { if (mounted.value && current === generation && sequence === preflightSequence) preflighting.value = false }
}

async function submit(mode: UploadMode) {
  if (!canSubmit.value) return
  submittingMode.value = mode
  actionError.value = ''
  submitMessage.value = ''
  const current = generation
  try {
    const checked = await checkPreflight(mode)
    if (current !== generation || !mounted.value) return
    if (!checked) { submitMessage.value = `此次未上传：${preflightError.value || '预检已取消，请重新检查。'}`; return }
    const remaining = checked.items.filter(item => !isUploaded(item.uploaded))
    if (!remaining.length) { submitMessage.value = '所选版本均已提交，无需重复提交。'; void loadCandidates(); return }
    if (!remaining.some(item => item.ready)) {
      submitMessage.value = `此次未上传：${remaining.map(item => `稿件 #${item.scriptId} ${targetLabel(item.target)}：${item.missing.join('、') || '预检未通过，请检查平台登录状态和素材'}`).join('；')}`
      return
    }
    if (!runtime.value?.installed) { submitMessage.value = `此次未上传：${runtime.value?.message || '运行环境未确认，请刷新状态'}`; return }
    // The API accepts a Cartesian product. Group projects by their remaining
    // targets so a partially uploaded batch never resubmits a completed pair.
    const groups = new Map<string, { scriptIds: number[]; videoIds: number[]; targets: SocialTarget[] }>()
    for (const scriptId of projectIds.value) {
      const targets = selectedTargets.value.filter(target => remaining.some(item => item.scriptId === scriptId && item.target === target))
      if (!targets.length) continue
      const key = targets.join(',')
      const group = groups.get(key) || { scriptIds: [], videoIds: [], targets }
      group.scriptIds.push(scriptId)
      group.videoIds.push(...remaining.filter(item => item.scriptId === scriptId && item.videoId != null).map(item => item.videoId!))
      groups.set(key, group)
    }
    let acceptedCount = 0
    for (const group of groups.values()) {
      if (!mounted.value || current !== generation) return
      const pending: PendingRequest = { ...group, requestId: crypto.randomUUID(), mode }
      pendingRequests.value = [...pendingRequests.value, pending]
      if (!persist()) { pendingRequests.value = pendingRequests.value.filter(item => item.requestId !== pending.requestId); return }
      try {
        const data: QueueResponse = await request('/jobs', 'POST', { sourceIds: pending.scriptIds, videoIds: pending.videoIds, targets: pending.targets, mode: pending.mode, requestId: pending.requestId })
        const accepted = normalizeJobs(data.jobs)
        const alreadyUploaded = !accepted.length && allUploaded(data.items, pending)
        if (data.requestId !== pending.requestId && !accepted.some(job => job.requestId === pending.requestId) && !alreadyUploaded) throw new Error('提交结果未确认')
        if (!mounted.value) return
        updateQueueState(data.queue)
        mergeJobs(accepted)
        void loadCandidates()
        pendingRequests.value = pendingRequests.value.filter(item => item.requestId !== pending.requestId)
        acceptedCount += accepted.length
        if (alreadyUploaded && current === generation) { submitMessage.value = acceptedCount ? '已提交所选版本，已有提交记录的版本已跳过。' : '所选版本均已提交，无需重复提交。'; void loadCandidates() }
        persist()
      } catch (error: any) {
        if (mounted.value && current === generation) actionError.value = error.message || '正在读取提交结果，请刷新发表队列'
        if (mounted.value && current === generation) { submittingMode.value = ''; await loadJobs() }
        return
      }
    }
    if (acceptedCount && submitMessage.value && current === generation) submitMessage.value = '已提交待上传项，已上传项已跳过。'
  } catch (error: any) {
    if (mounted.value && current === generation) actionError.value = error.message || '提交失败，请刷新发表队列'
  } finally {
    if (mounted.value && current === generation) { submittingMode.value = ''; schedulePoll() }
  }
}

async function retryJobs(selected: UploadJob[], batch: boolean) {
  if (!mounted.value || jobAction.value) return
  const ids = [...new Set(selected.map(job => job.id))].filter(id => {
    const latest = jobs.value.find(job => job.id === id)
    return latest && canRetry(latest) && !hasPendingRetry(latest)
  })
  if (!ids.length) return
  const publicationRetry = selected.some(job => ids.includes(job.id) && job.mode === 'publish')
  const current = generation
  const operation = batch ? 'retry:batch' : `retry:${ids[0]}`
  jobAction.value = operation
  actionError.value = ''
  retryMessage.value = ''
  retrySkipped.value = []
  pendingActions.value = { ...pendingActions.value, ...Object.fromEntries(ids.map(id => [id, 'retry' as const])) }
  // The server deduplicates retries by job state. Storage errors must not strand an existing task.
  persist()
  let needsRead = false
  let requestFailed = false
  try {
    const data = await request(batch ? '/jobs/reupload' : `/jobs/${encodeURIComponent(ids[0]!)}/reupload`, 'POST', batch ? { jobIds: ids } : {})
    const received = normalizeJobs(batch ? data.jobs : [data.job])
    const skipped = batch ? data.skipped : []
    if (!Array.isArray(skipped) || skipped.some(item => !item || typeof item.id !== 'string' || typeof item.message !== 'string')) throw new Error('重试结果未确认，请刷新队列')
    const acknowledged = [...received.map(job => job.id), ...skipped.map(item => item.id)]
    if (acknowledged.length !== ids.length || new Set(acknowledged).size !== ids.length || acknowledged.some(id => !ids.includes(id))) throw new Error('重试结果未确认，请刷新队列')
    if (!mounted.value) return
    updateQueueState(data.queue)
    for (const id of ids) if (pendingActions.value[id] === 'retry') delete pendingActions.value[id]
    mergeJobs(received)
    if (current === generation) {
      retryMessage.value = `已接受 ${received.length} 项${publicationRetry ? '原任务重试' : '重新上传'} · 跳过 ${skipped.length} 项`
      retrySkipped.value = skipped
      needsRead = skipped.length > 0
    }
  } catch (error: any) {
    if (mounted.value && current === generation) {
      actionError.value = error.message || '重试请求未确认，请刷新队列'
      retryMessage.value = '正在读取重新上传结果，请刷新状态，勿重复提交。'
      needsRead = true
      requestFailed = true
    }
  } finally {
    if (mounted.value && current === generation) {
      if (jobAction.value === operation) jobAction.value = ''
      schedulePoll()
    }
  }
  // Release the write lock before the bounded recovery GET, including when that read also fails.
  if (needsRead) {
    await loadJobs()
    if (requestFailed && mounted.value && current === generation && !queueError.value) {
      if (ids.every(id => {
        const job = jobs.value.find(job => job.id === id)
        return job && ['queued', 'running', 'saved', 'awaiting_confirmation'].includes(job.status)
      })) {
        actionError.value = ''
        retryMessage.value = '已更新发表队列，请查看下方进度。'
      } else if (ids.every(id => !pendingActions.value[id])) {
        retryMessage.value = '重新上传请求未成功，请处理提示后再次点击“重新上传”。'
      }
    }
  }
}
async function retryJob(job: UploadJob) { await retryJobs([job], false) }
async function retryFailedJobs() { await retryJobs(retryableJobs.value, true) }

async function runJobAction(job: UploadJob, action: 'confirm' | 'cancel') {
  if (!['confirm', 'cancel'].includes(action) || jobAction.value || pendingActions.value[job.id] || storageError.value || action === 'confirm' && (job.status !== 'awaiting_confirmation' || !job.result) || action === 'cancel' && !canCancel(job)) return
  const current = generation
  jobAction.value = `${action}:${job.id}`
  actionError.value = ''
  pendingActions.value = { ...pendingActions.value, [job.id]: action }
  if (!persist()) { delete pendingActions.value[job.id]; jobAction.value = ''; return }
  try {
    const data = await request(`/jobs/${encodeURIComponent(job.id)}/${action}`, 'POST', {})
    const received = normalizeJobs([data.job ?? data])
    if (!received.length || received[0].id !== job.id) throw new Error('任务操作结果未确认')
    if (!mounted.value) return
    updateQueueState(data.queue)
    mergeJobs(received)
  } catch (error: any) {
    if (mounted.value && current === generation) actionError.value = error.message || '正在读取操作结果，请刷新发表队列'
    if (mounted.value && current === generation) await loadJobs()
  } finally {
    if (mounted.value && current === generation) { jobAction.value = ''; schedulePoll() }
  }
}
async function confirmJob(job: UploadJob) { await runJobAction(job, 'confirm') }
async function cancelJob(job: UploadJob) { await runJobAction(job, 'cancel') }
async function openJob(job: UploadJob) {
  if (!job.result || hasBackgroundResult(job) || jobAction.value) return
  const current = generation
  jobAction.value = `open:${job.id}`
  actionError.value = ''
  try { await request(`/jobs/${encodeURIComponent(job.id)}/open`, 'POST', {}) }
  catch (error: any) { if (mounted.value && current === generation) actionError.value = error.message || '无法打开绑定编辑器' }
  finally { if (mounted.value && current === generation) jobAction.value = '' }
}

watch([versions, busy, candidatesLoading], () => {
  if (!globalMode.value || busy.value || candidatesLoading.value) return
  const keys = new Set(versions.value.filter(version => version.canPublish).map(version => version.key))
  const selected = selectedVersionKeys.value.filter(key => keys.has(key))
  if (selected.length !== selectedVersionKeys.value.length) { selectedVersionKeys.value = selected; persist() }
})
watch(() => [props.focusScriptId, props.focusVideoId], () => { focusCleared.value = false })
watch([scopeKey, () => props.scriptRevision], (next, previous) => {
  if (String(next[0]).includes('|focus:') || String(previous[0]).includes('|focus:')) {
    selectedVersionKeys.value = []
    candidateFilter.value = 'all'
    candidateSearch.value = ''
    queueFilter.value = 'all'
    focusedJobId.value = ''
  }
  generation++
  queueSequence++
  queueController?.abort()
  candidateController?.abort()
  candidateSequence++
  invalidatePreflight()
  submittingMode.value = ''
  jobAction.value = ''
  actionError.value = ''
  retryMessage.value = ''
  retrySkipped.value = []
  if (mounted.value) void refresh()
})
onMounted(() => {
  mounted.value = true
  restore()
  window.addEventListener(storageEvent, syncStoredState)
  window.addEventListener('storage', syncStoredState)
  window.addEventListener('focus', refreshCandidatesOnFocus)
  void refresh()
})
onBeforeUnmount(() => {
  persist()
  window.removeEventListener(storageEvent, syncStoredState)
  window.removeEventListener('storage', syncStoredState)
  window.removeEventListener('focus', refreshCandidatesOnFocus)
  mounted.value = false
  generation++
  queueController?.abort()
  runtimeController?.abort()
  preflightController?.abort()
  candidateController?.abort()
  for (const controller of requestControllers) controller.abort()
  clearTimeout(poll)
})
</script>

<style scoped>
.social-upload { min-width: 0; padding: 24px; color: var(--text-1, #27272a); font: 13px/1.6 var(--font-body, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif); }
.social-upload, .social-upload * { box-sizing: border-box; letter-spacing: 0; }
.upload-heading, .upload-heading > div, .queue-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.upload-heading { margin-bottom: 16px; }
.publication-focus { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--border, #e4e4e7); font-size: 12px; }
.publication-focus > span { min-width: 0; overflow-wrap: anywhere; }
.upload-heading > div { justify-content: flex-start; min-width: 0; }
h2, h3, p { margin: 0; }
h2 { font-size: 18px; line-height: 1.4; font-weight: 600; }
h3 { font-size: 14px; font-weight: 600; }
.upload-heading span, .queue-heading > span, .muted, .job-identity > span, .job-identity small { color: var(--text-2, #71717a); font-size: 12px; }
.upload-control { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; min-height: 42px; padding: 8px 12px; border: 1px solid var(--border-strong, #d4d4d8); border-radius: 6px; background: var(--bg-0, #fff); color: var(--text-1, #27272a); font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1.5; text-decoration: none; cursor: pointer; touch-action: manipulation; }
.upload-control:hover { background: var(--bg-2, #f4f4f5); border-color: #a1a1aa; }
.upload-control.primary { border-color: #18181b; background: #18181b; color: #fff; }
.upload-control.primary:hover { background: #3f3f46; }
.upload-control:disabled { cursor: not-allowed; opacity: .45; }
.upload-control:focus-visible, .target-choice input:focus-visible, .candidate-choice input:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.upload-control svg, .runtime-state svg, .check-state svg, .pending-request > svg, .job-status svg { flex-shrink: 0; }
.icon-control { width: 42px; flex-shrink: 0; padding: 8px; }
.text-control { border-color: transparent; }
.runtime-state { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 0 0 16px; font-size: 12px; }
.runtime-state > span, .runtime-platform, .runtime-error > span, .check-state, .job-status { display: inline-flex; align-items: center; gap: 6px; }
.runtime-platform { min-width: 0; flex-wrap: wrap; }
.runtime-help { flex-basis: 100%; color: var(--text-2, #71717a); font-size: 12px; overflow-wrap: anywhere; }
.runtime-error { min-width: 0; }
.runtime-platform > .technical-details { flex-basis: 100%; }
.runtime-platform > span { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.ready { color: #15803d; }
.warning { color: #92400e; }
.error, .operation-error { color: #b91c1c; }
.active { color: #1d4ed8; }
.operation-error, .pending-request { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 12px 0; overflow-wrap: anywhere; }
.pending-request { color: #92400e; }
.target-scroll { min-width: 0; }
.candidate-section { min-width: 0; margin: 0 0 24px; padding: 12px 0 0; border: 0; border-top: 1px solid var(--border, #e4e4e7); }
.candidate-section legend { padding: 0 12px 0 0; font-weight: 500; }
.candidate-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 8px; }
.candidate-search { min-width: 0; max-width: 100%; min-height: 42px; padding: 8px 12px; border: 1px solid var(--border-strong, #d4d4d8); border-radius: 6px; font: inherit; }
.candidate-search:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.candidate-list { max-height: 480px; overflow-y: auto; margin-top: 12px; }
.version-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto; align-items: start; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, #e4e4e7); }
.version-row .candidate-choice { padding: 0; align-items: flex-start; cursor: default; }
.version-row .candidate-choice input { margin-top: 4px; }
.version-progress { min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.version-progress p { margin-top: 4px; color: var(--text-2, #71717a); }
.version-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; max-width: 180px; }
.candidate-choice { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 8px 0; cursor: pointer; overflow-wrap: anywhere; }
.candidate-choice input { width: 16px; height: 16px; margin: 0; flex-shrink: 0; accent-color: #18181b; }
.candidate-choice span { min-width: 0; }
.candidate-choice small { display: block; color: var(--text-2, #71717a); font-size: 11px; }
.target-table { width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
.target-table th, .target-table td { vertical-align: top; border-bottom: 1px solid var(--border, #e4e4e7); padding: 14px 16px; overflow-wrap: anywhere; }
.target-table thead th { padding-block: 8px; border-top: 1px solid var(--border, #e4e4e7); background: var(--bg-1, #fafafa); }
.target-table thead th:first-child { width: 28%; }
.project-heading { padding-top: 18px !important; font-weight: 500; color: var(--text-2, #71717a); }
.target-choice { display: flex; align-items: center; gap: 8px; min-height: 42px; cursor: pointer; }
.target-choice input { width: 16px; height: 16px; margin: 0; accent-color: #18181b; flex-shrink: 0; }
.target-choice span { font-weight: 500; }
.target-choice small { display: block; font-size: 11px; font-weight: 400; color: var(--text-2, #71717a); }
.project-title { font-size: 13px; font-weight: 500; }
.project-title > span { display: block; }
.project-title small { display: block; margin-top: 5px; color: var(--text-2, #71717a); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; }
.check-state { min-height: 22px; font-size: 12px; }
.missing-list, .preflight-warnings { margin: 8px 0 0; padding: 0 0 0 16px; color: #92400e; font-size: 12px; }
.missing-list li + li, .preflight-warnings li + li { margin-top: 4px; }
.submit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 16px; }
.submit-feedback { margin-top: 8px; color: var(--text-2, #71717a); font-size: 12px; overflow-wrap: anywhere; }
.preflight-count { margin-left: auto; font-size: 12px; color: var(--text-2, #71717a); font-variant-numeric: tabular-nums; }
.upload-queue { margin-top: 32px; }
.queue-heading { margin-bottom: 12px; }
.queue-toolbar, .queue-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.queue-toolbar { justify-content: space-between; margin-bottom: 12px; }
.queue-filters [aria-pressed="true"] { background: var(--bg-2, #f4f4f5); border-color: #71717a; }
.retry-result { margin-bottom: 12px; font-size: 12px; overflow-wrap: anywhere; }
.retry-result ul { margin: 6px 0 0; padding-left: 20px; color: #92400e; }
.queue-activity { margin-bottom: 12px; color: var(--text-2, #71717a); font-size: 12px; overflow-wrap: anywhere; }
.queue-pause { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 0 0 12px; overflow-wrap: anywhere; }
.queue-pause > svg { flex-shrink: 0; }
.queue-list { margin: 0; padding: 0; list-style: none; }
.queue-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 16px; align-items: start; padding: 16px 0; border-top: 1px solid var(--border, #e4e4e7); }
.queue-row[data-focused="true"] { outline: 2px solid #2563eb; outline-offset: -2px; }
.job-identity { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.job-identity strong { font-weight: 500; }
.job-time { font-variant-numeric: tabular-nums; }
.job-progress { min-width: 0; overflow-wrap: anywhere; }
.job-progress p { margin-top: 6px; font-size: 12px; }
.technical-details { min-width: 0; max-width: 100%; color: var(--text-2, #71717a); font-size: 12px; }
.operation-error > .technical-details { flex-basis: 100%; }
.technical-details summary { display: list-item; width: fit-content; min-height: 42px; padding: 10px 0; cursor: pointer; }
.technical-details summary:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.more-actions { width: 100%; font-size: 12px; }
.more-actions summary { width: fit-content; min-height: 42px; padding: 10px 0; cursor: pointer; }
.more-actions summary:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.more-actions > div { display: flex; flex-wrap: wrap; gap: 6px; }
.technical-details pre { max-height: 240px; margin: 0 0 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
.job-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 290px; }
.empty-state { padding: 24px 0; color: var(--text-2, #71717a); font-size: 13px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spinning { animation: social-upload-spin 1s linear infinite; }
@keyframes social-upload-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) {
  .social-upload { padding: 16px; }
  .version-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .version-progress, .version-actions { padding-left: 26px; }
  .version-actions { justify-content: flex-start; max-width: none; }
  .candidate-list { grid-template-columns: minmax(0, 1fr); }
  .target-table, .target-table tbody, .target-table tr { display: block; }
  .target-table thead { display: block; }
  .target-table thead tr { display: grid; grid-template-columns: minmax(0, 1fr); }
  .target-table thead th { width: auto; padding: 8px 6px; font-size: 12px; }
  .target-table thead th:first-child { display: none; }
  .target-choice { align-items: flex-start; gap: 5px; }
  .target-choice input { margin-top: 3px; }
  .target-choice small { font-size: 10px; }
  .target-table tbody tr { padding-block: 16px; border-bottom: 1px solid var(--border, #e4e4e7); }
  .target-table tbody th, .target-table tbody td { display: block; width: 100%; padding: 6px 0; border: 0; }
  .target-table tbody th { padding-top: 0; margin-bottom: 8px; }
  .target-table tbody td::before { content: attr(data-label); display: inline-block; width: 100px; max-width: 45%; margin-right: 8px; font-size: 12px; color: var(--text-2, #71717a); }
  .missing-list, .preflight-warnings { padding-left: 16px; margin-left: 108px; }
  .submit-actions { align-items: stretch; }
  .submit-actions > .primary, .submit-actions > .upload-control:nth-child(2) { flex: 1 1 150px; }
  .preflight-count { width: 100%; margin-left: 0; }
  .queue-row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .job-actions { justify-content: flex-start; max-width: 100%; }
  .queue-heading { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
