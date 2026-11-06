# 花生项目 API 创作链路

2026-11-02 对已登录专用浏览器中的项目 `268238449803425` 做了只读观察；创建请求通过本地拦截取得结构，没有发送测试创建。实现位于 `backend/src/services/history-huasheng-api.ts`，历史、科普、奇闻默认优先走该接口链路。原 `runHuashengBrowserJob` 保留为独立浏览器链路，可用 `HUASHENG_CREATION_DRIVER=browser` 强制启用；接口会话准备失败且没有发出变更请求时也自动回退。

## 请求顺序

1. 从绑定账号的专用浏览器读取现有登录 cookie、CSRF 和站点正常请求生成的 `_ra/_bs/_fv`。`_ra` 是短期会话参数，长任务会重新读取；不把这些值写入任务或日志。
2. `GET /api/innovideo/config`、`GET /api/innovideo/material/tts/list?pn=1&ps=200&category_id=0` 读取默认及最近使用的配音。`POST /api/huasheng/project/create?csrf=...&_ra=...&_bs=...&_fv=...` 提交完整 `script`、标准模式 `is_fast:false`、画幅和配音。请求还含页面当前的 `s/t` 校验字段。只有业务码 0 且返回有效 `data.pid` 才保存项目链接；之后用 `/api/innovideo/project/info` 的原稿核对项目归属。服务端会自动发起首轮解析。
3. `GET /api/agent/project/chat/history?pid=...&limit=20&csrf=...` 等待首轮 `AskQuestion` + `RunPaused` 出现 A/B 选项。随后 `POST /api/agent/project/chat/run?pid=...&csrf=...`，请求体为 `{"pid":数字,"content":[{"type":"text","text":{"content":"A - 素材剪辑成片"}}]}`。按返回 `run_id` 和历史提问等待“确认 / 需要修改”。
4. 对同一 `chat/run` 发送 `确认`，等历史出现“确认，开始制作 / 需要调整”。`GET /api/agent/project/storyboard/get` 与 `GET /api/huasheng/project_plan/cost` 必须指向同一 `run_id` 和规划哈希，且 `is_latest=true`、`status=1`、`point=0`。
5. 保存 `confirm_pending` 后，`POST /api/huasheng/project_plan/confirm`，请求体为 `{"pid":数字,"run_id":"...","plan_hash":"..."}`。业务码 `10008` 表示标准模式当日额度不足，保存为 `quota_waiting`；不会自动切换快速模式。业务码 0 后用现有只读制作状态接口核对排队、创作或完成，才标记 `submitted`。

每次 POST 前先持久保存检查点。创建或最终确认响应不明时不自动重发；恢复优先核对原项目。浏览器链路仍可作为手动检查和备份。`/api/v2/innovideo/project/checkpoint/list` 在这条尚未开始制作的项目上返回空 `items`，因此不能用其空列表判定聊天解析完成；对话完成以 `chat/history` 的事件和 `current_state` 为准。`/api/v2/innovideo/project/info` 用于最终制作状态，不能把项目 `progress=100` 单独当成视频已完成。

## 指定克隆音色

`HuashengBrowserInput.voiceId` 可显式指定账号的克隆音色，`voiceType` 使用项目接口的类型值。指定后通过 `/api/innovideo/voice/clone/list` 核对 ID、可用状态及克隆类别，不采用账号最近使用的普通音色。注意两套类型编码不同：克隆列表 `voice_type: "2"` 映射为创建和修改项目请求的 `voice_type: 1`；项目接口的 `voice_type: 2` 表示上传音频。该映射已对照当前网页的首页创建及更换音色代码。

创建或恢复项目后对照 `/api/innovideo/project/info` 的 `project.voice_id`、`project.voice_type` 再核验。找不到指定音色、项目音色不一致或接口会话失败时不回退浏览器默认选择。未指定音色的既有历史等业务沿用原默认规则。

## 验证边界

已实测账号会话、原项目的 `chat/history`、规划书与零消耗查询；新驱动的创建 POST 通过本机拦截验证了参数和签名，未向花生创建额外项目。该账号的真实最终确认曾返回业务码 `10008`，因此这次没有新的成功创建及制作提交样本。接口行为变化时应使用保留的浏览器驱动核对原项目。
