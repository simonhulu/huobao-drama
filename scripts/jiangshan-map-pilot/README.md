# 江山原生地图逐帧推演叠层

上游页面保留原生地图、地形、投影和中文标注；此叠层只绘制军队、路线、进攻脉冲与占领标记。由浏览器驱动器逐帧更新上游相机，再传入实际屏幕坐标，同步渲染叠层。没有 GeoJSON 底图重绘，也不重复绘制地名。

## 18 秒精细版

`--variant refined` 使用 757 年原生地图，加入郭子仪、李光弼示意头像，骑兵、步兵透明素材，渐变曲线箭头、阵营旗、合围和占领标记。画幅为 1920×1080、30fps，共540帧。人物、兵种、地点和动作目前固定；这是视觉与时序演示，不是757年某场战役的复原。

已有素材缓存位于 `outputs/jiangshan-map-refined-20261102/assets/`：

| 文件 | 用途 |
| --- | --- |
| `portrait-guo.png` | 郭子仪示意立绘，768×768 |
| `portrait-li.png` | 李光弼示意立绘，768×768 |
| `cavalry.png` | 骑兵队形，512×512透明PNG |
| `infantry.png` | 步兵队形，512×512透明PNG |

`manifest.json` 保存生成来源、提示词、生成记录标识、原件及加工后哈希；`originals/` 保留请求和原件。头像不是经过考证的真实肖像，队形图标不表示实际人数。渲染器只读取现有PNG，不会重新生成素材。

需要补齐素材时运行下列脚本：它通过项目现有图片服务生成缺失素材，对哈希匹配的原件复用缓存；`--process` 仅从已有原件重新裁切/处理透明背景，不提交生成请求。

```sh
node scripts/jiangshan-map-pilot/generate-refined-assets.mjs
```

使用下文固定版本的上游 checkout，预览关键帧并记录全部540帧的动作位置：

```sh
node scripts/jiangshan-map-pilot/native-driver.mjs \
  --variant refined \
  --source /tmp/jiangshan-map-study-20261101 \
  --assets outputs/jiangshan-map-refined-20261102/assets \
  --output /absolute/path/to/new-output \
  --preview --audit-motion
```

去掉 `--preview`，保留其他参数，即生成 `jiangshan-refined-map-demo.mp4`，包含按动作时间对齐的 macOS Tingting 临时旁白。`--audit-motion` 输出逐帧 `motion-audit.json`；预览记录包含6张关键帧、全镜头布局及同帧乱序访问哈希。编码完成后另有 `delivery.json`，记录视频参数、音频cue、视频及地图/人物素材哈希。

精细版成片为 `outputs/jiangshan-map-refined-20261102/render-v6/jiangshan-refined-map-demo.mp4`，已完成全540帧位置检查、同帧复现、实际MP4抽帧与完整解码；7项回归测试和定向TypeScript检查通过。交付与限制见[精细版验收](../../docs/jiangshan-map-refined-video-20261102.md)，机器记录为成片目录的 `qa.json`。

| 时间 | 画面动作 |
| --- | --- |
| 0–2.5秒 | 两路部署、人物与兵种建立 |
| 2.5–8.5秒 | 沿两条曲线行军，推进至路线82% |
| 8.5–12秒 | 再推进至94%，合围圈收紧 |
| 12–14秒 | 据点占领标记逐步展开 |
| 14–18秒 | 占领完成后落旗，保持将领和驻军 |

曲线箭头尖端和地理锚点共用弧长采样，兵形与头像通过引线指回锚点。路线终点是城外示意部署，不能把94%位置解释成军队已经入城；城池叙事标记也不修改上游历史疆域。

### 全镜头布局与直接调用

驱动器先遍历完整镜头，采集每帧原生城市坐标及文字包围盒，再为两队兵形和两张头像各选一组整段固定偏移。头像卡及其标题、阴影还须避开整条路线，并优先缩短引线。行军箭头不再用地名矩形遮罩挖空，城市端点符号留白与合围圈文字避让分开。头像到达画面安全边界时连续夹紧；地理锚点仍沿曲线运动。这避免逐帧切换离散避让位置造成头像或兵形瞬移。驱动器还会检查关键帧实际像素中的箭头可见性，并保存 `route-visibility.json`。布局需要最终连续画面核验，不能把降低文字重叠的评分机制说成所有标签必然无遮挡。

独立加载精细版叠层：

```sh
node scripts/jiangshan-map-pilot/build-overlay.mjs \
  --variant refined \
  --output /absolute/path/to/refined-overlay.js
```

输入使用 `JiangshanRefinedInput`：`frame/fps/width/height`、包含“长安/商州/洛阳”的当帧 `cities`、原生文字屏幕框 `labelObstacles`、以及本地图片URL `assets:{guoPortrait,liPortrait,cavalry,infantry}`。连续片必须先准备布局，再将同一 `layout` 传给每次渲染：

