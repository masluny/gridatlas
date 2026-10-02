import { countryAt, nearestPlace } from "../src/locate.js";
import { atlas } from "../src/atlas.js";
import {
  GRID,
  columnLabel,
  columnNumber,
  windowAt,
  windowFromId,
  windowsOverlapping,
} from "../src/grid.js";

const WARSAW = {
  south: 52.0978497,
  north: 52.3681531,
  west: 20.8516882,
  east: 21.2711512,
};

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", message);
  }
}

assert(columnLabel(1) === "A", "A");
assert(columnLabel(26) === "Z", "Z");
assert(columnLabel(27) === "AA", "AA");
assert(columnLabel(52) === "AZ", "AZ");
assert(columnLabel(702) === "ZZ", "ZZ");
assert(columnLabel(703) === "AAA", "AAA");
for (let n = 1; n <= GRID.cols; n++) {
  if (columnNumber(columnLabel(n)) !== n) {
    assert(false, `column roundtrip ${n}`);
    break;
  }
}

const origin = windowAt(0, 0);
assert(origin.bounds.south === 0, `equator is a grid line (${origin.bounds.south})`);
assert(origin.bounds.west === 0, `prime meridian is a grid line (${origin.bounds.west})`);
assert(origin.bounds.south <= 0 && 0 < origin.bounds.north, "0 lat inside window");
assert(origin.bounds.west <= 0 && 0 < origin.bounds.east, "0 lon inside window");

for (let i = 0; i < 400; i++) {
  const lat = -89 + (i * 178) / 399;
  const lon = -179 + ((i * 97) % 358);
  const win = windowAt(lat, lon);
  const back = windowFromId(win.id);
  assert(back.id === win.id, `id roundtrip ${win.id}`);
  assert(win.bounds.south <= lat && lat < win.bounds.north, `lat inside ${win.id}`);
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const lonIn = wrapped === 180 ? -180 : wrapped;
  assert(win.bounds.west <= lonIn && lonIn < win.bounds.east, `lon inside ${win.id} ${lonIn}`);
  if (failed) break;
}

const covered = windowsOverlapping(WARSAW);
const ids = new Set(covered.map((w) => w.id));
assert(covered.length === 4, `Warsaw windows: ${covered.map((w) => w.id).join(", ")}`);
assert(new Set(covered.map((w) => w.row)).size === 2, "two rows");
assert(new Set(covered.map((w) => w.column)).size === 2, "two columns");

const spanLat = WARSAW.north - WARSAW.south;
const spanLon = WARSAW.east - WARSAW.west;
for (const win of covered) {
  const latShare =
    (Math.min(win.bounds.north, WARSAW.north) - Math.max(win.bounds.south, WARSAW.south)) / spanLat;
  const lonShare =
    (Math.min(win.bounds.east, WARSAW.east) - Math.max(win.bounds.west, WARSAW.west)) / spanLon;
  assert(latShare > 0.2 && lonShare > 0.2, `${win.id} share lat ${latShare} lon ${lonShare}`);
}

for (let i = 0; i < 36; i++) {
  for (let j = 0; j < 36; j++) {
    const lat = WARSAW.south + (spanLat * (i + 0.5)) / 36;
    const lon = WARSAW.west + (spanLon * (j + 0.5)) / 36;
    const id = windowAt(lat, lon).id;
    if (!ids.has(id)) {
      assert(false, `point ${lat.toFixed(4)},${lon.toFixed(4)} leaked into ${id}`);
      i = 36;
      break;
    }
  }
}

const krakow = windowAt(50.0647, 19.945);
assert(!ids.has(krakow.id), "Krakow is outside Warsaw's four windows");

assert(countryAt(52.23, 21.01) === "Poland", `Warsaw country ${countryAt(52.23, 21.01)}`);
assert(countryAt(48.8566, 2.3522) === "France", `Paris country ${countryAt(48.8566, 2.3522)}`);
assert(countryAt(35.68, 139.69) === "Japan", `Tokyo country ${countryAt(35.68, 139.69)}`);
assert(countryAt(0, -30) === null, "mid Atlantic is not a country");

const near = nearestPlace(52.23, 21.01);
assert(near && near.name === "Warsaw", `nearest ${near && near.name}`);
assert(atlas.rivers.some((river) => river.n === "Vistula"), "Vistula is on the map");

const sample = covered
  .map((w) => `${w.id} ${w.widthKm.toFixed(1)}×${w.heightKm.toFixed(1)} km`)
  .join("\n  ");
console.log(`Warsaw's four windows:\n  ${sample}`);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
