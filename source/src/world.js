// ============================================================================
// the seafront: geography, buildings, beach life, collision, places of interest
// ============================================================================
// Seafront coordinates: x runs east along the promenade (Bournemouth Pier at x = 0, Boscombe Pier at x = 1600),
// z is the distance inland from the edge of the promenade (beach and sea at z < 0, cliffs at z > PW). Everything
// is built straight and bent onto the curve of Poole Bay when packed: z_world = z + bend(x). The same bend and
// beach profile are repeated in the shaders (shaders.js), keep them in step.
const PROM = 2.1, PW = 14, BOSC = 1600; // promenade height and width, Boscombe Pier
const bend = (x) => { const t = (x - 800) / 900; return t < 0 ? -11 * t * t - 2 * t * t * t * t : -11 * t * t; };
const beachH = (z) => max(z > -50 ? 1.6 + z * 0.032 : (z + 50) * 0.045, -9);
// the chines: valleys cut into the cliffs (Bourne valley at the pier, Boscombe Chine, Durley, Alum, Branksome)
const CHINES = [[-10, 140], [BOSC, 75], [-1100, 60], [-2300, 70], [-3300, 60]];
const valleyF = (x) => { let v = 0; for (const [c, w] of CHINES) { const t = (x - c) / w; v = max(v, exp(-t * t * t * t)); } return v; };
const taper = (x) => max(sstep(-4600, -5000, x), sstep(8300, 8650, x));
function cliffH(x) {
  let h = (28 + 16 * (fbm(x * 0.003, 3.7, 3) - 0.5)) * (1 - 0.85 * valleyF(x));
  h *= mix(1, 0.15, sstep(-2500, -4300, x)); // down to the Sandbanks spit
  h = mix(h, 12, sstep(5000, 6500, x)); // Southbourne
  return h + 26 * exp(-(((x - 8000) / 500) ** 2)); // Hengistbury Head
}
const cliffW = (x) => 34 + 10 * fbm(x * 0.01, 9.1, 2) + 90 * valleyF(x);
// ground height at (x, z), without buildings
function ground(x, z) {
  let h;
  if (z < 0) h = beachH(z);
  else if (z < PW) h = PROM;
  else {
    const H = cliffH(x), W = cliffW(x), d = z - PW, vf = valleyF(x);
    const wall = 1 - vf; // the retaining wall at the foot of the cliff, none in the chines
    if (d < 0.25) h = PROM + d * 4 * wall;
    else {
      const t = min((d - 0.25) / W, 1);
      const s = mix(t * t * (3 - 2 * t), sqrt(t), 0.35);
      h = PROM + wall + (H - wall) * s + (fbm(x * 0.045, z * 0.06, 3) - 0.5) * 7 * sin(PI * t) * (1 - vf);
      if (d > W) h += (d - W) * 0.03 + (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 3 * min((d - W) / 20, 1);
    }
  }
  return mix(h, -12, taper(x));
}
const cliffTop = (x) => PW + 0.25 + cliffW(x);

// ---------------------------------------------------------------- terrain grid
// Columns every 2 m along the walk, coarser further away; rows dense on the beach edge and the cliff.
function buildTerrain() {
  const xs = [];
  for (let x = -450; x <= 2050; x += 2) xs.push(x);
  for (let x = -450, s = 2; x > -5000;) { s = min(s * 1.05, 50); x -= s; xs.unshift(max(x, -5000)); }
  for (let x = 2050, s = 2; x < 8650;) { s = min(s * 1.05, 50); x += s; xs.push(min(x, 8650)); }
  const zs = [-700, -520, -400, -320, -260, -215, -180, -150, -128, -110, -96, -85, -76, -70];
  for (let z = -68.5; z < -1; z += 1.5) zs.push(z);
  zs.push(-0.5, -0.02, 0, 2, 4, 6, 8, 10, 12, 13.98, 14, 14.25);
  for (let z = 15; z <= 70; z += 1) zs.push(z);
  for (let z = 72.5; z <= 160; z += 2.5) zs.push(z);
  for (let z = 168; z <= 480; z += 8) zs.push(z);
  const NXc = xs.length, NZc = zs.length, n = NXc * NZc;
  const P = new Float32Array(n * 3);
  for (let j = 0; j < NZc; j++) for (let i = 0; i < NXc; i++) {
    const x = xs[i], z = zs[j], o = (j * NXc + i) * 3;
    P[o] = x; P[o + 1] = ground(x, z); P[o + 2] = z + bend(x);
  }
  const b = new ArrayBuffer(n * 16), F = new Float32Array(b), U = new Uint32Array(b);
  for (let j = 0; j < NZc; j++) for (let i = 0; i < NXc; i++) {
    const k = j * NXc + i, o = k * 3, a = (j * NXc + max(i - 1, 0)) * 3, c = (j * NXc + min(i + 1, NXc - 1)) * 3;
    const d = (max(j - 1, 0) * NXc + i) * 3, e = (min(j + 1, NZc - 1) * NXc + i) * 3;
    const ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2], vx = P[e] - P[d], vy = P[e + 1] - P[d + 1], vz = P[e + 2] - P[d + 2];
    F[k * 4] = P[o]; F[k * 4 + 1] = P[o + 1]; F[k * 4 + 2] = P[o + 2];
    U[k * 4 + 3] = packN(vy * uz - vz * uy, vz * ux - vx * uz, vx * uy - vy * ux);
  }
  const I = new Uint32Array((NXc - 1) * (NZc - 1) * 6);
  let q = 0;
  for (let j = 0; j < NZc - 1; j++) for (let i = 0; i < NXc - 1; i++) {
    const a = j * NXc + i, c = a + NXc;
    I[q++] = a; I[q++] = c; I[q++] = a + 1; I[q++] = a + 1; I[q++] = c; I[q++] = c + 1;
  }
  return { vb: b, ib: I };
}

