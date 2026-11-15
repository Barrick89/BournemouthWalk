// ============================================================================
// procedural textures, painted on the GPU once at load
// ============================================================================
// MAT: material library, two 2D array textures: albedo (sRGB) and normal.xy + roughness + cavity.
// FOL: foliage cards with alpha (needles, leaves, gorse, grass tufts, heather, shrub leaves).
// NOISE: one tileable 256x256 RGBA noise texture for clouds and large-scale variation.
// Every pattern is periodic over its tile so it repeats without seams.
const L = { SAND: 0, PAVING: 1, ASPHALT: 2, CONCRETE: 3, GRASS: 4, SCRUB: 5, CLIFF: 6, FOREST: 7, GRAVEL: 8, BRICK: 9, RENDER: 10, TILES: 11,
  SLATE: 12, PLANKS: 13, BOARDS: 14, TIMBER: 15, METAL: 16, BARK: 17 };
const NMAT = 18;
// metres covered by one repeat of each material
const MSIZE = [2.5, 3.6, 4, 4, 2.5, 3, 9, 3, 2, 2.4, 4, 2, 2, 2.1, 2, 2, 1, 1.6];
const F = { PINE: 0, LEAF: 1, GORSE: 2, GRASS: 3, HEATHER: 4, SHRUB: 5 };
const NFOL = 6;

