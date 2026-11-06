<template>
  <div class="history-page" :class="{ 'is-production': workspaceView === 'production' }">
    <header class="page-head" :inert="monitorOpen || deleting">
      <div class="page-identity">
        <h1 class="page-title">历史脚本</h1>
        <span class="library-count">{{ total }} 条稿件</span>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-sm" type="button" aria-label="花生账号" title="花生账号" :aria-expanded="huashengAccountsOpen" @click="huashengAccountsOpen = true"><Users :size="15" />花生账号</button>
        <button v-if="workspaceView === 'production'" class="btn btn-sm monitor-trigger production-monitor" type="button" aria-label="采集监控" :title="`${jobTitle}：${jobSubtitle}`" :aria-expanded="monitorOpen" aria-controls="collection-monitor" @click="jobFailure ? openJobFailure() : openMonitor()">
          <Activity :size="15" /><span>采集监控</span><span v-if="monitorNeedsAttention" class="attention-dot" aria-hidden="true"></span><small v-if="monitorNeedsAttention || activeJob" :class="{ warning: monitorNeedsAttention }" role="status">{{ monitorNeedsAttention ? '需处理' : '运行中' }}</small>
        </button>
        <button v-else class="btn btn-ghost btn-sm" type="button" title="采集设置" :disabled="jobStarting" @click="openJobDialog"><Settings2 :size="15" />采集设置</button>
        <button class="btn btn-ghost btn-icon" type="button" title="刷新脚本库" aria-label="刷新脚本库" :disabled="loadingList || saving" @click="refresh">
          <RefreshCw :size="16" :class="{ spin: loadingList }" />
        </button>
        <button v-if="showStopJob" class="btn btn-primary" type="button" :disabled="!canStopJob || jobStopping" @click="stopJob"><Square :size="16" />{{ jobStopping || job?.status === 'stopping' ? '正在停止采集' : '停止采集' }}</button>
        <button v-show="!showStopJob" class="btn btn-primary" type="button" :disabled="!canStartJob" @click="openJobDialog"><Plus :size="16" />启动采集</button>
      </div>
    </header>

    <nav class="workspace-tabs" role="tablist" aria-label="历史脚本工作区" :inert="monitorOpen || deleting" @keydown="navigateWorkspaceTabs">
      <button v-for="view in workspaceViews" :id="`workspace-tab-${view.id}`" :key="view.id" type="button" role="tab" :aria-selected="workspaceView === view.id" :tabindex="workspaceView === view.id ? 0 : -1" :aria-controls="`workspace-${view.id}`" @click="setWorkspaceView(view.id)">
        <component :is="view.icon" :size="16" /><span>{{ view.label }}</span>
        <span v-if="view.id === 'library'" class="tab-count">{{ total }}</span>
        <span v-if="view.id === 'production' && productionSummary.attention" class="tab-count attention-count">{{ productionSummary.attention }} 待处理</span>
        <span v-if="view.id === 'collection' && activeJob" class="running-dot" aria-label="采集运行中"></span>
      </button>
    </nav>

    <section v-show="workspaceView !== 'production'" class="job-control" role="region" aria-label="历史素材采集任务" :inert="monitorOpen || deleting">
      <div class="job-main">
        <span class="job-icon" :class="{ active: activeJob }" aria-hidden="true"><Radar :size="16" /></span>
        <div class="job-copy">
          <strong :title="job ? `全局采集任务 #${job.id}` : undefined"><span>{{ jobTitle }}</span><small v-if="job" class="job-scope"> · 全局采集 #{{ job.id }}</small></strong>
          <button v-if="jobFailure" class="job-failure-trigger" type="button" aria-label="查看任务失败详情" :title="jobSubtitle" aria-controls="collection-monitor" @click="openJobFailure">
            <span>{{ jobSubtitle }}</span><ChevronRight :size="14" aria-hidden="true" />
          </button>
          <span v-else :title="jobSubtitle">{{ jobSubtitle }}</span>
        </div>
      </div>
      <div v-if="job" class="job-progress" aria-label="任务进度">
        <span>扫 {{ job.counts?.scanned ?? 0 }}</span>
        <span>选 {{ job.counts?.selected ?? 0 }}</span>
        <span v-if="job.targetCount === null">已入库 {{ job.counts?.completed ?? 0 }} · 持续采集</span>
        <span v-else>稿 {{ job.counts?.completed ?? 0 }}/{{ job.targetCount }}</span>
        <span v-if="job.counts?.failed">失败 {{ job.counts.failed }}</span>
      </div>
      <div class="job-actions">
        <button v-if="isRetryableJob(job)" class="btn btn-sm retry-collection" type="button" :aria-label="retryJobLabel(job)" :title="retryJobTitle(job)" :disabled="!canRetryJob(job)" @click="retryJob(job)">
          <RefreshCw :size="14" :class="{ spin: jobStarting }" /><span>{{ retryJobLabel(job) }}</span>
        </button>
        <button v-if="jobError" class="btn btn-sm" type="button" :disabled="jobLoading" @click="loadJobStatus">
          <RefreshCw :size="14" :class="{ spin: jobLoading }" /> 重试状态
        </button>
        <button v-if="showStopJob" class="btn btn-sm" type="button" :disabled="!canStopJob || jobStopping" @click="stopJob">
          <Square :size="14" /> {{ jobStopping || job?.status === 'stopping' ? '停止中' : '停止' }}
        </button>
        <button class="btn btn-sm monitor-trigger" type="button" aria-label="采集监控" :aria-expanded="monitorOpen" aria-controls="collection-monitor" @click="openMonitor">
          <Activity :size="15" /> 采集监控 <span v-if="monitorNeedsAttention" class="attention-dot" aria-hidden="true"></span>
        </button>
      </div>
    </section>

    <section v-show="workspaceView === 'production'" id="workspace-production" class="production-workspace" role="tabpanel" aria-labelledby="workspace-tab-production" :inert="monitorOpen || deleting">
      <div v-show="productionChannel === 'motion'" class="production-channels" role="group" aria-label="视频创作渠道">
        <button type="button" :aria-pressed="productionChannel === 'huasheng'" @click="setProductionChannel('huasheng')"><Clapperboard :size="15" />花生制作</button>
        <button type="button" :aria-pressed="productionChannel === 'motion'" @click="setProductionChannel('motion')"><Film :size="15" />精细化制作<span v-if="motionSummary.attention" class="channel-attention">{{ motionSummary.attention }} 待处理</span></button>
      </div>
      <HistoryHuasheng v-show="productionChannel === 'huasheng'" :accounts-revision="huashengAccountsRevision" :blocked-source-id="dirty || saving || loadingDetail || processingDetail || conflictDetail || detail?.artifactState?.rewritten !== 'current' ? detail?.id : undefined" @overview="productionSummary = $event" @open-script="openProductionScript" @manage-accounts="huashengAccountsOpen = true">
        <template #workspace-switcher>
          <div class="production-channels inline-channels" role="group" aria-label="视频创作渠道">
            <button type="button" :aria-pressed="productionChannel === 'huasheng'" @click="setProductionChannel('huasheng')"><Clapperboard :size="15" />花生制作</button>
            <button type="button" :aria-pressed="productionChannel === 'motion'" @click="setProductionChannel('motion')"><Film :size="15" />精细化制作<span v-if="motionSummary.attention" class="channel-attention">{{ motionSummary.attention }} 待处理</span></button>
          </div>
        </template>
      </HistoryHuasheng>
      <HistoryMotion v-if="motionWorkspaceVisited" v-show="productionChannel === 'motion'" :active="workspaceView === 'production' && productionChannel === 'motion'" :blocked-source-id="dirty || saving || loadingDetail || processingDetail || conflictDetail || detail?.artifactState?.rewritten !== 'current' ? detail?.id : undefined" @overview="motionSummary = $event" @open-script="openProductionScript" @open-library="setWorkspaceView('library')" @delivery-change="onMotionDeliveryChange" />
    </section>

    <section v-show="workspaceView === 'uploads'" id="workspace-uploads" class="upload-workspace" role="tabpanel" aria-labelledby="workspace-tab-uploads" :inert="monitorOpen || deleting">
      <HistorySocialUpload v-if="uploadWorkspaceVisited" :focus-script-id="route.query.script" :focus-video-id="route.query.videoId" @clear-focus="clearUploadFocus" />
    </section>

    <section v-show="workspaceView === 'collection'" id="workspace-collection" class="collection-workspace" role="tabpanel" aria-labelledby="workspace-tab-collection" :inert="monitorOpen || deleting">
      <header class="collection-heading">
        <div><h2>采集任务</h2><span class="muted">{{ jobsTotal ?? recentJobs.length }} 个任务</span></div>
        <div class="head-actions">
          <button class="btn btn-sm" type="button" @click="monitorTab = 'connection'; openMonitor()"><Radar :size="15" />连接检测</button>
          <button class="btn btn-ghost btn-icon" type="button" title="刷新采集任务" aria-label="刷新采集任务" :disabled="jobLoading" @click="loadJobStatus"><RefreshCw :size="16" :class="{ spin: jobLoading }" /></button>
        </div>
      </header>
      <div v-if="jobError" class="collection-error" role="alert">{{ jobError }}<button class="btn btn-sm" type="button" @click="loadJobStatus">重试</button></div>
      <div v-if="historyError" class="collection-error" role="alert">{{ historyError }}<button class="btn btn-sm" type="button" @click="loadOlderJobs">重试</button></div>
      <div v-if="!recentJobs.length" class="collection-empty"><Inbox :size="32" /><h3>暂无采集任务</h3><button class="btn" type="button" :disabled="!canStartJob" @click="openJobDialog"><Plus :size="15" />新建采集任务</button></div>
      <div v-else class="collection-table" role="table" aria-label="采集任务列表">
        <div class="collection-table-head" role="row"><span role="columnheader">任务 / 来源</span><span role="columnheader">状态</span><span role="columnheader">入库 / 目标</span><span role="columnheader">最近进展</span><span role="columnheader">操作</span></div>
        <div v-for="record in recentJobs" :key="record.id" class="collection-row" role="row">
          <div class="collection-task" role="cell"><button type="button" class="text-command" @click="viewCollectionJob(record.id)">任务 #{{ record.id }}</button><span class="muted">{{ collectionSourceLabel(record) }} · {{ formatDate(record.startedAt || record.updatedAt) }}</span></div>
          <div role="cell"><span class="collection-status" :class="record.status">{{ jobStatusLabel(record.status) }}</span><small v-if="!terminalJobStatuses.includes(record.status)">{{ stageLabel(record.stage) }}</small></div>
          <div class="collection-numbers" role="cell">{{ record.counts?.completed ?? 0 }}<span class="muted"> / {{ record.targetCount ?? '持续' }}</span><small v-if="record.counts?.failed" class="warning">曾失败 {{ record.counts.failed }} 篇</small></div>
          <div class="collection-progress" role="cell"><span :class="{ 'warning': record.status === 'failed' }">{{ describeJobFailure(record)?.summary || record.progressMessage || record.currentTitle || '暂无进展记录' }}</span><small class="muted">扫描 {{ record.counts?.scanned ?? 0 }} · 入选 {{ record.counts?.selected ?? 0 }}</small></div>
          <div class="collection-row-actions" role="cell">
            <button v-if="showStopJob && String(record.id) === String(job.id)" class="btn btn-ghost btn-icon" type="button" :aria-label="`停止采集任务 ${record.id}`" :title="jobStopping || job.status === 'stopping' ? '正在停止采集' : '停止采集'" :disabled="!canStopJob || jobStopping" @click="stopJob"><Square :size="16" /></button>
            <button v-if="isRetryableJob(record)" class="btn btn-ghost btn-icon" type="button" :aria-label="`${retryJobLabel(record)}任务 ${record.id}`" :title="retryJobTitle(record)" :disabled="!canRetryJob(record)" @click="retryJob(record)"><RefreshCw :size="16" /></button>
            <button class="btn btn-ghost btn-icon" type="button" :aria-label="`查看任务 ${record.id} 日志`" title="查看任务日志" @click="viewCollectionJob(record.id)"><List :size="16" /></button>
          </div>
        </div>
      </div>
      <button v-if="jobsHasMore" class="btn collection-more" type="button" :disabled="historyLoading" @click="loadOlderJobs">{{ historyLoading ? '正在读取…' : '加载更早任务' }}<ChevronDown :size="15" /></button>
    </section>

    <div v-if="monitorOpen" class="monitor-backdrop" role="presentation" @click.self="closeMonitor">
      <section id="collection-monitor" ref="monitorRef" class="monitor-drawer" role="dialog" aria-modal="true" aria-labelledby="collection-monitor-title" @keydown.esc.prevent.stop="closeMonitor" @keydown.tab="trapMonitorFocus">
        <header class="monitor-head">
          <div><h2 id="collection-monitor-title">采集监控</h2><p>{{ job ? `当前任务 #${job.id} · ${jobStatusLabel(job.status)}` : '暂无采集任务' }}</p></div>
          <div class="monitor-head-actions">
            <button class="btn btn-ghost btn-icon" type="button" title="刷新采集状态" aria-label="刷新采集状态" :disabled="jobLoading || browserSessionLoading || logsLoading" @click="refreshMonitoring"><RefreshCw :size="16" :class="{ spin: jobLoading || browserSessionLoading || logsLoading }" /></button>
            <button v-if="showStopJob" class="btn btn-sm" type="button" :disabled="!canStopJob || jobStopping" :title="`停止当前采集任务 #${job.id}`" @click="stopJob"><Square :size="14" />{{ jobStopping || job?.status === 'stopping' ? '正在停止当前采集' : '停止当前采集' }}</button>
            <button ref="monitorCloseRef" class="btn btn-ghost btn-icon" type="button" title="关闭采集监控" aria-label="关闭采集监控" @click="closeMonitor"><X :size="18" /></button>
          </div>
        </header>
        <div class="monitor-tabs" role="tablist" aria-label="采集监控内容" @keydown="navigateMonitorTabs">
          <button id="monitor-connection-tab" type="button" role="tab" :aria-selected="monitorTab === 'connection'" :tabindex="monitorTab === 'connection' ? 0 : -1" aria-controls="monitor-connection" @click="monitorTab = 'connection'"><Radar :size="15" /> 连接检测 <span v-if="browserNeedsAttention" class="attention-dot" aria-hidden="true"></span></button>
          <button id="monitor-logs-tab" type="button" role="tab" aria-label="任务日志" :aria-selected="monitorTab === 'logs'" :tabindex="monitorTab === 'logs' ? 0 : -1" aria-controls="monitor-logs" @click="monitorTab = 'logs'"><List :size="15" /> 任务日志 <span class="monitor-count">{{ jobEvents.length }}</span></button>
        </div>
        <div class="monitor-body">
          <p v-if="jobError" class="job-error" role="alert">{{ jobError }}</p>
          <section v-show="monitorTab === 'connection'" id="monitor-connection" role="tabpanel" aria-labelledby="monitor-connection-tab">
            <div v-if="isDouyinJob(job)" class="browser-session" role="region" aria-label="抖音采集登录">
            <div class="browser-verdict" :class="`verdict-${browserVerdict.tone}`" :role="browserVerdict.tone === 'error' ? 'alert' : 'status'" :aria-live="browserVerdict.tone === 'error' ? 'assertive' : 'polite'" aria-atomic="true">
              <CircleCheck v-if="browserVerdict.tone === 'success'" :size="28" aria-hidden="true" />
              <RefreshCw v-else-if="browserVerdict.tone === 'checking'" :size="28" class="spin" aria-hidden="true" />
              <CircleAlert v-else :size="28" aria-hidden="true" />
              <div>
                <h3>{{ browserVerdict.title }}</h3>
                <p><template v-if="browserVerdict.tone === 'error'">原因：</template><span>{{ browserVerdict.reason }}</span></p>
              </div>
            </div>
            <span class="session-checked-at">{{ browserSession?.checkedAt ? `最近检测 ${formatTime(browserSession.checkedAt)}` : '暂无检测记录' }}</span>
            <div class="browser-session-actions">
              <button class="btn btn-primary" type="button" :disabled="!canCheckBrowserLogin" :aria-busy="browserSessionAction === 'check' || browserSession?.status === 'checking'" @click="checkBrowserLogin"><RefreshCw v-if="browserSessionAction === 'check' || browserSession?.status === 'checking'" :size="14" class="spin" /><Search v-else :size="14" /> 检测登录状态</button>
              <button class="btn btn-sm" type="button" :disabled="!canOpenBrowserLogin" :aria-busy="browserSessionAction === 'open'" @click="openBrowserLogin"><RefreshCw v-if="browserSessionAction === 'open'" :size="14" class="spin" /><LogIn v-else :size="14" /> 打开登录窗口</button>
              <button v-if="browserSessionError" class="btn btn-sm" type="button" :disabled="browserSessionLoading || Boolean(browserSessionAction)" @click="loadBrowserSession"><RefreshCw :size="14" :class="{ spin: browserSessionLoading }" /> 重试登录状态</button>
            </div>
            <p class="session-checked-at">首次点击“打开登录窗口”手动登录，再点击“检测登录状态”：系统会关闭专用窗口，复用登录会话在后台检测和采集。登录过期或遇到验证码会暂停采集，请打开窗口完成验证后再检测。</p>
            <p v-if="activeJob && job?.stage !== 'waiting_login'" class="session-checked-at">采集运行中，打开登录窗口暂不可用；停止任务后可重新登录。</p>
            <details v-if="browserChecks.length" class="browser-diagnostics">
              <summary>查看检测过程（{{ browserChecks.length }}）</summary>
              <p class="browser-engine">无头 Chromium · 专用持久会话</p>
              <ol class="browser-checks" aria-label="登录检测步骤">
                <li v-for="(check, index) in browserChecks" :key="`${check.at}-${index}`" :class="`check-${check.outcome || 'pending'}`">
                  <time>{{ formatTime(check.at) }}</time><strong>{{ browserCheckStageLabel(check.stage) }}</strong><span>{{ check.message }}</span>
                </li>
              </ol>
            </details>
            </div>
            <div v-else-if="isYoutubeJob(job)" class="browser-session" role="region" aria-label="YouTube 采集登录">
              <h3>{{ isYoutubeLoginRequired(job) ? 'YouTube 采集已暂停' : 'YouTube 视频采集' }}</h3>
              <p>请在本机 Chrome 中登录 YouTube 并完成验证，再刷新登录。验证通过后，继续原任务及未完成来源。</p>
              <div class="browser-session-actions">
                <a class="btn btn-sm" href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer"><LogIn :size="14" />打开 YouTube</a>
                <button v-if="isRetryableJob(job)" class="btn btn-sm" type="button" :disabled="!canRefreshYoutubeSession(job)" :aria-busy="youtubeSessionState(job).loading" @click="refreshYoutubeSession(job)"><RefreshCw :size="14" :class="{ spin: youtubeSessionState(job).loading }" />刷新 YouTube 登录</button>
                <button v-if="isRetryableJob(job)" class="btn btn-primary" type="button" :disabled="!canRetryJob(job)" @click="retryJob(job)"><Play :size="14" />{{ jobStarting ? '正在恢复采集' : '继续采集' }}</button>
              </div>
              <p v-if="youtubeSessionState(job).error" class="job-error" role="alert">{{ youtubeSessionState(job).error }}</p>
              <p v-else-if="youtubeSessionState(job).message" role="status">{{ youtubeSessionState(job).message }}</p>
            </div>
            <div v-else class="browser-session" role="region" aria-label="来源采集连接">
              <h3>百家号文章 · czgts.cn</h3>
              <p>使用已保存的 Cookie 读取文章原文，作为视频二创来源。登录失效时，请在采集设置中更新 Cookie 并检测接口。</p>
              <button class="btn btn-sm" type="button" @click="closeMonitor(); openJobDialog()">打开采集设置</button>
            </div>
          </section>
          <section v-show="monitorTab === 'logs'" id="monitor-logs" role="tabpanel" aria-labelledby="monitor-logs-tab" class="job-records">
            <div class="log-task-picker">
              <label for="log-task">查看采集任务</label>
              <select id="log-task" v-model="selectedLogJobId">
                <option value="">{{ job ? `当前 / 最新 · #${job.id}` : '暂无任务' }}</option>
                <option v-for="item in recentJobs" :key="item.id" :value="String(item.id)">#{{ item.id }} · {{ formatLogDate(item.startedAt || item.updatedAt) }} · {{ jobStatusLabel(item.status) }}</option>
              </select>
              <div class="log-task-meta"><span>已加载 {{ recentJobs.length }}{{ jobsTotal !== null ? ` / ${jobsTotal}` : '' }} 个任务</span><button v-if="jobsHasMore" class="job-link" type="button" :disabled="historyLoading" @click="loadOlderJobs">{{ historyLoading ? '加载中…' : '加载更早任务' }}</button></div>
            </div>
            <div v-if="historyError" class="job-error" role="alert">{{ historyError }} <button class="job-link" type="button" @click="loadOlderJobs">重试任务列表</button></div>
            <div v-if="logJob" class="monitor-job-summary"><strong>#{{ logJob.id }} · {{ jobStatusLabel(logJob.status) }}<template v-if="stageLabel(logJob.stage) !== jobStatusLabel(logJob.status)"> · {{ stageLabel(logJob.stage) }}</template></strong><span>{{ selectedLogJobId ? '固定查看此任务' : '跟随当前任务' }}</span></div>
            <div v-if="logJob" class="log-task-stats" aria-label="所查看任务统计"><span>扫描 {{ logJob.counts?.scanned ?? 0 }}</span><span>入选 {{ logJob.counts?.selected ?? 0 }}</span><span>采集存稿 {{ logJob.counts?.completed ?? 0 }}</span><span>曾失败 {{ logJob.counts?.failed ?? 0 }}</span></div>
            <p v-if="logJob" class="log-task-period">开始 {{ formatLogDate(logJob.startedAt) }}<br v-if="logJob.completedAt" /><template v-if="logJob.completedAt">结束 {{ formatLogDate(logJob.completedAt) }}</template></p>
            <p v-if="logJob?.progressMessage && !logFailure" class="log-task-progress">{{ logJob.progressMessage }}</p>
            <div v-if="logFailure" class="job-error job-failure-detail" role="alert">
              <strong>{{ logFailure.summary }}</strong>
              <p v-if="logFailure.recovery">{{ logFailure.recovery }}</p>
              <div class="failure-actions">
                <button v-if="isRetryableJob(logJob)" class="btn btn-sm" type="button" :disabled="!canRetryJob(logJob)" @click="retryJob(logJob)"><RefreshCw :size="14" :class="{ spin: jobStarting }" />{{ jobStarting ? '正在恢复采集' : retryJobLabel(logJob) }}</button>
                <a v-if="logFailure.youtubeLoginRequired" class="btn btn-sm" href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer"><LogIn :size="14" />打开 YouTube</a>
                <button v-if="logFailure.youtubeLoginRequired" class="btn btn-sm" type="button" :disabled="!canRefreshYoutubeSession(logJob)" @click="refreshYoutubeSession(logJob)"><RefreshCw :size="14" :class="{ spin: youtubeSessionState(logJob).loading }" />刷新 YouTube 登录</button>
                <button v-if="logFailure.searchFailure" class="btn btn-sm" type="button" @click="monitorTab = 'connection'"><Radar :size="14" />连接检测</button>
              </div>
              <p v-if="youtubeSessionState(logJob).error" role="alert">{{ youtubeSessionState(logJob).error }}</p>
              <p v-else-if="youtubeSessionState(logJob).message" role="status">{{ youtubeSessionState(logJob).message }}</p>
              <details v-if="logFailure.searchFailure"><summary>技术详情</summary><p>{{ logFailure.raw }}</p></details>
              <p v-else-if="logFailure.raw && logFailure.raw !== logFailure.reason">{{ logFailure.raw }}</p>
            </div>
            <p v-else-if="logJob?.errorMessage" class="job-error" role="alert">{{ logJob.errorMessage }}</p>
            <HistoryBatchOutcomes v-if="logJobId" :job-id="logJobId" :active="monitorOpen && monitorTab === 'logs'" @open-script="openJobSource" />
            <div v-if="logsError" class="job-error" role="alert"><span>{{ logsError }}</span> <button class="job-link" type="button" :disabled="logsLoading" @click="loadLogJob(logsRetryOlder)">重试日志</button></div>
            <div v-if="logJob" class="job-health" role="region" aria-label="任务活动状态">
              <span :class="{ 'health-stale': logJob.workerHealth === 'stale' }">工作进程 · {{ workerHealthLabel }}</span>
              <span>{{ logJob.heartbeatAt ? `心跳 ${formatLogDate(logJob.heartbeatAt)}` : '暂无心跳' }}</span>
              <span v-if="logJob.leaseExpiresAt">租约至 {{ formatLogDate(logJob.leaseExpiresAt) }}</span>
              <span>{{ logJob.progressAt ? `最近业务进展 ${formatLogDate(logJob.progressAt)}` : '暂无业务进展' }}</span>
            </div>
        <div class="job-links">
          <a
            v-if="safeSourceUrl(logJob?.browserUrl)"
            class="job-link"
            :href="safeSourceUrl(logJob.browserUrl)"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink :size="13" /> 查看来源页面
          </a>
          <button v-if="logJob?.currentSourceId" class="job-link" type="button" @click="openJobSource(logJob.currentSourceId)">
            当前稿件 #{{ logJob.currentSourceId }}<span v-if="logJob.currentTitle"> · {{ logJob.currentTitle }}</span>
          </button>
          <button v-for="sourceId in jobSourceIds" :key="sourceId" class="job-link" type="button" @click="openJobSource(sourceId)">
            来源 #{{ sourceId }}
          </button>
        </div>
        <div v-if="logJobId" class="log-filters">
          <input v-model="logSearch" type="search" aria-label="搜索已加载日志" placeholder="搜索已加载日志" />
          <select v-model="logLevel" aria-label="日志级别"><option value="">全部级别</option><option value="info">信息</option><option value="warning">警告</option><option value="error">错误</option></select>
        </div>
        <p v-if="logJobId" class="log-range">已加载 {{ logCache?.items.length || 0 }} / {{ logCache?.total ?? '—' }} 条 · 最新在前<span v-if="logSearch || logLevel"> · 仅筛选已加载日志，匹配 {{ jobEvents.length }} 条</span></p>
        <p v-if="!jobEvents.length" class="monitor-empty">{{ logsLoading ? '正在读取任务日志…' : logSearch || logLevel ? '已加载日志中没有匹配记录' : '暂无任务日志' }}</p>
        <ol v-else class="job-events" aria-label="任务日志记录">
          <li v-for="event in jobEvents" :key="event.id || `${event.createdAt}-${event.message}`" :class="`level-${event.level || 'info'}`">
            <time :datetime="event.createdAt">{{ formatLogDate(event.createdAt) }}</time>
            <span>{{ jobLevelLabel(event.level) }}</span>
            <strong>{{ stageLabel(event.stage) }}</strong>
            <p>{{ event.message }}</p>
            <div v-if="event.counts || event.currentSourceId || event.currentTitle || safeSourceUrl(event.browserUrl)" class="event-context">
              <span v-if="event.counts">扫描 {{ event.counts.scanned ?? 0 }} · 入选 {{ event.counts.selected ?? 0 }} · 入库 {{ event.counts.completed ?? 0 }}</span>
              <span v-if="event.currentTitle">{{ event.currentTitle }}</span>
              <button v-if="event.currentSourceId" class="job-link" type="button" @click="openJobSource(event.currentSourceId)">稿件 #{{ event.currentSourceId }}</button>
              <a v-if="safeSourceUrl(event.browserUrl)" class="job-link" :href="safeSourceUrl(event.browserUrl)" target="_blank" rel="noopener noreferrer">打开来源页面 <ExternalLink :size="12" /></a>
            </div>
            <details v-if="event.candidate" class="event-candidate">
              <summary>{{ event.candidate.screeningStage ? `${candidateStageLabel(event.candidate.screeningStage)} · ` : '' }}{{ candidateOutcomeLabel(event.candidate.outcome) }} · {{ event.candidate.title || event.candidate.videoId || '候选视频' }}</summary>
              <dl>
                <template v-if="event.candidate.reason"><dt>筛选理由</dt><dd>{{ event.candidate.reason }}</dd></template>
                <template v-if="event.candidate.titleEvidence"><dt>标题依据</dt><dd>{{ event.candidate.titleEvidence }}</dd></template>
                <template v-if="event.candidate.curiosityAngle"><dt>观众问题</dt><dd>{{ event.candidate.curiosityAngle }}</dd></template>
                <template v-if="event.candidate.durationSeconds"><dt>视频时长</dt><dd>{{ duration(event.candidate.durationSeconds) }}</dd></template>
                <template v-if="event.candidate.commentCount !== undefined"><dt>评论总数</dt><dd>{{ event.candidate.commentCount }}</dd></template>
                <template v-if="event.candidate.likeCount !== undefined"><dt>点赞数</dt><dd>{{ event.candidate.likeCount }}</dd></template>
              </dl>
              <div v-if="event.candidate.comments?.length" class="event-comments"><strong>实际读取的评论（{{ event.candidate.comments.length }}）</strong><blockquote v-for="(comment, index) in event.candidate.comments" :key="index"><p>{{ comment.text }}</p><span v-if="comment.likes !== undefined">赞 {{ comment.likes }}</span></blockquote></div>
              <p v-else class="log-range">{{ event.candidate.screeningStage === 'search' ? '搜索页初筛尚未读取评论' : '此记录未保存评论样本' }}</p>
            </details>
          </li>
        </ol>
        <button v-if="logCache?.hasMore" class="btn log-load-more" type="button" :disabled="logsLoading" @click="loadLogJob(true)">{{ logsLoading ? '加载中…' : '加载更早日志' }}</button>
          </section>
        </div>
      </section>
    </div>

    <div v-if="jobDialogOpen" class="job-dialog-backdrop" role="presentation" @click.self="closeJobDialog">
      <section ref="jobDialogRef" class="job-dialog" role="dialog" aria-modal="true" aria-labelledby="job-dialog-title" @keydown.esc.prevent.stop="closeJobDialog" @keydown.tab="trapJobDialogFocus">
        <header>
          <div>
            <h2 id="job-dialog-title">启动历史素材采集</h2>
            <template v-if="collectionSource === 'douyin'"><p>按关键词搜索 · 点赞至少1万 · 评论至少20</p>
            <p>视频与图文 · 时长不限</p></template>
            <template v-else-if="collectionSource === 'youtube'"><p>按频道列表依次采集 · 保留原标题和频道信息 · 时长不限</p>
            <p>视频下载后自动转写、校对、二创。</p></template>
            <p v-else>采集百家号历史文章，保存完整原文后自动校对、二创。</p>
          </div>
          <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭" :disabled="jobStarting" @click="closeJobDialog">
            <X :size="16" />
          </button>
        </header>
        <label class="job-field"><span>采集来源</span>
          <select v-model="collectionSource" class="input" :disabled="jobStarting" aria-label="采集来源">
            <option value="douyin">抖音（视频 / 图文）</option><option value="youtube">YouTube 频道 / 视频</option><option value="czgts">百家号文章（czgts.cn）</option>
          </select>
        </label>
        <HistoryCollectionKeywords v-if="collectionSource === 'douyin'" :disabled="jobStarting" @change="collectionKeywords = $event" @ready="keywordSettingsReady = $event" />
        <template v-else-if="collectionSource === 'youtube'">
          <fieldset class="job-field" :disabled="jobStarting">
            <legend>YouTube 采集方式</legend>
            <div class="job-modes">
              <label class="job-mode" :class="{ active: youtubeMode === 'channels' }"><input v-model="youtubeMode" type="radio" name="youtube-mode" value="channels" /><span>频道列表</span></label>
              <label class="job-mode" :class="{ active: youtubeMode === 'video' }"><input v-model="youtubeMode" type="radio" name="youtube-mode" value="video" /><span>单条视频</span></label>
            </div>
          </fieldset>
          <HistoryYoutubeChannels v-show="youtubeMode === 'channels'" :disabled="jobStarting" @change="youtubeChannels = $event" @ready="youtubeSettingsReady = $event" />
          <label v-if="youtubeMode === 'video'" class="job-field"><span>YouTube 视频链接</span>
            <input v-model.trim="youtubeUrl" class="input" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-label="YouTube 视频链接" :disabled="jobStarting" placeholder="https://www.youtube.com/watch?v=…" />
            <small class="job-source-hint">只采集这条视频，不修改已保存的频道列表。</small>
          </label>
        </template>
        <HistoryCzgtsSettings v-else :disabled="jobStarting" @change="czgtsRange = $event" @ready="czgtsSettingsReady = $event" />
        <p class="job-source-hint">二创后同时进入花生制作与精细化制作；两版并行，每版完成后自动发表到百家号视频。</p>
        <fieldset class="job-field">
          <legend>采集方式</legend>
          <div class="job-modes">
            <label class="job-mode" :class="{ active: jobMode === 'count' }">
              <input v-model="jobMode" type="radio" name="collection-mode" value="count" />
              <span>按数量</span>
            </label>
            <label class="job-mode" :class="{ active: jobMode === 'continuous' }">
              <input v-model="jobMode" type="radio" name="collection-mode" value="continuous" />
              <span>持续采集</span>
            </label>
          </div>
        </fieldset>
        <label v-if="jobMode === 'count'" class="job-field">
          <span>产出数量</span>
          <input ref="jobCountInput" v-model.number="jobTargetCount" class="input" type="number" min="1" max="9999" step="1" inputmode="numeric" />
        </label>
        <p v-else class="job-mode-note">持续采集到结果末尾；可手动停止，单篇失败后继续采集，环境或浏览故障会停止。</p>
        <footer>
          <button class="btn" type="button" :disabled="jobStarting" @click="closeJobDialog">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!canSubmitJob" @click="startJob">
            <RefreshCw v-if="jobStarting && browserSessionAction === 'check'" :size="14" class="spin" /><Play v-else :size="14" /> {{ jobStarting ? browserSessionAction === 'check' ? '正在检测连接' : '启动中' : '开始采集' }}
          </button>
        </footer>
      </section>
    </div>

    <div v-show="workspaceView === 'library'" class="mobile-switch" role="group" aria-label="历史脚本视图" :inert="monitorOpen || deleting">
      <button type="button" aria-label="返回脚本列表" :aria-pressed="mobilePane === 'list'" :class="{ active: mobilePane === 'list' }" @click="mobilePane = 'list'"><ChevronLeft :size="16" /> 列表</button>
      <button type="button" :aria-pressed="mobilePane === 'detail'" :class="{ active: mobilePane === 'detail' }" :disabled="!selectedId" @click="mobilePane = 'detail'">详情</button>
    </div>

    <section v-show="workspaceView === 'library'" id="workspace-library" class="workspace" role="tabpanel" aria-labelledby="workspace-tab-library" :class="`mobile-${mobilePane}`" :inert="monitorOpen || deleting" :aria-busy="deleting">
      <aside class="source-rail" aria-label="历史脚本列表">
        <div class="filters">
          <div class="rail-heading">
            <h2>稿件库</h2><span>{{ total }} 条</span>
            <button class="btn btn-ghost btn-sm clear-filters" type="button" :disabled="!hasFilters" @click="resetFilters">清除筛选</button>
          </div>
          <div class="search-filter-row">
            <label class="sr-only" for="history-search">搜索历史脚本</label>
            <div class="search-box">
              <Search :size="15" />
              <input id="history-search" v-model.trim="filters.q" class="input" type="search" placeholder="搜索稿件" @keyup.enter="applyFilters" />
            </div>
            <label class="upload-filter" for="history-upload">
              <span class="sr-only">百家号发表</span>
              <select id="history-upload" v-model="filters.upload" class="input" @change="applyFilters">
                <option value="">发表：全部</option>
                <option value="not_uploaded">未提交</option>
                <option value="partially_uploaded">部分已提交</option>
                <option value="uploaded">全部已提交</option>
              </select>
            </label>
          </div>
          <div class="workflow-filters" role="group" aria-label="制作进度筛选（同时满足）">
            <label v-for="filter in workflowFilterOptions" :key="filter.key" class="workflow-filter" :for="`history-${filter.key}`">
              <span>{{ filter.label }}</span>
              <select :id="`history-${filter.key}`" v-model="filters[filter.key]" class="input" @change="applyFilters">
                <option value="">全部</option>
                <option :value="filter.yes">{{ filter.yesLabel }}</option>
                <option :value="filter.no">{{ filter.noLabel }}</option>
              </select>
            </label>
          </div>
          <details class="more-filters" :open="Boolean(filters.category || filters.status)">
            <summary>更多筛选<span v-if="filters.category || filters.status"> · 已启用</span></summary>
            <div class="filter-row">
              <label class="sr-only" for="history-category">分类</label>
              <select id="history-category" v-model="filters.category" class="input" @change="applyFilters">
                <option value="">全部类型</option>
                <option value="unclassified">待分类</option>
                <option v-for="item in categoryOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
              <label class="sr-only" for="history-status">采集状态</label>
              <select id="history-status" v-model="filters.status" class="input" @change="applyFilters">
                <option value="">全部采集状态</option>
                <option v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </div>
          </details>
        </div>

        <div v-if="listError" class="rail-error" role="alert">
          <CircleAlert :size="15" />
          <span>{{ listError }}</span>
          <button class="btn btn-sm" type="button" @click="loadList">重试</button>
        </div>

        <div v-if="loadingList && !items.length" class="rail-loading">正在读取脚本库</div>
        <div v-else-if="!items.length" class="rail-empty">
          <FileSearch :size="24" />
          <strong>{{ hasFilters ? '没有匹配的脚本' : '暂无历史脚本' }}</strong>
          <span v-if="hasFilters">请调整条件或清除筛选</span>
        </div>

        <div v-else class="source-list">
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="source-item"
            :class="{ active: item.id === selectedId }"
            :aria-pressed="item.id === selectedId"
            :disabled="saving"
            @click="selectItem(item.id)"
          >
            <span class="item-top">
              <span class="item-title">{{ item.title }}</span>
              <span class="tag" :class="statusTone(item.status)">{{ statusLabel(item.status, item) }}</span>
            </span>
            <span class="item-meta">
              <span class="script-id">脚本 #{{ item.id }}</span>
              <span>{{ item.authorName || '未知作者' }}</span>
              <span>{{ categoryLabel(item.category) }}</span>
            </span>
            <span class="item-stats">
              <span><MessageCircle :size="12" /> {{ metric(item, 'comments') }}</span>
              <span><Heart :size="12" /> {{ metric(item, 'likes') }}</span>
              <span>{{ scriptLength(item) }} 字</span>
            </span>
            <span class="item-workflow" aria-label="制作进度">
              <span v-for="filter in workflowFilterOptions" :key="filter.key" :class="{ complete: item.workflowState?.[filter.state] === true }">
                {{ filter.label }}{{ item.workflowState?.[filter.state] === true ? filter.yesLabel : item.workflowState?.[filter.state] === false ? filter.noLabel : '状态未知' }}
              </span>
            </span>
            <span class="item-upload" :title="uploadSummary(item)">
              <span :class="{ complete: item.workflowState?.uploadState === 'uploaded' }">{{ uploadStateLabel(item) }}</span>
              <span v-if="item.workflowState?.videoCompleted && item.workflowState?.videoLinked === false" class="pending-video">成片待关联</span>
            </span>
          </button>
        </div>

        <div class="pager">
          <button class="btn btn-sm" type="button" :disabled="page <= 1 || loadingList" @click="goPage(page - 1)">
            <ChevronLeft :size="14" /> 上一页
          </button>
          <span>{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-sm" type="button" :disabled="page >= totalPages || loadingList" @click="goPage(page + 1)">
            下一页 <ChevronRight :size="14" />
          </button>
        </div>
      </aside>

      <main class="detail-pane" aria-live="polite">
        <div v-if="!selectedId && !loadingList && !detailError" class="detail-empty">
          <BookMarked :size="32" />
          <h2>选择一条历史脚本</h2>
          <p>左侧列表显示已进入脚本库的视频素材和文章原文。</p>
        </div>

        <div v-else-if="loadingDetail" class="detail-loading">正在打开脚本详情</div>

        <div v-else-if="detailError" class="detail-empty error" role="alert">
          <CircleAlert :size="28" />
          <h2>{{ detailUnavailable?.reason === 'deleted' ? '稿件已删除' : detailUnavailable ? '稿件不可用' : '详情读取失败' }}</h2>
          <p>{{ detailError }}</p>
          <button v-if="detailUnavailable" class="btn" type="button" @click="returnToScriptList"><ArrowLeft :size="14" />返回稿件列表</button>
          <button v-else-if="selectedId" class="btn" type="button" @click="loadDetail(selectedId)">重试</button>
        </div>

        <article v-else-if="detail" class="review-console">
          <section class="source-summary">
            <div class="summary-copy">
              <h2 :title="detail.title">{{ detail.title }}</h2>
              <div class="summary-kicker">
                <span class="tag tag-accent">{{ categoryLabel(detail.category) }}</span>
                <span class="tag" :class="statusTone(detail.status)">{{ statusLabel(detail.status, detail) }}</span>
                <span v-if="dirty" class="tag tag-warning">未保存</span>
                <button v-if="productionBySource[detail.id]" class="source-production-link" type="button" :class="productionBySource[detail.id].tone" @click="detailTab = 'huasheng'"><Clapperboard :size="12" />{{ productionBySource[detail.id].label }}<ChevronRight :size="12" /></button>
                <p><span class="script-id">脚本 #{{ detail.id }}</span> · {{ detail.authorName || '未知作者' }} · 更新 {{ formatDate(detail.updatedAt) }}</p>
              </div>
            </div>
            <div class="summary-actions">
              <button class="btn btn-ghost btn-icon" type="button" title="复制脚本链接" aria-label="复制脚本链接" @click="copyScriptLink">
                <Copy :size="14" />
              </button>
              <a v-if="safeSourceUrl(detail.sourceUrl)" class="btn btn-ghost" :href="safeSourceUrl(detail.sourceUrl)" target="_blank" rel="noopener noreferrer">
                <ExternalLink :size="14" /> 来源
              </a>
              <button class="btn btn-ghost btn-icon" type="button" title="查看来源与审阅" aria-label="查看来源与审阅" @click="detailTab = 'source'"><BookOpenText :size="15" /></button>
              <a v-if="!dirty && detail.artifactState?.rewritten === 'current'" class="btn btn-ghost btn-icon" :href="historyScriptAPI.exportUrl(detail.id)" title="导出文稿" aria-label="导出文稿">
                <Download :size="15" />
              </a>
              <button class="btn btn-ghost btn-icon delete-script" type="button" aria-label="删除脚本" :disabled="!canDelete" :title="processingDetail ? '脚本正在处理，完成后可删除' : '删除脚本'" @click="deleteScript">
                <Trash2 :size="15" />
              </button>
            </div>
          </section>

          <section class="production-continuation" aria-label="生产进度">
            <p role="status">{{ continuationProgress }}</p>
            <button class="btn btn-primary" type="button" :disabled="continuationDisabled" @click="continueProduction"><Clapperboard :size="15" />{{ continuationButtonLabel }}</button>
          </section>
          <p v-if="continuationError || continuationReadError" class="save-error continuation-error" role="alert">{{ continuationError || continuationReadError }}<button class="btn btn-sm" type="button" :disabled="dirty || saving || deleting || loadingDetail" @click="loadDetail(detail.id)">重新读取</button></p>

          <div v-if="deleteError" class="delete-error" role="alert">
            <span>{{ deleteError }}</span>
            <button v-if="deleteConflict" class="btn btn-sm" type="button" @click="reloadForDelete">重新读取脚本</button>
          </div>
          <p v-if="detail.lastError" class="save-error" role="alert">{{ detail.lastError }}</p>

          <nav class="detail-tabs" role="tablist" aria-label="稿件内容" @keydown="navigateDetailTabs">
            <button v-for="tab in detailTabs" :id="`detail-tab-${tab.id}`" :key="tab.id" type="button" role="tab" :aria-selected="detailTab === tab.id" :tabindex="detailTab === tab.id ? 0 : -1" :aria-controls="`detail-panel-${tab.id}`" @click="selectDetailTab(tab.id)"><component :is="tab.icon" :size="15" /><span>{{ tab.label }}</span><span v-if="tab.id === 'source' && factualConcerns.length + rewriteWarnings.length" class="review-count">{{ factualConcerns.length + rewriteWarnings.length }}</span></button>
          </nav>

          <section v-show="detailTab === 'source'" id="detail-panel-source" class="source-info-pane" role="tabpanel" aria-labelledby="detail-tab-source">
          <section class="video-and-risk">
            <div v-if="isNoteDetail" class="video-panel note-origin">
              <div class="note-image-grid">
                <a v-for="(image, index) in sourceNoteImages" :key="image" :href="image" target="_blank" rel="noopener noreferrer" :aria-label="`查看来源图片 ${index + 1}`"><img :src="image" :alt="`来源图片 ${index + 1}`" loading="lazy" /></a>
              </div>
              <p>{{ sourceNoteImages.length }} 张来源图片</p>
              <a v-if="safeSourceUrl(detail.sourceUrl)" class="job-link" :href="safeSourceUrl(detail.sourceUrl)" target="_blank" rel="noopener noreferrer"><ExternalLink :size="13" />查看原图文</a>
            </div>
            <div v-else-if="!isArticleDetail" class="video-panel">
              <video
                v-if="detail.videoAvailable"
                :key="detail.id"
                class="source-video"
                :src="historyScriptAPI.videoUrl(detail.id)"
                controls
                preload="metadata"
                playsinline
                @error="videoError = true"
              />
              <div v-else class="video-missing">
                <VideoOff :size="28" />
                <span>{{ parseJson(detail.mediaJson).cleanup?.localReleasedAt ? '转录已保存，来源视频已清理' : '视频尚未下载' }}</span>
                <a v-if="safeSourceUrl(detail.sourceUrl)" class="job-link" :href="safeSourceUrl(detail.sourceUrl)" target="_blank" rel="noopener noreferrer"><ExternalLink :size="13" />查看原视频</a>
              </div>
              <p v-if="parseJson(detail.mediaJson).cleanup?.error" class="video-error" role="status">{{ parseJson(detail.mediaJson).cleanup.error }}</p>
              <div v-if="videoError" class="video-error" role="alert">
                <span>视频读取失败</span>
                <button class="btn btn-sm" type="button" @click="retryVideo">重试播放</button>
              </div>
            </div>
            <div v-else class="video-panel article-origin"><BookOpenText :size="28" /><strong>百家号文章原文</strong><p>{{ detail.rawTranscript?.length || 0 }} 字 · 原文已保存</p></div>

            <aside class="risk-panel" aria-label="审查状态">
              <button type="button" class="risk-head" :aria-expanded="reviewOpen" @click="reviewOpen = !reviewOpen">
                <ShieldAlert :size="17" />
                <strong>审稿提示</strong>
                <span>{{ factualConcerns.length + rewriteWarnings.length }} 项</span>
                <ChevronDown :size="16" :class="{ expanded: reviewOpen }" />
              </button>
              <dl>
                <div>
                  <dt>事实核查</dt>
                  <dd>{{ factCheckStatus === 'needs_sources' ? '待核查史料' : '未确认' }}</dd>
                </div>
                <div>
                  <dt>评论 / 点赞</dt>
                  <dd>{{ metric(detail, 'comments') }} / {{ metric(detail, 'likes') }}</dd>
                </div>
                <div>
                  <dt>来源状态</dt>
                  <dd>{{ artifactSummary }}</dd>
                </div>
                <div v-if="isArticleDetail"><dt>阅读 / 粉丝</dt><dd>{{ metric(detail, 'reads') }} / {{ metric(detail, 'fans') }}</dd></div>
              </dl>
              <p v-if="rewriteWarnings.length" class="risk-note warning">改写待复核 {{ rewriteWarnings.length }} 项：{{ rewriteWarnings[0].reason }}</p>
              <span class="risk-foot">{{ isNoteDetail ? '抖音图文原文' : isArticleDetail ? '文章原文' : `原视频 ${sourceDuration}` }} · 保存后仍待审阅</span>
            </aside>
          </section>

          <section v-if="reviewOpen" class="concern-list" aria-label="审稿详情">
            <h3 v-if="rewriteWarnings.length">改写待复核</h3>
            <ol v-if="rewriteWarnings.length" class="rewrite-warnings"><li v-for="(concern, index) in rewriteWarnings" :key="index"><strong>{{ concern.reason }}</strong><span>校对稿：{{ concern.before }}</span><span>待审稿：{{ concern.after }}</span></li></ol>
            <h3>史料疑点 · {{ factualConcerns.length }} 项</h3>
            <ol><li v-for="(concern, index) in factualConcerns" :key="index"><strong>{{ concern.claim || '待核查说法' }}</strong><span>{{ concern.reason }}</span><span v-if="concern.searchQuery">检索词：{{ concern.searchQuery }}</span></li></ol>
            <details v-if="selection.reason" class="source-evidence"><summary>选题依据与评论</summary><p>{{ selection.reason }}</p><blockquote v-for="(comment, index) in selection.comments || []" :key="index">{{ comment.text }}<small v-if="comment.likes !== undefined">{{ comment.likes }} 赞</small></blockquote></details>
            <details v-if="reviewJson.corrections?.length" class="source-evidence"><summary>转写校对记录 · {{ reviewJson.corrections.length }} 项</summary><p v-for="(correction, index) in reviewJson.corrections" :key="index">{{ correction.before }} → {{ correction.after }}<br />{{ correction.reason }}</p></details>
          </section>
          </section>

          <section v-show="detailTab === 'script'" id="detail-panel-script" class="manuscript-pane" role="tabpanel" aria-labelledby="detail-tab-script">
          <section class="editor-toolbar">
            <div>
              <div class="editor-layout" role="group" aria-label="文稿布局"><button type="button" title="原文对照" aria-label="原文对照" :aria-pressed="compareOriginal" @click="compareOriginal = true"><Columns2 :size="16" /></button><button type="button" title="专注改稿" aria-label="专注改稿" :aria-pressed="!compareOriginal" @click="compareOriginal = false"><PanelLeftClose :size="16" /></button></div>
              <strong>{{ compareOriginal ? '脚本对比' : '二创文稿' }}</strong>
              <span v-if="!isArticleDetail || editedScript">预计口播 {{ estimatedDuration }}</span>
            </div>
            <div class="save-state" role="status" aria-live="polite">
              <span v-if="processingDetail">{{ statusLabel(detail.status) }}</span>
              <span v-else-if="saveError" class="save-error">{{ saveError }}</span>
              <span v-else-if="dirty">有未保存修改</span>
              <span v-else-if="lastSavedAt" :title="formatTime(lastSavedAt)">已保存</span>
              <span v-else>无未保存修改</span>
              <button v-if="conflictDetail" class="btn btn-sm" type="button" @click="copyDraft"><Copy :size="14" /> 复制修改稿</button>
              <button v-if="conflictDetail" class="btn btn-sm" type="button" @click="useLatestDetail">读取最新稿</button>
              <button class="btn btn-primary" type="button" :disabled="!canSave" @click="saveRewrite">
                <Save :size="14" /> {{ saving ? '保存中' : '保存修改' }}
              </button>
            </div>
          </section>

          <section class="script-compare" :class="{ 'focus-rewrite': !compareOriginal }">
            <div v-show="compareOriginal" class="script-column original">
              <div class="script-head">
                <div class="original-modes" role="group" aria-label="原稿版本">
                  <button type="button" :class="{ active: originalMode === 'raw' }" :aria-pressed="originalMode === 'raw'" @click="originalMode = 'raw'">{{ isNoteDetail ? '图文原文' : isArticleDetail ? '文章原文' : '原始转写' }}</button>
                  <button v-if="!isArticleDetail || detail.correctedTranscript" type="button" :class="{ active: originalMode === 'corrected' }" :aria-pressed="originalMode === 'corrected'" :disabled="!detail.correctedTranscript" @click="originalMode = 'corrected'">校对稿</button>
                </div>
                <small>{{ originalText.length }} 字 · 只读</small>
              </div>
              <pre>{{ originalText || '暂无原稿' }}</pre>
            </div>
            <div class="script-column rewrite">
              <label class="script-head" for="rewritten-script">
                <span>二创稿</span>
                <small>{{ editedScript.length }} 字</small>
              </label>
              <p v-if="draftOriginLabel" id="draft-origin" class="draft-origin" :title="draftOriginLabel"><span>{{ draftOriginLabel }}</span></p>
              <details v-if="recreationPlan" class="recreation-summary recreation-analysis" aria-label="原文拆解与三个创作角度">
                <summary>原文拆解与三个创作角度<ChevronDown :size="13" /></summary>
                <p class="recreation-plan-status">{{ recreationPlanPending ? '分析已完成，正文尚未完成；继续制作时可复用此方案。' : '以下记录对应生成时的构思，后续人工修改不会自动更新。' }}</p>
                <dl>
                  <div><dt>原文核心观点</dt><dd>{{ recreationPlan.analysis.coreViewpoint }}</dd></div>
                  <div v-if="recreationPlan.analysis.authorStance"><dt>原作者立场</dt><dd>{{ recreationPlan.analysis.authorStance }}</dd></div>
                  <div v-if="recreationPlan.analysis.background?.length"><dt>必要背景</dt><dd><ul><li v-for="item in recreationPlan.analysis.background" :key="item.id">{{ item.content }}<p>{{ item.whyNeeded }}</p></li></ul></dd></div>
                  <div v-if="recreationPlan.analysis.sourceOutline?.length"><dt>原文大纲</dt><dd><ol><li v-for="item in recreationPlan.analysis.sourceOutline" :key="item.id">{{ item.summary }}</li></ol></dd></div>
                  <div><dt>故事结构</dt><dd><ol><li v-for="(beat, index) in recreationPlan.analysis.storyStructure" :key="index"><strong>{{ beat.stage }}</strong>：{{ beat.content }}</li></ol></dd></div>
                  <div><dt>情绪弧线</dt><dd><ol><li v-for="(beat, index) in recreationPlan.analysis.emotionArc" :key="index"><strong>{{ beat.stage }} · {{ beat.emotion }}</strong>：{{ beat.trigger }}</li></ol></dd></div>
                  <div v-if="recreationPlan.analysis.evidence?.length"><dt>材料与论证</dt><dd><ol><li v-for="item in recreationPlan.analysis.evidence" :key="item.id">{{ item.material }}<p>支持：{{ item.supports }}</p><p v-if="item.limitation">限定：{{ item.limitation }}</p></li></ol></dd></div>
                  <div v-if="recreationPlan.analysis.factsToPreserve?.length"><dt>保留事实</dt><dd><ul><li v-for="(fact, index) in recreationPlan.analysis.factsToPreserve" :key="index">{{ fact }}</li></ul></dd></div>
                </dl>
                <ol class="recreation-angles" aria-label="三个创作角度">
                  <li v-for="angle in recreationPlan.angles" :key="angle.id" :class="{ selected: angle.id === recreationPlan.selectedAngleId }">
                    <h4>{{ recreationAngleLabels[angle.id] || '创作角度' }} · {{ angle.title }}<span v-if="angle.id === recreationPlan.selectedAngleId" class="recreation-selected">{{ recreationPlanPending ? '拟采用' : '已采用' }}</span></h4>
                    <dl>
                      <div><dt>新立场</dt><dd>{{ angle.stance }}</dd></div>
                      <div><dt>认知反差</dt><dd>{{ angle.contrast }}</dd></div>
                      <div><dt>原文依据</dt><dd><ul><li v-for="(evidence, index) in angle.evidence" :key="index">{{ evidence }}</li></ul></dd></div>
                      <div><dt>叙事安排</dt><dd><ol><li v-for="(beat, index) in angle.outline" :key="index">{{ beat }}</li></ol></dd></div>
                    </dl>
                  </li>
                </ol>
                <dl><div><dt>采用理由</dt><dd>{{ recreationPlan.selectionReason }}</dd></div></dl>
                <dl v-if="recreationWritingOutline" aria-label="新稿写作大纲">
                  <div><dt>新稿主张</dt><dd>{{ recreationWritingOutline.thesis }}</dd></div>
                  <div><dt>新稿立场</dt><dd>{{ recreationWritingOutline.stance }}</dd></div>
                  <div><dt>段落大纲</dt><dd><ol><li v-for="section in recreationWritingOutline.sections" :key="section.id">
                    <strong>{{ section.purpose }}</strong><p>{{ section.newInformation }}</p>
                    <p v-if="section.backgroundIds?.length">背景：{{ recreationReferenceText(section.backgroundIds, recreationPlan.analysis.background, 'content') }}</p>
                    <p v-if="section.evidenceIds?.length">材料：{{ recreationReferenceText(section.evidenceIds, recreationPlan.analysis.evidence, 'material') }}</p>
                    <p v-if="section.emotionIds?.length">情绪：{{ recreationReferenceText(section.emotionIds, recreationPlan.analysis.emotionArc, 'emotion') }}</p>
                  </li></ol></dd></div>
                  <div><dt>结尾兑现</dt><dd>{{ recreationWritingOutline.endingPayoff }}</dd></div>
                </dl>
              </details>
              <details v-if="recreation && (recreation.title || recreation.coverText)" class="recreation-summary" aria-label="二创建议"><summary>标题与封面建议<ChevronDown :size="13" /></summary>
                <dl>
                  <div v-if="recreation.title"><dt>二创标题</dt><dd>{{ recreation.title }}</dd></div>
                  <div v-if="recreation.coverText"><dt>封面文字建议</dt><dd>{{ recreation.coverText }}</dd></div>
                </dl>
              </details>
              <textarea
                id="rewritten-script"
                v-model="editedScript"
                class="textarea rewrite-editor"
                :disabled="saving || processingDetail"
                :placeholder="rewritePlaceholder"
                aria-label="编辑待审稿"
                :aria-describedby="draftOriginLabel ? 'draft-origin' : undefined"
                spellcheck="false"
              ></textarea>
            </div>
          </section>
          </section>

          <section v-show="detailTab === 'huasheng'" id="detail-panel-huasheng" class="output-pane" role="tabpanel" aria-labelledby="detail-tab-huasheng">
            <HistoryHuasheng :key="`huasheng-${detail.id}`" :source-id="detail.id" :accounts-revision="huashengAccountsRevision" :script-text="savedScript" :script-revision="savedRevision" :script-current="detail.artifactState?.rewritten === 'current'" :dirty="dirty" :source-busy="saving || deleting || loadingDetail || processingDetail || !!conflictDetail" :production-busy="continuingProduction" :production-label="continuationButtonLabel" :production-disabled="continuationDisabled" :production-active="continuationActive" @continue-production="continueProduction" @open-script="openProductionScript" @manage-accounts="huashengAccountsOpen = true" />
          </section>
          <section v-show="detailTab === 'motion'" id="detail-panel-motion" class="output-pane" role="tabpanel" aria-labelledby="detail-tab-motion">
            <HistoryMotion v-if="motionDetailId === detail.id" :key="`motion-${detail.id}`" :active="workspaceView === 'library' && detailTab === 'motion'" :source-id="detail.id" :script-text="savedScript" :script-revision="savedRevision" :script-current="detail.artifactState?.rewritten === 'current'" :dirty="dirty" :source-busy="saving || deleting || loadingDetail || processingDetail || !!conflictDetail" @open-script="openProductionScript" @delivery-change="onMotionDeliveryChange" />
          </section>
          <section v-show="detailTab === 'delivery'" id="detail-panel-delivery" class="output-pane" role="tabpanel" aria-labelledby="detail-tab-delivery">
            <HistoryScriptDelivery v-if="!isArticleDetail || detail.rewrittenScript" :key="detail.id" ref="deliveryEditor" :script-id="detail.id" :script-revision="detail.revision" :refresh-revision="deliveryRefreshRevision" @video-change="onVideoDeliveryChange" />
            <p v-else class="output-empty">二创稿生成后可准备成片与封面。</p>
          </section>
          <section v-show="detailTab === 'uploads'" id="detail-panel-uploads" class="output-pane" role="tabpanel" aria-labelledby="detail-tab-uploads">
            <HistorySocialUpload v-if="uploadDetailId === detail.id" :key="`upload-${detail.id}`" :script-id="detail.id" :script-revision="detail.revision" />
          </section>
        </article>
      </main>
    </section>
    <HuashengAccounts v-if="huashengAccountsOpen" scope="history" @close="huashengAccountsOpen = false" @updated="huashengAccountsRevision++" />
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { onBeforeRouteUpdate } from 'vue-router'
import {
  ArrowLeft,
  Activity,
  BookMarked,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  Files,
  FileText,
  Film,
  Heart,
  Image,
  Inbox,
  LogIn,
  List,
  MessageCircle,
  PanelLeftClose,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  Square,
  Trash2,
  Upload,
  Users,
  VideoOff,
  X,
} from 'lucide-vue-next'
import { historyScriptAPI } from '~/composables/useApi'
import HistoryHuasheng from '~/components/HistoryHuasheng.vue'
import HistoryMotion from '~/components/HistoryMotion.vue'
import HuashengAccounts from '~/components/HuashengAccounts.vue'
import HistoryBatchOutcomes from '~/components/HistoryBatchOutcomes.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const huashengAccountsOpen = ref(false)
const huashengAccountsRevision = ref(0)
const workspaceViews = [
  { id: 'production', label: '视频制作', icon: Clapperboard },
  { id: 'library', label: '稿件库', icon: Files },
  { id: 'uploads', label: '百家号发表', icon: Upload },
  { id: 'collection', label: '采集任务', icon: Radar },
]
function workspaceFromQuery(query) {
  return workspaceViews.some(view => view.id === query.view) ? query.view : query.script ? 'library' : 'production'
}
const workspaceView = ref(workspaceFromQuery(route.query))
const uploadWorkspaceVisited = ref(workspaceView.value === 'uploads')
watch(workspaceView, view => { if (view === 'uploads') uploadWorkspaceVisited.value = true })
const productionSummary = ref({ total: 0, attention: 0, quota: 0, queued: 0, creating: 0, completed: 0 })
const productionChannel = ref(route.query.channel === 'motion' ? 'motion' : 'huasheng')
const motionWorkspaceVisited = ref(productionChannel.value === 'motion')
const motionSummary = ref({ total: 0, attention: 0 })
function setProductionChannel(channel) {
  productionChannel.value = channel
  if (channel === 'motion') motionWorkspaceVisited.value = true
  router.replace({ query: { ...route.query, channel } })
}
const detailTabs = [
  { id: 'script', label: '文稿', icon: FileText },
  { id: 'huasheng', label: '花生制作', icon: Clapperboard },
  { id: 'motion', label: '精细化制作', icon: Film },
  { id: 'delivery', label: '成片与封面', icon: Image },
  { id: 'uploads', label: '百家号发表', icon: Upload },
  { id: 'source', label: '来源与审阅', icon: BookOpenText },
]
const detailTab = ref('script')
const compareOriginal = ref(true)
const productionBySource = computed(() => {
  const bySource = {}
  const labels = { not_started: '花生未开始', queued: '花生排队中', creating: '花生制作中', completed: '花生已完成' }
  for (const job of [...(productionSummary.value.jobs || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (job.status === 'canceled' && job.stage === 'record_cleanup') continue
    if (String(job.sourceId) === String(detail.value?.id) && job.scriptSha256 !== savedScriptSha256.value) continue
    if (bySource[job.sourceId]) continue
    const pending = [job.stage, job.checkpoint].includes('create_pending')
    const quota = job.productionStatus === 'not_started' && ([job.stage, job.checkpoint].includes('quota_waiting') || /标准(?:模式)?.{0,8}额度.{0,8}(?:用完|不足|耗尽)|10008.{0,20}(?:超量|额度)/.test([job.message, job.error, job.productionMessage].filter(Boolean).join(' ')))
    bySource[job.sourceId] = { label: job.workflowLabel ? job.workflowLabel.startsWith('花生') ? job.workflowLabel : `花生 · ${job.workflowLabel}` : pending ? '花生结果待核对' : quota ? '等待标准额度' : labels[job.productionStatus] || '花生待检查', tone: job.workflowTone === 'success' ? 'completed' : job.workflowTone === 'error' ? 'quota' : pending ? 'queued' : quota ? 'quota' : job.productionStatus }
  }
  return bySource
})
const pageSize = 20
const workflowFilterOptions = [
  { key: 'video', state: 'videoCompleted', label: '视频', yes: 'completed', no: 'not_completed', yesLabel: '已完成', noLabel: '未完成' },
  { key: 'titlePlan', state: 'titlePlanGenerated', label: '标题方案', yes: 'generated', no: 'not_generated', yesLabel: '已生成', noLabel: '未生成' },
  { key: 'cover', state: 'coverGenerated', label: '封面', yes: 'generated', no: 'not_generated', yesLabel: '已生成', noLabel: '未生成' },
  { key: 'motion', state: 'motionGenerated', label: '精细化制作', yes: 'generated', no: 'not_generated', yesLabel: '已生成', noLabel: '未生成' },
]
function libraryFiltersFromQuery(query) {
  const result = { q: '', category: '', status: '', upload: '' }
  for (const key of Object.keys(result)) result[key] = typeof query[key] === 'string' ? query[key].trim() : ''
  for (const filter of workflowFilterOptions) result[filter.key] = [filter.yes, filter.no].includes(query[filter.key]) ? query[filter.key] : ''
  result.upload = ['not_uploaded', 'partially_uploaded', 'uploaded'].includes(query.upload) ? query.upload : ''
  return result
}
function uploadStateLabel(item) {
  const state = item.workflowState
  const publication = state?.uploads?.['baijiahao-video']
  if (publication === 'published') return '已发表'
  if (state?.uploadState === 'partially_uploaded') return state.publicationCounts?.published === state.publicationCounts?.submitted
    && state.publicationCounts?.submitted > 0 ? '部分已发表' : '部分已提交'
  if (publication === 'submitted') return '已提交审核'
  return publication === 'not_uploaded' || state?.uploadState === 'not_uploaded' ? '未提交' : '发表状态待核实'
}
function uploadSummary(item) {
  const counts = item.workflowState?.publicationCounts
  return counts?.expected > 0
    ? `百家号视频：已提交 ${counts.submitted}/${counts.expected} · 已发表 ${counts.published}/${counts.expected}`
    : `百家号视频：${uploadStateLabel(item)}`
}
function libraryPageFromQuery(query) {
  const value = typeof query.page === 'string' ? Number(query.page) : 1
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}
const filters = reactive(libraryFiltersFromQuery(route.query))
const page = ref(libraryPageFromQuery(route.query))
let restoringLibraryQuery = false
const total = ref(0)
const items = ref([])
const selectedId = ref(null)
const detail = ref(null)
const continuationTask = ref(null)
const continuationComplete = ref(false)
const continuationError = ref('')
const continuationReadError = ref('')
const continuingProduction = ref(false)
let continuationRequest = 0
let continuationTimer = null
let pollingContinuation = false
const uploadDetailId = ref(null)
const motionDetailId = ref(null)
watch([detailTab, () => detail.value?.id], ([tab, id]) => { if (tab === 'uploads') uploadDetailId.value = id })
watch([detailTab, () => detail.value?.id], ([tab, id]) => { if (tab === 'motion') motionDetailId.value = id })
const editedScript = ref('')
const savedScript = ref('')
const savedScriptSha256 = ref('')
let savedScriptHashRequest = 0
watch(savedScript, async text => {
  const request = ++savedScriptHashRequest
  savedScriptSha256.value = ''
  if (!text) return
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    if (request === savedScriptHashRequest) savedScriptSha256.value = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch { /* A version that cannot be verified must not inherit an older task's status. */ }
})
const savedRevision = ref('')
const loadingList = ref(false)
const loadingDetail = ref(false)
const saving = ref(false)
const deleting = ref(false)
const deleteError = ref('')
const deleteConflict = ref(false)
const listError = ref('')
const detailError = ref('')
const detailUnavailable = ref(null)
const saveError = ref('')
const lastSavedAt = ref('')
const mobilePane = ref('list')
const conflictDetail = ref(null)
const reviewOpen = ref(false)
const originalMode = ref('raw')
const videoError = ref(false)
const job = ref(null)
const recentJobs = ref([])
const jobsTotal = ref(null)
const jobsHasMore = ref(false)
const jobsCursor = ref(null)
const historyLoading = ref(false)
const historyError = ref('')
// Log browsing is independent of the live job used by the start/stop toolbar.
const selectedLogJobId = ref('')
const logJobDetails = ref({})
const logEventPages = ref({})
const logsLoading = ref(false)
const logsError = ref('')
const logsRetryOlder = ref(false)
const logSearch = ref('')
const logLevel = ref('')
let logRequest = 0
let jobsPageInitialized = false
let newestJobsPageId = null
const jobLoading = ref(false)
const jobStarting = ref(false)
const jobStopping = ref(false)
const jobError = ref('')
const youtubeSessions = ref({})
const youtubeSessionBusy = computed(() => Object.values(youtubeSessions.value).some(state => state.loading))
const jobDialogOpen = ref(false)
const jobMode = ref('count')
const jobTargetCount = ref(1)
const jobCategories = ref([])
const collectionKeywords = ref([])
const keywordSettingsReady = ref(false)
const collectionSource = ref('douyin')
const youtubeMode = ref('channels')
const youtubeUrl = ref('')
const youtubeChannels = ref([])
const youtubeSettingsReady = ref(false)
const czgtsSettingsReady = ref(false)
const czgtsRange = ref({ startTime: '', endTime: '' })
const deliveryRefreshRevision = ref(0)
const deliveryEditor = ref(null)
const jobDialogRef = ref(null)
const jobCountInput = ref(null)
const browserSession = ref(null)
const browserSessionLoading = ref(false)
const browserSessionAction = ref('')
const browserSessionError = ref('')
const monitorOpen = ref(false)
const monitorTab = ref('connection')
const monitorRef = ref(null)
const monitorCloseRef = ref(null)
let listRequest = 0
let detailRequest = 0
let jobRequest = 0
let stopRequest = 0
let browserSessionRequest = 0
let browserSessionActionRequest = 0
let jobDialogReturnFocus = null
let monitorReturnFocus = null
let processingTimer = null
let jobTimer = null
let browserSessionTimer = null
let pollingProcessing = false
let pollingJob = false
const processingStatuses = ['downloading', 'transcribing', 'correcting', 'rewriting']
const terminalJobStatuses = ['stopped', 'completed', 'failed', 'interrupted']
const activeJobStatuses = ['queued', 'running', 'stopping']

const categoryOptions = [
  { value: 'regional_history', label: '地域历史' },
  { value: 'unofficial_history', label: '秘史野史' },
  { value: 'historical_anecdote', label: '历史趣闻' },
  { value: 'historical_commentary', label: '叙述讲解' },
  { value: 'history_trivia', label: '冷知识' },
]

jobCategories.value = categoryOptions.map(item => item.value)

const statusOptions = [
  { value: 'article_saved', label: '原文已保存' },
  { value: 'selected', label: '已筛选' },
  { value: 'downloading', label: '下载中' },
  { value: 'downloaded', label: '源视频已下载' },
  { value: 'transcribing', label: '转写中' },
  { value: 'transcribed', label: '已转写' },
  { value: 'correcting', label: '校对中' },
  { value: 'corrected', label: '已校对' },
  { value: 'rewriting', label: '二创中' },
  { value: 'needs_review', label: '二创稿已就绪' },
  { value: 'failed', label: '失败' },
]

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const hasFilters = computed(() => Object.values(filters).some(Boolean))
const dirty = computed(() => editedScript.value !== savedScript.value)
const activeJob = computed(() => job.value && activeJobStatuses.includes(job.value.status))
const browserReady = computed(() => browserSession.value?.status === 'ready' && browserSession.value?.canCollect === true && Boolean(browserSession.value?.checkedAt) && !browserSessionError.value && !browserSessionAction.value)
const browserVerdict = computed(() => {
  const session = browserSession.value
  if (browserSessionError.value) return { tone: 'error', title: '暂时不能采集', reason: browserSessionError.value }
  if (browserSessionAction.value === 'check' || session?.status === 'checking') {
    return { tone: 'checking', title: '正在检测', reason: '正在确认抖音登录和视频搜索是否可用，请稍候。' }
  }
  if (browserSessionAction.value === 'open') return { tone: 'checking', title: '正在打开登录窗口', reason: '请在打开的抖音窗口完成登录。' }
  if (browserReady.value) return { tone: 'success', title: '可以采集', reason: '后台登录与视频搜索检测通过，采集时无需保持浏览器窗口。' }
  if (['login_required', 'waiting_login', 'blocked', 'error'].includes(session?.status)) {
    return { tone: 'error', title: '暂时不能采集', reason: session.message || '尚未通过登录与搜索检测，请重新检测。' }
  }
  return { tone: 'unknown', title: '启动时自动检测', reason: session?.checkedAt
    ? '上次检测已过期。开始采集时会自动确认连接状态。'
    : '尚未确认是否可用。开始采集时会自动检查。' }
})
const canStartJob = computed(() => !activeJob.value && !jobLoading.value && !jobStarting.value && !jobStopping.value && !youtubeSessionBusy.value && !jobError.value && (collectionSource.value !== 'douyin' || !browserSessionAction.value && browserSession.value?.status !== 'checking'))
const canStopJob = computed(() => Boolean(activeJob.value && job.value.status !== 'stopping'))
const showStopJob = computed(() => Boolean(activeJob.value))
const browserSessionLabel = computed(() => {
  if (browserSessionAction.value === 'check') return '检测中'
  if (browserSessionError.value) return browserSession.value ? '服务错误' : '未连接'
  const session = browserSession.value
  if (session?.status === 'ready') {
    if (!session.checkedAt) return '启动时自动检测'
    return session.canCollect === true ? '采集已就绪' : '启动时自动检测'
  }
  return {
    login_required: '需要登录',
    waiting_login: '等待登录',
    waiting_rate_limit: '服务限流，等待恢复',
    session_saved: '启动时自动检测',
    checking: '检测中',
    blocked: '浏览受阻',
    error: '服务错误',
  }[session?.status] || '未连接'
})
const canCheckBrowserLogin = computed(() => !browserSessionAction.value && browserSession.value?.status !== 'checking')
const canOpenBrowserLogin = computed(() => canCheckBrowserLogin.value && (!activeJob.value || job.value?.stage === 'waiting_login'))
const browserChecks = computed(() => Array.isArray(browserSession.value?.checks) ? browserSession.value.checks.slice(-20) : [])
const youtubeUrlValid = computed(() => isYoutubeVideoUrl(youtubeUrl.value))
const canSubmitJob = computed(() => canStartJob.value && (collectionSource.value === 'youtube' ? youtubeMode.value === 'channels' ? youtubeSettingsReady.value : youtubeUrlValid.value : collectionSource.value === 'czgts' ? czgtsSettingsReady.value : keywordSettingsReady.value) && (
  jobMode.value === 'continuous'
  || Number.isInteger(jobTargetCount.value) && jobTargetCount.value >= 1 && jobTargetCount.value <= 9999
))
const processingDetail = computed(() => processingStatuses.includes(detail.value?.status))
const continuationActive = computed(() => ['queued', 'running'].includes(continuationTask.value?.status))
const productionCompleted = computed(() => continuationComplete.value)
const continuationDisabled = computed(() => continuingProduction.value || productionCompleted.value || !detail.value || loadingDetail.value || saving.value || deleting.value || (!continuationActive.value && (dirty.value || !!conflictDetail.value)))
const continuationButtonLabel = computed(() => continuingProduction.value ? '正在提交…' : productionCompleted.value ? '全部已提交' : continuationActive.value ? '查看生产进度' : '继续生产')
const continuationProgress = computed(() => {
  if (dirty.value) return '文稿有未保存修改，请先保存。'
  if (productionCompleted.value) return '所需视频版本均已提交百家号，可查看审核与发表结果。'
  if (continuationActive.value) return continuationTask.value.progressMessage || '已进入生产队列，正在继续未完成步骤。'
  if (['failed', 'stale', 'canceled'].includes(continuationTask.value?.status)) return continuationTask.value.errorMessage || '生产未完成，可从已保存的步骤继续。'
  if (continuationTask.value?.status === 'succeeded') return continuationTask.value.result?.message || continuationTask.value.progressMessage || '已衔接视频制作，可继续查看各版本进度。'
  if (detail.value?.artifactState?.rewritten === 'current') return '二创稿已就绪，继续未完成的视频制作与发表。'
  if (detail.value?.artifactState?.corrected === 'current') return '校对稿已保存，下一步生成二创稿。'
  if (detail.value?.artifactState?.transcript === 'current') return '转录已保存，下一步校对并生成二创稿。'
  return detail.value?.status === 'downloaded' ? '源视频已下载，下一步转录、校对并生成二创稿。' : '继续处理来源、生成二创稿并制作两版视频。'
})
const isArticleDetail = computed(() => detail.value?.platform === 'baijiahao' || parseJson(detail.value?.mediaJson).kind === 'article')
const isNoteDetail = computed(() => parseJson(detail.value?.mediaJson).kind === 'note')
const sourceNoteImages = computed(() => {
  const images = parseJson(detail.value?.mediaJson).images
  return isNoteDetail.value && Array.isArray(images) ? images.map((_, index) => `/api/v1/history-scripts/${detail.value.id}/images/${index}`) : []
})
const rewritePlaceholder = computed(() => isArticleDetail.value ? '完整原文已保存在左侧，可在此编写待审稿。' : ({
  downloading: '正在下载来源视频',
  transcribing: '正在转写来源音频',
  correcting: '正在校对原始转写',
  rewriting: '正在生成二创待审稿',
}[detail.value?.status] || '待审稿尚未生成'))
const canSave = computed(() => Boolean(detail.value && dirty.value && savedRevision.value && !saving.value && !deleting.value && !loadingDetail.value && !processingDetail.value && editedScript.value.trim()))
const canDelete = computed(() => Boolean(detail.value && savedRevision.value && !saving.value && !deleting.value && !loadingDetail.value && !processingDetail.value))
const reviewJson = computed(() => parseJson(detail.value?.reviewJson))
const recreation = computed(() => ['water_koubo', 'light_edit', 'perspective_recreation', 'source_paraphrase'].includes(reviewJson.value.draftOrigin) && reviewJson.value.recreation
  && typeof reviewJson.value.recreation === 'object' && !Array.isArray(reviewJson.value.recreation)
  ? reviewJson.value.recreation : null)
const recreationPlan = computed(() => {
  if (reviewJson.value.draftOrigin === 'source_paraphrase') return null
  const plan = recreation.value || (!reviewJson.value.recreation ? reviewJson.value.recreationPlan : null)
  return plan?.analysis && typeof plan.analysis === 'object' && Array.isArray(plan.analysis.storyStructure)
    && Array.isArray(plan.analysis.emotionArc) && Array.isArray(plan.angles) ? plan : null
})
const recreationPlanPending = computed(() => Boolean(recreationPlan.value && !recreation.value))
const recreationWritingOutline = computed(() => Array.isArray(recreationPlan.value?.writingOutline?.sections) ? recreationPlan.value.writingOutline : null)
function recreationReferenceText(ids, items, field) {
  if (!Array.isArray(items)) return ''
  return ids.map(id => items.find(item => item.id === id)?.[field]).filter(value => typeof value === 'string' && value.trim()).join('；')
}
const recreationAngleLabels = { opposing: '相反立场', counterintuitive: '反常识角度', conflict: '冲突角度' }
const draftOriginLabel = computed(() => {
  if (reviewJson.value.draftOrigin === 'corrected_transcript') return '起稿方式：由校对稿直接保存，未进行自动改写；可继续人工编辑。'
  if (reviewJson.value.draftOrigin === 'source_paraphrase') {
    const model = typeof recreation.value?.model === 'string' && recreation.value.model.trim()
    const condensed = recreation.value?.skillRevision === 'history-source-condensed-v1'
    return `起稿方式：${model ? `${model} ` : ''}${condensed ? '保留主线与关键事实，缩写为约15分钟口播稿' : '保持原意，调整表达与句间衔接'}；可继续人工编辑。`
  }
  if (reviewJson.value.draftOrigin === 'light_edit') return `起稿方式：${recreation.value?.model || 'gpt-6-luna'} 轻度修改首尾，保留正文；可继续人工编辑。`
  if (reviewJson.value.draftOrigin === 'perspective_recreation') return `起稿方式：${recreation.value?.model || 'gpt-6.1-terra'} 拆解原文、比较三个角度后，按新立场重新组织全文；可继续人工编辑。`
  if (reviewJson.value.draftOrigin === 'water_koubo') {
    const model = typeof recreation.value?.model === 'string' && recreation.value.model.trim()
    return `起稿方式：按 water-koubo 二创规则，由${model ? ` ${model} ` : '文本模型'}基于校对稿生成；仍需审阅，可继续人工编辑。`
  }
  return ''
})
const factualConcerns = computed(() => Array.isArray(reviewJson.value.factualConcerns) ? reviewJson.value.factualConcerns : [])
const rewriteWarnings = computed(() => Array.isArray(reviewJson.value.manualRewriteReview?.concerns) ? reviewJson.value.manualRewriteReview.concerns : [])
const factCheckStatus = computed(() => reviewJson.value.factCheckStatus || 'needs_sources')
const originalText = computed(() => originalMode.value === 'corrected' ? detail.value?.correctedTranscript || '' : detail.value?.rawTranscript || '')
const selection = computed(() => parseJson(detail.value?.selectionJson))
const sourceDuration = computed(() => duration(parseJson(detail.value?.mediaJson).probe?.duration))
const estimatedSeconds = computed(() => {
  const han = editedScript.value.match(/\p{Script=Han}/gu)?.length || 0
  const words = editedScript.value.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu)?.length || 0
  return Math.ceil((han + words) * 60 / 300)
})
const estimatedDuration = computed(() => duration(estimatedSeconds.value))
const artifactSummary = computed(() => {
  if (isArticleDetail.value && !detail.value?.rewrittenScript) return '原文已保存，待审稿未编写'
  const state = detail.value?.artifactState || {}
  const label = { current: '版本匹配', stale: '已过期', missing: '未生成' }
  return `待审稿${label[state.rewritten] || '状态未知'}`
})
const jobTitle = computed(() => {
  if (jobError.value) return '采集状态无法更新'
  if (!job.value) return '浏览采集未启动'
  if (isYoutubeLoginRequired(job.value)) return '已暂停采集 · 等待 YouTube 验证'
  if (['queued', 'running'].includes(job.value.status) && job.value.stage === 'waiting_login') return '已暂停采集 · 等待登录'
  const status = jobStatusLabel(job.value.status)
  if (terminalJobStatuses.includes(job.value.status)) return `上次任务 · ${status}`
  const stage = stageLabel(job.value.stage)
  return status === stage || job.value.status === job.value.stage ? status : `${status} · ${stage}`
})
const browserNeedsAttention = computed(() => isYoutubeLoginRequired(job.value) || isDouyinJob(job.value) && Boolean(browserSessionError.value || ['blocked', 'error', 'login_required', 'waiting_login'].includes(browserSession.value?.status)))
const monitorNeedsAttention = computed(() => Boolean(jobError.value || job.value?.status === 'failed' || job.value?.workerHealth === 'stale' || browserNeedsAttention.value))
const logJobId = computed(() => selectedLogJobId.value || String(job.value?.id || ''))
const logJob = computed(() => {
  if (!logJobId.value) return null
  if (String(job.value?.id) === logJobId.value) return job.value
  return logJobDetails.value[logJobId.value] || recentJobs.value.find(item => String(item.id) === logJobId.value) || null
})
const logCache = computed(() => logEventPages.value[logJobId.value])
const workerHealthLabel = computed(() => {
  if (logJob.value?.workerHealth === 'alive') return logJob.value.heartbeatAt ? '心跳正常' : '租约有效 · 等待首个心跳'
  return { stale: '心跳超时', inactive: '未运行' }[logJob.value?.workerHealth] || '心跳未知'
})
function describeJobFailure(item, storedEvents = item?.events) {
  if (isYoutubeLoginRequired(item)) return {
    raw: item.errorMessage || item.progressMessage || '',
    reason: '需要登录或完成验证',
    recovery: '请在本机 Chrome 中登录 YouTube 并完成验证，再点击“刷新 YouTube 登录”。验证通过后点击“继续采集”，原任务和已保存来源保留。',
    youtubeLoginRequired: true,
    summary: 'YouTube 采集已暂停：需要登录或完成验证',
  }
  if (item?.status !== 'failed') return null
  const events = Array.isArray(storedEvents) ? storedEvents : []
  const failureEvent = events.findLast(event => event.stage === 'failed' || event.level === 'error')
  const raw = item.errorMessage || failureEvent?.message || (item.stage === 'failed' ? item.progressMessage : '') || ''
  // The terminal DTO replaces stage with "failed"; the preceding business event retains the failing operation.
  const stage = events.slice(0, failureEvent ? events.indexOf(failureEvent) : events.length)
    .findLast(event => event.stage && !terminalJobStatuses.includes(event.stage))?.stage
  const httpStatus = /^Text model request failed:\s*(429|502|503|504)\b/.exec(raw)?.[1]
  const searchFailure = /^搜索(?:筛选|布局)(?:未完成|未就绪)/.test(raw)
  const legacySearchFailure = raw.includes('未能确认“5分钟以上”和“视频”已选中、发布时间不限并加载结果')
  const reason = httpStatus
    ? httpStatus === '429' ? `模型${/gateway_concurrency_limit|concurrency limit/i.test(raw) ? '并发已满' : '请求受到限流'}（HTTP 429）`
      : `模型服务${httpStatus === '504' ? '响应超时' : '暂时不可用'}（HTTP ${httpStatus}）`
    : searchFailure ? legacySearchFailure ? '抖音搜索筛选未能完成，尚未开始扫描' : raw.split('；')[0]
      : raw || '任务未记录具体错误，请查看任务日志。'
  const recovery = searchFailure ? '点击“重试采集”自动重新检测并按原配置启动。若检测提示登录或安全验证，打开登录窗口处理后再次重试。已入库稿件保留并自动跳过。'
    : httpStatus === '429' ? '请等其他模型任务结束或稍后点击“重试采集”。已入库稿件保留并自动跳过。' : ''
  return { raw, reason, recovery, searchFailure, summary: `${stage ? `${stageLabel(stage, item)}失败` : '失败原因'}：${reason}` }
}

function isRetryableJob(item) {
  return Boolean(item?.config && (isYoutubeJob(item) ? ['failed', 'interrupted', 'stopped'] : ['failed', 'interrupted']).includes(item.status))
}

function canRetryJob(item) {
  return isRetryableJob(item) && !activeJob.value && !jobLoading.value && !jobStarting.value && !jobStopping.value && !youtubeSessionBusy.value
    && (!isDouyinJob(item) || !browserSessionAction.value && browserSession.value?.status !== 'checking')
}

function isYoutubeLoginRequired(item) {
  if (!isYoutubeJob(item) || !terminalJobStatuses.includes(item.status)) return false
  const failureEvent = (item.events || []).findLast(event => ['waiting_login', 'source_failed', 'failed'].includes(event.stage) || event.level === 'error')
  return item.errorCode === 'youtube_login_required' || item.stage === 'waiting_login'
    || /YouTube.{0,80}(?:要求登录|登录验证|登录失效|机器人验证|not a bot)/i.test(item.errorMessage || failureEvent?.message || item.progressMessage || '')
}

function youtubeSessionState(item) { return youtubeSessions.value[String(item?.id)] || {} }
function canRefreshYoutubeSession(item) { return isYoutubeJob(item) && canRetryJob(item) }
const jobFailure = computed(() => describeJobFailure(job.value))
const logFailure = computed(() => describeJobFailure(logJob.value, logCache.value?.items || logJob.value?.events))
const jobSubtitle = computed(() => {
  if (jobError.value) return '任务状态连接异常'
  if (jobFailure.value) return jobFailure.value.summary
  if (isArticleJob(job.value) && terminalJobStatuses.includes(job.value.status)) return job.value.progressMessage || '原文采集任务已结束'
  if (isYoutubeJob(job.value) && (!job.value || terminalJobStatuses.includes(job.value.status))) return job.value?.progressMessage || 'YouTube 频道与视频 · 启动后自动检测下载连接'
  if (!job.value || terminalJobStatuses.includes(job.value.status)) return `抖音连接 · ${browserSessionLabel.value}`
  if (job.value.errorMessage) return job.value.errorMessage
  return job.value.progressMessage || job.value.currentTitle || latestJobEvent.value?.message || '等待任务更新'
})
const latestJobEvent = computed(() => {
  const events = Array.isArray(job.value?.events) ? job.value.events : []
  return events[events.length - 1] || null
})
const jobEvents = computed(() => {
  const query = logSearch.value.trim().toLocaleLowerCase()
  return (logCache.value?.items || []).filter(event => (!logLevel.value || (event.level || 'info') === logLevel.value)
    && (!query || JSON.stringify([event.message, event.currentTitle, event.currentSourceId, event.candidate]).toLocaleLowerCase().includes(query))).slice().reverse()
})
const jobSourceIds = computed(() => {
  const ids = Array.isArray(logJob.value?.sourceIds) ? logJob.value.sourceIds : []
  return ids.filter(id => id && id !== logJob.value?.currentSourceId)
})

watch([monitorOpen, monitorTab, logJobId], () => {
  if (monitorOpen.value && monitorTab.value === 'logs') loadLogJob()
})

watch(() => filters.q, () => {
  if (restoringLibraryQuery) return
  clearTimeout(loadTimer)
  loadTimer = setTimeout(() => applyFilters(), 350)
}, { flush: 'sync' })

let loadTimer = null

function duration(value) {
  if (!Number.isFinite(value) || value <= 0) return '--:--'
  const seconds = Math.floor(value)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function parseJson(value) {
  try {
    const result = value ? JSON.parse(value) : {}
    return result && typeof result === 'object' ? result : {}
  } catch {
    return {}
  }
}

function categoryLabel(value) {
  if (value === 'unclassified') return '待分类'
  if (value === 'history') return '历史'
  return categoryOptions.find(item => item.value === value)?.label || value || '未分类'
}

function statusLabel(value, source) {
  if (value === 'needs_review' && source && source.artifactState?.rewritten !== 'current') return '二创稿待生成'
  return statusOptions.find(item => item.value === value)?.label || '未知状态'
}

function statusTone(value) {
  if (value === 'needs_review') return 'tag-warning'
  if (value === 'failed') return 'tag-error'
  if (['corrected', 'transcribed', 'downloaded'].includes(value)) return 'tag-info'
  return 'tag-accent'
}

function jobStatusLabel(value) {
  return {
    queued: '排队中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
  }[value] || '未知任务'
}

function stageLabel(value, sourceJob = job.value) {
  return {
    searching_articles: '搜索文章',
    fetching_article: '读取文章原文',
    article_saved: '原文已保存',
    queued: '排队中',
    checking: '检查环境',
    browsing: jobSource(sourceJob) === 'youtube' ? '读取 YouTube' : '浏览抖音',
    scrolling: '滚动加载',
    waiting_results: '等待新视频',
    exhausted: '结果已耗尽',
    channel_exhausted: '频道读取完成',
    keyword_search: '切换关键词',
    keyword_exhausted: '当前关键词已采完',
    keyword_stalled: '当前关键词暂无新结果',
    selecting: '筛选素材',
    waiting_browser: '等待浏览器',
    waiting_login: '等待登录',
    downloading: '下载视频',
    extracting: '抽取音频',
    transcribing: '语音转写',
    correcting: '校对文本',
    rewriting: '二创稿件',
    storing: '保存入库',
    source_failed: '单篇失败，继续采集',
    completed: '完成',
    stopped: '已停止',
    failed: '失败',
    interrupted: '已中断',
  }[value] || '准备中'
}

function jobLevelLabel(value) {
  return {
    info: '信息',
    warning: '警告',
    error: '错误',
  }[value] || '信息'
}

function browserCheckStageLabel(value) {
  return {
    session: '登录会话',
    connect: '连接浏览器',
    search_input: '搜索输入',
    search_submit: '提交搜索',
    video_results: '视频结果',
  }[value] || value || '检测'
}

function metric(item, key) {
  const metrics = parseJson(item.metricsJson)
  const value = metrics[key]
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '--'
}

function scriptLength(item) {
  return String(item.rewrittenScript || item.correctedTranscript || item.rawTranscript || '').length
}

function formatDate(value) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function formatLogDate(value) {
  const date = value ? new Date(value) : null
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
    : '未记录'
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port
      && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com') || url.hostname === 'baijiahao.baidu.com'
        || ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname)) ? url.href : ''
  } catch { return '' }
}

