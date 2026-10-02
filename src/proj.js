const MAX_LAT = 85.05112878;
const MERC_MAX = Math.log(Math.tan(Math.PI / 4 + (MAX_LAT * Math.PI) / 360));

// 0 at the north edge of the Mercator square, 1 at the south edge.
export function projectY(lat) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const merc = Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  return 0.5 - merc / (2 * MERC_MAX);
}

export function unprojectY(y) {
  const clamped = Math.max(1e-6, Math.min(1 - 1e-6, y));
  const merc = (0.5 - clamped) * 2 * MERC_MAX;
  return (180 / Math.PI) * (2 * Math.atan(Math.exp(merc)) - Math.PI / 2);
}
