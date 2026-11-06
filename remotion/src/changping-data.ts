export type Geo = readonly [number, number];

export const changpingMap = {
  width: 1920, height: 1080, fps: 30, seconds: 45,
  bounds: {minLon: 110.8, maxLon: 115, minLat: 34.8, maxLat: 37.2},
  mapTop: 130, mapHeight: 752,
  historyStatus: 'illustrative',
  geometryNote: 'Control zones, historical boundaries, fronts and routes are authored schematic geometry, not surveyed reconstructions. Terrain is illustrative.',
  anchorNote: 'Approximate modern city locations used for regional orientation, not precise ancient city or battlefield sites.',
  places: {
    changping: {label: '长平', modern: '今高平一带', point: [112.924, 35.798] as Geo},
    shangdang: {label: '上党', modern: '今长子、长治一带', point: [112.88, 36.12] as Geo},
    handan: {label: '邯郸', modern: '赵国都城', point: [114.49, 36.60] as Geo},
    yewang: {label: '野王', modern: '今沁阳一带', point: [112.94, 35.09] as Geo},
  },
  shangdangZone: [[112.4, 36.63], [112.92, 36.68], [113.4, 36.42], [113.52, 35.92],
    [113.25, 35.46], [112.72, 35.43], [112.3, 35.7], [112.2, 36.22]] as Geo[],
  qinApproach: [[110.6, 34.6], [112.66, 34.6], [112.59, 35.12], [112.25, 35.42],
    [112.14, 35.85], [111.65, 36.05], [110.6, 36.08]] as Geo[],
  zhaoRear: [[112.95, 37.4], [115.3, 37.4], [115.3, 35.95], [114.5, 36.04],
    [114, 36.12], [113.6, 36.45], [113.13, 36.47]] as Geo[],
  // The northern connection is a strategic link, not a reconstructed ancient road.
  rearLink: [[112.93, 35.98], [113.04, 36.24], [113.45, 36.42], [114.0, 36.55], [114.49, 36.6]] as Geo[],
  stages: [
    {start: 0, end: 9, date: '前262年', title: '上党归赵', short: '归赵',
      caption: '韩上党转入赵方，秦赵争夺由此展开。',
      narration: '秦攻下野王，切断韩国与上党的联系。上党归赵，蓝色范围向南扩展。'},
    {start: 9, end: 18, date: '前260年 · 相持', title: '秦军进逼，廉颇固守', short: '相持',
      caption: '秦方控制向长平推进，赵军收缩防守。',
      narration: '秦军进逼长平。廉颇收缩阵地，坚壁固守。双方在前线相持。'},
    {start: 18, end: 27, date: '前260年 · 换将后', title: '赵括出击，蓝色前沿西伸', short: '出击',
      caption: '蓝色突出部表示进攻态势，并非稳定占领。',
      narration: '赵括接替廉颇，转守为攻。蓝色前沿向西伸出，但这只是进攻态势。'},
    {start: 27, end: 36, date: '前260年 · 决战', title: '分割包围，赵军与后方断开', short: '包围',
      caption: '秦军切断后路，赵军主力被压成孤立区域。',
      narration: '白起佯败诱敌，奇兵截断赵军后路。红色从两翼合拢，蓝色被切成孤立的包围圈。'},
    {start: 36, end: 45, date: '前260年九月 → 战后', title: '赵军败亡，上党转入秦控制', short: '战后',
      caption: '战后秦进一步控制上党，赵国本土仍然存在。',
      narration: '赵军主力败亡。战后，秦进一步控制上党。但邯郸仍属赵国，赵国并未灭亡。'},
  ],
  sources: [
    {title: '史记·白起王翦列传', url: 'https://ctext.org/shiji/bai-qi-wang-jian-lie-zhuan/zh',
      supports: '野王、上党争夺、廉颇固守、赵括出击、秦佯败与奇兵断后、分割包围及战后复定上党。'},
    {title: '史记·赵世家', url: 'https://ctext.org/shiji/zhao-shi-jia/zh', supports: '赵受上党、长平败亡及赵国后续历史。'},
    {title: '陕西省地方志办公室·白起', url: 'https://dfz.shaanxi.gov.cn/zslm/sxsq/sqrw/xzzqc/200903/t20090311_2619780.html',
      supports: '现代地名对应、战役过程与战后占领上党的时间区分。'},
    {title: '山西省文旅厅·一河丹水承载数千年记忆', url: 'https://wlt.shanxi.gov.cn/xwzx/sxdt/202610/t20261022_10241570.shtml',
      supports: '高平与长平战场、丹河及太行山地理关系。'},
    {title: '太原市图书馆·长子县志', url: 'https://www.tylib.org.cn/web/information/9311',
      supports: '长子县现代经纬范围与上党区域地理。'},
    {title: '邯郸市邯山区政府·区域位置', url: 'http://www.hdhs.gov.cn/zjhs/201712/t20171211_732058.html',
      supports: '邯郸现代地理范围。'},
  ],
};

export function projectChangping([lon, lat]: Geo) {
  const b = changpingMap.bounds;
  return {x: (lon - b.minLon) / (b.maxLon - b.minLon) * changpingMap.width,
    y: changpingMap.mapTop + (b.maxLat - lat) / (b.maxLat - b.minLat) * changpingMap.mapHeight};
}
