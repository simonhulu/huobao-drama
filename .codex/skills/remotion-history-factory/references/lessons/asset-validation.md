# 画格资产校验 / 接触表失败

对应错误：`ASSET_INVALID` / `ASSET_CONTACT_SHEET_FAILED` / `ASSET_AUTO_APPROVAL_FAILED` / `VISUAL_APPROVAL_INVALID`。

## ASSET_INVALID

panel 文件缺失、为空、或两格内容字节完全相同（asset reuse 禁止）。这是
上游生成问题：回到 generate_ensure 视角查缺格原因（见
`generate-incomplete.md`），修好后 `start-new-run`。

## ASSET_CONTACT_SHEET_FAILED

ffmpeg 拼接触表失败——先确认所有 panel 文件能被 ffmpeg 解码（损坏的图
会让 xstack 直接失败）。

## ASSET_AUTO_APPROVAL_FAILED / VISUAL_APPROVAL_INVALID

接触表字节在生成后变了（SHA 不匹配）。审批锚定字节，字节变了必须
`contact-sheet` 重建再自动审批。**不要**手工改审批记录里的 SHA。

## 孤儿接触表自愈（runner 行为，了解即可）

进程被杀可能留下「盘上 sheet 有效但 run.json 没记录」的孤儿。runner 在
收集事实时会校验 `history-comic.assets.jpg.json` 索引是否与当前 manifest
panel 集完全一致，一致则自动重新挂接（事件日志记
`artifact_self_healed`），不需要手工干预；不一致才走正常重建路径。