function isArticleJob(value) { return value?.source === 'czgts' || value?.config?.source === 'czgts' }
function jobSource(value) { return value ? value.source || value.config?.source || 'douyin' : collectionSource.value }
function isYoutubeJob(value) { return jobSource(value) === 'youtube' }
function isDouyinJob(value) { return jobSource(value) === 'douyin' }
function collectionSourceLabel(value) { return { youtube: 'YouTube 视频', czgts: '百家号文章 · CZGTS', douyin: '抖音视频' }[jobSource(value)] || '来源未知' }
function retryJobLabel(value) { return isYoutubeJob(value) ? '继续采集' : '重试采集' }
function retryJobTitle(value) { return isYoutubeJob(value) ? '继续原任务及未完成来源' : isDouyinJob(value) ? '重新检测抖音搜索并按原配置重试采集' : '按原配置重试采集' }

function isYoutubeVideoUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname)) return false
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '')
    if (url.hostname.endsWith('youtu.be')) return /^\/[A-Za-z0-9_-]{11}$/.test(pathname)
    if (pathname === '/watch') return /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') || '')
    return /^\/(?:shorts|live)\/[A-Za-z0-9_-]{11}$/.test(pathname)
  } catch { return false }
}

function candidateOutcomeLabel(outcome) {
  return { inspecting: '正在检查', selected: '已入选', skipped: '未入选' }[outcome] || '筛选详情'
}

