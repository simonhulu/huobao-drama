# YouTube 采集登录恢复

遇到 `Sign in to confirm you're not a bot` 时，频道列表可能仍可读取，但下载已被 YouTube 拒绝。代理配置正常不代表登录会话有效。

在历史脚本页的采集监控中打开 YouTube，在本机 Chrome 完成登录或人机验证，然后点击“刷新 YouTube 登录”。系统刷新专用 Cookie 文件，并用原任务的一条视频检测下载权限；验证通过后点击“继续采集”。刷新本身不会启动生产。

如果 macOS 拒绝后台进程读取 Chrome 登录，系统会先检测已有专用 Cookie 文件。该文件仍有效时可直接继续。若也已失效，在项目根目录的终端执行：

```bash
~/.agent-reach/tools/history-youtube/bin/python3 backend/scripts/history-sources/export-youtube-cookies.py data/secrets/history-youtube/cookies.txt
```

随后重新点击“刷新 YouTube 登录”和“继续采集”。Cookie 文件仅保留 YouTube 域，权限为 `0600`，不需要上传或粘贴 Cookie，也不需要重启后端。自定义 Cookie 文件路径时，命令输出路径须与 `HISTORY_YOUTUBE_COOKIES_FILE` 相同。

采集遇到共同的登录验证故障会停止继续扫描，保留当前来源、已下载文件和检查点。恢复使用原任务 ID，优先处理该任务尚未完成的来源，再读取原频道列表；已完成且版本有效的稿件不会重复二创。单条普通视频故障仍可跳过，不会阻断整项采集。恢复完成后，失败计数表示仍未恢复的来源。

接口：`POST /api/v1/history-scripts/jobs/:id/youtube-session` 检测登录；`POST /api/v1/history-scripts/jobs/:id/resume` 继续原 YouTube 采集任务。已有其他采集任务运行时，恢复返回 `409`，避免两项采集竞争。

yt-dlp 官方说明指出 YouTube 可能轮换浏览器 Cookie，因此文件未到期不等于会话持续有效：[YouTube Cookie 指引](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)。成功检测仅证明该视频当时可以提取下载信息，不保证整个频道永远不会再次要求验证。

## 本次验证（2026-10-31）

- 原任务 `40328` 在同一验证故障下增长到入选 63 条、失败 62 条、完成 0 条。停止后保留全部来源，并通过恢复接口继续原任务 ID。
- 终端刷新导出 25 条 YouTube Cookie；同一视频 `g6bDE6sOlTc` 的 yt-dlp 单条权限检测和真实后台登录检测均通过。
- 后台直接读取 Chrome Cookie 数据库实测返回 `EPERM`。因此页面不能保证自动从 Chrome 刷新；现有专用会话可用时会据实显示检测通过，失效时需要按上述终端命令更新。
- 恢复后任务处于 `running/downloading`，优先处理原来源 `798`；观察到实际下载 `.part` 文件已达约 71 MiB。其余 62 条尚待后台继续，未声明整批已经完成。
- 后端 85 项相关回归、前端 11 项恢复流程场景、后端类型检查通过；检查了移动端恢复界面。包括共同验证故障停止扫描、普通单条故障继续、原 ID 恢复、恢复超过 100 条来源、跳过已完成稿件及失败操作可重试。
- 为保留正在运行的渲染和上传，仅在现有进程中加载采集处理器及采集路由，后端 PID `49045` 未变；临时本机调试端口已经关闭。正常重启后由更新后的源码直接注册这些能力。

## 中文标题修复（2026-10-31）

部分中文视频在 YouTube 配置了英文翻译标题。yt-dlp 默认频道请求使用英文界面语言，频道列表可能返回英文标题；已有记录证明英文在采集时已出现，并非二创模型改写。

采集元数据时现在显式传递 `--extractor-args youtube:lang=zh-CN`，历史采集与科普采集共用该入口。不调用模型翻译标题，也不改变视频下载参数；上游没有中文标题时仍保留实际返回值。

- 同一频道 `@FHZDN` 前 90 条对比：默认设置 31 条标题不含中文，指定中文后为 0 条。
- 核对现有 492 条 YouTube 来源，其中 42 条标题不含中文，均属于该频道。读取频道 205 条元数据后，按原视频 ID 找回全部 42 条中文标题，仅更新来源的标题、采集元数据中的标题及更新时间。
- 更新使用数据库事务及原 ID、原视频 ID、原标题条件，不重置正文、下载、二创、制作或发布记录。修复映射保存在本地 `data/youtube-title-repair-20261031.json`。
- 新回归测试先复现英文标题，再验证频道和单视频采集优先请求中文。YouTube 与科普素材链路共 25 项测试、后端类型检查通过。
- 未重启后端：新历史采集处理器和科普采集器已加载至原进程，实际读取 30 条标题全部为中文。正在执行的任务保留原调用及检查点，历史日志中的旧标题作为当时记录保留。

参考：[yt-dlp 官方 YouTube extractor 参数](https://github.com/yt-dlp/yt-dlp#youtube)，其中 `lang` 用于选择元数据语言。
