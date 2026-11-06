# 统一执行与恢复

网页、agent 和历史兼容入口共用 `backend/src/services/history-factory.ts` 的 `getHistoryFactory()`。内部继续使用已有 `history-motion-pipeline.ts`，不再复制素材处理、TTS、渲染和交付流程。接口由 `routes/history-factory.ts` 挂到 `/api/v1/remotion`。

## 常用操作

| 场景 | 接口/动作 |
| --- | --- |
| 查看制作列表 | `GET /api/v1/remotion/history-productions`，返回 `data.items` |
| 已保存历史稿开始制作 | `POST /api/v1/remotion/history-productions`，`{sourceId,scriptRevision?,profile?:"16:9"\|"9:16"}` |
| 进入本集详情 | `GET /api/v1/remotion/episodes/:episodeId/history-production` |
| 已有 Episode 开始制作 | `POST /api/v1/remotion/episodes/:episodeId/history-production/start`，`{profile?}` |
| 失败后继续 | `POST /api/v1/remotion/episodes/:episodeId/history-production/retry`，`{profile?}` |
| 下载任务编辑记录快照 | `GET /api/v1/remotion/episodes/:episodeId/history-production/evidence` |

历史稿入口传当前 `scriptRevision` 可拒绝过时页面。不要自己发明 revision：它是后端当前来源快照摘要；正文哈希和来源 revision 是不同字段。查看/开始/重试返回的详情含 `episode`、`job`、`shots`、`outputs`、`sourceId`、`links`、`url`。使用返回的 `url` 进入 `/remotion/episode/<真实 ID>`，不要把 drama 的集序号当 ID。

未有任务的 Episode 仍可查看原稿、配音、分镜和旧成片；启动后才出现新制作进度。旧成片存在不等于本轮重制已经完成。`outputs` 保留本集已有输出；新输出在 Remotion renders 登记，Episode 已有 `videoUrl` 时保留它。

## 固定输入与复用

历史稿创建或复用当前 revision、画幅对应任务，并建立 Episode/Remotion 关联。已有 Episode 采用 `scriptContent || content` 的确认正文；已有分镜的 narration 顺序完整覆盖正文时复用分镜，缺失或不一致则从正文确定性拆分。自动导演只补表达信息。`rewrittenScript` 一旦保存即是本轮唯一旁白来源，必须逐字保持；不得在制作、字幕、重试或交付步骤改写正文。

已有 `preTtsAudioUrl` 与 `preTtsTitlesJson` 通过本地媒体可读性、时长和正文匹配检查后写入配音缓存，不再生成 TTS。时间码缺失并不等于识别过音频全文；报告须标明估算。母带和已给时间码与正文冲突时显示具体错误，不能默默重配音掩盖版本问题。

新任务的有效设计、`narration.json`、生成图片、地图和视觉计划保存在 `data/storage/history-motion/<jobId>/`。生成的配音登记回 Episode，最终 `movie.mp4` 复制到 `/static/remotion/` 并登记 render；原执行目录和每次 render 目录保留。

每次素材决策遵循 [素材与编辑合同](material-contract.md)。当前优先复用候选视频；缺口先检查匹配分镜的已有图片，再按需生图；地图和信息动画由表达目的选择。每个成片的视频和图片按实际 SHA-256 去重；地图按底图哈希及城市、路线、区域和包围动作共同去重，共用地形底图但内容不同的定位、路线或包围镜头可以并存，单改标题、时长、颜色或运镜不算新内容；图片或地图失败记录可重试 fallback，先复用尚未使用的合法底层媒体，不能以独立信息画面填空，不改旁白。

## 状态与重试

常见阶段是规划、配音、画面、渲染、关联交付。`job.stage/message/error` 是具体进度依据；Episode 和 Remotion project 是该任务的投影，不能另启第二个队列管理同一 `jobId`。

- 运行中或已完成的同输入开始请求复用现有任务，不重复配音/渲染。
- 服务重启会把中断任务标为可重试，保留检查点；页面显示中断原因，用户点击继续即可恢复。
- `stage=rendered` 且已有验收产物时，重试只验证并登记原成片，不重新生成媒体。
- 新正文或新画幅创建新制作版本，旧任务、旧 render 和已有成片保留；正文正在制作时不并行修改版本。
- 失败重试只重新执行缺失或失败的媒体步骤，保留并复用已经成功且哈希已登记的工件；重试不得把同一文件分配给另一个镜头。
- 缺少未使用的视频会自动调用图片服务，无需用户手动补图。图片请求被明确内容审核拒绝时，保留原请求，自动设计一次非暴力的情绪或环境场景并补图；不改旁白、配音和字幕，不通过换词继续要求原先被拒绝的画面。替代提示词保存于 `plan.imageRecoveries`，重试沿用同一图片检查点。未知提交结果不得另起请求；已有任务先恢复轮询，已完成图直接复用。仍然失败时展示自动补图的实际原因，不笼统提示“请补充素材”。
- 历史稿交付的 `attached` 表示本次已关联，`existing_preserved` 表示保留了其他已有交付，`failed` 表示关联未完成。始终从本轮任务/输出读取新成片，不能用旧交付替代本轮产物。

旧 `/api/v1/history-scripts/motion/...` 路由仅承担兼容记录、素材检索和已有操作；新制作走同一个 factory 单例。不要从旧路由另造 runner，或把 `/approve` 当成默认人工关卡。

## 交付记录与核验

磁盘上的 `decisions.json` 保存候选与最终逐镜决定；render 目录保存冻结 `plan.json`、日志、成片及媒体验收 sidecar。`evidence` 下载的是当前任务/逐镜/来源/输出快照，不等于包含所有底层媒体文件的归档。

完整渲染器直接生产完整片、带声精选和回看页，记录输入哈希、字幕时间依据、技术参数、体积及实际引用的声音/地图。对代表片段检查内容错配、文字阅读、原字幕、运动、听感；自动视觉抽检的 90 秒默认任务处理预算不是观看时长，最多两帧的素材观察不能证明历史身份、事件、地点或连续性。实际检查多少就写多少，未连续看听整片不得声称全片审美通过。

专项人物表情、道具动画和已存在精修计划沿用 `videoeditor`。统一自动 composition 目前接入其动态标题，不代表全部表情追踪能力已自动化。只有真实渲染进入最终片的层才算本次完成。
