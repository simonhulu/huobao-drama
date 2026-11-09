# MuseTalk 口型质量优化与实测

日期：2026-11-09。已在 3090 部署原生 25 FPS、FP16、音频条件提前两帧的
小鹭半身配置，107 已通过真实客户端完成生成、下载、归一与圆窗合成。
这是针对当前主播的时序校准；两段短片的同步指标改善，不代表每个音素、牙齿或
动态自然度已经达到真人水平。没有重新发表或覆盖原任务成片。

## 原因与修改

此前为提高速度只生成 15 FPS 口型，再由 107 转为 30 FPS。补帧不能恢复缺失的
嘴型状态，而且官方 1.5 的音频窗口在 15 FPS 下比 25 FPS 提前约 80 ms。
这是源码可证的条件窗口差异，不能直接等同于成片实际延迟；实际延迟另用样片测量。
官方 main 仍为已固定的 `0a89dec45a0192b824e3cf4daf96c239440c5ed8`，
更新 checkout 本身不会带来新的推理代码。

新参考从用户原始 `data/static/science-intro-preview/presenter.mp4` 的原生
25 FPS 重新准备，完整保留 1:1 半身、身体与手势；不能将旧 15 FPS 参考直接加速。
参考为 720×720，交付为 360×360/25 FPS，最终合成仍为 1920×1080/30 FPS、
324px 圆窗和手机安全位置。原始素材 SHA-256：
`e4371d0e1181731023e6a636a2b65a24b1a9dc4e52d8c820c7556c280f0cbf64`。
新参考 SHA-256：
`24061ae64e50f01b699c127cefa84d5d1add887e30ea42f55b480becdccd8bd2`。

恢复 25 FPS 后，两段不同旁白仍有同向约 80 ms 偏差。因此显式启用
`--audio-lookahead-frames 2`：将第 i 帧的驱动条件改取第 i+2 帧，末尾钳制；
不移动成片音轨，不改变身体、参考 latent 或融合帧的索引，不改变帧数。
通用默认值仍为 0，当前主播启动脚本显式选择 2。

参数、参考与预处理哈希都进入 `xiaolu-r4-<配置指纹>`，两端自然建立新缓存，
防止新设置复用旧嘴型。模型加载前检查参考真实 FPS；加载后检查五组头像 cycle
非空、等长及脸部边界有效，避免无脸帧造成静默错序。API health 可读出实际配置。

## 同音频实验

使用已完成任务 `science-13d7c594-e98d-4cb3-aaed-8fa8b13d4459` 的正文原声：
第一段取第 60–84 秒，第二段取第 348–372 秒。没有重新生成 TTS 或花生项目。
两段均为 24 秒，跨越原始约 7 秒素材的循环转折。第一段各候选解码音轨的
PCM SHA-256 完全相同，第二段的校准前后 PCM 也相同。

评估副本统一放大至 720×720、转换至 25 FPS，原声时间戳不移动；
使用已有、校验过权重的官方 SyncNet/S3FD CPU 路径，每个样本找到一条人脸 track。
正偏差表示嘴部视频相对所匹配音频滞后。估计精度为一帧 40 ms，0 帧不能证明
绝对零延迟或每个发音的嘴形正确。

| 设置 | 偏差 | Confidence | 最小距离 | 完整 MP4 推理秒数 |
| --- | ---: | ---: | ---: | ---: |
| A：原 15 FPS / FP16 / margin10 | 200 ms | 4.6393 | 9.7411 | 15.703 |
| B：原生 25 FPS / FP16 / margin10 | 80 ms | 4.7878 | 9.7587 | 24.040 |
| C：25 FPS / FP16 / margin20 | 80 ms | 4.6255 | 9.9534 | 20.010 |
| D：25 FPS / FP32 / margin10，batch4 | 80 ms | 4.7254 | 9.7129 | 126.919 |
| E：新配置指纹，25 FPS / FP16，第一段 | 80 ms | 4.6827 | 9.7718 | 19.639 |
| E：同配置，第二段 | 80 ms | 5.7961 | 8.8881 | 13.720 |
| F：E + 条件提前两帧，第一段 | 0 ms | 5.0523 | 9.5317 | 24.758 |
| F：同校准，第二段 | 0 ms | 5.8878 | 8.8057 | 16.870 |

