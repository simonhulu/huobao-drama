# [Episode 147] 平台反馈驱动的节奏改进方案

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 针对 episode 147（万历矿税，加速了大明的灭亡？ 5）的平台反馈（开头流失、完播率低、节奏拖沓），重写脚本并重新生成分镜，把时长从 ~275 秒压缩到 120-150 秒，同时保留核心冲突与信息密度。

**Architecture:** 不改数据表结构，直接基于现有 `episodes.content` / `script_content` 做脚本改写，再触发 `storyboard_breaker` + `narrator` 重新生成分镜与旁白；利用已有 `pacing_mode='tight'` 控制节奏，不新增字段。

**Tech Stack:** TypeScript, Hono, Drizzle ORM, better-sqlite3, Mastra Agent workflow, 现有 `storyboard_breaker` / `narrator` / `storyboard_splitter`。

---

## 背景与问题诊断

目标剧集：`episodes.id = 147`，`drama_id = 26`，`episode_number = 6`，标题 `万历矿税，加速了大明的灭亡？ 5`。

当前原始脚本（`content` / `script_content`）存在平台指出的三个拖沓点：

| 平台反馈时间段 | 当前脚本位置 | 问题 | 影响 |
|---|---|---|---|
| 00:10-01:02 | 开头详细列举“防患、惜财、怕扰动”三点理由 | 表面理由铺陈过长，核心论点“真实原因只有两个”出现太晚 | 第 6 秒留存从 52% 掉到 30% |
| 02:43-03:31 | 中段逐一列举太监四种征税手段（霸占、敲诈、摊派、收商税） | 信息罗列节奏慢，每个手段单独展开 | 中段观众流失 |
| 04:19-04:35 | 结尾“万历派太监收税，手段恶劣，将大明推向深渊” | 与前面论述高度重复 | 结尾疲软，提前结束 |

根本原因：当前 `direct_script` 模式下的脚本按原文结构平铺直叙，缺少“钩子前置 + 信息压缩 + 结尾利落”的短视频节奏。

---

## 预期结果

- 时长：从 ~275 秒 → **120-150 秒**。
- 结构：开头 3 秒出钩子，10 秒内进入核心论点，60 秒内讲完冲突与手段，结尾 10 秒收束。
- 镜头数：预计 10-14 个（当前未生成，按脚本密度估算）。

---

## Task 1: 分析当前脚本并确定改写范围

**Files:**
- Read: `data/huobao_drama.db` → `episodes.content WHERE id = 147`
- Reference: `docs/plans/pacing-acceleration-plan.md`

**Step 1: 读取当前脚本**

Run:
```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama
sqlite3 data/huobao_drama.db "SELECT content FROM episodes WHERE id = 147;" > /tmp/ep147_current.txt
wc -m /tmp/ep147_current.txt
```

Expected: ~1,500 字，约 275 秒旁白。

**Step 2: 标记三个需要压缩的段落**

在 `/tmp/ep147_current.txt` 中标注：
- `P1`：三点反对理由（防患 / 惜财 / 怕扰动）
- `P2`：四个征税手段（霸占 / 敲诈 / 摊派 / 收商税）
- `P3`：结尾重复总结

**Step 3: Commit 分析快照**

```bash
git add docs/plans/2026-07-01-episode147-retention-driven-rewrite.md
git commit -m "docs: add episode 147 retention-driven rewrite plan"
```

---

## Task 2: 生成改写后脚本

**Files:**
- Modify: `data/huobao_drama.db` → `episodes.content` / `episodes.script_content` for `id = 147`

**Step 1: 按平台建议草拟精简脚本**

目标字数：约 450-550 字，语速 1.2 倍时约 100-120 秒。

```text
【开头 · 0-8s】
大臣们反对万历开矿，理由冠冕堂皇。
但真实原因只有两个——而这两个原因，暴露了皇帝和整个官僚集团之间最赤裸的利益冲突。

【压缩铺垫 · 8-25s】
他们列出防患、惜财、怕扰动地方等理由，但万历心里有数：民间开矿明明能赚钱，这些都只是借口。
真正的原因只有两条：第一，矿税指标会摊派给百姓，等于变相加税；第二，这笔钱要进皇帝私库，不是国库。

【核心冲突 · 25-45s】
天子与民争利，大臣们当然不干。
万历也不傻，绕开外廷，直接派太监去各地收矿税，还给每个太监定下硬指标。

【加速手段 · 45-70s】
太监们为了交差，什么手段都使得出来：霸占民矿、敲诈富户、按户摊派、设卡收商税，闹得全国鸡飞狗跳，民变四起。

【结尾 · 70-85s】
地方官和他们也是死对头。矿税收上来直接交给皇帝个人，等于从地方抽血。
云南矿税案为什么查不下去？因为满朝文武，早就不想再查了。
```

