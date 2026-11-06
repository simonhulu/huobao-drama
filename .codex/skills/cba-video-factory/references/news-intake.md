# 从双来源新闻到对应比赛录像

用户启动口令：`$cba-video-factory 开始生产`。默认来源为 `https://bbs.hupu.com/cba-hot` 和 `https://sports.sina.com.cn/`，按本轮 `news`、`highlights` 或 `both` 选择制作；用户不必先选比赛、提供新闻链接或找视频。

本入口由 Codex 使用可用的网页/搜索工具研究，并调用既有制作 CLI，不是后台定时爬虫。工作台授权的自动模式按主技能完成预览核验后自动出片，批准备注记录运行编号和实际核验方式，不记录成“用户看过预览”。制作执行器不上传或公开发布。

工作台 `discovery` 执行器读取指派新闻和已有研究记录，不重复全项目环境检查、agent-reach 全渠道体检或锁 PID 巡检。已保存且仍适用的正文沿用原 `retrievedAt`，只补缺失、时效变化或冲突信息，不把旧正文伪称为刚刚读取。

## 双来源快照与筛选

使用 `scripts/cba-video/news-intake.mjs` 的 `fetchCbaNewsIntake()`，读取虎扑 CBA 热榜第一页实际返回位置，以及新浪体育首页 CBA 标签的首屏20条。快照如实记录覆盖范围，不把首屏说成整个网站，也不无限抓取历史页。用户指定更多页或历史日期时再扩展。

虎扑热榜的真实列表位于 HTML 的 `window.$$data.topic.threads.list`；只接纳已识别虎扑资讯作者的 `[流言板]` 新闻帖，论坛讨论和未经确认的发帖者进入 `excludedItems` 并保存排除理由。实际返回条数可能变化，不假定固定24或50条。旧 `hupu-intake.mjs` 和 `cba.hupu.com` 的24条接口仅兼容历史批次，不能替代当前来源。

新浪体育首页 CBA 标签调用：

```text
https://interface.sina.cn/sports/pc_sports_caipiao_common_list_api.d.json?ename=cba&last_ts=&page=1&size=20
```

静态 `/cba/` 页面含旧归档，不是这个动态新闻流。接口中也可能出现国家队、U17或其他赛事，须按标题、标签和正文筛选；CBA稿件可能位于 `/basketball/nba/` 路径，不能仅凭路径或“NBA综合”栏目名排除。`k.sina.com.cn` 自媒体候选标为 `commentary_candidate`，必须寻找可靠原报道交叉核实后才可写成事实。

快照保留每源 `sourceReports`：来源、入口、状态、实际读取数、筛选数、排除数、错误、原始响应及SHA256。单源失败时保留另一源并标记 `complete:false`；双源失败明确报错。访问失败不等于没有新闻。`excludedItems` 保留论坛观点、非CBA或尚不能确认相关性的条目及理由。

去重后按虎扑、新浪交替排序，使有限条数生产也能覆盖两个可用来源；保留各源内部顺序和规范URL，不按比赛合并不同报道。工作台保存 `homepage.json` 后只处理这份冻结快照，不另换旧列表；执行器每次只处理后端指派的4条，更新整份 `intake.json` 中的对应条目，保留其他条目。条数限制作用于筛选后的候选，不得宣称未读取的页面已覆盖。

后端在每组研究完成后，立即串行推进本组已建档任务的素材获取、编辑、独立审核和交付，再研究下一组；研究子执行器仍只负责研究。组后刷新 `match-library.json`，下一组可复用刚获取并核验的同场素材。同一批次已尝试的任务不因下一组引用而重复制作，同场集锦保留唯一任务，包括其尚待恢复的失败记录。

## 正文、时间与任务记录

逐条取得正文，保存原题、报道事件、人物/球队、原始URL、绝对发布时间和事实依据。缺正文或不可访问就记录缺失原因，不能用搜索摘要冒充读过正文。列表的 `listingPublishedAt` 是发稿线索；`publishedAt` 只有取得明确正文证据才填写。抓取时间、回复时间、更新时间、URL日期均不能自动当作发稿日或比赛日。正文存在多个冲突发布时间时保留 `publicationEvidence.values` 和 `conflict:true`，`publishedAt` 保持 null 待核实。

