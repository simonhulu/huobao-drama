# 江山原生地图精细推演样片

2026-11-02 完成18秒精细版，保留江山原生地形、河流、边界、中文标签与布局，增加将领、兵种、曲线行军、合围与占领。当前为固定场景内部研发样片，没有切换任意稿件的自动生产入口。

## 查看产物

- [带旁白成片](../outputs/jiangshan-map-refined-20261102/render-v6/jiangshan-refined-map-demo.mp4)
- [从成片抽取的六帧总览](../outputs/jiangshan-map-refined-20261102/render-v6/video-contact-sheet.png)
- [占领后驻留画面](../outputs/jiangshan-map-refined-20261102/render-v6/video-frame-480.png)
- [生成素材与原件记录](../outputs/jiangshan-map-refined-20261102/assets/manifest.json)
- [交付元数据](../outputs/jiangshan-map-refined-20261102/render-v6/delivery.json)与[核验记录](../outputs/jiangshan-map-refined-20261102/render-v6/qa.json)

成片：1920×1080、30fps、540帧、18秒，H.264 / AAC 48kHz，约17.1 MB。SHA-256：`30d8a2c8f568c1ad0d4528cc6b66cec16240337625a9d56fcbe63c88a9553320`。

## 画面与动作

郭子仪和李光弼各使用独立生成的示意立绘，头像窗放大头脸，配姓名、兵种牌和旗号。骑兵、步军采用带透明通道的半写实小队素材。生成结果、提示词和原件哈希已缓存，渲染不会再次调用图片服务。

行军箭头使用渐细填充轮廓、暖色描边和渐变，沿三次曲线逐步展开。箭头尖端、部队地理锚点共用弧长采样；兵形和头像通过引线连接实际锚点。两路颜色表示同方不同部队。示意行军路线不是经考证的古道，部署不是历史战线。

0–2.5秒建立部署，2.5–8.5秒分路行军，8.5–12秒合围推进，12–14秒展开据点占领标记，14–18秒落旗驻留。城外部署与城市占领分开表达，未修改上游历史疆域。旁白使用本地 Tingting 临时演示音色，按四段时间区间混入。

连续检查发现逐帧切换避让候选会使对象瞬移，最大单帧跳跃约278px。改为预先读取完整镜头每帧原生标签和坐标，为各对象选择整段固定偏移，头像在安全边界连续夹紧。最终部队最大单帧位移为5.04px / 3.59px，与各自地理锚点完全相同；头像最大为4.53px / 3.59px。地图字号、相机和地点变化后需要重新准备布局。

## 箭头遮挡修复（v6）

用户指出蓝色箭头被截断。原因有两处：地名包围盒遮罩会挖空箭身，将领卡又覆盖了路线中段。现将箭头遮罩限定为城市端点符号留白，合围圈单独使用文字避让；头像卡、标题和阴影必须避开整条曲线，布局仍按完整镜头保持连续。

[修复前后对比](../outputs/jiangshan-map-refined-20261102/render-v6/arrow-before-after.png)。驱动器新增实际合成像素检查，5张行动关键帧共978个路线采样点均可见；旧版同位置有133个不可见点。另从最终MP4抽取第390、480帧检查，484个采样点均可见。7项回归测试、定向类型检查和成片完整解码通过，540帧未出现布局跳位。检查以当前固定场景为限。

## 核验结果

- 七项几何、占领时序、坐标变换、标签避让和全镜头布局回归测试通过；叠层定向 TypeScript 与驱动器语法检查通过。
- 全540帧的箭头尖端与地理锚点误差为0；第420帧开始完成占领，之前无提前完成。
- 165→330→165乱序回看画面哈希相同；浏览器无运行异常和本地资源失败。
- ffprobe 确认实际尺寸、30fps、540帧及18秒音视频流；FFmpeg完整解码通过，视频哈希与交付记录一致。
- 查看了实际MP4抽帧总览、驻留大图，以及部署、行军、合围、占领预览。复现的庆州文字被头像遮挡问题已处理。布局评分降低重叠，不能据此保证任意地图所有次级文字与符号全程无遮挡。
- 已核查音轨和旁白cue，没有声称完成人工听审。

## 实现与复用

- `remotion/src/JiangshanMapRefined.tsx`：将领卡、兵形、旗帜、曲线箭头、合围与占领叠层。
- `remotion/src/jiangshan-refined-geometry.ts`、对应 `.test.ts`：曲线弧长、阶段状态与全镜头布局。
- `scripts/jiangshan-map-pilot/native-driver.mjs`：原生相机驱动、整段布局准备、逐帧捕获、旁白混合及证据记录。
- `scripts/jiangshan-map-pilot/build-overlay.mjs`：选择基础/精细版并打包。
- `scripts/jiangshan-map-pilot/generate-refined-assets.mjs`：生成缓存、原件校验、头像处理和透明兵形加工。
- `.codex/skills/history-map-animation/SKILL.md` 及 `references/jiangshan-native.md`：记录精细版用法、输入合同与连续性检查。

运行命令和 `prepareJiangshanRefinedLayout → renderJiangshanRefined` 合同见[使用说明](../scripts/jiangshan-map-pilot/README.md)。上游固定 SHA 为 `a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a`，工作树保持干净。

当前人物、年份、地点和18秒动作仍固定；通用事件/已锁定旁白导入、多段古道、敌我攻守、任意人物与竖屏尚未接入。原生地形仍是上游栅格精度。地图来源、非商业数据例外及后续生产边界见[原生适配研究](jiangshan-map-native-video-adaptation-20261101.md)。
