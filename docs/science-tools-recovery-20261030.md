# 科普结构化生成与原任务恢复（2026-10-30）

科普分析和成稿已改为强制调用指定函数。两条报错的原任务均已恢复到 `review`（文稿待检查），修复已加载到运行中的后端。

## 原因与修复

- `science-a3f8eb9c-9ba4-45b1-a3f1-0342ea8d793c`：模型返回的 `angle`、`facts` 类型与程序约定不符。旧格式回退又产生了缺少 `outline` 的错误。现由实际 Zod Schema 生成工具参数，分析必须调用 `submit_science_plan`，成稿必须调用 `submit_science_script`；移除新响应的旧格式回退，不猜测或转换错误字段。
- `science-03befca9-1bb4-4ea4-91c0-b35d28aca0c4`：`text` 为空发生在语音识别阶段。原视频长 968.736508 秒，最后单独切出的约 8.7 秒反复返回空文本。现将不超过 20 秒的短尾段合并到前段，并限制合并后不超过 500 秒，保留全部音频；这条任务复用了前 480 秒的缓存，重新识别后半段后成功。

工具请求设置 `strict: true`、指定名称的 `tool_choice` 和 `parallel_tool_calls: false`，所有对象禁止额外字段，字段全部必填。仅接受正常完成、名称正确且唯一的工具调用；缺失、截断或普通文本响应直接报错。收到参数后仍校验字段、证据引用和文稿内容，缓存方案同样重新校验。

空转写最多尝试三次，等待 1.5 秒、3 秒；失败保留音频及已完成分段，取消立即生效。缺少文本字段或转写时长不完整仍然失败，不将异常结果当作成功。

标题继续遵循原要求：用面向 40 岁以上男性、通俗直白的语言重述原标题，保留原题事实范围和疑问关系。

## 实际恢复结果

| 原任务 ID | 新标题 | 原稿字符数 | 成稿字符数 | 当前状态 |
| --- | --- | ---: | ---: | --- |
| science-a3f8eb9c-9ba4-45b1-a3f1-0342ea8d793c | 特朗普为什么要对亚洲鲤鱼宣战？它们不是鲤鱼吗？ | 5979 | 1045 | review |
| science-03befca9-1bb4-4ea4-91c0-b35d28aca0c4 | 白蚁有多厉害？大水蚁为什么不是蚂蚁 | 5478 | 718 | review |

两条任务均实际完成分析、成稿两次工具调用。原任务 ID 保留；本次恢复完成到文稿阶段，视频制作和发布不包含在上述完成状态内。

恢复前记录和实际工具参数存放于 `data/reports/science-tools-20261030/`，分别以原任务 ID 为文件名前缀，后缀为 `.before.json`、`.submit_science_plan.json`、`.submit_science_script.json`。

## 验证与生效

- 联合回归 128 项全部通过，覆盖模型传输、科普分析成稿、音频转写、工作流和批量采集；日志：`/tmp/science-tool-tests-final.log`。
- 后端 `npx tsc --noEmit` 通过。
- 两条原任务通过真实模型恢复，并从 `http://localhost:3013/api/v1/science-pop/workflow/jobs/<id>` 核实状态和成稿。
- 确认科普任务无运行项后，向旧后端发送 SIGTERM 正常退出，再以原 Node 版本和 `node run-tsx.mjs src/index.ts` 启动；沿用 `.env`，未关闭正常工作进程。
- 重启后健康接口返回 HTTP 200，两条任务仍为 `review` 且保留完整成稿。启动日志：`/tmp/huobao-backend-science-tools-20261030.log`。

## 涉及文件

- `backend/src/services/ai.ts`、`ai-text-http-error.test.ts`：工具请求与响应约束。
- `backend/src/services/science-script.ts`、`science-script.test.ts`：Schema、强制工具调用、语义及缓存校验。
- `backend/src/services/history-script-processing.ts`、`history-script-processing.test.ts`：明确识别空转写响应。
- `backend/src/services/science-workflow-media.ts`、`science-workflow-media.test.ts`：短尾合并、有限重试、缓存恢复和取消。

函数调用约束按 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/function-calling) 实现。严格格式不能替代内容和证据校验，相关校验继续保留。
