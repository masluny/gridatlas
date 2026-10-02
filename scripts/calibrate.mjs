// Pick a worldwide window size such that Warsaw's bounding box
// falls in exactly four windows (2 by 2), and those windows are
// close to square on the ground.

const WARSAW = {
  south: 52.0978497,
  north: 52.3681531,
  west: 20.8516882,
  east: 21.2711512,
};

const spanLat = WARSAW.north - WARSAW.south;
const spanLon = WARSAW.east - WARSAW.west;
const midLat = (WARSAW.south + WARSAW.north) / 2;
const midLon = (WARSAW.west + WARSAW.east) / 2;

function hits(origin, step, start, end) {
  const a = (start - origin) / step;
  const b = (end - origin) / step;
  const k0 = Math.floor(a + 1e-9);
  const k1 = Math.floor(b - 1e-9);
  const line = origin + (k0 + 1) * step;
  return {
    count: k1 - k0 + 1,
    k0,
    k1,
    // 0 means the shared grid line sits on the middle of the city
    center: Math.abs(line - (start + end) / 2) / step,
    ratio: (end - start) / step,
  };
}

const latKmPerDeg = 110.574;
const lonScale = 111.32 * Math.cos((midLat * Math.PI) / 180);

const rows = [];
for (let n = 700; n <= 2200; n++) {
  const d = 180 / n;
  const h = hits(-90, d, WARSAW.south, WARSAW.north);
  if (h.count !== 2) continue;
  if (h.ratio < 1.55 || h.ratio > 1.92) continue;
  rows.push({ n, d, km: d * latKmPerDeg, ...h });
}

const cols = [];
for (let n = 900; n <= 3200; n++) {
  const d = 360 / n;
  const h = hits(-180, d, WARSAW.west, WARSAW.east);
  if (h.count !== 2) continue;
  if (h.ratio < 1.55 || h.ratio > 1.92) continue;
  cols.push({ n, d, km: d * lonScale, ...h });
}

const pairs = [];
for (const r of rows) {
  for (const c of cols) {
    const squareness = Math.abs(r.km - c.km) / Math.max(r.km, c.km);
    if (squareness > 0.12) continue;
    const ratioPenalty =
      Math.abs(r.ratio - 1.78) + Math.abs(c.ratio - 1.78);
    const centerPenalty = r.center + c.center;
    const score = squareness * 3 + ratioPenalty + centerPenalty * 0.35;
    pairs.push({ score, squareness, r, c });
  }
}

pairs.sort((a, b) => a.score - b.score);
console.log("lat candidates", rows.length, "lon candidates", cols.length, "pairs", pairs.length);
console.log("span km", (spanLat * latKmPerDeg).toFixed(2), (spanLon * lonScale).toFixed(2));
for (const p of pairs.slice(0, 12)) {
  console.log(
    [
      `score ${p.score.toFixed(3)}`,
      `rows ${p.r.n} dLat ${p.r.d.toFixed(5)} ${p.r.km.toFixed(2)}km ratio ${p.r.ratio.toFixed(3)} center ${p.r.center.toFixed(3)}`,
      `cols ${p.c.n} dLon ${p.c.d.toFixed(5)} ${p.c.km.toFixed(2)}km ratio ${p.c.ratio.toFixed(3)} center ${p.c.center.toFixed(3)}`,
    ].join("\n  "),
  );
}
