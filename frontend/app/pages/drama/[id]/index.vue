<template>
  <div class="page" v-if="drama">
    <!-- Header -->
    <div class="page-head">
      <div class="head-left">
        <button class="back-btn" @click="navigateTo('/')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回
        </button>
        <div class="head-info">
          <h1 class="page-title">{{ drama.title }}</h1>
          <div v-if="drama.video_title" class="drama-video-title">{{ drama.video_title }}</div>
          <div v-else-if="drama.hook" class="drama-hook">{{ drama.hook }}</div>
          <div class="page-meta">
            <span v-if="drama.genre" class="style-chip genre-chip">{{ genreLabel(drama.genre) }}</span>
            <span v-if="drama.style" class="style-chip">{{ styleLabel(drama.style) }}</span>
            <span v-if="drama.pacing_mode" class="style-chip">{{ pacingModeLabel(drama.pacing_mode) }}</span>
            <span v-if="drama.style || drama.pacing_mode || drama.genre" class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {{ drama.characters?.length || 0 }} 角色
            </span>
            <span class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
              {{ drama.scenes?.length || 0 }} 场景
            </span>
          </div>
        </div>
      </div>
      <div class="head-actions">
        <button class="btn" :disabled="preProducing" @click="runPreProduction">
          <svg :class="{ 'animate-spin': preProducing }" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          {{ preProducing ? '预生产中...' : 'Drama 预生产' }}
        </button>
        <button class="btn" @click="openSmartSplit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.7-4.9-3.6-4.9 3.6 1.9-5.7L4 8.8h6.1z"/>
          </svg>
          从故事生成
        </button>
        <button class="btn" @click="openImportScript">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>
          导入精稿直出
        </button>
        <button class="btn btn-primary" @click="openAddEpisode">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          添加集
        </button>
      </div>
    </div>

    <div v-if="lastSmartSplitResult" class="smart-result">
      <div class="smart-result-head">
        <div>
          <div class="section-label smart-result-kicker">最新故事改编结果</div>
          <h2 class="smart-result-title">已按剧情推进链创建 {{ lastSmartSplitResult.created_episodes?.length || 0 }} 集</h2>
          <p class="smart-result-copy">这次拆分先抽了剧情推进链，再按时长和悬念落点切集。原文已经直接写进对应 episode 的 content。</p>
        </div>
        <div class="smart-result-meta">
          <span class="summary-chip">时长 · {{ durationPresetLabel(lastSmartSplitResult.duration_preset?.id) }}</span>
          <span class="summary-chip">剧情 beat · {{ lastSmartSplitResult.plot_progression_chain?.length || 0 }}</span>
          <span class="summary-chip">剧集 · {{ lastSmartSplitResult.created_episodes?.length || 0 }}</span>
        </div>
      </div>
      <div class="smart-result-grid">
        <div class="smart-panel">
          <div class="smart-panel-title">剧情推进链</div>
          <div class="chain-list">
            <div v-for="beat in lastSmartSplitResult.plot_progression_chain" :key="beat.beat_id" class="chain-item">
              <div class="chain-phase">{{ beat.phase }}</div>
              <div class="chain-summary">{{ beat.summary }}</div>
              <div class="chain-context">{{ beat.suspense_value }}</div>
            </div>
          </div>
        </div>
        <div class="smart-panel">
          <div class="smart-panel-title">已创建剧集</div>
          <div class="plan-list">
            <div v-for="episode in lastSmartSplitResult.created_episodes" :key="episode.id" class="plan-item">
              <div class="plan-head">
                <div class="plan-title-row">
                  <span class="plan-episode">E{{ String(episode.episode_number).padStart(2, '0') }}</span>
                  <span class="plan-title">{{ episode.title }}</span>
                </div>
                <span class="plan-duration">{{ episode.duration }}s</span>
              </div>
              <p class="plan-summary">{{ episode.summary }}</p>
              <p class="plan-hook">开场钩子：{{ episode.opening_hook }}</p>
              <p class="plan-hook">集尾悬念：{{ episode.cliffhanger_hook }}</p>
              <p class="plan-preview">{{ episode.content_preview }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Episode List -->
    <div class="section-label section-label-with-actions">
      <div class="section-label-left">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="2" y="2" width="20" height="20" rx="2.5"/>
          <line x1="7" y1="8" x2="7" y2="16"/>
          <line x1="10" y1="8" x2="10" y2="16"/>
          <line x1="13" y1="8" x2="13" y2="16"/>
          <line x1="16" y1="8" x2="16" y2="16"/>
        </svg>
        剧集列表
      </div>
      <div class="section-label-actions">
        <label class="bulk-select-all">
          <input type="checkbox" :checked="allEpisodesSelected" @change="toggleSelectAllEpisodes" />
          全选
        </label>
        <button
          class="btn btn-sm btn-danger"
          :disabled="!selectedEpisodeIds.length || deletingBulk"
          @click="deleteSelectedEpisodes"
        >
          {{ deletingBulk ? '删除中...' : `删除${selectedEpisodeIds.length ? ` ${selectedEpisodeIds.length} 集` : ''}` }}
        </button>
      </div>
    </div>

    <div class="ep-grid">
      <div
        v-for="(ep, i) in drama.episodes"
        :key="ep.id"
        class="card ep-card"
        :class="{ 'ep-card-selected': selectedEpisodeIds.includes(ep.id) }"
        :style="{ animationDelay: `${i * 0.05}s` }"
        @click="navigateTo(`/drama/${drama.id}/episode/${ep.episode_number || ep.episodeNumber}`)"
      >
        <input
          type="checkbox"
          :value="ep.id"
          v-model="selectedEpisodeIds"
          class="ep-checkbox"
          @click.stop
        />
        <div class="ep-number">E{{ String(ep.episode_number || ep.episodeNumber).padStart(2, '0') }}</div>
        <div class="ep-body">
          <span class="ep-title">{{ ep.title }}</span>
          <div class="ep-status">
            <span :class="['status-dot', episodeStatus(ep).dot]"></span>
            <span class="status-text">{{ episodeStatus(ep).label }}</span>
            <span v-if="ep.duration" class="ep-duration">{{ ep.duration }}s</span>
            <span v-if="ep.workflow_type || ep.workflowType" class="workflow-chip">{{ workflowLabel(ep.workflow_type || ep.workflowType) }}</span>
          </div>
        </div>
        <button
          class="btn btn-icon ep-delete"
          :disabled="deletingEpisodeIds.includes(ep.id)"
          title="删除本集"
          @click.stop="deleteEpisode(ep)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <line x1="10" y1="11" x2="10" y2="17"/>
            <line x1="14" y1="11" x2="14" y2="17"/>
          </svg>
        </button>
        <div class="ep-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      <!-- Empty episode state -->
      <div v-if="!drama.episodes?.length" class="card ep-empty">
        <div class="ep-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p>点击上方「添加集」创建第一集</p>
      </div>
    </div>

    <div v-if="addDialog" class="dialog-mask" @click.self="addDialog = false">
      <div class="card dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Episode Setup</div>
            <div class="dialog-title-row">
              <div class="dialog-title">创建新集</div>
              <span class="dialog-badge">配置将锁定</span>
            </div>
            <div class="dialog-sub">为这一集预先锁定图片、视频和音频生成服务。创建后，这些生成链路将始终跟随当前集配置。</div>
          </div>
          <button class="back-btn" @click="addDialog = false">取消</button>
        </div>
        <div class="dialog-summary">
          <div class="summary-chip">图片 · {{ imageConfigs.length }} 可选</div>
          <div class="summary-chip">视频 · {{ videoConfigs.length }} 可选</div>
          <div class="summary-chip">音频 · {{ audioConfigs.length }} 可选</div>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">基础信息</span>
              <span class="dialog-section-copy">这一项只影响显示名称，不影响生成配置</span>
            </div>
            <label class="field">
              <span class="field-label">标题</span>
              <input v-model="newEpisodeTitle" class="input" placeholder="默认按集数自动命名" />
              <span class="field-hint">留空时会自动按集数命名，例如“第 3 集”。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">生成配置</span>
              <span class="dialog-section-copy">创建后不可更改，建议在这里一次性选对</span>
            </div>
            <div class="config-grid">
              <label class="config-card">
                <span class="config-card-kicker">IMAGE</span>
                <span class="field-label">图片配置</span>
                <BaseSelect v-model="newEpisodeImageConfigId" :options="imageConfigOptions" placeholder="选择图片服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">VIDEO</span>
                <span class="field-label">视频配置</span>
                <BaseSelect v-model="newEpisodeVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">AUDIO</span>
                <span class="field-label">音频配置</span>
                <BaseSelect v-model="newEpisodeAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
              </label>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">画面方向</span>
              <span class="dialog-section-copy">决定视频输出的宽高比</span>
            </div>
            <div class="radio-group">
              <label class="radio">
                <input type="radio" v-model="newEpisodeAspect" value="16:9" />
                <span>横屏 16:9</span>
              </label>
              <label class="radio">
                <input type="radio" v-model="newEpisodeAspect" value="9:16" />
                <span>竖屏 9:16</span>
              </label>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">创建后，工作台中的图片、视频、音频生成入口都会锁定到当前集。</div>
          <button class="btn btn-primary" :disabled="creatingEpisode || !canCreateEpisode" @click="addEpisode">
            {{ creatingEpisode ? '创建中...' : '创建并锁定配置' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="smartSplitDialog" class="dialog-mask" @click.self="smartSplitDialog = false">
      <div class="card dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Story Rewrite Mode</div>
            <div class="dialog-title-row">
              <div class="dialog-title">从故事生成（故事改编模式）</div>
              <span class="dialog-badge">DeepSeek V4 Flash</span>
            </div>
            <div class="dialog-sub">先抽剧情推进链，再按目标时长和悬念落点切集。创建后，每一集的原文片段会直接写入 episode content，后续单集流程无需改动。</div>
          </div>
          <button class="back-btn" @click="smartSplitDialog = false">取消</button>
        </div>
        <div class="dialog-summary">
          <div class="summary-chip">时长档位 · {{ durationPresets.length }}</div>
          <div class="summary-chip">图片 · {{ imageConfigs.length }} 可选</div>
          <div class="summary-chip">视频 · {{ videoConfigs.length }} 可选</div>
          <div class="summary-chip">音频 · {{ audioConfigs.length }} 可选</div>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">原文</span>
              <span class="dialog-section-copy">粘贴完整原文，模型会先抽剧情推进链，再决定集尾悬念</span>
            </div>
            <label class="field">
              <span class="field-label">故事原文</span>
              <textarea v-model="smartSplitSourceText" class="input textarea" placeholder="粘贴需要拆分成多集的原文"></textarea>
              <span class="field-hint">不会按段落或字数兜底切分，只按模型返回的剧情边界和原文锚点创建剧集。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">单集时长</span>
              <span class="dialog-section-copy">参考 YouTube Shorts 与长视频时长区间</span>
            </div>
            <div class="duration-grid">
              <label v-for="preset in durationPresets" :key="preset.id" class="duration-card">
                <input type="radio" v-model="smartSplitDurationPreset" :value="preset.id" />
                <div class="duration-copy">
                  <span class="duration-title">{{ preset.label }}</span>
                  <span class="duration-hint">{{ preset.hint }}</span>
                </div>
              </label>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">叙事节奏</span>
              <span class="dialog-section-copy">紧凑/极速会合并低密度 beat、减少集数，并影响后续分镜密度</span>
            </div>
            <div class="radio-group">
              <label v-for="opt in pacingModeOptions" :key="opt.value" class="radio">
                <input type="radio" v-model="smartSplitPacingMode" :value="opt.value" />
                <span>{{ opt.label }}</span>
              </label>
            </div>
            <label class="field checkbox-field" style="margin-top:10px">
              <input type="checkbox" v-model="smartSplitReplace" />
              <span class="field-label" style="font-weight:500">替换现有剧集</span>
              <span class="field-hint">勾选后会先删除当前所有集、分镜和素材，再按新节奏重新分集。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">生成配置</span>
              <span class="dialog-section-copy">新建出的每一集都会锁定这里的图片、视频和音频配置</span>
            </div>
            <div class="config-grid">
              <label class="config-card">
                <span class="config-card-kicker">IMAGE</span>
                <span class="field-label">图片配置</span>
                <BaseSelect v-model="smartSplitImageConfigId" :options="imageConfigOptions" placeholder="选择图片服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">VIDEO</span>
                <span class="field-label">视频配置</span>
                <BaseSelect v-model="smartSplitVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">AUDIO</span>
                <span class="field-label">音频配置</span>
                <BaseSelect v-model="smartSplitAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
              </label>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">画面方向</span>
              <span class="dialog-section-copy">创建出的所有集默认使用这个宽高比</span>
            </div>
            <div class="radio-group">
              <label class="radio">
                <input type="radio" v-model="smartSplitAspect" value="16:9" />
                <span>横屏 16:9</span>
              </label>
              <label class="radio">
                <input type="radio" v-model="smartSplitAspect" value="9:16" />
                <span>竖屏 9:16</span>
              </label>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">输出会包含剧情推进链、每集摘要、集尾钩子和原文片段预览，方便你直接判断切得对不对。</div>
          <button class="btn btn-primary" :disabled="smartSplitting || !canSmartSplit" @click="runSmartSplit">
            {{ smartSplitting ? '拆分中...' : '智能拆分并创建剧集' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="importScriptDialog" class="dialog-mask" @click.self="importScriptDialog = false">
      <div class="card dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Direct Script Mode</div>
            <div class="dialog-title-row">
              <div class="dialog-title">导入精稿直出</div>
              <span class="dialog-badge">不改写 / 不注入短剧节奏</span>
            </div>
            <div class="dialog-sub">直接导入已经写好的稿子。系统会按原稿结构逐镜头拆解、生成旁白，不会进行 AI 改写，也不会强制钩子/悬念/短剧节奏。</div>
          </div>
          <button class="back-btn" @click="importScriptDialog = false">取消</button>
        </div>
        <div class="dialog-summary">
          <div class="summary-chip">工作流 · 精稿直出</div>
          <div class="summary-chip">图片 · {{ imageConfigs.length }} 可选</div>
          <div class="summary-chip">视频 · {{ videoConfigs.length }} 可选</div>
          <div class="summary-chip">音频 · {{ audioConfigs.length }} 可选</div>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">精稿内容</span>
              <span class="dialog-section-copy">粘贴完整稿子，可直接导入为一集，也可用分隔标记拆成多集</span>
            </div>
            <label class="field">
              <span class="field-label">标题（可选）</span>
              <input v-model="importScriptTitle" class="input" placeholder="留空时自动按集数命名" />
            </label>
            <label class="field">
              <span class="field-label">稿子正文</span>
              <textarea v-model="importScriptContent" class="input textarea" placeholder="粘贴已经写好的精稿" @input="resetImportScriptPreview"></textarea>
              <span class="field-hint">支持解说词、对白、动作描述、背景交代等多种格式。导入前可在此二次编辑。</span>
            </label>

            <div class="clean-preview" style="margin-top: 12px">
              <button
                v-if="!importScriptCleanPreviewVisible"
                class="btn btn-sm"
                type="button"
                :disabled="!importScriptContent.trim()"
                @click="previewImportScript"
              >
                预览导入内容
              </button>

              <template v-else>
                <label class="field" style="margin-bottom: 8px">
                  <span class="field-label">导入内容（可直接修改）</span>
                  <textarea v-model="importScriptCleanedContent" class="input textarea" rows="8" placeholder="预览内容会显示在这里，你可以直接编辑"></textarea>
                  <span class="field-hint">
                    共 {{ importScriptCleanedContent.length }} 字。确认无误后再点击“导入精稿直出”。
                  </span>
                </label>
                <div class="clean-preview-actions">
                  <button class="btn btn-sm" type="button" @click="previewImportScript">
                    重新预览
                  </button>
                  <button class="btn btn-sm btn-ghost" type="button" @click="importScriptCleanPreviewVisible = false">
                    收起
                  </button>
                </div>
              </template>
            </div>

            <label class="field" style="margin-top: 14px">
              <span class="field-label">智能分集（可选）</span>
              <BaseSelect v-model="importScriptDurationPreset" :options="durationPresetOptions" placeholder="不分集，整篇导入为 1 集" searchable />
              <span class="field-hint">选择目标时长后，系统会按剧情链自动拆成多集；留空则整篇导入为单集。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">生成配置</span>
              <span class="dialog-section-copy">新建出的每一集都会锁定这里的图片、视频和音频配置</span>
            </div>
            <div class="config-grid">
              <label class="config-card">
                <span class="config-card-kicker">IMAGE</span>
                <span class="field-label">图片配置</span>
                <BaseSelect v-model="importScriptImageConfigId" :options="imageConfigOptions" placeholder="选择图片服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">VIDEO</span>
                <span class="field-label">视频配置</span>
                <BaseSelect v-model="importScriptVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">AUDIO</span>
                <span class="field-label">音频配置</span>
                <BaseSelect v-model="importScriptAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
              </label>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">画面方向</span>
              <span class="dialog-section-copy">决定视频输出的宽高比</span>
            </div>
            <div class="radio-group">
              <label class="radio">
                <input type="radio" v-model="importScriptAspect" value="16:9" />
                <span>横屏 16:9</span>
              </label>
              <label class="radio">
                <input type="radio" v-model="importScriptAspect" value="9:16" />
                <span>竖屏 9:16</span>
              </label>
            </div>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">渲染模式</span>
              <span class="dialog-section-copy">精稿直出通常先出图再合成视频</span>
            </div>
            <div class="radio-group">
              <label class="radio">
                <input type="radio" v-model="importScriptRenderMode" value="image_story" />
                <span>图文叙事（先生成图片，再合成视频）</span>
              </label>
              <label class="radio">
                <input type="radio" v-model="importScriptRenderMode" value="ai_video" />
                <span>AI 视频（直接生成视频）</span>
              </label>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">
            {{ importScriptCleanPreviewVisible ? '确认后会写入 episode，并自动进入精稿直出分镜拆解 → 旁白生成流程。' : '先预览导入内容，确认后再写入 episode。' }}
          </div>
          <button class="btn btn-primary" :disabled="importScriptPrimaryDisabled" @click="handleImportScriptPrimary">
            {{ importScriptPrimaryLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { aiConfigAPI, dramaAPI, episodeAPI } from '~/composables/useApi'

const route = useRoute()
const drama = ref(null)
const dramaId = Number(route.params.id)
const addDialog = ref(false)
const creatingEpisode = ref(false)
const smartSplitDialog = ref(false)
const smartSplitting = ref(false)
const preProducing = ref(false)
const newEpisodeTitle = ref('')
const imageConfigs = ref([])
const videoConfigs = ref([])
const audioConfigs = ref([])
const newEpisodeImageConfigId = ref(null)
const newEpisodeVideoConfigId = ref(null)
const newEpisodeAudioConfigId = ref(null)
const newEpisodeAspect = ref('16:9')
const smartSplitSourceText = ref('')
const smartSplitDurationPreset = ref('shorts_1_3')
const smartSplitPacingMode = ref('tight')
const smartSplitReplace = ref(false)
const smartSplitImageConfigId = ref(null)
const smartSplitVideoConfigId = ref(null)
const smartSplitAudioConfigId = ref(null)
const smartSplitAspect = ref('9:16')
const lastSmartSplitResult = ref(null)
const importScriptDialog = ref(false)
const importingScript = ref(false)
const importScriptTitle = ref('')
const importScriptContent = ref('')
const importScriptCleanedContent = ref('')
const importScriptCleanPreviewVisible = ref(false)
const importScriptDurationPreset = ref('')
const importScriptImageConfigId = ref(null)
const importScriptVideoConfigId = ref(null)
const importScriptAudioConfigId = ref(null)
const importScriptAspect = ref('16:9')
const importScriptRenderMode = ref('image_story')

const selectedEpisodeIds = ref([])
const deletingEpisodeIds = ref([])
const deletingBulk = ref(false)

const allEpisodesSelected = computed(() =>
  drama.value?.episodes?.length > 0 &&
  selectedEpisodeIds.value.length === drama.value.episodes.length
)

function toggleSelectAllEpisodes() {
  if (allEpisodesSelected.value) {
    selectedEpisodeIds.value = []
  } else {
    selectedEpisodeIds.value = drama.value.episodes.map(e => e.id)
  }
}

async function deleteEpisode(ep) {
  const name = ep.title || `第 ${ep.episode_number || ep.episodeNumber} 集`
  if (!confirm(`确定删除「${name}」？\n本集关联的分镜、角色、场景会被一并清理，且不可恢复。`)) return
  try {
    deletingEpisodeIds.value.push(ep.id)
    await episodeAPI.del(ep.id)
    toast.success('已删除')
    selectedEpisodeIds.value = selectedEpisodeIds.value.filter(id => id !== ep.id)
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    deletingEpisodeIds.value = deletingEpisodeIds.value.filter(id => id !== ep.id)
  }
}

async function deleteSelectedEpisodes() {
  const ids = selectedEpisodeIds.value
  if (!ids.length) return
  if (!confirm(`确定删除选中的 ${ids.length} 集？\n这些集关联的分镜、角色、场景会被一并清理，且不可恢复。`)) return
  try {
    deletingBulk.value = true
    await episodeAPI.bulkDelete(ids)
    toast.success(`已删除 ${ids.length} 集`)
    selectedEpisodeIds.value = []
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    deletingBulk.value = false
  }
}

const pacingModeOptions = [
  { label: '标准', value: 'standard' },
  { label: '紧凑', value: 'tight' },
  { label: '极速', value: 'extreme' },
]

const durationPresets = [
  { id: 'micro_30_60', label: '30-60 秒', hint: '极短切片，适合强冲突开场' },
  { id: 'ai_manga_60_90', label: '60-90 秒（AI 漫剧）', hint: '竖屏高密度短剧，情节+情绪推进' },
  { id: 'shorts_1_3', label: '1-3 分钟', hint: 'YouTube Shorts 区间，快节奏悬念推进' },
  { id: 'mid_3_8', label: '3-8 分钟', hint: '轻长视频，更适合完整小段落' },
  { id: 'mid_8_15', label: '8-15 分钟', hint: '常规长视频，单集可容纳完整转折' },
  { id: 'long_15_30', label: '15-30 分钟', hint: '较长正片，适合更完整的章节推进' },
]

function episodeStatus(ep) {
  if (ep.video_url || ep.videoUrl) return { key: 'merged', label: '已生成成片', dot: 'dot-success' }
  if (ep.composed_count) return { key: 'composed', label: `已合成 ${ep.composed_count} 个镜头`, dot: 'dot-ready' }
  if (ep.storyboard_count) return { key: 'storyboards', label: `已拆 ${ep.storyboard_count} 个镜头`, dot: 'dot-ready' }
  if (ep.script_content || ep.scriptContent) return { key: 'script', label: '已完成剧本', dot: 'dot-ready' }
  return { key: 'draft', label: '待编写', dot: 'dot-pending' }
}

function configLabel(config) {
  if (!config) return ''
  let modelName = ''
  try { const m = JSON.parse(config.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = config.model || '' }
  return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
}

const imageConfigOptions = computed(() => imageConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const videoConfigOptions = computed(() => videoConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const audioConfigOptions = computed(() => audioConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const durationPresetOptions = computed(() => durationPresets.map(p => ({ label: `${p.label} · ${p.hint}`, value: p.id })))
const canCreateEpisode = computed(() => !!(newEpisodeImageConfigId.value && newEpisodeVideoConfigId.value && newEpisodeAudioConfigId.value))
const canSmartSplit = computed(() => !!(
  smartSplitSourceText.value.trim()
  && smartSplitImageConfigId.value
  && smartSplitVideoConfigId.value
  && smartSplitAudioConfigId.value
))
const canImportScript = computed(() => !!(
  importScriptContent.value.trim()
  && importScriptImageConfigId.value
  && importScriptVideoConfigId.value
  && importScriptAudioConfigId.value
))
const canConfirmImportScript = computed(() => !!(
  canImportScript.value
  && importScriptCleanPreviewVisible.value
  && importScriptCleanedContent.value.trim()
))
const importScriptPrimaryDisabled = computed(() => {
  if (importingScript.value || !canImportScript.value) return true
  if (importScriptCleanPreviewVisible.value) return !canConfirmImportScript.value
  return false
})
const importScriptPrimaryLabel = computed(() => {
  if (importingScript.value) return '导入中...'
  return importScriptCleanPreviewVisible.value ? '确认导入精稿直出' : '先预览导入内容'
})

function durationPresetLabel(id) {
  return durationPresets.find(item => item.id === id)?.label || id || '未选择'
}
function pacingModeLabel(mode) {
  return pacingModeOptions.find(item => item.value === mode)?.label || mode || '未选择'
}
const styleLabels = {
  generic: '通用（电影感）',
  realistic: '写实',
  anime: '二次元',
  ghibli: '吉卜力',
  cinematic: '电影',
  comic: '漫画',
  watercolor: '水彩',
}
const genreLabels = {
  generic: '通用',
  history: '历史 / 历史人物',
  scifi: '科幻',
  mythology: '神话 / 奇幻',
  space: '天文 / 太空',
  deepsea: '深海',
  ancient: '古文明',
  wasteland: '末日废土',
}
function styleLabel(value) {
  return styleLabels[value] || value || ''
}
function genreLabel(value) {
  return genreLabels[value] || value || ''
}
const workflowLabels = {
  story_rewrite: '故事改编',
  direct_script: '精稿直出',
}
function workflowLabel(value) {
  return workflowLabels[value] || value || ''
}

function applyConfigDefaults() {
  if (!newEpisodeImageConfigId.value && imageConfigs.value.length) newEpisodeImageConfigId.value = imageConfigs.value[0].id
  if (!newEpisodeVideoConfigId.value && videoConfigs.value.length) newEpisodeVideoConfigId.value = videoConfigs.value[0].id
  if (!newEpisodeAudioConfigId.value && audioConfigs.value.length) newEpisodeAudioConfigId.value = audioConfigs.value[0].id
  if (!smartSplitImageConfigId.value && imageConfigs.value.length) smartSplitImageConfigId.value = imageConfigs.value[0].id
  if (!smartSplitVideoConfigId.value && videoConfigs.value.length) smartSplitVideoConfigId.value = videoConfigs.value[0].id
  if (!smartSplitAudioConfigId.value && audioConfigs.value.length) smartSplitAudioConfigId.value = audioConfigs.value[0].id
  if (!importScriptImageConfigId.value && imageConfigs.value.length) importScriptImageConfigId.value = imageConfigs.value[0].id
  if (!importScriptVideoConfigId.value && videoConfigs.value.length) importScriptVideoConfigId.value = videoConfigs.value[0].id
  if (!importScriptAudioConfigId.value && audioConfigs.value.length) importScriptAudioConfigId.value = audioConfigs.value[0].id
}

async function load() {
  try {
    drama.value = await dramaAPI.get(dramaId)
  } catch (e) {
    toast.error(e.message)
  }
}

async function loadConfigs() {
  try {
    const [imgs, vids, auds] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('audio'),
    ])
    imageConfigs.value = imgs || []
    videoConfigs.value = vids || []
    audioConfigs.value = auds || []
    applyConfigDefaults()
  } catch (e) {
    toast.error(e.message)
  }
}

function openAddEpisode() {
  newEpisodeTitle.value = ''
  applyConfigDefaults()
  addDialog.value = true
}

function openSmartSplit() {
  smartSplitDurationPreset.value = 'shorts_1_3'
  smartSplitPacingMode.value = drama.value?.pacing_mode || 'tight'
  smartSplitReplace.value = false
  smartSplitAspect.value = '9:16'
  if (!smartSplitSourceText.value.trim() && drama.value?.episodes?.length) {
    smartSplitSourceText.value = drama.value.episodes
      .map(e => e.content || '').filter(Boolean).join('\n\n')
  }
  applyConfigDefaults()
  smartSplitDialog.value = true
}

function openImportScript() {
  importScriptTitle.value = ''
  importScriptContent.value = ''
  importScriptCleanedContent.value = ''
  importScriptCleanPreviewVisible.value = false
  importScriptDurationPreset.value = ''
  importScriptAspect.value = '16:9'
  importScriptRenderMode.value = 'image_story'
  applyConfigDefaults()
  importScriptDialog.value = true
}

function resetImportScriptPreview() {
  importScriptCleanedContent.value = ''
  importScriptCleanPreviewVisible.value = false
}

async function previewImportScript() {
  if (!importScriptContent.value.trim()) return
  importScriptCleanedContent.value = importScriptContent.value.trim()
  importScriptCleanPreviewVisible.value = true
}

async function handleImportScriptPrimary() {
  if (!importScriptCleanPreviewVisible.value) {
    await previewImportScript()
    return
  }
  await runImportScript()
}

async function runImportScript() {
  if (!importScriptCleanPreviewVisible.value) {
    await previewImportScript()
    return
  }
  try {
    importingScript.value = true
    const payload = {
      title: importScriptTitle.value.trim() || undefined,
      script_content: importScriptCleanedContent.value.trim(),
      clean: false,
      clean_already_applied: true,
      duration_preset: importScriptDurationPreset.value || undefined,
      image_config_id: importScriptImageConfigId.value,
      video_config_id: importScriptVideoConfigId.value,
      audio_config_id: importScriptAudioConfigId.value,
      aspect_ratio: importScriptAspect.value,
      render_mode: importScriptRenderMode.value,
    }
    const result = await dramaAPI.importScript(dramaId, payload)
    importScriptDialog.value = false
    toast.success(`已导入 ${result.segment_count || result.episodes?.length || 0} 集精稿直出`)
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    importingScript.value = false
  }
}

async function addEpisode() {
  try {
    creatingEpisode.value = true
    await episodeAPI.create({
      drama_id: dramaId,
      title: newEpisodeTitle.value || undefined,
      image_config_id: newEpisodeImageConfigId.value,
      video_config_id: newEpisodeVideoConfigId.value,
      audio_config_id: newEpisodeAudioConfigId.value,
      aspect_ratio: newEpisodeAspect.value,
    })
    toast.success('已添加新集')
    addDialog.value = false
    load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    creatingEpisode.value = false
  }
}

async function runSmartSplit() {
  try {
    smartSplitting.value = true
    const result = await dramaAPI.smartSplit(dramaId, {
      source_text: smartSplitSourceText.value.trim(),
      duration_preset: smartSplitDurationPreset.value,
      pacing_mode: smartSplitPacingMode.value,
      replace: smartSplitReplace.value,
      image_config_id: smartSplitImageConfigId.value,
      video_config_id: smartSplitVideoConfigId.value,
      audio_config_id: smartSplitAudioConfigId.value,
      aspect_ratio: smartSplitAspect.value,
      render_mode: 'image_story',
    })
    lastSmartSplitResult.value = result
    smartSplitDialog.value = false
    toast.success(`已创建 ${result.created_episodes?.length || 0} 集`)
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    smartSplitting.value = false
  }
}

async function runPreProduction() {
  try {
    preProducing.value = true
    const result = await dramaAPI.preProduction(dramaId)
    toast.success(`预生产任务已创建（task_id=${result.task_id}），将统一提取角色/场景、分配音色并生成形象/样本`)
  } catch (e) {
    toast.error(e.message)
  } finally {
    preProducing.value = false
  }
}

onMounted(() => { load(); loadConfigs() })
</script>

<style scoped>
.page {
  padding: 28px 48px 40px;
  overflow-y: auto;
  height: 100%;
  animation: fadeUp 0.35s var(--ease-out) both;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
  gap: 20px;
}
.head-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.head-left { display: flex; align-items: flex-start; gap: 12px; }
.head-info { display: flex; flex-direction: column; gap: 8px; }

.back-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px; font-size: 13px; font-weight: 500;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-0); color: var(--text-2);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  box-shadow: var(--shadow-xs);
}
.back-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-0); }

.page-title {
  font-family: var(--font-display);
  font-size: 26px; font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
}
.drama-hook {
  font-size: 13px;
  line-height: 1.5;
  color: var(--accent-text);
  max-width: 720px;
}
.drama-video-title {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  max-width: 720px;
  font-weight: 500;
}

.page-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.style-chip {
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  background: var(--accent-bg); color: var(--accent-text);
  border-radius: 99px; border: 1px solid rgba(184,120,20,0.12);
}
.genre-chip {
  background: rgba(99, 102, 241, 0.12); color: rgb(79, 70, 229); border-color: rgba(99, 102, 241, 0.18);
}
.meta-divider { width: 3px; height: 3px; border-radius: 50%; background: var(--text-3); }
.meta-item {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--text-2);
}

.smart-result {
  margin-bottom: 24px;
  padding: 18px 20px;
  border-radius: 20px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(244,248,255,0.88));
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.smart-result-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.smart-result-kicker {
  margin-bottom: 8px;
}
.smart-result-title {
  font-size: 20px;
  line-height: 1.3;
  color: var(--text-0);
}
.smart-result-copy {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  max-width: 720px;
}
.smart-result-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.smart-result-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 16px;
}
.smart-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.78);
}
.smart-panel-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
}
.chain-list,
.plan-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chain-item,
.plan-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 14px;
  background: rgba(244,248,255,0.92);
  border: 1px solid rgba(27, 41, 64, 0.06);
}
.chain-phase {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent-text);
  text-transform: uppercase;
}
.chain-summary,
.plan-summary {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-1);
}
.chain-context,
.plan-preview {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.plan-head,
.plan-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.plan-title-row {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.plan-episode,
.plan-duration {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
}
.plan-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-0);
}
.plan-hook {
  font-size: 12px;
  line-height: 1.6;
  color: var(--accent-text);
}