function candidateStageLabel(stage) {
  return { search: '搜索页初筛', detail: '详情核验' }[stage] || '筛选'
}

async function confirmDiscard() {
  if (saving.value || deleting.value) return false
  if (!dirty.value) return true
  return globalThis.confirm('待审稿有未保存修改，确定离开当前脚本？')
}

function scriptIdFromQuery(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

function moveWorkspaceTab(event, views, active, select, prefix) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = views.findIndex(view => view.id === active)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length
  select(views[next].id)
  nextTick(() => document.getElementById(`${prefix}${views[next].id}`)?.focus())
}

function navigateWorkspaceTabs(event) {
  moveWorkspaceTab(event, workspaceViews, workspaceView.value, setWorkspaceView, 'workspace-tab-')
}

function navigateDetailTabs(event) {
  moveWorkspaceTab(event, detailTabs, detailTab.value, selectDetailTab, 'detail-tab-')
}

function selectDetailTab(tab) {
  detailTab.value = tab
  if (tab === 'delivery') deliveryRefreshRevision.value++
}

function setWorkspaceView(value) {
  workspaceView.value = value
  const query = { ...route.query, view: value }
  if (route.query.view !== query.view) router.replace({ query })
}

function clearUploadFocus() {
  const query = { ...route.query }
  delete query.script
  delete query.videoId
  router.replace({ query })
}

