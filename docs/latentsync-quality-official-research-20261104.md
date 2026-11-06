# LatentSync 口型质量调研

调研日期：2026-11-04。本轮仅研究和只读核实，没有更改远端参数或启动新生成。

## 当前链路与结论

当前已是 LatentSync 1.6 和 `stage2_512.yaml`，因此“升级 1.6”不是本次可用的改进。优先验证关闭 DeepCache、提高采样步数，再针对张嘴幅度试调 guidance；不能许诺这些调整一定解决全部口型问题。

主任务实测提供的配置：远端 `api_server.py` 固定 `20 steps / guidance_scale=1.5 / seed=1247`，强制开启 DeepCache，`cache_interval=3 / cache_branch_id=0`。主播源片头为 5.05 秒、1920×1080、24 fps、HEVC、约 19.9 Mbps；目标正文约 12 分钟。它是高清画布，但有效脸部像素与嘴部纹理仍应单独检查。

此前样片 `bodyAudioCorrelation≈0.9999`、`audioOffsetMs=0` 只证明正文配音在合成中保留、未被整体挪动，**不能证明嘴型准确或自然**。相关本地证据：`data/reports/science-latentsync-20261104/audio-check.json`。

## 官方事实

| 项目 | 官方实际说明 | 对本次的意义 |
| --- | --- | --- |
| 1.5 与 1.6 | 1.5 引入 temporal layer、增加中文训练数据；1.6 将训练分辨率从 256 提高到 512，重点改善牙齿与嘴唇模糊。1.6 没有新模型结构或训练策略。 | 已用 1.6 不代表每个素材都自然；不能把 1080p 输入等同于 1080p 嘴部生成。 |
| 步数 | README 推荐 `inference_steps=20–50`，更高步数改善视觉质量、增加耗时。 | 当前 20 是范围下限，值得用 40 步做短片对照。 |
| guidance | README 推荐 `1.0–3.0`；提高通常增强口型准确性，但可能产生变形和抖动。作者在“控制口型幅度”问题中直接指向此参数。 | 嘴巴张不开可试 1.5→2.0；泛白、闪烁时继续升高可能更差。 |
| DeepCache | 官方推理代码把它作为可选加速；参数解析默认关闭，但 `inference.sh` 示例主动开启。合入 PR 明说缓存参数影响质量与速度。 | 当前强制开启需用关闭结果建立质量基线；尚未证明它是本片质量差的原因。 |
| 帧率与音频 | 官方 `read_video` 默认先用 FFmpeg 转 25 fps；`read_audio` 默认重采样为 16 kHz 单声道。 | 当前 24 fps 片头、48 kHz WAV 输入会被官方链路转换，不能仅据输入规格断言同步错误。 |
| 短视频扩展 | 官方 `loop_video` 在视频短于音频时，交替正放和倒放源视频，重复脸、框及仿射矩阵。 | 5 秒片头会反复正反循环。它能覆盖时长，但长篇身体动作的重复和倒放不自然无法靠增加采样步数消除。 |

出处：

