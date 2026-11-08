# 科普制作流程升级：远程 MuseTalk

## 部署位置

正式科普程序运行在另一台 macOS 电脑；RTX 3090 运行 MuseTalk 和原有写作服务。
本工作区的样片和检查不能替代另一台电脑上的更新、重启与验证。
运行科普程序的电脑无需安装 PyTorch、MuseTalk 或 CUDA。

远程配置与参考视频保留在 3090；客户端只提交当前正文的音频。
客户端复用 `.env` 中已有的 `LATENTSYNC_SSH_*`，也支持独立的
`MUSETALK_SSH_*`。密码不进入代码、配置示例、日志或更新包。

## 自动制作

1. 独立采集队列保存来源，发送至制作队列。
2. 远程写作模型改写原稿，保留原意、推进与逻辑，去除原作者自我介绍。
3. 华生使用“音色小鹭” `1595608` 制作正文；固定自我介绍不加入正文。
4. 正文下载后，提取音频，调用远程 MuseTalk 1.5，复用缓存主播素材。
5. 原片头播放后缩入右下角，与正文同步主播圆窗衔接，保留正文原声。
6. 完成封面与原有后续交付。

口型服务默认最多等待 10 分钟。超时或服务失败会记录原因，自动完成仅片头版本。
用户主动停止任务时不触发降级、合成或上传。旧 LatentSync 不参与默认生产。

## 另一台电脑的配置

更新后端代码与 `backend/scripts/musetalk/`。保留那台电脑自己的 `.env`、
数据库、账号会话和任务素材，不用本机文件覆盖它们。

在该电脑的 `backend/.env` 中配置：

```dotenv
SCIENCE_PRESENTER_MODE=musetalk
MUSETALK_REMOTE_PORT=8789
MUSETALK_TIMEOUT_MS=600000
LATENTSYNC_SSH_HOST=hz01-ssh.gpuhome.cc
LATENTSYNC_SSH_PORT=30163
LATENTSYNC_SSH_USER=root
```

继续使用已有的 `LATENTSYNC_SSH_PASSWORD`，或配置该电脑上的 SSH 密钥路径。
也可以手动建立端口转发并设置 `MUSETALK_API_URL=http://127.0.0.1:8789`。
明确指定本地 API 地址时，后端不再自行建立隧道。

macOS 支持环境变量密码自动转发，无需手工保持隧道。
如需要手动调试，可以执行以下命令并在终端完成 SSH 登录，
再设置上述 `MUSETALK_API_URL`：

```sh
ssh -N -T -L 127.0.0.1:8789:127.0.0.1:8789 -p 30163 root@hz01-ssh.gpuhome.cc
```

该电脑需要已有的 Node、FFmpeg/ffprobe、OpenSSH，以及固定片头：
`data/science-pop/assets/xiaolu-intro.mp4`。
如片头存放在别处，使用 `SCIENCE_INTRO_VIDEO_PATH` 指向该电脑上的文件。
不要填写 `/Users/zhangshijie/Downloads/...` 等本机专属路径。

设置 `SCIENCE_PRESENTER_MODE=none` 可以明确切回仅片头流程。
更新并重启另一台电脑的科普后端后，以一个新任务验证日志中的远程 MuseTalk、
固定片头、过渡、正文圆窗及实际成片。已提交的平台作品不自动替换。

## 已测范围

2026-11-07，RTX 3090 与原写作模型同时驻留显存：

| 环节 | 8 分 56 秒正文 |
| --- | ---: |
| MuseTalk 15 FPS，360×360 主播完整导出 | 358.70 秒 |
| 下载主播 MP4 | 55.52 秒 |
| 本机帧率归一、片头和圆窗合成 | 434.72 秒 |
| 合计 | 848.94 秒，约 14 分 9 秒 |

该测量复用了已下载的华生成片，不包括原稿采集、二创、华生制作、
新音频上传及另一台电脑的性能。没有声称整个新任务必定在 15 分钟内完成。
模型首次加载与素材首次准备分别测量，常驻服务复用模型与头像缓存。
质量已由用户确认接受；详见 `musetalk-production-research-20261107.md`。

常驻 API 已在远程 `127.0.0.1:8789` 启动并完成真实客户端联调：
60 秒正文的自动 SSH、FLAC 上传、口型、下载、校验和帧率规范化共 62.204 秒；
第二次直接复用结果耗时 1.282 秒。此测试没有重做二创或调用华生生成。
当前服务由 `nohup` 运行；GPU 主机重启后需按
`backend/scripts/musetalk/README.md` 的启动命令重新启动服务。
即使服务暂时不可用，科普流程仍会自动完成仅片头版本。