/* Section label */
.section-label {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 700;
  color: var(--text-3); letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* Episode Grid */
.ep-grid { display: flex; flex-direction: column; gap: 10px; max-width: 760px; }

.ep-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 16px;
  cursor: pointer;
  animation: fadeUp 0.35s var(--ease-out) both;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s;
}
.ep-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow);
  transform: translateX(4px);
}

.ep-number {
  width: 44px; height: 44px; flex-shrink: 0;
  border-radius: var(--radius);
  background: var(--bg-2);
  border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 700;
  color: var(--text-2);
  transition: all 0.18s;
}
.ep-card:hover .ep-number {
  background: var(--accent-bg);
  border-color: rgba(184,120,20,0.2);
  color: var(--accent);
}

.ep-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ep-title { font-size: 14px; font-weight: 600; color: var(--text-0); }
.ep-status { display: flex; align-items: center; gap: 6px; }
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.dot-ready { background: var(--success); }
.dot-success { background: var(--primary); }
.dot-pending { background: var(--text-3); }
.status-text { font-size: 11px; color: var(--text-3); }
.ep-duration { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); margin-left: 4px; }
.workflow-chip {
  font-size: 10px; font-weight: 600;
  padding: 1px 6px;
  margin-left: 6px;
  background: rgba(16, 185, 129, 0.12); color: rgb(5, 150, 105);
  border-radius: 99px; border: 1px solid rgba(16, 185, 129, 0.18);
}

