# YouTube 代理验证（2026-10-30）

后端现有配置使用 `HISTORY_YOUTUBE_PROXY=http://127.0.0.1:7897`，频道读取和视频下载都通过 `youtubeNetworkArgs()` 传递 `--proxy`。下载重试仍保留代理参数。

任务 40324 在扫描前失败：后台服务未找到 Chrome Cookie 数据库。相同配置在终端可读取 Cookie，因此该错误不能归因为未配置代理或 yt-dlp 过时；后台环境的具体文件访问限制尚未独立证明。

真实验证结果：

- 使用代理匿名读取用户指定的历史频道，返回频道“歷史大觀”与视频 `bwbQOdW5Cv8`。
- 匿名下载该视频要求机器人验证；使用代理与 Chrome Cookie 后成功下载 8.033 秒 MP4，包含视频和音频。此验证使用低清短片，仅证明访问与下载链路可用，不代表完整 720p 视频交付。
- 新增回归测试先复现缺失 Cookie 数据库导致采集失败，再验证采集和下载仅对此错误进行一次匿名重试，代理参数始终保留。10 项 YouTube 测试和后端类型检查通过。

修复同时更新页面的来源标签，YouTube 读取失败不再显示“浏览抖音失败”。匿名回退不能代替需要登录的视频验证，仍应保留有效 Cookie 配置。

## 后台恢复

用户再次重试的任务 40325 仍由未重载的旧进程执行，因此继续收到原 Cookie 数据库错误。仅更新源代码不足以修复运行中的配置。

使用 `export-youtube-cookies.py` 调用已安装的 yt-dlp Cookie 提取器，只导出 `youtube.com` 及其子域的 27 条未过期 Cookie。文件保存在被 Git 忽略的 `data/secrets/history-youtube/cookies.txt`，权限为 `0600`，不保存其他网站 Cookie，不在日志打印 Cookie 值。

```bash
~/.agent-reach/tools/history-youtube/bin/python3.14 backend/scripts/history-sources/export-youtube-cookies.py data/secrets/history-youtube/cookies.txt
```

在 `backend/.env` 中设置 `HISTORY_YOUTUBE_COOKIES_FILE` 指向该文件，继续保留现有代理。运行中的同一后台进程也已同步这两个环境配置，并在该进程内调用 yt-dlp 成功读取频道视频。临时使用的本机调试端口已关闭；后台 PID 与现有渲染子进程 PID 均保持不变。

使用专用 Cookie 文件与生产格式规则，真实下载到 8.033 秒、1280×720、带音轨的 MP4。这只证明有界下载成功，不代表完整长视频下载已经完成。

已按任务 40325 保存的三个频道与持续采集配置重新启动任务 **40326**。观察到 `running/downloading`、扫描 3 条、跳过已有来源 2 条、入选新来源 1 条（来源 371）、错误为空，实际后台采集已越过原故障。Cookie 文件配置已立即生效；此前新增的匿名回退代码仍待下一次后台重载，当前恢复不依赖该回退。

浏览器登录失效时，可重新运行导出命令刷新同一路径，无需每次下载访问个人 Chrome 数据库。
