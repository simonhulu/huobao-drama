# 智能分集「前情提要（Recap）」设计文档

## 背景与问题

当前「导入精稿直出」的智能分集流程（`backend/src/services/episode-splitter.ts`）将长文本切分为多集后，每集正文是原文的连续切片。第一集因从头开始，观众可以理解；但从第二集起，新观众或被算法推流进入的观众缺乏对前情的了解，导致剧情断层、观看体验下降。

## 目标

1. 为每一集在正文前增加一个**可扩展的开场动画（Intro Animation）**，统一剧集品牌感。
2. 为从第二集开始的每一集，在开场动画后增加一段**语音+画面的前情提要（Recap）**，让观众无需回看上一集即可理解当前集的前因。

## 设计原则

1. **Intro 是独立产物**：不和普通 storyboard 混用同一套数据模型和生产逻辑，支持模板化扩展。
2. **Recap 是独立产物**：不和普通 storyboard 混用同一套数据模型和生产逻辑。
3. **正文不被侵入**：`opening_hook` 只用于 recap 到正文的过渡，正文仍从原文真正开头开始。
4. **跨集呼应**：上一集的 `cliffhanger_hook` 是下一集 `recap_script` 的核心素材。
5. **成本可控**：复用上一集已合成画面的首帧/关键帧，只重新生成一段短旁白。
6. **模板可扩展**：开场动画以模板形式存在，用户可新增、选择、默认回退。

## 关键概念定义

| 概念 | 定义 | 使用位置 |
|------|------|----------|
| `intro_template` | 开场动画模板（背景、文字、动画、变量占位符的 JSON 配置） | Intro Composer |
| `intro_video_url` | 开场动画合成后的视频地址 | 集合并（Merge）步骤 |
| `recap_script` | 前情提要旁白脚本（约 40-70 字） | Recap 合成步骤 |
| `opening_hook` | Recap 结束后、正文开始前的过渡钩子 | Recap 合成步骤末尾 |
| `cliffhanger_hook` | 本集结尾悬念 | 本集最后一个分镜的情绪落点 + 下一集 recap 素材 |
| `series_hook` | 全剧一句话核心钩子 | 剧集封面、标题、推广文案 |

## 架构调整

### 职责重新划分

当前 `episode-splitter.ts` 同时承担：
1. 抽取剧情推进链
2. 决定分集边界
3. 生成 title / summary
4. 生成 opening_hook / cliffhanger_hook / series_hook
5. 切分正文

调整后：
- **Episode Splitter**：只负责剧情链、分集边界、正文切分。
- **Hook Designer（新增）**：负责全局生成 opening_hook、cliffhanger_hook、recap_script、series_hook。
- **Intro Composer（新增）**：负责根据 `intro_template` 合成每集开场动画。
- **Recap Composer（新增）**：负责合成 recap 视频。
- **Episode Merger**：在合并正片时，按顺序将 intro 视频、recap 视频 prepend 到该集最前面。

### 生产流程

```
1. 导入精稿直出脚本
   ↓
2. 智能分集（Episode Splitter）
   输出：剧情链、分集边界、每集 covered_beat_ids、opening/ending anchors、正文 content
   ↓
3. Hook Design（新增）
   输入：全部分集 + 剧情链
   输出：
     - 每集 recap_script（第2集及以后）
     - 每集 opening_hook
     - 每集 cliffhanger_hook
     - 全剧 series_hook
   ↓
4. 分镜生成（Storyboard Breaker）
   输入：每集正文
   输出：正常 storyboards
   ↓
5. Intro 合成（新增）
   输入：intro_template + 剧集/分集标题变量
   输出：intro_video_url
   ↓
6. Recap 合成（新增）
   输入：recap_script + opening_hook + 上一集关键画面
   输出：recap_video_url
   ↓
7. 单镜合成
   ↓
8. 集合并（Merge）
   顺序 prepend：intro_video → recap_video → 正文
```

## 数据模型

### 方案：扩展 `episodes` 表 + 新增 `intro_templates` 表 + 扩展 `dramas` 表

在 `episodes` 表中新增以下字段（JSON 或独立列）：

