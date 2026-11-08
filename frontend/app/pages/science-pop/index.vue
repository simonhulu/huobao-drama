<template>
  <div class="science-page">
    <header class="page-head">
      <div><h1>冷知识科普</h1><p>从频道列表自动采集，批量二创、花生制作，直接发表到百家号。</p></div>
      <div class="head-actions"><button class="btn" @click="accountDialog = 'huasheng'"><Users :size="15" />花生账号</button><button class="btn" @click="accountDialog = 'baijiahao'"><Users :size="15" />百家号账号</button><button class="btn btn-ghost" @click="openImport"><Plus :size="15" />补充单条视频</button></div>
    </header>
    <ScienceCollection ref="collection" :accounts="accounts" @changed="refresh" @select-job="selectJob" @context="updateCollectionContext" />
    <div v-if="pageError" class="page-alert" role="alert"><CircleAlert :size="16" /><span>{{ pageError }}</span><button class="btn btn-sm" :disabled="loading" @click="refresh">重新加载</button></div>

    <section class="workspace" :class="{ 'show-detail': mobileDetail }" aria-label="冷知识科普工作台">
      <aside class="queue-pane" aria-label="科普任务">
        <header class="queue-head"><h2>创作任务 <span>{{ jobs.length }}</span></h2><button class="btn btn-icon btn-ghost" :disabled="loading" title="刷新本地列表" aria-label="刷新本地列表" @click="refresh"><RefreshCw :size="15" :class="{ spin: loading }" /></button></header>
        <div class="queue-filters" role="tablist" aria-label="任务状态筛选"><button v-for="filter in queueFilters" :key="filter.id" role="tab" :aria-selected="queueFilter === filter.id" :class="{ active: queueFilter === filter.id }" @click="queueFilter = filter.id">{{ filter.label }}<span>{{ filter.count }}</span></button></div>
        <div class="queue-sync"><button class="btn btn-sm" :disabled="batchSyncBusy || !!actionBusy || !syncableJobs.length" @click="syncPendingJobs"><RefreshCw :size="13" :class="{ spin: batchSyncBusy }" />{{ batchSyncBusy ? '正在启动同步…' : '同步待处理任务' }}</button><p>查询花生进度，完成后自动导出下载，并按原生产设置继续。</p><p v-if="batchSyncMessage" role="status">{{ batchSyncMessage }}</p><p v-if="batchSyncError" class="inline-error" role="alert">{{ batchSyncError }}</p></div>
        <label class="queue-search"><Search :size="14" /><input v-model="search" type="search" placeholder="搜索标题或任务 ID" aria-label="搜索科普任务" /></label>
        <div v-if="loading && !jobs.length" class="empty-state" role="status"><LoaderCircle :size="23" class="spin" /><p>正在读取任务…</p></div>
        <div v-else-if="!filteredJobs.length" class="empty-state"><Inbox :size="26" /><strong>{{ jobs.length ? '没有符合条件的任务' : '还没有科普任务' }}</strong><p>{{ jobs.length ? '试试其他关键词。' : '维护频道列表后，启动一批采集和创作。' }}</p></div>
        <ul v-else class="queue-list"><li v-for="job in filteredJobs" :key="job.id"><button class="queue-item" :class="{ selected: selectedId === job.id }" :aria-current="selectedId === job.id ? 'true' : undefined" @click="selectJob(job.id)"><strong>{{ job.title || '正在读取视频标题' }}</strong><span class="job-id">任务 ID <code>{{ job.id }}</code></span><span class="queue-bottom"><span class="status-label" :class="job.status"><i />{{ statusLabel(job) }}</span><time>{{ formatTime(job.updatedAt) }}</time></span><span v-if="recoveryFor(job)" class="queue-reason">{{ recoveryFor(job).title }}</span><span v-if="isDraftDirty(job.id)" class="draft-label">有未保存修改</span></button></li></ul>
      </aside>

      <section class="detail-pane" aria-label="科普任务详情" :aria-busy="detailLoading">
        <button class="back-button btn btn-ghost btn-sm" @click="mobileDetail = false"><ArrowLeft :size="14" />创作任务</button>
        <div v-if="!selectedJob" class="empty-state detail-empty"><FlaskConical :size="32" /><h2>{{ detailError ? '暂时无法读取任务' : '让频道里的好知识持续成为作品' }}</h2><p>{{ detailError || '保存常用 YouTube 频道，按目标数量自动采集和制作。' }}</p><button v-if="detailError" class="btn" @click="loadDetail(selectedId)">重试</button><button v-else class="btn" @click="collection?.openChannels()"><Plus :size="15" />管理采集频道</button></div>
        <template v-else>
          <header class="detail-head"><div><h2>{{ selectedJob.title || '新科普任务' }}</h2><div class="detail-meta"><span class="status-label" :class="selectedJob.status"><i />{{ statusLabel(selectedJob) }}</span><a :href="selectedJob.sourceUrl" target="_blank" rel="noreferrer">YouTube 原视频<ExternalLink :size="12" /></a><button v-if="selectedJob.projectUrl" class="project-entry" type="button" :disabled="!!actionBusy || batchSyncBusy" aria-label="花生项目" title="在任务绑定账号打开花生项目" @click="openHuashengProject"><LoaderCircle v-if="actionBusy === 'open-project'" :size="12" class="spin" /><ExternalLink v-else :size="12" />{{ actionBusy === 'open-project' ? '正在打开…' : '花生项目' }}</button></div><div class="detail-id"><span class="job-id">任务 ID <code>{{ selectedJob.id }}</code></span><button class="btn btn-ghost btn-sm" type="button" :disabled="copyState === 'copying'" @click="copyJobId"><Copy :size="12" />复制 ID</button><span v-if="copyState === 'success' || copyState === 'error'" class="copy-feedback" :class="{ error: copyState === 'error' }" role="status">{{ copyState === 'success' ? '任务 ID 已复制' : '复制失败，请手动选择任务 ID 复制' }}</span></div></div><button v-if="isRunning || ['waiting_remote', 'awaiting_export', 'retry_wait'].includes(selectedJob.status)" class="btn btn-sm" :disabled="!!actionBusy || batchSyncBusy" @click="runAction('cancel')"><Square :size="13" />停止</button><button class="btn btn-icon btn-ghost delete-task-button" type="button" aria-label="删除任务" :title="canDeleteTask ? '删除任务' : '请先停止任务再删除'" :disabled="!canDeleteTask || !!actionBusy || batchSyncBusy" @click="deleteTask"><LoaderCircle v-if="actionBusy === 'delete'" :size="15" class="spin" /><Trash2 v-else :size="15" /></button></header>
          <ol class="pipeline" aria-label="创作进度"><li v-for="(step, index) in steps" :key="step.id" :class="stepState(index)"><span class="step-icon"><Check v-if="stepState(index) === 'done'" :size="12" /><LoaderCircle v-else-if="stepState(index) === 'active' && isRunning" :size="12" class="spin" /><template v-else>{{ index + 1 }}</template></span>{{ step.label }}</li></ol>
          <p v-if="actionError" class="inline-error" role="alert">{{ actionError }}</p>
          <p v-if="actionNotice" class="action-notice" role="status"><Check :size="14" />{{ actionNotice }}</p>
          <section v-if="selectedRecovery" class="task-recovery" :class="{ scheduled: selectedJob.status === 'retry_wait' }" aria-labelledby="science-recovery-title">
            <div class="recovery-heading"><CircleAlert :size="18" /><h3 id="science-recovery-title">{{ selectedRecovery.title }}</h3><span v-if="selectedRecovery.account">{{ accountLabel(selectedRecovery.account, selectedRecovery.account === 'baijiahao' ? selectedJob.baijiahaoAccountName : selectedJob.huashengAccountName) }}</span></div>
            <p>{{ selectedRecovery.description }}</p>
            <p v-if="selectedRecovery.quotaBlocker" class="quota-blocker">当前账号额度：任务“{{ selectedRecovery.quotaBlocker.title }}”返回标准模式每日额度已用完，额度恢复后才能提交新的标准模式制作。</p>
            <div class="recovery-actions"><button v-for="(action, index) in selectedRecovery.actions" :key="action.id" class="btn btn-sm" :class="{ 'btn-primary': index === 0 }" :disabled="!!actionBusy || batchSyncBusy || isRunning" @click="runRecoveryAction(action.id)"><LoaderCircle v-if="actionBusy === recoveryActionName(action.id)" :size="14" class="spin" /><ExternalLink v-else-if="['open-original', 'open-content', 'project', 'collection', 'quota-task'].includes(action.id)" :size="14" /><ImagePlus v-else-if="action.id.startsWith('cover')" :size="14" /><Users v-else-if="action.id === 'account'" :size="14" /><Upload v-else-if="action.id === 'upload'" :size="14" /><RefreshCw v-else :size="14" />{{ action.id === 'sync' && actionBusy === 'sync' ? '正在接续…' : action.label }}</button></div>
            <details v-if="selectedJob.message && selectedJob.message !== actionNotice" class="recovery-error"><summary>{{ recoveryErrorSummary }}</summary><p>{{ selectedJob.message }}</p></details>
          </section>
          <div v-else class="job-message" :class="{ warning: selectedJob.status === 'needs_attention' }" role="status"><CircleAlert v-if="selectedJob.status === 'needs_attention'" :size="16" /><span>{{ selectedJob.message || '任务已保存' }}</span></div>
          <p v-if="selectedJob.automaticRetry" class="automatic-retry" role="status"><RefreshCw :size="14" /><span>已安排第 {{ selectedJob.automaticRetry.attempt }} / {{ selectedJob.automaticRetry.maxAttempts }} 次自动重试，下次 {{ formatTime(selectedJob.automaticRetry.nextRetryAt) }}</span></p>
          <p v-if="selectedJob.uploadRetry" class="automatic-retry" role="status"><Upload :size="14" /><span>已安排第 {{ selectedJob.uploadRetry.attempt }} 次自动重传，下次 {{ formatTime(selectedJob.uploadRetry.nextRetryAt) }}</span></p>
          <div v-if="selectedJob.uploadCheck || selectedJob.huashengCheck" class="recovery-check" role="status"><template v-for="(check, name) in { upload: selectedJob.uploadCheck, huasheng: selectedJob.huashengCheck }" :key="name"><p v-if="check"><strong>{{ name === 'upload' ? '上传核对' : '花生查询' }}</strong><time>{{ formatTime(check.checkedAt) }}</time><span>{{ check.message }}</span></p></template></div>
          <div v-if="selectedJob.projectUrl" class="project-sync">
            <button class="btn btn-sm" :disabled="!!actionBusy || batchSyncBusy" @click="runAction('check-huasheng')"><Search :size="13" :class="{ spin: actionBusy === 'check-huasheng' }" />只查询制作进度</button>
            <button class="btn btn-sm" :disabled="isRunning || !!actionBusy || batchSyncBusy" @click="runAction('sync')"><LoaderCircle v-if="actionBusy === 'sync'" :size="13" class="spin" /><RefreshCw v-else :size="13" />{{ actionBusy === 'sync' ? '正在接续…' : isRunning && ['produce', 'export'].includes(selectedJob.stage) ? '正在自动接续' : '同步花生状态' }}</button>
            <div v-if="visibleHuashengSync" class="sync-result" role="status"><span>上次查询 {{ formatTime(visibleHuashengSync.checkedAt) }}</span><p :class="{ 'sync-error': visibleHuashengSync.status === 'error' }">{{ visibleHuashengSync.error || visibleHuashengSync.message }}<template v-if="visibleHuashengSync.exportProgress !== undefined"> · 导出 {{ Math.round(visibleHuashengSync.exportProgress) }}%</template></p></div>
            <span class="sync-note">完成后自动导出下载，并按原生产设置继续。</span>
          </div>
          <details v-if="['needs_attention', 'paused'].includes(selectedJob.status) && scriptLocked && (canRecoverProject || canRecoverExport)" ref="projectRecovery" class="recovery-form">
            <summary>恢复原项目</summary>
            <p class="field-note">填写原任务的记录，继续时使用当前绑定账号核对，不会新建项目。</p>
            <form @submit.prevent="recoverJob">
              <label v-if="canRecoverProject" class="field"><span>原花生项目链接</span><input v-model="recovery.projectUrl" type="url" placeholder="https://www.huasheng.cn/video/…" :disabled="!!actionBusy" /></label>
              <details v-if="canRecoverExport" class="export-recovery"><summary>高级：恢复原导出任务</summary><label class="field"><span>原导出任务编号</span><input v-model="recovery.taskId" autocomplete="off" :disabled="!!actionBusy" /></label><label class="field"><span>原导出版本 hash</span><input v-model="recovery.projectHash" autocomplete="off" maxlength="64" placeholder="64 位版本标识" :disabled="!!actionBusy" /></label></details>
              <button class="btn btn-sm" type="submit" :disabled="!canRecover || !!actionBusy"><Save :size="13" />保存恢复信息</button>
            </form>
          </details>
          <p v-if="detailError" class="inline-error" role="alert">{{ detailError }}，当前保留上次结果。</p>
          <div class="detail-tabs" role="tablist" aria-label="科普任务内容"><button v-for="tab in tabs" :id="`science-tab-${tab.id}`" :key="tab.id" role="tab" :aria-selected="detailTab === tab.id" :aria-controls="`science-panel-${tab.id}`" :class="{ active: detailTab === tab.id }" @click="detailTab = tab.id">{{ tab.label }}</button></div>

          <section id="science-panel-script" v-show="detailTab === 'script'" role="tabpanel" aria-labelledby="science-tab-script" class="script-panel">
            <div class="account-pickers">
              <label class="field"><span>花生制作账号</span><select v-model="editor.huashengAccountName" aria-label="花生制作账号" :disabled="isRunning || scriptLocked || !!actionBusy"><option value="">请选择花生账号</option><option v-for="account in accounts.huasheng.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.status !== 'ready' ? ' · 需登录' : '' }}</option></select></label>
              <label class="field"><span>百家号上传账号</span><select v-model="editor.baijiahaoAccountName" aria-label="百家号上传账号" :disabled="isRunning || uploadLocked || !!actionBusy"><option value="">请选择百家号账号</option><option v-for="account in accounts.baijiahao.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.status !== 'ready' ? ' · 需登录' : '' }}</option></select></label>
            </div>
            <p class="field-note">{{ scriptLocked ? '已开始制作，文稿和花生账号已绑定当前项目。' : '账号仅用于当前任务。添加或登录账号可使用页面右上角的账号管理。' }}</p>
            <label class="field"><span>科普标题</span><input v-model="editor.title" maxlength="60" :disabled="isRunning || scriptLocked || !!actionBusy" placeholder="为这篇科普起一个标题" /></label>
            <div class="script-heading"><label for="science-script">二创文稿</label><span :class="{ 'inline-error': editor.script.length > 10000 }">{{ editor.script.length }} / 10000 字</span></div>
            <textarea id="science-script" v-model="editor.script" class="script-editor" :disabled="isRunning || scriptLocked || !!actionBusy" placeholder="原视频下载并转写后，二创文稿会出现在这里。也可以在此编辑口播稿。" />
            <p v-if="editor.script.length > 10000" class="inline-error" role="alert">花生文稿最多 10000 字，请精简后再开始制作。</p>
            <section v-if="selectedJob.factChecks?.length" class="fact-checks" aria-labelledby="science-fact-title"><h3 id="science-fact-title">知识点备注</h3><ul><li v-for="(fact, index) in selectedJob.factChecks" :key="index"><strong>{{ fact.claim }}</strong><span>{{ fact.note }}</span></li></ul></section>
            <details v-if="selectedJob.plan" class="planning-details" aria-label="科普二创准备记录">
              <summary>二创准备记录 <span>主题、立场、情绪、材料与大纲</span></summary>
              <div class="planning-body">
                <p v-if="planNeedsStoryDetails" class="field-note planning-legacy-note">这份旧版记录缺少完整的情绪与讲述材料拆解，不能据此确认已完成全部二创准备；已有分析和大纲仍可查看。</p>
                <dl class="planning-summary">
                  <div v-if="selectedJob.plan.writingModel"><dt>正文模型</dt><dd>{{ selectedJob.plan.writingModel }}</dd></div>
                  <div v-if="selectedJob.plan.writingVersion"><dt>写作版本</dt><dd>{{ selectedJob.plan.writingVersion }}</dd></div>
                  <div><dt>原稿概要</dt><dd>{{ selectedJob.plan.sourceSummary }}</dd></div>
                  <div v-if="selectedJob.plan.sourceTheme"><dt>原文主题</dt><dd>{{ selectedJob.plan.sourceTheme }}</dd></div>
                  <div><dt>核心主张</dt><dd>{{ selectedJob.plan.coreClaim || selectedJob.plan.angle }}</dd></div>
                  <div v-if="selectedJob.plan.authorStance"><dt>原稿立场</dt><dd>{{ selectedJob.plan.authorStance }}</dd></div>
                  <div v-if="selectedJob.plan.angle"><dt>重讲角度</dt><dd>{{ selectedJob.plan.angle }}</dd></div>
                </dl>
                <section v-if="selectedJob.plan.emotionalArc?.length" class="planning-section emotional-arc"><h4>原文情绪怎么变化</h4><ol><li v-for="item in selectedJob.plan.emotionalArc" :key="item.id"><strong>{{ item.from }} → {{ item.to }}</strong><span>变化缘由：{{ item.trigger }}</span><small v-if="sourceEvidence(item.evidenceIds)">原文依据：{{ sourceEvidence(item.evidenceIds) }}</small></li></ol></section>
                <section v-if="selectedJob.plan.tellingMaterials?.length" class="planning-section telling-materials"><h4>拿什么材料来讲</h4><ul><li v-for="item in selectedJob.plan.tellingMaterials" :key="item.id"><strong>{{ item.disposition === 'retain' ? '保留' : '不采用' }} · {{ item.detail }}</strong><span>讲述作用：{{ item.role }}</span><span>取舍理由：{{ item.reason }}</span><small v-if="sourceEvidence(item.evidenceIds)">原文依据：{{ sourceEvidence(item.evidenceIds) }}</small></li></ul></section>
                <section v-if="selectedJob.plan.background?.length" class="planning-section"><h4>必要背景</h4><ul><li v-for="item in selectedJob.plan.background" :key="item.id"><strong>{{ item.content }}</strong><span>{{ item.whyNeeded }}</span></li></ul></section>
                <section v-if="selectedJob.plan.mechanisms?.length" class="planning-section"><h4>机制链</h4><ol><li v-for="item in selectedJob.plan.mechanisms" :key="item.id"><strong>{{ item.claim }}</strong><span>{{ item.explanation }}</span><small v-if="item.conditions">条件：{{ item.conditions }}</small></li></ol></section>
                <section v-if="selectedJob.plan.evidence?.length" class="planning-section"><h4>原稿证据与素材</h4><ul><li v-for="item in selectedJob.plan.evidence" :key="item.id"><strong>“{{ item.material }}”</strong><span>{{ item.supports }}</span><small>限制：{{ item.limitation }}</small></li></ul></section>
                <section v-if="selectedJob.plan.curiosityArc?.length" class="planning-section"><h4>好奇心推进</h4><ol><li v-for="item in selectedJob.plan.curiosityArc" :key="item.id"><strong>{{ item.stage }}：{{ item.question }}</strong><span>触发：{{ item.trigger }}</span></li></ol></section>
                <section v-if="selectedJob.plan.sourceOutline?.length" class="planning-section"><h4>原稿结构</h4><ol><li v-for="item in selectedJob.plan.sourceOutline" :key="item.id">{{ item.summary }}</li></ol></section>
                <section v-if="selectedJob.plan.factsToPreserve?.length" class="planning-section"><h4>保留事实与限定</h4><ul><li v-for="(item, index) in selectedJob.plan.factsToPreserve" :key="index">{{ item }}</li></ul></section>
                <section v-if="selectedJob.plan.angles?.length" class="planning-section"><h4>候选重讲角度</h4><ul class="angle-list"><li v-for="item in selectedJob.plan.angles" :key="item.id" :class="{ selected: item.id === selectedJob.plan.selectedAngleId }"><strong>{{ item.title }}{{ item.id === selectedJob.plan.selectedAngleId ? ' · 已采用' : '' }}</strong><span>{{ item.contrast }}</span></li></ul><p v-if="selectedJob.plan.selectionReason" class="field-note">选择理由：{{ selectedJob.plan.selectionReason }}</p></section>
                <section v-if="selectedJob.plan.writingOutline" class="planning-section writing-outline"><h4>正式写作大纲</h4><p><strong>{{ selectedJob.plan.writingOutline.thesis }}</strong><span>{{ selectedJob.plan.writingOutline.stance }}</span></p><ol><li v-for="item in selectedJob.plan.writingOutline.sections" :key="item.id"><strong>{{ item.purpose }}</strong><span>{{ item.newInformation }}</span><dl v-if="item.telling" class="section-telling"><div><dt>先让人看到</dt><dd>{{ item.telling.sceneOrAction }}</dd></div><div><dt>再讲清道理</dt><dd>{{ item.telling.explanation }}</dd></div><div v-if="tellingMaterialDetails(item.telling.materialIds)"><dt>用到的材料</dt><dd>{{ tellingMaterialDetails(item.telling.materialIds) }}</dd></div><div v-if="emotionChanges(item.telling.emotionIds)"><dt>情绪怎么走</dt><dd>{{ emotionChanges(item.telling.emotionIds) }}</dd></div><div><dt>接着追问</dt><dd>{{ item.telling.nextQuestion }}</dd></div></dl></li></ol><p class="outline-ending">结尾：{{ selectedJob.plan.writingOutline.endingPayoff }}</p></section>
              </div>
            </details>
            <details class="source-details"><summary>原视频文稿 <span>{{ editor.transcript.length }} 字</span></summary><p class="field-note">可在这里校对原稿，或补充未能自动提取的字幕，再重新生成二创稿。</p><label class="sr-only" for="science-transcript">原视频文稿</label><textarea id="science-transcript" v-model="editor.transcript" :disabled="isRunning || scriptLocked || !!actionBusy" placeholder="原视频的字幕或转写文稿" /><a v-if="selectedJob.sourceVideoUrl" :href="selectedJob.sourceVideoUrl" target="_blank" rel="noreferrer"><Download :size="13" />查看已下载素材</a></details>
            <div class="editor-actions"><span class="save-state" :class="{ dirty: dirty }">{{ dirty ? '有未保存修改，切换任务后仍会保留' : '修改已保存' }}</span><button class="btn" :disabled="!dirty || isRunning || !!actionBusy" @click="saveDraft"><Save :size="14" />保存修改</button></div>
            <div class="production-actions"><div><strong>{{ statusLabel(selectedJob) }}</strong></div><template v-if="!selectedJob.videoUrl && canResumeProduction"><button class="btn" :disabled="!canProduce || !!actionBusy" @click="runAction('produce', { upload: false })"><Video :size="14" />继续自动制作</button><button class="btn btn-primary" :disabled="!canProduce || !editor.baijiahaoAccountName || !!actionBusy" @click="runAction('produce', { upload: true })"><Video :size="14" />继续制作并发表</button></template><button v-else-if="selectedJob.videoUrl" class="btn btn-primary" @click="detailTab = 'output'"><Upload :size="14" />查看成片与上传</button></div>
          </section>

          <section id="science-panel-output" v-show="detailTab === 'output'" role="tabpanel" aria-labelledby="science-tab-output" class="output-panel">
            <div class="output-media">
              <p v-if="selectedJob.videoCompositionPending" class="cover-upload-note" role="status">片头预览 · 视频合成尚未完成</p>
              <video v-if="selectedJob.videoUrl" :key="selectedJob.videoUrl" class="video-player" :src="selectedJob.videoUrl" controls playsinline preload="metadata" aria-label="科普成片预览" @error="videoError = true" @loadedmetadata="videoError = false" /><div v-else class="video-placeholder"><Video :size="30" /><strong>成片尚未生成</strong><p>{{ statusLabel(selectedJob) }}</p><button class="btn btn-sm" @click="detailTab = 'script'">返回任务</button></div><p v-if="videoError" class="inline-error" role="alert">视频暂时无法播放，请刷新任务后重试。</p><div class="file-links"><a v-if="selectedJob.videoUrl" :href="selectedJob.videoUrl" download><Download :size="14" />{{ selectedJob.videoCompositionPending ? '下载预览' : '下载成片' }}</a><button v-if="selectedJob.projectUrl" class="project-entry" type="button" :disabled="!!actionBusy || batchSyncBusy" title="在任务绑定账号打开花生项目" @click="openHuashengProject"><LoaderCircle v-if="actionBusy === 'open-project'" :size="12" class="spin" /><ExternalLink v-else :size="12" />{{ actionBusy === 'open-project' ? '正在打开…' : '查看花生项目' }}</button><a v-if="selectedJob.sourceVideoUrl" :href="selectedJob.sourceVideoUrl" target="_blank" rel="noreferrer">原始素材<ExternalLink :size="12" /></a></div>
              <section v-if="selectedJob.videoUrl || covers.some(cover => cover.url)" class="cover-panel" aria-labelledby="science-covers-title">
                <header><div><h3 id="science-covers-title">横竖封面</h3><p>成片完成后自动设计独立标题海报：主体特写，白字配黄关键词，横竖版分别构图。</p></div></header>
                <p v-if="covers.some(cover => cover.url) && selectedJob.coverStyle !== 'science-title-poster-v1'" class="cover-upload-note">当前为旧版封面，可重新生成独立标题海报。</p>
                <label class="field cover-instruction" for="science-cover-instruction"><span>封面设计指令 <small>可选 · {{ coverInstruction.length }} / 1000 字</small></span><textarea id="science-cover-instruction" v-model="coverInstruction" maxlength="1000" :disabled="isRunning || !!actionBusy || coverChangeLocked" placeholder="例如：主体放大，突出眼睛，背景深蓝；黄色强调标题里的“为什么”。" /></label>
                <div class="cover-actions"><span class="field-note">{{ coverInstructionDirty ? '指令有未保存修改，生成时会保存。' : '指令随当前任务保存，可再次修改生成。' }}</span><div class="cover-buttons"><button v-if="selectedJob.coverGenerationPending" class="btn btn-sm" type="button" :disabled="!canRegenerateCovers" @click="retryCovers"><RefreshCw :size="14" />继续生成封面</button><button class="btn btn-sm" type="button" :disabled="!canRegenerateCovers" @click="regenerateCovers"><LoaderCircle v-if="actionBusy === 'covers' || isRunning && selectedJob.stage === 'covers'" :size="14" class="spin" /><ImagePlus v-else :size="14" />{{ covers.some(cover => cover.url) ? '重新生成封面' : '生成海报封面' }}</button><button v-if="selectedJob.coverGenerationPending" class="btn btn-sm btn-ghost" type="button" :disabled="!canRegenerateCovers" @click="generateNewCovers"><ImagePlus :size="14" />生成新一版</button></div></div>
                <p v-if="coverPublished" class="cover-upload-note">作品已提交或发表，封面不能再修改。</p>
                <p v-else-if="selectedJob.upload?.saved" class="cover-upload-note">可设计新封面；已保存草稿的旧封面不会自动替换。</p>
                <p v-if="selectedJob.coverGenerationPending" class="cover-upload-note">新封面尚未完成，已有图片仍为上次生成的封面；新封面完成后才能发表。</p>
                <div class="cover-grid"><figure v-for="cover in covers" :key="cover.kind" class="cover-card"><a v-if="cover.url" class="cover-preview" :href="cover.url" target="_blank" rel="noreferrer" :title="`打开${cover.label}原图`" :aria-label="`打开${cover.label}原图`"><img :src="cover.url" :alt="cover.label" /></a><div v-else class="cover-preview cover-placeholder"><ImageIcon :size="25" /><span>{{ isRunning && selectedJob.stage === 'covers' ? '正在生成…' : '待生成' }}</span></div><figcaption><span>{{ cover.label }}<small>{{ cover.url ? selectedJob.coverGenerationPending ? '上次生成' : '已生成' : isRunning && selectedJob.stage === 'covers' ? '生成中' : '待生成' }}</small></span><a v-if="cover.url" class="btn btn-icon btn-ghost" :href="cover.url" :download="`${selectedJob.id}-${cover.kind}.jpg`" :title="`下载${cover.label}`" :aria-label="`下载${cover.label}`"><Download :size="15" /></a></figcaption></figure></div>
                <p class="cover-upload-note">这里显示封面生成结果；上传和发表进度见“百家号发表”。</p>
              </section>
            </div>
            <section class="upload-card" aria-labelledby="science-upload-title">
              <h3 id="science-upload-title">百家号发表</h3>
              <p>{{ accountLabel('baijiahao', selectedJob.baijiahaoAccountName) }}</p>
              <button v-if="!editor.baijiahaoAccountName" class="btn btn-sm" type="button" :disabled="isRunning || !!actionBusy || batchSyncBusy" @click="openUploadAccountPicker"><Users :size="14" />选择百家号账号</button>
              <p v-if="typeof selectedJob.autoUpload === 'boolean'" class="upload-mode">{{ selectedJob.autoUpload ? '自动发表' : '仅制作' }}</p>
              <div class="upload-status" :class="{ success: ['uploaded', 'submitted', 'published'].includes(uploadState(selectedJob)), 'inline-error': ['blocked', 'uncertain'].includes(uploadState(selectedJob)) }"><Check v-if="['uploaded', 'submitted', 'published'].includes(uploadState(selectedJob))" :size="17" /><LoaderCircle v-else-if="uploadState(selectedJob) === 'uploading'" :size="17" class="spin" /><Upload v-else :size="17" /><strong>{{ uploadStatusLabel(selectedJob) }}</strong></div>
              <p v-if="['blocked', 'uncertain'].includes(uploadState(selectedJob))" class="inline-error upload-error" role="alert">{{ selectedJob.message }}</p>
              <div v-if="selectedJob.hasUploadAttempt || selectedJob.upload || uploadState(selectedJob) === 'blocked'" class="upload-recovery-actions"><button class="btn btn-sm" :disabled="isRunning || !!actionBusy || batchSyncBusy" @click="openUploadReview('original')"><ExternalLink :size="14" />打开百家号窗口</button></div>
              <a v-if="selectedJob.upload?.publishedUrl" class="btn" :href="selectedJob.upload.publishedUrl" target="_blank" rel="noreferrer">{{ selectedJob.upload.published ? '打开已发表作品' : '打开审核中作品' }}<ExternalLink :size="13" /></a>
              <a v-if="draftUrl && !selectedJob.upload?.submitted" class="btn" :href="draftUrl" target="_blank" rel="noreferrer">打开百家号编辑页<ExternalLink :size="13" /></a>
              <button v-if="!selectedJob.upload?.submitted && !selectedJob.upload?.published" class="btn btn-primary" :disabled="selectedJob.videoCompositionPending || !selectedJob.videoUrl || !posterReady || isRunning || !!actionBusy || !editor.baijiahaoAccountName" @click="runAction('upload')"><Upload :size="14" />{{ selectedJob.stage === 'upload' ? '重试上传' : '直接发表' }}</button>
              <p v-if="!editor.baijiahaoAccountName">请在文稿页选择上传账号。</p><p v-if="selectedJob.videoCompositionPending">视频合成完成后才能生成封面和发表。</p><p v-else-if="selectedJob.videoUrl && !coverPublished && !posterReady">请先生成横竖海报封面，再发表。</p><p class="field-note">发表前尝试添加 #热爆趣创赛#；最多等 10 秒，失败则跳过话题继续发表。创作声明和水印照常设置。</p>
            </section>
          </section>

          <section id="science-panel-log" v-show="detailTab === 'log'" role="tabpanel" aria-labelledby="science-tab-log" class="log-panel"><h3>运行记录</h3><ol v-if="selectedJob.logs?.length"><li v-for="(entry, index) in selectedJob.logs" :key="index"><time>{{ formatTime(entry.at) }}</time><span>{{ entry.message }}</span></li></ol><p v-else class="field-note">任务开始后，会记录各步骤的进度。</p></section>
        </template>
      </section>
    </section>
    <footer class="page-foot"><span>每条任务独立保存账号、文稿、花生项目和上传结果。</span><span>{{ loading ? '正在刷新列表…' : `${jobs.filter(job => job.status === 'running').length} 项正在运行` }}</span></footer>

    <dialog ref="importDialog" class="import-dialog" aria-labelledby="science-import-title" @close="importError = ''">
      <header><div><h2 id="science-import-title">导入 YouTube 视频</h2></div><button class="btn btn-icon btn-ghost" aria-label="关闭导入窗口" :disabled="creating" @click="importDialog?.close()"><X :size="18" /></button></header>
      <form @submit.prevent="createJob"><div class="dialog-body"><label class="field"><span>YouTube 视频链接</span><input v-model="newJob.sourceUrl" type="url" required placeholder="https://www.youtube.com/watch?v=…" :disabled="creating" /></label><label class="field"><span>任务标题 <small>可选</small></span><input v-model="newJob.title" maxlength="60" placeholder="留空时使用视频标题" :disabled="creating" /></label><label class="field"><span>花生账号</span><select v-model="newJob.huashengAccountName" aria-label="花生账号" required :disabled="creating"><option value="">请选择花生账号</option><option v-for="account in accounts.huasheng.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.isDefault ? '（默认）' : '' }}</option></select></label><label class="field"><span>百家号账号 <small>可选</small></span><select v-model="newJob.baijiahaoAccountName" aria-label="百家号账号" :disabled="creating"><option value="">仅制作，不发表</option><option v-for="account in accounts.baijiahao.accounts" :key="account.accountName" :value="account.accountName">{{ account.label }}{{ account.isDefault ? '（默认）' : '' }}</option></select></label><p v-if="importError" class="inline-error" role="alert">{{ importError }}</p></div><footer><button class="btn btn-ghost" type="button" :disabled="creating" @click="importDialog?.close()">取消</button><button class="btn btn-primary" type="submit" :disabled="creating || !newJob.sourceUrl.trim() || !newJob.huashengAccountName"><LoaderCircle v-if="creating" :size="14" class="spin" /><Video v-else :size="14" />{{ creating ? '正在启动…' : newJob.baijiahaoAccountName ? '开始制作并发表' : '开始自动制作' }}</button></footer></form>
    </dialog>
    <ScienceAccounts v-if="accountDialog === 'huasheng'" @close="accountDialog = null" @updated="updateAccounts('huasheng', $event)" />
    <BaijiahaoAccounts v-if="accountDialog === 'baijiahao'" api-base="/science-pop/workflow/accounts/baijiahao" @close="accountDialog = null" @updated="updateAccounts('baijiahao', $event)" />
    <ScienceUploadReview v-if="reviewJob" :key="reviewJob.id" :job="reviewJob" :initial-view="reviewView" @close="reviewJob = null" @check="checkReviewedUpload" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ArrowLeft, Check, CircleAlert, Copy, Download, ExternalLink, FlaskConical, Image as ImageIcon, ImagePlus, Inbox, LoaderCircle, Plus, RefreshCw, Save, Search, Square, Trash2, Upload, Users, Video, X, Youtube } from 'lucide-vue-next'
