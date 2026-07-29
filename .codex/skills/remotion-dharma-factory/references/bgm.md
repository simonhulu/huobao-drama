# BGM 选曲规范（单轨制）

佛学/哲学口播的 BGM 哲学：**一首对的曲子从头到尾，比十首"贴合剧情"的曲子更高级**。
观众的大脑应该完全忘记 BGM 的存在——它是情绪的地暖，不是旋律的表演。

## 硬规则

- 全片一首长音床。曲源时长 **≥ 180s**；短 loop（哪怕 36s）不得拿来铺 8–12 分钟口播。
- 音量不是固定 `0.14`。props 构建先测 BGM / narration 的 integrated LUFS，再把 BGM
  定到无声间隙约低于人声 14 LU；旁白窗口再压低约 6 dB。
- 循环只在不可避免时发生，并且必须是 4 秒交叉淡变，不允许 `<Audio loop>` 的硬接缝。
- 渲染前必须配置 `episodes.bgm_audio_url`，否则 `dharma.episode_render` 直接失败。
- 测量失败、时长不够、或曲源太安静以至于需要 >0.5 增益时，直接换曲，不“调大音量”硬救。

## 选曲标准

按优先级：

1. **无强节奏**：ambient pad、钢琴独奏、合唱长音。鼓点/节拍器式的 loop
   会和旁白的自然语速打架。
2. **无旋律记忆点**：观众不该跟着哼。有记忆点的旋律在 10 分钟循环里
   会变成折磨。
3. **循环无痕**：曲子的首尾能量一致（loop 曲目天然满足； songs 结构
   （主歌-副歌）的不行）。
4. **情绪中性偏暖**：不悲伤、不激昂。文稿的情绪弧线由旁白和画面完成，
   BGM 只提供"安静的在场感"。

## 现成候选（data/static/music/freepacks/）

| 曲目 | 特点 | 适用 |
| --- | --- | --- |
| `holst-planets/2. Venus.mp3` | 500s、公共领域录音、管弦乐旋律存在感强 | **Episode 734 已审听否决**：不能作为默认佛学音床 |
| 新增 CC0 / Public Domain 长 ambient | 5–15 分钟、无强拍、无歌词 | **长期首选**：应建立“静室讲法”专用曲库 |
| `game-loops/FutureAmbient_2.wav` | 36s、热母带 | **禁止用于长口播**：会重复约 19 次且固定 0.14 曾盖过人声 |
| `Fantasy Choir` / `vampires-piano` / `Chillstep` | 短、旋律或节奏明显 | 仅可作为试听候选；没有长曲/审听证据时不得进入生产 |

`data/static/music/` 顶层 73 个 UUID .mp3 是 AI 生成的历史 BGM，命名无语义——
要用先在 `/library` 页面试听再选。

## 新增冥想/禅意曲包

本地曲库没有专用冥想包。补货路径：

```bash
cd backend && npx tsx ../scripts/import-free-audio-packs.ts --dry-run   # 看可导入包
```

或手动下载 CC0/royalty-free 曲包放到 `data/static/music/freepacks/<pack>/`，
刷新索引后在 `/library` 试听。来源与授权注意事项见
`docs/free-audio-resources.md`（CC0/Public Domain 可商用；CC-BY 需署名不适合；
Sonniss 禁 AI 训练）。

## 选曲流程

1. 通读文稿，确定基调（沉静/温暖/肃穆）。
2. 按上表取 2–3 个候选，各听 30s 以上（注意循环点）。
3. 选定后：

```text
PUT /api/v1/episodes/:id  { "bgm_audio_url": "static/music/<auditioned-long-bed>.mp3" }
```

4. 验证（渲染任务也会强制）：

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 backend/data/static/music/<auditioned-long-bed>.mp3
# ≥ 180.0
```

5. 在 preflight 阅读实测 LUFS / gain；若 production gate 要求 canary，只试听这一次风险窗口：
   BGM 可闻但不抢人声、旁白入句时会自然退后、循环点不可察。不满意就换曲并让审批失效后重走
   preflight；不要反复渲固定 pilot，也不要手改 props 的 gain 去救一首不对的歌。
