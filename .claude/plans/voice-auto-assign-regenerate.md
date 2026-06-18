# 音色自动分配 + 配音重生成

## 背景(已确认的根因)
- **问题1**:现有"分配音色"是 LLM agent(`voice_assigner`),无规则化默认值,每个角色要手选。
- **问题2 三处卡点**:
  1. `composeStoryboard` 复用已存在的 `ttsAudioUrl`/`narrationAudioUrl`(缓存),改音色不重生成。
  2. 前端 `batchShotTTS` 过滤 `!hasTTS`,已配音镜头被跳过。
  3. 改音色入口(`characters` PUT、`assign_voice` 工具)只清角色 `voiceSampleUrl`,不清 storyboard 的 `ttsAudioUrl`/`composedVideoUrl`。
- 一致性:单镜头 `/generate-tts` 走单音色老逻辑;多角色分音色只在 compose 链路。重生成要统一。

## 用户决策
1. 规则化默认音色:**提取角色后自动填默认(仅未分配的)**,保留手动改 + 现有 LLM 按钮。
2. 重生成:**改音色自动作废相关镜头配音+成片 + 提供手动「重新生成」按钮**。

---

## Part 1 — 规则化自动分配音色

### 新建 `backend/src/services/voice-auto-assign.ts`
- `pickVoiceForCharacter(char, voices)`:确定性打分匹配。
  - 推断**性别**:从 name/role/personality/description 关键词(男/女/老汉/大婶/少女/御姐/弟/姐…)。
  - 推断**年龄段**:老(七十/老/大爷/奶奶/老汉)、青年(青年/小伙/学生)、中年等。
  - 推断**定位**:主角/反派/配角/龙套 + 性格(蛮横/沉稳/精明…)。
  - 对音色库 `voiceName` 做关键词加权匹配(青涩青年/霸道少爷/搞笑大爷/热心大婶/沉稳高管…),取最高分;无强匹配时按性别回退默认(男→温润男声、女→甜美女声)。
- `autoAssignVoices(dramaId, { overwrite=false })`:载入该集 audio provider 的音色库,对未分配(或 overwrite 时全部)角色逐个 `pickVoiceForCharacter` 并写 `voiceStyle`/`voiceProvider`。返回分配结果列表。

### 新增端点 `POST /characters/auto-assign-voices`
- body: `{ episode_id, overwrite? }`,解析 dramaId,调 `autoAssignVoices`,返回 `{ assigned: [{id,name,voice_id}] }`。

### 触发(自动)
- 前端 `doExtract` 的完成回调链:提取 agent 跑完 → 调 `voicesAPI.autoAssign(episodeId)` → `refresh()`。
- 保留 `doVoice`(LLM)按钮不动;音色 tab 增设「智能默认分配」按钮手动复跑(overwrite 可选)。

---

## Part 2 — 配音重生成

### 抽共用对白音频构建器(`ffmpeg-compose.ts` 导出)
- 把 compose 里 1b「多角色逐行分音色→concat」逻辑抽成 `buildDialogueAudioForStoryboard(sb, ep, { force })`,compose 与 generate-tts 路由共用,保证单镜头配音也走多角色。

### compose 支持强制重生成
- `composeStoryboard(id, { force=false })`:force 时忽略 `ttsAudioUrl`/`narrationAudioUrl` 缓存,重新生成音频再合成。
- `routes/compose.ts` 两个端点接收 `?force=1`。

### generate-tts 路由统一多角色 + 重生成
- `routes/storyboards.ts` 的 `/generate-tts` 改用 `parseDialogueLines` + 共用构建器(多角色),且作为显式动作**总是重生成**(覆盖旧 `ttsAudioUrl`)。

### 改音色 → 自动作废
- 抽 `invalidateCharacterAudio(dramaId, characterName)`:用 `parseDialogueLines` 找出该 drama 下 dialogue 含此说话人的 storyboards,置 `ttsAudioUrl=null`、`composedVideoUrl=null`、`status` 复位。
- 挂到 `characters` PUT(voiceStyle 变更时)和 `assign_voice` 工具。
- 旁白音色是全局 `NARRATION_VOICE`,与角色无关,`narrationAudioUrl` 不动。

### 前端按钮
- 配音区:`batchShotTTS` 旁新增「重新生成全部配音」(对已配音镜头也重跑);单镜头在 `hasTTS` 时显示「重新生成配音」→ 调 generate-tts(现已重生成+多角色)。
- 合成区:利用 force 让「重新合成」忽略缓存(若已有重新合成按钮则加 force;无则在 compose tab 加「重新合成」)。

---

## 验证
- typecheck 后端;前端手测。
- 实测:改福来音色 → 相关镜头 ttsAudioUrl 被清;点重新生成配音 → 新音色生效、多角色分轨;旁白不受影响。
- 提取一集 → 角色自动带默认音色(福来→霸道青年类、祝老栓→搞笑大爷、村主任→沉稳高管、老婶子→热心大婶)。

## 风险/边界
- 关键词匹配是启发式,可能不完美 → 用户可手动改;只填未分配,不覆盖已选。
- 作废按说话人精确匹配 dialogue,避免误伤无关镜头。
