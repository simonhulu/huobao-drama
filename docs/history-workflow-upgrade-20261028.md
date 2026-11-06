# 历史视频：YouTube 来源、两版制作与百家号直接发表

更新于 2026-10-31。此文是 `/history-scripts` 当前工作流说明；旧文档中的自动图文、视频号短标题、联网选题标题及默认草稿箱流程已退出新制作链路。

## 页面怎么用

1. 打开 `/history-scripts`，点“启动采集”，来源选择 **YouTube 频道 / 视频**，在频道列表里添加、删除或修改频道，点“保存频道”后启动。默认保留 `https://www.youtube.com/@助眠睡前歷史故事/videos`；也可以切换为单条视频采集。YouTube 不要求先完成抖音登录。
2. 采集复用视频下载、转写、校对和二创链路。开启“二创成功后自动制作”时，新二创稿自动进入两版制作；已有稿件保存正文后点 **制作两版视频**。关闭自动入队只影响新稿，不取消已接受的任务。
3. 同一份已保存二创稿分别交给花生和现有 Remotion 历史工厂。精细化分支仍在 `/remotion/episode/<id>` 查看和恢复。制作阶段不再次创作文稿。
4. “成片与封面”按花生版、精细化版分别预览和下载；切换成片时同时切换本版标题、封面方案、图片和生成状态，未保存草稿也按版本保留。发布标题直接改写来源原标题，封面文字独立编辑，旧版文件保留。
5. 每版成片完成、校验并关联后，自动生成自己的标题、封面方案和三比例封面；包装齐备后单独自动发表百家号，不等待另一版成片。页面显示“已提交审核”或“已发表”，不把草稿或上传完成当作发表成功。首次使用需要有效的花生与百家号登录，以及已配置的文本、语音和图片服务。

本次真实 YouTube 验证只下载了来源 #368，没有为 84 分钟原片启动长稿制作。用户提出的十分钟浓缩与分集属于下一阶段方案，见 [十分钟浓缩及多集包装方案](history-ten-minute-series-plan.md)，当前尚未实施自动浓缩。

### YouTube 频道列表

频道列表与抖音关键词使用同一采集设置存储，但分别保存，修改频道不会覆盖关键词。支持 1–30 个频道，按显示顺序逐个读取；频道主页和对应 `/videos` 地址会归一，重复项及非频道链接不能保存。单条视频使用单独的临时输入，不混入长期频道列表。

“产出数量”是本次任务所有频道合计的成功二创数，不是每个频道各制作这么多条。前一个频道读完且目标未满足才进入下一个；全部读完或达到数量就结束。不同频道出现相同视频 ID、或来源已经保存时跳过，避免重复下载和制作。持续采集读取整个已保存列表直到耗尽；手动停止后不再进入下一频道。

频道修改保存后刷新仍保留；未保存或读取失败时不能按频道列表启动。每个任务保存启动时的列表快照，运行中修改设置只影响下一次新任务，重试旧任务沿用旧快照。旧 `youtube:{url:...}` 单链接任务继续兼容；新任务使用 `youtube:{urls:[...]}`。

频道列表更新已验证：后端 90 项、前端 10 项相关回归及后端 TypeScript 检查通过。实际本地页面完成临时频道添加、保存、刷新读取、删除并再次保存，原有抖音关键词保持一致；最终只保留用户原来指定的频道。验证没有启动采集或制作。桌面 1440px 与手机 390px 无横向溢出，记录在 `/tmp/history-youtube-channels-live.json`，页面截图 `/tmp/history-youtube-channels-final.png`。

## 代码和数据如何连接