// ---------------------------------------------------------------- collision
// Each collider is a box in seafront coordinates whose top may slope along z (pier ramps, groynes):
// x0 x1 z0 z1 bottom topA topB zA zB, top = topA at zA blending to topB at zB.
// The walker stands on the highest top within a step of its feet and is blocked by anything taller.
const COLL = [];
const collide = (x0, x1, z0, z1, bot, top, topB = top, zA = 0, zB = 1) => COLL.push(x0, x1, z0, z1, bot, top, topB, zA, zB);
const CB0 = -500, CBW = 16, CBN = 164; // buckets of 16 m along x
let CBK; // per bucket: list of collider indices

// ---------------------------------------------------------------- static scenery
const S = new Mesh(true); // bent onto the bay
const FAR = new Mesh(false); // far coasts, in world coordinates
// materials (colour alpha): 0 plain, 1 wood, 2 concrete, 3 building with windows, 4 glass, 5 lamp (glows in the
// evening), 6 painted metal, 7 hut boards, 8 roof, 9 far land, 10 cloth, 11 skin
const M = { PLAIN: 0, WOOD: 1, CONC: 2, BLDG: 3, GLASS: 4, LAMP: 5, METAL: 6, HUT: 7, ROOF: 8, FAR: 9, CLOTH: 10, SKIN: 11 };
const BLD = []; // building footprints (x0, x1, z0, z1): keeps trees out
const nearBld = (x, z, m) => { for (let i = 0; i < BLD.length; i += 4) if (x > BLD[i] - m && x < BLD[i + 1] + m && z > BLD[i + 2] - m && z < BLD[i + 3] + m) return true; return false; };
const GROYNES = [];

function lamp(x, z, y = PROM) {
  S.cyl(x, y, z, 0.11, 0.07, 4.6, 6, hex(0x2b4a52, M.METAL));
  S.box(x - 0.05, y + 4.5, z - 0.05, x + 0.05, y + 4.6, z + 0.05, hex(0x2b4a52, M.METAL));
  S.box(x - 0.22, y + 4.6, z - 0.22, x + 0.22, y + 5.05, z + 0.22, hex(0xfff1c8, M.LAMP));
  S.hip(x - 0.26, z - 0.26, x + 0.26, z + 0.26, y + 5.05, 0.25, hex(0x2b4a52, M.METAL), 0.04);
  collide(x - 0.15, x + 0.15, z - 0.15, z + 0.15, y, y + 5);
}
function bench(x, z, y = PROM, face = -1) {
  const wd = hex(0x8a6a48, M.WOOD), mt = hex(0x30363a, M.METAL), b = z - face * 0.3;
  S.box(x - 0.9, y + 0.42, z - 0.22, x + 0.9, y + 0.48, z + 0.22, wd);
  S.box(x - 0.9, y + 0.55, b - 0.04, x + 0.9, y + 0.95, b + 0.04, wd);
  for (const s of [-0.8, 0.8]) S.box(x + s - 0.04, y, z - 0.22, x + s + 0.04, y + 0.95, b + 0.04, mt);
  collide(x - 0.95, x + 0.95, min(z, b) - 0.25, max(z, b) + 0.1, y, y + 0.95);
}
const HUTDOOR = [0x3f8fc9, 0xf2c94c, 0x6fbf73, 0xe0614a, 0xf29bb8, 0x8ad3d6, 0x2f5f9e, 0xf08a3c, 0xffffff, 0x9b7fd1, 0xc9e265, 0x1f8a70];
function hut(x, z, y, door, wall, roof, face = -1) {
  // x: left edge, z: front (sea side) when face = -1
  const d = 2.5, z0 = face < 0 ? z : z - d, z1 = face < 0 ? z + d : z;
  S.box(x + 0.05, y, z0, x + 2.35, y + 2.25, z1, wall, true);
  const fz = face < 0 ? z0 : z1;
  S.box(x + 0.35, y + 0.05, fz + face * 0.06, x + 2.05, y + 2.0, fz, door, true);
  S.box(x + 0.15, y + 2.02, fz + face * 0.07, x + 2.25, y + 2.12, fz, hex(0xf4f1e8, M.HUT), true);
  S.roof(x + 0.05, z0, x + 2.35, z1, y + 2.25, 0.65, roof, true, 0.12);
  collide(x + 0.02, x + 2.38, z0 - 0.15, z1, y, y + 3);
}
function kiosk(x, z, w) {
  const wall = hex(pick([0xf3efe2, 0xdfe9ee, 0xf5e6c8]), M.HUT), stripe = pick([0x2f6fb0, 0xd9443a, 0x2a9d8f]);
  S.box(x, PROM, z, x + w, PROM + 3.2, z + 3.4, wall, true);
  S.box(x + 0.4, PROM + 0.9, z - 0.04, x + w - 0.4, PROM + 2.4, z, hex(0x24343c, M.GLASS), true);
  for (let i = 0; i < w / 0.6 - 1e-6; i++) S.beam([x + i * 0.6 + 0.3, PROM + 3.0, z + 0.2], [x + i * 0.6 + 0.3, PROM + 2.55, z - 1.2], 0.3, hex(i & 1 ? 0xffffff : stripe, M.CLOTH));
  S.box(x - 0.1, PROM + 3.2, z - 0.1, x + w + 0.1, PROM + 3.45, z + 3.5, hex(0x3b4146, M.ROOF));
  collide(x, x + w, z - 0.2, z + 3.4, PROM, PROM + 3.5);
}

