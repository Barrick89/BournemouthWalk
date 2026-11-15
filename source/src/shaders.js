// ============================================================================
// WGSL shaders
// ============================================================================
// Shared by every scene shader: the uniforms, noise, the sky, fog, shadows and lighting.
// Uniform block U (floats): 0 view-projection, 16 shadow matrix, 32 camera + time, 36 direction to the sun +
// shadows on, 40 sun colour + exposure, 44 zenith colour + cloud cover, 48 horizon colour + haze density,
// 52 ground bounce colour, 56 camera right + tan(fov x), 60 camera up + tan(fov y), 64 camera forward + near,
// 68 shadow texel, evening (lamps and lit windows), canvas size
const W_COMMON = /*wgsl*/`
struct U { vp: mat4x4f, sm: mat4x4f, cam: vec4f, sun: vec4f, sunC: vec4f, zen: vec4f, hor: vec4f, gnd: vec4f, cr: vec4f, cu: vec4f, cf: vec4f, misc: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sc: sampler_comparison;
@group(0) @binding(2) var shTex: texture_depth_2d;
const PROM = 2.1;
const PW = 14.0;
// the curve of the bay and the beach profile: the same as bend() and beachH() in world.js
fn bend(x: f32) -> f32 { let t = (x - 800.0) / 900.0; let t2 = t * t; return select(-11.0 * t2, -11.0 * t2 - 2.0 * t2 * t2, t < 0.0); }
fn beachH(z: f32) -> f32 { return max(select((z + 50.0) * 0.045, 1.6 + z * 0.032, z > -50.0), -9.0); }
fn h21(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = (h ^ (h >> 15u)) * 2246822519u; h = h ^ (h >> 13u);
  return f32(h) * 2.3283064e-10;
}
fn vn(p: vec2f) -> f32 {
  let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2f(1.0, 0.0)), f.x), mix(h21(i + vec2f(0.0, 1.0)), h21(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn fbm(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { s += a * vn(q); q = q * 2.03 + vec2f(17.1, 31.7); a *= 0.5; }
  return s / 0.9375;
}
// sky without sun disc and clouds: also the colour of the haze
fn skyBase(d: vec3f) -> vec3f {
  let y = max(d.y, 0.0);
  var c = mix(u.hor.rgb, u.zen.rgb, 1.0 - exp(-y * 3.2));
  let s = max(dot(d, u.sun.xyz), 0.0);
  c += u.sunC.rgb * (0.05 * pow(s, 4.0) + 0.14 * pow(s, 32.0) + 0.4 * pow(s, 500.0));
  return c;
}
fn skyFull(d: vec3f) -> vec3f {
  var c = skyBase(d);
  let s = dot(d, u.sun.xyz);
  c += u.sunC.rgb * 25.0 * smoothstep(0.99985, 0.99992, s);
  if (d.y > 0.0) {
    let q = d.xz / (d.y + 0.04) * 1.1 + u.cam.w * vec2f(0.0035, 0.0012);
    let n = fbm(q * 1.4) * 0.75 + fbm(q * 5.0 + 3.0) * 0.25;
    let cov = u.zen.w;
    let a = smoothstep(1.0 - cov, 1.1 - cov + 0.25, n) * smoothstep(0.0, 0.15, d.y);
    let lit = 0.55 + 0.45 * smoothstep(0.4, 0.9, fbm(q * 2.7 + 9.0 + u.sun.xz * 0.6));
    let cc = (u.sunC.rgb * 0.55 * lit + u.zen.rgb * 0.45 + u.hor.rgb * 0.35) * mix(1.0, 0.72, smoothstep(0.65, 1.0, n));
    c = mix(c, cc + u.sunC.rgb * 0.25 * pow(max(s, 0.0), 12.0), a * 0.92);
  }
  return c;
}
fn fog(c: vec3f, p: vec3f) -> vec3f {
  let d = p - u.cam.xyz; let l = length(d); let dir = d / max(l, 0.001);
  let f = 1.0 - exp(-l * u.hor.w);
  return mix(c, skyBase(vec3f(dir.x, max(dir.y, 0.0) * 0.35, dir.z)), f);
}
fn shadow(p: vec3f, n: vec3f) -> f32 {
  if (u.sun.w < 0.5) { return 1.0; }
  let q = u.sm * vec4f(p + n * 0.05, 1.0);
  let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || q.z > 1.0) { return 1.0; }
  let t = u.misc.x * 0.75; let z = q.z - 0.0004;
  var s = textureSampleCompareLevel(shTex, sc, uv + vec2f(-t, -t), z);
  s += textureSampleCompareLevel(shTex, sc, uv + vec2f(t, -t), z);
  s += textureSampleCompareLevel(shTex, sc, uv + vec2f(-t, t), z);
  s += textureSampleCompareLevel(shTex, sc, uv + vec2f(t, t), z);
  return mix(s * 0.25, 1.0, smoothstep(0.8, 1.0, max(abs(q.x), abs(q.y))));
}
fn lit(b: vec3f, n: vec3f, p: vec3f, spec: f32, shin: f32, wrap: f32) -> vec3f {
  let L = u.sun.xyz;
  let sh = shadow(p, n);
  let ndl = clamp((dot(n, L) + wrap) / (1.0 + wrap), 0.0, 1.0) * sh;
  let amb = mix(u.gnd.rgb, u.zen.rgb * 0.45 + u.hor.rgb * 0.12, n.y * 0.5 + 0.5);
  var c = b * (u.sunC.rgb * ndl + amb);
  if (spec > 0.0) {
    let V = normalize(u.cam.xyz - p); let H = normalize(L + V);
    c += u.sunC.rgb * spec * pow(max(dot(n, H), 0.0), shin) * sh;
  }
  return c;
}
`;

