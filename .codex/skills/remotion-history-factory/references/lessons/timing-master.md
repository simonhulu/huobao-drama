# 渲染时序的唯一来源是权威时间轴，不是字数估算

**日期**: 2026-07-26 · **集数**: Episode 645
**后果**: 整集 138 镜中 90 镜画面/字幕落后旁白 >1.5s（均值 2.7s、峰值 8s），
用户肉眼可见「旁白讲完了，画面和字幕还没到」。

## 我犯了什么错误

`buildGridStoryProps` 没有读叙事层级里现成的 Beat 权威窗口，而是用
`resolveMasterTitleDurations()` 按**累计字数比例**把 62 条 MiniMax titles 窗口
重新分摊到 138 个镜头上。

## 错误的心理模型

> 「titles 有每条句子的精确时间，镜头旁白按字数对齐到 titles，误差不会大。」

**这个模型是错的。** 实测两层误差叠加且不收敛：

1. **边界错分**：累计字数缩放差一个字符就把镜头推进相邻 title 窗口。
   实锤：shot 1「他叫霍去病。」在 title 0 内 7.15s 被念出，却被映射进
   title 1，画面 8.54s 才切——第 2 镜就落后 1.4s。
2. **窗内匀速假设**：字数占比 ≠ 时长占比（TTS 有停顿和加速），每镜再漂
   ±1~4s，138 镜累积成均值 2.7s 的系统落后。

字幕因为用「镜头内相对时间 + 字数均摊」从属于镜头边界，所以和画面一起错——
一个机制同时制造两种落后。

## runner 时代对应的失败码：TTS_TIMELINE_MISMATCH

history runner 在 tts_verify 阶段校验：pre-TTS 音频 + titles 存在、titles 有序
不重叠、覆盖率（titles 跨度 / 音频时长）在 0.60–1.05。不满足即报
`TTS_TIMELINE_MISMATCH`。

- Episode 还没有 pre-TTS master（`pre_tts_audio_url` / `pre_tts_titles_json`
  为空）→ 先跑 `tts.pre_generate`，不要伪造 titles。
- 覆盖率出界 → 检查 titles 是不是被手工改过、音频是不是换过版本；改了任何
  一边都必须重跑 TTS 主轨生成，而不是修补数字。

## 正确的操作方式

**渲染时序的唯一来源是 Beat 窗口链，不是任何重新推导：**

```text
storyboards.id -> storyboard_panels(panel_key='sb-{id}'[-pN], kind='full' plan)
               -> visual_beats.start_ms/end_ms   （与旁白主音轨同源，构造上零漂移）
shot.startFrame      = round(beat.start_ms / 1000 * fps)  —— 绝对帧位，不再累计堆叠
shot.durationInFrames = round((end_ms - start_ms) / 1000 * fps)
字幕分句 = 旁白字符区间在 preTtsTitlesJson 流上插值，减去镜头起点
```

## 防错规则

- 缺 Beat 窗口 / panel_key 无法解析 / 帧窗乱序都会让渲染任务**直接失败**，
  不存在降级估算路径——不要绕开失败去"估一个差不多"的时序。
- 重新生成 storyboard 数据时注意两个配套坑：`duration-seconds.md`（秒不是毫秒）、
  `storyboard-split-8s.md`（单镜 ≤ 8s）。
- **每次渲染后跑独立校验**（不复用后端代码的复核器）：任何 startFrame 偏差
  >1 帧即 exit 1。
- **文档约束不住实现**：契约必须落成代码门禁 + 测试 + 校验脚本三件套，
  只写文档等于没写。
