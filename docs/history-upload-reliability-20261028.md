# 历史视频百家号上传：真实任务证据审计（2026-10-28）

审计快照：2026-10-28 12:10 UTC（北京时间 20:10）。范围仅为上传任务 **168、169、170、171、172、173**，不是同号稿件或 Episode。通过只读 SQLite 查询、原任务检查点、实现代码和本地封面核对；没有连接平台浏览器、触发核对/重试、发帖、重启服务或修改生产记录。

这六项当前可证明的结果是：**1 项已发布、2 项已提交审核、3 项发表结果未知**。后两种状态都不能写成“已发布”。

## 真实结果与证据位置

所有任务均为历史专用账号 `history_baijiahao`、百家号视频、精细化成片 `motion`。数据库旧字段 `mode=draft` 是兼容存储；实际模式由 `publication_mode=publish` 与 payload 的 `publicationMode=publish` 决定，不表示这些任务在存草稿。

用户在 Remotion 看到的制作编号与上传编号不同：**Episode 1062 → 上传任务 168 → 稿件 62；Episode 1064 → 上传任务 169 → 稿件 119；Episode 1066 → 上传任务 171 → 稿件 118**。排查这三项时应沿此映射打开原任务，不要用 Episode 编号查询上传队列。

| 上传任务 | 稿件 | 成片 ID | 检查点阶段 | 能证明的结果 | 平台作品 ID | 最近平台凭证时间（UTC） |
| --- | --- | --- | --- | --- | --- | --- |
| 168 | 62 | 1 | `publish_requested` | 已记录点击，结果未知 | 缺失 | 缺失 |
| 169 | 119 | 2 | `publish_requested` | 已记录点击，结果未知 | 缺失 | 缺失 |
| 171 | 118 | 4 | `publish_requested` | 已记录点击，结果未知 | 缺失 | 缺失 |
| 170 | 141 | 3 | `published` | 平台记录为 `publish` | `1880286006679847837` | 09:50:34.722 |
| 172 | 80 | 5 | `submitted` | 平台记录为 `analyze`／审核中 | `1880286631817022032` | 09:51:13.526 |
| 173 | 131 | 6 | `submitted` | 平台记录为 `analyze`／审核中 | `1880286498131959014` | 09:49:06.548 |

任务 168、169、171 的数据库最后更新时间分别为 09:05:05、09:07:00、09:18:05 UTC。审计时未取得此后的新平台凭证，不据旧记录推断平台现在是否已发布。

原始本地证据：

- [168 检查点](../data/social-auto-upload/jobs/168/state.json)、[169 检查点](../data/social-auto-upload/jobs/169/state.json)、[171 检查点](../data/social-auto-upload/jobs/171/state.json)：每项只有检查点与 `staged.png`。
- [170 检查点](../data/social-auto-upload/jobs/170/state.json)、[发表记录截图](../data/social-auto-upload/jobs/170/publication.png)。
- [172 检查点](../data/social-auto-upload/jobs/172/state.json)、[提交记录截图](../data/social-auto-upload/jobs/172/publication.png)。
- [173 检查点](../data/social-auto-upload/jobs/173/state.json)、[提交记录截图](../data/social-auto-upload/jobs/173/publication.png)。

这些路径是本机私有产物，不应将检查点、账号文件或原始网络日志作为公开附件。本文没有复制 Cookie、密钥、凭据摘要或浏览器文档令牌。

## 旧任务与成功任务的结构化差异

