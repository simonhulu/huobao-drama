# 调用和数据约定

以下命令在项目根目录使用 `node scripts/cba-video/cli.mjs`，也可从任何目录执行本技能的 `scripts/run.mjs`（替换为实际绝对路径）。`--job` 为任务目录。所有文本/JSON 产物用编辑工具保存，路径带空格时正确引用。

## 环境

独立对话或 CLI 首次使用时执行以下环境检查。工作台已设置 `CBA_AUTOMATION_PHASE=discovery|editing|audit` 的子执行器直接进入后端指派步骤，不重复执行 `doctor`、agent-reach 全渠道体检、`git status` 或锁 PID 巡检；仅在出现具体错误时检查相关组件。`.production.lock` 由协调器管理，子执行器始终不得修改。

```sh
node scripts/cba-video/cli.mjs doctor
```

需要 Node、FFmpeg/ffprobe；在线下载使用已安装的 videodl 或 yt-dlp，具体 URL 的支持情况要实测，下载后的本地文件再导入。VideoHighlighter 使用独立源码目录与包含其依赖的 Python：

```sh
node scripts/cba-video/cli.mjs analyze --job data/cba-video/MATCH \
  --repo /absolute/path/VideoHighlighter --python /absolute/path/python
```

也可设置 `VIDEOHIGHLIGHTER_REPO`、`VIDEOHIGHLIGHTER_PYTHON`。本机已验证源码位于 `~/Library/Caches/cba-video/VideoHighlighter`，Python 为 `~/miniconda3/bin/python`。环境变化时先重新检查；不要把这些本机路径当作所有机器通用路径。源码首次接入的提交为 `8d3eee1379467057801bd987725d71b353b2a6dd`。适配器调用 `pipeline.run_highlighter(..., gui_config={report_only:true,...})`，保留真实报告；默认只启用场景、运动和音量信号，不证明语义。

配音通过 `backend/run-tsx.mjs` 复用项目 `generateTTSWithMetadata` 和已配置的音频提供商，不读取或输出明文密钥。可在 `job.tts` 设置 `{voice,speed,emotion?,configId?,model?}`，音色和模型必须与所选服务兼容。新任务默认使用用户选定的 A：`{voice:"Chinese (Mandarin)_Radio_Host",model:"speech-2.8-hd",speed:1.08,emotion:"fluent"}`。本机已验证 MiniMax 配置为 `configId:4`；新任务先核对配置提供商，仍为 MiniMax 时在预览前通过 `edit` 指定，其他机器不得盲用该数据库ID。已有任务不自动迁移音色。每段音轨按文稿与配置缓存。未经具体预览批准，不运行配音。

用户已授权以现有 Qwen 服务备用恢复。仅在确认当前失败步骤为配音且 MiniMax 返回明确账户故障时自动切换；恢复前使用旧错误还须匹配当前段落与配音配置摘要。备用从当前启用的 Qwen 旁白配置选取，使用其模型及兼容音色，不写死数据库ID，不传 MiniMax 音色或 `fluent` 参数。切换记录原配置和原因并使旧批准失效，复用文稿与录像重新核验后再配音；旧音频文件保留，新音频绑定实际配置。备用失败不循环换服务；取消后不再切换。用户明确要求备用恢复时可迁移旧任务，但不得推定其丢失的原始失败原因。

## 创建、选题、研究

默认先执行 [新闻遍历入口](news-intake.md)，从虎扑首页新闻生成有来源的批次记录。Codex 读取新闻并作编辑判断，`migu-search` 对已识别任务执行咪咕站内检索；不提供名为 `crawl` 或 `batch` 的自动联网命令。

`match.json`：

```json
{"id":"2026-10-18-nanjing-guangdong","league":"CBA","date":"2026-10-18","home":"南京","away":"广东","score":"96–95","verified":true,"seedUrls":["https://bbs.hupu.com/643059363.html"]}
```

该示例比赛身份已用新闻与咪咕公开赛事信息交叉核对。其他比赛的 `verified` 只在真实核实后设置。

