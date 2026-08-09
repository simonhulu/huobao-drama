---
name: remotion-dharma-factory
description: "Use when turning a final Buddhist or philosophy narration script into a verified full-screen progressive five-panel comic video with direct final delivery rendering."
---

# Remotion Dharma Factory

把最终净稿制作为全屏五格渐进漫画视频。当前唯一生产路径是：

```text
comic-progressive-five-v1
  -> asset review
  -> props build
  -> delivery_render（直接写入 manifest.deliveryOutput）
  -> delivery_verify
  -> episode_publish
  -> complete
```

固定配置：`retro-anime-1980s`、`gpt-image-2`、`native-comic-v12`、1280x720 / 30fps、H.264 VideoToolbox + AAC。没有候选成片或候选到交付的第二次发布阶段。

## 渲染契约

- native renderer 和 DharmaTextOverlay 都必须使用 `h264_videotoolbox`，并显式设置 `allow_sw=0`；VideoToolbox 不可用时直接失败，禁止回退 `libx264`。
- 主 props 必须包含 `textLayers: "overlay"`。缺字段或旧 props 必须回到 `build-props`，不能静默进入 burned 文字路径。
- 顶部章节悬念条（chapter-hooks-v1）：publishing package 带 `chapter_hooks` 时，`build-props` 用每个 hook 的 `anchor` 在冻结 TTS titles 里定位章节起点（失配即失败），overlay 层 `ChapterBar` 渲染顶部分段轨道 + 当前章悬念标签。无 `chapter_hooks` 的 run 不出章节条，不做自动降级。
- native renderer 可以在 `data/temp` 保留 plate、interval 缓存、音频和透明 PNG 序列等内部中间物；文字合成的最终输出必须直接写入 `manifest.deliveryOutput`。生产链不创建临时成片，也不复制临时文件到 delivery。
- 最终交付证据记录在 `deliveryRender`，至少绑定 props SHA-256、最终文件 SHA-256、字节数、帧数和 renderer/overlay 证据。
- 同一时刻只允许一个 run 持有 Dharma 渲染锁；中断后只恢复当前 run 中已有的完整最终输出证据。

## 当前状态契约

当前 run schema 是唯一可读 schema：`version=4`、`planVersion=comic-production-plan-v7`。旧 version、旧 plan 或包含旧候选流程的 run 不迁移、不改写，直接拒绝；需要新 run 时使用 `start-new-run` 或重新从最终净稿启动。

正常入口：

```bash
RUNNER=.codex/skills/remotion-dharma-factory/scripts/dharma_comic_pipeline.mjs
node "$RUNNER" run \
  --script scripts/dharma-notes/<article-id>/05-final-script.md \
  --title "<video-title>" \
  --publishing-package scripts/dharma-notes/<article-id>/07-publishing-package.json
node "$RUNNER" run \
  --run scripts/dharma-notes/<article-id>/comic-production.run.json \
  --publishing-package scripts/dharma-notes/<article-id>/07-publishing-package.json
```

`07-publishing-package.json` 是 `dharma-video-script` 在最终稿和标题之后的发布包装产物。它必须包含 `opening_hook`、`cliffhanger`、`creative_brief` 和 `cover_design`；工厂会校验标题指纹，把字段和完整包装对象写入 episode 数据库，并用 `cover_design.ai_prompt` 调度 4:3、3:4 封面。旧 run 可通过第二条命令补挂包装包并继续发布。

正常生产不使用 `start`、`next` 或 `advance`，它们只用于诊断和测试。`run` 会独占 run 状态并自动执行全部机器动作；`exit 75` 代表当前调用仍需 Agent 按 `next_action` 继续，不是交还用户。

停止只允许发生在以下边界：

1. Agent 看过素材但确实无法判断，并记录 `ASSET_HUMAN_REVIEW_REQUIRED`。
2. 出现不可恢复失败，且 `next_action=null`、`user_handoff_allowed=true`。
3. runner 返回已验证的 `COMPLETE`。

不得在 `submit`、`wait`、TTS 等待、props、`delivery_render`、`delivery_verify` 或 episode 发布过程中结束调用。`review-assets` 是 Agent 动作，不是用户审批门禁；只有明确执行 `escalate-assets` 后才允许交给用户。

## 输入与时间轴

- `--script` 是最终净稿。YAML front matter 只作为 metadata，不进入旁白。
- 标题和旁白是独立输入；TTS、字幕、manifest、props 和验证的唯一文本源是去除 front matter 的正文。
- 默认旁白音色为 `voice-clone-aug7-1786117023178`，默认语速为 `0.85`。已有 run 的音色和语速不可变，更换时创建新 revision。
- TTS titles 的 `time_begin/time_end` 是唯一时间真源，禁止按字数估算时长。字幕、金句、面板边界和同步验证都必须从冻结 TTS 时间轴推导。

## Agent 素材审查

当 `next_action=review-assets`：