- [官方 README：推理参数、显存需求与预处理](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/README.md#-inference)
- [官方 1.5 更新说明](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/docs/changelog_v1.5.md)
- [官方 1.6 更新说明](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/docs/changelog_v1.6.md)
- [作者回答：用 guidance_scale 调节口型幅度](https://github.com/bytedance/LatentSync/issues/190#issuecomment-2752274071)
- [官方推理代码：DeepCache、参数与模型加载](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/scripts/inference.py)
- [官方示例 inference.sh](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/inference.sh)
- [已合入 DeepCache PR #230](https://github.com/bytedance/LatentSync/pull/230)
- [官方读写媒体实现](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/util.py#L46)
- [官方正反循环实现](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L281)

## 社区报告与限制

1. **嘴角泛白与张嘴幅度存在冲突。** Issue #315 中，使用者报告 guidance 降到 1 可消除一部分泛白，但同步准确性下降；另一位报告开口幅度减小、口型变差。这是使用者报告，不是通用最优参数。作者在另一线程建议用 1.5 减少 flashes。
   [反馈一](https://github.com/bytedance/LatentSync/issues/315#issuecomment-3107503889)、[反馈二](https://github.com/bytedance/LatentSync/issues/315#issuecomment-3112503324)、[作者建议](https://github.com/bytedance/LatentSync/issues/277#issuecomment-2977173225)。

2. **静音闭嘴、闭唇音未必通过调参解决。** Issue #28 有静音仍张嘴和部分发音闭合不足的报告。后来的使用者说扩大 mask 后微调 UNet 1000 步有改善，但没有可复现训练配置或官方验证，不能据此直接改生产 mask。
   [闭唇音反馈](https://github.com/bytedance/LatentSync/issues/28#issuecomment-2580142042)、[微调声称](https://github.com/bytedance/LatentSync/issues/28#issuecomment-3326176276)。

3. **不要默认加 GFPGAN/CodeFormer。** GFPGAN 是社区建议，另外多位使用者报告增强后出现隔着牙说话、嘴巴难打开。官方推理流程未集成 GFPGAN 或 CodeFormer；超分辨率增强 PR #146 在本次查询时仍未合入。增强可改善锐度，不能证明恢复了正确音素口型。
   [建议](https://github.com/bytedance/LatentSync/issues/125#issuecomment-2782836307)、[负面反馈](https://github.com/bytedance/LatentSync/issues/125#issuecomment-2783384170)、[类似反馈](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2700386277)、[PR #146](https://github.com/bytedance/LatentSync/pull/146)。

4. **短 AI 素材是风险，尚非本片确诊。** Issue #220 中有使用者认为 AI 生成、过短的源视频会拖累效果，但之后也有人说官方 demo 仍有伪影。更长、稳定、清晰、脸部无遮挡的素材值得比较，不能引用成“真实录像必然解决”的官方承诺。
   [社区建议及后续反例](https://github.com/bytedance/LatentSync/issues/220#issuecomment-2816925919)。

5. **人脸跟踪抖动也可能影响观感。** Issue #67 中，使用者报告改进检测和 Kalman 平滑后得到改善；这是其自定义实现经验，尚无本片框/关键点的实测证据。
   [社区反馈](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2606254244)。

## 关于原素材口型的证据边界

[官方论文 §1、§3.1](https://arxiv.org/html/2412.09262v2#S3.SS1) 说明视觉线索可能构成 shortcut learning：模型利用嘴周肌肉、眼睛和脸颊推测口型，忽视音频；SyncNet 监督与固定全脸 mask 用于缓解。推理参考帧来自当前帧。

因此源素材表演值得检查，但论文**没有证明**当前 1.6 必须用闭嘴素材，也没有给“正脸 15 度”“侧脸超过 30 度不可用”的官方阈值。本次不采信搜索结果中没有一级出处的角度数字、虚构 `temporal_strength`、`motion_smoothing` 等参数。官方对侧脸使用仿射变换处理，稳定正面素材只是保守实验建议。

## 最小有效对照方案

固定同一段约 10 秒的中文正文音频、主播素材、seed、mask、分辨率与导出链路，保存可逐帧比较的原始输出，不只观看缩小后的圆窗。

| 组别 | Steps | Guidance | DeepCache | 能回答的问题 |
| --- | --- | --- | --- | --- |
| A | 20 | 1.5 | 开 | 当前配置基线 |
| B | 20 | 1.5 | 关 | 是否因加速近似损失质量 |
| C | 40 | 1.5 | 关 | 更多采样是否改善嘴唇、牙齿和闪烁 |
| D | 40 | 2.0 | 关 | 增强音频引导能否改善开口/闭唇，是否增加伪影 |

人工比较开闭嘴时机、双唇闭合、牙齿形态、嘴角闪烁、下颌形变、循环转折；同时记录时长、显存和官方 SyncNet 的 confidence/AV offset。后两项是辅助指标，不能代替自然度观看；官方说明评测须遵循其仿射与音画对齐预处理。[官方评测说明](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/README.md#-evaluation)

若参数组仍不合格，再用同一音频比较更长、稳定、有效脸部像素充足的源素材；若依旧存在明显闭唇和牙齿缺陷，再评估替代模型或有数据支持的微调。以短样片的人眼结果决定生产参数，避免继续用整片反复试错。
