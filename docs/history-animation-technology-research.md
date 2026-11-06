# 历史视频地图与兵器动画技术调研

调研日期：2026-10-24。本文区分官方已记录的能力、实现建议和本次尚未验证的事项。

## 结论与选型

可以程序化生产这类动画。对当前项目，建议以现有 Remotion 为地图动画和最终合成主线，Blender + Python 负责需要三维空间、器械结构与材质的镜头。无需把全部镜头统一到一种工具。

| 目标画面 | 优先方案 | 适用原因 | 主要投入 |
| --- | --- | --- | --- |
| 行军路线、夹击、包围、撤退、疆域分阶段变化 | Remotion + SVG/GeoJSON，按需引入 D3 | 易于按旁白逐帧控制，直接复用本项目 | 历史地点和路线数据、图层与时间轴模板 |
| 倾斜地图、山地与河谷关系 | 简单镜头用山体阴影底图加图层；真实三维用 Blender + DEM，或 MapLibre 地形 | 根据镜头是否需要真实视差选择实现 | 高程数据、投影一致性、地形裁剪 |
| 兵器拆解、剖面、机构运动、城池攻防空间关系 | Blender + Python | 可控制部件、镜头、光照、材质与关键帧 | 准确模型和机构结构，首次资产制作成本较高 |
| 网页中可旋转的兵器或交互沙盘 | Three.js | 浏览器交互和模型动画支持成熟 | 交互开发；输出视频还需逐帧采集 |
| 编辑人员手动制作地图视频 | After Effects + GEOlayers 3；或 GEOlayers.app | 现成地图设计、标注和动画工作流 | 软件、服务及地图素材授权，自动化接口另行核实 |

表中的优先级和投入是结合当前代码库的工程判断，不是速度或成本基准测试。这里同时涵盖兵器机构演示与兵棋式部队推演；后者如只复述已知战役过程，可以由明确时间轴驱动。若要让系统计算交战结果，则另需规则、参数与验证，不能把动画本身当作推演引擎。

## 二维地图与战役动画

### Remotion + SVG/GeoJSON：当前最适合先投入的路线

Remotion 官方要求动画由 `useCurrentFrame()` 驱动，避免以 CSS 动画或真实时间定时器控制，以保证各帧单独渲染时状态一致。[M1] D3 的 `geoPath` 可以将 GeoJSON 转换为 SVG 路径或 Canvas 绘制结果。[M2] 两者组合可以把地理数据、路线与部队状态组织成按帧确定的画面。

可实现的模板包括：多条行军箭头依次展开、部队符号沿路线移动、进军和撤退分段播放、会师与包围、城市易手、按年份或战役阶段切换势力区域。疆域变化应依据对应时点的区域数据做切换或有说明的过渡，不能依靠任意形变生成历史边界。这些是基于上述能力和现有代码的实现建议，并非本次已交付的模板。

地图不一定需要实时在线服务。对固定视频镜头，可以预先准备有授权的底图或山体阴影图，再叠加同一投影下的地点、路线、区域和文字，减少渲染时的网络依赖。仅将平面图倾斜或分层移动属于视觉上的 2.5D；需要山谷遮挡、真实视差或绕山观察时，应使用高程网格或三维地形。

### MapLibre：地理底图与三维地形的扩展选择

MapLibre GL JS 官方列出矢量瓦片、样式、地球、三维地形、建筑挤出与自定义三维图层等能力。[M3] 官方的 Animate a line 示例演示逐帧更新 GeoJSON 数据来展开路线。[M4]

如果接入 Remotion，不能直接照搬示例中的 `requestAnimationFrame` 播放循环：需要改为由视频帧号计算状态，并等待地图资源和对应画面准备完成。MapLibre 是渲染库，不包含免费无限使用的底图、卫星影像或高程服务；这些数据的获取、缓存及视频使用授权需分别确认。本次未安装 MapLibre 或验证它在当前 Remotion 版本中的渲染表现。

### GEOlayers：现成的可视化制作工具

GEOlayers 3 官方产品页说明可在 After Effects 中设计地图、标注地点、绘制地理要素、制作路线动画，并提供脚本 API；其三维景观工作流还涉及额外插件。[M5] GEOlayers.app 提供浏览器内的地图设计、地理数据导入、路线和标注及视频导出。[M6]

浏览器版本的官方定价页当前将免费档列为非商用；专业档及工作室档有各自的画幅、时长和商用范围。[M7] 因此它适合快速手工试片或团队编辑制作；是否能满足本项目的批量生成，需要进一步确认 API、导出与授权。没有核实到即可依赖的公开批量渲染 API，不能因为有网页导出按钮就认定可直接自动化接入。

## 三维地形与兵器动画

### Blender + Python：适合成片中的三维镜头

Blender 的官方命令行支持 `--background` 无界面运行、`--python` 执行脚本、`--render-anim` 渲染动画；Python API 提供 `keyframe_insert()`。因此可以编写脚本生成几何体、组织已有模型、设定镜头与关键帧，再批量输出帧序列，作为视频流水线的素材输入。[B1][B2]