B 使用原 runtime；E/F 使用新 runtime，后者在独立配置下重新建立头像缓存，
因此不能将 B 与 F 的所有像素差异都归因于两帧校准。E/F 是主要校准对照。
生成使用相同 seed 1247。耗时包含音频特征、生成、融合、编码和 mux，
不含单独记录的模型/头像加载；首段 CUDA 热身开销较高，不宜直接外推长片耗时。
FP32 显存峰值 9.244 GiB，FP16 首段峰值 7.764 GiB。

扩大裁剪和完整 FP32 都没有改善本次同步偏差；FP32 首段耗时明显增加，
因此生产保留 FP16、margin10、jaw、左右 cheeks 90/90。没有加入人脸修复、
插帧或其他未验证的后处理。静帧检查未发现明显矩形接缝或双嘴，但不能据此认定
动态嘴形正确。现有模型仍存在 256px 脸区生成及单帧抖动的限制。

## 查看产物

- [修改前后同音轨并排对比](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/compare.mp4)
- [对比页和独立样片](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/index.html)
- [第二段校准结果](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/middle-after.mp4)
- [107 实际合成](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/pipeline.mp4)
- [逐组测量、哈希与耗时](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/validation.json)
- [107 合成检查点与媒体信息](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/pipeline-validation.json)
- [成片实际圆窗的 SyncNet 复核](http://192.168.0.107:3013/static/science-diagnostics/musetalk-quality-20261109/final-circle-syncnet.json)

107 实际从原任务第 60 秒截取 24 秒正文，经现有 TS 客户端调用新 API，再叠加
固定片头和 `half-body` 圆窗。最终 29.066667 秒、872 帧、1920×1080/30 FPS，
带 48kHz 双声道原声，完整解码通过。生成至最终合成共 120.942 秒，
产物 SHA-256 为 `6e392d417df0185f4662214f5849a3345d1463f32ce3f41d243c345f0851c4ad`。
另从最终成片精确去掉 5.05 秒片头，裁出 `(1250,562)` 的 324px 实际圆窗，
保留同时刻成片音频，统一至 720px/25 FPS 后复核。检测得到两条 track，
各自偏差为 0 帧、1 帧（0–40 ms），confidence 为 3.2529、4.3467。
评估器整体字段会将两个 track 的偏差均值截断为 0，不能用这个整体值掩盖
后一条的 40 ms 残余；也不能将圆形裁切后分数与全幅样本直接排名。
没有修改原任务状态、封面或上传记录。当前浏览器自动化未提供可用浏览器，
已通过 HTTP、完整解码及实际截帧核验产物；未声称完成逐音素人工试听验收。

## 部署与回滚

GPU 持久启动脚本仍为
`/root/rivermind-data/musetalk-reference-halfbody-20261109/start-halfbody.sh`，
新参考为同目录 `presenter-halfbody-720-25fps.mp4`；
头像 ID 为 `xiaolu-r4-399b54766505cd364b59ba7e`。
切换前核对 107 无运行中科普任务、GPU 队列为空，备份旧代码、启动命令和来源清单，
只重启 MuseTalk。常驻写作服务未停止或更改。新服务健康检查已核对全部质量配置。

备份在 `/root/rivermind-data/musetalk-quality-20261109/backup-before-production/`，
旧参考、旧缓存、历史任务仍在。需要回滚时先确认队列为空，停止当前 MuseTalk，
再用同一虚拟环境执行该目录的 `restore-and-start.py`，恢复旧代码与启动参数。
新配置首次准备失败或新服务未就绪时，部署脚本会自动恢复旧服务。

代码涉及 `backend/scripts/musetalk/{runtime,api_server,benchmark}.py`、
新增 `test_runtime_quality.py`，以及 TS 客户端的 25 FPS/配置缓存隔离回归测试。
29 项 Python 测试、16 项 TS 客户端测试、后端 TypeScript 检查通过。
研究依据与固定版本来源见 [研究记录](musetalk-quality-research-20261109.md)。