import { api } from '~/composables/useApi'
import ScienceAccounts from '~/components/ScienceAccounts.vue'
import BaijiahaoAccounts from '~/components/BaijiahaoAccounts.vue'
import ScienceCollection from '~/components/ScienceCollection.vue'
import ScienceUploadReview from '~/components/ScienceUploadReview.vue'

definePageMeta({ layout: 'default' })
const BASE = '/science-pop/workflow'
const jobs = ref([])
const accounts = reactive({ huasheng: { accounts: [], defaultAccountName: null }, baijiahao: { accounts: [], defaultAccountName: null } })
const selectedId = ref('')
const selectedJob = ref(null)
const copyState = ref('')
const drafts = reactive({})
const coverDrafts = reactive({})
const recoveryDrafts = reactive({})
const search = ref('')
const queueFilter = ref('all')
const loading = ref(false)
const detailLoading = ref(false)
const pageError = ref('')
const detailError = ref('')
const actionError = ref('')
const actionNotice = ref('')
const actionBusy = ref('')
const batchSyncBusy = ref(false)
const batchSyncMessage = ref('')
const batchSyncError = ref('')
const detailTab = ref('script')
const mobileDetail = ref(false)
const accountDialog = ref(null)
const projectRecovery = ref(null)
const reviewJob = ref(null)
const reviewView = ref('original')
const collection = ref(null)
const collectionContext = reactive({ runs: [], loaded: false, error: '' })
const importDialog = ref(null)
const creating = ref(false)
const importError = ref('')
const videoError = ref(false)
const newJob = reactive({ sourceUrl: '', title: '', huashengAccountName: '', baijiahaoAccountName: '' })
const blankEditor = { title: '', transcript: '', script: '', huashengAccountName: '', baijiahaoAccountName: '' }
const editor = computed(() => drafts[selectedId.value]?.value || blankEditor)
const dirty = computed(() => isDraftDirty(selectedId.value))
const isRunning = computed(() => taskExecuting(selectedJob.value))
const canDeleteTask = computed(() => !!selectedJob.value && !['queued', 'running', 'waiting_remote', 'awaiting_export', 'retry_wait'].includes(selectedJob.value.status))
const canResumeProduction = computed(() => !isQueuedCollectionJob(selectedJob.value) && (['paused', 'needs_attention'].includes(selectedJob.value?.status)
  || selectedJob.value?.status === 'queued' && selectedJob.value.executionActive === false))
