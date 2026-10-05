// Bake the geography into two files.
// src/atlas.js loads with the map: countries, lakes and rivers at 1:50m,
// cities and country labels. src/detail.js is fetched in the background and
// takes over once you zoom in: countries, lakes and rivers at 1:10m, and
// built-up areas.
// Natural Earth is public domain (naturalearthdata.com). Smaller cities and
// towns come from Wikidata (CC0), see fetch-cities.mjs. Built-up areas come
// from NASA MODIS land cover (CC0), see fetch-urban.py.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countryAtPoint, decodeRing, preparePolygons } from "../src/geom.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = join(root, "raw");

function load(name) {
  return JSON.parse(readFileSync(join(raw, name), "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const [head, ...body] = rows;
  return body.map((cells) => Object.fromEntries(head.map((key, i) => [key, cells[i] ?? ""])));
}

function foldName(name) {
  return name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function km(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(lat2 - lat1, dLon) * 111.2;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function dist2(p, a, b) {
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const px = p[0] * cos;
  const py = p[1];
  const ax = a[0] * cos;
  const ay = a[1];
  const bx = b[0] * cos;
  const by = b[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

function simplify(points, tolerance) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const limit = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = dist2(points[i], points[a], points[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > limit) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([round3(points[i][0]), round3(points[i][1])]);
  }
  const deduped = [];
  for (const p of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    deduped.push(p);
  }
  return deduped;
}

function openRing(ring) {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

function cleanRing(ring, tolerance, minPoints) {
  const opened = openRing(ring);
  if (opened.length < minPoints) return null;
  const simplified = simplify(opened, tolerance);
  if (simplified.length < minPoints) return null;
  return simplified;
}

function eachPolygon(geometry, fn) {
  if (!geometry) return;
  if (geometry.type === "Polygon") fn(geometry.coordinates);
  else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) fn(polygon);
  }
}

function eachLine(geometry, fn) {
  if (!geometry) return;
  if (geometry.type === "LineString") fn(geometry.coordinates);
  else if (geometry.type === "MultiLineString") {
    for (const line of geometry.coordinates) fn(line);
  }
}

function packPolygons(features, nameOf, tolerance) {
  const out = [];
  let points = 0;
  for (const feature of features) {
    const parts = [];
    eachPolygon(feature.geometry, (polygon) => {
      if (!polygon.length) return;
      const outer = cleanRing(polygon[0], tolerance, 3);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < polygon.length; i++) {
        const hole = cleanRing(polygon[i], tolerance, 3);
        if (hole) holes.push(hole);
      }
      points += outer.length;
      for (const hole of holes) points += hole.length;
      parts.push({ outer, holes });
    });
    if (!parts.length) continue;
    const name = nameOf(feature) || "";
    out.push({ n: name, parts });
  }
  return { out, points };
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

function ringKm2(ring) {
  const lat = ring.reduce((total, p) => total + p[1], 0) / ring.length;
  return Math.abs(signedArea(ring)) * 111.2 * 111.2 * Math.cos((lat * Math.PI) / 180);
}

// Counter-clockwise outer rings and clockwise holes, so the map can fill
// the whole layer in one pass without nearby towns cancelling each other.
function wind(ring, counterClockwise) {
  return signedArea(ring) > 0 === counterClockwise ? ring : ring.slice().reverse();
}

// Built-up areas are many small polygons. The tolerance follows the size of
// each one, so a town keeps its shape while a big city is simplified harder.
// Everything goes into one feature.
function packUrban(features, { minKm2, holeKm2, tolerance, detail }) {
  const parts = [];
  let points = 0;
  let dropped = 0;
  for (const feature of features) {
    eachPolygon(feature.geometry, (polygon) => {
      if (!polygon.length) return;
      const area = ringKm2(polygon[0]);
      if (area < minKm2) {
        dropped += 1;
        return;
      }
      const tol = Math.min(tolerance, (detail * Math.sqrt(area)) / 111.2);
      const outer = cleanRing(polygon[0], tol, 3);
      if (!outer) {
        dropped += 1;
        return;
      }
      const holes = [];
      for (let i = 1; i < polygon.length; i++) {
        if (ringKm2(polygon[i]) < holeKm2) continue;
        const hole = cleanRing(polygon[i], tol, 3);
        if (hole) holes.push(wind(hole, false));
      }
      points += outer.length;
      for (const hole of holes) points += hole.length;
      parts.push({ outer: wind(outer, true), holes });
    });
  }
  return { out: parts.length ? [{ n: "", parts }] : [], points, polygons: parts.length, dropped };
}

// Rings and lines in detail.js are flat integer arrays in thousandths of a
// degree: the first point, then the step to each next point. That is about
// a third of the size of nested [lon, lat] pairs. geom.js decodeRing reads it.
function encode(ring) {
  const out = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of ring) {
    const ix = Math.round(x * 1000);
    const iy = Math.round(y * 1000);
    out.push(ix - px, iy - py);
    px = ix;
    py = iy;
  }
  return out;
}

function encodePolygons(list) {
  return list.map((f) => ({ n: f.n, parts: f.parts.map((p) => ({ outer: encode(p.outer), holes: p.holes.map(encode) })) }));
}

function decodePolygons(list) {
  return list.map((f) => ({ n: f.n, parts: f.parts.map((p) => ({ outer: decodeRing(p.outer), holes: p.holes.map(decodeRing) })) }));
}

function encodeLines(list) {
  return list.map((river) => ({ ...river, lines: river.lines.map(encode) }));
}

function packLines(features, tolerance) {
  const out = [];
  let points = 0;
  for (const feature of features) {
    const lines = [];
    eachLine(feature.geometry, (line) => {
      const cleaned = cleanRing(line, tolerance, 2);
      if (!cleaned) return;
      lines.push(cleaned);
      points += cleaned.length;
    });
    if (!lines.length) continue;
    out.push({
      n: feature.properties.name || "",
      rank: feature.properties.scalerank || 6,
      // The zoom level (web map style) from which Natural Earth shows it.
      z: feature.properties.min_zoom ?? 0,
      lines,
    });
  }
  return { out, points };
}

const countries = load("countries.geojson");
const lakes = load("lakes.geojson");
const rivers = load("rivers.geojson");
const places = load("places10.geojson");

const fine = packPolygons(countries.features, (f) => f.properties.NAME, 0.012);
const coarse = packPolygons(countries.features, (f) => f.properties.NAME, 0.2);
const lakePack = packPolygons(lakes.features, (f) => f.properties.name || "", 0.02);
const riverPack = packLines(rivers.features, 0.015);

// 1:10m, with the extra lakes and rivers Natural Earth has for Europe and
// North America.
const DETAIL = { land: 0.004, lakes: 0.004, rivers: 0.005 };
const land10 = packPolygons(load("ne_10m_admin_0_countries.geojson").features, (f) => f.properties.NAME, DETAIL.land);
const lakes10 = packPolygons(
  ["ne_10m_lakes", "ne_10m_lakes_europe", "ne_10m_lakes_north_america"].flatMap((name) => load(`${name}.geojson`).features),
  (f) => f.properties.name || "",
  DETAIL.lakes,
);
const rivers10 = packLines(
  ["ne_10m_rivers_lake_centerlines", "ne_10m_rivers_europe", "ne_10m_rivers_north_america"].flatMap(
    (name) => load(`${name}.geojson`).features,
  ),
  DETAIL.rivers,
);

// Built-up areas: raw/urban.geojson, made by fetch-urban.py. Without it the
// layer of the current detail.js is kept, so a rebuild never loses it.
// minKm2 and tolerance (degrees) are tuned to keep the layer near 3 MB.
// detail is the share of a polygon's width that its tolerance may reach.
const URBAN = { minKm2: 4.5, holeKm2: 10, tolerance: 0.015, detail: 0.4 };
let urbanPack;
if (existsSync(join(raw, "urban.geojson"))) {
  urbanPack = packUrban(load("urban.geojson").features, URBAN);
} else {
  const previous = existsSync(join(root, "src", "detail.js")) ? (await import("../src/detail.js")).detail : null;
  const kept = previous && previous.urban ? decodePolygons(previous.urban) : [];
  console.warn("raw/urban.geojson not found, keeping the built-up areas already in detail.js");
  urbanPack = { out: kept, points: 0, polygons: kept.reduce((n, f) => n + f.parts.length, 0), dropped: 0 };
}

const labels = [];
for (const feature of countries.features) {
  const lon = feature.properties.LABEL_X;
  const lat = feature.properties.LABEL_Y;
  const name = feature.properties.NAME;
  if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
  if (Math.abs(lat) > 85) continue;
  labels.push([name, round3(lon), round3(lat), feature.properties.LABELRANK || 6]);
}

const seenPlaces = new Set();
const seenQids = new Set();
const placeList = [];
for (const feature of places.features) {
  const props = feature.properties;
  const name = props.NAME;
  if (!name) continue;
  const coords = feature.geometry && feature.geometry.coordinates;
  const lon = coords ? coords[0] : props.LONGITUDE;
  const lat = coords ? coords[1] : props.LATITUDE;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
  const ascii = props.NAMEASCII || name;
  const country = props.ADM0NAME || "";
  const pop = Math.round(props.POP_MAX || 0);
  const key = `${name}|${country}|${round3(lat)}|${round3(lon)}`;
  if (seenPlaces.has(key)) continue;
  seenPlaces.add(key);
  if (props.WIKIDATAID) seenQids.add(props.WIKIDATAID);
  placeList.push([name, ascii === name ? null : ascii, country, round3(lat), round3(lon), pop]);
}

// Wikidata towns, minus anything Natural Earth already has. A town is a
// duplicate when it shares a Wikidata id, has the same name within 10 km,
// or sits within 1.5 km of a place already kept. Areas are left out too:
// names like "… metropolitan area" or "… district", and anything that
// outnumbers a Natural Earth city within 25 km, which is that city's
// metro area or municipality rather than a town of its own.
const AREA = /\b(metropolitan|municipality|urban area|agglomeration|conurbation|province|prefecture|district|county|region)\b/i;
const buckets = new Map();
function bucketKey(lat, lon) {
  return `${Math.floor(lat * 5)}|${Math.floor(lon * 5)}`;
}
function remember(place) {
  const key = bucketKey(place[3], place[4]);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(place);
}
function swallows(pop, lat, lon) {
  const by = Math.floor(lat * 5);
  const bx = Math.floor(lon * 5);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (const other of buckets.get(`${by + dy}|${bx + dx}`) || []) {
        if (other.ne && other[5] < pop && km(lat, lon, other[3], other[4]) < 25) return true;
      }
    }
  }
  return false;
}
function clashes(name, lat, lon) {
  const folded = foldName(name);
  const by = Math.floor(lat * 5);
  const bx = Math.floor(lon * 5);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const other of buckets.get(`${by + dy}|${bx + dx}`) || []) {
        const d = km(lat, lon, other[3], other[4]);
        if (d < 1.5) return true;
        if (d < 10 && foldName(other[0]) === folded) return true;
      }
    }
  }
  return false;
}
for (const place of placeList) {
  place.ne = true;
  remember(place);
}

