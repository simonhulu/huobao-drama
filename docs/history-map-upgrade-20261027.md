# 瑞金地图动画修订记录

作品为 source 62《一个叫花子为何能让红军提前长征？》，Episode 1062，任务 `302df8bb-f6b0-4929-9500-713def0241fd`。新版已登记到原 Remotion 工作页；原稿的既有交付关联、旧成片及旧任务保留。

- [工作详情与版本](http://localhost:3013/remotion/episode/1062)
- [完整新版](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-2485822b5180.mp4)
- [18 秒带声精选](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-2485822b5180-preview.mp4)
- [完整验证记录](../data/temp/history-map-upgrade-20261027/verification.json)与[交付 API 快照](../data/temp/history-map-upgrade-20261027/final-api.json)

## 根因与实现

旧图只接入地形和瑞金单点，缺少表达“外围部署、逐步压缩”的动作层；源高程采样与最终画幅不匹配，放大后显得模糊。文字虽描述包围，画面没有对应的空间变化。

| 层 | 本次修改与文件 |
| --- | --- |
| 地理数据 | `scripts/history-motion/map-data.mjs` 按输出采样选择瓦片层级，复用缓存；加入周边地点参照，保留来源、投影和采样证据 |
| 镜头计划 | `backend/src/services/history-motion-production.ts`、`history-motion-pipeline.ts` 接通 `mapPlan.presentation`；只提交地点和定位/路线/包围关系，限制无正文依据的包围与压缩 |
| 动作准备 | `backend/src/services/history-motion-maps.ts` 生成相机、阶段、图例和部署圈；概念几何与地理证据分别记录 |
| 实际画面 | `remotion/src/HistoryMapScene.tsx` 负责分段箭头、外围部署、活动空间收拢及结果停留；地形与标记共用相机变换，标签保持可读 |
| 渲染与同步 | `scripts/history-motion/render.mjs` 校验动画时间和示意标签；`backend/src/services/history-factory.ts` 同步合并后的 52 镜，隐藏旧尾镜并支持恢复 |

此次把原第 17、18 镜的连续空间叙事合并为一个 281 帧、9.3667 秒地图镜头，位于整片 **77.6667–87.0333 秒**。正文、原字幕时间窗和完整配音没有改写；仅重渲染这段，再按准确帧边界替换视频、直接复制完整 AAC 音轨。`map sample-v1` 是早期试片，不是最终交付。

## 实测结果

地图依次呈现“瑞金定位 → 计划外围构筑包围圈 → 计划压缩活动空间 → 部署构想停留”。蓝色表示外围部署，淡红色表示活动空间；旁边保留长汀县作现代地理参照。圈形、方向和收拢幅度均为叙事示意，不是实测封锁线、古代国界或部队坐标，也不能换算为历史面积变化。

底图为 1920×1080，使用 30 张 z11 Terrarium 瓦片；对应本画幅约 1439×809 个原始采样，重采样倍率约 1.33。瑞金锚点为 GeoNames 10378131（116.02715°E，25.88320°N）；地形来源 Mapzen/Tilezen 与 USGS，河流和背景地点来自 Natural Earth。许可、原件哈希及相机/阶段数据见[地理清单](../data/storage/history-motion/302df8bb-f6b0-4929-9500-713def0241fd/render-map-20261027/geographic-data.json)。输出尺寸和瓦片层级不代表古代地理精度。

完整视频为 1920×1080、30fps、7911 帧、263.744 秒，77,441,251 字节；H.264，约 17.62 MB/分钟。本次局部替换后采用 CRF 22、medium、3 Mbps 峰值，保留细线并减少等待，实际体积在本次 24 MB/分钟预算内。精选覆盖原片 72.3–90.3 秒，保留地图前后衔接与声音。

原文 SHA256 仍为 `2c4692d83eb5367915949650585969928a117253b9029f91c024ea798a83a7da`。完整配音母带哈希未变，原成片与新成片的 AAC 音频载荷哈希均为 `6aa6933e6f69c3d99ffb2ad10de12ecf9a75cd1ba01c7ac0b922348b4e1012f5`。52 镜使用 52 个不同场景文件哈希，其中 24 段视频的 assetId 互异；没有通过重复素材补足新片。

18 项渲染/组件测试与 60 项后端地图、制作和工厂测试通过。它们证明字段、时序、状态同步与技术约束，不证明影片好看或历史结论成立。

## 回看范围与限制

本次查看了最终地图的建立、部署、压缩和停留状态，并检查局部 2.5–2.6667 秒及 6.3–6.4667 秒的两组各 6 个连续输出帧；其余镜头沿用[上一版回看记录](history-remotion-validation-20261027.md)。没有重新连续看完整片，也没有完成听审或独立史学审阅。哈希一致只能证明正文和声音未变；地图清晰度、节奏和理解效果仍需观众实际观看评估。

最终输出 SHA256：`2485822b5180e4c31d0337cd1e94cb6fda8225ac883c7e6cf619bb099e691554`。API 快照列出新版及两版旧片，任务状态为 `completed`；原 Episode 的既有 `videoUrl` 仍保留，最新版本从 Remotion 输出列表播放和下载。
