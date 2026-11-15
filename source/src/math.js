// ============================================================================
// math + procedural helpers (load-time only unless noted)
// ============================================================================
const { sin, cos, sqrt, min, max, abs, floor, PI, pow, atan2, hypot, exp, round, sign } = Math;
const TAU = PI * 2;
let _seed = 1880; // the year Bournemouth Pier opened
const rnd = () => {
  _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rr = (a, b) => a + (b - a) * rnd();
const pick = (a) => a[rnd() * a.length | 0];
// each generator system starts its own random stream, so the systems stay independent
const rseed = (s) => { _seed = (1880 + Math.imul(s, 7919)) | 0; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

const ihash = (x, y) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vnoise = (x, y) => {
  const ix = floor(x), iy = floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  return mix(mix(ihash(ix, iy), ihash(ix + 1, iy), fx), mix(ihash(ix, iy + 1), ihash(ix + 1, iy + 1), fx), fy);
};
// fractal noise in [0, 1]
const fbm = (x, y, o = 4) => {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < o; i++) { s += a * vnoise(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 31.7; a *= 0.5; }
  return s / n;
};

// ---------------------------------------------------------------- mesh builder
// Vertex: position (3 x f32), normal (snorm8x4), colour (unorm8x4, alpha = material or part id): 20 bytes.
// `warp` meshes are built in seafront coordinates (x along the promenade, z = distance inland) and bent onto the
// curve of the bay as they are packed: z_world = z + bend(x) (see world.js).
const col = (r, g, b, m = 0) => ((r * 255 + 0.5 | 0) | (g * 255 + 0.5 | 0) << 8 | (b * 255 + 0.5 | 0) << 16 | m << 24) >>> 0;
const hex = (h, m = 0) => col((h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255, m);
const packN = (x, y, z) => { const l = hypot(x, y, z) || 1; return ((x / l * 127 | 0) & 255 | ((y / l * 127 | 0) & 255) << 8 | ((z / l * 127 | 0) & 255) << 16) >>> 0; };
class Mesh {
  constructor(warp) { this.f = []; this.warp = warp; }
  get n() { return this.f.length / 5; }
  tri(a, b, c, k) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n = packN(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    this.f.push(a[0], a[1], a[2], n, k, b[0], b[1], b[2], n, k, c[0], c[1], c[2], n, k);
  }
  quad(a, b, c, d, k) { this.tri(a, b, c, k); this.tri(a, c, d, k); }
  // box from its centre and three half-axis vectors (any orientation)
  boxA(c, ax, ay, az, k, noBottom) {
    const P = (i, j, l) => [c[0] + i * ax[0] + j * ay[0] + l * az[0], c[1] + i * ax[1] + j * ay[1] + l * az[1], c[2] + i * ax[2] + j * ay[2] + l * az[2]];
    const p = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
    this.quad(p[0], p[1], p[2], p[3], k); this.quad(p[5], p[4], p[7], p[6], k);
    this.quad(p[4], p[0], p[3], p[7], k); this.quad(p[1], p[5], p[6], p[2], k);
    this.quad(p[3], p[2], p[6], p[7], k); if (!noBottom) this.quad(p[4], p[5], p[1], p[0], k);
  }
  // axis-aligned box from two corners
  box(x0, y0, z0, x1, y1, z1, k, noBottom) {
    this.boxA([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [(x1 - x0) / 2, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, (z1 - z0) / 2], k, noBottom);
  }
  // box rotated by `a` about the vertical axis
  boxY(cx, cy, cz, hx, hy, hz, a, k) { const c = cos(a), s = sin(a); this.boxA([cx, cy, cz], [c * hx, 0, s * hx], [0, hy, 0], [-s * hz, 0, c * hz], k); }
  // beam between two points with a square cross-section of half-width r
  beam(a, b, r, k) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = hypot(...d);
    const t = abs(d[1]) < 0.9 * l ? [0, 1, 0] : [1, 0, 0];
    let s = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]]; const sl = hypot(...s); s = s.map((v) => v / sl * r);
    let w = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]]; const wl = hypot(...w); w = w.map((v) => v / wl * r);
    this.boxA([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d.map((v) => v / 2), s, w, k);
  }
  // vertical (tapered) cylinder
  cyl(x, y, z, r0, r1, h, seg, k, cap = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU, c0 = cos(a0), s0 = sin(a0), c1 = cos(a1), s1 = sin(a1);
      this.quad([x + c0 * r0, y, z + s0 * r0], [x + c1 * r0, y, z + s1 * r0], [x + c1 * r1, y + h, z + s1 * r1], [x + c0 * r1, y + h, z + s0 * r1], k);
      if (cap) this.tri([x, y + h, z], [x + c0 * r1, y + h, z + s0 * r1], [x + c1 * r1, y + h, z + s1 * r1], k);
    }
  }
  // gabled roof over [x0,x1] x [z0,z1] starting at height y, ridge `h` higher, running along z (alongZ) or x
  roof(x0, z0, x1, z1, y, h, k, alongZ, over = 0.15) {
    x0 -= over; x1 += over; z0 -= over; z1 += over;
    if (alongZ) {
      const xm = (x0 + x1) / 2;
      this.quad([x0, y, z0], [xm, y + h, z0], [xm, y + h, z1], [x0, y, z1], k); this.quad([x1, y, z0], [x1, y, z1], [xm, y + h, z1], [xm, y + h, z0], k);
      this.tri([x0, y, z0], [x1, y, z0], [xm, y + h, z0], k); this.tri([x0, y, z1], [xm, y + h, z1], [x1, y, z1], k);
    } else {
      const zm = (z0 + z1) / 2;
      this.quad([x0, y, z0], [x1, y, z0], [x1, y + h, zm], [x0, y + h, zm], k); this.quad([x0, y, z1], [x0, y + h, zm], [x1, y + h, zm], [x1, y, z1], k);
      this.tri([x0, y, z0], [x0, y + h, zm], [x0, y, z1], k); this.tri([x1, y, z0], [x1, y, z1], [x1, y + h, zm], k);
    }
  }
  // hipped roof (a pyramid when square)
  hip(x0, z0, x1, z1, y, h, k, over = 0.3) {
    x0 -= over; x1 += over; z0 -= over; z1 += over;
    const w = x1 - x0, d = z1 - z0, i = min(w, d) / 2, xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
    const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], e = [x0, y, z1];
    const r0 = w >= d ? [x0 + i, y + h, zm] : [xm, y + h, z0 + i], r1 = w >= d ? [x1 - i, y + h, zm] : [xm, y + h, z1 - i];
    if (w >= d) { this.quad(a, b, r1, r0, k); this.quad(c, e, r0, r1, k); this.tri(e, a, r0, k); this.tri(b, c, r1, k); }
    else { this.quad(b, c, r1, r0, k); this.quad(e, a, r0, r1, k); this.tri(a, b, r0, k); this.tri(c, e, r1, k); }
  }
  // low-poly blob (subdivided icosahedron, squashed and jittered) - used for tree crowns, bushes, heads
  blob(cx, cy, cz, rx, ry, rz, k, jit = 0.15, sub = 1) {
    for (const t of icoTris(sub)) {
      const p = t.map((v) => { const j = 1 + (ihash(v[0] * 97 + v[1] * 31 | 0, v[2] * 57 + 7 | 0) - 0.5) * 2 * jit; return [cx + v[0] * rx * j, cy + v[1] * ry * j, cz + v[2] * rz * j]; });
      this.tri(p[0], p[2], p[1], k);
    }
  }
  pack() {
    const f = this.f, n = f.length / 5, b = new ArrayBuffer(n * 20), F = new Float32Array(b), U = new Uint32Array(b);
    for (let i = 0; i < n; i++) {
      const o = i * 5, x = f[o];
      F[o] = x; F[o + 1] = f[o + 1]; F[o + 2] = f[o + 2] + (this.warp ? bend(x) : 0); U[o + 3] = f[o + 3]; U[o + 4] = f[o + 4];
    }
    return b;
  }
}
// unit icosphere triangles, `sub` times subdivided (cached)
const _ico = [];
function icoTris(sub) {
  if (_ico[sub]) return _ico[sub];
  const t = (1 + sqrt(5)) / 2, V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => { const l = hypot(...v); return v.map((c) => c / l); });
  let T = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]].map((f) => f.map((i) => V[i]));
  for (let s = 0; s < sub; s++) {
    const m = (a, b) => { const v = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], l = hypot(...v); return v.map((c) => c / l); };
    T = T.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  return (_ico[sub] = T);
}