const borders = preparePolygons(fine.out);
const towns = parseCsv(readFileSync(join(raw, "cities.csv"), "utf8"))
  .map((row) => ({
    qid: row.item.split("/").pop(),
    name: row.label,
    pop: Math.round(Number(row.pop)),
    lat: Number(row.la),
    lon: Number(row.lo),
    country: row.country,
  }))
  .filter((town) => town.name && Number.isFinite(town.lat) && Number.isFinite(town.lon))
  .filter((town) => !/^Q\d+$/.test(town.name))
  .sort((a, b) => b.pop - a.pop);
let townsAdded = 0;
for (const town of towns) {
  if (seenQids.has(town.qid)) continue;
  seenQids.add(town.qid);
  if (AREA.test(town.name)) continue;
  if (clashes(town.name, town.lat, town.lon)) continue;
  if (swallows(town.pop, town.lat, town.lon)) continue;
  const country = countryAtPoint(borders, town.lat, town.lon) || town.country;
  const ascii = town.name.normalize("NFD").replace(/\p{M}/gu, "");
  const place = [town.name, ascii === town.name ? null : ascii, country, round3(town.lat), round3(town.lon), town.pop];
  placeList.push(place);
  remember(place);
  townsAdded += 1;
}
placeList.sort((a, b) => b[5] - a[5]);

