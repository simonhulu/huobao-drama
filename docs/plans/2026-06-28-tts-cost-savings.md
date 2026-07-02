# TTS 成本节约计划

> **Goal:** 将 MiniMax TTS 默认模型从 `speech-2.8-hd` 降级为 `speech-2.8-turbo`，并消除 narration_only 模式下无意义角色试听样本的生成。

**Architecture:** 在 TTS adapter 与音频配置层统一默认模型；在 drama 预生产和自动流水线中检测 episode 的 `dialogueMode`，narration_only 时跳过 `tts.character_sample` 任务创建。

**Tech Stack:** Hono + TypeScript + Drizzle ORM + SQLite + MiniMax TTS

---

## 现状与浪费点

1. **模型全部使用 hd：** 数据库 `ai_service_configs` 中 audio 配置为 `["speech-2.8-hd"]`，代码 fallback 也是 hd，旁白/对白/试听样本全部走高价模型。
2. **角色试听样本浪费：** 已生成 46 个 `tts.character_sample`，对应角色全部只参演 `dialogue_mode='narration_only'` 的剧集，这些样本永远用不到。
3. **音色复刻未发生：** 代码中没有调用 MiniMax 的 voice design / cloning API（¥9.9/音色），`voiceSampleUrl` 只是普通 TTS 试听，不是复刻。

## 预期节约

- **模型切换：** 当前已生成约 5.1 万字符 TTS，hd→turbo 差价 ¥1.5/万字符，历史账单可少约 ¥7.7；未来随产量线性节约 43%。
- **跳过试听样本：** 46 个已生成样本 × 约 25 字 × ¥2.0/万字符 ≈ ¥0.23；未来每部 narration_only 剧集的角色数都直接省掉。

## 改动清单

### Task 1: 切换默认 TTS 模型

**Files:**
- Modify: `backend/src/services/adapters/minimax-tts.ts:60`
- Modify: 数据库 `ai_service_configs` id=4 的 `model` 字段

**Step 1: 改代码默认 fallback**

将
```ts
model: params.model || config.model || 'speech-2.8-hd',
```
改为
```ts
model: params.model || config.model || 'speech-2.8-turbo',
```

**Step 2: 更新数据库配置**

```sql
UPDATE ai_service_configs SET model = '["speech-2.8-turbo"]' WHERE id = 4;
```

**Step 3: 验证**

```bash
cd backend && sqlite3 ../data/huobao_drama.db "SELECT model FROM ai_service_configs WHERE id=4;"
```

Expected: `["speech-2.8-turbo"]`

---

### Task 2: narration_only 模式下跳过角色试听样本

**Files:**
- Modify: `backend/src/services/tasks/auto-pipeline.ts:400-438` (`scheduleVoiceSampleTasks`)
- Modify: `backend/src/services/tasks/handlers/drama-pre-production.ts:321-358` (样本任务创建循环)

**Step 1: 在 `scheduleVoiceSampleTasks` 中增加 dialogueMode 判断**

在函数开头读取 episode，如果 `dialogueMode === 'narration_only'`，直接返回空任务列表。

```ts
export function scheduleVoiceSampleTasks(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (ep?.dialogueMode === 'narration_only') {
    return { parentTask: null, childTasks: [] }
  }
  // ... 原有逻辑
}
```

**Step 2: 在 `drama-pre-production.ts` 中同样跳过**

在创建 `tts.character_sample` 任务前判断：

```ts
// 5. 为没有样本的角色生成音色样本（仅当 drama 下存在非 narration_only 剧集时才需要）
const hasNonNarrationOnlyEpisode = episodes.some(ep => ep.dialogueMode !== 'narration_only')
if (!hasNonNarrationOnlyEpisode) {
  logTaskSuccess('DramaPreProduction', 'skip-voice-samples', { dramaId, reason: 'all_episodes_are_narration_only' })
} else {
  // 原有创建样本任务逻辑
}
```

**Step 3: 写测试覆盖**

在 `backend/src/services/tasks/handlers/drama-pre-production.test.ts` 中新增测试：

```ts
test('drama.pre_production skips voice samples when all episodes are narration_only', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script')
  // 设置 episode 为 narration_only
  db.update(schema.episodes).set({ dialogueMode: 'narration_only' }).where(eq(schema.episodes.id, episodeId)).run()
  // 插入一个无 voiceSampleUrl 的角色
  const charId = Number(db.insert(schema.characters).values({
    dramaId, name: 'Unused', voiceStyle: 'voice-a', createdAt: now(), updatedAt: now()
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: now() }).run()

  const handler = createDramaPreProductionHandler({
    createAgent: mockAgentFactory(),
    createImageGenerationRecord: mockCreateImageGenerationRecord,
  })
  const task = createTask({ type: 'drama.pre_production', payload: { drama_id: dramaId } })
  await handler.run(makeContext(task))

  const sampleTasks = db.select().from(schema.creationTasks).where(eq(schema.creationTasks.type, 'tts.character_sample')).all()
  assert.equal(sampleTasks.length, 0, 'narration_only 剧集不应生成角色试听样本')
})
```

**Step 4: 运行测试**

```bash
cd backend && npm test -- src/services/tasks/handlers/drama-pre-production.test.ts
```

Expected: PASS

---

### Task 3: 验证整体行为

**Step 1: 运行相关测试**

```bash
cd backend && npm test -- src/services/tasks/handlers/tts-generate.test.ts src/services/tts-generation.test.ts src/services/tasks/handlers/agent-run-direct-script.test.ts
```

Expected: PASS

**Step 2: 类型检查**

```bash
cd backend && npm run typecheck
```

Expected: 无错误

---

## 回滚方案

- 代码：git revert 本次提交
- 数据库：
  ```sql
  UPDATE ai_service_configs SET model = '["speech-2.8-hd"]' WHERE id = 4;
  ```
