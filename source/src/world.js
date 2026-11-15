// ============================================================================
// the seafront as meshes: terrain, buildings, beach huts, piers, groynes, furniture, vegetation, life
// ============================================================================
// Everything is built from the real data (data.js) in local metres. Static geometry is grouped into chunks of
// CH x CH metres so the renderer can skip what is out of view.
const CH = 160;
const chunkKey = (x, z) => ((floor(x / CH) + 512) << 10) | (floor(z / CH) + 512);
const CHUNKS = new Map(); // key -> Mesh
const chunk = (x, z) => { const k = chunkKey(x, z); let m = CHUNKS.get(k); if (!m) CHUNKS.set(k, (m = new Mesh())); return m; };
const C = (r, g, b) => col(r, g, b, 0); // plain colour helper (material set via m)
const K = (h, layer) => hex(h, layer); // tint + material layer

// ---------------------------------------------------------------- collision
// Walls are segments (ax, az, bx, bz, bottom, top) in a hash of 8 m cells; platforms (pier decks, groyne tops) are
// polygons with a height.
const SEG = [], PLAT = [];
const wall = (ax, az, bx, bz, bot, top) => SEG.push(ax, az, bx, bz, bot, top);
const ringWalls = (r, bot, top, skip) => { for (let i = 0; i < r.length; i++) if (!skip || !skip(i)) { const a = r[i], b = r[(i + 1) % r.length]; wall(a[0], a[1], b[0], b[1], bot, top); } };
let SEGH, SEGF; // cell -> Int32Array of segment offsets
function buildCollision() {
  SEGF = new Float32Array(SEG); const map = new Map();
  for (let i = 0; i < SEGF.length; i += 6) {
    const x0 = floor(min(SEGF[i], SEGF[i + 2]) / 8), x1 = floor(max(SEGF[i], SEGF[i + 2]) / 8), z0 = floor(min(SEGF[i + 1], SEGF[i + 3]) / 8), z1 = floor(max(SEGF[i + 1], SEGF[i + 3]) / 8);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = (x + 4096) * 8192 + z + 4096; let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(i); }
  }
  SEGH = new Map(); for (const [k, l] of map) SEGH.set(k, Int32Array.from(l));
}

// ---------------------------------------------------------------- terrain meshes (chunked index ranges)
// detail grid: vertices on its 3 m lattice; coarse grid: 8 m, with a hole where the detail grid lies. The detail
// grid's border takes the coarse heights so the two meet without cracks.
function terrainMesh(h, g, tile, hole, border) {
  const { nx, nz, x0, z0, d } = g, n = nx * nz, b = new ArrayBuffer(n * 16), F = new Float32Array(b), U = new Uint32Array(b);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = x0 + i * d, z = z0 + j * d;
    let y = h[k]; if (border && (i === 0 || j === 0 || i === nx - 1 || j === nz - 1)) y = hgrid(HC, GC, x, z);
    const hl = h[j * nx + max(i - 1, 0)], hr = h[j * nx + min(i + 1, nx - 1)], hd = h[max(j - 1, 0) * nx + i], hu = h[min(j + 1, nz - 1) * nx + i];
    F[k * 4] = x; F[k * 4 + 1] = y; F[k * 4 + 2] = z; U[k * 4 + 3] = packN((hl - hr) / (2 * d), 1, (hd - hu) / (2 * d));
  }
  const idx = [], tiles = [];
  for (let tj = 0; tj < nz - 1; tj += tile) for (let ti = 0; ti < nx - 1; ti += tile) {
    const start = idx.length; let y0 = 1e9, y1 = -1e9;
    for (let j = tj; j < min(tj + tile, nz - 1); j++) for (let i = ti; i < min(ti + tile, nx - 1); i++) {
      if (hole && hole(x0 + (i + 0.5) * d, z0 + (j + 0.5) * d)) continue;
      const a = j * nx + i, c = a + nx;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
      y0 = min(y0, h[a], h[c + 1]); y1 = max(y1, h[a], h[c + 1]);
    }
    if (idx.length > start) tiles.push({ first: start, count: idx.length - start, box: [x0 + ti * d, y0 - 1, z0 + tj * d, x0 + min(ti + tile, nx - 1) * d, y1 + 1, z0 + min(tj + tile, nz - 1) * d] });
  }
  return { vb: b, ib: new Uint32Array(idx), tiles };
}

// ---------------------------------------------------------------- buildings
const BRICKS = [0xb26a52, 0xa45a44, 0xc08560, 0x9c6b54, 0xd2b48c], RENDERS = [0xf4f1ea, 0xece4d2, 0xf7f3e8, 0xe6dccb, 0xdfe6e8, 0xf0e0c8];
const ROOFT = [0xa0604a, 0x8c5040, 0x7a4a3c], ROOFS = [0x6a7078, 0x5a6068, 0x80868c];
function building(ring, h, roofCode, cls, facadeC, roofC, floors, seed, base) {
  rseed(seed);
  let gmin = 1e9, gmax = -1e9; for (const [x, z] of ring) { const t = terrainH(x, z); gmin = min(gmin, t); gmax = max(gmax, t); }
  if (base != null) gmin = gmax = base;
  const area = abs(ringArea(ring)); if (area < 3) return;
  const cn = WD.H.classes[cls] || '';
  const small = ['garages', 'garage', 'shed', 'outbuilding', 'roof', 'hut'].includes(cn);
  const y0 = gmin - 0.5, y1 = gmin + h + (gmax - gmin) * 0.6;
  let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x / ring.length; cz += z / ring.length; }
  const m = chunk(cx, cz);
  // walls
  const brick = facadeC ? false : ['detached', 'semidetached_house', 'house', 'terrace', 'church', 'school', 'garages', 'garage'].includes(cn) ? rnd() < 0.55 : rnd() < 0.22;
  const fcol = facadeC ? facadeC & 0xffffff : brick ? 0xffffff : pick(RENDERS);
  const wl = brick ? L.BRICK : L.RENDER, wc = brick ? hex(pick([0xffffff, 0xeeddcc, 0xffe8d0]), wl) : hex(fcol, wl);
  const fl = floors || max(1, round((h - 0.5) / 3));
  const e = ext(small ? 0 : 1, 0.5, min(fl, 255), rnd());
  m.vy = gmin; let per = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], l = hypot(b[0] - a[0], b[1] - a[1]);
    m.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], wc, e, [per, y0 - gmin, per + l, y0 - gmin, per + l, y1 - gmin, per, y1 - gmin]);
    per += l;
  }
  // roof: pitched over near-rectangular footprints, flat otherwise
  const o = obb(ring);
  const rect = o && area / (4 * o.hu * o.hv) > 0.82;
  let rc = roofCode;
  if (rc === 255) rc = h > 13 || !rect || cn === 'apartments' && rnd() < 0.6 ? 0 : rnd() < 0.7 ? 1 : 2;
  if (rc && !rect) rc = 0;
  const tiles = rnd() < 0.55, rl = tiles ? L.TILES : L.SLATE, rcol = roofC ? hex(roofC & 0xffffff, rl) : hex(tiles ? pick(ROOFT) : pick(ROOFS), rl);
  if (!rc || rc === 3) {
    m.poly(ring, y1, hex(0x8a8884, L.CONCRETE));
    if (!small && h > 6) for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; m.beam([a[0], y1 + 0.35, a[1]], [b[0], y1 + 0.35, b[1]], 0.18, wc); }
  } else {
    const { cx: ox, cz: oz, ux, uz, hu, hv } = o, ov = 0.35, U = hu + ov, Vv = hv + ov, pitch = tan40 * (hv + ov);
    const P = (u, v, y) => [ox + ux * u - uz * v, y, oz + uz * u + ux * v];
    m.poly(ring, y1 - 0.02, wc); // ceiling
    if (rc === 1) { // hipped
      const ri = max(U - Vv, 0);
      m.quad(P(-U, -Vv, y1), P(U, -Vv, y1), P(ri, 0, y1 + pitch), P(-ri, 0, y1 + pitch), rcol);
      m.quad(P(U, Vv, y1), P(-U, Vv, y1), P(-ri, 0, y1 + pitch), P(ri, 0, y1 + pitch), rcol);
      m.tri(P(-U, Vv, y1), P(-U, -Vv, y1), P(-ri, 0, y1 + pitch), rcol); m.tri(P(U, -Vv, y1), P(U, Vv, y1), P(ri, 0, y1 + pitch), rcol);
    } else { // gabled, ridge along the long side
      m.quad(P(-U, -Vv, y1), P(U, -Vv, y1), P(U, 0, y1 + pitch), P(-U, 0, y1 + pitch), rcol);
      m.quad(P(U, Vv, y1), P(-U, Vv, y1), P(-U, 0, y1 + pitch), P(U, 0, y1 + pitch), rcol);
      m.tri(P(-hu, hv, y1), P(-hu, -hv, y1), P(-hu, 0, y1 + pitch * hv / Vv), wc); m.tri(P(hu, -hv, y1), P(hu, hv, y1), P(hu, 0, y1 + pitch * hv / Vv), wc);
    }
  }
  if (abs(cx - 1100) < 2600 && abs(cz - 200) < 900) ringWalls(ring, y0 - 5, y1 + 2);
}
const tan40 = Math.tan(40 * PI / 180) * 0.75;

