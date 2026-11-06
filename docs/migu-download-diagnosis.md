# 咪咕下载诊断（2026-10-24）

## 结论与实测产物

用户提供的赛事页 `https://www.miguvideo.com/p/live/120000594061` 可以取得视频素材。本次从其中的具体集锦详情页 `https://www.miguvideo.com/p/detail/968668508`，通过已安装 videodl 的 `KedouVideoClient` 解析出真实 HLS 地址，再用 yt-dlp 下载成功。

产物：`data/cba-video-diagnostics/2026-10-24-migu/zhejiang-qingdao-highlights.mp4`。

- 内容：浙江对青岛，全场集锦；抽帧比分牌显示双方球队。
- ffprobe：297.72 秒，1280×720，25fps，H.264/AAC，55,138,085 字节。
- FFmpeg 整段解码退出码 0，无解码错误。
- 这是约 5 分钟的集锦，不能当作整场录像。

## 为什么旧链接曾经成功

旧任务 `data/cba-video/2026-10-18-nanjing-guangdong` 的成功原片是真实存在的：9232.68 秒、720p25、H.264/AAC、1,775,675,680 字节。

`downloads/replay-f2376cf598c8.info.json` 记录了 `yt-dlp/yt-dlp 2025.12.08`、`extractor=generic`、`protocol=m3u8_native`。它接收的是咪咕 CDN 的 `.m3u8` 地址，不是赛事网页。`job.json` 也记录了“正常官方播放器取得完整回放”。因此旧成功路径是：官方播放器取得媒体地址 → 项目 download 命令 → yt-dlp。没有证据支持“videodl 直接下载旧赛事页成功”。

旧错误日志中的失败发生在元数据文件写入：默认文件名包含长查询参数。现有下载命令改为短摘要文件名后成功，不能把该错误解释成媒体不允许下载。旧媒体地址本次重新请求返回 HTTP 605；它不能作为永久下载源，应重新解析。

## 当前失败的两个独立原因

1. **赛事集合响应不兼容。** 新旧 `/p/live/` 地址交给 Kedou 时，可返回 `code:200`。新页返回 35 个 `data.videoListItemVoList` 条目，每条是标题和公开详情页地址；安装版解析器固定读取单视频字段 `data.videoItemVoList`，因此抛出 KeyError。必须先选出具体视频，再解析详情页。
2. **解析服务网络不稳定。** Ray 出现 TLS EOF，Kedou 出现 DNS / 请求超时。7 秒和 15 秒预算的详情探测失败；随后一次 35 秒请求预算的探测在 14.6 秒取得有效媒体地址，并完成下载。因此超时不能被解释为平台不支持、需要会员或视频不可下载。

三链接对照（旧赛事、新赛事、之前失败的详情页）一度全部退出码 0、实际文件数 0。`videodl` 的退出码不能单独证明下载成功，必须检查文件、时长、音视频轨。

官方文档明确推荐咪咕使用 `RayVideoClient` 或 `KedouVideoClient`：<https://github.com/CharlesPikachu/videodl/blob/master/README.md#L408>。不能因为排在前面的其他通用解析器失败就断言咪咕不受支持。

## 什么地址可以用

| 输入 | 处理方式 | 本次证据 |
| --- | --- | --- |
| `/p/live/120000594061` | 先枚举视频，再明确选择条目 | 已取得 35 个条目 |
| `/p/detail/968668508` | Kedou 解析为真实媒体地址，再下载 | 已下载完整集锦并解码验证 |
| `/p/detail/968670472` | 这是列表标注的全场回放，仍需单独解析和核验 | 早期请求超时，不能据此判定不可下载 |
| 新鲜有效的非 DRM `.m3u8` / `.mp4` | 交给媒体下载器，检查实际文件 | 新集锦和旧完整录像均有成功文件 |
| `blob:`、过期直链、广告或试看 | 不能作为正式比赛素材直接使用 | 新任务不得复用旧失效直链 |

## 项目内修复

`scripts/cba-video/migu_resolve.py` 复用已安装 Kedou 解析器，兼容集合与单视频响应，不改 site-packages。真实媒体地址只写入权限 600 的临时文件；日志和命令结果不打印签名参数。

`cli.mjs download` 遇到咪咕详情页时先运行解析器。赛事页需指定 `--content-id`，或者直接使用已选定的详情页，防止无意把默认集锦当成整场录像。自动任务已有 `migu-search` 的详情页候选，可以直接使用候选 URL。

```sh
# JOB 为已有比赛任务目录；集锦只作为 highlights 素材导入。
node scripts/cba-video/cli.mjs download --job "$JOB" \
  --url https://www.miguvideo.com/p/live/120000594061 \
  --content-id 968668508 --id highlights --kind highlights
```

也可以传 `--url https://www.miguvideo.com/p/detail/968668508`，无需 `--content-id`。下载成功仍不自动确认比赛身份或完整性，也不代表已完成剪辑、配音、发布。

## 修复验证

新增解析桥接在真实集锦详情页上成功返回媒体地址。工厂脚本全套 48 项测试通过；随后补充分节与列表标题保留修复，受影响下载测试 6/6、解析桥接测试 13/13 通过。真实集锦的完整解码、参数和来源记录在 `data/cba-video-diagnostics/2026-10-24-migu/verification.json`，三链接失败对照在同目录 `videodl-comparison.json`。全场回放的桥接尝试仍未成功解析，本次未声称已取得整场录像。

## 生产沙箱补充排查

2026-10-24 的实际恢复又发现两个独立环境问题：默认子执行器未明确放行联网与任务 IPC；videodl 导入 LoggerHandle 时会在用户日志目录创建文件，workspace 沙箱因此拒绝。现在生产与预检共用 workspace-write、network_access=true 和任务 TMPDIR；预检实际运行写文件、IPC、咪咕首页联网及 videodl 导入，不能只凭登录状态或模型回复判为就绪。解析桥接将 videodl 日志隔离到权限 700 的任务临时目录，退出清理，不改用户 HOME 或 site-packages。

`migu_resolve.py --check-runtime` 已在生产同配置子进程中成功执行。下载器禁用全局配置、用户缓存及原始 info.json；临时媒体签名文件结束后删除。解析服务临时请求失败最多重试一次，错误选择或错误比赛编号不重试。恢复搜索保留旧候选及此前官方证据，同时如实记录最新失败。
