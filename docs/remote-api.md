# 远程创作 API 文档

本文档描述供远程项目/客户端调用的核心创作接口。

**基础 URL**: `http://<host>:5679/api/v1`

**响应格式**:
```json
{
  "code": 200,
  "data": { ... },
  "message": "ok"
}
```

---

## 1. 创建项目

`POST /dramas`

用于创建一个新的剧本/项目。

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 否 | 项目标题，默认"未命名" |
| description | string | 否 | 项目描述 |
| genre | string | 否 | 类型/题材 |
| style | string | 否 | 视觉风格，如 `realistic`、`cinematic` |
| tags | string[] | 否 | 标签数组 |
| metadata | object | 否 | 自定义元数据 |
| total_episodes | number | 否 | 默认创建的集数（默认 1，传 0 也视为 1） |

### 请求示例

```bash
curl -X POST http://localhost:5679/api/v1/dramas \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "远程测试项目",
    "description": "通过远程接口创建的项目",
    "style": "cinematic",
    "tags": ["test", "remote"]
  }'
```

### 响应示例

```json
{
  "code": 201,
  "data": {
    "id": 2,
    "title": "远程测试项目",
    "description": "通过远程接口创建的项目",
    "style": "cinematic",
    "status": "draft",
    "total_episodes": 1,
    "created_at": "2026-06-20T16:46:55.783Z",
    "updated_at": "2026-06-20T16:46:55.783Z"
  },
  "message": "created"
}
```

---

## 2. 获取所有项目

`GET /dramas`

支持分页和简单过滤。

### 查询参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | number | 否 | 页码，默认 1 |
| page_size | number | 否 | 每页数量，默认 20 |
| status | string | 否 | 按状态过滤，如 `draft` |
| keyword | string | 否 | 按标题关键词过滤 |

### 请求示例

```bash
curl "http://localhost:5679/api/v1/dramas?page=1&page_size=10"
```

### 响应示例

```json
{
  "code": 200,
  "data": {
    "items": [
      {
        "id": 2,
        "title": "远程测试项目",
        "status": "draft",
        "total_episodes": 2,
        "episodes": [ ... ],
        "characters": [],
        "scenes": []
      }
    ],
    "pagination": {
      "page": 1,
      "page_size": 10,
      "total": 1,
      "total_pages": 1
    }
  },
  "message": "ok"
}
```

---

## 3. 按项目 ID 创建 Episode

`POST /dramas/:id/episodes`

在某个项目下创建一集。会自动计算 `episode_number`。

### 路径参数

| 字段 | 类型 | 说明 |
|------|------|------|
| id | number | 项目 ID |

### 查询参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| auto | boolean | 否 | 是否开启自动创作流水线。传 `true` 时会在创建 episode 后自动开始剧本改写，并依次推进到最终合并导出。 |

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 否 | 标题，默认`第N集` |
| content | string | 否 / 是 | 原始故事内容。普通创建时可选；`auto=true` 时必填 |
| description | string | 否 | 描述 |
| aspect_ratio | string | 否 | 视频/图片比例，如 `16:9`、`9:16` |
| render_mode | string | 否 | 渲染模式，默认 `image_story`，可选 `ai_video` |
| image_config_id | number | 否 | 图片 AI 配置 ID |
| video_config_id | number | 否 | 视频 AI 配置 ID |
| audio_config_id | number | 否 | 音频 AI 配置 ID |

### 请求示例

#### 普通创建

```bash
curl -X POST http://localhost:5679/api/v1/dramas/2/episodes \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "远程测试集",
    "aspect_ratio": "9:16",
    "render_mode": "image_story",
    "description": "通过远程接口创建"
  }'
```

#### 自动创作

```bash
curl -X POST "http://localhost:5679/api/v1/dramas/2/episodes?auto=true" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "自动测试集",
    "content": "一个年轻人在咖啡馆偶遇前任...",
    "aspect_ratio": "9:16",
    "render_mode": "image_story"
  }'
```

