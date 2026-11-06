# 历史地图视频的免费地图数据

核实日期：2026-10-24。范围为长平之战样片使用的真实地形、河流、城市和历史总览，不把现代地理数据当成战国国界。

## 可直接采用的来源

| 内容 | 来源与数据 | 许可与使用要求 | 适合本片的用途 |
| --- | --- | --- | --- |
| 河流、湖泊、主要城市、现代国家/行政边界 | Natural Earth，提供 1:10m、1:50m、1:110m 的矢量与栅格数据 | 官方全部地图栅格和矢量数据为公共领域，可修改、商用；署名非强制，建议保留 Made with Natural Earth | 河流线、城市坐标和区域定位；现代边界不能替代秦、赵、韩的历史边界 |
| 真实高程 | Mapzen / Tilezen Terrain Tiles，AWS Open Data 托管，Terrarium PNG / GeoTIFF 等 | 聚合多个开放高程来源，各来源条款不同；本区域瓦片来源头含 SRTM、GMTED2010，官方说明两者为公共领域并请求给予 USGS 署名 | 生成太行、太岳、中条及山间盆地的真实晕渲地形，代替程序噪声造山 |
| 城市与现代地物的更细数据 | OpenStreetMap | ODbL；成图使用保留 OpenStreetMap contributors 署名；数据许可与在线瓦片服务的使用政策是两件事 | 当 Natural Earth 未覆盖小城市、小河流时补充；本片优先采用已缓存的 Natural Earth |
| 历史要素 | OpenHistoricalMap | 默认 CC0，但个别要素有独立的 `license=*`，应按所选要素核对 | 有时间标签的历史地点和边界候选来源；本次未核实到可直接作为前260年秦赵韩精细国界的数据 |
| 约前260年战国总览成图 | Wikimedia Commons，Philg88《EN-WarringStatesAll260BCE.jpg》 | 作者提供 CC BY-SA 3.0 Unported 或 GFDL 1.2 或更高；本片选用 CC BY-SA 3.0 时需署名、链接许可、说明修改，并遵守相同方式共享条款 | 用作独立历史总览插图，说明秦赵韩魏齐楚燕的大体位置；不是测绘精度的 GIS 边界 |

Natural Earth 的 “10m” 表示 1:10,000,000 比例尺，不是10米地面分辨率。城市数据表示现代聚落位置；历史名称、古城址和特定年代的归属需要另行核实。现代河流线也不等于复原的前260年河道。

## 推荐下载入口

Natural Earth 官方入口和公共领域声明：

