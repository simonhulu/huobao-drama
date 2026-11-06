<template>
  <section class="huasheng" :class="{ 'source-panel': isSource }" role="region" :aria-label="isSource ? '当前稿花生制作' : '花生自动制作'">
    <header class="toolbar">
      <slot v-if="!isSource" name="workspace-switcher" />
      <div class="heading">
        <h2 v-if="isSource || !$slots['workspace-switcher']">{{ isSource ? '花生制作' : '视频制作' }}</h2>
        <span v-if="!isSource" class="muted">{{ loaded ? `已加载 ${jobs.length} / ${totalJobs} 项${loadError ? '上次记录' : '任务'}` : '正在读取…' }}</span>
        <span v-else class="source-state" role="status">当前已保存稿：{{ currentJob ? workflowInfo(currentJob).label : loaded && scriptSha256 ? '尚未提交' : '正在读取…' }}</span>
      </div>
      <span v-if="!isSource" class="connection" :class="{ ready: browserReady, uncertain: !browserReady }" role="status"><CircleCheck v-if="browserReady" :size="14" aria-hidden="true" /><CircleAlert v-else :size="14" aria-hidden="true" />{{ browserLabel }}</span>
      <div class="toolbar-actions">
        <button v-if="isSource" data-submit class="control primary" type="button" :disabled="!canSubmit" :aria-busy="productionBusy" @click="submit"><ListChecks v-if="productionActive" :size="15" aria-hidden="true" /><Play v-else :size="15" aria-hidden="true" />{{ productionLabel || (productionBusy ? '正在提交…' : '继续生产') }}</button>
        <button class="control" type="button" :aria-label="inspectLabel" :title="inspectLabel" :disabled="!loaded || busy || !!loadError || productionChecking" @click="checkProduction()"><ListChecks :size="16" aria-hidden="true" /><span>{{ inspectLabel }}</span></button>
        <button class="control icon-control" type="button" aria-label="刷新状态" title="刷新状态" :disabled="busy" @click="refresh"><RefreshCw :size="16" :class="{ spinning: loading }" aria-hidden="true" /></button>
        <button v-if="!isSource" class="control icon-control" type="button" aria-label="制作设置" title="制作设置" :aria-expanded="settingsOpen" :aria-controls="settingsId" @click="toggleSettings"><Settings2 :size="16" aria-hidden="true" /></button>
      </div>
    </header>

    <div v-if="unavailableReason && isSource || loadError || actionError || actionNotice || productionChecking || exportsError || workflowError || isSource && exportsReady && (exportWorker || exportProduction)" class="notices">
      <p v-if="isSource && unavailableReason" class="warning">{{ unavailableReason }}</p>
      <p v-if="loadError" class="error" role="alert">{{ loadError }}。{{ loaded ? '显示上次读取的任务，' : '' }}请刷新状态重试。</p>
      <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
      <p v-if="actionNotice" class="muted" role="status">{{ actionNotice }}</p>
      <p v-if="productionChecking" class="muted" role="status">正在检查创作状态，显示上次检查结果。</p>
      <p v-if="exportsError" class="error" role="alert">{{ exportsError }}。手动下载和上传仍可使用，请刷新状态重试。</p>
      <p v-if="workflowError" class="warning" role="alert">{{ workflowError }}。{{ workflowLoaded ? '显示上次流程状态，' : '发表结果暂未确认，' }}请刷新状态重试。</p>
      <div v-if="isSource && exportsReady && (exportWorker || exportProduction)" class="processing-status">
        <p v-if="exportWorker" :class="exportWorker.status === 'stopped' ? 'warning' : 'muted'" role="status" aria-label="视频交付处理状态" :title="exportWorker.message">{{ exportWorker.status === 'stopped' ? '自动处理未运行' : '自动处理运行中' }}</p>
        <p v-if="exportProduction" class="muted" role="status" aria-label="项目生产并发" title="全局项目生产名额，覆盖导出、下载到标题与封面完成；名额满时仍可提交排队">生产并发：正在生产 {{ exportProduction.activeProjects }}/{{ exportProduction.limit }} · 等待 {{ exportProduction.waitingProjects }}</p>
      </div>
    </div>

    <div v-if="sourceConnectionProblem" class="notices" aria-label="花生连接恢复">
      <p class="warning">同步需要可用的花生登录会话。完成登录后，点击上方“同步花生状态”继续。</p>
      <div class="actions"><button class="control" type="button" @click="emit('manage-accounts')"><Users :size="15" aria-hidden="true" />花生账号</button></div>
    </div>

    <div class="production-body" :class="{ 'show-detail': mobileDetailOpen }">
      <aside v-if="!isSource" class="task-rail" aria-label="制作任务选择">
        <div v-if="!isSource" class="filters">
          <div class="filter-line">
            <div class="status-filters" role="group" aria-label="创作状态筛选">
              <button v-for="filter in productionFilters" :key="filter.value" class="filter" type="button" :aria-pressed="productionFilter === filter.value" @click="productionFilter = filter.value">{{ filter.label }}<span class="count">{{ filter.value === 'all' ? totalJobs : productionCounts[filter.value] }}</span></button>
            </div>
            <div class="queue-tools">
              <select v-model="workflowFilter" class="workflow-filter" aria-label="流程状态筛选"><option v-for="filter in workflowFilters" :key="filter.value" :value="filter.value">{{ filter.label }}（{{ workflowCounts[filter.value] }}）</option></select>
              <div class="attention-filters" role="group" aria-label="阻塞原因筛选">
                <button class="filter attention-filter" type="button" :aria-pressed="attentionOnly" @click="attentionOnly = !attentionOnly"><CircleAlert :size="14" aria-hidden="true" />需要处理<span class="count">{{ attentionCount }}</span></button>
                <button class="filter quota-filter" type="button" :aria-pressed="quotaOnly" @click="quotaOnly = !quotaOnly"><Hourglass :size="14" aria-hidden="true" />标准额度不足<span class="count">{{ quotaCount }}</span></button>
              </div>
              <label class="search"><Search :size="16" aria-hidden="true" /><input v-model="search" type="search" aria-label="搜索制作任务" placeholder="标题、编号、花生链接或项目 ID" /><button v-if="search" class="clear-search" type="button" aria-label="清除搜索" title="清除搜索" @click="search = ''"><X :size="14" aria-hidden="true" /></button></label>
            </div>
          </div>
          <p v-if="quotaCount" class="quota-explanation"><Hourglass :size="14" aria-hidden="true" />标准额度不足的项目尚未进入花生制作队列；额度恢复后，从原项目恢复，继续使用标准模式。</p>
        </div>
        <div class="rail-caption"><span>任务列表 · {{ displayedJobs.length }} 项</span><button class="control mobile-batch" type="button" @click="showBatchActions">批量操作（{{ selectedProjectJobs.length }}）</button></div>
        <ol v-if="displayedJobs.length" ref="taskListElement" class="task-list" aria-label="花生制作队列">
          <li v-for="job in displayedJobs" :key="projectKey(job)" class="task-item" :class="{ active: focusedKey === projectKey(job), selected: selectedProjects.includes(projectKey(job)) }">
            <label v-if="eligibleSelectionJob(job)" class="task-selection"><input type="checkbox" :checked="selectedProjects.includes(projectKey(job))" :disabled="busy || !!loadError" :aria-label="eligibleCheckJob(job) ? `选择任务 #${job.id} 项目` : `选择任务 #${job.id}，尚未绑定花生项目`" @change="toggleProject(job)" /></label>
            <button class="task-preview" type="button" :data-task-key="projectKey(job)" :aria-label="`查看任务 #${job.id} 详情`" :aria-current="focusedKey === projectKey(job) ? 'true' : undefined" @click="focusJob(job)">
              <span class="task-title">{{ job.title || `稿件 #${job.sourceId}` }}</span>
              <span class="task-meta"><span>稿件 #{{ job.sourceId }} · 任务 #{{ job.id }}</span><span class="production-status workflow-status" :class="workflowInfo(job).tone">{{ workflowInfo(job).label }}</span></span>
              <span class="task-summary" :class="{ warning: needsAttention(job) }" :title="taskSummary(job)">{{ taskSummary(job) }}</span>
            </button>
          </li>
        </ol>
        <div v-else class="empty" role="status"><p>{{ !loaded ? loadError ? '任务暂不可用' : '正在读取制作任务…' : projectSearchPending ? '正在查找花生项目…' : jobs.length ? '没有匹配的制作任务' : '暂无制作任务' }}</p><button v-if="hasFilters" class="control" type="button" @click="resetFilters"><X :size="14" aria-hidden="true" />清除筛选</button></div>
        <button v-if="nextBeforeId" class="control load-more" type="button" :disabled="busy || loadingMore" @click="loadMore"><RefreshCw :size="14" :class="{ spinning: loadingMore }" aria-hidden="true" />{{ loadingMore ? '正在加载…' : '加载更多任务' }}</button>
      </aside>
      <div class="detail-workspace">
        <div v-if="!isSource" class="detail-navigation"><button class="control mobile-back" type="button" @click="showTaskList"><ArrowLeft :size="15" aria-hidden="true" />返回任务列表</button><span>项目详情</span><span v-if="focusedJob" class="muted">稿件 #{{ focusedJob.sourceId }} · 任务 #{{ focusedJob.id }}</span></div>
        <div v-if="!isSource && loaded" class="export-batch">
          <div class="selection-line">
            <label class="auto-toggle batch-select"><input type="checkbox" :checked="allVisibleProjectsSelected" :indeterminate="someVisibleProjectsSelected && !allVisibleProjectsSelected" :disabled="busy || !!loadError || !visibleSelectionCandidates.length" aria-label="全选当前筛选中的已加载任务（含未绑定花生项目的任务）" @change="toggleVisibleProjects" />全选当前筛选中的已加载任务</label>
            <span class="muted batch-counts" role="status" aria-label="批量选择计数">已选 {{ selectedProjectJobs.length }} 项 · 可制作 {{ selectedProductionJobs.length }} 项 · 可检查 {{ selectedCheckJobs.length }} 项 · 可生成 {{ selectedExportJobs.length }} 项</span>
            <button class="control pending-select" type="button" title="选择当前筛选中已加载、素材就绪且导出下载或发布材料尚未完成的项目" :disabled="busy || !!loadError || !exportsReady || !pendingDownloadJobs.length" @click="selectPendingDownloads"><ListChecks :size="14" aria-hidden="true" />选择待下载项目（{{ pendingDownloadJobs.length }}）</button>
          </div>
          <div class="batch-actions" role="group" aria-label="对选中任务执行操作">
            <button class="control primary" type="button" :title="productionDisabledReason || '制作花生版和精细化版，各版完成后自动发表'" :disabled="busy || !!loadError || productionChecking || !selectedProductionJobs.length || selectedProductionJobs.length > 100" @click="produceSelected"><Play :size="14" aria-hidden="true" />{{ action === 'produce' ? '正在提交视频制作…' : `批量制作两版（${selectedProductionJobs.length}）` }}</button>
            <button class="control" type="button" :disabled="busy || !!loadError || productionChecking || !selectedCheckJobs.length" @click="checkProduction(true)"><ListChecks :size="14" aria-hidden="true" />检查选中项目状态（{{ selectedCheckJobs.length }}）</button>
            <button class="control" type="button" :title="exportDisabledReason || exportActionTitle" :disabled="busy || !!loadError || !exportsReady || !selectedExportJobs.length" @click="queueExports(selectedExportJobs)"><Download :size="14" aria-hidden="true" />批量下载并准备发布（{{ selectedExportJobs.length }}）</button>
            <button v-if="selectedRetryExportJobs.length" class="control" type="button" :title="exportActionTitle" :disabled="busy || !!loadError || !exportsReady" @click="resumeExports(selectedRetryExportJobs)"><RefreshCw :size="14" aria-hidden="true" />重试下载与发布准备（{{ selectedRetryExportJobs.length }}）</button>
            <button v-if="retryProductionJobs.length || productionResults.some(result => result.status === 'blocked')" class="control" type="button" :disabled="busy || !!loadError || !retryProductionJobs.length" @click="selectFailedProduction"><ListChecks :size="14" aria-hidden="true" />只选失败任务（{{ retryProductionJobs.length }}）</button>
          </div>
          <p v-if="selectedProjectJobs.length && !selectedProductionJobs.length" class="muted batch-limit">{{ productionDisabledReason }}</p>
          <p v-if="selectedProductionJobs.length > 100" class="warning batch-limit" role="alert">单次最多自动生产 100 项，请减少勾选数量。</p>
        </div>
        <div ref="queueElement" class="queue" :aria-busy="loading && !loaded" :tabindex="isSource ? undefined : 0" :aria-label="isSource ? undefined : '制作任务详情'">
          <section v-if="!isSource" v-show="settingsOpen" :id="settingsId" class="settings" aria-label="制作设置">
            <div class="settings-connection">
              <strong>花生连接</strong>
              <p v-if="!loadError && browser?.message" class="muted">{{ browser.message }}</p>
              <div class="actions">
                <button class="control" type="button" @click="emit('manage-accounts')"><Users :size="15" aria-hidden="true" />花生账号</button>
              </div>
            </div>
            <div class="settings-automation">
              <label class="auto-toggle"><input type="checkbox" :checked="enabled" :disabled="!loaded || busy || !!loadError" @change="changeEnabled" />二创成功后自动制作</label>
              <p class="muted">{{ enabled ? '仅新保存的二创稿自动入队。' : '自动入队已关闭；已有任务继续运行。' }}</p>
            </div>
            <div class="settings-automation export-settings">
              <strong>完成后自动发表</strong>
              <p class="muted">新建的两版制作任务会自动下载成片、准备标题与封面，并分别发表到百家号。已有项目可选择后补齐发布材料。</p>
            </div>
          </section>
          <section v-if="!isSource && productionResults.length" class="production-results" aria-label="批量自动生产结果">
            <details open>
              <summary><strong>本次提交结果</strong><span role="status" aria-live="polite">已接纳 {{ productionResultCounts.queued }} · 已跳过 {{ productionResultCounts.skipped }} · 未提交 {{ productionResultCounts.blocked }} · 待核对 {{ productionResultCounts.unconfirmed }}</span></summary>
              <ol class="production-result-list">
                <li v-for="result in productionResults" :key="result.key" :class="result.status" :aria-label="`任务 #${result.jobId} 自动生产结果`">
                  <div class="production-result-identity"><strong>{{ result.title || `稿件 #${result.sourceId}` }}</strong><span class="muted">稿件 #{{ result.sourceId }} · 任务 #{{ result.jobId }}</span></div>
                  <div><strong class="production-result-status">{{ productionResultLabels[result.status] }}</strong><p>{{ result.message }}</p></div>
                </li>
              </ol>
            </details>
            <button v-if="productionResultCounts.unconfirmed" class="control" type="button" :disabled="busy" @click="refresh"><RefreshCw :size="14" aria-hidden="true" />刷新核对任务</button>
          </section>
          <ol v-if="detailJobs.length" class="jobs" :aria-label="isSource ? '当前稿花生任务' : '当前任务详情'">
            <li v-for="job in detailJobs" :key="projectKey(job)" class="job-row">
              <div class="job-identity">
                <strong v-if="isSource" class="version-label">{{ job.scriptSha256 === scriptSha256 ? '当前已保存版本' : '其他已保存版本' }}</strong>
                <NuxtLink v-else v-slot="{ href }" :to="{ path: '/history-scripts', query: { script: String(job.sourceId) } }" custom><a class="job-title" :href="href" @click="openSource($event, job.sourceId)">{{ job.title || `稿件 #${job.sourceId}` }}</a></NuxtLink>
                <span class="job-reference">稿件 #{{ job.sourceId }}<span aria-hidden="true"> · </span>任务 #{{ job.id }}</span>
              </div>
              <div class="job-state">
                <span class="workflow-status" :class="workflowInfo(job).tone" :aria-label="`流程状态：${workflowInfo(job).label}`">{{ workflowInfo(job).label }}</span>
                <span class="production-status" :class="job.productionStatus"><span class="sr-only">创作状态：</span>{{ productionStatusLabel(job) }}</span>
                <span v-if="!(job.status === 'submitted' && job.productionStatus === 'completed')" class="job-status" :class="job.status">{{ statusLabels[job.status] }}</span>
                <span v-if="isQuotaBlocked(job)" class="quota-badge">标准额度不足</span>
              </div>
              <div class="workflow-progress" :aria-label="`任务 #${job.id} 全流程进度`">
                <ol><li v-for="step in workflowSteps(job)" :key="step.label" :class="step.tone"><CircleCheck v-if="step.tone === 'success'" :size="14" aria-hidden="true" /><CircleAlert v-else-if="step.tone === 'error'" :size="14" aria-hidden="true" /><span>{{ step.label }}</span><strong>{{ step.status }}</strong></li></ol>
                <p v-if="workflowInfo(job).stage !== 'production' && workflowInfo(job).message" :class="{ 'workflow-error': workflowInfo(job).tone === 'error' }">{{ workflowInfo(job).message }}</p>
                <div v-if="workflowInfo(job).stage === 'publication' || workflowInfo(job).stage === 'packaging'" class="actions"><button class="control" type="button" @click="emit('open-script', job.sourceId, workflowInfo(job).label === '标题待精简' ? 'delivery' : 'uploads', workflowFor(job)?.videoId ?? undefined)"><FolderOpen :size="14" aria-hidden="true" />{{ workflowInfo(job).label === '标题待精简' ? '编辑发布标题' : '查看发表进度' }}</button></div>
              </div>
              <div class="job-messages">
                <p v-if="job.productionCheckError" class="error" role="alert">检查失败：{{ job.productionCheckError }}。保留上次创作状态。</p>
                <template v-if="isQuotaBlocked(job)">
                  <p class="warning">尚未进入平台队列，待额度恢复后继续标准模式。</p>
                  <details class="status-record">
                    <summary>查看状态记录</summary>
                    <p v-if="job.error" class="error">{{ job.error }}</p>
                    <p v-if="job.productionMessage && job.productionMessage !== job.error">{{ job.productionMessage }}</p>
                    <p v-if="job.message && job.message !== job.productionMessage && job.message !== job.error" class="muted">{{ job.message }}</p>
                  </details>
                </template>
                <template v-else>
                  <p v-if="job.error" class="error">{{ job.error }}</p>
                  <p v-if="job.productionMessage && job.productionMessage !== job.error" class="row-message" :title="job.productionMessage">{{ job.productionMessage }}</p>
                  <p v-if="job.message && job.message !== job.productionMessage && job.message !== job.error" class="row-message muted" :title="job.message">{{ job.message }}</p>
                  <span v-if="!job.error && !job.productionCheckError && !job.productionMessage && !job.message" class="muted">暂无消息</span>
                </template>
              </div>
              <div class="job-checked"><time v-if="job.productionCheckedAt" :datetime="job.productionCheckedAt">{{ checkedTime(job.productionCheckedAt) }}</time><span v-else class="muted">尚未检查</span><span v-if="job.productionCheckError || loadError" class="warning">上次记录</span></div>
              <div class="job-commands actions">
                <button v-if="!isSource && eligibleCheckJob(job)" class="control" type="button" :disabled="busy || !!loadError || productionChecking" @click="checkProduction(true, job)"><ListChecks :size="14" aria-hidden="true" />检查当前项目状态</button>
                <button v-if="eligibleExportJob(job)" class="control" type="button" :title="exportActionTitle" :disabled="busy || !!loadError || !exportsReady" @click="queueExports([job])"><Download :size="14" aria-hidden="true" />下载并准备发布</button>
                <button v-if="!isSource" class="control" type="button" aria-label="查看稿件与产物" title="查看稿件与产物" @click="emit('open-script', job.sourceId, 'delivery')"><FolderOpen :size="14" aria-hidden="true" /><span>产物</span></button>
                <button v-if="!isSource && job.productionStatus === 'completed'" class="control icon-control" type="button" aria-label="上传此项目" title="上传此项目" @click="emit('open-script', job.sourceId, 'uploads')"><Upload :size="15" aria-hidden="true" /></button>
                <button v-if="huashengProjectUrl(job.projectUrl)" class="control project-link" type="button" :disabled="busy" :aria-label="job.productionStatus === 'completed' ? '下载视频，打开花生项目' : '打开花生项目'" :title="job.productionStatus === 'completed' ? '在原账号打开花生项目下载视频' : '在原账号打开花生项目'" @click="openProject(job)"><RefreshCw v-if="action === `open-project-${job.id}`" :size="14" class="spinning" aria-hidden="true" /><Download v-else-if="job.productionStatus === 'completed'" :size="14" aria-hidden="true" /><ExternalLink v-else :size="14" aria-hidden="true" /><span>{{ action === `open-project-${job.id}` ? '正在打开…' : job.productionStatus === 'completed' ? '下载' : '项目' }}</span></button>
                <button v-if="huashengProjectUrl(job.videoUrl)" class="control icon-control" type="button" :disabled="busy" aria-label="查看制作结果" title="在原账号查看制作结果" @click="openProject(job)"><RefreshCw v-if="action === `open-project-${job.id}`" :size="15" class="spinning" aria-hidden="true" /><Film v-else :size="15" aria-hidden="true" /></button>
                <a v-else-if="safeUrl(job.videoUrl)" class="control icon-control" :href="safeUrl(job.videoUrl)" target="_blank" rel="noopener noreferrer" aria-label="查看制作结果" title="查看制作结果"><Film :size="15" aria-hidden="true" /></a>
                <button v-if="canResume(job) && !requiresProjectLink(job)" class="control resume" type="button" :disabled="resumeDisabled(job)" @click="jobAction(job, 'resume')"><Play :size="13" aria-hidden="true" />恢复</button>
                <button v-if="canCancel(job)" class="control icon-control" type="button" :aria-label="`任务 #${job.id} 的更多操作`" title="更多操作" :aria-expanded="expandedJob === String(job.id)" @click="expandedJob = expandedJob === String(job.id) ? '' : String(job.id)"><MoreHorizontal :size="16" aria-hidden="true" /></button>
              </div>
              <section v-if="exportFor(job)" class="export-result" :aria-label="`稿件 #${job.sourceId} 自动生成产物状态`">
                <div class="export-heading" role="status" aria-live="polite"><strong>{{ exportStatusLabel(exportFor(job)!) }}</strong><span v-if="exportFor(job)!.message || needsProductRepair(exportFor(job)!)">{{ exportMessage(exportFor(job)!) }}</span></div>
                <p v-if="exportWorker?.status === 'stopped' && isActiveExport(exportFor(job)!)" class="warning" :title="exportWorker.message">自动处理未运行，可点击“下载并准备发布”继续。</p>
                <div v-if="exportFor(job)!.status === 'exporting' && exportPercent(exportFor(job)!) !== null" class="export-meter"><progress :value="exportPercent(exportFor(job)!)!" max="100" aria-label="花生导出进度" /><span>导出 {{ exportPercent(exportFor(job)!) }}%</span></div>
                <div v-if="exportFor(job)!.status === 'downloading' || exportFor(job)!.downloadedBytes" class="export-meter" role="status"><progress v-if="exportFor(job)!.status === 'downloading' && (exportFor(job)!.totalBytes || 0) > 0" :value="exportFor(job)!.downloadedBytes || 0" :max="exportFor(job)!.totalBytes!" aria-label="视频下载进度" /><span>已下载 {{ formatBytes(exportFor(job)!.downloadedBytes) }}<template v-if="(exportFor(job)!.totalBytes || 0) > 0"> / {{ formatBytes(exportFor(job)!.totalBytes) }}</template></span></div>
                <dl class="export-products"><div><dt>文案与封面方案</dt><dd>{{ productStatus(exportFor(job)!.designStatus, 'design') }}</dd></div><div><dt>三种尺寸封面图片</dt><dd>{{ productStatus(exportFor(job)!.coverStatus, 'covers') }}</dd></div></dl>
                <p v-if="exportFor(job)!.status === 'waiting_login'" class="warning" role="status">{{ exportWorker?.status === 'running' ? '请在花生登录窗口完成登录，原任务将自动继续。' : '请先完成花生登录，再点击“下载并准备发布”继续。' }}</p>
                <p v-if="exportFor(job)!.stage === 'export_uncertain'" class="warning" role="status">导出提交结果未确认，请核对原花生项目；不会重复提交导出。</p>
                <p v-if="exportFor(job)!.error && ['failed', 'needs_attention', 'waiting_login'].includes(exportFor(job)!.status)" class="error" role="alert">{{ exportFor(job)!.error }}</p>
                <p v-if="exportFor(job)!.updatedAt" class="muted">发布准备更新于 <time :datetime="exportFor(job)!.updatedAt">{{ checkedTime(exportFor(job)!.updatedAt) }}</time></p>
                <div class="actions">
                  <a v-if="downloadedVideoUrl(exportFor(job)!)" class="control" :href="downloadedVideoUrl(exportFor(job)!)" target="_blank" rel="noopener noreferrer"><Film :size="14" aria-hidden="true" />查看已下载视频</a>
                  <button v-if="exportFor(job)!.designStatus" class="control" type="button" @click="emit('open-script', job.sourceId, 'delivery')"><FolderOpen :size="14" aria-hidden="true" />查看文案与封面方案</button>
                  <button v-if="exportFor(job)!.coverStatus === 'completed'" class="control" type="button" @click="emit('open-script', job.sourceId, 'delivery')"><FolderOpen :size="14" aria-hidden="true" />查看封面图片</button>
                  <button v-if="exportFor(job)!.status === 'waiting_login'" class="control" type="button" @click="emit('manage-accounts')"><Users :size="14" aria-hidden="true" />花生账号</button>
                  <button v-if="exportFor(job)!.stage === 'export_uncertain' && huashengProjectUrl(exportFor(job)!.projectUrl)" class="control" type="button" :disabled="busy" @click="openProject(job)"><RefreshCw v-if="action === `open-project-${job.id}`" :size="14" class="spinning" aria-hidden="true" /><ExternalLink v-else :size="14" aria-hidden="true" />核对原花生项目</button>
                  <button v-if="canResumeExport(exportFor(job)!)" class="control" type="button" :title="exportActionTitle" :disabled="busy || !!loadError || !exportsReady" @click="resumeExports([exportFor(job)!])"><RefreshCw :size="13" aria-hidden="true" />{{ needsProductRepair(exportFor(job)!) ? '补齐产物' : '重试下载与发布准备' }}</button>
                </div>
                <p class="muted">也可打开花生项目下载视频，再到「成片交付」手动上传。</p>
              </section>
              <div v-if="canCancel(job) && expandedJob === String(job.id)" class="job-more"><span class="muted">任务 #{{ job.id }}</span><button class="control danger" type="button" :disabled="busy || job.cancelRequested" @click="jobAction(job, 'cancel')"><Square :size="13" aria-hidden="true" />{{ job.cancelRequested ? '正在停止…' : '取消任务' }}</button></div>
              <details v-if="canResume(job) && requiresProjectLink(job)" class="recovery">
                <summary>绑定已有花生项目</summary>
                <p class="muted">先点击“同步花生状态”自动查找原项目；无法确认时，可在<button class="project-home" type="button" :disabled="busy" @click="openProject(job)"><RefreshCw v-if="action === `open-project-${job.id}`" :size="12" class="spinning" aria-hidden="true" />花生我的项目</button>核对并绑定已有项目。</p>
                <form @submit.prevent="jobAction(job, 'resume')">
                  <label>已有花生项目链接<input v-model="projectUrls[String(job.id)]" type="url" placeholder="https://www.huasheng.cn/video/…" :disabled="resumeDisabled(job)" /></label>
                  <button class="control" type="submit" :disabled="resumeDisabled(job) || !existingProjectUrl(job)"><Link2 :size="14" aria-hidden="true" />绑定并恢复</button>
                </form>
                <p v-if="projectUrls[String(job.id)] && !existingProjectUrl(job)" class="warning">请填写 https://www.huasheng.cn/video/数字编号 格式的项目链接。</p>
              </details>
            </li>
          </ol>
          <div v-else class="empty"><p>{{ isSource ? !loaded ? loadError ? '任务暂不可用' : '正在读取制作任务…' : '当前稿件暂无制作任务' : '选择左侧任务，查看制作进度与产物' }}</p></div>
        </div>
      </div>
    </div>
    <footer v-if="!isSource && loaded" class="queue-footer">
      <span>{{ loadError ? '上次读取' : '已加载' }} {{ jobs.length }} 项<span v-if="hasFilters"> · 匹配 {{ displayedJobs.length }} 项</span></span>
      <div v-if="exportsReady && (exportWorker || exportProduction)" class="processing-status">
        <span v-if="exportWorker" :class="exportWorker.status === 'stopped' ? 'warning' : 'muted'" role="status" aria-label="视频交付处理状态" :title="exportWorker.message">{{ exportWorker.status === 'stopped' ? '自动处理未运行' : '自动处理运行中' }}</span>
        <span v-if="exportProduction" role="status" aria-label="项目生产并发" title="全局项目生产名额，覆盖导出、下载到标题与封面完成；名额满时仍可提交排队">生产并发：正在生产 {{ exportProduction.activeProjects }}/{{ exportProduction.limit }} · 等待 {{ exportProduction.waitingProjects }}</span>
      </div>
      <label class="monitor-toggle" :title="monitorTitle"><input type="checkbox" :checked="monitoring?.enabled ?? false" :disabled="!monitoring || busy || !!loadError" @change="changeMonitoring" /><span>循环监测</span><span v-if="monitoring?.enabled" class="monitor-interval">60 秒</span></label>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ArrowLeft, CircleAlert, CircleCheck, Download, ExternalLink, Film, FolderOpen, Hourglass, Link2, ListChecks, MoreHorizontal, Newspaper, Play, RefreshCw, Search, Settings2, Square, Upload, Users, X } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

