# 科普片头到圆窗口播的连续动效

日期：2026-11-05。

## 实际效果

[R3 片头圆窗动效预览](http://localhost:3013/static/science-validation/intro-motion-20261105/R3-intro-motion.mp4)已生成，使用现有固定片头、4.8 秒正文主片及已生成的 R3 同步主播视频；不提交远端推理，不重做原任务，也不调用图像或视频生成服务。

片头最后 0.8 秒内，原片头视频继续播放，画面随缓动逐渐收拢，取景向主播头部靠近，移动到右下角，圆角逐渐扩大至圆形。正文第一帧在后方显露，并保持到正文音轨真正开始。片头结束后，圆窗在相同位置用 0.12 秒短溶接交给已经同步的正文主播；正文和字幕从原本的时间开始。位置、尺寸、取景和遮罩共享同一个 smoothstep 进度，起止速度为零。

固定片头为 5.05 秒，动效从 4.25 秒开始。成片视频为 1920×1080、25fps、247 帧、9.88 秒；音轨为 9.85 秒，完整保留 5.05 秒片头和 4.8 秒正文。30ms 的视频尾部差异来自 CFR 帧量化。抽取正文音轨与原主片比较，相关系数为 0.9999427，在正负 40ms 范围内的最佳偏移为 0ms；这是音轨放置检查，不是音素同步评分。

## 剪辑与实现依据

- Adobe 的[效果控件关键帧说明](https://helpx.adobe.com/id_id/premiere/desktop/add-text-images/insert-images-and-graphics/animate-layers-using-the-effect-controls-panel.html)说明位置、缩放、不透明度均可用关键帧控制，并可使用 Bezier、Ease In、Ease Out 插值。本次把同一主播画面连续移动到其长期停留位置，用缓入缓出连接两个构图。
- FFmpeg 官方 [`geq`](https://ffmpeg.org/ffmpeg-filters.html#geq) 支持逐像素 RGB、alpha、当前时间 `T`、坐标采样与 bilinear 插值。本次在固定尺寸画布上反向采样移动取景，并计算圆角矩形的有符号距离生成遮罩，避免滤镜输出尺寸变化导致重置。
- FFmpeg 官方 [framesync](https://ffmpeg.org/ffmpeg-filters.html#Options-for-filters-with-several-inputs-_0028framesync_0029) 和 [`overlay`](https://ffmpeg.org/ffmpeg-filters.html#overlay) 提供 `eof_action=pass`、`repeatlast=0`，让过渡层结束后正文继续。`tpad` 前显式恢复 `fps`，保证 AVTB 时间基的分支仍会按预期补帧。

## 代码与核验

- 修改 `backend/src/services/science-video-intro.ts`，渲染版本升为 4，读取版本 1、2、3 的来源记录并升级，不重复片头。完整主播合成走归位动画；没有同步主播的本地片头预览继续使用原来的预览路径。
- 修改 `backend/src/services/science-video-intro.test.ts`：真实像素验证片头红色区域面积持续减少、质心向右下移动，检查正文显露、后续圆窗口播仍运动、原声顺序、超短正文和旧缓存升级。全文件 19 项测试通过；最终取景参数微调后，运动专项测试再次通过。
- 新增 `backend/scripts/science-intro-motion-preview.ts`，可复用渲染并输出媒体和音轨放置检查、8 个时刻的截图及接触表。服务、测试、脚本的独立严格 TypeScript 检查通过。
- 新增独立视频时长校验：完整音轨不能掩盖画面提前结束。

运行：

```bash
cd backend
node run-tsx.mjs --test src/services/science-video-intro.test.ts
node run-tsx.mjs scripts/science-intro-motion-preview.ts
```

实际产物与核验记录在 `data/reports/science-intro-motion-20261105/`：`validation.json`、`transition-contact.jpg`，以及 4.20、4.40、4.60、4.80、5.00、5.12、5.40、6.20 秒截图。已静态检查完整运动路径及右下角位置；正常速度播放的主观自然度仍以用户审看为准。

本次没有改变原 12 分钟任务的暂停状态，也没有改变已有 LatentSync 样片的生成质量。固定片头与正文参考是不同拍摄构图，取景匹配及短溶接缓和了交接，不能保证两份素材的人物姿态完全相同。
