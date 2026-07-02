# Spec: 每个镜头显示实际使用的 BGM / SFX / Ambient 素材索引

## Problem

当前 `http://localhost:3013/drama/26/episode/8` 的镜头列表和详情面板看不到每个镜头实际用了哪条 BGM、SFX 或环境音。用户无法判断：
- 某个镜头是不是完全没加声音；
- 加的 SFX 是不是合适的素材；
- BGM 来自素材库哪一项。

## Goal

在 episode 页面的每个镜头上显示其实际使用的音频素材索引：
- BGM：显示素材库条目（source、emotion_bucket、tags、文件名等）。
- SFX：显示音效文件名 / 所属 pack / 关键词。
- Ambient：显示环境底噪文件名 / 所属 pack / 关键词。
- 如果某类音频没有使用，显示“无”。

## Scope

只改“显示已有音频素材”这一层，不动：
- 音频选择算法；
- BGM/SFX 生成逻辑；
- 时长拆分、补图、精稿直出逻辑。

## Context

- BGM 已存储在 `storyboards.bgm_audio_url`，生成/选择逻辑在 `backend/src/services/music-generation.ts`。
- SFX 在 `backend/src/services/ffmpeg-compose.ts:386-394` 里临时选出，**没有回写**到数据库。
- Ambient 在 `backend/src/services/ffmpeg-compose.ts:428-448` 里临时选出，也**没有回写**。
- 前端 BGM 详情已有 `libraryAPI.lookupMusic(path)` 查询，SFX 只有 `/library/sfx` 列表，没有按 path 查询接口。

## Approach

### Backend

1. **Schema**
   - `storyboards` 表已有 `sfx_audio_url: text`。
   - 新增 `ambient_audio_url: text('ambient_audio_url')`。
   - 为 `sfx_audio_url` 和 `ambient_audio_url` 存 **relative path**（如 `static/sfx/...`），与 BGM 的 `bgm_audio_url` 风格保持一致。

2. **持久化 SFX / Ambient 选择结果**
   - 在 `backend/src/services/ffmpeg-compose.ts` 中：
     - 选好 `sfxFilePath` 后，把相对路径写进 `storyboards.sfx_audio_url`。
     - 选好 `ambientFilePath` 后，把相对路径写进 `storyboards.ambient_audio_url`。
   - 只在 `compose.storyboard` 流程里写，失败不阻塞合成。

3. **SFX lookup API**
   - 在 `backend/src/routes/library.ts` 新增：
     - `GET /api/v1/library/sfx/lookup?path=static/sfx/...`
     - 根据 `relativePath` 查 `sfx-mapping.json`，返回 `{ path, pack, keywords, url }`，找不到返回 `null`。

4. **字段映射**
   - 在 `backend/src/routes/storyboards.ts` 的 `fieldMap` 里确认 `sfx_audio_url` / `ambient_audio_url` 可正常序列化（snake_case）。

### Frontend

5. **Shot list（镜头卡片/缩略图区域）**
   - 在 `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue` 的镜头列表项上，增加一行小标签：
     - `BGM` / `SFX` / `AMB` 图标或文字；
     -  hover 或点击后显示素材名；
     - 没有就显示“无”。
   - 目标：一眼能看出哪些镜头缺少声音。

6. **Detail panel（右侧详情面板）**
   - 在现有 BGM 播放器下方新增：
     - **SFX**：如果有 `sfx_audio_url`，显示播放器 + 素材信息（pack、keywords）；没有显示“无”。
     - **Ambient**：如果有 `ambient_audio_url`，显示播放器 + 素材信息；没有显示“无”。
   - 使用新增的 `libraryAPI.lookupSfx(path)` 查询素材详情。

7. **前端 API 封装**
   - 在 `frontend/app/composables/useApi.ts` 的 `libraryAPI` 增加：
     - `lookupSfx: (path: string) => api.get<any>(`/library/sfx/lookup?path=${encodeURIComponent(path)}`)`

## Verification

1. 打开 `http://localhost:3013/drama/26/episode/8`。
2. 已合成的镜头详情面板能看到 BGM、SFX、Ambient 的实际素材名，无则显示“无”。
3. 镜头列表项上有声音类型标签。
4. 重新合成一个镜头后，`storyboards.sfx_audio_url` 和 `ambient_audio_url` 有值。
5. 后端 `npm run typecheck` 通过。
6. 前端 `npm run dev` 无类型报错，页面正常渲染。

## Risks

- 老数据没有 `sfx_audio_url` / `ambient_audio_url`，显示为“无”，需要重新合成一次才能回填。
- SQLite 新增列需要迁移；本项目用 Drizzle + 启动时 raw SQL 补丁，新增 nullable text 列无风险。

## Out of scope

- 修改 SFX / Ambient 选择算法；
- 修改 BGM 生成逻辑；
- 8 秒时长拆分；
- direct_script 精稿直出改造。
