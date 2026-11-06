# LatentSync 同步、嘴部失真与抖动诊断

日期：2026-11-05。用户反馈：同步、嘴唇及牙齿细节、抖动和自然度均不合格。本轮限定继续研究 LatentSync，不调用 Higgsfield，也不安装或启动替代模型。本文来自官方源码和作者讨论；下述实验尚未证明能修复本素材，不是质量验收结论。

## 已知基线

- 当前是 LatentSync 1.6 / 512，40 steps、DeepCache 关闭，权重已完整校验；提高 guidance 至 3.0 后 SyncNet 改善，但用户已否决其质量。原整片生产完成 14 段后停止，第 15 段取消，已有结果和检查点保留，不作为合格交付。
- 输入是用户新提供的 30 秒近景参考，正文约 728 秒；此前 5 秒固定开头独立拼接。输入、参数和历史样片见 [实测记录](science-latentsync-quality-validation-20261104.md)。
- `audioOffsetMs=0`、正文音频相关性或 SyncNet confidence 都不能证明每个音素、牙齿形态及自然度达标。
- 本次源码固定为 [`a229c3948406bc2cf6eaf4873e662e70c6a04746`](https://github.com/bytedance/LatentSync/tree/a229c3948406bc2cf6eaf4873e662e70c6a04746)。以下源码链接均指向该版本。
- 主任务已在远端逐项核对 `lipsync_pipeline.py`、`image_processor.py`、`affine_transform.py`、`audio2feature.py`、`mask.png` 的 SHA-256，与本机固定版本官方 clone 完全一致。因此不能把这些上游文件被本地改坏作为本轮已确认原因。

## 第一优先：先分清模型失真与几何损失

**源码事实。** [`AlignRestore`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/affine_transform.py#L11) 默认 `dtype=torch.float16`，对齐图像和仿射矩阵、逆变换和回贴 mask 均使用这一 dtype。矩阵求解中部分运算虽然为 FP32，交给 `warp_affine` 前仍转成 FP16。这与 UNet 的半精度推理是不同环节。

[`FaceDetector`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/face_detector.py#L47) 将 106 个关键点四舍五入为整数，[`ImageProcessor`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/image_processor.py#L61) 再将三个聚合点 round 一次。所谓 [`smooth=True`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/affine_transform.py#L136) 仅对归一化鼻点 bias 做 `0.2 * old + 0.8 * new`，没有平滑完整 scale、rotation、translation 或三点轨迹。

**待验证假设。** 高清坐标的 FP16 量化、连续两次 round 或逐帧关键点噪声可能造成重采样软化和定位抖动。下方往返实测支持部分几何误差存在，但尚不能将它判为模型口型、牙齿变形的根因。

**最小实验。** 先不运行 UNet，用完全相同的原帧和对齐矩阵做 align → restore 往返：比较现状与仅几何 FP32。保存源帧、aligned face、还原帧，量化非嘴部边缘漂移、局部差分、清晰度；同时导出逐帧矩阵的 scale、angle、translation。检测和轨迹保持一致，避免一次改动多个变量。若矩阵确有异常尖峰，再单独试浮点 landmarks 或保守的三点/相似变换轨迹平滑，避免平滑掉真实头动。

**已完成的无模型往返实测。** 取旧 E 组完全相同远端输入视频的前 6 秒，按 5 fps 抽样 30 帧，使用相同检测关键点分别做 FP16/FP32 几何对齐及还原，不经过 VAE 或 UNet。源视频 SHA-256 为 `b1028867af145290ecfcdd9f7037ae150b196a9a57b7d63b72c2d3656dcd6091`。逐帧矩阵、指标及源图/还原对照见 [`geometry/geometry.json`](../data/reports/science-latentsync-diagnosis-20261105/geometry/geometry.json) 和同目录 `roundtrip-*.png`。

| 脸部 ROI 指标均值 | FP16 | FP32 | 可以得出的结论 |
| --- | ---: | ---: | --- |
| PSNR | 44.18 dB | 45.76 dB | 往返像素误差的这一指标改善。 |
| 相邻抽样间残余位移变化 `phase_shift_delta_px` | 0.373 px | 0.096 px | 相位相关估计的残余位移波动减少；不是完整生成视频的抖动评分。 |
| Laplacian variance / 原图 variance | 0.604 | 0.564 | 比值下降，不能宣称变清晰；也不能仅以此单一指标评价全部观感。 |

这证明 FP32 几何值得继续对照，没有证明模型牙齿、嘴唇或音素对应已修复。30 帧低频抽样也不能代替原生 25fps 连续播放验收。

**社区证据边界。** 作者确认过输出降质，但没有给这段素材的诊断：[作者回复](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2582543908)。关键点抖动、重复提取和 Kalman 平滑的改善是[社区自定义实现经验](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2606254244)，不是作者已验证补丁。

## 第二优先：分开当前 target 与 UNet reference

**源码事实。** 训练 [`get_frames`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/data/unet_dataset.py#L68) 选择两个不重叠窗口，reference 起点与 target 起点至少相距 `num_frames=16` 帧。推理则在 [`lipsync_pipeline.py`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L397) 将当前 `inference_faces` 同时作为 masked target 和未遮挡 reference，再把其 latents 一起送入 UNet。[论文 §3.1](https://arxiv.org/html/2412.09262v2#S3.SS1) 讨论过视觉 shortcut：可见面部线索可能让模型弱化音频，但没有证明当前素材必须用闭嘴视频。

**待验证假设。** 当前参考素材的原口型可能通过未遮挡 reference 分支影响结果；仅改 CFG 可能以变形、泛白换来较强开口。训练/推理差异值得做隔离对照，但不能据此断言官方推理写错。

**最小实验。** 同一段约 6–10 秒中文音频、同一源片、seed、40 steps、guidance 1.5、cache-off，比较 offset 0 与 offset 16：仅 `prepare_image_latents` 的输入改为同人对齐 face 序列中偏移 16 帧的图像。先选姿态相近区间；越过尾部按已捕获 face 序列长度取模，并记录实际索引和偏移。基线也走同一 runner。

必须保持当前帧的 `masked_pixel_values`、`masks` 和 [`paste_surrounding_pixels_back`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L453) 输入不变。不能整体替换 `ref_pixel_values`，否则上半脸回贴也会换成另一时刻，造成错姿态和假改善。该实验不是官方现成 CLI 参数，应以实例级包装实现并保存改动脚本哈希。

## 已确认的后处理节奏损失

同一份旧 E / guidance 3 生成结果，原生 25fps 的前 6 秒为 150 帧，当前处理的 30fps 版本为 180 帧。嘴部 ROI 的相邻帧 MAD 阈值检查发现：原生版没有 MAD < 0.3 的相邻帧，30fps 版有 29 个；进一步逐帧匹配确认实际保持上一源帧 30 次，约每 6 帧一次。`fps=30:round=up` 带来相对源帧 0–33.33ms、均值 16.67ms 的保持延迟，没有累计增长。

两份 720×720 公开对照的有效音视频时长均为 6.000 秒，音轨解码 PCM 的 SHA-256 一致。可看[原生 25fps](http://localhost:3013/static/science-validation/diagnosis-20261105/E-native-25fps.mp4)和[当前 30fps](http://localhost:3013/static/science-validation/diagnosis-20261105/E-current-30fps.mp4)。方法、源码定位和限制见 [`cadence/README.md`](../data/reports/science-latentsync-diagnosis-20261105/cadence/README.md)，逐帧数据见 [`cadence-metrics.json`](../data/reports/science-latentsync-diagnosis-20261105/cadence/cadence-metrics.json)，媒体探测见 [`probes.json`](../data/reports/science-latentsync-diagnosis-20261105/cadence/probes.json)。

这确认后处理会损失动作节奏，不能说明生成阶段的牙齿、嘴唇、音素错误已解决。25fps 对照还绕过了 30fps 版已有的一次编码，不是只改帧率且编码次数完全一致的实验。最终圆窗仍会转换到主片帧率，单独修改主播存储帧率不足以消除成片重复帧。另已核实 `feature2chunks` 对 10 秒生成 252 帧，而现有流程裁为准确前 10 秒，不能把尾端两帧说成逐段累计漂移。

## 条件性定位：只有证据指向这里才继续改

**16 帧交界实测已完成。** 对已停止整片的两个原生 25fps 片段，各取前 30 秒，合计 1498 个转场、92 个窗口交界。交界嘴部 MAD 均值比内部高约 1%，中位数高约 28%，去除两端各 10% 后均值高约 13%；最大的 75 次嘴部变化全部在窗口内部。可能存在轻微交界不连续，但没有证据支持把主要问题归因于窗口拼接，暂不实施计算量更大的重叠推理。未补偿头动，像素差也不是独立的抖动评分。完整方法与数据见 [`window-boundaries/README.md`](../data/reports/science-latentsync-diagnosis-20261105/window-boundaries/README.md)。

| 环节 | 已核实事实 | 有价值的下一步 |
| --- | --- | --- |
| 16 帧窗口 | [推理主循环](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L387) 在 25 fps 下每 0.64 秒独立生成，无重叠，最后直接 concat；ref/masked VAE 每窗口 `.sample()`。 | 先检查抖动是否集中在 15→16、31→32 等边界。若匹配，再研究 16 帧/stride 8 的重叠预测，并在每个 denoising step 合并 epsilon、统一初始 latents、预编码 ref/masked。最终嘴型 crossfade 容易产生双嘴。 |
| 长窗口 | [配置](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/configs/unet/stage2_512.yaml#L97) 的 temporal position encoding 上限为 24。 | 不能无依据把 `num_frames` 改成 32/64；上游没有 `temporal_strength`、`motion_smoothing` 开关。 |
| mask 和回贴 | [预处理](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/utils/image_processor.py#L73) 用固定 mask 保留上半脸、遮挡下半脸；生成后先回贴周围像素，外层再逆变换、erosion 和 Gaussian blend，没有肤色匹配。 | 导出 aligned source、decoded before paste、after paste、restored full frame，定位牙齿失真和颜色接缝从哪一步出现。先定位，不默认换 mask。 |
| 音频特征 | [`transcribe`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/whisper/whisper/transcribe.py#L85) 实际只取 Whisper encoder embeddings，每 3000 mel 帧切块，不进行文字解码。 | 设置 `language=zh` 不会修复此链路。当前 UNet cross attention 是 384 维，不能直接把 tiny 换成 768 维 small。 |
| 特征与尾部 | [`audio2feature`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/whisper/audio2feature.py#L27) 按 `int(frame * 50 / fps)` 取上下文；`feature2chunks` 先 append，再判断 `start_idx > len(features)`。25 fps 下可能比实际特征时长多约 1–2 帧。 | 核验首尾和 30 秒请求边界；这不是全程音素错误的证据。不要据 offset 0 直接拉伸或整体平移音轨。 |
| 源片循环 | [`loop_video`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L281) 在视频不足时交替正放与倒放，复用 face 和矩阵。 | 分别检查循环转折、外层分段起点的动作跳变；它们与每个音素是否准确是不同问题。 |

## 不作为本轮“修复”的建议

- **不再单凭 SyncNet 分数选择生成设置。** 重点回看双唇闭合时机、圆唇、牙齿形态、嘴角颜色闪烁和下颌连续性，原尺寸及实际圆窗都需要看。
- **不默认加 GFPGAN。** 社区报告过[增强后嘴巴张不开](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2700386277)和[肤色接缝](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2883068384)。锐化不能恢复正确音素。
- **不把旧编码问题重新当成发现。** 作者已[确认提高 write_video 质量](https://github.com/bytedance/LatentSync/issues/67#issuecomment-2793463204)，当前固定版本包含该改进；不能直接搬旧 ComfyUI 修复说法。
- **不凭 issue 宣称微调已解决。** [闭唇音问题](https://github.com/bytedance/LatentSync/issues/28#issuecomment-2580142042)仍需本片复现；“扩大 mask 后微调 1000 步”的[社区反馈](https://github.com/bytedance/LatentSync/issues/28#issuecomment-3326176276)缺少完整配置和权重，不能等同于推理参数。

## 执行顺序与停止条件

1. 原设置整片生产已停止，保留 14 段结果和检查点。无 VAE/UNet 的 FP16/FP32 几何往返诊断已完成，证据支持残余位移更稳，不支持清晰度已提高。
2. F/G 的 6 秒短样片已完成，使用旧 E 组完全相同的远端 `406b9ab8242c42e0a78656dbce892fb9/input-video.mp4` 和 `input-audio.wav`。两组均为 40 steps、guidance 1.5、seed 1247、cache-off、几何 FP32，仅 F 为 reference offset 0、G 为 offset 16。已核对输入、runner、配置、pipeline、VAE、UNet 和 Whisper 哈希相同。F 耗时 451.017 秒，G 耗时 448.689 秒；元数据和原始最终回贴视频见 [`experiments/`](../data/reports/science-latentsync-diagnosis-20261105/experiments/)。没有恢复生产服务。
3. 只有抖动证据指向窗口或融合时，才进入对应实现；若模型 decoded face 本身仍有错误牙齿、闭唇和明显变形，明确报告此实验未解决，不再启动 12 分钟整片。

F/G 之间可隔离 reference 偏移的影响；旧 E 的 guidance 是 3.0，F/G 是 1.5，因此 E→F 不能作为仅改变几何精度的严格单变量结论。

**F/G 实际结果：未证明改善。** 两组按 5fps 抽取嘴部接触表，独立静态复核均未见 G 明显改善开口不足或软牙齿：仍以小幅开合为主，牙齿为偏软的浅色细带。少量帧有变化，但不够作为修复。静态接触表不能证明音素同步、动态抖动或自然度合格。可查看[左 F / 右 G 同音轨对照](http://localhost:3013/static/science-validation/diagnosis-20261105/FG-comparison-25fps.mp4)。公开对照统一为 25fps、前 150 帧、6 秒，并使用原正文音轨，不使用原始输出自带的有损音轨。

**下一条仅测素材差异。** 新近景参考按每秒一帧抽取整段 30 秒，几乎全程闭唇微笑，未见明显说话动作和露齿；旧 30 秒参考有大开口、圆唇、露齿和闭合。G 仍是在闭唇参考之间偏移，因此失败不能直接否定视觉参考压制的假设。但论文明确将当前帧作为推理 reference，不能将其判为上游实现错误；强制选张嘴帧也不符合训练的连续随机参考窗口。

H 沿用 F 的同一音轨和全部参数，仅把官方 `video_path` 换成用户旧说话素材 `hf_20261103_151740_4c28a4b3-a556-4230-b2b7-efe956f17faa.mp4`，不新增 reference 选择器。它只能回答旧素材是否更适用：景别、有效脸部像素与原始动作都变化，不能单独确定闭嘴是根因；开口变大也不等于同步变好。

**H 已完成，有局部改善，尚未合格。** 耗时 450.696 秒。远端输入与用户原文件的 SHA-256 均为 `7fabdefc46f4007f2eadf8485ee16195cfb8a13bc71d915a8c7eae46db67315e`；与 F 的音频、runner、pipeline、配置、VAE、UNet、Whisper 哈希相同，三个下载结果也均与各自元数据内的输出哈希一致。静态抽样及独立复核看到：H 开口更大，圆唇与露齿形态更丰富，牙列较 F 的浅色细带更容易辨认；但部分牙齿边界仍粘连、细节偏软，完全闭唇及闭合时机尚未验证。两组景别和裁剪不同，不能据此宣称严格清晰度提升。

可看 [H 独立样片](http://localhost:3013/static/science-validation/diagnosis-20261105/H-oldspeaking-25fps.mp4)和[左原素材 / 右同步后](http://localhost:3013/static/science-validation/diagnosis-20261105/H-source-vs-synced-25fps.mp4)。后一对照的左侧是旧素材直接配上正文，不代表其本来与正文同步。两侧均采用相同 `540:540:690:0` 裁剪、720×720、25fps、150 帧、6 秒和同一音轨；原文件完整保留，裁剪仅用于展示脸部。

## 同步检测与交付边界

官方 SyncNet CPU 检测使用已有且通过哈希验证的权重，没有修改模型。H 原素材和生成后的公开样片采用相同裁剪、帧率和音轨，比较结果如下：

| 对象 | Confidence | AV offset | 最小距离 |
| --- | ---: | ---: | ---: |
| 旧素材直接配正文 | 1.9156 | 7 帧 / 280ms | 13.9477 |
| H 同步后 | 6.7918 | 0 帧 / 0ms | 8.3913 |
| F 原始输出，供参考 | 6.8028 | 0 帧 / 0ms | 8.0797 |

H 相对“直接配音”有所改善，支持模型响应了音频，而不是只有原素材本来的说话动作。F 的检测对象是完整原始输出，H 是展示裁剪，不能把两者差值作为严格的素材优劣评分。分数及整体 offset 都不能证明普通话音素、闭唇、牙齿或动态自然度已达标，不据此平移正文音轨。

**本轮结论：保留 H 为候选，整片继续暂停。** 没有调用 Higgsfield，没有恢复已否决的 12 分钟生产任务或自动上传。25fps 和 FP32 目前仅用于隔离实验，未宣称生产合成的 30fps 重复帧已修复；G 的 reference 偏移也未接入生产。H 的局部改善不构成全部质量问题已解决的结论，不继续盲扫 CFG 或强制选择张嘴帧。

实验脚本共 18 项标准库单测通过，两个新诊断脚本编译检查通过。公开比较片的帧率、150 帧、音视频均 6 秒及解码音轨相同，已由 [`verify-comparisons.mjs`](../data/reports/science-latentsync-diagnosis-20261105/verify-comparisons.mjs) 实测，结果见 [`comparison-validation.json`](../data/reports/science-latentsync-diagnosis-20261105/comparison-validation.json)。这些检查保障比较可复现，不代替质量验收。

## 隔离实验脚本

新增 [`reference_experiment.py`](../backend/scripts/latentsync/reference_experiment.py)，放在现有 `api_server.py`、`verified_api.py` 旁，在当前远端 venv 运行。它校验现有 VAE、UNet、Whisper 权重后调用相同 loader，不启动 HTTP、不恢复生产 job。只支持最多 30 秒音频，关闭 DeepCache，不自动重试；已有 MP4 或同名 `.mp4.json` 都会拒绝覆盖。

```bash
python reference_experiment.py --video /path/reference.mp4 --audio /path/sample.wav --output /path/baseline.mp4 --ref-offset 0
python reference_experiment.py --video /path/reference.mp4 --audio /path/sample.wav --output /path/reference-offset16.mp4 --ref-offset 16
```

默认两组均为 40 steps、guidance 1.5、seed 1247。JSON 记录实际取模后偏移、每个窗口的 reference 索引、源码/脚本/输入/权重哈希及运行时间。offset 0 原样传递官方 reference 张量；非零 offset 从 `loop_video` 返回的合法对齐 face 序列取参考，只替换 `prepare_image_latents` 的参数。纯单测覆盖基线同一对象、尾窗、取模、target/paste 方法未改动及异常恢复；这些检查没有运行模型，也不证明画面改善。

`--geometry-dtype float32` 可独立比较仅几何 FP32：原 `loop_video` 执行前，将 restorer 的 dtype、fill_value、mask 转成 FP32，保持到回贴完成后恢复；UNet/VAE 权重 dtype 不变。默认 `float16` 不改变 restorer；几何和 reference 实验应分开进行，元数据记录该开关。与既有 E 组比较时需显式传 `--ref-offset 0 --guidance 3 --geometry-dtype float32`，并使用 E 的完全相同输入和 seed。

截至本次文档更新，F/G/H 均已完成，原始输出、参数、哈希、静态接触表和同步检测已落盘。G 未见明显改善，H 静态嘴形有局部改善但仍有缺陷；整片保持暂停，不宣称嘴部质量已修复或整片可继续生产。
