# 地图数据与已有案例的复用

## 数据来源

| 目标 | 可用来源 | 本项目需要保留的限制 |
| --- | --- | --- |
| 河流、主要现代城市、现代国界、海岸线 | Natural Earth 公共领域数据 | `10m` 是 1:10,000,000 比例尺，绝非 10 米精度；现代地理不等于古代复原 |
| 真实高程晕渲 | Mapzen / Tilezen Terrain Tiles 的 Terrarium 或 GeoTIFF | 保存每片实际来源；SRTM、GMTED2010 与其他区域上游数据的许可不能混为一谈 |
| 局部高程补充 | Copernicus DEM GLO-30 的公开 COG | 记录实际读取的 overview；30米名义源不能代替本片实际采样分辨率 |
| 更丰富的河网 | HydroRIVERS v1.0 | 按 HydroSHEDS 条款保留署名；现代水系不能证明古河道 |
| 更细的现代地物 | OpenStreetMap | 保存 ODbL 与署名依据；数据许可和在线瓦片服务政策分别核对 |
| 对应年代的历史要素 | OpenHistoricalMap、CHGIS 或有明确许可的历史成图 | 检查地区和时间覆盖、个别要素许可；免费下载不自动等于允许商业再利用 |

已有调查与官方链接见 [免费地图数据调查](../../../../docs/free-map-data-for-history.md)。该报告核实日期为 2026-10-24，长平区域的结论不能直接套给其他时间、地区和数据版本。CHGIS 所声明的前221年起时间范围不覆盖前260年长平之战。

历史国界不足时，应在底图保留可信地理信息，把战区控制画成示意。对任何历史成图，记录作者、原始页面、采用的许可、修改内容、署名与相同方式共享义务；不得把已有缩略图放大后称为高清 GIS 底图。

## 当前已有资产

以下路径从仓库根目录起算：

| 文件 | 实际用途 |
| --- | --- |
| `remotion/public/changping-demo-v2/terrain.png` | 经度107.5–116.3、纬度33.6–37.5的现代高程晕渲 |
| `remotion/public/changping-demo-v2/geographic-data.json` | 相同范围的河流、城市、EPSG:4326 坐标、投影与来源 |
| `remotion/public/changping-demo-v2/warring-states-260bce.jpg` | Philg88 约前260年战国总览缩略图；CC BY-SA 3.0；只适合小尺寸独立总览 |
| `remotion/src/ChangpingAtlasDemo.tsx` | 45秒长平案例：全局、上党转归、秦军进逼、赵军出击、包围、战后控制 |
| `remotion/src/changping-atlas-data.ts` | 案例投影与底图、总览署名 |
| `remotion/src/changping-data.ts` | 案例事件、近似地点、示意路线/控制区及史料链接 |
| `scripts/changping-demo/build-real-map.mjs` | 下载、缓存、Terrarium 高程解码、晕渲和 Natural Earth 裁剪的现成实现 |
| `scripts/changping-demo/render.mjs` | 固定长平案例渲染与示例旁白的实现参考 |

不要把上述案例脚本当成通用命令。`build-real-map.mjs` 的范围、输出目录、日期目录和尺寸目前写死；直接执行会重写已有地图资产。`render.mjs` 的故事、输出路径、旁白和片长也固定，且拒绝覆盖已有 MP4。新项目应复制并参数化需要的逻辑到新版本目录，或接入通用 composition；不修改历史样片来“变成”新故事。

## 高程与配准细节

Terrarium 解码为 `R*256 + G + B/256 - 32768` 米。案例先读取 Web Mercator 瓦片，再双线性重采样到经纬度线性画布，最后以实际地面距离计算坡度晕渲；像素数和瓦片 zoom 不能当成源 DEM 的精度。

取景范围、输出尺寸和源瓦片层级需要一起决定。只把低层级高程插值到 1920×1080 会得到模糊或阶梯块状地形；适当提高缓存瓦片层级，或扩大/收紧范围以匹配可用细节。按最终运镜的最大放大比例看实际输出，不以文件尺寸代替清晰度检查。地形只是参照层，不能靠锐化滤镜造出源数据没有的山脊精度。