type JobStatus = 'queued' | 'running' | 'waiting_login' | 'needs_attention' | 'submitted' | 'failed' | 'canceled'
type ProductionStatus = 'not_started' | 'queued' | 'creating' | 'completed'
type BrowserState = { status: 'ready' | 'login_required' | 'unavailable'; message: string }
type Job = { id: number | string; sourceId: number | string; title: string; status: JobStatus; stage: string; checkpoint?: string | null; message: string; projectUrl?: string | null; videoUrl?: string | null; error?: string | null; createdAt: string; updatedAt: string; scriptSha256: string; cancelRequested?: boolean; productionStatus: ProductionStatus; productionCheckedAt: string | null; productionMessage: string; productionCheckError: string | null; workflowLabel?: string; workflowTone?: string }
type WorkflowStage = 'production' | 'export' | 'packaging' | 'publication'
type WorkflowGroup = WorkflowStage | 'submitted' | 'published' | 'attention' | 'unknown'
type WorkflowVersion = { scriptId: number; scriptSha256: string | null; producer: string; producerJobId: string | null; videoId: number | null; exportJobId: number | null; state: string; stage: WorkflowStage; message: string; error: string | null; automatic: boolean; materialsReady: boolean }
type WorkflowInfo = { label: string; group: WorkflowGroup; stage: WorkflowStage; tone: 'success' | 'active' | 'error' | 'neutral'; message: string }
type SourceOverview = { jobs: Job[]; productionChecking?: boolean; nextBeforeId?: number | null; total?: number; counts?: Partial<Record<JobStatus, number>>; productionCounts?: Record<ProductionStatus, number> }
type Monitoring = { enabled: boolean; intervalMs: number; lastCheckedAt: string | null; nextCheckAt: string | null }
type Overview = SourceOverview & { enabled: boolean; browser: BrowserState; productionChecking: boolean; monitoring?: Monitoring }
type ExportStatus = 'queued' | 'exporting' | 'downloading' | 'processing' | 'completed' | 'waiting_login' | 'failed' | 'needs_attention'
type ProductStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'needs_attention'
type ExportJob = { id: number | string; huashengJobId: number | string; sourceId: number | string; scriptSha256: string; projectUrl: string; status: ExportStatus; stage: string; message: string; error: string | null; exportProgress: number | null; downloadedBytes: number | null; totalBytes: number | null; videoUrl: string | null; designStatus: ProductStatus | null; coverStatus?: ProductStatus | null; articleStatus: ProductStatus | null; createdAt: string; updatedAt: string }
type ExportWorker = { status: 'running' | 'stopped'; message: string }
type ExportProduction = { limit: number; activeProjects: number; waitingProjects: number }
type ProductionResultStatus = 'queued' | 'skipped' | 'blocked' | 'unconfirmed'
type ProductionResult = { jobId: number; sourceId: number; status: ProductionResultStatus; message: string; key: string; title: string }
const props = defineProps<{ sourceId?: number | string; accountsRevision?: number; scriptText?: string; scriptRevision?: string; scriptCurrent?: boolean; dirty?: boolean; sourceBusy?: boolean; productionBusy?: boolean; productionLabel?: string; productionDisabled?: boolean; productionActive?: boolean; blockedSourceId?: number | string }>()
const emit = defineEmits<{ overview: [value: { total: number; attention: number; quota: number; queued: number; creating: number; completed: number; jobs: Job[] }]; 'continue-production': []; 'open-script': [sourceId: number | string, tab?: 'script' | 'delivery' | 'article' | 'uploads', videoId?: number]; 'manage-accounts': [] }>()
const isSource = computed(() => props.sourceId !== undefined)
const base = '/history-scripts/huasheng'
const readTimeoutMs = 15_000
const writeTimeoutMs = 30_000
const exportActionTitle = '下载视频，准备百家号标题和封面；复用已有视频与发布材料，从原任务继续'
const endpoint = computed(() => isSource.value ? `/history-scripts/${encodeURIComponent(String(props.sourceId))}/huasheng` : base)
const statusLabels: Record<JobStatus, string> = { queued: '等待提交花生', running: '自动操作中', waiting_login: '等待登录', needs_attention: '需要处理', submitted: '已进入创作', failed: '任务失败', canceled: '已取消' }
const productionLabels: Record<ProductionStatus, string> = { not_started: '未开始', queued: '排队中', creating: '创作中', completed: '素材就绪' }
const loadedJobs = ref<Job[]>([])
const jobs = computed(() => loadedJobs.value.filter(job => !(job.status === 'canceled' && job.stage === 'record_cleanup')))
const serverTotal = ref<number | null>(null)
const serverProductionCounts = ref<Record<ProductionStatus, number> | null>(null)
const nextBeforeId = ref<number | null>(null)
const loadingMore = ref(false)
const browser = ref<BrowserState | null>(null)
const enabled = ref(true)
const exportJobs = ref<ExportJob[]>([])
const exportWorker = ref<ExportWorker | null>(null)
const exportProduction = ref<ExportProduction | null>(null)
const exportsLoaded = ref(false)
const exportsError = ref('')
const workflowVersions = ref<WorkflowVersion[]>([])
const workflowLoaded = ref(false)
const workflowError = ref('')
const selectedProjects = ref<string[]>([])
const productionResults = ref<ProductionResult[]>([])
const productionResultLabels: Record<ProductionResultStatus, string> = { queued: '已加入本次执行', skipped: '已跳过', blocked: '未提交，需要处理', unconfirmed: '结果待核对' }
const productionResultCounts = computed(() => Object.fromEntries(Object.keys(productionResultLabels).map(status => [status, productionResults.value.filter(result => result.status === status).length])) as Record<ProductionResultStatus, number>)
const exportStatusLabels: Record<ExportStatus, string> = { queued: '等待自动导出', exporting: '正在导出视频', downloading: '正在下载视频', processing: '正在准备发布', completed: '发布准备完成', waiting_login: '等待花生登录', failed: '发布准备失败', needs_attention: '发布准备需要处理' }
const exportsReady = computed(() => exportsLoaded.value && !exportsError.value)
const monitoring = ref<Monitoring | null>(null)
const monitorTitle = computed(() => !monitoring.value ? '循环监测暂不可用' : monitoring.value.enabled
  ? monitoring.value.nextCheckAt ? `下次检查：${checkedTime(monitoring.value.nextCheckAt)}` : '后台循环监测已开启'
  : '开启后台循环监测未完成的视频')