async function openProductionScript(id, tab = 'script', videoId) {
  await selectItem(Number(id))
  if (selectedId.value === Number(id)) {
    if (detailTabs.some(item => item.id === tab)) selectDetailTab(tab)
    setWorkspaceView('library')
    if (tab === 'delivery' && Number.isSafeInteger(videoId) && videoId > 0) {
      await nextTick()
      await deliveryEditor.value?.focusVideo(videoId)
    }
  }
}

function onVideoDeliveryChange() {
  loadList()
}

function onMotionDeliveryChange(id) {
  loadList()
  if (Number(detail.value?.id) !== Number(id)) return
  deliveryRefreshRevision.value++
}

function viewCollectionJob(id) {
  selectedLogJobId.value = String(id)
  monitorTab.value = 'logs'
  openMonitor()
}

async function syncScriptUrl(id, replace = false) {
  const query = { ...route.query }
  if (!query.view) query.view = workspaceView.value
  if (id) query.script = String(id)
  else delete query.script
  if (route.query.script !== query.script) delete query.videoId
  if (route.query.script === query.script) return
  await router[replace ? 'replace' : 'push']({ query })
}

async function returnToScriptList() {
  mobilePane.value = 'list'
  await syncScriptUrl(null, true)
}

async function loadLinkedScript(value) {
  if (value === undefined && workspaceView.value === 'uploads') return
  const id = scriptIdFromQuery(value)
  if (id && id === selectedId.value) return
  detailRequest += 1
  selectedId.value = id
  detail.value = null
  editedScript.value = savedScript.value = savedRevision.value = ''
  loadingDetail.value = false
  detailError.value = ''
  detailUnavailable.value = null
  saveError.value = ''
  deleteError.value = ''
  deleteConflict.value = false
  conflictDetail.value = null
  lastSavedAt.value = ''
  if (value === undefined) {
    if (items.value.length) {
      selectedId.value = items.value[0].id
      await syncScriptUrl(selectedId.value, true)
      await loadDetail(selectedId.value)
    } else mobilePane.value = 'list'
    return
  }
  mobilePane.value = 'detail'
  if (!id) {
    detailError.value = '脚本链接中的编号无效，请从列表中选择脚本。'
    return
  }
  await loadDetail(id)
}

