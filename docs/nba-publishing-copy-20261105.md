# NBA 发布描述更新

## 结果

新发布描述参考 CBA 的比赛日期和新闻事件写法，保留中文译稿中的人物、数据或事件，按空间补入双方及比分。

本次原作品描述已从：

> 东契奇砍下42分13助攻，湖人击败热火 #NBA#

修改为：

> 2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#

实际执行原作品 `online_modify=1` 修改，平台 `/pcui/article/publish` 返回 HTTP 200、`errno:0`。重新打开原编辑页读回了完整新描述和真实 `#NBA#` 标签；内容列表的同一作品记录也包含完整新描述，状态为 `published`。横竖封面通过原像素检查，成片、账号、原上传 payload 和作品 ID 保留。

- 任务：`nba-b58390cfe063609a0a5b`。
- 上传：`nba-upload-6b980d456f1e9a847c19692b5f4488e7440196eae9612324`。
- 作品：`1880972395803279815`。
- 成片 SHA256：`c8cfb1005408520566597c2a122bb37ba098f89781ac8d3bdae644347bd7cdbc`。
- 新描述长度：43 UTF-16 单位，包含话题。

工作台：<http://localhost:3013/nba-video?job=nba-b58390cfe063609a0a5b>。

## 规则与兼容

- 仅使用比赛当地日期；缺少有效比赛日期时不取文章或采集日期补位。
- 适当压缩“砍下42分”等标题措辞，完整保留球星数据、首发、连胜等信息。
- 按平台 50 UTF-16 单位预算保留完整分句或比赛信息；引语不拆开后拼接比分，已有日期和话题不重复追加。
- 新任务使用 `publicationCopy` 绑定描述与不可变上传清单。旧上传仍按原描述恢复；同账号同成片已有发表回执时复用，不因描述规则变化新建上传。
- 原作品修订单独保存在 `publishedDescriptionRevision`，原 payload 保留。工作台展示已核验修订；尚未上传的任务展示预计发布描述。
- 原作品编辑器同时显示话题计数 `1/10` 和字数计数。项目适配器现区分两者，并继续检查控件属性和“最多N字”等明确上限，避免把已添加话题作品的描述误判为最多10字。
- 必选话题查询不再因为前一次查询残留的“暂无话题”而提前退出。真实诊断发现旧逻辑在搜索请求发出前就清理输入；修复后实际收到了平台 `/pcui/pcpublisher/searchtopic` 的 `NBA` 候选，并读回精确 `#NBA#` 标签。始终保留原10秒边界和精确话题校验。

## 验证

- 后端文案、上传、工作流和路由测试 63 项通过；后端 `npm run typecheck` 通过。
- 前端控制器与模板编译测试 33 项通过。
- Python 文案、话题和原草稿发表回归 42 项通过，包含已有话题、真实字符限长和过期空列表后的新查询。
- Playwright 在 1440×1000 和 390×844 读回完整描述，无横向溢出或页面脚本错误；原作品没有再次发表按钮。
- 证据：`/tmp/nba-description-20261105/published-description-revision.json`、`description-verified.png`、`workspace-report.json`、桌面与手机截图。
- 原上传检查点的 `published-description-revisions/` 保存独立修订回执。

## 运行中批次恢复

实现期间用户从工作台启动 `nba-run-71cece07-16e1-4fea-ab15-06740daa5779`，本次等待其完成后更新独立 NBA 服务，未重启主后端。该轮四条成片中一条先提交成功，另一条因必选话题查询提前退出而阻断后续上传。

修复后仅继续此轮剩余三条，恢复运行 `nba-run-e213ca58-51a3-4a1e-a61e-f8c3dfd03bd6` 已完成，三条都取得 `submitted` 回执，等待平台审核，不能称为已公开发表。

| 任务 | 平台作品 ID | 结果 |
| --- | --- | --- |
| `nba-2cd50a9b698b96509b7a` | `1880979921733595776` | 沿用原上传 `nba-upload-b039110e1665b3f78c29955521c936c13913016db56cf425`，未重新上传视频；保留已经派发的旧文案 |
| `nba-4344d0c37be0dbbef1c6` | `1880980012735612815` | 自动使用比赛日期、东契奇42分13助攻和湖人138-117热火的新描述 |
| `nba-3cda95345ae6d1d38daa` | `1880980119641878886` | 自动使用比赛日期、湖人138比117热火和东契奇42分的新描述 |

三条均选择真实 `#NBA#`，工作台均显示已提交，禁止再次发表相同成片。证据：`/tmp/nba-description-20261105/topic-diagnostic.json`、`batch-recovery-report.json` 以及各原上传检查点。

## 主要文件

- `backend/src/services/nba-publishing-copy.ts`、`nba-publishing-copy.test.ts`：描述生成及边界覆盖。
- `backend/src/services/nba-news.ts`：复用球队中文简称。
- `backend/src/services/nba-upload.ts`、`nba-upload.test.ts`：新描述绑定和历史身份恢复。
- `backend/src/services/nba-types.ts`、`nba-video.ts`、`nba-video.test.ts`：独立修订回执与安全展示。
- `backend/scripts/social-auto-upload/editor_compat.py`、`test_baijiahao_metadata.py`：描述与话题计数分离。
- `backend/scripts/social-auto-upload/baijiahao_topics.py`、`test_baijiahao_topics.py`：必选话题等待当前查询与空列表回归。
- `frontend/app/pages/nba-video.vue`、`frontend/tests/nba-video-controller.test.mjs`：发布描述展示。
- `docs/nba-video-workflow.md`、`scripts/nba-video/README.md`：当前规则。
