# Legacy five-panel history workflow

仅用于用户明确要求恢复已有 `history-comic-five-v1` run。不是新作品默认流程；不要从默认工厂自动进入本文件。


# Remotion History Factory

把历史叙事 Episode 制作为全屏五格渐进漫画视频。只有这一条生产路径：

```text
history-comic-five-v1
+ grid 叙事画格资产（Sequence → Event → Beat → Panel 连续性生活）
+ comic-progressive-five-v1 版式
+ native-comic-v12 plate 底片 + Remotion DharmaTextOverlay 文字叠加（dharma-text-v5）
+ 1280x720 / 30fps
+ H.264 + AAC
```

没有 v8 Grid Remotion 渲染、Grok 视频、xAI 开场 montage、Director motion、pilot 阶梯或人工审稿门禁，不做方案选择。旧的 grid 路由仍可用于存量 Episode 维修，但不属于本路径。

## 停止契约

一次 skill 调用必须持续到以下两种边界之一：

1. `next_action=null` 且 `user_handoff_allowed=true` 的不可恢复 `failed`
2. 已验证的 `COMPLETE`

禁止在 `submit`、`wait`、design/generate 任务进行中、props、candidate render、抽帧、发布、验证阶段结束回复。

`action_kind=agent` 不是用户门禁。当前代理必须完成该动作并立即续跑，不得向用户汇报中间进展，不得等待"继续"。

不要把 `status=failed` 单独当成停止条件。若 `continuation_required=true` 或 `user_handoff_allowed=false`，当前代理必须按 `next_action` 恢复并续跑；`retry-action`、`retry-stage`、`repair-delivery`、`start-new-run` 都属于代理动作，不是用户门禁。

所有正常生产状态推进命令的进程退出码也是停止契约的一部分；仅诊断用的 `start`、`next`、`status`、`advance` 不参与：

- `0`：只用于上述允许交还用户的边界。
- `75`：当前 skill 调用尚未结束。stderr 会输出 `AGENT_CONTINUATION_REQUIRED`；执行 `next_action` 后继续同一 run，禁止向用户结束回复。

正常生产默认不设机器循环截止时间。只有调用方显式传入截止时才返回 `RUN_DEADLINE_REACHED`；该状态不写失败记录，必须用同一 run 续跑。

## 职责边界

| 层 | 唯一职责 |
| --- | --- |
| `SKILL.md` | 固定生产路径，规定 intake、看护纪律、Agent 续跑和失败恢复 |
| `scripts/history_intake.mjs` | 一键 intake：稿件 → episode → publishing package 入库 → pre-TTS → 确定性分镜 → remotion project → 叙事计划 → BGM → 合同终检，逐步幂等 |
| `scripts/history_comic_pipeline.mjs` | 顺序执行机器阶段、独占 run、持久化状态、恢复中断、驱动 design/generate、生成双封面、发布交付、回写 episode 并给出唯一动作 |
| `scripts/history_comic_validator.mjs` | 独立判断环境、TTS、叙事计划、manifest、素材、视觉审批证据、native result 和交付证据 |
| `references/comic-pipeline.md` | runner 命令面、阶段表、动作分类和预算的机器可校验合同（仅修改 runner 时阅读） |
| `references/lessons/*.md` | per-失败码修复指南；`status=failed` 时只读 `checks.lesson_path` 指向的一份 |
| 其余 `references/*.md` | 创作方法论，按需加载（见"references 加载纪律"） |

不要绕过 runner 直接编排 API、任务、生图、props、渲染、发布或质检。诊断与测试才使用 `start`、`next`、`advance`。

## 生产入口

**第一不再是 `run`，是 intake。** 对新稿件：

```bash
SKILL=.codex/skills/remotion-history-factory/scripts
node "$SKILL/history_intake.mjs" --script <含已确认标题元数据的稿件路径> \
  [--drama <已有drama-id> | --create-drama --style <style-id>] \
  [--bgm <static/music/...>] [--publishing-package <path>]
```

稿件必须包含 `polish-video-script` Step 12 写入的 frontmatter，并在同目录包含
`07-publishing-package.json`（或显式传入 `--publishing-package`），且只能有这一处标题来源：

```yaml
---
title: "<用户已确认的标题>"
---
<口播正文>
```

