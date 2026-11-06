# 四段说话参考的 LatentSync 短片验证

日期：2026-11-05。四组 LatentSync 推理、独立样片、单配音四宫格和 R2/R3 片头圆窗示例均已完成。用户随后接受了这轮效果；新任务生产参考切为 R3 原素材，参数和 FP32 人脸几何处理对齐样片。以下实验过程保留当时记录，原 12 分钟任务继续暂停。

## 实验条件

四份用户素材保存在 `data/science-pop/assets/xiaolu-speaking-20261105/`，原路径、SHA-256 和媒体信息见该目录 `manifest.json`。每份单独推理，不混合人物外观：R1 为独立外观测试；R2/R3 为正文候选；R4 含明显推进，仅作为运动镜头对照。

均使用同一份 `narration-4p8s.wav`，LatentSync 1.6 / 512、40 steps、guidance 1.5、seed 1247、DeepCache 关闭、几何 FP32、reference offset 0。原始完整输出为 `data/reports/science-latentsync-fourrefs-20261105/R{id}-40-g1p5-fp32.mp4`，同名 `.mp4.json` 记录推理参数及哈希。源码诊断和其他短片对照见 [诊断文档](latentsync-failure-diagnosis-20261105.md)。

R1 至 R4 对应用户提供文件的顺序，原文件均为 1280×720、24fps；R1/R2/R3 约 8 秒，R4 约 5 秒。原声不参与正文合成。四组元数据均为 completed，原始最终输出均为 122 帧、25fps；公开比较取准确前 120 帧。已逐项确认四组 audio、runner、pipeline、config、VAE、UNet、Whisper、image_processor、affine_transform、face_detector 和 mask 哈希一致，只有参考视频输入不同。

## 导出

[`latentsync-fourrefs-preview.ts`](../backend/scripts/latentsync-fourrefs-preview.ts) 只处理已下载结果，不建立 SSH、提交 GPU、恢复任务或修改生产配置。在 `backend/` 运行：

```bash
node run-tsx.mjs scripts/latentsync-fourrefs-preview.ts --case 3
node run-tsx.mjs scripts/latentsync-fourrefs-preview.ts --case 2
node run-tsx.mjs scripts/latentsync-fourrefs-preview.ts --all
```

`--case` 支持 1–4，`--all` 要求四组完整结果及元数据已齐。脚本检查 raw/source/audio/runner 哈希及素材 manifest；只接受恢复至源分辨率、带音轨的完整 MP4，不将 masked、decoded 或调试 PNG 当作成品。

每组居中裁为 720×720，仅取前 120 帧，按 25fps CFR 导出准确 4.8 秒，H.264 CRF 16。正文 WAV 单独编码一次 AAC 192kbps，再将同一音轨复制到四组短片及 2×2 对照；逐项检查解码为 48kHz 双声道 s16le PCM 后的哈希相同，包含相同的解码尾部 padding。源参考原声不会用于正文。

R2/R3 另用现有固定开头、`main-4p8s-25fps.mp4` 和 closeup 圆窗合成独立示例，正文主片的 ALAC 音轨会先与 WAV 做无损 PCM 一致性检查。片头示例含片头原声和正文，不属于四组纯正文短片的相同 PCM 比较。

已有导出只在来源、文件哈希和媒体验证均通过时复用；缺少 sidecar、来源变化或内容损坏会停止，不覆盖。检查结果写入 `data/reports/science-latentsync-fourrefs-20261105/preview-validation.json`，各输出另附同名 `.mp4.json`。

## 查看地址

