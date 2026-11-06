import {createHash} from 'node:crypto';

// A terrain raster is reusable geographic data. Repeating the same geographic
// argument is a repeated scene; new routes or control changes are new scenes.
export function mapSceneAssetKey(backgroundSha256, map) {
  const ordered = values => values.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const enclosure = map.encirclement;
  const compress = enclosure?.compressionStart !== undefined && enclosure?.compressionEnd !== undefined;
  const content = {
    backgroundSha256,
    cities: ordered((map.cities || []).map(city=>({name:city.name,x:city.x,y:city.y,role:city.role || 'primary'}))),
    routes: ordered((map.routes || []).map(route=>({points:route.points}))),
    forces: ordered((map.forces || []).map(force=>({commander:force.commander,faction:force.faction,city:force.city,action:force.action,
      routePoints:map.routes?.[force.routeIndex]?.points,
      captureOrder:force.action==='occupy' ? (map.forces || []).filter(other=>other.action==='occupy' && other.city===force.city && other.end<force.end).length : undefined}))),
    territories: ordered((map.territories || []).map(territory=>({points:territory.points,initialPoints:territory.initialPoints || territory.points}))),
    encirclement: enclosure ? {center:enclosure.center,radiusX:enclosure.radiusX,radiusY:enclosure.radiusY,
      compress,innerScale:compress ? enclosure.innerScale ?? .65 : undefined} : undefined,
  };
  return `map:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`;
}