```ts
interface EpisodeHooks {
  introVideoUrl?: string         // 合成后的开场动画视频
  recapScript?: string           // 前情提要脚本
  recapVideoUrl?: string         // 合成后的 recap 视频
  openingHook?: string           // 过渡钩子
  cliffhangerHook?: string       // 结尾悬念
  seriesHook?: string            // 全剧钩子
}
```

新增 `intro_templates` 表：

```ts
interface IntroTemplate {
  id: string                      // 模板唯一标识，如 "classic-title-fade"
  name: string                    // 展示名称，如 "经典黑场标题淡入"
  config: IntroTemplateConfig     // JSON：背景、图层、动画、变量定义
  isDefault: boolean              // 是否默认模板，全局唯一 true
  createdAt: string
  updatedAt: string
}
```

扩展 `dramas` 表：

```ts
interface Drama {
  // ... existing fields
  introTemplateId?: string | null // 指定本剧使用的开场模板，为空时使用 isDefault
}
```

模板配置示例（`IntroTemplateConfig`）：

```json
{
  "duration": 3.0,
  "background": { "type": "color", "value": "#000000" },
  "variables": {
    "dramaTitle": { "source": "drama.title", "fallback": "精彩短剧" },
    "episodeNumber": { "source": "episode.episodeNumber" }
  },
  "layers": [
    {
      "type": "text",
      "content": "{{dramaTitle}}",
      "fontSize": 72,
      "color": "#ffffff",
      "position": "center",
      "animation": { "type": "fadeIn", "duration": 1.5, "delay": 0.5 }
    }
  ],
  "audio": null
}
```

优先使用**独立列**，便于查询和索引。

## 开场动画模板

### 默认模板

系统内置一个默认模板 **「经典黑场标题淡入」**：
- 黑底 3 秒
- 剧名居中，白字，1.5 秒淡入
- 可扩展：增加副标题、Slogan、Logo、背景音乐

### 扩展机制

1. 用户在项目设置/剧集设置中选择已有模板，或上传/新建模板。
2. 新增模板只需向 `intro_templates` 表插入一条 `config` 记录；`Intro Composer` 按配置解析渲染。
3. 模板变量统一通过 `{{variableName}}` 占位，数据源限定为 `drama.*` 和 `episode.*` 字段，避免任意代码注入。
4. 渲染层复用现有 `composition/` 基础设施：背景生成、文字图层、淡入淡出动画、音频混合。
5. 未来可支持 SVG/序列帧背景、动态粒子等高级效果，但默认保持极简可控。

## Recap 视频结构

建议时长：**15-25 秒**，结构如下：

| 时间段 | 内容 | 画面 | 音频 |
|--------|------|------|------|
| 0-2s | 「前情提要」标签淡入 | 黑场或模糊上一集画面 | 轻微环境音/音乐铺垫 |
| 2-15s | 上一集关键事件回顾 | 上一集 2-3 个关键 storyboard 首帧/关键帧快速切换 | `recap_script` 旁白 |
| 15-20s | 过渡钩子 | 定格在上一集 cliffhanger 画面 | `opening_hook`（文字卡或短旁白） |
| 20s+ | 切正文 | 正文第一个 storyboard | 正文旁白接续 |

## 最终成片结构

每集合并后的视频顺序：

| 顺序 | 段落 | 时长 | 说明 |
|------|------|------|------|
| 1 | Intro（开场动画） | 3-5s | 每集都有，品牌/标题露出 |
| 2 | Recap（前情提要） | 15-25s | 第 2 集及以后才有 |
| 3 | Opening Hook | 2-3s | 文字卡或短旁白，承接正文 |
| 4 | 正文 | 主体 | 原分镜内容 |

## 素材选择策略

Recap 的画面素材来源：
- 优先使用上一集 storyboards 中对应 `must_keep_context` beat 的分镜。
- 如果找不到明确对应，使用上一集前 3 个 storyboard 的首帧 + 最后 1 个 cliffhanger 画面。
- 所有画面使用已生成的 `first_frame_image` 或 `composed_video_url` 的首帧。

Intro 的素材来源：
- 模板配置中的静态资源（背景色/图片/字体）。
- 变量数据来自 `dramas` / `episodes` 表（标题、集数等）。
- 不依赖剧情画面，可在分镜完成前独立生成。

## Hook Designer 实现要点

### 输入

- 全部分集结果（包含 covered_beat_ids、正文摘要）
- 剧情推进链（plot progression chain，包含 must_keep_context）