// ---------------------------------------------------------------- beach huts from their real footprints
const DOORS = [0x3f8fc9, 0xf2c94c, 0x6fbf73, 0xe0614a, 0xf29bb8, 0x8ad3d6, 0x2f5f9e, 0xf08a3c, 0xffffff, 0x9b7fd1, 0xc9e265, 0x1f8a70, 0xd94f70, 0x77c3ec];
function hut(ring, h, seed) {
  rseed(seed);
  const o = obb(ring); if (!o) return;
  let { cx, cz, ux, uz, hu, hv } = o;
  // the front faces the sea: the long side nearest the shoreline
  plProject(COAST, cx, cz); const side = _pl[0];
  const cs = plProject(COAST, cx, cz), nn = coastN(cs);
  // across = direction from the front to the back (inland)
  let ax = -uz, az = ux; if (ax * nn[0] + az * nn[1] < 0) { ax = -ax; az = -az; }
  let along = hu * 2, depth = hv * 2;
  if (hv > hu * 1.4) { [hu, hv] = [hv, hu]; along = hu * 2; depth = hv * 2; [ux, uz] = [ax, az]; ax = -uz; az = ux; if (ax * nn[0] + az * nn[1] < 0) { ax = -ax; az = -az; } }
  const n = max(1, round(along / 2.55)), w = along / n;
  const m = chunk(cx, cz), gy = terrainH(cx, cz) - 0.15;
  const wallC = rnd() < 0.7 ? hex(pick([0xf6f4ee, 0xefe9da, 0xf2f2ef]), L.BOARDS) : null;
  for (let k = 0; k < n; k++) {
    const u0 = -hu + k * w + 0.04, u1 = u0 + w - 0.08, ub = (u0 + u1) / 2;
    const P = (u, v, y) => [cx + ux * u + ax * v, y, cz + uz * u + az * v];
    const door = pick(DOORS), dc = hex(door, L.BOARDS), wc = wallC || dc, y0 = gy, y1 = gy + max(h - 0.6, 1.9), d = depth / 2;
    // walls (front, back, sides)
    m.quad(P(u0, -d, y0), P(u1, -d, y0), P(u1, -d, y1), P(u0, -d, y1), wc); m.quad(P(u1, d, y0), P(u0, d, y0), P(u0, d, y1), P(u1, d, y1), wc);
    m.quad(P(u0, d, y0), P(u0, -d, y0), P(u0, -d, y1), P(u0, d, y1), wc); m.quad(P(u1, -d, y0), P(u1, d, y0), P(u1, d, y1), P(u1, -d, y1), wc);
    // double doors on the front, a white frame
    const dw = (u1 - u0) * 0.36;
    m.quad(P(ub - dw, -d - 0.03, y0 + 0.08), P(ub + dw, -d - 0.03, y0 + 0.08), P(ub + dw, -d - 0.03, y1 - 0.25), P(ub - dw, -d - 0.03, y1 - 0.25), dc);
    m.box(P(ub - 0.02, 0, 0)[0] - 0.01, y0 + 0.08, P(ub, -d - 0.05, 0)[2] - 0.01, P(ub + 0.02, 0, 0)[0] + 0.01, y1 - 0.25, P(ub, -d - 0.03, 0)[2] + 0.01, hex(0xe8e8e4, L.BOARDS));
    // gable roof, ridge running from front to back
    const rp = 0.55, ov = 0.12, R = hex(pick([0x4a5359, 0x5b6770, 0x3d4a3f, 0x6b4b3a, 0x8a3b2e]), L.SLATE);
    m.quad(P(u0 - ov, -d - ov, y1), P(u0 - ov, d + ov, y1), P(ub, d + ov, y1 + rp), P(ub, -d - ov, y1 + rp), R);
    m.quad(P(u1 + ov, d + ov, y1), P(u1 + ov, -d - ov, y1), P(ub, -d - ov, y1 + rp), P(ub, d + ov, y1 + rp), R);
    m.tri(P(u0, -d, y1), P(u1, -d, y1), P(ub, -d, y1 + rp - 0.03), wc); m.tri(P(u1, d, y1), P(u0, d, y1), P(ub, d, y1 + rp - 0.03), wc);
  }
  ringWalls(ring, gy - 1, gy + h);
}

// OpenStreetMap has only part of the huts along Undercliff Drive: rows are added along the inland edge of the
// prom between the piers wherever there is level ground and nothing mapped, with a gap every few dozen huts
const nearFoot = (x, z, r) => {
  for (let i = floor((x - r) / 32); i <= floor((x + r) / 32); i++) for (let j = floor((z - r) / 32); j <= floor((z + r) / 32); j++) {
    const l = BIDX.get(i * 100000 + j); if (!l) continue;
    for (const g of l) { if (pip(g, x, z)) return true; for (let k = 0; k < g.length; k++) { const a = g[k], b = g[(k + 1) % g.length], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1); if (hypot(a[0] + dx * t - x, a[1] + dz * t - z) < r) return true; } }
  }
  return false;
};
function fillHuts() {
  rseed(81); let run = 0, seed = 9000;
  for (let s = 0; s < PROMC.len; s += 2.6) {
    const p = [...plAt(PROMC, s)], k = min(PROMW.length - 1, round(s / PROMC.len * (PROMW.length - 1))), w = min(PROMW[k], 18);
    const cs = plProject(COAST, p[0], p[1]); if (cs < S_B + 60 || cs > S_S - 40) continue;
    const n = coastN(cs), e = w / 2 + 1.5, x = p[0] + n[0] * e, z = p[1] + n[1] * e;
    if (++run % 26 > 23) continue; // a path between rows
    if (nearFoot(x, z, 3.6) || PIERS.some((q) => pip(q.ring, x, z))) { run = 0; continue; }
    const gp = terrainH(p[0] + n[0] * (w / 2 - 1), p[1] + n[1] * (w / 2 - 1)), g = terrainH(x, z);
    if (abs(g - gp) > 0.7 || terrainH(x + n[0] * 2, z + n[1] * 2) - gp > 1.6 || maskAt(x, z) === 3) { run = 0; continue; }
    const tx = p[2], tz = p[3], hw = 1.22, hd = 1.2;
    const r = [[x - tx * hw - n[0] * hd, z - tz * hw - n[1] * hd], [x + tx * hw - n[0] * hd, z + tz * hw - n[1] * hd], [x + tx * hw + n[0] * hd, z + tz * hw + n[1] * hd], [x - tx * hw + n[0] * hd, z - tz * hw + n[1] * hd]];
    if (ringArea(r) < 0) r.reverse();
    addFoot(r); hut(r, 2.6, seed++);
  }
}

