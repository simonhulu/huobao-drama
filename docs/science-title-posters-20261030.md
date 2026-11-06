# 科普视频独立标题海报

按用户提供的参考图实现：真实主体特写、暗色简洁背景、大号白字、黄色主题关键词、两到三行短问题。横版与竖版分别生成底图，中文由本地排版器叠加；不使用视频截帧，不改变已锁定的发布标题和口播稿。

## 使用方式

打开 `http://localhost:3013/science-pop`，选任务，在成片页下方的“横竖封面”区域填写“封面设计指令”，点击“重新生成封面”。生成成功后显示新横竖图，可预览和下载。未发表任务即使已保存平台草稿，仍可本地设计；历史已保存草稿暂不支持在此替换平台旧图。已提交作品禁止改封面。

生产顺序为：花生制作 → 接口导出下载 → 自动设计/生成横竖海报 → 校验成片与海报 → 上传发表。封面步骤与上传步骤分开；本地重生成不打开平台编辑页，上传步骤不调用生图模型。新封面未完成时保留旧图，但阻止发表。

## 恢复和绑定

每版海报保存在独立目录，计划、底图请求ID、配置身份、已完成图片hash均持久化。继续未完成版本复用原模型任务；无回执的已发送生图请求不自动重复下单。旧版不覆盖；只在两种比例都完成后更新当前版本。

未保存、未提交的原百家号编辑页，通过 `update-video-covers` 仅更换封面。更新前后验证原账号、targetId、documentToken、视频SHA256和文案；新图片和预览通过校验后提交绑定。修订回执先落盘，再更新主上传记录及科普任务。中断期间禁止用旧封面继续发表或另起视频上传。

## 实际产物与验证

样张：`data/reports/science-posters-20261030/poster-samples.jpg`。实际页面：同目录 `live-workspace.png`。三条真实任务的素材hash、原编辑页身份、封面上传证据和发表结果见 `validation.json`。

骆驼、生蚝已各生成横版1280×720及竖版810×1080；另一个原上传任务也已生成双海报。三条真实任务均已用新横竖海报在原编辑页提交审核，未重传视频。生蚝因实际残留横封面裁剪窗曾被安全拦截，在核对源图hash一致后沿原页确认，再完成原发表。另有13条原队列任务已恢复，成片完成后执行新海报步骤。

后端工作流57项、媒体/海报/排版/上传恢复等54项测试通过；前端Controller17项及海报浏览器场景通过；后端TypeScript检查通过。桥接封面修订、检查点、残留裁剪确认Python48项、水印5项及发表定向3项通过。实际发表可沿原窗口确认与本次海报SHA256一致的残留裁剪；只读预检不点击，也不重新选择文件。运行日志复制在上述报告目录，平台审核状态不等同审核通过。

主要文件：
- `backend/src/services/science-cover-poster.ts`：strict tool call封面计划、独立生图和检查点。
- `backend/src/services/cover-image-composer.ts`：可选两至三行确定性中文排版。
- `backend/src/services/science-workflow-media.ts`：成片和海报文件校验，无截帧逻辑。
- `backend/src/services/science-workflow.ts`、`backend/src/routes/science-workflow.ts`：成片后自动生成、重生成接口、上传前校验和修订。
- `backend/src/services/social-auto-upload.ts`、`backend/scripts/social-auto-upload/bridge.py`：原编辑页封面替换、水印控件验证。
- `backend/src/services/cba-upload-recovery.ts`：校验通过后的封面绑定转换。
- `frontend/app/pages/science-pop/index.vue`：封面指令、版本预览、重新生成和待审核标签。
