# 小鹭口型优化实测

日期：2026-11-04。任务：`science-a30b1bd7-0cfc-485e-9c17-63df16ff619e`。

2026-11-05 复核：用户明确反馈同步、嘴唇及牙齿画质、抖动和自然度均不合格。下述 E 设置已否决，不作为可用质量方案。原任务在第 15/25 段停止，14 段结果和全部检查点保留；远端该段推理进程已停止，未上传作品。后续仅继续排查 LatentSync，见 `docs/latentsync-failure-diagnosis-20261105.md`。

## 上轮试用设置（已否决）

- LatentSync 1.6 / 512，40 steps，guidance 3.0，DeepCache 关闭，seed 1247。
- 正文参考为用户新提供的 30 秒近景视频，项目副本为 `data/science-pop/assets/xiaolu-presenter-reference.mp4`。
- 5 秒固定片头继续独立拼接，保留原声；正文原配音驱动同步视频，右下角圆窗使用 closeup 取景。
- 参考内容和推理参数绑定 VERSION 5 缓存，原不合格结果及检查点保留，新生成不复用旧结果。

## 10 秒对照

A 到 D 使用同一新参考、同一正文前 10 秒、同一 seed。官方 SyncNet CPU 评估均找到一个人脸 track。

| 样片 | Steps | Guidance | DeepCache | Confidence | Min Distance | AV Offset | 生成及合成耗时 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| A | 20 | 1.5 | 开 | 5.9624 | 8.6242 | 0 ms | 322 s |
| B | 20 | 1.5 | 关 | 5.9156 | 8.7444 | 0 ms | 452 s |
| C | 40 | 1.5 | 关 | 5.9745 | 8.6614 | 0 ms | 715 s |
| D | 40 | 2.0 | 关 | 6.9452 | 7.8533 | 0 ms | 715 s |

旧 5 秒参考生成结果的正文前 10 秒为 confidence 6.0549、distance 9.0159、offset 0 ms。它包含参考素材及人脸尺度差异，不能将分数变化全归因于参数。

实测关闭缓存、增加步数没有明显提升同步评分；D 的音频引导提升有较清楚的同步收益。静态图中 C 牙齿仅略有改善，D 开口幅度仍偏小。

## 6 秒补测

| 样片 | Guidance | Confidence | Min Distance | AV Offset |
| --- | ---: | ---: | ---: | ---: |
| D 的前 6 秒 | 2.0 | 7.8568 | 7.2493 | 0 ms |
| E，直接生成前 6 秒 | 3.0 | 8.2557 | 7.2366 | 0 ms |

E 在相同时点的张口及圆口更清楚，也能回到近闭合状态。连续帧抽查未见明显新增嘴角泛白或身份漂移，牙齿仍偏软，口腔黑区边界略硬。

E 的输入是 6 秒完整音频，D 为 10 秒生成后取前 6 秒；音频上下文和生成长度不同，此补测不是严格单变量实验。6 秒指标不能直接与上表 10 秒指标排名。SyncNet 和静态帧检查不能证明自然度、每个音素或全片时序稳定已达标。

## 查看产物

- [四组 10 秒并排对照](http://localhost:3013/static/science-validation/quality-20261104/ABCD-comparison.mp4)
- [2.0 与 3.0 同段对照](http://localhost:3013/static/science-validation/quality-20261104/DE-comparison-6s.mp4)
- [采用设置的主播样片](http://localhost:3013/static/science-validation/quality-20261104/E-40steps-guidance3-presenter.mp4)
- [包含固定片头和圆窗的样片](http://localhost:3013/static/science-validation/quality-20261104/E-40steps-guidance3.mp4)

原始检查点、实测参数、耗时及官方评估 JSON 位于 `data/reports/science-latentsync-quality-20261104/`。选择 E 设置用于原任务后续生成，整片完成前不能宣称全片已通过质量验收。按短片实测，约 12 分钟正文在当前 3090 上预计需要十多个小时。

## 原任务恢复

2026-11-04 15:10 UTC 已重启独立 science 服务并通过 5683 端口继续原任务，`upload=false`。正文 728.066667 秒，共 25 段；第一段远端任务为 `39a5285d1bf846088e70db56d244deb0`，本机已确认 `in_progress`。

新检查点目录为 `presenter/c8728bee23b41a28379e87bab1381edf1c5dd83013e0cd07c9acf0856a0d20fe/`，核实其 VERSION 5、参考 SHA-256、40/3.0/cache-off/1247 与所选设置一致。此时整片尚未完成。

## 改动文件

- `backend/src/services/science-presenter-video.ts` 及测试：独立参考、推理设置、结果验证、缓存隔离和分段等待。
- `backend/src/services/science-video-intro.ts` 及测试：近景圆窗取景、下巴保留和缓存隔离。
- `backend/scripts/latentsync/`：可复现远端 API、设置校验、官方 SyncNet CPU 评估及说明。
- `backend/scripts/latentsync-quality-validation.ts`：四组真实对照生成。
- 本机私有 `backend/.env`：选择新参考、closeup 与 40/3.0/cache-off/1247。

## 验证

本轮服务实现已通过 34 项 TypeScript 测试、12 项 Python 测试和后端类型检查；实际执行了 A 到 E 的远端推理、结果元数据校验、下载和片头合成。官方评估代码及来源见 `docs/latentsync-quality-official-research-20261104.md` 和 `backend/scripts/latentsync/README.md`。