async function loadList(afterDelete = false) {
  if (deleting.value && afterDelete !== true) return
  const request = ++listRequest
  loadingList.value = true
  listError.value = ''
  try {
    const result = await historyScriptAPI.list({
      ...filters,
      limit: pageSize,
      offset: (page.value - 1) * pageSize,
    })
    if (request !== listRequest) return
    items.value = result.items || []
    total.value = result.total || 0
    if (page.value > totalPages.value) {
      page.value = totalPages.value
      await syncLibraryUrl()
      await loadList(afterDelete)
      return
    }
    if (!selectedId.value && items.value.length && (afterDelete === true || route.query.script === undefined)) {
      selectedId.value = items.value[0].id
      if (workspaceView.value !== 'uploads') await syncScriptUrl(selectedId.value, true)
      await loadDetail(selectedId.value)
    }
  } catch (error) {
    if (request === listRequest) listError.value = error.message || '列表读取失败'
  } finally {
    if (request === listRequest) loadingList.value = false
  }
}

function resetContinuation() {
  continuationRequest++
  continuationTask.value = null
  continuationComplete.value = false
  continuationError.value = ''
  continuationReadError.value = ''
}

async function loadDetail(id) {
  if (!id) return
  const request = ++detailRequest
  loadingDetail.value = true
  detailError.value = ''
  detailUnavailable.value = null
  saveError.value = ''
  deleteError.value = ''
  deleteConflict.value = false
  conflictDetail.value = null
  resetContinuation()
  try {
    const data = await historyScriptAPI.get(id)
    if (request !== detailRequest) return
    if (detail.value?.id !== data.id) detailTab.value = 'script'
    detail.value = data
    editedScript.value = data.rewrittenScript || ''
    savedScript.value = data.rewrittenScript || ''
    savedRevision.value = data.revision || ''
    lastSavedAt.value = ''
    conflictDetail.value = null
    videoError.value = false
    originalMode.value = 'raw'
    void loadContinuation(id)
  } catch (error) {
    if (request === detailRequest) {
      if (error.status === 404) {
        detailUnavailable.value = error.data?.reason === 'deleted' ? error.data : { reason: 'missing' }
        detailError.value = detailUnavailable.value.reason === 'deleted'
          ? `稿件 #${id}《${detailUnavailable.value.title}》已于 ${formatDate(detailUnavailable.value.deletedAt)} 删除。`
          : `稿件 #${id} 不存在或已被删除，请从稿件列表选择其他稿件。`
      } else detailError.value = error.message || '详情读取失败'
    }
  } finally {
    if (request === detailRequest) loadingDetail.value = false
  }
}