虎扑正文可从 `script#__NEXT_DATA__` 解析 `props.pageProps.detail.thread`：`title` 是原题，`content` 是正文HTML，`createdAt` 是毫秒发稿时间；只读取 thread，不混入回复和相关推荐。正文的视频字段只是直接素材线索，临时签名保存在本地记录，不打印令牌。

新浪采集器默认先读取至多8篇候选的正文元数据和正文；`articleStatus:pending` 或 `unavailable` 表示该条仍需研究，不是“已读正文”。已保存的 `sourceText` 可复用；同时保存 `publisher`、`classification` 和 `requiresCrossCheck`。后续研究仍须逐条完成事实及比赛核对，不能将栏目归属视为事实审核通过。

标题、标签或预读内容暂不足以确认赛事相关性的栏目候选仍保留，标记 `requiresRelevanceCheck:true` 并在 `selectionReason` 说明待核实；正文预算用完或访问失败不等于该新闻与 CBA 无关。后续须补读正文，确认属于 CBA 后才研究比赛和事实；明确 NBA、女篮等其他赛事仍在采集时排除。

批次记录示意（代理维护，非 CLI 输入）：

```json
{
  "entryUrls": ["https://bbs.hupu.com/cba-hot", "https://sports.sina.com.cn/"],
  "retrievedAt": "实际带时区时间",
  "scope": "实际读取的列表和分页范围",
  "items": [
    {
      "url": "真实新闻URL",
      "provider": "hupu",
      "title": "实际标题",
      "publishedAt": null,
      "eventSummary": "正文报道的具体事件",
      "matchId": null,
      "relatedSources": [],
      "videoCandidates": [],
      "jobDir": null,
      "status": "discovered",
      "reason": "",
      "duplicateOf": null
    }
  ]
}
```

每条必须有处理状态和必要原因，不能只报告成功条目。可使用 `discovered`、`researching`、`needs_research`、`waiting_for_source`、`waiting_for_media`、`needs_editorial_route`、`duplicate`、`already_delivered`、`skipped`、`awaiting_review`、`rendered` 等批次状态，不据此随意扩展制作 job 的状态枚举。相同URL已交付可以复用；相同事件的重复报道须有 `duplicateOf` 和具体依据。同场不同事件不能因为共用录像而全部标成已交付。

`duplicateOf` 保存规范原报道 URL，`reason` 说明同一事件的重复依据，`jobDir` 保持 null。重复报道可以指向其他组或历史任务的主报道；它自身不需要独立制作任务，也不能把原报道尚未完成的任务说成已交付。

## 建立可解释的比赛关联

先从正文提取实际比赛日期、双方球队、比分、球员和事件；再核对官方赛程或咪咕赛事页的开赛日期、主客场、比分及回放归属。球队简称只用于查找候选，不是唯一身份。对同一对手不同日期的比赛、稿件跨日发表、多场盘点，必须区分清楚。

新制作任务必须保存：

```json
{
  "profile": {"productionPolicy": "cba-value-v2"},
  "matchEvidence": {
    "status": "confirmed",
    "reason": "这条报道为何对应这场比赛，包括核对的日期、双方和事件",
    "sourceIds": ["实际存在且已保存正文的来源ID"],
    "sourceExcerpt": "支持这条关联的原文摘录"
  }
}
```

`sourceIds` 必须指向 `sources` 中的真实来源，至少一个保存了正文。不得用模型结论、单独的 `match.verified:true`、发稿日或球员名代替关联证据。多个候选或证据冲突时保持 `needs_research`，列出候选与缺失项；匹配能力不能保证所有新闻都有唯一对应比赛。

转会、训练、社媒等不对应单场已结束比赛的新闻，仍可保存直接相关视频线索，但标为 `needs_editorial_route` 并说明非单场原因。不能虚造比赛，也不能拿别场录像冒充当事事件。已有直连视频不等于没有素材，应明确当前比赛制作路线不适用。

## 找到录像、下载完成与可用于剪辑

先检查同场共享素材库：真实文件是否存在、是否可读、实际时长和音轨、指纹是否匹配，以及比赛身份是否核验。历史 `job.media[].path` 仅表示登记过；文件已经清理时必须显示“本地文件缺失”，不能显示已下载或可用。已完成成片和原录像分开保留状态。

没有有效本地录像或对应候选时，执行：

