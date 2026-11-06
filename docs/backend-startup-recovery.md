# 后端启动依赖恢复（2026-10-15）

## 原生模块版本不匹配

如果看到 `better_sqlite3.node was compiled against a different Node.js version`，说明安装依赖和启动服务使用了不同的 Node 主版本。先统一到 nvm、Homebrew 或 nodejs.org 安装的 Node `25.6.1`；不要使用 Conda `nodejs_wheel`，它会在 `better-sqlite3` 回收语句对象时触发 Node cleanup hook 崩溃。然后在 `backend` 目录执行：

```bash
npm install
npm rebuild better-sqlite3
npm run dev
```

前端的 Nuxt 代理默认访问 `http://127.0.0.1:5679`。只有后端已监听该端口后，前端请求才不会出现 `ECONNREFUSED 127.0.0.1:5679`；如后端使用其他端口，请同步设置前端的 `API_PROXY_TARGET`。

## 故障与结果

`npm run dev` 在加载 `services/adapters/registry.ts` 时因缺失 `qwen3-tts.js` 对应源码而退出。主后端 5679 端口未监听，Nuxt 3013 转发 `/dramas`、`/media-accounts`、`/tasks`、`/health/workers`、`/tasks/stream` 时返回 500。npm 的 `package-manager` 警告不是启动失败原因。

依赖检查发现共 17 个缺失实现模块（包含间接依赖）。恢复实现后，主后端已可启动，以上接口通过前端代理均返回 200，SSE 首条事件为 `connected`。历史脚本独立服务 9130 保持运行。

## 恢复来源

保留原有工作区修改，没有删除功能注册、替换空实现或回退现有调用方。

| 模块（位于 backend/src） | 恢复依据 |
| --- | --- |
| services/adapters/qwen3-tts.ts、services/qwen3-voice.ts | 2026-08-11 开发记录中完整 TypeScript 读取结果，含长请求超时处理；内容逐字核对 |
| services/narrative-storyboard-progress.ts、services/tasks/handlers/narrative-storyboard-monitor.ts、services/dharma-publishing-package.ts | 原始新增与后续修改补丁；转译逻辑与现存构建核对 |
| services/narrative-panel-prompt.ts | 2026-08-15 完整源码读取结果；转译逻辑与现存构建核对 |
| services/composition/sa3-audio-preflight.ts、services/opening-storyboard.ts、services/adapters/stable-audio-adapter.ts | 2026-10-11 tsx 缓存中的完整 sourcesContent |
| routes/deterministic-breaker.ts、routes/science-pop.ts、services/tasks/handlers/science-pop.ts、services/deterministic-breaker.ts、services/science-pop-segmentation.ts、services/render-artifacts.ts | 2026-08-12 现存 dist 实现及类型声明，恢复运行逻辑并补静态类型，转译后核对 |
| services/narrative-hierarchy.js、services/composition/grid-audio-mix.js，及各自 .d.ts | 完整原始 TS 未找到；现存 dist JS 和声明逐字恢复 |

`services/ai.ts` 补回构建产物中已有的 `getTextRequestExtras`，供 opening storyboard 调用。`tsconfig.json` 增加 `allowJs`，确保两个恢复为 JS 的模块进入新构建；TS 严格检查保留。`backend/.gitignore` 为这两个模块的 JS 和声明增加精确例外，避免被现有 `*.js`、`*.d.ts` 规则排除。

新增 `src/startup-imports.test.ts` 从主入口递归检查本地模块依赖，也检查声明文件旁对应的 JS 实现依赖。修复前测试失败并列出缺失项，恢复后通过。

## 验证

- `npm run typecheck`：通过。
- TypeScript 编译到全新临时目录：通过；确认 index、Qwen3 adapter、narrative-hierarchy、grid-audio-mix 均生成，不依赖旧 dist 文件。
- TTS 限流与超时 3 项、MiniMax adapter 2 项、episode TTS 5 项、任务路由 15 项：通过。
- 模型配置 9 项、媒体账号 2 项、启动依赖 1 项：通过。
- 从原构建测试读取并改为导入恢复后 src 的音频混合 17 项、确定性分镜 10 项、叙事画格提示 6 项、进度 2 项、监控 2 项：通过，使用隔离数据库。
- Remotion 路由 3 项中 2 项通过；脚本分集入口测试返回 400，具体为 `requires pre-TTS audio and MiniMax titles before Remotion project creation`。该检查位于未修改的 Remotion 流程，本次未改变预生成语音条件，也未宣称全仓测试全部通过。
- 前端代理实际 GET：`/dramas`、`/media-accounts`、`/tasks?active_only=true`、`/health/workers`、`/tasks/stream`、`/history-scripts` 均为 200。
- Playwright 实际加载首页：项目、账号、任务请求均为 200，无页面 JavaScript 异常。
- `git diff --check`：通过。

## 运行与边界

清理了三个已启动失败的开发监听进程。主后端此次以 `TASK_WORKER_DISABLED=1 node run-tsx.mjs src/index.ts` 启动，提供 API 而不消费旧任务；验证前后队列中的 7 个旧任务未被执行。普通 `npm run dev` 的默认 worker 行为没有修改。不要同时启动多个主后端占用 5679。

Qwen3 的可选 Python 服务/虚拟环境没有在本次部署，恢复 adapter 不代表完成本地 Qwen3 语音生成实测。没有付费模型调用、视频生产或发布。

部分模块恢复自已验证的历史构建基线。较新缓存中的 deterministic-breaker 还引用当前源码树没有的 `episode-production-state`；该额外状态机未在本次引入。恢复目标是当前工作树启动与接口可用，不能据此宣称所有历史分支功能均已恢复。
