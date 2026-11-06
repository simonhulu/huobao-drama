<template>
  <div class="nba-page">
    <header class="page-header">
      <div class="page-title"><h1>NBA 视频工厂</h1><span class="schedule-state" aria-label="定时采集状态"><Clock3 :size="13" /> {{ overview.settings.scheduleEnabled ? `每 ${overview.settings.intervalMinutes} 分钟采集` : '定时采集已关闭' }}</span></div>
      <div class="header-actions">
        <button class="btn btn-ghost" @click="openDialog('runs')"><History :size="15" /> 运行记录</button>
        <button class="btn" :disabled="busy" @click="openDialog('channels')"><ListVideo :size="15" /> 频道管理 <span class="button-count">{{ overview.settings.youtubeChannels.length }}</span></button>
        <button class="btn btn-icon" aria-label="采集与制作设置" title="采集与制作设置" @click="openDialog('settings')"><Settings2 :size="16" /></button>
        <button class="btn" :disabled="busy || !canQueueProduction || !selectedResumeIds.length" @click="resumeJobs()"><RotateCcw :size="14" /> 续做所选 <span class="button-count">{{ selectedResumeIds.length }}</span></button>
        <button class="btn" :disabled="busy || !canQueueProduction || !pendingUploadIds.length || !uploadAccountReady" :title="uploadAccountReady ? '加入制作队列并发表到共用百家号账号' : uploadAccountMessage" @click="uploadJobs()"><Upload :size="14" /> 上传并发表 <span class="button-count">{{ pendingUploadIds.length }}</span></button>
        <button v-if="isActive && !hasIndependentQueues" class="btn" :disabled="busy || overview.activeRun.status === 'stopping'" @click="stopRun()"><Square :size="13" /> {{ overview.activeRun.status === 'stopping' ? '正在停止' : '停止' }}</button>
        <button class="btn btn-primary" :disabled="busy || collectionBlocked" @click="openDialog('collect')"><Youtube :size="15" /> 批量采集</button>
      </div>
    </header>

    <div class="overview-strip" aria-label="任务统计">
      <span>全部 <strong>{{ overview.stats.total }}</strong></span><span>成片 <strong>{{ overview.stats.completed }}</strong></span><span>可续做 <strong>{{ overview.stats.resumable }}</strong></span><button class="stat-filter" :class="{ active: statusFilter === 'waiting_upload' }" :aria-pressed="statusFilter === 'waiting_upload'" @click="statusFilter = statusFilter === 'waiting_upload' ? 'all' : 'waiting_upload'">待发表 <strong>{{ pendingUploadIds.length }}</strong></button><span>已提交 <strong>{{ uploadedCount }}</strong></span>
      <span class="sync-time">{{ checkedAt ? `更新于 ${formatTime(checkedAt)}` : '正在读取任务' }}<button class="btn btn-icon btn-ghost" :disabled="loading" title="刷新任务" aria-label="刷新任务" @click="refresh"><RefreshCw :size="14" :class="{ spin: loading }" /></button></span>
    </div>
    <div class="collection-strip"><span><Youtube :size="14" /> {{ overview.settings.youtubeChannels.length }} 个频道 · 每频道 {{ overview.settings.videosPerChannel }} 条视频</span><span class="account-state" :class="uploadAccountReady ? 'success' : 'warning'"><Users :size="13" /> 百家号 · {{ overview.uploadAccount?.label || '未配置账号' }}<span>{{ uploadAccountReady ? '已登录' : uploadAccountMessage }}</span></span><NuxtLink to="/cba-video" title="管理共用的百家号账号">CBA 账号管理 <ArrowUpRight :size="12" /></NuxtLink></div>
    <section v-if="hasIndependentQueues" class="run-queues" aria-label="采集与制作队列">
      <div class="queue-run" aria-label="采集队列">
        <div class="queue-run-heading"><strong><Youtube :size="15" />采集队列</strong><span class="status" :class="activeCollection ? statusTone(activeCollection.status) : 'success'"><LoaderCircle v-if="activeCollection" :size="13" class="spin" />{{ activeCollection ? statusLabel(activeCollection.status) : '空闲' }}</span><button v-if="activeCollection" class="btn btn-sm" :disabled="busy || activeCollection.status === 'stopping'" @click="stopRun(activeCollection)"><Square :size="12" />{{ activeCollection.status === 'stopping' ? '正在停止采集' : '停止采集' }}</button></div>
        <p v-if="activeCollection">{{ activeCollection.message }}</p>
        <p v-else-if="overview.settings.scheduleEnabled">{{ overview.nextCollectionAt ? `下次采集：${formatTime(overview.nextCollectionAt)}` : '等待下一轮采集' }}</p>
      </div>
      <div class="queue-run" aria-label="制作队列">
        <div class="queue-run-heading"><strong><Video :size="15" />制作队列</strong><span class="status" :class="activeProcessing ? statusTone(activeProcessing.status) : queuedProcessing.length ? 'warning' : 'success'"><LoaderCircle v-if="activeProcessing" :size="13" class="spin" />{{ activeProcessing ? statusLabel(activeProcessing.status) : queuedProcessing.length ? '排队中' : '空闲' }}</span><span class="queued-count">等待 {{ queuedProcessing.length }} 批</span><button v-if="activeProcessing" class="btn btn-sm" :disabled="busy || activeProcessing.status === 'stopping'" @click="stopRun(activeProcessing)"><Square :size="12" />{{ activeProcessing.status === 'stopping' ? '正在停止制作' : '停止制作' }}</button></div>
        <p v-if="activeProcessing">{{ activeProcessing.message }}</p>
        <ul v-if="queuedProcessing.length" class="pending-runs"><li v-for="run in queuedProcessing" :key="run.id"><span>{{ runKindLabel(run.kind) }} · {{ run.jobIds.length }} 条任务</span><button class="btn btn-icon btn-ghost" :disabled="busy" aria-label="停止排队任务" title="停止排队任务" @click="stopRun(run)"><Square :size="12" /></button></li></ul>
      </div>
    </section>
    <section v-else-if="overview.activeRun" class="run-banner" role="status">
      <LoaderCircle :size="17" class="spin" /><div><strong>{{ runKindLabel(overview.activeRun.kind) }} · {{ statusLabel(overview.activeRun.status) }}</strong><p>{{ overview.activeRun.message }}</p></div><button class="btn btn-sm btn-ghost" @click="openDialog('runs')">查看进展 <ArrowUpRight :size="13" /></button>
    </section>
    <div v-if="pageError" class="alert error" role="alert"><CircleAlert :size="16" /><span>{{ pageError }}</span><button class="btn btn-sm" :disabled="loading" @click="refresh">重试</button></div>
    <div v-if="actionError && !dialogMode" class="alert error" role="alert"><CircleAlert :size="16" /><span>{{ actionError }}</span></div>

    <section class="workspace" :class="{ 'show-detail': mobileDetail }" aria-label="NBA 新闻工作台">
      <aside class="queue-pane" aria-label="新闻任务">
        <header class="queue-header"><h2>新闻任务 <span>{{ filteredJobs.length }} / {{ overview.jobs.length }}</span></h2></header>
        <label class="search-field"><Search :size="15" /><input v-model="search" type="search" placeholder="搜索新闻、球队或任务 ID" aria-label="搜索新闻、球队或任务 ID" /></label>
        <div class="queue-filters">
          <select v-model="statusFilter" aria-label="筛选任务状态"><option value="all">全部状态</option><option value="waiting_upload">待发表成片</option><option value="uploaded">已提交发表</option><option value="resumable">可续做</option><option value="running">进行中</option><option value="queued">排队中</option><option value="attention">待处理</option><option value="failed">执行失败</option><option value="stopped">已停止</option><option value="completed">成片完成</option></select>
          <select v-model="languageFilter" aria-label="筛选原文语言"><option value="all">中英文</option><option value="zh">中文原文</option><option value="en">英文原文</option></select>
        </div>
        <div class="selection-bar"><label><input type="checkbox" :checked="allVisibleSelected" :indeterminate="someVisibleSelected && !allVisibleSelected" :disabled="!visibleResumableJobs.length" @change="toggleVisibleSelection" /><span>{{ selectedResumeIds.length ? `已选 ${selectedResumeIds.length} 条` : '选择可续做任务' }}</span></label><button v-if="selectedIds.length" class="btn btn-icon btn-ghost" title="清空选择" aria-label="清空选择" @click="selectedIds = []"><X :size="13" /></button></div>
        <div v-if="loading && !overview.jobs.length" class="empty-state"><LoaderCircle :size="24" class="spin" /><p>正在读取任务…</p></div>
        <div v-else-if="!filteredJobs.length" class="empty-state"><Inbox :size="28" /><strong>{{ overview.jobs.length ? '没有符合条件的新闻' : '还没有新闻任务' }}</strong><button v-if="overview.jobs.length" class="btn btn-sm" @click="clearFilters">清除筛选</button><button v-else class="btn btn-sm" :disabled="busy || collectionBlocked" @click="openDialog('collect')"><Plus :size="14" /> 批量采集</button></div>
        <ul v-else class="queue-list">
          <li v-for="job in filteredJobs" :key="job.id" :class="{ selected: selectedId === job.id }">
            <input class="row-checkbox" type="checkbox" :checked="selectedIds.includes(job.id)" :disabled="!job.canResume || processingJobIds.has(job.id)" :aria-label="`选择任务：${job.title}`" @change="toggleJobSelection(job.id)" />
            <button class="queue-item" :aria-current="selectedId === job.id ? 'true' : undefined" @click="selectJob(job.id)"><span class="queue-title">{{ job.title }}</span><span class="queue-source">{{ languageLabel(job.article?.language) }} · {{ job.article?.publisher || '来源待核实' }} · {{ articleLength(job.article) }}</span><span v-if="job.game" class="queue-match">{{ gameLine(job.game) }}</span><span class="queue-bottom"><span class="status" :class="statusTone(job.status)"><i />{{ statusLabel(job.status) }}</span><span v-if="job.canUpload || job.uploaded || job.uploads?.length" :class="uploadTone(jobUploadStatus(job))">{{ uploadLabel(jobUploadStatus(job)) }}</span><time>{{ formatTime(job.updatedAt) }}</time></span><span v-if="['attention', 'failed', 'stopped'].includes(job.status)" class="queue-reason">{{ job.message }}</span></button>
          </li>
        </ul>
      </aside>

      <section class="detail-pane" :aria-busy="detailLoading" aria-label="新闻详情">
        <button class="btn btn-ghost btn-sm back-button" @click="mobileDetail = false"><ArrowLeft :size="14" /> 新闻任务</button>
        <div v-if="detailLoading && !selectedJob" class="empty-state detail-empty"><LoaderCircle :size="26" class="spin" /><p>正在读取详情…</p></div>
        <div v-else-if="!selectedJob" class="empty-state detail-empty"><Video :size="30" /><h2>{{ detailError ? '暂时无法读取任务' : '选择一条新闻' }}</h2><code v-if="selectedId">{{ selectedId }}</code><p v-if="detailError">{{ detailError }}</p><button v-if="detailError" class="btn btn-sm" @click="loadDetail(selectedId, true)">重新读取</button></div>
        <template v-else>
          <header class="detail-header"><div><div class="detail-kicker"><span class="status" :class="statusTone(selectedJob.status)"><i />{{ statusLabel(selectedJob.status) }}</span><span>{{ languageLabel(selectedJob.article?.language) }}原文</span><span v-if="isImported">既有产物</span></div><h2>{{ selectedJob.title }}</h2></div><button class="btn btn-icon btn-ghost delete-button" :disabled="busy || !canDelete" :title="deleteDisabledReason || '删除任务'" aria-label="删除任务" @click="openDialog('delete')"><Trash2 :size="16" /></button></header>
          <div class="task-identity"><code>{{ selectedJob.id }}</code><button class="btn btn-icon btn-ghost" title="复制任务链接" aria-label="复制任务链接" @click="copyTaskLink"><Link :size="13" /></button><time>{{ formatTime(selectedJob.updatedAt) }}</time></div>
          <ol class="pipeline" aria-label="制作进度"><li v-for="(step, index) in stages" :key="step.id" :class="stepState(step.id)" :aria-current="stageId(selectedJob.stage) === step.id ? 'step' : undefined"><span><Check v-if="stepState(step.id) === 'done'" :size="11" /><LoaderCircle v-else-if="stepState(step.id) === 'active'" :size="11" class="spin" /><template v-else>{{ index + 1 }}</template></span>{{ step.label }}</li></ol>
          <div v-if="selectedJob.message" class="job-message" :class="{ warning: ['attention', 'failed'].includes(selectedJob.status) }"><CircleAlert v-if="['attention', 'failed'].includes(selectedJob.status)" :size="15" /><span>{{ selectedJob.message }}</span><button v-if="canResumeSelected" class="btn btn-sm" :disabled="busy || !canQueueProduction" @click="resumeJobs([selectedJob.id])"><RotateCcw :size="13" /> 继续制作</button></div>
          <p v-if="detailError" class="inline-error" role="alert">{{ detailError }}，当前显示上次结果。</p>
          <nav class="detail-tabs" role="tablist" aria-label="任务详情" @keydown="changeTabByKey"><button v-for="tab in tabs" :id="`nba-tab-${tab.id}`" :key="tab.id" role="tab" :aria-selected="detailTab === tab.id" :aria-controls="`nba-panel-${tab.id}`" :tabindex="detailTab === tab.id ? 0 : -1" :class="{ active: detailTab === tab.id }" @click="detailTab = tab.id">{{ tab.label }}</button></nav>

          <div id="nba-panel-output" v-show="detailTab === 'output'" class="detail-section" role="tabpanel" aria-labelledby="nba-tab-output">
            <p v-if="selectedJob.qualityHold" class="inline-error" role="status">{{ selectedJob.qualityHold.rejectedDeliverySha256 === selectedJob.delivery?.sha256 ? '旧版成片已停发，原文与译稿已净化。' : '修复预览，尚未再次发表。' }}</p>
            <video v-if="assetUrl('video')" :key="`${selectedJob.id}-${selectedJob.delivery?.sha256}-${assetUrl('video')}`" ref="player" class="video-player" :src="assetUrl('video')" :poster="assetUrl('cover') || undefined" controls playsinline preload="metadata" :aria-label="`${selectedJob.title}成片`" @error="videoError = true" @loadedmetadata="videoError = false" />
            <div v-else class="video-placeholder"><Video :size="28" /><strong>成片尚未生成</strong><span>{{ stageLabel(selectedJob.stage) }}</span></div>
            <p v-if="videoError" class="inline-error" role="alert">视频暂时无法播放，请刷新任务后重试。</p>
            <div class="asset-links"><a v-if="assetUrl('video')" :href="assetUrl('video')" :download="`${selectedJob.id}.mp4`"><Download :size="14" /> 成片</a><a v-if="assetUrl('subtitles')" :href="assetUrl('subtitles')" :download="`${selectedJob.id}.srt`"><Captions :size="14" /> 字幕</a><a v-if="assetUrl('voice')" :href="assetUrl('voice')" download><Mic2 :size="14" /> 中文配音</a><a v-if="assetUrl('cover')" :href="assetUrl('cover')" target="_blank" rel="noreferrer"><Image :size="14" /> 横封面</a><a v-if="assetUrl('portraitCover')" :href="assetUrl('portraitCover')" target="_blank" rel="noreferrer"><Image :size="14" /> 竖封面</a><span v-if="selectedJob.delivery?.duration">{{ formatDuration(selectedJob.delivery.duration) }}</span></div>
            <section class="upload-section">
              <header class="section-header"><h3>百家号发表</h3><span :class="uploadTone(selectedUploadStatus)">{{ selectedUploadStatus ? uploadLabel(selectedUploadStatus) : '等待成片' }}</span></header>
              <p v-if="selectedJob.qualityHold" class="inline-error">{{ selectedJob.qualityHold.source === 'user-report' ? '已收到不合格反馈。以下为历史提交回执，当前作品已停止发表。' : selectedJob.qualityHold.reason }}</p>
              <div class="upload-account-line"><span>{{ overview.uploadAccount?.label || '未配置账号' }} · 与 CBA 共用 · #NBA#</span><NuxtLink to="/cba-video">管理账号 <ArrowUpRight :size="12" /></NuxtLink></div>
              <div v-if="publicationDescription" class="publication-description"><span>{{ selectedUploadJob?.uploaded ? '作品描述' : '发布描述' }}</span><p>{{ publicationDescription }}</p></div>
              <ul v-if="uploadRecords.length" class="upload-records"><li v-for="record in uploadRecords" :key="record.id"><div><strong>{{ record.accountLabel || record.accountName || '百家号' }}</strong><span :class="uploadTone(uploadStatus(record))">{{ uploadLabel(uploadStatus(record)) }}</span><a v-if="uploadReceipt(record)" :href="uploadReceipt(record)" target="_blank" rel="noreferrer">{{ uploadReceiptLabel(record) }} <ExternalLink :size="12" /></a></div><p v-if="record.message">{{ record.message }}</p><time>{{ formatTime(record.updatedAt) }}</time></li></ul>
              <p v-if="!uploadAccountReady" class="inline-error">{{ uploadAccountMessage }}</p>
              <button v-if="canUploadSelected" class="btn" :disabled="busy || !canQueueProduction || !uploadAccountReady" @click="uploadJobs([selectedJob.id])"><LoaderCircle v-if="actionBusy === 'upload'" :size="14" class="spin" /><Upload v-else :size="14" />{{ hasUploadIssue || selectedUploadStatus === 'saved' ? '继续发表' : '发表百家号' }}</button>
            </section>
            <section v-if="assetUrl('voice')" class="voice-section"><h3>中文配音</h3><audio ref="voicePlayer" :src="assetUrl('voice')" controls preload="none" aria-label="中文解说配音" /></section>
            <section v-if="selectedJob.delivery?.verification" class="verification-section"><header class="section-header"><h3>交付检查</h3><ShieldCheck :size="16" /></header><dl v-if="verificationEntries.length" class="verification-list"><div v-for="entry in verificationEntries" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ entry.value }}</dd></div></dl><details class="verification-detail"><summary>详细检查记录</summary><pre>{{ verificationJson }}</pre></details></section>
          </div>

          <div id="nba-panel-article" v-show="detailTab === 'article'" class="detail-section manuscript" role="tabpanel" aria-labelledby="nba-tab-article">
            <details class="article-section" open><summary><span>原报道</span><span>{{ languageLabel(selectedJob.article?.language) }} · {{ articleLength(selectedJob.article) }}</span><ChevronDown :size="15" /></summary><div class="article-meta"><span>{{ selectedJob.article?.publisher }}</span><span v-if="selectedJob.article?.byline">{{ selectedJob.article.byline }}</span><time v-if="selectedJob.article?.publishedAt">{{ formatTime(selectedJob.article.publishedAt) }}</time><a v-if="webUrl(selectedJob.article?.url)" :href="webUrl(selectedJob.article.url)" target="_blank" rel="noreferrer">原文 <ExternalLink :size="12" /></a></div><h3>{{ selectedJob.article?.title }}</h3><p v-if="selectedJob.article?.heldReason" class="inline-error">{{ selectedJob.article.heldReason }}</p><div v-if="selectedJob.article?.body" class="article-body" :lang="selectedJob.article.language === 'en' ? 'en' : 'zh-CN'">{{ selectedJob.article.body }}</div><p v-else class="section-empty">正文尚未保存。</p></details>
            <section class="script-section"><header class="section-header"><h3>中文译稿</h3><span v-if="selectedJob.script?.text">{{ selectedJob.script.text.length }} 字</span></header><h4 v-if="selectedJob.script?.title">{{ selectedJob.script.title }}</h4><div v-if="selectedJob.script?.text" class="article-body" lang="zh-CN">{{ selectedJob.script.text }}</div><p v-else class="section-empty">中文译稿尚未生成。</p></section>
          </div>

          <div id="nba-panel-materials" v-show="detailTab === 'materials'" class="detail-section materials" role="tabpanel" aria-labelledby="nba-tab-materials">
            <section v-if="selectedJob.game"><header class="section-header"><h3>对应比赛</h3><span :class="selectedJob.game.verified ? 'success' : 'warning'">{{ selectedJob.game.verified ? '比赛已核验' : '比赛待核验' }}</span></header><div class="scoreboard"><div><small>客队</small><strong>{{ selectedJob.game.away?.name }}</strong><span>{{ selectedJob.game.away?.score ?? '—' }}</span></div><span class="score-divider">:</span><div><small>主队</small><strong>{{ selectedJob.game.home?.name }}</strong><span>{{ selectedJob.game.home?.score ?? '—' }}</span></div></div><dl class="game-facts"><div><dt>比赛当地日期</dt><dd>{{ selectedJob.game.localDate || '待核验' }}</dd></div><div><dt>当地时区</dt><dd>{{ selectedJob.game.localTimezone || '待核验' }}</dd></div><div><dt>北京时间</dt><dd>{{ beijingTime(selectedJob.game.tipoffUtc) }}</dd></div><div v-if="selectedJob.game.espnEventId"><dt>ESPN 比赛编号</dt><dd>{{ selectedJob.game.espnEventId }}</dd></div></dl><ul v-if="selectedJob.game.evidenceUrls?.length" class="evidence-list"><li v-for="(url, index) in selectedJob.game.evidenceUrls" :key="url"><a v-if="webUrl(url)" :href="webUrl(url)" target="_blank" rel="noreferrer">核验来源 {{ index + 1 }} · {{ sourceHost(url) }} <ExternalLink :size="12" /></a></li></ul></section>
            <section v-if="selectedJob.article?.topic"><header class="section-header"><h3>视频主题</h3></header><h4>{{ selectedJob.article.topic.title }}</h4><p v-if="selectedJob.article.topic.description" class="article-body">{{ selectedJob.article.topic.description }}</p></section>
            <form class="source-editor" @submit.prevent="saveSource"><label class="field"><span>YouTube 体育视频</span><input v-model="sourceUrlDraft" type="url" placeholder="https://www.youtube.com/watch?v=…" :disabled="busy || isActive" required /></label><div><p v-if="assetUrl('video') || assetUrl('source')" class="muted">更换后需重新制作成片，原文与中文稿保留。</p><button class="btn" type="submit" :disabled="busy || isActive || !sourceChanged"><LoaderCircle v-if="actionBusy === 'source'" :size="14" class="spin" /><Save v-else :size="14" />{{ assetUrl('source') || assetUrl('video') ? '更换素材' : '补充视频' }}</button></div></form>
            <section class="source-section"><header class="section-header"><h3>原视频与现场声</h3><span v-if="selectedJob.media" :class="selectedJob.media.verified ? 'success' : 'warning'">{{ selectedJob.media.verified ? '素材已核验' : '素材待核验' }}</span></header><p v-if="sharedJobCount > 1" class="muted">{{ sharedJobCount }} 条新闻共享视频素材</p><video v-if="assetUrl('source') && detailTab === 'materials'" ref="sourcePlayer" class="video-player" :src="assetUrl('source')" controls playsinline preload="none" aria-label="对应体育原视频" /><p v-else-if="!assetUrl('source')" class="section-empty">尚无可播放的本地录像。</p><div class="asset-links"><a v-if="webUrl(selectedJob.media?.sourceUrl || selectedJob.article?.youtubeUrl)" :href="webUrl(selectedJob.media?.sourceUrl || selectedJob.article?.youtubeUrl)" target="_blank" rel="noreferrer">视频来源 <ExternalLink :size="13" /></a><span v-if="selectedJob.media">{{ formatDuration(selectedJob.media.duration) }}<template v-if="selectedJob.media.width"> · {{ selectedJob.media.width }} × {{ selectedJob.media.height }}</template></span></div><ul v-if="selectedJob.media?.verificationNotes?.length" class="material-notes"><li v-for="(note, index) in selectedJob.media.verificationNotes" :key="index">{{ note }}</li></ul></section>
          </div>

          <div id="nba-panel-logs" v-show="detailTab === 'logs'" class="detail-section" role="tabpanel" aria-labelledby="nba-tab-logs"><header class="section-header"><h3>执行记录</h3><span>已尝试 {{ selectedJob.attempts || 0 }} 次</span></header><ol v-if="jobLogs.length" class="job-logs"><li v-for="(log, index) in jobLogs" :key="`${log.at}-${index}`"><div><time>{{ formatTime(log.at) }}</time><span>{{ stageLabel(log.stage) }}</span></div><p>{{ log.message }}</p></li></ol><p v-else class="section-empty">暂无执行记录。</p></div>
        </template>
      </section>
    </section>

    <dialog ref="dialog" class="workspace-dialog" :class="{ 'runs-dialog': dialogMode === 'runs' }" aria-labelledby="nba-dialog-title" @close="dialogMode = null" @click="closeOnBackdrop">
      <header class="dialog-header"><h2 id="nba-dialog-title">{{ dialogTitle }}</h2><button class="btn btn-icon btn-ghost" title="关闭" aria-label="关闭对话框" @click="closeDialog"><X :size="17" /></button></header>
      <form v-if="dialogMode === 'collect'" @submit.prevent="startRun">
        <div class="dialog-body form-fields">
          <div class="collection-mode" aria-label="采集方式"><button type="button" :class="{ active: collectDraft.collectionMode === 'channels' }" :aria-pressed="collectDraft.collectionMode === 'channels'" @click="collectDraft.collectionMode = 'channels'"><Youtube :size="14" /> 频道批量采集</button><button type="button" :class="{ active: collectDraft.collectionMode === 'manual' }" :aria-pressed="collectDraft.collectionMode === 'manual'" @click="collectDraft.collectionMode = 'manual'"><Newspaper :size="14" /> 手动采集</button></div>
          <div v-if="collectDraft.collectionMode === 'channels'" class="channel-summary"><span><ListVideo :size="15" /> 已保存 {{ overview.settings.youtubeChannels.length }} 个频道</span><button type="button" class="btn btn-sm btn-ghost" @click="openDialog('channels')">管理频道 <ArrowUpRight :size="12" /></button><p v-if="!overview.settings.youtubeChannels.length" class="inline-error">请先保存至少一个 YouTube 频道。</p></div>
          <fieldset><legend>新闻语言</legend><div class="inline-options"><label><input v-model="collectDraft.languages" type="checkbox" value="zh" />中文</label><label><input v-model="collectDraft.languages" type="checkbox" value="en" />英文</label></div></fieldset>
          <div class="field-grid"><label class="field"><span>采集数量</span><input v-model.number="collectDraft.limit" type="number" min="1" max="100" step="1" required /></label><label v-if="collectDraft.collectionMode === 'channels'" class="field"><span>每频道扫描视频数</span><input v-model.number="collectDraft.videosPerChannel" type="number" min="1" max="1000" step="1" required /></label><label v-else class="field"><span>比赛日期 <span class="optional">可选</span></span><input v-model="collectDraft.gameDate" type="date" /></label></div>
          <template v-if="collectDraft.collectionMode === 'manual'"><label class="field"><span>新闻链接 <span class="optional">可选，每行一条</span></span><textarea v-model="collectDraft.articleUrls" rows="4" placeholder="https://…" spellcheck="false" /></label><label class="field"><span>YouTube 比赛视频 <span class="optional">可选</span></span><input v-model="collectDraft.youtubeUrl" type="url" placeholder="https://www.youtube.com/watch?v=…" /></label><label class="field"><span>ESPN 比赛编号 <span class="optional">可选</span></span><input v-model="collectDraft.espnEventId" inputmode="numeric" pattern="[0-9]+" placeholder="401…" /></label></template>
          <label class="check-line"><input v-model="collectDraft.autoProduce" type="checkbox" /><span>采集后自动制作</span></label>
          <label class="check-line"><input v-model="collectDraft.autoUpload" type="checkbox" /><span>制作后直接发表百家号</span></label><p v-if="collectDraft.autoUpload" class="muted">百家号 · {{ overview.uploadAccount?.label || '未配置账号' }} · {{ uploadAccountReady ? '已登录' : uploadAccountMessage }} · #NBA#</p>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
        </div><footer class="dialog-footer"><button type="button" class="btn btn-ghost" @click="closeDialog">取消</button><button type="submit" class="btn btn-primary" :disabled="busy || collectionBlocked || !collectDraft.languages.length || (collectDraft.collectionMode === 'channels' && !overview.settings.youtubeChannels.length)"><LoaderCircle v-if="actionBusy === 'collect'" :size="14" class="spin" /><Play v-else :size="14" />{{ actionBusy === 'collect' ? '正在提交…' : '开始采集' }}</button></footer>
      </form>
      <form v-else-if="dialogMode === 'channels'" @submit.prevent="saveChannels"><div class="dialog-body form-fields"><fieldset :disabled="actionBusy === 'channels'"><div v-for="(_, index) in channelDraft" :key="index" class="channel-row"><span>{{ index + 1 }}</span><input v-model="channelDraft[index]" type="url" :aria-label="`NBA YouTube 频道 ${index + 1}`" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/@NBA/videos" /><div class="channel-order"><button class="btn btn-icon btn-ghost" type="button" :disabled="index === 0" :aria-label="`上移频道 ${index + 1}`" title="上移" @click="moveChannel(index, -1)"><ArrowUp :size="13" /></button><button class="btn btn-icon btn-ghost" type="button" :disabled="index === channelDraft.length - 1" :aria-label="`下移频道 ${index + 1}`" title="下移" @click="moveChannel(index, 1)"><ArrowDown :size="13" /></button><button class="btn btn-icon btn-ghost" type="button" :aria-label="`删除频道 ${index + 1}`" title="删除频道" @click="channelDraft.splice(index, 1)"><Trash2 :size="14" /></button></div></div><p v-if="!channelDraft.length" class="section-empty">尚未添加频道。</p><button class="btn btn-sm" type="button" :disabled="channelDraft.length >= 30" @click="channelDraft.push('')"><Plus :size="13" /> 添加频道</button></fieldset><p class="muted">频道 {{ channelDraft.length }} / 30<span v-if="isActive"> · 下一批生效</span></p><p v-if="channelValidation" class="inline-error" role="status">{{ channelValidation }}</p><p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p></div><footer class="dialog-footer"><button type="button" class="btn btn-ghost" :disabled="busy" @click="closeDialog">取消</button><button type="submit" class="btn btn-primary" :disabled="busy || !!channelValidation || !channelsDirty"><LoaderCircle v-if="actionBusy === 'channels'" :size="14" class="spin" /><Save v-else :size="14" />{{ actionBusy === 'channels' ? '正在保存…' : '保存频道列表' }}</button></footer></form>
      <form v-else-if="dialogMode === 'settings'" @submit.prevent="saveSettings">
        <div class="dialog-body form-fields">
          <section class="settings-section"><h3>默认采集</h3><fieldset><legend>新闻语言</legend><div class="inline-options"><label><input v-model="settingsDraft.languages" type="checkbox" value="zh" />中文</label><label><input v-model="settingsDraft.languages" type="checkbox" value="en" />英文</label></div></fieldset><div class="field-grid"><label class="field"><span>每轮数量</span><input v-model.number="settingsDraft.limit" type="number" min="1" max="100" step="1" required /></label><label class="field"><span>每频道扫描视频数</span><input v-model.number="settingsDraft.videosPerChannel" type="number" min="1" max="1000" step="1" required /></label></div><label class="check-line"><input v-model="settingsDraft.autoProduce" type="checkbox" /><span>采集后自动制作</span></label><label class="check-line"><input v-model="settingsDraft.autoUpload" type="checkbox" /><span>制作后直接发表百家号</span></label><p class="muted">百家号 · {{ overview.uploadAccount?.label || '未配置账号' }} · 与 CBA 共用 · #NBA#</p></section>
          <section class="settings-section"><h3>中文配音</h3><div class="field-grid"><label class="field"><span>中文音色</span><input v-model="settingsDraft.voice" list="nba-voice-options" required /><datalist id="nba-voice-options"><option value="longanhuan_v3.1" /></datalist></label><label class="field"><span>语速</span><input v-model.number="settingsDraft.speed" type="number" min="0.5" max="2" step="0.05" required /></label></div></section>
          <section class="settings-section"><h3>球场混音</h3><label class="slider-field"><span>原视频声音</span><input v-model.number="settingsDraft.originalGain" type="range" min="0" max="1" step="0.01" /><output>{{ Math.round(settingsDraft.originalGain * 100) }}%</output></label><label class="slider-field"><span>分离球场声</span><input v-model.number="settingsDraft.arenaGain" type="range" min="0" max="2" step="0.01" /><output>{{ Math.round(settingsDraft.arenaGain * 100) }}%</output></label></section>
          <section class="settings-section"><h3>定时采集</h3><label class="check-line"><input v-model="settingsDraft.scheduleEnabled" type="checkbox" /><span>开启定时采集</span></label><label class="field interval-field"><span>采集间隔（分钟）</span><input v-model.number="settingsDraft.intervalMinutes" type="number" min="5" max="1440" step="1" :disabled="!settingsDraft.scheduleEnabled" required /></label></section>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
        </div><footer class="dialog-footer"><button type="button" class="btn btn-ghost" @click="closeDialog">取消</button><button class="btn btn-primary" type="submit" :disabled="busy || !settingsDraft.languages.length"><LoaderCircle v-if="actionBusy === 'settings'" :size="14" class="spin" /><Check v-else :size="14" />{{ actionBusy === 'settings' ? '正在保存…' : '保存设置' }}</button></footer>
      </form>
      <div v-else-if="dialogMode === 'runs'" class="dialog-body runs-body">
        <div v-if="!overview.runs.length" class="section-empty">暂无运行记录。</div>
        <details v-for="(run, index) in overview.runs" :key="run.id" class="run-record" :open="index === 0">
          <summary><span><strong>{{ runKindLabel(run.kind) }}</strong><time>{{ formatTime(run.createdAt) }}</time></span><span class="status" :class="statusTone(run.status)">{{ statusLabel(run.status) }}</span><ChevronDown :size="14" /></summary>
          <p class="run-message">{{ run.message }}</p><p class="muted">{{ run.jobIds?.length || 0 }} 条任务<template v-if="run.kind !== 'upload'"> · {{ run.excluded?.length || 0 }} 条未进入生产</template><template v-if="run.baijiahaoAccountLabel"> · 百家号 {{ run.baijiahaoAccountLabel }}</template></p>
          <details v-if="run.youtubeChannels?.length" class="run-channels"><summary>本批频道 {{ run.youtubeChannels.length }}</summary><ol><li v-for="channel in run.youtubeChannels" :key="channel"><a :href="webUrl(channel)" target="_blank" rel="noreferrer">{{ displayChannel(channel) }} <ExternalLink :size="11" /></a></li></ol></details>
          <section v-if="run.videos?.length" class="run-videos"><h3>频道视频扫描</h3><ul><li v-for="(video, videoIndex) in run.videos" :key="`${video.videoId}-${videoIndex}`"><div><a v-if="webUrl(video.url)" :href="webUrl(video.url)" target="_blank" rel="noreferrer">{{ video.title || video.videoId }} <ExternalLink :size="12" /></a><strong v-else>{{ video.title || video.videoId }}</strong><span :class="video.status === 'collected' ? 'success' : 'warning'">{{ channelVideoLabel(video.status) }}</span></div><p class="muted">{{ displayChannel(video.channel) }}</p><p v-if="video.message" :class="video.status === 'failed' ? 'inline-error' : 'muted'">{{ video.message }}</p></li></ul></section>
          <ul v-if="run.sources?.length" class="source-reports"><li v-for="source in run.sources" :key="source.id"><div><strong>{{ source.label }}</strong><span :class="source.status === 'ok' ? 'success' : 'warning'">{{ source.status === 'ok' ? '已采集' : source.status === 'partial' ? '部分采集' : '采集失败' }} {{ source.count || 0 }} 条</span></div><p v-if="source.error">{{ source.error }}</p></li></ul>
          <section v-if="run.excluded?.length" class="excluded-section"><h3>未进入生产</h3><ul><li v-for="(item, itemIndex) in run.excluded" :key="`${item.url}-${itemIndex}`"><a v-if="webUrl(item.url)" :href="webUrl(item.url)" target="_blank" rel="noreferrer">{{ item.title || item.url }} <ExternalLink :size="12" /></a><strong v-else>{{ item.title || '未命名报道' }}</strong><p>{{ item.reason }}</p><span v-if="item.duplicateOf" class="muted">重复于 {{ item.duplicateOf }}</span></li></ul></section>
        </details>
      </div>
      <form v-else-if="dialogMode === 'delete'" @submit.prevent="deleteJob"><div class="dialog-body delete-body"><p>删除任务“{{ deleteTarget?.title }}”？</p><p class="muted">{{ deleteTarget?.queued ? '将从制作队列移除，共享比赛素材保留。' : '共享比赛素材保留。' }}</p><p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p></div><footer class="dialog-footer"><button type="button" class="btn btn-ghost" @click="closeDialog">取消</button><button type="submit" class="btn delete-confirm" :disabled="busy"><LoaderCircle v-if="actionBusy === 'delete'" :size="14" class="spin" /><Trash2 v-else :size="14" /> 删除任务</button></footer></form>
    </dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Captions, Check, ChevronDown, CircleAlert, Clock3, Download, ExternalLink, History, Image, Inbox, Link, ListVideo, LoaderCircle, Mic2, Newspaper, Play, Plus, RefreshCw, RotateCcw, Save, Search, Settings2, ShieldCheck, Square, Trash2, Upload, Users, Video, X, Youtube } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { api } from '~/composables/useApi'

