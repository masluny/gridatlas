import { atlas } from "./atlas.js";
import { wrapLon } from "./grid.js";
import { countryAtPoint, preparePolygons } from "./geom.js";

let prepared = null;

function countries() {
  if (!prepared) prepared = preparePolygons(atlas.land);
  return prepared;
}

export function countryAt(lat, lon) {
  return countryAtPoint(countries(), lat, wrapLon(lon));
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function nearestPlace(lat, lon) {
  let best = null;
  let bestScore = Infinity;
  const cos = Math.cos((lat * Math.PI) / 180);
  const places = atlas.places;
  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    const dLat = place[3] - lat;
    let dLon = place[4] - lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    dLon *= cos;
    const score = dLat * dLat + dLon * dLon;
    if (score < bestScore) {
      bestScore = score;
      best = place;
    }
  }
  if (!best) return null;
  return {
    name: best[0],
    country: best[2],
    lat: best[3],
    lon: best[4],
    pop: best[5],
    km: distanceKm(lat, lon, best[3], best[4]),
  };
}

const FOLD = {
  ł: "l",
  ø: "o",
  đ: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ð: "d",
  ı: "i",
};

export function fold(text) {
  let out = "";
  for (const ch of text.toLowerCase()) out += FOLD[ch] ?? ch;
  return out.normalize("NFD").replace(/\p{M}/gu, "");
}

export function searchPlaces(query, limit = 8) {
  const q = fold(query.trim());
  if (!q) return [];
  const hits = [];
  const places = atlas.places;
  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    const name = fold(place[0]);
    const ascii = place[1] ? fold(place[1]) : name;
    let score = 0;
    if (name === q || ascii === q) score = 300;
    else if (name.startsWith(q) || ascii.startsWith(q)) score = 200;
    else if (name.includes(q) || ascii.includes(q)) score = 100;
    else continue;
    score += Math.log10((place[5] || 1) + 10);
    hits.push({ score, place });
  }
  hits.sort((a, b) => b.score - a.score || b.place[5] - a.place[5]);
  return hits.slice(0, limit).map(({ place }) => ({
    name: place[0],
    country: place[2],
    lat: place[3],
    lon: place[4],
    pop: place[5],
  }));
}