### 输出示例

```json
{
  "series_hook": "被婆婆逼走的儿媳，竟发现丈夫隐藏了二十年的秘密",
  "episodes": [
    {
      "episode_number": 1,
      "opening_hook": "婆婆当众说我不能生，我气得当场离家。",
      "cliffhanger_hook": "我走出家门那一刻，手机响了——是我丈夫。",
      "recap_script": null
    },
    {
      "episode_number": 2,
      "opening_hook": "丈夫的电话，揭开了婆婆真正的目的。",
      "cliffhanger_hook": "原来这二十年，他一直知道真相。",
      "recap_script": "上一集，我被婆婆当众羞辱后离家出走。就在我迈出大门时，丈夫打来了电话。"
    }
  ]
}
```

### 生成策略

1. 对每一集，回顾其 covered_beat_ids 对应的剧情链节点。
2. `cliffhanger_hook` 聚焦本集最后一个高悬念 beat。
3. `recap_script` 用上一集的 `cliffhanger_hook` + 关键 beat 的 `must_keep_context` 生成，控制在 40-70 字。
4. `opening_hook` 用当前集第一个关键冲突 beat 生成，作为过渡。
5. `series_hook` 从全剧最大冲突/悬念 beat 生成。

## 与现有系统的集成点

### 需要修改的文件

1. `backend/src/services/episode-splitter.ts`
   - 移除 `opening_hook`、`cliffhanger_hook`、`series_hook` 的生成逻辑。
   - 保留 `summary` 字段（用于剧集列表展示）。

2. 新增 `backend/src/services/hook-designer.ts`
   - 实现 Hook Designer 核心逻辑。

3. 新增 task handler：`backend/src/services/tasks/handlers/hook-design.ts`
   - 注册到 worker。

4. 新增 intro 合成服务：`backend/src/services/intro-composer.ts`
   - 读取 `intro_templates` 配置，渲染开场动画视频。

5. 新增 task handler：`backend/src/services/tasks/handlers/intro-compose.ts`
   - 注册到 worker。

6. 新增 recap 合成服务：`backend/src/services/recap-composer.ts`
   - 复用 `composition/` 目录能力。

7. 新增 task handler：`backend/src/services/tasks/handlers/recap-compose.ts`
   - 注册到 worker。

8. `backend/src/services/tasks/handlers/merge-episode.ts`
   - 合并时按顺序 prepend intro 视频、recap 视频。

9. `backend/src/services/tasks/auto-pipeline.ts`
   - 在分集任务完成后，触发 Hook Design 任务。
   - 在 Hook Design 完成后，并行触发 Intro Compose 与 Recap Compose 任务。

10. 数据库 schema：`backend/src/db/schema.ts`
    - `episodes` 表新增字段：`intro_video_url`、`recap_script`、`recap_video_url`、`opening_hook`、`cliffhanger_hook`、`series_hook`。
    - 新增 `intro_templates` 表：`id`、`name`、`config`、`is_default`、`created_at`、`updated_at`。
    - `dramas` 表新增字段：`intro_template_id`。

## UI 与交互设计

新增功能需要融入现有 3 个核心页面：`剧集列表页`、`单集工作台`、`全局设置页`。

### 1. 全局设置页 — 开场动画模板管理

入口：在 `settings.vue` 的左侧导航增加 **「开场模板」** 标签（与 AI 服务、Agent 配置同级）。

显示内容：
- 模板列表：名称、默认标识、预览缩略图/视频、创建时间。
- 操作：设为默认、编辑、删除。
- 新建模板按钮。

编辑/新建弹窗：
- 模板名称（文本）
- 时长（秒）
- 背景类型：纯色 / 图片
- 背景值：颜色选择器或图片上传
- 主标题文字（支持 `{{dramaTitle}}`、`{{episodeNumber}}` 占位）
- 字体大小、颜色、位置
- 动画类型：淡入 / 缩放 / 滑动
- JSON 高级模式（可切换为原始 config 编辑，便于扩展）

### 2. 剧集列表页 — 为本剧选择开场模板

位置：在 `pages/drama/[id]/index.vue` 的头部信息区或智能分集弹窗中，增加一个 **「开场模板」** 选择器（`BaseSelect`）。

