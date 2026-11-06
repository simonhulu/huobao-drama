<template>
  <div class="cba-page">
    <header class="page-head">
      <div><h1>CBA 视频工厂</h1><p>筛选虎扑与新浪新闻，用对应比赛录像制作新闻口播和比赛高亮。</p></div>
      <div class="head-actions">
        <button class="btn btn-ghost" @click="openDialog('runs')"><History :size="15" /> 运行记录</button>
        <button class="btn" @click="openAccounts"><Users :size="15" /> 百家号账号</button>
        <button class="btn" @click="openDialog('connections')"><Plug :size="15" /> 平台连接</button>
        <button class="btn" :disabled="isActive || queueActive || !!actionBusy" @click="openDialog('start')"><Newspaper :size="15" /> 采集新新闻</button>
        <button class="btn btn-primary" :disabled="queueActive || !!actionBusy || !resumeCandidatesCount" @click="openDialog('resume')"><RotateCcw :size="15" /> {{ resumeButtonLabel }}</button>
      </div>
    </header>
    <div class="source-strip">
      <a href="https://bbs.hupu.com/cba-hot" target="_blank" rel="noreferrer"><Newspaper :size="15" /> 虎扑 CBA 热榜 <ExternalLink :size="12" /></a>
      <a href="https://sports.sina.com.cn/" target="_blank" rel="noreferrer">新浪体育 <ExternalLink :size="12" /></a>
      <span class="source-defaults"><Mic2 :size="14" /> 新闻口播 90–180 秒 <span class="separator">/</span> 比赛高亮 3–5 分钟 <span class="separator">/</span> 同场素材复用</span>
    </div>
    <div v-if="overview.sourceReports?.length" class="source-health" aria-label="新闻来源采集状态"><span v-for="report in overview.sourceReports" :key="report.provider" :title="report.message" :class="{ 'source-failed': !['ok', 'success', 'not_collected'].includes(report.status) }"><strong>{{ report.provider === 'hupu' ? '虎扑' : report.provider === 'sina' ? '新浪' : report.provider }}</strong> {{ sourceReportLabel(report) }}<span v-if="report.message && !['ok', 'success', 'not_collected'].includes(report.status)"> · {{ report.message }}</span></span></div>
    <p v-if="intakeCoverageLabel" class="intake-coverage">{{ intakeCoverageLabel }}</p>
    <section v-if="resumeQueue" class="run-banner resume-queue-banner" :class="{ warning: ['attention', 'stopped'].includes(resumeQueue.status) }" aria-label="续做队列" role="status">
      <LoaderCircle v-if="queueActive" :size="17" class="spin" /><Check v-else-if="resumeQueue.status === 'completed'" :size="17" /><Upload v-else-if="resumeQueue.status === 'waiting_upload'" :size="17" /><CircleAlert v-else :size="17" />
      <div><strong>{{ resumeQueueHeading }}</strong><p>{{ resumeQueueSummary }}</p><p v-if="resumeQueue.currentTitle">{{ resumeQueue.currentTitle }}</p><p v-if="overview.activeRun?.queueId === resumeQueue.id">{{ overview.activeRun.message }}</p><progress :value="resumeQueue.processed || 0" :max="resumeQueue.total || 1" aria-label="续做队列已处理任务" /></div>
      <button class="btn btn-sm btn-ghost" @click="openDialog('runs')">查看队列</button>
      <button v-if="canStopQueue" class="btn btn-sm" :disabled="!!actionBusy || resumeQueue.status === 'stopping'" @click="stopResumeQueue"><Square :size="13" />{{ resumeQueue.status === 'stopping' ? '正在停止' : '停止队列' }}</button>
    </section>
    <section v-if="overview.activeRun && (!resumeQueue || overview.activeRun.queueId !== resumeQueue.id)" class="run-banner" role="status">
      <LoaderCircle :size="17" class="spin" /><div><strong>{{ runLabel(overview.activeRun) }}</strong><p>{{ overview.activeRun.message }}</p></div>
      <button class="btn btn-sm btn-ghost" @click="openDialog('runs')">查看进展</button>
      <button class="btn btn-sm" :disabled="!!actionBusy || overview.activeRun.status === 'stopping'" @click="stopRun"><Square :size="13" /> {{ overview.activeRun.status === 'stopping' ? '正在停止' : '停止' }}</button>
    </section>
    <section v-else-if="overview.recoveryActive" class="run-banner" role="status"><LoaderCircle :size="17" class="spin" /><div><strong>正在恢复上传进度</strong><p>核对原账号和平台草稿，完成后自动更新。</p></div></section>
    <section v-else-if="!queueActive && latestRun && !latestRun.queueId && runRecovered(latestRun)" class="run-banner" role="status"><Check :size="17" /><div><strong>本轮草稿已恢复</strong><p>{{ runRecoveryMessage(latestRun) }}</p></div><button class="btn btn-sm" @click="openDialog('runs')">查看记录</button></section>
    <section v-else-if="!queueActive && latestRun && !latestRun.queueId && ['attention', 'failed', 'stopped'].includes(latestRun.status)" class="run-banner warning" role="status">
      <CircleAlert :size="17" /><div><strong>{{ runStatusLabel(latestRun.status) }}</strong><p>{{ latestRun.message }}</p></div><button class="btn btn-sm" @click="openDialog('runs')">查看记录</button>
    </section>
    <div v-if="pageError" class="page-alert" role="alert"><CircleAlert :size="16" /><span>{{ pageError }}</span><button class="btn btn-sm" :disabled="loading" @click="refresh">重新加载</button></div>

    <nav class="workspace-switch" aria-label="工作台视图"><button :class="{ active: workspaceView === 'news' }" :aria-pressed="workspaceView === 'news'" @click="workspaceView = 'news'"><Newspaper :size="15" /> 新闻制作 <span>{{ overview.jobs.length }}</span></button><button :class="{ active: workspaceView === 'matches' }" :aria-pressed="workspaceView === 'matches'" @click="workspaceView = 'matches'"><Video :size="15" /> 比赛素材 <span>{{ materialInventory.matches }}</span></button><span>{{ materialInventory.downloaded }} 场原录像在本地 · {{ materialInventory.ready }} 场已核验</span></nav>

    <section v-if="workspaceView === 'matches'" class="match-library" aria-label="比赛素材库">
      <header class="library-head"><div><h2>比赛素材库</h2><p>按比赛汇总原录像。同场新闻共用素材，成片和原录像分别保存。</p></div><button class="btn btn-sm" :disabled="loading" @click="refresh"><RefreshCw :size="14" :class="{ spin: loading }" /> 刷新</button></header>
      <label class="queue-search library-search"><Search :size="14" /><input v-model="matchSearch" type="search" placeholder="搜索比赛日期或球队" aria-label="搜索比赛日期或球队" /></label>
      <p v-if="materialInventory.missing" class="material-notice">{{ materialInventory.missing }} 场的原录像已不在本地。已有成片仍可查看，再次剪辑前需要重新下载。</p>
      <p v-if="!filteredMatches.length" class="section-empty">{{ materialInventory.matches ? '没有符合条件的比赛。' : '核实新闻中的比赛日期和双方球队后，比赛与素材会显示在这里。' }}</p>
      <article v-for="match in filteredMatches" :key="match.id" class="match-card">
        <header><div><p class="match-date">{{ match.date }} · {{ match.verified ? '比赛已确认' : '比赛待核实' }}</p><h3>{{ match.home }} <span>{{ match.score || '对阵' }}</span> {{ match.away }}</h3></div><span class="footage-status" :class="footageTone(match.footage)">{{ footageLabel(match.footage) }}</span></header>
        <p class="match-sharing">{{ match.newsCount || match.jobIds?.length || 0 }} 条关联任务 · {{ match.footage?.candidateCount || 0 }} 个咪咕视频候选</p>
        <ul v-if="match.footage?.files?.length" class="material-file-list"><li v-for="file in match.footage.files" :key="`${file.jobId}-${file.id}`"><div><strong>{{ file.fileName }}</strong><span>{{ materialKind(file.kind) }} · {{ formatDuration(file.duration) || '时长待检查' }} · {{ file.available ? file.verified ? '已下载，比赛已核验' : '已下载，比赛待核验' : '本地文件缺失' }}</span></div><a v-if="file.sourceUrl" :href="file.sourceUrl" target="_blank" rel="noreferrer">咪咕来源 <ExternalLink :size="12" /></a></li></ul>
        <details v-if="playableFootage(match.footage).length" class="material-preview"><summary>播放原录像核对比赛</summary><video v-for="file in playableFootage(match.footage)" :key="file.previewUrl" :src="file.previewUrl" controls playsinline preload="none" class="video-player" :aria-label="`${match.home}对阵${match.away}原录像`" /></details>
        <div class="match-card-actions"><button v-if="match.jobIds?.length" class="btn btn-sm" @click="openMatchTask(match)">查看关联新闻与证据</button><a v-for="candidate in (match.footage?.candidates || []).slice(0, 2)" :key="candidate.url" :href="candidate.url" target="_blank" rel="noreferrer">{{ candidate.title || '咪咕视频候选' }} <ExternalLink :size="12" /></a></div>
      </article>
    </section>

    <section v-else class="workspace" :class="{ 'show-detail': mobileDetail }" aria-label="CBA 生产工作台">
      <aside class="queue-pane" aria-label="新闻任务">
        <header class="queue-head"><h2>新闻任务 <span>{{ overview.jobs.length }}</span></h2><button class="btn btn-icon btn-ghost" aria-label="刷新任务" title="刷新任务" :disabled="loading" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" /></button></header>
        <p class="output-inventory" aria-label="已有成片">已有成片 {{ outputInventory.jobs }} 项 · {{ outputInventory.videos }} 条视频</p>
        <div class="queue-filters" aria-label="筛选任务"><button v-for="item in filterOptions" :key="item.id" :aria-pressed="filter === item.id" :class="{ active: filter === item.id }" @click="filter = item.id">{{ item.label }} <span v-if="item.id !== 'all'">{{ countStatus(item.id) }}</span></button></div>
        <label class="queue-search"><Search :size="14" /><input v-model="search" type="search" placeholder="搜索任务 ID、新闻或球队" aria-label="搜索任务 ID、新闻或球队" /></label>
        <div v-if="loading && !overview.jobs.length" class="empty-state" role="status"><LoaderCircle :size="22" class="spin" /><p>正在读取任务…</p></div>
        <div v-else-if="!filteredJobs.length" class="empty-state"><Inbox :size="26" /><strong>{{ overview.jobs.length ? '没有符合条件的新闻' : '还没有生产任务' }}</strong><p>{{ overview.jobs.length ? '试试其他关键词或筛选条件。' : '开始生产后，新闻和处理结果会保存在这里。' }}</p><button v-if="overview.jobs.length" class="btn btn-sm" @click="clearFilters">清除筛选</button></div>
        <ul v-else class="queue-list"><li v-for="job in filteredJobs" :key="job.id"><button class="queue-item" :class="{ selected: selectedId === job.id }" :aria-current="selectedId === job.id ? 'true' : undefined" @click="selectJob(job.id)"><span class="queue-title">{{ job.title }}</span><span class="queue-id">ID: {{ job.id }}</span><span class="queue-meta">{{ matchLine(job) }}</span><span class="queue-material" :class="footageTone(job.footage)">{{ footageLabel(job.footage) }}</span><span class="queue-bottom"><span class="status-label" :class="statusTone(job.status)"><i />{{ taskStatusLabel(job) }}</span><span>{{ formatTime(job.updatedAt) }}</span></span><span v-if="job.status === 'attention'" class="queue-cause">{{ job.message }}</span></button></li></ul>
      </aside>

      <section class="detail-pane" aria-label="所选新闻详情" :aria-busy="detailLoading">
        <button class="back-button btn btn-ghost btn-sm" @click="mobileDetail = false"><ArrowLeft :size="14" /> 新闻任务</button>
        <div v-if="detailLoading && !selectedJob" class="empty-state"><LoaderCircle :size="24" class="spin" /><p>正在读取详情…</p></div>
        <div v-else-if="!selectedJob" class="empty-state detail-empty"><Video :size="30" /><h2>{{ detailError ? '暂时无法读取详情' : '让每条新闻成为视频' }}</h2><code v-if="selectedId" class="task-id-value">{{ selectedId }}</code><p>{{ detailError || '新闻逐条制作，同场比赛集锦复用。成片和平台草稿都在这里查看。' }}</p><button v-if="detailError" class="btn" @click="loadDetail(selectedId, true)">重新加载</button><button v-else class="btn btn-primary" :disabled="isActive || queueActive || !!actionBusy" @click="openDialog('start')"><Newspaper :size="14" /> 采集新新闻</button></div>
        <template v-else>
          <header class="detail-head"><div class="detail-heading"><h2>{{ selectedJob.title }}</h2><div class="detail-meta"><span class="status-label" :class="statusTone(selectedJob.status)"><i />{{ taskStatusLabel(selectedJob) }}</span><span>{{ matchLine(selectedJob) }}</span><a v-if="selectedJob.sourceUrl" :href="selectedJob.sourceUrl" target="_blank" rel="noreferrer">{{ sourceLabel(selectedJob.sourceUrl) }} <ExternalLink :size="12" /></a></div></div><button class="btn btn-icon btn-ghost delete-task-button" :disabled="!canDeleteTask || !!actionBusy" aria-label="删除任务" title="删除任务" @click="deleteTask"><Trash2 :size="15" /></button></header>
          <div class="task-identity"><span>任务 ID</span><code class="task-id-value">{{ selectedJob.id }}</code><div class="task-identity-actions"><button class="btn btn-icon btn-ghost" aria-label="复制任务 ID" title="复制任务 ID" @click="copyTaskReference('id')"><Copy :size="14" /></button><button class="btn btn-icon btn-ghost" aria-label="复制任务链接" title="复制任务链接" @click="copyTaskReference('link')"><Link :size="14" /></button></div></div>
          <button class="match-summary" @click="detailTab = 'materials'"><span><strong>{{ matchStatusLabel(selectedJob.matchLink) }}</strong><span :class="footageTone(selectedJob.footage)">{{ footageLabel(selectedJob.footage) }}</span></span><span>查看关联依据与录像 <ExternalLink :size="12" /></span></button>
          <ol v-if="selectedJob.status !== 'skipped'" class="pipeline" aria-label="生产进度"><li v-for="(step, index) in pipelineSteps" :key="step.id" :class="stepState(step.id)"><span class="step-icon"><Check v-if="stepState(step.id) === 'done'" :size="12" /><LoaderCircle v-else-if="stepState(step.id) === 'active'" :size="12" class="spin" /><CircleAlert v-else-if="stepState(step.id) === 'attention'" :size="12" /><template v-else>{{ index + 1 }}</template></span><span>{{ step.label }}</span></li></ol>
          <div v-if="selectedJob.message && !['ready', 'completed'].includes(selectedJob.status)" class="job-message" :class="{ warning: selectedJob.status === 'attention' }" role="status"><CircleAlert v-if="selectedJob.status === 'attention'" :size="16" /><span>{{ selectedJob.message }}</span><button v-if="canResume" class="btn btn-sm" :disabled="isActive || queueActive || !!actionBusy" @click="resumeJob"><RotateCcw :size="13" /> 继续生产</button></div>
          <p v-if="detailError" class="inline-error" role="alert">{{ detailError }}，当前保留上次结果。</p>
          <div class="detail-tabs" role="tablist" aria-label="详情内容" @keydown="changeTabByKey"><button v-for="tab in detailTabs" :id="`tab-${tab.id}`" :key="tab.id" role="tab" :aria-selected="detailTab === tab.id" :aria-controls="`panel-${tab.id}`" :tabindex="detailTab === tab.id ? 0 : -1" :class="{ active: detailTab === tab.id }" @click="detailTab = tab.id">{{ tab.label }}</button></div>

          <div id="panel-outputs" v-show="detailTab === 'outputs'" role="tabpanel" aria-labelledby="tab-outputs" class="output-grid">
            <section class="preview-section" aria-label="成片预览">
              <ul v-if="qualityWarnings.length" class="quality-notes" aria-label="成片质量提示"><li v-for="warning in qualityWarnings" :key="warning">{{ warning }}</li></ul>
              <div class="version-switch" aria-label="预览版本"><button v-for="version in versions" :key="version.id" :aria-pressed="videoKind === version.id" :class="{ active: videoKind === version.id }" @click="videoKind = version.id">{{ version.label }} <span>{{ formatDuration(selectedJob[version.id]?.duration) }}</span></button></div>
              <p v-if="hasAllVideos && canResume" class="retained-output">这里保留上一版成片，继续生产后更新。</p>
              <video v-if="currentVideo?.url" :key="`${selectedJob.id}-${videoKind}-${currentVideo.url}`" ref="player" class="video-player" :src="currentVideo.url" :poster="currentVideo.coverUrl" controls playsinline preload="metadata" :aria-label="`${selectedJob.title} · ${videoKind === 'news' ? '新闻版' : '原声集锦'}`" @error="videoError = true" @loadedmetadata="videoError = false" />
              <div v-else class="video-placeholder"><Video :size="28" /><strong>{{ selectedJob.status === 'skipped' ? '这条新闻已跳过' : '成片尚未生成' }}</strong><p>{{ selectedJob.status === 'attention' ? selectedJob.message : '完成素材核验、剪辑和配音后，可在这里播放。' }}</p></div>
              <p v-if="videoError" class="inline-error" role="alert">视频暂时无法播放，请刷新任务或打开成片查看。</p>
              <div :key="videoKind" class="file-links"><a v-if="currentVideo?.url" :href="currentVideo.url" target="_blank" rel="noreferrer"><Download :size="13" /> 打开成片</a><a v-if="currentVideo?.coverUrl" :href="currentVideo.coverUrl" target="_blank" rel="noreferrer"><Image :size="13" /> 查看封面</a><a v-if="videoKind === 'news' && selectedJob.subtitleUrl" :href="selectedJob.subtitleUrl" download="news.srt"><FileText :size="13" /> 下载字幕</a><a v-if="videoKind === 'news' && currentVideo?.url" :href="`/api/v1/cba-video/jobs/${encodeURIComponent(selectedJob.id)}/manual-template`" download><Download :size="13" /> 下载剪映模板</a><span v-if="currentVideo?.url">16:9 · {{ videoKind === 'news' ? '新闻口播' : '现场原声' }}</span></div>
              <p v-if="videoKind === 'news' && currentVideo?.url" class="template-note">模板只含两版成片实际使用的剪辑片段，并附新闻版、集锦版各自的合成音频和时间轴；新闻版另附 SRT。</p>
            </section>
            <section class="upload-section" aria-labelledby="upload-title">
              <header class="section-head"><div><h3 id="upload-title">平台草稿</h3><p>{{ savedUploadCount }} / {{ expectedUploadCount }} 条已保存</p><p v-if="selectedJob.baijiahaoAccountName">百家号 · {{ selectedJob.baijiahaoAccountLabel || accountLabel(selectedJob.baijiahaoAccountName) }}</p></div></header>
              <div v-for="target in uploadTargets" :key="target.id" class="platform-group"><div class="platform-title"><strong>{{ target.label }}</strong><span v-if="!jobTargets.includes(target.id)">本轮未选择</span></div><div v-for="version in versions" :key="version.id" class="upload-row"><div class="upload-identity"><span>{{ version.short }}</span><a v-if="uploadReceipt(target.id, version.id)" :href="uploadReceipt(target.id, version.id)" target="_blank" rel="noreferrer">打开草稿 <ExternalLink :size="11" /></a><span v-else class="upload-status" :class="statusTone(uploadItem(target.id, version.id)?.status)">{{ uploadLabel(uploadItem(target.id, version.id)?.status) }}</span></div><p v-if="uploadItem(target.id, version.id)?.message && !uploadReceipt(target.id, version.id)" class="upload-message">{{ uploadItem(target.id, version.id).message }}</p></div></div>
              <button class="btn" :disabled="!canUpload || isActive || queueActive || !!actionBusy" @click="openDialog('upload')"><Upload :size="14" /> {{ selectedJob.status === 'completed' ? '管理上传' : hasUploadIssue ? '继续上传 / 核对回执' : '上传到草稿箱' }}</button>
              <button v-if="hasUploadIssue" class="btn btn-ghost btn-sm" @click="openDialog('connections')">检查平台连接</button>
              <p class="upload-note">{{ selectedVersionLabel }}以平台回执为准。公开发布请在平台完成。</p>
            </section>
          </div>

          <div id="panel-materials" v-show="detailTab === 'materials'" role="tabpanel" aria-labelledby="tab-materials" class="materials-panel">
            <section><header class="section-head"><h3>这条新闻对应哪场比赛</h3><span>{{ matchStatusLabel(selectedJob.matchLink) }}</span></header><p class="linked-match">{{ matchLine(selectedJob) }}</p><p class="material-explanation">{{ selectedJob.matchLink?.reason || '比赛关联依据尚未记录，请继续研究原报道。' }}</p><ul v-if="selectedJob.matchLink?.evidence?.length" class="source-list"><li v-for="(evidence, index) in selectedJob.matchLink.evidence" :key="`${evidence.url}-${index}`"><a v-if="evidence.url" :href="evidence.url" target="_blank" rel="noreferrer">{{ evidence.label }} <ExternalLink :size="12" /></a><strong v-else>{{ evidence.label }}</strong><span v-if="evidence.detail">{{ evidence.detail }}</span></li></ul><ul v-if="selectedJob.matchLink?.candidates?.length" class="match-candidates"><li v-for="candidate in selectedJob.matchLink.candidates" :key="candidate.matchId"><strong>{{ candidate.date }} · {{ candidate.home }} {{ candidate.score || '对阵' }} {{ candidate.away }}</strong><p>{{ candidate.reason }}</p></li></ul></section>
            <section><header class="section-head"><h3>对应比赛原录像</h3><span :class="footageTone(selectedJob.footage)">{{ footageLabel(selectedJob.footage) }}</span></header><p v-if="selectedJob.footage?.status === 'missing'" class="material-notice">原录像已不在本地。成片仍然保留，再次剪辑前需要重新下载。</p><p v-else-if="selectedJob.footage?.status === 'downloaded_unverified'" class="material-explanation">文件已下载，仍需核对比赛日期、双方和比分；核验通过后才能用于剪辑。</p><p v-if="!selectedJob.footage?.files?.length" class="section-empty">{{ selectedJob.footage?.candidateCount ? `已找到 ${selectedJob.footage.candidateCount} 个候选，下载后还需核验画面。` : '尚无可用本地录像。继续生产会先核实比赛并查找对应素材。' }}</p><article v-for="file in selectedJob.footage?.files || []" :key="`${file.jobId}-${file.id}`" class="source-file"><header><div><strong>{{ file.fileName }}</strong><p>{{ materialKind(file.kind) }} · {{ formatDuration(file.duration) || '时长待检查' }} · {{ file.available ? file.verified ? '已下载，比赛已核验' : '已下载，比赛待核验' : '本地文件缺失' }}</p></div><a v-if="file.sourceUrl" :href="file.sourceUrl" target="_blank" rel="noreferrer">咪咕来源 <ExternalLink :size="12" /></a></header><video v-if="file.available && file.previewUrl && detailTab === 'materials'" :src="file.previewUrl" controls playsinline preload="none" class="video-player" :aria-label="`比赛原录像 · ${file.fileName}`" /></article><ul v-if="selectedJob.footage?.candidates?.length" class="source-list"><li v-for="candidate in selectedJob.footage.candidates" :key="candidate.url"><a :href="candidate.url" target="_blank" rel="noreferrer">{{ candidate.title || '咪咕视频候选' }} <ExternalLink :size="12" /></a><span>{{ formatDuration(candidate.duration) || '时长待核验' }} · 候选链接不代表已下载</span></li></ul></section>
          </div>

          <div id="panel-manuscript" v-show="detailTab === 'manuscript'" role="tabpanel" aria-labelledby="tab-manuscript" class="manuscript-panel">
            <section v-if="selectedJob.editorialAudit" class="audit-section" aria-labelledby="audit-title">
              <header class="section-head"><h3 id="audit-title">独立审核</h3><span :class="selectedJob.editorialAudit.decision === 'pass' ? 'success' : 'warning'">{{ ({ pass: '已通过', revise: '需要修改', blocked: '暂无法完成' })[selectedJob.editorialAudit.decision] || '待核对' }}</span></header>
              <p v-if="selectedJob.editorialAudit.reviewedAt" class="audit-time">{{ formatTime(selectedJob.editorialAudit.reviewedAt) }}</p>
              <ul v-if="auditIssues.length" class="audit-issues"><li v-for="(issue, index) in auditIssues" :key="`${issue.code}-${index}`"><p v-if="issue.message">{{ issue.message }}</p><p v-if="issue.suggestion" class="audit-suggestion">{{ issue.suggestion }}</p></li></ul>
            </section>
            <section aria-labelledby="script-title"><header class="section-head"><h3 id="script-title">新闻稿</h3><span>{{ selectedJob.script?.length || 0 }} 段</span></header><ol v-if="selectedJob.script?.length" class="script-list"><li v-for="(part, index) in selectedJob.script" :key="part.id"><span class="script-index">{{ String(index + 1).padStart(2, '0') }}</span><div><span class="script-mode">{{ part.mode === 'original' ? '现场原声' : 'AI 旁白' }}</span><p>{{ part.text || '保留该回合的现场解说与比赛原声。' }}</p></div></li></ol><p v-else class="section-empty">事实核验后，文稿会显示在这里。</p></section>
            <section class="sources-section" aria-labelledby="sources-title"><header class="section-head"><h3 id="sources-title">事实来源</h3><span>{{ selectedJob.sources?.length || 0 }} 条</span></header><ul v-if="selectedJob.sources?.length" class="source-list"><li v-for="(source, index) in selectedJob.sources" :key="`${source.url}-${index}`"><a :href="source.url" target="_blank" rel="noreferrer">{{ source.title || source.url }} <ExternalLink :size="12" /></a><span>{{ sourceHost(source.url) }}</span></li></ul><p v-else class="section-empty">研究后会保留原报道和交叉核实的来源。</p></section>
          </div>
        </template>
      </section>
    </section>
    <footer class="page-foot"><span>缺少录像的新闻会保留原因，继续处理下一条。</span><span>{{ loading ? '正在同步…' : `状态更新于 ${formatTime(checkedAt)}` }}</span></footer>

    <dialog ref="dialog" class="workspace-dialog" :class="{ 'wide-dialog': ['runs', 'resume'].includes(dialogMode) }" aria-labelledby="dialog-title" @close="dialogMode = null" @click="closeOnBackdrop">
      <header><div><h2 id="dialog-title">{{ dialogTitle }}</h2><p v-if="dialogMode === 'start'">筛选虎扑 CBA 热榜和新浪体育新闻，核实对应比赛后使用咪咕录像制作。</p><p v-else-if="dialogMode === 'resume'">从已有进度按顺序续做，沿用每条任务的素材、音色、上传平台与账号。</p><p v-else-if="dialogMode === 'upload'">将所选任务的{{ selectedVersionLabel }}保存到平台草稿箱。</p><p v-else-if="dialogMode === 'connections'">登录完成后，检查连接，再继续原任务。</p><p v-else>每轮生产和上传的真实进展。</p></div><button class="btn btn-icon btn-ghost" aria-label="关闭对话框" title="关闭" @click="closeDialog"><X :size="17" /></button></header>
      <form v-if="dialogMode === 'start' || dialogMode === 'upload'" @submit.prevent="dialogMode === 'start' ? startRun() : uploadJob()">
        <div class="dialog-body form-fields">
          <fieldset v-if="dialogMode === 'start'" class="production-options"><legend>制作什么视频</legend><label><input v-model="productionMode" type="radio" value="both" /><span><strong>新闻口播 + 比赛高亮</strong><small>同主题新闻整合成一篇评论，同场比赛只做一条集锦。</small></span></label><label><input v-model="productionMode" type="radio" value="news" /><span><strong>新闻口播</strong><small>结合同场新闻、数据与采访。目标 90–180 秒，实际口播至少 60 秒。</small></span></label><label><input v-model="productionMode" type="radio" value="highlights" /><span><strong>比赛高亮</strong><small>保留完整回合和现场原声。目标 180–300 秒，至少 90 秒。</small></span></label><p>信息或有效回合不足时会保留原因，不重复画面、停帧或凑字数出片。</p></fieldset>
          <label v-if="dialogMode === 'start'" class="field"><span>新闻范围</span><select v-model="limit"><option value="">两来源当前可采集新闻</option><option value="5">前 5 条</option><option value="10">前 10 条</option><option value="20">前 20 条</option></select><small>综合两来源筛选 CBA 新闻，跳过重复报道，同场复用已下载素材。</small></label>
          <label v-if="dialogMode === 'start'" class="check-line"><input v-model="autoUpload" type="checkbox" /><span><strong>成片后自动上传到草稿箱</strong><small>本地成片保留，上传失败可继续处理。</small></span></label>
          <fieldset v-if="dialogMode === 'upload' || autoUpload"><legend>目标平台</legend><label v-for="target in uploadTargets" :key="target.id"><input v-model="targets" type="checkbox" :value="target.id" />{{ target.label }}</label></fieldset>
          <div v-if="needsBaijiahaoAccount" class="account-picker">
            <p class="form-note">百家号上传时输入 #热爆趣创赛 并选择第一条候选话题；最多等 10 秒，失败则跳过话题继续保存草稿。</p>
            <label class="field"><span>上传到百家号账号</span><select v-model="baijiahaoAccountName" :disabled="accountsLoading"><option value="" disabled>{{ accountsLoading ? '正在读取账号…' : '请选择已登录账号' }}</option><option v-for="account in accountsState.accounts" :key="account.accountName" :value="account.accountName" :disabled="account.status !== 'ready'">{{ account.label }}{{ account.isDefault ? '（默认）' : '' }}{{ account.status !== 'ready' ? ' · 需登录' : '' }}</option></select><small>{{ dialogMode === 'upload' ? selectedVersionLabel : '本轮成片' }}上传到这个账号。</small></label>
            <p v-if="accountsError" class="inline-error" role="alert">{{ accountsError }}</p>
            <button class="btn btn-ghost btn-sm" type="button" @click="openAccounts"><Users :size="14" />{{ accountsState.accounts.length ? '管理账号 / 添加账号' : '添加百家号账号' }}</button>
          </div>
          <div v-if="dialogMode === 'start'" class="form-note"><Mic2 :size="15" /><span>沿用 A 音色 · MiniMax 电台主播 · 1.08 倍语速<br />本轮将自动核验制作预览并生成旁白和成片。</span></div><p v-else class="form-note">已保存的草稿会复用；上传结果不确定时，先核对原回执。</p>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
        </div>
        <footer><button class="btn btn-ghost" type="button" @click="closeDialog">取消</button><button class="btn btn-primary" type="submit" :disabled="!!actionBusy || isActive || queueActive || accountSelectionInvalid || ((dialogMode === 'upload' || autoUpload) && !targets.length)"><LoaderCircle v-if="actionBusy" :size="14" class="spin" /><Play v-else-if="dialogMode === 'start'" :size="14" /><Upload v-else :size="14" />{{ actionBusy ? '正在提交…' : dialogMode === 'start' ? '开始扫描并生产' : '保存到所选草稿箱' }}</button></footer>
      </form>
      <form v-else-if="dialogMode === 'resume'" @submit.prevent="startResumeQueue">
        <div class="dialog-body resume-selection">
          <p v-if="resumeCandidatesLoading" class="section-empty" role="status">正在读取可恢复任务…</p>
          <div v-else-if="resumeCandidatesError"><p class="inline-error" role="alert">{{ resumeCandidatesError }}</p><button class="btn btn-sm" type="button" @click="loadResumeCandidates">重新读取</button></div>
          <template v-else>
            <div v-if="resumeCandidates.length" class="resume-selection-head"><span>已选 {{ selectedResumeItems.length }} / {{ resumeCandidates.length }} 条</span><button class="btn btn-ghost btn-sm" type="button" :disabled="!!actionBusy" @click="toggleResumeSelection">{{ allResumeSelected ? '取消全选' : '全选' }}</button></div>
            <ul v-if="resumeCandidates.length" class="resume-candidates"><li v-for="item in resumeCandidates" :key="item.id"><label><input v-model="resumeSelectedIds" type="checkbox" :value="item.id" :disabled="!!actionBusy" /><span><strong>{{ item.title }}</strong><small>{{ resumeActionLabel(item) }} · {{ resumePolicyLabel(item) }}</small></span></label></li></ul>
            <p v-else class="section-empty">现有任务都已完成，或正在处理中。</p>
            <p class="form-note">{{ isActive ? '当前任务结束后自动开始。' : '' }}单条失败会保留原因并继续下一条。关闭页面后队列继续运行。</p>
          </template>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
        </div>
        <footer><button class="btn btn-ghost" type="button" @click="closeDialog">取消</button><button class="btn btn-primary" type="submit" :disabled="!canStartResumeQueue"><LoaderCircle v-if="actionBusy === 'resume-queue'" :size="14" class="spin" /><RotateCcw v-else :size="14" />{{ actionBusy === 'resume-queue' ? '正在提交…' : `${isActive ? '加入续做队列' : '开始续做'}（${selectedResumeItems.length}）` }}</button></footer>
      </form>
      <template v-else-if="dialogMode === 'connections'">
        <div class="dialog-body connection-list"><p v-if="runtimeLoading && !runtime" role="status">正在检查生产环境和平台登录…</p><p v-if="runtimeError" class="inline-error" role="alert">{{ runtimeError }}</p>
          <div class="connection-row"><div><strong>自动生产</strong><p>{{ runtime?.production?.message || '尚未检查' }}</p></div><span class="connection-state" :class="{ success: runtime?.production?.ready }">{{ runtime ? runtime.production?.ready ? '就绪' : '需处理' : '待检查' }}</span></div>
          <div class="connection-row"><div><strong>百家号</strong><p>添加账号后，在生产或上传时选择。</p></div><button class="btn btn-sm" @click="openAccounts">管理账号</button></div>
          <div v-for="target in uploadTargets.filter(item => item.platform === 'tencent')" :key="target.id" class="connection-row"><div><strong>{{ target.label }}</strong><p>{{ runtime?.platforms?.[target.platform]?.message || '尚未检查登录状态' }}</p></div><span v-if="runtime?.platforms?.[target.platform]?.ready" class="connection-state success">已连接</span><button v-else class="btn btn-sm" :disabled="!!actionBusy" @click="openLogin(target.platform)">{{ actionBusy === target.platform ? '打开中…' : '打开登录' }} <ExternalLink :size="12" /></button></div>
          <p v-if="connectionNotice" class="form-note" role="status">{{ connectionNotice }}</p><p v-if="runtime && !runtime.installed" class="inline-error">{{ runtime.message }}</p>
        </div>
        <footer><span class="muted">{{ runtimeCheckedAt ? `检查于 ${formatTime(runtimeCheckedAt)}` : '' }}</span><button class="btn" :disabled="runtimeLoading || !!actionBusy" @click="loadRuntime(true)"><RefreshCw :size="14" :class="{ spin: runtimeLoading }" />{{ runtimeLoading ? '检查中…' : '检查连接' }}</button></footer>
      </template>
      <template v-else-if="dialogMode === 'runs'">
        <div class="dialog-body run-list"><section v-if="resumeQueue" class="resume-history"><h3>{{ resumeQueueHeading }}</h3><p>{{ resumeQueueSummary }}</p><ol><li v-for="item in resumeQueue.items" :key="item.runId"><div><strong>{{ item.title }}</strong><span :class="statusTone(item.outcome || item.status)">{{ queueItemStatusLabel(item.outcome || item.status) }}</span></div><p v-if="item.message">{{ item.message }}</p></li></ol></section><p v-if="!overview.runs.length" class="section-empty">还没有运行记录。现有本地成片已自动导入新闻任务。</p><details v-for="(run, index) in overview.runs" :key="run.id" :open="index === 0 && !resumeQueue"><summary><span><strong>{{ runKindLabel(run.kind) }}</strong><small>{{ formatTime(run.createdAt) }}</small></span><span class="run-state" :class="statusTone(runRecovered(run) ? 'completed' : run.status)">{{ runRecovered(run) ? '草稿已恢复' : runStatusLabel(run.status) }}</span></summary><p>{{ runRecovered(run) ? runRecoveryMessage(run) : run.message }}</p><ul v-if="run.logs?.length" class="run-logs"><li v-for="(line, lineIndex) in run.logs" :key="lineIndex">{{ line }}</li></ul><p v-else class="muted">本轮尚无详细记录。</p></details></div>
        <footer><button class="btn" :disabled="loading" @click="refresh"><RefreshCw :size="14" :class="{ spin: loading }" />刷新状态</button></footer>
      </template>
    </dialog>
    <BaijiahaoAccounts v-if="accountsOpen" @updated="updateAccounts" @close="closeAccounts" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, Check, CircleAlert, Copy, Download, ExternalLink, FileText, History, Image, Inbox, Link, LoaderCircle, Mic2, Newspaper, Play, Plug, RefreshCw, RotateCcw, Search, Square, Trash2, Upload, Users, Video, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { api } from '~/composables/useApi'