// ---------------------------------------------------------------- piers from their real outlines
const PIERS = [];
function pier(p) {
  const r = []; for (let i = 0; i < p.ring.length - 2; i += 2) r.push([p.ring[i], p.ring[i + 1]]);
  if (ringArea(r) < 0) r.reverse();
  // the landward end: the vertex furthest inland
  let rx = 0, rz = 0, best = -1e9;
  for (const [x, z] of r) { plProject(COAST, x, z); if (_pl[0] > best) { best = _pl[0]; rx = x; rz = z; } }
  const deck = max(terrainH(rx, rz), 3.2) + 0.15;
  PIERS.push({ name: p.name, ring: r, deck, root: [rx, rz] });
  let cx = 0, cz = 0; for (const [x, z] of r) { cx += x / r.length; cz += z / r.length; }
  const deckC = hex(0xffffff, L.PLANKS), steel = hex(0x5d666c, L.METAL), white = hex(0xeef2f2, L.METAL);
  // the deck and its edge
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], m = chunk((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    m.quad([a[0], deck, a[1]], [b[0], deck, b[1]], [b[0], deck - 0.7, b[1]], [a[0], deck - 0.7, a[1]], steel);
    // railings where the edge stands over the beach or the sea
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (terrainH(mx, mz) > deck - 1.2) continue;
    const l = hypot(b[0] - a[0], b[1] - a[1]), n = max(1, round(l / 2.4));
    for (let k = 0; k <= n; k++) { const t = k / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t; m.box(x - 0.04, deck, z - 0.04, x + 0.04, deck + 1.15, z + 0.04, white); }
    m.beam([a[0], deck + 1.12, a[1]], [b[0], deck + 1.12, b[1]], 0.05, white); m.beam([a[0], deck + 0.62, a[1]], [b[0], deck + 0.62, b[1]], 0.03, white);
    wall(a[0], a[1], b[0], b[1], deck, deck + 1.15);
    if (l > 20) for (let s = 10; s < l - 5; s += 24) { const t = s / l; lamp(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, deck, 0.2); }
  }
  // deck surface, triangulated per chunk-sized piece (one big polygon is fine for culling at this size)
  const md = chunk(cx, cz); md.poly(r, deck, deckC); md.poly(r, deck - 0.7, steel, E0, true);
  PLAT.push({ ring: r, y: deck });
  // piles every 6 m along and 4 m across, where the deck is over beach or sea
  const o = obb(r);
  for (let u = -o.hu + 2; u < o.hu; u += 6) for (let v = -o.hv + 1; v < o.hv; v += 4) {
    const x = o.cx + o.ux * u - o.uz * v, z = o.cz + o.uz * u + o.ux * v;
    if (!pip(r, x, z)) continue;
    const g = terrainH(x, z); if (g > deck - 1.6) continue;
    const m = chunk(x, z);
    m.cyl(x, g - 2, z, 0.32, 0.26, deck - 0.7 - g + 2, 7, hex(0x55524c, L.CONCRETE), E0, false);
    wall(x - 0.4, z, x + 0.4, z, g - 2, deck - 0.71); wall(x, z - 0.4, x, z + 0.4, g - 2, deck - 0.71);
    if (pip(r, x + o.uz * 4, z - o.ux * 4)) m.beam([x, deck - 1.1, z], [x + o.uz * 4, max(g, -0.5) + 0.8, z - o.ux * 4], 0.07, steel);
  }
}

// ---------------------------------------------------------------- lamps, benches, bins, walls, fences
function lamp(x, z, y, side = 0) {
  const m = chunk(x, z), c = hex(0x2a3d45, L.METAL);
  m.cyl(x, y, z, 0.1, 0.06, 4.6, 7, c, E0, false);
  m.box(x - 0.045, y + 4.5, z - 0.045, x + 0.045, y + 4.62, z + 0.045, c);
  m.box(x - 0.2, y + 4.62, z - 0.2, x + 0.2, y + 5.02, z + 0.2, col(1, 0.93, 0.78, 21));
  m.box(x - 0.25, y + 5.02, z - 0.25, x + 0.25, y + 5.12, z + 0.25, c);
  wall(x - 0.14, z, x + 0.14, z, y, y + 5); wall(x, z - 0.14, x, z + 0.14, y, y + 5);
  LAMPS.push(x, y + 4.8, z);
}
const LAMPS = [];
function bench(x, z, ang) {
  const y = terrainH(x, z), m = chunk(x, z), wd = hex(0xffffff, L.TIMBER), mt = hex(0x30363a, L.METAL), c = cos(ang), s = sin(ang);
  const P = (u, v) => [x + c * u - s * v, z + s * u + c * v];
  m.boxY(x, y + 0.45, z, 0.95, 0.03, 0.22, ang, wd);
  const [bx, bz] = P(0, 0.26); m.boxY(bx, y + 0.75, bz, 0.95, 0.2, 0.03, ang, wd);
  for (const u of [-0.8, 0.8]) { const [lx, lz] = P(u, 0.03); m.boxY(lx, y + 0.35, lz, 0.04, 0.35, 0.25, ang, mt); }
  const [a0, b0] = P(-0.95, 0), [a1, b1] = P(0.95, 0); wall(a0, b0, a1, b1, y, y + 0.95);
}
function fenceLine(pts, kind) {
  for (let i = 0; i < pts.length - 2; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3], l = hypot(bx - ax, bz - az), n = max(1, round(l / 2.2)), m = chunk(ax, az);
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n, y = terrainH(x, z);
      if (kind === 'wall') { if (k < n) { const x2 = ax + (bx - ax) * (k + 1) / n, z2 = az + (bz - az) * (k + 1) / n, y2 = terrainH(x2, z2); m.beam([x, y + 0.4, z], [x2, y2 + 0.4, z2], 0.16, hex(0xd8d0c0, L.CONCRETE)); m.beam([x, y - 0.2, z], [x2, y2 - 0.2, z2], 0.16, hex(0xd8d0c0, L.CONCRETE)); } }
      else m.box(x - 0.04, y, z - 0.04, x + 0.04, y + (kind === 'rail' ? 1.0 : 1.25), z + 0.04, hex(kind === 'rail' ? 0x3a4248 : 0x6a5c4a, kind === 'rail' ? L.METAL : L.TIMBER));
    }
    if (kind !== 'wall') { const ya = terrainH(ax, az), yb = terrainH(bx, bz), H = kind === 'rail' ? 0.98 : 1.15; m.beam([ax, ya + H, az], [bx, yb + H, bz], 0.035, hex(kind === 'rail' ? 0x3a4248 : 0x6a5c4a, kind === 'rail' ? L.METAL : L.TIMBER)); m.beam([ax, ya + H * 0.5, az], [bx, yb + H * 0.5, bz], 0.025, hex(kind === 'rail' ? 0x3a4248 : 0x6a5c4a, kind === 'rail' ? L.METAL : L.TIMBER)); }
    wall(ax, az, bx, bz, terrainH(ax, az) - 1, terrainH(ax, az) + (kind === 'wall' ? 1.1 : 1.2));
  }
}