| 证据 | 168／169／171 | 170／172 | 173 |
| --- | --- | --- | --- |
| 原 payload、账号、页面绑定及文件 SHA256 | 有 | 有 | 有 |
| 视频、文案、两张封面上传完成记录 | 有 | 有 | 有 |
| `publishAttemptedAt`、`publishClickedAt` | 有 | 有 | 有 |
| 当前 `publicationRequestCount` | **字段缺失** | `1` | `1` |
| 当前 `publicationResponses` | **字段缺失** | 发布接口 HTTP 200、`errno=0` | 发布接口 HTTP 200、`errno=0` |
| 当前 `publicationNotices` | **字段缺失** | 空数组 | 空数组 |
| 创作声明选择的持久化记录 | 缺失 | `含AI生成内容`、已核验 | `含AI生成内容`、已核验 |
| 历史表单拒绝证据 | 缺失 | 保存在 `publicationAttempts` | 无拒绝记录 |
| 唯一作品 ID、完整平台记录、时长核验 | 缺失 | 有 | 有 |
| 真实平台状态截图 | 缺失 | 有 | 有 |

本轮此前已核对 168–172 的 15 个输入文件，本次补核 173 的 3 个输入文件：视频与横竖封面共 **18/18** 的当前 SHA256 与原检查点一致。这只证明原文件未被替换，不证明画面、历史叙述或封面文案正确。

170／172／173 的平台凭证分别记录本地时长 778.603／179.500／204.864 秒，平台时长 779／180／204 秒；均在当前允许的 1 秒差值内。170 的平台 `updated_at` 晚于提交时间，匹配使用同条记录的 `created_at`，不会把审核后的公开时间当作第一次上传时间。

## 根因与不能作出的推断

### 已有直接证据：平台必填创作声明曾阻断发表

170、172 的原尝试均捕获了“请选择创作声明类型”，并保留空的发布响应列表。后续在原编辑页选择“含AI生成内容”，保留前次记录到 `publicationAttempts`，再取得一次发布请求与成功业务响应，最后由平台作品记录确认结果。173 在发表前完成该字段，直接取得提交回执。

但 170、172 的**历史 attempt 未保存当次 `publicationRequestCount`**。这两份历史记录证明曾出现必填项拒绝提示，不能追溯声称当时已有完整“零网络请求”证明。审计时的新版代码已收紧恢复条件：必须同时有明确 `requestCount=0`、空响应、精确拒绝提示和原页绑定，才允许补字段后继续；缺字段不能自动当作零。

相关实现：[bridge.py](../backend/scripts/social-auto-upload/bridge.py) 的 `publication_preflight`、`ensure_history_creation_declaration`、`missing_creation_declaration_rejection`、`repair_creation_declaration_rejection`。

### 已有直接证据：旧三项缺少决定恢复方式所需的观测

168、169、171 只记录点击意图、点击时间和导航超时。没有保留实际请求是否发出、响应是否拒绝、瞬时表单提示或唯一平台作品 ID。168／169 后续列表读取失败，171 列表未匹配当前类型、完整标题和提交时间。

因此，导航超时不能代表“发表失败”；缺少请求字段不能代表“没有发送请求”；列表没有匹配不能代表“平台绝对没有作品”。也不能把 170／172 的创作声明原因直接套用到旧三项。它们必须保留原任务，通过只读核对取得新的证据，不能删除检查点后重新上传或补点发表。

### 当前实现已补充观测，但不等于旧任务得到新证据

`publish_video` 在点击前持久化意图，监听实际 `/pcui/article/publish` 的请求、业务响应与提示，并保存 `publicationObservation`。分类为 `unknown`、`no_request_validation`、`server_rejected` 或 `accepted`。HTTP 成功但没有明确业务成功码仍是未知；请求发出却无响应也仍是未知。

`accepted` 只描述提交响应，不直接证明已公开。成功仍须匹配平台视频记录、完整标题、创建时间、唯一 ID、原文件指纹及视频时长。平台列表短暂未收录时，当前代码只在已有明确成功响应且第一次扫描完整无匹配的条件下，再读一次列表；不会再次点发表。

上述新字段在六个已存样本中尚未回填。当前代码存在这些能力，不代表旧样本已经经过新版执行或真实平台验证。

## 审计发现与收口

