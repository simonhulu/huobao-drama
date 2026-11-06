# Remotion 项目不需要删了重建来反映分镜变更

**日期**: 2026-07-25 · **集数**: Episode 602
**后果**: Episode 从 Web UI 的任务列表消失，用户看不到运行中的生产任务。

## 我犯了什么错误

把 38 个分镜拆成 97 个后，认为 Remotion 项目 #11 里保存的是旧的分镜快照，
就调 `DELETE /api/v1/remotion/projects/11` 删掉它，再用
`POST /api/v1/remotion/projects` 创建了项目 #12。

## 错误的心理模型

> Remotion 项目 = 创建时把 Episode 的当前状态（分镜、TTS、脚本）冻结成一个不可变的快照。
> 如果分镜变了，这个快照就过时了，必须删了重建。

**这个模型是错的。** 实际情况是：

1. `remotion_projects.source_snapshot_json` 确实在创建时存了一份快照
2. 但 **render 阶段读取的是 Episode 的当前数据**，不是快照里的旧数据
3. 项目只是一个「生产容器」——它记录进度、阶段、产出物，不持有分镜
4. 分镜的变更会自然地通过 `storyboards` 表和 `narrative_plans` 传播到渲染器

换句话说，**改分镜不需要动项目。** 删项目不仅多余，还会触发连锁故障：
`GET /api/v1/grid/productions` 会把所有「有过被删项目」的 episode 永久踢出列表，
新建的活跃项目根本不被考虑——任务在后台正常跑，用户在页面上什么都看不到。

## 正确的操作方式

```
1. 修改 storyboards 表（增删改分镜记录）
2. 重新 POST narrative-hierarchy/import（更新叙事计划）
3. 继续 grid.episode_generate —— 项目不需要任何修改
```

## 防错规则

- **禁止** `DELETE /api/v1/remotion/projects/:id`，除非用户明确要求废弃整个生产任务
- **如果你觉得需要删了重建，停下来。** 检查：你是在改分镜/叙事/样式数据吗？如果是，直接改数据就行，项目会自然感知
- **如果确实必须删除**：用 SQLite 永久删除行（`DELETE FROM remotion_projects WHERE id = ?`），不要用 API 软删除
- **任何项目变更后验证**：Episode 必须仍然出现在 `GET /api/v1/grid/productions` 的 items 列表中