async function loadContinuation(id = detail.value?.id, refreshSource = false) {
  if (!id) return
  const request = ++continuationRequest
  const revision = savedRevision.value
  try {
    const result = await historyScriptAPI.continuation(id)
    if (request !== continuationRequest || detail.value?.id !== id || savedRevision.value !== revision) return
    continuationTask.value = result?.task || null
    continuationComplete.value = Boolean(result?.complete)
    continuationReadError.value = ''
    if (refreshSource && !dirty.value && !saving.value && !deleting.value && !loadingDetail.value) {
      const source = await historyScriptAPI.get(id)
      if (request !== continuationRequest || detail.value?.id !== id || savedRevision.value !== revision || dirty.value || saving.value || deleting.value) return
      const scriptChanged = (source.rewrittenScript || '') !== savedScript.value
      if (scriptChanged) resetContinuation()
      detail.value = source
      editedScript.value = savedScript.value = source.rewrittenScript || ''
      savedRevision.value = source.revision || ''
      if (scriptChanged) void loadContinuation(id)
    }
  } catch (error) {
    if (request === continuationRequest && detail.value?.id === id && savedRevision.value === revision) continuationReadError.value = error.message || '生产进度读取失败，请重新读取。'
  }
}

async function continueProduction() {
  if (continuationDisabled.value) return
  if (continuationActive.value) {
    await loadContinuation(detail.value.id, true)
    if (detail.value?.artifactState?.rewritten === 'current') detailTab.value = 'huasheng'
    return
  }
  const id = detail.value.id
  const request = ++continuationRequest
  continuingProduction.value = true
  continuationError.value = ''
  try {
    const result = await historyScriptAPI.continueProduction(id, savedRevision.value)
    if (request !== continuationRequest || detail.value?.id !== id) return
    if (result?.complete) { continuationComplete.value = true; continuationTask.value = result.task || null; return }
    if (!result?.task?.id) throw new Error('未收到生产任务，请重新读取状态后重试。')
    continuationTask.value = result.task
  } catch (error) {
    if (request === continuationRequest && detail.value?.id === id) continuationError.value = error.message || '继续生产失败，请重试。'
  } finally { continuingProduction.value = false }
}

async function pollContinuation() {
  if (pollingContinuation || document.hidden || !detail.value || continuingProduction.value || loadingDetail.value) return
  pollingContinuation = true
  try { await loadContinuation(detail.value.id, Boolean(continuationTask.value)) }
  finally { pollingContinuation = false }
}

async function selectItem(id, force = false) {
  if (saving.value || deleting.value) return
  if (id === selectedId.value) { mobilePane.value = 'detail'; return }
  if (!force && !(await confirmDiscard())) return
  selectedId.value = id
  mobilePane.value = 'detail'
  await syncScriptUrl(id)
  await loadDetail(id)
}

async function applyFilters() {
  if (deleting.value) return
  clearTimeout(loadTimer)
  page.value = 1
  await syncLibraryUrl()
  await loadList()
}

function resetFilters() {
  Object.assign(filters, libraryFiltersFromQuery({}))
  applyFilters()
}

async function syncLibraryUrl() {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(filters)) {
    if (value) query[key] = value
    else delete query[key]
  }
  if (page.value > 1) query.page = String(page.value)
  else delete query.page
  if ([...Object.keys(filters), 'page'].some(key => route.query[key] !== query[key])) await router.replace({ query })
}

async function goPage(nextPage) {
  if (deleting.value) return
  page.value = nextPage
  await syncLibraryUrl()
  await loadList()
}

async function refresh() {
  if (deleting.value) return
  await loadBrowserSession()
  await loadJobStatus()
  await loadList()
  if (selectedId.value && !dirty.value && !saving.value && !deleting.value) await loadDetail(selectedId.value)
}

async function loadBrowserSession() {
  if (!isDouyinJob(job.value) && collectionSource.value !== 'douyin') return
  if (browserSessionLoading.value || browserSessionAction.value === 'open') return
  const request = ++browserSessionRequest
  browserSessionLoading.value = true
  try {
    const result = await historyScriptAPI.browserSession()
    if (request !== browserSessionRequest) return
    browserSession.value = result.session || null
    browserSessionError.value = ''
  } catch (error) {
    if (request === browserSessionRequest) browserSessionError.value = error.message || '登录服务未连接'
  } finally {
    if (request === browserSessionRequest) browserSessionLoading.value = false
  }
}

async function runBrowserSessionAction(action) {
  if (browserSessionAction.value) return
  const request = ++browserSessionActionRequest
  browserSessionRequest += 1
  browserSessionLoading.value = false
  browserSessionAction.value = action
  browserSessionError.value = ''
  try {
    const result = action === 'open'
      ? await historyScriptAPI.openBrowserLogin()
      : await historyScriptAPI.checkBrowserLogin()
    if (request !== browserSessionActionRequest) return
    browserSessionRequest += 1
    browserSessionLoading.value = false
    browserSession.value = result.session || null
    browserSessionError.value = ''
    browserSessionAction.value = ''
    if (action === 'check' && !jobStopping.value && !jobStarting.value) await loadJobStatus()
  } catch (error) {
    if (request === browserSessionActionRequest) {
      browserSessionRequest += 1
      browserSessionLoading.value = false
      browserSessionError.value = error.message || '登录操作失败，请重试'
    }
  } finally {
    if (request === browserSessionActionRequest) browserSessionAction.value = ''
    if (action === 'check' && monitorOpen.value && monitorTab.value === 'connection') {
      await nextTick()
      const panel = monitorRef.value?.querySelector('.monitor-body')
      if (panel) panel.scrollTop = 0
    }
  }
}

function openBrowserLogin() {
  if (!canOpenBrowserLogin.value) return
  return runBrowserSessionAction('open')
}

function checkBrowserLogin() {
  if (!canCheckBrowserLogin.value) return
  return runBrowserSessionAction('check')
}

async function refreshMonitoring() {
  await Promise.all([loadBrowserSession(), loadJobStatus()])
  if (monitorTab.value === 'logs') await loadLogJob()
}

function openMonitor() {
  monitorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  monitorOpen.value = true
  nextTick(() => monitorCloseRef.value?.focus())
}

function openJobFailure() {
  selectedLogJobId.value = ''
  monitorTab.value = 'logs'
  openMonitor()
}

function closeMonitor() {
  monitorOpen.value = false
  nextTick(() => {
    monitorReturnFocus?.focus?.()
    monitorReturnFocus = null
  })
}

function trapMonitorFocus(event) {
  const focusable = Array.from(monitorRef.value?.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') || [])
    .filter(element => element instanceof HTMLElement && element.offsetParent !== null)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function navigateMonitorTabs(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  monitorTab.value = event.key === 'Home' ? 'connection' : event.key === 'End' ? 'logs' : monitorTab.value === 'connection' ? 'logs' : 'connection'
  nextTick(() => monitorRef.value?.querySelector(`[role="tab"][aria-selected="true"]`)?.focus())
}

function applyJobState(nextJob, recent = recentJobs.value) {
  const previousJob = job.value
  const previousStatus = previousJob?.status
  const sameJob = previousJob?.id && previousJob.id === nextJob?.id
  const completedIncreased = sameJob && (nextJob.counts?.completed ?? 0) > (previousJob.counts?.completed ?? 0)
  const previousSourceIds = new Set(Array.isArray(previousJob?.sourceIds) ? previousJob.sourceIds : [])
  const sourceAdded = sameJob && Array.isArray(nextJob.sourceIds) && nextJob.sourceIds.some(id => !previousSourceIds.has(id))
  const becameTerminal = previousStatus && nextJob?.status && previousStatus !== nextJob.status && terminalJobStatuses.includes(nextJob.status)
  job.value = nextJob || null
  mergeRecentJobs([...(Array.isArray(recent) ? recent : []), ...(nextJob ? [nextJob] : [])])
  if (nextJob) mergeLogEvents(String(nextJob.id), (nextJob.events || []).slice(-100))
  if (completedIncreased || sourceAdded || becameTerminal) {
    loadList()
  }
}

function mergeRecentJobs(items) {
  const byId = new Map(recentJobs.value.map(item => [String(item.id), item]))
  for (const item of items) byId.set(String(item.id), item)
  recentJobs.value = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id))
}

function mergeLogEvents(id, items, page, older = false) {
  const existing = logEventPages.value[id]
  const byId = new Map((existing?.items || []).map(item => [item.id ?? `${item.createdAt}-${item.message}`, item]))
  for (const item of items) byId.set(item.id ?? `${item.createdAt}-${item.message}`, item)
  const merged = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
  // After a long pause the latest page may no longer overlap the last fetched page.
  // Resume paging at the new boundary so the intervening events remain reachable.
  const gap = page && !older && items.length
    && (existing?.newestFetchedId == null || Number(items[0].id) > existing.newestFetchedId)
  const updateCursor = page && (older || !existing?.initialized || gap)
  const total = page ? page.total : existing?.total ?? null
  const complete = total !== null && merged.length >= total
  logEventPages.value[id] = {
    items: merged,
    total,
    initialized: Boolean(page || existing?.initialized),
    newestFetchedId: page && !older && items.length ? Number(items.at(-1).id) : existing?.newestFetchedId ?? null,
    hasMore: !complete && (updateCursor ? page.hasMore : existing?.hasMore || false),
    nextCursor: updateCursor ? page.nextCursor : existing?.nextCursor || null,
  }
}

function applyJobsPage(result, older = false) {
  mergeRecentJobs(result.recent || [])
  jobsTotal.value = result.total ?? null
  const oldest = result.recent?.at(-1)?.id
  const gap = !older && oldest != null && (newestJobsPageId == null || Number(oldest) > newestJobsPageId)
  if (older || !jobsPageInitialized || gap) {
    jobsHasMore.value = Boolean(result.hasMore)
    jobsCursor.value = result.nextCursor
    jobsPageInitialized = true
  }
  if (!older && result.recent?.length) newestJobsPageId = Number(result.recent[0].id)
  if (jobsTotal.value !== null && recentJobs.value.length >= jobsTotal.value) jobsHasMore.value = false
}

async function loadOlderJobs() {
  if (historyLoading.value || !jobsCursor.value) return
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await historyScriptAPI.jobs({ beforeId: jobsCursor.value })
    applyJobsPage(result, true)
  } catch (error) {
    historyError.value = error.message || '历史任务列表读取失败'
  } finally { historyLoading.value = false }
}

async function loadLogJob(older = false) {
  const id = logJobId.value
  if (!id || (older && (!logCache.value?.nextCursor || logsLoading.value))) return
  const request = ++logRequest
  const beforeId = older ? logCache.value.nextCursor : undefined
  logsLoading.value = true
  logsError.value = ''
  logsRetryOlder.value = older
  try {
    const [detailResult, eventsPage] = await Promise.all([
      String(job.value?.id) === id || older ? Promise.resolve(null) : historyScriptAPI.getJob(id),
      historyScriptAPI.jobEvents(id, { beforeId }),
    ])
    if (request !== logRequest || id !== logJobId.value) return
    if (detailResult?.job) logJobDetails.value[id] = detailResult.job
    mergeLogEvents(id, eventsPage.items || [], eventsPage, older)
  } catch (error) {
    if (request === logRequest && id === logJobId.value) logsError.value = error.message || '任务日志读取失败'
  } finally {
    if (request === logRequest) logsLoading.value = false
  }
}

async function loadJobStatus() {
  const request = ++jobRequest
  jobLoading.value = true
  jobError.value = ''
  try {
    const result = await historyScriptAPI.jobs()
    if (request !== jobRequest) return
    applyJobState(result.job, result.recent)
    applyJobsPage(result)
  } catch (error) {
    if (request === jobRequest) jobError.value = error.message || '任务状态无法更新'
  } finally {
    jobLoading.value = false
  }
}

async function pollJob() {
  if (pollingJob || jobLoading.value || jobStarting.value || jobStopping.value) return
  const request = ++jobRequest
  pollingJob = true
  try {
    if (job.value?.id && activeJob.value) {
      const result = await historyScriptAPI.getJob(job.value.id)
      if (request !== jobRequest) return
      jobError.value = ''
      applyJobState(result.job)
    } else {
      const result = await historyScriptAPI.jobs()
      if (request !== jobRequest) return
      jobError.value = ''
      applyJobState(result.job, result.recent)
      applyJobsPage(result)
    }
    if (monitorOpen.value && monitorTab.value === 'logs' && logJobId.value === String(job.value?.id) && !logsLoading.value) await loadLogJob()
  } catch (error) {
    if (request === jobRequest) jobError.value = error.message || '任务状态无法更新'
  } finally {
    pollingJob = false
  }
}

function openJobDialog() {
  if (jobStarting.value) return
  jobDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!jobCategories.value.length) jobCategories.value = categoryOptions.map(item => item.value)
  keywordSettingsReady.value = false
  czgtsSettingsReady.value = false
  jobDialogOpen.value = true
  nextTick(() => jobCountInput.value?.focus())
}

function closeJobDialog(force = false) {
  if (jobStarting.value && !force) return
  jobDialogOpen.value = false
  nextTick(() => {
    jobDialogReturnFocus?.focus?.()
    jobDialogReturnFocus = null
  })
}

function dialogFocusableElements() {
  return Array.from(jobDialogRef.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])
    .filter(element => element instanceof HTMLElement && element.offsetParent !== null)
}

function trapJobDialogFocus(event) {
  const focusable = dialogFocusableElements()
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function openJobSource(sourceId) {
  const id = Number(sourceId)
  if (!Number.isSafeInteger(id) || id < 1) return
  await selectItem(id)
  if (selectedId.value === id) {
    setWorkspaceView('library')
    closeMonitor()
  }
}

async function retryJob(item) {
  if (!canRetryJob(item)) return
  if (isYoutubeJob(item)) {
    jobStarting.value = true
    jobError.value = ''
    const request = ++jobRequest
    try {
      const result = await historyScriptAPI.resumeJob(String(item.id))
      if (request !== jobRequest) return
      if (!result?.job || String(result.job.id) !== String(item.id)) throw new Error('未收到原采集任务，请刷新状态后继续。')
      applyJobState(result.job)
      if (selectedLogJobId.value) logJobDetails.value[String(item.id)] = result.job
      closeMonitor()
      toast.success('已继续原采集任务')
    } catch (error) {
      if (request === jobRequest) {
        jobError.value = error.message || '恢复采集失败，请重试'
        toast.error(jobError.value)
      }
    } finally { jobStarting.value = false }
    return
  }
  await submitJob(structuredClone(toRaw(item.config)), true)
}

async function refreshYoutubeSession(item) {
  if (!canRefreshYoutubeSession(item)) return
  const id = String(item.id)
  youtubeSessions.value[id] = { loading: true, error: '', message: '' }
  try {
    const result = await historyScriptAPI.refreshYoutubeSession(id)
    youtubeSessions.value[id] = { loading: false, error: '', message: result.message || 'YouTube 登录已刷新并验证通过，可以继续采集。' }
  } catch (error) {
    youtubeSessions.value[id] = { loading: false, error: error.message || 'YouTube 登录刷新失败，请完成验证后重试。', message: '' }
  }
}

async function startJob() {
  if (!canSubmitJob.value) return
  await submitJob({
    targetCount: jobMode.value === 'continuous' ? null : jobTargetCount.value,
    ...(collectionSource.value === 'czgts'
      ? { source: 'czgts', czgts: { ...czgtsRange.value } }
      : collectionSource.value === 'youtube' ? { source: 'youtube', youtube: { urls: youtubeMode.value === 'channels' ? [...youtubeChannels.value] : [youtubeUrl.value.trim()] } }
        : { categories: [...jobCategories.value], keywords: [...collectionKeywords.value] }),
  })
}

async function submitJob(config, retry = false) {
  let request
  jobStarting.value = true
  jobError.value = ''
  try {
    if ((!config.source || config.source === 'douyin') && (retry || !browserReady.value)) {
      await runBrowserSessionAction('check')
      if (!browserReady.value) {
        toast.error(browserSessionError.value || browserSession.value?.message || '抖音连接检测未通过')
        jobStarting.value = false
        closeJobDialog(true)
        await nextTick()
        monitorTab.value = 'connection'
        openMonitor()
        return
      }
    }
    request = ++jobRequest
    const result = await historyScriptAPI.startJob(config)
    if (request !== jobRequest) return
    applyJobState(result.job)
    closeJobDialog(true)
    if (retry && monitorOpen.value) closeMonitor()
    toast.success(result.created ? '采集任务已启动' : '已有采集任务，已恢复监控')
  } catch (error) {
    if (request === undefined || request === jobRequest) {
      jobError.value = error.message || '采集任务启动失败'
      toast.error(jobError.value)
    }
  } finally {
    jobStarting.value = false
  }
}

async function stopJob() {
  if (!canStopJob.value || jobStopping.value) return
  const request = ++jobRequest
  const stopId = ++stopRequest
  const previousJob = job.value
  jobStopping.value = true
  jobError.value = ''
  applyJobState({ ...previousJob, status: 'stopping', stage: previousJob.stage || 'stopped', progressMessage: '正在停止采集任务' })
  const optimisticJob = job.value
  try {
    const result = await historyScriptAPI.stopJob(previousJob.id)
    if (request !== jobRequest || stopId !== stopRequest) return
    applyJobState(result.job)
    if (!monitorOpen.value) toast.success('已请求停止采集任务')
  } catch (error) {
    if (stopId === stopRequest && (request === jobRequest || job.value === optimisticJob)) {
      if (job.value === optimisticJob) {
        ++jobRequest
        applyJobState(previousJob)
      }
      jobError.value = error.message || '停止任务失败'
      if (!monitorOpen.value) toast.error(jobError.value)
    }
  } finally {
    if (stopId === stopRequest) jobStopping.value = false
  }
}

async function pollProcessing() {
  if (pollingProcessing || document.hidden || dirty.value || saving.value || deleting.value || loadingList.value || loadingDetail.value || listError.value || detailError.value) return
  if (!processingDetail.value && !items.value.some(item => processingStatuses.includes(item.status))) return
  pollingProcessing = true
  try {
    await loadList()
    if (!processingDetail.value || dirty.value || saving.value || deleting.value || loadingDetail.value || listError.value) return
    const id = selectedId.value
    const request = detailRequest
    const data = await historyScriptAPI.get(id)
    if (selectedId.value !== id || detailRequest !== request || dirty.value || saving.value || deleting.value) return
    detail.value = data
    editedScript.value = savedScript.value = data.rewrittenScript || ''
    savedRevision.value = data.revision || ''
  } catch { /* A background refresh must not replace the open draft with an error view. */ }
  finally { pollingProcessing = false }
}

async function deleteScript() {
  if (!canDelete.value) return
  const id = detail.value.id
  const message = `删除「${detail.value.title}」？\n删除后将从脚本库移除。${dirty.value ? '\n当前未保存的修改将丢弃。' : ''}`
  if (!globalThis.confirm(message)) return
  deleting.value = true
  deleteError.value = ''
  deleteConflict.value = false
  detailRequest += 1
  listRequest += 1
  try {
    await historyScriptAPI.del(id, savedRevision.value)
    items.value = items.value.filter(item => item.id !== id)
    selectedId.value = null
    detail.value = null
    editedScript.value = savedScript.value = savedRevision.value = ''
    saveError.value = ''
    conflictDetail.value = null
    lastSavedAt.value = ''
    toast.success('脚本已删除')
    await loadList(true)
    if (!selectedId.value) {
      await syncScriptUrl(null, true)
      mobilePane.value = 'list'
    }
  } catch (error) {
    deleteError.value = error.message || '删除失败，请重试'
    deleteConflict.value = error.status === 409
    toast.error(deleteError.value)
  } finally {
    deleting.value = false
  }
}

async function reloadForDelete() {
  if (await confirmDiscard()) await loadDetail(selectedId.value)
}

async function saveRewrite() {
  if (!canSave.value) return
  saving.value = true
  saveError.value = ''
  try {
    const data = await historyScriptAPI.saveRewrite(detail.value.id, {
      rewrittenScript: editedScript.value,
      expectedRevision: savedRevision.value,
    })
    detail.value = data
    editedScript.value = data.rewrittenScript || ''
    savedScript.value = data.rewrittenScript || ''
    savedRevision.value = data.revision || ''
    resetContinuation()
    void loadContinuation(data.id)
    lastSavedAt.value = new Date().toISOString()
    conflictDetail.value = null
    toast.success('二创稿已保存，可继续生产')
    const index = items.value.findIndex(item => item.id === data.id)
    if (index >= 0) items.value[index] = { ...items.value[index], ...data }
  } catch (error) {
    saveError.value = error.message || '保存失败'
    if (error.status === 409) {
      conflictDetail.value = true
      saveError.value = '版本冲突或脚本正在处理。你的修改仍保留。'
    }
    toast.error(saveError.value)
  } finally {
    saving.value = false
  }
}

async function useLatestDetail() {
  if (!conflictDetail.value) return
  if (dirty.value && !globalThis.confirm('读取最新会替换当前未保存待审稿，确定继续？')) return
  try {
    const data = await historyScriptAPI.get(detail.value.id)
    detail.value = data
    editedScript.value = savedScript.value = data.rewrittenScript || ''
    savedRevision.value = data.revision || ''
    conflictDetail.value = null
    saveError.value = ''
    resetContinuation()
    void loadContinuation(data.id)
  } catch (error) { saveError.value = error.message || '最新稿读取失败，修改仍保留' }
}

async function copyDraft() {
  try { await navigator.clipboard.writeText(editedScript.value); toast.success('待审稿已复制') }
  catch { toast.error('复制失败，待审稿仍保留') }
}

async function copyScriptLink() {
  if (!detail.value) return
  const url = new URL(globalThis.location.href)
  url.searchParams.set('script', String(detail.value.id))
  try {
    await navigator.clipboard.writeText(url.href)
    toast.success('脚本链接已复制')
  } catch { toast.error('复制失败，请复制浏览器地址栏中的链接') }
}

function retryVideo() {
  videoError.value = false
  document.querySelector('.source-video')?.load()
}

function beforeUnload(event) {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  if (globalThis.matchMedia('(max-width: 1100px)').matches) compareOriginal.value = false
  globalThis.addEventListener('beforeunload', beforeUnload)
  loadBrowserSession()
  loadJobStatus()
  if (route.query.script !== undefined) loadLinkedScript(route.query.script)
  loadList()
  processingTimer = setInterval(pollProcessing, 15_000)
  continuationTimer = setInterval(pollContinuation, 4000)
  jobTimer = setInterval(pollJob, 4_000)
  browserSessionTimer = setInterval(loadBrowserSession, 4_000)
})