const loaded = ref(false)
const productionChecking = ref(false)
const loading = ref(false)
const action = ref('')
const loadError = ref('')
const actionError = ref('')
const actionNotice = ref('')
const sourceConnectionProblem = computed(() => isSource.value && jobs.value.some(job => /浏览器|登录|Chrome|调试端口/i.test(job.productionCheckError || '')))
const projectUrls = ref<Record<string, string>>({})
const scriptSha256 = ref('')
const hashError = ref('')
const settingsId = useId()
const settingsOpen = ref(false)
const queueElement = ref<HTMLElement | null>(null)
const taskListElement = ref<HTMLElement | null>(null)
const focusedKey = ref('')
const mobileDetailOpen = ref(false)
async function toggleSettings() {
  settingsOpen.value = !settingsOpen.value
  if (!settingsOpen.value) return
  mobileDetailOpen.value = true
  await nextTick()
  const queue = queueElement.value
  if (!queue) return
  queue.scrollTop = 0
  if (getComputedStyle(queue).overflowY === 'visible') {
    queue.querySelector('.settings')?.scrollIntoView({ block: 'nearest' })
  }
}
const search = ref('')
const projectSearchId = computed(() => {
  const query = search.value.trim().replace(/^#/, '')
  return /^\d+$/.test(query) ? query : huashengProjectId(query)
})
const projectSearchPending = computed(() => !!projectSearchId.value && !!nextBeforeId.value && !loadError.value)
const productionFilter = ref<'all' | ProductionStatus>('all')
const workflowFilter = ref<'all' | WorkflowGroup>('all')
const workflowFilters: { value: 'all' | WorkflowGroup; label: string }[] = [{ value: 'all', label: '全部流程' }, { value: 'production', label: '花生制作' }, { value: 'export', label: '导出下载' }, { value: 'packaging', label: '标题封面' }, { value: 'publication', label: '等待或正在提交' }, { value: 'submitted', label: '审核中' }, { value: 'published', label: '已发表' }, { value: 'attention', label: '失败或待处理' }, { value: 'unknown', label: '状态未确认' }]
const workflowCounts = computed(() => Object.fromEntries(workflowFilters.map(filter => [filter.value, filter.value === 'all' ? jobs.value.length : jobs.value.filter(job => workflowInfo(job).group === filter.value).length])) as Record<'all' | WorkflowGroup, number>)
const attentionOnly = ref(false)
const quotaOnly = ref(false)
const expandedJob = ref('')
const productionFilters: { value: 'all' | ProductionStatus; label: string }[] = [{ value: 'all', label: '全部' }, ...Object.entries(productionLabels).map(([value, label]) => ({ value: value as ProductionStatus, label }))]
const busy = computed(() => loading.value || loadingMore.value || !!action.value)
const inspectLabel = computed(() => productionChecking.value || action.value === 'production' ? '同步花生状态中…' : '同步花生状态')
const browserReady = computed(() => !loadError.value && browser.value?.status === 'ready')
const browserLabel = computed(() => {
  if (loadError.value) return '连接未确认'
  if (!loaded.value) return '正在读取连接状态'
  return browserReady.value ? '连接已就绪' : browser.value?.status === 'login_required' ? '需要登录' : '浏览器不可用'
})
const orderedJobs = computed(() => [...jobs.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const attentionCount = computed(() => jobs.value.filter(needsAttention).length)
const quotaCount = computed(() => jobs.value.filter(isQuotaBlocked).length)
const inventoryComplete = computed(() => isSource.value || !nextBeforeId.value)
const totalJobs = computed(() => inventoryComplete.value ? jobs.value.length : serverTotal.value ?? jobs.value.length)
const productionCounts = computed(() => !inventoryComplete.value && serverProductionCounts.value ? serverProductionCounts.value : Object.fromEntries(Object.keys(productionLabels).map(status => [status, jobs.value.filter(job => job.productionStatus === status).length])) as Record<ProductionStatus, number>)
const hasFilters = computed(() => productionFilter.value !== 'all' || workflowFilter.value !== 'all' || attentionOnly.value || quotaOnly.value || !!search.value.trim())
const displayedJobs = computed(() => {
  if (isSource.value) return orderedJobs.value
  const query = search.value.trim().toLocaleLowerCase()
  return orderedJobs.value.filter(job => (productionFilter.value === 'all' || job.productionStatus === productionFilter.value)
    && (workflowFilter.value === 'all' || workflowInfo(job).group === workflowFilter.value)
    && (!attentionOnly.value || needsAttention(job)) && (!quotaOnly.value || isQuotaBlocked(job))
    && (!query || `${job.title || ''} ${job.sourceId} ${job.id}`.toLocaleLowerCase().includes(query.replace(/^#/, ''))
      || !!projectSearchId.value && [job.projectUrl, job.videoUrl].some(url => huashengProjectId(url) === projectSearchId.value)))
})
watch([projectSearchId, workflowFilter, busy, nextBeforeId, loaded, loadError], (_value, _previous, onCleanup) => {
  if (isSource.value || !(projectSearchPending.value || workflowFilter.value !== 'all' && nextBeforeId.value && !loadError.value) || busy.value || !loaded.value) return
  const timeout = setTimeout(() => { void loadMore() }, 250)
  onCleanup(() => clearTimeout(timeout))
})
const focusedJob = computed(() => displayedJobs.value.find(job => projectKey(job) === focusedKey.value))
const detailJobs = computed(() => isSource.value ? displayedJobs.value : focusedJob.value ? [focusedJob.value] : [])
watch(displayedJobs, visible => {
  if (!visible.some(job => projectKey(job) === focusedKey.value)) focusedKey.value = visible[0] ? projectKey(visible[0]) : ''
}, { immediate: true })
async function focusJob(job: Job) {
  focusedKey.value = projectKey(job)
  mobileDetailOpen.value = true
  settingsOpen.value = false
  await nextTick()
  if (queueElement.value) queueElement.value.scrollTop = 0
  if (window.matchMedia('(max-width: 760px)').matches) {
    queueElement.value?.focus({ preventScroll: true })
    queueElement.value?.closest('.detail-workspace')?.scrollIntoView({ block: 'start' })
  }
}
async function showBatchActions() {
  mobileDetailOpen.value = true
  await nextTick()
  queueElement.value?.parentElement?.querySelector<HTMLInputElement>('.batch-select input')?.focus()
}
async function showTaskList() {
  mobileDetailOpen.value = false
  await nextTick()
  const button = Array.from(taskListElement.value?.querySelectorAll<HTMLButtonElement>('.task-preview') || [])
    .find(element => element.dataset.taskKey === focusedKey.value)
  button?.focus({ preventScroll: true })
  button?.scrollIntoView({ block: 'nearest' })
}
function productionStatusLabel(job: Job) {
  if ([job.stage, job.checkpoint].includes('create_pending')) return '花生结果待核对'
  return productionLabels[job.productionStatus] || '未检查'
}
function workflowFor(job: Job) {
  return workflowVersions.value.find(version => version.producer === 'huasheng' && String(version.scriptId) === String(job.sourceId)
    && version.scriptSha256 === job.scriptSha256 && (version.producerJobId !== null
      ? version.producerJobId === String(job.id)
      : version.exportJobId !== null ? String(exportFor(job)?.id) === String(version.exportJobId)
        : !jobs.value.some(other => String(other.sourceId) === String(job.sourceId) && other.scriptSha256 === job.scriptSha256 && other.status !== 'canceled' && Number(other.id) > Number(job.id))))
}
function workflowInfo(job: Job): WorkflowInfo {
  const version = workflowFor(job)
  const output = exportFor(job)
  const info = (label: string, group: WorkflowGroup, stage: WorkflowStage, tone: WorkflowInfo['tone'], message: string): WorkflowInfo => ({ label, group, stage, tone, message })
  if (version) {
    const message = [...new Set([version.message, version.error].filter(Boolean))].join('；')
    if (version.state === 'published') return info('已发表', 'published', 'publication', 'success', message)
    if (version.state === 'submitted') return info('已提交审核', 'submitted', 'publication', 'success', message)
    if (version.state === 'uncertain') return info('发表待核对', 'attention', 'publication', 'error', message)
    if (version.state === 'stale') return info('稿件版本待核对', 'attention', version.stage, 'error', message)
    if (version.state === 'attention') {
      const titleTooLong = /50\s*字|发布标题.{0,8}超限/.test(message)
      const label = titleTooLong ? '标题待精简' : version.stage === 'publication' ? '提交失败'
        : version.stage === 'packaging' ? '标题封面失败' : version.stage === 'export' ? output?.status === 'waiting_login' ? '等待花生登录' : '导出下载失败' : '制作待处理'
      return info(label, 'attention', titleTooLong ? 'packaging' : version.stage, 'error', message)
    }
    if (version.state === 'uploading') return info('正在提交百家号', 'publication', 'publication', 'active', message)
    if (version.state === 'queued') return info('等待提交百家号', 'publication', 'publication', 'active', message)
    if (version.state === 'ready') return info(version.automatic ? '等待自动提交' : '待提交百家号', 'publication', 'publication', 'active', message)
    if (version.state === 'packaging') return info('准备标题封面', 'packaging', 'packaging', 'active', message)
  }
  if (output) {
    const message = output.error || exportMessage(output) || exportStatusLabel(output)
    if (['failed', 'needs_attention'].includes(output.status)) return info(output.stage === 'export_uncertain' ? '导出待核对'
      : output.stage === 'processing' || output.stage === 'products_repair' ? '标题封面失败' : '导出下载失败', 'attention', output.stage === 'processing' || output.stage === 'products_repair' ? 'packaging' : 'export', 'error', message)
    if (output.status === 'waiting_login') return info('等待花生登录', 'attention', 'export', 'error', message)
    if (output.status === 'processing') return info('准备标题封面', 'packaging', 'packaging', 'active', message)
    if (needsProductRepair(output)) return info('产物待补齐', 'attention', 'packaging', 'error', message)
    if (output.status === 'completed') return info(workflowError.value ? '发表状态未确认' : '发布材料就绪', 'unknown', 'publication', 'neutral', workflowError.value || '视频和发布材料已完成，尚未读取到本版百家号提交回执')
    if (output.stage !== 'waiting_production' || job.productionStatus === 'completed') return info(output.status === 'downloading' ? '下载中' : output.status === 'exporting' ? '导出中' : '等待导出', 'export', 'export', 'active', message)
  }
  if (version?.state === 'exporting') return info(version.exportJobId === null ? '等待导出' : '导出下载中', 'export', 'export', 'active', version.message)
  if (job.productionStatus === 'completed') return info(workflowError.value ? '流程状态未确认' : workflowLoaded.value ? '等待导出' : '读取后续状态', workflowError.value ? 'unknown' : 'export', 'export', 'neutral', workflowError.value || '花生素材已就绪，尚未取得本版成片导出和发表完成记录')
  return info(productionStatusLabel(job) === '未开始' ? statusLabels[job.status] : productionStatusLabel(job), needsProductionAttention(job) ? 'attention' : 'production', 'production', needsProductionAttention(job) ? 'error' : job.productionStatus === 'not_started' ? 'neutral' : 'active', job.error || job.productionCheckError || job.productionMessage || job.message)
}
function workflowSteps(job: Job) {
  const info = workflowInfo(job)
  const stages: WorkflowStage[] = ['production', 'export', 'packaging', 'publication']
  const labels = ['花生制作', '导出下载', '标题封面', '百家号发表']
  const current = stages.indexOf(info.stage)
  const submitted = ['submitted', 'published'].includes(info.group)
  return stages.map((stage, index) => ({ label: labels[index],
    status: submitted || index < current || index === 0 && job.productionStatus === 'completed' ? index === 3 ? info.label : '已完成'
      : index === current ? info.label : '等待',
    tone: submitted || index < current || index === 0 && job.productionStatus === 'completed' ? 'success' : index === current ? info.tone : 'neutral',
  }))
}
function taskSummary(job: Job) {
  const info = workflowInfo(job)
  if (info.stage !== 'production') return info.message || info.label
  if (job.productionCheckError) return `检查失败：${job.productionCheckError}`
  if (isQuotaBlocked(job)) return '标准额度不足，等待恢复'
  const output = exportFor(job)
  if (output) return output.error || exportMessage(output) || exportStatusLabel(output)
  return job.error || job.productionMessage || job.message || statusLabels[job.status]
}
const visibleSelectionCandidates = computed(() => displayedJobs.value.filter(eligibleSelectionJob))
const selectedProjectJobs = computed(() => visibleSelectionCandidates.value.filter(job => selectedProjects.value.includes(projectKey(job))))
const selectedCheckJobs = computed(() => selectedProjectJobs.value.filter(eligibleCheckJob))
const selectedExportJobs = computed(() => selectedProjectJobs.value.filter(eligibleExportJob))
const selectedRetryExportJobs = computed(() => selectedProjectJobs.value.map(exportFor).filter((job): job is ExportJob => !!job && canResumeExport(job)))
const pendingDownloadJobs = computed(() => visibleSelectionCandidates.value.filter(job => eligibleExportJob(job) || !!exportFor(job) && canResumeExport(exportFor(job)!)))
const selectedProductionJobs = computed(() => selectedProjectJobs.value.filter(eligibleProductionJob))
const productionDisabledReason = computed(() => {
  if (!selectedProjectJobs.value.length) return '请先勾选需要制作视频的任务'
  if (selectedProjectJobs.value.every(job => job.productionStatus === 'completed')) return '所选项目素材就绪，可继续导出下载与发布准备。'
  if (!selectedProductionJobs.value.length) return '所选任务已提交、正在运行或需要先处理稿件，不能重复制作'
  if (selectedProductionJobs.value.length > 100) return '单次最多制作 100 项，请减少勾选数量'
  return ''
})
const exportDisabledReason = computed(() => {
  if (!exportsReady.value) return '下载与发布材料状态尚未读取成功，请刷新状态'
  if (!selectedProjectJobs.value.length) return '请先勾选素材就绪的项目，或点击“选择待下载项目”'
  if (selectedExportJobs.value.length) return ''
  if (selectedRetryExportJobs.value.length) return '所选下载或发布准备任务失败，请点击“重试下载与发布准备”'
  if (selectedProjectJobs.value.some(job => exportFor(job)?.stage === 'export_uncertain')) return '导出结果待核对，请打开原花生项目确认；不会重复提交'
  if (selectedProjectJobs.value.every(job => { const output = exportFor(job); return output && productsCompleted(output) })) return '所选项目的视频、标题与封面已完成'
  return '仅可导出下载素材就绪的最新已保存版本；请先处理稿件或等待素材就绪'
})
const retryProductionJobs = computed(() => visibleSelectionCandidates.value.filter(job => eligibleProductionJob(job)
  && productionResults.value.some(result => result.key === projectKey(job) && (result.status === 'blocked'
    || result.status === 'queued' && ['failed', 'needs_attention'].includes(job.status)))))
const allVisibleProjectsSelected = computed(() => visibleSelectionCandidates.value.length > 0 && selectedProjectJobs.value.length === visibleSelectionCandidates.value.length)
const someVisibleProjectsSelected = computed(() => selectedProjectJobs.value.length > 0)
watch(visibleSelectionCandidates, visible => {
  const keys = new Set(visible.map(projectKey))
  selectedProjects.value = selectedProjects.value.filter(key => keys.has(key))
})
const overview = computed(() => ({ total: totalJobs.value, attention: attentionCount.value, quota: quotaCount.value, queued: productionCounts.value.queued, creating: productionCounts.value.creating, completed: productionCounts.value.completed, jobs: jobs.value.map(job => ({ ...job, workflowLabel: workflowInfo(job).label, workflowTone: workflowInfo(job).tone })) }))
watch([overview, loaded], () => { if (!isSource.value && loaded.value) emit('overview', overview.value) })
const currentJob = computed(() => scriptSha256.value ? orderedJobs.value.find(job => job.scriptSha256 === scriptSha256.value) : undefined)
const unavailableReason = computed(() => {
  if (props.dirty) return '请先保存当前修改，再继续生产。'
  if (props.sourceBusy) return '稿件正在读取或处理，完成后再提交。'
  if (!props.scriptText?.trim() || !props.scriptRevision) return '二创稿尚未就绪，可点击“继续生产”补齐。'
  if (!props.scriptCurrent) return '当前稿已过期或来源版本未确认，可点击“继续生产”处理。'
  if (hashError.value) return hashError.value
  return ''
})
const canSubmit = computed(() => isSource.value && (props.productionLabel ? !props.productionDisabled
  : loaded.value && !busy.value && !props.productionBusy && !loadError.value && !props.dirty && !props.sourceBusy))
let mounted = false
let timer: ReturnType<typeof setTimeout> | undefined
let pending: Promise<void> | undefined
let hashRequest = 0

function projectKey(job: Job) { return `${job.sourceId}:${job.id}:${job.scriptSha256}` }
function eligibleSelectionJob(job: Job) {
  return Number.isSafeInteger(Number(job.id)) && Number(job.id) > 0 && Number.isSafeInteger(Number(job.sourceId)) && Number(job.sourceId) > 0
}
function eligibleCheckJob(job: Job) {
  return eligibleSelectionJob(job) && (!!huashengProjectUrl(job.projectUrl) || [job.stage, job.checkpoint].includes('create_pending'))
}
function eligibleProductionJob(job: Job) {
  return eligibleSelectionJob(job) && job.productionStatus === 'not_started'
    && ['queued', 'waiting_login', 'needs_attention', 'failed', 'canceled'].includes(job.status)
    && (!job.cancelRequested || job.status === 'canceled') && String(props.blockedSourceId) !== String(job.sourceId)
}
function exportFor(job: Job) {
  return exportJobs.value.find(item => String(item.huashengJobId) === String(job.id) && String(item.sourceId) === String(job.sourceId) && item.scriptSha256 === job.scriptSha256)
}
function eligibleExportProject(job: Job) {
  if (job.productionStatus !== 'completed' || !eligibleCheckJob(job) || !huashengProjectUrl(job.projectUrl)) return false
  if (String(props.blockedSourceId) === String(job.sourceId) || isSource.value && (unavailableReason.value || job.scriptSha256 !== scriptSha256.value)) return false
  // The enqueue API accepts source IDs, so an old row must never enqueue a newer version.
  return !jobs.value.some(other => String(other.sourceId) === String(job.sourceId) && (other.createdAt > job.createdAt || other.createdAt === job.createdAt && Number(other.id) > Number(job.id)))
}
function isActiveExport(job: ExportJob) {
  return job.stage !== 'export_uncertain' && ['queued', 'exporting', 'downloading', 'processing', 'waiting_login'].includes(job.status)
}
function productsCompleted(job: ExportJob) { return job.status === 'completed' && [job.designStatus, job.coverStatus].every(status => status === 'completed') }
function needsProductRepair(job: ExportJob) { return job.status === 'completed' && !productsCompleted(job) }
function exportStatusLabel(job: ExportJob) { return needsProductRepair(job) ? '产物待补齐' : exportStatusLabels[job.status] }
function exportMessage(job: ExportJob) { return needsProductRepair(job) ? '封面图片等产物尚未全部确认完成，请补齐原任务；已有视频和完成的产物会复用。' : job.message }
function eligibleExportJob(job: Job) {
  const existing = exportFor(job)
  return eligibleExportProject(job) && (!existing || isActiveExport(existing))
}
function toggleProject(job: Job) {
  if (busy.value || loadError.value || !eligibleSelectionJob(job)) return
  const key = projectKey(job)
  selectedProjects.value = selectedProjects.value.includes(key) ? selectedProjects.value.filter(value => value !== key) : [...selectedProjects.value, key]
}
function toggleVisibleProjects() {
  if (busy.value || loadError.value) return
  selectedProjects.value = allVisibleProjectsSelected.value ? [] : visibleSelectionCandidates.value.map(projectKey)
}
function selectPendingDownloads() {
  if (busy.value || loadError.value || !exportsReady.value) return
  selectedProjects.value = pendingDownloadJobs.value.map(projectKey)
}
function selectFailedProduction() {
  if (busy.value || loadError.value) return
  selectedProjects.value = retryProductionJobs.value.map(projectKey)
}

function produceSelected() {
  if (isSource.value || !loaded.value || busy.value || loadError.value || productionChecking.value) return
  const selected = selectedProductionJobs.value.map(job => ({ jobId: Number(job.id), sourceId: Number(job.sourceId), key: projectKey(job), title: job.title }))
  if (!selected.length || selected.length > 100) return
  void perform('produce', async () => {
    try {
      const response = await deadline(api.post<{ results: { jobId: number; sourceId: number; status: 'queued' | 'skipped' | 'blocked'; message: string }[] }>(`${base}/produce`, { jobIds: selected.map(job => job.jobId) }), writeTimeoutMs, '自动生产请求超时，提交结果待核对')
      if (!mounted) return
      productionResults.value = selected.map<ProductionResult>(job => {
        const matches = Array.isArray(response?.results) ? response.results.filter(result => result && result.jobId === job.jobId && result.sourceId === job.sourceId) : []
        const result = matches.length === 1 ? matches[0] : undefined
        return result && ['queued', 'skipped', 'blocked'].includes(result.status) && typeof result.message === 'string'
          ? { ...job, status: result.status, message: result.message }
          : { ...job, status: 'unconfirmed', message: '该任务的提交结果未返回，请刷新核对；不会自动重发。' }
      })
      const accepted = new Set(productionResults.value.filter(result => result.status === 'queued' || result.status === 'skipped').map(result => result.key))
      selectedProjects.value = selectedProjects.value.filter(key => !accepted.has(key))
      if (productionResults.value.some(result => result.status === 'unconfirmed')) actionError.value = '部分自动生产结果未确认，请刷新核对任务；不会自动重发。'
    } catch (error) {
      if (!mounted) return
      const status = (error as { status?: number } | null)?.status
      const rejected = typeof status === 'number' && status >= 400 && status < 500
      const message = rejected ? errorMessage(error, '自动生产请求被拒绝，请处理后重试')
        : `${error instanceof Error && /请求超时/.test(error.message) ? '自动生产请求超时，提交结果待核对' : '请求结果未确认'}，请刷新核对任务状态；不会自动重发。`
      productionResults.value = selected.map<ProductionResult>(job => ({ ...job, status: rejected ? 'blocked' : 'unconfirmed', message }))
      actionError.value = message
    }
  })
}
function canResumeExport(job: ExportJob) {
  const parent = jobs.value.find(item => exportFor(item) === job)
  return !!parent && eligibleExportProject(parent) && job.stage !== 'export_uncertain' && (['failed', 'needs_attention'].includes(job.status) || needsProductRepair(job))
}
function exportPercent(job: ExportJob) { return typeof job.exportProgress === 'number' && Number.isFinite(job.exportProgress) ? Math.round(Math.min(100, Math.max(0, job.exportProgress))) : null }
function formatBytes(value: number | null) {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  const units = ['B', 'KB', 'MB', 'GB']
  const index = bytes > 0 ? Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))) : 0
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
function productStatus(status: ProductStatus | null | undefined, kind: 'design' | 'covers') {
  if (status === 'completed') return ({ design: '方案完成', covers: '图片完成' })[kind]
  if (kind === 'covers' && status === 'generating') return '正在生成图片'
  if (kind === 'covers' && (!status || status === 'queued')) return status ? '等待生成图片' : '尚未生成图片'
  return status ? ({ queued: '等待生成', generating: '正在生成', failed: '生成失败', needs_attention: '需要处理' } as Record<string, string>)[status] || '状态待确认' : '尚未开始'
}
function downloadedVideoUrl(job: ExportJob) {
  if (job.videoUrl && new RegExp(`^/static/history-deliveries/${Number(job.sourceId)}/[a-f0-9-]+\\.(mp4|mov|m4v|webm)$`, 'i').test(job.videoUrl)) return job.videoUrl
  return undefined
}
async function loadExports(requestedEndpoint: string, sourceId: number | string | undefined) {
  try {
    const data = await read<{ enabled: boolean; jobs: ExportJob[]; worker?: ExportWorker; production?: ExportProduction }>(`${base}/exports${sourceId === undefined ? '' : `?sourceId=${encodeURIComponent(String(sourceId))}`}`, '自动导出状态读取超时')
    if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.jobs) || data.jobs.some(job => !job || !Object.hasOwn(exportStatusLabels, job.status) || !job.id || !job.huashengJobId || typeof job.scriptSha256 !== 'string' || typeof job.updatedAt !== 'string')) throw new Error('自动导出服务响应不完整')
    if (!mounted || requestedEndpoint !== endpoint.value) return
    exportJobs.value = data.jobs
    exportWorker.value = data.worker && ['running', 'stopped'].includes(data.worker.status) && typeof data.worker.message === 'string' ? data.worker : null
    const production = data.production
    exportProduction.value = production && Number.isSafeInteger(production.limit) && production.limit > 0
      && Number.isSafeInteger(production.activeProjects) && production.activeProjects >= 0
      && Number.isSafeInteger(production.waitingProjects) && production.waitingProjects >= 0 ? production : null
    exportsLoaded.value = true
    exportsError.value = ''
  } catch (error) {
    if (mounted && requestedEndpoint === endpoint.value) exportsError.value = errorMessage(error, '自动导出状态读取失败')
  }
}
async function loadWorkflow(requestedEndpoint: string, sourceId: number | string | undefined) {
  try {
    const ids = [...new Set(jobs.value.map(job => Number(job.sourceId)))]
    const paths = sourceId === undefined ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => `candidates?sourceIds=${ids.slice(index * 100, index * 100 + 100).join(',')}`) : [`sources/${encodeURIComponent(String(sourceId))}/state`]
    const pages = await Promise.all(paths.map(path => read<{ items?: { versions: WorkflowVersion[] }[]; production?: { versions: WorkflowVersion[] } }>(`/history-scripts/uploads/${path}`, '全流程状态读取超时')))
    const versions = pages.flatMap(data => {
      const items = sourceId === undefined ? data?.items?.flatMap(item => item.versions) : data?.production?.versions
      if (!Array.isArray(items)) throw new Error('全流程状态响应不完整')
      return items
    })
    if (versions.some(version => !version || !Number.isSafeInteger(version.scriptId)
      || !['production', 'export', 'packaging', 'publication'].includes(version.stage) || typeof version.state !== 'string'
      || typeof version.message !== 'string')) throw new Error('全流程状态响应不完整')
    if (!mounted || requestedEndpoint !== endpoint.value) return
    workflowVersions.value = versions.filter(version => version.producer === 'huasheng')
    workflowLoaded.value = true
    workflowError.value = ''
  } catch (error) {
    if (mounted && requestedEndpoint === endpoint.value) workflowError.value = errorMessage(error, '全流程状态读取失败')
  }
}
function queueExports(input: Job[]) {
  if (busy.value || !exportsReady.value || loadError.value) return
  const selected = input.filter(eligibleExportJob)
  if (!selected.length) return
  // The server deduplicates each project and script version; perform only reads after a lost response.
  void perform('export-enqueue', () => deadline(api.post(`${base}/exports`, { sourceIds: [...new Set(selected.map(job => Number(job.sourceId)))] }), writeTimeoutMs, '下载与发布准备请求超时，结果待核对；请刷新状态，不会自动重发'))
}
function resumeExports(input: ExportJob[]) {
  if (busy.value || !exportsReady.value || loadError.value) return
  const selected = input.filter(canResumeExport)
  if (!selected.length) return
  void perform('export-resume', async () => {
    const results = await Promise.allSettled(selected.map(job => deadline(api.post(`${base}/exports/${encodeURIComponent(String(job.id))}/resume`, {}), writeTimeoutMs, '重试请求超时，结果待核对；不会自动重发')))
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`任务 #${selected[index]!.id}：${errorMessage(result.reason, '重试结果待核对')}`] : [])
    if (failures.length) throw new Error(failures.join('；'))
  })
}

