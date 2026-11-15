// ============================================================================
// the real seafront: unpacks world.bin (built by tools/build_world.py from elevation tiles and OpenStreetMap
// data via Overture Maps) and answers questions about it: ground height, surface type, the shoreline, the prom
// ============================================================================
// Local coordinates: metres, x east, z north, y up; origin at the shore end of Bournemouth Pier.
// Surface classes (mask): 0 town, 1 sand, 2 promenade, 3 road, 4 footway, 5 grass, 6 woodland, 7 heath/scrub,
// 8 bare cliff, 9 gardens, 10 steps, 11 lawn, 12 pond
let WD; // header + sections
let HD, HC, MD, MC; // heights (detail 3 m, coarse 8 m) as Float32Array, masks as Uint8Array
let GD, GC; // grid descriptions {x0, z0, d, nx, nz}
async function loadWorld() {
  const bin = Uint8Array.from(atob(WORLD_B64), (c) => c.charCodeAt(0));
  const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const base = 4 + n + (-n & 3), T = { int16: Int16Array, uint8: Uint8Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array }, S = {};
  for (const k in H.meta) { const [o, l, t] = H.meta[k]; S[k] = new T[t](buf, base + o, l / T[t].BYTES_PER_ELEMENT); }
  // heights were stored as row-wise deltas in steps of hq metres
  const undelta = (a, g) => { const h = new Float32Array(g.nx * g.nz); for (let j = 0; j < g.nz; j++) { let v = 0; for (let i = 0; i < g.nx; i++) { v += a[j * g.nx + i]; h[j * g.nx + i] = v * H.hq; } } return h; };
  GD = H.gd; GC = H.gc; HD = undelta(S.hd, GD); HC = undelta(S.hc, GC); MD = S.md; MC = S.mc;
  WD = { H, S };
  initShore();
}

// ---------------------------------------------------------------- ground height (bilinear, detail grid where it exists)
const hgrid = (h, g, x, z) => {
  let u = (x - g.x0) / g.d, v = (z - g.z0) / g.d;
  u = u < 0 ? 0 : u > g.nx - 1.001 ? g.nx - 1.001 : u; v = v < 0 ? 0 : v > g.nz - 1.001 ? g.nz - 1.001 : v;
  const i = u | 0, j = v | 0, fu = u - i, fv = v - j, o = j * g.nx + i;
  return (h[o] * (1 - fu) + h[o + 1] * fu) * (1 - fv) + (h[o + g.nx] * (1 - fu) + h[o + g.nx + 1] * fu) * fv;
};
const inDetail = (x, z) => x > GD.x0 && z > GD.z0 && x < GD.x0 + (GD.nx - 1) * GD.d && z < GD.z0 + (GD.nz - 1) * GD.d;
const terrainH = (x, z) => inDetail(x, z) ? hgrid(HD, GD, x, z) : hgrid(HC, GC, x, z);
// surface class at a point (nearest pixel)
function maskAt(x, z) {
  // (pixel j of the detail mask covers x0 + (j - 1) * d .. x0 + j * d, see raster() in build_world.py)
  if (inDetail(x, z)) { const s = WD.H.mdscale, d = GD.d / s, j = clamp(floor((x - GD.x0) / d + 1), 0, GD.nx * s - 1), i = clamp(floor((z - GD.z0) / d + 1), 0, GD.nz * s - 1); return MD[i * GD.nx * s + j]; }
  const j = clamp(round((x - GC.x0) / GC.d), 0, GC.nx - 1), i = clamp(round((z - GC.z0) / GC.d), 0, GC.nz - 1);
  return MC[i * GC.nx + j];
}

// ---------------------------------------------------------------- the shoreline and the promenade as paths
// polyline helpers: cumulative length, point and direction at a distance, nearest distance along it
function polyline(flat) {
  const n = flat.length / 2, P = Float64Array.from(flat), L = new Float64Array(n);
  for (let i = 1; i < n; i++) L[i] = L[i - 1] + hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
  return { P, L, n, len: L[n - 1] };
}
const _pl = [0, 0, 0, 0];
// point at arc length s -> _pl = [x, z, dx, dz] (unit direction)
function plAt(pl, s) {
  const { P, L, n } = pl; s = clamp(s, 0, pl.len);
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] <= s) lo = m; else hi = m; }
  const t = (s - L[lo]) / ((L[hi] - L[lo]) || 1), dx = P[hi * 2] - P[lo * 2], dz = P[hi * 2 + 1] - P[lo * 2 + 1], dl = hypot(dx, dz) || 1;
  _pl[0] = P[lo * 2] + dx * t; _pl[1] = P[lo * 2 + 1] + dz * t; _pl[2] = dx / dl; _pl[3] = dz / dl;
  return _pl;
}
// arc length of the point on the line nearest to (x, z); also the signed side distance in _pl[0]
function plProject(pl, x, z) {
  const { P, L, n } = pl; let best = 1e18, bs = 0, side = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = P[i * 2], az = P[i * 2 + 1], dx = P[i * 2 + 2] - ax, dz = P[i * 2 + 3] - az, l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x, pz = az + dz * t - z, d = px * px + pz * pz;
    if (d < best) { best = d; bs = L[i] + t * sqrt(l2); side = (dx * (z - az) - dz * (x - ax)) / sqrt(l2); }
  }
  _pl[0] = side; return bs;
}
let COAST, PROMW, PROMC, S_B, S_S; // the shoreline (west to east), promenade centre line + width per point
function initShore() {
  const H = WD.H;
  COAST = polyline(H.coast);
  S_B = H.sB; S_S = H.sS;
  // the promenade: points [x, z, width] every ~4 m; gaps (pier approaches) are bridged by the polyline
  const c = [], w = [];
  for (let i = 0; i < H.prom.length; i += 3) { c.push(H.prom[i], H.prom[i + 1]); w.push(H.prom[i + 2]); }
  PROMC = polyline(c); PROMW = Float32Array.from(w);
}
// inland unit normal of the shoreline at arc length s (land is to the left walking east)
const coastN = (s) => { const p = plAt(COAST, s); return [-p[3], p[2]]; };
// lat/lon <-> local, for the far coasts
const LL = (lat, lon) => [(lon - -1.87563) * 111320 * cos(50.71585 * PI / 180), (lat - 50.71585) * 110574];
