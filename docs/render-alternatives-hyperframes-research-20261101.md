# HyperFrames 与 video-shotcraft 渲染调研

调研日期：2026-11-01。范围仅为公开官方源码和文档；未安装依赖、下载媒体、运行基准或修改生产任务。

## 结论

- HyperFrames 是 `heygen-com/hyperframes`，官方站点为 `hyperframes.heygen.com`。它是独立的 HTML 视频框架，底层仍由 Chrome 逐帧合成，再交给 FFmpeg 编码，不能据此保证比当前 Remotion 更快。
- `Vincentwei1021/video-shotcraft` 是镜头资产、创作流程和编辑工作台，核心渲染继续使用 Remotion。引入它可以改善效果制作效率，不会自动消除浏览器逐帧渲染成本。
- 对我们的长历史素材视频，优先保留现有文稿、时间轴、字幕、素材引用、任务与文件生命周期，让普通裁剪、拼接、缩放、定格、字幕和混音走 FFmpeg；复杂地图、程序动效和特殊镜头才使用 Remotion。此项是架构建议，并非本次已经实施的改造。
- 已切换硬件编码的当前 Remotion 应作为新的实际基线。此次未做相同素材、画质、分辨率、帧率、机器负载下的对照，不能承诺迁移框架的加速倍数。

## 固定版本

| 项目 | 本次核验提交 | 提交时间 UTC | 许可与维护证据 |
|---|---|---|---|
| HyperFrames | `e5887959bb7c23c45ea56d44d9e6f0929de4eb3d` | 2026-11-01 09:47:43 | Apache-2.0；本提交为复制进度停滞错误修复，仓库未归档 |
| video-shotcraft | `1266a3ec4831289c4d893d42dd5102723658039a` | 2026-10-29 16:17:26 | Apache-2.0；本提交更新音效来源和声音流程，仓库未归档 |

