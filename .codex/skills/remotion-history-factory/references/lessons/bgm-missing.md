# BGM 未配置：API 字段未暴露 + 流程缺少 BGM 选择步骤

**日期**: 2026-07-25 · **集数**: Episode 602
**后果**: 第一次渲染没有 BGM，用户反馈后才补上。

## 根因

两个独立的问题叠加：

1. `bgmAudioUrl` 和 `bgmPlanJson` 不在 `PUT /episodes/:id` 的 allowed 字段列表里，
   Web UI 根本没法配置 BGM
2. Skill 的 Creative Workflow 没有"选择 BGM"这一步，agent 不会主动去选

## 修正

1. 把 `bgm_audio_url` 和 `bgm_plan_json` 加入 `episodes.ts` 的 allowed 列表，
   并加上 snake_case → camelCase 映射（代码已修复，不会复发）
2. 渲染前验证：`episodes.bgmAudioUrl` 必须非空

## 防错规则

- **渲染前验证 BGM**：
  ```sql
  SELECT bgm_audio_url FROM episodes WHERE id = ? AND bgm_audio_url IS NOT NULL
  ```
  如果返回空，说明 BGM 未配置，必须先选曲再渲染
- **Skill 流程检查**：运行任何渲染/环境检查之前，确认 `bgmAudioUrl` 指向
  存在的文件，且时长 ≥ 30 秒（太短会频繁循环，听感差；history runner 的
  environment_check 会硬性拒绝 < 30s 的 BGM）
