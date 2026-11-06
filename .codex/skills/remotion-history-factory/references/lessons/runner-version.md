# Runner 版本不匹配

对应错误：`RUNNER_VERSION_MISMATCH`。

## 含义

run 文件里记录着最后一次写它的 runner 版本（`runnerRelease`）。当前 runner
发现该状态由**更新**的 runner 写入——状态里可能有这个旧二进制不懂的语义
（新 action、新证据字段），继续写只会破坏预算与证据链。

真实事故：生产中途部署了新 runner，旧 runner 进程遇到新状态里的
`auto-approve-assets`，报 "Unknown machine action" 并把这次失败写进
`actionFailureHistory`，白白污染 repair 预算。现在版本不匹配会在**写入
之前**直接拒绝，不消耗任何预算、不写失败历史。

## 正确反应

1. 用拥有该 run 的新 runner 继续：`run --run <path>`（新 runner 的二进制）。
2. 或者由新 runner 执行 `start-new-run` 开新 revision。
3. 如果你确信旧 runner 才是对的（例如误部署），先统一 runner 版本再操作
   ——**不要**手工编辑 run.json 里的 `runnerRelease` 骗过检查。

## 兼容保证

旧 runner 打开旧状态（planHash 不同）的既有迁移行为不变：计划迁移会在
验证版本后照常执行，下游证据按计划失效重派，失败历史永远保留。
