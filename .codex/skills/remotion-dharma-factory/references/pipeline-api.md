# 管线 API 与数据契约（Pipeline Reference）

## 路由

| 方法 | 路径 | 同步/任务 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/dramas` | 同步 | 建剧；佛学内容 `genre: 'dharma'` + 显式 `media_account_id` |
| POST | `/api/v1/dramas/:id/import-script` | 任务链 | `script_content` + `title` + `clean: false`；自动 extract → tts.pre_generate → breaker |
| GET | `/api/v1/dharma/image-styles` | 同步 | 三个 production style + 旧风格兼容项；新生产只显示 `production: true` |
| POST | `/api/v1/dharma/episode/:id/footage/generate` | 任务 `dharma.footage_generate` | 为一个连续段落生成 AI 图/视频；固化 role/emotion/style/move snapshot |
| POST | `/api/v1/dharma/episode/:id/footage` | 同步 | 素材指派 upsert 到 `storyboards.grid_cells`；校验文件存在 |
| GET | `/api/v1/dharma/episode/:id/footage` | 同步 | 指派、情绪弧线、AI 图/视频覆盖率、素材唯一性、BGM、production gate 与成片状态 |
| POST | `/api/v1/dharma/episode/:id/preflight` | 同步 | 编译整片输入、创意门禁和精确 full-plan fingerprint；不转码、不渲帧 |
| POST | `/api/v1/dharma/episode/:id/canary` | 任务 `dharma.episode_render` | 仅当 preflight 判定 `requirement: required` 时渲染服务端选定的 15–30s 风险窗口 |
| POST | `/api/v1/dharma/episode/:id/review/approve` | 同步 | 审批精确 full-plan fingerprint；若要求 canary，同时绑定其 fingerprint |
| POST | `/api/v1/dharma/episode/:id/render` | 任务 `dharma.episode_render` | 新生产只提交空对象 `{}`；审批通过后一次正式整集渲染 |
| POST | `/api/v1/tasks/:id/cancel` | 同步 | 正式整集 Dharma render 还必须带匹配 `TASK_CONTROL_TOKEN` 的 `X-Task-Control-Token`，以及确认文本、原因、操作者标签 |
| PUT | `/api/v1/episodes/:id` | 同步 | `bgm_audio_url` 在此配置 |
| GET | `/api/v1/library/music` | 同步 | BGM 候选列表 |
| GET | `/api/v1/grid/videos/assets` | 同步 | 可复用视频资产库（跨管线） |

## 任务

`dharma.episode_render`：`resumable: false, maxAttempts: 1`，跑在 long-running
worker 池（30 分钟租约）。正式生产 payload 只有 `{ episode_id }`；条件 canary 由服务端写入
canonical snake_case 窗口字段。camelCase 只作为旧记录读取兼容，不能创建新任务。任务事件包含阶段计时与帧进度：
`dharma.episode.render.stage`、`dharma.episode.render.remotion_stage`、
`dharma.episode.render.encoder`（编码器证据）和
`dharma.episode.rendered`（输出摘要）。正式整集在 publish 前会 claim 交付提交点；
claim 后失租的任务必须转 `stale` 并人工核对，不能自动重试。

### 正式整集取消的生产部署

将高熵 `TASK_CONTROL_TOKEN` 放入生产 secret manager，并只注入 backend 服务进程。正式整集指
payload 不含 `max_duration_sec` 和 `only_storyboard_ids`；取消时必须由任务中心在
`X-Task-Control-Token` header 发送该 secret，同时提交任务编号绑定的确认文本、原因和操作者标签。
不配置 token 时，服务必须拒绝正式整集取消（fail closed）。不要把 secret 放到前端配置、代码、日志、
浏览器存储或 shell history；代理需要转发该 header，但不得记录其值。它授权此次控制操作，不能把
`actor` 当作已认证身份。

## 持久化契约

### storyboards.grid_cells（dharma 形状）

```json
{
  "dharma": 1,
  "theme": "山间迷雾",
  "role": "contemplative_nature",
  "emotion": "curiosity",
  "styleId": "dharma-surreal-dream-v1",
  "video": {
    "src": "static/remotion/stock/pexels-26893760.mp4",
    "provider": "pexels", "videoId": "26893760",
    "sourceUrl": "https://www.pexels.com/video/...",
    "licenseUrl": "https://www.pexels.com/license/",
    "creator": "...", "durationSec": 20.5,
    "sourceStartSec": 2, "focusX": 50, "focusY": 50, "grade": "zen_muted"
  },
  "image": { "src": "static/images/xxx.png", "move": "push", "generatedSegmentTaskId": 12345 },
  "quote": { "text": "应无所住而生其心", "source": "《金刚经》" }
}
```

- 每项必须有受控的 `role / emotion / styleId`；情绪与三种 production style 的映射必须一致。
- `video` / `image` 必须且只能有一个；stock 视频必须写 `provider/sourceUrl/licenseUrl/creator`，并指向
  manifest 中的原始 stock 文件，不能写 proxy/cache 路径。
- 相邻分镜同 `video.src` = 一个动态视觉段落；同一生成任务写回的相邻图片按
  `generatedSegmentTaskId` 合并成一次完整 Ken Burns 段落。
- 每个 canonical 本地源文件只能出现在一个连续范围；`A -> B -> A` 原子拒绝。
- `insight` 或带 `quote` 的段落必须是 `dharma-minimal-light-v1` AI 图并使用 `hold`。
- 与 grid 管线的 cells 形状互斥——同一剧集只走一条管线。

### episodes

- `bgm_audio_url`：`static/music/...`（渲染硬门禁：存在、可测响度且 ≥180s）。
- `video_url`：整集渲染成功后写回任务私有的
  `static/remotion/dharma-ep<id>-task<taskId>.mp4`。它只会在输入指纹、commit claim 和
  当前 worker lease 都仍有效时更新，旧 worker 不能覆盖当前交付。
- `metadata.dharmaRender`：渲染摘要（output/durationFrames/segmentCount/quoteCount/renderedAt）。
- `metadata.dharmaProductionGate`：当前整片 plan/canary 的 fingerprint 与审核证据；任何素材、
  TTS、BGM、风格或 renderer contract 变化都会使审批失效。
- `metadata.dharmaPilot` 仅为旧剧集读取兼容；新生产不得创建或依赖固定 60 秒 pilot。

### 产物路径

| 产物 | 路径 |
| --- | --- |
| props | `data/static/temp/dharma-props-<id>[-<scope>].json` |
| 渲染素材暂存 | `remotion/public/dharma-assets/<content-identity>.<ext>`（硬链接优先，跨渲染复用） |
| 任务渲染暂存 | `data/static/remotion/.staging/dharma-ep<id>-task<taskId>-*/render.mp4`（仅任务执行期；终态清理） |
| 风险 canary | `data/static/remotion/dharma-ep<id>-canary-<seconds>s-task<taskId>.mp4` |
| 调试 preview | `data/static/remotion/dharma-ep<id>-preview-task<taskId>.mp4` |
| 整集成片 | `data/static/remotion/dharma-ep<id>-task<taskId>.mp4` |
| stock 素材 | `data/static/remotion/stock/` + `manifests/` |

任务先写上述 staging 文件；通过输出契约后才原子 rename 到任务私有路径，最后用 lease
保护的 CAS 更新 `video_url` 或 canary 审核状态。不要从 staging 目录取成片，也不要自行把
taskId 去掉或复用旧文件名。

## SQL 门禁速查

```sql
-- TTS 就绪
SELECT pre_tts_audio_url IS NOT NULL AND pre_tts_titles_json IS NOT NULL
FROM episodes WHERE id = ?;