`history_intake.mjs` 读取并校验该标题和 Step 13 publishing package，把 frontmatter 从朗读正文中剥离，然后用同一个标题
创建或同步 episode。它不从文件名、第一句、主题或模型重新生成标题，也不调用标题 agent。
省略 `--drama`（或显式传入 `--create-drama`）时，intake 先按正文哈希查找可复用的已有
drama；找不到时创建一个新 drama，并把确认标题同时写入 `dramas.title` 和首个
`episodes.title`。创建新 drama 时必须先向用户询问并由用户明确选择 `--style <style-id>`；
缺少 `--style` 直接失败，不推断、不推荐、不自动使用任何风格。指定 `--drama` 时只复用已有
系列及其已锁定 style，不覆盖系列标题；已有 drama 的 style 为空同样直接失败。
`--title` 只为旧稿件的显式兼容覆盖保留；新稿件不得传入，若与 frontmatter 不同则直接失败。
缺少 frontmatter 标题时，intake 直接失败，不进入 drama、episode、TTS 或分镜创建。

Intake 会用同一标题校验 `07-publishing-package.json`，然后把完整 JSON 和 SHA-256 指纹写入
episode 的数据库字段。`opening_hook`、`cliffhanger`、`creative_brief` 和 `cover_design`
是生产合同；缺失或标题不一致时在 episode 导入阶段停止，不允许 runner 用标题、正文或模型
响应补写。

intake 逐步幂等执行：读取标题并创建/复用 drama → 用同一标题创建/同步 episode → 等 pre-TTS（MiniMax API）→
`POST /api/v1/episodes/:id/storyboards:break-deterministic` 确定性分镜（从 TTS titles 流精确切分，
逐字平铺正文、每块 ≤8s、四重自检不过不写库）→ 建 remotion project → 构建并导入叙事计划
（`kind='full'`、`timing_source='tts-time-begin-end'`、1 Event = 1 Beat = 1 Panel、beatCoverage ==
storyboard 数）→ BGM（显式 `--bgm` 或继承本 drama 最近一集）→ 打印发布包装、episode/style、pre-TTS、
叙事计划、BGM 五项终检，exit 0。失败打印
`{step, error, direction}` 并 exit 1；修复后原命令重跑，已完成步骤自动 skipped。

**不要**手工拼 API 建 episode/project/plan，**不要**用 LLM storyboard_breaker（非确定性的假成功/漏句/截断是历史事故源，仅存量维修可用），**不要**在 intake 前手工调 API/DB 逐项预检合同——intake 与 runner 用的是同一份校验，fail-fast 且报错自带修复方向。

新系列的第一个 episode 必须由用户先选定风格：intake 使用显式 `--style` 并将它写入
`dramas.style`；未指定时停止并要求询问用户。已有 drama 的 `dramas.style` 直接复用，
不在续集或单镜头阶段改风格。

### TTS 语境读音标注

每次新生成 MiniMax 旁白前，后端先调用已配置的文本大模型，根据完整正文语境识别容易读错的
多音字、姓氏、历史人物名、地名和古汉语词语。标注转换为异步接口兼容的
`pronunciation_dict.tone`，例如 `乐毅/(yue4)(yi4)`、`曾参/(zeng1)(shen1)`；数字 1-5
表示声调，轻声为 5，ü 用 v。原稿和请求 `text` 保留原汉字，不插入会被朗读或污染字幕的拼音。

词典会作用于所有匹配位置，因此标注使用完整词语；同字异音使用不同语境短语，不对重复的
单个汉字全局指定读音。发送 TTS 前必须校验词语确实存在于原文、汉字与拼音音节数量一致、
注音格式有效、重复与重叠规则无冲突。大模型调用或校验失败时停止 TTS，不静默降级为未标注
正文；无风险词时须由大模型明确返回空标注。已有 pre-TTS 母带仍按既有幂等规则复用，
不会因为新增此机制自动重新生成；读音标注降低错读风险，不代替实际音频的听审。

### 封面标题边界

稿件 frontmatter 的 `title` 只负责系列名和 episode 标题，不是封面主标题。history factory
intake 会传 `skip_cover_generation: true`，并清理导入接口可能排入的封面任务；生产 runner
在既有 `episode_publish` 阶段使用已入库的 `cover_design` 生成 4:3 和 3:4 封面。

封面主标题必须来自已校验的 `cover_design.main_title`；历史工厂标记的 episode 缺少这个
字段时必须拒绝生成。禁止使用 episode.title、文件名、正文或 AI `main_title` 兜底/改写。
封面设计中的画面提示词可以单独提供，但不能替代已提交的主标题。

然后启动生产：

