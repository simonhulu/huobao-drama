# Grid 设计任务失败

对应错误：`DESIGN_TASK_FAILED`（design_ensure 阶段，grid.episode_design 终态非成功）。

## 第一步永远是读任务的真实错误

runner 的 `checks.design_task` 只保留 `{id, status, error}`；完整任务对象在
run.json 的 `designTask.raw`，也可用 `GET /api/v1/tasks/<id>` 查
`error_message`。先搞清是内容问题还是基础设施问题，再动手。

## 按病因处理

- **Provider/网络故障**（DNS fake-ip、HTTP 000、超时潮）→ 转
  `circuit-breaker.md`：停止重试，等恢复。
- **分镜数据问题**（duration 单位错、单镜 > 8s 被拒）→ 修数据，见
  `duration-seconds.md`、`storyboard-split-8s.md`。
- **偶发单任务失败** → `retry-action` 重发设计任务（这会真正重新 POST，
  属于 retry-action 的有效场景）。

## 禁止事项

- 不要因为设计失败就删除 Remotion 项目重建——项目只是生产容器，
  见 `remotion-project-rebuild.md`。
- 不要绕过 `grid.episode_design` 手工往 `design_json` 里塞占位对象——
  runner 只校验它是合法 JSON 对象，占位垃圾会把更贵的失败推到
  manifest/asset 阶段。
