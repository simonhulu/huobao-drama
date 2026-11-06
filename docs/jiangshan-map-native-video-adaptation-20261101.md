# 江山地图原生渲染与视频推演适配

核验日期：2026-11-01 至 2026-11-02。上游固定版本：[`a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a`](https://github.com/DeanChensj/jiangshan-map/tree/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a)。

本文保留12秒基础原型的研究与数据调查。后续18秒精细版已加入生成将领头像、透明骑兵/步军、曲线箭头和全镜头稳定布局，成片、实现与验收见[精细推演样片](jiangshan-map-refined-video-20261102.md)。

## 结论与采用方向

**直接保留江山地图的原生地图渲染、地形、中文标注和避让方法，叠加本项目已有的军事动作与视频时序。** 用户明确看重它的地图美观和地理细节，不能仅提取 GeoJSON 再由原有地图样式重绘。

现有技能是 `.codex/skills/history-map-animation/SKILL.md`。它的行军、攻击、撤退、占领判定、字幕及旁白同步可以与江山原生地图结合。两者之间的关键接口是“每帧相机状态与同一投影的屏幕坐标”，并非一张固定背景图。

本轮实现独立研发原型，尚未替换历史视频生产入口。展示题材是 741 年唐代地图上的虚构行军和占领动作，不是历史战役复原；直线只用于验证坐标和动作同步。

## 实际实现

```text
江山本地原始 HTML / CSS / JS / 地形与历史数据
  → 等待本地资源就绪，收起网页操作界面
  → seek(frame)：设置原生 camera，完成原生标签布局
  → MercatorProjector + SVG getScreenCTM：获得当帧城市坐标
  → React flushSync：行军箭头、军队、进攻、占领标记
  → 逐帧画面 → FFmpeg H.264 → 定时演示旁白 / AAC
  → 独立 MP4，可供现有视频合成流程使用
```

- `scripts/jiangshan-map-pilot/native-driver.mjs`：本地服务、原生页面驱动、资源就绪、帧时钟、投影、画面捕获、音视频编码和证据记录。
- `scripts/jiangshan-map-pilot/build-overlay.mjs`：使用现有 esbuild 打包叠层，无新增依赖。
- `remotion/src/JiangshanMapPilot.tsx`：只绘制军事动作及必要说明，调用 `HistoryMapForces`、`HistoryMapFlag`、`mapForceState`、`mapCityControlAt`、`referenceRoutePoint`。
- 江山底图及文字在浏览器里由原代码每帧渲染；相机和军事对象共用实际屏幕投影。原生 SVG 的地名、河流名、州道边界、关隘符号、地形配色没有被自制 GeoJSON 图替代。
- 出现/消失年份、别名等通过原始城池记录匹配；样例的“洛阳”匹配原始“东都洛阳”及其别名，保留该年的原生地图标注。
- 网页实时播放和 CSS 动画停用；动作由 `frame / fps` 决定。检查同一帧在乱序访问前后的像素哈希，防止按墙钟录屏造成漂移。
- 地图布局使用上游私有 `_applyCamera()` 等接口，因而锁定上游版本。升级须再次验证，不能自动追随 `main`。

## 上游实际能力

| 能力 | 本次核实 | 对我们制作视频的价值 |
| --- | --- | --- |
| 地图渲染 | 原生 JavaScript + SVG，无 npm 运行依赖；已有本地地形栅格 | 可以直接使用整套地图样式和中文标注 |
| 历史范围 | 18 个时期、184 个疆域快照（另含 neighbors 上下文）；网页覆盖前403年至现代 | 适合朝代格局和历史地理背景；不能视为逐年精确战线 |
| 中文内容 | 古今地名、州郡、关隘、河流、运河、道路、人物行迹 | 能显著补充中文地图语境 |
| API | `atlasAPI.locate/inspect/resolvePlace/openPerson/search` 与本地 MCP | 可供稿件地名解析和地图选景使用 |
| 镜头 | 原生 Mercator 投影、SVG 相机、缩放时标签布局 | 直接用于视频运镜；我方动作跟随同一矩阵 |
| 视频导出 | 未提供公共 `seek(frame)` 或视频导出 API；内置 CLI 主要做截图/查询 | 本轮桥接补充逐帧驱动与编码 |
| 离线 | 本地地图资产可用；原页面还请求 Google Fonts 与统计脚本 | 本轮阻断外网请求，以本机字体渲染；没有在线瓦片依赖 |

官方接口说明见 [`llms.txt`](https://github.com/DeanChensj/jiangshan-map/blob/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a/llms.txt)。相机和字体策略见 [`docs/camera-performance.md`](https://github.com/DeanChensj/jiangshan-map/blob/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a/docs/camera-performance.md)，其中性能数字是上游特定环境的结果，不能当成本项目导出性能。

## 数据与查询需要修正的具体问题

这些问题影响自动制作时的可信度，不构成放弃其原生渲染的理由。

1. **导出丢失城市时间语义。** 上游 `export_geojson.js` 的 settlements 输出没有保留 `appear/vanish/capitalPeriods/eraNames/aliases`。1949 年以前 1,403 条朝代—城池记录中，149 条含出现/消失时间、46 条含首都时段、235 条含别名。不能把导出的城池表直接当成任意年份的有效地名表。原生页面保留并使用这些字段。
2. **同名地点仍会误解。** 本地浏览器实际查询 `inspect({year:208,place:'江州'})` 得到 `[115.98,29.71]`、`resolvedName:'琵琶亭'`，并未按汉代巴郡江州定位重庆。1102 年同名查询也指向这一地标。自动制作必须给明确地点身份/区域并核实，不能只相信“零坐标查询”宣传。
3. **覆盖不是所有地点。** 实测 1934 年“瑞金”未解析成功。缺失地点仍需已核实的补充地点库。
4. **无公元零年。** 实测 `year:0` 被原 API 转为 1，输入适配应显式拒绝 0，不能静默改年。
5. **阶段图不等于事件当年精细边界。** 例如前260年落入覆盖前278—前250年的一张战国阶段图，不能据此自动裁定战前战后每座城的控制权。战役行为和历史疆域必须分层表达。
6. **GeoJSON 覆盖与网页不同。** 官方导出截至 1948 年，不含现代省界、完整人物与地名溯源数据；不能误写为“全部网页能力已导出”。
7. **现代地形只是参照。** 上游地形实测是 2320×1560 的固定 WebP 栅格，不是随缩放自动加载的多级 DEM。采用其观感并不意味着局部精度或古代地形已获核实。

来源：[`export_geojson.js`](https://github.com/DeanChensj/jiangshan-map/blob/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a/scripts/export_geojson.js#L241)、[`app.js` 城池时间语义](https://github.com/DeanChensj/jiangshan-map/blob/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a/js/app.js#L2961)。本机浏览器结果保存于 `outputs/jiangshan-map-study-20261101/upstream-browser-inspection.json`。

## 许可边界

[上游 README](https://github.com/DeanChensj/jiangshan-map/blob/a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a/README_ZH.md#L215-L221) 明确写明：项目为 GPL-3.0，但由 CHGIS V6、Hartwell 衍生的府州郡边界和战国疆域保留学术、非商业限制。官方 GeoJSON 的统一 GPL 字符串没有保留这一例外，不能作为所有数据可商用的证明。

原始几何缺少逐要素来源与许可字段，仅关闭府县层也不能证明剩余全部数据可商用。现代省界、水系和地形等仍需记录各自来源依据。GPL 软件与输出视频的许可不能简单等同；视频使用了哪些地图内容，仍需按数据本身判断。

本轮产物限内部技术验证。正式公开视频应使用已确认允许相应用途的数据层，或取得必要授权/替换受限数据；**保留江山渲染和标注方法，与替换具体数据源并不冲突。** 没有对外发布、联系作者或开启生产默认。

## 已执行验证与可复现入口

- 上游 `node scripts/validate_atlas.js --fast` 通过：18 个时期、2,430 个年份检查、40 个 E2E CUJ。该快速模式不含全部拓扑和 MCP 子进程检查；不声称执行过完整套件。
- 官方 GeoJSON 导出实际成功，生成191个文件；用于能力和数据语义调查，不作为最终样片底图。
- 现有地图与动作相关57项测试通过；叠层单独浏览器检查包含军队移动、占领完成时点、坐标位移同步和同帧重复截图。
- 原生页面在外网请求被阻断后可渲染；浏览器无 JavaScript 异常。原生地图与叠层的联合乱序帧检查以 `native-v2/native-preview-evidence.json` 为准。
- 最终样片为 `outputs/jiangshan-map-study-20261101/native-v2/jiangshan-native-map-pilot.mp4`。成片实际尺寸、帧率、帧数、时长、音轨、文件哈希与原始资产哈希记录于 `native-v2/delivery.json`。演示旁白采用本地 macOS Tingting，不代表正式配音选择；本轮核查音轨与时间安排，尚未完成人工听审。军队避让新增回归测试后，动作与标签17项测试通过，组件定向 TypeScript 检查通过。

复现命令见 `scripts/jiangshan-map-pilot/README.md`。研发 checkout 当前位于 `/tmp/jiangshan-map-study-20261101`；可重新克隆并切到上述 SHA 后传入 `--source`，不依赖临时目录长期存在。

## 接入正式工厂还需要的工作

1. 把这套已验证的原生桥接包装为可复用地图后端，接收明确的年份、地点身份、镜头和动作计划，替代本次固定12秒示范。输出帧图或本地视频，交给现有工厂合成。
2. 旁白使用已锁定音频与对齐结果，将文字事件转为帧区间，统一驱动相机、行军、进攻、占领与字幕；不从动作名称猜测城市归属。
3. 向江山原生布局提供视频字幕安全区、军队/头像占位；本轮首先让军队避让原生文字的实际屏幕包围盒。
4. 建立逐层数据来源清单与可用数据包。原生画法优先保留，地理事实、示意控制与数据许可分别记录。
5. 用真实历史稿件验证多段路线、多阵营、退军、城池易手与疆域阶段切换；另外验证 9:16 与多镜头续接。本轮不能代替这些验收。

停止标准：当前交付研究结论、原生引擎可运行适配和带旁白短片，明确尚未完成通用生产接入；不把样片称为全部功能已经上线。

工具维护记录：Agent Reach 本机 v1.5.0，检查发现 v1.6.1 可用，未在此任务升级。需要更新时可使用：帮我更新 Agent Reach：https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/update.md