// ---------------------------------------------------------------- groynes: timber walls across the beach
const GROYNES = [];
function groynes() {
  rseed(11);
  for (let s = S_B - 1800; s < S_S + 1300; s += rr(105, 135)) {
    if (abs(s - S_B) < 70 || abs(s - S_S) < 55) continue;
    const p = plAt(COAST, s), x0 = p[0], z0 = p[1], nx = -p[3], nz = p[2];
    // from where the beach meets the prom down into the sea
    let a = 0; while (a < 90 && terrainH(x0 + nx * a, z0 + nz * a) < 2.2) a += 1;
    let b = 0; while (b < 120 && terrainH(x0 - nx * b, z0 - nz * b) > -1.4) b += 1;
    const m = chunk(x0, z0), wd = hex(0xffffff, L.TIMBER), top = [];
    const P = (o) => [x0 + nx * o, z0 + nz * o];
    for (let o = a - 1; o > -b; o -= 2) {
      const [xa, za] = P(o), [xb, zb] = P(o - 2), ya = terrainH(xa, za) + 0.75, yb = terrainH(xb, zb) + 0.75, w = 0.2;
      const q = (x, z, y, sgn) => [x + p[2] * w * sgn, y, z + p[3] * w * sgn];
      m.quad(q(xa, za, ya, -1), q(xb, zb, yb, -1), q(xb, zb, yb - 1.6, -1), q(xa, za, ya - 1.6, -1), wd);
      m.quad(q(xb, zb, yb, 1), q(xa, za, ya, 1), q(xa, za, ya - 1.6, 1), q(xb, zb, yb - 1.6, 1), wd);
      m.quad(q(xa, za, ya, 1), q(xb, zb, yb, 1), q(xb, zb, yb, -1), q(xa, za, ya, -1), wd);
      if ((o | 0) % 4 === 0) m.boxY(xa, ya - 0.5, za, 0.16, 0.85, 0.16, atan2(p[3], p[2]), hex(0xd8d0c0, L.TIMBER));
      wall(xa, za, xb, zb, ya - 2, ya);
    }
    const [xa, za] = P(a - 1), [xb, zb] = P(-b);
    GROYNES.push(x0, z0, xa, za, xb, zb);
    // the groyne top is a narrow path you can balance on
    const w = 0.22, r = [[xa + p[2] * w, za + p[3] * w], [xa - p[2] * w, za - p[3] * w], [xb - p[2] * w, zb - p[3] * w], [xb + p[2] * w, zb + p[3] * w]];
    PLAT.push({ ring: r, groyne: true });
  }
}

// ---------------------------------------------------------------- the cliff lifts (West Cliff, Fisherman's Walk)
function funicular(l) {
  let [ax, az, bx, bz] = l; let ya = terrainH(ax, az), yb = terrainH(bx, bz);
  if (ya > yb) { [ax, az, bx, bz, ya, yb] = [bx, bz, ax, az, yb, ya]; }
  const m = chunk(ax, az), dx = bx - ax, dz = bz - az, len = hypot(dx, dz), ux = dx / len, uz = dz / len, vx = -uz, vz = ux;
  const conc = hex(0xc8c2b8, L.CONCRETE), rail = hex(0x50565a, L.METAL), car = hex(0xf1e6c8, L.BOARDS), roof = hex(0x2e5e4e, L.METAL);
  const at = (t) => [ax + dx * t, ya + (yb - ya) * t + 0.4, az + dz * t];
  for (let t = 0; t < 1; t += 0.05) {
    const p = at(t), q = at(t + 0.05);
    m.quad([p[0] + vx * 2.6, p[1], p[2] + vz * 2.6], [p[0] - vx * 2.6, p[1], p[2] - vz * 2.6], [q[0] - vx * 2.6, q[1], q[2] - vz * 2.6], [q[0] + vx * 2.6, q[1], q[2] + vz * 2.6], conc);
    for (const s of [-1.9, -1.1, 1.1, 1.9]) m.beam([p[0] + vx * s, p[1] + 0.1, p[2] + vz * s], [q[0] + vx * s, q[1] + 0.1, q[2] + vz * s], 0.05, rail);
    for (const s of [-2.6, 2.6]) { const g = terrainH(p[0] + vx * s, p[2] + vz * s); if (g < p[1] - 0.3) m.box(p[0] + vx * s - 0.2, g - 0.5, p[2] + vz * s - 0.2, p[0] + vx * s + 0.2, p[1], p[2] + vz * s + 0.2, conc); }
  }
  for (const [s, t] of [[-1.5, 0.08], [1.5, 0.9]]) {
    const p = at(t), a = atan2(uz, ux);
    m.boxY(p[0] + vx * s, p[1] + 1.4, p[2] + vz * s, 1.8, 1.2, 0.9, a, car);
    m.boxY(p[0] + vx * s, p[1] + 1.75, p[2] + vz * s, 1.7, 0.45, 0.92, a, col(0.02, 0.02, 0.02, 20));
    m.boxY(p[0] + vx * s, p[1] + 2.68, p[2] + vz * s, 1.95, 0.08, 1.0, a, roof);
  }
}

// ---------------------------------------------------------------- distant coasts: Purbeck, the Isle of Wight, Christchurch Bay
const FAR = new Mesh();
function island(rim, hc, chalk) {
  const P = rim.map(([lat, lon, h]) => { const [x, z] = LL(lat, lon); return [x, z, h]; });
  let cx = 0, cz = 0; for (const p of P) { cx += p[0] / P.length; cz += p[1] / P.length; }
  const face = col(...(chalk ? [0.86, 0.85, 0.8] : [0.55, 0.45, 0.32]), 22), top = col(0.3, 0.36, 0.2, 22), e = ext(0, 1);
  const inset = (p, k) => [p[0] + (cx - p[0]) * k, p[2], p[1] + (cz - p[1]) * k];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const a1 = inset(a, 0.01), b1 = inset(b, 0.01), a2 = inset(a, 0.35), b2 = inset(b, 0.35); a2[1] = mix(a[2], hc, 0.7); b2[1] = mix(b[2], hc, 0.7);
    FAR.quad([a[0], -6, a[1]], [b[0], -6, b[1]], b1, a1, face, e); FAR.quad(a1, b1, b2, a2, top, e); FAR.tri(a2, b2, [cx, hc, cz], top, e);
  }
}
function buildFar() {
  // Studland, Old Harry Rocks, Ballard Down and the Purbeck Hills
  island([[50.683, -1.948, 3], [50.668, -1.940, 5], [50.652, -1.933, 12], [50.643, -1.924, 32], [50.640, -1.928, 30], [50.633, -1.945, 90],
    [50.617, -1.955, 40], [50.600, -1.960, 60], [50.590, -2.050, 100], [50.600, -2.300, 120], [50.660, -2.300, 80], [50.670, -2.050, 40], [50.683, -1.990, 5]], 190, true);
  for (const [lat, lon, h] of [[50.6438, -1.9205, 28], [50.6430, -1.9195, 22]]) { const [x, z] = LL(lat, lon); FAR.cyl(x, -6, z, 22, 14, h + 6, 6, col(0.9, 0.89, 0.84, 22), ext(0, 1)); }
  // the Isle of Wight: Tennyson Down to the Needles, Totland, Yarmouth
  island([[50.662, -1.578, 30], [50.672, -1.575, 60], [50.685, -1.545, 30], [50.705, -1.500, 10], [50.725, -1.350, 20], [50.700, -1.150, 30],
    [50.580, -1.250, 60], [50.630, -1.450, 120], [50.660, -1.540, 140], [50.664, -1.570, 110]], 160, true);
  for (const [lat, lon, h] of [[50.6625, -1.5865, 28], [50.6615, -1.5895, 24], [50.6605, -1.5925, 20]]) { const [x, z] = LL(lat, lon); FAR.cyl(x, -6, z, 30, 18, h + 6, 5, col(0.93, 0.92, 0.88, 22), ext(0, 1)); }
  // Hengistbury Head, Christchurch Bay, Hurst Spit
  island([[50.717, -1.790, 20], [50.711, -1.760, 25], [50.713, -1.740, 30], [50.721, -1.730, 6], [50.735, -1.700, 20], [50.745, -1.620, 20],
    [50.725, -1.580, 5], [50.706, -1.551, 3], [50.712, -1.545, 3], [50.740, -1.560, 15], [50.800, -1.600, 30], [50.800, -1.790, 30]], 40, false);
}

