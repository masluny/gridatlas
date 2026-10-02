// Worldwide window grid.
//
// The earth is tiled by 1,220 rows and 1,504 columns. Every window is the
// same size in degrees: 180/1220° north–south and 360/1504° east–west.
// At Warsaw that is about 16.3 km by 16.3 km.
//
// Those two divisors are the pair for which Warsaw's bounding box
// (52.0978497°–52.3681531° N, 20.8516882°–21.2711512° E) falls in exactly
// four windows, and the cross of those four sits on the middle of the city.
// The same window size is used everywhere else.
//
// Windows are half-open: a window owns its south and west edges.
// Row 1 is the southernmost band. Column A is the band that starts at 180° W.
// Numbers increase northward, letters increase eastward.

export const GRID = Object.freeze({
  rows: 1220,
  cols: 1504,
});

const LAT_SPAN = 180;
const LON_SPAN = 360;

export function wrapLon(lon) {
  const x = (((lon + 180) % 360) + 360) % 360 - 180;
  return x === 180 ? -180 : x;
}

export function columnLabel(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Column must be a positive integer, got ${n}`);
  }
  let value = n;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function columnNumber(label) {
  const text = String(label).toUpperCase();
  if (!/^[A-Z]+$/.test(text)) throw new Error(`Bad column: ${label}`);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    n = n * 26 + (text.charCodeAt(i) - 64);
  }
  return n;
}

export function rowIndex(lat) {
  if (lat >= 90) return GRID.rows - 1;
  if (lat <= -90) return 0;
  let row = Math.floor(((lat + 90) * GRID.rows) / LAT_SPAN);
  if (row >= GRID.rows) row = GRID.rows - 1;
  if (row < 0) row = 0;
  return row;
}

export function colIndex(lon) {
  const x = wrapLon(lon);
  let col = Math.floor(((x + 180) * GRID.cols) / LON_SPAN);
  if (col >= GRID.cols) col = GRID.cols - 1;
  if (col < 0) col = 0;
  return col;
}

function sizeKm(lat) {
  const latStep = LAT_SPAN / GRID.rows;
  const lonStep = LON_SPAN / GRID.cols;
  const heightKm = latStep * 110.574;
  const widthKm = lonStep * 111.32 * Math.cos((lat * Math.PI) / 180);
  return {
    widthKm: Math.abs(widthKm),
    heightKm,
  };
}

export function windowFromRowCol(row, col) {
  if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) {
    throw new Error(`Window is off the map (${col}, ${row})`);
  }
  const south = -90 + (row * LAT_SPAN) / GRID.rows;
  const north = -90 + ((row + 1) * LAT_SPAN) / GRID.rows;
  const west = -180 + (col * LON_SPAN) / GRID.cols;
  const east = -180 + ((col + 1) * LON_SPAN) / GRID.cols;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  const column = columnLabel(col + 1);
  const rowNumber = row + 1;
  const { widthKm, heightKm } = sizeKm(lat);
  return {
    id: `${column}-${rowNumber}`,
    column,
    row: rowNumber,
    bounds: { west, south, east, north },
    center: { lat, lon },
    widthKm,
    heightKm,
  };
}

export function windowAt(lat, lon) {
  const latC = Math.max(-90, Math.min(90, lat));
  return windowFromRowCol(rowIndex(latC), colIndex(lon));
}

export function windowFromId(id) {
  const match = /^([A-Za-z]+)-([1-9]\d*)$/.exec(String(id).trim());
  if (!match) throw new Error(`Bad window id: ${id}`);
  const col = columnNumber(match[1]) - 1;
  const row = Number(match[2]) - 1;
  if (row < 0 || row >= GRID.rows || col < 0 || col >= GRID.cols) {
    throw new Error(`Window is off the map: ${id}`);
  }
  return windowFromRowCol(row, col);
}

// Bounds are half-open: [west, east) × [south, north).
// Longitudes may be unwrapped (east > 180) when the view crosses the date line.
export function windowsOverlapping({ west, south, east, north }) {
  if (!(east > west) || !(north > south)) return [];

  let lon0 = west;
  let lon1 = east;
  if (lon1 - lon0 >= LON_SPAN) {
    lon0 = -180;
    lon1 = 180;
  }

  const lat0 = Math.max(-90, south);
  const lat1 = Math.min(90, north);
  if (!(lat1 > lat0)) return [];

  const rowA = rowIndex(lat0);
  const rowB = rowIndex(Math.min(lat1 - 1e-9, 89.999999));
  const lonStep = LON_SPAN / GRID.cols;
  const seen = new Set();
  const windows = [];

  let lon = lon0;
  let guard = 0;
  while (lon < lon1 - 1e-9 && guard++ <= GRID.cols + 1) {
    const col = colIndex(lon + 1e-8);
    const wrapped = wrapLon(lon);
    const cellWest = -180 + (col * LON_SPAN) / GRID.cols;
    let into = wrapped - cellWest;
    if (into < 0) into += LON_SPAN;
    const remain = Math.max(lonStep - into, lonStep * 1e-6);
    if (!seen.has(col)) {
      seen.add(col);
      for (let row = rowA; row <= rowB; row++) {
        windows.push(windowFromRowCol(row, col));
      }
    }
    lon += remain;
  }

  return windows;
}