```bash
RUNNER=.codex/skills/remotion-history-factory/scripts/history_comic_pipeline.mjs
nohup node "$RUNNER" run --episode <episode-id> > scripts/history-notes/episode-<id>/runner.out 2>&1 &
```

恢复已有生产：`node "$RUNNER" run --run scripts/history-notes/episode-<id>/history-comic.run.json`（同样用 nohup）。

## 看护纪律（血泪教训，强制执行）

runner 是长进程（design/generate/渲染可达数小时）。以下每一条都来自真实事故：

- **必须 nohup detached 启动**。宿主的受跟踪后台任务会被清理器杀掉（每集被杀 3-4 次的事故）；前台 Bash 超时会杀死 runner 留下死租约。被杀了就按 [lease-recovery.md](lessons/lease-recovery.md) 恢复。
- **只订阅事件，不轮询状态**。armed 一个 persistent monitor 盯 `history-comic.events.log`（run 目录，JSONL，仅阶段转场/失败/终态追加一行）或 runner 进程退出，然后停止干预。禁止：手动循环 `status`/查库/查任务（曾单集 1,141 次轮询、占会话 89%）；重复武装多个 monitor 盯同一目标；设与任务时长错配的短超时 monitor 再反复重挂。
- **事件到来时**只读一次紧凑 `status --run <path>`（输出已裁到 ~2KB），按 `next_action` 行动；没有 next_action 变化就继续等。
- 等待 design/generate 期间**不要做空转健康检查**；熔断/provider 故障特征（`Circuit breaker is open`、HTTP 000、DNS fake-ip、超时潮）读 [circuit-breaker.md](lessons/circuit-breaker.md)，确认后等恢复，不要重复诊断。

## Agent Action

当 runner 返回 `continuation_required=true`：

- 不向用户发送阶段性结论。
- 把退出码 75 当成未完成，而不是命令失败或一次执行结束。
- 执行 `next_action` 所指的代理工作。
- 完成后立刻再次运行 `node "$RUNNER" run --run "$RUN"`。修复类命令会自动重新进入 runner，不需要再补一条 `run`。

## 素材与成片数值审查（自动批准）

`asset_review` 与 `frame_review` 不再要求 Agent 看图。素材接触表（`history-comic.assets.jpg`）仍由机器生成并 SHA 锚定，供事后人工抽查；sheet 就绪后 runner 立即以 `actor=runner`、`reviewTool=numeric` 写入审批证据（绑定当前 sheet 字节与全量面板数），流水线在审查阶段不停顿。成片侧不再抽静帧：渲染器是确定性的，`frame_review` 的审批证据直接锚定 candidate.mp4 字节（绑定当前 props 指纹与全量面板数），数值验证即充分质检。

数值证据指：全部画格文件存在、非空、内容哈希唯一、接触表绑定资产指纹；frame 审批绑定渲染产出的同一 candidate 字节。candidate 字节在渲染后被改动时审批自动失效，runner 会要求重渲染。后台进程被杀导致素材接触表在盘但状态丢失时，runner 会自愈重挂，不需要手工改 run.json。

产物保留供事后人工抽查，不耗 token。没有单格重生入口：抽查发现坏格、畸形或版式问题，只能 `start-new-run` 整跑重来。

## 文字与画面演出合同

底片（plate）由 `native-comic-v12` 逐帧确定性渲染，不含任何文字层；字幕由 Remotion composition `DharmaTextOverlay`（1280x720@30fps 透明 PNG 序列）真渲染后与底片 ffmpeg 合成，链路同 dharma 工厂（`dharma_text_overlay_stage.mjs`，dharma-text-v5）。字体、帧位、缓动都由 props 与渲染器/叠加层版本锁定；不要临时改用 CSS animation、系统字体或未冻结的在线字体，也不要回退 ffmpeg 仿制文字层。