// a pier: deck height follows `deck(z)`, `w(z)` is its half width
function pier(px, len, deck, w, rail, pile) {
  const step = 3, wood = hex(0x8c7a64, M.WOOD), iron = hex(0x4a5258, M.METAL);
  for (let z = 0; z > -len; z -= step) {
    const z1 = z - step, a = deck(z), b = deck(z1), hw = w(z - step / 2);
    S.quad([px - hw, a, z], [px + hw, a, z], [px + hw, b, z1], [px - hw, b, z1], wood);
    S.quad([px - hw, a - 0.7, z], [px - hw, b - 0.7, z1], [px + hw, b - 0.7, z1], [px + hw, a - 0.7, z], iron);
    for (const s of [-1, 1]) {
      S.quad([px + s * hw, a, z], [px + s * hw, b, z1], [px + s * hw, b - 0.7, z1], [px + s * hw, a - 0.7, z], iron);
      // railing: posts and two rails
      S.box(px + s * hw - 0.05, a, z - 0.05, px + s * hw + 0.05, a + 1.15, z + 0.05, rail);
      S.beam([px + s * hw, a + 1.12, z], [px + s * hw, b + 1.12, z1], 0.045, rail);
      S.beam([px + s * hw, a + 0.6, z], [px + s * hw, b + 0.6, z1], 0.03, rail);
    }
    collide(px - hw, px + hw, z1, z, a - 0.7, b, a, z1, z);
    collide(px - hw - 0.2, px - hw + 0.08, z1, z, a, b + 1.15, a + 1.15, z1, z);
    collide(px + hw - 0.08, px + hw + 0.2, z1, z, a, b + 1.15, a + 1.15, z1, z);
  }
  // end rail
  const e = deck(-len), we = w(-len + 1);
  S.beam([px - we, e + 1.12, -len], [px + we, e + 1.12, -len], 0.045, rail);
  collide(px - we, px + we, -len - 0.2, -len + 0.08, e, e + 1.15);
  // piles in rows across the deck, braced
  for (let z = -pile; z > -len; z -= pile) {
    const hw = w(z) - 0.6, top = deck(z) - 0.7, bot = min(beachH(z), 0) - 3, n = max(2, round(hw / 3) + 1);
    if (beachH(z) > top - 1.2) continue;
    for (let i = 0; i < n; i++) {
      const x = px - hw + 2 * hw * i / (n - 1);
      S.cyl(x, bot, z, 0.32, 0.26, top - bot, 6, iron, false);
      collide(x - 0.4, x + 0.4, z - 0.4, z + 0.4, bot, top - 0.01);
      if (i) S.beam([x - 2 * hw / (n - 1), top - 0.3, z], [x, max(beachH(z), -0.5) + 0.5, z], 0.06, iron);
    }
    S.beam([px - hw, top - 0.25, z], [px + hw, top - 0.25, z], 0.12, iron);
  }
}
function building(x0, z0, x1, z1, y0, h, colr, roofCol, roofType) {
  S.box(x0, y0, z0, x1, y0 + h, z1, hex(colr, M.BLDG), true);
  if (roofType === 1) S.hip(x0, z0, x1, z1, y0 + h, min(x1 - x0, z1 - z0) * 0.3, hex(roofCol, M.ROOF));
  else if (roofType === 2) S.roof(x0, z0, x1, z1, y0 + h, min(x1 - x0, z1 - z0) * 0.35, hex(roofCol, M.ROOF), (x1 - x0) < (z1 - z0));
  else S.box(x0 - 0.2, y0 + h, z0 - 0.2, x1 + 0.2, y0 + h + 0.5, z1 + 0.2, hex(roofCol, M.CONC));
  collide(x0, x1, z0, z1, y0 - 20, y0 + h);
  BLD.push(x0, x1, z0, z1);
}