提交来源：[HyperFrames 提交](https://github.com/heygen-com/hyperframes/commit/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d)、[video-shotcraft 提交](https://github.com/Vincentwei1021/video-shotcraft/commit/1266a3ec4831289c4d893d42dd5102723658039a)。仓库许可不替代其依赖、字体或音视频素材各自的许可；video-shotcraft 使用 Remotion，仍需适用 Remotion 的许可条件。

检索先按 `agent-reach` 的 GitHub / gh 路由执行。现有 gh 认证返回 HTTP 401，随后用公开 GitHub REST API 和固定 SHA 的 raw 源码读取；没有修改凭证。

## HyperFrames

### 实际渲染与加速路径

官方明确说明两者均使用 headless Chrome 和 FFmpeg；主要创作模型差异是 HTML/CSS/可 seek 动画与 React 组件，而不是一个使用 GPU、另一个只能使用 CPU。[README 架构与比较](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/README.md#L246)

`@hyperframes/engine` 基于 Puppeteer，驱动页面逐帧 seek、截图和 FFmpeg；提供浏览器池、截帧、流式编码、视频帧提取和 frame-range 并行协调。更高层的 CLI / `@hyperframes/producer` 包装这些服务。不能把页面编辑 SDK 或技能包本身视为更快的渲染器。[engine README](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/README.md#L15)

真实可辨认的优化包括：

| 机制 | 源码证据 | 对我们的意义与边界 |
|---|---|---|
| 流式编码 | 截图 buffer 经 `image2pipe` 写入 FFmpeg，平行 worker 的帧先重排 | 减少中间截图落盘和回读，利于磁盘；截图、浏览器合成和图片解码仍存在，也不是 Remotion 独有机制 |
| 编码器探测与硬件编码 | 枚举 FFmpeg 编码器，再运行一帧可用性探测；Mac 映射 VideoToolbox | 主要缩短编码部分，不等于地图、DOM、字幕、seek 和截帧全部在硬件视频引擎上完成 |
| 快速截帧、静态去重与回退 | producer 保留 drawElement / screenshot / beginframe 路径及静态去重指标 | 是否适用取决于内容、平台、并发和保真门槛，不能推算通用加速倍数 |
| 草稿质量与并行 | CLI 支持 draft、帧率和 producer/engine worker 机制 | 降质量与加 worker 是不同变量；不能用更低画质结果与当前最终成片比较 |

固定证据：[流式编码与重排](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/services/streamingEncoder.ts#L3)、[截帧指标与回退说明](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/producer/src/services/renderOrchestrator.ts#L579)、[并发与 drawElement 的适用限制](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/producer/src/services/renderOrchestrator.ts#L2242)、[官方性能排查](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/docs/guides/performance.mdx#L20)。

### Mac 硬件编码的具体限制

- `gpuEncoder.ts` 将 VideoToolbox 映射到 `h264_videotoolbox` / `hevc_videotoolbox`，属于真实实现，不只是 README 宣传。[编码器映射](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/utils/gpuEncoder.ts#L94)
- 它先查 FFmpeg 编译支持，再用一帧执行探测并缓存结果。[探测入口](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/utils/gpuEncoder.ts#L64)、[探测参数](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/utils/gpuEncoder.ts#L142)
- VideoToolbox 参数使用码率控制，并包含 `-allow_sw 1`。所以选择 VideoToolbox 路径不等于严格拒绝所有软件回退；验收仍须核实实际编码器、执行环境和结果。[码率与回退参数](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/utils/gpuEncoder.ts#L112)
- 底层 chunk 与 streaming 编码函数的 `useGpu` 默认值都是 `false`；只有调用方开启且探测返回编码器才走 GPU 分支，否则选择 `libx264` / `libx265`。这里核实的是底层函数默认值，不能据此断言所有 CLI/Studio 入口的最终配置。[chunk 参数与分支](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/services/chunkEncoder.ts#L286)、[streaming 参数与分支](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/engine/src/services/streamingEncoder.ts#L235)

官方有 macOS 桌面分发，本地 CLI 要求 Node.js 22+、Chrome/Chromium 和 FFmpeg。使用普通 CLI/producer 服务可以脚本化，不依赖操作桌面剪辑软件。[平台入口与要求](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/README.md#L29)

### 自动化、效果与本项目适配

官方 CLI 提供 `lint -> check -> render`；check 会打开浏览器检查运行、布局、动效与媒体问题。流式编码使用托管子进程及帧重排失败通知，producer 有资源清理和错误回退。这些证明具备自动化工程设计，不证明我们的跨日大批任务已经在它上面验收。[CLI 检查流程](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/docs/guides/rendering.mdx#L28)、[资源回收约定](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/packages/producer/src/services/renderOrchestrator.ts#L24)

HTML/CSS、GSAP、Lottie、Three.js、WAAPI 等可 seek 动画适合字幕、图表、路线地图和视觉解释层。它具备表达本项目效果的基础，但我们已有的 React 地图、镜头定格、字幕对齐、素材唯一性、验收及交付逻辑不会自动转换过去。[支持的动画模型](https://github.com/heygen-com/hyperframes/blob/e5887959bb7c23c45ea56d44d9e6f0929de4eb3d/README.md#L210)

对长片和磁盘，流式截图可减少临时帧 I/O，但视频提帧、浏览器代理、素材缓存、工程和成片依然需要生命周期管理。它不能代替我们的“文稿成功后释放采集媒体、上传成功后释放可重建成片、保留工程和发布证据”规则。

## video-shotcraft

### 核心渲染仍是 Remotion

线上 README 明确“由 Remotion 动画和导出”，Workbench 的编辑结果也由 Remotion 输出；工作台锁定 `remotion` / `@remotion/*` 4.0.484。它提供镜头配方、组件、截图和音频工作流，而不是独立替换 Remotion 的编码引擎。[创作入口](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/README.md#L30)、[Workbench 导出](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/README.md#L162)、[依赖版本](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/workbench/package.json#L23)

已核验的批量 demo 脚本直接调用 `@remotion/bundler` 和 `@remotion/renderer.renderMedia`。它会复用 bundle、跳过已有 MP4，并允许调整 concurrency / scale；这些能节省重复构建或重复制作，不能消除逐帧合成。该调用传入 H.264、CRF 20、JPEG 90，没有显式开启 `hardwareAcceleration`。其中 `chromiumOptions.gl = "angle"` 是浏览器图形配置，不是 VideoToolbox 编码开关。[脚本实现](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/workbench/scripts/render-demos.mjs#L14)、[实际渲染参数](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/workbench/scripts/render-demos.mjs#L62)

此结论限于核验的工作台、模板与 demo 路线，不声称仓库每个脚本都没有其他编码设置。当前本机安装文档为 104 卡，而核验线上 README 已为 124 卡 / 150 shots，本地说明不是线上最新能力清单。

### 剪映导出不是更快的无头渲染后端

它先通过 Remotion 渲染无字幕、无 BGM/SFX 的 `plate.mp4`，再以 pyJianYingDraft 构建剪映原生轨道。镜头内复杂运镜、粒子和 3D 已烘焙到底片；字幕、音频和镜头切分才继续编辑。该路线增加底片渲染和草稿媒体打包，不能作为“绕开 Remotion 合成”的加速理由。[分层与底片流程](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/references/jianying-export.md#L16)

官方指南称 macOS 剪映专业版 11.2 验证通过，Windows 实现未真机验证；Mac 需要处理媒体沙盒访问和设备指纹，并要求安装草稿前退出剪映。剪映打开后会加密升级草稿，不能保证可逆读回。这是编辑交接能力，和无人值守批量 MP4 生产是两种交付方式。[Mac 支持及限制](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/references/jianying-export.md#L11)、[安装与打包](https://github.com/Vincentwei1021/video-shotcraft/blob/1266a3ec4831289c4d893d42dd5102723658039a/references/jianying-export.md#L147)

### 适合借鉴的能力

适合借用经过调校的 2.5D 运镜、字幕、转场、文字效果、节奏与声音设计方法，提高少量重点镜头的质量。它主要面向产品宣传片，不能直接替换我们长历史片的史实地图、全文配音对齐和批量交付服务。镜头更复杂还可能增加渲染负载，不能把创作效率提升等同成片运算提速。

## 对当前决策的建议

| 目标 | 选择 |
|---|---|
| 尽快提高现有长片吞吐 | 先使用当前已实现的硬件编码；按真实日志继续区分浏览器合成、编码和通道排队 |
| 大量素材切片、字幕和混音 | 从既有 plan 生成 FFmpeg 常规编辑任务，保留复杂镜头的 Remotion 输出接口 |
| 提升地图和少量解释镜头效果 | 继续使用现有 Remotion；选择性借鉴 video-shotcraft 动效，不更换整个工厂 |
| 独立 HTML 模板或新的创作体验 | 可以考虑 HyperFrames，但应作为另一个可选 renderer，而非立即迁移全部历史任务 |
| 长期降低磁盘 | 生命周期策略与 renderer 解耦；保留脚本、plan、字幕、必要素材引用、发布确认和回收状态 |

停止条件：已核实项目身份、底层引擎、Mac 编码路径、自动化边界、效果模型、许可和维护提交；不对未经实测的速度、稳定性或迁移工作量作数量承诺。
