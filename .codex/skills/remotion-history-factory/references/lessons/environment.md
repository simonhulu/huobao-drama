# 环境检查失败

对应错误：`ENVIRONMENT_INVALID`（environment_check 阶段）。

## 先读 checks.errors，它逐条告诉你缺什么

- `Backend health check failed` / `No healthy task worker is available`
  → 后端或 worker 池没起来：`cd backend && npm run dev`，确认
  `/api/v1/health` 与 `/api/v1/health/workers` 正常。
- `ffmpeg is unavailable` / `ffprobe is unavailable` → 装 FFmpeg 4+ 并确认在 PATH。
- `native-comic-v11 renderer is unavailable` / `check_dharma_sync.mjs is unavailable`
  → 仓库文件缺失，确认 `scripts/videoeditor/` 完整。
- 字体缺失 → 确认 `data/fonts/NotoSansCJKsc-Regular.otf` 与
  `remotion/public/fonts/NotoSerifSC-Bold.ttf`。
- BGM 相关两条（文件缺失 / 不足 30s）→ 见 `bgm-missing.md`。

## 正确反应

- 修的是**环境**，不是 run 状态。修好后 `retry-stage` 重跑本阶段即可，
  不消耗 action-repair 预算。
- 环境失败时 `checks.network_errors` 里有原始网络错误；连续多集同发型
  网络错误（DNS fake-ip / HTTP 000 / 超时潮）→ 转 `circuit-breaker.md`，
  等恢复再重试，别反复烧 stage-retry 预算（`verifyStageRetries = 2`）。