// ---------------------------------------------------------------- vegetation instances (chunked)
// instance: x, y, z, scale, rotation, tint, squash, kind
const VEG = { pine: [], broad: [], shrub: [] };
function vegetation() {
  rseed(21);
  const add = (k, x, z, s, sq = rr(0.85, 1.15), y = terrainH(x, z)) => blocked(x, z) || inBuilding(x, z) || VEG[k].push(x, y - 0.1, z, s, rr(0, TAU), rnd(), sq, k === 'pine' ? 0 : 1);
  // nothing grows inside buildings or huts
  const blocked = (x, z) => { const k = (floor(x / 8) + 4096) * 8192 + floor(z / 8) + 4096, l = SEGH.get(k); if (!l) return false; for (const i of l) { const ax = SEGF[i], az = SEGF[i + 1], dx = SEGF[i + 2] - ax, dz = SEGF[i + 3] - az, l2 = dx * dx + dz * dz || 1, t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1); if (hypot(ax + dx * t - x, az + dz * t - z) < 2.5) return true; } return false; };
  // the mapped trees
  const T = WD.H.points.tree; for (let i = 0; i < T.length; i += 2) add(rnd() < 0.4 ? 'pine' : 'broad', T[i], T[i + 1], rr(8, 15));
  // scatter by surface class across the detail grid
  const area = (GD.nx - 1) * GD.d * (GD.nz - 1) * GD.d, N = area / 6 * DENS;
  for (let i = 0; i < N; i++) {
    const x = GD.x0 + rnd() * (GD.nx - 1) * GD.d, z = GD.z0 + rnd() * (GD.nz - 1) * GD.d, c = maskAt(x, z), r = rnd();
    if (c === 6) { if (r < 0.08) add(rnd() < 0.75 ? 'pine' : 'broad', x, z, rr(11, 20)); else if (r < 0.55) add('shrub', x, z, rr(0.9, 2.4)); }
    else if (c === 7) { if (r < 0.014) add('pine', x, z, rr(8, 16)); else if (r < 0.03) add('broad', x, z, rr(3.5, 7)); else if (r < 0.95) { add('shrub', x, z, rr(1, 2.4)); if (rnd() < 0.6) add('shrub', x + rr(-1.5, 1.5), z + rr(-1.5, 1.5), rr(0.8, 2)); } }
    else if (c === 8) { if (r < 0.03) add('shrub', x, z, rr(0.5, 1.2)); }
    else if (c === 9) { if (r < 0.012) add(rnd() < 0.3 ? 'pine' : 'broad', x, z, rr(6, 13)); else if (r < 0.03) add('shrub', x, z, rr(1, 2.5)); }
    else if (c === 5 || c === 11) { if (r < 0.004) add(rnd() < 0.4 ? 'pine' : 'broad', x, z, rr(8, 16)); }
    else if (c === 0) { if (r < 0.003) add('broad', x, z, rr(6, 12)); }
  }
  // the wider town: a sparser sprinkling of tall trees to fill the skyline
  for (let i = 0; i < 9000 * DENS; i++) {
    const x = GC.x0 + rnd() * (GC.nx - 1) * GC.d, z = GC.z0 + rnd() * (GC.nz - 1) * GC.d;
    if (inDetail(x, z)) continue; const c = maskAt(x, z);
    if (c === 6 || (c === 7 && rnd() < 0.4) || (c === 9 && rnd() < 0.15) || (c === 5 && rnd() < 0.1)) add(rnd() < 0.6 ? 'pine' : 'broad', x, z, rr(10, 20));
  }
  // hedges become rows of shrubs
  for (const l of WD.H.lines.hedge) for (let i = 0; i < l.length - 2; i += 2) { const d = hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]); for (let s = 0; s < d; s += 0.9) add('shrub', l[i] + (l[i + 2] - l[i]) * s / d, l[i + 1] + (l[i + 3] - l[i + 1]) * s / d, rr(0.9, 1.3), 0.9); }
}
// building footprints by 32 m cell, to keep trees out of them
const BIDX = new Map();
const addFoot = (r) => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of r) { x0 = min(x0, x); x1 = max(x1, x); z0 = min(z0, z); z1 = max(z1, z); } for (let i = floor(x0 / 32); i <= floor(x1 / 32); i++) for (let j = floor(z0 / 32); j <= floor(z1 / 32); j++) { const k = i * 100000 + j; let l = BIDX.get(k); if (!l) BIDX.set(k, (l = [])); l.push(r); } };
const inBuilding = (x, z) => { const l = BIDX.get(floor(x / 32) * 100000 + floor(z / 32)); if (l) for (const r of l) if (pip(r, x, z)) return true; return false; };
// sorts instances into chunks: returns {data: Float32Array, chunks: [{first, count, box}]}
function chunkInstances(a, rad) {
  const by = new Map();
  for (let i = 0; i < a.length; i += 8) { const k = chunkKey(a[i], a[i + 2]); let l = by.get(k); if (!l) by.set(k, (l = [])); l.push(i); }
  const out = new Float32Array(a.length), chunks = []; let n = 0;
  for (const [k, l] of by) {
    const first = n / 8; let b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const i of l) { for (let j = 0; j < 8; j++) out[n + j] = a[i + j]; const s = a[i + 3] * rad; b = [min(b[0], a[i] - s), min(b[1], a[i + 1]), min(b[2], a[i + 2] - s), max(b[3], a[i] + s), max(b[4], a[i + 1] + s * 2), max(b[5], a[i + 2] + s)]; n += 8; }
    chunks.push({ first, count: l.length, box: b });
  }
  return { data: out, chunks };
}

