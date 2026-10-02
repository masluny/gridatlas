export function bboxOfRings(rings) {
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const lon = ring[i][0];
      const lat = ring[i][1];
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > lat !== yj > lat;
    if (!crosses) continue;
    const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (lon < x) inside = !inside;
  }
  return inside;
}

export function preparePolygons(list) {
  return list.map((item) => ({
    n: item.n,
    parts: item.parts.map((part) => ({
      outer: part.outer,
      holes: part.holes,
      bbox: bboxOfRings([part.outer, ...part.holes]),
    })),
  }));
}

export function countryAtPoint(prepared, lat, lon) {
  for (let i = 0; i < prepared.length; i++) {
    const country = prepared[i];
    const parts = country.parts;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const box = part.bbox;
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
      if (!pointInRing(lon, lat, part.outer)) continue;
      let inHole = false;
      for (let h = 0; h < part.holes.length; h++) {
        if (pointInRing(lon, lat, part.holes[h])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return country.n;
    }
  }
  return null;
}
