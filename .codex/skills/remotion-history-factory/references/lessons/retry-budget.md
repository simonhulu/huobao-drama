# 重试预算：retry-action 什么时候是空转

对应错误：`DESIGN_INCOMPLETE` / `GENERATE_INCOMPLETE` / `IMAGE_RETRY_EXHAUSTED` / `ACTION_FAILED`。

## 真实事故

requeue 预算耗尽后（如 `designRequeueCount` 到顶），run 进入 failed，
`next_action = retry-action`。agent 照做，runner 重新执行失败的 action——
但 `ensure-design` / `ensure-generate` 看到预算已尽，**不发任何新任务**，
969ms 后原样抛同一个错误。如此两次烧光 action-repair 预算（`actionRepairs = 2`），
才被迫 `start-new-run`。整个过程中零实际工作被重发。

## retry-action 的真实语义

`retry-action` 只做一件事：清除 `actionFailure` 记录并重新执行那个 action。
它**不会**重置任何预算计数（requeue 次数、重生次数都不变）。因此：

- **有效场景**：action 本身因瞬时原因崩溃（renderer 崩溃、ffmpeg 抖动、
  网络毛刺），重跑会真正重发工作。
- **空转场景**：失败的根因是预算耗尽（`DESIGN_INCOMPLETE` /
  `GENERATE_INCOMPLETE` / `IMAGE_RETRY_EXHAUSTED`）。此时 runner 直接给
  `next_action = start-new-run`；即使手动跑 `retry-action`，runner 也会
  立即拒绝并提示用 `start-new-run`，**不消耗 repair 预算、不写失败历史**。

## start-new-run 的正确时机

- `next_action = start-new-run` 时**直接执行**，不要先 retry 试探。
- 新 revision 的预算计数全新；旧 run 的失败历史归档在旧 run 文件 +
  新 run 的 `revisionSourceFailures` 摘要里，随时可审计。
- `start-new-run --run <path> --actor <name> --reason <text>`：
  reason 写清根因（≥8 字符），这会留在 revision 记录里。