```sh
node scripts/cba-video/cli.mjs init --match match.json
node scripts/cba-video/cli.mjs research --job data/cba-video/MATCH --input research.json
```

`research.json` 包含 `sources`、`facts`、`news`，每个字段替换原字段，故追加前先读取现有记录。`--input` 也可指定含 sources.json、facts.json、news-draft.json 的研究目录。

首次编辑使用后端简报和当前任务，围绕一个篮球问题组合主新闻与同主题已核实材料，确认事实、采访、比赛身份和可用素材。小鹭口播设 `profile.narrationPolicy:"xiaolu-commentator-v1"`，目标90–180秒，至少300个有效文字、60秒实际旁白和60秒比赛画面；首段以“大家好，我们是你们的评论员小鹭”开头。成稿直接讲比赛和自己的判断，不念虎扑、新浪、原文或“这篇报道提到”；后台仍保存真实sources、factIds和出处。球员采访保留说话人，未证实消息不能改成确定事实，不虚构退役球员个人经历。主报道是切入，不禁止利用同场已有报道提供可靠补充；每个具体数字须由保存的正文支持，事实ID合法不等于正文确有依据。复用原文与素材，仅缺失、冲突或新增事实补查。

没有已核实对应录像或可用候选时，必须运行 `node scripts/cba-video/cli.mjs migu-search --job data/cba-video/MATCH`。命令先读取 `https://www.miguvideo.com/p/home`，再按比赛日期和球队别名调用站内搜索，把可追溯的 `mediaSearch` 写入任务。用户提供的播放页仅可作为示例或候选；恢复时复用已核实素材及有效候选，补查失败部分，不重新扫描无关比赛，不要求用户先提供视频。

`mediaSearch` 包含 `provider`、`entryUrl`、`searchedAt`、`queries`、`requests:[{query,page,status,resultCount}]`、`candidates`、`status` 和 `completed`。`status` 区分 `candidates_found`、`partial`、`not_found`、`access_blocked`；只有 `completed:true` 的 `not_found` 才代表本次查询未找到。部分请求失败保留 `partial` 及已有候选，继续重试或补查咪咕 CBA 回看；请求错误或无法解析的响应不能计作零结果。

每个候选保留 `verified:false`、`replayCandidate` 和 `matchEvidence`，可附官方赛事依据 `source`。这些字段只是线索，不直接导入媒体，也不改变已批准剪辑的摘要。标题“全片”、视频发布日期、时长均不能单独证明同场完整比赛；下载后核对实际日期、双方、比分牌、四节完整性及音轨，再以 `import-media --kind full_replay --match-confirmed` 导入。

工作台候选选择遵循用户规则：在已关联同一比赛的素材中按时长降序尝试，时长相同或缺失时按搜索结果顺序。集锦模式不因“全场/半场”标题冲突而排除候选，保存原赛事页标题和搜索标题，下载后保持 `matchConfirmed:false`，交给编辑核验实际画面与范围；不将半场或未知范围标为完整回放。没有对应单场比赛的新闻显示“没有对应视频”，研究记录继续保留。

- `sources`: `[{id,url,title,publishedAt,retrievedAt,kind,text}]`，kind 为 official/media/forum，text 保存相关摘录或核实摘要。
- `facts`: `[{id,text,sourceIds:[sourceId],verified:true}]`。未核实项不能设置 true，也不能为其填造来源。
- `news`: `{title,shortTitle,summary,segments:[{id,text,factIds:[factId],clipIds:[clipId],mode?:"original"}]}`。素材未取得时 clipIds 保持空数组。

新任务设置 `profile.titlePolicy:"source-date-cba-v1"`。新闻标题从第一条 seed 对应原标题结合正文微改；原始 `sources.title` 保留不变。两版 `title` 都按 `2026-10-23 CBA｜标题正文` 编写（日期取核实的 `match.date`，最多50字符）；两版 `shortTitle` 含 CBA、最多16字符，供视频号使用。百家号直接使用完整标题，超长应在编辑阶段缩写，不在上传时截字。工作台在未交付任务的独立审核前启用此规则；已交付旧任务继续复用原成片与原上传指纹。

