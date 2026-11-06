# 叙事计划无效

对应错误：`NARRATIVE_PLAN_INVALID`（narrative_plan_verify 阶段）。

## 校验内容（checks 里有实测值）

1. 必须存在 `kind = 'full'` 的 narrative_plans 行。
2. `timing_source` 不能是 `storyboard_grid_fallback`——那是骨架兜底，
   不是真实叙事设计。
3. Beat 时序覆盖数 == 在册 storyboard 数（每个分镜都有
   `visual_beats.start_ms` 权威窗口）。

## 正确反应

- 缺计划或计划是 fallback 骨架 → 重跑叙事层级导入
  （`narrative-hierarchy/import`），让每个分镜都挂上 Beat 窗口。
- 覆盖数不足 → 有分镜没进计划：核对 storyboards 与 plan 的 episode 归属，
  重新导入。**不要**按字数估算补窗口——时序唯一来源是 Beat 窗口链，
  见 `timing-master.md`。
- 修好后 `retry-stage`（预算 `verifyStageRetries = 2`）。若刚重建过
  storyboard，注意 `duration-seconds.md` 与 `storyboard-split-8s.md` 两个
  配套约束。