```text
node scripts/cba-video/cli.mjs migu-search --job <任务目录>
```

从咪咕首页站内检索日期、球队全称和常用简称，需要时补查 CBA 回看。用户给过的单一 `/p/live/...` 示例不是所有比赛的固定来源，不把自动找视频工作交回用户。同场候选优先尝试时长较长者，下载失败再试下一条，保留真实尝试；不能为了更长而下载别场比赛。

`mediaSearch` 保存入口、检索时间、查询词、各页结果和候选。`status` 为 `candidates_found`、`partial`、`not_found` 或 `access_blocked`；仅 `completed:true` 且 `not_found` 可说明本次检索未找到，不代表平台永远不存在。访问失败、搜索未完成、候选待下载、下载失败、本地文件缺失、已下载待核验、已核验可用应分别展示。

候选保持 `verified:false`；候选中的 `matchEvidence`、`replayCandidate` 只是线索，与任务的已确认新闻关联证据不同。下载后检查完整日期、双方、比分牌、比赛时钟和实际动作，不能把试看、半场或集锦标为全场回放。已允许使用官方集锦时设 `profile.sourceScope:"highlights"`，媒体仍为 `kind:"highlights"`。

## 选择产物与内容门槛

新任务设置 `profile.productionPolicy:"cba-value-v2"`；新闻版另设 `profile.narrationPolicy:"xiaolu-commentator-v1"`，保留本轮所选版本：

| 选择 | editions | 制作单位 | 目标与最低要求 |
| --- | --- | --- | --- |
| news | `["news"]` | 同主题完整篮球评论 | 目标90–180秒，至少60秒比赛画面及300个有效口播文字；实际语音至少60秒且覆盖成片一半 |
| highlights | `["highlights"]` | 单场比赛 | 目标180–300秒，至少90秒及3个 `completePlay:true` 的已核验完整回合；保留原声，不生成新闻配音 |
| both | `["news","highlights"]` | 新闻及本场唯一集锦 | 分别满足两种要求；同场后续新闻仅出新闻版，复用已有合格集锦 |

以原新闻事件为切入口，把同场赛果、数据、采访等可靠材料组织成有中心判断的评论，不把每条短讯拆成一个短片。固定以“大家好，我们是你们的评论员小鹭”开场，直接讲比赛与自己的篮球分析；媒体名、正文证据保存在后台，采访保留真实发言人。信息不够时先整理已采集的同主题材料，不编造战绩、节比分、伤情诊断或战术因果，也不把制作核验说明念成正文。仍无法支持最低要求时，记录 `skipped` 或明确阻塞原因，不制作数秒“新闻”。

新闻背景可使用明确标注的同场资料画面；直接指认某个进球、犯规或受伤动作时，镜头必须真正对应。实际配音不能超过已选比赛画面的覆盖范围，不能靠停帧、大段无口播镜头或重复动作补足时长。集锦先核对动作起点、攻防过程及结果，再标 `completePlay:true`，不靠重复直播镜头与慢放凑够回合数。

虎扑新闻目录为 `<match-id>-news-<帖子id>`，新浪使用稳定新闻标识或规范URL摘要；集锦单版目录为 `<match-id>-highlights`。`match.id` 保持真实比赛身份，不加运行编号。主 `seedUrls[0]` 是当前报道，其他材料进入 `sources`。同场各任务共享通过检查的原录像，保留各自稿件、批准和音轨；不能复制同一集锦到不同任务后重复上传。

同主题补充报道可归入一个新闻任务：`intake`保存 `status:"merged"`、`mergedInto`（主报道URL）、`jobDir`、`reason`、`matchId`、`matchEvidence:{status:"confirmed",reason,sourceExcerpt}` 及 `segmentIds`。该来源正文须已保存，所列旁白须通过已核实事实使用该来源；后台会核对实际关联，不因同场或出现在sources中便认定已制作。`merged`表示已纳入当前稿件，只有当前成片验证通过才可记已交付；不要把补充报道误标为重复报道。

旧交付不自动添加新版规则或重制，原文件、预览和上传回执保留；页面可提示旧成片过短。后续预览审核、配音、渲染、实际时长验收和交付按主技能执行。单条缺来源或录像时保留原因并继续其他条目，最终汇总成功、重复、待核实、非单场和素材问题；发布仍按用户明确指令执行。