// ---------------------------------------------------------------- base meshes for the instanced things
// trees: unit height; colour alpha = foliage layer or 255 bark; extra x = wind weight
function cards(m, cx, cy, cz, sx, sy, layer, n, seed, up = 0.3, flat = 0) {
  // crossed, randomly tilted cards around a centre, their normals pointing out of the crown; `flat` of them lie
  // almost horizontal (pine pads)
  rseed(seed);
  for (let i = 0; i < n; i++) {
    const a = rr(0, PI), t = i < flat ? rr(0.7, 1.1) * (rnd() < 0.5 ? -1 : 1) : rr(-up, up), c = cos(a), s = sin(a);
    const ox = cx + rr(-0.3, 0.3) * sx, oy = cy + rr(-0.25, 0.25) * sy, oz = cz + rr(-0.3, 0.3) * sx;
    const hx = c * sx, hz = s * sx, hy = sy;
    const p = [[ox - hx, oy - hy + t * sx, oz - hz], [ox + hx, oy - hy - t * sx, oz + hz], [ox + hx, oy + hy - t * sx, oz + hz], [ox - hx, oy + hy + t * sx, oz - hz]];
    const k = col(1, 1, 1, layer), e = ext(0, 0, 0, 1);
    const nn = (q) => [q[0] - cx, (q[1] - cy) * 0.6 + sy * 0.4, q[2] - cz];
    for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) m.tri(p[i0], p[i1], p[i2], k, e, [[0, 1], [1, 1], [1, 0], [0, 0]][i0].concat([[0, 1], [1, 1], [1, 0], [0, 0]][i1], [[0, 1], [1, 1], [1, 0], [0, 0]][i2]), nn([(p[i0][0] + p[i1][0] + p[i2][0]) / 3, (p[i0][1] + p[i1][1] + p[i2][1]) / 3, (p[i0][2] + p[i1][2] + p[i2][2]) / 3]));
  }
}
function branch(m, a, b, r0, r1) { const bk = col(1, 1, 1, 255), e = ext(0, 0, 0, 0); const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; m.beam(a, b, (r0 + r1) / 2, bk, e); }
// Scots / Corsican pine: tall bare trunk, a broken flat-topped crown of needle pads
function pineMesh(lod) {
  const m = new Mesh(); rseed(31);
  const bk = col(1, 1, 1, 255), e = ext(0, 0, 0, 0);
  m.cyl(0, 0, 0, 0.022, 0.009, 0.92, lod ? 5 : 8, bk, e, false);
  const pads = lod ? 7 : 16;
  for (let i = 0; i < pads; i++) {
    const a = i * 2.4 + rr(-0.4, 0.4), y = rr(0.55, 0.93), r = rr(0.06, 0.2) * (1.1 - (y - 0.55)), x = cos(a) * r, z = sin(a) * r;
    if (!lod) branch(m, [0, y - 0.05, 0], [x, y + 0.02, z], 0.006, 0.003);
    cards(m, x, y + 0.03, z, rr(0.09, 0.13), rr(0.05, 0.07), F.PINE, lod ? 2 : 5, 40 + i, 0.4, lod ? 1 : 3);
  }
  return m;
}
// broadleaf (holm oak, sycamore): short trunk, rounded crown of leaf clusters
function broadMesh(lod) {
  const m = new Mesh(); rseed(32);
  const bk = col(1, 1, 1, 255), e = ext(0, 0, 0, 0);
  m.cyl(0, 0, 0, 0.04, 0.02, 0.5, lod ? 5 : 8, bk, e, false);
  const n = lod ? 7 : 16;
  for (let i = 0; i < n; i++) {
    const a = i * 2.4, y = rr(0.42, 0.9), r = sin((y - 0.35) / 0.6 * PI) * rr(0.2, 0.32), x = cos(a) * r, z = sin(a) * r;
    if (!lod && i < 8) branch(m, [0, 0.4, 0], [x * 0.8, y, z * 0.8], 0.012, 0.005);
    cards(m, x, y, z, rr(0.12, 0.16), rr(0.1, 0.13), F.LEAF, lod ? 2 : 3, 60 + i, 0.5);
  }
  return m;
}
// shrubs: gorse, heather, rhododendron (picked by tint in the shader would need branching; use three layers)
function shrubMesh() {
  const m = new Mesh(); rseed(33);
  for (let i = 0; i < 4; i++) cards(m, rr(-0.2, 0.2), rr(0.35, 0.5), rr(-0.2, 0.2), rr(0.4, 0.5), rr(0.32, 0.4), [F.GORSE, F.HEATHER, F.SHRUB, F.GORSE][i], 2, 70 + i, 0.3);
  return m;
}
function grassMesh() { const m = new Mesh(); for (let i = 0; i < 2; i++) { const a = i * PI / 2, c = cos(a) * 0.5, s = sin(a) * 0.5; m.quad([-c, 0, -s], [c, 0, s], [c, 1, s], [-c, 1, -s], col(1, 1, 1, 3), E0, [0, 1, 1, 1, 1, 0, 0, 0]); } return m; }
// people: parts coded in colour alpha (40 head, 41 torso, 42/43 legs, 44/45 arms, 46 hair); facing +x
function personMesh() {
  const m = new Mesh(), k = (p) => col(1, 1, 1, p);
  m.boxA([0, 0.46, 0.09], [0.07, 0, 0], [0, 0.46, 0], [0, 0, 0.07], k(42)); m.boxA([0, 0.46, -0.09], [0.07, 0, 0], [0, 0.46, 0], [0, 0, 0.07], k(43));
  m.boxA([0.01, 1.17, 0], [0.12, 0, 0], [0, 0.32, 0], [0, 0, 0.19], k(41));
  m.boxA([0, 1.14, 0.25], [0.05, 0, 0], [0, 0.31, 0], [0, 0, 0.05], k(44)); m.boxA([0, 1.14, -0.25], [0.05, 0, 0], [0, 0.31, 0], [0, 0, 0.05], k(45));
  m.blob(0.01, 1.62, 0, 0.1, 0.12, 0.095, k(40), E0, 0.02, 1); m.blob(-0.01, 1.69, 0, 0.105, 0.075, 0.1, k(46), E0, 0.05, 1);
  return m;
}
function gullMesh() {
  const m = new Mesh(), w = col(0.95, 0.95, 0.95, 22), g = col(0.62, 0.65, 0.68, 22), e1 = ext(0, 0.6, 1), e2 = ext(0, 0.6, 2), e0 = ext(0, 0.6, 0);
  m.blob(0, 0, 0, 0.24, 0.07, 0.07, w, e0, 0.05, 1);
  m.quad([0.07, 0, 0.04], [-0.07, 0, 0.04], [-0.12, 0, 0.4], [0.02, 0, 0.42], g, e1); m.quad([0.02, 0, 0.42], [-0.12, 0, 0.4], [-0.2, 0, 0.62], [-0.12, 0, 0.64], g, e1);
  m.quad([0.07, 0, -0.04], [0.02, 0, -0.42], [-0.12, 0, -0.4], [-0.07, 0, -0.04], g, e2); m.quad([0.02, 0, -0.42], [-0.12, 0, -0.64], [-0.2, 0, -0.62], [-0.12, 0, -0.4], g, e2);
  return m;
}
function boatMesh() {
  const m = new Mesh(), hull = hex(0xf2f2ee, L.METAL), dk = hex(0x8a6a48, L.PLANKS), sail = col(0.97, 0.96, 0.92, 22), es = ext(0, 0.8, 0, 10 / 255);
  const H = [[4, 0.8, 0], [2, 0.8, 1.3], [-3.5, 0.8, 1.1], [-3.5, 0.8, -1.1], [2, 0.8, -1.3]], B = [[3.4, -0.6, 0], [1.6, -0.6, 0.5], [-3, -0.6, 0.4], [-3, -0.6, -0.4], [1.6, -0.6, -0.5]];
  for (let i = 0; i < 5; i++) { const j = (i + 1) % 5; m.quad(H[i], B[i], B[j], H[j], hull); }
  m.quad(H[1], H[2], H[3], H[4], dk); m.tri(H[0], H[1], H[4], dk);
  m.box(0.6, 0.8, -0.05, 0.7, 11, 0.05, hull);
  m.tri([0.5, 1.4, 0], [0.5, 10.6, 0], [-3.2, 1.4, 0], sail, es); m.tri([0.8, 1.4, 0], [3.6, 1.0, 0], [0.8, 9.6, 0], sail, es);
  return m;
}

