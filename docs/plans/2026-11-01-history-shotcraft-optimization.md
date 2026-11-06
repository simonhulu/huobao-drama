# 历史视频镜头与准备流程优化

用户已授权从 video-shotcraft 借鉴更好的镜头设计，并按既定方向优化。沿用 Remotion 与 required VideoToolbox，不迁移框架、不改正文或配音时间线。

## 视觉方向与范围

在现有暖金、深墨、文楷/毛笔字和全画面历史素材上调整镜头语言。保留现有设计 tokens，直接用已有制作素材验证，因此不另做产品宣传片的 UI styleframe。一个镜头只承担一个主动作，信息落定留阅读时间；不引入电子 BGM、抖动、全片倾斜或无法从单图得到的假 3D。

已从完整本地技能目录 `/Users/zhangshijie/.agents/skills/video-shotcraft` 解析 `gallery/api/library.json` 并读卡和对应 demo：

- `tension-camera-moves / slow-push-in`：采用二次加速 1→1.14 的克制推近、配套暗角及硬切释放，只给少量有紧张语义的重点镜头。
- `tension-camera-moves / pull-back-isolation`：借鉴减速后拉和终点静止的节奏，用于历史全景揭示；单张历史图片不复制 demo 的多卡熄灭与光晕，也不声称完整复刻该镜头。
- `canvas-materialize-moves / diagram-cascade`：借鉴连线先行 8 帧、信息顺次呈现和完成态停留；将树状假 UI 适配成计划已经明确的时间/关系图，不增加历史事实或关系。

参考源码：`demos/camera/tension-camera-moves/{SlowPushIn,PullBackIsolation}.tsx`、`demos/interaction/canvas-materialize-moves/DiagramCascadeBuild.tsx`。普通水平观察为项目自有适配，保留字幕及地图坐标，不称为参考卡复刻。

## 实施

1. 写纯镜头设计函数及回归，保证正文、帧数、音频、手工运镜与地图不变。只在新渲染入口应用，历史断点恢复不重新设计。
2. 区分时间线、关系、对比、引文的伴随信息排版，保留底层画面和字幕安全区，增加完成态停留。验证横竖屏长文本和分页。
3. 在顺序确定素材之后，有限并行独立补图；同一 runner 的任务共享两路补图。先测并发上限、断点保存、失败排空、未知请求不重提和素材去重，再实现。视觉匹配状态保持真实；本次不声称完成全库视觉索引。
4. 使用已有业务素材/配音制作小段可播放样片，保存真实编码器、抽帧和验收记录；只清理本轮可重建测试中间文件。新增样片不覆盖生产成片，不触发上传。
5. 检查运行服务是否处于安全更新窗口；当前生产不中断。渲染子进程每次直接读取新代码；后端优化需要确认当前进程的加载方式与任务状态后启用。

## 验收

先跑精确回归，再渲染短样片核验画面、字幕、声音、阶段计时和文件体积。视觉检查同时看入场、运动中和结束停留帧；不把测试通过当作审美通过。按 skill 尝试独立终检，记录服务或工具导致的实际验证限制。

不承诺未测量的整体倍速；记录本轮确实观察到的并发与产物结果。制作计划、下载素材、中间产物和最终产物仍归属各自任务，上传回执规则继续生效。

## 2026-11-02 实施与交付

已完成并在空闲窗口平滑重载后端：旧进程 9255 收到 SIGTERM 后正常退出，launchd 启动 97734，健康接口恢复 200。重载前 motion、上传和通用任务均无运行项，花生导出 activeProjects=0。新任务使用新流程；未重建或上传既有业务成片。

核心文件：

- `scripts/history-motion/shotcraft.mjs`：只替换自动生成的重复中心缩放；后拉揭示、水平观察、静止和一次重点推近；保留自定义镜头、地图、素材与字幕时间。
- `scripts/history-motion/render.mjs`：新渲染冻结设计并记录源计划 SHA-256；断点收尾复用已保存设计，旧断点保持原计划；不同源计划拒绝收尾且保留 partial。
- `remotion/src/HistoryCompanionGraphic.tsx`、`HistoryMotionFactory.tsx`：四类图解、连线先行、完成态停留、字幕字号与重点暗角。按标题及 label/detail/value 的实际内容预算分页，简短五代时间线同屏保留五项。
- `backend/src/services/history-motion-image-queue.ts`、`history-motion-pipeline.ts`：同 runner 的所有任务共享两个生图槽，地图头像也占此额度；失败停止同批未提交工作、排空已提交工作并逐镜保存，重试只补缺。最多检查三个候选，优先 sampled+usable；保留 uncertain 原始证据及手工 selection。

验证：后端 production、unique-assets、pipeline-speed 共 **51 项通过**，backend typecheck 通过；镜头、合成及渲染 **37 项通过**。排版调整后重跑涉及的 13 项通过，另以 Chromium 加载真实本地文楷字体检查四种图解 × 横竖屏 × 四类文本，共 **32 组通过**。独立审查发现的长 value 溢出已修复；没有只凭 CSS max-height 判定安全。

样片入口：`http://localhost:3013/static/remotion/shotcraft-preview-20261102/index.html`。全部使用原有配音和素材，未调用生图服务。`source-manifest.json` 记录每段所属原任务、原镜头和原始帧范围，`outputs/shotcraft-review-20261102` 保存抽帧、浏览器检查和独立审查。

| 样片 | 视频帧时长 | 文件大小 | 渲染入口总耗时 | 到画面绘制完成 | 最终编码/封装 |
| --- | ---: | ---: | ---: | ---: | ---: |
| camera | 26.8 秒 | 7.29 MB | 68.10 秒 | 55.14 秒 | 8.39 秒 |
| tension | 8.03 秒 | 2.16 MB | 25.18 秒 | 19.15 秒 | 2.18 秒 |
| graphics | 20.03 秒 | 5.36 MB | 69.81 秒 | 56.55 秒 | 7.34 秒 |

三段均验证真实 `h264_videotoolbox`、1920×1080、30fps、AAC 和上传体积预算。AAC 封装时长较视频帧时长多约 0.06 秒。浏览器从 3013 页面实际解码播放成功。最终编码/封装计时不是独立 CPU 编码耗时，不与重叠阶段相加。最终样片的可重建素材副本/打包缓存共自动清理约 **225 MB**；源素材、成片与证据保留。

素材审查还发现原 city-shot-21 使用近现代军服底片。仅在本次图解样片中，明确人工选择同一任务 city-shot-20 已有古代朝堂插画替换，并记录于 `manualSelections`；原业务任务未改。此修正不能证明自动选材已解决时代匹配问题。

范围限制：本轮未建立全库视觉索引，未做片内动作定位或迁移渲染器；两个槽的限制作用于一个 runner，非跨进程的全局供应商限流。并发回归验证了等待重叠与恢复行为，未用付费生产任务测量端到端倍速。抽帧和技术音轨检查不代表完整听审；独立报告单独记录无法验证项。

独立终检已完成：[报告](../../outputs/shotcraft-review-20261102/independent-review.md)。最终无剩余阻塞；核对了最终文件哈希、时间线保持、图解完成态和 tension f169→170 的硬切。未亲自试听、缺少 Gallery 动态参考、竖屏只做排版而未渲完整视频，均按无法验证记录。面板可能压暗部分人物面部，后续逐镜摆位仍有改进空间。