适合的历史镜头包括：山口与峡谷的地形关系、城池与攻城器械的空间关系、兵器部件分离展示、机构动作分阶段演示。建议让 Blender 负责三维画面，字幕、地名与讲解标注在最终合成层完成。这里是技术方案判断，本次未制作上述镜头样片。

Geometry Nodes 的 Instance on Points 可以在点上重复放置同一几何体，而不重复底层几何数据，适合程序化布置军阵符号、营帐、船只等重复资产。[B3] 它解决重复布置问题；真实人物动作、服饰细节及大规模群体互动仍需单独的模型、绑定与动作资产。

### 真实地形：DEM + BlenderGIS

BlenderGIS 的项目 README 明确支持 Shapefile、栅格图、GeoTIFF DEM、OpenStreetMap XML，以及地理参考、地形网格和 SRTM 高程数据获取。[B4] 可将 DEM（数字高程模型）变成地形，再叠加经过考据的古城、关隘、路线与部队符号。

建议先在 GIS 工具中裁剪研究区域、核对坐标系，再进入 Blender。现代 DEM 只能提供现代地貌依据；古河道、海岸线、城池位置与历史道路需要额外史料。插件 README 声明最低 Blender 版本，并不构成其与本机版本兼容的证明；本次没有安装或运行 BlenderGIS。在线高程服务可能需要 API key，README 特别注明 OpenTopography 自 2022 年起要求 key。[B4]

### 兵器机构：先建立可解释的结构，再做动画

已有可靠模型时，可以按部件组织、设置旋转轴和关键帧，做拆解、剖面、透明外壳与动作顺序展示。若只有图片，仍需要建模和结构核实；代码不能自动补齐可靠的历史结构。以固定时间轴控制动作通常更便于配合讲解，这是制作建议，并非已完成的工程验证。

Blender 有刚体和约束模拟，但官方也记录了步数、迭代、物体尺度等对稳定性的影响。[B5] 视觉上合理的动作不能直接证明真实射程、受力或性能；涉及定量结论，需要有来源的参数与适当的物理模型。

### Three.js：适合网页预览与可交互演示

Three.js 提供 glTF 模型加载和动画系统。[B6][B7] 可作为浏览器中的地形沙盘、可旋转兵器展示和镜头预览方案；如果最终目标是视频，还需设计固定帧率的采集与编码流程。建议以 Blender 作为需要精细资产制作与离线渲染的工具，以 Three.js 作为需要网页交互和即时预览的工具。两者可以通过 glTF/GLB 资产衔接，但材质与动画是否完整保留需针对具体资产测试。

### 许可与尚未验证事项

Blender 官方说明：软件可商用，生成的作品不因 Blender 的 GPL 自动成为 GPL 作品。[B8] 外部模型、贴图、地形和地图数据仍各自受其授权约束。

外部能力通过搜索服务返回的官方文档、产品主页及项目 README 索引核对。Jina Reader 请求超时，备用 web-reader 后端未配置，Blender 官方文档直接读取遇到访问验证；没有据此宣称通读全部文档、插件兼容性已验证或动画已渲染。

## 历史数据与素材

Natural Earth 官方声明其地图栅格和矢量数据属于公共领域，可以用于商业作品。[M8] 这类现代地理数据可以提供部分底图信息，但不能自动提供特定朝代的疆域或战役路线。历史地点可参考 CHGIS/TGAZ 等资料；例如 TGAZ 的一个地名记录明确标注 CC BY-NC 4.0，不能推定可直接用于商业视频，应按具体数据集和用途核对。[M9]

每个地图镜头至少需要整理：时代和事件阶段、地理范围、地名与坐标、路线经过点、部队或区域状态、对应旁白时间、史料来源，以及哪些内容只是示意。坐标来源与路线史料来源要分别记录；现代城市坐标只证明点位，不证明古城址或两点间的行军道路。

每个兵器镜头至少需要：可靠的外观和结构参考、部件划分、运动轴或连接方式、需要解释的动作阶段。精细文物复原通常还需要已有模型或人工建模修整；程序化基础几何更适合原理示意，不能承诺仅凭名称就得到准确复原。

## 当前项目与本机验证

本项目已经有可复用的动画基础，以下是代码检查结果，不代表本轮已运行这些合成或验证画面质量：

- `remotion/src/EpisodeShowcase.tsx:968` 的 `MigrationMapScene` 包含路线逐步展开、移动标记、地点标注和镜头平移缩放；同文件 `TradeFlowMapScene` 包含贸易流向地图。
- `remotion/src/WarMapParallaxDemo.tsx:587` 的 `WarMapScene` 包含两条路线、两组部队标记及分阶段时间控制；已在 `remotion/src/index.tsx` 注册为合成。
- `remotion/src/reference-editorial-core.ts:3` 已有路线坐标、展开时间、标记、`historyStatus` 和 `coordinateSource` 字段，可延续其史料来源与示意状态的记录方式。
- `backend/src/services/remotion-planner.ts:404` 已有地图镜头规划，但包含针对特定叙事的规则。扩展成通用战役模板仍需独立的事件和部队时间轴设计。
- `remotion/package.json` 已包含 React 与 Remotion；没有据此宣称已经安装 D3、MapLibre 或 Three.js。

