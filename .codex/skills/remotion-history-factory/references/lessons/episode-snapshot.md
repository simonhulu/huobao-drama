# Episode 快照无效：入口条件不满足

对应错误：`EPISODE_SNAPSHOT_INVALID`（intake / start 阶段）。

## 触发原因（按 checks.errors 逐条对照）

1. **Episode / Drama 不存在或被软删** → 确认 id，别在删掉的 episode 上开工。
2. **Drama 没有锁定系列视觉风格**（`dramas.style` 为空）→ 先在 Web UI
   或数据库锁定 style，这是全系列画面一致性的锚点。
3. **Episode 不是 direct_script 类型**（`workflow_type` 是 story_rewrite 等）
   → 历史工厂只生产 direct_script episode：稿件驱动分镜拆解与 pre-TTS 主轨。
   非 direct_script episode 永远走不到 tts_verify 之后——早期版本的 runner
   不校验这一项，episode 会白跑到 tts_verify 才报一个不对因的
   "no pre-TTS master" 错误。在 intake 就拒绝是特性。
4. **稿件为空**（`script_content` 空白）→ 先把最终稿写入 episode，
   再启动 run。

## 正确反应

修好 episode/drama 数据后用原命令重新 `start`（同 episode + 同 token 会
幂等重放原 run）。**不要**为了让校验通过而临时编一个 style 或贴一段假稿件。
