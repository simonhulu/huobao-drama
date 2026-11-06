# 历史原稿改写与远程写作配置

历史页 `/history-scripts` 的新稿直接调用远程写作模型，不再调用 GPT 选择新角度、比较立场或生成新稿大纲。核心提示词按用户要求原样采用：

> 请将下面这段文本改写为更自然、更有人类写作风格的表达，要求句子间的逻辑更合理，更通俗，可读性更强，句子更通顺。保持原意不变。

输入包含完整校对稿、来源标题和作者标识。4500 字以内保留原有观点、事实、关键例子、主要顺序和情绪推进，允许调整句间衔接，没有强制换词或凑字数要求。根据用户后续修订，超过 4500 字的稿件必须先进行语义缩写，目标为每分钟约 300 字、约 15 分钟，尽量落在 4000-4500 字。4500 是软目标，允许略超；删去重复表述、冗余铺垫和次要例子，保留主线、立场、关键事实、因果、情绪转折和完整结尾，不重新选角度或生成新大纲。校对疑点继续作为编辑记录保留，不送给写作模型生成免责声明。改写不是外部史实核验。

新稿来源标记为 `draftOrigin=source_paraphrase`、`skillName=history-source-paraphrase`，记录实际远程模型。新稿不生成分析、角度或大纲，旧检查点不参与写作；旧已完成稿仍显示真实历史来源，不自动重写。失败、取消、输出截断不会替换已保存正文，只有明确 HTTP 429 拒绝才重试。

## 十五分钟缩写规则

- 长度按非空白 Unicode 字符计算。新采集长稿使用 `history-source-condensed-v1`；短稿仍使用原有 `history-source-paraphrase-v1`。
- 缩写保留完整原文和正文、思考预算，不用丢弃原文或调低 token 上限来凑篇幅。9000 字以上按连续自然段累计约 3500 字分组；单段极长时先用 `Intl.Segmenter` 划分句子。所有片段原样拼接必须等于完整输入，按字数比例分配合计 4300 字的软目标，依次由远程模型缩写后按原顺序合并。每片使用直接的自然语言篇幅指令，不生成独立标题、开场、总结或新大纲；不再整篇重写，不拆成多集。
- 分段是针对本次远程小模型的真实限制：source 378 的整稿请求曾多次返回复制稿或仅略减的 2.1 万字稿，均未应用；1116 字纯文本缩写小样可得到 208 字结果。因此采用分段的局部篇幅目标，整篇完成前不保存任何部分正文，任一片失败或取消均保留旧稿。
- 已保存长稿在手动开始或重试未完成制作时先准备短稿，来源页和当前 Episode 使用相同正文及 SHA256。花生与精细化分支在锁定版本之前共用这个短稿。
- 原长稿、旧配音地址和时间码保存在缩写记录中，旧失败任务、制作快照、成片和发表回执保留。正文变化后不复用旧配音。
- 缩写记录绑定实际输出哈希；已缩写且略超 4500 字的完整稿不会反复缩写，人工修改后重新检查。只少数字却仍远超目标的结果会被拒绝保存，不机械截字，不自动拆集。
- 已运行或已产出成片的旧任务继续使用原快照。旧双渠道队列若尚未执行且稿件超长，先提示从来源准备新稿，禁止执行中悄悄改变一条队列绑定的稿件哈希。
- 500 镜限制保留为制作保护，报错改为提示先缩写正文后重试。预计口播统一按每分钟 300 字计算，实际配音以音频时长为准。

`scripts/history-recreation-preview.ts <sourceId> --condense` 可隔离生成已保存长稿的缩写样稿，记录结束原因、预算和最终正文，不记录思考过程。`scripts/history-apply-condensed-preview.ts <episodeId> <previewDirectory>` 先检查样稿与数据库版本，附加 `--apply` 才应用到同一 Episode；它保留完整前快照，登记持久制作任务，由现有 worker 接续执行，避免重启中断其他渲染。

source 378 的分段样稿已生成：`data/static/history-recreation-study/378-1793883488008/`，正文 4801 个非空白字符，预计口播 859 秒，预拆 217 镜。七片均 `finish_reason=stop`，前五片复用先前正常完成的远程响应。已对照原稿读完整稿，并将三处语义校订单独记录在 `editorial-corrections.json`，未改写原始模型响应。

