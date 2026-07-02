<template>
  <div class="studio" v-if="drama">
    <header class="studio-topbar">
      <div class="studio-topbar-main">
        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回项目
        </button>
        <div class="studio-identity">
          <h1 class="studio-title">{{ drama.title }}</h1>
          <div v-if="episode?.video_title" class="studio-episode-title">{{ episode.video_title }}</div>
          <span class="studio-episode-chip">第 {{ episodeNumber }} 集</span>
          <div class="studio-meta-row">
            <span class="studio-meta-pill">{{ currentSubStageLabel }}</span>
            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/11</span>
            <span class="studio-meta-inline">{{ chars.length }} 角色 · {{ sbs.length }} 镜头</span>
          </div>
        </div>
      </div>

      <div class="studio-topbar-side">
        <div class="studio-actions">
          <button class="btn" @click="refresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            刷新
          </button>
          <button class="btn btn-settings" @click="settingsDrawerOpen = true" title="生产设置">
            <Settings2 :size="13" />
            设置
          </button>
          <button class="btn btn-primary" @click="panel = mergeUrl ? 'export' : (sbs.length ? 'production' : 'script')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {{ mergeUrl ? '查看成片' : (sbs.length ? '继续制作' : '开始制作') }}
          </button>
        </div>
      </div>
    </header>

    <div v-if="settingsDrawerOpen" class="settings-drawer-overlay" @click.self="settingsDrawerOpen = false">
      <aside class="settings-drawer" role="dialog" aria-modal="true" aria-label="生产设置">
        <div class="settings-drawer-head">
          <div>
            <div class="settings-drawer-kicker">Episode {{ episodeNumber }}</div>
            <h2 class="settings-drawer-title">生产设置</h2>
          </div>
          <button class="btn btn-ghost btn-icon drawer-close" @click="settingsDrawerOpen = false" aria-label="关闭生产设置">
            <X :size="16" />
          </button>
        </div>

        <div class="settings-drawer-body">
          <section class="settings-section">
            <div class="settings-section-title">生产模式</div>
            <div class="settings-control-row">
              <span class="render-mode-label">输出模式</span>
              <div class="render-mode-switch" title="图文叙事使用静态图+Ken Burns+对白/旁白；AI视频模式需要额外生成AI视频">
                <button :class="['render-mode-btn', { active: renderMode === 'image_story' }]" @click="confirmSetRenderMode('image_story')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  图文叙事
                </button>
                <button :class="['render-mode-btn', { active: renderMode === 'ai_video' }]" @click="confirmSetRenderMode('ai_video')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  AI 视频
                </button>
              </div>
            </div>
            <div class="settings-control-row">
              <span class="render-mode-label">执行模式</span>
              <div class="drawer-inline-controls">
                <button :class="['auto-mode-btn', { active: autoMode }]" :title="autoMode ? '当前为自动模式' : '当前为手动模式'" @click="toggleAutoMode">
                  <svg v-if="autoMode" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
                  <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {{ autoMode ? '自动' : '手动' }}
                </button>
                <label v-if="autoMode" class="ai-rewrite-checkbox" title="关闭后，自动模式会跳过 AI 改写，直接用原文生成分镜和旁白">
                  <input type="checkbox" :checked="enableAiRewrite" @change="toggleAiRewrite" />
                  <span>AI 改写</span>
                </label>
              </div>
            </div>
            <div class="settings-control-row">
              <span class="render-mode-label">叙事节奏</span>
              <BaseSelect :model-value="pacingMode" :options="pacingModeOptions" class="drawer-select" @update:model-value="updatePacingMode" />
            </div>
            <div class="settings-control-row">
              <span class="render-mode-label">对白模式</span>
              <BaseSelect :model-value="dialogueMode" :options="dialogueModeOptions" class="drawer-select" @update:model-value="updateDialogueMode" />
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-section-title">解说 TTS</div>
            <div class="settings-control-row">
              <span class="render-mode-label">Provider</span>
              <div class="narration-provider-switch">
                <button
                  v-for="p in narrationProviderChoices"
                  :key="p.provider"
                  :class="['narration-provider-btn', { active: narrationProvider === p.provider }]"
                  :disabled="!p.config || narrationProviderSaving"
                  :title="p.config ? `切换为 ${p.label}` : `没有可用的 ${p.label} 音频配置`"
                  @click="setNarrationProvider(p.provider)"
                >
                  <span class="provider-dot" :class="p.provider"></span>
                  {{ p.label }}
                </button>
              </div>
            </div>
            <div class="settings-control-row">
              <span class="render-mode-label">解说音色</span>
              <BaseSelect :model-value="narrationVoiceId || ''" :options="narrationVoiceOptions" placeholder="默认" class="drawer-select wide" @update:model-value="updateNarrationVoice" />
            </div>
            <div class="settings-control-row">
              <span class="render-mode-label">解说语速</span>
              <div class="drawer-speed-control">
                <input type="range" min="0.8" max="2.5" step="0.1" :value="narrationSpeed" class="speed-slider" @change="e => updateNarrationSpeed(Number(e.target.value))" />
                <span class="speed-value">{{ narrationSpeed.toFixed(1) }}x</span>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-section-title">字幕</div>
            <div class="settings-control-row">
              <span class="render-mode-label">启用字幕</span>
              <div class="drawer-inline-controls">
                <input type="checkbox" :checked="subtitleEnabled" @change="updateSubtitleEnabled" title="开启/关闭字幕" />
                <button class="btn btn-sm" :disabled="subtitleGenerating" @click="generateSubtitles">
                  <Loader2 v-if="subtitleGenerating" :size="11" class="animate-spin" />
                  <span v-else>生成</span>
                </button>
                <button class="btn btn-sm" :disabled="subtitlePreviewLoading || !firstSubtitleStoryboard" @click="previewSubtitle">
                  <Loader2 v-if="subtitlePreviewLoading" :size="11" class="animate-spin" />
                  <span v-else>预览</span>
                </button>
              </div>
            </div>
            <div v-if="subtitleEnabled" class="subtitle-controls drawer-subtitle-controls">
              <BaseSelect :model-value="subtitleFont" :options="subtitleFontOptions" class="drawer-select compact" @update:model-value="v => updateSubtitleField('subtitle_font', v)" />
              <input type="color" :value="subtitleColor" @input="e => updateSubtitleField('subtitle_color', e.target.value)" class="subtitle-color" title="字幕颜色" />
              <input type="number" :value="subtitleSize" min="12" max="120" @change="e => updateSubtitleField('subtitle_size', Number(e.target.value))" class="subtitle-size" title="字号" />
              <BaseSelect :model-value="subtitlePosition" :options="subtitlePositionOptions" class="drawer-select mini" @update:model-value="v => updateSubtitleField('subtitle_position', v)" />
              <input type="number" :value="subtitleMargin" min="0" max="400" @change="e => updateSubtitleField('subtitle_margin', Number(e.target.value))" class="subtitle-size" title="左右边距" />
              <input type="number" :value="subtitleMarginV" min="0" max="400" @change="e => updateSubtitleField('subtitle_margin_v', Number(e.target.value))" class="subtitle-size" title="上下边距" />
              <input type="color" :value="subtitleStrokeColor" @input="e => updateSubtitleField('subtitle_stroke_color', e.target.value)" class="subtitle-color" title="描边颜色" />
              <input type="number" :value="subtitleStrokeWidth" min="0" max="10" @change="e => updateSubtitleField('subtitle_stroke_width', Number(e.target.value))" class="subtitle-size" title="描边宽度" />
              <input type="color" :value="subtitleBackgroundColor || '#000000'" @input="e => updateSubtitleField('subtitle_background_color', e.target.value)" class="subtitle-color" title="背景颜色（空为透明）" />
              <button v-if="subtitleBackgroundColor" class="btn btn-xs" title="清除背景色" @click="updateSubtitleField('subtitle_background_color', null)">×</button>
            </div>
            <video v-if="subtitlePreviewUrl" :src="subtitlePreviewUrl" controls class="subtitle-preview" />
          </section>
        </div>
      </aside>
    </div>

    <div class="studio-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar">
      <nav class="pipeline">
        <div
          v-for="section in sidebarSections"
          :key="section.id"
          class="pipe-section"
        >
          <div class="pipe-section-label">{{ section.label }}</div>
          <button
            v-for="item in section.items"
            :key="item.key"
            :class="['pipe-item pipe-item-sub', { active: activeSubStepKey === item.key, done: item.done, running: item.running }]"
            @click="goSubStep(item.key)"
          >
            <span class="pipe-icon" :class="item.done ? 'icon-done' : item.running ? 'icon-running' : activeSubStepKey === item.key ? 'icon-active' : ''">
              <svg v-if="item.done" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <Loader2 v-else-if="item.running" :size="11" class="animate-spin" />
              <component v-else :is="item.icon" :size="11" />
            </span>
            <span class="pipe-copy">
              <span class="pipe-label">{{ item.label }}</span>
              <span v-if="item.running" class="pipe-sub pipe-sub-running">执行中…</span>
              <span v-else-if="item.desc" class="pipe-sub">{{ item.desc }}</span>
            </span>
          </button>
        </div>
      </nav>

      <!-- Bottom: Progress + Refresh -->
      <div class="sidebar-bottom">
        <div class="progress-wrap">
          <div class="progress-head">
            <span class="progress-label">制作进度</span>
            <span class="progress-val">{{ pipelineProgress }}/11</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: (pipelineProgress / 11 * 100) + '%' }"></div>
          </div>
        </div>
        <div class="sidebar-jumper" v-if="sidebarJumpSteps.length">
          <button
            v-for="step in sidebarJumpSteps"
            :key="step.key"
            :class="['sidebar-jump-dot', { active: activeSubStepKey === step.key, done: step.done }]"
            @click="goSubStep(step.key)"
            :title="step.label"
          ></button>
        </div>
        <button class="refresh-btn" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          刷新数据
        </button>
      </div>
    </aside>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main">
      <div v-if="activeSubSteps.length" class="stage-subnav">
        <button
          v-for="sub in activeSubSteps"
          :key="sub.key"
          :class="['stage-subnav-item', { active: activeSubStepKey === sub.key, done: sub.done }]"
          @click="goSubStep(sub.key)"
        >
          <span>{{ sub.label }}</span>
          <span v-if="sub.done" class="stage-subnav-dot"></span>
        </button>
      </div>

      <div v-if="openingHook || cliffhanger" class="retention-strip">
        <div v-if="openingHook" class="retention-card">
          <span class="retention-label">3 秒钩子</span>
          <span class="retention-text">{{ openingHook }}</span>
        </div>
        <div v-if="cliffhanger" class="retention-card">
          <span class="retention-label">结尾悬念</span>
          <span class="retention-text">{{ cliffhanger }}</span>
        </div>
      </div>

      <!-- ===== SCRIPT PANEL ===== -->
      <div v-if="panel === 'script'" class="content-panel">
        <!-- Step 0: Raw Content -->
        <div v-if="scriptStep === 0" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">01</span>
                <span class="step-name">原始内容</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="rawLen" class="char-count">{{ rawLen }} 字</span>
              <button class="btn btn-sm" @click="useStoryValidationSample">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5 5l14 14"/></svg>
                插入测试样例
              </button>
              <button class="btn btn-sm" @click="saveRaw(); toast.success('已保存')">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                保存
              </button>
            </div>
          </div>
          <textarea
            class="fill-textarea"
            v-model="localRaw"
            placeholder="粘贴小说原文、故事大纲或分镜描述..."
          />
          <div class="sample-hint-bar">
            <span class="sample-hint-title">测试建议</span>
            <span class="sample-hint-copy">样例会刻意包含内心、背景、因果和悬念，适合验证新的分镜和旁白逻辑是否真的保住了故事信息。</span>
          </div>
        </div>

        <!-- Step 1: Rewrite -->
        <div v-else-if="scriptStep === 1" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">02</span>
                <span class="step-name">AI 改写</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="scriptLen" class="char-count">{{ scriptLen }} 字</span>
              <button v-if="rawContent" class="btn btn-sm" @click="skipRewrite">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                跳过改写
              </button>
              <button v-if="scriptContent" class="btn btn-sm" @click="doRewrite" :disabled="rn">
                <Loader2 v-if="rn && rt === 'script_rewriter'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                重新改写
              </button>
            </div>
          </div>

          <div v-if="!scriptContent && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
            </div>
            <div class="empty-title">AI 改写为格式化剧本</div>
            <div class="empty-desc">你可以先用 AI 把原始内容整理成格式化剧本，也可以跳过这一步，直接使用原始内容继续提取角色与场景。</div>
            <div class="step-empty-actions">
              <button class="btn btn-primary" @click="doRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                开始改写
              </button>
              <button class="btn" @click="skipRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                跳过改写
              </button>
            </div>
          </div>
          <div v-else-if="rn && rt === 'script_rewriter'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在改写剧本...</div>
          </div>
          <textarea v-else class="fill-textarea" v-model="localScript" placeholder="格式化剧本内容..." />
        </div>

        <!-- Step 2: Extract -->
        <div v-else-if="scriptStep === 2" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">03</span>
                <span class="step-name">提取角色与场景</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="chars.length" class="char-count">{{ chars.length }} 角色 · {{ scenes.length }} 场景</span>
              <button v-if="chars.length" class="btn btn-sm" @click="doExtract" :disabled="rn">
                <Loader2 v-if="rn && rt === 'extractor'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                重新提取
              </button>
            </div>
          </div>

          <div v-if="!chars.length && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <div class="empty-title">从剧本提取角色与场景</div>
            <div class="empty-desc">AI 自动分析剧本，提取角色信息和场景列表，与项目已有数据智能去重合并</div>
            <button class="btn btn-primary" @click="doExtract">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              开始提取
            </button>
          </div>
          <div v-else-if="rn && rt === 'extractor'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在提取角色和场景...</div>
          </div>
          <div v-else class="extract-stage">
            <aside class="card extract-summary">
              <div class="extract-summary-kicker">Extraction Board</div>
              <div class="extract-summary-title">角色与场景结果</div>
              <div class="extract-summary-desc">从剧本里提取出的角色和场景已经入库。这里先确认命名、定位和描述是否可直接进入后续制作。</div>
              <div class="extract-summary-stats">
                <div class="extract-summary-stat">
                  <span>角色</span>
                  <strong>{{ chars.length }}</strong>
                </div>
                <div class="extract-summary-stat">
                  <span>场景</span>
                  <strong>{{ scenes.length }}</strong>
                </div>
              </div>
              <div class="extract-summary-note">如果角色描述过于简短，后续分配音色和生成形象时建议先补充人物特征。</div>
            </aside>

            <div class="card extract-card">
              <div class="extract-card-head">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span>角色</span>
                <span class="tag tag-accent">{{ chars.length }}</span>
              </div>
              <div class="extract-list">
                <div v-for="c in chars" :key="c.id" class="extract-row">
                  <div class="char-avatar">{{ c.name?.[0] || '?' }}</div>
                  <div class="extract-info">
                    <div class="extract-name-row">
                      <div class="extract-name">{{ c.name }}</div>
                      <span class="tag">{{ c.role || '角色' }}</span>
                    </div>
                    <div class="extract-meta wrap">{{ c.description || c.appearance || c.personality || '暂无描述' }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card extract-card" v-if="scenes.length">
              <div class="extract-card-head">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                <span>场景</span>
                <span class="tag tag-accent">{{ scenes.length }}</span>
              </div>
              <div class="extract-list">
                <div v-for="s in scenes" :key="s.id" class="extract-row">
                  <div class="scene-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <div class="extract-info">
                    <div class="extract-name-row">
                      <div class="extract-name">{{ s.location }}</div>
                      <span v-if="s.time" class="tag">{{ s.time }}</span>
                    </div>
                    <div class="extract-meta wrap">{{ s.description || s.time || '等待补充场景描述' }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 3: Voice Assignment -->
        <div v-else-if="scriptStep === 3" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">04</span>
                <span class="step-name">分配音色</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="charsVoiced" class="char-count">{{ charsVoiced }}/{{ chars.length }} 已分配</span>
              <span v-if="voiceSampleCount" class="char-count">{{ voiceSampleCount }}/{{ charsVoiced }} 试听文件</span>
              <button v-if="chars.length" class="btn btn-sm" @click="autoAssignVoices(false)" title="按角色性别/年龄/性格规则自动填未分配的音色，不调用大模型">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>
                智能默认分配
              </button>
              <button v-if="charsVoiced" class="btn btn-sm" @click="doVoice" :disabled="rn">
                <Loader2 v-if="rn && rt === 'voice_assigner'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                重新分配
              </button>
              <button v-if="charsVoiced" class="btn btn-sm" @click="batchGenSamples">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19 5v14"/></svg>
                生成试听文件
              </button>
            </div>
          </div>

          <div v-if="!charsVoiced && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
            </div>
            <div class="empty-title">为角色分配合适的音色</div>
            <div class="empty-desc">AI 根据角色特征自动分配最匹配的 TTS 音色</div>
            <button class="btn btn-primary" @click="doVoice">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              AI 自动分配
            </button>
          </div>
          <div v-else-if="rn && rt === 'voice_assigner'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在分配音色...</div>
          </div>
          <div v-else class="voice-stage">
            <aside class="card voice-stage-panel">
              <div class="voice-stage-kicker">Voice Casting</div>
              <div class="voice-stage-title">角色声音分配台</div>
              <div class="voice-stage-desc">先为每个角色选择合适音色，再生成试听。音色标签会帮助你快速区分旁白、主角、反派和配角的表达方向。</div>
              <div class="voice-stage-stats">
                <div class="voice-stage-stat">
                  <span class="voice-stage-stat-label">已分配</span>
                  <strong>{{ charsVoiced }}/{{ chars.length }}</strong>
                </div>
                <div class="voice-stage-stat">
                  <span class="voice-stage-stat-label">试听文件</span>
                  <strong>{{ voiceSampleCount }}/{{ charsVoiced }}</strong>
                </div>
              </div>
              <div class="voice-library-meta">
                <span>音色库</span>
                <span>{{ voiceProfiles.length }} 条</span>
              </div>
              <div class="voice-library">
                <div v-for="voice in voiceProfiles" :key="voice.id" class="voice-library-item">
                  <div class="voice-library-head">
                    <span class="voice-library-name">{{ voice.label }}</span>
                    <span class="tag">{{ voice.gender }}</span>
                  </div>
                  <div class="voice-library-traits">{{ voice.traits }}</div>
                  <div class="voice-library-fit">{{ voice.suitable }}</div>
                </div>
              </div>
            </aside>

            <div class="voice-grid">
              <div v-for="c in chars" :key="c.id" class="card voice-card">
                <div class="voice-card-head">
                  <div class="voice-char">
                    <div class="char-avatar lg">{{ c.name?.[0] || '?' }}</div>
                    <div class="voice-name">
                      <div class="voice-name-row">
                        <div class="extract-name">{{ c.name }}</div>
                        <span class="tag" :class="(c.voice_style || c.voiceStyle) ? 'tag-success' : ''">{{ (c.voice_style || c.voiceStyle) ? '已分配' : '待分配' }}</span>
                      </div>
                      <div class="extract-meta">{{ c.role || '角色' }}</div>
                    </div>
                  </div>
                </div>

                <div class="voice-card-copy">
                  <div class="voice-card-text">{{ c.description || c.personality || c.appearance || '暂无角色描述，可根据人物定位手动挑选音色。' }}</div>
                </div>

                <div class="voice-select-block">
                  <span class="voice-block-label">选择音色</span>
                  <BaseSelect
                    :model-value="c.voice_style || c.voiceStyle || ''"
                    :options="voiceSelectOptions"
                    placeholder="选择音色"
                    searchable
                    style="width:100%"
                    @update:model-value="updateCharVoice(c.id, $event)"
                  />
                </div>

                <div v-if="getVoiceProfile(c.voice_style || c.voiceStyle)" class="voice-profile-card">
                  <div class="voice-profile-head">
                    <span class="voice-profile-name">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.label }}</span>
                    <span class="tag">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.gender }}</span>
                  </div>
                  <div class="voice-profile-traits">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.traits }}</div>
                  <div class="voice-profile-fit">{{ getVoiceProfile(c.voice_style || c.voiceStyle)?.suitable }}</div>
                </div>

                <div class="voice-actions-row">
                  <button class="btn btn-sm" :disabled="!(c.voice_style || c.voiceStyle) || isPendingVoiceSample(c.id)" @click="genSample(c.id)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    {{ isPendingVoiceSample(c.id) ? '试听生成中' : ((c.voice_sample_url || c.voiceSampleUrl) ? '重新试听' : '生成试听') }}
                  </button>
                  <span class="dim" style="font-size:11px">{{ isPendingVoiceSample(c.id) ? '任务已加入队列，完成后会自动刷新' : ((c.voice_sample_url || c.voiceSampleUrl) ? '已生成声音样本，可直接播放' : '生成后可快速确认角色声音') }}</span>
                </div>
                <div v-if="voiceSampleError(c.id)" class="prod-error">{{ voiceSampleError(c.id) }}</div>

                <div v-if="c.voice_sample_url || c.voiceSampleUrl" class="voice-player">
                  <audio :src="'/' + (c.voice_sample_url || c.voiceSampleUrl)" controls preload="none" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 4: Storyboard -->
        <div v-else-if="scriptStep === 4" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">05</span>
                <span class="step-name">分镜列表</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="sbs.length" class="char-count">{{ sbs.length }} 镜头 · {{ totalDuration }}s</span>
              <span v-if="isImageStory && sbs.length" class="tag" :class="narrationCount === sbs.length ? 'tag-success' : ''">
                {{ usesOriginalNarrationText ? '原文TTS' : '旁白' }} {{ narrationCount }}/{{ sbs.length }}
              </span>
              <span v-if="sbs.length" class="tag" :class="storyRichShotCount === sbs.length ? 'tag-success' : ''">
                故事信号 {{ storyRichShotCount }}/{{ sbs.length }}
              </span>
              <button v-if="sbs.length" class="btn btn-sm" @click="addShot">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                添加
              </button>
              <template v-if="!sbs.length">
                <span class="locked-config">视频模型 · {{ lockedVideoConfigLabel }}</span>
              </template>
              <button class="btn btn-sm" :disabled="rn" @click="doBreakdown">
                <Loader2 v-if="rt === 'storyboard_breaker'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ sbs.length ? '重新拆解' : 'AI 拆解分镜' }}
              </button>
              <button v-if="sbs.length" class="btn btn-sm primary" :disabled="autoSplitPreview.loading || autoSplitPreview.executing" @click="openAutoSplitPreview" title="先检测旁白+对白过长的镜头，预览后再确认细分">
                <Loader2 v-if="autoSplitPreview.loading" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                检测并细分超载
              </button>
              <button v-if="sbs.length && canGenerateAINarration" class="btn btn-sm" :disabled="rn" @click="doNarration" title="story_rewrite 模式下生成 AI 解说/旁白文案；direct_script 不会走这个入口">
                <Loader2 v-if="rt === 'narrator'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
                {{ narrationCount ? '重新生成解说文案' : 'AI 生成解说文案' }}
              </button>
              <button v-else-if="sbs.length && narrationCount < sbs.length" class="btn btn-sm" :disabled="rn" @click="doNarration" title="按原始正文回填逐镜头 TTS 文本，不调用 narrator">
                <Loader2 v-if="rt === 'narrator'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>
                回填原文TTS
              </button>
              <span v-if="narrationAudioActiveCount || narrationAudioFailedCount" class="tag mono" :class="narrationAudioFailedCount ? 'tag-error' : 'tag-warning'">
                解说音频
                <template v-if="narrationAudioQueuedCount"> 排队 {{ narrationAudioQueuedCount }}</template>
                <template v-if="narrationAudioRunningCount"> · 运行 {{ narrationAudioRunningCount }}</template>
                <template v-if="narrationAudioFailedCount"> · 失败 {{ narrationAudioFailedCount }}</template>
              </span>
              <button v-if="sbs.length && isImageStory" class="btn btn-sm" :disabled="batchNarrationAudioPending" @click="batchNarrationAudio" :title="batchNarrationAudioTitle">
                <Loader2 v-if="batchNarrationAudioPending" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                {{ batchNarrationAudioButtonText }}
              </button>
            </div>
          </div>

          <div v-if="sbs.length" class="split-layout">
            <!-- Shot List -->
            <div class="shot-list">
              <div class="shot-list-head">
                <div>
                  <div class="shot-list-title">镜头序列</div>
                  <div class="shot-list-sub">按镜头顺序检查内容与素材状态</div>
                </div>
                <span class="tag mono">{{ totalDuration }}s</span>
              </div>
              <div class="shot-list-body">
                <div
                  v-for="(sb, i) in sbs"
                  :key="sb.id"
                  :class="['shot-item', { active: selectedSb?.id === sb.id }]"
                  @click="selectedSb = sb"
                >
                  <div class="shot-item-header">
                    <div class="shot-num">#{{ String(i+1).padStart(2,'0') }}</div>
                    <span class="tag" style="font-size:10px">{{ sb.shot_type || sb.shotType || '—' }}</span>
                    <span v-if="getStoryboardCharacterIds(sb).length" class="tag" style="font-size:10px">{{ getStoryboardCharacterIds(sb).length }} 角色</span>
                    <div class="shot-status">
                      <div v-if="sb.imageUrl || sb.composedImage || sb.firstFrameImage" class="shot-dot has-img" title="已生成图片"></div>
                      <div v-if="sb.videoUrl || sb.composedVideoUrl" class="shot-dot has-video" title="已生成视频"></div>
                      <div v-if="sb.dialogue" class="shot-dot has-dialogue" title="有对白"></div>
                      <div v-if="sb.bgm_audio_url || sb.bgmAudioUrl" class="shot-dot has-bgm" title="有配乐"></div>
                      <div v-if="sb.sfx_audio_url || sb.sfxAudioUrl" class="shot-dot has-sfx" title="有音效"></div>
                      <div v-if="sb.ambient_audio_url || sb.ambientAudioUrl" class="shot-dot has-ambient" title="有环境音"></div>
                    </div>
                  </div>
                  <div class="shot-body">
                    <div class="shot-desc">{{ sb.description || sb.title || '无描述' }}</div>
                  </div>
                  <div class="shot-meta">
                    <span class="mono dim" style="font-size:10px">{{ sb.duration || 8 }}s</span>
                    <span v-if="sb.location" class="shot-location">{{ sb.location }}</span>
                    <span v-if="getStoryboardCharacterNames(sb).length" class="shot-location">{{ getStoryboardCharacterNames(sb).join(' / ') }}</span>
                    <span v-if="sb.dialogue" class="shot-dialogue">{{ sb.dialogue }}</span>
                  </div>
                  <div v-if="hasAudioCheckAssets(sb)" class="audio-check-list shot-audio-check" @click.stop>
                    <div v-for="asset in getAudioCheckAssets(sb)" :key="asset.kind + asset.url" class="audio-check-row">
                      <span :class="['audio-check-label', `audio-check-${asset.kind}`]">{{ asset.label }}</span>
                      <span class="audio-check-name" :title="asset.name">{{ asset.name }}</span>
                      <audio :src="asset.url" controls preload="none" class="audio-check-player"></audio>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Detail Panel -->
            <div class="detail-panel" v-if="selectedSb">
                <div class="detail-head">
                  <div class="detail-head-copy">
                    <span class="detail-head-title">镜头 #{{ sbs.indexOf(selectedSb) + 1 }}</span>
                  <span class="detail-head-sub">{{ selectedSb.title || `镜头 ${sbs.indexOf(selectedSb) + 1}` }} · {{ selectedSb.shot_type || selectedSb.shotType || '未设置景别' }}</span>
                  </div>
                  <span class="tag mono">{{ (selectedSb.duration || 8) }}s</span>
                  <button class="btn btn-ghost btn-icon ml-auto" style="color:var(--error)" @click="deleteShot(selectedSb)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  </button>
              </div>
              <div class="detail-body">
                <div class="detail-hero">
                  <div class="detail-hero-copy">
                    <div class="detail-hero-label">镜头概览</div>
                    <div class="detail-hero-text">{{ selectedSb.description || selectedSb.title || '当前镜头还没有画面描述，建议先补充核心动作和构图。' }}</div>
                    <div class="detail-status-row">
                      <span class="tag">{{ getSceneName(selectedSb) }}</span>
                      <span class="tag">{{ selectedSb.angle || '未设角度' }}</span>
                      <span class="tag">{{ selectedSb.movement || '未设运镜' }}</span>
                      <span class="tag" :class="getFirstFrame(selectedSb) ? 'tag-success' : ''">首帧 {{ getFirstFrame(selectedSb) ? '已生成' : '待生成' }}</span>
                      <span class="tag" :class="getLastFrame(selectedSb) ? 'tag-success' : ''">尾帧 {{ getLastFrame(selectedSb) ? '已生成' : '待生成' }}</span>
                      <span class="tag" :class="hasVid(selectedSb) ? 'tag-success' : ''">视频 {{ hasVid(selectedSb) ? '已生成' : '待生成' }}</span>
                    </div>
                  </div>
                  <div class="detail-preview-grid">
                    <div class="detail-preview-card">
                      <div class="detail-preview-title">首帧</div>
                      <div class="detail-preview-media">
                        <img
                          v-if="getFirstFrame(selectedSb)"
                          :src="'/' + getFirstFrame(selectedSb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getFirstFrame(selectedSb), `镜头 #${sbs.indexOf(selectedSb) + 1} 首帧`)"
                        />
                        <div v-else class="detail-preview-empty">待生成</div>
                      </div>
                    </div>
                    <div class="detail-preview-card">
                      <div class="detail-preview-title">尾帧</div>
                      <div class="detail-preview-media">
                        <img
                          v-if="getLastFrame(selectedSb)"
                          :src="'/' + getLastFrame(selectedSb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getLastFrame(selectedSb), `镜头 #${sbs.indexOf(selectedSb) + 1} 尾帧`)"
                        />
                        <div v-else class="detail-preview-empty">待生成</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="detail-section story-verify-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">故事保真检查</span>
                    <span class="detail-section-copy">直接看当前镜头有没有承住内心、背景、因果和悬念</span>
                  </div>
                  <div class="story-verify-stats">
                    <div class="story-verify-stat">
                      <span>有效镜头</span>
                      <strong>{{ storyRichShotCount }}/{{ sbs.length }}</strong>
                    </div>
                    <div v-for="item in storySignalSummary" :key="item.label" class="story-verify-stat">
                      <span>{{ item.label }}</span>
                      <strong>{{ item.count }}</strong>
                    </div>
                  </div>
                  <div class="story-verify-tags">
                    <span v-for="signal in selectedSbStorySignals" :key="signal" class="story-signal-tag">{{ signal }}</span>
                    <span v-if="!selectedSbStorySignals.length" class="story-signal-tag muted">偏动作镜头</span>
                  </div>
                  <div class="story-verify-copy">
                    {{ selectedSbStorySummary }}
                  </div>
                  <div class="story-carrier-list">
                    <div v-for="item in selectedSbStoryCarriers" :key="item.label" class="story-carrier-item">
                      <span class="story-carrier-label">{{ item.label }}</span>
                      <span class="story-carrier-text">{{ item.value }}</span>
                    </div>
                  </div>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">镜头结构</span>
                    <span class="detail-section-copy">景别、角度、运镜、场景绑定和时长</span>
                  </div>
                  <div class="field-grid field-grid-4">
                    <label class="field">
                      <span class="field-label">标题</span>
                      <input :value="selectedSb.title || ''" class="input"
                        @blur="updateField(selectedSb, 'title', $event.target.value)" placeholder="如：雪地逼近" />
                    </label>
                    <label class="field">
                      <span class="field-label">景别</span>
                      <input
                        list="shot-type-list"
                        :value="selectedSb.shot_type || selectedSb.shotType || ''"
                        class="input"
                        placeholder="选择或输入景别"
                        @change="updateField(selectedSb, 'shot_type', $event.target.value)"
                      />
                      <datalist id="shot-type-list">
                        <option v-for="t in shotTypes" :key="t" :value="t" />
                      </datalist>
                    </label>
                    <label class="field">
                      <span class="field-label">角度</span>
                      <input
                        list="shot-angle-list"
                        :value="selectedSb.angle || ''"
                        class="input"
                        placeholder="选择或输入角度"
                        @change="updateField(selectedSb, 'angle', $event.target.value)"
                      />
                      <datalist id="shot-angle-list">
                        <option v-for="t in shotAngles" :key="t" :value="t" />
                      </datalist>
                    </label>
                    <label class="field">
                      <span class="field-label">运镜</span>
                      <input
                        list="shot-movement-list"
                        :value="selectedSb.movement || ''"
                        class="input"
                        placeholder="选择或输入运镜"
                        @change="updateField(selectedSb, 'movement', $event.target.value)"
                      />
                      <datalist id="shot-movement-list">
                        <option v-for="t in shotMovements" :key="t" :value="t" />
                      </datalist>
                    </label>
                  </div>
                  <div class="field-grid field-grid-4">
                    <label class="field">
                      <span class="field-label">绑定角色</span>
                      <div class="role-pills">
                        <button
                          v-for="char in chars"
                          :key="char.id"
                          type="button"
                          :class="['role-pill', { active: isStoryboardCharacterSelected(selectedSb, char.id) }]"
                          @click="toggleStoryboardCharacter(selectedSb, char.id)"
                        >
                          {{ char.name }}
                        </button>
                        <span v-if="!chars.length" class="dim" style="font-size:12px">当前集还没有角色</span>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">绑定场景</span>
                      <select class="input" :value="selectedSb.scene_id || selectedSb.sceneId || ''"
                        @change="updateField(selectedSb, 'scene_id', $event.target.value ? Number($event.target.value) : null)">
                        <option value="">未绑定场景</option>
                        <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
                          {{ scene.location }} · {{ scene.time || '未设时间' }}
                        </option>
                      </select>
                    </label>
                    <label class="field">
                      <span class="field-label">地点</span>
                      <input :value="selectedSb.location || ''" class="input"
                        @blur="updateField(selectedSb, 'location', $event.target.value)" placeholder="场景地点" />
                    </label>
                    <label class="field">
                      <span class="field-label">时间</span>
                      <input :value="selectedSb.time || ''" class="input"
                        @blur="updateField(selectedSb, 'time', $event.target.value)" placeholder="如：深夜 / 清晨" />
                    </label>
                    <label class="field">
                      <span class="field-label">时长</span>
                      <input :value="selectedSb.duration || 8" class="input" type="number" min="1" max="60"
                        @blur="updateField(selectedSb, 'duration', Number($event.target.value))" />
                    </label>
                  </div>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">画面语义</span>
                    <span class="detail-section-copy">动作、结果、氛围和对白</span>
                  </div>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">动作</span>
                      <textarea :value="selectedSb.action || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'action', $event.target.value)" placeholder="谁在做什么，表情和动作细节是什么" />
                    </label>
                    <label class="field">
                      <span class="field-label">结果</span>
                      <textarea :value="selectedSb.result || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'result', $event.target.value)" placeholder="镜头结束时的状态变化或画面结果" />
                    </label>
                  </div>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">画面描述</span>
                      <textarea :value="selectedSb.description || ''" class="textarea" rows="4"
                        @blur="updateField(selectedSb, 'description', $event.target.value)" placeholder="描述画面内容..." />
                    </label>
                    <label class="field">
                      <span class="field-label">氛围</span>
                      <textarea :value="selectedSb.atmosphere || ''" class="textarea" rows="4"
                        @blur="updateField(selectedSb, 'atmosphere', $event.target.value)" placeholder="光线、色调、空气感、环境氛围" />
                    </label>
                  </div>
                  <label class="field">
                    <span class="field-label">对白</span>
                    <textarea :value="selectedSb.dialogue || ''" class="textarea" rows="3"
                      @blur="updateField(selectedSb, 'dialogue', $event.target.value)" placeholder="角色名：台词内容（角色原声，关键时刻点睛）" />
                  </label>
                  <label class="field">
                    <span class="field-label">{{ narrationFieldLabel }}</span>
                    <textarea :value="selectedSb.narration || ''" class="textarea" rows="3"
                      @blur="updateField(selectedSb, 'narration', $event.target.value)" :placeholder="narrationFieldPlaceholder" />
                    <div class="narration-audio-row">
                      <audio v-if="hasNarrationAudio(selectedSb)" :src="'/' + getNarrationAudioUrl(selectedSb)" controls preload="none" class="dub-audio" />
                      <button class="btn btn-sm" :disabled="isPendingShotTTS(selectedSb.id)" @click="genShotTTS(selectedSb)">
                        {{ isPendingShotTTS(selectedSb.id) ? '生成中' : hasNarrationAudio(selectedSb) ? '重新生成解说音频' : '生成解说音频' }}
                      </button>
                    </div>
                  </label>
                </div>
                <div class="detail-section">
                  <div class="detail-section-head">
                    <span class="detail-section-title">生成提示</span>
                    <span class="detail-section-copy">分别服务图片、视频、配乐和音效生成</span>
                  </div>
                  <label class="field">
                    <span class="field-label">静态画面提示词</span>
                    <textarea :value="selectedSb.image_prompt || selectedSb.imagePrompt || ''" class="textarea" rows="4"
                      @blur="updateField(selectedSb, 'image_prompt', $event.target.value)" placeholder="用于首帧、尾帧和镜头图片的单帧画面提示词" />
                  </label>
                  <label class="field">
                    <span class="field-label">视频提示词</span>
                    <textarea :value="selectedSb.video_prompt || selectedSb.videoPrompt || ''" class="textarea" rows="5"
                      @blur="updateField(selectedSb, 'video_prompt', $event.target.value)" placeholder="按 3 秒分段的视频提示词..." />
                  </label>
                  <div class="field-grid field-grid-2">
                    <label class="field">
                      <span class="field-label">配乐提示词</span>
                      <textarea :value="selectedSb.bgm_prompt || selectedSb.bgmPrompt || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'bgm_prompt', $event.target.value)" placeholder="如：压抑低频弦乐，缓慢推进" />
                      <div v-if="selectedSb.bgm_audio_url || selectedSb.bgmAudioUrl" class="bgm-library-row">
                        <audio :src="'/' + (selectedSb.bgm_audio_url || selectedSb.bgmAudioUrl)" controls preload="none" class="dub-audio" />
                      </div>
                      <div v-if="bgmLibraryInfo" class="bgm-library-meta">
                        <div class="bgm-meta-line">
                          <span class="bgm-meta-pill" :class="'source-' + bgmLibraryInfo.source">{{ bgmLibraryInfo.source }}</span>
                          <span v-if="bgmLibraryInfo.emotion_bucket" class="bgm-meta-pill">{{ bgmLibraryInfo.emotion_bucket }}</span>
                          <span v-if="bgmLibraryInfo.intensity" class="bgm-meta-pill">{{ bgmLibraryInfo.intensity }}</span>
                        </div>
                        <div v-if="bgmLibraryInfo.tags?.length" class="bgm-meta-tags">
                          <span v-for="tag in bgmLibraryInfo.tags" :key="tag" class="bgm-tag">{{ tag }}</span>
                        </div>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">音效提示词</span>
                      <textarea :value="selectedSb.sound_effect || selectedSb.soundEffect || ''" class="textarea" rows="3"
                        @blur="updateField(selectedSb, 'sound_effect', $event.target.value)" placeholder="如：风雪声、脚踩积雪、衣料摩擦声" />
                      <div v-if="selectedSb.sfx_audio_url || selectedSb.sfxAudioUrl" class="bgm-library-row">
                        <audio :src="'/' + (selectedSb.sfx_audio_url || selectedSb.sfxAudioUrl)" controls preload="none" class="dub-audio" />
                      </div>
                      <div v-if="sfxLibraryInfo" class="bgm-library-meta">
                        <div class="bgm-meta-line">
                          <span class="bgm-meta-pill">{{ sfxLibraryInfo.pack || 'SFX' }}</span>
                          <span v-if="sfxLibraryInfo.keywords?.length" class="bgm-meta-tags">
                            <span v-for="tag in sfxLibraryInfo.keywords.slice(0, 6)" :key="tag" class="bgm-tag">{{ tag }}</span>
                          </span>
                        </div>
                      </div>
                      <div v-else class="bgm-library-meta">
                        <div class="bgm-meta-line"><span class="bgm-meta-pill">无</span></div>
                      </div>
                      <div v-if="selectedSb.ambient_audio_url || selectedSb.ambientAudioUrl" class="bgm-library-row" style="margin-top:8px">
                        <audio :src="'/' + (selectedSb.ambient_audio_url || selectedSb.ambientAudioUrl)" controls preload="none" class="dub-audio" />
                      </div>
                      <div v-if="ambientLibraryInfo" class="bgm-library-meta">
                        <div class="bgm-meta-line">
                          <span class="bgm-meta-pill">Ambient</span>
                          <span v-if="ambientLibraryInfo.pack" class="bgm-meta-pill">{{ ambientLibraryInfo.pack }}</span>
                          <span v-if="ambientLibraryInfo.keywords?.length" class="bgm-meta-tags">
                            <span v-for="tag in ambientLibraryInfo.keywords.slice(0, 6)" :key="tag" class="bgm-tag">{{ tag }}</span>
                          </span>
                        </div>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="rn && rt === 'storyboard_breaker'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">正在拆解分镜并生成提示词...</div>
          </div>

          <div v-else class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/>
              </svg>
            </div>
            <div class="empty-title">将剧本拆解为分镜序列</div>
            <div class="empty-desc">AI 自动分析剧本，生成镜头列表和视频提示词，并尽量保留内心、背景和上下文承接。</div>
            <div class="locked-config-banner">当前集视频模型：{{ lockedVideoConfigLabel }}</div>
            <button class="btn btn-primary" @click="doBreakdown">
              <Loader2 v-if="rt === 'storyboard_breaker'" :size="13" class="animate-spin" />
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              AI 拆解分镜
            </button>
          </div>
        </div>

      </div>

      <!-- ===== PRODUCTION PANEL ===== -->
      <div v-else-if="panel === 'production'" class="content-panel">
        <!-- Guard: need at least characters, scenes or storyboards -->
        <div v-if="!chars.length && !scenes.length && !sbs.length" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="empty-title">尚未准备就绪</div>
          <div class="empty-desc">请先完成角色/场景提取或分镜拆解</div>
          <button class="btn btn-primary" @click="panel = 'script'">前往剧本</button>
        </div>

        <template v-else>
          <div class="step-toolbar prod-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                <span class="step-name">制作工作台</span>
              </div>
            </div>
            <div class="prod-tabs">
              <button
                v-for="t in prodTabDefs"
                :key="t.id"
                :class="['prod-tab', { active: prodTab === t.id }]"
                @click="prodTab = t.id"
              >
                <component :is="t.icon" :size="11" />
                {{ t.label }}
                <span v-if="t.badge" class="prod-tab-badge">{{ t.badge }}</span>
              </button>
            </div>
          </div>

          <!-- Sub: Characters -->
          <div v-if="prodTab === 'chars'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ visualChars.length }} 个需生成形象角色</span>
              <span class="tag">{{ lockedImageConfigLabel }}</span>
              <span v-if="chars.length > visualChars.length" class="tag">旁白仅保留声音</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchCharImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量生成
                </button>
              </div>
            </div>
            <div class="asset-grid">
              <div v-for="c in visualChars" :key="c.id" class="card asset-card">
                <div class="asset-cover">
                  <img
                    v-if="c.image_url || c.imageUrl"
                    :src="'/' + (c.image_url || c.imageUrl)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + (c.image_url || c.imageUrl), `${c.name} 角色形象`)"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(c.image_url || c.imageUrl) ? 'is-ready' : (isPendingCharImage(c.id) ? 'is-pending' : '')">
                    {{ (c.image_url || c.imageUrl) ? '已生成' : (isPendingCharImage(c.id) ? (charImageStatusText(c.id) || '生成中') : '待生成') }}
                  </span>
                </div>
                <div class="asset-body">
                  <div class="asset-name">{{ c.name }}</div>
                  <div class="asset-meta dim">{{ c.role || '角色' }}</div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (c.image_url || c.imageUrl) && 'ok', isPendingCharImage(c.id) && 'pending']" />
                  <span class="dim" style="font-size:10px">{{ charImageStatusText(c.id) || ((c.image_url || c.imageUrl) ? '已生成' : (isPendingCharImage(c.id) ? '生成中' : '待生成')) }}</span>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingCharImage(c.id)" @click="genCharImg(c.id)">{{ isPendingCharImage(c.id) ? '生成中' : '生成' }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Scenes -->
          <div v-else-if="prodTab === 'scenes'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ scenes.length }} 个场景</span>
              <span class="tag">{{ lockedImageConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchSceneImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量生成
                </button>
              </div>
            </div>
            <div class="asset-grid">
              <div v-for="s in scenes" :key="s.id" class="card asset-card">
                <div class="asset-cover wide">
                  <img
                    v-if="s.image_url || s.imageUrl"
                    :src="'/' + (s.image_url || s.imageUrl)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + (s.image_url || s.imageUrl), `${s.location} 场景图`)"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(s.image_url || s.imageUrl) ? 'is-ready' : (isPendingSceneImage(s.id) ? 'is-pending' : '')">{{ (s.image_url || s.imageUrl) ? '已生成' : (isPendingSceneImage(s.id) ? '生成中' : '待生成') }}</span>
                </div>
                <div class="asset-body">
                  <div class="asset-name">{{ s.location }}</div>
                  <div class="asset-meta dim">{{ s.time || '—' }}</div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (s.image_url || s.imageUrl) && 'ok', isPendingSceneImage(s.id) && 'pending']" />
                  <span class="dim" style="font-size:10px">{{ (s.image_url || s.imageUrl) ? '已生成' : (isPendingSceneImage(s.id) ? '生成中' : '待生成') }}</span>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingSceneImage(s.id)" @click="genSceneImg(s.id)">{{ isPendingSceneImage(s.id) ? '生成中' : '生成' }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Dubbing -->
          <div v-else-if="prodTab === 'dubbing'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ ttsEligibleCount }} 条可生成配音</span>
              <span class="tag mono">{{ ttsGeneratedCount }}/{{ ttsEligibleCount }} 已生成</span>
              <span v-if="ttsActiveCount" class="tag tag-warning mono">排队 {{ ttsQueuedCount }} · 运行 {{ ttsRunningCount }}</span>
              <span v-if="ttsFailedCount" class="tag tag-error mono">失败 {{ ttsFailedCount }}</span>
              <span class="tag">{{ lockedAudioConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchShotTTS">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                  批量生成
                </button>
                <button v-if="ttsGeneratedCount" class="btn btn-sm" @click="regenAllTTS" title="用当前音色重新生成所有已配音镜头（改音色后用）">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  重新生成全部
                </button>
              </div>
            </div>

            <div v-if="!ttsEligibleCount" class="step-empty" style="min-height:260px">
              <div class="empty-visual">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              </div>
              <div class="empty-title">当前没有可生成的配音</div>
              <div class="empty-desc">先在分镜里填写“角色名：台词”或“旁白：文案”，这里就会出现待生成的语音镜头。</div>
            </div>

            <div v-else class="dub-grid">
                <div v-for="(sb, i) in sbs.filter(hasDialogue)" :key="sb.id" class="card dub-card">
                  <div class="dub-head">
                    <div class="dub-copy">
                    <div class="dub-title">
                      <span class="frame-num">#{{ String(sb.storyboard_number || sb.storyboardNumber || i + 1).padStart(2, '0') }}</span>
                      <span class="frame-badge">{{ getDialogueSpeaker(sb) }}</span>
                    </div>
                    <div class="dub-desc">{{ getDialogueText(sb) || '未填写文本' }}</div>
                    </div>
                    <span
                      class="tag"
                      :class="isPendingShotTTS(sb.id) ? 'tag-warning' : hasTTS(sb) ? 'tag-success' : shotTTSError(sb.id) ? 'tag-error' : ''"
                    >
                      {{ isPendingShotTTS(sb.id) ? '生成中' : hasTTS(sb) ? '已生成' : shotTTSError(sb.id) ? '失败' : '待生成' }}
                    </span>
                  </div>
                <div class="dub-meta">
                  <span class="dim">{{ sb.shot_type || sb.shotType || '未设景别' }}</span>
                  <span class="dim">{{ sb.duration || 8 }}s</span>
                  <span class="dim">{{ sb.location || '未设地点' }}</span>
                </div>
                <div class="dub-foot">
                  <audio v-if="hasTTS(sb)" :src="'/' + getTTSUrl(sb)" controls preload="none" class="dub-audio" />
                  <div v-else class="dim" style="font-size:12px">{{ isPendingShotTTS(sb.id) ? '配音任务已加入队列' : '尚未生成语音文件' }}</div>
                  <button class="btn btn-sm ml-auto" :disabled="isPendingShotTTS(sb.id)" @click="genShotTTS(sb)">{{ isPendingShotTTS(sb.id) ? '生成中' : hasTTS(sb) ? '重新生成' : '生成配音' }}</button>
                </div>
                <div v-if="shotTTSError(sb.id)" class="prod-error">{{ shotTTSError(sb.id) }}</div>
              </div>
            </div>
          </div>

          <!-- Sub: Shots -->
          <div v-else-if="prodTab === 'shots'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
              <span class="tag mono">{{ shotImgCount }}/{{ sbs.length }} 已有帧图</span>
              <span class="tag">{{ lockedImageConfigLabel }}</span>
              <div class="ml-auto flex gap-1">
                <BaseSelect v-model="frameMode" :options="frameModeOptions" placeholder="帧模式" searchable style="width:100px" />
                <button class="btn btn-sm" @click="batchShotFrames">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  批量生成
                </button>
                <button v-if="gridImagePath" class="btn btn-sm" @click="reopenGridPreview">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  查看当前宫格图
                </button>
                <button class="btn btn-primary btn-sm" @click="openGridTool">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  宫格图工具
                </button>
              </div>
            </div>

            <div v-if="gridHistory.length" class="grid-history-panel">
              <div v-if="gridImagePath" class="latest-grid-strip">
                <button class="latest-grid-strip-thumb" @click="openImageViewer('/' + gridImagePath, '当前宫格图')">
                  <img :src="'/' + gridImagePath" class="previewable-image" />
                </button>
                <div class="latest-grid-strip-copy">
                  <div class="latest-grid-strip-head">
                    <span class="tag mono">{{ gridActualLayout.rows }}x{{ gridActualLayout.cols }}</span>
                    <span class="tag" v-if="gridRecoveredMode">{{ gridRecoveredMode }}</span>
                  </div>
                  <div class="latest-grid-strip-title">当前宫格图</div>
                  <div class="latest-grid-strip-meta">
                    <span v-if="gridRecoveredAt">{{ gridRecoveredAt }}</span>
                    <span>可继续切割并分配</span>
                  </div>
                </div>
                <div class="latest-grid-strip-actions">
                  <button class="btn btn-sm" @click="reopenGridPreview">预览</button>
                  <button class="btn btn-primary btn-sm" @click="continueGridSplit">继续切割</button>
                </div>
              </div>
              <div class="grid-history-head">
                <div>
                  <div class="grid-history-title">历史宫格图</div>
                  <div class="grid-history-subtitle">按需展开切换不同宫格图，不默认占用第一屏</div>
                </div>
                <button class="btn btn-sm" @click="showAllGridHistory = !showAllGridHistory">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline :points="showAllGridHistory ? '18 15 12 9 6 15' : '6 9 12 15 18 9'"/></svg>
                  {{ showAllGridHistory ? '收起历史宫格图' : `展开全部 (${gridHistory.length})` }}
                </button>
              </div>
              <div v-if="showAllGridHistory" class="grid-history-list">
                <button
                  v-for="item in gridHistory"
                  :key="item.id"
                  :class="['grid-history-item', { active: item.localPath === gridImagePath }]"
                  @click="selectGridHistory(item)"
                >
                  <div class="grid-history-thumb">
                    <img :src="'/' + item.localPath" class="previewable-image" />
                  </div>
                  <div class="grid-history-copy">
                    <div class="grid-history-tags">
                      <span class="tag mono">#{{ item.id }}</span>
                      <span class="tag mono">{{ item.layout.rows }}x{{ item.layout.cols }}</span>
                      <span class="tag">{{ item.modeLabel }}</span>
                    </div>
                    <div class="grid-history-meta">{{ item.createdAtLabel }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div class="frame-scroll">
              <div class="frame-grid">
                <div v-for="(sb, i) in sbs" :key="sb.id"
                  :class="['frame-row', 'card', { active: selectedSb?.id === sb.id }]"
                  @click="selectedSb = sb">
                  <!-- Info: number + type + desc -->
                  <div class="frame-info">
                    <div class="frame-top">
                      <span class="frame-num">#{{ String(i+1).padStart(2,'0') }}</span>
                      <span class="frame-badge">{{ sb.shot_type || sb.shotType || '—' }}</span>
                    </div>
                    <div class="frame-desc">{{ sb.description || sb.title || '—' }}</div>
                    <div class="frame-meta">
                      <span :class="['dot', getFirstFrame(sb) && 'ok', isPendingShotFrame(sb.id, 'first_frame') && 'pending']" />
                      <span class="dim" style="font-size:11px">首帧</span>
                      <span v-if="frameMode === 'first_last'" style="display:flex;align-items:center;gap:4px">
                        <span :class="['dot', getLastFrame(sb) && 'ok', isPendingShotFrame(sb.id, 'last_frame') && 'pending']" />
                        <span class="dim" style="font-size:11px">尾帧</span>
                      </span>
                    </div>
                  </div>
                  <!-- Thumbnails -->
                  <div class="frame-thumbs">
                    <div class="frame-thumb-wrap">
                      <div class="frame-thumb" @click.stop="!isPendingShotFrame(sb.id, 'first_frame') && genShotFrame(sb, 'first_frame')">
                        <img
                          v-if="getFirstFrame(sb)"
                          :src="'/' + getFirstFrame(sb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getFirstFrame(sb), `镜头 #${String(i + 1).padStart(2, '0')} 首帧`)"
                        />
                        <div v-else class="frame-thumb-empty" :class="{ 'frame-thumb-failed': isFailedShotFrame(sb.id, 'first_frame') }" :title="shotFrameFailMessage(sb.id, 'first_frame')">
                          <Loader2 v-if="isPendingShotFrame(sb.id, 'first_frame')" :size="14" class="animate-spin" />
                          <svg v-else-if="isFailedShotFrame(sb.id, 'first_frame')" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <span v-if="getFirstFrame(sb)" class="frame-re">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        </span>
                      </div>
                      <span class="frame-thumb-label" :class="{ 'label-failed': isFailedShotFrame(sb.id, 'first_frame') }">{{ isPendingShotFrame(sb.id, 'first_frame') ? '首帧生成中' : isFailedShotFrame(sb.id, 'first_frame') ? '失败 点击重试' : '首帧' }}</span>
                      <div v-if="isFailedShotFrame(sb.id, 'first_frame') && shotFrameFailMessage(sb.id, 'first_frame')" class="frame-thumb-error">{{ shotFrameFailMessage(sb.id, 'first_frame') }}</div>
                    </div>
                    <div v-if="frameMode === 'first_last'" class="frame-thumb-wrap">
                      <div class="frame-thumb" @click.stop="!isPendingShotFrame(sb.id, 'last_frame') && genShotFrame(sb, 'last_frame')">
                        <img
                          v-if="getLastFrame(sb)"
                          :src="'/' + getLastFrame(sb)"
                          class="previewable-image"
                          @click.stop="openImageViewer('/' + getLastFrame(sb), `镜头 #${String(i + 1).padStart(2, '0')} 尾帧`)"
                        />
                        <div v-else class="frame-thumb-empty" :class="{ 'frame-thumb-failed': isFailedShotFrame(sb.id, 'last_frame') }" :title="shotFrameFailMessage(sb.id, 'last_frame')">
                          <Loader2 v-if="isPendingShotFrame(sb.id, 'last_frame')" :size="14" class="animate-spin" />
                          <svg v-else-if="isFailedShotFrame(sb.id, 'last_frame')" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </div>
                        <span v-if="getLastFrame(sb)" class="frame-re">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        </span>
                      </div>
                      <span class="frame-thumb-label" :class="{ 'label-failed': isFailedShotFrame(sb.id, 'last_frame') }">{{ isPendingShotFrame(sb.id, 'last_frame') ? '尾帧生成中' : isFailedShotFrame(sb.id, 'last_frame') ? '失败 点击重试' : '尾帧' }}</span>
                      <div v-if="isFailedShotFrame(sb.id, 'last_frame') && shotFrameFailMessage(sb.id, 'last_frame')" class="frame-thumb-error">{{ shotFrameFailMessage(sb.id, 'last_frame') }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Grid Tool Dialog -->
            <div v-if="gridDialog" class="overlay" @click.self="gridDialog = false">
              <div class="card grid-tool">
                <div class="grid-tool-head">
                  <span style="font-size:15px;font-weight:600;font-family:var(--font-display)">宫格图工具</span>
                  <button class="btn btn-ghost btn-icon ml-auto" @click="gridDialog = false">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>

                <!-- Step 0: Config -->
                <div v-if="gridStep === 0" class="grid-tool-body">
                  <div class="grid-mode-tabs">
                    <button v-for="m in gridModes" :key="m.id"
                      :class="['grid-mode-tab', { active: gridMode === m.id }]"
                      @click="gridMode = m.id; gridSelected = []; gridSingleTarget = null; gridAssignmentsState = []">
                      <span style="font-weight:600">{{ m.label }}</span>
                      <span class="dim" style="font-size:11px">{{ m.desc }}</span>
                    </button>
                  </div>

                  <div class="grid-config">
                    <label class="field" style="flex:0 0 auto" v-if="gridMode !== 'multi_ref'">
                      <span class="field-label">宫格</span>
                      <BaseSelect v-model="gridLayout" :options="gridLayoutOptions" placeholder="宫格" style="width:90px" />
                    </label>
                    <div class="field" style="flex:1">
                      <span class="field-label">
                        {{ gridMode === 'multi_ref' ? '选择目标镜头' : '选择镜头' }}
                        <span class="dim" v-if="gridMode !== 'multi_ref'">(已选 {{ gridSelected.length }})</span>
                      </span>
                    </div>
                    <div style="align-self:flex-end" v-if="gridMode !== 'multi_ref'">
                      <button class="btn btn-sm" @click="gridSelectAll">{{ gridSelected.length === sbs.length ? '取消全选' : '全选' }}</button>
                    </div>
                  </div>

                  <div class="grid-pick-list">
                    <label v-for="(sb, i) in sbs" :key="sb.id"
                      :class="['grid-pick-item', { selected: gridMode === 'multi_ref' ? gridSingleTarget === sb.id : gridSelected.includes(sb.id) }]">
                      <input v-if="gridMode === 'multi_ref'" type="radio" :value="sb.id" v-model="gridSingleTarget" name="grid-target" />
                      <input v-else type="checkbox" :value="sb.id" v-model="gridSelected" />
                      <span class="mono" style="font-size:11px;width:28px">#{{ String(i+1).padStart(2,'0') }}</span>
                      <span class="truncate" style="flex:1;font-size:12px">{{ sb.description || sb.title || '—' }}</span>
                    </label>
                  </div>

                  <div class="grid-tool-foot">
                    <span v-if="gridCanStart" class="tag mono">{{ gridAutoLayout.rows }}x{{ gridAutoLayout.cols }} = {{ gridAutoLayout.rows * gridAutoLayout.cols }}格</span>
                    <span class="dim" style="font-size:11px">{{ gridPromptLoading ? gridPromptStatus : gridSummary }}</span>
                    <button class="btn btn-primary ml-auto" :disabled="!gridCanStart || gridPromptLoading" @click="generateGridPrompt">
                      <Loader2 v-if="gridPromptLoading" :size="12" class="animate-spin" />
                      <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      {{ gridPromptLoading ? '生成中' : '生成提示词' }}
                    </button>
                  </div>
                </div>

                <!-- Step 1: Prompt Preview -->
                <div v-else-if="gridStep === 1" class="grid-tool-body">
                  <div class="grid-prompt-summary">
                    <div class="grid-prompt-label">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                      宫格图提示词
                      <span v-if="gridPromptSource" class="tag ml-8">{{ gridPromptSource === 'agent' ? 'AI生成' : '模板兜底' }}</span>
                    </div>
                    <div class="grid-prompt-text">{{ gridPromptText || '（等待生成）' }}</div>
                  </div>

                  <div class="grid-blank-preview" :style="gridBlankStyle">
                    <div v-for="(cell, i) in gridCellPrompts" :key="i" class="grid-blank-cell">
                      <div class="grid-blank-cell-index">#{{ cell.shot_number }} {{ {first_frame:'首帧',last_frame:'尾帧',reference:'参考'}[cell.frame_type] || '' }}</div>
                      <div class="grid-blank-cell-desc">{{ cell.prompt }}</div>
                    </div>
                    <div v-for="i in Math.max(0, (gridAutoLayout.rows * gridAutoLayout.cols) - gridCellPrompts.length)" :key="'empty-'+i" class="grid-blank-cell empty">
                      <div class="grid-blank-cell-index">空</div>
                      <div class="grid-blank-cell-desc">—</div>
                    </div>
                  </div>

                  <div class="grid-tool-foot">
                    <button class="btn" @click="gridStep = 0">上一步</button>
                    <button class="btn ml-auto" @click="generateGridPrompt" :disabled="gridPromptLoading">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                      重新生成
                    </button>
                    <button class="btn btn-primary" @click="startGridGen">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      生成宫格图
                    </button>
                  </div>
                </div>

                <!-- Step 2: Generating -->
                <div v-else-if="gridStep === 2" class="grid-tool-body" style="align-items:center;justify-content:center;min-height:300px">
                  <Loader2 :size="28" class="animate-spin" style="color:var(--accent)" />
                  <div class="loading-text" style="margin-top:12px">宫格图生成中...</div>
                  <div class="dim" style="font-size:11px;margin-top:6px">{{ gridStatusText }}</div>
                </div>

                <!-- Step 3: Preview -->
                <div v-else-if="gridStep === 3" class="grid-tool-body grid-tool-body-preview">
                  <div class="grid-preview-layout">
                    <div class="grid-preview-pane">
                      <div class="grid-preview-wrap">
                        <div class="grid-preview-stage">
                          <img
                            :src="'/' + gridImagePath"
                            class="grid-preview-img previewable-image"
                            @click.stop="openImageViewer('/' + gridImagePath, '宫格图预览')"
                          />
                          <div class="grid-overlay" :style="gridOverlayStyle">
                            <button
                              v-for="(a, i) in gridAssignments"
                              :key="i"
                              type="button"
                              :class="['grid-overlay-cell', activeGridCell === i && 'active']"
                              @click="focusGridCell(i)"
                            >
                              <span class="grid-cell-label">{{ gridCellLabel(a) }}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                      <div class="grid-adjust-summary">
                        <span class="tag mono">{{ gridActualLayout.rows }}x{{ gridActualLayout.cols }} = {{ gridActualLayout.rows * gridActualLayout.cols }}格</span>
                        <span class="dim" style="font-size:12px">{{ gridAssignedCount }}/{{ gridAssignments.length }} 格已分配</span>
                        <span class="tag" v-if="gridAssignedCount < gridAssignments.length">未分配格子会被忽略，不会写回分镜</span>
                      </div>
                    </div>
                    <div class="grid-assignment-pane">
                      <div class="grid-assign-head">
                        <div class="grid-assign-title">格子分配</div>
                        <div class="grid-assign-subtitle">切分后由你自己决定每格对应哪个分镜</div>
                      </div>
                      <div v-if="gridAssignmentTotalPages > 1" class="grid-assign-pagination">
                        <button class="btn btn-sm" :disabled="gridAssignmentPage === 0" @click="gridAssignmentPage--">上一页</button>
                        <span class="dim">第 {{ gridAssignmentPage + 1 }}/{{ gridAssignmentTotalPages }} 页</span>
                        <span class="dim">{{ gridAssignmentPageStart + 1 }}-{{ gridAssignmentPageEnd }} / {{ gridAssignments.length }}</span>
                        <button class="btn btn-sm ml-auto" :disabled="gridAssignmentPage >= gridAssignmentTotalPages - 1" @click="gridAssignmentPage++">下一页</button>
                      </div>
                      <div class="grid-assign-columns">
                        <span>格</span>
                        <span>镜头</span>
                        <span>类型</span>
                        <span>当前绑定</span>
                      </div>
                      <div class="grid-assign-info">
                        <div v-for="item in pagedGridAssignments" :key="item.index" :class="['grid-assign-row', activeGridCell === item.index && 'active']">
                          <span class="grid-assign-index">格{{ item.index + 1 }}</span>
                          <BaseSelect
                            :model-value="item.assignment.storyboard_id"
                            :options="gridAssignmentShotOptions"
                            placeholder="选择镜头"
                            @update:model-value="updateGridAssignment(item.index, 'storyboard_id', $event)"
                          />
                          <BaseSelect
                            :model-value="item.assignment.frame_type"
                            :options="gridFrameTypeOptions"
                            placeholder="帧类型"
                            style="width:100%"
                            @update:model-value="updateGridAssignment(item.index, 'frame_type', $event)"
                          />
                          <span class="grid-assign-bind">{{ gridCellTitle(item.assignment.storyboard_id) }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="grid-tool-foot">
                    <button class="btn" @click="gridStep = 1">返回</button>
                    <button class="btn btn-primary ml-auto" @click="doGridSplit">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                      切分并分配
                    </button>
                  </div>
                </div>

                <!-- Step 4: Done -->
                <div v-else-if="gridStep === 4" class="grid-tool-body" style="align-items:center;justify-content:center;min-height:200px">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <div style="font-size:17px;font-weight:700;font-family:var(--font-display);margin-top:8px">{{ isGridSplitPending() ? '分配任务已提交' : gridSplitError() ? '分配失败' : '分配完成' }}</div>
                  <div class="dim" style="font-size:13px;margin-top:4px">{{ isGridSplitPending() ? '后台正在切分图片并写回分镜' : `${gridAssignedCount} 格已分配` }}</div>
                  <div v-if="gridSplitError()" class="prod-error">{{ gridSplitError() }}</div>
                  <button class="btn btn-primary" style="margin-top:16px" @click="gridDialog = false; refresh()">关闭</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Videos -->
          <div v-else-if="prodTab === 'videos'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
              <span class="tag mono">{{ shotVidCount }}/{{ sbs.length }} 已生成</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchVideos">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  批量视频
                </button>
              </div>
            </div>
            <div class="prod-grid">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="card prod-card">
                <div class="prod-cover">
                  <video
                    v-if="hasVid(sb)"
                    :src="'/' + getVideoUrl(sb)"
                    class="prod-video"
                    controls
                    preload="metadata"
                    playsinline
                  />
                  <img
                    v-else-if="hasImg(sb)"
                    :src="'/' + getStoryboardCover(sb)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + getStoryboardCover(sb), `镜头 #${String(i + 1).padStart(2, '0')} 参考图`)"
                  />
                  <div v-else class="prod-cover-empty" :class="{ 'prod-cover-failed': isFailedShotFrame(sb.id, 'first_frame') }" :title="shotFrameFailMessage(sb.id, 'first_frame') || undefined">
                    <svg v-if="isFailedShotFrame(sb.id, 'first_frame')" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  </div>
                  <span class="prod-idx">#{{ String(i+1).padStart(2,'0') }}</span>
                  <span v-if="hasComposed(sb)" class="prod-overlay-badge">已合成</span>
                </div>
                <div class="prod-info">
                  <div class="prod-desc truncate">{{ sb.description || sb.title || '—' }}</div>
                  <div class="prod-meta-line">{{ sb.shot_type || sb.shotType || '未设景别' }} · {{ sb.duration || 8 }}s</div>
                  <div class="prod-dots">
                    <span :class="['dot', hasImg(sb) && 'ok', isFailedShotFrame(sb.id, 'first_frame') && 'fail']" /><span style="font-size:10px">图</span>
                    <span :class="['dot', hasVid(sb) && 'ok', isPendingVideo(sb.id) && 'pending']" /><span style="font-size:10px">{{ isPendingVideo(sb.id) ? '视频生成中' : '视频' }}</span>
                  </div>
                  <div v-if="shotFrameFailMessage(sb.id, 'first_frame')" class="prod-error">图片：{{ shotFrameFailMessage(sb.id, 'first_frame') }}</div>
                  <div v-if="videoFailMessage(sb.id)" class="prod-error">{{ videoFailMessage(sb.id) }}</div>
                </div>
                <div class="prod-actions">
                  <button class="btn btn-sm" :disabled="isPendingVideo(sb.id)" @click="genVid(sb)">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    {{ isPendingVideo(sb.id) ? '生成中' : (isImageStory ? '生成 AI 视频' : '生成视频') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Sub: Compose -->
          <div v-else-if="prodTab === 'compose'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ sbs.length }} 个镜头</span>
              <span class="tag mono">{{ composedCount }}/{{ sbs.length }} 已合成</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" @click="batchCompose(false)">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  批量合成
                </button>
                <button v-if="composedCount" class="btn btn-sm" @click="batchCompose(true)" title="忽略缓存、用当前配音重新合成全部（改音色后用）">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  重新合成全部
                </button>
              </div>
            </div>
            <div class="prod-grid">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="card prod-card">
                <div class="prod-cover">
                  <video
                    v-if="hasComposed(sb)"
                    :src="'/' + getComposedVideoUrl(sb)"
                    class="prod-video"
                    controls
                    preload="metadata"
                    playsinline
                  />
                  <video
                    v-else-if="hasVid(sb)"
                    :src="'/' + getVideoUrl(sb)"
                    class="prod-video"
                    controls
                    preload="metadata"
                    playsinline
                  />
                  <img
                    v-else-if="hasImg(sb)"
                    :src="'/' + getStoryboardCover(sb)"
                    class="previewable-image"
                    @click.stop="openImageViewer('/' + getStoryboardCover(sb), `镜头 #${String(i + 1).padStart(2, '0')} 参考图`)"
                  />
                  <div v-else class="prod-cover-empty" :class="{ 'prod-cover-failed': isFailedShotFrame(sb.id, 'first_frame') }" :title="shotFrameFailMessage(sb.id, 'first_frame') || undefined">
                    <svg v-if="isFailedShotFrame(sb.id, 'first_frame')" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </div>
                  <span class="prod-idx">#{{ String(i+1).padStart(2,'0') }}</span>
                  <span v-if="hasComposed(sb)" class="prod-overlay-badge">已合成</span>
                </div>
                <div class="prod-info">
                  <div class="prod-desc truncate">{{ sb.description || sb.title || '—' }}</div>
                  <div class="prod-meta-line">{{ sb.shot_type || sb.shotType || '未设景别' }} · {{ sb.duration || 8 }}s</div>
                  <div class="prod-dots">
                    <span :class="['dot', hasImg(sb) && 'ok', isFailedShotFrame(sb.id, 'first_frame') && 'fail']" /><span style="font-size:10px">{{ isImageStory ? '图' : '图' }}</span>
                    <span :class="['dot', hasVid(sb) && 'ok']" /><span style="font-size:10px">{{ isImageStory ? '视频(可选)' : '视频' }}</span>
                    <span :class="['dot', hasTTS(sb) && 'ok']" /><span style="font-size:10px">配音</span>
                    <span :class="['dot', hasComposed(sb) && 'ok', isPendingCompose(sb.id) && 'pending']" /><span style="font-size:10px">{{ isPendingCompose(sb.id) ? '合成中' : '合成' }}</span>
                  </div>
                  <div v-if="hasAudioCheckAssets(sb)" class="audio-check-list prod-audio-check" @click.stop>
                    <div v-for="asset in getAudioCheckAssets(sb)" :key="asset.kind + asset.url" class="audio-check-row">
                      <span :class="['audio-check-label', `audio-check-${asset.kind}`]">{{ asset.label }}</span>
                      <span class="audio-check-name" :title="asset.name">{{ asset.name }}</span>
                      <audio :src="asset.url" controls preload="none" class="audio-check-player"></audio>
                    </div>
                  </div>
                  <div v-if="shotFrameFailMessage(sb.id, 'first_frame')" class="prod-error">图片：{{ shotFrameFailMessage(sb.id, 'first_frame') }}</div>
                  <div v-if="composeFailMessage(sb.id)" class="prod-error">{{ composeFailMessage(sb.id) }}</div>
                </div>
                <div class="prod-actions">
                  <button class="btn btn-sm" :disabled="(!isImageStory && !hasVid(sb)) || isPendingCompose(sb.id)" @click="doCompose(sb, hasComposed(sb))">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    {{ isPendingCompose(sb.id) ? '合成中' : (hasComposed(sb) ? '重新合成' : (isImageStory ? '图文合成' : '开始合成')) }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Production Navigator -->
        </template>
      </div>

      <!-- ===== EXPORT PANEL ===== -->
      <div v-else class="content-panel">
        <div v-if="!sbs.length" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="empty-title">尚未准备就绪</div>
          <div class="empty-desc">请先完成分镜和制作流程</div>
          <button class="btn btn-primary" @click="panel = 'script'">前往剧本</button>
        </div>
        <div v-else class="export-split">
          <div class="export-main">
            <template v-if="mergeUrl">
              <div v-memo="[mergeUrl, mergeStatus]">
                <video :src="mergeVideoSrc" controls class="export-video" preload="metadata" playsinline />
                <div class="export-bar">
                  <span class="tag tag-success">拼接完成</span>
                  <span class="tag" :class="isImageStory ? 'tag-info' : 'tag-warning'">{{ isImageStory ? '图文叙事成片' : 'AI 视频成片' }}</span>
                  <span class="dim" style="font-size:12px">{{ sbs.length }} 镜头 · {{ totalDuration }}s</span>
                  <button class="btn ml-auto" :disabled="composedCount === 0 || isMerging" @click="doMerge">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                    重新拼接
                  </button>
                  <a :href="mergeVideoSrc" download class="btn btn-primary">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    下载视频
                  </a>
                </div>
              </div>
            </template>
            <template v-else-if="isMerging">
              <div class="step-empty">
                <div class="empty-visual">
                  <Loader2 :size="32" class="animate-spin" />
                </div>
                <div class="empty-title">正在拼接全集视频…</div>
                <div class="empty-desc">正在合成 {{ composedCount }} 个镜头，请勿关闭页面。完成后会自动显示成片。</div>
                <div class="merge-progress-track"><div class="merge-progress-fill" /></div>
              </div>
            </template>
            <template v-else>
              <div class="step-empty">
                <div class="empty-visual">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                </div>
                <div class="empty-title">{{ mergeFailed ? '拼接失败' : '拼接全集视频' }}</div>
                <div v-if="mergeFailed" class="empty-desc merge-error-text">{{ mergeFailMessage || '拼接过程中出错，请重试' }}</div>
                <div v-else class="empty-desc">将 {{ composedCount }} 个已合成镜头拼接为完整视频</div>
                <button class="btn btn-primary" :disabled="composedCount === 0" @click="doMerge" style="margin-top:12px">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  {{ mergeFailed ? '重新拼接' : '开始拼接' }}
                </button>
              </div>
            </template>
          </div>
          <div class="export-list">
            <div class="export-list-head">镜头概览</div>
            <div class="export-list-body">
              <div v-for="(sb, i) in sbs" :key="sb.id" class="exp-row">
                <div class="exp-row-main">
                  <span class="mono dim" style="font-size:10px">#{{ String(i+1).padStart(2,'0') }}</span>
                  <span class="truncate" style="flex:1;font-size:11px">{{ sb.description || sb.title || '—' }}</span>
                  <span :class="['dot', hasComposed(sb) && 'ok']" />
                </div>
                <div v-if="hasAudioCheckAssets(sb)" class="audio-check-list export-audio-check" @click.stop>
                  <div v-for="asset in getAudioCheckAssets(sb)" :key="asset.kind + asset.url" class="audio-check-row">
                    <span :class="['audio-check-label', `audio-check-${asset.kind}`]">{{ asset.label }}</span>
                    <span class="audio-check-name" :title="asset.name">{{ asset.name }}</span>
                    <audio :src="asset.url" controls preload="none" class="audio-check-player"></audio>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="showBottomBubble" class="step-bubble">
        <button
          v-if="panel === 'script'"
          class="bubble-btn"
          :disabled="scriptStep === 0"
          @click="goPrevStep"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ prevStepLabel || '上一步' }}
        </button>
        <button
          v-else-if="panel === 'production'"
          class="bubble-btn"
          :disabled="prodTabIdx === 0"
          @click="prodTabIdx = Math.max(0, prodTabIdx - 1)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ prodTabDefs[Math.max(0, prodTabIdx - 1)]?.label || '上一步' }}
        </button>

        <div class="bubble-dots">
          <button
            v-for="step in bubbleSteps"
            :key="step.key"
            :class="['bubble-dot', { done: step.done, current: step.key === activeBubbleKey }]"
            @click="goSubStep(step.key)"
            :title="step.label"
          ></button>
        </div>

        <button
          v-if="panel === 'script'"
          class="bubble-btn primary"
          :disabled="!canGoNext"
          @click="goNextStep"
        >
          {{ nextStepLabel || '下一步' }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
        <button
          v-else-if="panel === 'production'"
          class="bubble-btn primary"
          :disabled="panel === 'production' && prodTab === 'compose' && !canExport"
          @click="goNextProd"
        >
          {{ prodTabIdx < prodTabDefs.length - 1 ? (prodTabDefs[prodTabIdx + 1]?.label || '下一步') : '进入导出' }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
      </div>

      <div v-if="imageViewer.open && imageViewer.src" class="overlay image-viewer-overlay" @click.self="closeImageViewer">
        <div class="card image-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ imageViewer.title || '图片预览' }}</div>
            <button class="btn btn-ghost btn-icon" @click="closeImageViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body">
            <img :src="imageViewer.src" :alt="imageViewer.title || '图片预览'" class="image-viewer-img" />
          </div>
        </div>
      </div>

      <div v-if="autoSplitPreview.open" class="overlay auto-split-overlay" @click.self="closeAutoSplitPreview">
        <div class="card auto-split-dialog">
          <div class="auto-split-head">
            <div class="auto-split-title">自动细分超载镜头</div>
            <button class="btn btn-ghost btn-icon" @click="closeAutoSplitPreview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="auto-split-body">
            <div v-if="autoSplitPreview.loading" class="auto-split-loading">
              <Loader2 :size="24" class="animate-spin" />
              <span>正在分析超载镜头...</span>
            </div>
            <div v-else-if="!autoSplitPreview.shots.length" class="auto-split-empty">
              没有检测到超载镜头
            </div>
            <div v-else class="auto-split-list">
              <div class="auto-split-meta">阈值：{{ autoSplitPreview.threshold }} 字 · 共 {{ autoSplitPreview.shots.length }} 个镜头将被拆分</div>
              <div v-for="shot in autoSplitPreview.shots" :key="shot.id" class="auto-split-shot">
                <div class="auto-split-shot-header">
                  <span class="auto-split-shot-title">镜头 {{ shot.storyboard_number }}</span>
                  <span class="auto-split-shot-count">拆分为 {{ shot.split_into }} 个</span>
                </div>
                <div class="auto-split-proposed-list">
                  <div v-for="(p, idx) in shot.proposed" :key="idx" class="auto-split-proposed">
                    <div class="auto-split-proposed-title">{{ p.title }}</div>
                    <div class="auto-split-proposed-text">{{ p.narration }} {{ p.dialogue }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="auto-split-foot">
            <button class="btn" :disabled="autoSplitPreview.executing" @click="closeAutoSplitPreview">取消</button>
            <button class="btn primary" :disabled="!autoSplitPreview.shots.length || autoSplitPreview.executing" @click="confirmAutoSplit">
              <Loader2 v-if="autoSplitPreview.executing" :size="12" class="animate-spin" />
              确认细分
            </button>
          </div>
        </div>
      </div>

      <!-- Auto Start Confirmation Dialog -->
      <div v-if="autoStartDialogOpen" class="overlay auto-start-overlay" @click.self="autoStartDialogOpen = false">
        <div class="card auto-start-dialog">
          <div class="auto-start-head">
            <div class="auto-start-title">开启自动模式</div>
            <button class="btn btn-ghost btn-icon" @click="autoStartDialogOpen = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="auto-start-body">
            <p class="auto-start-desc">确认后将自动执行以下流程：</p>
            <ol class="auto-start-steps">
              <li :class="{ muted: !dialogEnableAiRewrite }">
                AI 改写原文
                <span v-if="!dialogEnableAiRewrite" class="skip-tag">已跳过</span>
              </li>
              <li>提取角色与场景</li>
              <li>拆解分镜</li>
              <li>细分超载镜头</li>
              <li>生成解说旁白</li>
            </ol>
            <label class="auto-start-checkbox">
              <input type="checkbox" v-model="dialogEnableAiRewrite" />
              <span>启用 AI 改写（会先改写原文，再进入后续流程）</span>
            </label>
          </div>
          <div class="auto-start-foot">
            <button class="btn" @click="autoStartDialogOpen = false">取消</button>
            <button class="btn primary" @click="confirmAutoStart">确认开启</button>
          </div>
        </div>
      </div>
    </main>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import {
  Users, MapPin, Video, ImageIcon, Layers, Mic2, FileText, FolderKanban, Clapperboard, Download, Loader2, Settings2, X,
} from 'lucide-vue-next'
import { dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, imageAPI, videoAPI, composeAPI, ttsAPI, mergeAPI, gridAPI, aiConfigAPI, voicesAPI, libraryAPI } from '~/composables/useApi'
import { useAgent } from '~/composables/useAgent'
import { useTasks } from '~/composables/useTasks'
import BaseSelect from '~/components/BaseSelect.vue'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const STORY_VALIDATION_SAMPLE = `2008年冬天，林夏第一次走进顾家时，就知道自己永远不会被这个家真正接纳。婆婆嘴上客气，眼神却像在挑一件不合身的旧衣服。她什么都没说，只把冻红的手悄悄藏进袖口里。

八年后，顾沉深夜回到家，看见餐桌上那份已经签好字的离婚协议，才意识到林夏不是闹脾气。白天他刚在公司答应替母亲隐瞒真相，以为再拖一拖，一切还能过去。可他不知道，林夏下午已经在医院拿到了那张被藏了三年的诊断单。

她站在阳台上，风把窗帘吹得猎猎作响。她心里其实怕得厉害，却比任何时候都清醒。她明白，自己这次转身，不只是离开一段婚姻，更是在逼那个一直装作无事发生的男人，终于看一眼真相。门后忽然传来脚步声，她没有回头。`

const STORY_SIGNAL_RULES = [
  { label: '内心', pattern: /心里|心中|内心|害怕|迟疑|沉默|硬撑|不安|压抑|后悔|愤怒|委屈|清醒|疲惫|痛苦|绝望|慌乱|隐忍|崩溃|怔住/ },
  { label: '背景', pattern: /当年|从前|曾经|之前|那年|多年|一直|原来|出身|过去|旧事|八年后|第一次|三年|多年|往事/ },
  { label: '因果', pattern: /因为|所以|结果|于是|直到|才|导致|逼得|终于|因此|意识到|明白|不只是|为了|以为|看见/ },
  { label: '悬念', pattern: /不知道|似乎|仿佛|隐约|秘密|真相|预感|没想到|忽然|突然|竟然|脚步声|没有回头|被藏|隐瞒/ },
]

const STORY_CARRIER_FIELDS = [
  { key: 'description', label: '画面描述' },
  { key: 'action', label: '动作' },
  { key: 'result', label: '结果' },
  { key: 'atmosphere', label: '氛围' },
  { key: 'narration', label: '旁白' },
  { key: 'dialogue', label: '对白' },
]

const drama = ref(null), episode = ref(null), chars = ref([]), scenes = ref([]), sbs = ref([]), mergeData = ref(null)
const panel = ref('script')
const { running: rn, runningType: rt, run: runAgent, loadTasks: loadAgentTasks } = useAgent()

const localRaw = ref(''), localScript = ref('')
const batchNarrationAudioRunning = ref(false)
const settingsDrawerOpen = ref(false)
const rawContent = computed(() => episode.value?.content || '')
const scriptContent = computed(() => episode.value?.script_content || episode.value?.scriptContent || '')
const epId = computed(() => episode.value?.id || 0)
const renderMode = computed(() => episode.value?.render_mode || 'image_story')
const isImageStory = computed(() => renderMode.value === 'image_story')
const autoMode = computed(() => episode.value?.auto_mode === true)
const enableAiRewrite = computed(() => episode.value?.enable_ai_rewrite !== false)
const narrationVoiceId = computed(() => episode.value?.narration_voice_id || '')
const narrationSpeed = computed(() => episode.value?.narration_speed || 1.0)
const pacingMode = computed(() => episode.value?.pacing_mode || 'tight')
const pacingModeOptions = [
  { label: '标准', value: 'standard' },
  { label: '紧凑', value: 'tight' },
  { label: '极速', value: 'extreme' },
]
const dialogueMode = computed(() => episode.value?.dialogue_mode || 'narration_only')
const dialogueModeOptions = [
  { label: '无对白', value: 'narration_only' },
  { label: '含对白', value: 'with_dialogue' },
]
const subtitleEnabled = computed(() => episode.value?.subtitle_enabled !== false)
const subtitleFont = computed(() => episode.value?.subtitle_font || 'PingFang SC')
const subtitleColor = computed(() => episode.value?.subtitle_color || '#FFFFFF')
const subtitleSize = computed(() => episode.value?.subtitle_size || 48)
const subtitlePosition = computed(() => episode.value?.subtitle_position || 'bottom')
const subtitleMargin = computed(() => episode.value?.subtitle_margin ?? 60)
const subtitleMarginV = computed(() => episode.value?.subtitle_margin_v ?? 40)
const subtitleBackgroundColor = computed(() => episode.value?.subtitle_background_color || '')
const subtitleStrokeColor = computed(() => episode.value?.subtitle_stroke_color || '#000000')
const subtitleStrokeWidth = computed(() => episode.value?.subtitle_stroke_width ?? 2)
const subtitleFontOptions = [
  { label: '苹方', value: 'PingFang SC' },
  { label: '思源黑体', value: 'Source Han Sans SC' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: '宋体', value: 'SimSun' },
  { label: '黑体', value: 'SimHei' },
]
const subtitlePositionOptions = [
  { label: '顶部', value: 'top' },
  { label: '居中', value: 'middle' },
  { label: '底部', value: 'bottom' },
]
const subtitleGenerating = ref(false)
const subtitlePreviewLoading = ref(false)
const subtitlePreviewUrl = ref('')
const firstSubtitleStoryboard = computed(() => sbs.value.find(s => (s.narration || s.dialogue)?.trim()) || null)
const openingHook = computed(() => episode.value?.opening_hook || '')
const cliffhanger = computed(() => episode.value?.cliffhanger || '')
const workflowType = computed(() => episode.value?.workflow_type || episode.value?.workflowType || '')
const narrationMode = computed(() => episode.value?.narration_mode || episode.value?.narrationMode || '')
// 业务契约：direct_script 的 narration 字段不是 AI 旁白，而是逐镜头原文 TTS 切片。
// 只有 story_rewrite + rewrite 才允许调用 narrator 生成新的解说/旁白文案。
const usesOriginalNarrationText = computed(() => workflowType.value === 'direct_script' || narrationMode.value === 'verbatim')
const canGenerateAINarration = computed(() => !usesOriginalNarrationText.value)
const narrationFieldLabel = computed(() => usesOriginalNarrationText.value ? '原文 TTS 文本' : '旁白 / 解说')
const narrationFieldPlaceholder = computed(() => usesOriginalNarrationText.value
  ? '原文切片，仅用于 TTS；不要改写成第一人称'
  : 'AI 解说/旁白文案，作为镜头主音轨')
const {
  tasks: mediaTasks,
  loading: tasksLoading,
  error: tasksError,
  lastLoadedAt: tasksLastLoadedAt,
  loadTasks: loadCreationTasks,
  startUpdates: startTaskUpdates,
} = useTasks({ dramaId, episodeId: epId, pollMs: 3000 })
const rawLen = computed(() => localRaw.value.replace(/\s/g, '').length || 0)
const scriptLen = computed(() => localScript.value.replace(/\s/g, '').length || 0)
const charsVoiced = computed(() => chars.value.filter(c => c.voice_style || c.voiceStyle).length)
const voiceSampleCount = computed(() => chars.value.filter(c => c.voice_sample_url || c.voiceSampleUrl).length)
const composedCount = computed(() => sbs.value.filter(s => s.composed_video_url || s.composedVideoUrl).length)
const narrationCount = computed(() => sbs.value.filter(s => (s.narration || '').trim()).length)
const mergeUrl = computed(() => mergeData.value?.merged_url || mergeData.value?.mergedUrl || null)
const mergeVideoSrc = computed(() => {
  if (!mergeUrl.value) return ''
  const cacheKey = mergeData.value?.completed_at || mergeData.value?.created_at || ''
  return '/' + mergeUrl.value + (cacheKey ? `?v=${Date.parse(cacheKey) || cacheKey}` : '')
})
let mergePollTimer = null
function clearMergePoll() {
  if (mergePollTimer) {
    clearInterval(mergePollTimer)
    mergePollTimer = null
  }
}
const merging = ref(false)
const mergeStatus = computed(() => mergeData.value?.status || '')
const isMerging = computed(() => merging.value || mergeStatus.value === 'processing' || mergeStatus.value === 'pending' || isMergeTaskRunning())
const mergeFailed = computed(() => !merging.value && mergeStatus.value === 'failed')
const mergeFailMessage = computed(() => mergeData.value?.error_msg || mergeData.value?.errorMsg || '')

const scriptStep = ref(0)
const prodTab = ref('chars')
const prodTabIdx = computed({
  get: () => prodTabDefs.value.findIndex(t => t.id === prodTab.value),
  set: (v) => { prodTab.value = prodTabDefs.value[v]?.id || 'chars' },
})
const frameMode = ref('first')
const fallbackVoiceProfiles = [
  { id: 'alloy', label: 'Alloy', gender: '中性', traits: '平衡、自然、克制', suitable: '通用叙述、旁白、需要稳定输出的角色' },
  { id: 'echo', label: 'Echo', gender: '男声', traits: '低沉、稳重、冷静', suitable: '成熟男性、父辈、旁白、压迫感角色' },
  { id: 'fable', label: 'Fable', gender: '男声', traits: '温暖、讲述感、表现力强', suitable: '男主、成长型角色、叙事担当' },
  { id: 'onyx', label: 'Onyx', gender: '男声', traits: '深沉、有力、权威', suitable: '反派、强势角色、掌控型人物' },
  { id: 'nova', label: 'Nova', gender: '女声', traits: '温柔、甜润、亲和', suitable: '女主、母亲、柔和配角' },
  { id: 'shimmer', label: 'Shimmer', gender: '女声', traits: '明亮、活泼、年轻', suitable: '少女、轻快角色、跳脱配角' },
]
const voiceProfiles = ref(fallbackVoiceProfiles)
const voiceSelectOptions = computed(() => voiceProfiles.value.map(v => ({ label: `${v.label} · ${v.traits}`, value: v.id })))
const narrationVoiceOptions = computed(() => [
  { label: '默认', value: '' },
  ...voiceProfiles.value.map(v => ({ label: `${v.label} · ${v.gender}`, value: v.id })),
])
const videoConfigSelectOptions = computed(() => videoConfigs.value.map(c => {
  let modelName = ''
  try { const m = JSON.parse(c.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = c.model || '' }
  const label = modelName ? `${modelName} (${c.provider})` : `${c.name} (${c.provider})`
  return { label, value: c.id }
}))
const frameModeOptions = [{ label: '仅首帧', value: 'first' }, { label: '首尾帧', value: 'first_last' }]
const gridLayoutOptions = [
  { label: '2x2', value: '2x2' },
  { label: '3x3', value: '3x3' },
  { label: '4x4', value: '4x4' },
  { label: '5x5', value: '5x5' },
]
const imageConfigs = ref([])
const videoConfigs = ref([])
const audioConfigs = ref([])
const failedVideoMessages = ref({})
const failedComposeMessages = ref({})
const failedShotFrameMessages = ref({})
const imageViewer = ref({ open: false, src: '', title: '' })
const autoSplitPreview = ref({
  open: false,
  loading: false,
  executing: false,
  threshold: 0,
  shots: [],
})
const autoStartDialogOpen = ref(false)
const dialogEnableAiRewrite = ref(true)

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running'])
const FAILED_TASK_STATUSES = new Set(['failed', 'stale'])

function isActiveTask(task) {
  return !!task && ACTIVE_TASK_STATUSES.has(String(task.status || ''))
}

function isFailedTask(task) {
  return !!task && FAILED_TASK_STATUSES.has(String(task.status || ''))
}

function taskScopeId(task) {
  return Number(task?.scope_id ?? task?.scopeId ?? 0)
}

function taskPayloadValue(task, snakeKey, camelKey) {
  const payload = task?.payload || {}
  return payload[snakeKey] ?? payload[camelKey]
}

function taskIdempotencyKey(task) {
  return String(task?.idempotency_key ?? task?.idempotencyKey ?? '')
}

function latestMediaTask(type, matcher) {
  return [...mediaTasks.value]
    .filter(task => task?.type === type && matcher(task))
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] || null
}

function taskFailureMessage(task) {
  if (!task) return ''
  return task.error_message || task.errorMessage || (task.status === 'stale' ? '任务已中断，请重试' : '任务失败')
}

function shotTTSTask(storyboardId) {
  const id = Number(storyboardId)
  return latestMediaTask('tts.storyboard', task =>
    taskScopeId(task) === id || Number(taskPayloadValue(task, 'storyboard_id', 'storyboardId')) === id,
  )
}

function shotNarrationAudioTask(storyboardId) {
  const id = Number(storyboardId)
  return latestMediaTask('tts.storyboard', task =>
    taskIdempotencyKey(task).startsWith('tts.storyboard:narration:')
    && (taskScopeId(task) === id || Number(taskPayloadValue(task, 'storyboard_id', 'storyboardId')) === id),
  )
}

function episodeNarrationAudioTask() {
  const id = Number(epId.value)
  return latestMediaTask('tts.episode', task =>
    taskIdempotencyKey(task).startsWith('tts.episode:narration:')
    && (taskScopeId(task) === id || Number(taskPayloadValue(task, 'episode_id', 'episodeId')) === id),
  )
}

function isPendingShotTTS(storyboardId) {
  return isActiveTask(shotTTSTask(storyboardId))
}

function shotTTSError(storyboardId) {
  const task = shotTTSTask(storyboardId)
  return isFailedTask(task) ? taskFailureMessage(task) : ''
}

function voiceSampleTask(characterId) {
  const id = Number(characterId)
  return latestMediaTask('tts.character_sample', task =>
    taskScopeId(task) === id || Number(taskPayloadValue(task, 'character_id', 'characterId')) === id,
  )
}

function isPendingVoiceSample(characterId) {
  return isActiveTask(voiceSampleTask(characterId))
}

function voiceSampleError(characterId) {
  const task = voiceSampleTask(characterId)
  return isFailedTask(task) ? taskFailureMessage(task) : ''
}

function configLabel(config) {
  if (!config) return '未配置'
  let modelName = ''
  try { const m = JSON.parse(config.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = config.model || '' }
  return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
}

function isPendingCharImage(id) {
  return isActiveTask(charImageTask(id))
}

function charImageTask(id) {
  return latestMediaTask('image.generate', task =>
    (task.scope_type || task.scopeType) === 'character' && taskScopeId(task) === Number(id),
  )
}

function charImageStatusText(id) {
  const task = charImageTask(id)
  if (!task) return ''
  const status = String(task.status || '')
  if (status === 'queued' && task.queue_position != null) {
    return `队列第 ${task.queue_position} 位`
  }
  if (status === 'running' && task.provider) {
    const providerLabels = {
      openai: 'OpenAI',
      gemini: 'Gemini',
      minimax: 'MiniMax',
      doubao: '火山',
      aliyun: '阿里',
      chatfire: 'Chatfire',
      apimart: 'APIMart',
    }
    return `${providerLabels[task.provider] || task.provider} 生成中`
  }
  if ((status === 'failed' || status === 'stale') && (task.error_message_zh || task.errorMessageZh || task.error_message)) {
    return task.error_message_zh || task.errorMessageZh || task.error_message || '生成失败'
  }
  return ''
}

function openImageViewer(src, title = '') {
  if (!src) return
  imageViewer.value = { open: true, src, title }
}

function closeImageViewer() {
  imageViewer.value = { open: false, src: '', title: '' }
}

function handleImageViewerKeydown(event) {
  if (event.key === 'Escape' && imageViewer.value.open) closeImageViewer()
}

onMounted(() => {
  window.addEventListener('keydown', handleImageViewerKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleImageViewerKeydown)
  clearMergePoll()
})

function isPendingSceneImage(id) {
  return isActiveTask(latestMediaTask('image.generate', task =>
    (task.scope_type || task.scopeType) === 'scene' && taskScopeId(task) === Number(id),
  ))
}

function framePendingKey(id, frameType) {
  return `${id}:${frameType}`
}

function shotFrameTask(id, frameType) {
  const storyboardId = Number(id)
  return latestMediaTask('image.generate', task =>
    (task.scope_type || task.scopeType) === 'storyboard'
    && taskScopeId(task) === storyboardId
    && String(taskPayloadValue(task, 'frame_type', 'frameType') || '') === frameType,
  )
}

function isPendingShotFrame(id, frameType) {
  return isActiveTask(shotFrameTask(id, frameType))
}

function isFailedShotFrame(id, frameType) {
  return !!failedShotFrameMessages.value[framePendingKey(id, frameType)] || isFailedTask(shotFrameTask(id, frameType))
}

function shotFrameFailMessage(id, frameType) {
  const task = shotFrameTask(id, frameType)
  return failedShotFrameMessages.value[framePendingKey(id, frameType)] || (isFailedTask(task) ? taskFailureMessage(task) : '')
}

function isPendingVideo(id) {
  return isActiveTask(latestMediaTask('video.generate', task =>
    (task.scope_type || task.scopeType) === 'storyboard' && taskScopeId(task) === Number(id),
  ))
}

function videoFailMessage(id) {
  const task = latestMediaTask('video.generate', item =>
    (item.scope_type || item.scopeType) === 'storyboard' && taskScopeId(item) === Number(id),
  )
  return failedVideoMessages.value[id] || (isFailedTask(task) ? taskFailureMessage(task) : '')
}

function isPendingCompose(id) {
  return isActiveTask(latestMediaTask('compose.storyboard', task =>
    (task.scope_type || task.scopeType) === 'storyboard' && taskScopeId(task) === Number(id),
  ))
}

function composeFailMessage(id) {
  const task = latestMediaTask('compose.storyboard', item =>
    (item.scope_type || item.scopeType) === 'storyboard' && taskScopeId(item) === Number(id),
  )
  return failedComposeMessages.value[id] || (isFailedTask(task) ? taskFailureMessage(task) : '')
}

function isMergeTaskRunning() {
  return isActiveTask(latestMediaTask('merge.episode', task =>
    (task.scope_type || task.scopeType) === 'episode' && taskScopeId(task) === Number(epId.value),
  ))
}

function isNarratorCharacter(char) {
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  return text.includes('旁白') || text.includes('narrator') || text.includes('画外音')
}

const visualChars = computed(() => chars.value.filter(c => !isNarratorCharacter(c)))

const lockedImageConfigId = computed(() => episode.value?.image_config_id || episode.value?.imageConfigId || null)
const lockedVideoConfigId = computed(() => episode.value?.video_config_id || episode.value?.videoConfigId || null)
const lockedAudioConfigId = computed(() => episode.value?.audio_config_id || episode.value?.audioConfigId || null)
const lockedAudioProvider = computed(() => audioConfigs.value.find(c => c.id === lockedAudioConfigId.value)?.provider || '')
const lockedImageConfigLabel = computed(() => configLabel(imageConfigs.value.find(c => c.id === lockedImageConfigId.value)))
const lockedVideoConfigLabel = computed(() => configLabel(videoConfigs.value.find(c => c.id === lockedVideoConfigId.value)))
const lockedAudioConfigLabel = computed(() => configLabel(audioConfigs.value.find(c => c.id === lockedAudioConfigId.value)))
const narrationProviderSaving = ref(false)
const activeAudioConfigs = computed(() => audioConfigs.value.filter(c => c.is_active !== false))
const narrationCfg = computed(() => activeAudioConfigs.value.find(c => c.settings?.useForNarration))
const narrationProvider = computed(() => narrationCfg.value?.provider || lockedAudioProvider.value || 'minimax')
const narrationProviderChoices = computed(() => [
  { label: 'MiniMax', provider: 'minimax', config: activeAudioConfigs.value.find(c => c.provider === 'minimax') },
  { label: 'SiliconFlow', provider: 'siliconflow', config: activeAudioConfigs.value.find(c => c.provider === 'siliconflow') },
])

async function setNarrationProvider(provider) {
  if (provider === narrationProvider.value) return
  const target = activeAudioConfigs.value.find(c => c.provider === provider)
  if (!target) {
    toast.error(`没有可用的 ${provider} 音频配置`)
    return
  }
  narrationProviderSaving.value = true
  try {
    const updates = activeAudioConfigs.value.map((config) => {
      const nextSettings = { ...(config.settings || {}), useForNarration: config.id === target.id }
      if (config.settings?.useForNarration === nextSettings.useForNarration) return null
      return aiConfigAPI.update(config.id, { settings: nextSettings })
    }).filter(Boolean)
    await Promise.all(updates)
    await loadConfigs()
    toast.success(`解说 TTS 已切换为 ${provider}`)
  } catch (e) {
    toast.error(e?.message || '切换解说 TTS 失败')
  } finally {
    narrationProviderSaving.value = false
  }
}

// Grid tool state
const gridDialog = ref(false)
const gridStep = ref(0)
const gridLayout = ref('3x3')
const gridMode = ref('first_frame')
const gridSelected = ref([])
const gridSingleTarget = ref(null)
const gridGenId = ref(null)
const gridImagePath = ref('')
const gridStatusText = ref('')
const gridActualLayout = ref({ rows: 3, cols: 3 })
const gridRecoveredAt = ref('')
const gridRecoveredMode = ref('')
const gridPromptText = ref('')
const gridCellPrompts = ref([])
const gridPromptSource = ref('')
const gridPromptLoading = ref(false)
const gridPromptStatus = ref('')
const gridAssignmentsState = ref([])
const gridActiveShotIds = ref([])
const gridHistory = ref([])
const gridSplitTaskId = ref(null)
const showAllGridHistory = ref(false)
const activeGridCell = ref(0)
const gridAssignmentPage = ref(0)
const gridStorageKey = computed(() => `huobao:grid:${dramaId}:${epId.value || episodeNumber}`)

const gridModes = [
  { id: 'first_frame', label: '首帧', desc: '每格=一个镜头的首帧' },
  { id: 'first_last', label: '首尾帧', desc: '每镜头占一行：左首帧，右尾帧' },
  { id: 'multi_ref', label: '多参考', desc: '所有格子=同一镜头的参考图' },
]

const gridLayoutShape = computed(() => {
  const [rows, cols] = String(gridLayout.value || '3x3').split('x').map(Number)
  return {
    rows: rows || 3,
    cols: cols || 3,
  }
})
const gridTotalCells = computed(() => {
  return gridLayoutShape.value.rows * gridLayoutShape.value.cols
})

const gridCanStart = computed(() => {
  if (gridMode.value === 'multi_ref') return !!gridSingleTarget.value
  return gridSelected.value.length > 0
})

const gridSummary = computed(() => {
  if (gridMode.value === 'multi_ref') {
    const idx = sbs.value.findIndex(s => s.id === gridSingleTarget.value) + 1
    return gridSingleTarget.value ? `${gridLayoutShape.value.rows}x${gridLayoutShape.value.cols} 参考图 → 镜头 #${idx}` : '请选择一个镜头'
  }
  if (!gridSelected.value.length) return '请选择镜头'
  const count = gridSelected.value.length
  if (gridMode.value === 'first_last') {
    const { rows, cols } = gridLayoutShape.value
    return `${count} 个镜头 → ${rows}x${cols} 宫格（按首尾帧风格生成，切分后再手动分配）`
  }
  const { rows, cols } = gridLayoutShape.value
  const cells = rows * cols
  return `${count} 个镜头 → ${rows}x${cols} 宫格（先生成宫格图，切分后再手动分配）`
})

function createGridAssignments() {
  return Array.from({ length: gridActualLayout.value.rows * gridActualLayout.value.cols }, () => ({
    storyboard_id: null,
    frame_type: 'first_frame',
  }))
}

const gridAssignments = computed(() => gridAssignmentsState.value)
const gridAssignableShotIds = computed(() => {
  const assignedIds = [...new Set(gridAssignments.value.map(item => item?.storyboard_id).filter(Boolean))]
  const ids = Array.isArray(gridActiveShotIds.value) && gridActiveShotIds.value.length
    ? gridActiveShotIds.value
    : assignedIds.length
      ? assignedIds
    : gridMode.value === 'multi_ref'
      ? (gridSingleTarget.value ? [gridSingleTarget.value] : [])
      : gridSelected.value.length
        ? [...gridSelected.value]
        : sbs.value.map(s => s.id)
  return ids.filter(id => sbs.value.some(s => s.id === id))
})
const gridAssignmentShotOptions = computed(() => [
  { label: '未分配', value: null },
  ...gridAssignableShotIds.value.map((id) => {
    const index = sbs.value.findIndex(s => s.id === id) + 1
    const sb = sbs.value.find(s => s.id === id)
    return {
      label: `#${String(index).padStart(2, '0')} ${sb?.title || sb?.description || '镜头'}`,
      value: id,
    }
  }),
])
const gridFrameTypeOptions = computed(() => {
  return [
    { label: '首帧', value: 'first_frame' },
    { label: '尾帧', value: 'last_frame' },
    { label: '参考图', value: 'reference' },
  ]
})
const gridAssignedCount = computed(() => gridAssignments.value.filter(item => !!item.storyboard_id).length)
const gridAssignmentPageSize = computed(() => {
  if (gridAssignments.value.length >= 25) return 8
  if (gridAssignments.value.length >= 16) return 10
  if (gridAssignments.value.length >= 9) return 9
  return Math.max(1, gridAssignments.value.length || 1)
})
const gridAssignmentTotalPages = computed(() => Math.max(1, Math.ceil(gridAssignments.value.length / gridAssignmentPageSize.value)))
const gridAssignmentPageStart = computed(() => gridAssignmentPage.value * gridAssignmentPageSize.value)
const gridAssignmentPageEnd = computed(() => Math.min(gridAssignments.value.length, gridAssignmentPageStart.value + gridAssignmentPageSize.value))
const pagedGridAssignments = computed(() => {
  return gridAssignments.value
    .slice(gridAssignmentPageStart.value, gridAssignmentPageEnd.value)
    .map((assignment, offset) => ({
      assignment,
      index: gridAssignmentPageStart.value + offset,
    }))
})

function resetGridAssignments() {
  gridAssignmentsState.value = createGridAssignments()
  activeGridCell.value = 0
  gridAssignmentPage.value = 0
}

function gridCellLabel(a) {
  if (!a?.storyboard_id) return '未分配'
  const idx = sbs.value.findIndex(s => s.id === a.storyboard_id) + 1
  const suffix = { first_frame: '首', last_frame: '尾', reference: '参' }[a.frame_type] || ''
  return `#${idx}${suffix ? ` ${suffix}` : ''}`
}

function gridCellTitle(id) {
  if (!id) return '未分配'
  const idx = sbs.value.findIndex(s => s.id === id) + 1
  const sb = sbs.value.find(s => s.id === id)
  return `#${String(idx).padStart(2, '0')} ${sb?.title || sb?.description || '镜头'}`
}

function updateGridAssignment(index, field, value) {
  const next = [...gridAssignmentsState.value]
  next[index] = { ...next[index], [field]: value }
  gridAssignmentsState.value = next
  activeGridCell.value = index
  if (gridImagePath.value) persistGridImagePath(gridImagePath.value)
}

function focusGridCell(index) {
  activeGridCell.value = index
  gridAssignmentPage.value = Math.floor(index / gridAssignmentPageSize.value)
}

const gridOverlayStyle = computed(() => {
  const { rows, cols } = gridActualLayout.value
  return { 'grid-template-columns': `repeat(${cols}, 1fr)`, 'grid-template-rows': `repeat(${rows}, 1fr)` }
})

const gridAutoLayout = computed(() => {
  return gridLayoutShape.value
})

const gridBlankStyle = computed(() => {
  const { rows, cols } = gridAutoLayout.value
  return { 'grid-template-columns': `repeat(${cols}, 1fr)`, 'grid-template-rows': `repeat(${rows}, 1fr)` }
})

// Production step helpers
function prodStepDone(id) {
  if (id === 'chars') return !visualCharTotal.value || charImgCount.value === visualCharTotal.value
  if (id === 'scenes') return !!scenes.value.length && sceneImgCount.value === scenes.value.length
  if (id === 'dubbing') return !!sbs.value.length && (!ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value)
  if (id === 'shots') return !!sbs.value.length && shotImgCount.value === sbs.value.length
  if (id === 'videos') return !!sbs.value.length && shotVidCount.value === sbs.value.length
  if (id === 'compose') return !!sbs.value.length && composedCount.value > 0
  return false
}
const canExport = computed(() => !!sbs.value.length && composedCount.value > 0)

// 某一类型的媒体任务是否有处于活跃（queued/running）状态的
function hasActiveMediaTask(type, scopeType) {
  return mediaTasks.value.some(task =>
    task?.type === type
    && (!scopeType || (task.scope_type || task.scopeType) === scopeType)
    && isActiveTask(task),
  )
}

// 导航项是否处于「执行中」状态（用于侧栏 spinner）。
// 数据全部来自已有的任务轮询（mediaTasks，每 3s 刷新）和 agent 运行状态（rn/rt），
// 不新增后端接口，未完成 + 有活跃任务即视为执行中。
function stepRunning(key) {
  switch (key) {
    // 剧本阶段由 agent 运行状态驱动
    case 'script:rewrite': return rn.value && rt.value === 'script_rewriter'
    case 'script:extract': return rn.value && rt.value === 'extractor'
    case 'script:voice': return rn.value && rt.value === 'voice_assigner'
    case 'script:storyboard':
      return (rn.value && (rt.value === 'storyboard_breaker' || rt.value === 'storyboard_splitter' || rt.value === 'narrator'))
        || hasActiveMediaTask('tts.storyboard')
        || hasActiveMediaTask('tts.episode')
    // 制作阶段由媒体任务活跃状态驱动，且仅在该步尚未完成时显示
    case 'prod:chars':
      return !prodStepDone('chars') && hasActiveMediaTask('image.generate', 'character')
    case 'prod:scenes':
      return !prodStepDone('scenes') && hasActiveMediaTask('image.generate', 'scene')
    case 'prod:dubbing':
      return !prodStepDone('dubbing')
        && (hasActiveMediaTask('tts.storyboard') || hasActiveMediaTask('tts.episode'))
    case 'prod:shots':
      return !prodStepDone('shots') && hasActiveMediaTask('image.generate', 'storyboard')
    case 'prod:videos':
      return !prodStepDone('videos')
        && (hasActiveMediaTask('video.generate') || hasActiveMediaTask('video.episode'))
    case 'prod:compose':
      return !prodStepDone('compose')
        && (hasActiveMediaTask('compose.storyboard') || hasActiveMediaTask('compose.episode'))
    case 'export:merge':
      return !mergeUrl.value && isMergeTaskRunning()
    default:
      return false
  }
}

function goNextProd() {
  if (prodTabIdx.value < prodTabDefs.value.length - 1) {
    prodTabIdx.value++
  } else {
    panel.value = 'export'
  }
}

// Script step navigation
const stepLabels = ['原始内容', 'AI 改写', '提取', '音色', '分镜']
const prevStepLabel = computed(() => scriptStep.value > 0 ? stepLabels[scriptStep.value - 1] : '')
const nextStepLabel = computed(() => {
  if (scriptStep.value === 4) return '进入制作'
  return stepLabels[scriptStep.value + 1] || ''
})
const canGoNext = computed(() => {
  if (scriptStep.value === 0) return !!localRaw.value.trim()
  if (scriptStep.value === 1) return !!localScript.value.trim() || !!scriptContent.value
  if (scriptStep.value === 2) return chars.value.length > 0
  if (scriptStep.value === 3) return charsVoiced.value > 0
  if (scriptStep.value === 4) return sbs.value.length > 0
  return false
})
function goPrevStep() { if (scriptStep.value > 0) scriptStep.value-- }
function goNextStep() {
  if (scriptStep.value === 0 && localRaw.value.trim()) { saveRaw() }
  if (scriptStep.value === 1 && localScript.value.trim()) { saveScr() }
  if (scriptStep.value === 4) { panel.value = 'production'; return }
  if (canGoNext.value) scriptStep.value++
}

function gridSelectAll() {
  if (gridSelected.value.length === sbs.value.length) gridSelected.value = []
  else gridSelected.value = sbs.value.map(s => s.id)
}

function openGridTool() {
  gridStep.value = 0
  gridSelected.value = []
  gridSingleTarget.value = null
  gridActiveShotIds.value = []
  gridPromptText.value = ''
  gridCellPrompts.value = []
  gridPromptSource.value = ''
  gridPromptStatus.value = ''
  gridAssignmentsState.value = []
  gridDialog.value = true
}

function persistGridImagePath(value) {
  if (typeof window === 'undefined') return
  if (!value) {
    window.localStorage.removeItem(gridStorageKey.value)
    return
  }
  const current = restoreGridState() || {}
  const entries = current.entries || {}
  entries[value] = {
    generationId: gridGenId.value,
    layout: gridActualLayout.value,
    shotIds: gridActiveShotIds.value,
    assignments: gridAssignmentsState.value,
    recoveredAt: gridRecoveredAt.value,
    recoveredMode: gridRecoveredMode.value,
  }
  const payload = {
    activeImagePath: value,
    entries,
  }
  window.localStorage.setItem(gridStorageKey.value, JSON.stringify(payload))
}

function restoreGridState() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(gridStorageKey.value)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return { activeImagePath: raw, entries: { [raw]: {} } }
  }
}

function applyGridState(imagePath, meta = {}) {
  gridImagePath.value = imagePath || ''
  gridGenId.value = meta.generationId || meta.id || null
  if (meta.layout?.rows && meta.layout?.cols) gridActualLayout.value = meta.layout
  if (Array.isArray(meta.shotIds)) gridActiveShotIds.value = meta.shotIds
  else gridActiveShotIds.value = []
  if (Array.isArray(meta.assignments)) gridAssignmentsState.value = meta.assignments
  else gridAssignmentsState.value = []
  gridRecoveredAt.value = meta.recoveredAt || meta.createdAtLabel || ''
  gridRecoveredMode.value = meta.recoveredMode || meta.modeLabel || ''
}

function selectGridHistory(item) {
  const cached = restoreGridState()
  const cachedEntry = cached?.entries?.[item.localPath] || {}
  applyGridState(item.localPath, {
    ...item,
    ...cachedEntry,
    generationId: cachedEntry.generationId || item.id,
    recoveredAt: cachedEntry.recoveredAt || item.createdAtLabel,
    recoveredMode: cachedEntry.recoveredMode || item.modeLabel,
  })
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  persistGridImagePath(item.localPath)
}

function reopenGridPreview() {
  if (!gridImagePath.value) {
    openGridTool()
    return
  }
  gridDialog.value = true
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  gridStep.value = 3
}

function parseGridLayoutFromFrameType(value) {
  const match = String(value || '').match(/grid_[^_]+_(\d+)x(\d+)$/)
  if (!match) return null
  return { rows: Number(match[1]) || 3, cols: Number(match[2]) || 3 }
}

function continueGridSplit() {
  if (!gridImagePath.value) {
    toast.warning('还没有可继续切割的宫格图')
    return
  }
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  gridDialog.value = true
  gridStep.value = 3
}

function getGridPromptShotIds() {
  if (gridMode.value === 'multi_ref') return gridSingleTarget.value ? [gridSingleTarget.value] : []
  if (gridMode.value === 'first_last') return [...gridSelected.value]
  return gridSelected.value.slice(0, gridTotalCells.value)
}

async function generateGridPrompt() {
  if (!gridCanStart.value) {
    toast.warning('请先选择镜头')
    return
  }
  gridPromptLoading.value = true
  gridPromptStatus.value = '正在调用 AI 生成宫格提示词...'
  gridPromptText.value = ''
  gridCellPrompts.value = []
  gridPromptSource.value = ''
  try {
    const shotIds = getGridPromptShotIds()
    const { rows, cols } = gridAutoLayout.value

    const res = await gridAPI.prompt({
      storyboard_ids: shotIds,
      drama_id: dramaId,
      episode_id: epId.value,
      rows,
      cols,
      mode: gridMode.value,
    })

    gridPromptText.value = res?.grid_prompt || ''
    gridCellPrompts.value = Array.isArray(res?.cell_prompts) ? res.cell_prompts : []
    gridPromptSource.value = res?.source || ''

    if (gridPromptText.value) {
      resetGridAssignments()
      gridPromptStatus.value = gridPromptSource.value === 'agent' ? 'AI 提示词已生成' : '已使用模板提示词'
      gridStep.value = 1
    } else {
      gridPromptStatus.value = ''
      toast.error('提示词生成失败')
    }
  } catch (e) {
    gridPromptStatus.value = ''
    toast.error(e?.message || '生成提示词失败')
  } finally {
    gridPromptLoading.value = false
  }
}

async function startGridGen() {
  let rows, cols, ids
  if (gridMode.value === 'multi_ref') {
    rows = gridAutoLayout.value.rows; cols = gridAutoLayout.value.cols; ids = [gridSingleTarget.value]
  } else {
    rows = gridAutoLayout.value.rows; cols = gridAutoLayout.value.cols; ids = gridSelected.value.slice(0, gridTotalCells.value)
    if (gridMode.value === 'first_last') ids = [...gridSelected.value]
  }
  gridActiveShotIds.value = ids.filter(Boolean)
  gridActualLayout.value = { rows, cols }
  if (!gridAssignmentsState.value.length) resetGridAssignments()
  gridStep.value = 2
  gridStatusText.value = '提交生成请求...'
  try {
    const res = await gridAPI.generate({
      storyboard_ids: ids,
      drama_id: dramaId,
      episode_id: epId.value,
      rows,
      cols,
      mode: gridMode.value,
      custom_prompt: gridPromptText.value || undefined,
      aspect_ratio: episode.value?.aspect_ratio || '16:9',
    })
    gridGenId.value = res.image_generation_id
    gridActualLayout.value = res.grid || { rows, cols }
    gridStatusText.value = '等待图片生成...'
    await loadCreationTasks()
    pollGridStatus()
  } catch (e) {
    toast.error(e.message)
    gridStep.value = 0
  }
}

async function pollGridStatus() {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const res = await gridAPI.status(gridGenId.value)
      gridStatusText.value = `状态: ${res.status}`
      if (res.status === 'completed' && res.local_path) {
        gridImagePath.value = res.local_path
        gridGenId.value = gridGenId.value || res.id || null
        persistGridImagePath(res.local_path)
        gridStep.value = 3
        return
      }
      if (res.status === 'failed') {
        toast.error(res.error_msg || '生成失败')
        gridStep.value = 0
        return
      }
    } catch {}
  }
  toast.error('生成超时'); gridStep.value = 0
}

async function hydrateShotFrameFailures() {
  // 从图片生成记录里恢复历史失败态：某镜头某帧最新记录为 failed 且当前无图 → 标记失败
  try {
    const rows = await imageAPI.list({ drama_id: dramaId })
    const list = Array.isArray(rows) ? rows : []
    const sbIds = new Set(sbs.value.map(s => s.id))
    const latestByKey = new Map()
    for (const row of list) {
      const sid = row?.storyboard_id ?? row?.storyboardId
      const ft = String(row?.frame_type || row?.frameType || '')
      if (!sbIds.has(sid) || (ft !== 'first_frame' && ft !== 'last_frame')) continue
      const key = framePendingKey(sid, ft)
      const prev = latestByKey.get(key)
      if (!prev || Number(row?.id || 0) > Number(prev?.id || 0)) latestByKey.set(key, row)
    }
    const next = {}
    for (const [key, row] of latestByKey) {
      const [sid, ft] = key.split(':')
      if (row?.status === 'failed' && !hasShotFrame(Number(sid), ft)) {
        next[key] = row?.error_msg || row?.errorMsg || '生成失败'
      }
    }
    failedShotFrameMessages.value = next
  } catch {}
}

async function loadLatestGridImage() {
  try {
    const rows = await imageAPI.list({ drama_id: dramaId })
    const list = Array.isArray(rows) ? rows : []
    const grids = list
      .filter((row) => row?.status === 'completed' && String(row?.frame_type || row?.frameType || '').startsWith('grid_') && (row?.local_path || row?.localPath))
      .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))
      .map((row) => {
        const frameType = String(row?.frame_type || row?.frameType || '')
        const parsedLayout = parseGridLayoutFromFrameType(frameType) || { rows: 3, cols: 3 }
        return {
          id: row.id,
          localPath: row?.local_path || row?.localPath || '',
          layout: parsedLayout,
          modeLabel: frameType.replace(/^grid_/, '').replace(/_/g, ' · '),
          createdAtLabel: row?.created_at || row?.createdAt || '',
        }
      })

    gridHistory.value = grids

    const cached = restoreGridState()
    const preferredPath = cached?.activeImagePath && grids.some(item => item.localPath === cached.activeImagePath)
      ? cached.activeImagePath
      : grids[0]?.localPath
    const current = grids.find(item => item.localPath === preferredPath)
    if (current) {
      const cachedEntry = cached?.entries?.[current.localPath] || {}
      applyGridState(current.localPath, {
        ...current,
        ...cachedEntry,
        generationId: cachedEntry.generationId || current.id,
        recoveredAt: cachedEntry.recoveredAt || current.createdAtLabel,
        recoveredMode: cachedEntry.recoveredMode || current.modeLabel,
      })
      if (!gridAssignmentsState.value.length) resetGridAssignments()
      persistGridImagePath(current.localPath)
      return
    }
  } catch {}

  const cached = restoreGridState()
  if (cached?.activeImagePath) {
    const cachedEntry = cached?.entries?.[cached.activeImagePath] || {}
    applyGridState(cached.activeImagePath, {
      ...cachedEntry,
      recoveredAt: cachedEntry.recoveredAt || '',
      recoveredMode: cachedEntry.recoveredMode || '',
    })
  }
}

async function doGridSplit() {
  const { rows, cols } = gridActualLayout.value
  try {
    const assignments = gridAssignments.value
      .filter(item => !!item.storyboard_id)
      .map(item => ({ storyboard_id: item.storyboard_id, frame_type: item.frame_type }))
    if (!assignments.length) {
      toast.warning('请至少分配一个格子')
      return
    }
    const res = await gridAPI.split({ image_generation_id: gridGenId.value, rows, cols, assignments })
    gridSplitTaskId.value = res?.task_id || null
    persistGridImagePath(gridImagePath.value)
    gridStep.value = 4
    toast.success('切图分配任务已加入队列')
    await refresh()
    watchAsyncResult(() => {
      const task = currentGridSplitTask()
      if (!task && gridSplitTaskId.value) return false
      return !gridSplitTaskId.value || task?.status === 'succeeded' || isFailedTask(task)
    }, 24)
  } catch (e) {
    toast.error(e.message)
  }
}

const charImgCount = computed(() => visualChars.value.filter(c => c.image_url || c.imageUrl).length)
const sceneImgCount = computed(() => scenes.value.filter(s => s.image_url || s.imageUrl).length)
const ttsEligibleCount = computed(() => sbs.value.filter(s => hasDialogue(s)).length)
const ttsGeneratedCount = computed(() => sbs.value.filter(s => hasDialogue(s) && hasTTS(s)).length)
const latestTTSTasks = computed(() => sbs.value
  .filter(hasDialogue)
  .map(sb => shotTTSTask(sb.id))
  .filter(Boolean))
const ttsQueuedCount = computed(() => latestTTSTasks.value.filter(t => String(t.status || '') === 'queued').length)
const ttsRunningCount = computed(() => latestTTSTasks.value.filter(t => String(t.status || '') === 'running').length)
const ttsFailedCount = computed(() => latestTTSTasks.value.filter(t => isFailedTask(t)).length)
const ttsActiveCount = computed(() => latestTTSTasks.value.filter(t => isActiveTask(t)).length)
const latestNarrationAudioTasks = computed(() => sbs.value
  .filter(sb => (sb.narration || '').trim())
  .map(sb => shotNarrationAudioTask(sb.id))
  .filter(Boolean))
const latestNarrationEpisodeTask = computed(() => episodeNarrationAudioTask())
const narrationAudioQueuedCount = computed(() => {
  const childCount = latestNarrationAudioTasks.value.filter(t => String(t.status || '') === 'queued').length
  return childCount || (String(latestNarrationEpisodeTask.value?.status || '') === 'queued' ? 1 : 0)
})
const narrationAudioRunningCount = computed(() => {
  const childCount = latestNarrationAudioTasks.value.filter(t => String(t.status || '') === 'running').length
  return childCount || (String(latestNarrationEpisodeTask.value?.status || '') === 'running' ? 1 : 0)
})
const narrationAudioFailedCount = computed(() =>
  latestNarrationAudioTasks.value.filter(t => isFailedTask(t)).length + (isFailedTask(latestNarrationEpisodeTask.value) ? 1 : 0))
const narrationAudioActiveCount = computed(() => narrationAudioQueuedCount.value + narrationAudioRunningCount.value)
const batchNarrationAudioPending = computed(() => batchNarrationAudioRunning.value || narrationAudioActiveCount.value > 0)
const batchNarrationAudioButtonText = computed(() => {
  if (batchNarrationAudioRunning.value) return '提交中'
  if (narrationAudioRunningCount.value) return `生成中 ${narrationAudioRunningCount.value}`
  if (narrationAudioQueuedCount.value) return `排队中 ${narrationAudioQueuedCount.value}`
  if (usesOriginalNarrationText.value) return narrationCount.value ? '重新生成全部原文TTS音频' : '生成全部原文TTS音频'
  return narrationCount.value ? '重新生成全部解说音频' : '生成全部解说音频'
})
const batchNarrationAudioTitle = computed(() => usesOriginalNarrationText.value
  ? '按原文 TTS 文本批量重新生成音频，不生成 AI 解说文案'
  : '用当前解说音色批量重新生成所有镜头的解说音频')
const shotImgCount = computed(() => sbs.value.filter(s => s.first_frame_image || s.firstFrameImage || s.last_frame_image || s.lastFrameImage || s.composed_image || s.composedImage).length)
const shotVidCount = computed(() => sbs.value.filter(s => s.video_url || s.videoUrl).length)
const visualCharTotal = computed(() => visualChars.value.length)

const prodTabDefs = computed(() => [
  { id: 'chars', label: '角色形象', icon: Users, badge: '' },
  { id: 'scenes', label: '场景', icon: MapPin, badge: '' },
  { id: 'dubbing', label: '配音', icon: Mic2, badge: '' },
  { id: 'shots', label: '分镜图', icon: ImageIcon, badge: shotImgCount.value ? `${shotImgCount.value}/${sbs.value.length}` : '' },
  { id: 'videos', label: isImageStory.value ? 'AI视频升级' : '视频生成', icon: Video, badge: shotVidCount.value ? `${shotVidCount.value}/${sbs.value.length}` : '' },
  { id: 'compose', label: isImageStory.value ? '镜头合成' : '视频合成', icon: Layers, badge: composedCount.value ? `${composedCount.value}/${sbs.value.length}` : '' },
])

const mainStageDefs = [
  { id: 'script', label: '剧本', desc: '内容改写与整理', icon: FileText },
  { id: 'assets', label: '资产', desc: '角色、场景与音色', icon: FolderKanban },
  { id: 'storyboard', label: '分镜', desc: '镜头制作与合成', icon: Clapperboard },
  { id: 'export', label: '导出', desc: '拼接与成片输出', icon: Download },
]

const sidebarSections = computed(() => ([
  {
    id: 'script',
    label: '剧本',
    items: [
      { key: 'script:raw', label: '原始内容', desc: '', icon: FileText, done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', desc: '', icon: FileText, done: !!scriptContent.value },
      { key: 'script:extract', label: '提取', desc: '', icon: Users, done: !!chars.value.length },
      { key: 'script:voice', label: '音色', desc: '', icon: Mic2, done: !!chars.value.length && charsVoiced.value === chars.value.length },
      { key: 'script:storyboard', label: '分镜', desc: '', icon: Clapperboard, done: !!sbs.value.length },
    ],
  },
  {
    id: 'production',
    label: '制作',
    items: [
      { key: 'prod:chars', label: '角色形象', desc: '', icon: Users, done: prodStepDone('chars') },
      { key: 'prod:scenes', label: '场景图片', desc: '', icon: MapPin, done: prodStepDone('scenes') },
      { key: 'prod:dubbing', label: '配音生成', desc: '', icon: Mic2, done: prodStepDone('dubbing') },
      { key: 'prod:shots', label: '镜头图片', desc: '', icon: ImageIcon, done: prodStepDone('shots') },
  { key: 'prod:videos', label: isImageStory.value ? 'AI视频升级' : '视频生成', desc: '', icon: Video, done: prodStepDone('videos') },
  { key: 'prod:compose', label: isImageStory.value ? '镜头合成' : '视频合成', desc: '', icon: Layers, done: prodStepDone('compose') },
    ],
  },
  {
    id: 'export',
    label: '导出',
    items: [
      { key: 'export:merge', label: '拼接导出', desc: '', icon: Download, done: !!mergeUrl.value },
    ],
  },
]).map(section => ({
  ...section,
  // 有活跃任务即视为执行中（允许已完成的步骤在重跑时再次显示执行状态）
  items: section.items.map(item => ({ ...item, running: stepRunning(item.key) })),
})))

const activeMainStage = computed(() => {
  if (panel.value === 'export') return 'export'
  if (panel.value === 'production') {
    return ['chars', 'scenes'].includes(prodTab.value) ? 'assets' : 'storyboard'
  }
  if (scriptStep.value <= 1) return 'script'
  if (scriptStep.value <= 3) return 'assets'
  return 'storyboard'
})

function mainStageDone(stageId) {
  if (stageId === 'script') return !!scriptContent.value
  if (stageId === 'assets') {
    const charsReady = !!chars.value.length && charsVoiced.value === chars.value.length
    const charImagesReady = !visualCharTotal.value || charImgCount.value === visualCharTotal.value
    const sceneImagesReady = !scenes.value.length || sceneImgCount.value === scenes.value.length
    return charsReady && charImagesReady && sceneImagesReady
  }
  if (stageId === 'storyboard') {
    if (!sbs.value.length) return false
    const ttsReady = !ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value
    const videosReady = isImageStory.value || shotVidCount.value === sbs.value.length
    return ttsReady
      && shotImgCount.value === sbs.value.length
      && videosReady
      && composedCount.value > 0
  }
  if (stageId === 'export') return !!mergeUrl.value
  return false
}

function goMainStage(stageId) {
  if (stageId === 'script') {
    panel.value = 'script'
    scriptStep.value = Math.min(scriptStep.value, 1)
    return
  }
  if (stageId === 'assets') {
    const hasAssetWorkspace = !!visualCharTotal.value || !!scenes.value.length
    const hasPendingAssetGeneration = (visualCharTotal.value && charImgCount.value < visualCharTotal.value)
      || (scenes.value.length && sceneImgCount.value < scenes.value.length)
    if (panel.value === 'production' || hasPendingAssetGeneration || hasAssetWorkspace) {
      panel.value = 'production'
      prodTab.value = ['chars', 'scenes'].includes(prodTab.value) ? prodTab.value : 'chars'
      return
    }
    panel.value = 'script'
    scriptStep.value = chars.value.length ? 3 : 2
    return
  }
  if (stageId === 'storyboard') {
    if (panel.value === 'production') {
      prodTab.value = ['dubbing', 'shots', 'videos', 'compose'].includes(prodTab.value) ? prodTab.value : 'dubbing'
      return
    }
    panel.value = 'script'
    scriptStep.value = 4
    return
  }
  panel.value = 'export'
}

const activeSubSteps = computed(() => {
  if (activeMainStage.value === 'script') {
    return [
      { key: 'script:raw', label: '原始内容', done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', done: !!scriptContent.value },
    ]
  }
  if (activeMainStage.value === 'assets') {
    return [
      { key: 'script:extract', label: '提取角色场景', done: !!chars.value.length },
      { key: 'script:voice', label: '分配音色', done: !!chars.value.length && charsVoiced.value === chars.value.length },
      { key: 'prod:chars', label: '角色形象', done: !visualCharTotal.value || charImgCount.value === visualCharTotal.value },
      { key: 'prod:scenes', label: '场景图片', done: !scenes.value.length || sceneImgCount.value === scenes.value.length },
    ]
  }
  if (activeMainStage.value === 'storyboard') {
    return [
      { key: 'script:storyboard', label: '分镜拆解', done: !!sbs.value.length },
      { key: 'prod:dubbing', label: '配音生成', done: !ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value },
      { key: 'prod:shots', label: '镜头图片', done: !!sbs.value.length && shotImgCount.value === sbs.value.length },
      { key: 'prod:videos', label: '视频生成', done: !!sbs.value.length && shotVidCount.value === sbs.value.length },
      { key: 'prod:compose', label: '视频合成', done: !!sbs.value.length && composedCount.value === sbs.value.length },
    ]
  }
  return [
    { key: 'export:merge', label: '拼接导出', done: !!mergeUrl.value },
  ]
})

const activeSubStepKey = computed(() => {
  if (panel.value === 'script') {
    if (scriptStep.value === 0) return 'script:raw'
    if (scriptStep.value === 1) return 'script:rewrite'
    if (scriptStep.value === 2) return 'script:extract'
    if (scriptStep.value === 3) return 'script:voice'
    return 'script:storyboard'
  }
  if (panel.value === 'production') return `prod:${prodTab.value}`
  return 'export:merge'
})

const sidebarJumpSteps = computed(() => {
  const section = sidebarSections.value.find((item) => item.items.some(step => step.key === activeSubStepKey.value))
  return section?.items || []
})

const bubbleSteps = computed(() => {
  if (panel.value === 'script') {
    return [
      { key: 'script:raw', label: '原始内容', done: !!rawContent.value },
      { key: 'script:rewrite', label: 'AI 改写', done: !!scriptContent.value },
      { key: 'script:extract', label: '提取', done: !!chars.value.length },
      { key: 'script:voice', label: '音色', done: !!chars.value.length && charsVoiced.value === chars.value.length },
      { key: 'script:storyboard', label: '分镜', done: !!sbs.value.length },
    ]
  }
  if (panel.value === 'production') {
    return prodTabDefs.value.map(step => ({
      key: `prod:${step.id}`,
      label: step.label,
      done: prodStepDone(step.id),
    }))
  }
  return []
})

const activeBubbleKey = computed(() => {
  if (panel.value === 'script') return activeSubStepKey.value
  if (panel.value === 'production') return `prod:${prodTab.value}`
  return ''
})

const showBottomBubble = computed(() => panel.value === 'script' || panel.value === 'production')

function goSubStep(key) {
  if (key.startsWith('script:')) {
    panel.value = 'script'
    const stepMap = {
      'script:raw': 0,
      'script:rewrite': 1,
      'script:extract': 2,
      'script:voice': 3,
      'script:storyboard': 4,
    }
    scriptStep.value = stepMap[key] ?? 0
    return
  }
  if (key.startsWith('prod:')) {
    panel.value = 'production'
    prodTab.value = key.replace('prod:', '')
    return
  }
  panel.value = 'export'
}

const pipelineProgress = computed(() => {
  let p = 0
  if (rawContent.value) p++
  if (scriptContent.value) p++
  if (chars.value.length) p++
  if (charsVoiced.value) p++
  if (sbs.value.length) p++
  if (sbs.value.length && (!ttsEligibleCount.value || ttsGeneratedCount.value === ttsEligibleCount.value)) p++
  if (sbs.value.some(s => s.composed_image || s.composedImage)) p++
  if (sbs.value.some(s => s.video_url || s.videoUrl)) p++
  if (sbs.value.length && composedCount.value === sbs.value.length) p++
  if (mergeUrl.value) p++
  return p
})

const currentStageLabel = computed(() => {
  if (panel.value === 'script') return `剧本阶段 · ${stepLabels[scriptStep.value]}`
  if (panel.value === 'production') return `制作阶段 · ${prodTabDefs.value[prodTabIdx.value]?.label || '制作'}`
  return mergeUrl.value ? '导出阶段 · 成片已生成' : '导出阶段 · 等待拼接'
})

const currentMainStageLabel = computed(() => {
  const current = mainStageDefs.find(stage => stage.id === activeMainStage.value)
  return current?.label || '工作台'
})

const currentSubStageLabel = computed(() => {
  const current = activeSubSteps.value.find(step => step.key === activeSubStepKey.value)
  return current?.label || currentStageLabel.value
})

function updateCharVoice(charId, voiceId) {
  characterAPI.update(charId, { voice_style: voiceId, voice_provider: lockedAudioProvider.value || undefined })
  const c = chars.value.find(ch => ch.id === charId)
  if (c) {
    c.voice_style = voiceId
    c.voiceStyle = voiceId
    c.voice_provider = lockedAudioProvider.value || ''
    c.voiceProvider = lockedAudioProvider.value || ''
    c.voice_sample_url = ''
    c.voiceSampleUrl = ''
  }
}
function getVoiceProfile(voiceId) {
  return voiceProfiles.value.find(v => v.id === voiceId) || null
}
const selectedSb = ref(null)
const bgmLibraryInfo = ref(null)
async function loadBgmLibraryInfo() {
  const url = selectedSb.value?.bgm_audio_url || selectedSb.value?.bgmAudioUrl
  if (!url) {
    bgmLibraryInfo.value = null
    return
  }
  try {
    bgmLibraryInfo.value = await libraryAPI.lookupMusic(url)
  } catch {
    bgmLibraryInfo.value = null
  }
}
const sfxLibraryInfo = ref(null)
async function loadSfxLibraryInfo() {
  const url = selectedSb.value?.sfx_audio_url || selectedSb.value?.sfxAudioUrl
  if (!url) {
    sfxLibraryInfo.value = null
    return
  }
  try {
    sfxLibraryInfo.value = await libraryAPI.lookupSfx(url)
  } catch {
    sfxLibraryInfo.value = null
  }
}
const ambientLibraryInfo = ref(null)
async function loadAmbientLibraryInfo() {
  const url = selectedSb.value?.ambient_audio_url || selectedSb.value?.ambientAudioUrl
  if (!url) {
    ambientLibraryInfo.value = null
    return
  }
  try {
    ambientLibraryInfo.value = await libraryAPI.lookupSfx(url)
  } catch {
    ambientLibraryInfo.value = null
  }
}
watch(selectedSb, async () => {
  await loadBgmLibraryInfo()
  await loadSfxLibraryInfo()
  await loadAmbientLibraryInfo()
}, { immediate: true, deep: true })
const totalDuration = computed(() => sbs.value.reduce((s, sb) => s + (sb.duration || 8), 0))
const storyRichShotCount = computed(() => sbs.value.filter(isStoryRichShot).length)
const storySignalSummary = computed(() => STORY_SIGNAL_RULES.map(rule => ({
  label: rule.label,
  count: sbs.value.filter(sb => getShotStorySignals(sb).includes(rule.label)).length,
})))
const selectedSbStorySignals = computed(() => selectedSb.value ? getShotStorySignals(selectedSb.value) : [])
const selectedSbStoryCarriers = computed(() => selectedSb.value ? getShotStoryCarriers(selectedSb.value) : [])
const selectedSbStorySummary = computed(() => {
  if (!selectedSb.value) return '请选择镜头查看故事保真情况。'
  const signals = selectedSbStorySignals.value
  const carriers = selectedSbStoryCarriers.value
  if (!carriers.length) {
    return '当前镜头主要留下了动作壳子，缺少能承住心理、背景、因果或悬念的信息。'
  }
  const carrierLabels = carriers.map(item => item.label).join('、')
  if (signals.length) {
    return `当前镜头承住了${signals.join('、')}信息，主要落在${carrierLabels}里。`
  }
  if (carriers.length >= 3) {
    return `当前镜头的信息载体较完整，主要通过${carrierLabels}在补足上下文。`
  }
  return `当前镜头仍以显性动作交代为主，现有信息主要落在${carrierLabels}里，建议再补一层旁白、结果或氛围。`
})
const shotTypes = [
  '大远景', '远景', '全景', '中景', '中近景', '近景', '特写', '大特写',
  '双人镜头', '三人镜头', '群像', '背影', '侧面', '正面', '俯视', '仰视',
  '过肩', '主观视角', '航拍', '运动镜头',
]
const shotAngles = ['平视', '仰视', '俯视', '侧拍', '背拍', '斜侧', '主观视角', '过肩']
const shotMovements = ['固定', '推镜', '拉镜', '摇镜', '移镜', '跟拍', '升降', '手持', '环绕']

function updateField(sb, field, value) {
  const current = sb[field] ?? sb[toCamel(field)]
  if (current === value) return
  sb[field] = value
  const camelField = toCamel(field)
  if (camelField !== field) sb[camelField] = value
  storyboardAPI.update(sb.id, { [field]: value })
}

function toCamel(field) {
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function getStoryboardCharacterIds(sb) {
  return sb?.character_ids || sb?.characterIds || []
}

function getShotFieldValue(sb, field) {
  if (!sb) return ''
  const camelField = toCamel(field)
  const value = sb[field] ?? sb[camelField] ?? ''
  if (Array.isArray(value)) return value.join('、').trim()
  return String(value || '').trim()
}

function getShotStoryCarriers(sb) {
  return STORY_CARRIER_FIELDS
    .map(item => ({ ...item, value: getShotFieldValue(sb, item.key) }))
    .filter(item => item.value)
}

function getShotStoryText(sb) {
  if (!sb) return ''
  const carriers = getShotStoryCarriers(sb)
  const context = [getShotFieldValue(sb, 'title'), getShotFieldValue(sb, 'location'), getShotFieldValue(sb, 'time')].filter(Boolean)
  return [
    context.join(' '),
    ...carriers.map(item => `${item.label}：${item.value}`),
  ].filter(Boolean).join('\n')
}

function getShotStorySignals(sb) {
  const text = getShotStoryText(sb)
  if (!text) return []
  return STORY_SIGNAL_RULES
    .filter(rule => rule.pattern.test(text))
    .map(rule => rule.label)
}

function isStoryRichShot(sb) {
  const carriers = getShotStoryCarriers(sb)
  return getShotStorySignals(sb).length > 0 || carriers.length >= 3
}

function getStoryboardCharacterNames(sb) {
  const ids = getStoryboardCharacterIds(sb)
  return chars.value.filter(char => ids.includes(char.id)).map(char => char.name)
}

function isStoryboardCharacterSelected(sb, charId) {
  return getStoryboardCharacterIds(sb).includes(charId)
}

function toggleStoryboardCharacter(sb, charId) {
  const currentIds = getStoryboardCharacterIds(sb)
  const nextIds = currentIds.includes(charId)
    ? currentIds.filter(id => id !== charId)
    : [...currentIds, charId]
  updateField(sb, 'character_ids', nextIds)
}

function getSceneName(sb) {
  const sceneId = sb?.scene_id || sb?.sceneId
  if (!sceneId) return '未绑定场景'
  const scene = scenes.value.find(s => s.id === sceneId)
  return scene ? `${scene.location} · ${scene.time || '未设时间'}` : `场景 #${sceneId}`
}

async function deleteShot(sb) {
  if (!confirm('确定删除此镜头？')) return
  const idx = sbs.value.indexOf(sb)
  await storyboardAPI.del(sb.id)
  await refresh()
  if (sbs.value.length) selectedSb.value = sbs.value[Math.min(idx, sbs.value.length - 1)]
  else selectedSb.value = null
}

const scriptSteps = computed(() => {
  const hasScript = !!scriptContent.value
  const hasChars = chars.value.length > 0 && hasScript
  const hasVoice = charsVoiced.value > 0 && hasChars
  const hasSbs = sbs.value.length > 0
  return [
    { label: '原始内容', state: rawContent.value ? 'done' : 'active', spinning: false },
    { label: 'AI 改写', state: hasScript ? 'done' : (rawContent.value ? 'active' : ''), spinning: rt.value === 'script_rewriter' },
    { label: '提取', state: hasChars ? 'done' : (hasScript ? 'active' : ''), spinning: rt.value === 'extractor' },
    { label: '音色', state: hasVoice ? 'done' : (hasChars ? 'active' : ''), spinning: rt.value === 'voice_assigner' },
    { label: '分镜', state: hasSbs ? 'done' : (hasVoice ? 'active' : ''), spinning: rt.value === 'storyboard_breaker' },
  ]
})

watch(rawContent, v => { localRaw.value = v }, { immediate: true })
watch(scriptContent, v => { localScript.value = v }, { immediate: true })

function currentGridSplitTask() {
  if (!gridSplitTaskId.value) return null
  return mediaTasks.value.find(task => Number(task?.id || 0) === Number(gridSplitTaskId.value)) || null
}

function isGridSplitPending() {
  if (!gridSplitTaskId.value) return false
  const task = currentGridSplitTask()
  return !task || isActiveTask(task)
}

function gridSplitError() {
  const task = currentGridSplitTask()
  return isFailedTask(task) ? taskFailureMessage(task) : ''
}

async function refresh(options = {}) {
  try {
    drama.value = await dramaAPI.get(dramaId)
    const ep = drama.value.episodes?.find(e => (e.episode_number || e.episodeNumber) === episodeNumber)
    if (ep) {
      episode.value = ep
      try { chars.value = await episodeAPI.characters(ep.id) } catch { chars.value = [] }
      try { scenes.value = await episodeAPI.scenes(ep.id) } catch { scenes.value = [] }
      sbs.value = await episodeAPI.storyboards(ep.id)
      // sbs 已替换为全新对象，重新把 selectedSb 指到对应的新对象，避免渲染旧数据(如旁白)
      if (sbs.value.length) {
        const prevId = selectedSb.value?.id
        selectedSb.value = sbs.value.find(s => s.id === prevId) || sbs.value[0]
      } else {
        selectedSb.value = null
      }
      await loadAgentTasks(dramaId, ep.id, refresh)
      if (!options.skipTasks) await loadCreationTasks()

      const epHasContent = !!(episode.value?.content)
      const epHasScript = !!(episode.value?.script_content || episode.value?.scriptContent)
      const epHasSbs = sbs.value.length > 0

      if (epHasSbs) scriptStep.value = 4
      else if (epHasScript && chars.value.some(c => c.voice_style || c.voiceStyle)) scriptStep.value = 3
      else if (epHasScript && chars.value.length) scriptStep.value = 2
      else if (epHasScript || epHasContent) scriptStep.value = 1
      else scriptStep.value = 0
      await loadLatestGridImage()
    }
  } catch (e) {
    toast.error(e.message)
  }
  try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
}

function saveRaw() { episodeAPI.update(epId.value, { content: localRaw.value }); episode.value.content = localRaw.value }
function saveScr() { episodeAPI.update(epId.value, { script_content: localScript.value }); episode.value.script_content = localScript.value }
function useStoryValidationSample() {
  localRaw.value = STORY_VALIDATION_SAMPLE
  saveRaw()
  toast.success('已写入故事保真测试样例')
}
async function toggleAutoMode() {
  const next = !autoMode.value
  if (!next) {
    try {
      await episodeAPI.update(epId.value, { auto_mode: false })
      episode.value.auto_mode = false
      toast.success('已切换为手动模式，自动推进已暂停')
    } catch (e) {
      toast.error(e?.message || '切换失败')
    }
    return
  }
  dialogEnableAiRewrite.value = enableAiRewrite.value
  autoStartDialogOpen.value = true
}
async function confirmAutoStart() {
  try {
    await episodeAPI.update(epId.value, { auto_mode: true, enable_ai_rewrite: dialogEnableAiRewrite.value })
    episode.value.auto_mode = true
    episode.value.enable_ai_rewrite = dialogEnableAiRewrite.value
    autoStartDialogOpen.value = false
    toast.success(dialogEnableAiRewrite.value ? '已开启自动模式并启动流程（含 AI 改写）' : '已开启自动模式并启动流程（跳过 AI 改写）')
  } catch (e) {
    toast.error(e?.message || '开启失败')
  }
}
async function toggleAiRewrite() {
  const next = !enableAiRewrite.value
  try {
    await episodeAPI.update(epId.value, { enable_ai_rewrite: next })
    episode.value.enable_ai_rewrite = next
    toast.success(next ? '已开启 AI 改写（自动模式会先改写原文）' : '已关闭 AI 改写（自动模式直接用原文）')
  } catch (e) {
    toast.error(e?.message || '切换失败')
  }
}
async function updateNarrationVoice(voiceId) {
  try {
    await episodeAPI.update(epId.value, { narration_voice_id: voiceId || null })
    episode.value.narration_voice_id = voiceId || null
    toast.success(voiceId ? '已设置解说音色' : '已恢复默认解说音色')
  } catch (e) {
    toast.error(e?.message || '设置失败')
  }
}
async function updateNarrationSpeed(speed) {
  try {
    await episodeAPI.update(epId.value, { narration_speed: speed })
    episode.value.narration_speed = speed
    toast.success(`解说语速已设为 ${speed.toFixed(1)}x`)
  } catch (e) {
    toast.error(e?.message || '设置失败')
  }
}
async function updatePacingMode(mode) {
  if (mode === pacingMode.value) return
  if (!confirm(`切换叙事节奏会清空当前分镜、旁白、配音和成片，并按“${mode === 'extreme' ? '极速' : mode === 'tight' ? '紧凑' : '标准'}”模式重新生成分镜。是否继续？`)) return
  try {
    const result = await episodeAPI.update(epId.value, { pacing_mode: mode })
    episode.value.pacing_mode = mode
    toast.success(`已切换为${mode === 'extreme' ? '极速' : mode === 'tight' ? '紧凑' : '标准'}节奏，分镜重新生成中`)
    if (result.pacing_task_ids) {
      watchAsyncResult(() => {
        loadAgentTasks()
        const stillRunning = rn.value && ['storyboard_breaker', 'storyboard_splitter', 'narrator'].includes(rt.value)
        return !stillRunning
      }, 60)
    }
  } catch (e) {
    toast.error(e?.message || '切换失败')
  }
}
async function updateDialogueMode(mode) {
  if (mode === dialogueMode.value) return
  if (!confirm(`切换对白模式会清空当前分镜、旁白、配音和成片，并按“${mode === 'narration_only' ? '无对白' : '含对白'}”模式重新生成分镜。是否继续？`)) return
  try {
    const result = await episodeAPI.update(epId.value, { dialogue_mode: mode })
    episode.value.dialogue_mode = mode
    toast.success(`已切换为${mode === 'narration_only' ? '无对白' : '含对白'}模式，分镜重新生成中`)
    if (result.pacing_task_ids) {
      watchAsyncResult(() => {
        loadAgentTasks()
        const stillRunning = rn.value && ['storyboard_breaker', 'storyboard_splitter', 'narrator'].includes(rt.value)
        return !stillRunning
      }, 60)
    }
  } catch (e) {
    toast.error(e?.message || '切换失败')
  }
}
async function updateSubtitleEnabled(e) {
  const value = e.target.checked
  try {
    await episodeAPI.update(epId.value, { subtitle_enabled: value })
    episode.value.subtitle_enabled = value
    toast.success(value ? '已开启字幕' : '已关闭字幕')
  } catch (e) {
    toast.error(e?.message || '设置失败')
  }
}
async function updateSubtitleField(field, value) {
  try {
    await episodeAPI.update(epId.value, { [field]: value })
    episode.value[field] = value
  } catch (e) {
    toast.error(e?.message || '设置失败')
  }
}
async function generateSubtitles() {
  subtitleGenerating.value = true
  try {
    await composeAPI.generateSubtitles(epId.value)
    toast.success('字幕文件已生成')
    await refresh()
  } catch (e) {
    toast.error(e?.message || '生成失败')
  } finally {
    subtitleGenerating.value = false
  }
}
async function previewSubtitle() {
  if (!firstSubtitleStoryboard.value) return
  subtitlePreviewLoading.value = true
  subtitlePreviewUrl.value = ''
  try {
    const res = await composeAPI.subtitlePreview(firstSubtitleStoryboard.value.id)
    subtitlePreviewUrl.value = res.preview_url
  } catch (e) {
    toast.error(e?.message || '预览失败')
  } finally {
    subtitlePreviewLoading.value = false
  }
}
async function setRenderMode(mode) {
  if (mode === renderMode.value) return
  try {
    await episodeAPI.update(epId.value, { render_mode: mode })
    episode.value.render_mode = mode
    toast.success(mode === 'image_story' ? '已切换为图文叙事模式' : '已切换为 AI 视频模式')
  } catch (e) {
    toast.error(e?.message || '切换失败')
  }
}
async function confirmSetRenderMode(mode) {
  if (mode === renderMode.value) return
  const fromLabel = renderMode.value === 'image_story' ? '图文叙事' : 'AI 视频'
  const toLabel = mode === 'image_story' ? '图文叙事' : 'AI 视频'
  if (!confirm(`切换输出模式会从「${fromLabel}」变为「${toLabel}」。\n\n已合成的镜头、已生成的视频和成片将需要重新制作。是否继续？`)) return
  await setRenderMode(mode)
}
function doRewrite() { saveRaw(); runAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', dramaId, epId.value, refresh) }
function skipRewrite() {
  const raw = (localRaw.value || rawContent.value || '').trim()
  if (!raw) {
    toast.warning('请先填写原始内容')
    return
  }
  localScript.value = raw
  saveScr()
  toast.success('已跳过 AI 改写，当前将直接使用原始内容')
  scriptStep.value = 2
}
function doExtract() { saveScr(); runAgent('extractor', '请从剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并', dramaId, epId.value, afterExtract) }
async function afterExtract() {
  await refresh()
  // 提取完成后，自动用 LLM（配音导演）按性别/年龄/职业/定位分配音色，再错开同音色音调；
  // LLM 不可用时回退规则分配（规则分配自带音调去重）
  try {
    await runAgent('voice_assigner', '请为所有角色分配合适的音色', dramaId, epId.value, async () => {
      await voicesAPI.dedupePitches(epId.value)
      toast.success('已自动分配角色音色')
      await refresh()
    })
    return
  } catch (e) {
    try {
      const r = await voicesAPI.autoAssign(epId.value, false)
      if (r?.assigned?.length) toast.success(`已为 ${r.assigned.length} 个角色分配默认音色`)
    } catch (_) { /* 分配失败不阻断提取流程 */ }
  }
  await refresh()
}
async function autoAssignVoices(overwrite = false) {
  try {
    const r = await voicesAPI.autoAssign(epId.value, overwrite)
    toast.success(r?.assigned?.length ? `已分配 ${r.assigned.length} 个角色音色` : '没有需要分配的角色')
    await refresh()
  } catch (e) { toast.error(e.message) }
}
function doVoice() { runAgent('voice_assigner', '请为所有角色分配合适的音色', dramaId, epId.value, refresh) }
async function batchGenSamples() {
  const pending = chars.value.filter(c => (c.voice_style || c.voiceStyle) && !(c.voice_sample_url || c.voiceSampleUrl) && !isPendingVoiceSample(c.id))
  if (!pending.length) {
    const activeCount = chars.value.filter(c => isPendingVoiceSample(c.id)).length
    toast.info(activeCount ? '试听任务已在队列中' : (charsVoiced.value ? '所有角色的试听文件已生成' : '请先分配音色'))
    return
  }
  const results = await Promise.allSettled(pending.map(c => characterAPI.voiceSample(c.id, epId.value)))
  const okCount = results.filter(r => r.status === 'fulfilled').length
  const failCount = results.length - okCount
  if (okCount) toast.success(`已加入队列 ${okCount} 份试听文件`)
  if (failCount) toast.error(`${failCount} 份试听文件入队失败`)
  await refresh()
  if (okCount) {
    const ids = pending.map(c => c.id)
    watchAsyncResult(() => ids.every(id => {
      const char = chars.value.find(c => c.id === id)
      return !!(char?.voice_sample_url || char?.voiceSampleUrl) || !!voiceSampleError(id)
    }), 36)
  }
}
function doBreakdown() {
  const cfg = videoConfigs.value.find(c => c.id === lockedVideoConfigId.value)
  const label = cfg ? `${cfg.name} (${cfg.provider})` : '默认'
  runAgent('storyboard_breaker', `请按 story beat 先拆解故事，再生成完整分镜和视频提示词。不要删掉内心、背景、因果、动机、悬念等有效信息；若信息不宜直接拍动作，请通过反应镜头、环境细节、物件特写等方式承载。视频模型：${label}，请根据该模型的特性和时长限制生成合适的视频提示词。`, dramaId, epId.value, refresh)
}
function doSplitShots() {
  runAgent('storyboard_splitter', '请检查本集所有镜头，把旁白+对白+叙事负担超载的镜头细分为多个紧凑镜头。拆分时保留背景、心理、因果、动机、悬念等叙事功能，不要在细分过程中删掉故事信息。', dramaId, epId.value, refresh)
}
async function doNarration() {
  if (usesOriginalNarrationText.value) {
    try {
      const result = await episodeAPI.generateNarrations(epId.value)
      toast.success(result?.restored ? `已按原文回填 ${result.restored} 个镜头 TTS 文本` : '已按原文回填 TTS 文本')
      await refresh()
    } catch (e) {
      toast.error(e?.message || '按原文回填 TTS 文本失败')
    }
    return
  }
  runAgent('narrator', '请读取 original_story 原文（已按集优化），用电影解说视角把原文拆成逐镜头旁白。每镜头 1-3 句，先让观众听懂人物关系和情节，再带情绪；不要假设观众看过前文；不写内心独白；有原声对白的镜头要铺垫对白分量，不要复述台词。保存到每个镜头的 narration 字段。', dramaId, epId.value, refresh)
}
async function openAutoSplitPreview() {
  if (!epId.value) return
  autoSplitPreview.value.loading = true
  autoSplitPreview.value.open = true
  try {
    const res = await storyboardAPI.autoSplit(epId.value, true)
    const data = res?.data || {}
    autoSplitPreview.value.threshold = data.threshold || 0
    autoSplitPreview.value.shots = Array.isArray(data.shots) ? data.shots : []
    if (!autoSplitPreview.value.shots.length) {
      toast.info(data.message || '没有检测到超载镜头')
    }
  } catch (e) {
    toast.error(e?.message || '预览超载镜头失败')
    autoSplitPreview.value.open = false
  } finally {
    autoSplitPreview.value.loading = false
  }
}
function closeAutoSplitPreview() {
  autoSplitPreview.value.open = false
  autoSplitPreview.value.shots = []
  autoSplitPreview.value.executing = false
}
async function confirmAutoSplit() {
  if (!epId.value || !autoSplitPreview.value.shots.length) return
  autoSplitPreview.value.executing = true
  try {
    const res = await storyboardAPI.autoSplit(epId.value, false)
    const data = res?.data || {}
    toast.success(`已细分 ${data.created_shot_ids?.length || 0} 个新镜头，删除 ${data.deleted_shot_ids?.length || 0} 个原镜头`)
    closeAutoSplitPreview()
    await refresh()
  } catch (e) {
    toast.error(e?.message || '自动细分镜头失败')
  } finally {
    autoSplitPreview.value.executing = false
  }
}
async function genSample(id) {
  try {
    await characterAPI.voiceSample(id, epId.value)
    toast.success('试听任务已加入队列')
    await refresh()
    watchAsyncResult(() => {
      const char = chars.value.find(c => c.id === id)
      return !!(char?.voice_sample_url || char?.voiceSampleUrl) || !!voiceSampleError(id)
    }, 36)
  } catch (e) {
    toast.error(e.message)
  }
}
async function addShot() { await storyboardAPI.create({ episode_id: epId.value, storyboard_number: sbs.value.length + 1, title: `镜头${sbs.value.length + 1}`, duration: 8 }); refresh() }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function watchAsyncResult(check, attempts = 24, delay = 2500) {
  void (async () => {
    for (let i = 0; i < attempts; i++) {
      await sleep(delay)
      await refresh()
      if (check()) return
    }
  })()
}

async function genCharImg(id) {
  try {
    await characterAPI.generateImage(id, epId.value)
    toast.success('角色图片生成中')
    await refresh()
    watchAsyncResult(() => {
      const char = chars.value.find(c => c.id === id)
      return !!(char?.image_url || char?.imageUrl)
    })
  } catch (e) {
    toast.error(e.message)
  }
}
function batchCharImages() {
  const ids = visualChars.value.filter(c => !(c.image_url || c.imageUrl)).map(c => c.id)
  if (!ids.length) { toast.info('所有角色图片已生成'); return }
  characterAPI.batchImages(ids, epId.value).then(async () => {
    toast.success('角色图片批量生成中')
    await refresh()
    watchAsyncResult(() => ids.every(id => {
      const char = chars.value.find(c => c.id === id)
      return !!(char?.image_url || char?.imageUrl)
    }), 36)
  }).catch(e => {
    toast.error(e.message)
  })
}
async function genSceneImg(id) {
  try {
    await sceneAPI.generateImage(id, epId.value)
    toast.success('场景图片生成中')
    await refresh()
    watchAsyncResult(() => {
      const scene = scenes.value.find(s => s.id === id)
      return !!(scene?.image_url || scene?.imageUrl)
    })
  } catch (e) {
    toast.error(e.message)
  }
}
function batchSceneImages() {
  const ids = scenes.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
  if (!ids.length) { toast.info('所有场景图片已生成'); return }
  ids.forEach(id => { sceneAPI.generateImage(id, epId.value).then(() => refresh()).catch(e => toast.error(e.message)) })
  toast.success('场景图片批量生成中')
  watchAsyncResult(() => ids.every(id => {
    const scene = scenes.value.find(s => s.id === id)
    return !!(scene?.image_url || scene?.imageUrl)
  }), 36)
}

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function getDialogueSpeakerRaw(sb) {
  const dialogue = sb?.dialogue?.trim() || ''
  const match = dialogue.match(/^(.+?)[:：]/)
  return match ? match[1].replace(/[（(].+?[)）]/g, '').trim() : ''
}

function getDialogueText(sb) {
  const dialogue = sb?.dialogue?.trim() || ''
  return dialogue ? dialogue.replace(/^.+?[:：]\s*/, '').trim() : ''
}

function isTTSIgnorable(sb) {
  const speaker = getDialogueSpeakerRaw(sb)
  const text = getDialogueText(sb)
  if (!sb?.dialogue?.trim()) return true
  if (speaker && IGNORE_TTS_SPEAKERS.test(speaker)) return true
  if (!text) return true
  if (IGNORE_TTS_TEXT.test(text)) return true
  return false
}

function hasDialogue(sb) { return !isTTSIgnorable(sb) }
function hasTTS(sb) { return !!(sb?.tts_audio_url || sb?.ttsAudioUrl) }
function getTTSUrl(sb) { return sb?.tts_audio_url || sb?.ttsAudioUrl || '' }
function hasNarrationAudio(sb) { return !!(sb?.narration_audio_url || sb?.narrationAudioUrl) }
function getNarrationAudioUrl(sb) { return sb?.narration_audio_url || sb?.narrationAudioUrl || '' }
function getDialogueSpeaker(sb) {
  const speaker = getDialogueSpeakerRaw(sb)
  if (!speaker) return '旁白'
  return speaker
}
async function genShotTTS(sb) {
  try {
    await storyboardAPI.generateTTS(sb.id)
    toast.success(`镜头 #${sb.storyboard_number || sb.storyboardNumber || sb.id} 配音任务已加入队列`)
    await refresh()
    watchAsyncResult(() => {
      const target = sbs.value.find(item => item.id === sb.id)
      return !!(target && (hasTTS(target) || hasNarrationAudio(target))) || !!shotTTSError(sb.id)
    }, 36)
  } catch (e) { toast.error(e.message) }
}
async function batchShotTTS() {
  const pending = sbs.value.filter(sb => hasDialogue(sb) && !hasTTS(sb) && !isPendingShotTTS(sb.id))
  const activeCount = sbs.value.filter(sb => hasDialogue(sb) && isPendingShotTTS(sb.id)).length
  if (!pending.length) {
    toast.info(activeCount ? '配音任务已在队列中' : (ttsEligibleCount.value ? '所有镜头配音已生成' : '当前没有可生成的对白或旁白'))
    return
  }
  const result = await ttsAPI.all(epId.value, false)
  toast.success(`已为 ${result.total} 个镜头创建批量配音任务`)
  await refresh()
}
async function regenAllTTS() {
  // 重新生成所有可配音镜头（含已生成的），用于改音色后批量刷新
  const targets = sbs.value.filter(sb => hasDialogue(sb) && !isPendingShotTTS(sb.id))
  const activeCount = sbs.value.filter(sb => hasDialogue(sb) && isPendingShotTTS(sb.id)).length
  if (!targets.length) {
    toast.info(activeCount ? '配音任务已在队列中' : '当前没有可生成的对白或旁白')
    return
  }
  if (!confirm(`将用当前音色重新生成 ${targets.length} 个镜头的配音，覆盖旧配音。继续？`)) return
  const result = await ttsAPI.all(epId.value, true)
  toast.success(`已为 ${result.total} 个镜头创建批量重新配音任务`)
  await refresh()
}
async function batchNarrationAudio() {
  // 重新生成所有解说/旁白音频，用于改解说音色后批量刷新
  batchNarrationAudioRunning.value = true
  try {
    if (usesOriginalNarrationText.value) {
      const targetCount = narrationCount.value || sbs.value.length
      if (!targetCount) {
        toast.info('当前没有分镜，请先拆解分镜')
        return
      }
      if (!confirm(`将按原文 TTS 文本重新生成 ${targetCount} 个镜头的解说音频，覆盖旧音频。继续？`)) return
      let result = await ttsAPI.narration(epId.value, true)
      if (result?.narration_filled) {
        await refresh()
        result = await ttsAPI.narration(epId.value, true)
      }
      if (result?.total) {
        toast.success(`已为 ${result.total} 个镜头创建原文 TTS 音频重新生成任务`)
      } else {
        toast.info(result?.message || '当前没有可生成的原文 TTS 文本')
      }
      await refresh()
      return
    }
    // 没有旁白文案时先自动生成，再刷新后继续
    if (!narrationCount.value && sbs.value.length) {
      await doNarration()
      toast.info('已创建解说文案生成任务，请在文案生成后再点击生成音频')
      return
    }
    const targets = sbs.value.filter(sb => (sb.narration || '').trim() && !isPendingShotTTS(sb.id))
    const activeCount = sbs.value.filter(sb => (sb.narration || '').trim() && isPendingShotTTS(sb.id)).length
    if (!targets.length) {
      if (activeCount) {
        toast.info('解说音频任务已在队列中')
      } else if (!sbs.value.length) {
        toast.info('当前没有分镜，请先拆解分镜')
      } else if (!narrationCount.value) {
        toast.info('当前分镜还没有解说文案，请先生成解说文案')
      } else {
        toast.info('当前没有可生成的解说旁白')
      }
      return
    }
    if (!confirm(`将用当前解说音色重新生成 ${targets.length} 个镜头的解说音频，覆盖旧音频。继续？`)) return
    const result = await ttsAPI.narration(epId.value, true)
    toast.success(`已为 ${result.total} 个镜头创建解说音频重新生成任务`)
    await refresh()
  } finally {
    batchNarrationAudioRunning.value = false
  }
}

function getFirstFrame(s) { return s?.first_frame_image || s?.firstFrameImage || null }
function getLastFrame(s) { return s?.last_frame_image || s?.lastFrameImage || null }
function getStoryboardCover(s) { return s?.composed_image || s?.composedImage || getFirstFrame(s) || getLastFrame(s) || null }
function getVideoUrl(s) { return s?.video_url || s?.videoUrl || null }
function getComposedVideoUrl(s) { return s?.composed_video_url || s?.composedVideoUrl || null }
function hasImg(s) { return !!getStoryboardCover(s) }
function hasVid(s) { return !!getVideoUrl(s) }
function hasComposed(s) { return !!getComposedVideoUrl(s) }
function normalizePlayableAssetUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(raw)) return raw
  return '/' + raw.replace(/^\/+/, '')
}
function getAssetFilename(value) {
  const raw = String(value || '').split('?')[0].split('#')[0]
  const fallback = raw.split('/').filter(Boolean).pop() || raw || 'audio'
  try {
    return decodeURIComponent(fallback)
  } catch {
    return fallback
  }
}
function getAudioCheckAssets(sb) {
  const items = [
    { kind: 'bgm', label: 'BGM', path: sb?.bgm_audio_url || sb?.bgmAudioUrl },
    { kind: 'sfx', label: 'SFX', path: sb?.sfx_audio_url || sb?.sfxAudioUrl },
    { kind: 'ambient', label: '环境', path: sb?.ambient_audio_url || sb?.ambientAudioUrl },
  ]
  return items
    .map(item => ({
      kind: item.kind,
      label: item.label,
      url: normalizePlayableAssetUrl(item.path),
      name: getAssetFilename(item.path),
    }))
    .filter(item => item.url)
}
function hasAudioCheckAssets(sb) { return getAudioCheckAssets(sb).length > 0 }

function getShotReferenceImages(sb) {
  const refs = []
  const pushRef = (value) => {
    if (!value || refs.includes(value) || refs.length >= 6) return
    refs.push(value)
  }
  const primaryChar = detectPrimaryCharacter(sb)
  if (primaryChar?.image_url || primaryChar?.imageUrl) {
    pushRef(primaryChar.image_url || primaryChar.imageUrl)
  }
  for (const ref of getRefs(sb)) {
    pushRef(ref)
  }
  return refs.filter(Boolean).slice(0, 6)
}

function inferCharacterEthnicity(name) {
  if (!name || /\s/.test(name)) return ''
  return /[一-龥]{1,6}/.test(name) ? '中国人，东亚人面孔，' : ''
}

function detectPrimaryCharacter(sb) {
  const ids = getStoryboardCharacterIds(sb)
  if (ids.length <= 1) return null
  const text = `${sb.title || ''} ${sb.description || ''} ${sb.image_prompt || sb.imagePrompt || ''}`
  let best = null
  let bestScore = -1
  for (const id of ids) {
    const char = chars.value.find(item => item.id === id)
    if (!char?.name) continue
    const name = char.name
    const count = (text.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    const firstIndex = text.indexOf(name)
    const positionScore = firstIndex >= 0 ? Math.max(0, 200 - firstIndex) : 0
    const score = count * 20 + positionScore
    if (score > bestScore) {
      bestScore = score
      best = char
    }
  }
  return best
}

function buildCharacterPromptLabel(char) {
  if (!char) return ''
  const appearance = char.appearance || char.appearance_text || ''
  const description = char.description || ''
  const role = char.role || ''
  const ethnicity = inferCharacterEthnicity(char.name)
  const detail = appearance || description || role
  let detailText = ''
  if (detail) {
    const trimmed = detail.replace(/[\n\r]+/g, ' ').trim()
    const withoutNamePrefix = trimmed.startsWith(char.name)
      ? trimmed.slice(char.name.length).replace(/^[，,、\s]+/, '')
      : trimmed
    detailText = withoutNamePrefix.length > 80 ? withoutNamePrefix.slice(0, 80) + '…' : withoutNamePrefix
  }
  return `${ethnicity}“${char.name}”该角色${detailText ? '（' + detailText + '）' : ''}`
}

function expandCharacterNamesInPrompt(text, sb) {
  if (!text) return text
  let expanded = text
  for (const charId of getStoryboardCharacterIds(sb)) {
    const char = chars.value.find(item => item.id === charId)
    if (!char?.name) continue
    const escapedName = char.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(?<![一-龥])${escapedName}(?!的)`, 'g')
    expanded = expanded.replace(regex, '该角色')
  }
  return expanded
}

function buildShotImagePrompt(sb, frameType) {
  const rawDescription = sb.image_prompt || sb.imagePrompt || sb.description || ''
  const description = expandCharacterNamesInPrompt(rawDescription, sb)
  const location = sb.location || getSceneName(sb)
  const time = sb.time || ''
  const atmosphere = expandCharacterNamesInPrompt(sb.atmosphere || '', sb)
  const frameHint = frameType === 'first_frame'
    ? '起始关键帧，突出建立关系和动作开始瞬间'
    : '结束关键帧，突出动作结束、情绪落点或结果状态'
  const primaryChar = detectPrimaryCharacter(sb)
  const characterEthnicity = getStoryboardCharacterIds(sb)
    .some(id => {
      const char = chars.value.find(item => item.id === id)
      return char?.name ? inferCharacterEthnicity(char.name) : ''
    })
    ? '中国人，东亚人面孔，'
    : ''
  const primaryClause = primaryChar
    ? `画面主体是${buildCharacterPromptLabel(primaryChar)}，其他角色作为配角或背景出现。`
    : ''

  return [
    `整体风格：${drama.value?.style || 'realistic'}，`,
    location ? `地点：${location}，` : '',
    time ? `时间：${time}，` : '',
    atmosphere ? `氛围：${atmosphere}，` : '',
    primaryClause,
    description ? `画面描述：${characterEthnicity}${description}，` : '',
    frameHint,
  ].filter(Boolean).join('')
}

async function genShotFrame(sb, frameType) {
  const prompt = buildShotImagePrompt(sb, frameType)
  const referenceImages = getShotReferenceImages(sb)
  const key = framePendingKey(sb.id, frameType)
  try {
    // 重试前清掉旧的失败态
    if (failedShotFrameMessages.value[key]) {
      const next = { ...failedShotFrameMessages.value }
      delete next[key]
      failedShotFrameMessages.value = next
    }
    const body = {
      storyboard_id: sb.id,
      drama_id: dramaId,
      prompt,
      frame_type: frameType,
      aspect_ratio: episode.value?.aspect_ratio,
      reference_images: referenceImages.length ? referenceImages : undefined,
    }
    const generation = await imageAPI.generate(body)
    toast.success(frameType === 'first_frame' ? '首帧生成中' : '尾帧生成中')
    await refresh()
    pollShotFrame(generation?.id, sb.id, frameType)
  } catch (e) {
    markShotFrameFailed(key, e.message)
    toast.error(e.message)
  }
}

function markShotFrameFailed(key, message) {
  failedShotFrameMessages.value = { ...failedShotFrameMessages.value, [key]: message || '生成失败' }
}

function hasShotFrame(sbId, frameType) {
  const target = sbs.value.find(s => s.id === sbId)
  return frameType === 'first_frame' ? !!getFirstFrame(target) : !!getLastFrame(target)
}

async function pollShotFrame(generationId, sbId, frameType) {
  const key = framePendingKey(sbId, frameType)
  const clearPending = () => {}
  // 无生成 id：退回到只看结果有没有出图(超时则判失败)
  if (!generationId) {
    for (let i = 0; i < 120; i++) {
      await sleep(4000)
      await refresh()
      if (hasShotFrame(sbId, frameType)) { clearPending(); return }
    }
    clearPending(); markShotFrameFailed(key, '生成超时'); return
  }
  for (let i = 0; i < 180; i++) {
    await sleep(4000)
    try {
      const res = await imageAPI.get(generationId)
      await refresh()
      const status = res?.status
      if (status === 'completed' || hasShotFrame(sbId, frameType)) { clearPending(); return }
      if (status === 'failed') {
        clearPending()
        markShotFrameFailed(key, res?.error_msg || res?.errorMsg || '生成失败')
        toast.error(`镜头 #${sbId} ${frameType === 'first_frame' ? '首帧' : '尾帧'}生成失败`)
        return
      }
    } catch {}
  }
  clearPending(); markShotFrameFailed(key, '生成超时'); toast.error('镜头图片生成超时')
}

async function batchShotFrames() {
  const needLast = frameMode.value === 'first_last'
  // 收集所有缺图的帧任务：首帧必生，first_last 模式下尾帧也补
  const jobs = []
  for (const sb of sbs.value) {
    if (!getFirstFrame(sb) && !isPendingShotFrame(sb.id, 'first_frame')) jobs.push({ sb, frameType: 'first_frame' })
    if (needLast && !getLastFrame(sb) && !isPendingShotFrame(sb.id, 'last_frame')) jobs.push({ sb, frameType: 'last_frame' })
  }
  if (!jobs.length) {
    toast.info('所有镜头图片已生成')
    return
  }
  toast.success(`开始批量生成 ${jobs.length} 张镜头图片`)
  // 限制同时发起的 shot frame 生成数量，避免一次性把后端队列打满
  const MAX_PENDING_SHOT_FRAMES = 8
  const executing = new Set()
  for (const job of jobs) {
    const p = genShotFrame(job.sb, job.frameType).finally(() => executing.delete(p))
    executing.add(p)
    if (executing.size >= MAX_PENDING_SHOT_FRAMES) {
      await Promise.race(executing)
    }
  }
  await Promise.allSettled(executing)
}

async function genVid(sb) {
  const params = {
    storyboard_id: sb.id,
    drama_id: dramaId,
    prompt: sb.video_prompt || sb.videoPrompt || '',
    duration: Number(sb.duration || 5),
    aspect_ratio: episode.value?.aspect_ratio,
  }
  const first = getFirstFrame(sb)
  const last = getLastFrame(sb)
  const refs = getRefs(sb)
  if (first && last) { Object.assign(params, { reference_mode: 'first_last', first_frame_url: first, last_frame_url: last }) }
  else if (refs.length) { Object.assign(params, { reference_mode: 'multiple', reference_image_urls: [first, ...refs].filter(Boolean) }) }
  else if (first) { Object.assign(params, { reference_mode: 'single', image_url: first }) }
  try {
    delete failedVideoMessages.value[sb.id]
    const generation = await videoAPI.generate(params)
    toast.success('视频生成中')
    await refresh()
    pollVideoGeneration(generation?.id, sb.id)
  } catch (e) {
    toast.error(e.message)
  }
}
async function pollVideoGeneration(generationId, storyboardId) {
  if (!generationId) {
    watchAsyncResult(() => {
      const target = sbs.value.find(s => s.id === storyboardId)
      return !!(target?.video_url || target?.videoUrl)
    }, 60, 4000)
    return
  }
  for (let i = 0; i < 120; i++) {
    await sleep(4000)
    try {
      const res = await videoAPI.get(generationId)
      await refresh()
      if (res?.status === 'completed') {
        delete failedVideoMessages.value[storyboardId]
        toast.success('视频生成完成')
        return
      }
      if (res?.status === 'failed') {
        failedVideoMessages.value = {
          ...failedVideoMessages.value,
          [storyboardId]: res?.error_msg || res?.errorMsg || '视频生成失败',
        }
        toast.error(failedVideoMessages.value[storyboardId])
        return
      }
    } catch {}
  }
  failedVideoMessages.value = {
    ...failedVideoMessages.value,
    [storyboardId]: '视频生成超时',
  }
  toast.error('视频生成超时')
}
async function doCompose(sb, force = false) {
  try {
    delete failedComposeMessages.value[sb.id]
    await composeAPI.shot(sb.id, force)
    toast.success(force ? '重新合成任务已加入队列' : '合成任务已加入队列')
    await refresh()
    pollComposeStatus()
  } catch (e) {
    failedComposeMessages.value = {
      ...failedComposeMessages.value,
      [sb.id]: e.message,
    }
    toast.error(e.message)
  }
}
function batchVideos() {
  const pendingIds = sbs.value.filter(s => !hasVid(s)).map(s => s.id)
  pendingIds.forEach(id => {
    const sb = sbs.value.find(item => item.id === id)
    if (sb) genVid(sb)
  })
  if (pendingIds.length) {
    watchAsyncResult(() => pendingIds.every(id => {
      const target = sbs.value.find(s => s.id === id)
      return !!(target?.video_url || target?.videoUrl)
    }), 80, 4000)
  }
}
async function batchCompose(force = false) {
  if (force && !confirm(`将忽略缓存、用当前配音重新合成 ${sbs.value.length} 个镜头。继续？`)) return
  try {
    await composeAPI.all(epId.value, force)
    toast.success(force ? '重新合成已开始' : '批量合成已开始')
    await refresh()
    pollComposeStatus()
  } catch (e) {
    toast.error(e?.message || '批量合成启动失败')
  }
}
async function doMerge() {
  clearMergePoll()
  try {
    merging.value = true
    mergeData.value = null
    await mergeAPI.merge(epId.value)
    toast.success('拼接中...')
    await loadCreationTasks()
  } catch (e) {
    merging.value = false
    toast.error(e.message || '拼接启动失败')
    return
  }
  mergePollTimer = setInterval(async () => {
    try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
    if (mergeData.value?.status === 'completed' || mergeData.value?.status === 'failed') {
      clearMergePoll()
      merging.value = false
      mergeData.value.status === 'completed' ? toast.success('拼接完成') : toast.error(mergeFailMessage.value || '拼接失败')
    }
  }, 3000)
}

function pollMergeStatus() {
  clearMergePoll()
  mergePollTimer = setInterval(async () => {
    try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
    if (mergeData.value?.status === 'completed' || mergeData.value?.status === 'failed') {
      clearMergePoll()
      merging.value = false
    }
  }, 3000)
}

// 页面加载时若拼接仍在进行，恢复轮询，避免刷新后卡在“拼接中”不更新
function resumeMergeIfRunning() {
  if (mergeStatus.value === 'processing' || mergeStatus.value === 'pending') pollMergeStatus()
}

// 刷新页面后，若后台仍有镜头在合成（status 持久化在数据库），恢复进度轮询
function resumeComposeIfRunning() {
  const processing = sbs.value.filter(sb => (sb.status || '') === 'compose_processing')
  if (processing.length) {
    pollComposeStatus()
  }
}

async function pollComposeStatus() {
  for (let i = 0; i < 120; i++) {
    await sleep(3000)
    try {
      const res = await composeAPI.status(epId.value)
      await refresh()
      const items = Array.isArray(res?.items) ? res.items : []
      const processingIds = items.filter(item => item.status === 'compose_processing').map(item => item.id)

      const failedItems = items.filter(item => item.status === 'compose_failed')
      if (failedItems.length) {
        const next = { ...failedComposeMessages.value }
        failedItems.forEach((item) => {
          next[item.id] = item.error_msg || item.errorMsg || '视频合成失败'
        })
        failedComposeMessages.value = next
      }

      if (!processingIds.length) {
        if (failedItems.length) toast.error(`有 ${failedItems.length} 个镜头合成失败`)
        else toast.success('批量合成完成')
        return
      }
    } catch {}
  }
}
function getRefs(sb) {
  const raw = sb.reference_images || sb.referenceImages
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

async function loadConfigs() {
  try {
    const [imgCfgs, vidCfgs, audCfgs] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('audio'),
    ])
    imageConfigs.value = imgCfgs || []
    videoConfigs.value = vidCfgs || []
    audioConfigs.value = audCfgs || []
  } catch (e) { console.error('Failed to load AI configs', e) }
}

function inferVoiceGender(name, desc = []) {
  const text = `${name} ${Array.isArray(desc) ? desc.join(' ') : ''}`
  const maleKeywords = ['男', 'boy', 'man', 'male', '男主', '大爷', '学长', '少年男', '男声', '男性']
  const femaleKeywords = ['女', 'girl', 'woman', 'female', '女主', '少女', '御姐', '奶奶', '大婶', '大妈', '阿姨', '闺蜜', '女声', '女性']
  const lower = text.toLowerCase()
  if (maleKeywords.some(k => lower.includes(k.toLowerCase()))) return '男声'
  if (femaleKeywords.some(k => lower.includes(k.toLowerCase()))) return '女声'
  return '中性'
}

function mapVoiceProfile(v) {
  const desc = Array.isArray(v.description) ? v.description : []
  return {
    id: v.voice_id,
    label: v.voice_name || v.voice_id,
    gender: inferVoiceGender(v.voice_name || v.voice_id, desc),
    traits: desc.length ? desc.slice(0, 2).join('、') : `${v.language || '多语言'}音色`,
    suitable: desc.length > 2 ? desc.slice(2).join('、') : `${v.language || '通用'}角色`,
  }
}

async function loadVoices() {
  try {
    const provider = lockedAudioProvider.value || 'minimax'
    const rows = await voicesAPI.list(provider)
    voiceProfiles.value = rows?.length ? rows.map(mapVoiceProfile) : fallbackVoiceProfiles
  } catch (e) {
    console.error('Failed to load voices', e)
    voiceProfiles.value = fallbackVoiceProfiles
  }
}

watch([lockedAudioConfigId, audioConfigs], () => { loadVoices() }, { deep: true })
onMounted(() => {
  startTaskUpdates(async () => {
    await refresh({ skipTasks: true })
  })
  refresh().then(() => { hydrateShotFrameFailures(); resumeMergeIfRunning(); resumeComposeIfRunning() })
  loadConfigs()
  loadVoices()
})
</script>

<style scoped>
/* ===== Studio Layout ===== */
.studio {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  padding: 14px;
  gap: 12px;
  background:
    radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 28%),
    linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0)),
    var(--bg-base);
}

.studio-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  min-height: 46px;
  padding: 8px 12px;
  border-radius: 18px;
  background: rgba(252, 253, 255, 0.84);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 14px 36px rgba(20, 32, 54, 0.07), 0 3px 10px rgba(20, 32, 54, 0.04);
  backdrop-filter: blur(16px);
}

.settings-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: flex;
  justify-content: flex-end;
  padding: 12px;
  background: rgba(26, 37, 58, 0.26);
  backdrop-filter: blur(6px);
  animation: fadeIn 0.16s var(--ease-out);
}