**Step 2: 将改写脚本写入数据库**

Run:
```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama/backend
node -e "
const Database = require('better-sqlite3');
const db = new Database('../data/huobao_drama.db');
const newContent = \`大臣们反对万历开矿，理由冠冕堂皇。但真实原因只有两个——而这两个原因，暴露了皇帝和整个官僚集团之间最赤裸的利益冲突。

他们列出防患、惜财、怕扰动地方等理由，但万历心里有数：民间开矿明明能赚钱，这些都只是借口。真正的原因只有两条：第一，矿税指标会摊派给百姓，等于变相加税；第二，这笔钱要进皇帝私库，不是国库。

天子与民争利，大臣们当然不干。万历也不傻，绕开外廷，直接派太监去各地收矿税，还给每个太监定下硬指标。

太监们为了交差，什么手段都使得出来：霸占民矿、敲诈富户、按户摊派、设卡收商税，闹得全国鸡飞狗跳，民变四起。

地方官和他们也是死对头。矿税收上来直接交给皇帝个人，等于从地方抽血。云南矿税案为什么查不下去？因为满朝文武，早就不想再查了。\`;
db.prepare('UPDATE episodes SET content = ?, script_content = ?, updated_at = ? WHERE id = ?')
  .run(newContent, newContent, new Date().toISOString(), 147);
console.log('Updated episode 147, new length:', newContent.length);
"
```

Expected output: `Updated episode 147, new length: ~470`

**Step 3: 验证写入**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT length(content) FROM episodes WHERE id = 147;"
```

Expected: ~470 字符。

---

## Task 3: 清空旧分镜与媒体任务，准备重新生成

**Files:**
- Modify: `data/huobao_drama.db` → `storyboards`, `creation_tasks`, `assets` for `episode_id = 147`

**Step 1: 删除旧分镜**

Run:
```bash
sqlite3 data/huobao_drama.db "DELETE FROM storyboards WHERE episode_id = 147;"
sqlite3 data/huobao_drama.db "DELETE FROM storyboard_characters WHERE storyboard_id NOT IN (SELECT id FROM storyboards);"
```

Expected: 旧分镜清空（此前 episode 147 无分镜，此步为兜底）。

**Step 2: 删除关联媒体任务**

Run:
```bash
sqlite3 data/huobao_drama.db "DELETE FROM creation_tasks WHERE episode_id = 147;"
sqlite3 data/huobao_drama.db "DELETE FROM creation_task_dependencies WHERE task_id NOT IN (SELECT id FROM creation_tasks);"
sqlite3 data/huobao_drama.db "DELETE FROM creation_task_events WHERE task_id NOT IN (SELECT id FROM creation_tasks);"
```

**Step 3: 确认 episode 状态为可重新生成**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT id, status, pacing_mode FROM episodes WHERE id = 147;"
```

Expected: `status = 'draft'`, `pacing_mode = 'literal'` or `'tight'`.

---

## Task 4: 触发 storyboard breaker 重新分镜

**Files:**
- Use API endpoint: `POST /api/agent/run` or frontend「重新拆解」按钮
- Reference: `backend/src/routes/agent.ts`

**Step 1: 确认后端正在运行**

Run:
```bash
curl -s http://localhost:5679/api/health
```

Expected: HTTP 200 with healthy status.

**Step 2: 调用 breaker agent**

Run:
```bash
curl -s -X POST http://localhost:5679/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"episodeId": 147, "task": "breakdown"}'
```

Expected: 返回任务 ID 或开始同步执行（取决于接口实现）。