function isQuotaBlocked(job: Job) {
  if (job.productionStatus !== 'not_started') return false
  return [job.stage, job.checkpoint].includes('quota_waiting') || /标准(?:模式)?.{0,8}额度.{0,8}(?:用完|不足|耗尽)|10008.{0,20}(?:超量|额度)/.test([job.message, job.error, job.productionMessage].filter(Boolean).join(' '))
}
function needsProductionAttention(job: Job) { return ['waiting_login', 'needs_attention', 'failed'].includes(job.status) || !!job.productionCheckError || isQuotaBlocked(job) }
function needsAttention(job: Job) { return workflowInfo(job).group === 'attention' }
function resetFilters() { productionFilter.value = 'all'; workflowFilter.value = 'all'; attentionOnly.value = false; quotaOnly.value = false; search.value = '' }
function openSource(event: MouseEvent, sourceId: number | string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  emit('open-script', sourceId, 'script')
}
function safeUrl(value?: string | null) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
function checkedTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
function canResume(job: Job) {
  return ['waiting_login', 'needs_attention', 'failed', 'canceled'].includes(job.status) && (!isSource.value || job.scriptSha256 === scriptSha256.value)
}
function canCancel(job: Job) {
  return ['queued', 'running', 'waiting_login', 'needs_attention'].includes(job.status)
}
function resumeDisabled(job: Job) {
  return busy.value || !!loadError.value || (isSource.value && !!unavailableReason.value) || String(props.blockedSourceId) === String(job.sourceId)
}
function requiresProjectLink(job: Job) {
  return !job.projectUrl && ['needs_attention', 'failed'].includes(job.status) && [job.stage, job.checkpoint].includes('create_pending')
}
function huashengProjectUrl(value?: string | null) {
  try {
    const url = new URL(value?.trim() || '')
    if (url.protocol !== 'https:' || !['www.huasheng.cn', 'huasheng.cn'].includes(url.hostname) || url.username || url.password || url.port || !/^\/video\/\d+\/?$/.test(url.pathname)) return undefined
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch { return undefined }
}
function huashengProjectId(value?: string | null) {
  const url = huashengProjectUrl(value)
  return url ? new URL(url).pathname.split('/').pop() : undefined
}
function existingProjectUrl(job: Job) { return huashengProjectUrl(projectUrls.value[String(job.id)]) }
function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined }
function schedule() {
  clearTimer()
  if (mounted && !action.value) timer = setTimeout(() => { void refresh() }, 5000)
}
function validBrowser(value: unknown): value is BrowserState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as BrowserState
  return ['ready', 'login_required', 'unavailable'].includes(candidate.status) && typeof candidate.message === 'string'
}
function validJobs(value: unknown): value is Job[] {
  return Array.isArray(value) && value.every(job => job && ['string', 'number'].includes(typeof job.id) && ['string', 'number'].includes(typeof job.sourceId)
    && Object.hasOwn(statusLabels, job.status) && typeof job.createdAt === 'string' && typeof job.scriptSha256 === 'string')
}
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback }
function needsCompleteInventory(data: SourceOverview) {
  return (data.counts?.canceled ?? 0) > 0 || data.jobs.some(job => job.status === 'canceled' && job.stage === 'record_cleanup')
}
function updateInventory(data: SourceOverview) {
  serverTotal.value = Number.isSafeInteger(data.total) && data.total! >= 0 ? data.total! : null
  serverProductionCounts.value = data.productionCounts && Object.keys(productionLabels).every(status => Number.isSafeInteger(data.productionCounts![status as ProductionStatus]) && data.productionCounts![status as ProductionStatus] >= 0) ? data.productionCounts : null
  nextBeforeId.value = Number.isSafeInteger(data.nextBeforeId) && data.nextBeforeId! > 0 ? data.nextBeforeId! : null
}

