<template>
  <div class="dharma-studio">
    <header class="studio-topbar">
      <div class="topbar-left">
        <NuxtLink to="/dharma" class="icon-button" title="返回剧集列表" aria-label="返回剧集列表">
          <ArrowLeft :size="17" />
        </NuxtLink>
        <div class="episode-identity">
          <p class="eyebrow">佛学工厂 / 制作中心</p>
          <h1 class="studio-title">{{ episodeTitle || `佛学剧集 #${episodeId}` }}</h1>
        </div>
      </div>
      <button
        v-if="selectedImageStyle"
        class="topbar-style"
        type="button"
        :disabled="imageStyleSaving || !footage?.drama_id"
        title="查看或修改 AI 图片风格"
        @click="stylePickerOpen = true"
      >
        <img :src="selectedImageStyle.preview_url" alt="" />
        <span>
          <small>AI 图片风格</small>
          <strong>{{ selectedImageStyle.name }}</strong>
        </span>
        <Palette :size="15" aria-hidden="true" />
      </button>
      <button class="icon-button" type="button" title="刷新制作数据" aria-label="刷新制作数据" :disabled="loading" @click="refresh">
        <RefreshCw :size="16" :class="{ 'spin-once': loading }" />
      </button>
    </header>

    <div v-if="error" class="notice notice-error" role="alert">
      <CircleX :size="16" />
      <span>{{ error }}</span>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="18" class="spin" />
      <span>正在读取制作数据</span>
    </div>

    <div v-else class="production-shell">
      <aside class="step-nav" aria-label="生产步骤">
        <div class="step-nav-head">
          <span class="step-nav-label">生产流程</span>
          <span class="step-nav-count">4 steps</span>
        </div>
        <nav class="step-nav-list">
          <button
            v-for="step in workflowSteps"
            :key="step.id"
            class="step-nav-item"
            :class="{ active: activeStep === step.id }"
            type="button"
            :title="step.label"
            :aria-current="activeStep === step.id ? 'step' : undefined"
            @click="activeStep = step.id"
          >
            <span class="step-nav-icon"><component :is="step.icon" :size="17" /></span>
            <span class="step-nav-copy">
              <span class="step-nav-title">{{ step.label }}</span>
              <span class="step-nav-detail">{{ step.detail }}</span>
            </span>
            <span class="step-status" :class="step.statusClass">{{ step.status }}</span>
          </button>
        </nav>
      </aside>

      <main class="production-content">
        <div v-if="footage && !footage.pre_tts_ready" class="notice notice-info">
          <LoaderCircle :size="15" class="spin" />
          <span>TTS 与分镜正在生成。素材审查与渲染会在准备完成后自动更新。</span>
        </div>

        <section v-show="activeStep === 'overview'" class="content-section" aria-labelledby="overview-title">
          <div class="section-heading">
            <div>
              <p class="section-kicker">01 / 总览</p>
              <h2 id="overview-title">制作状态</h2>
            </div>
            <span class="status-pill" :class="footage?.pre_tts_ready ? 'status-ready' : 'status-waiting'">
              {{ footage?.pre_tts_ready ? '可进入素材审查' : '等待 TTS' }}
            </span>
          </div>

          <div class="status-grid">
            <div class="status-item">
              <span class="status-label">TTS 与分镜</span>
              <strong>{{ footage?.pre_tts_ready ? '已就绪' : '生成中' }}</strong>
              <span class="status-note">{{ footage?.pre_tts_ready ? '主时间轴可用' : '完成后自动刷新' }}</span>
            </div>
            <div class="status-item">
              <span class="status-label">素材指派</span>
              <strong>{{ footage?.assigned_count ?? 0 }} / {{ footage?.total ?? 0 }}</strong>
              <span class="status-note">{{ materialStatusNote }}</span>
            </div>
            <div class="status-item">
              <span class="status-label">视觉计划</span>
              <strong>{{ visualPlanReady ? `已通过 ${visualPlanCoverage}` : '待完善' }}</strong>
              <span class="status-note">{{ visualPlanReady ? '静室氛围门禁已通过' : '需完善空间角色与时序' }}</span>
            </div>
            <div class="status-item">
              <span class="status-label">成片交付</span>
              <strong>{{ footage?.video_url ? '已渲染' : renderRunning ? '渲染中' : '未渲染' }}</strong>
              <span class="status-note">{{ footage?.video_url ? '可在渲染步骤下载' : '先完成试渲审核' }}</span>
            </div>
          </div>

          <section class="script-panel" aria-labelledby="script-title">
            <div class="panel-head">
              <div>
                <p class="section-kicker">净稿</p>
                <h3 id="script-title">生产文本</h3>
              </div>
              <FileText :size="17" aria-hidden="true" />
            </div>
            <p v-if="episodeScript" class="script-content">{{ episodeScript }}</p>
            <p v-else class="empty-copy">当前剧集未返回净稿文本；TTS 与分镜状态仍可在本页跟踪。</p>
          </section>
        </section>

        <section v-show="activeStep === 'materials'" class="content-section" aria-labelledby="materials-title">
          <div class="section-heading materials-heading">
            <div>
              <p class="section-kicker">02 / 素材</p>
              <h2 id="materials-title">视觉段落</h2>
              <p class="section-description">连续使用同一素材的相邻分镜在这里合并审查与替换。</p>
            </div>
            <div class="materials-heading-controls">
              <button
                class="current-style-card"
                type="button"
                :disabled="imageStyleSaving || !footage?.drama_id || !imageStyles.length"
                @click="stylePickerOpen = true"
              >
                <img v-if="selectedImageStyle" :src="selectedImageStyle.preview_url" alt="" />
                <span class="current-style-copy">
                  <span>AI 图片风格</span>
                  <strong>{{ selectedImageStyle?.name || '读取风格中' }}</strong>
                </span>
                <Palette :size="16" aria-hidden="true" />
              </button>
              <span class="status-pill" :class="footage?.assigned_count === footage?.total && footage?.total ? 'status-ready' : 'status-waiting'">
                {{ footage?.assigned_count ?? 0 }} / {{ footage?.total ?? 0 }} 已指派
              </span>
            </div>
          </div>

          <div v-if="footage?.asset_reuse_violations?.length" class="notice notice-error material-alert" role="alert">
            <AlertTriangle :size="16" />
            <span>发现非连续素材复用。请将同一素材保留在一个连续视觉段落内，或替换其中一个段落。</span>
          </div>

          <div v-if="segments.length" class="segment-filter-bar" aria-label="按素材来源筛选">
            <button
              v-for="filter in materialFilters"
              :key="filter.id"
              class="filter-chip"
              :class="{ active: materialFilter === filter.id }"
              type="button"
              @click="materialFilter = filter.id"
            >
              {{ filter.label }} <span>{{ filter.count }}</span>
            </button>
          </div>

          <div v-if="!footage?.pre_tts_ready" class="materials-empty dashed-empty">
            <LoaderCircle :size="20" class="spin" />
            <p>等待 TTS 主时间轴和分镜生成完成。</p>
          </div>
          <div v-else-if="!segments.length" class="materials-empty">
            <LayoutGrid :size="22" />
            <p>还没有可审查的分镜素材。</p>
          </div>
          <div v-else-if="!filteredSegments.length" class="materials-empty">
            <FilterX :size="22" />
            <p>当前筛选条件下没有视觉段落。</p>
          </div>
          <div v-else class="segment-list">
            <article v-for="segment in filteredSegments" :key="segment.key" class="segment-card">
              <div class="segment-preview">
                <video
                  v-if="segment.assigned && segment.kind === 'video' && segment.src"
                  :src="mediaUrl(segment.src)"
                  muted
                  controls
                  preload="metadata"
                />
                <img
                  v-else-if="segment.assigned && segment.kind === 'image' && segment.src"
                  :src="mediaUrl(segment.src)"
                  :alt="`视觉段落 ${segment.range}`"
                />
                <div v-else class="segment-placeholder">
                  <ImageOff :size="21" />
                  <span>待指派</span>
                </div>
                <span v-if="segment.fileMissing" class="media-warning"><AlertTriangle :size="12" /> 文件缺失</span>
                <span v-if="generationTaskBySegment[segment.key]" class="media-running"><LoaderCircle :size="12" class="spin" /> 生成中</span>
              </div>

              <div class="segment-body">
                <div class="segment-topline">
                  <div>
                    <p class="segment-number">分镜 {{ segment.range }}</p>
                    <h3>{{ segment.roleLabel }}</h3>
                  </div>
                  <div class="segment-badges">
                    <span class="source-badge" :class="`source-${segment.source}`">{{ sourceLabel(segment.source) }}</span>
                    <span class="metric-badge">{{ segment.itemCount }} 镜</span>
                  </div>
                </div>

                <div class="segment-meta">
                  <span><Clock3 :size="13" /> {{ fmtSeconds(segment.duration) }}</span>
                  <span v-if="segment.theme"><Tag :size="13" /> {{ segment.theme }}</span>
                  <span v-if="segment.emotion"><Activity :size="13" /> {{ emotionLabel(segment.emotion) }}</span>
                  <span v-if="segment.styleLabel"><Palette :size="13" /> {{ segment.styleLabel }}</span>
                </div>
                <p class="segment-narration">{{ truncate(segment.narration, 104) || '暂无旁白文本' }}</p>
                <p v-if="segment.quote?.text" class="segment-quote">
                  <Quote :size="13" />
                  <span>{{ segment.quote.text }}<template v-if="segment.quote.source"> - {{ segment.quote.source }}</template></span>
                </p>

                <div class="segment-actions" :aria-label="`视觉段落 ${segment.range} 的素材操作`">
                  <button
                    class="btn btn-ghost btn-compact"
                    type="button"
                    :disabled="segmentActionRunning(segment) || !stockEligible(segment)"
                    :title="stockEligible(segment) ? '从素材库选择' : '金句与顿悟段必须使用 AI 关键图'"
                    @click="openStockPicker(segment)"
                  >
                    <FolderOpen :size="14" />
                    <span>素材库</span>
                  </button>
                  <button class="btn btn-ghost btn-compact" type="button" :disabled="segmentActionRunning(segment)" @click="openGenerateDialog(segment, 'image')">
                    <ImageIcon :size="14" />
                    <span>生成图片</span>
                  </button>
                  <button
                    class="btn btn-ghost btn-compact"
                    type="button"
                    :disabled="segmentActionRunning(segment) || !videoGenerationEligible(segment)"
                    :title="videoGenerationEligible(segment) ? '生成动态衔接素材' : '金句与顿悟段必须生成 AI 静态图'"
                    @click="openGenerateDialog(segment, 'video')"
                  >
                    <Film :size="14" />
                    <span>生成视频</span>
                  </button>
                  <button
                    v-if="quoteEditorVisible(segment)"
                    class="btn btn-ghost btn-compact"
                    type="button"
                    :disabled="segmentActionRunning(segment)"
                    :title="quoteEditable(segment) ? '为顿悟段选择一个金句锚点' : '先完成极简光影 AI 图片生成'"
                    @click="openQuoteEditor(segment)"
                  >
                    <Quote :size="14" />
                    <span>{{ segment.quote?.text ? '编辑金句' : '添加金句' }}</span>
                  </button>
                </div>

                <details class="segment-shots">
                  <summary>查看 {{ segment.itemCount }} 个分镜</summary>
                  <ol>
                    <li v-for="item in segment.items" :key="item.storyboard_id">
                      <strong>#{{ item.storyboard_number }}</strong>
                      <span>{{ truncate(item.narration, 92) || '暂无旁白' }}</span>
                    </li>
                  </ol>
                </details>
              </div>
            </article>
          </div>
        </section>

        <section v-show="activeStep === 'bgm'" class="content-section" aria-labelledby="bgm-title">
          <div class="section-heading">
            <div>
              <p class="section-kicker">03 / BGM</p>
              <h2 id="bgm-title">音乐轨道</h2>
              <p class="section-description">成片使用一条 BGM 轨道，保存后会参与下一次试渲和正式渲染。</p>
            </div>
            <span class="status-pill" :class="footage?.bgm_audio_url ? 'status-ready' : 'status-waiting'">
              {{ footage?.bgm_audio_url ? '已选择' : '未选择' }}
            </span>
          </div>

          <section class="bgm-panel" aria-label="BGM 选择与上传">
            <label class="field-label" for="bgm-select">当前 BGM</label>
            <div class="bgm-control-row">
              <select
                id="bgm-select"
                class="bgm-select"
                :value="footage?.bgm_audio_url || ''"
                :disabled="bgmSaving || musicUploading"
                @change="onBgmChange"
              >
                <option value="">无 BGM</option>
                <option v-for="music in musicItems" :key="music.url" :value="musicPath(music)">
                  {{ music.filename }}（{{ fmtDuration(music.duration) }}）
                </option>
              </select>
              <button class="btn btn-ghost" type="button" :disabled="musicLoading" @click="loadMusic">
                <RefreshCw :size="15" :class="{ spin: musicLoading }" />
                刷新音乐库
              </button>
            </div>
            <div class="upload-row">
              <input ref="musicUploadInput" class="sr-only" type="file" accept="audio/*" @change="uploadMusic" />
              <button class="btn btn-primary" type="button" :disabled="musicUploading" @click="musicUploadInput?.click()">
                <LoaderCircle v-if="musicUploading" :size="15" class="spin" />
                <Upload v-else :size="15" />
                {{ musicUploading ? '上传中' : '上传音乐' }}
              </button>
              <NuxtLink to="/library" class="text-link">管理音乐素材库</NuxtLink>
            </div>
            <audio v-if="footage?.bgm_audio_url" class="bgm-player" controls preload="none" :src="mediaUrl(footage.bgm_audio_url)" />
            <p class="hint">支持从本地上传音频，上传后会刷新素材索引并保留当前选择。</p>
          </section>
        </section>

        <section v-show="activeStep === 'render'" class="content-section" aria-labelledby="render-title">
          <div class="section-heading">
            <div>
              <p class="section-kicker">04 / 渲染</p>
              <h2 id="render-title">预检、审核与交付</h2>
              <p class="section-description">先验证全片生产方案；仅在视觉风险存在时渲染一段连续风险片段，审核后一次正式渲染。</p>
            </div>
            <span class="status-pill" :class="footage?.video_url ? 'status-ready' : renderRunning ? 'status-running' : 'status-waiting'">
              {{ footage?.video_url ? '成片已就绪' : renderRunning ? '渲染中' : '等待渲染' }}
            </span>
          </div>

          <section class="render-panel">
            <div class="render-actions">
              <button
                class="btn btn-ghost"
                type="button"
                :disabled="renderRunning || !!renderStarting || !footage?.pre_tts_ready || !visualPlanReady"
                :title="visualPlanReady ? '编译并验证全片输入' : visualPlanGateReason"
                @click="runPreflight"
              >
                <LoaderCircle v-if="renderStarting === 'preflight'" :size="15" class="spin" />
                <BadgeCheck v-else :size="15" />
                <span>验证全片方案</span>
              </button>
              <button
                v-if="canaryRequired && canaryReview?.status === 'pending'"
                class="btn btn-ghost"
                type="button"
                :disabled="renderRunning || !!renderStarting"
                @click="runCanary"
              >
                <LoaderCircle v-if="renderStarting === 'canary'" :size="15" class="spin" />
                <Play v-else :size="15" />
                <span>渲染风险片段</span>
              </button>
              <button
                v-if="productionGate && (!canaryRequired || canaryReadyForApproval) && !productionApproved"
                class="btn btn-ghost"
                type="button"
                :disabled="renderRunning || !!renderStarting || !approvalActor.trim() || !approvalReason.trim()"
                @click="approveProduction"
              >
                <LoaderCircle v-if="renderStarting === 'approval'" :size="15" class="spin" />
                <BadgeCheck v-else :size="15" />
                <span>审核并放行整集</span>
              </button>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="renderRunning || !!renderStarting || !productionAdmission.allowed"
                :title="productionAdmission.allowed ? '正式渲染整集' : String(productionAdmission.reason || '请先完成全片预检与审核')"
                @click="runRender"
              >
                <LoaderCircle v-if="renderStarting === 'full'" :size="15" class="spin" />
                <Clapperboard v-else :size="15" />
                <span>正式渲染整集</span>
              </button>
            </div>

            <div v-if="productionGate && (!canaryRequired || canaryReadyForApproval) && !productionApproved" class="approval-fields">
              <input v-model="approvalActor" class="approval-input" type="text" maxlength="80" placeholder="审核人" aria-label="审核人" />
              <input v-model="approvalReason" class="approval-input approval-reason" type="text" maxlength="240" placeholder="审核结论" aria-label="审核结论" />
            </div>

            <div v-if="renderRunning" class="render-progress" aria-live="polite">
              <LoaderCircle :size="15" class="spin" />
              <span v-if="renderTelemetry">
                {{ dharmaPhaseLabels[renderTelemetry.phase] }} · 本阶段 {{ formatRenderDuration(renderTelemetry.phaseElapsedMs) }} · 已耗时 {{ formatRenderDuration(renderTelemetry.elapsedMs) }}
                <template v-if="renderTelemetry.fps !== null"> · {{ renderTelemetry.fps }} fps</template>
                <template v-if="renderTelemetry.etaMs !== null"> · 预计剩余 {{ formatRenderDuration(renderTelemetry.etaMs) }}</template>
              </span>
              <span v-else>{{ renderProgress.text || '渲染中…' }}</span>
            </div>
            <div v-if="renderError" class="notice notice-error inline" role="alert">
              <CircleX :size="15" />
              <span>{{ renderError }}</span>
            </div>
            <div v-if="productionGate && !productionAdmission.allowed && productionAdmission.reason" class="render-gate">{{ productionAdmission.reason }}</div>
            <div v-if="canaryRequired && canaryReview?.reasons?.length" class="render-gate">风险片段原因：{{ canaryReview.reasons.join('、') }}</div>
            <div v-if="!visualPlanReady && visualPlanGateReason" class="render-gate">{{ visualPlanGateReason }}</div>
          </section>

          <section v-if="finalVideoUrl || canaryVideoUrl || pilotVideoUrl" class="render-output" aria-label="渲染输出">
            <div v-if="canaryVideoUrl" class="output-item">
              <div class="output-head">
                <h3><Play :size="15" /> 风险片段输出</h3>
                <a :href="mediaUrl(canaryVideoUrl)" download class="icon-button" title="下载风险片段" aria-label="下载风险片段"><Download :size="16" /></a>
              </div>
              <video :src="mediaUrl(canaryVideoUrl)" controls class="final-player" />
            </div>
            <div v-if="pilotVideoUrl" class="output-item">
              <div class="output-head">
                <h3><Play :size="15" /> 历史试渲输出</h3>
                <a :href="mediaUrl(pilotVideoUrl)" download class="icon-button" title="下载历史试渲" aria-label="下载历史试渲"><Download :size="16" /></a>
              </div>
              <video :src="mediaUrl(pilotVideoUrl)" controls class="final-player" />
            </div>
            <div v-if="finalVideoUrl" class="output-item">
              <div class="output-head">
                <h3><Clapperboard :size="15" /> 成片</h3>
                <a :href="mediaUrl(finalVideoUrl)" download class="icon-button" title="下载成片" aria-label="下载成片"><Download :size="16" /></a>
              </div>
              <video :src="mediaUrl(finalVideoUrl)" controls class="final-player" />
            </div>
          </section>
        </section>
      </main>
    </div>

    <div v-if="stockPickerOpen" class="modal-backdrop" @click.self="closeStockPicker">
      <section class="modal-panel stock-modal" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title">
        <div class="modal-head">
          <div>
            <p class="section-kicker">素材库</p>
            <h2 id="stock-modal-title">更换分镜 {{ selectedSegment?.range }} 的素材</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭素材库" @click="closeStockPicker"><X :size="17" /></button>
        </div>
        <div class="metadata-grid">
          <label class="field-label">
            空间角色
            <select v-model="stockMetadata.role" class="metadata-select">
              <option v-for="option in visualRoleOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
          <label class="field-label">
            情绪位置
            <select v-model="stockMetadata.emotion" class="metadata-select" @change="syncStockStyle">
              <option v-for="option in stockEmotionOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
          <label class="field-label">
            画面风格
            <select v-model="stockMetadata.styleId" class="metadata-select">
              <option v-for="style in compatibleStyles(stockMetadata.emotion)" :key="style.id" :value="style.id">{{ style.name }}</option>
            </select>
          </label>
          <label v-if="selectedStockAsset?.kind === 'image'" class="field-label">
            Ken Burns 运镜
            <select v-model="stockMetadata.move" class="metadata-select">
              <option v-for="option in moveOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <div v-if="stockLoading" class="modal-loading"><LoaderCircle :size="18" class="spin" /> 正在读取素材库</div>
        <div v-else-if="stockError" class="notice notice-error inline" role="alert"><CircleX :size="15" /> {{ stockError }}</div>
        <div v-else-if="!stockItems.length" class="materials-empty"><FolderOpen :size="22" /><p>素材库当前没有可用素材。</p></div>
        <div v-else class="stock-grid">
          <button
            v-for="asset in stockItems"
            :key="`${asset.kind}:${asset.src}`"
            class="stock-asset"
            :class="{ selected: selectedStockAsset === asset }"
            type="button"
            @click="selectedStockAsset = asset"
          >
            <video v-if="asset.kind === 'video'" :src="mediaUrl(asset.url || asset.src)" muted preload="metadata" />
            <img v-else :src="mediaUrl(asset.url || asset.src)" :alt="stockAssetLabel(asset)" />
            <span>{{ stockAssetLabel(asset) }}</span>
          </button>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" @click="closeStockPicker">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!selectedStockAsset || stockApplying" @click="applyStockAsset">
            <LoaderCircle v-if="stockApplying" :size="15" class="spin" />
            {{ stockApplying ? '正在指派' : '确认使用此素材' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="generateDialogOpen" class="modal-backdrop" @click.self="closeGenerateDialog">
      <section class="modal-panel generate-modal" role="dialog" aria-modal="true" aria-labelledby="generate-modal-title">
        <div class="modal-head">
          <div>
            <p class="section-kicker">AI 生成</p>
            <h2 id="generate-modal-title">为分镜 {{ selectedSegment?.range }} 生成{{ generationKind === 'video' ? '视频' : '图片' }}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭生成窗口" @click="closeGenerateDialog"><X :size="17" /></button>
        </div>
        <div class="metadata-grid generation-metadata">
          <label class="field-label">
            空间角色
            <select v-model="generationMetadata.role" class="metadata-select">
              <option v-for="option in visualRoleOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
          <label class="field-label">
            情绪位置
            <select v-model="generationMetadata.emotion" class="metadata-select" @change="syncGenerationStyle">
              <option v-for="option in emotionOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
          <label class="field-label">
            画面风格
            <select v-model="generationMetadata.styleId" class="metadata-select">
              <option v-for="style in compatibleStyles(generationMetadata.emotion)" :key="style.id" :value="style.id">{{ style.name }}</option>
            </select>
          </label>
          <label v-if="generationKind === 'image'" class="field-label">
            Ken Burns 运镜
            <select v-model="generationMetadata.move" class="metadata-select">
              <option v-for="option in moveOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <label class="field-label" for="generation-prompt">画面提示词</label>
        <textarea id="generation-prompt" v-model="generationPrompt" class="generation-prompt" rows="6" placeholder="描述这一段需要生成的画面" />
        <p v-if="selectedGenerationStyle" class="hint">本段使用「{{ selectedGenerationStyle.name }}」承载{{ emotionLabel(generationMetadata.emotion) }}。</p>
        <p class="hint">生成完成后，系统会把同一份素材写回这个视觉段落的全部分镜。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" :disabled="generationStarting" @click="closeGenerateDialog">取消</button>
          <button class="btn btn-primary" type="button" :disabled="generationStarting || !generationPrompt.trim()" @click="startGeneration">
            <LoaderCircle v-if="generationStarting" :size="15" class="spin" />
            {{ generationStarting ? '正在提交' : `生成${generationKind === 'video' ? '视频' : '图片'}` }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="quoteDialogOpen" class="modal-backdrop" @click.self="closeQuoteEditor">
      <section class="modal-panel quote-modal" role="dialog" aria-modal="true" aria-labelledby="quote-modal-title">
        <div class="modal-head">
          <div>
            <p class="section-kicker">顿悟停顿</p>
            <h2 id="quote-modal-title">{{ selectedSegment?.quote?.text ? '编辑金句' : '添加金句' }}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭金句编辑窗口" :disabled="quoteSaving" @click="closeQuoteEditor"><X :size="17" /></button>
        </div>
        <p class="modal-description">金句只挂在一个分镜窗口上，旁白念到该句时显示中央大字；其余分镜不会重复显示。</p>
        <label class="field-label" for="quote-anchor">出现位置</label>
        <select id="quote-anchor" v-model="quoteAnchorStoryboardId" class="metadata-select quote-anchor-select">
          <option v-for="item in selectedSegment?.items || []" :key="item.storyboard_id" :value="Number(item.storyboard_id)">
            #{{ item.storyboard_number }} · {{ truncate(item.narration, 56) || '暂无旁白' }}
          </option>
        </select>
        <label class="field-label quote-field-label" for="quote-text">金句正文</label>
        <textarea
          id="quote-text"
          v-model="quoteText"
          class="generation-prompt quote-textarea"
          rows="3"
          maxlength="36"
          placeholder="输入一句需要停顿的教义或总结（最多 36 字）"
        />
        <div class="quote-field-meta"><span>{{ quoteText.length }} / 36</span><span>建议不超过 24 字</span></div>
        <label class="field-label quote-field-label" for="quote-source">出处（可选）</label>
        <input id="quote-source" v-model="quoteSource" class="approval-input quote-source-input" type="text" maxlength="20" placeholder="如：《金刚经》" />
        <p class="hint">正文为空时不会自动保存；已有金句可使用下方按钮移除。</p>
        <div class="modal-actions">
          <button v-if="selectedSegment?.quote?.text" class="btn btn-ghost quote-remove" type="button" :disabled="quoteSaving" @click="removeQuote">
            <LoaderCircle v-if="quoteSaving === 'remove'" :size="15" class="spin" />
            <span v-else>移除金句</span>
          </button>
          <button class="btn btn-ghost" type="button" :disabled="Boolean(quoteSaving)" @click="closeQuoteEditor">取消</button>
          <button class="btn btn-primary" type="button" :disabled="Boolean(quoteSaving) || !quoteText.trim() || !quoteAnchorStoryboardId" @click="saveQuote">
            <LoaderCircle v-if="quoteSaving === 'save'" :size="15" class="spin" />
            <span v-else>保存金句</span>
          </button>
        </div>
      </section>
    </div>

    <div v-if="stylePickerOpen" class="modal-backdrop" @click.self="closeStylePicker">
      <section class="modal-panel style-modal" role="dialog" aria-modal="true" aria-labelledby="style-modal-title">
        <div class="modal-head">
          <div>
            <p class="section-kicker">项目默认风格</p>
            <h2 id="style-modal-title">选择 AI 图片风格</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭风格选择" :disabled="imageStyleSaving" @click="closeStylePicker"><X :size="17" /></button>
        </div>
        <div class="style-gallery" role="radiogroup" aria-label="AI 图片风格">
          <button
            v-for="style in productionImageStyles"
            :key="style.id"
            class="style-gallery-card"
            :class="{ active: imageStyle === style.id }"
            type="button"
            role="radio"
            :aria-checked="imageStyle === style.id"
            :disabled="imageStyleSaving"
            @click="selectImageStyle(style.id)"
          >
            <img :src="style.preview_url" alt="" />
            <span>
              <strong>{{ style.name }}</strong>
              <small>{{ style.description }}</small>
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  Activity, AlertTriangle, ArrowLeft, BadgeCheck, Clapperboard, Clock3,
  CircleX, Download, FileText, Film, FilterX, FolderOpen, Image as ImageIcon,
  ImageOff, LayoutDashboard, LayoutGrid, LoaderCircle, Music, Palette, Play, Quote,
  RefreshCw, Tag, Upload, X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { dharmaAPI, dramaAPI, episodeAPI, libraryAPI, taskAPI } from '~/composables/useApi'
import { useTasks } from '~/composables/useTasks'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const episodeId = computed(() => Number(route.params.id))

const footage = ref(null)
const episodeTitle = ref('')
const episodeScript = ref('')
const musicItems = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const bgmSaving = ref(false)
const musicLoading = ref(false)
const musicUploading = ref(false)
const musicUploadInput = ref(null)
const renderStarting = ref('')
const approvalActor = ref('')
const approvalReason = ref('')
const activeStep = ref('overview')
const materialFilter = ref('all')

const stockPickerOpen = ref(false)
const stockLoading = ref(false)
const stockApplying = ref(false)
const stockError = ref('')
const stockItems = ref([])
const selectedStockAsset = ref(null)
const selectedSegment = ref(null)
const stockMetadata = ref({ role: 'temple_interior', emotion: 'stillness', styleId: '', move: 'drift_right' })

const generateDialogOpen = ref(false)
const generationKind = ref('image')
const generationPrompt = ref('')
const generationMetadata = ref({ role: 'temple_interior', emotion: 'stillness', styleId: '', move: 'drift_right' })
const generationStarting = ref(false)
const generationTaskBySegment = ref({})
const generationPollTimers = new Map()
const quoteDialogOpen = ref(false)
const quoteText = ref('')
const quoteSource = ref('')
const quoteAnchorStoryboardId = ref(null)
const quoteSaving = ref('')
const imageStyles = ref([])
const imageStyle = ref('')
const defaultImageStyleId = ref('')
const imageStyleSaving = ref(false)
const stylePickerOpen = ref(false)

const taskCenter = useTasks({ episodeId })
const renderRunning = computed(() => taskCenter.isTaskRunning('dharma.episode_render'))
const renderProgress = computed(() => taskCenter.taskProgress('dharma.episode_render'))
const renderError = computed(() => taskCenter.taskError('dharma.episode_render'))
const renderTelemetry = computed(() => {
  const task = taskCenter.latestTask('dharma.episode_render')
  return task ? taskCenter.telemetryByTaskId.value[Number(task.id)] || null : null
})

const dharmaPhaseLabels = {
  preflight: '渲染预检', configuration: '读取渲染配置', props_build: '构建素材与合成参数',
  input_fingerprint_pre_render: '核对渲染输入', staging_prepare: '准备交付暂存区',
  remotion_render: '启动 Remotion', remotion_bundle: '打包合成代码',
  remotion_composition: '读取合成配置', remotion_frames: '渲染画面帧',
  remotion_encode: '编码封装成片', output_validation: '校验交付文件',
  publish: '发布交付文件', staging_cleanup: '清理暂存文件',
}

const finalVideoUrl = computed(() => footage.value?.video_url || '')
const pilotReview = computed(() => footage.value?.pilot_review || null)
const productionGate = computed(() => footage.value?.production_gate || null)
const productionAdmission = computed(() => footage.value?.production_admission || { allowed: false })
const canaryReview = computed(() => productionGate.value?.canary || null)
const canaryRequired = computed(() => canaryReview.value?.requirement === 'required')
const canaryReadyForApproval = computed(() => canaryReview.value?.status === 'rendered')
const productionApproved = computed(() => productionGate.value?.fullPlan?.status === 'approved')
const visualPlan = computed(() => footage.value?.visual_plan || null)
const visualPlanReady = computed(() => Boolean(visualPlan.value?.ready))
const visualPlanCoverage = computed(() => {
  const ratio = Number(visualPlan.value?.sacred_coverage_ratio)
  return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : ''
})
const visualPlanGateReason = computed(() => {
  const errors = visualPlan.value?.errors
  if (Array.isArray(errors) && errors.length) return String(errors[0])
  return '素材空间计划未通过静室氛围门禁'
})
const canaryVideoUrl = computed(() => String(canaryReview.value?.output || ''))
const pilotVideoUrl = computed(() => {
  const output = pilotReview.value?.output || ''
  return output && output !== finalVideoUrl.value ? output : ''
})

const materialStatusNote = computed(() => {
  const total = Number(footage.value?.total || 0)
  const assigned = Number(footage.value?.assigned_count || 0)
  if (!total) return '等待分镜生成'
  return assigned === total ? '全部分镜已有素材' : `还有 ${total - assigned} 镜待指派`
})
const productionImageStyles = computed(() => imageStyles.value.filter(style => style?.production === true))
const selectedImageStyle = computed(() => (
  productionImageStyles.value.find(style => style.id === imageStyle.value)
  || productionImageStyles.value.find(style => style.id === defaultImageStyleId.value)
  || productionImageStyles.value[0]
  || null
))
const selectedGenerationStyle = computed(() => (
  productionImageStyles.value.find(style => style.id === generationMetadata.value.styleId) || null
))

const workflowSteps = computed(() => [
  {
    id: 'overview', label: '概览', detail: '文本与生产状态', icon: LayoutDashboard,
    status: footage.value?.pre_tts_ready ? '已就绪' : '等待中',
    statusClass: footage.value?.pre_tts_ready ? 'status-ready' : 'status-waiting',
  },
  {
    id: 'materials', label: '素材', detail: '视觉段落审查', icon: LayoutGrid,
    status: footage.value?.asset_reuse_ready === false ? '需处理' : materialStatusNote.value,
    statusClass: footage.value?.asset_reuse_ready === false ? 'status-blocked' : Number(footage.value?.assigned_count || 0) === Number(footage.value?.total || 0) && footage.value?.total ? 'status-ready' : 'status-waiting',
  },
  {
    id: 'bgm', label: 'BGM', detail: '音乐轨道', icon: Music,
    status: footage.value?.bgm_audio_url ? '已选择' : '未选择',
    statusClass: footage.value?.bgm_audio_url ? 'status-ready' : 'status-waiting',
  },
  {
    id: 'render', label: '渲染', detail: '预检与交付', icon: Clapperboard,
    status: footage.value?.video_url ? '已完成' : renderRunning.value ? '进行中' : '未开始',
    statusClass: footage.value?.video_url ? 'status-ready' : renderRunning.value ? 'status-running' : 'status-waiting',
  },
])

const visualRoleLabels = {
  temple_interior: '寺院静室', ritual: '仪式场景',
  temple_exterior: '寺院外景', contemplative_nature: '自然换气',
  human_relationship: '人物关系',
}
// 人物关系镜头必须由语义计划生成，暂不在通用素材选择器中开放裸选。
const visualRoleOptions = Object.entries(visualRoleLabels)
  .filter(([id]) => id !== 'human_relationship')
  .map(([id, label]) => ({ id, label }))
const emotionLabels = {
  curiosity: '好奇', stillness: '平静', tension: '冲突',
  acceptance: '接纳', insight: '顿悟', release: '释然',
}
const emotionOptions = Object.entries(emotionLabels).map(([id, label]) => ({ id, label }))
const stockEmotionOptions = emotionOptions.filter(option => option.id !== 'insight')
const moveOptions = [
  { id: 'push', label: '缓慢推进' },
  { id: 'pull', label: '缓慢拉远' },
  { id: 'hold', label: '静止停顿' },
  { id: 'drift_left', label: '向左漂移' },
  { id: 'drift_right', label: '向右漂移' },
]

function visualRoleLabel(role) {
  return visualRoleLabels[role] || '未标注空间角色'
}

function emotionLabel(emotion) {
  return emotionLabels[emotion] || '未标注情绪'
}

function compatibleStyles(emotion) {
  return productionImageStyles.value.filter(style => Array.isArray(style.emotions) && style.emotions.includes(emotion))
}

function styleForEmotion(emotion) {
  return compatibleStyles(emotion)[0] || selectedImageStyle.value
}

function suggestedEmotionForSegment(segment) {
  if (segment?.emotion && emotionLabels[segment.emotion]) return segment.emotion
  const index = segments.value.findIndex(item => item.key === segment?.key)
  if (index <= 0) return 'curiosity'
  if (index === segments.value.length - 1) return 'release'
  if (segment?.quote?.text) return 'insight'
  const ratio = index / Math.max(1, segments.value.length - 1)
  if (ratio < 0.3) return 'stillness'
  if (ratio < 0.55) return 'tension'
  return 'acceptance'
}

function metadataForSegment(segment) {
  const emotion = suggestedEmotionForSegment(segment)
  const compatible = compatibleStyles(emotion)
  const existingStyle = compatible.find(style => style.id === segment?.styleId)
  const style = existingStyle || compatible[0] || selectedImageStyle.value
  return {
    role: visualRoleLabels[segment?.role] ? segment.role : 'temple_interior',
    emotion,
    styleId: style?.id || '',
    move: segment?.move || style?.default_move || 'hold',
  }
}

function syncStockStyle() {
  const style = styleForEmotion(stockMetadata.value.emotion)
  stockMetadata.value.styleId = style?.id || ''
  stockMetadata.value.move = style?.default_move || 'hold'
}

function syncGenerationStyle() {
  const style = styleForEmotion(generationMetadata.value.emotion)
  generationMetadata.value.styleId = style?.id || ''
  generationMetadata.value.move = style?.default_move || 'hold'
}

function inferSource(item) {
  if (!item?.assigned) return 'unassigned'
  const src = String(item.src || '').toLowerCase()
  if (src.includes('/stock/') || src.includes('stock/') || src.includes('library/')) return 'library'
  return 'ai'
}

function buildSegments(items) {
  const orderedItems = Array.isArray(items) ? items : []
  const grouped = []
  for (const item of orderedItems) {
    const previous = grouped[grouped.length - 1]
    const previousItem = previous?.items?.[previous.items.length - 1]
    const sameAssignedAsset = Boolean(
      item?.assigned && previous?.assigned
      && item.kind === previous.kind
      && item.src && item.src === previous.src
      && item.role === previousItem?.role
      && item.emotion === previousItem?.emotion
      && item.style_id === previousItem?.style_id
      && (item.image?.move || null) === (previousItem?.image?.move || null)
      && (item.kind !== 'image' || (
        item.image?.generatedSegmentTaskId != null
        && item.image.generatedSegmentTaskId === previousItem?.image?.generatedSegmentTaskId
      )),
    )
    if (sameAssignedAsset) previous.items.push(item)
    else grouped.push({ assigned: Boolean(item?.assigned), kind: item?.kind || null, src: item?.src || null, items: [item] })
  }
  return grouped.map((group, index) => {
    const first = group.items[0]
    const last = group.items[group.items.length - 1]
    const source = inferSource(first)
    return {
      ...group,
      key: `${first.storyboard_id}-${last.storyboard_id}-${group.kind || 'unassigned'}-${group.src || index}`,
      range: first.storyboard_number === last.storyboard_number ? `#${first.storyboard_number}` : `#${first.storyboard_number} - #${last.storyboard_number}`,
      duration: group.items.reduce((sum, item) => sum + Number(item.duration || 0), 0),
      itemCount: group.items.length,
      narration: first.narration || '',
      quote: group.items.find(item => item.quote?.text)?.quote || null,
      role: first.role || null,
      roleLabel: visualRoleLabel(first.role),
      emotion: first.emotion || null,
      styleId: first.style_id || null,
      styleLabel: productionImageStyles.value.find(style => style.id === first.style_id)?.name || '',
      move: first.image?.move || null,
      theme: first.theme || '',
      source,
      fileMissing: group.items.some(item => item.assigned && item.file_exists === false),
    }
  })
}

const segments = computed(() => buildSegments(footage.value?.items))
const materialFilters = computed(() => {
  const count = (source) => source === 'all' ? segments.value.length : segments.value.filter(segment => segment.source === source).length
  return [
    { id: 'all', label: '全部', count: count('all') },
    { id: 'library', label: '素材库', count: count('library') },
    { id: 'ai', label: 'AI 生成', count: count('ai') },
    { id: 'unassigned', label: '待指派', count: count('unassigned') },
  ]
})
const filteredSegments = computed(() => materialFilter.value === 'all'
  ? segments.value
  : segments.value.filter(segment => segment.source === materialFilter.value))

let ttsPollTimer = null

function truncate(text, maxLength) {
  const value = String(text || '')
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function fmtDuration(seconds) {
  const rounded = Math.round(Number(seconds) || 0)
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
}

function fmtSeconds(seconds) {
  const rounded = Math.max(0, Math.round(Number(seconds) || 0))
  return rounded >= 60 ? fmtDuration(rounded) : `${rounded} 秒`
}

function formatRenderDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes ? `${minutes} 分 ${String(remainder).padStart(2, '0')} 秒` : `${remainder} 秒`
}

function mediaUrl(src) {
  const value = String(src || '')
  if (!value) return ''
  return /^(https?:|blob:|data:|\/)/.test(value) ? value : `/${value}`
}

function musicPath(item) {
  return String(item.url || '').replace(/^\//, '')
}

function sourceLabel(source) {
  return ({ library: '素材库', ai: 'AI 生成', unassigned: '待指派' })[source] || '未知来源'
}

function stockAssetLabel(asset) {
  if (asset?.label) return String(asset.label)
  if (asset?.filename) return String(asset.filename)
  const src = String(asset?.src || '')
  return src.split('/').filter(Boolean).pop() || '未命名素材'
}

function segmentActionRunning(segment) {
  return Boolean(generationTaskBySegment.value[segment.key] || stockApplying.value)
}

function stockEligible(segment) {
  return segment?.emotion !== 'insight' && !segment?.quote?.text
}

function videoGenerationEligible(segment) {
  return segment?.emotion !== 'insight' && !segment?.quote?.text
}

function quoteEditable(segment) {
  if (!segment?.assigned || segment.kind !== 'image') return false
  if (segment.quote?.text) return true
  if (segment.emotion !== 'insight' || segment.styleId !== 'dharma-minimal-light-v1' || segment.move !== 'hold') return false
  return segment.items.every(item => Number.isInteger(Number(item.image?.generatedSegmentTaskId)))
}

function quoteEditorVisible(segment) {
  return segment?.emotion === 'insight' || Boolean(segment?.quote?.text)
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    footage.value = await dharmaAPI.footage(episodeId.value)
    if (typeof footage.value?.image_style === 'string') imageStyle.value = footage.value.image_style
    if (productionImageStyles.value.length && !productionImageStyles.value.some(style => style.id === imageStyle.value)) {
      imageStyle.value = defaultImageStyleId.value || productionImageStyles.value[0].id
    }
    loaded.value = true
    if (footage.value?.pre_tts_ready) stopTtsPolling()
    else startTtsPolling()
  } catch (err) {
    error.value = err?.message || '加载制作数据失败'
  } finally {
    loading.value = false
  }
}

async function loadImageStyles() {
  try {
    const response = await dharmaAPI.imageStyles()
    imageStyles.value = Array.isArray(response?.items) ? response.items : []
    defaultImageStyleId.value = String(response?.default_style_id || '')
    if (!productionImageStyles.value.some(style => style.id === imageStyle.value)) {
      imageStyle.value = defaultImageStyleId.value || productionImageStyles.value[0]?.id || ''
    }
  } catch (err) {
    toast.error(err?.message || '图片风格目录加载失败')
  }
}

function closeStylePicker() {
  if (!imageStyleSaving.value) stylePickerOpen.value = false
}

async function saveImageStyle(previousStyle = String(footage.value?.image_style || defaultImageStyleId.value)) {
  const dramaId = Number(footage.value?.drama_id)
  if (!Number.isInteger(dramaId) || dramaId <= 0) {
    imageStyle.value = previousStyle
    return false
  }
  imageStyleSaving.value = true
  try {
    await dramaAPI.update(dramaId, { style: imageStyle.value })
    footage.value = { ...footage.value, image_style: imageStyle.value }
    toast.success(`AI 图片风格已设为「${selectedImageStyle.value?.name || imageStyle.value}」`)
    return true
  } catch (err) {
    imageStyle.value = previousStyle
    toast.error(err?.message || '图片风格保存失败')
    return false
  } finally {
    imageStyleSaving.value = false
  }
}

async function selectImageStyle(styleId) {
  if (styleId === imageStyle.value) {
    closeStylePicker()
    return
  }
  const previousStyle = imageStyle.value
  imageStyle.value = styleId
  if (await saveImageStyle(previousStyle)) closeStylePicker()
}

async function loadTitle() {
  try {
    const response = await dramaAPI.list()
    for (const drama of response.items || []) {
      const episode = (drama.episodes || []).find(item => Number(item.id) === episodeId.value)
      if (!episode) continue
      episodeTitle.value = [drama.title, episode.title].filter(Boolean).join(' · ')
      episodeScript.value = String(
        episode.content || episode.script_content || episode.scriptContent || episode.cleaned_content || episode.cleanedContent || '',
      )
      return
    }
  } catch {
    // The page remains usable when the enriched drama list is temporarily unavailable.
  }
}

async function loadMusic() {
  musicLoading.value = true
  try {
    const response = await libraryAPI.music()
    musicItems.value = response.items || []
  } catch (err) {
    toast.error(err?.message || '音乐素材库加载失败')
  } finally {
    musicLoading.value = false
  }
}

async function pollTts() {
  try {
    const active = await taskAPI.list({ episode_id: episodeId.value, active_only: true })
    const response = await dharmaAPI.footage(episodeId.value)
    footage.value = response
    if (response?.pre_tts_ready || (Array.isArray(active) && active.length === 0)) {
      stopTtsPolling()
      await refresh()
    }
  } catch (err) {
    console.error('poll tts error', err)
  }
}

function startTtsPolling() {
  if (ttsPollTimer) return
  ttsPollTimer = setInterval(pollTts, 3000)
}

function stopTtsPolling() {
  if (!ttsPollTimer) return
  clearInterval(ttsPollTimer)
  ttsPollTimer = null
}

async function onBgmChange(event) {
  const value = event.target.value
  bgmSaving.value = true
  error.value = ''
  try {
    await episodeAPI.update(episodeId.value, { bgm_audio_url: value || null })
    await refresh()
    toast.success(value ? 'BGM 已保存' : '已移除 BGM')
  } catch (err) {
    error.value = err?.message || 'BGM 保存失败'
  } finally {
    bgmSaving.value = false
  }
}

async function uploadMusic(event) {
  const input = event.target
  const file = input?.files?.[0]
  if (!file) return
  musicUploading.value = true
  try {
    await libraryAPI.uploadMusic(file)
    await libraryAPI.refresh()
    await loadMusic()
    toast.success('音乐已上传并刷新素材库')
  } catch (err) {
    toast.error(err?.message || '音乐上传失败')
  } finally {
    musicUploading.value = false
    if (input) input.value = ''
  }
}

async function openStockPicker(segment) {
  selectedSegment.value = segment
  stockMetadata.value = metadataForSegment(segment)
  selectedStockAsset.value = null
  stockError.value = ''
  stockPickerOpen.value = true
  stockLoading.value = true
  try {
    const response = await dharmaAPI.stockAssets()
    stockItems.value = Array.isArray(response?.items) ? response.items.filter(item => item?.src && (item.kind === 'image' || item.kind === 'video')) : []
  } catch (err) {
    stockItems.value = []
    stockError.value = err?.message || '素材库暂时不可用，请稍后重试。'
  } finally {
    stockLoading.value = false
  }
}

function closeStockPicker() {
  if (stockApplying.value) return
  stockPickerOpen.value = false
  selectedStockAsset.value = null
  selectedSegment.value = null
}

async function applyStockAsset() {
  const segment = selectedSegment.value
  const asset = selectedStockAsset.value
  if (!segment || !asset) return
  if (!stockMetadata.value.role || !stockMetadata.value.emotion || !stockMetadata.value.styleId) {
    stockError.value = '请先完成空间角色、情绪和画面风格选择。'
    return
  }
  stockApplying.value = true
  stockError.value = ''
  let applied = false
  try {
    const assetKind = asset.kind === 'video' ? 'video' : 'image'
    const assignments = segment.items.map(item => ({
      storyboardId: item.storyboard_id,
      role: stockMetadata.value.role,
      emotion: stockMetadata.value.emotion,
      style_id: stockMetadata.value.styleId,
      ...(item.theme ? { theme: item.theme } : segment.theme ? { theme: segment.theme } : {}),
      [assetKind]: assetKind === 'image'
        ? { src: asset.src, move: stockMetadata.value.move }
        : { src: asset.src },
    }))
    await dharmaAPI.applyFootage(episodeId.value, assignments)
    await refresh()
    toast.success(`已为分镜 ${segment.range} 指派素材库素材`)
    applied = true
  } catch (err) {
    stockError.value = err?.message || '素材指派失败'
  } finally {
    stockApplying.value = false
    if (applied) closeStockPicker()
  }
}

function openGenerateDialog(segment, kind) {
  selectedSegment.value = segment
  generationKind.value = kind
  generationMetadata.value = metadataForSegment(segment)
  generationPrompt.value = segment.narration || ''
  generateDialogOpen.value = true
}

function closeGenerateDialog() {
  if (generationStarting.value) return
  generateDialogOpen.value = false
  selectedSegment.value = null
  generationPrompt.value = ''
}

function openQuoteEditor(segment) {
  if (!quoteEditable(segment)) return
  selectedSegment.value = segment
  const existing = segment.quote || {}
  quoteText.value = String(existing.text || '')
  quoteSource.value = String(existing.source || '')
  const existingAnchor = segment.items.find(item => item.quote?.text)
  quoteAnchorStoryboardId.value = Number(existingAnchor?.storyboard_id || segment.items[0]?.storyboard_id || 0) || null
  quoteSaving.value = ''
  quoteDialogOpen.value = true
}

function closeQuoteEditor() {
  if (quoteSaving.value) return
  quoteDialogOpen.value = false
  quoteText.value = ''
  quoteSource.value = ''
  quoteAnchorStoryboardId.value = null
  selectedSegment.value = null
}

function buildQuoteAssignments(segment, quote) {
  return segment.items.map(item => ({
    storyboardId: item.storyboard_id,
    role: item.role,
    emotion: item.emotion,
    style_id: item.style_id,
    ...(item.theme ? { theme: item.theme } : {}),
    image: {
      src: item.src,
      move: item.image?.move || segment.move || 'hold',
    },
    quote: quote && Number(item.storyboard_id) === Number(quoteAnchorStoryboardId.value) ? quote : null,
  }))
}

async function saveQuote() {
  const segment = selectedSegment.value
  const text = quoteText.value.trim()
  if (!segment || !text || !quoteAnchorStoryboardId.value) return
  quoteSaving.value = 'save'
  try {
    const quote = {
      text,
      ...(quoteSource.value.trim() ? { source: quoteSource.value.trim() } : {}),
    }
    await dharmaAPI.applyFootage(episodeId.value, buildQuoteAssignments(segment, quote))
    await refresh()
    toast.success('金句已保存到选定分镜')
    closeQuoteEditor()
  } catch (err) {
    toast.error(err?.message || '金句保存失败')
  } finally {
    if (quoteSaving.value === 'save') quoteSaving.value = ''
  }
}

async function removeQuote() {
  const segment = selectedSegment.value
  if (!segment) return
  quoteSaving.value = 'remove'
  try {
    await dharmaAPI.applyFootage(episodeId.value, buildQuoteAssignments(segment, null).map(assignment => ({
      ...assignment,
      quote: null,
    })))
    await refresh()
    toast.success('金句已移除')
    closeQuoteEditor()
  } catch (err) {
    toast.error(err?.message || '金句移除失败')
  } finally {
    if (quoteSaving.value === 'remove') quoteSaving.value = ''
  }
}

function removeGenerationTask(segmentKey) {
  const next = { ...generationTaskBySegment.value }
  delete next[segmentKey]
  generationTaskBySegment.value = next
}

function stopGenerationPolling(segmentKey) {
  const timer = generationPollTimers.get(segmentKey)
  if (timer) clearInterval(timer)
  generationPollTimers.delete(segmentKey)
}

function taskStatus(task) {
  return String(task?.status || task?.data?.status || '').toLowerCase()
}

function taskError(task) {
  return String(task?.error || task?.error_message || task?.message || task?.data?.error || '素材生成任务失败')
}

function startGenerationPolling(segmentKey, taskId) {
  stopGenerationPolling(segmentKey)
  let attempts = 0
  let pending = false
  const timer = setInterval(async () => {
    if (pending) return
    pending = true
    attempts += 1
    try {
      const task = await taskAPI.get(taskId)
      const status = taskStatus(task)
      if (status === 'succeeded' || status === 'completed') {
        stopGenerationPolling(segmentKey)
        removeGenerationTask(segmentKey)
        await refresh()
        toast.success('素材生成完成，已刷新视觉段落')
      } else if (['failed', 'cancelled', 'canceled', 'stale'].includes(status)) {
        stopGenerationPolling(segmentKey)
        removeGenerationTask(segmentKey)
        toast.error(taskError(task))
      } else if (attempts >= 120) {
        stopGenerationPolling(segmentKey)
        removeGenerationTask(segmentKey)
        toast.error('素材仍在生成，请稍后刷新本页查看结果。')
      }
    } catch (err) {
      if (attempts >= 12) {
        stopGenerationPolling(segmentKey)
        removeGenerationTask(segmentKey)
        toast.error(err?.message || '无法继续查询生成状态，请稍后刷新。')
      }
    } finally {
      pending = false
    }
  }, 5000)
  generationPollTimers.set(segmentKey, timer)
}

async function startGeneration() {
  const segment = selectedSegment.value
  const prompt = generationPrompt.value.trim()
  if (!segment || !prompt) return
  generationStarting.value = true
  let submitted = false
  try {
    const metadata = generationMetadata.value
    const response = await dharmaAPI.generateFootage(episodeId.value, {
      storyboard_ids: segment.items.map(item => Number(item.storyboard_id)),
      kind: generationKind.value,
      prompt,
      role: metadata.role,
      emotion: metadata.emotion,
      style_id: metadata.styleId,
      ...(generationKind.value === 'image' ? { move: metadata.move } : {}),
    })
    const taskId = Number(response?.task_id)
    if (!Number.isFinite(taskId) || taskId <= 0) throw new Error('生成任务未返回有效任务编号')
    generationTaskBySegment.value = {
      ...generationTaskBySegment.value,
      [segment.key]: { taskId, kind: generationKind.value },
    }
    await taskCenter.loadTasks()
    startGenerationPolling(segment.key, taskId)
    toast.success('素材生成任务已提交')
    submitted = true
  } catch (err) {
    toast.error(err?.message || '素材生成任务提交失败')
  } finally {
    generationStarting.value = false
    if (submitted) closeGenerateDialog()
  }
}

async function onTasksSettled() {
  await refresh()
}

async function runPreflight() {
  renderStarting.value = 'preflight'
  error.value = ''
  try {
    await dharmaAPI.preflight(episodeId.value)
    await refresh()
    toast.success('全片生产方案已验证')
  } catch (err) {
    error.value = err?.message || '全片方案验证失败'
  } finally {
    renderStarting.value = ''
  }
}

async function runCanary() {
  renderStarting.value = 'canary'
  error.value = ''
  try {
    await dharmaAPI.renderCanary(episodeId.value)
    await taskCenter.loadTasks()
    taskCenter.startUpdates(onTasksSettled)
  } catch (err) {
    error.value = err?.message || '风险片段渲染启动失败'
  } finally {
    renderStarting.value = ''
  }
}

async function approveProduction() {
  const gate = productionGate.value
  const fullPlanFingerprint = String(gate?.fullPlan?.fingerprint || '')
  if (!fullPlanFingerprint) return
  renderStarting.value = 'approval'
  error.value = ''
  try {
    await dharmaAPI.approveProduction(episodeId.value, {
      fullPlanFingerprint,
      ...(canaryRequired.value ? { canaryFingerprint: String(canaryReview.value?.fingerprint || '') } : {}),
      actor: approvalActor.value.trim(),
      reason: approvalReason.value.trim(),
    })
    await refresh()
    toast.success('生产方案已审核通过')
  } catch (err) {
    error.value = err?.message || '生产方案审核失败'
  } finally {
    renderStarting.value = ''
  }
}

async function runRender() {
  renderStarting.value = 'full'
  error.value = ''
  try {
    await dharmaAPI.render(episodeId.value, {})
    await taskCenter.loadTasks()
    taskCenter.startUpdates(onTasksSettled)
  } catch (err) {
    error.value = err?.message || '正式渲染启动失败'
  } finally {
    renderStarting.value = ''
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadImageStyles()])
  loadTitle()
  loadMusic()
  await taskCenter.loadTasks()
  if (taskCenter.isTaskRunning('dharma.episode_render')) taskCenter.startUpdates(onTasksSettled)
})

onUnmounted(() => {
  stopTtsPolling()
  for (const timer of generationPollTimers.values()) clearInterval(timer)
  generationPollTimers.clear()
})
</script>

<style scoped>
.dharma-studio { display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg-base); color: var(--text-0); }
.studio-topbar { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 24px; border-bottom: 1px solid var(--border); background: var(--bg-1); flex-shrink: 0; }
.topbar-left, .episode-identity, .section-heading, .panel-head, .modal-head, .output-head, .segment-topline, .bgm-control-row, .upload-row, .render-actions, .render-progress, .notice, .materials-heading-controls { display: flex; align-items: center; }
.topbar-left { min-width: 0; gap: 12px; }
.episode-identity { min-width: 0; display: block; }
.eyebrow, .section-kicker { color: var(--text-3); font-size: 11px; line-height: 1.2; margin: 0; }
.studio-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-0); font-size: 15px; line-height: 1.3; margin: 2px 0 0; }
.topbar-style { min-width: 0; max-width: 220px; display: grid; grid-template-columns: 34px minmax(0, 1fr) 18px; align-items: center; gap: 8px; padding: 3px 8px 3px 3px; color: var(--text-2); text-align: left; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.topbar-style:hover:not(:disabled), .topbar-style:focus-visible { color: var(--text-0); border-color: var(--border-focus); outline: none; }
.topbar-style:disabled { opacity: .56; cursor: wait; }
.topbar-style img { width: 34px; height: 26px; object-fit: cover; border-radius: calc(var(--radius-sm) - 1px); background: var(--bg-2); }
.topbar-style span { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.topbar-style small, .topbar-style strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar-style small { color: var(--text-3); font-size: 9px; line-height: 1.2; }
.topbar-style strong { font-size: 11px; font-weight: 600; line-height: 1.3; }
.icon-button { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--text-2); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); text-decoration: none; cursor: pointer; }
.icon-button:hover:not(:disabled), .icon-button:focus-visible { color: var(--text-0); background: var(--bg-2); border-color: var(--border); outline: none; }
.icon-button:disabled { opacity: .5; cursor: wait; }
.notice { gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 1.5; }
.notice-error { color: var(--error); background: rgba(220, 38, 38, .08); }
.notice-info { color: var(--accent-text); background: var(--accent-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.notice.inline { margin-top: 14px; padding: 9px 11px; border: 1px solid currentColor; border-radius: var(--radius-sm); }
.page-loading, .modal-loading { display: flex; align-items: center; gap: 9px; color: var(--text-3); font-size: 13px; }
.page-loading { padding: 28px; }
.production-shell { min-height: 0; flex: 1; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
.step-nav { min-width: 0; padding: 18px 12px; border-right: 1px solid var(--border); background: var(--bg-1); overflow-y: auto; }
.step-nav-head { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 10px; }
.step-nav-label { color: var(--text-2); font-size: 11px; font-weight: 700; }
.step-nav-count { color: var(--text-3); font-size: 10px; }
.step-nav-list { display: flex; flex-direction: column; gap: 4px; }
.step-nav-item { width: 100%; min-height: 64px; display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 8px; padding: 9px 8px; color: var(--text-2); text-align: left; background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
.step-nav-item:hover, .step-nav-item:focus-visible { background: var(--bg-2); border-color: var(--border); outline: none; }
.step-nav-item.active { color: var(--text-0); background: var(--bg-2); border-color: var(--border); }
.step-nav-icon { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
.step-nav-item.active .step-nav-icon { color: var(--text-0); }
.step-nav-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.step-nav-title { color: inherit; font-size: 13px; font-weight: 650; }
.step-nav-detail { overflow: hidden; color: var(--text-3); font-size: 11px; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.step-status { grid-column: 2; justify-self: start; max-width: 138px; overflow: hidden; padding: 2px 6px; border-radius: 999px; font-size: 10px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.status-ready { color: #15803d; background: rgba(22, 163, 74, .1); }
.status-waiting { color: var(--text-3); background: var(--bg-2); }
.status-running { color: #1d4ed8; background: rgba(37, 99, 235, .1); }
.status-blocked { color: var(--error); background: rgba(220, 38, 38, .1); }
.production-content { min-width: 0; overflow-y: auto; padding: 28px clamp(20px, 3vw, 40px) 44px; }
.production-content > .notice { max-width: 1400px; margin: 0 auto 18px; }
.content-section { width: 100%; max-width: 1400px; margin: 0 auto; }
.section-heading { align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.materials-heading-controls { justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.current-style-card { min-width: 0; max-width: 240px; display: grid; grid-template-columns: 52px minmax(0, 1fr) 20px; align-items: center; gap: 8px; padding: 4px 8px 4px 4px; color: var(--text-2); text-align: left; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.current-style-card:hover:not(:disabled), .current-style-card:focus-visible { color: var(--text-0); border-color: var(--border-focus); outline: none; }
.current-style-card:disabled { opacity: .56; cursor: wait; }
.current-style-card img { width: 52px; height: 38px; object-fit: cover; border-radius: calc(var(--radius-sm) - 1px); background: var(--bg-2); }
.current-style-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.current-style-copy > span { overflow: hidden; color: var(--text-3); font-size: 10px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.current-style-copy strong { overflow: hidden; color: inherit; font-size: 12px; font-weight: 600; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.section-heading h2, .panel-head h3, .segment-body h3, .output-head h3, .modal-head h2 { color: var(--text-0); letter-spacing: 0; }
.section-heading h2 { font-size: 20px; line-height: 1.25; margin: 4px 0 0; }
.section-description { max-width: 680px; margin: 8px 0 0; color: var(--text-3); font-size: 13px; line-height: 1.6; }
.status-pill { flex: 0 0 auto; padding: 5px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.status-item { min-height: 118px; display: flex; flex-direction: column; justify-content: space-between; padding: 15px; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); }
.status-label { color: var(--text-3); font-size: 11px; }
.status-item strong { color: var(--text-0); font-size: 16px; line-height: 1.25; font-weight: 650; }
.status-note { color: var(--text-3); font-size: 11px; line-height: 1.4; }
.script-panel, .bgm-panel, .render-panel, .render-output { margin-top: 20px; padding: 18px; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); }
.panel-head, .modal-head, .output-head { justify-content: space-between; gap: 16px; }
.panel-head h3, .output-head h3 { display: flex; align-items: center; gap: 7px; font-size: 14px; margin: 3px 0 0; }
.panel-head > svg { color: var(--text-3); }
.script-content { max-height: 340px; overflow-y: auto; margin: 16px 0 0; padding: 14px; white-space: pre-wrap; color: var(--text-2); background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; line-height: 1.8; }
.empty-copy { margin: 16px 0 0; color: var(--text-3); font-size: 13px; line-height: 1.6; }
.material-alert { margin: -6px 0 16px; border: 1px solid rgba(220, 38, 38, .2); border-radius: var(--radius-sm); }
.segment-filter-bar { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
.filter-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; color: var(--text-2); background: var(--bg-1); border: 1px solid var(--border); border-radius: 999px; font-size: 12px; cursor: pointer; }
.filter-chip span { color: var(--text-3); font-size: 10px; }
.filter-chip:hover, .filter-chip:focus-visible, .filter-chip.active { color: var(--text-0); background: var(--bg-2); border-color: var(--border-strong, var(--border)); outline: none; }
.materials-empty { min-height: 170px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; color: var(--text-3); background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; text-align: center; }
.materials-empty p { margin: 0; }
.dashed-empty { border-style: dashed; }
.segment-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(410px, 1fr)); gap: 12px; }
.segment-card { min-width: 0; display: grid; grid-template-columns: 150px minmax(0, 1fr); overflow: hidden; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); }
.segment-preview { position: relative; min-height: 100%; overflow: hidden; background: var(--bg-2); }
.segment-preview video, .segment-preview img { width: 100%; height: 100%; min-height: 218px; display: block; object-fit: cover; background: #000; }
.segment-placeholder { height: 100%; min-height: 218px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--text-3); font-size: 12px; border-right: 1px dashed var(--border); }
.media-warning, .media-running { position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 999px; color: #fff; font-size: 10px; }
.media-warning { background: rgba(185, 28, 28, .88); }
.media-running { background: rgba(24, 24, 27, .82); }
.segment-body { min-width: 0; display: flex; flex-direction: column; padding: 15px; }
.segment-topline { align-items: flex-start; justify-content: space-between; gap: 10px; }
.segment-number { margin: 0; color: var(--text-3); font-size: 11px; }
.segment-body h3 { margin: 4px 0 0; font-size: 14px; line-height: 1.35; }
.segment-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.source-badge, .metric-badge { display: inline-flex; padding: 3px 6px; border-radius: 999px; font-size: 10px; line-height: 1.2; white-space: nowrap; }
.source-library { color: #1d4ed8; background: rgba(37, 99, 235, .1); }
.source-ai { color: #7c3aed; background: rgba(124, 58, 237, .1); }
.source-unassigned { color: var(--text-3); background: var(--bg-2); }
.metric-badge { color: var(--text-3); background: var(--bg-2); }
.segment-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; color: var(--text-3); font-size: 11px; }
.segment-meta span { display: inline-flex; align-items: center; gap: 4px; }
.segment-narration { display: -webkit-box; overflow: hidden; margin: 11px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.55; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.segment-quote { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0 0; padding-left: 9px; color: var(--text-2); border-left: 2px solid var(--border-strong, var(--border)); font-size: 11px; line-height: 1.55; }
.segment-quote svg { flex: 0 0 auto; margin-top: 2px; color: var(--text-3); }
.segment-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: auto; padding-top: 15px; }
.btn { min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 7px 11px; color: var(--text-0); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; font-size: 12px; font-weight: 600; line-height: 1.2; cursor: pointer; }
.btn:hover:not(:disabled), .btn:focus-visible { border-color: var(--border-strong, var(--border)); outline: none; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-ghost { background: var(--bg-1); }
.btn-ghost:hover:not(:disabled), .btn-ghost:focus-visible { background: var(--bg-2); }
.btn-primary { color: var(--primary-foreground, #fafafa); background: var(--accent); border-color: var(--accent); }
.btn-primary:hover:not(:disabled), .btn-primary:focus-visible { filter: brightness(.93); }
.btn-compact { min-height: 30px; padding: 6px 8px; font-size: 11px; }
.segment-shots { margin-top: 13px; color: var(--text-3); font-size: 11px; }
.segment-shots summary { width: fit-content; cursor: pointer; }
.segment-shots summary:hover { color: var(--text-1); }
.segment-shots ol { display: flex; flex-direction: column; gap: 7px; margin: 10px 0 0; padding: 0; list-style: none; }
.segment-shots li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 6px; padding-top: 7px; border-top: 1px solid var(--border); line-height: 1.45; }
.segment-shots strong { color: var(--text-2); font-weight: 600; }
.field-label { display: block; margin-bottom: 8px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.metadata-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.metadata-grid .field-label { min-width: 0; margin: 0; }
.metadata-select { width: 100%; min-width: 0; display: block; margin-top: 7px; padding: 8px 9px; color: var(--text-0); background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; font-size: 12px; }
.metadata-select:focus { border-color: var(--border-focus, var(--accent)); outline: none; }
.generation-metadata { margin: 16px 0; }
.bgm-control-row { gap: 9px; }
.bgm-select { min-width: 0; flex: 1; padding: 8px 10px; color: var(--text-0); background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
.bgm-select:focus { border-color: var(--border-focus, var(--accent)); outline: none; }
.upload-row { gap: 12px; margin-top: 14px; }
.text-link { color: var(--text-2); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.text-link:hover { color: var(--text-0); }
.bgm-player { width: 100%; max-width: 600px; height: 36px; margin-top: 16px; }
.hint { margin: 10px 0 0; color: var(--text-3); font-size: 11px; line-height: 1.5; }
.render-actions { flex-wrap: wrap; gap: 9px; }
.approval-fields { display: flex; gap: 9px; margin-top: 12px; }
.approval-input { min-width: 0; padding: 8px 10px; color: var(--text-0); background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; font-size: 12px; }
.approval-input:focus { border-color: var(--border-focus, var(--accent)); outline: none; }
.approval-reason { flex: 1; }
.render-progress { flex-wrap: wrap; gap: 8px; margin-top: 15px; color: var(--accent-text); font-size: 12px; line-height: 1.5; }
.render-gate { margin-top: 10px; color: var(--text-3); font-size: 12px; line-height: 1.55; }
.render-output { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 18px; }
.render-output:has(.output-item:only-child) { grid-template-columns: minmax(0, 760px); }
.output-head { margin-bottom: 10px; }
.final-player { width: 100%; display: block; background: #000; border-radius: var(--radius-sm); }
.modal-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(9, 9, 11, .36); }
.modal-panel { width: min(100%, 840px); max-height: min(760px, calc(100vh - 40px)); display: flex; flex-direction: column; overflow: hidden; padding: 20px; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, .12)); }
.modal-head { align-items: flex-start; }
.modal-head h2 { margin: 4px 0 0; font-size: 17px; line-height: 1.35; }
.modal-description { margin: 12px 0 0; color: var(--text-3); font-size: 12px; line-height: 1.55; }
.modal-loading { min-height: 180px; justify-content: center; }
.stock-grid { min-height: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 9px; overflow-y: auto; margin-top: 16px; padding: 1px; }
.stock-asset { min-width: 0; overflow: hidden; padding: 0; color: var(--text-2); text-align: left; background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.stock-asset:hover, .stock-asset:focus-visible, .stock-asset.selected { color: var(--text-0); border-color: var(--accent); outline: none; }
.stock-asset video, .stock-asset img { width: 100%; height: 102px; display: block; object-fit: cover; background: #000; }
.stock-asset > span { display: block; overflow: hidden; padding: 8px; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.style-modal { width: min(100%, 760px); }
.style-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; overflow-y: auto; margin-top: 18px; padding: 1px; }
.style-gallery-card { min-width: 0; padding: 7px; color: var(--text-2); text-align: left; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.style-gallery-card:hover:not(:disabled), .style-gallery-card:focus-visible, .style-gallery-card.active { color: var(--text-0); border-color: var(--border-focus); outline: none; }
.style-gallery-card.active { box-shadow: 0 0 0 2px var(--accent-glow); }
.style-gallery-card:disabled { cursor: wait; }
.style-gallery-card img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: calc(var(--radius-sm) - 1px); background: var(--bg-2); }
.style-gallery-card > span { display: flex; flex-direction: column; gap: 3px; padding: 9px 2px 2px; }
.style-gallery-card strong { font-size: 13px; font-weight: 600; line-height: 1.3; }
.style-gallery-card small { color: var(--text-3); font-size: 11px; line-height: 1.45; }
.generation-prompt { width: 100%; resize: vertical; padding: 10px; color: var(--text-0); background: var(--bg-base); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; font-size: 13px; line-height: 1.55; }
.generation-prompt:focus { border-color: var(--border-focus, var(--accent)); outline: none; }
.spin { animation: spin 900ms linear infinite; }
.spin-once { animation: spin 650ms linear 1; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 980px) {
  .production-shell { grid-template-columns: 58px minmax(0, 1fr); }
  .step-nav { padding: 12px 7px; }
  .step-nav-head, .step-nav-copy, .step-status { display: none; }
  .step-nav-list { gap: 7px; }
  .step-nav-item { min-height: 42px; display: flex; justify-content: center; padding: 6px; }
  .step-nav-icon { width: 28px; height: 28px; }
  .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metadata-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .dharma-studio { min-height: 100vh; height: auto; overflow: visible; }
  .studio-topbar { padding: 9px 14px; }
  .topbar-style { max-width: 150px; grid-template-columns: 30px minmax(0, 1fr) 16px; gap: 6px; padding-right: 5px; }
  .topbar-style img { width: 30px; height: 24px; }
  .topbar-style small { display: none; }
  .production-shell { min-height: auto; display: flex; flex-direction: column; }
  .step-nav { position: sticky; z-index: 4; top: 0; padding: 8px 12px; overflow: visible; border-right: 0; border-bottom: 1px solid var(--border); }
  .step-nav-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
  .step-nav-item { width: 100%; }
  .production-content { overflow: visible; padding: 20px 14px 36px; }
  .section-heading { align-items: flex-start; flex-direction: column; gap: 9px; }
  .materials-heading-controls { width: 100%; justify-content: space-between; }
  .current-style-card { max-width: min(100%, 240px); }
  .status-grid { grid-template-columns: 1fr; }
  .segment-list { grid-template-columns: 1fr; }
  .segment-card { grid-template-columns: 112px minmax(0, 1fr); }
  .segment-preview video, .segment-preview img, .segment-placeholder { min-height: 212px; }
  .bgm-control-row { align-items: stretch; flex-direction: column; }
  .upload-row { align-items: flex-start; flex-direction: column; }
  .approval-fields { flex-direction: column; }
  .metadata-grid { grid-template-columns: 1fr; }
  .render-output { grid-template-columns: 1fr; }
  .modal-backdrop { align-items: end; padding: 0; }
  .modal-panel { width: 100%; max-height: min(85vh, 760px); border-radius: var(--radius) var(--radius) 0 0; }
  .style-gallery { grid-template-columns: minmax(0, 1fr); }
}
</style>