**Step 3: 等待并检查分镜结果**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT storyboard_number, duration, substr(narration,1,60) FROM storyboards WHERE episode_id = 147 ORDER BY storyboard_number;"
```

Expected: 10-14 个镜头，每个镜头 narration 1-2 句。

---

## Task 5: 触发 narrator 重新生成旁白与音频

**Files:**
- Use API endpoint: `POST /api/agent/run`
- Reference: `backend/src/agents/index.ts` narrator agent config

**Step 1: 调用 narrator agent**

Run:
```bash
curl -s -X POST http://localhost:5679/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"episodeId": 147, "task": "narration"}'
```

**Step 2: 检查旁白字数与时长**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT storyboard_number, duration, length(narration) as nl, narration FROM storyboards WHERE episode_id = 147 ORDER BY storyboard_number;"
```

Expected: 总时长 120-150 秒；每个镜头 narration 不超过 2 句。

---

## Task 6: 验证节奏与平台反馈对应项

**Files:**
- Read: `data/huobao_drama.db` → `storyboards` for `episode_id = 147`

**Step 1: 检查三点反对理由是否被压缩**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT narration FROM storyboards WHERE episode_id = 147 AND narration LIKE '%防患%';"
```

Expected: 仅 1 个镜头包含“防患/惜财/怕扰动”，且为一句话带过。

**Step 2: 检查四种征税手段是否合并**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT narration FROM storyboards WHERE episode_id = 147 AND narration LIKE '%霸占%';"
```

Expected: 1 个镜头内同时出现“霸占、敲诈、摊派、设卡收商税”。

**Step 3: 检查结尾无重复总结**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT storyboard_number, narration FROM storyboards WHERE episode_id = 147 ORDER BY storyboard_number DESC LIMIT 2;"
```

Expected: 结尾镜头直接落在“云南矿税案查不下去 / 满朝文武不想查”，无“将大明推向深渊”式重复。

**Step 4: 汇总总时长与镜头数**

Run:
```bash
sqlite3 data/huobao_drama.db "SELECT COUNT(*) as shots, SUM(COALESCE(duration,0)) as total_seconds FROM storyboards WHERE episode_id = 147 AND deleted_at IS NULL;"
```

Expected: `shots` 10-14, `total_seconds` 120-150。

---

## Task 7: 可选 — 把本次改写经验沉淀为提示词模板

**Files:**
- Create: `backend/src/services/script-retention-optimizer.ts`
- Modify: `backend/src/agents/tools/script-tools.ts`

如果希望系统能复用本次“平台反馈 → 脚本压缩”的逻辑，可以新增一个轻量工具函数。

**Step 1: 创建优化器函数**

```typescript
// backend/src/services/script-retention-optimizer.ts
export interface RetentionIssue {
  type: 'slow_opening' | 'list_heavy' | 'repetitive_ending'
  description: string
  suggestedFix: string
}

export function compressScriptByRetentionIssues(
  script: string,
  issues: RetentionIssue[],
): string {
  // 当前为占位实现：直接返回输入
  // 未来接入 LLM 重写 pipeline
  return script
}
```

**Step 2: 添加测试**

Create: `backend/src/services/script-retention-optimizer.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { compressScriptByRetentionIssues } from './script-retention-optimizer.js'

describe('script-retention-optimizer', () => {
  it('returns script unchanged when no issues provided', () => {
    const script = '大臣们反对万历开矿。'
    assert.equal(compressScriptByRetentionIssues(script, []), script)
  })
})
```

**Step 3: 运行测试**

Run:
```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama/backend
npx tsx --test src/services/script-retention-optimizer.test.ts
```

Expected: PASS

**Step 4: Commit**

```bash
git add backend/src/services/script-retention-optimizer.ts backend/src/services/script-retention-optimizer.test.ts
git commit -m "feat: add retention-driven script optimizer scaffold"
```

---

## 风险与回退

| 风险 | 回退方案 |
|---|---|
| 改写后信息密度过高，观众看不懂 | 保留原脚本备份，可随时回写；或把 `pacing_mode` 改回 `standard` 重新生成 |
| 重新生成失败 | 检查 `creation_tasks` 日志；后端 `agent.run` 接口有错误返回 |
| 镜头数仍然过多 | 手动在 `storyboards` 删除纯过渡镜头，或再压缩脚本 |

---

## 建议的下一步

1. 先执行 Task 1-2：把改写脚本写入 episode 147。
2. 执行 Task 3-6：清空旧数据，重新跑 breaker + narrator，拿到新分镜和时长。
3. 对比前后数据，确认节奏改善后，再考虑是否沉淀为通用工具（Task 7）。
