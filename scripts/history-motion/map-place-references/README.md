# Offline place references

A deliberately small fallback for places absent from the cached Natural Earth populated-place dataset. `map-data.mjs` verifies every archived source file hash and checks coordinates against the source page's `Place.geo` structured data before using an entry.

## Ruijin / 瑞金

- Source: https://www.geonames.org/10378131/ruijin.html
- Accessed: 2026-10-26.
- Source feature: populated place, Jiangxi, China; coordinates **25.88320° N, 116.02715° E**.
- GeoNames search also contains the administrative district, feature 1797053, with a different centroid. This record deliberately uses the populated place for city positioning.
- Coordinate system: WGS84, confirmed by https://www.geonames.org/about.html.
- License and attribution: **GeoNames, CC BY 4.0**, https://creativecommons.org/licenses/by/4.0/.
- Scope: modern city reference only. These coordinates do not establish the location of a specific 1934 building, battle line, road or historical administrative boundary.

The archived HTML files are evidence, not scripts to execute. Adding another place requires its source document, explicit feature identity, coordinates, license, and hashes in `places.json`.