.settings-drawer {
  width: min(420px, calc(100vw - 24px));
  height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(27, 41, 64, 0.12);
  border-radius: 16px;
  background: rgba(252, 253, 255, 0.96);
  box-shadow: 0 22px 60px rgba(20, 32, 54, 0.22), 0 6px 20px rgba(20, 32, 54, 0.12);
  animation: drawerSlideIn 0.18s var(--ease-out);
}

@keyframes drawerSlideIn {
  from { opacity: 0; transform: translateX(18px); }
  to { opacity: 1; transform: translateX(0); }
}

.settings-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}

.settings-drawer-kicker {
  font-size: 10px;
  font-weight: 800;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0;
}

.settings-drawer-title {
  margin-top: 2px;
  font-size: 18px;
  line-height: 1.2;
  letter-spacing: 0;
}

.drawer-close {
  flex-shrink: 0;
}

.settings-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 8px;
  background: rgba(247, 250, 255, 0.72);
}

.settings-section-title {
  font-size: 12px;
  font-weight: 800;
  color: var(--text-0);
}

.settings-control-row {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 30px;
}

.settings-control-row > .render-mode-label {
  align-self: center;
}

.settings-control-row .render-mode-switch,
.settings-control-row .narration-provider-switch {
  justify-self: end;
}

