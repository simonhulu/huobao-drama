# 租约恢复：runner 被杀后如何安全续跑

对应错误：`RUN_LEASE_ACTIVE` / `RUN_LEASE_LOST` / `RUN_LEASE_OWNERSHIP_MISMATCH`。

## 真实事故

runner 的机器循环被 harness 杀掉（前台进程被回收），`run.json` 旁边留下
`history-comic.run.json.lock`。再次启动时报 `RUN_LEASE_ACTIVE`，agent 差点
直接 `rm` 锁文件——如果旧进程其实还活着，两个 driver 会并发写同一份 run
状态，证据链直接错乱。

## 租约机制（先理解再操作）

- 锁文件：`<run>.lock`，内含 owner、pid、hostname、expiresAt（60s 心跳续约）。
- 以下两种情况新 runner **可以安全窃取**租约（runner 自动处理，不用手动删锁）：
  1. 租约已过期（expiresAt < now）
  2. 同主机且 owner PID 已死
- owner 进程还活着时，任何变更命令都会被拒绝——这是特性，不是故障。

## 正确的启动姿势

机器循环（design/generate 轮询、渲染）可能跑几十分钟，**不要挂在前台
turn 里**，用 detached 方式启动并定期 `status` 查看：

```bash
nohup node .codex/skills/remotion-history-factory/scripts/history_comic_pipeline.mjs \
  run --run scripts/history-notes/episode-<id>/history-comic.run.json \
  >> scripts/history-notes/episode-<id>/runner.log 2>&1 &
```

## 恢复流程

1. 先查不先删：`cat <run>.lock`，确认 owner PID 是否真的死了
   （`ps -p <pid>`）。
2. PID 已死或租约已过期 → 直接重跑 `run --run <path>`，runner 会自动窃取
   过期租约。
3. PID 还活着 → 说明有别的 driver 在跑，等它或 kill 它，**绝不手动删锁**。
4. runner 在渲染中途被杀 → candidate 可能半成品：用 `run --run <path>`
   续跑，runner 的 `recover-candidate` 会校验 `native/result.json` +
   `candidate.mp4` 是否绑定当前 props，有效则免费收养，无效则重渲。
