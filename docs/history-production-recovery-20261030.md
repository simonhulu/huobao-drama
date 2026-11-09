# 历史制作队列自动恢复

> 2026-11-09 原开发机（用户 `zhangshijie`）状态更新：主后端 `com.huobao-drama.backend` 与独立导出 worker `cn.huobao.history-huasheng-export` 已停止并禁用登录自启，配置、任务和产物保留。该机需要时在 `backend/` 执行 `npm run start`。107 的正式部署沿用自身启动器和配置。下文记录的是 2026-10-30 当时的部署与验证；当前花生状态查询及两台机器的启动方式见 [花生自动制作](history-huasheng-automation.md)。

## 本次修复

第 1109 集显示“服务重启中断制作”，来自工厂构造时把所有中断中的工作标为失败。网页重试只恢复内部任务，外层双版本流程仍可能停在旧的 failed 状态。素材和渲染共用串行 Promise，长时间渲染期间后续任务无法准备画面。后端原先没有系统进程守护。

- 工厂启动后及每 5 秒检查已接纳的任务，从原任务、原母带、分镜和已完成画面继续。恢复查询不受列表最新 100 条的限制。
- 502、503、429、网络超时、上游账号暂不可用等故障持久化重试时间；普通故障 30 秒起，递增至最多 10 分钟，等待图片任务时 5 秒续查。退避期间释放执行槽位。
- 同时最多准备两个任务，整片渲染独占。失败任务与恢复异常不阻断其他任务。
- 渲染设置 3 小时总上限和 15 分钟无日志进展的检查；超时结束本轮进程及其子进程，保留素材后重试。可用 `HISTORY_MOTION_RENDER_TIMEOUT_MS` 调整总上限。
- 外层双版本流程继续追踪原先失败但已经重试或完成的任务；失败记录每 60 秒核对，不重新创建作品。轮转检查避免前 50 条长期工作遮住后续稿件。
- 执行前核对当前正文和工厂任务 ID。删除、被新版本替代、正文失效的工作不会自动复活。确定性的内容或配置问题隔离在原任务。
- 成功监听后才启动工作器，避免第二个后端尚未抢到端口就重复执行制作。

## 本机服务

已安装并启动用户级 launchd 服务：

- `~/Library/LaunchAgents/com.huobao-drama.backend.plist`：稳定后端，不监听代码变更；退出后自动拉起，10 秒节流；使用现有 `.env`。`caffeinate -i` 阻止运行期间的空闲睡眠。
- `~/Library/LaunchAgents/com.huobao-drama.frontend.plist`：3013 页面服务，退出后自动拉起。
- 日志：`.logs/backend-service.log`、`.logs/frontend-service.log`。

查看服务：`launchctl list | rg com.huobao-drama`。计划更新时先停服务并等待退出，再加载新代码；不要同时另起一个 5679 后端。

这是登录用户级服务，不能在关机、断电或用户退出后继续运行。上游长时间不可用时将退避重试，不能保证仍有成片产出。尚未完成整整 24 小时的持续运行验证。

## 验证证据

2026-10-30 12:21 至 12:22（北京时间），实际强制结束生产后端 PID 18760。launchd 自动启动新后端 PID 21648，5679 恢复监听，3013 代理接口返回 200。没有人工点击任务重试。

重启前后核对以下 9 个原任务：1072、1073、1074、1097、1108、1109、1112、1113、1114。

- 9 个任务 ID 均保持不变，已有画面键全部保留。
- 本次快照中有 `plan.audioPath` 的 8 个任务，重启前后母带 SHA-256 均相同。1113 仍在配音对齐步骤，没有该字段，其独立配音缓存未纳入本次哈希核对。
- 重启前画面数分别为 24、4、20、83、131、0、0、0、56；恢复时未减少。
- 1072/1073 首次恢复后画面实际增长；强制终止恢复后 1074/1097 继续选片补图，1109 留在原队列等待执行。这不代表 1109 已经完成。
- 1102、1103、1105、1106、1111 的删除标记保持原样，没有自动恢复这些已删除工作。
- 首次受控更新保留了 1108 的全部 131 个画面及配音，旧的未完成渲染进程树已结束；渲染帧本身不能从断点恢复，需要重新合成。

以下隔离测试共 103 项通过，覆盖重启恢复、退避持久化、失败隔离、并发、原稿锁定、素材去重、交付重用和双版本状态恢复：

```sh
cd backend
/opt/homebrew/bin/node --import tsx --test \
  src/services/history-factory.test.ts \
  src/services/history-motion-production.test.ts \
  src/services/history-motion-unique-assets.test.ts \
  src/services/history-motion-image-checkpoint.test.ts \
  src/services/history-video-workflow.test.ts \
  src/startup-imports.test.ts
```

全量 TypeScript 检查初次通过。最终检查时，其他并行修改产生了 `cover-design-extractor.ts` 的字段索引类型错误，以及 `science-workflow.ts` 所引用的 `updateSocialUploadVideoCovers` 缺失错误；本次未修改这些模块。不能把这次结果表述为最终全仓类型检查通过。

本轮修改的实现位于 `backend/src/services/history-factory.ts`、`history-motion-production.ts`、`history-motion-pipeline.ts`、`history-video-workflow.ts` 和 `backend/src/index.ts`，并更新对应回归测试。没有改动正文、默认音色、封面规则或发布策略。
