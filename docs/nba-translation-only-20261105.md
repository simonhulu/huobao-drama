# NBA 原稿翻译流程调整

## 行为

- 英文新闻只做完整中文翻译，不创作、不补充、不概括删节。
- 中文新闻直接使用原稿，不调用文本模型。
- 删除事实审核、事实段落映射要求和事实修正循环。
- 制作完成、续做和百家号草稿上传不再依赖历史审核结果。
- 已保存的可用中文稿直接复用，旧审核记录仅保留在缓存的 `previousReview` 中。
- 页面使用八个制作阶段，显示“翻译”和“中文译稿”，移除稿件审核和事实映射区块。
- 同场素材、声音、字幕、完整回合收尾与实际成片检查继续用于视频制作。

## 自动化验证

- 后端 NBA 生产、队列、采集、下载、上传、路由及 YouTube 共用服务：148 项通过。
- 前端 NBA 控制器及 Vue 编译：31 项通过。
- 后端 `npm run typecheck` 和前端 `npm run build` 通过。
- 下载提示文案调整后的 YouTube 测试：11 项通过。
- Playwright 已验证桌面 1440px、手机 390px：八阶段、无稿件审核或映射区块、无页面横向溢出、无页面脚本错误。
- 回归覆盖本次“战胜猛龙”误报：复用旧译稿，不调用翻译、事实审核或修正模型，不受旧修正次数限制。

## 原任务恢复

- 任务：`nba-b58390cfe063609a0a5b`，ESPN 比赛 `401909921`，湖人 138 比 117 热火。
- 请求：`nba-translation-only-20261105-001`；运行：`nba-run-ac653e6e-2b37-42bf-a509-4159e3ecc57b`。
- 日志已确认直接复用中文译稿，并清除活动审核结果。
- 官方素材：`wCjTikWeEBE`，1920×1080，60000/1001 fps，58002 帧，全长严格音视频解码通过。
- 源文件 SHA256：`65574ed874843ef3244f865ae40ea8cef996e9bf64752dff5df2fba6930e8712`。
- 生产服务从完整本地文件自动注册素材，再完成真实片尾检查；未手工设置素材核验结果。
- 自动上传绑定 CBA 共用百家号“体育”账号，只保存草稿。

## 实际结果

- 运行已完成，服务空闲，任务为 `completed`、`uploaded: true`、`canUpload: false`。
- 中文稿 SHA256 保持为 `4bb38ad167953a149458f9fc39a19527824b46457ac1a5a59cfeeda2710742ec`，未重新翻译或改写。
- 成片：`data/nba-video/jobs/nba-b58390cfe063609a0a5b/video-57673bf145e69e89.mp4`。
- 成片为 1920×1080，3258 帧，54.354299 秒，34,542,547 字节，全长解码通过。
- 成片 SHA256：`c8cfb1005408520566597c2a122bb37ba098f89781ac8d3bdae644347bd7cdbc`。
- 实际旁白约 49.82 秒，旁白后约 4.41 秒，片尾叠化约 0.50 秒；结尾显示本场最终比分牌后淡出，末帧为黑场、尾音结束。
- 字幕覆盖完整稿件，未检出异常长停顿或字幕内部空缺；交付记录为 `contentMode: "translation-only"`、`factReviewPerformed: false`。
- Playwright 验证实际成片在桌面和手机播放、非空白画面、HTTP Range 与字幕下载；证据位于 `/tmp/nba-translation-recovery-20261105/browser/report.json` 及同目录截图。
- 百家号回执：`saved: true`、`published: false`，2026-11-05 07:31:51（北京时间）保存完成。
- [百家号草稿](https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=1880972395803279815)。
- [工作台成片](http://localhost:3013/nba-video?job=nba-b58390cfe063609a0a5b)。

## 修改文件

- 后端：`backend/src/services/nba-production.ts`、`nba-video.ts`、`nba-youtube.ts`。
- 回归测试：`backend/src/services/nba-production.test.ts`、`nba-video.test.ts`。
- 前端：`frontend/app/pages/nba-video.vue`、`frontend/tests/nba-video-controller.test.mjs`。
- 文档：`docs/nba-video-workflow.md`、`scripts/nba-video/README.md` 及本记录。