.drawer-inline-controls,
.drawer-speed-control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.drawer-speed-control {
  flex-wrap: nowrap;
}

.drawer-speed-control .speed-slider {
  width: 150px;
}

.drawer-select {
  width: 180px;
  justify-self: end;
}

.drawer-select.wide {
  width: 230px;
}

.drawer-select.compact {
  width: 132px;
}

.drawer-select.mini {
  width: 88px;
}

.settings-drawer :deep(.drawer-select .base-select-trigger) {
  height: 28px;
  min-height: 28px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 8px;
}

.drawer-subtitle-controls {
  justify-content: flex-end;
  flex-wrap: wrap;
}

.settings-section .subtitle-preview {
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
}
.studio-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  margin-top: 8px;
  border-radius: 18px;
  background: rgba(252, 253, 255, 0.84);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 8px 24px rgba(20, 32, 54, 0.05);
  backdrop-filter: blur(16px);
}

.studio-topbar-main,
.sidebar,
.main {
  background: rgba(252, 253, 255, 0.84);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 18px 48px rgba(20, 32, 54, 0.08), 0 4px 14px rgba(20, 32, 54, 0.05);
  backdrop-filter: blur(16px);
}

.studio-topbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  padding: 0;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: transparent;
  min-width: 0;
}

.topbar-back {
  width: auto;
  min-width: 76px;
  padding: 0 8px;
  height: 28px;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 11px;
}

