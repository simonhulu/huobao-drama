# 熔断：provider 故障时不要重复诊断

对应错误：`GENERATE_TASK_FAILED`（grid.episode_generate 任务终态失败）。

## 真实事故特征（多集实证）

grid 生图/生视频任务大面积失败时，失败模式高度一致：

- DNS 解析到 fake-ip（`198.18.x.x`，代理/VPN 分流特征）
- HTTP 状态 000（连接根本没建立）
- 超时潮：不相关的一批任务在同一时间窗内全部超时

这些是**供应商侧或网络侧故障**，不是稿件、分镜或参数问题。

## 错误反应（都踩过）

- 每个失败任务单独重试 → 重试也死在同一个网络故障上，白白消耗
  storyboard 重生预算（每格首次 + 3 次重生，烧完即 `IMAGE_RETRY_EXHAUSTED`）
- 反复改 prompt / 改参数"排查" → 故障与内容无关，改什么都不会好
- 删除 Remotion 项目重建 → 见 `remotion-project-rebuild.md`，永远禁止

## 正确反应

1. 确认模式：连续 ≥3 个任务报 DNS fake-ip / HTTP 000 / 超时 → 判定
   provider 故障，**停止一切重试**。
2. 等恢复（通常几分钟到几十分钟），期间不要动 run 状态和任务队列。
3. 恢复后：
   - 当前 run 的 requeue 预算若已耗尽（`GENERATE_INCOMPLETE` /
     `IMAGE_RETRY_EXHAUSTED`）→ `start-new-run` 开新 revision，
     预算全新，失败历史留在旧 run 文件里供审计。
   - 预算未耗尽 → `retry-action` 重发任务即可。
4. 恢复后第一批任务先小样验证（1–2 格）再放量，避免二次烧预算。
