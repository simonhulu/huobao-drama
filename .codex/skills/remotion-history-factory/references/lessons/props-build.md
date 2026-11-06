# Props 构建失败

对应错误：`PROPS_BUILD_FAILED`（props_build 阶段）。

## 常见根因（错误信息里有具体一条）

1. **BGM 不可用**：`environmentFacts.bgm` 指向的文件不存在，或时长 < 30s
   → 见 `bgm-missing.md`。
2. **派生 BGM 音量超过 0.5 上限**：旁白 −14 LU 的目标需要把 BGM 推得过响
   → 换一条更安静的循环，**不要**调大上限。
3. **panel emphasis 帧序非法**：manifest panel 窗口不单调（首格必须从 0 帧
   开始且严格递增）→ 上游 manifest 数据问题，回 manifest 阶段修，见
   `manifest.md`。
4. **资产/TTS 文件缺失**：props 锚定的任一文件（音频、BGM、panel）不在
   盘上 → 查 run 目录与 frozen TTS 文件是否被清理过；被清理则
   `start-new-run`。

## 正确反应

瞬时原因（文件刚好在同步中等）→ `retry-action`；数据性原因 → 修上游后
`start-new-run`。新 props 会让旧的 frame 审批自动失效（runner 会清掉
过期证据），这是特性，不需要手工清理。