.studio-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.studio-overline {
  display: none;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.studio-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.studio-title {
  font-size: 14px;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
}
.studio-episode-title {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-2);
  max-width: 520px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.studio-episode-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  color: var(--accent-text);
  font-size: 9px;
  font-weight: 700;
}

.studio-meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  min-width: 0;
}

.studio-meta-pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.05);
  color: var(--text-2);
  font-size: 8px;
  font-weight: 600;
  white-space: nowrap;
}

.studio-meta-pill.is-stage {
  background: rgba(19, 51, 121, 0.08);
  color: var(--accent-text);
}
.studio-meta-pill.is-progress {
  background: rgba(45, 122, 69, 0.08);
  color: var(--success);
}
.studio-meta-inline {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 600;
  white-space: nowrap;
}

.studio-topbar-side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.render-mode-section {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 3px 2px 8px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.04);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.render-mode-label {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 700;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.render-mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(27, 41, 64, 0.08);
}

.render-mode-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.render-mode-btn svg {
  flex-shrink: 0;
  opacity: 0.72;
}

.render-mode-btn.active {
  background: var(--accent-gradient);
  color: #fff;
  box-shadow: 0 8px 18px rgba(47, 111, 237, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.render-mode-btn.active svg {
  opacity: 1;
}

.render-mode-btn:not(.active):hover {
  background: var(--bg-hover);
  color: var(--text-0);
}

.render-mode-btn:active {
  transform: translateY(1px);
}

.auto-mode-section {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 3px 2px 8px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.04);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.narration-provider-section {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 3px 2px 8px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.04);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.narration-provider-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(27, 41, 64, 0.08);
}

.narration-provider-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
}