useHead({ title: 'NBA 视频工厂 · 火宝短剧' })
const route = useRoute()
const router = useRouter()
const defaultSettings = { youtubeChannels: ['https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ/videos'], videosPerChannel: 20, languages: ['en', 'zh'], limit: 6, autoProduce: true, autoUpload: false, scheduleEnabled: false, intervalMinutes: 60, voice: 'longanhuan_v3.1', speed: 1.05, originalGain: 0.32, arenaGain: 0.85 }
const overview = ref({ settings: { ...defaultSettings, youtubeChannels: [...defaultSettings.youtubeChannels], languages: [...defaultSettings.languages] }, jobs: [], matches: [], runs: [], activeRun: null, uploadAccount: null, stats: { total: 0, completed: 0, resumable: 0, running: 0 } })
const selectedId = ref(queryJob(route.query.job))
const selectedJob = ref(null)
const search = ref('')
const statusFilter = ref('all')
const languageFilter = ref('all')
const selectedIds = ref([])
const mobileDetail = ref(!!selectedId.value)
const detailTab = ref('output')
const loading = ref(false)
const detailLoading = ref(false)
const pageError = ref('')
const detailError = ref('')
const checkedAt = ref('')
const actionBusy = ref('')
const actionError = ref('')
const player = ref(null)
const voicePlayer = ref(null)
const sourcePlayer = ref(null)
const videoError = ref(false)
const sourceUrlDraft = ref('')
const dialog = ref(null)
const dialogMode = ref(null)
const deleteTarget = ref(null)
const collectDraft = ref({ collectionMode: 'channels', languages: [...defaultSettings.languages], limit: 6, videosPerChannel: 20, articleUrls: '', youtubeUrl: '', gameDate: '', espnEventId: '', autoProduce: true, autoUpload: false })
const settingsDraft = ref({ ...defaultSettings, youtubeChannels: [...defaultSettings.youtubeChannels], languages: [...defaultSettings.languages] })
const channelDraft = ref([])
const channelSaved = ref([])
const stages = [{ id: 'intake', label: '采集' }, { id: 'match', label: '主题' }, { id: 'script', label: '翻译' }, { id: 'media', label: '素材' }, { id: 'voice', label: '配音' }, { id: 'captions', label: '字幕' }, { id: 'render', label: '剪辑' }, { id: 'verify', label: '核验' }]
const tabs = [{ id: 'output', label: '成片' }, { id: 'article', label: '原文与译稿' }, { id: 'materials', label: '视频素材' }, { id: 'logs', label: '执行记录' }]
const busy = computed(() => !!actionBusy.value)
const hasIndependentQueues = computed(() => Object.hasOwn(overview.value, 'activeCollection'))
const activeCollection = computed(() => hasIndependentQueues.value ? overview.value.activeCollection : overview.value.activeRun?.kind === 'collect' ? overview.value.activeRun : null)
const activeProcessing = computed(() => hasIndependentQueues.value ? overview.value.activeProcessing : overview.value.activeRun?.kind !== 'collect' ? overview.value.activeRun : null)
const queuedProcessing = computed(() => overview.value.queuedProcessing || [])
const isActive = computed(() => !!overview.value.activeRun || !!activeCollection.value || !!activeProcessing.value || queuedProcessing.value.length > 0)
const collectionBlocked = computed(() => hasIndependentQueues.value ? !!activeCollection.value : isActive.value)
const canQueueProduction = computed(() => hasIndependentQueues.value || !isActive.value)
const processingJobIds = computed(() => new Set([activeProcessing.value, ...queuedProcessing.value].filter(Boolean).flatMap(run => run.jobIds || [])))
const uploadAccountReady = computed(() => overview.value.uploadAccount?.status === 'ready')
const uploadAccountMessage = computed(() => overview.value.uploadAccount?.message || (overview.value.uploadAccount ? '请在 CBA 账号管理中检查登录' : '请在 CBA 工作台配置百家号账号'))
const pendingUploadIds = computed(() => overview.value.jobs.filter(job => job.canUpload && !job.uploaded && !processingJobIds.value.has(job.id)).map(job => job.id))
const uploadedCount = computed(() => overview.value.jobs.filter(job => job.uploaded).length)
const uploadsActive = computed(() => overview.value.jobs.some(job => job.uploads?.some(upload => ['queued', 'running'].includes(upload.status))))
const pollDelay = computed(() => isActive.value || uploadsActive.value ? 4000 : 15000)
const filteredJobs = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase()
  return overview.value.jobs.filter(job => (statusFilter.value === 'all' || (statusFilter.value === 'resumable' ? job.canResume : statusFilter.value === 'waiting_upload' ? job.canUpload && !job.uploaded : statusFilter.value === 'uploaded' ? job.uploaded : job.status === statusFilter.value))
    && (languageFilter.value === 'all' || job.article?.language === languageFilter.value)
    && (!keyword || [job.id, job.title, job.article?.publisher, job.article?.url, job.article?.topic?.title, job.game?.localDate, job.game?.home?.name, job.game?.away?.name].filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(keyword))))
})
const visibleResumableJobs = computed(() => filteredJobs.value.filter(job => job.canResume && !processingJobIds.value.has(job.id)))
const selectedResumeIds = computed(() => overview.value.jobs.filter(job => job.canResume && !processingJobIds.value.has(job.id) && selectedIds.value.includes(job.id)).map(job => job.id))
const allVisibleSelected = computed(() => visibleResumableJobs.value.length > 0 && visibleResumableJobs.value.every(job => selectedIds.value.includes(job.id)))
const someVisibleSelected = computed(() => visibleResumableJobs.value.some(job => selectedIds.value.includes(job.id)))
const currentSummary = computed(() => overview.value.jobs.find(job => job.id === selectedId.value))
const selectedUploadJob = computed(() => currentSummary.value || selectedJob.value)
const selectedUploadStatus = computed(() => jobUploadStatus(selectedUploadJob.value))
const canUploadSelected = computed(() => !!selectedUploadJob.value?.canUpload && !selectedUploadJob.value?.uploaded && !processingJobIds.value.has(selectedUploadJob.value.id))
const uploadRecords = computed(() => [...(selectedJob.value?.uploads || [])].reverse())
const publicationDescription = computed(() => {
  const job = selectedUploadJob.value
  const record = [...(job?.uploads || [])].reverse().find(record => record.currentVersion && ['submitted', 'published'].includes(uploadStatus(record)))
  return record?.description || job?.publishingDescription || ''
})
const hasUploadIssue = computed(() => ['blocked', 'uncertain', 'failed'].includes(latestUpload(selectedUploadJob.value)?.status))
const channelsDirty = computed(() => JSON.stringify(channelDraft.value) !== JSON.stringify(channelSaved.value))
const channelValidation = computed(() => validateChannels(channelDraft.value))
const sourceChanged = computed(() => !!sourceUrlDraft.value.trim() && sourceUrlDraft.value.trim() !== (selectedJob.value?.article?.youtubeUrl || selectedJob.value?.media?.sourceUrl || ''))
const canResumeSelected = computed(() => !!(currentSummary.value || selectedJob.value)?.canResume && !processingJobIds.value.has(selectedId.value))
const deleteDisabledReason = computed(() => {
  const job = currentSummary.value || selectedJob.value
  if (!job) return ''
  if (job.canDelete === true) return ''
  if (job.canDelete === false) return job.deleteBlockedReason || '任务正在执行，请先停止当前批次后删除'
  if (['running', 'stopping'].includes(job.status)) return '任务正在制作，请先停止当前批次后删除'
  if (job.uploads?.some(upload => ['queued', 'running'].includes(upload.status))) return '任务正在等待或执行上传，请先停止当前批次后删除'
  if (job.uploads?.some(upload => upload.status === 'uncertain')) return '上传回执尚未确认，请先核对原上传记录后删除'
  return ''
})
const canDelete = computed(() => !!selectedJob.value && !deleteDisabledReason.value)
const jobLogs = computed(() => [...(selectedJob.value?.logs || [])].reverse())
const sharedJobCount = computed(() => selectedJob.value?.article?.topic ? overview.value.jobs.filter(job => job.article?.topic?.id === selectedJob.value.article.topic.id).length : selectedJob.value?.game ? overview.value.jobs.filter(job => job.game?.id === selectedJob.value.game.id).length : 0)
const isImported = computed(() => !!(selectedJob.value?.delivery?.verification?.imported || selectedJob.value?.delivery?.verification?.existingArtifact || selectedJob.value?.delivery?.verification?.importedExistingDelivery))
const verificationEntries = computed(() => summarizeVerification(selectedJob.value?.delivery?.verification || {}, selectedJob.value?.delivery?.duration))
const verificationJson = computed(() => JSON.stringify(selectedJob.value?.delivery?.verification || {}, null, 2))
const dialogTitle = computed(() => ({ collect: 'NBA 批量采集', channels: 'YouTube 频道管理', settings: '采集与制作设置', runs: '运行记录', delete: '删除任务' })[dialogMode.value] || '')
let disposed = false
let overviewRequest = null
let overviewController = null
let detailController = null
let detailSequence = 0
let pollTimer
let initializeCollection = true
let sourceDraftJobId = ''
const pendingRequests = new Map()

function queryJob(value) { return typeof value === 'string' ? value.trim() : Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() : '' }
function languageLabel(language) { return language === 'zh' ? '中文' : language === 'en' ? '英文' : '语言待核实' }
function articleLength(article) { if (!article) return '长度待核实'; const count = article.language === 'en' ? article.wordCount ?? article.length : article.characterCount ?? article.length; return Number.isFinite(Number(count)) ? `${Number(count).toLocaleString('zh-CN')} ${article.language === 'en' ? '词' : '字'}` : '长度待核实' }
function statusLabel(status) { return ({ queued: '排队中', running: '进行中', stopping: '正在停止', stopped: '已停止', attention: '待处理', failed: '执行失败', completed: '已完成' })[status] || '待处理' }
function statusTone(status) { return status === 'completed' ? 'success' : ['attention', 'stopped'].includes(status) ? 'warning' : status === 'failed' ? 'error-text' : ['running', 'queued', 'stopping'].includes(status) ? 'info' : '' }
function stageId(stage) { return stage === 'review' ? 'script' : stage }
function stageLabel(stage) { return stage === 'completed' ? '交付完成' : stages.find(item => item.id === stageId(stage))?.label || '等待处理' }
function runKindLabel(kind) { return ({ resume: '续做已有任务', upload: '发表百家号视频', collect: '采集新闻', produce: '制作新闻视频' })[kind] || '新闻任务' }
function latestUpload(job) { return job?.uploads?.at(-1) }
function uploadStatus(record) { return record?.status === 'saved' && record.result?.submitted === true && record.result.saved === false ? record.result.published ? 'published' : 'submitted' : record?.status }
function jobUploadStatus(job) { if (job?.qualityHold) return 'quality_hold'; const status = uploadStatus(latestUpload(job)); return job?.uploaded ? status === 'published' ? 'published' : 'submitted' : status || (job?.canUpload ? 'pending' : '') }
function uploadLabel(status) { return ({ queued: '等待发表', running: '上传与发表中', saved: '历史草稿', submitted: '已提交审核', published: '已发表', blocked: '发表待处理', uncertain: '待核对回执', failed: '发表失败', quality_hold: '质量问题已停发' })[status] || '待发表' }
function uploadTone(status) { return status === 'published' ? 'success' : ['blocked', 'uncertain', 'quality_hold'].includes(status) ? 'warning' : status === 'failed' ? 'error-text' : ['queued', 'running', 'submitted'].includes(status) ? 'info' : 'muted' }
function uploadReceipt(record) {
  const status = uploadStatus(record)
  if (['submitted', 'published'].includes(status) && record.result?.submitted === true && record.result.saved === false) return webUrl(record.result.publishedUrl || record.result.editorUrl)
  return status === 'saved' && record.result?.saved ? webUrl(record.result.draftUrl || record.result.editorUrl) : ''
}
function uploadReceiptLabel(record) { return ({ submitted: '查看提交', published: '查看作品' })[uploadStatus(record)] || '打开旧草稿' }
function channelVideoLabel(status) { return ({ collected: '已采集', excluded: '已跳过', failed: '采集失败' })[status] || '待处理' }
function channelUrl(value) {
  try {
    if (/[\u0000-\u001f\u007f]/.test(value)) return ''
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return ''
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '')
    const channel = pathname.match(/^(\/@[^/\s?#]+|\/channel\/UC[A-Za-z0-9_-]{22}|\/(?:c|user)\/[^/\s?#]+)(?:\/videos)?$/)?.[1]
    return channel ? new URL(`${channel}/videos`, 'https://www.youtube.com').href : ''
  } catch { return '' }
}
function validateChannels(values) {
  if (values.length > 30) return '最多保存 30 个频道'
  const urls = values.map(channelUrl)
  if (urls.some(value => !value)) return '请填写有效的 YouTube 频道主页或 videos 页，不能使用单条视频链接'
  const ids = urls.map(value => { const pathname = decodeURIComponent(new URL(value).pathname).normalize('NFC'); return pathname.startsWith('/@') ? pathname.toLowerCase() : pathname })
  return new Set(ids).size === ids.length ? '' : '频道不能重复，频道主页与 videos 页视为同一频道'
}
function displayChannel(value) { try { return decodeURI(value) } catch { return value || '' } }
function moveChannel(index, offset) { const target = index + offset; if (index < 0 || target < 0 || index >= channelDraft.value.length || target >= channelDraft.value.length) return; const items = [...channelDraft.value]; [items[index], items[target]] = [items[target], items[index]]; channelDraft.value = items }
function formatTime(value) { if (!value) return '时间待记录'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间待记录' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function beijingTime(value) { if (!value) return '待核验'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '待核验' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function formatDuration(value) { const seconds = Math.round(Number(value)); return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '时长待检查' }
function gameLine(game) { return [game.localDate, `${game.away?.name || ''} ${game.away?.score ?? ''} : ${game.home?.score ?? ''} ${game.home?.name || ''}`].filter(Boolean).join(' · ') }
function webUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' } }
function sourceHost(value) { try { return new URL(value).hostname } catch { return '' } }
function assetUrl(kind) { const asset = selectedJob.value?.assets?.[kind]; return typeof asset === 'string' ? asset : asset?.url || '' }
function firstNumber(...values) { for (const value of values) if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) return Number(value); return undefined }
function checkStatus(value) { return [true, 'passed', 'pass', 'ok'].includes(value) ? '已通过' : [false, 'failed', 'fail'].includes(value) ? '未通过' : '待核验' }
function summarizeVerification(value, deliveryDuration) {
  const entries = [], timing = value.timing || {}
  const add = (key, label, result) => { if (result !== undefined) entries.push({ key, label, value: result }) }
  const decoded = value.fullDecode ?? value.decoded ?? value.decodePassed ?? value.decode?.passed ?? value.decode
  if (decoded !== undefined) add('decode', '完整解码', checkStatus(decoded))
  const duration = firstNumber(value.durationSeconds, value.duration, deliveryDuration)
  if (duration !== undefined) add('duration', '成片时长', `${formatDuration(duration)}（${duration.toFixed(2)} 秒）`)
  const pause = firstNumber(value.maximumPauseSeconds, value.maxPauseSeconds, value.voice?.maximumPauseSeconds, value.voice?.maxPauseSeconds)
  if (pause !== undefined) add('pause', '旁白最长停顿', `${pause.toFixed(2)} 秒`)
  const closingRange = Array.isArray(value.closingSourceSeconds) && value.closingSourceSeconds.length === 2 ? Number(value.closingSourceSeconds[1]) - Number(value.closingSourceSeconds[0]) : undefined
  const closing = firstNumber(timing.closingDuration, value.closingDuration, value.closingDurationSeconds, closingRange)
  if (closing !== undefined) add('closing', '片尾保留', `${closing.toFixed(2)} 秒`)
  const overlap = firstNumber(value.crossfadeSeconds, value.overlapDuration, timing.overlapDuration)
  if (overlap !== undefined) add('overlap', '片尾叠化', `${overlap.toFixed(2)} 秒`)
  const gray = firstNumber(value.finalFrameMeanGray)
  if (gray !== undefined) add('frameFade', '末帧淡出', `${gray < 2 ? '已通过' : '未通过'}（亮度 ${gray.toFixed(2)}）`)
  else if (value.fadeOutPassed !== undefined) add('frameFade', '末帧淡出', checkStatus(value.fadeOutPassed))
  const tail = firstNumber(value.final10msRmsDbFS, value.tailRmsDbFS)
  if (tail !== undefined) add('audioFade', '尾音淡出', `${tail < -55 ? '已通过' : '未通过'}（${tail.toFixed(1)} dBFS）`)
  const loudness = firstNumber(value.loudnessLUFS)
  if (loudness !== undefined) add('loudness', '综合响度', `${loudness.toFixed(1)} LUFS`)
  const peak = firstNumber(value.truePeakDbTP, value.truePeakDb)
  if (peak !== undefined) add('peak', '真峰值', `${peak.toFixed(1)} dBTP`)
  if (typeof value.completeScriptCaptionAlignment === 'boolean') add('captions', '字幕与中文稿', value.completeScriptCaptionAlignment ? '一致' : '待核对')
  if (typeof value.naturalEnding === 'boolean') add('ending', '自然收尾', checkStatus(value.naturalEnding))
  return entries
}
function stepState(id) { const job = selectedJob.value; if (!job) return 'todo'; const index = stages.findIndex(step => step.id === id), current = stages.findIndex(step => step.id === stageId(job.stage)); if (job.status === 'completed' || job.stage === 'completed' || index < current) return 'done'; if (index !== current) return 'todo'; return ['attention', 'failed', 'stopped'].includes(job.status) ? 'held' : job.status === 'running' ? 'active' : 'todo' }
function clearFilters() { search.value = ''; statusFilter.value = 'all'; languageFilter.value = 'all' }
function toggleJobSelection(id) { if (processingJobIds.value.has(id) || !overview.value.jobs.some(job => job.id === id && job.canResume)) return; selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter(item => item !== id) : [...selectedIds.value, id] }
function toggleVisibleSelection() { const ids = new Set(visibleResumableJobs.value.map(job => job.id)); selectedIds.value = allVisibleSelected.value ? selectedIds.value.filter(id => !ids.has(id)) : [...new Set([...selectedIds.value, ...ids])] }
function updateTaskLink(id, replace = false) { const query = { ...route.query }; if (id) query.job = id; else delete query.job; return router[replace ? 'replace' : 'push']({ query, hash: route.hash }) }
function pausePlayers() { player.value?.pause(); voicePlayer.value?.pause(); sourcePlayer.value?.pause() }
async function copyTaskLink() { if (!selectedJob.value) return; try { const url = new URL(window.location.href); url.searchParams.set('job', selectedJob.value.id); await navigator.clipboard.writeText(url.href); toast.success('已复制任务链接') } catch { toast.error('无法复制任务链接') } }
function changeTabByKey(event) { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = tabs.findIndex(tab => tab.id === detailTab.value); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; detailTab.value = tabs[next].id; nextTick(() => document.getElementById(`nba-tab-${detailTab.value}`)?.focus()) }

async function loadDetail(id, showLoading = false) {
  if (!id || disposed) return
  const sequence = ++detailSequence
  detailController?.abort()
  const controller = new AbortController()
  detailController = controller
  if (showLoading) detailLoading.value = true
  try {
    const result = await api.get(`/nba-video/jobs/${encodeURIComponent(id)}`, controller.signal)
    if (!disposed && sequence === detailSequence && selectedId.value === id) {
      selectedJob.value = result; detailError.value = ''
      if (sourceDraftJobId !== id) { sourceUrlDraft.value = result.article?.youtubeUrl || result.media?.sourceUrl || ''; sourceDraftJobId = id }
    }
  } catch (error) {
    if (!disposed && sequence === detailSequence && selectedId.value === id && error.name !== 'AbortError') detailError.value = error.message || '详情读取失败'
  } finally { if (!disposed && sequence === detailSequence) detailLoading.value = false }
}
async function refresh() {
  if (disposed) return
  if (overviewRequest) return overviewRequest
  loading.value = true
  overviewController = new AbortController()
  overviewRequest = (async () => {
    try {
      const result = await api.get('/nba-video', overviewController.signal)
      if (disposed) return
      overview.value = { ...result, settings: { ...defaultSettings, ...result.settings, youtubeChannels: [...(result.settings?.youtubeChannels || defaultSettings.youtubeChannels)] }, jobs: result.jobs || [], matches: result.matches || [], runs: result.runs || [], activeRun: result.activeRun || null, uploadAccount: result.uploadAccount || null, stats: result.stats || { total: result.jobs?.length || 0, completed: 0, resumable: 0, running: 0 } }
      pageError.value = ''; checkedAt.value = new Date().toISOString()
      selectedIds.value = selectedIds.value.filter(id => overview.value.jobs.some(job => job.id === id && job.canResume))
      if (!selectedId.value) selectedId.value = queryJob(route.query.job) || result.jobs?.[0]?.id || ''
      if (selectedId.value && !detailLoading.value) await loadDetail(selectedId.value)
    } catch (error) { if (!disposed && error.name !== 'AbortError') pageError.value = error.message || '状态读取失败，已保留上次结果' }
    finally { if (!disposed) loading.value = false; overviewRequest = null }
  })()
  return overviewRequest
}
async function refreshAfterAction() { if (overviewRequest) await overviewRequest; if (!disposed) await refresh() }
async function selectJob(id, { updateUrl = true } = {}) {
  if (!id) return
  mobileDetail.value = true
  if (updateUrl && queryJob(route.query.job) !== id) void updateTaskLink(id)
  if (selectedId.value === id && selectedJob.value) return
  pausePlayers(); selectedId.value = id; selectedJob.value = null; detailError.value = ''; detailTab.value = 'output'; videoError.value = false; sourceDraftJobId = ''
  await loadDetail(id, true)
}
async function openDialog(mode) {
  actionError.value = ''; dialogMode.value = mode
  if (mode === 'collect' && initializeCollection) { const settings = overview.value.settings; collectDraft.value = { collectionMode: 'channels', languages: [...settings.languages], limit: settings.limit, videosPerChannel: settings.videosPerChannel, autoProduce: settings.autoProduce, autoUpload: settings.autoUpload, articleUrls: '', youtubeUrl: '', gameDate: '', espnEventId: '' }; initializeCollection = false }
  if (mode === 'channels') { channelDraft.value = [...overview.value.settings.youtubeChannels]; channelSaved.value = [...channelDraft.value] }
  if (mode === 'settings') settingsDraft.value = { ...overview.value.settings, youtubeChannels: [...overview.value.settings.youtubeChannels], languages: [...overview.value.settings.languages] }
  if (mode === 'delete') deleteTarget.value = selectedJob.value ? { id: selectedJob.value.id, title: selectedJob.value.title, queued: (currentSummary.value || selectedJob.value).status === 'queued' } : null
  await nextTick(); if (!disposed && dialogMode.value === mode) dialog.value?.showModal()
}
function closeDialog() { dialog.value?.close(); dialogMode.value = null }
function closeOnBackdrop(event) { if (event.target !== dialog.value) return; const rect = dialog.value.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog() }
async function postOnce(path, body) {
  const key = JSON.stringify({ path, body })
  if (!pendingRequests.has(key)) pendingRequests.set(key, `nba-web-${crypto.randomUUID()}`)
  try { const result = await api.post(path, { ...body, requestId: pendingRequests.get(key) }); pendingRequests.delete(key); return result }
  catch (error) { if (error.status >= 400 && error.status < 500) pendingRequests.delete(key); throw error }
}
function collectionInput() {
  const form = collectDraft.value
  if (!form.languages.length) throw new Error('至少选择一种新闻语言')
  if (!Number.isInteger(form.limit) || form.limit < 1 || form.limit > 100) throw new Error('采集数量需为 1–100 的整数')
  const base = { collectionMode: form.collectionMode, languages: [...form.languages], limit: form.limit, autoProduce: !!form.autoProduce, autoUpload: !!form.autoUpload }
  if (form.collectionMode === 'channels') {
    if (!overview.value.settings.youtubeChannels.length) throw new Error('请先保存至少一个 YouTube 频道')
    if (!Number.isInteger(form.videosPerChannel) || form.videosPerChannel < 1 || form.videosPerChannel > 1000) throw new Error('每频道扫描视频数需为 1–1000 的整数')
    return { ...base, videosPerChannel: form.videosPerChannel }
  }
  if (form.collectionMode !== 'manual') throw new Error('请选择采集方式')
  const articleUrls = [...new Set(form.articleUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
  if (articleUrls.length > 100) throw new Error('每轮最多提交 100 个新闻链接')
  if (articleUrls.some(url => !webUrl(url))) throw new Error('请检查新闻链接，每行填写一个完整网址')
  const youtubeUrl = form.youtubeUrl.trim(), gameDate = form.gameDate.trim(), espnEventId = form.espnEventId.trim()
  if (youtubeUrl && (!webUrl(youtubeUrl) || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(sourceHost(youtubeUrl)))) throw new Error('请填写有效的 YouTube 视频链接')
  if (gameDate && !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) throw new Error('请检查比赛日期')
  if (espnEventId && !/^\d+$/.test(espnEventId)) throw new Error('ESPN 比赛编号只能包含数字')
  return { ...base, articleUrls, ...(youtubeUrl ? { youtubeUrl } : {}), ...(gameDate ? { gameDate } : {}), ...(espnEventId ? { espnEventId } : {}) }
}
async function startRun() {
  if (busy.value || collectionBlocked.value) return
  let input
  try { input = collectionInput() } catch (error) { actionError.value = error.message; return }
  actionBusy.value = 'collect'; actionError.value = ''
  try { await postOnce('/nba-video/runs', input); initializeCollection = true; if (dialogMode.value === 'collect') closeDialog(); toast.success('已开始采集 NBA 新闻') }
  catch (error) { actionError.value = error.message || '提交结果未确认，请刷新后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function resumeJobs(ids = selectedResumeIds.value) {
  if (busy.value || !canQueueProduction.value) return
  const chosen = new Set(ids), jobIds = overview.value.jobs.filter(job => job.canResume && !processingJobIds.value.has(job.id) && chosen.has(job.id)).map(job => job.id)
  if (!jobIds.length) return
  actionBusy.value = 'resume'; actionError.value = ''
  try { await postOnce('/nba-video/resume', { jobIds }); selectedIds.value = selectedIds.value.filter(id => !jobIds.includes(id)); toast.success(`已将 ${jobIds.length} 条续做任务加入制作队列`) }
  catch (error) { actionError.value = error.message || '续做结果未确认，请刷新后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function uploadJobs(ids = pendingUploadIds.value) {
  if (busy.value || !canQueueProduction.value) return
  if (!uploadAccountReady.value) { actionError.value = uploadAccountMessage.value; return }
  const chosen = new Set(ids), jobIds = overview.value.jobs.filter(job => job.canUpload && !job.uploaded && !processingJobIds.value.has(job.id) && chosen.has(job.id)).map(job => job.id)
  if (!jobIds.length) return
  actionBusy.value = 'upload'; actionError.value = ''
  try { await postOnce('/nba-video/uploads', { jobIds }); toast.success(`已将 ${jobIds.length} 条发表任务加入制作队列`) }
  catch (error) { actionError.value = error.message || '上传结果未确认，请刷新后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function saveChannels() {
  if (busy.value || !channelsDirty.value) return
  if (channelValidation.value) { actionError.value = channelValidation.value; return }
  const youtubeChannels = channelDraft.value.map(channelUrl)
  actionBusy.value = 'channels'; actionError.value = ''
  try {
    await api.put('/nba-video/channels', { youtubeChannels })
    channelDraft.value = [...youtubeChannels]; channelSaved.value = [...youtubeChannels]
    if (dialogMode.value === 'channels') closeDialog()
    toast.success('频道列表已保存，将用于下一批采集')
  } catch (error) { actionError.value = error.message || '频道保存失败，请重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function stopRun(run = overview.value.activeRun) {
  if (busy.value || !run || run.status === 'stopping') return
  const id = run.id
  actionBusy.value = 'stop'; actionError.value = ''
  try { await api.post(`/nba-video/runs/${encodeURIComponent(id)}/stop`, {}); toast.success('已请求停止，完成的进度会保留') }
  catch (error) { actionError.value = error.message || '停止结果未确认，请刷新状态'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function saveSettings() {
  if (busy.value) return
  const value = settingsDraft.value
  if (!value.languages.length || !value.voice.trim()) { actionError.value = '请选择新闻语言并填写中文音色'; return }
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100 || !Number.isInteger(value.videosPerChannel) || value.videosPerChannel < 1 || value.videosPerChannel > 1000 || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 5 || value.intervalMinutes > 1440 || !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2 || !Number.isFinite(value.originalGain) || value.originalGain < 0 || value.originalGain > 1 || !Number.isFinite(value.arenaGain) || value.arenaGain < 0 || value.arenaGain > 2) { actionError.value = '请检查采集数量、语速、混音与采集间隔'; return }
  actionBusy.value = 'settings'; actionError.value = ''
  try { await api.put('/nba-video/settings', { ...value, youtubeChannels: [...overview.value.settings.youtubeChannels], voice: value.voice.trim(), languages: [...value.languages] }); if (dialogMode.value === 'settings') closeDialog(); toast.success('设置已保存') }
  catch (error) { actionError.value = error.message || '设置保存失败，请重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function saveSource() {
  if (busy.value || isActive.value || !selectedJob.value || !sourceChanged.value) return
  const id = selectedJob.value.id, youtubeUrl = sourceUrlDraft.value.trim()
  if (!webUrl(youtubeUrl) || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(sourceHost(youtubeUrl))) { actionError.value = '请填写有效的 YouTube 视频链接'; return }
  actionBusy.value = 'source'; actionError.value = ''
  try { await api.patch(`/nba-video/jobs/${encodeURIComponent(id)}`, { youtubeUrl }); sourceDraftJobId = ''; toast.success('比赛视频已更新，可继续制作') }
  catch (error) { actionError.value = error.message || '视频链接保存失败，请重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
async function deleteJob() {
  if (busy.value || !deleteTarget.value || !canDelete.value) return
  const target = { ...deleteTarget.value }
  actionBusy.value = 'delete'; actionError.value = ''
  try {
    await api.del(`/nba-video/jobs/${encodeURIComponent(target.id)}`, { expectedTitle: target.title })
    selectedIds.value = selectedIds.value.filter(id => id !== target.id)
    overview.value = { ...overview.value, jobs: overview.value.jobs.filter(job => job.id !== target.id) }
    if (selectedId.value === target.id) { pausePlayers(); selectedId.value = ''; selectedJob.value = null; detailError.value = ''; detailSequence++; detailController?.abort(); detailLoading.value = false; mobileDetail.value = false; await updateTaskLink('', true) }
    closeDialog(); toast.success('任务已删除，共享素材保留')
  } catch (error) { actionError.value = error.message || '删除结果未确认，请刷新后重试'; toast.error(actionError.value) }
  finally { await refreshAfterAction(); if (!disposed) actionBusy.value = '' }
}
function restartPolling() { if (pollTimer !== undefined) window.clearInterval(pollTimer); if (!disposed) pollTimer = window.setInterval(refresh, pollDelay.value) }
watch(pollDelay, restartPolling)
watch(detailTab, pausePlayers)
watch(() => route.query.job, value => { const requested = queryJob(value), id = requested || overview.value.jobs[0]?.id || ''; if (id && id !== selectedId.value) { clearFilters(); void selectJob(id, { updateUrl: false }) } if (!requested) mobileDetail.value = false })
onMounted(() => { restartPolling(); void refresh() })
onBeforeUnmount(() => { disposed = true; detailSequence++; overviewController?.abort(); detailController?.abort(); if (pollTimer !== undefined) window.clearInterval(pollTimer); pausePlayers(); dialog.value?.close() })
</script>

<style scoped>
.nba-page { --nba-green: #15803d; --nba-amber: #92400e; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 22px 28px 14px; overflow: auto; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 var(--font-body); letter-spacing: 0; }
.nba-page *, .nba-page *::before, .nba-page *::after { box-sizing: border-box; }
.nba-page :is(h1,h2,h3,h4,p,button,input,textarea,select) { font-family: inherit; letter-spacing: 0; }
.nba-page :is(button,a,input,textarea,select,summary):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.nba-page :is(h1,h2,h3,h4,p,ul,ol,dl) { margin: 0; }.nba-page h1 { font-size: 22px; font-weight: 650; line-height: 1.35; }.nba-page h2 { font-size: 17px; font-weight: 600; }.nba-page h3 { font-size: 14px; font-weight: 600; }.nba-page h4 { font-size: 14px; font-weight: 550; }
.nba-page .btn { min-height: 34px; border-radius: 6px; font-size: 12px; box-shadow: none; transform: none; gap: 6px; white-space: nowrap; }.nba-page .btn:hover { box-shadow: none; transform: none; }.nba-page .btn-icon { width: 32px; height: 32px; min-height: 32px; padding: 6px; flex-shrink: 0; }.nba-page .btn-sm { min-height: 30px; padding: 5px 9px; }.nba-page button:disabled { cursor: not-allowed; opacity: .5; }
.page-header, .page-title, .header-actions, .overview-strip, .sync-time, .run-banner, .queue-header, .selection-bar, .selection-bar label, .queue-bottom, .detail-header, .detail-kicker, .task-identity, .section-header, .asset-links, .dialog-header, .dialog-footer { display: flex; align-items: center; }
.page-header { justify-content: space-between; gap: 18px; flex-wrap: wrap; padding-bottom: 18px; flex-shrink: 0; }.page-title { gap: 12px; flex-wrap: wrap; }.schedule-state { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); font-size: 11px; }.header-actions { flex-wrap: wrap; gap: 7px; }.button-count { width: 2ch; text-align: right; font-variant-numeric: tabular-nums; }
.overview-strip { flex-wrap: wrap; gap: 12px 22px; min-height: 41px; border-block: 1px solid var(--border); color: var(--text-2); font-size: 12px; flex-shrink: 0; }.overview-strip strong { color: var(--text-1); font-weight: 550; margin-left: 5px; font-variant-numeric: tabular-nums; }.sync-time { margin-left: auto; gap: 7px; font-size: 11px; }
.run-banner, .alert { gap: 10px; padding: 11px 12px; margin-top: 12px; border-radius: 5px; flex-shrink: 0; }.run-banner { background: var(--info-bg); color: var(--info); }.run-banner > svg, .alert > svg { flex-shrink: 0; }.run-banner > div { flex: 1; min-width: 0; }.run-banner strong { font-size: 12px; font-weight: 550; }.run-banner p { color: var(--text-1); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }.alert { display: flex; align-items: center; }.alert span { flex: 1; min-width: 0; overflow-wrap: anywhere; }.alert.error { background: var(--error-bg); color: var(--error); }
.run-queues { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); flex-shrink: 0; border-block: 1px solid var(--border); margin-top: 12px; }.queue-run { min-width: 0; padding: 12px 16px 12px 0; }.queue-run + .queue-run { border-left: 1px solid var(--border); padding-left: 16px; }.queue-run-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; min-height: 30px; }.queue-run-heading strong { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 550; }.queue-run-heading > .btn { margin-left: auto; }.queue-run p { margin-top: 5px; font-size: 12px; overflow-wrap: anywhere; }.queued-count { color: var(--text-2); font-size: 11px; }.pending-runs { list-style: none; padding: 7px 0 0; }.pending-runs li { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; min-height: 32px; }.pending-runs li span { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) { .run-queues { grid-template-columns: minmax(0,1fr); }.queue-run { padding: 10px 0; }.queue-run + .queue-run { border-left: 0; border-top: 1px solid var(--border); padding-left: 0; } }
.workspace { display: grid; grid-template-columns: 322px minmax(0,1fr); min-height: 470px; flex: 1; overflow: hidden; border-bottom: 1px solid var(--border); margin-top: 12px; }.queue-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 15px 0 0; border-right: 1px solid var(--border); }.queue-header { padding: 0 16px 13px 0; justify-content: space-between; }.queue-header h2 { font-size: 14px; }.queue-header h2 span { margin-left: 5px; font-size: 11px; font-weight: 400; color: var(--text-2); }
.search-field { display: flex; align-items: center; gap: 7px; height: 34px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 5px; padding: 0 9px; margin: 0 16px 9px 0; color: var(--text-2); }.search-field:focus-within { outline: 2px solid var(--info); outline-offset: 1px; }.search-field input { min-width: 0; width: 100%; border: 0; outline: none; background: transparent; font-size: 12px; color: var(--text-1); }.search-field input:focus-visible { outline: none; }.queue-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding-right: 16px; }.queue-filters select { min-width: 0; width: 100%; height: 32px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-1); background: var(--bg-0); padding: 0 7px; font-size: 12px; }.selection-bar { justify-content: space-between; height: 41px; flex-shrink: 0; padding: 0 16px 0 4px; color: var(--text-2); font-size: 11px; }.selection-bar label { gap: 8px; cursor: pointer; }.nba-page input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; flex-shrink: 0; margin: 0; }
.queue-list { list-style: none; min-height: 0; flex: 1; overflow: auto; border-top: 1px solid var(--border); padding: 0; }.queue-list li { display: grid; grid-template-columns: 28px minmax(0,1fr); border-bottom: 1px solid var(--border); position: relative; }.queue-list li:hover { background: var(--bg-1); }.queue-list li.selected { background: var(--bg-2); box-shadow: inset 3px 0 var(--accent); }.row-checkbox { align-self: start; justify-self: end; margin-top: 19px !important; }.queue-item { display: block; width: 100%; min-width: 0; text-align: left; border: 0; background: transparent; padding: 14px 16px 14px 10px; cursor: pointer; color: inherit; }.queue-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; font-weight: 550; line-height: 1.7; }.queue-source, .queue-match { display: block; margin-top: 6px; font-size: 11px; color: var(--text-2); overflow-wrap: anywhere; }.queue-match { margin-top: 4px; }.queue-bottom { justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--text-2); }.queue-bottom time { font-variant-numeric: tabular-nums; font-size: 10px; flex-shrink: 0; }.queue-reason { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--nba-amber); font-size: 11px; margin-top: 6px; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }.status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }.success { color: var(--nba-green); }.warning { color: var(--nba-amber); }.error-text, .inline-error { color: var(--error); }.info { color: var(--info); }.inline-error { font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }.muted { color: var(--text-2); font-size: 12px; line-height: 1.8; }
.detail-pane { min-width: 0; overflow: auto; padding: 16px 0 28px 26px; }.detail-header { align-items: flex-start; justify-content: space-between; gap: 12px; }.detail-header > div { min-width: 0; }.detail-header h2 { font-size: 18px; line-height: 1.65; overflow-wrap: anywhere; margin-top: 5px; }.detail-kicker { flex-wrap: wrap; gap: 12px; color: var(--text-2); font-size: 11px; }.delete-button { color: var(--text-2); }.delete-button:not(:disabled):hover { color: var(--error); background: var(--error-bg); }.task-identity { gap: 5px; margin-top: 4px; color: var(--text-2); font-size: 10px; }.task-identity code { min-width: 0; overflow-wrap: anywhere; font: 10px/1.6 var(--font-mono); }.task-identity .btn-icon { width: 26px; height: 26px; min-height: 26px; padding: 5px; }.task-identity time { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }.back-button { display: none; }
.pipeline { display: grid; grid-template-columns: repeat(8,minmax(0,1fr)); gap: 5px; list-style: none; padding: 13px 0; border-block: 1px solid var(--border); margin-top: 13px !important; }.pipeline li { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--text-2); font-size: 10px; text-align: center; }.pipeline li > span { display: grid; place-items: center; width: 19px; height: 19px; border: 1px solid var(--border); border-radius: 50%; font-size: 10px; }.pipeline .done { color: var(--nba-green); }.pipeline .done > span { border-color: transparent; background: var(--success-bg); }.pipeline .active { color: var(--info); }.pipeline .active > span { border-color: var(--info); background: var(--info-bg); }.pipeline .held { color: var(--nba-amber); }.pipeline .held > span { border-color: var(--nba-amber); }.job-message { display: flex; align-items: center; gap: 8px; padding: 11px 0; color: var(--text-2); font-size: 12px; }.job-message.warning { color: var(--nba-amber); }.job-message > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }.job-message > svg { flex-shrink: 0; }.job-message .btn { flex-shrink: 0; }
.detail-tabs { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border-bottom: 1px solid var(--border); gap: 14px; }.detail-tabs button { min-width: 0; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 11px 2px; background: transparent; color: var(--text-2); cursor: pointer; font-size: 12px; line-height: 1.5; }.detail-tabs button.active { color: var(--text-0); border-bottom-color: var(--text-0); font-weight: 600; }.detail-section { padding-top: 18px; min-width: 0; }.video-player { display: block; width: 100%; aspect-ratio: 16/9; max-height: 54vh; background: #18181b; object-fit: contain; border-radius: 5px; }.video-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; width: 100%; aspect-ratio: 16/9; min-height: 180px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); color: var(--text-2); font-size: 12px; }.asset-links { flex-wrap: wrap; gap: 12px 18px; margin-top: 12px; font-size: 12px; }.asset-links a, .article-meta a, .evidence-list a { display: inline-flex; align-items: center; gap: 5px; color: var(--text-1); text-decoration: none; }.asset-links a:hover, .article-meta a:hover, .evidence-list a:hover { text-decoration: underline; }.asset-links > span { margin-left: auto; color: var(--text-2); font-size: 11px; }.section-header { justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }.section-header > span { color: var(--text-2); font-size: 11px; }.section-header > .success { color: var(--nba-green); }.section-header > .warning { color: var(--nba-amber); }.voice-section, .verification-section, .script-section, .source-section { padding-top: 24px; margin-top: 24px; border-top: 1px solid var(--border); }.voice-section h3 { margin-bottom: 10px; }.voice-section audio { display: block; width: 100%; height: 38px; }.verification-section .section-header > svg { color: var(--text-2); }.verification-list > div, .game-facts > div { display: grid; grid-template-columns: 140px minmax(0,1fr); gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12px; }.verification-list dt, .game-facts dt { color: var(--text-2); overflow-wrap: anywhere; }.verification-list dd, .game-facts dd { margin: 0; overflow-wrap: anywhere; line-height: 1.8; }
.article-section > summary { display: flex; align-items: center; gap: 10px; list-style: none; cursor: pointer; font-size: 14px; font-weight: 600; }.article-section > summary::-webkit-details-marker { display: none; }.article-section > summary > span:nth-child(2) { margin-left: auto; font-size: 11px; color: var(--text-2); font-weight: 400; }.article-section:not([open]) > summary > svg { transform: rotate(-90deg); }.article-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 13px 0; color: var(--text-2); font-size: 11px; }.article-section h3, .script-section h4 { margin-bottom: 14px; line-height: 1.8; overflow-wrap: anywhere; }.article-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.95; font-size: 13px; color: var(--text-1); }.article-body[lang="en"] { line-height: 1.85; }.section-empty { padding: 20px 0; color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }.material-notes { padding-left: 20px; font-size: 12px; line-height: 1.8; margin-top: 12px !important; color: var(--text-2); }.material-notes li { margin-top: 6px; overflow-wrap: anywhere; }
.scoreboard { display: grid; grid-template-columns: minmax(0,1fr) 20px minmax(0,1fr); align-items: center; gap: 14px; padding: 20px 0; border-block: 1px solid var(--border); }.scoreboard > div { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }.scoreboard small { color: var(--text-2); font-size: 10px; }.scoreboard strong { font-size: 15px; font-weight: 550; overflow-wrap: anywhere; }.scoreboard > div > span { font-size: 27px; font-weight: 600; font-variant-numeric: tabular-nums; }.score-divider { text-align: center; font-size: 20px; color: var(--text-2); }.game-facts { margin-top: 10px !important; }.evidence-list { list-style: none; padding: 10px 0 0; font-size: 12px; }.evidence-list li { padding-top: 8px; overflow-wrap: anywhere; }.source-section .video-player { margin-top: 13px; }.job-logs { list-style: none; padding: 0; }.job-logs li { border-bottom: 1px solid var(--border); padding: 15px 0; }.job-logs li > div { display: flex; flex-wrap: wrap; gap: 12px; color: var(--text-2); font-size: 11px; }.job-logs li p { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 6px; font-size: 12px; line-height: 1.8; }
.source-editor { padding-top: 24px; margin-top: 24px; border-top: 1px solid var(--border); }.source-editor > div { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 12px; }.source-editor > div > p { flex: 1; min-width: 180px; }.source-editor .btn { margin-left: auto; }
.verification-detail { margin-top: 14px; color: var(--text-2); font-size: 11px; }.verification-detail summary { cursor: pointer; }.verification-detail pre { max-height: 340px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; margin: 12px 0 0; background: var(--bg-1); border: 1px solid var(--border); border-radius: 4px; font: 11px/1.8 var(--font-mono); }
.empty-state { min-height: 240px; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px 18px; color: var(--text-2); text-align: center; font-size: 12px; }.empty-state strong { color: var(--text-1); font-size: 13px; font-weight: 550; }.empty-state code, .empty-state p { max-width: 100%; overflow-wrap: anywhere; }.detail-empty { min-height: 390px; }.empty-state h2 { color: var(--text-1); font-size: 17px; }
.workspace-dialog { width: min(680px,calc(100vw - 32px)); max-height: calc(100dvh - 40px); padding: 0; margin: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-0); color: var(--text-1); overflow: auto; box-shadow: 0 20px 70px rgba(0,0,0,.16); }.workspace-dialog::backdrop { background: rgba(0,0,0,.3); }.dialog-header { justify-content: space-between; gap: 15px; padding: 18px 22px; border-bottom: 1px solid var(--border); }.dialog-header h2 { font-size: 17px; line-height: 1.5; }.dialog-body { padding: 20px 22px; }.form-fields { display: grid; gap: 18px; }.dialog-footer { justify-content: flex-end; gap: 9px; padding: 14px 22px; border-top: 1px solid var(--border); background: var(--bg-0); }.form-fields fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }.form-fields legend { font-size: 12px; font-weight: 550; margin-bottom: 9px; }.inline-options { display: flex; flex-wrap: wrap; gap: 22px; }.inline-options label, .check-line { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }.field-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }.field-grid .check-line { align-self: end; min-height: 36px; }.field { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 12px; }.field > span { font-weight: 550; }.optional { font-size: 11px; font-weight: 400; color: var(--text-2); margin-left: 4px; }.field :is(input,textarea) { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: 5px; padding: 9px 10px; background: var(--bg-0); color: var(--text-1); font-size: 12px; line-height: 1.6; }.field input { height: 37px; }.field textarea { resize: vertical; min-height: 90px; max-height: 240px; }.field input:disabled { background: var(--bg-1); color: var(--text-2); }.settings-section { display: grid; gap: 15px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }.settings-section:last-of-type { padding-bottom: 0; border-bottom: 0; }.settings-section h3 { font-size: 13px; }.slider-field { display: grid; grid-template-columns: 90px minmax(0,1fr) 42px; align-items: center; gap: 12px; font-size: 12px; }.slider-field input { min-width: 0; width: 100%; accent-color: var(--accent); }.slider-field output { text-align: right; color: var(--text-2); font-variant-numeric: tabular-nums; }.interval-field { max-width: 240px; }.runs-dialog { width: min(800px,calc(100vw - 32px)); }.run-record { border-bottom: 1px solid var(--border); padding-bottom: 18px; margin-bottom: 18px; }.run-record:last-child { margin-bottom: 0; border-bottom: 0; }.run-record > summary { display: flex; align-items: center; gap: 12px; cursor: pointer; list-style: none; }.run-record > summary::-webkit-details-marker { display: none; }.run-record > summary > span:first-child { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }.run-record strong { font-size: 12px; font-weight: 550; overflow-wrap: anywhere; }.run-record time { color: var(--text-2); font-size: 11px; }.run-record > summary .status { font-size: 11px; }.run-record:not([open]) > summary > svg { transform: rotate(-90deg); }.run-message { margin: 13px 0 5px !important; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }.source-reports { list-style: none; padding: 12px 0 0; }.source-reports li { padding: 9px 0; font-size: 12px; }.source-reports li > div { display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: space-between; }.source-reports p { margin-top: 4px; color: var(--nba-amber); overflow-wrap: anywhere; }.excluded-section { padding-top: 16px; }.excluded-section h3 { font-size: 12px; }.excluded-section ul { list-style: none; padding: 0; }.excluded-section li { padding: 12px 0; border-bottom: 1px solid var(--border); font-size: 12px; }.excluded-section li:last-child { border-bottom: 0; }.excluded-section a { color: var(--text-1); text-decoration: none; overflow-wrap: anywhere; line-height: 1.7; }.excluded-section a:hover { text-decoration: underline; }.excluded-section p { margin-top: 4px; color: var(--nba-amber); overflow-wrap: anywhere; line-height: 1.8; }.delete-body > p:first-child { overflow-wrap: anywhere; font-size: 14px; line-height: 1.8; }.delete-body .muted { margin-top: 9px; }.delete-confirm { color: var(--error); border-color: var(--error); }.spin { animation: nba-spin 1s linear infinite; }@keyframes nba-spin { to { transform: rotate(360deg); } }
.stat-filter { display: inline-flex; align-items: center; min-height: 30px; padding: 3px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: inherit; font-size: inherit; cursor: pointer; }.stat-filter.active { border-bottom-color: var(--accent); color: var(--text-1); }
.collection-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 20px; padding-top: 10px; color: var(--text-2); font-size: 11px; flex-shrink: 0; }.collection-strip > span, .collection-strip a, .upload-account-line a, .upload-records a, .run-channels a, .run-videos a { display: inline-flex; align-items: center; gap: 5px; }.collection-strip > span { min-width: 0; flex-wrap: wrap; overflow-wrap: anywhere; }.collection-strip svg { flex-shrink: 0; }.collection-strip a, .upload-account-line a { color: var(--text-2); text-decoration: none; white-space: nowrap; }.collection-strip > a { margin-left: auto; }.collection-strip a:hover, .upload-account-line a:hover { color: var(--text-1); text-decoration: underline; }.account-state > span { color: var(--text-2); }
.collection-mode { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); border: 1px solid var(--border); border-radius: 6px; padding: 3px; gap: 4px; }.collection-mode button { display: inline-flex; justify-content: center; align-items: center; gap: 6px; min-height: 34px; padding: 6px 8px; border: 0; border-radius: 3px; color: var(--text-2); background: transparent; cursor: pointer; font-size: 12px; }.collection-mode button.active { color: var(--text-1); background: var(--bg-2); }.collection-mode svg { flex-shrink: 0; }.channel-summary { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding-bottom: 13px; border-bottom: 1px solid var(--border); font-size: 12px; }.channel-summary > span { display: inline-flex; align-items: center; gap: 7px; }.channel-summary > p { flex-basis: 100%; }
.channel-row { display: grid; grid-template-columns: 18px minmax(0,1fr) 96px; align-items: center; gap: 7px; margin-bottom: 10px; }.channel-row > span { font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }.channel-row input { width: 100%; min-width: 0; height: 36px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-1); background: var(--bg-0); font-size: 12px; }.channel-order { display: flex; align-items: center; }
.upload-section { padding: 20px 0; border-bottom: 1px solid var(--border); }.upload-account-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin: 8px 0 13px; font-size: 12px; color: var(--text-2); }.upload-account-line > span { overflow-wrap: anywhere; }.upload-records { list-style: none; padding: 0; }.upload-records li { padding: 11px 0; border-top: 1px solid var(--border); font-size: 12px; }.upload-records li > div { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }.upload-records strong { font-size: 12px; font-weight: 550; overflow-wrap: anywhere; }.upload-records p { margin-top: 5px; line-height: 1.7; overflow-wrap: anywhere; color: var(--text-2); }.upload-records a { color: var(--text-1); text-decoration: none; }.upload-records a:hover { text-decoration: underline; }.upload-records time { display: block; margin-top: 4px; color: var(--text-2); font-size: 11px; }.upload-section > .btn { margin-top: 10px; }
.publication-description { margin: 12px 0; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }.publication-description > span { color: var(--text-2); font-size: 11px; }.publication-description p { margin: 3px 0 0; color: var(--text-1); }
.run-channels { margin-top: 14px; font-size: 12px; }.run-channels > summary { cursor: pointer; color: var(--text-2); }.run-channels ol { padding: 8px 0 0 20px; }.run-channels li { padding: 3px 0; }.run-channels a, .run-videos a { color: var(--text-1); text-decoration: none; overflow-wrap: anywhere; word-break: break-word; }.run-channels a:hover, .run-videos a:hover { text-decoration: underline; }.run-channels svg, .run-videos svg { flex-shrink: 0; }.run-videos { padding-top: 17px; }.run-videos h3 { font-size: 12px; }.run-videos ul { list-style: none; padding: 4px 0 0; }.run-videos li { padding: 11px 0; border-bottom: 1px solid var(--border); font-size: 12px; }.run-videos li:last-child { border-bottom: 0; }.run-videos li > div { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 14px; }.run-videos li > div > a { flex: 1; min-width: 160px; }.run-videos p { margin-top: 4px; overflow-wrap: anywhere; }
@media (max-width: 1180px) { .nba-page { padding-inline: 20px; }.workspace { grid-template-columns: 290px minmax(0,1fr); }.detail-pane { padding-left: 20px; }.header-actions { gap: 6px; } }
@media (max-width: 760px) { .nba-page { padding: 17px 16px 14px; }.page-header { align-items: flex-start; gap: 14px; padding-bottom: 14px; }.page-title { width: 100%; }.nba-page h1 { font-size: 20px; }.header-actions { width: 100%; gap: 7px; }.header-actions .btn { padding-inline: 9px; }.header-actions .btn-icon { padding: 6px; }.header-actions .btn-primary { margin-left: auto; }.overview-strip { gap: 10px 16px; padding-top: 8px; padding-bottom: 5px; }.sync-time { margin-left: 0; width: 100%; justify-content: space-between; }.workspace { display: block; flex: none; min-height: 420px; overflow: visible; }.queue-pane { border-right: 0; }.queue-header, .queue-filters { padding-right: 0; }.search-field { margin-right: 0; }.selection-bar { padding-right: 0; }.queue-list { overflow: visible; }.queue-item { padding-right: 6px; }.detail-pane { display: none; overflow: visible; padding: 10px 0 24px; }.show-detail .queue-pane { display: none; }.show-detail .detail-pane { display: block; }.back-button { display: inline-flex; margin: 0 0 12px -8px; }.detail-header h2 { font-size: 17px; }.task-identity { flex-wrap: wrap; }.task-identity code { max-width: calc(100% - 32px); }.task-identity time { margin-left: 0; width: 100%; }.pipeline { grid-template-columns: repeat(4,minmax(0,1fr)); row-gap: 12px; }.detail-tabs { gap: 5px; }.detail-tabs button { font-size: 11px; padding-inline: 0; }.job-message { flex-wrap: wrap; }.job-message > span { flex-basis: calc(100% - 25px); }.job-message .btn { margin-left: auto; }.video-player { max-height: none; }.verification-list > div, .game-facts > div { grid-template-columns: 105px minmax(0,1fr); gap: 10px; }.run-banner { flex-wrap: wrap; }.run-banner > div { flex-basis: calc(100% - 30px); }.run-banner > button { margin-left: auto; }.scoreboard { gap: 8px; }.scoreboard strong { font-size: 13px; }.workspace-dialog { max-height: calc(100dvh - 24px); }.dialog-header, .dialog-body, .dialog-footer { padding-inline: 17px; }.dialog-header { padding-block: 15px; }.dialog-header h2 { font-size: 16px; }.field-grid { grid-template-columns: minmax(0,1fr); gap: 15px; }.slider-field { grid-template-columns: 78px minmax(0,1fr) 38px; gap: 8px; }.dialog-footer .btn { white-space: normal; }.article-section > summary { gap: 6px; }.article-section > summary > span:nth-child(2) { font-size: 10px; } }
@media (max-width: 480px) { .collection-strip { gap: 7px 12px; }.collection-strip > a { margin-left: 0; }.channel-row { grid-template-columns: 18px minmax(0,1fr); row-gap: 3px; }.channel-order { grid-column: 2; justify-content: flex-end; }.collection-mode button { font-size: 11px; padding-inline: 4px; }.header-actions .btn-primary { margin-left: 0; }.queue-bottom { flex-wrap: wrap; row-gap: 4px; } }
@media (max-height: 720px) and (min-width: 761px) { .workspace { flex: none; min-height: 500px; height: 500px; } }
@media (prefers-reduced-motion: reduce) { .nba-page :deep(*) { animation: none !important; transition: none !important; } }
</style>