const W_TEXGEN = /*wgsl*/`
struct G { layer: u32, size: f32, kind: u32, pad: u32 }
@group(0) @binding(0) var<uniform> g: G;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
fn ih(p: vec2i, s: u32) -> f32 {
  var h = (u32(p.x) * 1597334677u) ^ (u32(p.y) * 3812015801u) ^ (s * 2654435761u);
  h = (h ^ (h >> 15u)) * 2246822519u; h = h ^ (h >> 13u); h = h * 3266489917u; h = h ^ (h >> 16u);
  return f32(h) * 2.3283064e-10;
}
fn wrap(i: vec2f, per: vec2f) -> vec2i { return vec2i(i - floor(i / per) * per); }
// periodic value noise and fbm: p in cells, per = period in cells
fn vn(p: vec2f, per: vec2f, s: u32) -> f32 {
  let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  let a = ih(wrap(i, per), s); let b = ih(wrap(i + vec2f(1.0, 0.0), per), s);
  let c = ih(wrap(i + vec2f(0.0, 1.0), per), s); let d = ih(wrap(i + vec2f(1.0, 1.0), per), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn fbm(uv: vec2f, f0: vec2f, oct: i32, s: u32) -> f32 {
  var a = 0.5; var t = 0.0; var n = 0.0; var f = f0;
  for (var i = 0; i < oct; i++) { t += a * vn(uv * f, f, s + u32(i) * 17u); n += a; a *= 0.5; f *= 2.0; }
  return t / n;
}
// periodic cellular noise: x = distance to nearest point, y = id of that cell, z = second nearest - nearest
fn vor(uv: vec2f, f: vec2f, s: u32, jit: f32) -> vec3f {
  let p = uv * f; let i = floor(p); var d1 = 9.0; var d2 = 9.0; var id = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let c = i + vec2f(f32(x), f32(y)); let w = wrap(c, f);
    let o = c + 0.5 + (vec2f(ih(w, s), ih(w, s + 7u)) - 0.5) * jit;
    let d = length(p - o);
    if (d < d1) { d2 = d1; d1 = d; id = ih(w, s + 3u); } else if (d < d2) { d2 = d; }
  } }
  return vec3f(d1, id, d2 - d1);
}
struct M { c: vec3f, h: f32, r: f32 }
// running-bond bricks / tiles: returns (distance to the joint in units of the brick height, id)
fn bond(uv: vec2f, cols: f32, rows: f32, s: u32) -> vec2f {
  let r = floor(uv.y * rows); let x = uv.x * cols + select(0.0, 0.5, (i32(r) & 1) == 1);
  let cx = floor(x); let fx = fract(x); let fy = fract(uv.y * rows);
  let dx = min(fx, 1.0 - fx) * rows / cols; let dy = min(fy, 1.0 - fy);
  return vec2f(min(dx, dy), ih(wrap(vec2f(cx, r), vec2f(cols, rows)), s));
}
fn mat(l: u32, uv: vec2f) -> M {
  var m: M; m.r = 0.9; m.h = 0.0;
  switch l {
    case 0u: { // sand: fine grain, wind ripples, a few shell fragments and dark grains
      let g = fbm(uv, vec2f(48.0), 3, 1u); let big = fbm(uv, vec2f(3.0), 3, 2u);
      let rip = sin((uv.y * 7.0 + uv.x * 2.0 + fbm(uv, vec2f(3.0), 4, 3u) * 3.5) * 6.2832) * smoothstep(0.35, 0.7, fbm(uv, vec2f(2.0), 3, 5u));
      let sp = ih(vec2i(uv * 300.0), 4u);
      m.c = mix(vec3f(0.46, 0.36, 0.24), vec3f(0.6, 0.49, 0.35), big) * (0.88 + 0.22 * g);
      m.c = select(m.c, m.c * vec3f(0.55, 0.5, 0.48), sp > 0.985);
      m.c = select(m.c, vec3f(0.86, 0.82, 0.74), sp < 0.006);
      m.h = rip * 0.12 + g * 0.6; m.r = 0.93;
    }
    case 1u: { // promenade paving: 0.6 m slabs (6 x 6 per tile), weathered
      let q = uv * 6.0; let cell = floor(q); let f = fract(q); let e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      let id = ih(wrap(cell, vec2f(6.0)), 5u); let n = fbm(uv, vec2f(16.0), 4, 6u);
      m.c = vec3f(0.38, 0.365, 0.34) * (0.86 + 0.22 * id) * (0.85 + 0.25 * n) * mix(0.82, 1.0, fbm(uv, vec2f(4.0), 3, 7u));
      let j = smoothstep(0.004, 0.016, e); m.c *= mix(0.45, 1.0, j); m.h = j * (0.8 + 0.2 * n); m.r = mix(0.95, 0.75, j);
    }
    case 2u: { // asphalt: dark binder with light aggregate
      let a = vor(uv, vec2f(90.0), 8u, 1.0); let n = fbm(uv, vec2f(8.0), 4, 9u);
      let agg = smoothstep(0.35, 0.2, a.x) * step(0.4, a.y);
      m.c = vec3f(0.075, 0.075, 0.08) * (0.8 + 0.4 * n) + vec3f(0.16, 0.155, 0.15) * agg * a.y;
      m.h = agg * 0.6 + n * 0.4; m.r = 0.88 - agg * 0.15;
    }
    case 3u: { // concrete: blotchy grey, pores, a joint at the tile edge
      let n = fbm(uv, vec2f(6.0), 5, 10u); let p = vor(uv, vec2f(120.0), 11u, 1.0);
      m.c = vec3f(0.48, 0.47, 0.44) * (0.82 + 0.3 * n) * mix(0.75, 1.0, smoothstep(0.0, 0.12, p.x));
      let j = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)); m.c *= mix(0.55, 1.0, smoothstep(0.0, 0.003, j));
      m.h = n * 0.5 + smoothstep(0.0, 0.12, p.x) * 0.3; m.r = 0.92;
    }
    case 4u: { // grass: blades as streaks, a few dry patches
      let s1 = fbm(vec2f(uv.x * 4.0, uv.y), vec2f(40.0, 160.0), 3, 12u); let s2 = fbm(vec2f(uv.x, uv.y * 4.0), vec2f(160.0, 40.0), 3, 13u);
      let bl = max(s1, s2); let dry = smoothstep(0.55, 0.75, fbm(uv, vec2f(3.0), 4, 14u));
      m.c = mix(vec3f(0.07, 0.12, 0.03), vec3f(0.2, 0.28, 0.07), bl); m.c = mix(m.c, vec3f(0.36, 0.33, 0.16) * (0.7 + 0.5 * bl), dry * 0.7);
      m.h = bl; m.r = 0.95;
    }
    case 5u: { // heath / scrub ground: litter, twigs, moss
      let n = fbm(uv, vec2f(10.0), 4, 15u); let t = vor(uv, vec2f(40.0), 16u, 1.0);
      m.c = mix(vec3f(0.08, 0.07, 0.04), vec3f(0.11, 0.14, 0.05), n) * (0.8 + 0.4 * t.y);
      m.h = n * 0.6 + smoothstep(0.05, 0.0, t.z) * 0.4; m.r = 0.95;
    }
    case 6u: { // sandstone cliff: horizontal bands (v is vertical), runnels washed down the face
      let band = fbm(vec2f(uv.x * 0.5, uv.y), vec2f(2.0, 22.0), 4, 17u);
      let run = fbm(vec2f(uv.x, uv.y * 0.15), vec2f(36.0, 2.0), 3, 18u);
      let grain = fbm(uv, vec2f(64.0), 2, 19u);
      var c = mix(vec3f(0.66, 0.44, 0.24), vec3f(0.82, 0.7, 0.52), smoothstep(0.35, 0.65, band));
      c = mix(c, vec3f(0.58, 0.3, 0.15), smoothstep(0.62, 0.8, fbm(vec2f(uv.x * 0.3, uv.y), vec2f(1.0, 9.0), 3, 20u)) * 0.7);
      m.c = c * (0.82 + 0.25 * grain) * mix(0.75, 1.05, run);
      m.h = run * 0.7 + band * 0.2 + grain * 0.1; m.r = 0.95;
    }
    case 7u: { // woodland floor: pine needle litter
      let n = fbm(uv, vec2f(8.0), 4, 21u); let a = vor(uv, vec2f(70.0), 22u, 1.0);
      let needle = smoothstep(0.08, 0.0, abs(fract((uv.x * cos(a.y * 6.28) + uv.y * sin(a.y * 6.28)) * 70.0) - 0.5) - 0.42);
      let moss = smoothstep(0.45, 0.65, fbm(uv, vec2f(5.0), 4, 24u));
      m.c = mix(vec3f(0.09, 0.06, 0.035), vec3f(0.19, 0.12, 0.065), n) * (0.75 + 0.45 * needle);
      m.c = mix(m.c, vec3f(0.07, 0.1, 0.035) * (0.8 + 0.4 * n), moss * 0.8);
      m.h = n * 0.5 + needle * 0.5; m.r = 0.96;
    }
    case 8u: { // gravel path
      let p = vor(uv, vec2f(28.0), 23u, 1.0); let s = smoothstep(0.0, 0.25, p.z);
      m.c = mix(vec3f(0.35, 0.32, 0.27), vec3f(0.58, 0.54, 0.46), p.y) * mix(0.5, 1.0, s);
      m.h = s * (1.0 - p.x * 0.6); m.r = 0.85;
    }
    case 9u: { // brick, running bond, 0.225 x 0.075 m courses
      let b = bond(uv, 2.4 / 0.225, 2.4 / 0.075, 24u); let n = fbm(uv, vec2f(32.0), 3, 25u);
      let mortar = smoothstep(0.08, 0.16, b.x);
      let bc = mix(vec3f(0.42, 0.16, 0.08), vec3f(0.55, 0.28, 0.15), b.y) * (0.85 + 0.25 * n);
      m.c = mix(vec3f(0.55, 0.52, 0.47), bc, mortar); m.h = mortar * (0.85 + 0.15 * n); m.r = mix(0.9, 0.82, mortar);
    }
    case 10u: { // render / stucco (tinted by the building colour)
      let n = fbm(uv, vec2f(20.0), 4, 26u); let streak = fbm(vec2f(uv.x, uv.y * 0.2), vec2f(30.0, 1.0), 3, 27u);
      m.c = vec3f(0.84, 0.82, 0.78) * (0.93 + 0.1 * n) * mix(0.85, 1.0, smoothstep(0.3, 0.7, streak));
      m.h = n * 0.3; m.r = 0.9;
    }
    case 11u: { // clay roof tiles
      let b = bond(uv, 8.0, 13.0, 28u); let fy = fract(uv.y * 13.0); let n = fbm(uv, vec2f(16.0), 3, 29u);
      let curve = sin(fract(uv.x * 8.0 + select(0.0, 0.5, (i32(floor(uv.y * 13.0)) & 1) == 1)) * 3.1416);
      m.c = mix(vec3f(0.36, 0.14, 0.08), vec3f(0.5, 0.24, 0.13), b.y) * (0.75 + 0.3 * n) * (0.65 + 0.35 * fy) * (0.85 + 0.15 * curve);
      m.h = fy * 0.6 + curve * 0.3; m.r = 0.72;
    }
    case 12u: { // slate
      let b = bond(uv, 7.0, 12.0, 30u); let fy = fract(uv.y * 12.0); let n = fbm(uv, vec2f(24.0), 3, 31u);
      m.c = vec3f(0.15, 0.16, 0.18) * (0.75 + 0.5 * b.y) * (0.8 + 0.3 * n) * (0.7 + 0.3 * fy);
      m.c *= mix(0.4, 1.0, smoothstep(0.02, 0.06, b.x)); m.h = fy * 0.7 + n * 0.2; m.r = 0.55;
    }
    case 13u: { // pier deck planks (along v), weathered
      let q = uv.x * 15.0; let pl = floor(q); let f = fract(q);
      let off = ih(vec2i(i32(pl), 0), 32u); let e = fract(uv.y * 2.0 + off);
      let grain = fbm(vec2f(uv.x * 15.0, uv.y * 1.5), vec2f(15.0, 3.0), 4, 33u);
      let gap = smoothstep(0.0, 0.07, min(f, 1.0 - f)) * smoothstep(0.0, 0.01, min(e, 1.0 - e));
      m.c = mix(vec3f(0.25, 0.2, 0.15), vec3f(0.42, 0.35, 0.27), ih(vec2i(i32(pl), 1), 34u)) * (0.75 + 0.4 * grain) * mix(0.25, 1.0, gap);
      m.h = gap * (0.85 + 0.15 * grain); m.r = 0.85;
    }
    case 14u: { // painted shiplap boards, horizontal (tinted)
      let q = uv.y * 16.0; let f = fract(q); let n = fbm(uv, vec2f(12.0, 48.0), 3, 35u);
      let wear = smoothstep(0.72, 0.85, fbm(uv, vec2f(8.0), 4, 36u));
      m.c = mix(vec3f(0.86, 0.86, 0.84), vec3f(0.4, 0.32, 0.24), wear * 0.6) * (0.94 + 0.06 * n) * mix(0.55, 1.0, smoothstep(0.0, 0.12, f));
      m.h = f * 0.8 + n * 0.1; m.r = mix(0.5, 0.85, wear);
    }
    case 15u: { // weathered timber
      let grain = fbm(vec2f(uv.x * 0.25, uv.y * 3.0), vec2f(1.0, 24.0), 5, 37u); let crack = vor(vec2f(uv.x, uv.y * 0.2), vec2f(6.0, 2.0), 38u, 1.0);
      m.c = mix(vec3f(0.22, 0.19, 0.15), vec3f(0.45, 0.4, 0.33), grain) * mix(0.45, 1.0, smoothstep(0.0, 0.06, crack.z));
      m.h = grain * 0.6 + smoothstep(0.0, 0.06, crack.z) * 0.4; m.r = 0.9;
    }
    case 16u: { // painted metal (tinted)
      let n = fbm(uv, vec2f(32.0), 3, 39u); let rust = smoothstep(0.78, 0.9, fbm(uv, vec2f(6.0), 4, 40u));
      m.c = mix(vec3f(0.75), vec3f(0.35, 0.18, 0.1), rust) * (0.95 + 0.05 * n); m.h = n * 0.2; m.r = mix(0.35, 0.8, rust);
    }
    default: { // pine bark: plates and deep fissures
      let p = vor(vec2f(uv.x, uv.y * 0.45), vec2f(8.0, 4.0), 41u, 0.9); let n = fbm(uv, vec2f(16.0, 8.0), 3, 42u);
      let fis = smoothstep(0.0, 0.18, p.z);
      m.c = mix(vec3f(0.12, 0.08, 0.06), mix(vec3f(0.42, 0.26, 0.16), vec3f(0.55, 0.36, 0.24), p.y) * (0.8 + 0.3 * n), fis);
      m.h = fis * (0.7 + 0.3 * n); m.r = 0.95;
    }
  }
  return m;
}
struct MO { @location(0) a: vec4f, @location(1) n: vec4f }
@fragment fn fsMat(@builtin(position) fc: vec4f) -> MO {
  let uv = fc.xy / g.size; let e = 1.0 / g.size;
  let m = mat(g.layer, uv); let hx = mat(g.layer, fract(uv + vec2f(e, 0.0))).h; let hy = mat(g.layer, fract(uv + vec2f(0.0, e))).h;
  let k = 0.006 * g.size / 512.0 * 60.0;
  let n = normalize(vec3f((m.h - hx) * k, (m.h - hy) * k, 1.0));
  var o: MO; o.a = vec4f(clamp(m.c, vec3f(0.0), vec3f(1.0)), 1.0); o.n = vec4f(n.xy * 0.5 + 0.5, m.r, m.h); return o;
}

// ---------------------------------------------------------------- foliage cards
// uv: (0,0) top left; the stem enters at the bottom centre. Colour in rgb, coverage in alpha.
fn seg(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
fn leaf(p: vec2f, a: vec2f, dir: vec2f, len: f32, wid: f32) -> f32 {
  let q = p - a; let u = dot(q, dir) / len; let v = (dir.x * q.y - dir.y * q.x) / len;
  if (u < 0.0 || u > 1.0) { return 0.0; }
  let w = sin(u * 3.1416) * wid; return smoothstep(w, w * 0.6, abs(v));
}
@fragment fn fsFol(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = fc.xy / g.size; var a = 0.0; var c = vec3f(0.0); let s = g.layer * 101u;
  switch g.layer {
    case 0u: { // pine: a twig with tufts of long needles
      for (var t = 0; t < 9; t++) {
        let ft = f32(t); let base = vec2f(0.5 + (ih(vec2i(t, 0), s) - 0.5) * 0.25, 0.95 - ft * 0.1);
        for (var k = 0; k < 22; k++) {
          let ang = -1.57 + (ih(vec2i(t, k), s + 1u) - 0.5) * 2.6; let l = 0.12 + ih(vec2i(t, k), s + 2u) * 0.1;
          let b = base + vec2f(cos(ang), sin(ang)) * l;
          let d = seg(p, base, b); let cov = smoothstep(0.006, 0.002, d);
          if (cov > a) { a = cov; c = mix(vec3f(0.06, 0.12, 0.05), vec3f(0.17, 0.27, 0.11), ih(vec2i(t, k), s + 3u)) * (0.75 + 0.25 * (1.0 - length(p - base) / l)); }
        }
      }
      let tw = smoothstep(0.012, 0.006, seg(p, vec2f(0.5, 1.0), vec2f(0.52, 0.12)));
      if (tw > a * 0.5) { a = max(a, tw); c = vec3f(0.25, 0.16, 0.1); }
    }
    case 1u, 5u: { // broadleaf twig (holm oak / sycamore) or shrub (rhododendron): ovate leaves on a stem
      let big = g.layer == 5u; let n = select(26, 14, big);
      for (var k = 0; k < n; k++) {
        let fk = f32(k); let t = fk / f32(n);
        let base = vec2f(0.5 + sin(fk * 2.4) * 0.06, 0.95 - t * 0.85);
        let ang = select(-0.6, -2.5, (k & 1) == 0) + (ih(vec2i(k, 0), s) - 0.5) * 0.9;
        let dir = vec2f(cos(ang), sin(ang)); let l = select(0.17, 0.26, big) * (0.7 + 0.5 * ih(vec2i(k, 1), s));
        let cov = leaf(p, base, dir, l, select(0.26, 0.2, big));
        if (cov > a) { a = cov; let v = ih(vec2i(k, 2), s);
          c = select(mix(vec3f(0.07, 0.15, 0.04), vec3f(0.2, 0.32, 0.08), v), mix(vec3f(0.04, 0.1, 0.04), vec3f(0.1, 0.18, 0.07), v), big);
          let q = p - base; let mid = abs(dir.x * q.y - dir.y * q.x); c *= 0.8 + 0.4 * smoothstep(0.0, 0.02, mid); }
      }
      let st = smoothstep(0.01, 0.005, seg(p, vec2f(0.5, 1.0), vec2f(0.5, 0.1)));
      if (st > a * 0.5) { a = max(a, st); c = vec3f(0.2, 0.15, 0.08); }
    }
    case 2u: { // gorse: spiny green shoots with yellow pea flowers
      for (var k = 0; k < 70; k++) {
        let b = vec2f(0.15 + ih(vec2i(k, 0), s) * 0.7, 0.15 + ih(vec2i(k, 1), s) * 0.8);
        let ang = ih(vec2i(k, 2), s) * 6.2832; let e = b + vec2f(cos(ang), sin(ang)) * 0.06;
        let cov = smoothstep(0.006, 0.002, seg(p, b, e));
        if (cov > a) { a = cov; c = mix(vec3f(0.08, 0.14, 0.05), vec3f(0.16, 0.24, 0.08), ih(vec2i(k, 3), s)); }
        if (ih(vec2i(k, 4), s) > 0.55) { let fl = smoothstep(0.024, 0.014, length(p - e)); if (fl > a * 0.8) { a = max(a, fl); c = vec3f(0.95, 0.72, 0.05) * (0.8 + 0.2 * ih(vec2i(k, 5), s)); } }
      }
    }
    case 3u: { // grass tuft: blades curving up and out from the base
      for (var k = 0; k < 46; k++) {
        let fk = ih(vec2i(k, 0), s); let b = vec2f(0.4 + fk * 0.2, 1.0);
        let lean = (ih(vec2i(k, 1), s) - 0.5) * 0.9; let h = 0.5 + ih(vec2i(k, 2), s) * 0.48;
        let y = (1.0 - p.y) / h; if (y < 0.0 || y > 1.0) { continue; }
        let x = b.x + lean * y * y * 0.5; let w = 0.012 * (1.0 - y);
        let cov = smoothstep(w + 0.002, w, abs(p.x - x));
        if (cov > a) { a = cov; c = mix(vec3f(0.08, 0.14, 0.03), vec3f(0.3, 0.38, 0.1), y * 0.6 + ih(vec2i(k, 3), s) * 0.4);
          c = mix(c, vec3f(0.45, 0.4, 0.2), step(0.85, ih(vec2i(k, 4), s)) * y); }
      }
    }
    default: { // heather: fine twigs with purple bells
      for (var k = 0; k < 90; k++) {
        let b = vec2f(0.1 + ih(vec2i(k, 0), s) * 0.8, 0.25 + ih(vec2i(k, 1), s) * 0.75);
        let e = b + vec2f((ih(vec2i(k, 2), s) - 0.5) * 0.06, -0.08 - ih(vec2i(k, 3), s) * 0.1);
        let cov = smoothstep(0.005, 0.002, seg(p, b, e));
        if (cov > a) { a = cov; c = mix(vec3f(0.12, 0.13, 0.06), vec3f(0.2, 0.22, 0.1), ih(vec2i(k, 4), s)); }
        let fl = smoothstep(0.016, 0.008, length(p - e));
        if (fl > a * 0.8) { a = max(a, fl); c = mix(vec3f(0.42, 0.2, 0.42), vec3f(0.6, 0.35, 0.6), ih(vec2i(k, 5), s)); }
      }
    }
  }
  // round the card off so a crown of cards reads as soft clumps, not squares
  if (g.layer != 3u) { a *= smoothstep(0.52, 0.36, length((p - vec2f(0.5, 0.55)) * vec2f(1.0, 0.9))); }
  return vec4f(c, a);
}
@fragment fn fsNoise(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 256.0;
  return vec4f(fbm(uv, vec2f(4.0), 5, 50u), fbm(uv, vec2f(8.0), 5, 51u), 1.0 - min(vor(uv, vec2f(6.0), 52u, 1.0).x, 1.0), fbm(uv, vec2f(32.0), 3, 53u));
}
// mip maps: 2x2 box filter (alpha-weighted for foliage so the edges do not darken)
@group(0) @binding(1) var src: texture_2d<f32>;
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy) * 2;
  let a = textureLoad(src, p, 0); let b = textureLoad(src, p + vec2i(1, 0), 0); let c = textureLoad(src, p + vec2i(0, 1), 0); let d = textureLoad(src, p + vec2i(1, 1), 0);
  if (g.kind == 1u) {
    let w = a.a + b.a + c.a + d.a;
    let rgb = select((a.rgb + b.rgb + c.rgb + d.rgb) * 0.25, (a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) / w, w > 0.001);
    return vec4f(rgb, min(1.0, w * 0.25 * 1.1)); // keep thin needles visible a little further away
  }
  var m = (a + b + c + d) * 0.25;
  if (g.kind == 2u) { let n = normalize(vec3f(m.xy * 2.0 - 1.0, 0.5)); m = vec4f(n.xy * 0.5 + 0.5, m.z, m.w); }
  return m;
}
`;

