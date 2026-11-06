---
name: history-video-publish
description: "将 history-scripts 的花生版、精细化版或手动成片关联到原稿，复用发布包装，按独立成片直接发表百家号视频并核验回执。历史流程不再生成图文或视频号短标题。"
---

# 历史视频交付与发表

适用 `/history-scripts` 的成片交付。正文固定使用当前 `rewrittenScript`，精细化制作交给 `remotion-history-factory`；本 skill 不再二创、不重配已有合格母带。

## 当前生产合同

用户已选择：每次制作同时生成花生版和精细化版，哪版先完成就先自动发表百家号，另一版完成后独立发表。不等两版齐，不保存为草稿等待确认。此约定已落实在后端，不要求代理代替用户点击每次发表。

- 新采集完成二创后，事务标记 `huashengQueue.productionMode:dual` 接入 `history_dual_production`。
- 手动入口 `POST /api/v1/history-scripts/<sourceId>/production {}` 启动或恢复两条生产分支。
- 已有 `motion_backfill` 记录时，明确选择两版生产会将其更新为 `dual`，保留原任务 ID、完成状态和工件，允许原花生版进入独立发表；单独补做入口不会反向覆盖已有双版模式。
- 既有精细化入口仍可直接打开 `/remotion/episode/<真实ID>`，同时接入花生制作。
- 每版成片使用 `history_video_deliveries` 独立记录 producer、任务、正文 SHA256、文件 SHA256 与 URL。历史版本保留；旧单一 videoUrl 仅兼容读取。
- 新完成交付写入 `history_video_publication_intents`；已接纳的双版任务若旧花生成片只存在于兼容交付记录，须核对正文、原文件路径和文件指纹，补登记渠道成片及发表意图，复用原文件。后台不为未接纳的旧库成片批量建立发表任务。
- 用户明确要求补做已完成花生作品时，使用 `POST /api/v1/history-scripts/huasheng/refine-completed {"sourceIds":[明确选择的稿件ID]}`。`motion_backfill` 只制作和发表精细化版；原花生分支不重做、不重新导出或发表。同正文已完成精细化成片先核验并补关联，其他任务复用原工件继续；进度按一份精细化成片统计。
- 单版封面和发布标题齐备后，立即创建该 videoId 的发表任务。另一版失败不阻塞。

## 标题与封面

发布标题直接改写采集原标题，保留主要人物、时间、数字与主题词；去掉关注、订阅、频道品牌等无关推广内容。禁止另搜爆款标题替代原题，不再为视频号生成 16 字短标题。

`baijiahaoTitle` 是正式标题，兼容 `title/video_title` 同值。`coverDesign.main_title` 是独立封面文字，不强制两者相等。新方案保存 `source-title-v2` 的原标题、清理标题、关键词和去推广记录。简介允许为空；不为了填满字段再写一篇文稿。

复用当前有效封面。封面缺失时用现有图片服务自动补齐，已有成功生图请求、底图和排字结果优先复用。输出 16:9 和 3:4 为百家号使用；4:3 兼容文件仍保留。

## 操作与回执

先读取 `/api/v1/history-scripts/<sourceId>/delivery`，`videos` 是当前稿每个制作渠道的最新成片，`videoHistory` 是历史版本。采集源视频 `/<sourceId>/video` 不是作品，不得送去发表。

手动补发或恢复：

```json
POST /api/v1/history-scripts/uploads/jobs
{
  "sourceIds": [123],
  "targets": ["baijiahao-video"],
  "mode": "publish",
  "videoIds": [456],
  "requestId": "stable-request-id"
}
```

省略 videoIds 选择所选稿件当前全部成片；自动发表始终传单个 videoId。重试沿用任务和已落盘的 requestId，不能重新生成 ID 绕过未知结果。

旧上传记录可能没有 videoId。补登记成片时同时匹配同源、同文件的原发表任务：有可信提交回执则完成，无回执或结果不明则保留原任务继续核对，不能因补出新 videoId 而再次上传。明确尚未开始上传的失败可在原任务重试。

队列调用 `social-auto-upload`：校验文件 → 上传/封面 → 已授权直接发表 → 平台回执。`submitted` 是已提交审核，`published` 是平台公开成功，两者不能混称。旧 `saved` 只代表草稿，不计为新发表。发表结果未知时只读核对原检查点与作品记录，不能重新上传或再次点击发表。

历史工厂成片在百家号原编辑页补齐必填“创作声明：含AI生成内容”，不向视频画面烧录角标。明确记录到“请选择创作声明类型”且没有发出发布请求时，可核对原视频和包装后在原页面补齐再提交，保留前次拒绝证据；没有这类证据的旧未知尝试仍只读核对。核验优先读取当前作品列表，使用平台作品 `created_at` 与本次提交对应，不能用审核后变化的页面显示时间排除真实回执。

登录或安全验证阻断时，使用页面百家号登录/同步入口，保留原任务。代码入口为 `history-social-upload.ts`、`social-auto-upload.ts` 和 `backend/scripts/social-auto-upload/`。传统 `scripts/history-video-publish` 手工包是兼容工具，不用于代替新网页链路。

## 验证与报告

检查逐版 output ID、正文/文件指纹、发表任务与平台作品 ID 对应。测试只能证明程序行为；真实平台发表必须有实际作品回执，不能把离线浏览器测试或草稿当成已发表。保留本次实际回看范围，不追加逐镜审批。当前实现与验证见 [当前流程与验证](../../../docs/history-workflow-upgrade-20261028.md)。
