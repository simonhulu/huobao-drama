# 帧审查失败

对应错误：`FRAME_RENDER_FAILED` / `FRAME_AUTO_APPROVAL_FAILED`（frame_review 阶段）。

## FRAME_RENDER_FAILED

从 candidate 抽帧或拼帧表失败。帧**永远从最终 candidate 字节**抽取（不从
props 重渲），保证审查与发布的交付是同一份文件。ffmpeg 抽帧失败多为
candidate 损坏 → 回 candidate_render，见 `render-recovery.md`。

## FRAME_AUTO_APPROVAL_FAILED

- `Frame sheet bytes changed after extraction` → 帧表在生成后被改动，
  `extract-review-frames` 重新抽帧即可。
- `Candidate bytes changed after render` → candidate 被替换过，帧证据全部
  失效，回 candidate_render。

## 孤儿帧表自愈（runner 行为，了解即可）

真实事故：后台进程被杀，6MB 帧表在盘上但 run.json `frameSheet = null`，
approve-frames 报 "No frame review sheet is available"。runner 现在会自愈：
当 `review-frames/` 里的 PNG 文件名集合与当前 props 计算出的采样集**完全
一致**、且 candidate 对当前 props 有效时，自动重新挂接帧表（事件日志记
`artifact_self_healed`）。不匹配才走重新抽帧路径——两种路径都不需要手工
改 run.json。
