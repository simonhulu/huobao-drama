# 音色库试听

`/library?tab=voices` 的 MiniMax 短试听使用官方同步合成接口 `POST /v1/t2a_v2`，固定 `stream=false`、`output_format=hex`，保留所选账号、模型和音色。正式长配音仍使用异步接口。

`POST /api/v1/ai-voices/preview` 返回可直接播放的本地 `audio_url`。生成结果保存为 `data/static/audio/voice-previews/<sha256>.m4a`，缓存按配置、模型、音色和试听文本区分；同一进程内的相同请求共用一次生成，刷新页面后仍复用已保存音频。失败不会写入成功缓存，再次试听可重试。指定的音频配置失效时直接报错，不能悄悄换用其他账号。

试听生成总等待上限为 60 秒，包括排队、请求和音量标准化；超时会从本地待提交队列移除，已发出的同步请求会中止等待。前端请求上限为 65 秒。生成中可取消等待或切换音色，服务端仍可完成并缓存已开始的短试听，避免再次请求重复生成。

生成结束后立即恢复试听按钮，播放器自动播放不再占用生成状态。音频加载 15 秒仍未就绪则显示可重试错误。切换账号、关闭试听和离开页面时停止当前播放器并释放音频源。

官方接口参考：https://platform.minimax.cn/docs/api-reference/speech-t2a-http

## 百炼 Qwen 3.1 配音与复刻

云端服务商为 `qwen-tts`，模型为 `qwen-audio-3.1-tts-flash`；与本地 `qwen3-tts`、识别模型 `qwen-audio-3.1-asr-flash-filetrans` 分开。音色库可分别查询 MiniMax 和百炼账号的可用音色、试听并设置默认旁白。百炼复刻音色绑定账号、地域和目标模型，不能传入 MiniMax 的音色 ID。

在 `backend/.env` 配置 `QWEN_API_KEY` 后执行：

```sh
cd backend
node --env-file=.env --import=tsx scripts/setup-qwen-tts.ts /absolute/path/reference.mp4 20 20
```

最后两个参数是参考片段的起点和长度（秒），长度限 3 至 30 秒。脚本提取单声道 24kHz WAV，创建并等待音色部署，保存音色与加密 API 配置，生成带情绪指令的真实试听，成功后设为默认旁白。可通过 `QWEN_TTS_BASE_URL` 选择对应地域或业务空间端点。音色复刻记录保存在私有的 `data/storage/qwen-tts-voices/`；重复执行会复用已创建的音色和试听。若创建响应丢失，会先核对音色列表，无法确认时停止，避免重复付费创建。

既有剧集保存的 MiniMax 音色在使用百炼配置生成时会解析为百炼默认音色。已保存的完整配音仍按原有规则复用；无配音的失败任务重试会读取当前默认旁白配置。这里是明确切换默认服务商，不是任意 MiniMax 请求报错后的自动跨服务商重试。

长文本按句子边界拆为不超过 1000 字符的片段，每段成功后保存 WAV，后续失败重试可复用已成功片段。缓存区分账号、端点、模型、音色、文本与情感指令。非流式接口没有字级时间戳，精细化制作继续使用现有的真实音频识别对轴流程。

官方文档：[非实时语音合成](https://docs.bailian.console.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)、[声音复刻](https://docs.bailian.console.aliyun.com/zh/model-studio/voice-cloning-user-guide)。