// ---------------------------------------------------------------- sky (fullscreen, drawn first)
const W_SKY = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) q: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
  let p = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  var o: O; o.pos = vec4f(p, 0.0, 1.0); o.q = p; return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let d = normalize(u.cf.xyz + u.cr.xyz * i.q.x * u.cr.w + u.cu.xyz * i.q.y * u.cu.w);
  return vec4f(skyFull(d), 1.0);
}
`;

// ---------------------------------------------------------------- terrain: beach, promenade, cliffs
const W_TERRAIN = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f }
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f) -> O {
  var o: O; o.pos = u.vp * vec4f(p, 1.0); o.wp = p; o.n = n.xyz; return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; let n = normalize(i.n);
  let z = p.z - bend(p.x);
  let dist = distance(p, u.cam.xyz);
  let df = 1.0 - smoothstep(15.0, 140.0, dist);
  let n1 = fbm(p.xz * 0.06);
  let f1 = vn(p.xz * 5.0); let f2 = vn(p.xz * 19.0);
  var b: vec3f; var spec = 0.0; var shin = 40.0;
  let sand = mix(vec3f(0.6, 0.47, 0.31), vec3f(0.7, 0.58, 0.41), n1) * (1.0 + ((f1 - 0.5) * 0.14 + (f2 - 0.5) * 0.1) * df);
  if (z < -0.01 || p.y < 0.6) {
    b = sand;
    // wind ripples on the dry sand, a damp band where the waves reach
    b *= 1.0 + 0.05 * sin(p.x * 2.1 + p.z * 1.3 + vn(p.xz * 0.7) * 6.0) * df * smoothstep(0.5, 1.0, p.y);
    let wet = 1.0 - smoothstep(0.12, 0.5, p.y + (vn(p.xz * 0.3) - 0.5) * 0.12);
    b = mix(b, b * vec3f(0.56, 0.55, 0.55), wet);
    spec = wet * 0.6; shin = 150.0;
    if (p.y < -0.2) { b *= vec3f(0.75, 0.82, 0.8); }
  } else if (z < PW + 0.2 && p.y < PROM + 0.3) {
    // promenade: concrete slabs, a red cycle lane
    let g = vec2f(p.x, z) / vec2f(1.8, 1.2);
    let f = fract(g); let e = min(min(f.x, 1.0 - f.x) * 1.8, min(f.y, 1.0 - f.y) * 1.2);
    b = vec3f(0.5, 0.48, 0.45) * (0.92 + 0.1 * h21(floor(g))) * (0.95 + 0.07 * f1 * df);
    if (z > 6.3 && z < 8.9) {
      b = vec3f(0.42, 0.2, 0.16) * (0.92 + 0.08 * f2 * df);
      let dash = step(0.5, fract(p.x / 3.0));
      let line = 1.0 - smoothstep(0.05, 0.08, abs(z - 7.6));
      b = mix(b, vec3f(0.9), line * dash * df);
    } else { b *= mix(0.8, 1.0, mix(1.0, smoothstep(0.0, 0.03, e), df)); }
    b = mix(b, sand, (1.0 - smoothstep(0.0, 1.6, z)) * 0.35 * (0.5 + f1));
    spec = 0.05; shin = 20.0;
  } else {
    // cliffs: gorse, heather and pines on the slope, bare sandstone where it is steep, grass on the top
    let slope = 1.0 - n.y;
    let veg = mix(vec3f(0.07, 0.12, 0.04), vec3f(0.2, 0.22, 0.08), n1) * (0.75 + 0.5 * vn(p.xz * 0.9) * (0.5 + 0.5 * df));
    let band = vn(vec2f(p.x * 0.05, p.y * 1.3)) * 0.6 + vn(vec2f(p.x * 0.3, p.y * 6.0)) * 0.4;
    let st = mix(vec3f(0.72, 0.5, 0.3), vec3f(0.58, 0.34, 0.19), band) * (0.9 + 0.12 * f2 * df);
    let ex = smoothstep(0.24, 0.4, slope + (fbm(p.xz * 0.045 + 7.0) - 0.5) * 0.9);
    b = mix(veg, st, ex);
    let grass = mix(vec3f(0.14, 0.25, 0.07), vec3f(0.26, 0.33, 0.11), n1) * (0.9 + 0.2 * f1 * df);
    b = mix(b, grass, smoothstep(0.07, 0.025, slope) * smoothstep(PROM + 1.5, PROM + 3.0, p.y));
  }
  return vec4f(fog(lit(b, n, p, spec, shin, 0.0), p), 1.0);
}
`;