```js
// frameInputs 是完整镜头逐帧采集的输入；此前已按帧完成原生相机与标签布局。
const layout = window.prepareJiangshanRefinedLayout(frameInputs);
// 捕获某帧前，先恢复该帧的原生相机和标签布局，再提交相应叠层。
const evidence = window.renderJiangshanRefined({...frameInputs[150], layout});
```

两函数不会代替调用方设置原生相机。改变镜头、画幅、帧率、地点、字体或原生标签后应重新采集并准备布局。省略 `layout` 的逐帧局部避让仅适合单帧探索，不用于连续成片。默认完整驱动器会调用 `window.jiangshanVideo.prepare()`，随后 `seek(frame)` 同步更新原生地图和叠层。

## 12 秒基础版叠层

```sh
node scripts/jiangshan-map-pilot/build-overlay.mjs \
  --output outputs/jiangshan-map-study-20261101/native-overlay.js
```

页面准备绝对定位且覆盖完整视口的 `#jiangshan-video-overlay` 容器，加载生成的 IIFE 后调用：

```js
const evidence = window.renderJiangshanOverlay({
  frame: 120, fps: 30, width: 1920, height: 1080,
  cities: [
    {name: '长安', x: 400, y: 600},
    {name: '洛阳', x: 1500, y: 500},
  ],
});
```

示例坐标只说明 API，实际值必须来自当帧江山投影与 SVG `getScreenCTM()`。函数使用 React `flushSync()` 同步提交 DOM，返回：`frame`、`seconds`、`phase`、`routeProgress`、`armyAnchor`、`occupationProgress`、`occupationMarkerVisible`、`historicalTerritoryChanged:false`。浏览器驱动器负责字体/原生地图资源准备、相机 seek、截图、编码和旁白。

12 秒演示时序：0–2 秒建立；2–6 秒沿端点连线行军；6–8 秒进攻脉冲；8–10 秒展开占领标记；10–12 秒落旗停留。动作来自帧号，不使用墙钟、定时器或异步动画。无论帧顺序如何，相同帧号和投影输入产生相同画面。

军队、旗帜、沿路线定位、占领完成判定复用 `HistoryMapForces`、`HistoryMapFlag`、`mapForceState`、`mapCityControlAt` 与 `referenceRoutePoint`。占领是叙事叠层，绝不修改上游历史疆域或地名。所有动作是虚构演示，路线非古道；素材许可与古地理核验仍需完成。

`superseded-geojson-pilot` 如存在，为已废弃的早期重绘实验，不属于最终交付。当前代码只保留原生逐帧叠层接口。

## 本地原生页面与基础版短片

准备上游源码（已有 checkout 可直接传入，不必重复克隆）：

```sh
git clone https://github.com/DeanChensj/jiangshan-map.git /tmp/jiangshan-map-study-20261101
git -C /tmp/jiangshan-map-study-20261101 checkout a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a
```

只检查关键画面：

```sh
node scripts/jiangshan-map-pilot/native-driver.mjs \
  --source /tmp/jiangshan-map-study-20261101 \
  --output outputs/jiangshan-map-study-20261101/native \
  --preview
```

去掉 `--preview` 导出12秒 H.264/AAC MP4。产物含5张关键帧、原生相机和叠层状态、乱序跳帧一致性检查、音频cue、上游资产哈希和 `delivery.json`。完整视频已存在时拒绝覆盖，复跑请选择新的 `--output`。

驱动器直接打开上游本地网页，保留 SVG、地形、中文城名、河流、关隘、道路与边界。`window.jiangshanVideo.seek(frame)` 设置原生相机并完成标签布局，再将实际屏幕坐标与原生文字包围盒交给叠层；所有外网请求被阻断，地图与地形读本地资产。每帧捕获完成画面后编码，并加入按cue对齐的 macOS Tingting 临时演示旁白。

需要本项目已有依赖、`.remotion-chrome` 中的 Chrome、FFmpeg/ffprobe，以及 macOS `say`。未安装新依赖，未修改上游源码；字体采用本机已有字体，跨系统字形可能不同。驱动器调用上游私有相机方法，固定 SHA 是兼容性要求。

两个版本都是固定年份/人物/动作的研发示范。精细版展示了同方两路部队，尚未接通任意稿件、通用多阵营、多段路线或竖屏。上游部分地图数据含非商业限制，当前短片只用于内部技术验证。生产适配方向和逐层资料问题见 `docs/jiangshan-map-native-video-adaptation-20261101.md`。

12秒基础样片：`outputs/jiangshan-map-study-20261101/native-v2/jiangshan-native-map-pilot.mp4`。该版本还让路线避开原生文字范围，军队避让保留实际地理锚点；视频编码为 BT.709 H.264，旁白为 48kHz AAC。