const scriptLocked = computed(() => !!(selectedJob.value?.checkpoint || selectedJob.value?.projectUrl || selectedJob.value?.videoUrl))
const recovery = computed(() => recoveryDrafts[selectedId.value] || { projectUrl: '', taskId: '', projectHash: '' })
const canRecoverProject = computed(() => selectedJob.value?.checkpoint === 'create_pending' && !selectedJob.value?.projectUrl)
const canRecoverExport = computed(() => selectedJob.value?.stage === 'export' && !selectedJob.value?.videoUrl)
const canRecover = computed(() => {
  const project = canRecoverProject.value && recovery.value.projectUrl.trim()
  const task = canRecoverExport.value && recovery.value.taskId.trim()
  const hash = canRecoverExport.value && recovery.value.projectHash.trim()
  return !!(project || task && hash) && (!!task === !!hash)
})
const uploadLocked = computed(() => !!(selectedJob.value?.hasUploadAttempt || selectedJob.value?.upload))
const canProduce = computed(() => canResumeProduction.value && editor.value.script.length <= 10000 && !!editor.value.huashengAccountName && !isRunning.value)
const draftUrl = computed(() => selectedJob.value?.upload?.saved ? selectedJob.value.upload.draftUrl || selectedJob.value.upload.editorUrl : null)
const coverInstruction = computed({
  get: () => coverDrafts[selectedId.value]?.value || '',
  set: value => { if (selectedId.value) coverDrafts[selectedId.value] = { saved: selectedJob.value?.coverInstruction || '', ...coverDrafts[selectedId.value], value } },
})
const coverInstructionDirty = computed(() => isCoverInstructionDirty(selectedId.value))
const coverPublished = computed(() => !!(selectedJob.value?.upload?.submitted || selectedJob.value?.upload?.published))
const coverChangeLocked = computed(() => coverPublished.value)
const canRegenerateCovers = computed(() => !!selectedJob.value?.videoUrl && !isRunning.value && !actionBusy.value && !batchSyncBusy.value
  && !selectedJob.value?.videoCompositionPending && !coverChangeLocked.value && coverInstruction.value.length <= 1000)