function buildScenery() {
  rseed(1);
  // promenade edge (sea wall) and the retaining wall at the foot of the cliffs
  for (let x = -460; x < 2060; x += 10) {
    S.box(x, 0.9, -0.35, x + 10, PROM + 0.06, 0.12, hex(0xbdb6a8, M.CONC), true);
    if (x < -40 || x > 30 && x < BOSC - 40 || x > BOSC + 30) S.box(x, PROM, PW - 0.05, x + 10, PROM + 1.3, PW + 0.35, hex(0xc9bfae, M.CONC), true);
  }
  // lamps and benches along the sea side of the promenade
  for (let x = -440; x < 2050; x += 32) if (abs(x) > 14 && abs(x - BOSC) > 12) lamp(x, 0.9);
  for (let x = -424; x < 2050; x += 48) if (abs(x) > 14 && abs(x - BOSC) > 12) bench(x, 1.6);

  // beach huts in rows along the back of the promenade, gaps for kiosks, toilets and paths
  const ROOFS = [0x4a5359, 0x5b6770, 0x3d4a3f, 0x6b4b3a];
  const hutRow = (xa, xb) => {
    let x = xa, n = 0;
    while (x < xb - 2.4) {
      if (n > 0 && n % 24 === 0) {
        const r = rnd();
        if (r < 0.4) kiosk(x + 0.6, 10.6, 6); else if (r < 0.6) { building(x + 0.5, 10.4, x + 7, PW - 0.1, PROM, 3.2, 0xd8d2c4, 0x7d8a8f, 0); }
        x += 8; n++; continue;
      }
      const door = hex(pick(HUTDOOR), M.HUT), full = rnd() < 0.3;
      hut(x, 11.2, PROM, door, full ? door : hex(pick([0xf4f1e8, 0xece6d6, 0xf7f7f2]), M.HUT), hex(pick(ROOFS), M.ROOF));
      x += 2.55; n++;
    }
  };
  hutRow(70, 495); hutRow(548, 1500);
  hutRow(-400, -70);
  hutRow(1665, 2040);
  // Overstrand: three tiers of huts stepping up the cliff foot near Boscombe
  for (let t = 0; t < 3; t++) {
    const y = PROM + t * 3.1, z = 10.6 + t * 3.4;
    S.box(1502, PROM - 0.1, z - 0.4 + (t ? 0 : 0.4), 1572, y, z + 3.4, hex(0xe9e4d8, M.CONC), true);
    for (let x = 1503; x < 1569; x += 2.55) hut(x, z, y, hex(pick(HUTDOOR), M.HUT), hex(0xf6f3ea, M.HUT), hex(0x50606a, M.ROOF));
    S.beam([1502, y + 1.05, z - 0.35], [1572, y + 1.05, z - 0.35], 0.04, hex(0xdfe7ea, M.METAL));
    collide(1502, 1572, z - 0.4, z + 3.4, PROM - 1, y);
  }
  collide(1502, 1572, 20.4, 26, PROM - 1, PROM + 12);

  // groynes: low timber walls running down the beach every ~105 m
  for (let x = -395; x < 2050; x += 105) {
    if (abs(x) < 40 || abs(x - BOSC) < 40) continue;
    GROYNES.push(x);
    const wd = hex(0x6e6152, M.WOOD), top = (z) => beachH(z) + 0.6;
    for (let z = -0.4; z > -58; z -= 2) S.quad([x - 0.18, top(z), z], [x + 0.18, top(z), z], [x + 0.18, top(z - 2), z - 2], [x - 0.18, top(z - 2), z - 2], wd),
      S.quad([x - 0.18, top(z), z], [x - 0.18, top(z - 2), z - 2], [x - 0.18, beachH(z - 2) - 0.8, z - 2], [x - 0.18, beachH(z) - 0.8, z], wd),
      S.quad([x + 0.18, top(z), z], [x + 0.18, beachH(z) - 0.8, z], [x + 0.18, beachH(z - 2) - 0.8, z - 2], [x + 0.18, top(z - 2), z - 2], wd);
    for (let z = -1; z > -58; z -= 2.5) S.box(x - 0.24, beachH(z) - 0.5, z - 0.12, x + 0.24, top(z) + 0.25, z + 0.12, hex(0x5d5245, M.WOOD));
    collide(x - 0.25, x + 0.25, -50, -0.3, -5, 0.6, beachH(-0.3) + 0.6, -50, -0.3);
    collide(x - 0.25, x + 0.25, -58, -50, -5, beachH(-58) + 0.6, 0.6, -58, -50);
  }

  // Bournemouth Pier: level with the promenade at first, rising onto the sea, a wide head with a pavilion
  const bDeck = (z) => z > -22 ? PROM : z > -55 ? mix(PROM, 4.6, (-22 - z) / 33) : 4.6;
  const bW = (z) => z < -236 ? 17 : 5.5;
  pier(0, 300, bDeck, bW, hex(0xe8eef0, M.METAL), 9);
  for (let z = -20; z > -230; z -= 22) for (const s of [-1, 1]) lamp(s * 5.0, z, bDeck(z));
  // entrance building: two wings with the deck running between them under a shared roof
  {
    const y = PROM, wc = hex(0xf2f2ee, M.CONC), gl = hex(0x2a3b46, M.GLASS), bl = hex(0x2f6fa3, M.METAL);
    for (const s of [-1, 1]) {
      S.box(s * 2.6, y, -18, s * 10, y + 5.2, -5, wc, true);
      S.box(s * 2.55, y + 0.4, -16.5, s * 2.6, y + 4.4, -6.5, gl, true);
      S.box(s * 3, y + 2.6, -5.04, s * 9.6, y + 4.6, -5, gl, true);
      collide(min(s * 2.6, s * 10), max(s * 2.6, s * 10), -18, -5, -5, y + 5.2);
    }
    S.box(-10.4, y + 5.2, -18.4, 10.4, y + 6, -4.6, wc);
    S.box(-10.45, y + 5.5, -18.45, 10.45, y + 5.8, -4.55, bl);
    S.box(-4, y + 6, -11, 4, y + 7.6, -9.6, bl);
  }
  // pavilion on the head
  {
    const y = 4.6, wc = hex(0xf0e9da, M.BLDG);
    S.box(-13, y, -293, 13, y + 7.5, -246, wc, true);
    S.hip(-13, -293, 13, -246, y + 7.5, 5, hex(0x4f7c74, M.ROOF));
    S.box(-4, y + 7.5, -272, 4, y + 15, -266, wc);
    S.hip(-4, -272, 4, -266, y + 15, 4, hex(0x4f7c74, M.ROOF), 0.4);
    collide(-13, 13, -293, -246, y - 1, y + 13);
  }
  // Boscombe Pier: slim neck, open head, a long low entrance building with a jutting canopy
  const sDeck = (z) => z > -16 ? PROM : z > -42 ? mix(PROM, 4.0, (-16 - z) / 26) : 4.0;
  const sW = (z) => z < -206 ? 10 : 3.5;
  pier(BOSC, 230, sDeck, sW, hex(0xdfe6e6, M.METAL), 8);
  for (let z = -30; z > -200; z -= 25) lamp(BOSC + 3.1, z, sDeck(z));
  {
    const y = PROM, wc = hex(0xf4f4f0, M.CONC), gl = hex(0x27414d, M.GLASS);
    for (const s of [-1, 1]) {
      S.box(BOSC + s * 2.2, y, -13, BOSC + s * 15, y + 3.8, -2, wc, true);
      S.box(BOSC + s * 3, y + 0.6, -2.04, BOSC + s * 14.4, y + 3.2, -2, gl, true);
      collide(min(BOSC + s * 2.2, BOSC + s * 15), max(BOSC + s * 2.2, BOSC + s * 15), -13, -2, -5, y + 3.8);
    }
    S.box(BOSC - 15.5, y + 3.8, -13.5, BOSC + 15.5, y + 4.3, -1.5, wc);
    // the canopy: a slab tilting up towards the sea
    S.boxA([BOSC, y + 5.2, -14.5], [16.5, 0, 0], [0, 1.3, -0.9], [0, 0.12, 0.17], hex(0xe6e9ea, M.CONC));
    for (let z = -60; z > -200; z -= 45) { S.box(BOSC - 3, 4.0, z - 3, BOSC - 2.2, 6.4, z + 3, gl); S.box(BOSC - 3.1, 6.4, z - 3.1, BOSC - 1.8, 6.6, z + 3.1, wc); }
  }

  // East Cliff Lift: two cars on a straight incline up the cliff
  {
    const x = 520, zt = cliffTop(x) + 3, yt = ground(x, zt), z0 = 14.2, y0 = PROM + 0.4;
    const conc = hex(0xb9b2a4, M.CONC), cream = hex(0xf1e6c8, M.HUT), grn = hex(0x2e5e4e, M.ROOF);
    const at = (t) => [mix(z0, zt, t), mix(y0, yt, t)];
    for (let t = 0; t < 1; t += 0.05) {
      const [za, ya] = at(t), [zb, yb] = at(t + 0.05);
      S.quad([x - 3, ya, za], [x + 3, ya, za], [x + 3, yb, zb], [x - 3, yb, zb], conc);
      for (const s of [-3, 3]) S.quad([x + s, ya, za], [x + s, yb, zb], [x + s, min(yb, ground(x + s, zb)) - 0.5, zb], [x + s, min(ya, ground(x + s, za)) - 0.5, za], conc);
      for (const r of [-2.2, -1.2, 1.2, 2.2]) S.beam([x + r, ya + 0.12, za], [x + r, yb + 0.12, zb], 0.05, hex(0x555b60, M.METAL));
    }
    const car = (cx, t) => {
      const [z, y] = at(t);
      S.box(cx - 0.9, y + 0.2, z - 1.6, cx + 0.9, y + 2.6, z + 1.6, cream);
      S.box(cx - 0.92, y + 1.3, z - 1.4, cx + 0.92, y + 2.2, z + 1.4, hex(0x2a3b46, M.GLASS));
      S.box(cx - 1, y + 2.6, z - 1.7, cx + 1, y + 2.8, z + 1.7, grn);
    };
    car(x - 1.7, 0.06); car(x + 1.7, 0.92);
    building(x - 9, 9.6, x + 9, 13.8, PROM, 3.6, 0xf1e6c8, 0x2e5e4e, 2);
    building(x - 6, zt - 1, x + 6, zt + 6, yt, 3.4, 0xf1e6c8, 0x2e5e4e, 2);
    collide(x - 3.2, x + 3.2, 13.8, zt, -5, 60);
  }

  // the cliff top: hotels and blocks of flats, the Russell-Cotes villa near the pier
  rseed(2);
  building(186, cliffTop(200) + 8, 214, cliffTop(200) + 24, ground(200, cliffTop(200) + 16) - 1, 10, 0xb5654a, 0x8f3f2c, 1);
  {
    const x = 210, z = cliffTop(200) + 9, y = ground(x, z) - 1;
    S.box(x - 3, y, z - 3, x + 3, y + 15, z + 3, hex(0xb5654a, M.BLDG)); S.hip(x - 3, z - 3, x + 3, z + 3, y + 15, 3.5, hex(0x8f3f2c, M.ROOF));
  }
  building(-78, 22, -32, 40, ground(-55, 30), 8, 0xeef3f3, 0x9aa7ad, 0);
  S.box(-77, ground(-55, 30) + 0.5, 21.9, -33, ground(-55, 30) + 7, 22, hex(0x2a4552, M.GLASS));
  for (let x = -2600; x < 4200;) {
    const near = x > -500 && x < 2100, w = near ? rr(18, 44) : rr(20, 60);
    if (abs(x - 520) < 26 || abs(x - 200) < 30 || (valleyF(x + w / 2) > 0.3 && rnd() < 0.7) || rnd() < 0.15) { x += w + rr(10, 30); continue; }
    const z0 = cliffTop(x + w / 2) + rr(10, 26) + (near ? 0 : rr(0, 40)), d = rr(14, 26), y = ground(x + w / 2, z0 + d / 2) - 2;
    const c = pick([0xf3efe4, 0xe9e2d0, 0xfafafa, 0xd9cfbd, 0xc4876a, 0xb8a58c, 0xe4d6b5]);
    const h = pick([9, 12, 15, 18, 21, 24, 27]) + 2, rt = rnd() < 0.35 ? 1 : 0;
    building(x, z0, x + w, z0 + d, y, h, c, rt ? pick([0x7a3f30, 0x55606a, 0x6c4434]) : 0xd0cdc5, rt);
    x += w + rr(8, 28);
  }

  // beach life: umbrellas, windbreaks, towels and sunbathers, busiest near the piers
  rseed(3);
  const NB = 520 * DENS | 0, CLOTH = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffd166, 0x9b5de5, 0xffffff, 0x06d6a0, 0xef476f, 0x118ab2];
  for (let i = 0, tries = 0; i < NB && tries < 20000; tries++) {
    const x = rr(-400, 2040), z = rr(-36, -5);
    const w = 0.25 + exp(-(((x - 30) / 220) ** 2)) + exp(-(((x - BOSC) / 180) ** 2)) * 0.8;
    if (rnd() > w || abs(x) < 9 || abs(x - BOSC) < 6 || GROYNES.some((g) => abs(g - x) < 2.5)) continue;
    i++;
    const y = beachH(z), r = rnd(), a = rr(-0.4, 0.4);
    if (r < 0.3) {
      // parasol
      S.beam([x, y - 0.3, z], [x, y + 2.1, z], 0.025, hex(0xdddddd, M.METAL));
      const c1 = hex(pick(CLOTH), M.CLOTH), c2 = hex(0xffffff, M.CLOTH), R = rr(1, 1.3);
      for (let k = 0; k < 8; k++) { const a0 = k / 8 * TAU, a1 = (k + 1) / 8 * TAU; S.tri([x, y + 2.25, z], [x + cos(a0) * R, y + 1.85, z + sin(a0) * R], [x + cos(a1) * R, y + 1.85, z + sin(a1) * R], k & 1 ? c1 : c2); }
    } else if (r < 0.5) {
      // windbreak: striped panels between poles
      const n = 3 + (rnd() * 3 | 0), ca = cos(a), sa = sin(a), cs = [pick(CLOTH), pick(CLOTH), 0xffffff];
      for (let k = 0; k < n; k++) {
        const px = x + ca * k * 1.1, pz = z + sa * k * 1.1, qx = x + ca * (k + 1) * 1.1, qz = z + sa * (k + 1) * 1.1;
        S.quad([px, y + 0.05, pz], [qx, y + 0.05, qz], [qx, y + 1.25, qz], [px, y + 1.25, pz], hex(cs[k % 3], M.CLOTH));
        S.box(px - 0.03, y - 0.2, pz - 0.03, px + 0.03, y + 1.35, pz + 0.03, hex(0x8a6a48, M.WOOD));
      }
    }
    if (r > 0.25) {
      // towel, sometimes with someone lying or sitting on it
      const tx = x + rr(-1.5, 1.5), tz = z + rr(0.8, 2.5), ty = beachH(tz) + 0.02, c = hex(pick(CLOTH), M.CLOTH);
      S.boxY(tx, ty, tz, 0.9, 0.015, 0.45, a, c);
      if (rnd() < 0.6) sunbather(tx, beachH(tz) + 0.03, tz, a, rnd() < 0.5);
    }
  }
  // lifeguard stations with red-over-yellow flags
  for (const x of [45, 260, BOSC - 40]) {
    const z = -14, y = beachH(z) - 0.3, red = hex(0xd62828, M.CLOTH), yel = hex(0xffcc00, M.CLOTH);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) S.box(x + dx * 1.1 - 0.06, y, z + dz * 1.1 - 0.06, x + dx * 1.1 + 0.06, y + 2.2, z + dz * 1.1 + 0.06, hex(0xe0e0e0, M.METAL));
    S.box(x - 1.3, y + 2.2, z - 1.3, x + 1.3, y + 4.3, z + 1.3, yel, true);
    S.box(x - 1.32, y + 3.2, z - 1.32, x + 1.32, y + 4.0, z + 1.32, hex(0x2a3b46, M.GLASS), true);
    S.hip(x - 1.3, z - 1.3, x + 1.3, z + 1.3, y + 4.3, 0.6, red, 0.2);
    collide(x - 1.3, x + 1.3, z - 1.3, z + 1.3, y, y + 4.6);
    for (const fx of [x - 30, x + 30]) {
      const fy = beachH(-30);
      S.beam([fx, fy - 0.3, -30], [fx, fy + 3.2, -30], 0.03, hex(0xdddddd, M.METAL));
      S.quad([fx, fy + 2.4, -30], [fx + 1.1, fy + 2.4, -30], [fx + 1.1, fy + 2.85, -30], [fx, fy + 2.85, -30], yel);
      S.quad([fx, fy + 2.85, -30], [fx + 1.1, fy + 2.85, -30], [fx + 1.1, fy + 3.2, -30], [fx, fy + 3.2, -30], red);
    }
  }
}
// someone lying (or sitting) on a towel: a few boxes
function sunbather(x, y, z, a, sit) {
  const skin = hex(pick([0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac]), M.SKIN), sw = hex(pick([0xe63946, 0x1d3557, 0x2a9d8f, 0xffb703, 0x111111]), M.CLOTH);
  const c = cos(a), s = sin(a), P = (u, h, v) => [x + c * u - s * v, y + h, z + s * u + c * v];
  if (!sit) {
    S.boxY(...P(-0.55, 0.1, 0), 0.25, 0.1, 0.17, a, skin);
    S.boxY(...P(-0.05, 0.11, 0), 0.25, 0.11, 0.18, a, sw);
    S.boxY(...P(0.35, 0.12, 0), 0.12, 0.1, 0.1, a, skin);
  } else {
    S.boxY(...P(-0.15, 0.1, 0), 0.32, 0.08, 0.17, a, skin);
    S.boxY(...P(0.2, 0.42, 0), 0.11, 0.3, 0.17, a, sw);
    S.boxY(...P(0.2, 0.83, 0), 0.1, 0.11, 0.09, a, skin);
  }
}
// far coasts: Purbeck (Old Harry Rocks, Ballard Down) to the south-west, the Isle of Wight (the Needles) to the
// south-east, the New Forest coast behind Hengistbury Head. Rim points: [x, z, cliff height], in world coordinates.
function island(rim, hc, chalk) {
  let cx = 0, cz = 0; for (const p of rim) { cx += p[0] / rim.length; cz += p[1] / rim.length; }
  const face = hex(chalk ? 0xe9e6dc : 0xa08a62, M.FAR), top = hex(0x6d7f4a, M.FAR), n = rim.length;
  const inset = (p, k) => [p[0] + (cx - p[0]) * k, p[2], p[1] + (cz - p[1]) * k];
  for (let i = 0; i < n; i++) {
    const a = rim[i], b = rim[(i + 1) % n];
    const a0 = [a[0], -6, a[1]], b0 = [b[0], -6, b[1]], a1 = inset(a, 0.012), b1 = inset(b, 0.012), a2 = inset(a, 0.35), b2 = inset(b, 0.35);
    a2[1] = b2[1] = hc * 0.8; a2[1] = mix(a[2], hc, 0.7); b2[1] = mix(b[2], hc, 0.7);
    FAR.quad(a0, b0, b1, a1, face); FAR.quad(a1, b1, b2, a2, top); FAR.tri(a2, b2, [cx, hc, cz], top);
  }
}
function buildFar() {
  island([[-5300, -4200, 4], [-4300, -5800, 6], [-3800, -7000, 12], [-3350, -8000, 35], [-3450, -8300, 30], [-4300, -9000, 70], [-5200, -10200, 40], [-5600, -11600, 60], [-9000, -12600, 90], [-20000, -13500, 120], [-32000, -12000, 120], [-32000, -6000, 60], [-12000, -5200, 30], [-7000, -4300, 6]], 190, true);
  // Old Harry: chalk stacks off the point
  for (const [x, z, h] of [[-3240, -8060, 28], [-3200, -8180, 22], [-3290, -8260, 16]]) FAR.cyl(x, -6, z, 26, 18, h + 6, 6, hex(0xefece2, M.FAR));
  island([[20100, -6000, 30], [20700, -4600, 60], [21800, -2400, 40], [24500, -1300, 20], [32000, 500, 20], [46000, -1000, 30], [48000, -12000, 60], [33000, -14500, 120], [25000, -9800, 130], [21300, -7000, 120]], 160, true);
  // the Needles
  for (const [x, z, h] of [[19800, -6150, 30], [19560, -6290, 26], [19300, -6430, 22]]) FAR.cyl(x, -6, z, 45, 25, h + 6, 5, hex(0xf2f0e8, M.FAR));
  island([[8600, -900, 8], [9600, -300, 10], [12500, 200, 22], [16000, -400, 25], [18500, -2200, 6], [19800, -3600, 3], [20200, -3400, 3], [19500, -1500, 10], [24000, 1500, 20], [24000, 9000, 40], [8600, 9000, 30]], 45, false);
}

