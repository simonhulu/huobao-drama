# 口型替代方案核实

日期：2026-11-05。用户已否定当前 LatentSync 1.6 输出的同步、牙齿嘴唇细节、变形及自然度。现有资产为 30 秒小鹭近景参考、约 12 分 8 秒中文正文原配音和 3090 24GB。本轮只研究官方资料，没有安装、推理、提交付费任务或改动服务。

## 推荐

优先做一次 **Sync `sync-3` 的 10 秒真实素材对照**，条件是已有可用账号、模型权限及免费额度或明确预算。它支持现有视频加原音频，且官方明确区分了整镜头处理、近景、静默嘴唇开口和旧模型的分块限制，较贴合本次失败类型。**这些是供应商声明，不是本素材质量已改善的实测证据。** 先看有声短片，再决定是否接入整片。

若必须仅使用现有 3090 和开源模型，MuseTalk 1.5 是可执行的小样对照候选，但不能保证提升本次最在意的清晰度和抖动；不建议未经对照就迁移整条生产线。

## 方案对照

| 方案 | 输入与身份处理 | 3090 可执行性 | 本次限制 | 凭据及费用 |
| --- | --- | --- | --- | --- |
| Sync `sync-3`，其次 `lipsync-2-pro` | 官方 API 支持现有视频+音频；重定向说话，不要求为该人物训练；sync-3 另支持图片生成说话视频，本次应使用原视频 | 托管服务，不依赖本机 GPU；没有可据此部署到 3090 的公开权重说明 | 官方称 sync-3 整镜头处理、4K 输出和风格保留；仍须实测音素、牙齿与自然度。2-pro 仍为 512 面部+超分辨率、独立 2 秒片段 | 需账号/API key 或已登录 Studio；免费额度或付费，见下文 |
| MuseTalk 1.5 | 现有视频+音频；裁脸到 256×256、单步 latent inpainting，再贴回原帧；有预训练权重，不必先训练人物 | 官方报告 fp16 在 4GB 3050 Ti 上可跑 Gradio，故 24GB 3090 足以作为推理候选；不据 V100 的宣传帧率推算本机实际速度 | 官方仍列明 256 分辨率、唇形/颜色等身份细节损失、单帧生成的 jitter。不能因 1.5 使用 GAN/perceptual/sync loss 就宣称优于已失败的 LatentSync 1.6/512 | 开源推理无需 SaaS key；代码 MIT、预训练模型可商用，其他依赖按各自许可；只作推理无需训练 |
| Wan2.2-S2V-14B | 官方入口为参考图片+原音频+可选文字/pose；重新生成面部、身体与镜头，不是逐帧保留这段视频再只改口型 | 官方 S2V 单卡示例要求至少 80GB，即使已带 offload 和 dtype 转换；不能把 TI2V-5B 的 24GB 说明移植为 S2V-14B 的保证 | 改变生成任务与身份/动作连续性风险，12 分钟保持人物和背景须另验；社区量化/offload 版本不等同于官方 3090 路线 | 本地需大权重与新环境；托管需另外账户/配额，本轮不作为最小替换 |

## Sync 的关键前置条件