.narration-provider-btn.active {
  background: var(--accent-gradient);
  color: #fff;
  box-shadow: 0 8px 18px rgba(47, 111, 237, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.narration-provider-btn:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.narration-provider-btn:not(.active):not(:disabled):hover {
  background: var(--bg-hover);
  color: var(--text-0);
}

.provider-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.provider-dot.minimax { background: #8b5cf6; }
.provider-dot.siliconflow { background: #10b981; }

.narration-voice-section {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 8px 2px 8px;
  border-radius: 999px;
  background: rgba(18, 25, 42, 0.04);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.narration-voice-section :deep(.base-select-trigger) {
  height: 24px;
  min-height: 24px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.speed-slider {
  width: 80px;
  height: 4px;
  accent-color: var(--accent);
}
.speed-value {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  min-width: 32px;
  text-align: right;
}

.subtitle-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 10px;
}
.subtitle-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.subtitle-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.subtitle-controls :deep(.base-select-trigger) {
  height: 22px;
  min-height: 22px;
  font-size: 11px;
  border-radius: 999px;
}
.subtitle-color {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(27, 41, 64, 0.12);
  border-radius: 999px;
  cursor: pointer;
  background: transparent;
}
.subtitle-size {
  width: 48px;
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
  border: 1px solid rgba(27, 41, 64, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.74);
}
.subtitle-preview {
  width: 240px;
  height: 135px;
  border-radius: 8px;
  background: #000;
}

.auto-mode-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(27, 41, 64, 0.08);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.auto-mode-btn svg {
  flex-shrink: 0;
  opacity: 0.72;
}

.auto-mode-btn.active {
  background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 8px 18px rgba(22, 163, 74, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.auto-mode-btn.active svg {
  opacity: 1;
}

.auto-mode-btn:not(.active):hover {
  background: var(--bg-hover);
  color: var(--text-0);
}

.ai-rewrite-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.ai-rewrite-checkbox input {
  margin: 0;
}

.auto-mode-btn:active {
  transform: translateY(1px);
}

.studio-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.studio-topbar .btn {
  height: 28px;
  padding: 0 10px;
  font-size: 11px;
  white-space: nowrap;
}

.studio-body {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  flex: 1;
}

/* ===== Sidebar ===== */
.sidebar {
  width: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  border-radius: 28px;
}
.back-btn {
  width: 40px; height: 40px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(27, 41, 64, 0.1); border-radius: 14px;
  background: rgba(255,255,255,0.8); color: var(--text-2);
  cursor: pointer; transition: all 0.15s;
  box-shadow: var(--shadow-xs);
}
.back-btn:hover { background: #fff; color: var(--text-0); }

/* Pipeline Nav */
.pipeline { flex: 1; overflow-y: auto; padding: 16px 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.pipe-section { display: flex; flex-direction: column; gap: 4px; }
.pipe-section-label {
  font-size: 10px; font-weight: 700; color: #95a1b6;
  text-transform: uppercase; letter-spacing: 0.1em;
  padding: 2px 8px 3px;
}
.pipe-item {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 7px 10px;
  border-radius: 17px;
  font-size: 12px; font-weight: 600;
  background: none; border: 1px solid transparent; color: var(--text-2); cursor: pointer;
  transition: all 0.14s; width: 100%; text-align: left;
}
.pipe-item:hover { background: rgba(255,255,255,0.3); color: var(--text-0); }
.pipe-item.active {
  background: rgba(255,255,255,0.94);
  color: var(--text-0);
  border-color: rgba(27, 41, 64, 0.05);
  box-shadow: 0 8px 18px rgba(19, 33, 56, 0.045);
}
.pipe-item.done { color: var(--success); }
.pipe-item-sub {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  padding: 7px 10px;
  position: relative;
  min-height: 42px;
}

.pipe-item-sub:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 18px;
  top: 25px;
  bottom: -7px;
  width: 1px;
  background: rgba(27, 41, 64, 0.07);
}

.pipe-icon {
  width: 17px; height: 17px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(246,248,252,0.98); border: 1px solid rgba(18,25,42,0.08);
  color: #aab4c6; flex-shrink: 0; transition: all 0.15s;
  position: relative;
  z-index: 1;
}
.pipe-item.active .pipe-icon { background: rgba(19, 51, 121, 0.07); border-color: rgba(19, 51, 121, 0.1); color: var(--accent-text); }
.pipe-item.done .pipe-icon { background: rgba(45, 122, 69, 0.96); border-color: rgba(45,122,69,0.18); color: #fff; }
.icon-active { background: var(--accent-dark) !important; border-color: var(--accent-dark) !important; color: #fff !important; }
.icon-done { background: var(--success) !important; border-color: var(--success) !important; color: #fff !important; }

/* 执行中状态：区别于已完成(绿)和当前选中(蓝)，用琥珀色 + 脉冲 */
.pipe-item.running { color: #b97309; }
.pipe-item.running .pipe-icon,
.icon-running {
  background: rgba(245, 158, 11, 0.12) !important;
  border-color: rgba(245, 158, 11, 0.35) !important;
  color: #d97706 !important;
}
.pipe-item.running .pipe-icon { animation: pipe-running-pulse 1.6s ease-in-out infinite; }
.pipe-sub-running { color: #d97706 !important; font-weight: 700 !important; }
@keyframes pipe-running-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.28); }
  50% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0); }
}

.pipe-label { flex: 1; font-size: 11.5px; }
.pipe-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pipe-sub {
  font-size: 8.5px;
  line-height: 1.35;
  color: var(--text-3);
  font-weight: 500;
}
.pipe-badge {
  font-size: 9px; font-weight: 700; padding: 1px 5px;
  border-radius: 99px; background: var(--bg-3); color: var(--text-3);
  font-family: var(--font-mono);
}
.pipe-badge.badge-done { background: var(--success-bg); color: var(--success); }
.pipe-spinner { width: 10px; height: 10px; border: 1.5px solid var(--accent-bg); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* Sidebar Bottom */
.sidebar-bottom {
  padding: 12px 14px 14px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  display: flex; flex-direction: column; gap: 8px;
  flex-shrink: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.72));
}
.sidebar-jumper {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 3px 0 2px;
}
.sidebar-jump-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: none;
  background: rgba(45, 122, 69, 0.22);
  cursor: pointer;
  transition: transform 0.14s, background 0.14s, box-shadow 0.14s;
}
.sidebar-jump-dot:hover {
  transform: scale(1.08);
}
.sidebar-jump-dot.active {
  background: var(--accent-dark);
  box-shadow: 0 0 0 2px rgba(76, 125, 255, 0.14);
}
.sidebar-jump-dot.done {
  background: var(--success);
}
.sidebar-jump-dot.active.done {
  background: #1e3f8a;
}
.progress-wrap { display: flex; flex-direction: column; gap: 5px; }
.progress-head { display: flex; justify-content: space-between; }
.progress-label { font-size: 10.5px; color: var(--text-3); font-weight: 500; }
.progress-val { font-size: 10.5px; color: var(--text-2); font-family: var(--font-mono); font-weight: 600; }
.progress-track { height: 6px; background: rgba(194, 207, 227, 0.92); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent-gradient); border-radius: 99px; transition: width 0.5s var(--ease-out); }
.refresh-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px; font-size: 11.5px; color: var(--text-2);
  background: rgba(255,255,255,0.86); border: 1px solid rgba(27, 41, 64, 0.08); border-radius: 999px;
  cursor: pointer; transition: all 0.15s;
}
.refresh-btn:hover { background: #fff; color: var(--text-0); }

/* ===== Main Content ===== */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; border-radius: 30px; }
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
.stage-subnav {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.52));
  overflow-x: auto;
  flex-shrink: 0;
}
.stage-subnav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.7);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s ease;
}
.stage-subnav-item:hover {
  background: #fff;
  color: var(--text-0);
}
.stage-subnav-item.active {
  background: rgba(19, 51, 121, 0.08);
  border-color: rgba(19, 51, 121, 0.12);
  color: #1e3f8a;
}
.stage-subnav-item.done {
  color: var(--text-1);
}
.stage-subnav-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--success);
  box-shadow: 0 0 0 4px rgba(45, 122, 69, 0.1);
}