// ---------------------------------------------------------------- the sea surface: polar grid around the camera
function seaGrid() {
  const R = [], SEG = 192;
  for (let i = 0; i <= 200; i++) R.push(i < 40 ? i * 0.75 : 30 * 1.045 ** (i - 40));
  const v = new Float32Array(R.length * SEG * 2);
  for (let i = 0; i < R.length; i++) for (let s = 0; s < SEG; s++) { const a = s / SEG * TAU, o = (i * SEG + s) * 2; v[o] = cos(a) * R[i]; v[o + 1] = sin(a) * R[i]; }
  const I = new Uint32Array((R.length - 1) * SEG * 6); let q = 0;
  for (let i = 0; i < R.length - 1; i++) for (let s = 0; s < SEG; s++) { const a = i * SEG + s, b = i * SEG + (s + 1) % SEG, c = a + SEG, d = b + SEG; I[q++] = a; I[q++] = c; I[q++] = b; I[q++] = b; I[q++] = c; I[q++] = d; }
  return { vb: v, ib: I };
}

// ---------------------------------------------------------------- beach life: parasols, windbreaks, towels, sunbathers
function beachLife() {
  rseed(41);
  const CLOTH = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffd166, 0x9b5de5, 0xffffff, 0x06d6a0, 0xef476f, 0x118ab2];
  const n = 900 * DENS;
  for (let i = 0; i < n; i++) {
    const s = rr(S_B - 900, S_S + 600), w = 0.35 + exp(-(((s - S_B) / 300) ** 2)) + exp(-(((s - S_S) / 250) ** 2)) * 0.8;
    if (rnd() > w) continue;
    const p = plAt(COAST, s), nx = -p[3], nz = p[2];
    // dry sand between the reach of the waves and the prom
    let o = rr(5, 40); const x = p[0] + nx * o, z = p[1] + nz * o, y = terrainH(x, z);
    if (maskAt(x, z) !== 1 || y < 0.9 || PIERS.some((q) => pip(q.ring, x, z)) || nearGroyne(x, z, 2.5)) continue;
    const m = chunk(x, z), r = rnd(), a = atan2(nz, nx) + rr(-0.5, 0.5);
    if (r < 0.32) {
      m.beam([x, y - 0.3, z], [x, y + 2.1, z], 0.022, hex(0xdddddd, L.METAL));
      const c1 = col(...[0, 0, 0], 22), C1 = hex(pick(CLOTH), 0), R = rr(1, 1.3);
      for (let k = 0; k < 10; k++) { const a0 = k / 10 * TAU, a1 = (k + 1) / 10 * TAU; m.tri([x, y + 2.22, z], [x + cos(a0) * R, y + 1.82, z + sin(a0) * R], [x + cos(a1) * R, y + 1.82, z + sin(a1) * R], (k & 1 ? hex(pick(CLOTH), 0) : hex(0xffffff, 0)) & 0x00ffffff | 22 << 24, ext(0, 0.8, 0, 10 / 255)); }
    } else if (r < 0.5) {
      const k = 3 + (rnd() * 3 | 0), ca = cos(a + PI / 2), sa = sin(a + PI / 2), cs = [pick(CLOTH), pick(CLOTH), 0xffffff];
      for (let j = 0; j < k; j++) {
        const px = x + ca * j * 1.1, pz = z + sa * j * 1.1, qx = x + ca * (j + 1) * 1.1, qz = z + sa * (j + 1) * 1.1;
        m.quad([px, y + 0.05, pz], [qx, y + 0.05, qz], [qx, y + 1.25, qz], [px, y + 1.25, pz], (hex(cs[j % 3], 0) & 0xffffff) | 22 << 24, ext(0, 0.85, 0, 10 / 255));
        m.box(px - 0.03, y - 0.2, pz - 0.03, px + 0.03, y + 1.35, pz + 0.03, hex(0xffffff, L.TIMBER));
      }
    }
    if (r > 0.25) {
      const tx = x + rr(-1.5, 1.5), tz = z + rr(-1.5, 1.5), ty = terrainH(tx, tz) + 0.02;
      m.boxY(tx, ty, tz, 0.9, 0.012, 0.45, a, (hex(pick(CLOTH), 0) & 0xffffff) | 22 << 24, ext(0, 0.9, 0, 10 / 255));
    }
  }
}
const nearGroyne = (x, z, d) => { for (let i = 0; i < GROYNES.length; i += 6) { const ax = GROYNES[i + 2], az = GROYNES[i + 3], bx = GROYNES[i + 4], bz = GROYNES[i + 5], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1); if (hypot(ax + dx * t - x, az + dz * t - z) < d) return true; } return false; };

// ---------------------------------------------------------------- everything
function buildWorld() {
  const H = WD.H, S = WD.S;
  for (const p of H.piers) pier(p);
  groynes();
  // buildings (on a pier: standing on its deck)
  const rings = (n, co) => { const out = []; let o = 0; for (let i = 0; i < n.length; i++) { const r = []; let x = 0, z = 0; for (let k = 0; k < n[i]; k++) { x += co[o++]; z += co[o++]; r.push([x * H.ringq, z * H.ringq]); } out.push(r); } return out; };
  const B = rings(S.bn, S.bco);
  for (let i = 0; i < B.length; i++) {
    const r = B[i]; let cx = 0, cz = 0; for (const [x, z] of r) { cx += x / r.length; cz += z / r.length; }
    const on = PIERS.find((p) => pip(p.ring, cx, cz));
    addFoot(r);
    building(r, S.bh[i] / 10, S.broof[i], S.bcls[i], S.bfc[i], S.brc[i], S.bfl[i], 1000 + i, on ? on.deck : null);
  }
  const Hh = rings(S.hn, S.hco);
  for (let i = 0; i < Hh.length; i++) { addFoot(Hh[i]); hut(Hh[i], S.hh[i] / 10, 5000 + i); }
  fillHuts();
  // furniture: the mapped benches near the prom (facing the sea), lamps along the prom, bins
  const P = H.points;
  for (let i = 0; i < P.bench.length; i += 2) {
    const x = P.bench[i], z = P.bench[i + 1], s = plProject(COAST, x, z), nn = coastN(s);
    bench(x, z, atan2(-nn[1], -nn[0]) - PI / 2);
  }
  for (let s = 0; s < PROMC.len; s += 30) {
    const p = plAt(PROMC, s), x = p[0], z = p[1], i = min(PROMW.length - 1, round(s / PROMC.len * (PROMW.length - 1))), w = PROMW[i];
    const cs = plProject(COAST, x, z), nn = coastN(cs), lx = x - nn[0] * (w / 2 - 1.2), lz = z - nn[1] * (w / 2 - 1.2);
    if (PIERS.some((q) => pip(q.ring, lx, lz))) continue;
    lamp(lx, lz, terrainH(lx, lz));
  }
  for (let i = 0; i < P.bin.length; i += 2) { const x = P.bin[i], z = P.bin[i + 1], y = terrainH(x, z), m = chunk(x, z); m.cyl(x, y, z, 0.25, 0.25, 0.9, 8, hex(0x2c3a33, L.METAL)); }
  for (const k of ['wall', 'fence', 'rail']) for (const l of H.lines[k]) fenceLine(l, k);
  for (const l of H.lines.funicular) funicular(l);
  beachLife();
  buildFar();
  buildCollision();
  vegetation();
}