| 问题 | 快照证据与影响 | 处理方向与进展 |
| --- | --- | --- |
| 失败列表诊断不完整 | 原实现最终异常只保存 `publicationError`；最后一次失败扫描的 outcome、页数、条数、时间可能未保存。旧三项没有 `publicationCheck` | 本轮 Python 已补 `record_check`，白名单保存扫描诊断与 `checkedAt`；旧记录未追溯改写 |
| 成功后残留旧错误 | 170 已有 `phase=published` 和完整回执，顶层仍有旧 `publicationError`；数据库 error 已清空 | 本轮 Python 已在新核对成功时清除当前 `publicationError`；旧样本原样保留 |
| 本地轮询看似恢复 | 三个失败 intent 的 `updated_at` 持续刷新、`attempts=0`，但上传任务及平台检查时间停在 09:xx | 不把 intent 的轮询时间解释为平台核对时间；显示最后真实检查时间与当前待处理动作 |
| 审核状态不会自动更新 | 172／173 已被记录为 DB `completed`；intent worker 不再选中，`service.reconcile()` 对 completed 直接返回 | 如需追踪审核结果，按已有作品 ID 低频只读刷新；保留提交回执并严格禁止重传/重发 |

当前 `history-video-publication.ts` 的 failed 分支只观察原上传任务的数据库结果，每 30 秒更新 intent；没有调用平台核对。`attempts` 只在该 worker 抛出异常时增加，并不是发表按钮点击次数。上传任务自身的 `recovery_attempts=0`、`next_attempt_at=null`、`recovery_action=null` 也不表示正在恢复。

“提交任务完成”与“平台审核通过”已有明确字段区分：`history-social-upload.ts` 在 `submitted=true` 时结束执行；[路由映射](../backend/src/routes/history-social-upload.ts) 根据 `published` 将外部状态映射为 `submitted` 或 `published`。这不是把审核中谎报为已发布，但其平台状态是最后一次回读的快照。

## 本轮防重复交叉审阅与加载边界

只读交叉审阅确认，TS 恢复分支已经拦截“已派发却缺检查点”返回的新上传建议；旧 `uncertain` 即使缺少派发和结果字段，也转为原任务恢复。结果落库检查原账号和 `targetId`，恢复使用原 payload。Python 的受限重查只读取作品列表，不调用发表按钮；缺少明确零请求证据不能走创作声明修复。

另发现并由 TS 执行者修复了一个可证实的取消旁路：原未知发表任务重试后成为 `queued/recover`，旧 `cancel()` 可将它取消，而 `enqueue()` 又排除 canceled，从而可能给同一成片建立新上传任务。现在取消条件排除已有派发、结果或 recover 操作的发表任务；历史 canceled 记录只要有这些尝试证据，重新入队也复用原记录，不新建上传、不改写原 payload/结果。旧 canceled 状态暂不自动迁移，以避免与旧快照索引冲突。TS 执行者报告此前相关套件 **140/140** 通过，取消边界先复现失败，修复后新增定向回归 **12/12** 与类型检查通过。

最后一次交叉读回发现并修复了相同证据口径的恢复分支：`queued/recover` 即使派发标志与结果都缺失，也不能因桥检查点缺失而开始新上传。现在 `recoverPublication` 的拦截同时覆盖 `operation=recover`；精确复现该状态的用例要求保留原任务为 uncertain，上传与发表调用均为零。执行者报告最后相关定向回归 **4/4** 与类型检查通过。对本轮的缺失证据、防重复、受限只读重查与原账号/目标保留范围，最终只读交叉审阅无其他未解决发现。

桥端另有一项缺失证据边界已经修复：旧 `reset-attempt` 只看 `publishAttemptedAt`，在 `publish_requested` 阶段丢失该字段时仍可能归档原记录。现在 `publish_requested/submitted/published` 阶段即使缺失或为零的时间戳也禁止清理/重传；结构为 null、列表、空对象或未知阶段的发表检查点同样被拒绝。有效的已完成回执仍可正常复用。当前网页 TS 路径本已避免对发表任务调用草稿 reset，本轮进一步收紧桥端自身边界。

