import type {changpingMap, Geo} from './changping-data';

const atlasConfig = {
  bounds: {minLon: 107.5, maxLon: 116.3, minLat: 33.6, maxLat: 37.5},
  mapWidth: 1380,
  geometryNote: 'Real modern DEM relief and Natural Earth rivers/city coordinates. Animated battlefield control remains schematic; the separately credited historical atlas is circa 260 BCE, not a surveyed GIS boundary layer.',
  terrainAttribution: 'Terrain: Mapzen / USGS SRTM, GMTED2010; geographic vectors: Natural Earth (public domain).',
  atlasAttribution: 'Historical map: Philg88, circa 260 BCE, CC BY-SA 3.0. Reduced and presented alongside original modern-geography animation.',
  sources: [
    {title: 'Natural Earth: public-domain geographic data', url: 'https://www.naturalearthdata.com/about/terms-of-use/', supports: 'Modern rivers and city reference coordinates, not ancient borders or ancient river reconstruction.'},
    {title: 'Terrain Tiles on AWS', url: 'https://registry.opendata.aws/terrain-tiles/', supports: 'Real modern elevation; exact source tiles and source imagery headers are recorded in map-source-data.'},
    {title: 'Mapzen terrain attribution', url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md', supports: 'Attribution and upstream DEM provenance.'},
    {title: 'Philg88: Warring States circa 260 BCE', url: 'https://commons.wikimedia.org/wiki/File:EN-WarringStatesAll260BCE.jpg', supports: 'Separate historical overview with state boundaries and major settlements; CC BY-SA 3.0, not an exact battlefield survey.'},
  ],
};

export const createAtlasMap = (base: typeof changpingMap) => ({...base, ...atlasConfig, sources: [...base.sources, ...atlasConfig.sources]});

export function projectAtlas([lon, lat]: Geo) {
  const b = atlasConfig.bounds;
  return {x: (lon - b.minLon) / (b.maxLon - b.minLon) * atlasConfig.mapWidth,
    y: 130 + (b.maxLat - lat) / (b.maxLat - b.minLat) * 752};
}
