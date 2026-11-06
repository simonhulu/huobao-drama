# 历史稿件继续生产

`/history-scripts` 的稿件详情统一提供“继续生产”。该操作创建持久化任务 `history.production.continue`，复用现有采集、花生和 Remotion 生产体系。

| 当前情况 | 行为 |
| --- | --- |
| 只有来源或已下载视频 | 从缺失的转录、校对、二创检查点继续 |
| 有当前有效二创稿 | 复用正文，补齐或继续两版视频 |
| 正在处理 | 复用当前任务并显示进度，不重复入队 |
| 花生创建结果不明 | 同步现有项目，完整原稿与时间证据唯一匹配后关联原项目 |
| 花生同步失败或无法唯一确认 | 显示核对原因，精细化版仍可继续 |
| 所需视频已交付但材料或发表未完成 | 只补齐对应版本的材料与发表，不重复制作 |
| 所需视频均有提交回执 | 显示“全部已提交”，查看审核与发表结果 |
| 编辑器有未保存修改或版本冲突 | 保存或刷新后再继续 |

“源视频已下载”表示文字步骤可能仍缺失。“二创稿已就绪”表示可制作，不要求额外人工审批。源任务仍持有有效文件锁时等待；仅由现有死进程检查释放失效锁。

## 接口

- `POST /api/v1/history-scripts/:id/continue`：可传 `expectedRevision`，返回 `{task, created, complete, message}`。
- `GET /api/v1/history-scripts/:id/continuation`：读取最新续作任务及所需版本的提交完成状态。
- 原花生状态检查接口保留，界面称为“同步花生状态”。包括没有项目链接的 `create_pending` 任务；同步本身不创建、确认、导出或恢复制作。

`complete` 表示当前稿件所需的视频版本均取得有效百家号提交回执，可能仍在审核。
只有平台明确确认发表才算“已发表”。素材就绪、导出入队、旧完成标记、保存草稿和人工标记
都不能满足 `complete`。续作任务成功表示已衔接对应步骤，最终进度和回执仍看各版本。
网页同步与队列重试均保留原任务和有效产物。详见 [生产闭环](history-production-closed-loop.md)。

花生项目发现有请求时间、项目数量与详情查询预算；列表不完整、多个匹配或服务不可用时不猜测关联，不以同步替代重新创建。

## 核验

服务和路由测试使用隔离数据库及替身生产服务；前端测试拦截 API，覆盖缺稿续作、有效稿复用、重复点击、版本冲突和花生待核对。测试不会启动或发布真实稿件。实际部署后只读取真实稿件的续作状态核验接口。

2026-10-30 验证结果：158 项后端相关测试、5 项隔离 Playwright 测试、后端类型检查和前端构建通过。Impeccable 检查无发现，1440px 与 390px 模拟页面无按钮重叠。后端服务已更新；经 3013 页面代理读取 368 的续作接口成功，真实页面显示可用的“继续生产”，无页面运行错误。365 此前已有删除时间，接口按预期返回 404，未恢复该记录。两者均未创建真实续作任务。

部署时，原 YouTube 持续采集任务 40326 已连续收到平台限流错误；通过原停止接口结束本轮请求后更新服务，已存来源和检查点保留。平台限流不属于本次续作入口修复范围。

## 修改位置

- 页面：`frontend/app/pages/history-scripts.vue`、`frontend/app/components/HistoryHuasheng.vue`、`frontend/app/composables/useApi.ts`。
- 持久续作与接口：`backend/src/services/history-production-continuation.ts`、`backend/src/routes/history-production-continuation.ts`。
- 花生同步：`backend/src/services/history-huasheng.ts`、`backend/src/services/history-huasheng-discovery.ts`。
- 两版流程与队列：`backend/src/services/history-video-workflow.ts`、`backend/src/services/tasks/types.ts`、`backend/src/services/tasks/worker.ts`；显式正文冲突不可自动重试。
- 注册：`backend/src/index.ts`、`backend/src/routes/history-scripts.ts`、`backend/scripts/history-sources/run.ts`。
- 工厂规则：`.codex/skills/remotion-history-factory/SKILL.md`；新增对应服务、路由、页面测试并补充现有相关测试。