// Paints every layer and its mips. Returns the GPU textures.
function makeTextures(device, size) {
  const TU = GPUTextureUsage, Q = device.queue;
  const mips = (s) => floor(Math.log2(s)) + 1;
  const tex = (format, layers, s) => device.createTexture({ size: [s, s, layers], format, mipLevelCount: mips(s), usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT, dimension: '2d' });
  const matA = tex('rgba8unorm-srgb', NMAT, size), matN = tex('rgba8unorm', NMAT, size), fol = tex('rgba8unorm-srgb', NFOL, 512);
  const noise = device.createTexture({ size: [256, 256], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT });
  const m = device.createShaderModule({ code: W_TEXGEN });
  const ub = device.createBuffer({ size: 64 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { hasDynamicOffset: true } }] });
  const bglM = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { hasDynamicOffset: true } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }] });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl] }), plM = device.createPipelineLayout({ bindGroupLayouts: [bglM] });
  const P = (fs, targets, layout = pl) => device.createRenderPipeline({ layout, vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: fs, targets: targets.map((format) => ({ format })) } });
  const pMat = P('fsMat', ['rgba8unorm-srgb', 'rgba8unorm']), pFol = P('fsFol', ['rgba8unorm-srgb']), pNoise = P('fsNoise', ['rgba8unorm']);
  const pMip = { 'rgba8unorm-srgb': P('fsMip', ['rgba8unorm-srgb'], plM), 'rgba8unorm': P('fsMip', ['rgba8unorm'], plM) };
  const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }] });
  // uniforms for every draw, at 256-byte steps
  const U = new ArrayBuffer(64 * 256), Uu = new Uint32Array(U), Uf = new Float32Array(U); let slot = 0;
  const uni = (layer, s, kind) => { const o = slot * 64; Uu[o] = layer; Uf[o + 1] = s; Uu[o + 2] = kind; return (slot++) * 256; };
  const e = device.createCommandEncoder();
  const view = (t, layer, level = 0) => t.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
  const pass = (pipe, views, off, s) => { const r = e.beginRenderPass({ colorAttachments: views.map((v) => ({ view: v, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] })) }); r.setPipeline(pipe); r.setBindGroup(0, bg, [off]); r.draw(3); r.end(); };
  const offs = [];
  for (let l = 0; l < NMAT; l++) { const o = uni(l, size, 0); offs.push(o); pass(pMat, [view(matA, l), view(matN, l)], o, size); }
  for (let l = 0; l < NFOL; l++) pass(pFol, [view(fol, l)], uni(l, 512, 0), 512);
  pass(pNoise, [noise.createView()], uni(0, 256, 0), 256);
  // mip chains
  const mipOff = [uni(0, 0, 0), uni(0, 0, 1), uni(0, 0, 2)];
  const chain = (t, layers, s, fmt, kind) => {
    for (let l = 0; l < layers; l++) for (let lv = 1; lv < mips(s); lv++) {
      const b = device.createBindGroup({ layout: bglM, entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }, { binding: 1, resource: view(t, l, lv - 1) }] });
      const r = e.beginRenderPass({ colorAttachments: [{ view: view(t, l, lv), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      r.setPipeline(pMip[fmt]); r.setBindGroup(0, b, [mipOff[kind]]); r.draw(3); r.end();
    }
  };
  Q.writeBuffer(ub, 0, U);
  chain(matA, NMAT, size, 'rgba8unorm-srgb', 0); chain(matN, NMAT, size, 'rgba8unorm', 2); chain(fol, NFOL, 512, 'rgba8unorm-srgb', 1);
  Q.submit([e.finish()]);
  return { matA, matN, fol, noise };
}
