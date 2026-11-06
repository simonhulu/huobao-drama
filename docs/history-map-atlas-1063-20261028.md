# 第1063集山川河网与城市地图升级

第1063集《朱棣兵少为何敢挑战整个大明》的12个地图镜头已升级并登记回原 Remotion 任务和稿件141。正文、旁白、字幕和切镜时间保持原版，武将、军队、占领旗帜及原行动时序继续使用。旧版文件与作品记录保留。

## 查看产物

- 原作品页：<http://localhost:3013/remotion/episode/1063>
- 同镜头升级前后对比：<http://localhost:3013/static/remotion/history-map-atlas-1063-comparison/index.html>
- 40.6秒带声精选：<http://localhost:3013/static/remotion/history-map-atlas-1063-1793164229879-preview.mp4>
- 完整成片：<http://localhost:3013/static/remotion/history-67df9801-27d8-4e06-a1b2-1970b564b528-9bfd7310e120.mp4>

新成片 SHA-256：`9bfd7310e120150683287819654d4a486329e31936959a3e09f68d1a947a7952`。

## 实际变化与来源

| 图层 | 实际实现 | 范围和限制 |
| --- | --- | --- |
| 地形 | Mapzen 已缓存实测高程，多尺度晕渲、分层配色 | 本片不同取景的原始采样约540–1687像素宽；输出1080p不等于高程源达到1080p，更不等于30米精度 |
| 河网 | 实际下载的 HydroRIVERS v1.0 亚洲包，裁剪并压缩为约784KB的区域缓存，主支流分级 | 东经109–124°、北纬30–42.5°；本片每镜11–257条河线。现代河网提供位置参照 |
| 海面、天然湖泊 | Natural Earth 多边形，保留孔洞 | 使用明确的水面几何，不把低海拔陆地当海水；省略水库 |
| 地理名称 | Natural Earth 范围、Wikidata 位置、已核实的本片城市锚点 | 包括太行山、军都山、泰山、紫金山、渤海等可用源；实际显示受画幅与避让限制 |
| 城池与军事 | 城市/都城/关隘/战场符号，屏幕空间标签，原军队动画 | 城市可用引线内移，次要地理名放不下则省略；只有明确的 `occupy` 改归属 |

来源原件、SHA-256、官方链接和构建脚本在 `scripts/history-motion/map-geography-data/`。主要公开入口：

- HydroRIVERS：<https://www.hydrosheds.org/products/hydrorivers>
- Natural Earth：<https://www.naturalearthdata.com/>
- Mapzen Terrain Tiles：<https://registry.opendata.aws/terrain-tiles/>
- Copernicus DEM：<https://registry.opendata.aws/copernicus-dem/>

Copernicus Float32 COG 范围读取、缓存和失败回退已接通并测试；本次更细数据下载未完成，450像素overview没有替代更清晰的Mapzen缓存。成片实际使用的provider与采样尺寸分别保存在各镜地形清单中。

明代语境省略1855年改道后的现行下游黄河主干与现代水库，永定河使用有依据的“卢沟河”名称；没有猜画东昌运河或古代国界。这仍不是完整古河道、古海岸线或精确兵位复原，独立历史审阅尚未进行。

## 执行与效率

后续网页制作仍通过 `history-motion-pipeline.ts` → `prepareMotionMap()` → `map-data.mjs` / `map-geography.mjs` → `HistoryMapScene` 执行。全文历史语境传入地图准备器；`cartography:{version:1,style:'relief-atlas'}` 启用新版制图。旧地图未带该字段时保留兼容渲染。

本片复用已有取景、城市经纬锚点与地形缓存，没有再次配音或生成人物头像。12个地图镜头为6、14、41、43、72、83、97、98、103、105、110、135。只渲染覆盖这些镜头及转场的9个完整GOP区间，共3787帧，其他视频直接复用。配音音色仍为 `ttv-voice-2026072016135626-xnywYYL4`。

固定计划与复现入口：`data/temp/history-map-atlas-1063/`。本轮产物目录：

```text
data/storage/history-motion/67df9801-27d8-4e06-a1b2-1970b564b528/render-map-atlas-1793164229879/
```

其中 `plan.json`、`shot-*-geography.json`、地形manifest、`movie.mp4.json`、`patch-evidence.json`、`map-review.json` 与 `completed-job.json` 保存计划、来源、检查及登记证据。

## 已核验的结果

- 总计23358帧，30fps，1920×1080，H.264/AAC，时长778.603秒，191054839字节，约14.72MB/分钟，符合现有上传预算。
- 音频包内容、PTS、DTS与原成片完全相同；替换区间外的视频包内容及时间戳完全相同；全片显示帧连续无缺帧、重帧。
- 稿件分镜拼接、逐镜起止帧、字幕和配音路径与原计划一致；登记前核对原成片哈希及当前稿件，保存原任务、原Episode和原稿件交付快照。
- 现有生产API返回新版成片，状态为 `completed`；作品列表保留旧版。对比页、带声精选、作品页和媒体HTTP响应已验证。
- 渲染合同15项、地形3项、地理9项、后端地图/生产及军事布局77项检查通过。后端TypeScript检查通过，两份skill通过 `quick_validate.py`。

实际视觉检查范围：查看最终成片全部12段地图的3fps连续抽帧联系表、shot-41同帧前后对比与shot-103最终1080p结果。检查到包围建立、行军轨迹、抵达换旗和结果停留，修复了标签避让把“山东半岛”移到海面的问题。联系表末尾白格是未填满的拼图格，不是视频空帧。

本次没有连续播放整片或进行人类听审，也没有观众理解测试。浏览器自动化不可用：内置浏览器不存在，Chrome返回 `Codex auth token is unavailable`；因此页面闭环以现有生产API、数据库登记和媒体响应验证，未声称完成浏览器点击播放检查。抽帧与技术测试不能代替独立历史审阅或观众观看评价。

## 修改范围

核心实现位于 `scripts/history-motion/{map-data,atlas-terrain,map-geography,render}.mjs`、对应测试、地理缓存包、`backend/src/services/history-motion-maps.ts`、`history-motion-pipeline.ts`、`remotion/src/HistoryMapScene.tsx` 和 `history-map-labels.ts`。已更新 `history-map-animation` 的入口/数据参考及 `remotion-history-factory` 的地图流程说明；没有另建制作UI。