Python 执行者报告：首次相关回归 **40/40** 通过，后续诊断/显式计数/清除旧错误的定向回归 **5/5** 通过，最后损坏 reset 边界及正常完成恢复的定向回归 **3/3** 通过，4 个文件编译检查通过。以上是分批验证结果，不合并宣称为一次完整套件运行。

主执行者还复现并修复了前端误导：`publish/uncertain` 曾显示“未能保存到草稿箱，请重新上传”，现改为保留实际技术错误与“继续原任务”，批量入口为“批量继续任务”；已排队的原发表恢复任务也不再提供取消入口。其报告前端完整组件回归 **152/152** 与构建通过，取消入口的后续定向回归 **2/2** 通过，真实页面检查未出现脚本错误；本审计未重复运行这些测试。

真实页面证据：[桌面原任务 168](../data/reports/history-upload-reliability-20261028.png)、[390px 手机宽度原任务 168](../data/reports/history-upload-reliability-mobile-20261028.png)。主执行者实际检查无页面脚本错误、无横向溢出；本审计确认两个证据文件存在。

本轮主要实现与回归文件：

- [history-social-upload.ts](../backend/src/services/history-social-upload.ts)、[队列回归](../backend/src/services/history-social-upload.test.ts)：原任务恢复、缺检查点拦截、取消边界与账号/目标保留。
- [history-video-publication.ts](../backend/src/services/history-video-publication.ts)、[生产与发表回归](../backend/src/services/history-video-workflow.test.ts)：发表意图只接受原上传任务的提交回执。
- [bridge.py](../backend/scripts/social-auto-upload/bridge.py)、[发表回归](../backend/scripts/social-auto-upload/test_publication.py)：请求观测、声明修复、受限只读重查、诊断持久化与损坏记录保护。
- [HistorySocialUpload.vue](../frontend/app/components/HistorySocialUpload.vue)：原任务状态、恢复操作与取消入口。

加载边界必须明确：Python 桥在下一次调用时加载修改；TS 后端安全边界需等当前生产任务结束后安全重启才生效。审计期间后台仍有成片渲染，未重启后端。代码通过或前端构建完成不代表运行中的旧 TS 进程已经更新，更不代表旧三项已取得新的平台结果。

## 与上传技术成功独立的真实包装错误

任务 172／稿件 80 的已提交标题是“授衔时徐海东为何沉默 周恩来只提粟裕”，源标题也以徐海东为主角；实际上传的 [16:9 封面](../data/static/history-deliveries/80/95d09f7f-2dc0-4bbd-bd8b-edc797a1f556/16x9.png) 经直接查看，主标题却写“陈赓授衔时为何大将军衔让他发呆”。

这是人物名称不一致的具体问题。文件 SHA 一致、上传成功、平台受理均不能排除此类错误。本审计未修改已提交作品或旧封面；处理该问题应保留现有作品 ID 与历史记录，不能通过重新发表来伪装修正。

## 验证范围

- 本文结论来自上述六项定向 SQL 查询、检查点、已保存的服务器记录、文件哈希和一张实际封面；没有重新回读平台，因此不宣称平台在审计时的最新审核结果。
- 已查看 [test_publication.py](../backend/scripts/social-auto-upload/test_publication.py) 中请求分类、创作声明、未知结果禁止重发、短暂收录延迟、审核中状态、错误媒体/时长与审核时间变化的回归场景。测试定义存在不等于测试已通过；本文不代替执行者的测试运行结果。
- 文档只陈述这六项证据，不以局部成功推断整批作品全部完成。未进行全片回看、逐镜内容审核或历史事实审阅。
- [现行历史流程](history-workflow-upgrade-20261028.md) 已要求两版分别直接发表；旧草稿文档中的流程不能覆盖该要求。本文仅补充本次真实任务与可靠性证据。
