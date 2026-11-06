# 历史稿件：先拆解，再从新立场重述

2026-11-05：新稿已改为保持原意的全文表达润色，不再选择新角度。当前实现与配置见[历史原稿改写](history-source-paraphrase-20261105.md)。以下为旧版本记录。

新采集的历史口播二创使用 `gpt-6.1-sol`。视频、抖音图文、百家号采集共享 `history-source-pipeline.ts` → `history-script-recreation.ts`，本次修改这条实际执行路径；其他用途的全局模型配置不变。

第一次模型请求分析原文核心观点、故事结构、情绪及具体触发事件，列出必须保留的材料，再生成相反立场、反常识、冲突各一个角度。每项包含命题、认知反差、材料依据和新的叙事顺序，自动选择一项并解释原因。第二次请求只按所选角度写完整口播，重新组织开场、事件次序、信息揭示和结尾。相反立场可以质疑归因或换观察主体，不能否认事实、虚构对白心理或把疑点说成已证实。

分析以 `reviewJson.recreationPlan` 保存，成功成稿以 `draftOrigin=perspective_recreation` 及 `recreation.analysis/angles/selectedAngleId/selectionReason` 保存。正文仍单独写入 `rewrittenScript`，下游不会把分析或角度一起送去配音。写稿失败后只重试写稿；来源、提示版本、模型不匹配时重新分析。取消、截断和空正文不能成为成功稿；完全原样或只改标点的返回会拒绝。校验不能自动证明所有改写都足够原创。

`/history-scripts` 的原编辑器新增折叠区“原文拆解与三个创作角度”，显示采用项及理由。没有成稿时展示已保存的分析进度。旧 `light_edit`、`water_koubo` 和人工改稿仍按真实历史来源显示；既有稿件不会因升级自动重写。正常采集采用新流程，不增加选角度审批。

## 真实样稿

使用 source 62《一个“叫花子”，为何能让红军提前长征？》的完整 2148 字校对稿与已有疑点，实际完成两阶段请求，总耗时 224.4 秒，输出 2209 字新稿。三个候选角度为：

- 相反立场：让已有警报更可判断，把个人英雄归因改成情报进入集体决策的过程。
- 反常识：越不像重要人物，越可能带着重要情报过关。
- 冲突：既要把情报带过去，又不能让载体把人暴露。

本次采用第一项，从“已有警报为什么仍需要冒险递送”起笔。可查看[完整分析与新稿](../data/storage/history-scripts/recreation-previews/source-62-perspective-20261027.md)、[模型结果](../data/storage/history-scripts/recreation-previews/source-62-perspective-20261027.json)。这是独立验证产物，没有覆盖 source 62 的已保存正文、配音或视频，也没有触发自动视频提交。待核史实仍需史料审阅；本次只验证新叙事流程和一篇实际输出，不声称每篇质量或历史结论自动合格。

核心改动位于 `backend/src/services/history-script-recreation.ts`、`history-source-pipeline.ts` 及 `frontend/app/pages/history-scripts.vue`。108 项二创、流水线和采集任务测试通过，覆盖请求模型与先后顺序、分析检查点复用、取消、旧稿保护及成功保存后入队。后端 TypeScript 检查通过；5 项浏览器回归验证新旧稿来源、三个角度、未完成分析及采集文案，包含手机布局与正文可编辑空间。后端已重启并可读取原稿件，原正文哈希核对未变。