应用时检测到 Episode 1229 的制作任务已于 2026-11-05 12:33 UTC 删除，工厂拒绝继续，数据库正文没有被覆盖。用户随后明确选择“保留删除状态，仅修复删除按钮”，因此没有恢复或新建制作任务，source 378 仍保留原长稿。临时空闲重载 LaunchAgent 已撤销，未中断正在执行的主服务；本文新增的缩写策略代码尚待后续正常部署，不据此宣称线上全局规则已生效。稿件库删除按钮已独立修复，不再因列表后台刷新而禁用已加载的空闲稿件，保存、详情读取和稿件处理期间仍保留保护。

## 远程服务

- 模型：`Qwen3.5-9B-Writing-DPO-i1-Q4_K_M`，与科普页共用 SSH 连接配置，服务端口 8788。
- 2026-11-05 已将 llama.cpp 单槽上下文从 8192 经 32768 提升至 **131072（128K）**，保持全层 GPU 卸载，启用 `--flash-attn on`。模型元数据原生训练上下文为 262144，本次未修改 RoPE。RTX 3090 24GB 显存占用约从 6346 MiB（32K）增至 9500 MiB（128K）。`/props` 已确认单槽 `n_ctx=131072`，短生成正常结束。
- 明确发送 `top_p=0.8`、`top_k=20`、`min_p=0`、`repeat_penalty=1`。历史温度 0.3，科普保留原有温度设置。
- 历史默认开启思考，预算 **8192 token**；科普默认关闭，可独立配置。只读取 `message.content`，不保存或展示 `message.reasoning_content`。
- 历史正文预算默认 **32768 token**，可独立配置为 1 至 65536；思考预算为 1 至 8192，额外计入请求。默认 `max_tokens=32768+8192=40960`，已移除调用方硬编码 8192 和适配器总输出 32768 的限制。历史等待时限相应提高至 20 分钟；模型提前结束就立即返回，不必用满预算。
- 上下文窗口与输出上限是两个参数：服务启动参数 `--ctx-size 131072` 控制输入、思考和正文的总容量，单次请求 `max_tokens` 控制新生成的思考和正文。只扩大上下文不会改变调用方输出上限；token 也不等于中文字符或英文单词。完整输入加总输出仍需适合服务上下文，超限时明确失败，不裁剪原稿。

```dotenv
SCIENCE_WRITER_MAX_TOKENS=8192
HISTORY_WRITER_MAX_TOKENS=32768
HISTORY_WRITER_ENABLE_THINKING=true
HISTORY_WRITER_THINKING_BUDGET_TOKENS=8192
SCIENCE_WRITER_ENABLE_THINKING=false
SCIENCE_WRITER_THINKING_BUDGET_TOKENS=1536
```

`backend/run-tsx.mjs` 按 `.env`、`.env.local` 顺序加载基础配置与本地覆盖，避免本地文件遮住 `.env` 内的远端凭据；继承的环境变量仍优先。

上述环境变量放在 `backend/.env` 或 `.env.local` 后需重载后端；历史正文、思考预算现在独立于科普配置。进一步提高单次正文上限可设置 `HISTORY_WRITER_MAX_TOKENS=65536`，默认思考开启时请求总输出为 73728，仍须为输入保留上下文空间。

远端 128K 启动脚本固化为 `/root/rivermind-data/start-qwen-writer.sh`，32K 回滚脚本为 `start-qwen-writer-32k.sh`，本次参数和日志备份为 `qwen-server-before-128k.*`；早先 8K 备份 `qwen-server-before-32k.*` 也保留。本次未更换权重，增加上下文不等同于提高模型参数规模或证明普遍提速。

来源 377、378 的旧失败经远端日志确认都输出了恰好 **9728 token（8192 正文 + 1536 思考）**，最终缓存分别约 23103、24645，未达到当时的 32768 上下文，没有显存不足。原因是单次输出预算耗尽。现在 `finish_reason=length` 错误会报告请求上限、正文和思考预算，以及服务返回的完成 token 数，不包含来源或思考正文。

## 同稿对照

早先使用 source 906 的完整 2844 字校对稿，按相同改写提示、相同采样参数和 seed 42 对照。该轮正文预算为 8192、思考预算为 1536，输入约 2445 token，没有旧角度大纲。原数据库稿件未修改，也未触发视频制作。

