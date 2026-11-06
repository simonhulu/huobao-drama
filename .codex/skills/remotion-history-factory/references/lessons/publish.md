# 发布失败：delivery 归属与 episode 指针

对应错误：`DELIVERY_EXISTS_UNOWNED` / `EPISODE_PUBLISH_FAILED`。

## DELIVERY_EXISTS_UNOWNED

publish 阶段发现目标 delivery 文件已存在且**字节不同**。delivery 按内容
SHA 命名、不可变——同名不同字节意味着有人（通常是另一个 run / 另一台
机器）放了一个冲突文件。

- 正确动作：`start-new-run`（新 candidate 会有新 SHA、新文件名，天然
  避开冲突）。
- **不要**删除或覆盖那个已存在的文件——它可能正被别的 episode 引用。

## EPISODE_PUBLISH_FAILED

episode_publish 阶段把 `video_url` + `historyComic` 元数据用 CAS 提交并
回读校验。失败模式：

- `already points at a foreign video_url` → episode 已被别的生产线占用。
  先确认那个 URL 归属，**不要强覆盖**；确认是残留后手工清
  `video_url = NULL` 再 `retry-action`。
- `CAS update failed` → 有并发写者抢了这集，重跑一次即可。
- `readback verification failed` → API 回读与提交不一致，查后端 episodes
  路由是否在拦截/改写 video_url。
