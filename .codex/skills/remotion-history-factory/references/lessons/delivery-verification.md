# 交付校验失败

对应错误：`DELIVERY_VERIFICATION_FAILED`（delivery_verify 阶段）。

## 先分transient还是deterministic

runner 的报告里 `failureClass` 与 `retryable` 已经分好类：

- **transient**（`retryableErrors`：ffprobe/ffmpeg/sync checker 工具本身
  没跑成）→ runner 自动重验（预算 `deliveryTransientRetries = 3`），
  超过后 `repair-delivery --actor <name> --reason <text>` 让人工确认后
  再验（预算 `deliveryRepairs = 2`）。
- **deterministic**（编码错、帧数不符、音画时长差 >0.5s、黑场、响度
  出界、sync 校验失败）→ 内容级缺陷，校验多少次都一样，
  `next_action = start-new-run`。

## sync 校验是权威，不许手工对齐

`check_dharma_sync.mjs` 用冻结 TTS titles 独立重算字幕窗口，与渲染产物
逐帧比对。它失败说明**渲染时序真的错了**，不是校验器过敏——回 props /
manifest 阶段查时序来源（见 `timing-master.md`），**不要**为了让校验
通过而手调字幕或 props。

## 交付字节不可变

delivery 按内容 SHA 命名、原子发布、永不覆盖。任何内容修复都意味着新的
candidate → 新的 SHA → 新的 delivery 文件，旧文件留作审计。