/* Toolbar */
.step-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 14px; border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(255,255,255,0.42)); flex-shrink: 0;
}
.prod-toolbar { background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(255,255,255,0.42)); }
.toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.step-indicator { display: flex; align-items: center; gap: 8px; }
.step-num {
  width: 26px; height: 26px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(19, 51, 121, 0.08);
  font-family: var(--font-mono); font-size: 10px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 13px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Editor Area */
.step-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.fill-textarea {
  flex: 1; border: none; border-radius: 0; padding: 26px 28px;
  font-size: 13.5px; line-height: 1.9; resize: none; outline: none;
  font-family: var(--font-body); background: linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.12)); color: var(--text-0);
}
.fill-textarea:focus { box-shadow: none; }
.sample-hint-bar {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px 14px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.62), rgba(246,250,255,0.82));
}
.sample-hint-title {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  color: var(--accent-text);
  font-size: 10px;
  font-weight: 700;
}
.sample-hint-copy {
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
}

/* Step Empty State */
.step-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; min-height: 300px; gap: 10px; padding: 46px;
  animation: fadeIn 0.3s var(--ease-out);
}
.empty-visual {
  width: 72px; height: 72px; border-radius: 22px;
  background: rgba(255,255,255,0.8); color: var(--accent);
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: var(--shadow-sm);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.empty-title { font-size: 22px; font-weight: 700; font-family: var(--font-display); color: var(--text-0); }
.empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.8; }
.step-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Step Loading */
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }

/* Step Navigator Bubble */
.step-bubble {
  position: static;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px 12px;
  background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.58));
  border-top: 1px solid rgba(27, 41, 64, 0.08);
  margin-top: auto;
}
.bubble-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 999px; font-size: 11.5px; font-weight: 500;
  border: 1px solid rgba(27, 41, 64, 0.08); background: rgba(255,255,255,0.84); color: var(--text-2); cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.bubble-btn:hover:not(:disabled) { background: #fff; color: var(--text-0); }
.bubble-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.bubble-btn.primary { margin-left: auto; background: linear-gradient(135deg, #557ff4, #345fcc); color: #fff; box-shadow: 0 6px 16px rgba(53, 95, 206, 0.2); border-color: transparent; }
.bubble-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.bubble-btn.primary:disabled { filter: none; box-shadow: none; opacity: 0.5; }
.bubble-dots { display: flex; gap: 7px; padding: 0 4px; }
.bubble-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: rgba(143, 160, 184, 0.4); cursor: pointer; transition: all 0.15s;
  border: none;
}
.bubble-dot.done { background: var(--success); }
.bubble-dot.current { background: var(--accent-dark); transform: scale(1.2); box-shadow: 0 0 0 2px rgba(76, 125, 255, 0.14); }

/* Extract grid */
.extract-stage { flex: 1; min-height: 0; overflow: hidden; padding: 12px 16px; display: grid; grid-template-columns: 280px minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
.extract-summary { padding: 16px; display: flex; flex-direction: column; gap: 14px; align-self: stretch; position: sticky; top: 0; max-height: 100%; }
.extract-summary-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3); }
.extract-summary-title { font-size: 20px; line-height: 1.05; font-family: var(--font-display); color: var(--text-0); }
.extract-summary-desc { font-size: 12px; color: var(--text-2); line-height: 1.7; }
.extract-summary-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.extract-summary-stat { padding: 10px 12px; border-radius: 14px; background: rgba(19, 51, 121, 0.05); border: 1px solid rgba(19, 51, 121, 0.08); display: flex; flex-direction: column; gap: 4px; }
.extract-summary-stat span { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
.extract-summary-stat strong { font-size: 18px; color: var(--text-0); font-family: var(--font-display); }
.extract-summary-note { padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,0.56); border: 1px solid rgba(27, 41, 64, 0.08); font-size: 11px; line-height: 1.7; color: var(--text-2); }
.extract-card { overflow: hidden; min-height: 0; display: flex; flex-direction: column; }
.extract-card-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; font-size: 12px; font-weight: 600;
  border-bottom: 1px solid var(--border); background: var(--bg-1);
  color: var(--text-1);
}
.extract-list { padding: 8px 14px; flex: 1; min-height: 0; overflow-y: auto; }
.extract-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.extract-row + .extract-row { border-top: 1px solid var(--border); }
.char-avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--accent-bg); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; flex-shrink: 0;
}
.scene-icon {
  width: 30px; height: 30px; border-radius: 6px;
  background: var(--bg-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3); flex-shrink: 0;
}
.extract-info { min-width: 0; }
.extract-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.extract-name { font-size: 13px; font-weight: 600; }
.extract-meta { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.extract-meta.wrap { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

/* Voice grid */
.voice-stage { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 12px; }
.voice-stage-panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-self: start;
  position: sticky;
  top: 0;
  min-height: 0;
  max-height: calc(100vh - 210px);
  overflow: hidden;
}
.voice-stage-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3); }
.voice-stage-title { font-size: 20px; line-height: 1.05; font-family: var(--font-display); color: var(--text-0); }
.voice-stage-desc { font-size: 12px; color: var(--text-2); line-height: 1.7; }
.voice-stage-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.voice-stage-stat { padding: 10px 12px; border-radius: 14px; background: rgba(19, 51, 121, 0.05); border: 1px solid rgba(19, 51, 121, 0.08); display: flex; flex-direction: column; gap: 3px; }
.voice-stage-stat-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
.voice-stage-stat strong { font-size: 18px; color: var(--text-0); font-family: var(--font-display); }
.voice-library-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
}
.voice-library {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.voice-library-item { padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,0.56); border: 1px solid rgba(27, 41, 64, 0.08); display: flex; flex-direction: column; gap: 4px; }
.voice-library-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-library-name { font-size: 13px; font-weight: 700; color: var(--text-0); }
.voice-library-traits { font-size: 11px; color: var(--text-1); }
.voice-library-fit { font-size: 10px; color: var(--text-3); line-height: 1.5; }