async function loadMore() {
  if (!mounted || busy.value || !nextBeforeId.value) return
  const cursor = nextBeforeId.value
  const requestedEndpoint = endpoint.value
  clearTimer()
  loadingMore.value = true
  try {
    const data = await read<Overview>(`${requestedEndpoint}?beforeId=${cursor}`, '更多任务读取超时，请重试')
    if (!data || !validJobs(data.jobs)) throw new Error('任务分页响应不完整')
    if (!mounted || requestedEndpoint !== endpoint.value) return
    loadedJobs.value = [...new Map([...loadedJobs.value, ...data.jobs].map(job => [String(job.id), job])).values()]
    updateInventory(data)
    loadError.value = ''
    await loadWorkflow(requestedEndpoint, props.sourceId)
  } catch (error) { if (mounted && requestedEndpoint === endpoint.value) loadError.value = errorMessage(error, '更多任务读取失败') }
  finally { loadingMore.value = false; if (mounted) schedule() }
}

async function read<T>(path: string, message: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(message)), readTimeoutMs)
  try { return await api.get<T>(path, controller.signal) }
  catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally { clearTimeout(timeout) }
}

async function deadline<T>(request: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { if (timeout !== undefined) clearTimeout(timeout) }
}

function refresh(): Promise<void> {
  if (!mounted) return Promise.resolve()
  if (pending) return pending
  clearTimer()
  loading.value = true
  const requestedEndpoint = endpoint.value
  pending = (async () => {
    const exportRead = loadExports(requestedEndpoint, props.sourceId)
    let workflowRead: Promise<void> = Promise.resolve()
    try {
      const data = await read<Overview | SourceOverview>(requestedEndpoint, '花生状态读取超时，请刷新核对任务')
      if (!data || !validJobs(data.jobs) || (!isSource.value && (!('enabled' in data) || typeof data.enabled !== 'boolean' || !validBrowser(data.browser)))) throw new Error('花生服务响应不完整')
      // The source endpoint may expose only jobs; the overview owns the batch check flag.
      const checking = data.productionChecking ?? (isSource.value ? (await read<Overview>(base, '花生检查状态读取超时，请刷新核对任务')).productionChecking : undefined)
      if (typeof checking !== 'boolean') throw new Error('花生创作检查状态响应不完整')
      const refreshed = new Map(data.jobs.map(job => [String(job.id), job]))
      let completeInventory = needsCompleteInventory(data)
      let cursor = data.nextBeforeId ?? null
      const cursors = new Set<number>()
      while (!isSource.value && cursor && (completeInventory || refreshed.size < loadedJobs.value.length) && !cursors.has(cursor)) {
        cursors.add(cursor)
        const page = await read<Overview>(`${requestedEndpoint}?beforeId=${cursor}`, '已加载任务刷新超时，请重试')
        if (!page || !validJobs(page.jobs)) throw new Error('任务分页响应不完整')
        for (const job of page.jobs) refreshed.set(String(job.id), job)
        completeInventory ||= needsCompleteInventory(page)
        cursor = page.nextBeforeId ?? null
      }
      if (!mounted || requestedEndpoint !== endpoint.value) return
      loadedJobs.value = [...refreshed.values()]
      workflowRead = loadWorkflow(requestedEndpoint, props.sourceId)
      updateInventory({ ...data, nextBeforeId: cursor })
      productionChecking.value = checking
      if ('enabled' in data) {
        enabled.value = data.enabled; browser.value = data.browser
        monitoring.value = data.monitoring && typeof data.monitoring.enabled === 'boolean' ? data.monitoring : null
      }
      loaded.value = true
      loadError.value = ''
    } catch (error) {
      if (mounted && requestedEndpoint === endpoint.value) loadError.value = errorMessage(error, '花生状态读取失败')
    } finally {
      await Promise.allSettled([exportRead, workflowRead])
      pending = undefined
      if (mounted) { loading.value = false; schedule() }
    }
  })()
  return pending
}