onBeforeUnmount(() => {
  globalThis.removeEventListener('beforeunload', beforeUnload)
  if (loadTimer) clearTimeout(loadTimer)
  if (processingTimer) clearInterval(processingTimer)
  if (continuationTimer) clearInterval(continuationTimer)
  continuationRequest += 1
  if (jobTimer) clearInterval(jobTimer)
  if (browserSessionTimer) clearInterval(browserSessionTimer)
  browserSessionRequest += 1
  browserSessionActionRequest += 1
  logRequest += 1
  listRequest += 1
  detailRequest += 1
})

onBeforeRouteLeave(async () => {
  return await confirmDiscard()
})

onBeforeRouteUpdate(async (to, from) => {
  const selectedQuery = selectedId.value ? String(selectedId.value) : undefined
  if (to.query.view === 'uploads' && from.query.view === 'uploads' && to.query.script === undefined) return true
  if (to.query.script === from.query.script || to.query.script === selectedQuery) return true
  return await confirmDiscard()
})

watch(() => route.query.script, loadLinkedScript)
watch(() => JSON.stringify([libraryFiltersFromQuery(route.query), libraryPageFromQuery(route.query)]), value => {
  const [nextFilters, nextPage] = JSON.parse(value)
  if (page.value === nextPage && Object.keys(filters).every(key => filters[key] === nextFilters[key])) return
  clearTimeout(loadTimer)
  restoringLibraryQuery = true
  Object.assign(filters, nextFilters)
  restoringLibraryQuery = false
  page.value = nextPage
  loadList()
})
watch(() => route.query.channel, channel => {
  productionChannel.value = channel === 'motion' ? 'motion' : 'huasheng'
  if (productionChannel.value === 'motion') motionWorkspaceVisited.value = true
})
watch(() => route.query.view, () => {
  workspaceView.value = workspaceFromQuery(route.query)
})
</script>

<style scoped>
.history-page {
  --warning: #9a4c08;
  --radius: 6px;
  --radius-lg: 8px;
  --font-body: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
  font-family: var(--font-body);
}

.page-head {
  min-height: 62px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-0);
}

.page-identity {
  display: flex;
  align-items: center;
  gap: 12px;
}

.identity-mark {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-2);
  color: var(--accent-text);
}

.page-title {
  font: 650 21px/1.3 var(--font-body);
}

.page-desc {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.4;
}

.job-control {
  min-height: 46px;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 6px 24px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}

.job-main,
.job-progress,
.job-actions {
  display: flex;
  align-items: center;
  min-width: 0;
}

.job-main {
  gap: 10px;
}

.job-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-2);
  background: var(--bg-0);
}

.job-icon.active {
  color: var(--info);
  border-color: rgba(37,99,235,0.22);
  background: var(--info-bg);
}

.job-copy {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.job-copy strong {
  display: flex;
  align-items: center;
  color: var(--text-0);
  font-size: 13px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-scope { flex-shrink: 0; color: var(--text-2); font-size: 11px; font-weight: 400; }

.job-copy span {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-copy strong > span { min-width: 0; color: inherit; font-size: inherit; line-height: inherit; }

.job-failure-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--error);
  text-align: left;
  cursor: pointer;
}
.job-failure-trigger span { min-width: 0; flex: 1; color: inherit; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.job-failure-trigger svg { flex-shrink: 0; }
.job-failure-trigger:hover span { text-decoration: underline; }
.job-failure-trigger:focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.job-failure-detail { display: grid; gap: 6px; margin-block: 12px; }
.job-failure-detail p { color: var(--text-2); }
.failure-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.job-failure-detail summary { cursor: pointer; font-size: 12px; }
.job-failure-detail details p { margin-top: 8px; overflow-wrap: anywhere; }

.job-progress {
  gap: 7px;
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
}

.job-progress span {
  padding-inline: 7px;
  border-left: 1px solid var(--border);
}

.job-progress span:first-child { border-left: 0; }

.job-actions {
  justify-content: flex-end;
  gap: 8px;
}

.job-error {
  margin: 0;
  color: var(--error);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.attention-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--warning); }
.monitor-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; justify-content: flex-end; background: rgba(9, 9, 11, 0.24); }
.monitor-drawer { width: min(520px, 100%); height: 100dvh; display: flex; flex-direction: column; min-height: 0; background: var(--bg-0); border-left: 1px solid var(--border); box-shadow: var(--shadow-xl); }
.monitor-head { flex-shrink: 0; min-height: 80px; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; }
.monitor-head > div:first-child { min-width: 0; }
.monitor-head h2 { font-size: 18px; line-height: 1.4; }
.monitor-head p { margin-top: 3px; color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
.monitor-head-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.monitor-tabs { flex-shrink: 0; display: flex; gap: 20px; padding-inline: 20px; border-bottom: 1px solid var(--border); }
.monitor-tabs button { min-height: 44px; display: inline-flex; align-items: center; gap: 7px; padding: 8px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-2); font: 500 13px var(--font-body); cursor: pointer; }
.monitor-tabs button[aria-selected="true"] { border-bottom-color: var(--text-0); color: var(--text-0); }
.monitor-count { color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.monitor-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px; }
.monitor-job-summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; }
.monitor-job-summary strong { font-size: 13px; }
.monitor-job-summary > span { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.monitor-empty { color: var(--text-2); font-size: 13px; padding-block: 24px; }
.log-task-picker { display: grid; gap: 7px; margin-bottom: 4px; }
.log-task-picker label { color: var(--text-2); font-size: 12px; font-weight: 600; }
.log-task-picker select, .log-filters input, .log-filters select { min-width: 0; width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-0); color: var(--text-1); font: 12px var(--font-body); }
.log-task-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--text-3); font-size: 11px; }
.log-task-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.log-task-period, .log-task-progress { margin: 0; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.log-task-period { color: var(--text-3); }
.log-filters { display: grid; grid-template-columns: minmax(0, 1fr) 100px; gap: 8px; margin-top: 4px; }
.log-range { margin-block: 0 4px; color: var(--text-3); font-size: 11px; line-height: 1.7; }
.log-load-more { width: 100%; margin-top: 12px; }
.event-context, .event-candidate { grid-column: 1 / -1; min-width: 0; overflow-wrap: anywhere; }
.event-context { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--text-3); line-height: 1.7; }
.event-candidate { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-1); }
.event-candidate summary { cursor: pointer; line-height: 1.7; color: var(--text-1); }
.event-candidate dl { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 6px 10px; margin-block: 12px; line-height: 1.7; }
.event-candidate dt { color: var(--text-3); }
.event-candidate dd { margin: 0; color: var(--text-1); }
.event-comments blockquote { border-left: 2px solid var(--border); margin: 8px 0; padding-left: 10px; }
.event-comments blockquote span { font-size: 11px; color: var(--text-3); }

.job-health {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  padding-block: 8px;
  border-block: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.health-stale {
  color: var(--warning);
}

.browser-session {
  display: grid;
  gap: 18px;
}

.browser-session[style*="display: none"] { display: none !important; }

.browser-verdict {
  --verdict-color: var(--text-2);
  --verdict-bg: var(--bg-1);
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 12px;
  padding: 18px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--verdict-bg);
  overflow-wrap: anywhere;
}
.verdict-success { --verdict-color: var(--success); --verdict-bg: var(--success-bg); }
.verdict-error { --verdict-color: var(--error); --verdict-bg: var(--error-bg); }
.verdict-checking { --verdict-color: var(--info); --verdict-bg: var(--info-bg); }
.browser-verdict > svg { margin-top: 2px; color: var(--verdict-color); }
.browser-verdict h3 { color: var(--text-0); font: 700 24px/1.3 var(--font-body); }
.browser-verdict p { margin-top: 8px; color: var(--text-1); font-size: 14px; line-height: 1.65; }
.session-checked-at { font-size: 12px; color: var(--text-2); }
.browser-diagnostics { border-top: 1px solid var(--border); }
.browser-diagnostics summary { padding-block: 12px; color: var(--text-2); font-size: 13px; cursor: pointer; }
.browser-diagnostics summary:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.browser-engine { margin-bottom: 10px; color: var(--text-2); font-size: 12px; }

.browser-session-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}

.browser-checks {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}

.browser-checks li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 8px;
  color: var(--text-2);
  font-size: 12px;
  overflow-wrap: anywhere;
  padding-block: 12px;
  border-top: 1px solid var(--border);
}

.browser-checks strong {
  font-weight: 500;
}

.browser-checks span {
  min-width: 0;
  color: var(--text-1);
  grid-column: 2 / -1;
  line-height: 1.65;
}

.job-records {
  display: grid;
  gap: 8px;
}

.job-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0;
}

.job-link {
  min-height: 30px;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-0);
  color: var(--text-1);
  padding: 4px 8px;
  font: 500 12px var(--font-body);
  text-decoration: none;
  cursor: pointer;
}

.job-link span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-events {
  display: grid;
  gap: 6px;
  padding: 0 0 2px;
  list-style: none;
  margin: 0;
}

.job-events li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: baseline;
  gap: 6px 10px;
  color: var(--text-2);
  font-size: 12px;
  padding-block: 12px;
  border-top: 1px solid var(--border);
}

.job-events time {
  font-variant-numeric: tabular-nums;
}

.job-events strong {
  color: var(--text-1);
}

.job-events p {
  grid-column: 1 / -1;
  min-width: 0;
  margin: 0;
  color: var(--text-1);
  overflow-wrap: anywhere;
  line-height: 1.7;
}

.job-events .level-warning span,
.job-events .level-warning p {
  color: var(--warning);
}

.job-events .level-error span,
.job-events .level-error p {
  color: var(--error);
}

.job-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(9, 9, 11, 0.32);
}

.video-panel.article-origin { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; padding: 24px; text-align: center; background: var(--bg-1); color: var(--text-1); border: 1px solid var(--border); aspect-ratio: auto; min-height: 180px; }
.article-origin p { color: var(--text-2); line-height: 1.7; font-size: 13px; }
.video-panel.note-origin { display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--bg-1); color: var(--text-1); aspect-ratio: auto; }
.note-image-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 440px; overflow-y: auto; }
.note-image-grid a { display: block; min-width: 0; aspect-ratio: 3 / 4; background: var(--bg-2); }
.note-image-grid img { width: 100%; height: 100%; object-fit: contain; }
.note-origin p { color: var(--text-2); font-size: 13px; }

.job-dialog {
  width: min(460px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-0);
  box-shadow: var(--shadow-xl);
  padding: 16px;
  display: grid;
  gap: 14px;
}

.job-dialog header,
.job-dialog footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.job-dialog h2 {
  font-size: 18px;
}

.job-dialog p,
.job-field span,
.job-field legend {
  color: var(--text-2);
  font-size: 12px;
}

.job-field {
  display: grid;
  gap: 8px;
  border: 0;
}

.job-field .input {
  max-width: 140px;
}

.job-field select.input,
.job-field input[type='url'] {
  width: 100%;
  max-width: none;
}

.job-source-hint {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.job-modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-1);
}

.job-mode {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.job-mode.active {
  background: var(--bg-0);
  box-shadow: var(--shadow-sm);
}

.job-mode input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.job-mode span {
  color: var(--text-1);
  font-size: 13px;
}

.job-mode-note {
  min-height: 62px;
  display: flex;
  align-items: center;
}

.job-check {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text-0);
  font-size: 13px;
}

.job-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.workspace {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: 304px minmax(0, 1fr);
}

.source-rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-0);
}

.filters {
  padding: 8px 12px;
  display: grid;
  gap: 6px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}

.search-box {
  position: relative;
}
.search-filter-row { display: grid; grid-template-columns: minmax(0, 1fr) 108px; gap: 6px; }
.search-filter-row > .search-box, .search-filter-row > .upload-filter, .search-filter-row .input { min-width: 0; width: 100%; }
.upload-filter .input { height: 100%; padding: 6px 8px; font-size: 12px; }

.search-box svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
}

.search-box .input {
  padding-left: 36px;
}

.filter-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.filters .clear-filters { margin-left: auto; min-height: 28px; padding: 3px 0 3px 6px; font-size: 11px; }
.workflow-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.workflow-filter { display: grid; gap: 2px; min-width: 0; color: var(--text-2); font-size: 11px; }
.workflow-filter .input, .more-filters .input { width: 100%; min-width: 0; padding: 6px 8px; min-height: 32px; }
.more-filters { font-size: 11px; color: var(--text-2); }
.more-filters summary { cursor: pointer; padding-block: 4px; }
.more-filters .filter-row { margin-top: 6px; }
.item-workflow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 6px; color: var(--text-2); font-size: 11px; line-height: 1.5; }
.item-workflow > span { display: flex; align-items: baseline; gap: 4px; }
.item-workflow > span::before { content: ''; width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: var(--text-3); }
.item-workflow > .complete { color: #18734a; }
.item-workflow > .complete::before { background: currentColor; }
.item-upload { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--text-2); font-size: 11px; line-height: 1.5; }
.item-upload > .complete { color: #18734a; }
.item-upload > .pending-video { color: #9a4c08; }

.source-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 0;
  display: grid;
  align-content: start;
  gap: 0;
}

.source-item {
  width: 100%;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg-0);
  padding: 14px 16px;
  cursor: pointer;
  display: grid;
  gap: 6px;
  transition: background-color 160ms ease-out;
}

.source-item:hover,
.source-item:focus-visible {
  background: var(--bg-1);
}

.source-item.active {
  background: #eff6ff;
  color: #1d4ed8;
  box-shadow: inset 1px 0 #2563eb;
}

.item-top,
.item-meta,
.item-stats {
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.item-title {
  flex: 1;
  min-width: 0;
  color: var(--text-0);
  font-weight: 550;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.item-meta,
.item-stats {
  color: var(--text-2);
  font-size: 12px;
}

.item-stats span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.script-id {
  color: var(--text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pager {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
}

.rail-loading,
.rail-empty,
.rail-error,
.detail-empty,
.detail-loading {
  margin: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-0);
  color: var(--text-2);
  padding: 20px;
}

.rail-empty,
.detail-empty {
  display: grid;
  place-items: center;
  text-align: center;
  gap: 8px;
}

.rail-error {
  display: flex;
  gap: 8px;
  color: var(--error);
  background: var(--error-bg);
}

.detail-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-0);
}

.review-console {
  height: 100%;
  min-height: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.source-summary,
.video-and-risk,
.editor-toolbar,
.concern-list {
  background: var(--bg-0);
}

.source-summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 12px;
  flex-shrink: 0;
}

.production-continuation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px 12px;
  flex-shrink: 0;
}
.production-continuation p { min-width: 0; margin: 0; color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
.production-continuation .btn { flex-shrink: 0; min-width: 112px; }
.continuation-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 20px 10px; margin: 0; }
.continuation-error .btn { flex-shrink: 0; }
@media (max-width: 760px) {
  .production-continuation { padding: 0 14px 10px; align-items: flex-start; }
  .production-continuation .btn { min-width: 104px; }
  .continuation-error { padding-inline: 14px; flex-wrap: wrap; }
}

.summary-kicker,
.summary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.summary-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px 12px;
  align-items: start;
}

.summary-kicker { grid-column: 1; grid-row: 2; }

.summary-copy h2 {
  grid-column: 1;
  grid-row: 1;
  font: 600 17px/1.6 var(--font-body);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.summary-copy p {
  color: var(--text-2);
  font-size: 12.5px;
}

.video-and-risk {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  gap: 20px;
  overflow: hidden;
}

.video-panel {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #09090b;
  display: grid;
  place-items: center;
}

.source-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #09090b;
}

.video-missing {
  color: #fafafa;
  display: grid;
  place-items: center;
  gap: 8px;
}

.risk-panel {
  padding: 0;
  display: grid;
  gap: 10px;
}

.risk-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--warning);
  width: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  font: inherit;
  cursor: pointer;
  text-align: left;
  min-height: 36px;
}
.risk-head > svg:last-child { margin-left: auto; transition: transform 0.15s; }
.risk-head > svg.expanded { transform: rotate(180deg); }
.risk-head > span { font-size: 12px; color: var(--text-2); }
.risk-foot { font-size: 12px; color: var(--text-2); }
.warning { color: var(--warning); }
.video-error { position: absolute; inset: 0; display: grid; align-content: center; justify-items: center; gap: 12px; background: var(--accent); color: var(--bg-0); }

.risk-panel dl {
  display: grid;
  gap: 8px;
}

.risk-panel dl div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.risk-panel dt {
  color: var(--text-2);
}

.risk-panel dd {
  color: var(--text-0);
  font-weight: 600;
  text-align: right;
}

.risk-note {
  color: var(--text-2);
  font-size: 12.5px;
}

.editor-toolbar {
  flex-shrink: 0;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.editor-toolbar > div:first-child {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}

.editor-toolbar span,
.save-state {
  color: var(--text-2);
  font-size: 12px;
}

.save-state {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.save-error {
  color: var(--error);
}

.delete-script { color: var(--error); }
.delete-script:hover:not(:disabled) { background: var(--error-bg); }
.delete-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  color: var(--error);
  background: var(--error-bg);
}

.script-compare {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-0);
  flex: 1;
  min-height: 0;
  margin: 0 20px 20px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  overflow: hidden;
}