.ep-arrow { color: var(--text-3); flex-shrink: 0; transition: transform 0.18s; }
.ep-card:hover .ep-arrow { transform: translateX(3px); color: var(--accent); }

/* Empty */
.ep-empty {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px; text-align: center; color: var(--text-3); font-size: 13px;
  border-style: dashed;
}
.ep-empty-icon {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--bg-2); display: flex; align-items: center; justify-content: center;
}

.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 38, 0.18);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dialog {
  width: min(760px, 100%);
  max-height: min(860px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 26px 26px 22px;
  border-radius: 28px;
  background:
    radial-gradient(circle at top left, rgba(122,167,255,0.14), transparent 34%),
    radial-gradient(circle at top right, rgba(76,125,255,0.08), transparent 26%),
    linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,247,255,0.92));
  overflow: hidden;
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 22px 52px rgba(32, 48, 77, 0.14), 0 8px 18px rgba(32, 48, 77, 0.08);
}
.dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dialog-head-copy { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.dialog-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dialog-title { font-size: 28px; font-weight: 800; color: var(--text-0); letter-spacing: -0.03em; }
.dialog-badge {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(76,125,255,0.1);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 700;
}
.dialog-sub { font-size: 14px; line-height: 1.7; color: var(--text-2); }
.dialog-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.summary-chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.78);
  border: 1px solid rgba(27, 41, 64, 0.08);
  font-size: 12px;
  color: var(--text-2);
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding-right: 4px;
}
.dialog-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 22px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.dialog-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-section-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.dialog-section-copy { font-size: 12px; color: var(--text-3); }
.config-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.config-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.78));
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.config-card-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 2px;
}
.dialog-foot-copy {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.field-hint { font-size: 12px; color: var(--text-3); }
.textarea {
  min-height: 200px;
  resize: vertical;
  line-height: 1.7;
}

.radio-group {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.radio {
  flex: 1 1 120px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.78));
  border: 1px solid rgba(27, 41, 64, 0.08);
  color: var(--text-1);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.radio:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.radio input[type="radio"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
}
.radio:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.clean-mode-radio {
  align-items: flex-start;
}
.radio-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.35;
}
.radio-copy small {
  color: var(--text-3);
  font-size: 12px;
  font-weight: 400;
}
.retention-preview {
  display: grid;
  gap: 8px;
  margin: 6px 0 10px;
  padding: 10px 12px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: var(--radius);
  background: rgba(244,248,255,0.72);
}
.retention-preview-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  font-size: 12px;
  line-height: 1.5;
}
.retention-preview-row span {
  color: var(--text-3);
  font-weight: 600;
}
.retention-preview-row strong {
  min-width: 0;
  color: var(--text-1);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.duration-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.duration-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.78));
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.duration-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.duration-card input[type="radio"] {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  accent-color: var(--accent);
  cursor: pointer;
}
.duration-card:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.duration-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.duration-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
}
.duration-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