async function perform(name: string, operation: () => Promise<unknown>) {
  if (!mounted || action.value) return
  action.value = name
  actionError.value = ''
  actionNotice.value = ''
  clearTimer()
  try {
    await pending
    if (!mounted) return
    await operation()
  }
  catch (error) { if (mounted) actionError.value = errorMessage(error, '花生操作失败，请刷新状态后重试') }
  finally {
    if (mounted) {
      // A lost response may still have created a task; reconcile without repeating the write.
      try { await refresh() }
      finally { action.value = ''; schedule() }
    }
  }
}
function changeEnabled(event: Event) {
  const input = event.target as HTMLInputElement
  const next = input.checked
  input.checked = enabled.value
  if (busy.value || !loaded.value || loadError.value) return
  void perform('settings', () => api.put(`${base}/settings`, { enabled: next }))
}
function changeMonitoring(event: Event) {
  const input = event.target as HTMLInputElement
  const next = input.checked
  input.checked = monitoring.value?.enabled ?? false
  if (busy.value || !monitoring.value || loadError.value) return
  void perform('monitoring', () => api.put(`${base}/monitoring`, { enabled: next }))
}
function checkProduction(selectedOnly = false, current?: Job) {
  if (!loaded.value || busy.value || loadError.value || productionChecking.value) return
  const jobIds = selectedOnly ? (current ? eligibleCheckJob(current) ? [Number(current.id)] : [] : selectedCheckJobs.value.map(job => Number(job.id))) : undefined
  if (selectedOnly && (isSource.value || !jobIds?.length)) return
  const requestedEndpoint = endpoint.value
  void perform('production', async () => {
    const result = await api.post<{ checking: boolean }>(`${requestedEndpoint}/check-production`, selectedOnly ? { jobIds } : {})
    if (typeof result?.checking !== 'boolean') throw new Error('花生创作检查响应不完整，请刷新状态确认')
    if (mounted && requestedEndpoint === endpoint.value) productionChecking.value = result.checking
  })
}
function submit() {
  if (!canSubmit.value) return
  emit('continue-production')
}
function jobAction(job: Job, kind: 'resume' | 'cancel') {
  if (busy.value || (kind === 'resume' && (!canResume(job) || resumeDisabled(job))) || (kind === 'cancel' && (!canCancel(job) || job.cancelRequested))) return
  const projectUrl = kind === 'resume' && requiresProjectLink(job) ? existingProjectUrl(job) : undefined
  if (kind === 'resume' && requiresProjectLink(job) && !projectUrl) return
  void perform(`${kind}-${job.id}`, () => api.post(`${base}/jobs/${encodeURIComponent(String(job.id))}/${kind}`, projectUrl ? { projectUrl } : {}))
}
function openProject(job: Job) {
  if (busy.value) return
  const requestedEndpoint = endpoint.value
  void perform(`open-project-${job.id}`, async () => {
    const result = await api.post<{ message: string }>(`${base}/jobs/${encodeURIComponent(String(job.id))}/open-project`, {})
    if (mounted && requestedEndpoint === endpoint.value) actionNotice.value = result.message || '已在原任务账号打开花生页面'
  })
}
watch(() => props.scriptText, async text => {
  const request = ++hashRequest
  scriptSha256.value = ''
  hashError.value = ''
  if (!text || !isSource.value) return
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    if (request === hashRequest) scriptSha256.value = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch { if (request === hashRequest) hashError.value = '无法核对稿件版本，请使用 localhost 或安全连接打开工作台。' }
}, { immediate: true })
watch(() => props.scriptRevision, () => { if (mounted && !action.value) void refresh() })
watch(() => props.accountsRevision, async () => {
  await pending
  if (mounted && !action.value) void refresh()
})
onMounted(() => { mounted = true; void refresh() })
onBeforeUnmount(() => { mounted = false; hashRequest++; clearTimer() })
</script>