.voice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; align-content: start; }
.voice-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; border-radius: 22px; min-height: 0; }
.voice-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.voice-char { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.voice-name { min-width: 0; flex: 1; }
.voice-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.voice-card-copy { min-height: 58px; }
.voice-card-text { font-size: 12px; line-height: 1.7; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.voice-select-block { display: flex; flex-direction: column; gap: 6px; }
.voice-block-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); }
.voice-profile-card { padding: 12px; border-radius: 16px; background: linear-gradient(135deg, rgba(19, 51, 121, 0.08), rgba(255,255,255,0.78)); border: 1px solid rgba(19, 51, 121, 0.1); display: flex; flex-direction: column; gap: 4px; }
.voice-profile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-profile-name { font-size: 13px; font-weight: 700; color: var(--accent-text); }
.voice-profile-traits { font-size: 11px; color: var(--text-1); }
.voice-profile-fit { font-size: 10px; color: var(--text-2); line-height: 1.5; }
.voice-actions-row { display: flex; align-items: center; gap: 8px; }
.voice-player audio { width: 100%; height: 30px; border-radius: var(--radius); }
.char-avatar.lg { width: 38px; height: 38px; font-size: 16px; }

/* Split layout (storyboard) */
.split-layout { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.shot-list { width: 296px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg-0); }
.shot-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.06);
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(10px);
}
.shot-list-title { font-size: 13px; font-weight: 700; color: var(--text-0); }
.shot-list-sub { margin-top: 3px; font-size: 11px; color: var(--text-3); line-height: 1.45; }
.shot-list-body { padding: 6px; }
.shot-item {
  position: relative; padding: 10px 11px; cursor: pointer;
  border: 1px solid transparent; border-left: 3px solid transparent;
  transition: all 0.15s;
  display: flex; flex-direction: column; gap: 5px;
  border-radius: 14px;
}
.shot-item + .shot-item { margin-top: 6px; }
.shot-item:hover { background: var(--bg-hover); border-color: rgba(27, 41, 64, 0.06); }
.shot-item.active {
  background: var(--bg-0);
  border-left-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-glow);
  z-index: 1;
}
.shot-item-header { display: flex; align-items: center; gap: 8px; }
.shot-num {
  font-size: 11px; font-family: var(--font-mono); font-weight: 700;
  color: var(--accent); background: var(--accent-bg);
  padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
  letter-spacing: 0.03em;
}
.shot-item.active .shot-num { background: var(--accent); color: #fff; }
.shot-status { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
.shot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.shot-dot.has-img { background: var(--success); }
.shot-dot.has-video { background: var(--info); }
.shot-dot.has-dialogue { background: var(--warning); }
.shot-dot.has-bgm { background: #9b59b6; }
.shot-dot.has-sfx { background: #e67e22; }
.shot-dot.has-ambient { background: #3498db; }
.shot-body { }
.shot-desc { font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-1); }
.shot-item.active .shot-desc { color: var(--text-0); }
.shot-meta { display: flex; align-items: center; gap: 6px; }
.audio-check-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.shot-audio-check,
.prod-audio-check,
.export-audio-check {
  margin-top: 8px;
}
.audio-check-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 5px 7px;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 6px;
  background: rgba(255,255,255,0.45);
}
.audio-check-label {
  min-width: 38px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  line-height: 16px;
  font-weight: 700;
  text-align: center;
  color: #fff;
  background: var(--text-3);
}
.audio-check-bgm { background: #7c3fb2; }
.audio-check-sfx { background: #c56a17; }
.audio-check-ambient { background: #2476ad; }
.audio-check-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-2);
}
.audio-check-player {
  grid-column: 1 / -1;
  width: 100%;
  height: 28px;
  min-width: 0;
}
.shot-location {
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-dialogue {
  font-size: 10px; color: var(--text-3); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-left: 2px; border-left: 2px solid var(--border);
  padding-left: 6px;
}

.detail-panel { flex: 1; display: flex; flex-direction: column; overflow-y: auto; min-width: 0; }
.detail-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-head-copy { display: flex; flex-direction: column; gap: 2px; }
.detail-head-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.detail-head-sub { font-size: 11px; color: var(--text-3); }
.detail-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.detail-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.9fr);
  gap: 12px;
  padding: 12px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(20,39,82,0.08), rgba(255,255,255,0.68));
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-hero-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.detail-hero-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--text-3);
}
.detail-hero-text { font-size: 13px; color: var(--text-1); line-height: 1.7; }
.detail-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.detail-preview-card { display: flex; flex-direction: column; gap: 6px; }
.detail-preview-title { font-size: 11px; font-weight: 700; color: var(--text-2); }
.detail-preview-media {
  position: relative; aspect-ratio: 16/9; overflow: hidden;
  border-radius: 14px; background: rgba(18,25,42,0.08);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-preview-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.detail-preview-empty {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: 12px;
}
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.detail-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-section-title { font-size: 12px; font-weight: 700; color: var(--text-0); }
.detail-section-copy { font-size: 11px; color: var(--text-3); }
.story-verify-section {
  background: linear-gradient(135deg, rgba(19, 51, 121, 0.05), rgba(255,255,255,0.82));
}
.story-verify-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 8px;
}
.story-verify-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 11px;
  border-radius: 14px;
  background: rgba(255,255,255,0.86);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.story-verify-stat span {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.story-verify-stat strong {
  font-size: 18px;
  line-height: 1;
  color: var(--text-0);
  font-family: var(--font-display);
}
.story-verify-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.story-signal-tag {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  border: 1px solid rgba(19, 51, 121, 0.12);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.story-signal-tag.muted {
  background: rgba(18, 25, 42, 0.05);
  border-color: rgba(27, 41, 64, 0.08);
  color: var(--text-3);
}
.story-verify-copy {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-1);
}
.story-carrier-list {
  display: grid;
  gap: 8px;
}
.story-carrier-item {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.story-carrier-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
}
.story-carrier-text {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Field */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-row { display: flex; gap: 12px; }
.field-grid { display: grid; gap: 12px; }
.field-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.locked-config {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(19, 51, 121, 0.08);
  border: 1px solid rgba(19, 51, 121, 0.12);
  color: var(--text-1);
  font-size: 11px;
  font-weight: 600;
}
.locked-config-banner {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.role-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.role-pill {
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(27, 41, 64, 0.12);
  background: rgba(255,255,255,0.86);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.role-pill:hover { border-color: var(--accent); color: var(--text-0); }
.role-pill.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: 0 8px 18px rgba(29, 77, 176, 0.18);
}

/* Production tabs */
.prod-tabs { display: flex; gap: 0; background: var(--bg-2); border-radius: var(--radius); padding: 2px; }
.prod-tab {
  display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 12px;
  border: none; background: transparent; color: var(--text-2); cursor: pointer;
  border-radius: calc(var(--radius) - 2px); transition: all 0.15s; font-weight: 500;
}
.prod-tab:hover { color: var(--text-0); }
.prod-tab.active { background: var(--bg-0); color: var(--text-0); font-weight: 600; box-shadow: var(--shadow-xs); }
.prod-tab-badge { font-size: 10px; font-family: var(--font-mono); padding: 0 4px; background: var(--bg-3); border-radius: 99px; }
.prod-tab.active .prod-tab-badge { background: var(--accent-bg); color: var(--accent-text); }

/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.prod-section-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.dub-grid { display: flex; flex-direction: column; gap: 10px; }
.dub-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; border-radius: 20px; background: linear-gradient(180deg, rgba(255,255,255,0.74), rgba(248,251,255,0.58)); }
.dub-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.dub-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.dub-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-desc { font-size: 13px; line-height: 1.6; color: var(--text-1); }
.dub-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; }
.dub-foot { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid rgba(27, 41, 64, 0.08); }
.dub-audio { flex: 1; min-width: 0; height: 30px; }
.narration-audio-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.bgm-library-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.bgm-library-meta { margin-top: 8px; padding: 8px 10px; background: rgba(255,255,255,0.04); border-radius: var(--radius); }
.bgm-meta-line { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.bgm-meta-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.1); color: var(--muted); text-transform: lowercase; }
.bgm-meta-pill.source-minimax { background: rgba(79,195,247,0.15); color: #4fc3f7; }
.bgm-meta-pill.source-freepack { background: rgba(129,199,132,0.15); color: #81c784; }
.bgm-meta-pill.source-local { background: rgba(255,255,255,0.1); }
.bgm-meta-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.bgm-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,0.06); color: var(--muted); }

/* Asset grid */
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.asset-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.asset-card:hover { transform: translateY(-2px); box-shadow: 0 16px 30px rgba(20, 32, 54, 0.08); }
.asset-cover { position: relative; aspect-ratio: 1; background: var(--bg-2); overflow: hidden; }
.asset-cover.wide { aspect-ratio: 16/9; }
.asset-cover img { width: 100%; height: 100%; object-fit: cover; }
.previewable-image { cursor: zoom-in; transition: transform 0.18s var(--ease-out), filter 0.18s var(--ease-out); }
.previewable-image:hover { transform: scale(1.015); filter: saturate(1.04); }
.asset-cover-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(7,11,21,0.58);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
.asset-cover-badge.is-ready {
  background: rgba(36, 125, 72, 0.92);
}
.asset-cover-badge.is-pending {
  background: rgba(19, 51, 121, 0.92);
}
.asset-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.asset-body { padding: 8px 10px; }
.asset-name { font-size: 13px; font-weight: 600; }
.asset-meta { font-size: 11px; }
.asset-foot { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-top: 1px solid var(--border); }

/* Frame grid */
.frame-grid { display: flex; flex-direction: column; gap: 8px; }
.frame-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; cursor: pointer;
  border-radius: var(--radius-lg);
  transition: all 0.15s;
  border: 1.5px solid transparent;
}
.frame-row:hover { background: var(--bg-0); border-color: var(--border); }
.frame-row.active {
  background: var(--bg-0);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.frame-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.frame-top { display: flex; align-items: center; gap: 8px; }
.frame-num {
  font-size: 13px; font-family: var(--font-mono); font-weight: 800;
  color: var(--accent);
}
.frame-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 20px;
  background: var(--accent-bg); color: var(--accent);
  border: 1px solid var(--accent-glow);
  white-space: nowrap;
}
.frame-desc {
  font-size: 12px; line-height: 1.5; color: var(--text-1);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.frame-meta { display: flex; align-items: center; gap: 6px; }
.frame-thumbs { display: flex; gap: 8px; flex-shrink: 0; }
.frame-thumb-wrap { display: flex; flex-direction: column; gap: 3px; align-items: center; }
.frame-thumb-label { font-size: 10px; font-weight: 600; color: var(--text-3); }
.frame-thumb {
  position: relative; width: 130px; aspect-ratio: 16/9;
  border-radius: 6px; overflow: hidden;
  background: var(--bg-2); cursor: pointer;
  transition: all 0.15s; border: 1.5px solid var(--border);
}
.frame-thumb:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.frame-thumb img { width: 100%; height: 100%; object-fit: cover; }
.frame-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.frame-thumb-failed { color: var(--error); background: rgba(220, 53, 69, 0.08); }
.frame-thumb-label.label-failed { color: var(--error); }
.frame-thumb-error { margin-top: 2px; font-size: 10px; line-height: 1.35; color: var(--error); max-width: 130px; }
.frame-re {
  position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff;
  display: none; align-items: center; justify-content: center;
}
.frame-thumb:hover .frame-re { display: flex; }
.frame-scroll { flex: 1; overflow-y: auto; padding: 10px 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(76, 125, 255, 0.14);
}
.dot.fail { background: var(--error); }

/* Prod grid */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.prod-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255,255,255,0.74), rgba(248,251,255,0.58));
}
.prod-card:hover { transform: translateY(-2px); box-shadow: 0 16px 30px rgba(20, 32, 54, 0.08); }
.prod-cover { position: relative; aspect-ratio: 16/9; background: var(--bg-2); overflow: hidden; }
.prod-cover img { width: 100%; height: 100%; object-fit: cover; }
.prod-video { width: 100%; height: 100%; object-fit: cover; background: #000; display: block; }
.prod-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.prod-cover-failed { background: color-mix(in srgb, var(--error) 8%, transparent); color: var(--error); }
.prod-idx {
  position: absolute; top: 5px; left: 5px; font-size: 10px; font-weight: 700;
  font-family: var(--font-mono); background: rgba(0,0,0,0.5); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-overlay-badge {
  position: absolute; bottom: 5px; right: 5px; font-size: 10px; font-weight: 600;
  background: var(--success); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-info { padding: 10px 12px 8px; }
.prod-desc { font-size: 12px; line-height: 1.4; }
.prod-meta-line { margin-top: 5px; font-size: 10px; color: var(--text-3); }
.prod-dots { display: flex; align-items: center; gap: 4px; margin-top: 5px; color: var(--text-3); }
.prod-error {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.prod-actions { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid rgba(27, 41, 64, 0.08); }
.prod-actions .btn { flex: 1; justify-content: center; }

/* Image viewer */
.image-viewer-overlay {
  z-index: 120;
  padding: 28px;
  background: rgba(18, 24, 34, 0.68);
  backdrop-filter: blur(10px);
}
.image-viewer-dialog {
  width: min(1100px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,251,255,0.92));
}
.image-viewer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}
.image-viewer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.image-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.image-viewer-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(8, 14, 24, 0.22);
  background: rgba(255,255,255,0.9);
}

/* Auto split dialog */
.auto-split-overlay {
  z-index: 130;
  padding: 28px;
  background: rgba(18, 24, 34, 0.68);
  backdrop-filter: blur(10px);
}
.auto-split-dialog {
  width: min(720px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,251,255,0.92));
}
.auto-split-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
}
.auto-split-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.auto-split-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  min-height: 0;
}
.auto-split-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 0;
  color: var(--text-2);
}
.auto-split-empty {
  text-align: center;
  padding: 40px 0;
  color: var(--text-3);
}
.auto-split-meta {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 12px;
}
.auto-split-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.auto-split-shot {
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 16px;
  background: rgba(255,255,255,0.66);
  overflow: hidden;
}
.auto-split-shot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: rgba(27, 41, 64, 0.03);
  border-bottom: 1px solid rgba(27, 41, 64, 0.06);
}
.auto-split-shot-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}
.auto-split-shot-count {
  font-size: 11px;
  color: var(--text-3);
}
.auto-split-proposed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}
.auto-split-proposed {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.9);
  border: 1px solid rgba(27, 41, 64, 0.06);
}
.auto-split-proposed-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 6px;
}
.auto-split-proposed-text {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.auto-split-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
}

/* Grid tool dialog */
.grid-tool { width: min(1320px, calc(100vw - 40px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column; overflow: hidden; animation: scaleIn 0.2s var(--ease-out); }
.grid-tool-head { display: flex; align-items: center; gap: 8px; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.grid-tool-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.grid-tool-body-preview { overflow: hidden; min-height: 0; padding-bottom: 10px; }
.grid-tool-foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 4px; }
.grid-preview-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.72fr) minmax(340px, 400px);
  gap: 14px;
  min-height: 0;
  flex: 1;
  align-items: start;
}
.grid-preview-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.grid-assignment-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 18px;
  background: rgba(255,255,255,0.66);
  overflow: hidden;
  max-height: min(70vh, 840px);
}
.grid-assign-head {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(255,255,255,0.72));
}
.grid-assign-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.grid-assign-subtitle {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}
.grid-assign-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.86);
}
.grid-assign-columns {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 96px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(246, 248, 252, 0.92);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Prompt preview */
.grid-prompt-summary { background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.grid-prompt-label { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.grid-prompt-text { font-size: 12px; color: var(--text-1); line-height: 1.7; }

.grid-blank-preview {
  display: grid;
  gap: 4px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 8px;
  min-height: 200px;
}
.grid-blank-cell {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 70px;
}
.grid-blank-cell.empty { opacity: 0.4; }
.grid-blank-cell-index { font-size: 10px; font-weight: 700; color: var(--accent); font-family: var(--font-mono); }
.grid-blank-cell-desc { font-size: 11px; color: var(--text-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.grid-mode-tabs { display: flex; gap: 6px; }
.grid-mode-tab { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1.5px solid var(--border); border-radius: var(--radius); background: var(--bg-0); cursor: pointer; transition: all 0.15s; text-align: left; }
.grid-mode-tab:hover { border-color: var(--border-strong); }
.grid-mode-tab.active { border-color: var(--accent); background: var(--accent-bg); }
.grid-config { display: flex; gap: 12px; align-items: flex-end; }
.grid-pick-list { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px; }
.grid-pick-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; transition: background 0.1s; }
.grid-pick-item:hover { background: var(--bg-hover); }
.grid-pick-item.selected { background: var(--accent-bg); }
.grid-pick-item input { accent-color: var(--accent); }
.grid-preview-wrap {
  border-radius: var(--radius);
  overflow: auto;
  border: 1px solid var(--border);
  background: rgba(14, 19, 28, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  max-height: min(70vh, 860px);
  padding: 10px;
}
.grid-preview-stage {
  position: relative;
  width: fit-content;
  max-width: 100%;
  margin: auto;
  line-height: 0;
}
.grid-preview-img {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: min(66vh, 820px);
  object-fit: contain;
}
.grid-overlay { position: absolute; inset: 0; display: grid; }
.grid-overlay-cell {
  border: 1px dashed rgba(255,255,255,0.42);
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 4px 6px;
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.grid-overlay-cell.active {
  background: rgba(255,255,255,0.08);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.28);
}
.grid-cell-label { font-size: 10px; font-weight: 700; color: #fff; background: rgba(0,0,0,0.5); padding: 1px 5px; border-radius: 3px; }
.grid-adjust-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 2px; }
.grid-assign-info {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 4px 12px 10px;
}
.grid-assign-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 112px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(27, 41, 64, 0.08);
}
.grid-assign-row.active {
  background: rgba(32, 86, 190, 0.05);
  border-radius: 12px;
  padding-left: 6px;
  padding-right: 6px;
}
.grid-assign-row:last-child { border-bottom: 0; }
.grid-assign-index {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.grid-assign-bind {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.45;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-history-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.64));
}
.grid-history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.grid-history-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.grid-history-subtitle {
  font-size: 11px;
  color: var(--text-3);
}
.grid-history-list {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(160px, 182px);
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.grid-history-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 16px;
  background: rgba(255,255,255,0.78);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.grid-history-item:hover {
  border-color: rgba(33, 88, 255, 0.18);
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.grid-history-item.active {
  border-color: rgba(33, 88, 255, 0.26);
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.86));
  box-shadow: 0 14px 28px rgba(33, 88, 255, 0.12);
}
.grid-history-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(14, 19, 28, 0.05);
}
.grid-history-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.grid-history-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grid-history-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grid-history-meta {
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.45;
  word-break: break-word;
}

.latest-grid-strip {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,255,255,0.62));
}
.latest-grid-strip-thumb {
  width: 72px;
  height: 48px;
  padding: 0;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 10px;
  overflow: hidden;
  background: rgba(14, 19, 28, 0.06);
  cursor: zoom-in;
  box-shadow: none;
}
.latest-grid-strip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.latest-grid-strip-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.latest-grid-strip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.latest-grid-strip-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-0);
  font-family: var(--font-display);
}
.latest-grid-strip-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--text-3);
}
.latest-grid-strip-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* Export */
.export-split { flex: 1; display: flex; min-height: 0; overflow: hidden; }
.export-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 24px; min-height: 0; overflow-y: auto; }
.export-video { max-width: min(720px, 100%); max-height: calc(100vh - 280px); width: auto; height: auto; border-radius: var(--radius-lg); background: #000; }
.merge-progress-track { width: 220px; height: 5px; border-radius: 3px; background: var(--bg-3, rgba(0,0,0,0.08)); overflow: hidden; margin-top: 14px; }
.merge-progress-fill { width: 40%; height: 100%; border-radius: 3px; background: var(--primary); animation: merge-indeterminate 1.3s ease-in-out infinite; }
@keyframes merge-indeterminate { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
.merge-error-text { color: var(--error); }
.export-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; width: 100%; max-width: 720px; }
.export-list { width: 240px; flex-shrink: 0; border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
.export-list-head { padding: 11px 14px; font-size: 11px; font-weight: 700; color: var(--text-3); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.06em; }
.export-list-body { flex: 1; overflow-y: auto; padding: 6px; }
.exp-row { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border-radius: var(--radius); }
.exp-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.exp-row:hover { background: var(--bg-hover); }

/* Shared */
.dim { color: var(--text-3); }

@media (max-width: 1240px) {
  .studio-body {
    grid-template-columns: 1fr;
  }

  .studio-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .studio-topbar-side {
    justify-content: flex-end;
  }

  .studio-toolbar {
    gap: 6px;
  }

  .split-layout,
  .export-split {
    flex-direction: column;
  }

  .sidebar {
    max-height: 340px;
  }

  .shot-list,
  .export-list {
    width: 100%;
  }

  .detail-panel {
    min-height: 420px;
  }

  .field-grid-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .image-viewer-overlay {
    padding: 16px;
  }

  .image-viewer-dialog {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
  }

  .grid-tool {
    width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
  }

  .grid-preview-layout {
    grid-template-columns: 1fr;
  }

  .grid-preview-wrap,
  .grid-preview-img {
    max-height: 42vh;
  }

  .grid-assignment-pane {
    max-height: 42vh;
  }

  .grid-assign-columns {
    display: none;
  }

  .grid-assign-row {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}

@media (max-width: 860px) {
  .studio {
    padding: 12px;
    gap: 12px;
  }

  .studio-topbar-main {
    align-items: center;
  }

  .studio-topbar {
    flex-wrap: nowrap;
  }

  .studio-actions {
    flex-wrap: nowrap;
  }

  .studio-topbar .btn {
    padding: 0 8px;
  }

  .studio-episode-title,
  .studio-meta-inline {
    display: none;
  }

  .toolbar-right,
  .step-bubble,
  .export-bar,
  .sample-hint-bar {
    flex-wrap: wrap;
  }

  .extract-grid,
  .voice-grid,
  .asset-grid,
  .prod-grid {
    grid-template-columns: 1fr;
  }

  .voice-stage {
    grid-template-columns: 1fr;
  }

  .extract-stage {
    grid-template-columns: 1fr;
  }

  .extract-summary {
    position: static;
  }

  .voice-stage-panel {
    position: static;
    max-height: none;
    overflow: visible;
  }

  .frame-row {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-hero {
    grid-template-columns: 1fr;
  }

  .field-grid-2,
  .field-grid-4 {
    grid-template-columns: 1fr;
  }

  .story-carrier-item {
    grid-template-columns: 1fr;
  }

  .frame-thumbs {
    width: 100%;
  }

  .frame-thumb {
    width: 100%;
  }

  .latest-grid-strip {
    grid-template-columns: 1fr;
  }

  .grid-history-list {
    grid-auto-columns: minmax(148px, 168px);
  }

  .latest-grid-strip-thumb {
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
  }

  .latest-grid-strip-actions {
    justify-content: flex-start;
  }

  .render-mode-section,
  .narration-provider-section,
  .narration-voice-section {
    flex: 1 1 auto;
    justify-content: space-between;
    max-width: 100%;
  }

  .narration-voice-section :deep(.base-select-trigger) {
    flex: 1 1 auto;
    width: auto !important;
  }

  .render-mode-switch,
  .narration-provider-switch {
    flex-shrink: 0;
  }
}

@media (max-width: 620px) {
  .settings-drawer-overlay {
    padding: 0;
  }

  .settings-drawer {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }

  .settings-control-row {
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 6px;
  }

  .settings-control-row .render-mode-switch,
  .settings-control-row .narration-provider-switch,
  .drawer-inline-controls,
  .drawer-speed-control,
  .drawer-select {
    justify-self: stretch;
    justify-content: flex-start;
  }

  .drawer-select,
  .drawer-select.wide,
  .drawer-select.compact,
  .drawer-select.mini {
    width: 100%;
  }

  .drawer-speed-control .speed-slider {
    flex: 1;
    width: auto;
  }
}

.retention-strip {
  display: flex;
  gap: 12px;
  padding: 10px 16px 0;
}
.retention-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.25);
  border-radius: 8px;
}
.retention-label {
  font-size: 11px;
  font-weight: 600;
  color: #f59e0b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.retention-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}

.auto-start-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.auto-start-dialog {
  width: 420px;
  max-width: 92vw;
  padding: 20px;
}
.auto-start-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.auto-start-title {
  font-size: 16px;
  font-weight: 700;
}
.auto-start-desc {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 10px;
}
.auto-start-steps {
  margin: 0 0 16px 18px;
  padding: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text);
}
.auto-start-steps li.muted {
  color: var(--text-3);
  text-decoration: line-through;
}
.skip-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  font-size: 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.06);
  color: var(--text-3);
}
.auto-start-checkbox {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.auto-start-checkbox input {
  margin-top: 2px;
}
.auto-start-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