用户已允许集锦创作时，在 `profile` 保留原尺寸、时长与平台设置，并显式加入 `sourceScope:"highlights"`。该字段绑定审批摘要；改变素材范围需要重新生成预览。此模式允许经核实的 `kind:"highlights"` 素材进入制作，仍检查事实、媒体身份、指纹、回合和原声；预览明确披露素材范围。默认未设置或 `sourceScope:"full_replay"` 仍要求完整回放，不把集锦改名为完整录像。

仅在用户明确要求比赛推荐时，候选列表供 `recommend --input candidates.json` 使用：`[{match,reason,sourceUrls:[url],publishedAt,materialStatus}]`。此命令校验并归并同场，不联网也不虚构热度；默认新闻遍历不以此命令代替逐条阅读和视频匹配。应先统一球队别名再提交。

## 素材与分析

```sh
node scripts/cba-video/cli.mjs download --job data/cba-video/MATCH --url 'https://source/video'
node scripts/cba-video/cli.mjs import-media --job data/cba-video/MATCH --file /absolute/replay.mp4 --id replay --kind full_replay --match-confirmed
node scripts/cba-video/cli.mjs analyze --job data/cba-video/MATCH --id replay
```

咪咕 `/p/detail/` 地址先由已安装 videodl 的 KedouVideoClient 解析，再交给 yt-dlp 下载。`/p/live/` 是赛事集合，需要指定 `--content-id` 或选择 migu-search 返回的具体详情页；不能把默认集锦当作完整录像。可用 `--python` 或 `VIDEODL_PYTHON` 指定已安装 videodl 的 Python。其余地址直接使用 yt-dlp。下载禁用全局配置和播放列表，失败保存脱敏日志并保留任务以便重试。必须检查真实文件和 ffprobe，退出码 0 不代表已下载成功。成功也不会自动确认比赛身份/完整性。`import-media` 引用本地原文件并保存 SHA-256，不搬走原文件。已有镜头引用的 media id 不能悄悄替换。诊断与实测产物见 `docs/migu-download-diagnosis.md`。

网页不受解析器支持时，可用已有浏览器按网站正常播放流程被动读取媒体响应；不改签名、会员或 DRM 逻辑。实际媒体 URL 可存文本文件，`download --url-file <文件>` 读取，避免在日志或对话里泄漏查询参数。先核实播放清单时长/分辨率，排除广告、试看与精华，再检查磁盘余量。免费产品标签不等于实际下载成功。

分析产物 `candidates-replay.json` 是候选清单，不直接替代最终剪辑。同一媒体指纹下已有有效分析、切点和实际画面证据时复用，文案修正不触发重新分析。首次查看片段并确定用途后用 `edit` 导入：

```json
{
  "clips": [{"id":"play1","mediaId":"replay","start":123.4,"end":139.7,"label":"事件名称","factIds":["fact1"],"verified":true,"verificationNote":"实际画面核对记录，例如节次、比赛时钟、比分与动作"}],
  "profile": {"titlePolicy":"source-date-cba-v1"},
  "news": {"title":"2026-10-18 CBA｜南京一分险胜广东","shortTitle":"CBA南京一分险胜广东","summary":"发布简介","segments":[{"id":"n1","text":"旁白正文","factIds":["fact1"],"clipIds":["play1"]}]},
  "highlights": {"title":"2026-10-18 CBA｜南京96–95广东关键回合集锦","shortTitle":"CBA南京广东关键回合","clipIds":["play1"]}
}
```

示例时间码仅解释格式，禁止拿示例直接用于比赛。`edit` 只接收 clips/news/highlights/tts/match/profile。profile 按字段合并，因此只设置 sourceScope 或 preset 不会丢掉尺寸、帧率和时长目标；其他字段仍整体替换。按录像原时间顺序选集锦，禁止重叠；旁白段落各自分配不同回合。原声段落用 `mode:"original"`，无需配音文件。为可读字幕把新闻分成数句一段，避免一段涵盖太多事件。