// ---------------------------------------------------------------- instanced things
// trees and bushes: (x, y, z, scale), (rotation, tint, squash, kind)
function buildPlants() {
  rseed(4);
  const pines = [], bushes = [];
  const NP = 3200 * DENS | 0, NBu = 14000 * DENS | 0;
  for (let i = 0, t = 0; i < NP && t < NP * 8; t++) {
    const x = rnd() < 0.75 ? rr(-500, 2100) : rr(-3500, 5500), W = cliffW(x), vf = valleyF(x);
    const z = PW + rr(0.15 + vf * 0.4, 1) * (W + 160 + vf * 150);
    if (nearBld(x, z, 4) || (abs(x - 520) < 9 && z < cliffTop(520) + 10) || z < PW + 4) continue;
    const y = ground(x, z), slope = abs(ground(x, z + 2) - ground(x, z - 2)) / 4;
    if (slope > 1.2) continue;
    i++;
    pines.push(x, y - 0.4, z + bend(x), rr(9, 19), rr(0, TAU), rnd(), rr(0.85, 1.15), 0);
    if (abs(x - 800) < 1200) collide(x - 0.3, x + 0.3, z - 0.3, z + 0.3, y - 1, y + 8);
  }
  for (let i = 0, t = 0; i < NBu && t < NBu * 6; t++) {
    const x = rnd() < 0.8 ? rr(-500, 2100) : rr(-3500, 5500), W = cliffW(x);
    const z = PW + 0.6 + rr(0, 1) ** 0.8 * (W + 40);
    if (nearBld(x, z, 1) || (abs(x - 520) < 4.5 && z < cliffTop(520) + 4) || (x > 1500 && x < 1574 && z < 24)) continue;
    i++;
    bushes.push(x, ground(x, z) - 0.15, z + bend(x), rr(0.8, 2.6), rr(0, TAU), rnd(), rr(0.5, 0.8), 1);
  }
  return { pines: new Float32Array(pines), bushes: new Float32Array(bushes) };
}
// walkers on the promenade and along the water's edge: (x0, z, speed, phase), (seed, scale, 0, 0)
function buildPeople() {
  rseed(5);
  const a = [], n = 320 * DENS | 0;
  for (let i = 0; i < n; i++) {
    const beach = rnd() < 0.22, sp = rr(0.9, 1.6) * (rnd() < 0.5 ? -1 : 1), kid = rnd() < 0.12;
    a.push(rr(-260, 1860), beach ? rr(-46, -38) : rr(2.8, 9.8), sp * (kid ? 1.1 : 1), rr(0, TAU), rnd(), kid ? rr(0.55, 0.7) : rr(0.92, 1.1), 0, 0);
  }
  return new Float32Array(a);
}
// gulls circling: (centre x, y, z, radius), (angular speed, phase, scale, 0)
function buildGulls() {
  rseed(6);
  const a = [];
  for (let i = 0; i < 46; i++) { const x = rr(-300, 1900); a.push(x, rr(6, 40), rr(-120, 40) + bend(x), rr(8, 40), rr(0.25, 0.5) * (rnd() < 0.5 ? -1 : 1), rr(0, TAU), rr(0.9, 1.2), 0); }
  return new Float32Array(a);
}
// boats out in the bay: (x0, z, speed, phase), (scale, kind, 0, 0)
function buildBoats() {
  rseed(7);
  const a = [];
  for (let i = 0; i < 16; i++) a.push(rr(-3000, 6000), rr(-3000, -350), rr(1, 3.5) * (rnd() < 0.5 ? -1 : 1), rr(0, TAU), rr(0.8, 1.6), rnd() < 0.7 ? 0 : 1, 0, 0);
  return new Float32Array(a);
}