本机 `blender --version` 返回 Blender 5.2.2 LTS，`ffmpeg`、`node` 可执行文件存在。实际成功执行了下面的无界面 Python 检查：

```sh
blender --background --factory-startup --python-expr 'import bpy; print("HISTORY_ANIMATION_BPY_OK", bpy.app.version_string); print("RENDER_ENGINE", bpy.context.scene.render.engine)'
```

输出包含 `HISTORY_ANIMATION_BPY_OK 5.2.2 LTS` 和 `RENDER_ENGINE BLENDER_EEVEE`，进程正常退出。这证明当前机器能够后台执行 `bpy`；本次没有渲染三维帧或视频，未测试 GPU 渲染、性能、复杂模型、插件或生产流水线接入。

Remotion 的使用许可还需按组织规模与使用方式判断，不能把已有依赖等同于任意使用场景都免费。[M10]

## 建议的第一轮试片

先用两个短镜头验证最主要的能力，无需先建设通用三维平台：

1. 约 20 秒地图推演：两军进入、一路绕行、形成夹击、撤退，加入山河底图、地点和阶段文字；采用明确标注的示意数据，先检验可读性、时间控制和复用方式。
2. 约 10 秒兵器原理示意：使用有来源的器械模型，依次展示整体、部件拆解和一个动作周期；先检验模型是否准确以及后台渲染和合成能否走通。

推荐生产流程：整理史料与旁白时间点 → 编写镜头数据 → Remotion 生成地图 / Blender 生成三维素材 → Remotion 或 FFmpeg 合成字幕、旁白与成片。Blender 优先输出图像序列，按镜头需求选择是否包含透明通道，再统一合成；不预先绑定一种特殊视频编码。

试片完成后再判断是否需要 MapLibre 的在线地图、Three.js 的交互预览或更多兵器模型。本次交付范围是选型调研与本机后台执行可行性核验，未安装新软件、修改业务代码或制作样片。

## 地图与视频部分一手来源

- [M1 Remotion：Animating properties](https://www.remotion.dev/docs/animating-properties)：按视频帧驱动动画。
- [M2 D3：Paths](https://d3js.org/d3-geo/path)：GeoJSON 到 SVG / Canvas。
- [M3 MapLibre GL JS 官方项目页](https://maplibre.org/projects/gl-js/)：地图、地形、地球与三维图层能力。
- [M4 MapLibre：Animate a line](https://maplibre.org/maplibre-gl-js/docs/examples/animate-a-line/)：可查看运行示例及源码。
- [M5 GEOlayers 3 官方产品页](https://aescripts.com/geolayers/)：After Effects 地图工作流和脚本 API。
- [M6 GEOlayers.app 官方主页](https://geolayers.app/)：浏览器制作与视频导出，含可打开的示例项目。
- [M7 GEOlayers.app 官方定价页](https://www.geolayers.app/pricing.html)：非商用与商用档、分辨率及片长限制。
- [M8 Natural Earth：Terms of Use](https://www.naturalearthdata.com/about/terms-of-use/)：公共领域及商业使用。
- [M9 复旦 TGAZ 地名记录示例](https://tgaz.fudan.edu.cn/tgaz/placename/json/hvd_23611)：数据内容和该记录标注的许可。
- [M10 Remotion：License & Pricing](https://remotion.dev/docs/license/pricing)：组织规模、商业使用和自动化用途的许可要求。

## 三维部分一手来源

- [B1 Blender 4.5 LTS 命令行参数](https://docs.blender.org/manual/en/4.5/advanced/command_line/arguments.html)：后台执行、Python 脚本与动画渲染。
- [B2 Blender Python API：bpy_struct](https://docs.blender.org/api/current/bpy.types.bpy_struct.html)：`keyframe_insert()` 等关键帧接口。
- [B3 Blender 手册：Instance on Points](https://docs.blender.org/manual/zh-hans/dev/modeling/geometry_nodes/instances/instance_on_points.html)：几何实例化能力。
- [B4 BlenderGIS 项目 README](https://github.com/domlysz/BlenderGIS)：GIS 格式、地形、高程服务及 API key 要求。
- [B5 Blender 手册：刚体模拟提示](https://docs.blender.org/manual/en/latest/physics/rigid_body/tips.html)：模拟稳定性与动画交接。
- [B6 Three.js：GLTFLoader](https://threejs.org/docs/#examples/en/loaders/GLTFLoader)：glTF 模型加载。
- [B7 Three.js：Animation System](https://threejs.org/manual/en/animation-system.html)：浏览器中的模型动画系统。
- [B8 Blender 许可](https://www.blender.org/about/license/)：软件与创作产物的许可边界。
