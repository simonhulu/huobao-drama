---
name: history-motion-video-factory
description: "历史视频精细化制作的兼容入口。调用统一 remotion-history-factory，复用本地素材、配音、图片和地图，在现有 Remotion 工作详情中继续制作与交付。"
---

# 历史视频制作兼容入口

收到本 skill 请求时，立即按 [remotion-history-factory](../remotion-history-factory/SKILL.md) 继续。制作策略、素材协议、执行 API 与交付标准只在统一 skill 中维护。

新任务进入 `/remotion` 和 `/remotion/episode/<episodeId>`，不建设独立精细化界面。已有 `history_motion_productions` 任务与产物保留，恢复规则见 [统一执行](../remotion-history-factory/references/unified-workflow.md)。不要再次要求用户切换 skill，也不要启动第二条 runner。

兼容入口同样受统一合同约束：已保存的 `rewrittenScript` 逐字不改；同一成片内视频、图片和地图底图以实际 SHA-256 去重；信息动画只能叠加在视频或图片上，不能独立做 PPT；缺媒体或补图/地图失败须记录可重试缺口并复用成功工件。自动视觉抽检默认每任务 90 秒处理预算，不等于已观看 90 秒视频；有限采样只说明实际所见，不证明历史身份、事件或地点。