| 环节 | 当前入口和实现 | 关键约束 |
| --- | --- | --- |
| YouTube 来源 | `history-source-youtube.ts`，source jobs/pipeline/routes | yt-dlp；视频 ID 与来源 URL 归一；已下载文件检查后复用；不冒用抖音热度门槛 |
| 自动接纳 | `history-source-pipeline.ts` → `history-huasheng.ts` | 二创成功写入 `huashengQueue.productionMode:dual`；消费标记与两版记录同一事务 |
| 手动制作 | `POST /api/v1/history-scripts/:id/production {}`；兼容 `/:id/huasheng` 和精细化入口 | 锁定当前正文 SHA；重复操作复用接受的任务 |
| 两版调度 | `history-video-workflow.ts`，`history_dual_production` | 两分支独立；本地精细化最多两项活跃；单项出错不阻塞其他稿件 |
| 花生交付 | `history-huasheng-export.ts` | 复用原项目导出；远端视频完成且导出成功入队后才结束调度；导出完成与发表意图原子写入 |
| 精细化交付 | `history-motion-delivery.ts` | 关联自己的 output ID，不因花生已占旧 `videoUrl` 而漏交；只重试关联不重新渲染 |
| 成片版本 | `history-video-deliveries.ts`，`history_video_deliveries` | 正文 SHA、producer、任务、文件 SHA；`videos` 为当前每渠道最新版，`videoHistory` 留全部版本 |
| 发布包装 | `history-title-source.ts`、`history-publishing-copy.ts`、`history-delivery-automation.ts`、`history_video_packaging` | 按 videoId 保存与重试；人物、年代、数字与主题词保留；另一版方案作为避重参考；不再依赖视频号短标题、简介或文章 |
| 发表意图 | `history-video-publication.ts`，`history_video_publication_intents` | 按单个 videoId 入队；先完成先发表；不会自动扫描旧库批量发表 |
| 平台执行 | `history-social-upload.ts` → `social-auto-upload.ts` → `backend/scripts/social-auto-upload/` | 默认 `publish`；原检查点、固定 requestId、平台回执防重复；结果未知只核对 |

正式标题 `baijiahaoTitle` 与兼容 `title/video_title` 同值。封面 `main_title` 不再被迫等于发布标题；新包装存储 `publishing_version:source-title-v2`、原标题、清理结果、保留关键词和移除推广内容。旧包装可读，不批量覆盖。

## 每版独立的标题和封面

花生在导出文件下载、校验和关联后触发包装；精细化版在渲染成片校验和关联后触发。`history_video_packaging` 以具体 `video_id` 为主键，`history_video_design_intents` 保存本版模型调用进度。两版不能互相满足包装就绪条件，也不会复用稿件级旧标题和封面。只补齐本版缺少的产物，重试复用已完成的本版方案、底图和封面文件。

同一稿件的两版标题方案依次创作，后一版读取前一版已保存的标题和画面提示词，要求改变标题表达与场景构图。保存时忽略标点、空白、大小写和版本后缀检查重复，不接受只追加“花生版”或“精细化版”的相同文案。封面图片仍可各自生成，输出目录为 `history-deliveries/<sourceId>/video-<videoId>/covers-<hash>/`。

包装接口使用 `GET/PUT /api/v1/history-scripts/:id/delivery?video_id=<videoId>`；`POST /design`、`POST /design/review`、`POST /covers` 同样携带该参数。返回本版 `videoId`、`producer` 和包装字段，`videoPackagings` 汇总当前各版包装；`videos` 和 `videoHistory` 保留成片列表。省略参数时仍读取旧 `history_script_deliveries`，仅用于历史兼容。

上传指定 videoId 时只读取本版包装，缺少、过期或失败时不能改用旧共用封面。尚未提交到平台的排队任务可以等待本版包装完成，再更新上传快照；已经提交、回执未知或正在恢复的任务保留原始快照和检查点，不重新上传或重复发表。包装失败不移除成片，也不清除另一版的产物和回执。

本次拆分验证：后端 437 项、前端 204 项相关回归及后端类型检查通过。服务重启后，用来源 #133 的花生 videoId=55、精细化 videoId=100 在 1440px 与 390px 页面只读核验版本切换、对应 API、空包装不回退旧标题和无溢出；记录位于 `/tmp/history-packaging-live/evidence.json`。额外运行的 `history-publishing-mechanism.test.ts` 有 30 项旧用例失败：其 mock 和断言仍期待已废弃的联网搜题及 `platform-v1/curiosity` 协议，与现行 `source-title-v2` 不匹配，未在本次拆分中迁移。

`articleGeneration` 在新交付里为 `null`；自动文章 worker 不再启动。旧文章数据、旧草稿回执、旧显式草稿 API 留作兼容，不参与新页面的发布选项和完成判断。抖音图文或百家号文章仍可作为二创**输入来源**，不生成图文发布作品。

## 状态与恢复