- 普通字幕使用随包字体霞鹜文楷 Screen（LXGW WenKai Screen），暖象牙白、深墨描边，底部居中。字幕由冻结 titles 按标点切段、按字符插值定位 spoken 窗口，display 驻留窗口（ink-read-v2 规则）由 core 的 `computeSubtitleDisplayWindows` 现算后显式落盘进 props/overlay props；句间 SharedAxisZ 转场（旧句放大变糊淡出 × 新句升入对焦），末句 blur-out 退场。
- 历史叙事不做关键词描金：`subtitleKeywords` 恒为空数组，overlay 只出暖白楷体层；金句卡同样恒空（`quotes: []`），overlay 金句/气泡层不出现在 history 产物中。
- 画格按 Beat 窗口逐个进入：12 帧 cubicInOut 版式过渡，新格滑入、已读格重排降饱和；每 5 格一页，页间 8 帧墨色 dip；整页 Ken Burns 平移。manifest 中的 `focusX/focusY` 控制每格取景重心，默认 50/50。
- 顶部章节目录条（chapter-hooks-v2）：publishing package 带 `chapter_hooks` 时，overlay 层 `ChapterBar` 在画面顶部渲染分段轨道 + 全章节 hook 标签常驻（当前章金色高亮、未来章暖白常驻作悬念、已播章暗化）；hooks 与 full 叙事计划的 `narrative_sequences` 按序一一对应（数量不符即失败），时间轴直接取 sequence 的 start/end ms。无 `chapter_hooks` 的 episode 不出章节条，不做自动截断降级。
- BGM 由 runner 实测响度后解算：旁白 −14 LU、增益上限 0.5、淡入 3s 淡出 5s。旁白主轨不做任何剪切、拼接或重生成。

## 失败恢复

`status=failed` 时**只读 `checks.lesson_path` 指向的一份 lesson**（1KB 级，与失败码一一对应），修最早失败点：

- `next_action=retry-action`：实际修复动作异常后，显式运行 `retry-action`，再运行 `run`。若 retry-action 拒绝执行并指出 `start-new-run`（requeue 预算已尽、重试结构性无效），直接照做——不要反复尝试同一个 retry-action。
- `next_action=retry-stage`：修复环境、TTS 或叙事计划证据后，显式运行 `retry-stage`，再运行 `run`。
- `next_action=repair-delivery`：只有验证工具连续三次无法完成时，修复对应工具并运行 `repair-delivery`；它保留同一 delivery 字节，只清除失败验证结论，再运行 `run`。
- `next_action=start-new-run`：当前不可变证据链不能原地修复；运行 `start-new-run --actor agent --reason "<原因>"`，从输出取得新 run 并继续。新 run 预算全新（源失败历史仅归档审计）。
- `RUNNER_VERSION_MISMATCH`：run 由更新的 runner 写入。用最新代码的 runner 续跑，或 `start-new-run`。**有 run 在飞时不要修改 runner 源码**；必须改时预期存量 run 需要 start-new-run。

机器重试和 Agent 修复都有固定预算（画格重生 4 次、通用动作修复 2 次、交付瞬态验证 3 次 + 修复 2 次、grid 任务重排队 1 次、verify 阶段重试 2 次）。预算耗尽后 runner 会给出 `next_action=null` 的终态；只有此时才能把失败交还用户。禁止手工提高任务 `max_attempts`、删除修复历史或清空验证报告来绕过预算。

不要删除失败记录，不要覆盖 manifest、candidate 或 delivery，不要整批重生仍然有效的画格。渲染器有区间级增量缓存，修复后的重渲染只重编受影响的区间。

## references 加载纪律

正常生产只需要本文件。其余按触发条件加载，不预读：

- `checks.lesson_path` → 只读那一份（失败时）
- `DESIGN_*`/`GENERATE_*`/`IMAGE_RETRY_EXHAUSTED` 调试 → [grid-pipeline.md](grid-pipeline.md)（资产阶段提示词与门禁）
- 新系列选风格（`dramas.style` 为空）→ [visual-style-library.md](visual-style-library.md)
- 手工修叙事计划（罕见，intake 已自动构建）→ [narrative-storyboard.md](narrative-storyboard.md) + [storyboard-continuity.md](storyboard-continuity.md)；大段计划创作委派 sub-agent 写文件，主上下文只留结论
- 修改 runner → [comic-pipeline.md](comic-pipeline.md)（与 runner 由架构测试强制一致）

## 完成判定

`status == complete`（即 `stage==complete`、`error_code==COMPLETE`、`next_action==null`）是唯一完成信号——发布回读、SHA 一致性、`verificationReport.passed` 都已被状态机作为前置 gate 强制执行，不要逐项手工比对。

最终回复从输出中抄取：`delivery.deliveryPath`（成片绝对路径）、`delivery.sha256`、`episodePublication.videoUrl`（前端 URL，必须是 `static/remotion/history-comic-*.mp4`）、`verificationReport.metrics`（时长/帧率/同步）、run state 路径。任何字段缺失都继续恢复或验证，不能宣称完成。