const covers = computed(() => [
  { kind: 'landscape', label: '横版封面', url: coverAssetUrl(selectedJob.value?.landscapeCoverUrl) },
  { kind: 'portrait', label: '竖版封面', url: coverAssetUrl(selectedJob.value?.portraitCoverUrl) },
])
const posterReady = computed(() => !selectedJob.value?.videoCompositionPending && selectedJob.value?.coverStyle === 'science-title-poster-v1' && covers.value.every(cover => cover.url) && !selectedJob.value?.coverGenerationPending)
const planNeedsStoryDetails = computed(() => {
  const plan = selectedJob.value?.plan
  return !!plan && (!plan.sourceTheme || !Array.isArray(plan.emotionalArc) || !Array.isArray(plan.tellingMaterials)
    || !plan.writingOutline?.sections?.length || plan.writingOutline.sections.some(section => !section.telling))
})
const selectedRecovery = computed(() => recoveryFor(selectedJob.value))
const recoveryErrorSummary = computed(() => {
  const observation = currentHuashengObservation(selectedJob.value)
  return observation && observation.status !== 'error' ? '历史错误记录' : '错误详情'
})
const visibleHuashengSync = computed(() => {
  const job = selectedJob.value, sync = job?.huashengSync
  return sync && (!job.huashengCheck || Date.parse(sync.checkedAt) > Date.parse(job.huashengCheck.checkedAt)) ? sync : null
})
const queueFilters = computed(() => [
  { id: 'all', label: '全部', count: jobs.value.length },
  { id: 'attention', label: '待处理', count: jobs.value.filter(job => matchesQueueFilter(job, 'attention')).length },
  { id: 'active', label: '进行中', count: jobs.value.filter(job => matchesQueueFilter(job, 'active')).length },
  { id: 'done', label: '已交付', count: jobs.value.filter(job => matchesQueueFilter(job, 'done')).length },
])
const filteredJobs = computed(() => {
  const filtered = jobs.value.filter(job => matchesQueueFilter(job, queueFilter.value)
    && `${job.id} ${job.title || ''} ${job.sourceUrl}`.toLowerCase().includes(search.value.trim().toLowerCase()))
  return queueFilter.value === 'attention'
    ? filtered.sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
    : filtered
})
const syncableJobs = computed(() => jobs.value.filter(job => job.projectUrl && !job.videoUrl && !job.hasUploadAttempt && !job.upload && job.stage !== 'upload'
  && !taskExecuting(job) && ['needs_attention', 'paused', 'waiting_remote', 'awaiting_export', 'retry_wait'].includes(job.status)))
const tabs = [{ id: 'script', label: '文稿与账号' }, { id: 'output', label: '成片与上传' }, { id: 'log', label: '运行记录' }]
const steps = [{ id: 'download', label: '素材与原稿' }, { id: 'rewrite', label: '二创文稿' }, { id: 'produce', label: '花生制作' }, { id: 'export', label: '导出成片' }, { id: 'covers', label: '横竖封面' }, { id: 'upload', label: '百家号发表' }]
let pollTimer
let disposed = false
let detailSequence = 0
let copySequence = 0
let mutationVersion = 0

