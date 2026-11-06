# 剪映自动化方案与 Remotion 的适用性

调研日期：2026-11-01。目标环境：M1 Mac，批量历史视频，包含素材视频、图片、字幕、解释图、地图和 TTS。仅阅读官方仓库 README、文档及源码，未安装、克隆、下载媒体或做速度对比。

## 结论

这两个项目目前都不适合直接替换本机 Remotion 的无人值守 MP4 主流程。它们主要提供剪映草稿编排，真正成片仍交给剪映桌面程序；所审查的自动导出路径均依赖 Windows GUI。Mac 能创建或导入草稿，不等于能在 Mac 上自动完成 MP4 导出。[C1][C2][C3][J1][J2]

它们适合补充“生成可编辑草稿，再在剪映精修”的工作方式。有额外 Windows 导出机器时，可以另建剪映生产分支；没有依据断言它们在本台 M1 上比已启用硬件编码的 Remotion 更快或画面更好。生成 JSON 草稿的耗时不能与渲染完整 MP4 的耗时直接比较。

## 固定版本

| 项目 | 审查 commit | 最新 commit 时间（UTC） | 仓库许可 |
|---|---|---|---|
| Hommy-master/capcut-mate | [`d573d18b04126a819cc37a29e50eefe76f81bb6b`](https://github.com/Hommy-master/capcut-mate/commit/d573d18b04126a819cc37a29e50eefe76f81bb6b) | 2026-11-01 10:10:34，更新文档 | [Apache-2.0][C6] |
| isYangs/jianying-editor-skill | [`b7225641d39a9cd354ec265e2f6101b009fa1b44`](https://github.com/isYangs/jianying-editor-skill/commit/b7225641d39a9cd354ec265e2f6101b009fa1b44) | 2026-10-15 07:50:53，合并 AI voiceover 接口 | [MIT][J6] |

以上时间来自当次 GitHub commit API，仅证明最近有提交，不代表稳定性或兼容性已经验证。代码许可不等于剪映客户端、会员特效、云音乐或其他素材的使用授权。

## 实际能力与限制

| 维度 | capcut-mate | jianying-editor-skill |
|---|---|---|
| 草稿与成片 | FastAPI 创建草稿、加素材和关键帧；`gen_video` 排队后调用剪映控制器导出，并可上传对象存储。[C1][C2] | Python/AI Skill 编排草稿；`auto_exporter` 调用 `JianyingController.export_draft`，不是独立编码引擎。[J1][J2] |
| 本机 Mac 导出 | `video_task_manager` 对非 Windows 直接返回“视频生成功能仅在Windows系统上可用”；Mac 桌面客户端不解除此限制。[C2] | README 明确“macOS 导出需通过 Windows Agent”；也可人工在剪映导出。[J1] |
| 无人值守条件 | Windows 上需要打开剪映、处于目录页，依赖 `uiautomation`、`pyautogui` 查找和点击控件。[C2][C3] | 同样使用 Windows UI Automation；包装脚本虽称 `Headless draft exporter`，实际会查找并激活剪映窗口。[J2][J4] |
| 批量与并发 | 草稿下载最多 3、上传最多 2，剪映导出通过 `export_video_lock` 全局串行。HTTP 异步提交不等于并行渲染。[C4][C2] | Windows Agent 每个请求新建线程，所审查入口没有导出锁或隔离的剪映实例；不能把多线程视为安全的并发导出。[J3] |
| 硬件加速 | 导出控制器暴露分辨率、帧率和超时，未提供可验证的硬件编码器选择。剪映自身是否启用硬件及其速度需要单独确认。[C5] | 导出同样由剪映 GUI 决定；没有该项目对本机 VideoToolbox 的导出证明。[J2][J4] |
| 版本依赖 | 依赖剪映 UI 控件和页面状态；所审查入口未给出当前所有剪映版本的兼容保证。[C3][C5] | README 要求自动导出使用 5.9 或更低版本；vendored 控制器注释写“6及以下”，文档边界不一致，应以明确验证版本为准。[J1][J4] |
| 历史视频表达 | 支持视频、图像、音频、字幕、关键帧、特效，适合模板化时间轴。[C1] | 支持相同基础编排及 TTS；HTML 动效先录成 WebM，再作为素材放入草稿，并不直接执行现有 Remotion 组件。[J1][J5] |

## 对当前流程的判断

1. 不宜用这两个草稿自动化项目直接替换当前 M1 本机成片入口。当前地图几何、时间轴、解释图、字幕和交付验收已经在 Remotion 中实现，切换到草稿格式仍需迁移这些表达和验证。普通镜头转向 FFmpeg、复杂镜头保留 Remotion 的建议见[整体选型](video-renderer-selection-20261101.md)。
2. 对模板字幕、剪映特效和人工精修，草稿输出有实际价值；它解决的是编辑入口，不能据此认定成片吞吐更高。
3. 外接 Windows 剪映导出属于新增执行环境。素材传输、草稿兼容、GUI 状态、串行导出、成片回传都进入总耗时与磁盘预算，不能只统计草稿生成时间。
4. 本次没有对两套方案作本机端到端速度或质量测量，不给倍速、并发吞吐或画质优劣结论。仓库中的效果描述与耗时提示不作为本项目实测。

## 一手证据

[C1]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/README.md#L13-L31
[C2]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/src/utils/video_task_manager.py#L486-L498
[C3]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/src/pyJianYingDraft/jianying_controller.py#L21-L33
[C4]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/src/utils/video_task_manager.py#L34-L38
[C5]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/src/pyJianYingDraft/jianying_controller.py#L544-L558
[C6]: https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/LICENSE#L1-L5
[J1]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/README.md#L16-L36
[J2]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/scripts/auto_exporter.py#L46-L78
[J3]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/scripts/core/windows_export_agent.py#L179-L207
[J4]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/scripts/vendor/pyJianYingDraft/jianying_controller.py#L85-L129
[J5]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/scripts/core/vfx_ops.py#L47-L59
[J6]: https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/LICENSE#L1-L13

补充关键位置：capcut-mate 的实际导出锁和 GUI 调用位于 [`video_task_manager.py:741-774`](https://github.com/Hommy-master/capcut-mate/blob/d573d18b04126a819cc37a29e50eefe76f81bb6b/src/utils/video_task_manager.py#L741-L774)；jianying-editor-skill 的窗口激活位于 [`jianying_controller.py:239-257`](https://github.com/isYangs/jianying-editor-skill/blob/b7225641d39a9cd354ec265e2f6101b009fa1b44/scripts/vendor/pyJianYingDraft/jianying_controller.py#L239-L257)。