### 响应示例

#### 普通创建

```json
{
  "code": 201,
  "data": {
    "id": 5,
    "drama_id": 2,
    "episode_number": 2,
    "title": "远程测试集",
    "aspect_ratio": "9:16",
    "render_mode": "image_story",
    "image_config_id": null,
    "video_config_id": null,
    "audio_config_id": null,
    "auto_started": false,
    "initial_task_id": null,
    "created_at": "2026-06-20T16:47:14.063Z",
    "updated_at": "2026-06-20T16:47:14.063Z"
  },
  "message": "created"
}
```

#### 自动创作

```json
{
  "code": 201,
  "data": {
    "id": 6,
    "drama_id": 2,
    "episode_number": 3,
    "title": "自动测试集",
    "aspect_ratio": "9:16",
    "render_mode": "image_story",
    "auto_started": true,
    "initial_task_id": 42,
    "created_at": "2026-06-20T16:47:14.063Z",
    "updated_at": "2026-06-20T16:47:14.063Z"
  },
  "message": "created"
}
```

### 自动流水线说明

开启 `auto=true` 后，系统会按以下顺序自动推进：

1. `script_rewriter` — 剧本改写
2. `extractor` — 角色与场景提取
3. `voice_assigner` — 角色音色分配
4. `storyboard_breaker` — 分镜拆解
5. `narrator` — 自动生成旁白
6. 图片/视频生成（`image_story` 生成首帧图，`ai_video` 额外生成视频）
7. 对白/旁白 TTS 生成
8. 单镜头合成
9. 整集合并导出

流水线中任意一步失败后，后续步骤会自动停止，等待人工介入。可通过 `GET /episodes/:id/pipeline-status` 查询当前进度与失败状态。

---

## 4. 查询 Episode 创作进度

`GET /episodes/:id/pipeline-status`

返回某一集视频创作的流水线进度，包括总共多少步、当前在第几步、各步骤状态。

### 路径参数

| 字段 | 类型 | 说明 |
|------|------|------|
| id | number | Episode ID |

### 请求示例

```bash
curl http://localhost:5679/api/v1/episodes/5/pipeline-status
```

### 响应示例

```json
{
  "code": 200,
  "data": {
    "episode_id": 5,
    "progress": {
      "current_step": 1,
      "total_steps": 10,
      "percentage": 10,
      "is_completed": false
    },
    "steps": {
      "script_rewrite": { "status": "done" },
      "extract_characters": { "status": "pending", "count": 0 },
      "extract_scenes": { "status": "pending", "count": 0 },
      "assign_voices": { "status": "pending", "assigned": 0, "total": 0 },
      "generate_voice_samples": { "status": "pending", "completed": 0, "total": 0 },
      "extract_storyboards": { "status": "pending", "count": 0 },
      "generate_images": { "status": "pending", "completed": 0, "total": 0 },
      "generate_videos": { "status": "pending", "completed": 0, "total": 0 },
      "compose_shots": { "status": "pending", "completed": 0, "total": 0 },
      "merge_episode": { "status": "pending", "merged_url": null }
    }
  },
  "message": "ok"
}
```

### 步骤说明

| 步骤 | 含义 |
|------|------|
| script_rewrite | 剧本改写 |
| extract_characters | 角色抽取 |
| extract_scenes | 场景抽取 |
| assign_voices | 角色配音设置 |
| generate_voice_samples | 配音样本生成 |
| extract_storyboards | 分镜抽取 |
| generate_images | 分镜图片生成 |
| generate_videos | 分镜视频生成 |
| compose_shots | 镜头合成 |
| merge_episode | 整集合并 |

### 状态说明

| 状态 | 含义 |
|------|------|
| pending | 未开始 |
| ready | 已就绪（剧本阶段） |
| partial | 部分完成 |
| done | 已完成 |
| processing / failed 等 | 任务系统状态（merge_episode 可能返回） |

---

## 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |
