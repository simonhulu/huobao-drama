# 兼容说明：执行流程

新制作及恢复流程统一维护在 [remotion-history-factory 的统一执行](../../remotion-history-factory/references/unified-workflow.md)。历史 motion 记录与成片保持可访问；无需为了进入统一页面删除、重建旧任务或重新配音。

技术验收后自动关联交付。旧 `approve` API 是兼容操作，不是新流程必须等待的人工批准。读取任务自己的成片地址，不能把其他渠道已存在的交付视频当成本次产物。

正文、素材唯一性和回退边界以统一 skill 为准：保存的 `rewrittenScript` 逐字保持；同一成片的视频、图片和地图文件按实际 SHA-256 唯一；补图或地图失败只保留可重试缺口或使用尚未使用的合法底层媒体，信息动画不能独立填空。