// ---------------------------------------------------------------- base meshes for the instanced things
// colour alpha = part id (people: 0 head, 1 torso, 2/3 legs, 4/5 arms, 6 hair; trees: 0 trunk, 1 foliage)
function personMesh() {
  const m = new Mesh(false), k = (p) => col(1, 1, 1, p);
  m.box(-0.08, 0, 0.02, 0.08, 0.9, 0.16, k(2)); m.box(-0.08, 0, -0.16, 0.08, 0.9, -0.02, k(3));
  m.box(-0.12, 0.86, -0.2, 0.12, 1.48, 0.2, k(1));
  m.box(-0.06, 0.86, 0.2, 0.06, 1.45, 0.3, k(4)); m.box(-0.06, 0.86, -0.3, 0.06, 1.45, -0.2, k(5));
  m.blob(0, 1.6, 0, 0.11, 0.13, 0.11, k(0), 0.02, 1);
  m.blob(-0.02, 1.67, 0, 0.115, 0.08, 0.115, k(6), 0.05, 1);
  return m.pack();
}
function gullMesh() {
  const m = new Mesh(false), w = col(0.95, 0.95, 0.95, 0), g = col(0.62, 0.65, 0.68, 1), g2 = col(0.62, 0.65, 0.68, 2);
  m.blob(0, 0, 0, 0.24, 0.07, 0.07, w, 0.05, 1);
  m.tri([0.18, 0, 0], [0.26, 0, 0.012], [0.26, 0, -0.012], col(1, 0.8, 0.2, 0));
  m.quad([0.07, 0, 0.04], [-0.07, 0, 0.04], [-0.12, 0, 0.4], [0.02, 0, 0.42], g); m.quad([0.02, 0, 0.42], [-0.12, 0, 0.4], [-0.2, 0, 0.62], [-0.12, 0, 0.64], g);
  m.quad([0.07, 0, -0.04], [0.02, 0, -0.42], [-0.12, 0, -0.4], [-0.07, 0, -0.04], g2); m.quad([0.02, 0, -0.42], [-0.12, 0, -0.64], [-0.2, 0, -0.62], [-0.12, 0, -0.4], g2);
  return m.pack();
}
function boatMesh() {
  const m = new Mesh(false), hull = col(0.95, 0.95, 0.93, 0), dk = col(0.25, 0.3, 0.38, 0), sail = col(0.97, 0.96, 0.92, 1);
  const H = [[4, 0.8, 0], [2, 0.8, 1.3], [-3.5, 0.8, 1.1], [-3.5, 0.8, -1.1], [2, 0.8, -1.3]], B = [[3.4, -0.6, 0], [1.6, -0.6, 0.5], [-3, -0.6, 0.4], [-3, -0.6, -0.4], [1.6, -0.6, -0.5]];
  for (let i = 0; i < 5; i++) { const j = (i + 1) % 5; m.quad(H[i], B[i], B[j], H[j], hull); }
  m.quad(H[1], H[2], H[3], H[4], dk); m.tri(H[0], H[1], H[4], dk);
  m.box(0.6, 0.8, -0.05, 0.7, 11, 0.05, hull);
  m.tri([0.5, 1.4, 0], [0.5, 10.6, 0], [-3.2, 1.4, 0], sail); m.tri([0.8, 1.4, 0], [3.6, 1.0, 0], [0.8, 9.6, 0], sail);
  return m.pack();
}
// a Scots pine: tall bare trunk, a flat, broken crown
function pineMesh() {
  const m = new Mesh(false), tr = col(0.42, 0.27, 0.18, 0), lf = col(1, 1, 1, 1);
  m.cyl(0, 0, 0, 0.03, 0.016, 0.82, 6, tr, false);
  rseed(8);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + rr(-0.4, 0.4), r = rr(0.07, 0.15), y = rr(0.66, 0.86), x = cos(a) * r, z = sin(a) * r;
    m.beam([0, y - 0.08, 0], [x, y, z], 0.008, tr);
    m.blob(x, y + 0.02, z, rr(0.1, 0.15), rr(0.05, 0.07), rr(0.1, 0.15), lf, 0.25, 1);
  }
  m.blob(0, 0.9, 0, 0.13, 0.06, 0.13, lf, 0.25, 1);
  return m.pack();
}
function bushMesh() { const m = new Mesh(false); m.blob(0, 0.35, 0, 0.6, 0.55, 0.6, col(1, 1, 1, 1), 0.28, 1); return m.pack(); }