-- 分镜数与素材指派覆盖率（dharma 形状的 grid_cells）
SELECT COUNT(*) AS total,
       SUM(CASE WHEN json_extract(grid_cells, '$.dharma') = 1 THEN 1 ELSE 0 END) AS assigned
FROM storyboards WHERE episode_id = ?;

-- 第一镜必须承担 curiosity + 超现实梦境；媒介可以是视频或立即运动的 AI 图
SELECT json_extract(grid_cells, '$.emotion'),
       json_extract(grid_cells, '$.styleId'),
       json_extract(grid_cells, '$.video.src'),
       json_extract(grid_cells, '$.image.move')
FROM storyboards
WHERE episode_id = ? AND storyboard_number = 1;

-- BGM
SELECT bgm_audio_url FROM episodes WHERE id = ?;

-- 无活跃渲染任务
SELECT id, status, lease_expires_at FROM creation_tasks
WHERE episode_id = ? AND type = 'dharma.episode_render'
  AND status IN ('queued','running');
```

## 验证脚本

```bash
# 每次 props 构建/渲染后必跑（独立重推导时序，±1 帧容差）
node scripts/videoeditor/check_dharma_sync.mjs <episodeId> [--allow-partial]

# 后端自动化测试（仅 src/**/*.test.ts，不扫描 backend/scripts/**；不启动后台 worker）
cd backend && npm test

# 直接 provider 测试仍必须自行 mock 网络；TASK_WORKER_DISABLED 不是网络 sandbox。

# Dharma 定向契约测试
npx tsx --test src/services/dharma-props.test.ts

# 交付验证
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of json <output.mp4>
```

## Web 审查面（/dharma）

- `/dharma`：佛学剧集列表 + 新建（粘贴净稿 → 建剧 → import-script）。
- `/dharma/episode/<id>`：状态概览 / 素材审查网格（逐分镜预览）/ BGM 选择 /
  渲染（整片 preflight → 条件 canary → 精确指纹审批 → 一次正式整集，任务事件监控）/
  成片播放下载。
- 页面是状态与审查面：素材指派和渲染可由 agent 走 API 完成，页面用于人工验收。