| 模式 | 耗时 | 正文字符 | 总输出 token |
| --- | --- | --- | --- |
| 非思考 | 14.8 秒 | 1942 | 1527 |
| 思考，预算 1536 | 31.0 秒 | 2645 | 3431 |

这一个样本中，思考稿更好地保留了原时间关系、引文和措辞程度，口播语气也更自然，因此历史改写默认采用限额思考。这不构成所有稿件质量提升的统计证明。两稿仍保留了来源节目回顾和末尾缺失诗文的引出句，样稿仍需正常编辑审阅。

对照产物：`data/static/history-recreation-study/906-thinking-1793868062670/`，包含原稿、两版最终正文与 `comparison.json`；不包含模型思考正文。

```bash
cd backend
node run-tsx.mjs scripts/history-recreation-preview.ts 906
node run-tsx.mjs scripts/writing-thinking-preview.ts 906
```

参考：[Qwen 官方说明](https://huggingface.co/Qwen/Qwen3.5-9B#best-practices)、[llama.cpp 服务接口](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)。当前部署已确认支持请求字段 `reasoning_budget_tokens`。

## 实现与验证

主要修改：

- `backend/src/services/history-script-recreation.ts` 及对应测试：以用户原话为核心提示，单次远程改写，保留旧稿类型兼容。
- `backend/src/services/history-source-pipeline.ts` 及对应测试：新稿来源标记与进度，成功后清除旧选角度检查点。
- `backend/src/services/science-writing-model.ts` 及对应测试、`backend/.env.example`：共享远程传输、采样、独立思考开关及额外预算。
- `backend/run-tsx.mjs`、`backend/run-tsx.test.mjs`：环境文件合并及实际 Node 普通、watch 启动验证。
- `backend/scripts/history-recreation-preview.ts`、`backend/scripts/writing-thinking-preview.ts`：隔离样稿和有无思考对照，不覆盖数据库正文。
- `frontend/app/pages/history-scripts.vue`、`frontend/tests/history-scripts.test.mjs`：准确显示新稿来源并隐藏过期角度方案，保持旧稿显示兼容。
- 本文、`docs/science-pop-workflow.md`、`docs/history-perspective-recreation-20261027.md`：配置和版本说明。

早先改写流程验证的相关后端测试 142/142 通过，页面浏览器测试 4/4 通过。该轮独立真实样稿位于 `data/static/history-recreation-study/906-1793868327123/`：2699 字，32.9 秒，记录实际远程模型和新提示版本，原数据库原稿与旧稿均未修改。

128K 和大输出预算更新后，历史改写、科普写作、来源管线相关测试 88/88 通过，后端 `tsc --noEmit` 通过；回归覆盖两篇约 2.2 万字原稿完整传入、默认 40960 请求上限、自定义 65536 正文上限和独立思考预算。隔离长稿验证脚本额外记录预算、`finish_reason` 和 token 用量，不记录思考内容。

此前两篇失败长稿使用新配置进行真实远端验证，请求均为 `max_tokens=40960`、思考预算 8192：

| 来源 | 原稿字符 | 改写字符 | 实际总输出 token | 耗时 | 结束原因 |
| --- | --- | --- | --- | --- | --- |
| 377 | 21530 | 21477 | 14886 | 148.4 秒 | stop |
| 378 | 22186 | 22398 | 16332 | 167.3 秒 | stop |

两次实际输出均超过旧上限 9728，正常结束；检查了首尾，均写到原稿的结论部分。产物及请求用量记录分别在 `data/static/history-recreation-study/377-1793876600222/` 与 `378-1793876814432/`。这验证了输出预算修复，不代表已完成逐句写作质量或史实审阅。预览没有覆盖数据库稿件，也没有触发视频制作。

主后端已在原采集任务停止并保留检查点后重载，通过健康检查；采集任务 40353 已恢复，按原任务继续处理未完成来源。11:10:59 UTC 只读核验远端 `/props` 仍为 131072，当前任务 24698 的 `/slots` 实际显示 `max_tokens=40960`、`n_predict=40960`；接口不提供来源编号，不据此推断稿件归属。科普服务健康正常。