// ---------------------------------------------------------------- the sea surface: polar grid around the camera
function seaGrid() {
  const R = [], SEG = 160;
  for (let i = 0; i <= 190; i++) R.push(i < 40 ? i * 0.75 : 30 * 1.045 ** (i - 40));
  const v = new Float32Array(R.length * SEG * 2);
  for (let i = 0; i < R.length; i++) for (let s = 0; s < SEG; s++) { const a = s / SEG * TAU, o = (i * SEG + s) * 2; v[o] = cos(a) * R[i]; v[o + 1] = sin(a) * R[i]; }
  const I = new Uint32Array((R.length - 1) * SEG * 6); let q = 0;
  for (let i = 0; i < R.length - 1; i++) for (let s = 0; s < SEG; s++) {
    const a = i * SEG + s, b = i * SEG + (s + 1) % SEG, c = a + SEG, d = b + SEG;
    I[q++] = a; I[q++] = c; I[q++] = b; I[q++] = b; I[q++] = c; I[q++] = d;
  }
  return { vb: v, ib: I };
}

// ---------------------------------------------------------------- places along the way
// [from x, to x, title, text]
const POI = [
  [-80, 60, 'Bournemouth Pier', 'Eröffnet 1880. Hier beginnt der Spaziergang nach Osten – immer am Meer entlang.'],
  [150, 260, 'East Cliff', 'Oben auf der Klippe: die Villa des Russell-Cotes-Museums, erbaut um 1900.'],
  [470, 570, 'East Cliff Lift', 'Die Standseilbahn bringt Spaziergänger seit 1908 die Klippe hinauf.'],
  [700, 900, 'Undercliff Drive', 'Die Promenade am Fuß der Klippen: Kiefern oben, Strandhütten unten.'],
  [1080, 1260, 'Strandhütten', 'Bournemouth gilt als Heimat der ersten städtischen Strandhütte Englands (1909).'],
  [1490, 1575, 'Overstrand', 'Strandhütten auf drei Etagen – Boscombe Pier ist schon ganz nah.'],
  [1575, 1700, 'Boscombe Pier', 'Eröffnet 1889, 2008 neu gestaltet. Ziel erreicht!'],
];
// viewpoints for keys 1-5: [x, z (seafront), yaw, pitch]
const POSES = [
  [24, 5, 1.25, -0.03],
  [15, -296, PI - 0.12, 0.02],
  [505, 7, 2.45, 0.12],
  [900, -32, 1.75, -0.02],
  [BOSC + 1, -205, -1.85, -0.03],
];