- [统一审看页](http://localhost:3013/static/science-validation/fourrefs-20261105/index.html)。
- [R1 独立外观测试](http://localhost:3013/static/science-validation/fourrefs-20261105/R1-25fps.mp4)
- [R2 正文候选](http://localhost:3013/static/science-validation/fourrefs-20261105/R2-25fps.mp4)
- [R3 正文候选](http://localhost:3013/static/science-validation/fourrefs-20261105/R3-25fps.mp4)
- [R4 推进镜头对照](http://localhost:3013/static/science-validation/fourrefs-20261105/R4-25fps.mp4)
- [R2 片头圆窗示例](http://localhost:3013/static/science-validation/fourrefs-20261105/R2-intro-circle.mp4)
- [R3 片头圆窗示例](http://localhost:3013/static/science-validation/fourrefs-20261105/R3-intro-circle.mp4)
- [四组 2×2 对照](http://localhost:3013/static/science-validation/fourrefs-20261105/R1-R4-2x2-25fps.mp4)，排列为左上 R1、右上 R2、左下 R3、右下 R4。

以上文件均已生成；静态服务已实测返回 MP4。审看页在浏览器已加载出视频控件，连续播放的 UI 自动检查因本机自动化连接错误未完成；不据此宣称已观看全部动态效果。静态开口、牙齿细节、闭唇时机、音画同步及实际圆窗中的自然度仍需审看实际视频；哈希、帧数和导出检查通过不能代替质量验收。

## 已完成的观察与检查

四组及四宫格均已生成准确 4.8 秒、120 帧、25fps 的公开样片，解码音轨的 SHA-256 均为 `ed0c6487606fdb266daff931a2039faacaa48b33b1c9c6923a160fd1db987d1b`。R2/R3 另有约 9.88 秒的片头圆窗示例，保留原片头原声，正文从 5.05 秒开始。以原 WAV 对照片头示例的正文音轨，两组相关系数均为 0.9999427，在正负 40ms 搜索范围内的最大相关位置为 0ms。这个检查验证音轨拼接位置，不证明嘴形同步。

抽取 R3 片头过渡的第 125、129、134、140 帧，已确认原固定片头淡出、正文淡入和右下角圆窗渐入，截图见 `data/reports/science-latentsync-fourrefs-20261105/R3-transition-check.jpg`；正文中圆窗的全幅截图为同目录 `R3-intro-circle-check.png`。

R3 的五组分阶段静帧显示：嘴唇纹理和牙齿边缘在 decoded 阶段已软化，pasted/restored 没有在这些帧新增明显硬矩形接缝。R2 第 75 帧也可见源牙列清楚、decoded 牙列较软。不同正文要求嘴形改变，不能把与源口形不同本身判为错误；这些静帧也不能区分 UNet 生成与 VAE 重建各自的损失。详见 `data/reports/science-latentsync-fourrefs-20261105/R3-visual-review.md`。

官方 SyncNet 在原始全幅最终输出上用 CPU 检测，使用已验证的现有权重：

| 对象 | Confidence | AV offset | 最小距离 |
| --- | ---: | ---: | ---: |
| R1 | 7.9411 | 0 帧 / 0ms | 7.1886 |
| R2 | 7.0267 | 0 帧 / 0ms | 8.0339 |
| R3 | 7.0174 | 0 帧 / 0ms | 8.1739 |
| R4 | 6.9742 | 0 帧 / 0ms | 8.0083 |

检测 JSON 保存为报告目录的 `R1-syncnet.json` 至 `R4-syncnet.json`。整体 offset 为零不能证明每个音素、闭唇、牙齿或连续自然度达标。各素材的景别和面部尺寸不同，也不能把分数直接当成参考质量排名。原生产任务 `science-a30b1bd7-0cfc-485e-9c17-63df16ff619e` 仍为 `paused`、`autoUpload:false`；本轮没有改变生产参考、重启 API 或调用其他生成服务。

## 本轮交付与限制

四段已实际用于 LatentSync 推理。R2/R3 外观、构图较一致，保留为稳定正文候选；R1 单独展示，避免与既定主播外观混接；R4 的推进镜头可作为运动对照。抽样仍可见嘴部细节软化，尚无依据恢复 12 分钟全片。没有请求购买或生成更多参考素材。

新增可选阶段抓帧和两项单测，修改 `backend/scripts/latentsync/reference_experiment.py`、`test_reference_experiment.py` 和 `README.md`；新增 `backend/scripts/latentsync-fourrefs-preview.ts` 及本文。20 项 Python 标准库单测通过，导出脚本的严格 TypeScript 检查和实际 `--all` 导出通过。核验记录为报告目录的 `preview-validation.json`，逐个产物另附同名 JSON。静态页面、样片和素材均在本机文件与服务中可直接查看。
