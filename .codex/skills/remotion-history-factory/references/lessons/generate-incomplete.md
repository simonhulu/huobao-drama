# 任务报成功但盘上缺格：终态/磁盘竞态

对应错误：`GENERATE_INCOMPLETE`（grid.episode_generate 成功但画格仍缺）。

## 真实事故

`grid.episode_generate` 任务终态报 `succeeded`，但 runner 复查发现
`storyboard_panels.final_path` 指向的文件**在盘上不存在**。任务系统的终态
与文件系统之间存在竞态：任务把 panel 标记 completed 时，最终图片还没落盘
（或落盘失败被吞了）。如果只信任务状态，后续 manifest/asset 阶段会在更晚、
更贵的位置炸掉。

## runner 的兜底语义（先理解再操作）

- runner **不信**任务自报的成功：`ensure-generate` 在任务终态后重新按盘上
  事实计算缺格（`computeMissingPanelStoryboards`：grid_cells、panel 行、
  gen_status、final_path 存在且非空，逐格校验）。
- 仍有缺格 → 自动 requeue 一次 scoped 生成（`onlyStoryboardIds`）。
- requeue 预算（`gridTaskRequeue = 1`）耗尽仍缺 → 抛 `GENERATE_INCOMPLETE`，
  run 进入 failed，`next_action = start-new-run`。

## 正确反应

1. 先看 `checks.generate_missing.sample` 里的 storyboard 和原因——是
   「final image is missing on disk」（竞态/落盘失败）还是
   「missing grid_cells」（上游数据问题）。
2. 竞态型缺格：`start-new-run` 开新 revision，预算全新后 scoped 生成会
   只补缺的格。
3. 如果同一批 storyboard 反复缺 → 多半是 provider 故障，转
   `circuit-breaker.md`。
4. **不要**手工把别的图片复制成 final_path 骗过校验——内容指纹
   （asset fingerprint）会在 asset_review 阶段抓出重复或错位内容。