- [Terms of Use](https://www.naturalearthdata.com/about/terms-of-use/)
- [1:10m Cultural Vectors](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/)，包括 Populated Places、Admin 0 Countries、Admin 1 States and Provinces 等。
- [1:10m Physical Vectors](https://www.naturalearthdata.com/downloads/10m-physical-vectors/)，包括 Rivers and Lake Centerlines、Lakes 等。
- [官方维护的矢量仓库](https://github.com/nvkelso/natural-earth-vector)，可读取 GeoJSON，保留下载版本与哈希。
- 城市 Shapefile：`https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_populated_places.zip`
- 河流 Shapefile：`https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_rivers_lake_centerlines.zip`
- 现代国家 Shapefile：`https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries.zip`

Terrain Tiles 的官方入口：

- [AWS Open Data：Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)，登记了公开 S3 桶 `elevation-tiles-prod`，无需 AWS 账号。
- [Tilezen / Joerd 数据来源](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
- [Tilezen / Joerd 署名与各来源许可](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- Terrarium 瓦片：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
- 本机已实际取得响应的瓦片示例：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/8/208/100.png`。

示例瓦片返回的 `x-amz-meta-x-imagery-sources` 包含 SRTM 的 `N36E113.tif`、`N35E113.tif`、`N36E112.tif`、`N35E112.tif`，以及 GMTED2010 的 `30N090E_20101117_gmted_mea075.tif`。生成本片底图时应按实际下载瓦片保存来源头与哈希，不能把整个聚合服务说成单一 NASA 数据集，也不能把输出图片像素或瓦片缩放级别当作源数据精度。

适用于本区域的署名可以写为：

> Terrain: Mapzen / Tilezen; SRTM and GMTED2010 data courtesy of the U.S. Geological Survey. Terrain Tiles accessed on 2026-10-24 via the AWS Open Data Registry. Rivers and city context: Natural Earth.

片中使用简短来源行，随片资料页记录完整链接、访问日期、缓存瓦片来源和处理方法。Joerd 官方说明署名应出现于适合所用媒介的位置；世界其他区域可能使用需要额外署名的不同数据，不能把这份本区域说明直接当作全球通用许可。

## 战国国界：已找到什么，尚未找到什么

本次没有核实到一个许可清楚、可直接下载、专门对应前260年秦赵韩边界且精度适合长平战区细节的 GIS 数据集。免费现代国界很多，不能因此推定某一年战国国界也有同样完整的现成数据。

CHGIS 官方说明时间序列范围为前221年至1911年，Harvard CGA 说明全国面状覆盖包括1820年和1911年。它对历史地名与行政区非常有用，但前260年早于其声明的时间范围，不应把1820年或1911年的边界换标签后用于长平之战。官方介绍称其为免费学术用途；具体下载数据的许可需逐份核对，也不应由“免费下载”推定任意商业视频均可直接使用。

- [CHGIS 官方介绍](https://chgis.fas.harvard.edu/pages/intro/)
- [Harvard CGA：China Historical GIS](https://gis.harvard.edu/china-historical-gis)
- [CHGIS v6 数据仓库](https://dataverse.harvard.edu/dataverse/chgis_v6)

OpenHistoricalMap 提供开放下载和兼容 OSM 的接口，能表达历史变化，但“能查询历史”不代表目标时间和地区已完整录入。本次未完成对其前260年秦赵韩要素的完整性验证，因此不把它列为本片已经获得的国界。

- [OpenHistoricalMap About](https://www.openhistoricalmap.org/about)
- [OpenHistoricalMap Copyright and Acknowledgements](https://www.openhistoricalmap.org/copyright)
- [OpenStreetMap Copyright](https://www.openstreetmap.org/copyright)

## 可复用的约前260年总览图

作者 Philg88 的战国总览图包含各国的颜色分区、边界与主要城市，可用于建立历史全局位置感。官方 Commons 文件实体标注：作者原创，2010-10-27，4724×4348，许可 CC BY-SA 3.0 Unported / GFDL 1.2 或更高。本次选择 CC BY-SA 3.0。

- [英文原图及许可说明](https://commons.wikimedia.org/wiki/File:EN-WarringStatesAll260BCE.jpg)
- [对应 Commons 文件实体 M11900403](https://commons.wikimedia.org/entity/M11900403)
- [中文版本](https://commons.wikimedia.org/wiki/File:ZH-%E6%88%98%E5%9B%BD%E4%B8%83%E9%9B%84%E5%9C%B0%E5%9B%BE.jpg)
- [CC BY-SA 3.0 许可](https://creativecommons.org/licenses/by-sa/3.0/)
- 原始图片端点：`https://upload.wikimedia.org/wikipedia/commons/c/ca/EN-WarringStatesAll260BCE.jpg`

原图域名在本次会话中请求超时。已从 [Lumen Learning 的周代课程页](https://courses.lumenlearning.com/tc3-boundless-worldhistory?p=728) 找到并下载同一图的522×480转载缩略图，78,181 bytes。课程页对应图片的 alt 是 “The map shows seven warring states: Zhao, Yan, Qi, Wei, Qin, Han, and Chu.”；该图片也被列入页面来源。它适合不超过原尺寸的总览插图，不能放大后冒称高清底图。

- 转载图片端点：`https://textimgs.s3.amazonaws.com/boundless-world-history/7mx6nxtws92ubzub3pwz.jpe`
- 本次下载位置：`/tmp/changping-philg88-warringstates.jpg`

署名示例：

> Warring States overview, circa 260 BCE — Philg88, Wikimedia Commons, CC BY-SA 3.0. [按实际填写：缩放 / 裁剪 / 标记添加。]

如果裁剪、重绘或叠图等构成对该图的改编，应依许可发布相应改编作品；署名并不能代替相同方式共享要求。该图是作者制作的历史示意总览，不能因为有清晰边线就把它标为经过测绘核实的前260年国界。动画的局部战区范围与进军路线仍需保留“示意”的说明。

## 本片实施建议

在战区主画面使用真实高程晕渲、真实河流、经过筛选的城市和山脉名称，降低秦赵色块的不透明度，让地形仍能读出来。在总览插图单独展示约前260年的历史各国分布。将秦赵控制范围和战役箭头作为独立动画层，既能满足地图信息密度，也能继续按旁白展示势力消长。

本次核实依据包括 Natural Earth 官方条款完整网页、Joerd 官方 GitHub 页面内的署名文档、CHGIS 官方介绍；Commons 和部分 OHM 内容通过检索服务返回的官方页面索引核对。GitHub raw 域名出现 TLS 失败，Commons 原图端点超时，OERProject 页面返回 Access Denied；没有据此宣称已经下载高清战国图或取得精确古代国界。