标注为同场资料画面且文案没有指认动作时，切点不必精确到完整回合的起止帧；可理解且不误导就保留。文案明确指认某次得分、受伤或犯规时，必须核对实际事件和关键动作，错配或截断导致含义改变必须修正。剪辑审美和不影响事实的边界偏好不触发重剪。

## 预览、批准、交付

以下默认示例用于对话审核。若当前是工作台明确启动的自动模式，按主技能的“工作台自动模式”完成预览核验，并在批准备注中记录真实的本轮授权与核验方式；配音仍必须绑定完整且有效的预览摘要。

工作台首审须一次列全事实、来源、身份与误导画面的实质错误，纯润色建议不阻断。首审后最多一轮内容修正，编辑只改问题清单涉及的内容，复审核对这些修正及其影响；仍有真实错误时保留问题并结束本条，队列继续下一条。报告结构问题单独交审核者限次修复，不触发重编稿或重剪；格式修复不能补造事实、画面观察或来源。

```sh
node scripts/cba-video/cli.mjs edit --job data/cba-video/MATCH --input edit.json
node scripts/cba-video/cli.mjs review --job data/cba-video/MATCH
```

查看并交付 `review/index.html`，它使用真实片段预览、时间码和来源引用；完整方案还生成 `review/news-preview.mp4` 与 `review/highlights-preview.mp4`，供连续观看。这两条都是原声画面预览，新闻旁白尚未合成，不能称为最终成片。缺素材时只生成明确标缺的资料页。`review/validation.json` 中的 errors 必须解决，`complete:true` 才能批准。用户明确认可该版本后：

```sh
node scripts/cba-video/cli.mjs approve --job data/cba-video/MATCH --digest ACTUAL_REVIEW_DIGEST --note '记录用户对本次预览的真实确认'
node scripts/cba-video/cli.mjs tts --job data/cba-video/MATCH
node scripts/cba-video/cli.mjs render --job data/cba-video/MATCH
```

实际音轨长度决定新闻时间线；成片输出到 `renders/<渲染摘要前16位>/`，摘要绑定已批准的编辑、真实音轨和渲染实现，包括 news.mp4、highlights.mp4、news.srt、两版封面和 delivery.json。交付清单含平台文案、来源及剪辑警告。输出文件已存在且本次版本无变化时复用。

真实配音生成后，应检查“这球”“第一次/第二次”等叙述是否对应当时画面。只需调整朗读起点时，可在该段 `audioDigest.offsetSeconds` 设置非负秒数。需要在句间保留原声时，可用 `audioDigest.parts` 分段安排：`[{start:0,end:9.4,offset:0,text:"前半段原文"},{start:9.4,end:21.3,offset:17,text:"后半段原文"}]`。start/end 是音频原始时间，offset 是此新闻段内的播放起点；各段连续覆盖整条音频，文字拼接必须与已批准原文完全一致，播放窗口不可重叠。断点应落在实际停顿处，不截断词语；数值必须按本场音频核验，不能照搬示例。空档恢复现场声，字幕同步让出空档。以上只安排已生成音轨的时序，不能借此更改已批准的文字、镜头或音色。

## 恢复

```sh
node scripts/cba-video/cli.mjs status --job data/cba-video/MATCH
node scripts/cba-video/cli.mjs migu-search --job data/cba-video/MATCH
```

`waiting_for_media` 表示尚无任务要求的素材（默认完整回放，显式集锦模式可用对应集锦），不代表已搜索失败：无 `mediaSearch` 时先执行咪咕搜索，有报告则根据实际失败步骤继续检索、下载或核验。`needs_edit` 补事实/镜头核实；`awaiting_review` 等待具体预览确认；`approved` 可继续配音渲染；`rendered` 已有两版交付。同任务使用 `.lock` 防并行写入。如果进程中断留下锁，先读取 PID 并确认对应进程已退出，再只移除这个锁文件；不要清理整个任务目录。

验证脚本：`node --test scripts/cba-video/*.test.mjs`；媒体适配测试的真实上游运行按测试文件说明设置环境。合成素材测试是工具测试，不能当作真实比赛成片或实际回合识别成功的证据。
