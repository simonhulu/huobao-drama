# 渲染失败与 candidate 恢复

对应错误：`RENDER_FAILED` / `NATIVE_RESULT_INVALID`（candidate_render / publish 阶段）。

## RENDER_FAILED

native 渲染器崩溃或渲染结果无效。

- **瞬时原因**（机器负载、ffmpeg 抖动、磁盘短暂不可写）→ `retry-action`
  重渲，这是 retry-action 的有效场景。
- **渲染到一半进程被杀** → 不要手工删 `native/` 或 `candidate.mp4`。
  续跑时 runner 的 `recover-candidate` 会校验 `native/result.json` +
  `candidate.mp4` 是否绑定当前 props（propsSha、输出 SHA、帧数全对），
  有效则免费收养，无效自动重渲。
- **反复在同一位置失败** → 看渲染器 stderr（run.json 的 actionFailure
  errors 里有尾部），多数是 props 数据问题，回 props 阶段修。

## NATIVE_RESULT_INVALID

`result.json` 存在但校验不过（props SHA / 输出 SHA / 帧数 / renderer 版本
不匹配）。说明 native 目录里的产物不属于当前 props——`retry-action`
触发重渲即可，不要手工编辑 `result.json`。

## 绝对禁止

- 不要把 `candidate.mp4` 手工复制成 delivery（`data/static/remotion/`）——
  delivery 只能由 publish 阶段经 SHA 校验后原子发布。
- 不要删 `candidate.mp4` 逼迫重渲：runner 已有完整的收养/重渲判定，
  手工删除只会丢证据。