- `GET /api/v1/history-scripts/:id/production` 可读两版调度记录；制作详情分别沿用原花生、Remotion 页。
- 成片失败不丢失另一版。旧正文的待执行记录不用于新稿，修改正文后应从新版本开始制作。
- 已完成的成片和包装优先复用。`下载并准备发布` 用于旧项目补齐发布材料；单独修复旧封面不会自动授权发表旧作品。
- 已接受的两版制作会自动准备标题与封面，分别发表；不再暴露第二个“自动下载文章”开关。
- 发表中的 `submitted` 为平台审核中，`published` 为公开成功，旧 `saved` 仅为草稿。列表按当前稿件两版各自回执汇总，不能一版发表就显示两版全部完成。
- 发布结果未知时保留 attempt/checkpoint，只读核对，不重置、不重传、不再次点发表。失败可从原任务恢复。服务退出会等待当前调度步骤结束。

手动补发请求（正常制作由后端自动调用）：

```json
{
  "sourceIds": [123],
  "targets": ["baijiahao-video"],
  "mode": "publish",
  "videoIds": [456],
  "requestId": "history-output-456"
}
```

发送到 `POST /api/v1/history-scripts/uploads/jobs`。自动发表始终选择单个 videoId；省略 videoIds 时为所选稿件当前各版成片。重试须沿用原 requestId。

## 验证与边界

真实下载：来源 #368，视频 `VprFAzjTTuM`，原标题“秦朝亡了沒人救，漢朝亡了憑什麼還能再活兩百年？”，频道显示名“歷史大觀”。实际下载 715,744,358 字节，FFprobe 识别为 H.264/AAC MP4、720p、5082.383673 秒；API 返回 `downloaded`。证据见 [下载记录](history-youtube-download-20261028.json)。本机已配置 yt-dlp、网络代理与已有浏览器登录；其他机器需配置相应环境。

自动化验证覆盖：YouTube 链接/频道及下载恢复、来源链路、原标题关键词保留、双版独立保存、第一版先发表/第二版后发、重复重试不再发表、旧库不回填、过期稿件不派发、单分支失败隔离、远端完成后导出入队失败恢复、标题/封面及页面状态。平台执行器使用隔离的浏览器夹具验证直接发表与回执处理；实际平台列表做过只读检查。

本轮主要回归：后台整合 281 项、来源 109 项、标题/封面 155 项、平台后台 140 项、平台前端 151 项、Python 执行器 106 项、制作页面 115 项通过；最终调度回归 `history-video-workflow.test.ts` 的 7 项通过，包含本轮新增的导出入队恢复及单条状态异常隔离。制作页新增的双版预览用例单独复跑通过。这些数量有重叠，不应相加视为独立测试总量。后端 TypeScript 检查、三个相关 skill 的格式与文档链接检查均通过。

本地运行服务核验：来源 #368 API 返回真实 YouTube 标题和 `downloaded`；视频 Range 请求返回 HTTP 206、正确文件总长度和 MP4 头；其 production 列表为空，证明验证未启动长稿制作。实际 `/history-scripts` 页面加载 281 条稿件、显示 #368 和 YouTube 采集选项，页面无 JavaScript 异常；账号运行检查返回百家号已登录。截图保存为 `/tmp/history-workflow-live.png`、`/tmp/history-youtube-live-dialog.png`，双版成片桌面/手机截图在 `/tmp/history-delivery-ui-v2/`。

本轮没有选择旧作品做真实公共试发，也没有生成新的两版完整影片；不能据此宣称实际作品已经公开或已通过平台审核。已验证的是页面、持久化队列、服务连接及发表执行行为。新作品的最终平台结果以实际回执为准，账号验证或平台审核仍会影响进度。

上游直接发表依据：[dreammis/social-auto-upload 的百家号执行器](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/uploader/baijiahao_uploader/main.py#L553)。

## 主要修改位置

后端：`history-source-youtube.ts`、`history-video-deliveries.ts`、`history-video-workflow.ts`、`history-video-publication.ts`、`history-title-source.ts`，以及 source pipeline、Huasheng、delivery、motion delivery、social upload 的现有服务和路由。

前端：`history-scripts.vue`、`HistoryHuasheng.vue`、`HistoryMotion.vue`、`HistoryScriptDelivery.vue`、`HistorySocialUpload.vue` 与对应测试。

技能：`history-video-publish`、`publish-baijiahao`、`remotion-history-factory`。复用现有工作台和工厂，没有增加第二套制作页面。