1. 读取 `checks.asset_sheet_path`，核对 `checks.asset_sheet_sha256`。
2. 使用 `view_image` 或宿主原生图片读取工具逐格看实际接触表；只读 SHA、文件名或日志不算视觉审查。
3. 检查人数、关系、动作、可见情绪、物理证据、连续性、清晰度、畸形和生成文字。
4. 清楚合格时由 Agent 批准；清楚不合格时执行 `reject-asset`；只有证据两可时才执行 `escalate-assets`。

合格：

```bash
node "$RUNNER" approve-assets --run "$RUN" \
  --sheet-sha256 <checks.asset_sheet_sha256> \
  --actor agent --review-tool view_image \
  --reviewed-count <checks.asset_review_count> \
  --reason "<逐格可见证据>"
```

不合格：

```bash
node "$RUNNER" reject-asset --run "$RUN" --key <panel-key> \
  --actor agent --reason "<具体可见缺陷>"
```

无法可靠判断：

```bash
node "$RUNNER" escalate-assets --run "$RUN" \
  --sheet-sha256 <checks.asset_sheet_sha256> \
  --actor agent --review-tool view_image \
  --reason "<具体歧义和位置>"
```

素材审批完成后，runner 自动进入 props 构建；不需要人工批准页面或视频静帧。

## Props 与直接交付渲染

`build-props` 必须冻结：

- 真实 TTS title 范围和每个 subtitle 的 title 索引。
- `theme`、`scripture`、`explanation` 三类 emphasis 的动画、来源和 SFX 规则。
- `LXGW WenKai Screen` 普通字幕、`Ma Shan Zheng` 金句、`Noto Serif SC` 气泡字体及其版本指纹。
- overlay props、音频/BGM 挂载、响度测量、manifest/asset/TTS artifact chain 和 props SHA-256。

`next_action=render-delivery` 时，runner 执行一条渲染动作：

```text
native-comic-v12 -> plate / interval cache
  -> DharmaTextOverlay PNG sequence
  -> ffmpeg overlay composite -> manifest.deliveryOutput
  -> deliveryRender record
```

最终合成直接写入 `manifest.deliveryOutput`，文件本身从生成完成起就是最终视频。内部 plate、PNG 序列和 renderer 缓存只是实现细节，不构成第二个成片版本。若最终输出和完整 delivery record 已存在但 run 状态尚未写完，使用 `recover-delivery` 绑定同一字节；若输出路径已有无法验证归属的文件，拒绝覆盖并创建新 run。

The compositor directly writes the final delivery at `manifest.deliveryOutput`; there is no candidate-to-delivery copy step.

## 交付验证与发布

`delivery_verify` 直接检查 `manifest.deliveryOutput`：

- H.264/AAC、1280x720、30fps、无 B-frame。
- 解码帧数、音视频时长、字幕和经文与冻结 TTS 时间轴一致。
- loudness、持续黑帧、ffmpeg/ffprobe 警告和同步脚本全部通过。
- `verificationReport.sha256` 必须等于 `deliveryRender.sha256`，并绑定当前 props、素材接触表、TTS audio/titles。

只有验证通过后才能执行 `publish-episode`。该动作将已验证 delivery 的 URL、delivery SHA-256、verification SHA-256 和 props SHA-256 原子写入 episode，并通过 `/dharma/episode/:id/footage` 回读确认。它是 episode 元数据发布，不是视频候选发布。

## 失败恢复

- `retry-action`：修复当前机器动作异常后，保留失败记录并按预算重试。
- `retry-stage`：只用于 environment、episode ownership 或 TTS 证据的显式修复。
- `repair-delivery`：只清除验证工具的瞬时失败结论，保留同一最终 delivery 字节。
- 不可恢复的输入、manifest、素材或交付归属问题必须 `start-new-run`；不得覆盖 manifest、props 或最终 delivery。
- 不手工提高任务预算，不删除失败记录，不通过清空验证报告绕过门禁。

## 完成判定

只有同时满足以下事实才能报告完成：

```text
stage == complete
status == complete
error_code == COMPLETE
next_action == null
verificationReport.passed == true
delivery.path == manifest.deliveryOutput
delivery.sha256 == verificationReport.sha256
artifactChain.deliveryRenderSha256 == artifactChain.deliverySha256
artifactChain.deliverySha256 == artifactChain.verificationSha256
checks.episode_published_current == true
checks.episode_video_url == checks.expected_episode_video_url
artifactChain.episodeVideoUrl == checks.expected_episode_video_url
```

此外，episode 数据库必须同时有 `opening_hook`、`cliffhanger`、`cover_image_4x3_url` 和 `cover_image_3x4_url`。封面任务失败会保留 run 状态，恢复同一个 run 重试；发布脚本只从数据库读取这些字段，必要时只做平台尺寸归一化。

最终回复给出最终视频绝对路径、前端 URL、SHA-256、时长/帧率验证结果和 run state 路径。任一字段缺失都继续验证或恢复，不能宣称完成。
