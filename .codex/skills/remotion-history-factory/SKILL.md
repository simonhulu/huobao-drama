---
name: remotion-history-factory
description: "Create historical narration videos as full-frame shots, then automatically use videoeditor for shot-specific emotion animation, kinetic titles and synchronized local sound effects. Preserve the confirmed manuscript and narration timing; deliver a checked, compact upload-ready movie and a short sound-on preview."
---

# Remotion History Factory

默认制作全画幅历史叙事视频：一镜一个完整场景，按旁白推进，再由 `$videoeditor` 完成逐镜精修。精修是正常制作的一部分，不等待用户另说“加动画”“加音效”。五格漫画、拼页、`progressive_five` 和旧 comic runner 不再是新作品入口。

## 入口与职责

- 新稿：工厂负责已确认稿件、标题/发布包装、风格、旁白母带、确定性分镜、角色一致性与单镜资产；随后自动进入 videoeditor，直到可播放成片。
- 已有 episode URL：复用原稿、旁白与合格图片，直接调用 videoeditor 精修。没有“原稿/AI 改写”双真源：选定已确认正文，确认分镜 narration 与母带一致，不能再私造另一版标题/画面脚本。
- 已有 MP4：先确认有逐镜信息、干净图片和旁白母带；已有烧录字幕不能再叠同一字幕。缺少素材时先使用已能确定的部分，记录限制。
- 只有用户明确要求恢复已有五格 run，才读 [legacy-five-panel.md](references/legacy-five-panel.md)。不要把旧 runner 的 `COMPLETE` 当成新的全画幅精修已完成。

本 Skill 是制作总控；精修实现和判断标准只有一份，位于 [videoeditor/SKILL.md](../videoeditor/SKILL.md) 与其 [refined-editing.md](../videoeditor/references/refined-editing.md)。开始制作时主代理必须读取这两份，保持上下文中的用户授权和风格偏好。不是启动另一个聊天等待人工交接。

## 新稿准备

保留稿件 frontmatter 的已确认 `title` 与同目录 `07-publishing-package.json`。发布包装的钩子、封面主标题、简介不从文件名或 AI 再生成一份。已有 drama 复用锁定 style；新系列没有风格时只询问缺失的创作选择，不重复询问用户已经选过的风格。

```bash
node .codex/skills/remotion-history-factory/scripts/history_intake.mjs \
  --source-only --script <final-script.md> \
  --drama <drama-id>
```

新系列使用 `--create-drama --style <已选style-id>` 代替 `--drama`。
`--source-only` 执行标题/发布包装入库、MiniMax pre-TTS 与确定性分镜，输出 `source-ready` 和真实 episode ID。它不创建五格叙事层级、不继承 BGM、不启动 comic runner。`source-ready` 仅是原材料准备完成，继续制作，不能在这里交还用户。

旁白继续使用现有语境读音词典机制；不把拼音写入正文。分镜按锁定母带 titles 切分，逐字平铺已确认稿件；不调用会重新改写 narration 的 LLM breaker。已有母带无需因精修重新配音。

## 全画幅资产

每镜根据 narration、场景说明、人物反应设计单一完整构图，角色外观与相邻镜头的服饰/道具连续。优先复用合格图片；缺失的按现有 `POST /api/v1/images` 任务接口生成，先读 `backend/src/routes/images.ts` 当前请求格式，再传真实 storyboard ID、完整 prompt、已配置 provider/model 与 16:9。不要调用 `grid.episode_design/generate` 或生成五格页面。

画内留出情绪动画的头部空间与信息标题的空白区。普通字幕、大字、思考泡、乱线、汗滴不烧进 AI 图片，交给可编辑的 Remotion 层。需要地图时读 videoeditor 的 map-animation 参考，用可核验的坐标，不用地理幻觉图。

等待素材任务终态并核验输出可读；只修失败/不合格镜头，不整批重生。任务 ID、图片 SHA、旁白 SHA、titles SHA 记录到本集工作目录。正常范围内自动推进，无需用户批准试片后才继续全片。

## 自动精修与交付

按 videoeditor 的 [全画幅精修流程](../videoeditor/references/refined-editing.md)执行：