useHead({ title: 'CBA 视频工厂 · 火宝短剧' })
const route = useRoute()
const router = useRouter()
const overview = ref({ jobs: [], runs: [], activeRun: null, settings: { autoUpload: true, targets: ['tencent-video', 'baijiahao-video'] } })
const selectedId = ref(taskIdFromQuery(route.query.job))
const selectedJob = ref(null)
const loading = ref(false)
const detailLoading = ref(false)
const pageError = ref('')
const detailError = ref('')
const checkedAt = ref(null)
const search = ref('')
const matchSearch = ref('')
const workspaceView = ref('news')
const filter = ref('all')
const mobileDetail = ref(!!selectedId.value)
const detailTab = ref('outputs')
const videoKind = ref('news')
const videoError = ref(false)
const player = ref(null)
const dialog = ref(null)
const dialogMode = ref(null)
const actionBusy = ref('')
const actionError = ref('')
const resumeCandidates = ref([])
const resumeSelectedIds = ref([])
const resumeCandidatesLoading = ref(false)
const resumeCandidatesError = ref('')
const limit = ref('')
const productionMode = ref('both')
const autoUpload = ref(true)
const targets = ref(['tencent-video', 'baijiahao-video'])
const runtime = ref(null)
const runtimeLoading = ref(false)
const runtimeError = ref('')
const runtimeCheckedAt = ref(null)
const connectionNotice = ref('')
const accountsOpen = ref(false)
const accountsState = ref({ accounts: [], defaultAccountName: null })
const accountsLoading = ref(false)
const accountsError = ref('')
const baijiahaoAccountName = ref('')
let accountsReturnMode = null
const uploadTargets = [{ id: 'tencent-video', label: '视频号', platform: 'tencent' }, { id: 'baijiahao-video', label: '百家号', platform: 'baijiahao' }]
const versionOptions = [{ id: 'news', label: '新闻版', short: '新闻' }, { id: 'highlights', label: '原声集锦', short: '集锦' }]
const versions = computed(() => versionsFor(selectedJob.value))
const selectedVersionLabel = computed(() => versionLabel(versions.value))
const detailTabs = [{ id: 'outputs', label: '成片与上传' }, { id: 'materials', label: '比赛与素材' }, { id: 'manuscript', label: '文稿与来源' }]
const filterOptions = [{ id: 'all', label: '全部' }, { id: 'attention', label: '待处理' }, { id: 'ready', label: '待上传' }, { id: 'completed', label: '已完成' }]
const pipelineSteps = [{ id: 'collecting', label: '读取新闻' }, { id: 'finding_media', label: '匹配录像' }, { id: 'writing', label: '核实编稿' }, { id: 'auditing', label: '独立审核' }, { id: 'rendering', label: '剪辑配音' }, { id: 'uploading', label: '保存草稿' }]
const isActive = computed(() => !!overview.value.activeRun)
const queueJobIds = ref({})
const queueJobPolicies = ref({})
const resumeQueue = computed(() => {
  const queue = overview.value.resumeQueue
  if (!queue) return null
  const result = { ...queue, completed: queue.completed || 0, failed: queue.failed || 0, waitingUpload: queue.waitingUpload || 0, noVideo: queue.noVideo || 0 }
  result.items = (queue.items || []).map(item => {
    if (item.outcome) return item
    const outcome = legacyQueueOutcome(item)
    if (['attention', 'failed'].includes(item.status) && outcome !== 'failed') {
      result.failed = Math.max(0, result.failed - 1)
      if (outcome === 'completed') result.completed++
      if (outcome === 'waiting_upload') result.waitingUpload++
      if (outcome === 'no_video') result.noVideo++
    }
    return { ...item, outcome, message: outcome === 'no_video' ? '没有对应视频'
      : outcome === 'waiting_upload' ? queue.status === 'stopped' ? '成片已生成，队列已停止；继续未完成可恢复上传' : '成片已生成，正在等待上传到所选账号草稿箱'
      : outcome === 'completed' && item.status !== 'completed' ? '当前成片已核验保存到原账号草稿箱，历史尝试记录已保留' : item.message }
  })
  if (queue.status === 'attention' && !result.failed && !result.noVideo) result.status = result.waitingUpload ? 'waiting_upload' : 'completed'
  return result
})
const queueActive = computed(() => !!resumeQueue.value && ['queued', 'running', 'stopping'].includes(resumeQueue.value.status))
const canStopQueue = computed(() => queueActive.value || !!resumeQueue.value && resumeQueue.value.status !== 'stopped' && resumeQueue.value.waitingUpload > 0)
const resumeCandidatesCount = computed(() => overview.value.resumeCandidatesCount ?? overview.value.jobs.filter(job => job.canResume || job.canUpload && job.autoUpload && job.status !== 'completed').length)
const resumeButtonLabel = computed(() => queueActive.value ? resumeQueue.value.status === 'stopping' ? '队列正在停止' : '队列运行中' : `继续未完成（${resumeCandidatesCount.value}）`)
const selectedResumeItems = computed(() => resumeCandidates.value.filter(item => resumeSelectedIds.value.includes(item.id)))
const allResumeSelected = computed(() => resumeCandidates.value.length > 0 && selectedResumeItems.value.length === resumeCandidates.value.length)
const canStartResumeQueue = computed(() => !actionBusy.value && !queueActive.value && !resumeCandidatesLoading.value && !resumeCandidatesError.value && selectedResumeItems.value.length > 0)
const resumeQueueHeading = computed(() => {
  const queue = resumeQueue.value
  if (!queue) return ''
  const index = queue.items?.findIndex(item => ['running', 'stopping'].includes(item.status)) ?? -1
  return queue.status === 'running' && index >= 0 ? `续做队列 · 第 ${index + 1} / ${queue.total} 条`
    : `续做队列 · ${{ queued: '等待当前任务结束', running: '正在执行', stopping: '正在停止', stopped: '已停止', completed: '已完成', waiting_upload: '等待上传', attention: '部分任务待处理' }[queue.status] || '待处理'}`
})
const resumeQueueSummary = computed(() => {
  const queue = resumeQueue.value
  if (!queue) return ''
  return `本轮已处理 ${queue.processed || 0} / ${queue.total} 条 · 完成 ${queue.completed || 0}${queue.waitingUpload ? ` · 等待上传 ${queue.waitingUpload}` : ''}${queue.noVideo ? ` · 没有对应视频 ${queue.noVideo}` : ''} · 失败 ${queue.failed || 0} · 待执行 ${queue.pending || 0}${queue.stopped ? ` · 已停止 ${queue.stopped}` : ''}`
})
const needsPolling = computed(() => isActive.value || queueActive.value || !!overview.value.recoveryPending || resumeQueue.value?.status !== 'stopped' && !!resumeQueue.value?.waitingUpload)
const latestRun = computed(() => overview.value.runs[0])
const intakeCoverageLabel = computed(() => {
  const coverage = overview.value.intakeCoverage
  return coverage ? `最新首页 ${coverage.total} 条 · 已处理 ${coverage.processed} 条 · 待处理 ${coverage.pending} 条${coverage.retrievedAt ? ` · 读取于 ${formatTime(coverage.retrievedAt)}` : ''}` : ''
})
const outputInventory = computed(() => overview.value.jobs.reduce((total, job) => {
  const videos = versionsFor(job).filter(version => job[version.id]?.url).length
  if (videos) { total.jobs++; total.videos += videos }
  return total
}, { jobs: 0, videos: 0 }))
const materialInventory = computed(() => (overview.value.matches || []).reduce((total, match) => {
  total.matches++
  if (match.footage?.files?.some(file => file.available)) total.downloaded++
  if (match.footage?.status === 'ready') total.ready++
  if (match.footage?.status === 'missing') total.missing++
  return total
}, { matches: 0, ready: 0, downloaded: 0, missing: 0 }))
const filteredMatches = computed(() => (overview.value.matches || []).filter(match => [match.date, match.home, match.away].filter(Boolean).join(' ').toLowerCase().includes(matchSearch.value.trim().toLowerCase())))
const filteredJobs = computed(() => overview.value.jobs.filter(job => (filter.value === 'all' || taskGroup(job) === filter.value) && [job.id, job.title, job.home, job.away].filter(Boolean).join(' ').toLowerCase().includes(search.value.trim().toLowerCase())))
const qualityWarnings = computed(() => selectedJob.value?.quality?.warnings || [])
const currentVideo = computed(() => selectedJob.value?.[videoKind.value])
const hasAllVideos = computed(() => versions.value.length > 0 && versions.value.every(version => !!selectedJob.value?.[version.id]?.url))
const canResume = computed(() => selectedJob.value?.canResume === true)
const canUpload = computed(() => selectedJob.value?.canUpload === true)
const canDeleteTask = computed(() => !!selectedJob.value && !['queued', 'running', 'stopping'].includes(selectedJob.value.status))
const jobTargets = computed(() => selectedJob.value?.targets || overview.value.settings.targets)
const expectedUploadCount = computed(() => jobTargets.value.length * versions.value.length)
const savedUploadCount = computed(() => jobTargets.value.reduce((total, target) => total + versions.value.filter(version => uploadItem(target, version.id)?.status === 'saved' && uploadItem(target, version.id)?.result?.saved).length, 0))
const hasUploadIssue = computed(() => selectedJob.value?.uploads?.some(item => versions.value.some(version => version.id === item.kind) && ['blocked', 'uncertain', 'failed'].includes(item.status)))
const auditIssues = computed(() => selectedJob.value?.editorialAudit?.issues?.filter(issue => issue.message || issue.suggestion) || [])
const needsBaijiahaoAccount = computed(() => (dialogMode.value === 'upload' || autoUpload.value) && targets.value.includes('baijiahao-video'))
const accountSelectionInvalid = computed(() => needsBaijiahaoAccount.value && (accountsLoading.value || !!accountsError.value || !accountsState.value.accounts.some(account => account.accountName === baijiahaoAccountName.value && account.status === 'ready')))
const dialogTitle = computed(() => ({ start: '采集新新闻并生产', resume: '继续未完成任务', upload: '上传到平台草稿箱', connections: '平台连接', runs: '运行记录' })[dialogMode.value] || '')
let overviewRequest = null
let detailSequence = 0
let resumeCandidateSequence = 0
let pollTimer
let disposed = false
const pendingRequests = new Map()
const queueResolutionAttempts = new Map()
let queueResolutionWork = null

