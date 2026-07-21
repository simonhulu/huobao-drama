#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const sourcePath = path.join(root, "data/static/demos/world.geojson");
const outputPath = path.join(root, "remotion/src/worldMapData.ts");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const features = (source.features || []).map((feature) => ({
  id: feature.id,
  properties: { name: feature.properties?.name || "" },
  geometry: feature.geometry,
}));

const output = `// Generated from data/static/demos/world.geojson. Keep the source file as the canonical map input.\n// The TS module is required because Remotion's bundler does not load the .geojson extension by default.\nexport const worldGeoJson = ${JSON.stringify({ type: source.type, features })} as const;\n`;
fs.writeFileSync(outputPath, output);
console.log(JSON.stringify({ source: sourcePath, output: outputPath, features: features.length }, null, 2));
