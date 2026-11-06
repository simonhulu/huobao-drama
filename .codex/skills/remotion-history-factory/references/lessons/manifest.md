# Manifest 构建失败 / 已冻结的 manifest 不再当前

对应错误：`MANIFEST_BUILD_FAILED` / `MANIFEST_INVALID` / `MANIFEST_CHANGED`。

## MANIFEST_BUILD_FAILED

`build_history_comic_manifest.mjs` 退出非 0 或被独立校验器拒绝。错误信息里
有 builder 的 stderr 或校验缺陷列表，按列表修上游数据（panel 窗口重叠、
tts 标题越界、panel < 5 个等）。修好后 `retry-action`。

## MANIFEST_CHANGED

冻结的 manifest SHA-256 与盘上文件不一致，或 manifest 不再绑定当前冻结
TTS——**上游数据（storyboards / narrative plan / TTS 主轨）在 run 中途变了**。

- 冻结意味着「这个 run 的一切下游证据都锚定这组字节」。任何上游变更都
  让整条证据链失效，无法安全续跑。
- 唯一正确动作：`start-new-run`，新 revision 重新冻结当前数据。
- **永远不要**手工编辑 `history-comic.manifest.json`、`tts-titles.json`
  来"对齐"——SHA 绑定会立刻抓出第二处不一致，而且审批证据全部作废。