// ---------------------------------------------------------------- walkers, gulls, boats
// walkers: their path is the prom (offset across it) or the beach near the water; updated each frame on the CPU
const WALK = { n: 0, s: null, o: null, v: null, ph: null, beach: null, data: null };
function initPeople() {
  rseed(51);
  const n = 340 * DENS | 0; WALK.n = n;
  WALK.s = new Float32Array(n); WALK.o = new Float32Array(n); WALK.v = new Float32Array(n); WALK.ph = new Float32Array(n); WALK.beach = new Uint8Array(n);
  WALK.data = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const beach = rnd() < 0.25; WALK.beach[i] = beach ? 1 : 0;
    WALK.s[i] = beach ? rr(S_B - 1200, S_S + 900) : rr(0, PROMC.len); WALK.o[i] = beach ? rr(3, 15) : rr(-0.42, 0.42);
    const kid = rnd() < 0.12; WALK.v[i] = rr(0.9, 1.5) * (rnd() < 0.5 ? -1 : 1);
    WALK.ph[i] = rr(0, TAU);
    const d = WALK.data, o = i * 8; d[o + 5] = kid ? rr(0.55, 0.7) : rr(0.92, 1.1); d[o + 6] = rnd(); d[o + 7] = beach ? 0 : 1;
  }
}
function updatePeople(dt) {
  const d = WALK.data;
  for (let i = 0; i < WALK.n; i++) {
    const beach = WALK.beach[i], line = beach ? COAST : PROMC; let s = WALK.s[i] + WALK.v[i] * dt;
    const lo = beach ? S_B - 1200 : 0, hi = beach ? S_S + 900 : PROMC.len;
    if (s < lo) s += hi - lo; else if (s > hi) s -= hi - lo;
    WALK.s[i] = s; WALK.ph[i] += abs(WALK.v[i]) * dt * 4.49;
    const p = plAt(line, s); let x = p[0], z = p[1]; const dx = p[2], dz = p[3];
    let off = WALK.o[i];
    if (!beach) { const k = min(PROMW.length - 1, round(s / PROMC.len * (PROMW.length - 1))); off *= PROMW[k]; }
    // beach walkers keep to the seaward side of the shoreline (offset towards the sea), prom walkers across the prom
    const sx = beach ? dz * off : -dz * off, sz = beach ? -dx * off : dx * off;
    x = p[0] + sx; z = p[1] + sz;
    const o = i * 8, dir = WALK.v[i] > 0 ? 1 : -1;
    d[o] = x; d[o + 1] = terrainH(x, z); d[o + 2] = z; d[o + 3] = WALK.ph[i];
    d[o + 4] = atan2(dz * dir, dx * dir);
  }
}
function buildGulls() {
  rseed(61); const a = [];
  for (let i = 0; i < 50; i++) { const p = plAt(COAST, rr(S_B - 800, S_S + 600)); a.push(p[0] + rr(-60, 60), rr(8, 45), p[1] + rr(-150, 40), rr(8, 40), rr(0.25, 0.5) * (rnd() < 0.5 ? -1 : 1), rr(0, TAU), rr(1.4, 1.8), 0); }
  return new Float32Array(a);
}
function buildBoats() {
  rseed(71); const a = [];
  for (let i = 0; i < 18; i++) { const x = rr(-5000, 9000); a.push(x, rr(-6000, -900), rr(1, 3.5) * (rnd() < 0.5 ? -1 : 1), rr(0, TAU), rr(0.9, 1.6), 0, 0, 0); }
  return new Float32Array(a);
}

// ---------------------------------------------------------------- places along the way
// [x, z, radius, title, text]
let POI, POSES;
// the middle of the promenade inland of the shoreline at arc length s (or a point 30 m inland if there is none)
function promPoint(s) {
  const p = [...plAt(COAST, s)], n = coastN(s); let a = -1, b = -1;
  for (let o = 0; o < 160; o += 0.75) { const c = maskAt(p[0] + n[0] * o, p[1] + n[1] * o); if (c === 2) { if (a < 0) a = o; b = o; } else if (a >= 0 && o - b > 4) break; }
  const o = a < 0 ? 30 : min(a + 5, (a + b) / 2); return [p[0] + n[0] * o, p[1] + n[1] * o, p[2], p[3]];
}
function initPlaces() {
  const BP = PIERS.find((p) => p.name.includes('Bournemouth')), SP = PIERS.find((p) => p.name.includes('Boscombe'));
  const far = (p) => { let b = null, d = -1; for (const q of p.ring) { const k = hypot(q[0] - p.root[0], q[1] - p.root[1]); if (k > d) { d = k; b = q; } } return b; };
  const [rcx, rcz] = LL(50.7176, -1.8707);
  const zz = WD.H.names.find((n) => n[0] === 'East Cliff Zig Zag'), toft = WD.H.names.find((n) => n[0] === 'Toft Zig Zag');
  POI = [
    [BP.root[0], BP.root[1] - 40, 90, 'Bournemouth Pier', 'Eröffnet 1880. Hier beginnt der Spaziergang – immer am Meer entlang nach Osten.'],
    [rcx, rcz - 120, 110, 'East Cliff', 'Oben auf der Klippe: das Russell-Cotes-Museum, als East Cliff Hall 1901 vollendet.'],
    [zz[1], zz[2] - 60, 90, 'East Cliff Zig Zag', 'Der Zickzackweg führt die Klippe hinauf. Weiter westlich steht der East Cliff Lift seit dem Erdrutsch von 2016 still.'],
    [toft[1], toft[2] - 70, 90, 'Toft Zig Zag', 'Kiefern, Ginster und Heide halten den Sand der Klippen fest.'],
    [SP.root[0] - 140, SP.root[1] - 30, 70, 'Overstrand', 'Die Strandhütten in Boscombe – Boscombe Pier ist schon ganz nah.'],
    [SP.root[0], SP.root[1] - 60, 90, 'Boscombe Pier', 'Eröffnet 1889, Eingangsgebäude aus den 1950ern, „Pier of the Year 2010“. Ziel erreicht!'],
  ];
  const sB = plProject(PROMC, BP.root[0], BP.root[1]);
  const st = promPoint(S_B + 130);
  const sm = (S_B + S_S) / 2, mid = [...plAt(COAST, sm)], mn = coastN(sm);
  const bh = far(BP), sh = far(SP), zp = promPoint(plProject(COAST, zz[1], zz[2]));
  const yawTo = (fx, fz) => atan2(fx, -fz); // forward = (sin yaw, -cos yaw), see main.js
  POSES = [
    [st[0], st[1], yawTo(st[2], st[3]) + 0.35, -0.02],
    [bh[0] + (BP.root[0] - bh[0]) * 0.04, bh[1] + (BP.root[1] - bh[1]) * 0.04, yawTo(BP.root[0] - bh[0], BP.root[1] - bh[1]), 0.02],
    [zp[0], zp[1], yawTo(zz[1] - zp[0], zz[2] - zp[1]), 0.18],
    [mid[0] + mn[0] * 12, mid[1] + mn[1] * 12, yawTo(mid[2], mid[3]), -0.03],
    [sh[0] + (SP.root[0] - sh[0]) * 0.05, sh[1] + (SP.root[1] - sh[1]) * 0.05, yawTo(-1, 0.25), -0.02],
  ];
}