// ---------------------------------------------------------------- objects: scenery, plants, people, gulls, boats
const W_OBJ = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) c: vec3f, @location(3) @interpolate(flat) m: u32 }
fn out(wp: vec3f, n: vec3f, c: vec3f, m: u32) -> O { var o: O; o.pos = u.vp * vec4f(wp, 1.0); o.wp = wp; o.n = n; o.c = c; o.m = m; return o; }
fn part(c: vec4f) -> u32 { return u32(round(c.a * 255.0)); }
fn rotY(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c); }

@vertex fn vsMesh(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f) -> O {
  return out(p, n.xyz, c.rgb, part(c));
}
// pines and bushes: ia = position + scale, ib = rotation, tint, squash, kind
@vertex fn vsTree(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> O {
  let leaf = part(c) == 1u; let s = ia.w;
  var q = rotY(p * vec3f(s * ib.z, s, s * ib.z), ib.x);
  if (leaf) { let w = sin(u.cam.w * 1.1 + ia.x * 0.05 + ia.z * 0.03) * 0.015 * q.y; q += vec3f(w, 0.0, w * 0.6); }
  var col = c.rgb;
  var m = 1u;
  if (leaf) {
    m = 12u;
    if (ib.w < 0.5) { col = mix(vec3f(0.11, 0.19, 0.08), vec3f(0.17, 0.25, 0.1), ib.y); }
    else if (ib.y < 0.16) { col = mix(vec3f(0.78, 0.64, 0.1), vec3f(0.35, 0.4, 0.1), ib.y * 4.0); }
    else if (ib.y < 0.26) { col = vec3f(0.36, 0.24, 0.32); }
    else { col = mix(vec3f(0.13, 0.22, 0.08), vec3f(0.3, 0.36, 0.13), ib.y); }
  }
  return out(ia.xyz + q, rotY(n.xyz, ib.x), col, m);
}
// walkers: ia = start x, z, speed, phase; ib = seed, scale
@vertex fn vsPeople(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> O {
  let k = part(c); let t = u.cam.w;
  let d = ia.x + 260.0 + ia.z * t;
  let x = d - floor(d / 2120.0) * 2120.0 - 260.0;
  let ph = ia.w + abs(ia.z) * t * 4.49;
  var q = p; var nn = n.xyz; var piv = 0.0; var a = 0.0;
  if (k == 2u) { piv = 0.88; a = sin(ph) * 0.42; }
  if (k == 3u) { piv = 0.88; a = -sin(ph) * 0.42; }
  if (k == 4u) { piv = 1.42; a = -sin(ph) * 0.32; }
  if (k == 5u) { piv = 1.42; a = sin(ph) * 0.32; }
  if (piv > 0.0) {
    let ca = cos(a); let sa = sin(a); let y = q.y - piv;
    q = vec3f(q.x * ca - y * sa, piv + q.x * sa + y * ca, q.z); nn = vec3f(nn.x * ca - nn.y * sa, nn.x * sa + nn.y * ca, nn.z);
  }
  q.y += abs(cos(ph)) * 0.03;
  q *= ib.y;
  let dir = sign(ia.z); q = vec3f(q.x * dir, q.y, q.z * dir); nn = vec3f(nn.x * dir, nn.y, nn.z * dir);
  let y = select(beachH(ia.y), PROM, ia.y > 0.0);
  var shirt = array<vec3f, 10>(vec3f(0.8, 0.12, 0.12), vec3f(0.1, 0.25, 0.55), vec3f(0.95, 0.95, 0.92), vec3f(0.12, 0.5, 0.35), vec3f(0.95, 0.7, 0.15), vec3f(0.15, 0.15, 0.17), vec3f(0.55, 0.75, 0.9), vec3f(0.85, 0.45, 0.6), vec3f(0.45, 0.3, 0.6), vec3f(0.95, 0.5, 0.25));
  var legs = array<vec3f, 5>(vec3f(0.12, 0.17, 0.3), vec3f(0.2, 0.2, 0.22), vec3f(0.75, 0.68, 0.55), vec3f(0.35, 0.45, 0.6), vec3f(0.85, 0.85, 0.82));
  var skin = array<vec3f, 5>(vec3f(0.95, 0.76, 0.6), vec3f(0.88, 0.67, 0.5), vec3f(0.76, 0.53, 0.35), vec3f(0.55, 0.36, 0.22), vec3f(0.36, 0.22, 0.14));
  var hair = array<vec3f, 5>(vec3f(0.1, 0.07, 0.05), vec3f(0.35, 0.22, 0.12), vec3f(0.75, 0.6, 0.35), vec3f(0.6, 0.6, 0.6), vec3f(0.55, 0.25, 0.1));
  let s = ib.x;
  let sk = skin[u32(fract(s * 7.13) * 5.0)];
  var col = sk; var m = 11u;
  let bare = ia.y < 0.0 && fract(s * 3.7) < 0.5;
  if (k == 1u || k == 4u || k == 5u) { col = select(shirt[u32(fract(s * 13.7) * 10.0)], sk, bare); m = select(10u, 11u, bare); }
  if (k == 2u || k == 3u) { col = select(legs[u32(fract(s * 29.3) * 5.0)], sk, ia.y < 0.0); m = select(10u, 11u, ia.y < 0.0); }
  if (k == 6u) { col = hair[u32(fract(s * 41.9) * 5.0)]; m = 10u; }
  return out(vec3f(x, y, ia.y + bend(x)) + q, nn, col, m);
}
// gulls: ia = centre of the circle + radius, ib = angular speed, phase, scale
@vertex fn vsGull(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> O {
  let k = part(c); let t = u.cam.w;
  let a = ib.y + ib.x * t;
  let pos = ia.xyz + vec3f(cos(a) * ia.w, sin(t * 0.3 + ib.y) * 1.5, sin(a) * ia.w);
  let hd = vec2f(-sin(a), cos(a)) * sign(ib.x);
  var q = p * ib.z * 1.6; var nn = n.xyz;
  if (k > 0u) {
    let f = (sin(t * 6.0 + ib.y * 5.0) * 0.55 + 0.1) * select(-1.0, 1.0, k == 1u);
    let cf = cos(f); let sf = sin(f);
    q = vec3f(q.x, q.y * cf + q.z * sf, q.z * cf - q.y * sf); nn = vec3f(nn.x, nn.y * cf + nn.z * sf, nn.z * cf - nn.y * sf);
  }
  let r = vec3f(q.x * hd.x - q.z * hd.y, q.y, q.x * hd.y + q.z * hd.x);
  let rn = vec3f(nn.x * hd.x - nn.z * hd.y, nn.y, nn.x * hd.y + nn.z * hd.x);
  return out(pos + r, rn, c.rgb, 0u);
}
// boats: ia = start x, world z, speed, phase; ib = scale
@vertex fn vsBoat(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f) -> O {
  let t = u.cam.w;
  let d = ia.x + 4000.0 + ia.z * t;
  let x = d - floor(d / 11000.0) * 11000.0 - 4000.0;
  let dir = sign(ia.z);
  let r = sin(t * 0.7 + ia.w) * 0.06;
  var q = p * ib.x; var nn = n.xyz;
  q = vec3f(q.x, q.y * cos(r) - q.z * sin(r), q.y * sin(r) + q.z * cos(r));
  nn = vec3f(nn.x, nn.y * cos(r) - nn.z * sin(r), nn.y * sin(r) + nn.z * cos(r));
  q = vec3f(q.x * dir, q.y, q.z * dir); nn = vec3f(nn.x * dir, nn.y, nn.z * dir);
  return out(vec3f(x, sin(t * 0.9 + ia.w) * 0.15, ia.y) + q, nn, c.rgb, select(0u, 10u, part(c) == 1u));
}

@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; var n = normalize(i.n);
  let V = u.cam.xyz - p;
  if (dot(n, V) < 0.0) { n = -n; }
  let an = abs(n);
  let fu = select(p.x, p.z, an.x > an.z); // horizontal coordinate along a wall
  var b = i.c; var spec = 0.0; var shin = 32.0; var wrap = 0.0; var emit = vec3f(0.0);
  let vd = normalize(-V);
  let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, -vd)), 5.0);
  switch i.m {
    case 1u: { b *= 0.8 + 0.3 * vn(vec2f(fu * 1.5 + p.y * 0.5, p.y * 9.0 + fu * 3.0)); }
    case 2u: { b *= 0.9 + 0.14 * vn(p.xz * 2.0 + p.y * 2.0); }
    case 3u: {
      if (an.y < 0.5) {
        let g = vec2f(fu / 3.2, (p.y - 0.5) / 3.0); let f = fract(g); let cell = floor(g);
        if (f.x > 0.22 && f.x < 0.78 && f.y > 0.28 && f.y < 0.86) {
          b = vec3f(0.05, 0.06, 0.07); spec = 1.0; shin = 300.0;
          emit = skyBase(reflect(vd, n)) * (0.12 + 0.6 * fres) + vec3f(1.0, 0.72, 0.42) * 1.6 * u.misc.y * step(0.6, h21(cell + vec2f(floor(p.x * 0.05) * 7.0, 0.0)));
        } else if (f.y < 0.1) { b *= 0.85; }
      }
    }
    case 4u: { b *= 0.6; spec = 1.0; shin = 300.0; emit = skyBase(reflect(vd, n)) * (0.1 + 0.6 * fres); }
    case 5u: { emit = b * (0.25 + 4.0 * u.misc.y); }
    case 6u: { spec = 0.35; shin = 50.0; }
    case 7u: { b *= 0.9 + 0.1 * step(0.14, fract(p.y * 7.0)); }
    case 8u: { b *= 0.86 + 0.14 * step(0.25, fract((p.y + fu * 0.0) * 5.0)); }
    case 9u: { b *= 0.85 + 0.3 * vn(p.xz * 0.003); }
    case 10u: { wrap = 0.4; }
    case 11u: { wrap = 0.3; spec = 0.08; shin = 12.0; }
    case 12u: { b *= 0.7 + 0.55 * vn(p.xz * 2.3 + p.y * 3.1); wrap = 0.45; }
    default: {}
  }
  return vec4f(fog(lit(b, n, p, spec, shin, wrap) + emit, p), 1.0);
}
`;

// ---------------------------------------------------------------- the sea: polar grid around the camera
const W_SEA = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f }
fn wv(p: vec2f, t: f32, d: vec2f, L: f32, a: f32, ph: f32) -> vec3f {
  let k = 6.2831853 / L; let w = sqrt(9.81 * k); let x = dot(d, p) * k - w * t + ph;
  let c = cos(x);
  return vec3f(a * sin(x), a * k * c * d.x, a * k * c * d.y);
}
// swell rolling in towards the shore (+z), plus chop
fn waves(p: vec2f, t: f32) -> vec3f {
  return wv(p, t, vec2f(0.12, 0.993), 41.0, 0.16, 0.0) + wv(p, t, vec2f(-0.35, 0.937), 23.0, 0.09, 1.3)
       + wv(p, t, vec2f(0.5, 0.866), 13.0, 0.05, 4.1) + wv(p, t, vec2f(-0.7, 0.714), 8.3, 0.03, 2.2)
       + wv(p, t, vec2f(0.9, 0.436), 5.1, 0.018, 0.7);
}
fn ripples(p: vec2f, t: f32) -> vec2f {
  return (wv(p, t, vec2f(0.8, 0.6), 2.3, 0.012, 0.0) + wv(p, t, vec2f(-0.6, 0.8), 1.7, 0.009, 2.0)
        + wv(p, t, vec2f(0.1, -0.995), 1.1, 0.006, 4.0) + wv(p, t, vec2f(-0.95, -0.3), 0.7, 0.004, 1.0)).yz;
}
// the water level near the beach rises and falls: the wash running up the sand and back
fn swash(x: f32, t: f32, depth: f32) -> f32 {
  let s = 0.11 * sin(t * 0.75 + x * 0.011) + 0.05 * sin(t * 1.21 + x * 0.027 + 1.3);
  return (s + 0.06) * (1.0 - smoothstep(0.5, 3.0, depth));
}
@vertex fn vs(@location(0) o: vec2f) -> O {
  let t = u.cam.w;
  let p = floor(u.cam.xz / 3.0) * 3.0 + o;
  let depth = -beachH(p.y - bend(p.x));
  let amp = clamp(depth / 3.0, 0.0, 1.0) * (1.0 - smoothstep(250.0, 1500.0, length(o)));
  let h = waves(p, t).x * amp + swash(p.x, t, depth);
  var r: O; r.wp = vec3f(p.x, h, p.y); r.pos = u.vp * vec4f(r.wp, 1.0); return r;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; let t = u.cam.w;
  let z = p.z - bend(p.x);
  let depth = -beachH(z);
  let wd = p.y - beachH(z); // water above the sand
  let dist = distance(p, u.cam.xyz);
  let amp = clamp(depth / 3.0, 0.0, 1.0) * (1.0 - smoothstep(250.0, 1500.0, dist));
  var g = waves(p.xz, t).yz * amp + ripples(p.xz, t) * (1.0 - smoothstep(25.0, 350.0, dist));
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  let V = normalize(u.cam.xyz - p);
  let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  let R = reflect(-V, n);
  let refl = skyFull(vec3f(R.x, max(R.y, 0.01), R.z));
  let deep = vec3f(0.012, 0.075, 0.1); let shallow = vec3f(0.07, 0.3, 0.28);
  let body = mix(shallow, deep, smoothstep(0.4, 9.0, wd)) * (u.sunC.rgb * max(u.sun.y, 0.05) * 0.5 + u.zen.rgb * 0.35);
  var c = mix(body, refl, fres);
  let H = normalize(u.sun.xyz + V);
  let sh = shadow(p, vec3f(0.0, 1.0, 0.0));
  c += u.sunC.rgb * sh * (pow(max(dot(n, H), 0.0), 900.0) * 9.0 + pow(max(dot(n, H), 0.0), 90.0) * 0.12);
  // foam: the wash at the water's edge and waves breaking in the shallows
  let fn1 = vn(p.xz * vec2f(1.3, 2.6) + vec2f(t * 0.1, -t * 0.4)) * 0.6 + vn(p.xz * 6.0 + vec2f(0.0, -t)) * 0.4;
  let edge = 1.0 - smoothstep(0.0, 0.05 + 0.12 * fn1, wd);
  let ph = fract(z * 0.075 - t * 0.11 + vn(vec2f(p.x * 0.015, t * 0.03)) * 0.8);
  let brk = pow(ph, 10.0) * smoothstep(2.2, 0.9, depth) * smoothstep(0.1, 0.3, wd);
  let foam = clamp(max(edge * 0.9, brk) * smoothstep(0.25, 0.65, fn1 + max(edge, brk) * 0.35), 0.0, 1.0);
  c = mix(c, lit(vec3f(0.85, 0.88, 0.88), vec3f(0.0, 1.0, 0.0), p, 0.0, 1.0, 0.3), foam);
  let a = max(mix(smoothstep(0.0, 0.5, wd) * 0.88, 1.0, fres), foam) * smoothstep(-0.005, 0.03, wd);
  return vec4f(fog(c, p), a);
}
`;

// ---------------------------------------------------------------- post: exposure, tone map, vignette, dither
const W_POST = /*wgsl*/`
@group(0) @binding(0) var<uniform> e: vec4f;
@group(0) @binding(1) var tx: texture_2d<f32>;
@group(0) @binding(2) var sm: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / e.yz;
  var c = textureSampleLevel(tx, sm, uv, 0.0).rgb * e.x;
  c = aces(c);
  let v = uv - 0.5; c *= 1.0 - dot(v, v) * 0.45;
  c = pow(c, vec3f(1.0 / 2.2));
  let d = fract(sin(dot(fc.xy, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  return vec4f(c + d / 255.0, 1.0);
}
`;
