# 每个分镜时长必须 ≤ 8 秒，否则 grid.episode_generate 拒绝执行

**日期**: 2026-07-25 · **集数**: Episode 602
**后果**: 38 个分镜被拆成 97 个，叙事计划也得重建。

## 原因

`backend/src/services/grid-narrative-pipeline.ts` 定义了
`MAX_SINGLE_IMAGE_SHOT_SECONDS = 8`。这是视觉设计约束——单张静态图片在屏幕上
停留超过 8 秒会让观众感到拖沓。

38 个 TTS 标题的时长范围是 5~17 秒，绝大多数超过 8 秒，所以必须拆分。

## 正确的拆分方法

对每个标题，如果 `duration > 8`：

1. 先用 `。！？` 分句
2. 不够再用 `；：` 分
3. 还不够用 `，、` 分
4. 每段的 duration 按字符数比例分配
5. 递归检查拆分后的段，确保全部 ≤ 8s

## 防错规则

- **运行 grid.episode_generate 之前**：
  ```sql
  SELECT COUNT(*) FROM storyboards WHERE episode_id = ? AND duration > 8
  ```
  必须返回 0
- **拆分时不破坏句子的语义完整性**——宁可在标点处多分几段，也不要在词中间硬切
