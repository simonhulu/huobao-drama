# 江山原生地图与逐帧推演

中文历史地图升级采用 `jiangshan-map` 的原生渲染与标注。地图、地形、水系、城池、州道边界和地理标签由江山自己的代码绘制；本项目叠加军队、行军箭头、攻守结果、占领和旁白时序。不要退回仅提取数据后自行重画的路线。

## 已实现入口

固定上游版本：`a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a`。基础版是741年唐代地图、12秒；精细版为757年地图、18秒。两者都是1920×1080、30fps的固定动作示范，非史实战役或古道复原。精细版最终渲染与验收状态以其成片和独立QA记录为准。

- `scripts/jiangshan-map-pilot/native-driver.mjs`：启动本地原生页面，完成资源准备，按帧设置相机与原生标签布局，再编码音视频。
- `remotion/src/JiangshanMapPilot.tsx`：浏览器 React 叠层，复用已有军事符号与动作判定。使用 `flushSync` 完成每帧提交。
- `remotion/src/JiangshanMapRefined.tsx`、`jiangshan-refined-geometry.ts`：精细版将领与兵种叠层、弧长一致的曲线箭头、全镜头布局和阶段时序。
- `scripts/jiangshan-map-pilot/generate-refined-assets.mjs`：通过现有图片服务准备并缓存两张将领头像、两种兵形；保留生成原件和哈希。
- `scripts/jiangshan-map-pilot/README.md`：运行方式和输入合同。
- `docs/jiangshan-map-native-video-adaptation-20261101.md`：研究、许可、已知查询问题及生产接入差距。

```sh
node scripts/jiangshan-map-pilot/native-driver.mjs \
  --source /absolute/path/to/jiangshan-map \
  --output /absolute/path/to/new-output
```

先用 `--preview` 可生成关键帧及乱序跳帧一致性记录。完整模式生成 H.264/AAC 视频、画面与声音时序、源文件和视频哈希。禁止覆盖已存在的成片，重新渲染使用新的输出目录。

## 精细版的使用与素材

```sh
node scripts/jiangshan-map-pilot/native-driver.mjs \
  --variant refined \
  --source /absolute/path/to/jiangshan-map \
  --assets outputs/jiangshan-map-refined-20261102/assets \
  --output /absolute/path/to/new-output \
  --audit-motion
```

加 `--preview` 仅生成预览和记录。`--audit-motion` 保存全部540帧的城市、箭头、军队与头像位置，供连续性检查；同帧乱序哈希通过不能代替连续帧审阅。精细版成片为 `outputs/jiangshan-map-refined-20261102/render-v6/jiangshan-refined-map-demo.mp4`，对应 `delivery.json` 和 `qa.json` 已记录编码、全540帧位置、实际MP4抽帧与完整解码核验；详情见 `docs/jiangshan-map-refined-video-20261102.md`。

缓存目录含 `portrait-guo.png`、`portrait-li.png`（各768×768）及透明 `cavalry.png`、`infantry.png`（各512×512）。`manifest.json` 记录原始/加工图片哈希、提示词和生成记录；`originals/` 保存原件。将领为郭子仪、李光弼示意立绘，骑军与步军是视觉符号；不能推断实际军容、服制或人数已获考证。渲染只消费缓存。缺失素材可运行 `node scripts/jiangshan-map-pilot/generate-refined-assets.mjs`，哈希匹配的原件会复用；追加 `--process` 仅重新处理已有原件。

动作时序：0–2.5秒部署，2.5–8.5秒沿曲线推进至82%，8.5–12秒推进至94%并收紧包围，12–14秒展开占领标记，14–18秒落旗驻留。两路红蓝色区分同方部队，不能直接当作敌我阵营。路线端点是示意部署位置，94%停留不表示军队入城。临时旁白采用 macOS Tingting，未接入任意已锁定配音。

## 全镜头布局合同

精细版先用完整镜头每帧的原生投影坐标与文字屏幕框准备布局，为各兵形/头像选择整段固定偏移；头像边界连续夹紧，地理锚点不变。表现对象通过引线指回锚点，箭头尖端与锚点共用弧长采样。当前布局降低标签重叠，实际遮挡仍需查看连续画面。

完整驱动器自动先调用 `window.jiangshanVideo.prepare()` 再 `seek(frame)`。直接使用叠层时，先把全镜头 `JiangshanRefinedInput[]` 交给 `window.prepareJiangshanRefinedLayout(inputs)`，再对每帧调用 `window.renderJiangshanRefined({...input, layout})`；每次捕获前仍须恢复该帧原生相机与标签布局。输入包括 `frame/fps/width/height`、“长安/商州/洛阳”当帧坐标、`labelObstacles` 和 `assets:{guoPortrait,liPortrait,cavalry,infantry}` 本地图片URL。改变镜头、画幅、字体或地点后重做布局。省略 `layout` 会回到逐帧局部避让，不能用于连续成片。

## 必须保持的实现约束

1. 地图原生相机先完成布局，再通过原生投影和 `getScreenCTM()` 得到动作锚点；不能把 Mercator 画面与另一套线性经纬投影混用。
2. 读取原生文本的实际屏幕包围盒，用全镜头布局安排精细版的军队和头像；行军箭头保持完整，不套用地名文字框遮罩；头像连同标题、阴影避开整条曲线。仅城市符号留出端点空隙，合围圈单独使用文字遮罩。保持原生标注，关闭“点击城池”等交互引导及网页侧栏，不替换成自绘地图。
3. 军队、旗帜和事件只使用帧时钟。离线冻结资产，字体就绪后捕获；用乱序访问同帧画面哈希验证可复现性，另用连续帧位置及画面检查瞬移、遮挡和事件时点。
4. 叙事占领标记与历史国家疆域分层；不得因攻击动作自动修改上游疆域。真实制作必须有明确史料和旁白事件依据。
5. 原型使用私有相机接口，必须固定上游 SHA。升级先核验 API、镜头、标签、行动配准与实际短片。
6. 原型只服务当前固定演示。精细版展示同方两路部队，不能据此声称任意人物、稿件、通用多阵营、多段路线、疆域时序与竖屏均已接入；自动生产入口尚未切换。

## 已核实的资料问题

上游原始城池具有出现/消失时间、首都时段、别名及年代改名字段，但 GeoJSON 导出会遗漏其中部分。地图查询也不是史实权威：208年的“江州”实测被解析到九江附近；1934年的“瑞金”未解析；公元0年会静默变为1。制作前校验地点身份与年份，优先使用已锁定的地点记录，缺失时补充可核实来源。

上游 README 明确列出 CHGIS V6/Hartwell 衍生府州郡及战国疆域的学术、非商业限制，而 GeoJSON 的统一 GPL 字符串未保留例外。按实际图层记录来源、许可和使用状态。当前样例是内部研发预览，不能据此声称数据已获商用许可。
