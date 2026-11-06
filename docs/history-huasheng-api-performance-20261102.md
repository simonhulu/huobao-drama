# 花生任务列表接口性能排查

排查时间：2026-11-02。接口：`GET /api/v1/history-scripts/huasheng`。

## 结论与证据

主要阻塞点是列表读取同步等待浏览器和花生官网身份核验。旧调用链为：

```text
3013 Nuxt 代理 -> 5679 Hono -> overview()
  -> browserStatus()（10 秒进程内缓存）
  -> accounts.check()
  -> 连接专用浏览器、读取 Cookie、请求官网 nav 身份接口
  -> 查询本地任务和统计 -> 返回 JSON
```

`monitoring.enabled=false` 只关闭制作进度自动检查，不会阻止这条账号核验调用链。响应中的 `productionStatus=completed` 也不能跳过账号核验。

| 实测项目 | 结果 |
| --- | --- |
| 原接口，经 localhost:3013 | HTTP 200，总耗时 25.701 秒 |
| 上述请求等待首字节 | 25.699 秒 |
| 响应体 | 27,923 字节，34 条任务 |
| 排查时日志最近 300 次该接口请求 | P50 182 ms，P95 5,435 ms，最长 58,909 ms |
| 生产库只读任务查询 | 49.427 ms，34 条 |
| 生产库只读状态统计 | 0.608 ms |
| 生产库只读制作状态统计 | 0.387 ms |

数据库查询与 HTTP 测量分别执行，不能相减当作精确的单次请求分段追踪。但数据库用时、日志中的快慢交替、调用链和阻塞回归测试共同证明，列表不应该承担远端身份核验的等待。

身份接口在 `backend/src/services/huasheng-identity.ts` 中设定单次 10 秒超时，连接异常或部分 HTTP 错误最多尝试 3 次，另有退避等待。浏览器连接也有独立超时和重试。因此列表延迟可超过 30 秒；这不是列表有 34 条记录所需的正常开销。

前端还有放大因素：原 `deadline()` 只让 `Promise.race` 在 15 秒后报错，不会取消底层 GET；之后每 5 秒的轮询可以继续启动新请求。页面还会用 `v-show` 保留全局和单稿组件，各自持续轮询。当前响应只有 34 条，没有进入逐页串行加载，分页不是这次主因。

## 已实现的修复

1. `overview()` 读取本地任务及已持久化的账号核验结果，返回 `browser.checkedAt`，不连接浏览器，也不请求官网。账号快照损坏时返回浏览器不可用状态，本地任务列表仍可读取。
2. 保留显式账号检查、登录和实际生产操作的实时身份核验。展示用快照不参与生产授权。
3. 花生组件的所有 GET 读取使用 `AbortController`，15 秒超时时取消对应浏览器请求。`api.get(path, signal?)` 保持对原有调用的兼容。写命令的处理与重试规则不变。浏览器取消请求不等于服务端工作一定被取消；列表自身脱离远端核验才是根本修复。

修复后的列表路径为：

```text
GET 列表 -> 本地账号核验快照 + SQLite 任务/统计 -> 返回
显式检查或生产操作 -> 实时核验官网身份 -> 更新本地账号状态
```

## 验证

新增回归测试使用真实账号服务、默认 driver 和 Hono 路由，将实时身份核验挂起：旧代码无法返回列表，测试失败；修复后列表立即返回，并能读取核验结束后新持久化的失效状态。测试也覆盖账号快照不可读时仍返回本地任务。

后端 89 项相关测试通过，覆盖任务状态、分页统计、跨账号身份隔离、登录恢复、生产检查和防重复提交。

```bash
cd backend
TASK_WORKER_DISABLED=1 node --import tsx --test \
  src/routes/history-huasheng-overview.test.ts \
  src/routes/history-huasheng.test.ts \
  src/services/history-huasheng-default-driver.test.ts \
  src/services/history-huasheng.test.ts \
  src/routes/history-huasheng-accounts.test.ts \
  src/services/huasheng-workspace-accounts.test.ts
```

另外，从生产库只读复制任务、设置、监控与稿件删除标记到临时数据库，运行修复后的本地 HTTP 服务，连续请求 20 次：

| 项目 | 修复后隔离 HTTP 实测 |
| --- | --- |
| 任务数与统计 | 与原响应一致，34 条 |
| 最快 / P50 / P95 / 最慢 | 2.472 / 3.879 / 5.780 / 32.035 ms |
| 远端账号检查次数 | 0 |
| 响应字节数 | 27,962，增加核验时间字段 |

此测量使用真实数据快照，但与生产进程负载不同，不是同一运行中服务的上线前后压测。临时服务和数据库已清理，生产库未被此测量修改。

前端回归确认超时的任务列表和导出列表 GET 实际产生 `ERR_ABORTED`，并且随后刷新可恢复；共享 API 的原单参 GET、取消信号传递和 POST 兼容检查通过。

前端完整套件首次运行 83/89 通过，6 项失败是旧链接断言与现有按钮行为不一致。运行期间工作区出现了这 6 项断言的外部修改，已保留；在当前文件上重跑这 6 项和取消回归，7/7 通过。未在这些外部修改后再次运行约 337 秒的全量套件。

```bash
cd frontend
node --test --test-name-pattern='task actions respect|production status distinguishes|current completed project queues|export state failure stays|export progress and recovery controls|uncertain export submission|hanging queue and export reads' tests/history-huasheng.test.mjs
```

最新一轮后端 `npm run typecheck` 通过。排查期间出现过新增测试和其他并行修改文件的类型错误，最终检查已无错误；没有撤销其他工作区修改。

## 后续优化顺序

1. 在生产任务空档让主后端重新加载修复，再通过原 3013 地址采集实际 P50/P95 和错误率。当前 5679 通过 `node --import tsx --env-file=.env src/index.ts` 启动，没有文件监听；修改源码不能使该旧进程自动生效。
2. 合并全局和单稿视图重复轮询；不可见视图暂停计时器但保留组件与编辑状态。有进行中任务时维持短间隔，全部完成后降低频率。现有测试约定隐藏视图继续轮询，本次未改这项行为。
3. 增加接口总耗时、SQL、官网请求和事件循环延迟的分段指标。确认剩余长尾来自排队、锁等待还是 CPU，再做针对性调整。
4. 逐步将浏览器、生成和渲染 worker 从 API 进程独立运行，接口只查询状态和接收任务。当前主入口同时启动 API 与多类 worker；主库同步 SQLite 的 `busy_timeout=30000` 是潜在事件循环阻塞风险，本次未证明发生过该锁等待。
5. 数据量增长时再调整列表字段投影与统计：目前列表会从数据库取出 `script` 后再从公开响应中移除，可改为只查公开列。现有查询规模不足以支持优先迁移数据库或增加缓存基础设施。

## 修改文件

- `backend/src/services/history-huasheng.ts`
- `backend/src/routes/history-huasheng-overview.test.ts`
- `backend/src/routes/history-huasheng.test.ts`
- `backend/src/services/history-huasheng.test.ts`
- `frontend/app/components/HistoryHuasheng.vue`
- `frontend/app/composables/useApi.ts`
- `frontend/tests/history-huasheng.test.mjs`
- 本报告
