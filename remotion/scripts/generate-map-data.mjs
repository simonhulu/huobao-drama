import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const inputPath =
  process.argv[2] ??
  path.join(root, "data/static/demos/map-sources/natural-earth-china-provinces.geojson");
const riversPath =
  process.argv[3] ??
  path.join(root, "data/static/demos/map-sources/natural-earth-major-rivers.geojson");
const outputPath =
  process.argv[4] ?? path.join(root, "remotion/src/chinaMapData.ts");

const bounds = {
  minLon: 96,
  maxLon: 122,
  minLat: 20,
  maxLat: 42,
  left: 68,
  top: 86,
  width: 1080,
  height: 500,
};

const round = (value) => Math.round(value * 100) / 100;

const project = ([lon, lat]) => [
  round(
    bounds.left +
      ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * bounds.width,
  ),
  round(
    bounds.top +
      ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * bounds.height,
  ),
];

const linePath = (coordinates, close = false) => {
  if (!coordinates?.length) return "";
  const points = coordinates.map(project);
  return `${points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
    .join(" ")}${close ? " Z" : ""}`;
};

const geometryPath = (geometry) => {
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) => linePath(ring, true)).join(" ");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map((ring) => linePath(ring, true)))
      .join(" ");
  }
  if (geometry.type === "LineString") return linePath(geometry.coordinates);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map((line) => linePath(line)).join(" ");
  }
  return "";
};

const provincesGeoJson = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const riversGeoJson = JSON.parse(fs.readFileSync(riversPath, "utf8"));

const provinces = provincesGeoJson.features
  .filter((feature) => feature.properties?.admin === "China")
  .map((feature) => ({
    name: feature.properties?.name ?? "",
    d: geometryPath(feature.geometry),
  }))
  .filter((feature) => feature.d)
  .sort((a, b) => a.name.localeCompare(b.name));

const riverNames = new Set(["Chang Jiang", "Yangtze", "Huang", "Han"]);
const rivers = riversGeoJson.features
  .filter((feature) => riverNames.has(feature.properties?.name))
  .map((feature) => ({
    name: feature.properties?.name ?? "",
    d: geometryPath(feature.geometry),
  }))
  .filter((feature) => feature.d);

const output = `// Generated from Natural Earth 1:50m data. Public Domain.
// Sources: https://github.com/nvkelso/natural-earth-vector
export type MapPath = { name: string; d: string };

export const chinaProvincePaths: readonly MapPath[] = ${JSON.stringify(provinces, null, 2)};

export const chinaRiverPaths: readonly MapPath[] = ${JSON.stringify(rivers, null, 2)};

export const chinaMapBounds = ${JSON.stringify(bounds, null, 2)} as const;
`;

fs.writeFileSync(outputPath, output);
console.log(
  `Generated ${provinces.length} province paths and ${rivers.length} river paths at ${outputPath}`,
);