<style scoped>
.huasheng { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: #fff; color: #27272a; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
.huasheng *, .huasheng *::before, .huasheng *::after { box-sizing: border-box; letter-spacing: 0; }
.huasheng button, .huasheng input { font: inherit; }
.project-home { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; color: #2563eb; background: transparent; text-decoration: underline; cursor: pointer; }.project-home:disabled { opacity: .5; cursor: default; }
.huasheng button, .huasheng a, .huasheng summary, .huasheng input { -webkit-tap-highlight-color: transparent; }
.huasheng :is(button, a, summary, input):focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.huasheng ::selection { background: #dbeafe; color: #172554; }
.huasheng svg { flex-shrink: 0; }
.toolbar, .heading, .toolbar-actions, .actions, .connection, .auto-toggle { display: flex; align-items: center; gap: 8px; }
.toolbar { flex-shrink: 0; flex-wrap: wrap; gap: 12px; min-height: 48px; padding: 8px 20px; border-bottom: 1px solid #e4e4e7; }
.heading { min-width: 0; gap: 12px; flex-wrap: wrap; }
.heading h2 { margin: 0; color: #18181b; font: 600 18px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
.connection { margin-left: auto; color: #52525b; font-size: 12px; }
.connection.ready { color: #15803d; }
.connection.uncertain { color: #92400e; }
.toolbar-actions { flex-shrink: 0; }
.control { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; max-width: 100%; padding: 5px 10px; border: 1px solid #d4d4d8; border-radius: 5px; background: #fff; color: #3f3f46; line-height: 20px; text-decoration: none; cursor: pointer; }
.control:hover:not(:disabled) { background: #f4f4f5; border-color: #a1a1aa; }
.control.primary { background: #18181b; border-color: #18181b; color: #fff; }
.control.primary:hover:not(:disabled) { background: #3f3f46; border-color: #3f3f46; }
.control:disabled { color: #71717a; background: #f4f4f5; border-color: #e4e4e7; cursor: not-allowed; }
.control.icon-control { flex-shrink: 0; width: 32px; height: 32px; padding: 0; }
.control.resume { color: #1d4ed8; }
.control.danger { color: #b91c1c; }
.muted, .job-reference, .job-status, .job-checked, .queue-footer { color: #71717a; }
.settings { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 1fr); flex-shrink: 0; gap: 16px 32px; padding: 16px 24px; background: #fafafa; border-bottom: 1px solid #e4e4e7; }
.settings p { margin: 4px 0 10px; font-size: 12px; overflow-wrap: anywhere; }
.settings strong { font-size: 13px; font-weight: 600; }
.settings .actions { flex-wrap: wrap; }
.auto-toggle { align-items: flex-start; font-weight: 500; cursor: pointer; }
.auto-toggle input { flex-shrink: 0; width: 15px; height: 15px; margin-top: 2px; accent-color: #18181b; }
.settings-automation p { margin-left: 23px; }
.export-settings { grid-column: 1 / -1; }
.processing-status { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 16px; }
.export-batch { display: grid; gap: 4px; padding: 6px 0 8px; border-top: 1px solid #e4e4e7; font-size: 12px; }
.selection-line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 16px; min-width: 0; }
.batch-select { min-width: 0; overflow-wrap: anywhere; }
.batch-counts { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.pending-select { margin-left: auto; }
.batch-actions { display: flex; align-items: center; gap: 8px; min-width: 0; overflow-x: auto; padding: 4px; scrollbar-width: thin; }
.batch-actions .control { flex-shrink: 0; white-space: nowrap; }
.batch-limit { margin: 0; }
.production-results { padding: 12px 24px; border-bottom: 1px solid #e4e4e7; background: #fafafa; font-size: 12px; }
.production-results summary { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; min-height: 28px; cursor: pointer; }
.production-results summary::before { content: '+'; width: 12px; text-align: center; }
.production-results details[open] > summary::before { content: '-'; }
.production-results summary span { color: #52525b; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.production-result-list { display: grid; gap: 0; max-height: 180px; margin: 8px 0 0; padding: 0; overflow: auto; list-style: none; scrollbar-width: thin; }
.production-result-list > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 8px 16px; padding: 8px 0; border-top: 1px solid #e4e4e7; overflow-wrap: anywhere; }
.production-result-identity { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.production-result-identity strong, .production-result-status { font-weight: 500; }
.production-result-list p { margin: 3px 0 0; color: #52525b; }
.production-result-list .queued .production-result-status { color: #1d4ed8; }
.production-result-list .blocked .production-result-status { color: #b91c1c; }
.production-result-list .unconfirmed .production-result-status { color: #92400e; }
.production-results > .control { margin-top: 8px; }
.export-result { grid-column: 1 / -1; display: grid; gap: 8px; padding: 12px; border: 1px solid #e4e4e7; border-radius: 5px; background: #fafafa; font-size: 12px; overflow-wrap: anywhere; }
.export-result p { margin: 0; }
.export-heading, .export-meter, .export-products { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
.export-heading strong { font-weight: 600; }
.export-meter progress { width: 180px; max-width: 100%; accent-color: #2563eb; }
.export-meter span { font-variant-numeric: tabular-nums; }
.export-products { margin: 0; gap: 8px 24px; }
.export-products > div { display: flex; flex-wrap: wrap; gap: 6px; }
.export-products dt { color: #71717a; }
.export-products dd { margin: 0; font-weight: 500; }
.export-result .actions { flex-wrap: wrap; }
.notices { flex-shrink: 0; display: grid; gap: 4px; max-height: 96px; overflow-y: auto; padding: 8px 20px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.notices p, .job-messages p { margin: 0; overflow-wrap: anywhere; }
.warning { color: #92400e; }
.error { color: #b91c1c; overflow-wrap: anywhere; }
.filters { flex-shrink: 0; min-width: 0; padding: 0 20px; border-bottom: 1px solid #e4e4e7; }
.filter-line { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; column-gap: 20px; }
.status-filters, .attention-filters, .queue-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.status-filters { gap: 16px; padding: 4px 0; }
.filter { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #52525b; cursor: pointer; }
.filter:hover { color: #18181b; }
.filter[aria-pressed="true"] { color: #1d4ed8; border-bottom-color: #2563eb; font-weight: 600; }
.count { min-width: 18px; font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 400; }
.queue-tools { flex: 1 1 480px; min-width: 0; justify-content: flex-end; gap: 8px 12px; padding: 6px 0; }
.attention-filters { gap: 12px; }
.attention-filters .filter { gap: 5px; min-height: 32px; padding: 4px 8px; border: 1px solid #e4e4e7; border-radius: 5px; font-size: 12px; }
.attention-filters .filter[aria-pressed="true"] { color: #92400e; background: #fffbeb; border-color: #d97706; }
.search { display: flex; align-items: center; gap: 6px; min-width: 0; width: 220px; max-width: 100%; height: 32px; padding: 0 8px; border: 1px solid #d4d4d8; border-radius: 5px; color: #71717a; }
.search:focus-within { outline: 2px solid #2563eb; outline-offset: 2px; }
.search input { width: 100%; min-width: 0; border: 0; outline: none; color: #27272a; background: transparent; font-size: 12px; caret-color: #2563eb; }
.search input::placeholder { color: #71717a; opacity: 1; }
.search input::-webkit-search-cancel-button { display: none; }
.clear-search { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 26px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: #52525b; cursor: pointer; }
.clear-search:hover { background: #f4f4f5; }
.quota-explanation { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: 0 0 10px; color: #92400e; font-size: 12px; overflow-wrap: anywhere; }
.quota-explanation svg { margin-top: 2px; }
.queue { flex: 1; min-height: 240px; min-width: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: #d4d4d8 #fafafa; }
.queue:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
.job-row { display: grid; grid-template-columns: minmax(0, 1.25fr) 124px minmax(0, 1.6fr) 132px 190px; align-items: start; gap: 12px; padding-inline: 24px; }
.jobs { margin: 0; padding: 0; list-style: none; }
.job-row { min-height: 80px; padding-block: 14px; border-bottom: 1px solid #e4e4e7; }
.job-row:hover { background: #fafafa; }
.job-row > * { min-width: 0; }
.job-identity, .job-state, .job-messages, .job-checked { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.job-state { position: relative; }
.job-title { color: #27272a; text-decoration: none; font-weight: 500; overflow-wrap: anywhere; }
.job-title:hover { color: #1d4ed8; text-decoration: underline; text-underline-offset: 3px; }
.job-reference { font-size: 11px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.production-status { display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 1px 6px; border-radius: 4px; background: #f4f4f5; color: #52525b; font-size: 12px; font-weight: 500; }
.production-status.queued { background: #fffbeb; color: #92400e; }
.production-status.creating { background: #eff6ff; color: #1d4ed8; }
.production-status.completed { background: #f0fdf4; color: #15803d; }
.workflow-status { display: inline-flex; align-items: center; min-height: 22px; padding: 1px 6px; border-radius: 4px; background: #f4f4f5; color: #52525b; font-size: 12px; font-weight: 600; }
.workflow-status.active { background: #eff6ff; color: #1d4ed8; }
.workflow-status.success { background: #f0fdf4; color: #15803d; }
.workflow-status.error { background: #fef2f2; color: #b91c1c; }
.workflow-filter { width: 100%; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid #d4d4d8; border-radius: 5px; background: #fff; color: #3f3f46; }
.workflow-progress { grid-column: 1 / -1; min-width: 0; padding: 12px 0; border-block: 1px solid #e4e4e7; }
.workflow-progress ol { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.workflow-progress li { display: flex; flex-wrap: wrap; align-items: center; align-content: start; gap: 4px; min-width: 0; color: #71717a; font-size: 12px; }
.workflow-progress li strong { flex-basis: 100%; overflow-wrap: anywhere; color: #3f3f46; font-weight: 500; }
.workflow-progress li.success, .workflow-progress li.success strong { color: #15803d; }
.workflow-progress li.active strong { color: #1d4ed8; }
.workflow-progress li.error, .workflow-progress li.error strong, .workflow-error { color: #b91c1c; }
.workflow-progress p { margin: 10px 0 0; overflow-wrap: anywhere; }
.workflow-progress .actions { margin-top: 10px; }
.job-status { font-size: 12px; }
.job-status.running { color: #1d4ed8; }
.job-status.failed { color: #b91c1c; }
.job-status.needs_attention, .job-status.waiting_login { color: #92400e; }
.quota-badge { color: #92400e; font-size: 11px; font-weight: 600; }
.job-messages { gap: 3px; font-size: 12px; }
.status-record { width: 100%; min-width: 0; }
.status-record summary { width: fit-content; max-width: 100%; min-height: 24px; padding-block: 3px; color: #52525b; cursor: pointer; }
.status-record p { margin-top: 6px; white-space: pre-wrap; }
.row-message { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.job-checked { font-size: 11px; font-variant-numeric: tabular-nums; }
.job-checked time { max-width: 100%; overflow-wrap: anywhere; }
.job-commands { justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
.job-commands .control { padding-inline: 6px; font-size: 12px; }
.job-commands .icon-control { width: 28px; }
.job-more { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding-top: 6px; }
.recovery { grid-column: 1 / -1; font-size: 12px; }
.recovery summary { width: fit-content; max-width: 100%; min-height: 28px; padding-block: 4px; color: #1d4ed8; cursor: pointer; }
.recovery p { margin: 4px 0; overflow-wrap: anywhere; }
.recovery a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 3px; }
.recovery form { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px; max-width: 640px; margin-block: 8px; }
.recovery label { display: flex; flex: 1 1 240px; min-width: 0; flex-direction: column; gap: 4px; }
.recovery input { width: 100%; min-width: 0; height: 34px; padding: 5px 8px; border: 1px solid #d4d4d8; border-radius: 5px; background: #fff; color: #27272a; caret-color: #2563eb; }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 160px; padding: 32px 16px; color: #71717a; }
.empty p { margin: 0; }
.queue-footer { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; flex-shrink: 0; padding: 2px 20px; border-top: 1px solid #e4e4e7; background: #fafafa; font-size: 11px; }
.monitor-toggle { display: flex; align-items: center; gap: 6px; min-height: 32px; color: #52525b; cursor: pointer; }
.monitor-toggle input { width: 15px; height: 15px; margin: 0; accent-color: #18181b; }
.monitor-toggle:has(input:disabled) { cursor: not-allowed; }
.monitor-interval { font-variant-numeric: tabular-nums; color: #71717a; }
.source-panel { display: block; flex: 0 0 auto; height: auto; }
.source-panel .toolbar { padding: 12px 0; gap: 8px; }
.source-panel .heading { flex: 1; gap: 8px; }
.source-panel .heading h2 { font-size: 14px; }
.source-state { color: #52525b; font-size: 12px; }
.source-panel .notices { padding: 8px 0; background: transparent; }
.source-panel .queue { min-height: 0; overflow: visible; }
.source-panel .job-row { grid-template-columns: minmax(120px, 1fr) minmax(110px, .7fr) minmax(160px, 1.3fr); padding: 12px 0; gap: 8px 12px; }
.source-panel .job-checked { grid-column: 1 / 3; justify-content: flex-start; flex-direction: row; align-self: center; flex-wrap: wrap; gap: 6px; }
.source-panel .job-commands { grid-column: 3; }
.version-label { font-size: 12px; font-weight: 500; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spinning { animation: huasheng-spin 1s linear infinite; }
@keyframes huasheng-spin { to { transform: rotate(360deg); } }
@media (max-width: 1100px) {
  .queue-tools { justify-content: space-between; }
  .job-row { grid-template-columns: minmax(0, 1fr) 136px 190px; gap: 8px 16px; }
  .job-identity { grid-column: 1; }
  .job-state { grid-column: 2; grid-row: span 2; }
  .job-messages { grid-column: 1; }
  .job-checked { grid-column: 3; grid-row: 1; align-items: flex-end; }
  .job-commands { grid-column: 3; grid-row: 2; }
  .source-panel .job-row { grid-template-columns: minmax(0, 1fr) 128px; }
  .source-panel .job-state { grid-column: 2; grid-row: 1; }
  .source-panel .job-messages { grid-column: 1 / -1; }
  .source-panel .job-checked { grid-column: 1; grid-row: auto; align-items: flex-start; }
  .source-panel .job-commands { grid-column: 2; grid-row: auto; }
}
@media (max-width: 640px) {
  .toolbar { padding: 12px; gap: 8px; }
  .heading { gap: 8px; }
  .heading h2 { font-size: 16px; }
  .connection { font-size: 11px; }
  .toolbar-actions { margin-left: auto; }
  .settings { grid-template-columns: minmax(0, 1fr); padding: 12px; gap: 16px; }
  .filters { padding-inline: 12px; }
  .export-batch { gap: 8px; }
  .selection-line { gap: 8px; }
  .batch-counts { flex-basis: 100%; }
  .selection-line .pending-select { margin-left: 0; }
  .export-batch .control { padding-inline: 8px; font-size: 12px; }
  .production-results { padding: 8px 12px; }
  .production-result-list { max-height: 160px; }
  .production-result-list > li { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .status-filters { justify-content: space-between; gap: 4px; }
  .status-filters .filter { gap: 4px; font-size: 12px; }
  .attention-filters { flex-wrap: wrap; gap: 6px; }
  .search { width: 100%; }
  .notices { padding: 8px 12px; }
  .job-row, .source-panel .job-row { grid-template-columns: minmax(0, 1fr) minmax(96px, auto); padding: 12px; gap: 8px; }
  .job-state, .source-panel .job-state { grid-column: 2; grid-row: 1; align-items: flex-end; }
  .job-messages, .source-panel .job-messages { grid-column: 1 / -1; }
  .job-checked, .source-panel .job-checked { grid-column: 1; grid-row: auto; align-items: flex-start; align-self: center; }
  .job-commands, .source-panel .job-commands { grid-column: 2; grid-row: auto; max-width: 168px; }
  .queue-footer { padding: 8px 12px; }
  .source-panel .toolbar { padding: 12px 0; }
  .source-panel .heading { flex-basis: 100%; }
  .source-panel .toolbar-actions { margin-left: 0; }
  .source-panel .job-row { padding-inline: 0; }
}
@media (max-width: 760px), (max-height: 600px) {
  .huasheng:not(.source-panel) { flex: none; height: auto; min-height: 0; }
  .huasheng:not(.source-panel) .queue { flex: none; overflow: visible; min-height: 240px; }
  .huasheng:not(.source-panel) .notices { max-height: none; overflow: visible; }
  .huasheng:not(.source-panel) .batch-actions { flex-wrap: wrap; overflow: visible; }
  .huasheng:not(.source-panel) .control { min-height: 40px; }
}
/* The board separates scanning tasks from working on one project's details. */
.production-body { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: auto; }
.task-rail { display: flex; flex-direction: column; flex: 0 0 360px; min-width: 0; min-height: 0; border-right: 1px solid #e4e4e7; }
.task-rail .filters { padding: 6px 14px 10px; }
.task-rail .filter-line { display: block; }
.task-rail .queue-tools { flex-wrap: wrap; }
.task-rail .status-filters { justify-content: space-between; gap: 4px; padding-block: 2px; }
.task-rail .status-filters .count { min-width: 0; }
.task-rail .filter { gap: 3px; font-size: 12px; }
.task-rail .queue-tools { display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding: 4px 0 0; }
.task-rail .attention-filters { gap: 8px; }
.task-rail .search { width: 100%; }
.task-rail .quota-explanation { padding: 10px 0 0; }
.rail-caption { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 8px; padding: 8px 14px; color: #71717a; font-size: 11px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.task-list { flex: 1; min-height: 180px; margin: 0; padding: 0; overflow: auto; list-style: none; scrollbar-width: thin; scrollbar-color: #d4d4d8 #fafafa; }
.task-item { display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid #e4e4e7; padding: 0 14px; }
.task-item:hover { background: #fafafa; }
.task-item.active { background: #eff6ff; }
.task-item.selected .task-title { font-weight: 600; }
.task-selection { display: flex; flex-shrink: 0; align-items: center; justify-content: center; min-height: 44px; cursor: pointer; }
.task-selection input { width: 15px; height: 15px; margin: 0; accent-color: #18181b; }
.task-preview { display: flex; flex-direction: column; align-items: stretch; flex: 1; min-width: 0; gap: 7px; padding: 12px 0; border: 0; background: transparent; text-align: left; color: #27272a; cursor: pointer; }
.task-preview:focus-visible { outline-offset: -2px; }
.task-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; font-weight: 500; }
.task-meta { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; color: #71717a; font-size: 11px; font-variant-numeric: tabular-nums; }
.task-meta .production-status { font-size: 11px; min-height: 20px; }
.task-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #71717a; font-size: 12px; }
.task-summary.warning { color: #92400e; }
.detail-workspace { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.detail-navigation { display: flex; align-items: center; flex-shrink: 0; gap: 12px; min-height: 36px; padding: 8px 20px; color: #52525b; font-size: 12px; }
.detail-navigation .muted { margin-left: auto; font-size: 11px; }
.detail-workspace > .export-batch { padding: 6px 20px 8px; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
.detail-workspace .selection-line { gap: 6px 12px; }
.detail-workspace .batch-actions { flex-wrap: wrap; overflow: visible; padding: 4px 0; }
.detail-workspace .batch-actions .control { font-size: 12px; }
.huasheng:not(.source-panel) .job-row { display: flex; flex-direction: column; align-items: stretch; gap: 16px; padding: 20px; border: 0; }
.huasheng:not(.source-panel) .job-row:hover { background: transparent; }
.huasheng:not(.source-panel) .job-title { font-size: 20px; line-height: 1.5; font-weight: 600; }
.huasheng:not(.source-panel) .job-identity { gap: 8px; }
.huasheng:not(.source-panel) .job-state { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; }
.huasheng:not(.source-panel) .job-messages { padding: 12px 0; border-block: 1px solid #e4e4e7; font-size: 13px; }
.huasheng:not(.source-panel) .row-message { display: block; overflow: visible; white-space: pre-wrap; }
.huasheng:not(.source-panel) .job-checked { flex-direction: row; align-items: center; flex-wrap: wrap; }
.huasheng:not(.source-panel) .job-commands { justify-content: flex-start; max-width: none; gap: 8px; }
.huasheng:not(.source-panel) .job-commands .control { padding-inline: 10px; }
.huasheng:not(.source-panel) .export-result { margin: 0; }
.source-panel .production-body, .source-panel .detail-workspace { display: contents; }
.mobile-back, .mobile-batch { display: none; }
@media (min-width: 761px) and (max-width: 1100px) {
  .task-rail { flex-basis: 320px; }
}
@media (min-width: 761px) and (max-height: 600px) {
  .huasheng:not(.source-panel) .production-body { flex: none; height: 520px; }
  .huasheng:not(.source-panel) .queue { flex: 1; overflow: auto; min-height: 240px; }
}
@media (max-width: 760px) {
  .production-body { display: block; flex: none; overflow: visible; }
  .task-rail { width: 100%; border: 0; }
  .task-list { flex: none; overflow: visible; }
  .detail-workspace { display: none; }
  .show-detail .task-rail { display: none; }
  .show-detail .detail-workspace { display: flex; }
  .mobile-back, .mobile-batch { display: inline-flex; }
  .detail-navigation { flex-wrap: wrap; padding: 10px 12px; }
  .detail-navigation > span:not(.muted) { display: none; }
  .detail-workspace > .export-batch { padding-inline: 12px; }
  .huasheng:not(.source-panel) .job-row { padding: 16px 12px; }
  .huasheng:not(.source-panel) .job-title { font-size: 18px; }
}
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