function formatTime(value) { if (!value) return '尚未检查'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function formatDuration(value) { if (!value || !Number.isFinite(Number(value))) return ''; const seconds = Math.round(Number(value)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function matchLine(job) {
  const match = job.matchLink?.home && job.matchLink?.away ? job.matchLink : job
  return [(match.date || match.matchDate)?.slice(0, 10), match.home && match.away ? `${match.home} ${match.score || '对'} ${match.away}` : job.matchLink ? matchStatusLabel(job.matchLink) : '新闻事件'].filter(Boolean).join(' · ')
}
function matchStatusLabel(link) { return ({ confirmed: '比赛已确认', candidate: '比赛候选待核实', ambiguous: '多场候选 / 证据待核对', unmatched: '尚未匹配比赛', not_applicable: '非单场比赛新闻' })[link?.status] || '比赛关系待检查' }
function footageLabel(footage) { return footage?.label || ({ ready: '已下载 · 比赛已核验', downloaded_unverified: '已下载 · 待核验比赛', missing: '原素材已不在本地 · 需重新下载', not_downloaded: '尚未下载', search_failed: '检索未完成 · 尚未下载', not_found: '本次未找到对应录像', unmatched: '比赛关系待确认' })[footage?.status] || '素材状态待检查' }
function footageTone(footage) { return footage?.status === 'ready' ? 'success' : ['missing', 'search_failed', 'downloaded_unverified'].includes(footage?.status) ? 'warning' : 'neutral' }
function materialKind(kind) { return ({ full_replay: '完整回放', highlights: '比赛集锦' })[kind] || '比赛素材' }
function playableFootage(footage) { return (footage?.files || []).filter(file => file.available && file.previewUrl) }
function sourceReportLabel(report) { return ['ok', 'success'].includes(report.status) ? `已采集 ${report.count || 0} 条` : report.status === 'not_collected' ? '尚未采集' : '采集未完成' }
function sourceLabel(url) { const host = sourceHost(url); return host === 'bbs.hupu.com' || host.endsWith('.hupu.com') ? '虎扑原文' : host === 'sina.com.cn' || host.endsWith('.sina.com.cn') ? '新浪原文' : '新闻原文' }
function versionsFor(job) { return versionOptions.filter(version => !Array.isArray(job?.editions) || job.editions.includes(version.id)) }
function versionLabel(items) { return items.map(version => `${version.short}版`).join('和') }
function runRecovered(run) {
  if (run.status !== 'attention' || !['upload', 'resume'].includes(run.kind) || !run.jobIds?.length || !run.targets?.length) return false
  return run.jobIds.every(id => {
    const job = overview.value.jobs.find(item => item.id === id)
    const jobVersions = versionsFor(job)
    return job?.status === 'completed' && jobVersions.length > 0 && run.targets.every(target => jobVersions.every(version => job.uploads?.some(upload =>
      upload.ownerRunId === run.id && upload.target === target && upload.kind === version.id
      && upload.status === 'saved' && upload.result?.saved === true && upload.result.published === false
      && (target !== 'baijiahao-video' || upload.accountName === run.baijiahaoAccountName))))
  })
}
function runRecoveryMessage(run) {
  const jobs = overview.value.jobs.filter(job => run.jobIds?.includes(job.id))
  const runVersions = versionOptions.filter(version => jobs.some(job => versionsFor(job).some(item => item.id === version.id)))
  return `${versionLabel(runVersions)}已核验保存到原账号草稿箱。`
}
function legacyQueueOutcome(item) {
  if (!['attention', 'failed'].includes(item.status)) return ({ queued: 'pending', stopping: 'running' })[item.status] || item.status
  const ids = item.resolvedJobIds || queueJobIds.value[item.jobId] || [item.jobId]
  const jobs = ids.map(id => overview.value.jobs.find(job => job.id === id))
  if (item.noCorrespondingVideo || jobs.length && jobs.every(job => job?.noCorrespondingVideo)) return 'no_video'
  const run = overview.value.runs.find(run => run.id === item.runId) || queueJobPolicies.value[item.jobId]
  const uploads = []
  for (const job of jobs) {
    const editions = versionsFor(job)
    const selectedTargets = run?.targets || job?.targets
    if (!job || job.validationFailure || !editions.length || !selectedTargets?.length
      || (run?.autoUpload ?? job.autoUpload) !== true
      || !(job.canUpload || job.status === 'running' && job.stage === 'uploading')
      || !editions.every(version => job[version.id]?.url)) return 'failed'
    for (const target of selectedTargets) for (const edition of editions) {
      // Summary uploads are already filtered by the server's current output
      // inputDigest. Keep the run, account, target and edition boundary here.
      const upload = job.uploads?.filter(upload => upload.ownerRunId === item.runId && upload.target === target && upload.kind === edition.id
        && (!upload.jobId || upload.jobId === job.id)
        && (target !== 'baijiahao-video' || !!upload.accountName && upload.accountName === (run?.baijiahaoAccountName || job.baijiahaoAccountName))).at(-1)
      if (!upload?.inputDigest || !upload.fingerprint || !['queued', 'running', 'saved'].includes(upload.status)
        || upload.status === 'saved' && (upload.result?.saved !== true || upload.result.published !== false)) return 'failed'
      uploads.push(upload)
    }
  }
  if (!uploads.length) return 'failed'
  return uploads.some(upload => ['queued', 'running'].includes(upload.status)) ? 'waiting_upload' : 'completed'
}
function resolveLegacyQueueJobs() {
  if (queueResolutionWork) return queueResolutionWork
  const queue = overview.value.resumeQueue
  if (!queue) return
  const pending = (queue.items || []).filter(item => !item.outcome && ['attention', 'failed'].includes(item.status)
    && !overview.value.jobs.some(job => job.id === item.jobId)
    && !queueJobIds.value[item.jobId]?.every(id => overview.value.jobs.some(job => job.id === id))
    && Date.now() - (queueResolutionAttempts.get(item.jobId) || 0) >= 30_000)
  if (!pending.length) return
  queueResolutionWork = (async () => {
    // Each legacy detail scans local records. Resolve one at a time, separately
    // from the overview poll, so slow lookups cannot hold up live progress.
    for (const item of pending) {
      if (disposed || overview.value.resumeQueue?.id !== queue.id) break
      queueResolutionAttempts.set(item.jobId, Date.now())
      try {
        const detail = await api.get(`/cba-video/jobs/${encodeURIComponent(item.jobId)}`)
        if (disposed || overview.value.resumeQueue?.id !== queue.id) break
        if (detail?.id) {
          queueJobIds.value = { ...queueJobIds.value, [item.jobId]: [detail.id] }
          queueJobPolicies.value = { ...queueJobPolicies.value, [item.jobId]: {
            targets: detail.targets, autoUpload: detail.autoUpload, baijiahaoAccountName: detail.baijiahaoAccountName,
          } }
        }
      } catch { /* Keep the original failure and retry unresolved IDs after the cooldown. */ }
    }
  })().finally(() => { queueResolutionWork = null })
  return queueResolutionWork
}
function displayTask(task) {
  const noVideo = !['queued', 'running', 'stopping', 'completed', 'ready'].includes(task.status) && !task.news && !task.highlights
    && (task.noCorrespondingVideo || /(?:没有|不存在|不对应|无法关联|未能关联)(?:可核实的)?(?:具体|对应|CBA|单场|的|一场|该场|本场|\s)*比赛/.test(String(task.message || '')))
  return noVideo ? { ...task, message: '没有对应视频', noCorrespondingVideo: true } : task
}
function statusLabel(status) { return ({ ready: '成片就绪', pending: '待生产', queued: '待续做', running: '进行中', attention: '需要处理', completed: '草稿已保存', skipped: '已跳过', failed: '执行失败' })[status] || '待处理' }
function taskGroup(job) {
  if (['completed', 'skipped'].includes(job.status)) return job.status
  // Queue membership must not hide retained videos or their remaining upload work.
  const editions = versionsFor(job)
  return !job.validationFailure && editions.length && editions.every(version => job[version.id]?.url)
    && (job.canUpload || job.stage === 'uploading') ? 'ready' : 'attention'
}
function taskStatusLabel(job) {
  return taskGroup(job) === 'ready' ? ({ queued: '排队上传', running: '正在上传', attention: '上传待处理' })[job.status] || '待上传' : statusLabel(job.status)
}
function statusTone(status) { return ['completed', 'saved'].includes(status) ? 'success' : ['attention', 'blocked', 'uncertain'].includes(status) ? 'warning' : status === 'failed' ? 'danger' : ['running', 'ready', 'queued', 'waiting_upload'].includes(status) ? 'info' : 'neutral' }
function runKindLabel(kind) { return ({ production: '新闻遍历与生产', resume: '继续生产', upload: '保存平台草稿' })[kind] || '生产任务' }
function runLabel(run) { return run.status === 'stopping' ? '正在停止当前任务' : runKindLabel(run.kind) }
function runStatusLabel(status) { return ({ queued: '排队中', running: '正在执行', stopping: '正在停止', stopped: '本轮已停止', completed: '本轮已完成', attention: '本轮有任务需要处理', failed: '本轮执行失败' })[status] || status }
function queueItemStatusLabel(status) { return ({ pending: '待续做', queued: '待续做', running: '进行中', stopping: '正在停止', stopped: '已停止', completed: '完成', waiting_upload: '等待上传', no_video: '没有对应视频', attention: '待处理', failed: '失败' })[status] || '待处理' }
function resumeActionLabel(item) { return item.action === 'upload' ? '仅恢复草稿上传' : `继续${pipelineSteps.find(step => step.id === item.stage)?.label || '生产'}` }
function resumePolicyLabel(item) {
  if (!item.autoUpload) return '仅生成成片'
  return (item.targets || []).map(target => target === 'baijiahao-video' ? `百家号 · ${item.baijiahaoAccountLabel || item.baijiahaoAccountName || '原账号待补充'}` : uploadTargets.find(platform => platform.id === target)?.label || target).join('、') || '沿用原上传设置'
}
function uploadLabel(status) { return ({ saved: '已保存', queued: '排队中', running: '处理中', blocked: '需处理', uncertain: '待核对', failed: '失败' })[status] || (hasAllVideos.value ? '未上传' : '等待成片') }
function uploadItem(target, kind) { return selectedJob.value?.uploads?.filter(item => item.target === target && item.kind === kind && (target !== 'baijiahao-video' || (item.accountName || null) === (selectedJob.value?.baijiahaoAccountName || null))).at(-1) }
function accountLabel(name) { return accountsState.value.accounts.find(account => account.accountName === name)?.label || name }
function uploadReceipt(target, kind) { const item = uploadItem(target, kind); return item?.status === 'saved' && item.result?.saved ? item.result.draftUrl || item.result.editorUrl : null }
function sourceHost(url) { try { return new URL(url).hostname } catch { return '' } }
function countStatus(status) { return overview.value.jobs.filter(job => taskGroup(job) === status).length }
function clearFilters() { filter.value = 'all'; search.value = '' }
function taskIdFromQuery(value) { return typeof value === 'string' ? value.trim() : Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() : '' }
function updateTaskLink(id, replace = false) {
  const query = { ...route.query }
  if (id) query.job = id
  else delete query.job
  return router[replace ? 'replace' : 'push']({ query, hash: route.hash })
}
async function copyTaskReference(kind) {
  const id = selectedJob.value?.id
  if (!id) return
  const label = kind === 'link' ? '任务链接' : '任务 ID'
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('job', id)
    await navigator.clipboard.writeText(kind === 'link' ? url.href : id)
    toast.success(`${label}已复制`)
  } catch { toast.error(`${label}复制失败`) }
}
function stepState(id) {
  const job = selectedJob.value
  if (!job) return 'todo'
  const index = pipelineSteps.findIndex(step => step.id === id)
  const current = pipelineSteps.findIndex(step => step.id === job.stage)
  if (index < 0) return 'todo'
  if (job.status === 'completed' || canUpload.value && index < pipelineSteps.findIndex(step => step.id === 'uploading') || current > index) return 'done'
  if (index === current && job.status === 'attention') return 'attention'
  return index === current && job.status === 'running' ? 'active' : 'todo'
}
function changeTabByKey(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = detailTabs.findIndex(tab => tab.id === detailTab.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + detailTabs.length) % detailTabs.length
  detailTab.value = detailTabs[next].id
  nextTick(() => document.getElementById(`tab-${detailTab.value}`)?.focus())
}
async function loadDetail(id, showLoading = false) {
  if (!id) return
  const sequence = ++detailSequence
  if (showLoading) detailLoading.value = true
  try {
    const detail = await api.get(`/cba-video/jobs/${encodeURIComponent(id)}`)
    if (!disposed && sequence === detailSequence && selectedId.value === id) {
      selectedJob.value = displayTask(detail); detailError.value = ''
      if (detail.id !== id) {
        selectedId.value = detail.id
        if (taskIdFromQuery(route.query.job) === id) void updateTaskLink(detail.id, true)
      }
    }
  } catch (error) {
    if (!disposed && sequence === detailSequence && selectedId.value === id) detailError.value = error.message || '详情加载失败'
  } finally { if (sequence === detailSequence) detailLoading.value = false }
}
async function refresh() {
  if (overviewRequest) return overviewRequest
  loading.value = true
  overviewRequest = (async () => {
    try {
      const result = await api.get('/cba-video')
      if (disposed) return
      overview.value = { ...result, jobs: result.jobs.map(displayTask) }; checkedAt.value = new Date().toISOString(); pageError.value = ''
      if (!result.jobs.some(job => job.id === selectedId.value)) {
        const related = selectedJob.value?.sourceUrl && result.jobs.find(job => job.sourceUrl === selectedJob.value.sourceUrl)
        const id = related?.id || taskIdFromQuery(route.query.job) || result.jobs[0]?.id || ''
        if (id !== selectedId.value) {
          selectedId.value = id
          selectedJob.value = null; detailError.value = ''; detailSequence++; detailLoading.value = false
          if (related && taskIdFromQuery(route.query.job)) void updateTaskLink(id, true)
        }
      }
      void resolveLegacyQueueJobs()
      if (!detailLoading.value) await loadDetail(selectedId.value)
    } catch (error) { if (!disposed) pageError.value = error.message || '状态同步失败，已保留上次结果' }
    finally { loading.value = false; overviewRequest = null }
  })()
  return overviewRequest
}
async function refreshAfterAction() {
  // A GET issued before the action cannot confirm the result of that action.
  if (overviewRequest) await overviewRequest
  return refresh()
}
async function selectJob(id, { updateUrl = true } = {}) {
  workspaceView.value = 'news'
  mobileDetail.value = true
  if (updateUrl && taskIdFromQuery(route.query.job) !== id) void updateTaskLink(id)
  if (id === selectedId.value && selectedJob.value) return
  player.value?.pause(); selectedId.value = id; selectedJob.value = null; detailError.value = ''
  detailTab.value = 'outputs'; videoKind.value = 'news'; videoError.value = false
  await loadDetail(id, true)
}
async function openMatchTask(match) {
  const id = match.jobIds?.find(id => overview.value.jobs.some(job => job.id === id))
  if (!id) return
  workspaceView.value = 'news'
  await selectJob(id)
  detailTab.value = 'materials'
}
async function openDialog(mode) {
  actionError.value = ''; dialogMode.value = mode
  if (mode === 'start') productionMode.value = overview.value.settings.productionMode || 'both'
  if (mode === 'start' || mode === 'upload') { autoUpload.value = overview.value.settings.autoUpload; targets.value = [...(mode === 'upload' ? jobTargets.value : overview.value.settings.targets)]; baijiahaoAccountName.value = mode === 'upload' ? selectedJob.value?.baijiahaoAccountName || '' : ''; loadAccounts(mode) }
  await nextTick(); dialog.value?.showModal()
  if (mode === 'connections') loadRuntime(false)
  if (mode === 'resume') await loadResumeCandidates()
}
async function loadResumeCandidates() {
  const sequence = ++resumeCandidateSequence
  resumeCandidatesLoading.value = true; resumeCandidatesError.value = ''; resumeSelectedIds.value = []
  try {
    const result = await api.get('/cba-video/resume-queue')
    if (!disposed && sequence === resumeCandidateSequence && dialogMode.value === 'resume') {
      resumeCandidates.value = result.items || []
      resumeSelectedIds.value = resumeCandidates.value.map(item => item.id)
    }
  } catch (error) {
    if (!disposed && sequence === resumeCandidateSequence) { resumeCandidates.value = []; resumeCandidatesError.value = error.message || '待续做任务读取失败，请重试' }
  } finally { if (sequence === resumeCandidateSequence) resumeCandidatesLoading.value = false }
}
function toggleResumeSelection() { resumeSelectedIds.value = allResumeSelected.value ? [] : resumeCandidates.value.map(item => item.id) }
function updateAccounts(result) {
  accountsState.value = result; accountsError.value = ''
  if (!baijiahaoAccountName.value) baijiahaoAccountName.value = result.defaultAccountName || ''
}
async function loadAccounts(mode) {
  accountsLoading.value = true; accountsError.value = ''
  try { const result = await api.get('/cba-video/accounts'); if (!disposed) { accountsState.value = result; if (dialogMode.value === mode && !baijiahaoAccountName.value) baijiahaoAccountName.value = result.defaultAccountName || '' } }
  catch (error) { if (!disposed) accountsError.value = error.message || '账号加载失败，请打开账号管理重试' }
  finally { accountsLoading.value = false }
}
function openAccounts() { accountsReturnMode = dialogMode.value; closeDialog(); accountsOpen.value = true }
async function closeAccounts() { accountsOpen.value = false; if (accountsReturnMode) { dialogMode.value = accountsReturnMode; accountsReturnMode = null; await nextTick(); dialog.value?.showModal() } }
function closeDialog() { dialog.value?.close() }
function closeOnBackdrop(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog()
}
async function postOnce(path, body) {
  const key = JSON.stringify({ path, body })
  if (!pendingRequests.has(key)) pendingRequests.set(key, `web-${crypto.randomUUID()}`)
  try { const result = await api.post(path, { ...body, requestId: pendingRequests.get(key) }); pendingRequests.delete(key); return result }
  catch (error) { if (error.status >= 400 && error.status < 500) pendingRequests.delete(key); throw error }
}
async function startRun() {
  if (actionBusy.value || isActive.value || queueActive.value) return
  if (accountSelectionInvalid.value) { actionError.value = '请先添加并选择已登录的百家号账号'; return }
  actionBusy.value = 'start'; actionError.value = ''
  try { await postOnce('/cba-video/runs', { ...(limit.value ? { limit: Number(limit.value) } : {}), productionMode: productionMode.value, autoUpload: autoUpload.value, targets: targets.value.length ? [...targets.value] : [...overview.value.settings.targets], ...(needsBaijiahaoAccount.value ? { baijiahaoAccountName: baijiahaoAccountName.value } : {}) }); closeDialog(); toast.success('已开始筛选虎扑与新浪 CBA 新闻') }
  catch (error) { actionError.value = error.message || '启动结果未确认，请刷新状态后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function startResumeQueue() {
  if (!canStartResumeQueue.value) return
  const jobIds = selectedResumeItems.value.map(item => item.id)
  actionBusy.value = 'resume-queue'; actionError.value = ''
  try {
    const result = await postOnce('/cba-video/resume-queue', { jobIds })
    if (result.queue) overview.value = { ...overview.value, resumeQueue: result.queue }
    closeDialog(); toast.success(isActive.value ? '已加入续做队列，当前任务结束后自动继续' : '已开始按队列继续未完成任务')
  } catch (error) { actionError.value = error.message || '队列提交结果未确认，请刷新状态后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function stopResumeQueue() {
  if (actionBusy.value || !canStopQueue.value || resumeQueue.value.status === 'stopping') return
  const queueId = resumeQueue.value.id
  actionBusy.value = 'stop-queue'
  try { await api.post(`/cba-video/resume-queue/${encodeURIComponent(queueId)}/stop`, {}); toast.success('已请求停止续做队列，已有进度会保留') }
  catch (error) { toast.error(error.message || '停止队列结果未确认，请刷新状态') }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function stopRun() {
  if (actionBusy.value || !overview.value.activeRun) return
  actionBusy.value = 'stop'
  try { await api.post(`/cba-video/runs/${encodeURIComponent(overview.value.activeRun.id)}/stop`, {}); toast.success('已请求停止，完成的结果会保留') }
  catch (error) { toast.error(error.message || '停止请求未确认，请刷新状态') }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function resumeJob() {
  if (actionBusy.value || isActive.value || queueActive.value || !canResume.value) return
  actionBusy.value = 'resume'
  try { await postOnce(`/cba-video/jobs/${encodeURIComponent(selectedId.value)}/resume`, {}); toast.success('正在继续自动生产，复用已有素材') }
  catch (error) { toast.error(error.message || '恢复请求未确认，请刷新状态') }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function uploadJob() {
  if (actionBusy.value || isActive.value || queueActive.value || !canUpload.value || !targets.value.length) return
  if (accountSelectionInvalid.value) { actionError.value = '请先添加并选择已登录的百家号账号'; return }
  actionBusy.value = 'upload'; actionError.value = ''
  try { await postOnce(`/cba-video/jobs/${encodeURIComponent(selectedId.value)}/upload`, { targets: [...targets.value], ...(targets.value.includes('baijiahao-video') ? { baijiahaoAccountName: baijiahaoAccountName.value } : {}) }); closeDialog(); toast.success('正在核对成片并保存平台草稿') }
  catch (error) { actionError.value = error.message || '上传请求未确认，请刷新状态后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function deleteTask() {
  if (!canDeleteTask.value || actionBusy.value || !selectedJob.value) return
  const title = selectedJob.value.title
  if (!window.confirm(`确认删除任务“${title}”？\n\n任务将从列表移除；素材、成片和上传凭据保留，符合回收条件后由磁盘管理清理。平台已有草稿不会被撤回。`)) return
  const id = selectedId.value
  actionBusy.value = 'delete'; actionError.value = ''
  try {
    const result = await api.post(`/storage/owners/cba/${encodeURIComponent(id)}/delete-task`, { confirm: true, expectedTitle: title })
    selectedJob.value = null; selectedId.value = ''; mobileDetail.value = false
    await updateTaskLink('', true)
    toast.success(result.platformDraftsRemain ? '任务已删除；平台已有草稿仍需在平台单独处理' : '任务已删除')
  } catch (error) {
    actionError.value = error.message || '删除结果未确认，请刷新状态后重试'
    toast.error(actionError.value)
  } finally { await refreshAfterAction(); actionBusy.value = '' }
}
async function loadRuntime(force) {
  if (runtimeLoading.value) return
  runtimeLoading.value = true; runtimeError.value = ''
  try { runtime.value = await api.get(`/cba-video/runtime?refresh=${force}`); runtimeCheckedAt.value = new Date().toISOString() }
  catch (error) { runtimeError.value = error.message || '连接检查失败，请重试' }
  finally { runtimeLoading.value = false }
}
async function openLogin(platform) {
  if (actionBusy.value) return
  actionBusy.value = platform; runtimeError.value = ''; connectionNotice.value = ''
  try { const result = await api.post('/cba-video/runtime/login', { platform }); connectionNotice.value = result.message || '已打开登录窗口，完成登录后点击“检查连接”。' }
  catch (error) { runtimeError.value = error.message || '无法打开登录窗口' }
  finally { actionBusy.value = '' }
}
watch(needsPolling, active => { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined }; if (active) pollTimer = window.setInterval(refresh, 5000) })
watch(versions, items => { if (!items.some(version => version.id === videoKind.value)) videoKind.value = items[0]?.id || 'news' }, { flush: 'sync' })
watch(detailTab, tab => { if (tab !== 'outputs') player.value?.pause() })
watch(videoKind, () => { videoError.value = false })
watch(() => route.query.job, value => {
  const requested = taskIdFromQuery(value), id = requested || overview.value.jobs[0]?.id || ''
  if (id !== selectedId.value) {
    clearFilters()
    if (id) void selectJob(id, { updateUrl: false })
    else { selectedId.value = ''; selectedJob.value = null; detailError.value = ''; detailSequence++; detailLoading.value = false }
  }
  if (!requested) mobileDetail.value = false
})
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; detailSequence++; resumeCandidateSequence++; if (pollTimer) window.clearInterval(pollTimer); player.value?.pause() })
</script>

<style scoped>
.cba-page { --cba-font: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; --cba-green: #15803d; --cba-amber: #92400e; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 22px 28px 12px; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 var(--cba-font); letter-spacing: 0; overflow: auto; }
.cba-page :is(h1,h2,h3,p,button,input,select) { font-family: var(--cba-font); letter-spacing: 0; }
.cba-page :is(button,a,input,select,summary):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.cba-page h1 { font-size: 21px; font-weight: 650; line-height: 1.3; }.cba-page h2 { font-size: 18px; font-weight: 600; }.cba-page h3 { font-size: 14px; font-weight: 600; }
.intake-coverage { margin-bottom: 12px; color: var(--text-2); font-size: 12px; }
.cba-page .btn { border-radius: 6px; box-shadow: none; transform: none; min-height: 34px; }.cba-page .btn-sm { min-height: 30px; padding: 4px 10px; font-size: 12px; }.cba-page .btn-icon { padding: 6px; width: 32px; min-height: 32px; }
.page-head, .head-actions, .source-strip, .queue-head, .queue-bottom, .detail-meta, .detail-status, .section-head, .platform-title, .upload-identity, .file-links, .page-foot { display: flex; align-items: center; }
.page-head { justify-content: space-between; gap: 24px; margin-bottom: 18px; flex-shrink: 0; flex-wrap: wrap; }.page-head p { margin-top: 5px; color: var(--text-2); font-size: 12px; }.head-actions { gap: 8px; flex-wrap: wrap; }
.source-strip { gap: 14px; padding: 12px 0; border-block: 1px solid var(--border); color: var(--text-2); font-size: 12px; flex-shrink: 0; }.source-strip a { display: inline-flex; align-items: center; gap: 6px; color: var(--text-1); text-decoration: none; font-weight: 500; }
.source-strip a:hover, .file-links a:hover, .detail-meta a:hover, .source-list a:hover { text-decoration: underline; }.source-defaults { display: flex; align-items: center; gap: 6px; margin-left: auto; }.separator { margin-inline: 5px; color: var(--border-strong); }
.run-banner, .page-alert { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-top: 12px; border: 1px solid var(--border); border-radius: 6px; flex-shrink: 0; }.run-banner { background: var(--info-bg); color: var(--info); }.run-banner > div { flex: 1; min-width: 0; }.run-banner p { color: var(--text-1); font-size: 12px; overflow-wrap: anywhere; }.run-banner.warning, .job-message.warning { background: var(--warning-bg); color: var(--cba-amber); }.page-alert { color: var(--error); background: var(--error-bg); }.page-alert span { flex: 1; overflow-wrap: anywhere; }
.resume-queue-banner progress { display: block; width: min(340px, 100%); height: 5px; margin-top: 8px; accent-color: var(--info); border: 0; border-radius: 3px; overflow: hidden; }.resume-queue-banner progress::-webkit-progress-bar { background: var(--border); }.resume-queue-banner progress::-webkit-progress-value { background: var(--info); }
.workspace { display: grid; grid-template-columns: 304px minmax(0,1fr); flex: 1; min-height: 440px; overflow: hidden; border-bottom: 1px solid var(--border); }.queue-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); padding-top: 16px; }.queue-head { padding: 0 14px 10px 0; justify-content: space-between; }.queue-head h2 { font-size: 15px; }.queue-head h2 span { font-size: 12px; font-weight: 400; color: var(--text-2); margin-left: 6px; }
.output-inventory { padding: 0 14px 9px 0; color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.queue-filters { display: flex; gap: 3px; padding: 0 14px 12px 0; }.queue-filters button { background: none; border: 0; border-radius: 5px; padding: 5px 7px; color: var(--text-2); font-size: 12px; cursor: pointer; white-space: nowrap; }.queue-filters button.active { color: var(--text-0); background: var(--bg-2); font-weight: 600; }.queue-filters span { font-size: 11px; margin-left: 2px; font-variant-numeric: tabular-nums; }
.queue-search { display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 8px; margin: 0 14px 14px 0; border: 1px solid var(--border); border-radius: 5px; color: var(--text-2); }.queue-search:focus-within { outline: 2px solid var(--info); outline-offset: 1px; }.queue-search input { width: 100%; min-width: 0; background: transparent; border: 0; font-size: 12px; outline: none !important; color: var(--text-1); }
.queue-list { list-style: none; overflow: auto; border-top: 1px solid var(--border); padding-bottom: 16px; }.queue-item { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--border); background: none; padding: 14px 14px 14px 10px; cursor: pointer; }.queue-item:hover { background: var(--bg-hover); }.queue-item.selected { background: var(--info-bg); box-shadow: inset 3px 0 var(--info); }.queue-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-1); font-size: 13px; line-height: 1.65; font-weight: 550; }.queue-meta { display: block; color: var(--text-2); font-size: 11px; margin: 6px 0 9px; }.queue-bottom { justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }.queue-cause { display: block; margin-top: 7px; font-size: 11px; color: var(--cba-amber); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-label { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); white-space: nowrap; }.status-label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }.success { color: var(--cba-green); }.warning { color: var(--cba-amber); }.danger { color: var(--error); }.info { color: var(--info); }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; flex: 1; padding: 32px 20px; color: var(--text-2); text-align: center; }.empty-state p { max-width: 360px; font-size: 12px; }.empty-state strong { font-size: 13px; color: var(--text-1); }.detail-empty { min-height: 390px; }
.detail-pane { padding: 22px 0 24px 28px; min-width: 0; overflow: auto; container-type: inline-size; }.back-button { display: none; }.detail-status { font-size: 12px; gap: 10px; margin-bottom: 8px; }.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }.detail-heading { min-width: 0; }.detail-head h2 { font-size: 20px; line-height: 1.5; max-width: 1000px; overflow-wrap: anywhere; }.delete-task-button { flex-shrink: 0; color: var(--text-2); }.delete-task-button:not(:disabled):hover { color: var(--error); background: var(--error-bg); }.detail-meta { gap: 14px; flex-wrap: wrap; color: var(--text-2); font-size: 12px; margin-top: 7px; }.detail-meta a { display: inline-flex; align-items: center; gap: 3px; color: var(--info); text-decoration: none; }
.pipeline { display: flex; list-style: none; gap: 8px; margin-top: 20px; padding: 14px 0; border-block: 1px solid var(--border); }.pipeline li { flex: 1; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }.pipeline li:not(:last-child)::after { content: ''; flex: 1; height: 1px; background: var(--border); margin-inline: 4px; }.step-icon { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--border-strong); border-radius: 50%; font-size: 10px; flex-shrink: 0; }.pipeline li.done { color: var(--cba-green); }.pipeline li.done .step-icon { background: var(--success-bg); border-color: transparent; }.pipeline li.active { color: var(--info); }.pipeline li.active .step-icon { background: var(--info-bg); border-color: var(--info); }.pipeline li.attention { color: var(--cba-amber); }.pipeline li.attention .step-icon { border-color: var(--cba-amber); }
.job-message { display: flex; align-items: center; gap: 8px; padding: 10px 0; color: var(--text-2); font-size: 12px; }.job-message.warning { padding: 10px 12px; margin-top: 12px; border-radius: 5px; }.job-message > span { flex: 1; overflow-wrap: anywhere; }.job-message > svg { flex-shrink: 0; }
.detail-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--border); }.detail-tabs button { border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 11px 0; background: none; color: var(--text-2); font-size: 13px; cursor: pointer; }.detail-tabs button.active { color: var(--text-0); border-color: var(--text-0); font-weight: 600; }
.output-grid { display: grid; grid-template-columns: minmax(0,1fr); gap: 24px; padding-top: 18px; }.preview-section { min-width: 0; }.version-switch { display: flex; align-items: center; gap: 4px; margin-bottom: 12px; }.version-switch button { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid transparent; border-radius: 5px; background: none; color: var(--text-2); font-size: 12px; cursor: pointer; }.version-switch button.active { background: var(--bg-2); color: var(--text-1); font-weight: 600; }.version-switch span { font-variant-numeric: tabular-nums; font-weight: 400; font-size: 11px; color: var(--text-2); }
.video-player { display: block; width: 100%; max-height: 56vh; aspect-ratio: 16/9; background: #18181b; border-radius: 6px; object-fit: contain; }.video-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; aspect-ratio: 16/9; min-height: 160px; padding: 24px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px; color: var(--text-2); text-align: center; }.video-placeholder p { font-size: 12px; max-width: 350px; }
.file-links { gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; }.file-links a { display: inline-flex; align-items: center; gap: 4px; color: var(--text-1); text-decoration: none; }.file-links > span { color: var(--text-2); margin-left: auto; font-size: 11px; }.template-note { margin-top: 9px; color: var(--text-2); font-size: 11px; line-height: 1.65; max-width: 680px; }
.section-head { justify-content: space-between; gap: 10px; margin-bottom: 12px; }.section-head p, .section-head > span { color: var(--text-2); font-size: 12px; margin-top: 3px; }.upload-section { border-top: 1px solid var(--border); padding-top: 18px; }.upload-section > .btn { margin-top: 14px; }.platform-group { border-bottom: 1px solid var(--border); padding: 9px 0 7px; }.platform-title { justify-content: space-between; gap: 6px; margin-bottom: 5px; font-size: 12px; }.platform-title > span { font-size: 11px; color: var(--text-2); }.upload-row { padding: 5px 0; }.upload-identity { gap: 16px; justify-content: space-between; font-size: 12px; }.upload-identity > span:first-child { color: var(--text-2); }.upload-status { font-size: 11px; }.upload-identity a { display: inline-flex; align-items: center; gap: 3px; color: var(--cba-green); font-size: 11px; text-decoration: none; }.upload-identity a:hover { text-decoration: underline; }.upload-message { font-size: 11px; color: var(--cba-amber); margin-top: 4px; overflow-wrap: anywhere; }.upload-note { margin-top: 10px; color: var(--text-2); font-size: 11px; line-height: 1.7; max-width: 440px; }
.manuscript-panel { padding-top: 20px; max-width: 900px; }.script-list { list-style: none; }.script-list li { display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); }.script-index { padding-top: 3px; font: 11px var(--font-mono); color: var(--text-2); }.script-mode { font-size: 11px; color: var(--text-2); }.script-list p { margin-top: 5px; font-size: 15px; line-height: 1.9; }.sources-section { padding-top: 24px; }.source-list { list-style: none; }.source-list li { padding: 10px 0; border-bottom: 1px solid var(--border); }.source-list a { display: inline; color: var(--info); text-decoration: none; overflow-wrap: anywhere; }.source-list svg { vertical-align: middle; }.source-list span { display: block; font-size: 11px; color: var(--text-2); margin-top: 3px; }.section-empty { padding: 22px 0; color: var(--text-2); font-size: 12px; }.page-foot { justify-content: space-between; gap: 12px; padding-top: 10px; flex-shrink: 0; color: var(--text-2); font-size: 11px; }
.workspace-dialog { position: fixed; inset: 0; margin: auto; padding: 0; width: min(510px,calc(100vw - 32px)); max-height: calc(100dvh - 48px); background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-elevated); color: var(--text-1); overflow: auto; }.workspace-dialog::backdrop { background: rgb(9 9 11 / 32%); }.workspace-dialog.wide-dialog { width: min(700px,calc(100vw - 32px)); }.workspace-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 22px 16px; border-bottom: 1px solid var(--border); }.workspace-dialog h2 { font-size: 18px; line-height: 1.5; }.workspace-dialog header p { margin-top: 5px; font-size: 12px; color: var(--text-2); }.dialog-body { padding: 20px 22px; }.workspace-dialog footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--border); }.workspace-dialog footer > .muted { margin-right: auto; }
.form-fields { display: grid; gap: 22px; }.field { display: grid; gap: 7px; }.field > span { font-weight: 550; }.field select { padding: 8px 10px; background: var(--bg-0); border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-1); font-size: 13px; }.field small { color: var(--text-2); font-size: 11px; }.check-line { display: flex; align-items: flex-start; gap: 9px; }.check-line input { margin-top: 4px; }.check-line small { display: block; color: var(--text-2); font-size: 11px; margin-top: 3px; }.form-fields input { accent-color: var(--accent); width: 15px; height: 15px; }.form-fields fieldset { display: flex; flex-wrap: wrap; gap: 22px; border: 0; }.form-fields legend { margin-bottom: 10px; font-weight: 550; }.form-fields fieldset label { display: inline-flex; align-items: center; gap: 7px; }.form-note { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: var(--bg-1); border-radius: 5px; color: var(--text-2); font-size: 12px; line-height: 1.75; }.form-note > svg { flex-shrink: 0; margin-top: 3px; }
.resume-selection { padding-top: 10px; }.resume-selection-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 12px; color: var(--text-2); }.resume-candidates { list-style: none; max-height: min(42vh, 380px); overflow: auto; border-block: 1px solid var(--border); margin-bottom: 14px; }.resume-candidates li + li { border-top: 1px solid var(--border); }.resume-candidates label { display: flex; align-items: flex-start; gap: 11px; padding: 12px 5px; cursor: pointer; }.resume-candidates label:hover { background: var(--bg-hover); }.resume-candidates input { flex-shrink: 0; margin-top: 4px; width: 15px; height: 15px; accent-color: var(--accent); }.resume-candidates strong { display: block; font-size: 13px; font-weight: 550; line-height: 1.65; overflow-wrap: anywhere; }.resume-candidates small { display: block; color: var(--text-2); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }.resume-history { margin-bottom: 18px; border-bottom: 1px solid var(--border); }.resume-history > p { margin-top: 4px; font-size: 12px; color: var(--text-2); }.resume-history ol { max-height: 330px; overflow: auto; margin-top: 12px; padding-left: 24px; }.resume-history li { padding: 10px 0; border-top: 1px solid var(--border); font-size: 12px; }.resume-history li > div { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.resume-history strong { font-weight: 500; overflow-wrap: anywhere; }.resume-history li span { flex-shrink: 0; }.resume-history li p { margin-top: 5px; color: var(--text-2); overflow-wrap: anywhere; }
.inline-error { color: var(--error); font-size: 12px; overflow-wrap: anywhere; margin-block: 8px; }.connection-list { padding-top: 6px; }.connection-row { display: flex; align-items: center; gap: 14px; padding: 17px 0; border-bottom: 1px solid var(--border); }.connection-row > div { flex: 1; min-width: 0; }.connection-row p { margin-top: 5px; font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }.connection-state { font-size: 12px; white-space: nowrap; }.connection-list .form-note { margin-top: 14px; }
.run-list details { border-bottom: 1px solid var(--border); padding: 12px 0; }.run-list details:first-child { padding-top: 0; }.run-list summary { display: flex; align-items: center; gap: 12px; cursor: pointer; }.run-list summary::before { content: '›'; color: var(--text-2); font-size: 18px; }.run-list details[open] summary::before { transform: rotate(90deg); }.run-list summary > span:first-of-type { flex: 1; }.run-list summary small { display: block; font-size: 11px; color: var(--text-2); font-weight: 400; margin-top: 3px; }.run-state { font-size: 12px; }.run-list details > p { font-size: 12px; margin-top: 14px; overflow-wrap: anywhere; }.run-logs { list-style: none; margin-top: 12px; background: var(--bg-1); padding: 4px 12px; border-radius: 5px; max-height: 330px; overflow: auto; }.run-logs li { padding: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.75; border-bottom: 1px solid var(--border); }.run-logs li:last-child { border: 0; }.muted { color: var(--text-2); font-size: 11px; }
.detail-pane { padding-top: 16px; }
.detail-head h2 { font-size: 18px; }
.pipeline { margin-top: 14px; padding-block: 10px; }
.detail-tabs button { padding-block: 9px; }
.audit-section { padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }.audit-section .section-head { margin-bottom: 4px; }.audit-time { color: var(--text-2); font-size: 11px; }.audit-issues { margin-top: 12px; padding-left: 18px; font-size: 13px; line-height: 1.75; }.audit-issues li + li { margin-top: 10px; }.audit-suggestion { color: var(--text-2); }
.output-grid { padding-top: 14px; }
.retained-output { color: var(--cba-amber); font-size: 12px; margin-bottom: 10px; }
.video-player { max-height: max(220px, calc(100dvh - 430px)); }
.source-health { display: flex; flex-wrap: wrap; gap: 6px 22px; padding-top: 7px; color: var(--text-2); font-size: 11px; }
.source-health strong { color: var(--text-1); font-weight: 500; margin-right: 3px; }.source-health .source-failed { color: var(--cba-amber); overflow-wrap: anywhere; }
.workspace-switch { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding-top: 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.workspace-switch button { display: inline-flex; align-items: center; gap: 7px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-2); padding: 10px 14px; cursor: pointer; font-size: 13px; }
.workspace-switch button.active { color: var(--text-0); border-color: var(--text-0); font-weight: 600; }.workspace-switch button span { font-weight: 400; color: var(--text-2); font-size: 11px; }.workspace-switch > span { margin-left: auto; color: var(--text-2); font-size: 11px; }
.queue-material { display: block; font-size: 11px; margin: -3px 0 8px; overflow-wrap: anywhere; }.footage-status { font-size: 12px; }
.queue-id { display: block; margin-top: 5px; color: var(--text-2); font: 11px/1.6 var(--font-mono); overflow-wrap: anywhere; }
.task-identity { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--text-2); font-size: 11px; }
.task-identity > span { flex-shrink: 0; }.task-id-value { min-width: 0; max-width: 100%; font: 11px/1.6 var(--font-mono); overflow-wrap: anywhere; user-select: text; }
.task-identity-actions { display: flex; flex-shrink: 0; gap: 2px; }.task-identity-actions .btn-icon { width: 28px; min-height: 28px; height: 28px; padding: 5px; }
.match-summary { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 12px; margin-top: 14px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 5px; text-align: left; color: var(--text-2); font-size: 11px; cursor: pointer; }
.match-summary > span { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 12px; }.match-summary strong { color: var(--text-1); font-weight: 550; }.match-summary > span:last-child { flex-shrink: 0; }
.match-library { flex: 1; min-height: 440px; overflow: auto; padding: 18px 0 24px; }.library-head, .match-card > header, .source-file > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.library-head h2 { font-size: 16px; }.library-head p { font-size: 12px; margin-top: 4px; color: var(--text-2); }.library-search { max-width: 380px; margin-top: 16px; }
.match-card { padding: 20px 0; border-bottom: 1px solid var(--border); }.match-card h3 { margin-top: 4px; font-size: 16px; }.match-card h3 span { font-weight: 500; padding-inline: 8px; }.match-date, .match-sharing { color: var(--text-2); font-size: 11px; }.match-sharing { margin-top: 8px; }
.material-file-list { list-style: none; margin-top: 13px; }.material-file-list li { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-top: 8px; padding: 10px 12px; border-radius: 4px; background: var(--bg-1); }.material-file-list li > div { min-width: 0; }.material-file-list strong { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }.material-file-list span { display: block; margin-top: 3px; color: var(--text-2); font-size: 11px; }
.material-file-list a, .match-card-actions a, .source-file a { display: inline-flex; align-items: center; gap: 4px; color: var(--info); text-decoration: none; font-size: 12px; }.material-file-list a, .source-file a { flex-shrink: 0; }.match-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 20px; margin-top: 12px; }.match-card-actions a { max-width: 420px; overflow-wrap: anywhere; }.match-card-actions svg { flex-shrink: 0; }.material-preview { margin-top: 12px; font-size: 12px; }.material-preview summary { color: var(--info); cursor: pointer; }.material-preview .video-player { margin-top: 12px; max-width: 780px; max-height: 480px; }
.materials-panel { display: grid; gap: 25px; padding-top: 20px; max-width: 960px; }.materials-panel .section-head { align-items: flex-start; flex-wrap: wrap; }.linked-match { font-size: 16px; font-weight: 550; }.material-explanation { color: var(--text-2); font-size: 12px; line-height: 1.8; margin-top: 8px; }.material-notice { color: var(--cba-amber); font-size: 12px; padding: 10px 12px; margin: 12px 0; background: var(--warning-bg, #fffbeb); border-radius: 4px; line-height: 1.7; }
.match-candidates { list-style: none; margin-top: 12px; }.match-candidates li { border-bottom: 1px solid var(--border); padding: 10px 0; font-size: 12px; }.match-candidates strong { font-weight: 500; }.match-candidates p { margin-top: 4px; color: var(--text-2); }.source-file { margin-top: 14px; }.source-file strong { font-weight: 500; font-size: 12px; overflow-wrap: anywhere; }.source-file > header > div { min-width: 0; }.source-file p { color: var(--text-2); font-size: 11px; margin-top: 4px; }.source-file .video-player { margin-top: 12px; max-height: 450px; }
.quality-notes { padding: 10px 12px 10px 28px; margin-bottom: 12px; color: var(--cba-amber); background: var(--warning-bg, #fffbeb); border-radius: 4px; font-size: 12px; line-height: 1.7; }
.form-fields .production-options { display: grid; gap: 11px; }.form-fields .production-options label { align-items: flex-start; gap: 9px; cursor: pointer; }.production-options input { flex-shrink: 0; margin-top: 4px; }.production-options strong { font-size: 13px; font-weight: 550; }.production-options small { display: block; margin-top: 3px; font-size: 11px; line-height: 1.7; color: var(--text-2); }.production-options > p { color: var(--text-2); font-size: 11px; line-height: 1.7; padding-left: 24px; }
@container (min-width: 830px) { .output-grid { grid-template-columns: minmax(0,1fr) 238px; gap: 26px; }.upload-section { border-top: 0; border-left: 1px solid var(--border); padding: 4px 0 0 22px; }.file-links > span { margin-left: 0; } }
@media (max-width: 1180px) { .cba-page { padding-inline: 20px; }.workspace { grid-template-columns: 270px minmax(0,1fr); }.detail-pane { padding-left: 22px; }.source-strip > span:not(.source-defaults) { display: none; }.queue-filters button { padding-inline: 5px; } }
@media (max-width: 920px) { .page-head { gap: 16px; align-items: flex-start; }.page-head p { max-width: 300px; }.head-actions { flex-wrap: wrap; justify-content: flex-end; }.head-actions .btn { padding-inline: 9px; font-size: 12px; }.source-defaults { font-size: 11px; }.pipeline { gap: 5px; }.pipeline li { flex-direction: column; text-align: center; gap: 5px; }.pipeline li::after { display: none; } }
@media (max-width: 760px) { .cba-page { padding: 18px 16px 12px; }.page-head { flex-direction: column; gap: 14px; }.page-head p { max-width: none; }.head-actions { width: 100%; justify-content: flex-start; }.head-actions .btn-primary { margin-left: auto; }.source-strip { flex-wrap: wrap; gap: 7px; }.source-defaults { margin-left: 0; width: 100%; }.workspace { display: block; min-height: 420px; overflow: auto; }.queue-pane { border: 0; min-height: 100%; }.queue-head, .queue-filters { padding-right: 0; }.queue-search { margin-right: 0; }.queue-filters button { padding-inline: 10px; }.queue-list { overflow: visible; }.detail-pane { display: none; padding: 14px 0 22px; overflow: visible; }.show-detail .queue-pane { display: none; }.show-detail .detail-pane { display: block; }.back-button { display: inline-flex; margin: 0 0 14px -8px; }.detail-head h2 { font-size: 18px; }.pipeline { margin-top: 16px; }.detail-meta { gap: 6px 12px; }.video-player { max-height: none; }.page-foot { align-items: flex-start; font-size: 10px; }.page-foot > span:first-child { max-width: 62%; }.job-message { flex-wrap: wrap; }.run-banner { flex-wrap: wrap; }.run-banner > div { flex-basis: calc(100% - 30px); }.run-banner > .btn:first-of-type { margin-left: 26px; } }
@media (max-height: 700px) { .workspace { flex: none; min-height: 500px; height: 500px; }.cba-page { overflow: auto; } }
@media (max-width: 760px) { .workspace-switch > span { width: 100%; margin: 3px 0 9px; }.workspace-switch button { padding-inline: 10px; }.match-summary { align-items: flex-start; flex-direction: column; gap: 6px; }.match-summary > span:last-child { font-size: 10px; }.match-card > header { flex-direction: column; gap: 8px; }.library-head { gap: 10px; }.library-head > .btn { flex-shrink: 0; }.library-search { max-width: none; }.material-file-list li, .source-file > header { flex-wrap: wrap; }.match-card h3 { font-size: 15px; }.material-preview .video-player { max-height: none; }.source-defaults { flex-wrap: wrap; }.materials-panel .section-head { gap: 5px; } }
@media (prefers-reduced-motion: reduce) { .cba-page :deep(*) { animation: none !important; transition: none !important; } }
</style>