单点查询仍需给观众定位上下文。可以从同一范围内的可靠数据选少量邻近城市、河流、区域名和现代参考边界；上下文地点不等于本段历史事件发生地。没有许可或覆盖不足的数据层不强补，更不能把现代行政边界换成历史阵营颜色。示意部署圈、箭头、受压范围应作为独立叙事层保存，其依据与真实地形/地点来源分开。

案例对该内陆区域孤立负高程做了非负邻域中值修复，写入原值、新值、像素位置。此做法不能默认推广到海岸、洼地或其他存在真实负高程的区域。

新地图的缓存清单至少记录：

```json
{
  "bounds": {"minLon": 107.5, "maxLon": 116.3, "minLat": 33.6, "maxLat": 37.5},
  "crs": "EPSG:4326",
  "projection": "Equirectangular; longitude and latitude linear in image pixels",
  "sources": [{"url": "实际原始来源", "license": "实际许可", "sha256": "实际文件哈希"}],
  "historyStatus": "illustrative",
  "historicalLimit": "现代地形和城市用于定位；战区控制与路线为示意"
}
```

这是数据准备清单，不是声称任意渲染器已接受此 JSON。接入新渠道时，以当前 `HistoryMotionFactory` 类型与渲染器校验为实际输入合同。若渲染输入使用归一化屏幕坐标，仍需保留生成它的经纬度和投影证据，不能直接让模型猜坐标。

## 通用制图实现

- `scripts/history-motion/map-data.mjs`：`prepareMapData(input)` 负责地点、取景和路线；`prepareAtlasTerrain({bounds,width,height,directory}, options)` 可在保留旧版取景时升级底图。`options.network=false` 使用本地缓存。
- `scripts/history-motion/atlas-terrain.mjs`：多尺度实测高程晕渲、分层配色，以及有预算的 Copernicus Float32 COG 范围读取。默认最多96片地形瓦片；完整高精度源不可得时回退完整缓存，不拼入缺失瓦片或凭空造山。
- `scripts/history-motion/map-geography.mjs`：`prepareMapGeography({bounds,width,height,context,year})` 返回 `waterways/waterAreas/geographicLabels/sources/decisions/historicalLimit`，无联网或模型调用。东经109–124°、北纬30–42.5°内使用已下载 HydroRIVERS 亚洲裁剪包（约784KB）；区域外使用可用的 Natural Earth 河流，其他区域图层按真实覆盖省略。
- `scripts/history-motion/map-geography-data/`：原始几何裁剪包、各包 SHA-256 与官方链接、历史差异参考、可复现的 Python 标准库构建脚本。Natural Earth 的海面多边形保留孔洞，不能以地形高程低于零直接判断海水。
- `backend/src/services/history-motion-maps.ts`：自动生产的组合入口，接收已锁定稿件 `historicalContext`。地理清单与每次军事动作清单独立保存，避免后镜覆盖前镜证据。
- `remotion/src/HistoryMapScene.tsx` 与 `history-map-labels.ts`：`cartography:{version:1,style:'relief-atlas'}` 启用独立水面、分级河流、屏幕空间地名；河流圆角偏移不超过2屏幕像素，军队路线不随之改变。河名 `waterwayId` 必须引用实际河段；山川标签移位过大时省略，避免错指另一地物。

明代语境省略1855年改道后的现行下游黄河主干、现代水库，并使用有依据的“卢沟河”等名称；这不构成完整古水系复原。当前没有猜画东昌运河，没有自动复原历史国界。来源和已知缺口保存在制作记录，不默认烧录长来源文字或素材类别角标。

第1063集本轮实际使用 **Mapzen 缓存高程 + HydroRIVERS/Natural Earth/Wikidata 图层**。Copernicus 范围解码已经验证，但更细数据下载未完成；没有将450像素预览用于替代更清晰缓存。不要把已实现的接口能力写成该片采用的数据。真实成片证据见 `docs/history-map-atlas-1063-20261028.md`。
