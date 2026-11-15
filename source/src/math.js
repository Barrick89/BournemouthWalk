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
// Vertex (32 bytes): position (3 x f32), normal (snorm8x4), uv in metres (2 x f32), colour (unorm8x4: rgb tint,
// a = material layer / code), extra (unorm8x4: x mode, y roughness scale, z floors or part, w seed).
// UVs are projected from world space per triangle (walls: along the wall and up; floors: x, z) unless given.
const col = (r, g, b, m = 0) => ((r * 255 + 0.5 | 0) | (g * 255 + 0.5 | 0) << 8 | (b * 255 + 0.5 | 0) << 16 | m << 24) >>> 0;
const hex = (h, m = 0) => col((h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255, m);
const ext = (mode = 0, rough = 0.5, z = 0, w = 0) => ((mode & 255) | (rough * 255 + 0.5 | 0) << 8 | (z & 255) << 16 | (w * 255 + 0.5 | 0) << 24) >>> 0;
const E0 = ext();
const packN = (x, y, z) => { const l = hypot(x, y, z) || 1; return ((x / l * 127 | 0) & 255 | ((y / l * 127 | 0) & 255) << 8 | ((z / l * 127 | 0) & 255) << 16) >>> 0; };
class Mesh {
  constructor() { this.f = []; this.vy = 0; this.uo = 0; this.box3 = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]; }
  get n() { return this.f.length / 8; }
  // one triangle; uv: [u0, v0, u1, v1, u2, v2] or projected
  tri(a, b, c, k, e = E0, uv, nrm) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const N = nrm ? packN(...nrm) : packN(nx, ny, nz);
    let U = uv;
    if (!U) {
      if (abs(ny) > 0.7) U = [a[0], a[2], b[0], b[2], c[0], c[2]];
      else { let tx = -nz, tz = nx; const tl = hypot(tx, tz) || 1; tx /= tl; tz /= tl; const pu = (p) => p[0] * tx + p[2] * tz + this.uo; U = [pu(a), a[1] - this.vy, pu(b), b[1] - this.vy, pu(c), c[1] - this.vy]; }
    }
    const B = this.box3;
    for (let i = 0; i < 3; i++) {
      const p = i === 0 ? a : i === 1 ? b : c;
      this.f.push(p[0], p[1], p[2], N, U[i * 2], U[i * 2 + 1], k, e);
      if (p[0] < B[0]) B[0] = p[0]; if (p[1] < B[1]) B[1] = p[1]; if (p[2] < B[2]) B[2] = p[2];
      if (p[0] > B[3]) B[3] = p[0]; if (p[1] > B[4]) B[4] = p[1]; if (p[2] > B[5]) B[5] = p[2];
    }
  }
  quad(a, b, c, d, k, e, uv) { if (uv) { this.tri(a, b, c, k, e, [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]]); this.tri(a, c, d, k, e, [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]]); } else { this.tri(a, b, c, k, e); this.tri(a, c, d, k, e); } }
  // box from its centre and three half-axis vectors (any orientation)
  boxA(c, ax, ay, az, k, e, noBottom) {
    const P = (i, j, l) => [c[0] + i * ax[0] + j * ay[0] + l * az[0], c[1] + i * ax[1] + j * ay[1] + l * az[1], c[2] + i * ax[2] + j * ay[2] + l * az[2]];
    const p = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
    this.quad(p[0], p[1], p[2], p[3], k, e); this.quad(p[5], p[4], p[7], p[6], k, e);
    this.quad(p[4], p[0], p[3], p[7], k, e); this.quad(p[1], p[5], p[6], p[2], k, e);
    this.quad(p[3], p[2], p[6], p[7], k, e); if (!noBottom) this.quad(p[4], p[5], p[1], p[0], k, e);
  }
  box(x0, y0, z0, x1, y1, z1, k, e, noBottom) { this.boxA([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [(x1 - x0) / 2, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, (z1 - z0) / 2], k, e, noBottom); }
  // box rotated by `a` about the vertical axis
  boxY(cx, cy, cz, hx, hy, hz, a, k, e) { const c = cos(a), s = sin(a); this.boxA([cx, cy, cz], [c * hx, 0, s * hx], [0, hy, 0], [-s * hz, 0, c * hz], k, e); }
  // beam between two points with a square cross-section of half-width r
  beam(a, b, r, k, e) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = hypot(...d);
    const t = abs(d[1]) < 0.9 * l ? [0, 1, 0] : [1, 0, 0];
    let s = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]]; const sl = hypot(...s); s = s.map((v) => v / sl * r);
    let w = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]]; const wl = hypot(...w); w = w.map((v) => v / wl * r);
    this.boxA([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d.map((v) => v / 2), s, w, k, e);
  }
  // vertical (tapered) cylinder, smooth normals
  cyl(x, y, z, r0, r1, h, seg, k, e, cap = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU, c0 = cos(a0), s0 = sin(a0), c1 = cos(a1), s1 = sin(a1), C = 2 * PI * r0;
      const p = [[x + c0 * r0, y, z + s0 * r0], [x + c1 * r0, y, z + s1 * r0], [x + c1 * r1, y + h, z + s1 * r1], [x + c0 * r1, y + h, z + s0 * r1]];
      const uv = [i / seg * C, 0, (i + 1) / seg * C, 0, (i + 1) / seg * C, h, i / seg * C, h];
      this.tri(p[0], p[1], p[2], k, e, [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]], [(c0 + c1) / 2, 0, (s0 + s1) / 2]);
      this.tri(p[0], p[2], p[3], k, e, [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]], [(c0 + c1) / 2, 0, (s0 + s1) / 2]);
      if (cap) this.tri([x, y + h, z], p[3], p[2], k, e);
    }
  }
  // vertical cylinder with an elliptical section (radii rx along x, rz along z at the bottom and top), smooth
  ecyl(x, y, z, rx0, rz0, rx1, rz1, h, seg, k, e) {
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU, c0 = cos(a0), s0 = sin(a0), c1 = cos(a1), s1 = sin(a1);
      const p = [[x + c0 * rx0, y, z + s0 * rz0], [x + c1 * rx0, y, z + s1 * rz0], [x + c1 * rx1, y + h, z + s1 * rz1], [x + c0 * rx1, y + h, z + s0 * rz1]];
      const n0 = [c0 / rx0, 0, s0 / rz0], n1 = [c1 / rx0, 0, s1 / rz0], nm = [(n0[0] + n1[0]) / 2, 0, (n0[2] + n1[2]) / 2];
      this.tri(p[0], p[1], p[2], k, e, undefined, nm); this.tri(p[0], p[2], p[3], k, e, undefined, nm);
    }
  }
  // flat polygon (ring of [x, z], counter-clockwise seen from above) at height y, facing up (or down)
  poly(ring, y, k, e, down) {
    for (const [i, j, l] of earcut(ring)) { const a = [ring[i][0], y, ring[i][1]], b = [ring[j][0], y, ring[j][1]], c = [ring[l][0], y, ring[l][1]]; if (down) this.tri(a, b, c, k, e); else this.tri(a, c, b, k, e); }
  }
  // low-poly blob (subdivided icosahedron, squashed and jittered)
  blob(cx, cy, cz, rx, ry, rz, k, e, jit = 0.15, sub = 1) {
    for (const t of icoTris(sub)) {
      const p = t.map((v) => { const j = 1 + (ihash(v[0] * 97 + v[1] * 31 | 0, v[2] * 57 + 7 | 0) - 0.5) * 2 * jit; return [cx + v[0] * rx * j, cy + v[1] * ry * j, cz + v[2] * rz * j]; });
      this.tri(p[0], p[2], p[1], k, e, undefined, [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]);
    }
  }
  // packs into a vertex buffer
  pack() {
    const f = this.f, n = f.length / 8, b = new ArrayBuffer(n * 32), F = new Float32Array(b), U = new Uint32Array(b);
    for (let i = 0; i < n; i++) { const o = i * 8; F[o] = f[o]; F[o + 1] = f[o + 1]; F[o + 2] = f[o + 2]; U[o + 3] = f[o + 3]; F[o + 4] = f[o + 4]; F[o + 5] = f[o + 5]; U[o + 6] = f[o + 6]; U[o + 7] = f[o + 7]; }
    return b;
  }
}
// ear clipping for simple polygons ([[x, z], ...] counter-clockwise); returns index triples
function earcut(r) {
  const n = r.length, idx = [...Array(n).keys()], out = [];
  let area = 0; for (let i = 0; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) idx.reverse();
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length], a = r[i0], b = r[i1], c = r[i2];
      if (cross(a, b, c) <= 1e-9) continue;
      let ok = true; for (const j of idx) if (j !== i0 && j !== i1 && j !== i2 && inside(r[j], a, b, c)) { ok = false; break; }
      if (!ok) continue;
      out.push([i0, i1, i2]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break; // degenerate: give up on the rest
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
// minimum-area oriented rectangle of a ring: centre, unit axis u (long side), half lengths
function obb(r) {
  let best = null;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]; let ux = b[0] - a[0], uz = b[1] - a[1]; const l = hypot(ux, uz); if (l < 0.3) continue; ux /= l; uz /= l;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const p of r) { const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux; u0 = min(u0, u); u1 = max(u1, u); v0 = min(v0, v); v1 = max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz, u0, u1, v0, v1 } = best, hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  if (hv > hu) { [hu, hv] = [hv, hu]; [ux, uz] = [-uz, ux]; }
  return { cx, cz, ux, uz, hu, hv, A: best.A };
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
