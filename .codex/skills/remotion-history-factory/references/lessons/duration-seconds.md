# Storyboard 的 `duration` 字段单位是秒，不是毫秒

**日期**: 2026-07-25 · **集数**: Episode 602
**后果**: 第一次 `grid.episode_generate` 立即失败，报错"单图分镜时长必须 ≤ 8s"。

## 我犯了什么错误

MiniMax TTS 返回的 `titles[].time_begin` 和 `time_end` 单位是**毫秒**（10813ms = 10.8 秒）。
我把毫秒值直接写入了 `storyboards.duration`，但后端代码把这个字段跟
`MAX_SINGLE_IMAGE_SHOT_SECONDS = 8` 直接比较——它期望的是**秒**。
10813 > 8，触发拒绝。

## 为什么容易犯

TTS 接口返回毫秒是业界惯例，`duration` 不写单位也是 SQLite 常见做法。
两套约定在同一个系统里碰撞，文档里没有明确说明。

## 正确的做法

```python
dur_sec = round((time_end - time_begin) / 1000, 1)  # 毫秒 → 秒
db.execute("UPDATE storyboards SET duration = ? WHERE id = ?", (dur_sec, sid))
```

## 防错规则

- **插入分镜后立即验证**：
  ```sql
  SELECT id, duration FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number LIMIT 5
  ```
  所有 duration 值应该在 2~20 之间（秒），绝不应该出现 ≥ 100 的值
- **改后端也同样有效**：在 `grid.episode_generate` 入口加一个断言，如果 duration > 60 就报明确的单位错误