.script-column {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.script-column + .script-column {
  border-left: 1px solid var(--border);
}

.script-head {
  min-height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-0);
  font-weight: 650;
}

.script-head small {
  color: var(--text-2);
  font-weight: 500;
}

.draft-origin {
  margin: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.recreation-summary {
  margin: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.recreation-summary dt {
  color: var(--text-2);
}

.recreation-summary dl {
  margin: 0;
}

.recreation-summary dd {
  margin: 0 0 8px;
  color: var(--text-1);
}

.recreation-summary p {
  margin: 0;
  color: var(--text-2);
}

.recreation-analysis .recreation-plan-status {
  margin: 0 0 12px;
}

.recreation-analysis[open] {
  max-height: min(32vh, 360px);
  flex-shrink: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.recreation-analysis ol,
.recreation-analysis ul {
  margin: 4px 0;
  padding-left: 20px;
}

.recreation-analysis li + li {
  margin-top: 5px;
}

.recreation-analysis .recreation-angles {
  margin: 14px 0;
  padding: 0;
  list-style: none;
}

.recreation-angles > li {
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.recreation-angles h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.recreation-selected {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
}

.script-column pre,
.rewrite-editor {
  flex: 1;
  min-height: 0;
  padding: 16px;
  border: 0;
  border-radius: 0;
  background: var(--bg-0);
  color: var(--text-1);
  font: 16px/1.9 var(--font-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  overflow: auto;
}

.rewrite-editor {
  resize: none;
  outline: none;
}

.rewrite-editor:focus {
  box-shadow: inset 0 0 0 2px var(--border-focus);
}

.concern-list {
  padding: 16px 0;
  border-top: 1px solid var(--border);
}

.concern-list h3 {
  font-size: 16px;
  margin-bottom: 10px;
}

.concern-list ol {
  display: grid;
  gap: 10px;
  padding-left: 20px;
}

.concern-list li strong,
.concern-list li span {
  display: block;
}

.concern-list li span {
  color: var(--text-2);
  font-size: 12.5px;
}

.mobile-switch {
  display: none;
}

.history-page :deep(h2), .history-page :deep(h3), .history-page :deep(h4) { font-family: var(--font-body); }
.history-page :deep(.btn), .history-page :deep(.input), .history-page :deep(select) { border-radius: 6px; }
.history-page :deep(.btn) { box-shadow: none; }
.history-page :deep(::selection) { background: #dbeafe; color: #172554; }
.history-page :deep(textarea) { caret-color: #2563eb; }
.history-page :deep(input::placeholder), .history-page :deep(textarea::placeholder) { color: var(--text-2); opacity: 1; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.library-count, .muted { color: var(--text-2); font-size: 12px; }
.library-count { padding-left: 12px; border-left: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.workspace-tabs { display: flex; align-items: stretch; flex-shrink: 0; gap: 24px; padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--bg-0); }
.workspace-tabs > button, .detail-tabs > button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex-shrink: 0; min-height: 46px; padding: 0 3px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-2); font: 500 13px var(--font-body); cursor: pointer; }
.workspace-tabs > button[aria-selected="true"], .detail-tabs > button[aria-selected="true"] { color: var(--text-0); border-bottom-color: var(--text-0); }
.workspace-tabs > button:hover, .detail-tabs > button:hover { color: var(--text-0); }
.tab-count { display: inline-flex; align-items: center; min-height: 20px; padding: 0 6px; border-radius: 4px; background: var(--bg-2); color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.tab-count.attention-count { color: var(--warning); background: #fff7ed; }
.running-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.rail-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rail-heading h2 { font-size: 13px; font-weight: 650; }
.rail-heading > span { color: var(--text-2); font-size: 11px; }
.item-production { margin-left: auto; color: var(--text-2); font-size: 10px; }
.item-production.quota, .source-production-link.quota { color: #9a4c08; }
.item-production.completed, .source-production-link.completed { color: #15803d; }
.item-production.queued, .item-production.creating, .source-production-link.queued, .source-production-link.creating { color: #1d4ed8; }
.source-production-link { display: inline-flex; align-items: center; gap: 4px; border: 0; padding: 2px 0; background: transparent; color: var(--text-2); font: 500 11px var(--font-body); cursor: pointer; }
.source-production-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.detail-tabs { display: flex; gap: 22px; flex-shrink: 0; min-width: 0; overflow-x: auto; padding: 0 20px; border-bottom: 1px solid var(--border); }
.detail-tabs > button { min-height: 44px; font-size: 12px; }
.review-count { color: var(--warning); font-size: 11px; font-variant-numeric: tabular-nums; }
.manuscript-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.editor-layout { display: flex; align-items: center; padding: 2px; border: 1px solid var(--border); border-radius: 6px; gap: 2px; }
.editor-layout button { display: inline-grid; place-items: center; width: 30px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--text-2); cursor: pointer; }
.editor-layout button[aria-pressed="true"] { color: var(--text-0); background: var(--bg-2); }
.script-compare.focus-rewrite { grid-template-columns: minmax(0, 1fr); }
.script-compare.focus-rewrite .rewrite { border: 0; }
.script-compare.focus-rewrite .rewrite-editor { padding: 20px 24px; }
.script-compare.focus-rewrite .draft-origin { padding-inline: 24px; }
.recreation-summary > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; color: var(--text-2); list-style: none; }
.recreation-summary > summary::-webkit-details-marker { display: none; }
.recreation-summary[open] > summary { margin-bottom: 12px; color: var(--text-1); }
.recreation-summary[open] > summary svg { transform: rotate(180deg); }
.draft-origin { flex-shrink: 0; }
.draft-origin > span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.output-pane, .source-info-pane { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.source-info-pane { padding: 24px; }
.review-console > .save-error, .review-console > .delete-error { flex-shrink: 0; margin: 8px 20px; max-height: 96px; overflow: auto; font-size: 12px; }
.output-pane :deep(.delivery), .output-pane :deep(.article-panel) { margin: 0; padding: 24px; border: 0; border-radius: 0; box-shadow: none; }
.output-pane :deep(header h2) { font-size: 16px; }
.output-pane :deep(.hint), .output-pane :deep(header p) { color: var(--text-2); }
.output-empty { padding: 32px 24px; color: var(--text-2); }
.production-workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
.production-workspace > :deep(.huasheng) { flex: 1; min-width: 0; min-height: 0; }
.production-workspace > :deep(.history-motion) { flex: 1; min-width: 0; min-height: 0; }
.production-channels { display: flex; flex-shrink: 0; gap: 6px; padding: 10px 24px; background: var(--bg-0); border-bottom: 1px solid var(--border); }
.production-channels > button { display: inline-flex; align-items: center; gap: 7px; border: 1px solid transparent; border-radius: 5px; padding: 6px 12px; background: transparent; color: var(--text-2); font: 500 13px var(--font-body); cursor: pointer; }
.production-channels > button[aria-pressed="true"] { border-color: var(--border); background: var(--bg-1); color: var(--text-0); }
.production-channels > button:hover { color: var(--text-0); }
.production-channels.inline-channels { min-width: 0; flex-wrap: wrap; padding: 0; border: 0; }
.inline-channels > button { padding: 5px 8px; font-size: 12px; }
.is-production .page-head { min-width: 0; min-height: 56px; flex-wrap: wrap; gap: 8px 16px; padding: 8px 16px; }
.is-production .page-title { font-size: 18px; }
.is-production .page-identity { min-width: 0; gap: 8px; }
.is-production .head-actions { flex-wrap: wrap; gap: 6px; }
.is-production .production-monitor { font-size: 12px; gap: 6px; }
.production-monitor small { color: var(--text-2); font-size: 11px; }
.production-monitor small.warning { color: var(--warning); }
.is-production .workspace-tabs { min-width: 0; flex-wrap: wrap; gap: 0 16px; padding-inline: 16px; }
.is-production .workspace-tabs > button { min-height: 40px; }
.channel-attention { font-size: 11px; color: #a16207; }
.upload-workspace { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; background: var(--bg-0); }
.collection-workspace { flex: 1; min-height: 0; overflow: auto; padding: 24px; }
.collection-heading, .collection-heading > div { display: flex; align-items: center; gap: 12px; }
.collection-heading { justify-content: space-between; margin-bottom: 24px; }
.collection-heading h2 { font-size: 18px; }
.collection-table { width: 100%; min-width: 0; }
.collection-table-head, .collection-row { display: grid; grid-template-columns: minmax(180px, 1.1fr) 100px 100px minmax(220px, 2fr) 84px; gap: 16px; align-items: center; padding: 14px 12px; border-bottom: 1px solid var(--border); }
.collection-row-actions { display: flex; justify-content: flex-end; gap: 4px; }
.collection-table-head { padding-block: 10px; font-size: 12px; color: var(--text-2); background: var(--bg-1); border-top: 1px solid var(--border); }
.collection-row { min-height: 88px; font-size: 13px; }
.collection-row > div { min-width: 0; }
.collection-row small { display: block; margin-top: 5px; color: var(--text-2); font-size: 11px; line-height: 1.6; }
.collection-task { display: grid; gap: 5px; }
.collection-task > span { line-height: 1.6; }
.text-command { width: fit-content; border: 0; padding: 0; background: transparent; color: var(--text-0); font: 600 13px var(--font-body); text-align: left; cursor: pointer; }
.text-command:hover { text-decoration: underline; text-underline-offset: 3px; }
.collection-status { color: var(--text-2); font-size: 12px; }
.collection-status.running, .collection-status.queued { color: #1d4ed8; }
.collection-status.completed { color: #15803d; }
.collection-status.failed, .collection-status.interrupted { color: #b91c1c; }
.collection-numbers { font-variant-numeric: tabular-nums; }
.collection-progress > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.7; }
.collection-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--error); padding: 12px 0; }
.collection-more { display: flex; margin: 20px auto; }
.collection-empty { display: grid; justify-items: center; gap: 16px; padding: 64px 16px; color: var(--text-2); }
.collection-empty h3 { font-size: 16px; color: var(--text-1); }

.spin {
  animation: spin 0.9s linear infinite;
}

.history-page :deep(*) { letter-spacing: 0; }
.history-page :deep(button), .history-page :deep(a), .history-page :deep(input), .history-page :deep(select) { touch-action: manipulation; }
.history-page :deep(button:focus-visible), .history-page :deep(a:focus-visible), .history-page :deep(summary:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: 3px; }
.history-page :deep(.btn) { min-height: 40px; }
.history-page :deep(.btn:hover) { transform: none; }
.source-item:disabled { cursor: wait; opacity: 0.6; }
.rail-empty, .detail-empty, .rail-loading, .detail-loading, .rail-error { border: 0; border-radius: 0; }
.rail-empty, .rail-loading { flex: 1; }
.source-item { font: inherit; }
.source-item .tag { flex-shrink: 0; }
.source-summary .summary-actions { align-self: flex-start; flex-shrink: 0; }
.original-modes { display: flex; gap: 4px; min-width: 0; }
.original-modes button { border: 0; border-radius: var(--radius-sm); padding: 6px 8px; background: transparent; color: var(--text-2); font: 500 12px var(--font-body); cursor: pointer; min-height: 36px; }
.original-modes button.active { background: var(--bg-2); color: var(--text-0); }
.original-modes button:disabled { cursor: not-allowed; opacity: 0.5; }
.original pre { background: var(--bg-1); }
.rewrite-warnings { margin-bottom: 24px; }
.source-evidence { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 12px; }
.source-evidence summary { cursor: pointer; font-weight: 600; padding-block: 4px; }
.source-evidence p, .source-evidence blockquote { margin-top: 12px; font-size: 14px; }
.source-evidence blockquote { border-left: 2px solid var(--border); padding-left: 12px; }
.source-evidence small { margin-left: 8px; color: var(--text-2); }
.detail-empty h2 { font-size: 18px; }
.detail-empty p { max-width: 420px; }

@media (max-width: 1200px) {
  .source-summary { gap: 12px; }
  .summary-actions { gap: 4px; }
  .summary-actions .btn { padding-inline: 8px; }
}

@media (min-width: 1100px) {
  .history-page.is-production { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); }
  .is-production .page-head { grid-column: 1; grid-row: 1; }
  .is-production .workspace-tabs { grid-column: 2; grid-row: 1; }
  .is-production .production-workspace { grid-column: 1 / -1; grid-row: 2; }
}

@media (max-width: 980px) {
  .job-control { grid-template-columns: minmax(0, 1fr) auto; }
  .job-progress { display: none; }
  .job-actions { grid-column: 2; grid-row: 1; }
  .workspace {
    grid-template-columns: 268px minmax(0, 1fr);
  }

  .video-and-risk,
  .script-compare {
    grid-template-columns: 1fr;
  }

  .script-column + .script-column {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .script-compare:not(.focus-rewrite) { overflow: auto; }
  .script-compare:not(.focus-rewrite) .script-column { min-height: 340px; }
  .collection-table-head, .collection-row { grid-template-columns: minmax(140px, 1fr) 80px 84px minmax(170px, 1.6fr) 84px; gap: 12px; }
}

@media (max-width: 760px) {
  .page-head {
    height: auto;
    min-height: 56px;
    padding: 8px 14px;
  }

  .page-title {
    font-size: 18px;
  }

  .job-control {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    padding: 6px 14px;
  }

  .job-progress {
    display: none;
  }

  .job-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
    grid-column: auto;
    grid-row: auto;
  }

  .job-error {
    margin-left: 0;
  }

  .job-events li {
    align-items: flex-start;
  }

  .job-events li {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .job-events p {
    grid-column: 1 / -1;
  }

  .monitor-drawer { width: 100%; border-left: 0; }
  .monitor-head { min-height: 76px; padding: 14px 16px; }
  .monitor-tabs { padding-inline: 16px; }
  .monitor-body { padding: 16px; }
  .job-actions { gap: 6px; }
  .job-actions .btn { padding-inline: 10px; font-size: 12px; }
  .job-progress { gap: 0; }
  .job-progress span { padding-inline: 6px; }
  .job-progress span:first-child { padding-left: 0; }

  .mobile-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0 14px;
    gap: 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-0);
  }

  .mobile-switch button {
    height: 36px;
    border: 0;
    border-radius: 0;
    background: var(--bg-0);
    color: var(--text-2);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }

  .mobile-switch button.active {
    background: var(--bg-0);
    color: var(--text-0);
    box-shadow: inset 0 -2px var(--text-0);
  }

  .workspace {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .source-rail,
  .detail-pane {
    flex: 1;
    min-height: 0;
    height: auto;
  }

  .source-rail {
    border-right: 0;
  }

  .workspace.mobile-list .detail-pane,
  .workspace.mobile-detail .source-rail {
    display: none;
  }

  .review-console {
    padding: 0;
    height: auto;
    min-height: 100%;
  }

  .editor-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-actions,
  .save-state {
    justify-content: space-between;
  }

  .script-column pre,
  .rewrite-editor {
    min-height: 340px;
    font-size: 16px;
  }
  .page-identity { min-width: 0; }
  .page-desc { font-size: 12px; }
  .source-summary .summary-actions { align-self: auto; }
  .save-state { justify-content: flex-start; }
  .input { font-size: 16px; min-height: 44px; }
  .summary-copy h2 { font-size: 18px; }
  .summary-copy { grid-template-columns: minmax(0, 1fr); }
  .summary-kicker { grid-column: 1; grid-row: auto; }
  .summary-copy h2 { grid-row: auto; }
  .video-and-risk { gap: 12px; }
  .script-head { padding-inline: 10px; flex-wrap: wrap; }
  .script-head small { font-size: 12px; }
  .btn { min-height: 44px !important; }
  .head-actions { gap: 4px; }
  .head-actions > .btn-ghost:not(.btn-icon) { padding-inline: 8px; font-size: 0; gap: 0; }
  .head-actions > .btn-primary { padding: 7px 10px; min-height: 36px !important; font-size: 12px; }
  .head-actions > .btn-icon { min-width: 32px; width: 32px; }
  .page-identity { gap: 8px; }
  .library-count { padding-left: 8px; font-size: 11px; white-space: nowrap; }
  .workspace-tabs { gap: 20px; padding-inline: 14px; }
  .workspace-tabs > button { min-height: 42px; font-size: 12px; gap: 5px; }
  .tab-count { font-size: 10px; padding-inline: 4px; }
  .job-icon { display: none; }
  .job-copy strong { font-size: 11px; }
  .job-copy span { font-size: 10px; }
  .job-copy .job-failure-trigger span { -webkit-line-clamp: 1; }
  .job-actions .monitor-trigger { font-size: 0; gap: 0; padding-inline: 8px; min-height: 32px !important; }
  .job-actions .retry-collection { padding-inline: 8px; gap: 0; }
  .retry-collection span { display: none; }
  .job-actions .btn { min-height: 32px !important; }
  .source-summary { padding: 14px 14px 10px; gap: 8px; }
  .source-summary .summary-actions { flex-shrink: 0; align-self: flex-start; display: grid; grid-template-columns: repeat(2, 30px); gap: 0; }
  .summary-actions .btn { min-width: 30px; width: 30px; min-height: 32px !important; padding: 4px; }
  .summary-actions a:not(.btn-icon) { font-size: 0; gap: 0; }
  .summary-copy h2 { font-size: 15px; }
  .summary-copy p { font-size: 11px; }
  .summary-kicker { gap: 4px; }
  .summary-kicker .tag { font-size: 10px; }
  .detail-pane { overflow: auto; }
  .detail-tabs { padding-inline: 14px; gap: 20px; }
  .detail-tabs > button { min-height: 42px; }
  .manuscript-pane { min-height: 460px; }
  .editor-toolbar { padding: 10px 14px; gap: 8px; }
  .editor-toolbar > div:first-child { gap: 8px; }
  .editor-toolbar > div:first-child > span { font-size: 11px; margin-left: auto; }
  .save-state { justify-content: space-between; font-size: 11px; }
  .save-state .btn { min-height: 36px !important; }
  .script-compare { margin: 0 14px 14px; min-height: 340px; }
  .script-compare.focus-rewrite .rewrite-editor { padding: 14px; }
  .script-compare.focus-rewrite .draft-origin { padding-inline: 14px; }
  .source-info-pane { padding: 16px; overflow: visible; }
  .output-pane { flex: none; overflow: visible; }
  .output-pane :deep(.delivery), .output-pane :deep(.article-panel) { padding: 16px; }
  .collection-workspace { padding: 18px 14px; }
  .collection-heading { margin-bottom: 18px; }
  .collection-heading h2 { font-size: 17px; }
  .collection-heading > div { gap: 8px; }
  .collection-table-head { display: none; }
  .collection-row { grid-template-columns: minmax(0, 1fr) 80px 36px; gap: 10px; padding: 16px 0; }
  .collection-task { grid-column: 1; }
  .collection-row > div:nth-child(2) { grid-column: 2; }
  .collection-row > div:nth-child(3) { grid-column: 1; grid-row: 3; font-size: 12px; }
  .collection-row > div:nth-child(3) small { display: inline; margin-left: 8px; }
  .collection-progress { grid-column: 1 / 3; grid-row: 2; }
  .collection-row > div:last-child { grid-column: 3; grid-row: 1; }
  .collection-row-actions { flex-direction: column; align-items: flex-end; }
}
@media (max-height: 600px) {
  .history-page { overflow-y: auto; }
  .workspace, .collection-workspace, .upload-workspace { flex: none; height: 520px; min-height: 520px; }
  .detail-pane { overflow: auto; }
}
@media (max-width: 760px), (max-height: 600px) {
  .history-page.is-production { display: flex; overflow-y: auto; }
  .is-production .production-workspace { flex: none; height: auto; min-height: 0; overflow: visible; }
  .is-production .production-workspace > :deep(.huasheng) { flex: none; }
}
@media (max-width: 760px) {
  .is-production .workspace-tabs { flex-wrap: nowrap; gap: 8px; padding-inline: 12px; overflow-x: auto; }
  .is-production .workspace-tabs > button { padding-inline: 2px; }
}
@media (prefers-reduced-motion: reduce) { .history-page :deep(*) { animation: none !important; transition: none !important; } }
</style>
