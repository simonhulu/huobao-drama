# 花生临时空白页修复记录

## 已确认的问题

- `about:blank#huobao-huasheng-<UUID>` 是读取花生会话时创建的临时页。用户提供的标记曾出现在科普账号专用 Chrome（端口 9250）。
- Chrome 已创建页面、但 `Target.createTarget` 超时未返回编号时，原实现无法关闭该页面。
- 原连接失效、关闭请求抛错或返回 `success:false` 时，旧清理逻辑会忽略失败，后续重试可能继续留下空白页。
- 以上故障已通过测试复现；旧任务日志没有保留底层异常，无法确定原故障具体卡在哪一个 CDP 命令。

## 修复范围

- 临时页后台创建，创建前保存唯一标记；请求结果不明时按完整标记查找所属页面。
- 清理失败时新建 CDP 会话关闭同一目标，兼容页面延迟可见、取消请求和页面初始化失败。
- 关闭操作共享成功结果；清理失败允许再次尝试。获取页面列表失败不能被报告为清理成功。
- 导出流程和项目检查统一使用所属目标清理，底层异常保留为 `cause`。
- 不按通用 `about:blank` 或域名批量关闭页面。

涉及文件：

- `backend/src/services/history-huasheng-browser.ts`
- `backend/src/services/history-huasheng-export-api.ts`
- `backend/src/services/history-huasheng-connection.test.ts`

## 验证

在 `backend` 目录执行：

```sh
TASK_WORKER_DISABLED=1 node run-tsx.mjs --test src/services/history-huasheng-connection.test.ts src/services/history-huasheng-export-api.test.ts src/services/science-workflow.test.ts
npm run typecheck
```

101 项测试全部通过，包含真实本地 Chromium 生命周期测试；类型检查和 `git diff --check` 通过。

实际科普账号执行只读会话读取成功，测试前后标记空白页均为 0。曾观察到的旧空白页在专项清理执行前已消失，不能将其消失归因于该清理命令。

## 原任务恢复

- 任务：`science-79732d80-f568-43ce-bd5f-853fb4c7c4d8`
- 标题：《仙人掌为何生命力强，火龙果真是它结的吗？》
- 原项目：`https://www.huasheng.cn/video/265869573914784`
- 恢复方式：继续原任务，保留自动上传设置，没有重建项目。
- 导出回执：`p7dadbce5c516bd1748836e638a3afac8f70c7070233c3ab415f25b09e0eea377`
- 2026-10-31 07:10（北京时间）：成片已下载，83,914,150 字节，进入第 1 版横竖标题海报生成。此时尚未确认封面或上传完成。

为避免中断其他生产，未重启后端。通过本地临时 Node 调试连接，将仅包含上述两个服务的构建加载至现有科普工作流的 `exportApi`；原错误类型和其他服务实例保留。正常重启后使用修改后的源代码。生成的临时构建位于 `backend/node_modules/.cache/huasheng-page-recovery-20261031.mjs`，不作为源代码维护。