1. **原片是否自然说话。** 官方明确要求 lipsync-2/2-pro 输入已有自然说话动作；静止或不在说话的段落无法正常驱动。若新参考多数闭嘴，不应盲选 2-pro。sync-3 能打开静默嘴唇，但官方也说明此时动作较通用，未必保留原人物说话风格。[模型说明](https://sync.so/docs/models/lipsync)
2. **保留原音轨。** 请求使用 `video + audio`，不调用 TTS/翻译。短样片视频与音频均裁到同一 10 秒，并显式 `sync_mode: cut_off`，避免默认 bounce、变速或裁掉正文。`POST /v2/generate` 提交后保存编号，查询同一任务到 `COMPLETED/FAILED/REJECTED`，不盲目重提。[Quickstart](https://sync.so/docs/quickstart)、[Sync Mode](https://sync.so/docs/developer-guides/sync-mode)
3. **模型权限。** 通过账户 Studio 模型选择器或 List Models 核实 `sync-3` 是否可用；官方写明权限可能按账号或 rollout 不同。`SYNC_API_KEY` 是所需凭据名；本轮未读取或确认项目是否已有此密钥。[模型说明](https://sync.so/docs/models/lipsync)、[Quickstart](https://sync.so/docs/quickstart)
4. **免费说明有旧文案冲突。** Free Trial 和 Billing 页面目前一致写每月 3 次共享免费视频生成、每次最多 15 秒、全 3 次可用于 sync-3、无需信用卡；sync-3 页面及 Quickstart 头部仍残留“1 次/月”等旧字样。以实际账号可见额度/模型权限为准，不承诺一定免费。免费输出带水印。[Free Trial](https://sync.so/docs/free-trial)、[Billing](https://sync.so/docs/product/billing)、[sync-3](https://sync.so/docs/models/sync-3)
5. **费用须按账号计费制核实。** 官方 legacy usage 页面给出 25fps 下 sync-3 约 $0.107–$0.133/秒、2-pro 约 $0.067–$0.083/秒，订阅另计；仅按此范围估计 728 秒，sync-3 约 $78–$97，2-pro 约 $49–$61，非实际报价。新 credit billing 约 13.3/8.3 credits 每秒，且 top-up 单价随计划不同，不能把 credits 换算值当现金购买价。使用账户估价接口/Studio 查看一次 10 秒样片的实际成本再提交。[Billing](https://sync.so/docs/product/billing)、[Credit Billing](https://sync.so/docs/product/billing/v3)
6. **长视频策略。** 先短片验收；最终可按原正文分段处理再合成，单次时长遵守账户计划。不要把 30 秒参考默认倒放扩展成整片，也不要为了凑套餐时长改动原配音速度。保留固定片头、原正文配音和已配置的圆窗几何。[内容与时长模式](https://sync.so/docs/compatibility-and-tips/media-content-tips)

## 最小对照产物

- 保留已失败 LatentSync 的真实 10 秒输出作为基线，使用同一用户参考视频前 10 秒和完全相同的正文 WAV 驱动候选；再选一段含明显 b/p/m 闭唇、a/o 开口及停顿的 10–15 秒配音作第二轮，不能只选容易的连续元音。
- 第一轮只跑 `sync-3` 一次，不自动用完免费额度或启动 12 分钟生成。若账号仅开放 2-pro，先确认原参考确有连续自然说话动作再试。
- 提供原尺寸有声独立视频、同一音轨的并排对照、实际圆窗成片预览；检查音素时机、闭唇、牙齿跨帧、嘴角/下颌抖动、肤色贴合及人物一致性。SyncNet 可辅助，但分数上升和音轨偏移为零不能替代观看验收。
- 若只有开源条件，独立环境用官方 MuseTalk 1.5 预训练权重，以官方推荐 25fps、fp16 和单人近景跑同一 10 秒；记录实际速度与画质。不要先接入 GFPGAN，也不要把放大后锐化当正确牙齿或音素恢复。

## 官方依据

- MuseTalk 官方 SHA `0a89dec45a0192b824e3cf4daf96c239440c5ed8`：[README 模型、最低硬件与限制](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/README.md#limitations)、[实际裁脸/推理/回贴代码](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/inference.py#L164)。`bbox_shift` 开口说明在 README 中标记为 1.0，不应直接套作 1.5 的优化承诺。
- Sync 官方：[模型族](https://sync.so/docs/models/lipsync)、[sync-3](https://sync.so/docs/models/sync-3)、[质量指南](https://sync.so/docs/compatibility-and-tips/improving-lip-sync-quality)、[原视频自然说话要求](https://sync.so/docs/compatibility-and-tips/media-content-tips)。供应商对质量和能力的描述均未在当前小鹭素材实测。
- Wan2.2 官方 SHA `1ea34ff48f87168174e12956e200b1d908b1c5ff`：[S2V 命令、输入和 80GB 说明](https://github.com/Wan-Video/Wan2.2/blob/1ea34ff48f87168174e12956e200b1d908b1c5ff/README.md#run-speech-to-video-generation)。24GB 的另一节属于 TI2V-5B，不属于 S2V-14B。