const atlas = {
  land: fine.out,
  coarse: coarse.out,
  lakes: lakePack.out,
  rivers: riverPack.out,
  places: placeList,
  labels,
};

const file = `// Generated by scripts/pack.mjs from Natural Earth public-domain geography.
// Countries, lakes, rivers: 1:50m. Cities: 1:10m populated places, plus
// Wikidata (CC0) cities and towns of 10,000 people or more.
// Do not edit by hand.
export const atlas = ${JSON.stringify(atlas)};
`;
writeFileSync(join(root, "src", "atlas.js"), file);

const detail = {
  land: encodePolygons(land10.out),
  lakes: encodePolygons(lakes10.out),
  rivers: encodeLines(rivers10.out),
  urban: encodePolygons(urbanPack.out),
};
const detailFile = `// Generated by scripts/pack.mjs. Countries, lakes, rivers: Natural Earth
// 1:10m, public domain. Built-up areas: NASA MODIS land cover MCD12Q1 v6.1,
// class 13 (CC0). Do not edit by hand.
export const detail = ${JSON.stringify(detail)};
`;
writeFileSync(join(root, "src", "detail.js"), detailFile);

const vistula = riverPack.out.filter((r) => r.n === "Vistula").map((r) => r.rank);
console.log(
  JSON.stringify(
    {
      bytes: Buffer.byteLength(file),
      detailBytes: Buffer.byteLength(detailFile),
      land10Points: land10.points,
      lakes10: lakes10.out.length,
      lakes10Points: lakes10.points,
      rivers10: rivers10.out.length,
      rivers10Points: rivers10.points,
      countries: fine.out.length,
      landPoints: fine.points,
      coarsePoints: coarse.points,
      lakes: lakePack.out.length,
      lakePoints: lakePack.points,
      urbanPolygons: urbanPack.polygons,
      urbanPoints: urbanPack.points,
      urbanDropped: urbanPack.dropped,
      rivers: riverPack.out.length,
      riverPoints: riverPack.points,
      places: placeList.length,
      townsAdded,
      labels: labels.length,
      vistulaRanks: vistula,
    },
    null,
    2,
  ),
);