1. 逐镜看图并记录表达意图，决定保留安静还是添加人物情绪、重点文字或道具动作；一镜一份决策，不把镜头编号套成固定模板。
2. 用原旁白时间定位每个动作；使用实际运动的 SVG/React 动画和可读的大字。检查人物头部、标题、字幕不相互遮挡。
3. 使用本地已授权音效库，按声画动作选材、裁前静默、保留自然尾音、校准声压及旁白避让。不要用“音效总数”代替完成度，不按“钱/奏折”等词机械打点。
4. 执行计划校验、底片、透明动画层、合并、音效混音；最终合成直接按 videoeditor 的[上传编码与体积验收](../videoeditor/references/refined-editing.md#上传编码与体积验收)产出紧凑上传版，继续完成声画抽检和约一分钟的精选。已有项目保留旧版；新项目的完整成片和精选均须能访问。

默认仅旁白与局部 SFX；BGM 只有本次作品明确选择时才加入，不从上一集静默继承。用户选择的音乐与“情绪音效”分轨处理。

底部逐字字幕与画面大字是不同层；不要把“字体动画”理解成只换字体，也不要把人物反应做成静止贴纸。纯事实、哀悼、诗句可留白，不强行综艺化。

## 字幕与最终渲染合同

新成片默认保留 1080p/30fps、全部字幕/动效，最终编码使用软件 H.264 CRF 24、slow、VBV 峰值 2Mbps；不是先交付高码率整片再追加压缩。体积目标约 10–15MB/分钟，默认验收上限 17MB/分钟（另有 0.5MB 启动/封装余量），检查真实文件大小，不能把峰值码率当成平均码率保证。参数与质量例外以冻结的 `plan.uploadEncoding` 和交付报告为准；不要仅改 `remotion.config.ts`、默用 6.5–7Mbps 硬件编码或通过降尺寸/帧率压缩。具体接线、抽样检查及例外流程只维护在上述 videoeditor 参考中。

字幕烧录默认采用完整视频 composition 的 Remotion `renderMedia()` 直接成片；禁止把整片逐帧导出 PNG，再交给 FFmpeg 拼接/叠加。正常逐帧合成是视频渲染必需步骤，不是性能故障；要避免的是整片透明帧落盘和重复合成。

已验证的字幕专用出口是 `scripts/videoeditor/history_caption_worker.mjs` + 隔离 runtime `remotion/production`，要求冻结的干净底片（不能已烧录同一字幕）和冻结的 caption props。该 worker 会固定 Remotion 4.0.534、要求 H.264 硬件编码、要求共享内存传帧，并把版本、输入哈希、编码参数和媒体校验写入 sidecar；完成后检查 sidecar 的 `status=validated`、`sharedMemoryUsed=true`、硬件编码器名称及完整帧数/音轨。这是既有字幕专用验证合同，不是新的紧凑上传编码入口；不能用它的硬件/3Mbps 设置替代新上传档位，迁移时须重新验证软件编码与全部画面层。共享内存、硬件编码和 GPU 绘制是不同能力；没有独立证据时不得声称使用 GPU 绘制。

该出口目前只对 episode 1044 的 1280×720、30fps 字幕 composition 做过整片验证，不等于完整逐镜编辑器已经迁移。`HistoryCaptionDirect` 不含 `ReferenceEditorialOverlay` 的逐镜情绪/动态标题，也不负责 SFX；不可直接拿它替代完整精修 composition，或把已带字幕的成片再次送入而造成双字幕。一般历史精修必须保留所有已批准的画面层和声音设计，并在提交前确认它们都进入直接成片路径。遇到分辨率、帧率、动效或字幕样式超出该次验证范围时，先扩展/验证 composition 与编码参数；不能静默退回整片 PNG 序列，也不能为了速度删掉效果或降低画质。

现有精修执行链的接线尚未证明对所有 episode 通用：若当前入口仍把字幕烘焙进 base，先改为无字幕底片并准备冻结 caption props，再运行字幕专用出口；确认画面层没有丢失、音频按原合同复制或混音后才能交付。执行结果仍须登记为真实的持久化任务；本地 MP4/sidecar 本身不代表 Remotion 任务列表中的任务已完成。

通过相关脚本测试、时间轴/帧数/编码检查只是技术完成；对代表片段检查动画变化与真实音频播放。无法实际听审时记录检查方式，不声称真人连续听审或“完美”。自动数值通过不能替代视觉/声音审美判断。

交付至少包含完整视频、带声音精选、可复现编辑计划与音效来源记录。最终说明本次改动、验证范围和真实限制。外部发布仍使用用户指定的发布 Skill，不因工厂完成自动上传平台。

## 实现边界

这是 **Skill 驱动的全画幅工作流**，复用已有执行脚本；不是让旧 `history_comic_pipeline.mjs run` 自动改变输出格式。不要启动旧 runner 再在其已审批 candidate 上后贴特效，或伪造旧 run 的审批/COMPLETE。

渲染与交付状态以本轮真实文件、哈希和检查记录为准。进行中的旧任务保留；只有本次作品全片与检查完成，才报告完成。