@media (max-width: 860px) {
  .page-head,
  .smart-result-head {
    flex-direction: column;
    align-items: stretch;
  }

  .smart-result-grid,
  .duration-grid {
    grid-template-columns: 1fr;
  }

  .head-actions {
    width: 100%;
  }

  .head-actions .btn {
    flex: 1;
    justify-content: center;
  }

  .radio {
    flex: 1 1 100%;
  }

  .dialog {
    width: 100%;
    max-height: calc(100vh - 24px);
    padding: 18px;
    border-radius: 22px;
  }

  .dialog-title {
    font-size: 24px;
  }

  .config-grid {
    grid-template-columns: 1fr;
  }

  .dialog-foot {
    flex-direction: column;
    align-items: stretch;
  }
}

/* Episode list bulk actions & selection */
.section-label-with-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.section-label-left {
  display: flex;
  align-items: center;
  gap: 7px;
}
.section-label-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bulk-select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.bulk-select-all input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.ep-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
  flex-shrink: 0;
}
.ep-delete {
  color: var(--error);
  opacity: 0;
  transition: opacity 0.18s var(--ease-out);
}
.ep-card:hover .ep-delete,
.ep-card-selected .ep-delete {
  opacity: 1;
}
.ep-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ep-card-selected {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.ep-card-selected .ep-number {
  background: var(--accent-bg);
  border-color: rgba(184,120,20,0.2);
  color: var(--accent);
}

.btn-danger {
  background: var(--error-bg);
  color: var(--error);
  border-color: rgba(210, 79, 102, 0.25);
}
.btn-danger:hover:not(:disabled) {
  background: var(--error);
  color: #fff;
  border-color: var(--error);
}
</style>