显示内容：
- 当前已选模板名称（若未选择则显示「使用默认模板」）。
- 下拉列出所有模板，第一项为「使用默认」。
- 切换后立即调用 `PUT /dramas/:id` 保存 `intro_template_id`。

智能分集结果面板调整：
- 原面板展示每集的 `opening_hook` / `cliffhanger_hook`，现在这些钩子由 Hook Designer 后续生成，因此改为显示 **集数、标题、摘要、预计时长**。钩子状态以标签展示「待生成」。

### 3. 单集工作台 — 查看与调整 intro/recap

位置一：`episode/[episodeNumber].vue` 的 **生产设置抽屉** 新增 **「开场与前情提要」** 区块。

显示内容：
- 开场模板：只读显示当前 drama 所选模板，提供「去项目设置修改」链接。
- 开场动画状态：未生成 / 已生成（显示 `intro_video_url`，可播放）。
- 前情提要脚本（`recap_script`）：多行文本，可编辑；第 1 集不显示。
- 开场钩子（`opening_hook`）：可编辑。
- 集尾悬念（`cliffhanger_hook`）：可编辑。
- 全剧钩子（`series_hook`）：第 1 集显示，可编辑；其他集可折叠。
- 操作按钮：
  - 「重新生成开场动画」—— 触发 `intro.compose` 任务。
  - 「重新生成前情提要」—— 触发 `recap.compose` 任务（仅第 2 集及以后）。

位置二：`导出面板` 的镜头概览上方增加 **片头结构** 小卡片：

```
[Intro] 开场动画 — 3s      [播放]
[Recap] 前情提要 — 18s     [播放]  （第 2 集及以后）
[正文] 第 1 镜头 — ...
```

主视频播放器仍播放完整合并视频（已包含 intro + recap），片头结构用于快速定位。

### 4. 需要新增的 API 端点

- `GET /intro-templates` — 列表
- `GET /intro-templates/:id` — 详情
- `POST /intro-templates` — 创建
- `PUT /intro-templates/:id` — 更新
- `DELETE /intro-templates/:id` — 删除
- `POST /intro-templates/:id/set-default` — 设为默认

现有端点扩展：
- `PUT /dramas/:id` 增加可接受字段 `intro_template_id`。
- `PUT /episodes/:id` 增加可接受字段 `recap_script`、`opening_hook`、`cliffhanger_hook`、`series_hook`。
- `GET /dramas/:id` 与 `GET /episodes/:id/*` 已自动返回新增字段（因为字段已在 schema 中）。

### 5. 前端 composables 扩展

在 `useApi.ts` 中新增：

```ts
export const introTemplateAPI = {
  list: () => api.get('/intro-templates'),
  get: (id: string) => api.get(`/intro-templates/${id}`),
  create: (data: any) => api.post('/intro-templates', data),
  update: (id: string, data: any) => api.put(`/intro-templates/${id}`, data),
  del: (id: string) => api.del(`/intro-templates/${id}`),
  setDefault: (id: string) => api.post(`/intro-templates/${id}/set-default`, {}),
}
```

## 风险与备选

| 风险 | 影响 | 备选方案 |
|------|------|----------|
| 上一集未合成完成，recap 无画面可用 | Recap 合成阻塞 | 用 `first_frame_image` 代替 `composed_video_url` 的首帧 |
| recap_script 生成过长 | 观众失去耐心 | 在 prompt 中强制字数限制，并在合成前校验 |
| Hook Designer 失败导致后续流程阻塞 | 无法进入分镜 | 允许跳过 Hook Design，用空 recap 继续（降级体验） |
| Intro Composer 模板解析失败 | 开场动画缺失 | 降级为 1 秒黑场 + 剧名静态图 |
| 用户未选择模板 | 不知道该用哪个开场 | 使用 `is_default=true` 的模板 |

## 验收标准

1. 每一集合成后的成片开头都包含开场动画（Intro）。
2. 从第二集开始，每集开场动画后包含 15-25 秒 recap。
3. Recap 内容能概括上一集关键事件，让观众理解当前集前因。
4. Recap 结束后自然过渡到正文，不突兀。
5. 用户可在剧集设置中选择或切换开场动画模板。
6. 失败时至少能降级为无 intro/recap 的正片，不阻塞整体流程。