function editable(job) { return { title: job.title || '', transcript: job.transcript || '', script: job.script || '', huashengAccountName: job.huashengAccountName || '', baijiahaoAccountName: job.baijiahaoAccountName || '' } }
function isDraftDirty(id) { const draft = drafts[id]; return !!draft && JSON.stringify(draft.value) !== draft.saved }
function sourceEvidence(ids) { return (selectedJob.value?.plan?.evidence || []).filter(item => ids?.includes(item.id)).map(item => item.material).join('；') }
function tellingMaterialDetails(ids) { return (selectedJob.value?.plan?.tellingMaterials || []).filter(item => ids?.includes(item.id)).map(item => item.detail).join('；') }
function emotionChanges(ids) { return (selectedJob.value?.plan?.emotionalArc || []).filter(item => ids?.includes(item.id)).map(item => `${item.from} → ${item.to}`).join('；') }
function isCoverInstructionDirty(id) { const draft = coverDrafts[id]; return !!draft && draft.value !== draft.saved }
function coverAssetUrl(url) {
  const revision = selectedJob.value?.coverRevision
  return url && Number.isSafeInteger(revision) && revision > 0 && /^(?:\/|https?:\/\/)/.test(url)
    ? `${url}${url.includes('?') ? '&' : '?'}revision=${revision}` : url || null
}
function acceptJob(job, force = false) {
  recoveryDrafts[job.id] ||= { projectUrl: '', taskId: '', projectHash: '' }
  const instruction = job.coverInstruction || ''
  if (!isCoverInstructionDirty(job.id) || coverDrafts[job.id].value === instruction) coverDrafts[job.id] = { value: instruction, saved: instruction }
  const value = editable(job)
  if (force || !isDraftDirty(job.id)) drafts[job.id] = { value, saved: JSON.stringify(value) }
  const index = jobs.value.findIndex(item => item.id === job.id)
  if (index === -1) jobs.value.unshift(job)
  else jobs.value[index] = job
  if (selectedId.value === job.id) selectedJob.value = job
}
function updateAccounts(platform, value) { accounts[platform] = value }
function accountLabel(platform, name) { return accounts[platform].accounts.find(item => item.accountName === name)?.label || (name ? '已绑定账号' : '尚未选择上传账号') }
function updateCollectionContext(context) {
  collectionContext.runs = context.runs || []
  collectionContext.loaded = context.loaded === true
  collectionContext.error = context.error || ''
}
function isQueuedCollectionJob(job) { return !!job?.collectionId && job.status === 'queued' && job.executionActive === false && job.stage !== 'upload' && !job.videoUrl }
function queuedCollectionRecovery(job) {
  if (!isQueuedCollectionJob(job)) return null
  const run = collectionContext.runs.find(run => run.id === job.collectionId)
  let title, description
  const saved = job.projectUrl ? '原项目和制作记录已保留。' : '文稿已保存，尚未提交花生。'
  if (collectionContext.error) {
    title = '所属批次暂时无法读取'
    description = `${saved} ${collectionContext.error}，请重新读取所属批次后继续。`
  } else if (!run) {
    title = collectionContext.loaded ? '未找到所属批次记录' : '正在读取所属批次'
    description = `${saved} ${collectionContext.loaded ? '请核对原批次记录，再沿用原账号和产出方式继续。' : '正在核对原批次的调度状态。'}`
  } else {
    title = ({ running: '等待批次调度', stopping: '所属批次正在停止', needs_attention: '所属批次异常暂停',
      stopped: '所属批次已停止', interrupted: '所属批次执行中断', completed: '所属批次已结束' })[run.status] || '所属批次需要核对'
    description = `${saved} 原批次为“${run.mode === 'upload' ? '制作并直接发表' : '自动制作视频'}”，继续时沿用原账号和产出方式。${run.message ? ` 批次记录：${run.message}` : ''}`
  }
  const quotaBlocker = !job.projectUrl && job.huashengAccountName && jobs.value.find(item => item.id !== job.id
    && item.huashengAccountName === job.huashengAccountName && item.checkpoint === 'quota_waiting'
    && item.stage === 'produce' && !item.videoUrl && ['needs_attention', 'paused'].includes(item.status))
  const canRetryTask = !!run && !['running', 'stopping'].includes(run.status)
  return { account: 'huasheng', title, description, actions: [...(canRetryTask ? [{ id: 'retry-task', label: '重启本任务' }] : []), { id: 'collection', label: '查看所属批次' },
    ...(quotaBlocker ? [{ id: 'quota-task', label: '查看额度受限任务' }] : [])],
    ...(quotaBlocker ? { quotaBlocker: { id: quotaBlocker.id, title: quotaBlocker.title || quotaBlocker.id } } : {}) }
}
function taskExecuting(job) { return job?.executionActive === true || job?.status === 'running' || job?.status === 'queued' && job.executionActive !== false }
function currentHuashengObservation(job) {
  if (!job) return null
  const check = job.huashengCheck, sync = job.huashengSync
  const observation = sync && (!check || Date.parse(sync.checkedAt) > Date.parse(check.checkedAt)) ? sync : check
  const latestLog = job.logs?.at(-1)?.at
  return observation && (!latestLog || Date.parse(observation.checkedAt) >= Date.parse(latestLog)
    || observation === sync && /^花生状态同步/.test(job.message || '')) ? observation : null
}
function matchesQueueFilter(job, filter) {
  const awaitingBatch = isQueuedCollectionJob(job) && !collectionContext.error
    && ['running', 'stopping'].includes(collectionContext.runs.find(run => run.id === job.collectionId)?.status)
  if (filter === 'attention') return !awaitingBatch && job.status !== 'retry_wait' && !uploadRetryPending(job) && !!recoveryFor(job)
  if (filter === 'active') return awaitingBatch || taskExecuting(job) || uploadRetryPending(job) || ['waiting_remote', 'awaiting_export', 'retry_wait'].includes(job.status)
  if (filter === 'done') return job.status === 'completed' || ['uploaded', 'submitted', 'published'].includes(uploadState(job))
  return true
}
function recoveryFor(job) {
  if (!job || taskExecuting(job) || ['uploaded', 'submitted', 'published'].includes(uploadState(job))) return null
  const action = (id, label) => ({ id, label })
  if (job.status === 'retry_wait' && job.stage === 'upload') return {
    account: 'baijiahao', title: '已安排重新上传', description: '视频和封面已保留，将重新上传，取得提交回执后自动停止。',
    actions: [action('upload', '立即重新上传'), action('cancel', '停止自动重传')],
  }
  if (job.status === 'retry_wait') return {
    account: 'huasheng', title: '已安排自动恢复',
    description: job.projectUrl ? '原项目和导出记录已保留，等待下一次自动恢复。' : '文稿和账号已保留，等待下一次自动重试制作。',
    actions: [action(job.projectUrl ? 'sync' : 'produce', job.projectUrl ? '立即恢复原任务' : '立即重试制作'), action('cancel', '停止自动恢复'),
      ...(job.projectUrl ? [action('check-huasheng', '只查询制作进度')] : [])],
  }
  const collectionRecovery = queuedCollectionRecovery(job)
  if (collectionRecovery) return collectionRecovery
  if (job.status === 'queued' && job.executionActive === false) return {
    title: '尚未开始本机制作', description: '文稿已保存，目前没有执行中的制作操作。',
    actions: [action('produce', job.autoUpload ? '开始制作并发表' : '开始制作')],
  }
  if (!['needs_attention', 'paused', 'draft'].includes(job.status)) return null
  const message = job.message || ''
  if (job.videoCompositionPending) return {
    title: '视频合成尚未完成', description: message || '片头预览已保存，完成视频合成后才能发表。',
    actions: [action('produce', '继续合成视频'), action('log', '查看运行记录')],
  }
  if (job.videoUrl && (job.stage === 'covers' || !job.hasUploadAttempt && (job.coverStyle !== 'science-title-poster-v1' || job.coverGenerationPending || !job.landscapeCoverUrl || !job.portraitCoverUrl))) {
    const unknown = /已提交但未取得|未取得任务编号|结果不明确/.test(message)
    return { title: unknown ? '封面请求结果待确认' : job.status === 'paused' ? '封面生成已暂停' : '横竖封面尚未完成',
      description: unknown ? '图片服务没有返回任务编号，原生成记录已保留。可以发起新一版封面生成。'
        : /502|503|504|超时|timeout|Upstream/i.test(message) ? '图片服务暂时不可用，视频已经保存。可以重试封面生成。' : '视频已经保存，完成横版和竖版封面后即可发表。',
      actions: unknown ? [action('cover-new', '生成新一版封面'), action('cover-edit', '修改封面要求')]
        : [action('cover-retry', job.status === 'paused' ? '继续生成封面' : '重试封面生成'), action('cover-edit', '修改封面要求')],
    }
  }
  if (job.stage === 'upload' || ['uncertain', 'blocked'].includes(uploadState(job))) {
    const verification = /安全验证|验证码|验证身份|verification|captcha/i.test(message)
    const login = /登录|登陆|扫码|login|authentication/i.test(message)
    return { account: 'baijiahao', title: verification ? '百家号需要安全验证' : login ? '百家号账号需要登录'
      : uploadRetryPending(job) ? '已安排重新上传' : job.status === 'paused' ? '上传已暂停' : '百家号上传中断',
      description: verification ? '打开当前任务的百家号窗口完成验证，完成后再继续发表。'
        : login ? '请登录任务绑定的百家号账号，完成后重新上传。'
        : '视频和封面已保留，可以重新上传；取得提交回执后自动停止。',
      actions: verification ? [action('open-original', '打开验证窗口'), action('upload', '验证完成，继续上传')]
        : login ? [action('account', '登录百家号账号'), action('open-original', '打开账号窗口'), action('upload', '登录完成，重试上传')]
        : [action('upload', job.status === 'paused' ? '继续上传' : '重新上传视频'), action('open-original', '打开百家号窗口')],
    }
  }
  if (job.checkpoint === 'quota_waiting' && job.stage === 'produce' && !job.videoUrl) return {
    account: 'huasheng', title: '花生标准模式每日额度已用完',
    description: '当前项目尚未进入制作。额度恢复后从原项目继续，仍沿用标准模式。',
    actions: [...(job.projectUrl ? [action('project', '查看花生项目')] : []),
      job.collectionId ? action('collection', '查看所属批次') : action('produce', '继续原制作任务')],
  }
  const currentCheck = currentHuashengObservation(job)
  if (currentCheck?.status === 'error') return { account: 'huasheng', title: '花生状态暂时无法查询',
    description: currentCheck.error || currentCheck.message || '原项目和检查点已保留，可以重新查询花生进度。',
    actions: [action('check-huasheng', '重新查询制作进度'), action('account', '检查花生账号'), action('project', '查看花生项目')],
  }
  if (currentCheck?.status === 'completed') return { title: '花生制作已完成', description: '原项目已经完成制作，可以继续导出和下载。', actions: [action('sync', '继续导出下载'), action('project', '查看花生项目')] }
  if (['queued', 'creating'].includes(currentCheck?.status)) return { title: currentCheck.status === 'queued' ? '花生已接收，正在排队' : '花生正在制作', description: currentCheck.message, actions: [action('check-huasheng', '再次查询制作进度'), action('sync', '继续等待与导出'), action('project', '查看花生项目')] }
  if (/核验.*身份|身份.*核验|专用浏览器|登录|登录用户|账号.*不一致/.test(message)) return {
    title: /核验|身份/.test(message) ? '花生账号身份暂未确认' : '花生账号需要检查',
    description: job.checkpoint === 'submitted' ? '制作请求已经提交。账号检查失败不代表花生停止制作，可以重新查询原项目。' : '请检查任务绑定的花生账号，再继续原项目。',
    actions: [action('account', '检查花生账号'), ...(job.projectUrl ? [action('check-huasheng', '只查询制作进度'), action('project', '查看花生项目')] : [])],
  }
  if (job.checkpoint === 'create_pending' && !job.projectUrl) return {
    title: '花生项目链接尚未确认', description: '花生可能已创建项目。请在“我的项目”中找到对应项目，再绑定原项目链接。',
    actions: [action('account', '打开花生账号'), action('recover-project', '填写原项目链接')],
  }
  if (job.projectUrl && job.stage === 'produce') return {
    title: job.checkpoint === 'submitted' ? '等待核对花生制作进度' : '花生制作方案待确认',
    description: job.checkpoint === 'submitted' ? '原制作请求已经提交，可以先查询进度，再继续导出流程。' : '打开原花生项目完成方案或点数确认，再继续当前任务。',
    actions: job.checkpoint === 'submitted' ? [action('check-huasheng', '只查询制作进度'), action('sync', '继续制作与导出'), action('project', '查看花生项目')]
      : [action('project', '打开花生项目'), action('produce', '继续原制作任务')],
  }
  if (job.projectUrl && job.stage === 'export') return { title: '成片导出需要继续', description: '原花生项目和导出记录已保留，可以继续查询并下载成片。', actions: [action('sync', '继续原导出任务'), action('recover-project', '填写原导出信息')] }
  return { title: job.status === 'paused' ? '任务已暂停' : job.status === 'draft' ? '任务尚未开始' : '制作流程已中断', description: '已完成的材料会继续保留，可以从中断步骤继续。', actions: [action('produce', '继续原制作任务'), action('log', '查看运行记录')] }
}
function recoveryActionName(action) { return ({ 'cover-retry': 'covers', 'cover-new': 'covers', project: 'open-project', produce: 'produce', upload: 'upload', 'check-upload': 'check-upload', 'check-huasheng': 'check-huasheng', sync: 'sync', 'retry-task': 'retry-task' })[action] || action }
async function runRecoveryAction(action) {
  if (actionBusy.value || batchSyncBusy.value || isRunning.value) return
  if (action === 'collection') {
    const id = selectedJob.value?.collectionId
    if (!id) return
    const jobId = selectedJob.value.id
    actionBusy.value = 'collection'; actionError.value = ''; actionNotice.value = ''
    try {
      const found = await collection.value?.revealRun(id)
      if (!disposed && selectedId.value === jobId && !found) actionError.value = '暂时无法定位所属批次，请在频道采集区重新读取批次记录。'
    } catch (error) { if (!disposed && selectedId.value === jobId) actionError.value = error.message || '所属批次暂时无法打开，请重试' }
    finally { actionBusy.value = '' }
    return
  }
  if (action === 'quota-task') {
    const id = selectedRecovery.value?.quotaBlocker?.id
    if (id) await selectJob(id)
    return
  }
  if (action === 'cover-retry') return retryCovers()
  if (action === 'cover-new') return generateNewCovers()
  if (action === 'cover-edit') { detailTab.value = 'output'; await nextTick(); document.getElementById('science-cover-instruction')?.focus(); return }
  if (action === 'retry-task') {
    const job = selectedJob.value
    if (!job?.collectionId) return
    const id = job.id
    actionBusy.value = 'retry-task'; actionError.value = ''; actionNotice.value = ''; mutationVersion++; detailSequence++; detailLoading.value = false
    try {
      const run = await collection.value?.retryJobs(job.collectionId, [id])
      if (!run) throw new Error('批次重试未启动，请打开所属批次核对')
      if (!disposed && selectedId.value === id) {
        actionNotice.value = '已重启本任务，沿用原批次账号和产出方式。'
        await loadDetail(id)
      }
    } catch (error) { if (!disposed && selectedId.value === id) actionError.value = error.message || '任务重启未确认，请打开所属批次核对' }
    finally { actionBusy.value = '' }
    return
  }
  if (action === 'account') { accountDialog.value = selectedRecovery.value?.account || 'huasheng'; return }
  if (action === 'open-original' || action === 'open-content') return openUploadReview(action === 'open-content' ? 'content' : 'original')
  if (action === 'project') return openHuashengProject()
  if (action === 'recover-project') { if (projectRecovery.value) { projectRecovery.value.open = true; await nextTick(); projectRecovery.value.querySelector('input')?.focus() } return }
  if (action === 'log') { detailTab.value = 'log'; return }
  return runAction(action, action === 'produce' ? { upload: selectedJob.value.autoUpload === true } : {})
}
async function openHuashengProject() {
  if (!selectedJob.value?.projectUrl || actionBusy.value || batchSyncBusy.value) return
  const id = selectedJob.value.id
  actionBusy.value = 'open-project'; actionError.value = ''; actionNotice.value = ''
  try {
    const result = await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/open-project`, {})
    if (!disposed && selectedId.value === id) actionNotice.value = result.message || '已在任务绑定的花生账号打开项目'
  } catch (error) { if (!disposed && selectedId.value === id) actionError.value = error.message || '原账号的花生项目暂时无法打开，请重试' }
  finally { actionBusy.value = '' }
}
function openUploadReview(view = 'original') {
  if (!selectedJob.value || isRunning.value || actionBusy.value || batchSyncBusy.value) return
  reviewView.value = view
  reviewJob.value = { id: selectedJob.value.id, title: selectedJob.value.title, accountLabel: accountLabel('baijiahao', selectedJob.value.baijiahaoAccountName) }
}
async function checkReviewedUpload() {
  const id = reviewJob.value?.id
  reviewJob.value = null
  if (id && id === selectedId.value) await runAction('check-upload')
}
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
async function openUploadAccountPicker() {
  detailTab.value = 'script'
  await nextTick()
  document.querySelector('select[aria-label="百家号上传账号"]')?.focus()
}
function uploadState(job) {
  if (job.upload?.published) return 'published'
  if (job.upload?.submitted) return 'submitted'
  if (job.uploadStatus === 'uncertain') return job.status === 'paused' ? 'paused'
    : /安全验证|验证码|验证身份|captcha|verification|请.*登录|登录.*失效|扫码/i.test(job.message || '') ? 'blocked' : 'queued'
  if (job.uploadStatus) return job.uploadStatus
  if (job.stage === 'upload' && ['queued', 'running'].includes(job.status)) return job.status === 'queued' ? 'queued' : 'uploading'
  if (job.upload?.saved) return 'uploaded'
  if (job.stage === 'upload' && job.status === 'needs_attention') return /尚未确认|待核对|检查点无法|文案已变化/.test(job.message || '') ? 'queued' : 'blocked'
  if (job.videoUrl && job.status === 'paused') return 'paused'
  return job.videoUrl ? 'pending' : 'not_ready'
}
function uploadRetryPending(job) { return job.stage === 'upload' && !taskExecuting(job) && uploadState(job) === 'queued' }
function uploadStatusLabel(job) {
  if (uploadRetryPending(job)) return '等待自动重传'
  return ({ pending: '待上传', queued: '上传排队', uploading: '上传中', uploaded: '已上传（草稿）', submitted: '已上传·待审核', published: '已发表', blocked: '上传异常', paused: '上传已暂停', not_ready: '等待成片与封面' })[uploadState(job)] || '待上传'
}
function statusLabel(job) {
  if (job.videoCompositionPending) return taskExecuting(job) ? '合成视频' : '视频待合成'
  if (uploadRetryPending(job)) return '等待自动重传'
  if (job.status === 'retry_wait') return '等待自动恢复'
  if (job.automaticRetry) return '等待自动重试'
  const collectionRecovery = queuedCollectionRecovery(job)
  if (collectionRecovery) return collectionRecovery.title
  if (job.status === 'running' && /只读核对百家号|只读核对.*上传/.test(job.message || '')) return '核对上传结果'
  if (job.status === 'queued' && job.executionActive === false) return '待开始制作'
  if (job.status === 'running' && /同步花生/.test(job.message || '')) return '同步花生状态'
  if (job.status === 'running' && job.stage !== 'upload') return ({ download: '下载素材', transcribe: '提取原稿', rewrite: '生成二创', produce: '花生制作', export: '导出成片', covers: '生成封面' })[job.stage] || '处理中'
  if (job.videoUrl && job.stage === 'covers' && ['needs_attention', 'paused'].includes(job.status)) return job.status === 'paused' ? '封面已暂停' : '封面异常'
  const upload = uploadState(job)
  if (job.stage === 'upload' || ['uploaded', 'submitted', 'published'].includes(upload) || job.videoUrl && job.status === 'ready') return upload === 'not_ready' ? '待生成封面' : uploadStatusLabel(job)
  if (job.status === 'waiting_remote' && job.stage === 'produce' && ['not_started', 'queued'].includes(job.huashengSync?.status)) return '等待花生制作'
  return ({ draft: '待处理', queued: '排队制作', paused: '已暂停', needs_attention: '需要处理', waiting_remote: job.stage === 'export' ? '花生导出中' : '花生制作中', awaiting_export: '排队导出', ready: '待上传', completed: '已完成' })[job.status] || '待处理'
}
function stepState(index) {
  const stage = selectedJob.value?.stage
  const current = ({ download: 0, transcribe: 0, rewrite: 1, produce: 2, export: 3, covers: 4, upload: 5, completed: 6 })[stage] ?? 0
  return index < current ? 'done' : index === current ? selectedJob.value?.status === 'needs_attention' ? 'attention' : 'active' : ''
}
async function loadDetail(id) {
  if (!id || disposed) return
  const sequence = ++detailSequence
  const version = mutationVersion
  detailLoading.value = true
  try {
    const job = await api.get(`${BASE}/jobs/${encodeURIComponent(id)}`)
    if (disposed || sequence !== detailSequence || selectedId.value !== id || version !== mutationVersion) return
    acceptJob(job); detailError.value = ''
  } catch (err) { if (!disposed && sequence === detailSequence && selectedId.value === id) detailError.value = err.message || '读取详情失败' }
  finally { if (sequence === detailSequence) detailLoading.value = false }
}
async function selectJob(id) {
  copyState.value = ''; copySequence++
  selectedId.value = id; selectedJob.value = jobs.value.find(job => job.id === id) || null
  if (selectedJob.value) acceptJob(selectedJob.value)
  actionError.value = ''; actionNotice.value = ''; detailError.value = ''; videoError.value = false; mobileDetail.value = true
  await loadDetail(id)
}
async function copyJobId() {
  const id = selectedJob.value?.id
  if (!id || copyState.value === 'copying') return
  const sequence = ++copySequence
  copyState.value = 'copying'
  try {
    await navigator.clipboard.writeText(id)
    if (!disposed && sequence === copySequence && selectedId.value === id) copyState.value = 'success'
  } catch {
    if (!disposed && sequence === copySequence && selectedId.value === id) copyState.value = 'error'
  }
}
async function refresh() {
  if (loading.value || disposed) return
  loading.value = true
  const version = mutationVersion
  try {
    const result = await api.get(BASE)
    if (disposed || version !== mutationVersion) return
    jobs.value = result.jobs || []
    if (result.accounts) { updateAccounts('huasheng', result.accounts.huasheng); updateAccounts('baijiahao', result.accounts.baijiahao) }
    pageError.value = ''
    if (!selectedId.value && jobs.value.length) { await selectJob(jobs.value[0].id); mobileDetail.value = false }
    else if (selectedId.value) await loadDetail(selectedId.value)
  } catch (err) { if (!disposed) pageError.value = err.message || '任务读取失败，请重试' }
  finally { loading.value = false }
}
function payloadForDraft(job) {
  const value = drafts[job.id]?.value || editable(job)
  const payload = {}
  for (const key of Object.keys(value)) if (value[key] !== editable(job)[key]) payload[key] = key.endsWith('AccountName') ? value[key] || null : value[key]
  return payload
}
async function persistDraft(id) {
  if (!isDraftDirty(id)) return jobs.value.find(job => job.id === id)
  const current = jobs.value.find(job => job.id === id)
  const job = await api.patch(`${BASE}/jobs/${encodeURIComponent(id)}`, payloadForDraft(current))
  if (!disposed) acceptJob(job, true)
  return job
}
async function saveDraft() {
  if (actionBusy.value || batchSyncBusy.value || isRunning.value || !selectedJob.value || !dirty.value) return
  const id = selectedId.value
  actionBusy.value = 'save'; actionError.value = ''; mutationVersion++; detailSequence++; detailLoading.value = false
  try { await persistDraft(id) }
  catch (err) { if (!disposed && selectedId.value === id) actionError.value = err.message || '保存失败，修改仍保留在此页' }
  finally { actionBusy.value = '' }
}
async function runAction(action, payload = {}) {
  if (actionBusy.value || batchSyncBusy.value || !selectedJob.value || isRunning.value && !['cancel', 'check-huasheng'].includes(action)) return
  if (action === 'produce' && isQueuedCollectionJob(selectedJob.value)) { actionError.value = '该任务由所属批次调度，请查看所属批次并沿用原生产设置继续。'; return }
  if (action === 'sync' && !selectedJob.value.projectUrl) return
  const id = selectedId.value
  actionBusy.value = action; actionError.value = ''; actionNotice.value = ''; mutationVersion++; detailSequence++; detailLoading.value = false
  try {
    if (!['cancel', 'covers', 'sync', 'check-upload', 'check-huasheng'].includes(action)) await persistDraft(id)
    const job = await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/${action}`, payload)
    if (disposed) return
    mutationVersion++; detailSequence++; detailLoading.value = false
    acceptJob(job)
    if (selectedId.value === id && action === 'recover') actionNotice.value = job.message || '原项目信息已保存'
    if (selectedId.value === id && action === 'sync') {
      if (taskExecuting(job)) actionNotice.value = '接续请求已受理，后台将自动按原设置继续，进度会自动更新。'
      else if (job.automaticRetry) actionNotice.value = '接续请求已受理，已安排自动重试。'
      else if (job.status === 'needs_attention') actionError.value = job.message || '接续遇到问题，请检查任务提示'
      else actionNotice.value = job.message || '花生状态已更新'
    }
    if (selectedId.value === id && action === 'upload') detailTab.value = 'output'
  } catch (err) { if (!disposed && selectedId.value === id) actionError.value = err.message || '操作未完成，请重试' }
  finally { actionBusy.value = '' }
}
async function deleteTask() {
  if (!canDeleteTask.value || actionBusy.value || batchSyncBusy.value || disposed) return
  const id = selectedJob.value.id, title = selectedJob.value.title || '未命名科普任务'
  const unsaved = isDraftDirty(id) || isCoverInstructionDirty(id) ? '\n未保存的本地修改将丢弃。' : ''
  if (!window.confirm(`删除任务“${title}”？\n\n任务将从列表和后续批次中移除，本地素材、成片和平台发布记录保留。后续采集会跳过这个视频。${unsaved}`)) return
  actionBusy.value = 'delete'; actionError.value = ''; mutationVersion++; detailSequence++; detailLoading.value = false
  try {
    const result = await api.del(`${BASE}/jobs/${encodeURIComponent(id)}`)
    if (disposed) return
    if (result.deleted !== true || result.id !== id) throw new Error('删除结果未确认，请刷新列表核对后重试')
    mutationVersion++; detailSequence++; detailLoading.value = false
    const index = jobs.value.findIndex(job => job.id === id)
    jobs.value = jobs.value.filter(job => job.id !== id)
    delete drafts[id]; delete coverDrafts[id]; delete recoveryDrafts[id]
    if (selectedId.value === id) {
      selectedId.value = ''; selectedJob.value = null; copyState.value = ''; copySequence++
      detailError.value = ''; videoError.value = false
      const next = jobs.value[Math.min(Math.max(index, 0), jobs.value.length - 1)]
      if (next) await selectJob(next.id)
      else mobileDetail.value = false
    }
    await collection.value?.refresh()
  } catch (err) { if (!disposed) actionError.value = err.message || '删除任务失败，请稍后重试' }
  finally { actionBusy.value = '' }
}
async function regenerateCovers() {
  if (!canRegenerateCovers.value) return
  await runAction('covers', { regenerate: true, instruction: coverInstruction.value })
}
async function retryCovers() {
  if (!canRegenerateCovers.value) return
  await runAction('covers', coverInstructionDirty.value ? { instruction: coverInstruction.value } : {})
}
async function generateNewCovers() {
  if (!canRegenerateCovers.value) return
  if (selectedJob.value.coverGenerationPending && !window.confirm('生成新一版横竖封面？原生成请求可能已经被图片服务接受，新版本会发起新的生图请求。已有视频和封面会保留。')) return
  await runAction('covers', { newVersion: true, instruction: coverInstruction.value })
}
async function syncPendingJobs() {
  if (batchSyncBusy.value || actionBusy.value || !syncableJobs.value.length || disposed) return
  batchSyncBusy.value = true; batchSyncMessage.value = ''; batchSyncError.value = ''
  mutationVersion++; detailSequence++; detailLoading.value = false
  try {
    const result = await api.post(`${BASE}/sync`, {})
    if (disposed) return
    mutationVersion++; detailSequence++; detailLoading.value = false
    batchSyncMessage.value = `已开始同步 ${result.started.length} 条，跳过 ${result.skipped.length} 条。结果会自动更新。`
    for (const id of result.started) {
      const job = jobs.value.find(item => item.id === id)
      if (job) acceptJob({ ...job, status: 'running', message: '正在同步花生制作状态' })
    }
    await refresh()
  } catch (err) { if (!disposed) batchSyncError.value = err.message || '同步未启动，请重试' }
  finally { batchSyncBusy.value = false }
}
async function recoverJob() {
  if (!canRecover.value) return
  const payload = {}
  if (canRecoverProject.value && recovery.value.projectUrl.trim()) payload.projectUrl = recovery.value.projectUrl.trim()
  if (canRecoverExport.value && recovery.value.taskId.trim() && recovery.value.projectHash.trim()) payload.exportTask = { taskId: recovery.value.taskId.trim(), projectHash: recovery.value.projectHash.trim() }
  await runAction('recover', payload)
}
async function openImport() {
  newJob.huashengAccountName = accounts.huasheng.defaultAccountName || ''
  newJob.baijiahaoAccountName = accounts.baijiahao.defaultAccountName || ''
  importError.value = ''
  await nextTick(); importDialog.value?.showModal()
}
async function createJob() {
  if (creating.value || !newJob.sourceUrl.trim()) return
  if (!newJob.huashengAccountName) { importError.value = '请选择花生制作账号'; return }
  creating.value = true; importError.value = ''; mutationVersion++; detailSequence++; detailLoading.value = false
  try {
    const payload = { sourceUrl: newJob.sourceUrl.trim(), mode: newJob.baijiahaoAccountName ? 'upload' : 'videos' }
    if (newJob.title.trim()) payload.title = newJob.title.trim()
    payload.huashengAccountName = newJob.huashengAccountName || null
    payload.baijiahaoAccountName = newJob.baijiahaoAccountName || null
    const job = await api.post(`${BASE}/jobs`, payload)
    if (disposed) return
    acceptJob(job); importDialog.value?.close(); newJob.sourceUrl = ''; newJob.title = ''; detailTab.value = 'script'; await selectJob(job.id)
  } catch (err) { if (!disposed) importError.value = err.message || '导入失败，请检查链接后重试' }
  finally { creating.value = false }
}
function beforeUnload(event) { if (Object.keys(drafts).some(isDraftDirty) || Object.keys(coverDrafts).some(isCoverInstructionDirty)) { event.preventDefault(); event.returnValue = '' } }
onMounted(async () => { window.addEventListener('beforeunload', beforeUnload); await refresh(); if (!disposed) pollTimer = window.setInterval(refresh, 4000) })
onBeforeUnmount(() => { disposed = true; detailSequence++; if (pollTimer) window.clearInterval(pollTimer); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<style scoped>
.science-page { --science-font: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 22px 28px 12px; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 var(--science-font); overflow: auto; }
.science-page :is(h1,h2,h3,p,button,input,select,textarea) { font-family: var(--science-font); letter-spacing: 0; }
.science-page :is(button,a,input,select,textarea,summary):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.science-page h1 { font-size: 21px; font-weight: 650; line-height: 1.3; margin: 0; }.science-page h2 { font-size: 18px; font-weight: 600; margin: 0; }.science-page h3 { font-size: 14px; font-weight: 600; margin: 0; }.science-page p { margin: 0; }
.science-page .btn { border-radius: 6px; box-shadow: none; transform: none; min-height: 34px; gap: 6px; }.science-page .btn-sm { min-height: 30px; padding: 4px 10px; font-size: 12px; }.science-page .btn-icon { padding: 6px; width: 32px; min-height: 32px; }
.page-head,.head-actions,.source-strip,.queue-head,.queue-bottom,.detail-meta,.file-links,.page-foot,.script-heading,.editor-actions,.production-actions { display: flex; align-items: center; }
.page-head { justify-content: space-between; gap: 24px; margin-bottom: 18px; flex-shrink: 0; flex-wrap: wrap; }.page-head p { margin-top: 5px; color: var(--text-2); font-size: 12px; }.head-actions { gap: 8px; flex-wrap: wrap; }
.source-strip { justify-content: space-between; gap: 12px; padding: 11px 0; border-block: 1px solid var(--border); color: var(--text-2); font-size: 12px; flex-wrap: wrap; }.source-strip > span:first-child { display: flex; gap: 8px; align-items: center; color: var(--text-1); }
.workspace { display: grid; grid-template-columns: 280px minmax(0,1fr); flex: 1; min-height: 440px; overflow: hidden; border-bottom: 1px solid var(--border); }.queue-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); padding-top: 16px; }.queue-head { padding: 0 14px 12px 0; justify-content: space-between; }.queue-head h2 { font-size: 15px; }.queue-head h2 span { font-size: 12px; font-weight: 400; color: var(--text-2); margin-left: 6px; }.queue-search { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin: 0 14px 14px 0; border: 1px solid var(--border); border-radius: 6px; color: var(--text-2); }.queue-search input { min-width: 0; width: 100%; border: 0; background: transparent; outline: 0; color: var(--text-1); font: inherit; }
.queue-list { list-style: none; margin: 0; padding: 0 14px 14px 0; overflow: auto; }.queue-list li + li { margin-top: 6px; }.queue-item { width: 100%; text-align: left; padding: 13px 11px; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--text-1); cursor: pointer; font: inherit; }.queue-item:hover { background: var(--bg-1); }.queue-item.selected { background: var(--info-bg); border-color: var(--border); }.queue-item strong { display: block; line-height: 1.6; font-weight: 550; overflow-wrap: anywhere; }.queue-bottom { justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--text-2); }.draft-label { display: block; margin-top: 6px; font-size: 11px; color: var(--warning); }
.status-label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); }.status-label i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }.status-label.running,.status-label.waiting_remote,.status-label.awaiting_export { color: var(--info); }.status-label.completed,.status-label.ready { color: var(--success); }.status-label.needs_attention { color: var(--warning); }
.queue-sync { padding: 0 14px 14px 0; }.queue-sync p { margin-top: 6px; font-size: 11px; color: var(--text-2); line-height: 1.6; }.queue-sync .inline-error { color: var(--error); }.project-sync { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; margin-top: 12px; }.project-sync .btn { flex-shrink: 0; }.sync-result,.sync-note { color: var(--text-2); font-size: 12px; line-height: 1.7; }.sync-result { flex: 1; min-width: 180px; overflow-wrap: anywhere; }.sync-result .sync-error { color: var(--error); }
.queue-filters { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 2px; margin: 0 14px 14px 0; border-bottom: 1px solid var(--border); }.queue-filters button { display: flex; flex-direction: column; align-items: center; gap: 3px; min-height: 49px; padding: 5px 2px 8px; border: 0; border-bottom: 2px solid transparent; background: transparent; font: inherit; font-size: 11px; color: var(--text-2); cursor: pointer; }.queue-filters button.active { border-bottom-color: var(--info); color: var(--text-1); }.queue-filters button span { font-size: 12px; font-variant-numeric: tabular-nums; }.queue-reason { display: block; margin-top: 7px; color: var(--warning); font-size: 11px; overflow-wrap: anywhere; }
.task-recovery { padding: 14px 0 14px 14px; border-left: 3px solid var(--warning); border-block: 1px solid var(--border); }.recovery-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }.recovery-heading > svg { color: var(--warning); flex-shrink: 0; }.recovery-heading > span { margin-left: auto; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }.task-recovery > p { margin-top: 8px; color: var(--text-2); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }.recovery-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }.recovery-actions .btn { max-width: 100%; white-space: normal; text-align: left; }.recovery-actions .btn svg { flex-shrink: 0; }.recovery-error { margin-top: 10px; font-size: 11px; color: var(--text-2); }.recovery-error summary { cursor: pointer; }.recovery-error p { padding-top: 8px; max-height: 150px; overflow: auto; overflow-wrap: anywhere; line-height: 1.7; }.recovery-check { margin-top: 10px; font-size: 12px; }.recovery-check p { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 10px; padding: 6px 0; }.recovery-check strong { font-weight: 550; }.recovery-check time { color: var(--text-2); font-size: 11px; }.recovery-check span { flex-basis: 100%; color: var(--text-2); overflow-wrap: anywhere; }.upload-recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }.cover-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.action-notice,.automatic-retry { display: flex; align-items: flex-start; gap: 7px; margin-top: 12px !important; color: var(--success); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }.action-notice svg,.automatic-retry svg { flex-shrink: 0; margin-top: 3px; }.automatic-retry { color: var(--info); }
.status-label.retry_wait,.task-recovery.scheduled .recovery-heading > svg { color: var(--info); }.task-recovery.scheduled { border-left-color: var(--info); }
.project-entry { display: inline-flex; align-items: center; gap: 5px; border: 0; padding: 0; background: transparent; color: var(--info); font: inherit; cursor: pointer; }.project-entry:disabled { opacity: .5; cursor: default; }
.job-id { display: block; margin-top: 6px; color: var(--text-2); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }.job-id code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: inherit; white-space: normal; }.detail-head > div { min-width: 0; flex: 1; }.detail-head > .btn { flex-shrink: 0; }.detail-id { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; }.detail-id .job-id { min-width: 0; margin: 0; }.detail-id .btn { flex-shrink: 0; }.copy-feedback { flex-basis: 100%; font-size: 11px; color: var(--success); overflow-wrap: anywhere; }.copy-feedback.error { color: var(--error); }
.detail-pane { padding: 22px 0 24px 28px; min-width: 0; overflow: auto; }.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.detail-head h2 { overflow-wrap: anywhere; line-height: 1.5; }.detail-meta { gap: 14px; flex-wrap: wrap; color: var(--text-2); font-size: 12px; margin-top: 8px; }.detail-meta a,.file-links a,.source-details a { display: inline-flex; align-items: center; gap: 4px; color: var(--info); text-decoration: none; }
.delete-task-button { color: var(--text-2); }.delete-task-button:not(:disabled):hover { color: var(--error); background: var(--error-bg); }
.pipeline { display: flex; list-style: none; gap: 8px; margin: 20px 0 12px; padding: 14px 0; border-block: 1px solid var(--border); }.pipeline li { flex: 1; display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-2); }.pipeline li:not(:last-child)::after { content: ''; flex: 1; height: 1px; background: var(--border); margin-inline: 4px; }.step-icon { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--border); border-radius: 50%; font-size: 10px; flex-shrink: 0; }.pipeline li.done { color: var(--success); }.pipeline li.done .step-icon { background: var(--success-bg); border-color: transparent; }.pipeline li.active { color: var(--info); }.pipeline li.active .step-icon { background: var(--info-bg); border-color: var(--info); }.pipeline li.attention { color: var(--warning); }
.job-message { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: var(--bg-1); border-radius: 6px; color: var(--text-2); }.job-message.warning { background: var(--warning-bg); color: var(--warning); }.job-message svg { flex-shrink: 0; margin-top: 2px; }
.detail-tabs { display: flex; gap: 24px; margin: 20px 0; border-bottom: 1px solid var(--border); }.detail-tabs button { border: 0; background: transparent; padding: 0 0 10px; border-bottom: 2px solid transparent; margin-bottom: -1px; font: inherit; color: var(--text-2); cursor: pointer; }.detail-tabs button.active { color: var(--text-1); border-bottom-color: var(--text-1); font-weight: 600; }
.field { display: grid; gap: 7px; margin-bottom: 16px; }.field > span,.script-heading label { font-weight: 550; }.field small { font-weight: 400; color: var(--text-2); margin-left: 5px; }.field input,.field select,textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); color: var(--text-1); font: inherit; }.field input:disabled,.field select:disabled,textarea:disabled { background: var(--bg-1); color: var(--text-2); opacity: 1; }.account-pickers { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }.account-pickers .field { margin-bottom: 8px; }.field-note { color: var(--text-2); font-size: 12px; margin: 0 0 16px !important; line-height: 1.7; }.script-heading { justify-content: space-between; margin-bottom: 8px; }.script-heading span { color: var(--text-2); font-size: 12px; }.script-editor { min-height: 300px; line-height: 1.95; resize: vertical; }.editor-actions { justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 16px; }.save-state { margin-right: auto; color: var(--text-2); font-size: 12px; }.save-state.dirty { color: var(--warning); }
.fact-checks { background: var(--warning-bg); padding: 15px; border-radius: 6px; margin: 16px 0; }.fact-checks > p { font-size: 12px; color: var(--text-2); margin-top: 5px; }.fact-checks ul { padding-left: 18px; margin: 12px 0 0; }.fact-checks li + li { margin-top: 9px; }.fact-checks li strong,.fact-checks li span { display: block; }.fact-checks li strong { font-weight: 550; }.fact-checks li span { color: var(--text-2); margin-top: 3px; font-size: 12px; }
.planning-details { margin: 16px 0; border: 1px solid var(--border); border-radius: 6px; }.planning-details summary { cursor: pointer; padding: 13px 15px; font-weight: 550; }.planning-details summary span { margin-left: 8px; font-weight: 400; color: var(--text-2); font-size: 12px; }.planning-body { padding: 0 15px 15px; max-height: 540px; overflow: auto; }.planning-summary { display: grid; gap: 10px; margin: 0; padding: 14px 0; border-top: 1px solid var(--border); }.planning-summary div { display: grid; grid-template-columns: 88px minmax(0,1fr); gap: 12px; }.planning-summary dt { color: var(--text-2); font-size: 12px; }.planning-summary dd { margin: 0; line-height: 1.7; }.planning-section { padding-top: 14px; border-top: 1px solid var(--border); }.planning-section + .planning-section { margin-top: 14px; }.planning-section h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }.planning-section ul,.planning-section ol { margin: 0; padding-left: 20px; }.planning-section li { line-height: 1.65; }.planning-section li + li { margin-top: 8px; }.planning-section li strong,.planning-section li span,.planning-section li small { display: block; }.planning-section li span,.planning-section li small { color: var(--text-2); font-size: 12px; margin-top: 2px; }.writing-outline > p { margin: 0 0 10px; line-height: 1.65; }.writing-outline > p strong,.writing-outline > p span { display: block; }.writing-outline > p span { color: var(--text-2); font-size: 12px; }.writing-outline .outline-ending { margin-top: 10px; color: var(--text-2); font-size: 12px; }
.angle-list li.selected { color: var(--info); }.angle-list li.selected span { color: var(--text-2); }
.planning-legacy-note { padding: 10px 12px; margin-top: 10px !important; background: var(--warning-bg); border-radius: 6px; }.section-telling { display: grid; gap: 8px; margin: 10px 0 0; padding: 10px 12px; background: var(--bg-1); border-radius: 6px; font-size: 12px; }.section-telling div { display: grid; grid-template-columns: 84px minmax(0,1fr); gap: 10px; }.section-telling dt { color: var(--text-2); }.section-telling dd { margin: 0; overflow-wrap: anywhere; }
.recovery-form { border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 12px; }.recovery-form summary { cursor: pointer; font-weight: 550; }.recovery-form .field-note { margin-top: 10px !important; }.export-recovery { margin-bottom: 12px; }.export-recovery .field { margin-top: 10px; }
.source-details { margin-top: 16px; border: 1px solid var(--border); padding: 13px; border-radius: 6px; }.source-details summary { cursor: pointer; font-weight: 550; }.source-details summary span { margin-left: 8px; font-weight: 400; color: var(--text-2); font-size: 12px; }.source-details .field-note { margin-top: 12px !important; margin-bottom: 10px !important; }.source-details textarea { min-height: 200px; line-height: 1.9; resize: vertical; }.source-details a { margin-top: 10px; font-size: 12px; }
.production-actions { padding: 18px 0 0; margin-top: 20px; border-top: 1px solid var(--border); flex-wrap: wrap; gap: 10px; }.production-actions > div { margin-right: auto; }.production-actions strong { font-weight: 550; }.production-actions p { color: var(--text-2); font-size: 12px; margin-top: 4px; }
.output-panel { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 24px; }.video-player { display: block; width: 100%; max-height: 520px; aspect-ratio: 16/9; background: #111; border-radius: 6px; }.video-placeholder { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; aspect-ratio: 16/9; background: var(--bg-1); color: var(--text-2); padding: 20px; text-align: center; border-radius: 6px; }.video-placeholder strong { font-weight: 550; color: var(--text-1); }.video-placeholder p { font-size: 12px; }.file-links { gap: 16px; flex-wrap: wrap; padding-top: 14px; font-size: 12px; }.upload-card { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding-left: 24px; border-left: 1px solid var(--border); }.upload-card > p { font-size: 12px; color: var(--text-2); }.upload-status { display: flex; align-items: center; gap: 8px; padding-block: 6px; }.upload-status strong { font-weight: 550; }.success { color: var(--success); }
.log-panel ol { list-style: none; padding: 0; margin: 16px 0 0; }.log-panel li { display: grid; grid-template-columns: 100px minmax(0,1fr); gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }.log-panel time { color: var(--text-2); font-size: 12px; }.log-panel li span { overflow-wrap: anywhere; }
.output-media { min-width: 0; }.cover-panel { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }.cover-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.cover-panel header p { margin-top: 5px; color: var(--text-2); font-size: 12px; }.cover-panel header .btn { flex-shrink: 0; }.cover-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; margin-top: 14px; }.cover-card { margin: 0; min-width: 0; }.cover-preview { display: flex; align-items: center; justify-content: center; width: 100%; height: 180px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg-1); }.cover-preview img { display: block; width: 100%; height: 100%; object-fit: contain; }.cover-placeholder { flex-direction: column; gap: 8px; color: var(--text-2); font-size: 12px; }.cover-card figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; margin-top: 5px; font-size: 12px; }.cover-card figcaption a { color: var(--text-2); text-decoration: none; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 35px 20px; color: var(--text-2); }.empty-state strong { font-weight: 550; color: var(--text-1); }.empty-state p { max-width: 380px; font-size: 12px; line-height: 1.8; }.detail-empty { min-height: 350px; }.detail-empty h2 { color: var(--text-1); }.back-button { display: none; }.page-foot { justify-content: space-between; gap: 12px; padding-top: 11px; font-size: 11px; color: var(--text-2); flex-wrap: wrap; }.page-alert { display: flex; align-items: center; gap: 10px; padding: 12px; margin-top: 12px; background: var(--error-bg); color: var(--error); border-radius: 6px; }.page-alert span { flex: 1; }.inline-error { color: var(--error); font-size: 12px; margin: 12px 0 !important; }
.upload-card { min-width: 0; }.upload-card > p { overflow-wrap: anywhere; }.upload-card > .upload-error { color: var(--error); }
.import-dialog { position: fixed; inset: 0; margin: auto; padding: 0; width: min(530px,calc(100vw - 32px)); max-height: calc(100dvh - 48px); background: var(--bg-0); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-elevated); color: var(--text-1); overflow: auto; }.import-dialog::backdrop { background: rgb(9 9 11 / 32%); }.import-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 22px 22px 16px; border-bottom: 1px solid var(--border); }.import-dialog header p { margin-top: 5px; font-size: 12px; color: var(--text-2); }.dialog-body { padding: 20px 22px; }.import-dialog footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--border); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }.spin { animation: spin 1s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
.cover-card figcaption small { margin-left: 8px; color: var(--text-2); font-size: 11px; }.cover-upload-note { margin-top: 10px !important; color: var(--text-2); font-size: 12px; line-height: 1.7; }
.cover-instruction { margin-top: 16px; margin-bottom: 10px; }.cover-instruction textarea { min-height: 90px; resize: vertical; line-height: 1.7; }.cover-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }.cover-actions .field-note { margin: 0 !important; }.cover-actions .btn { flex-shrink: 0; }
@media (max-width: 1200px) { .workspace { grid-template-columns: 250px minmax(0,1fr); }.output-panel { grid-template-columns: 1fr; }.upload-card { padding: 20px 0 0; border-left: 0; border-top: 1px solid var(--border); } }
@media (max-width: 760px) { .science-page { padding: 18px 16px 10px; }.page-head { gap: 14px; }.source-strip > span:last-child { display: none; }.workspace { grid-template-columns: 1fr; min-height: 400px; overflow: auto; }.queue-pane { border-right: 0; }.queue-list { padding-right: 0; overflow: visible; }.queue-search,.queue-filters { margin-right: 0; }.detail-pane { display: none; padding: 18px 0; overflow: visible; }.workspace.show-detail .queue-pane { display: none; }.workspace.show-detail .detail-pane { display: block; }.back-button { display: inline-flex; margin-bottom: 14px; }.pipeline { gap: 3px; }.pipeline li { font-size: 10px; flex-direction: column; text-align: center; }.pipeline li::after { display: none; }.account-pickers { grid-template-columns: 1fr; gap: 6px; }.head-actions { gap: 6px; }.head-actions .btn { font-size: 12px; }.script-editor { min-height: 320px; }.editor-actions .save-state { width: 100%; }.production-actions > div { width: 100%; margin-bottom: 4px; }.page-foot > span:first-child { display: none; }.recovery-heading > span { flex-basis: 100%; margin-left: 25px; } }
</style>
