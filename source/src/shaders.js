// ============================================================================
// WGSL shaders
// ============================================================================
// Uniform block U (floats): 0 view-projection | 16 camera + time | 20 direction to the sun + cloud cover |
// 24 haze, wetness, evening, exposure | 28 camera right + tan x | 32 camera up + tan y | 36 forward + near |
// 40 screen size, 1/size | 44 wind, ... | 48 cascade matrices (3 x 16) | 96 cascade far distances + texel size
// Bind group 0 is shared by every scene shader (see main.js).
const W_COMMON = /*wgsl*/`
diagnostic(off, derivative_uniformity);
struct U { vp: mat4x4f, cam: vec4f, sun: vec4f, env: vec4f, cr: vec4f, cu: vec4f, cf: vec4f, scr: vec4f, wind: vec4f,
  csm: array<mat4x4f, 3>, split: vec4f, pad: array<vec4f, 3> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var scmp: sampler_comparison;
@group(0) @binding(2) var shadowTex: texture_depth_2d_array;
@group(0) @binding(3) var srep: sampler;
@group(0) @binding(4) var matA: texture_2d_array<f32>;
@group(0) @binding(5) var matN: texture_2d_array<f32>;
@group(0) @binding(6) var folT: texture_2d_array<f32>;
@group(0) @binding(7) var skyLut: texture_2d<f32>;
@group(0) @binding(8) var hDet: texture_2d<f32>;
@group(0) @binding(9) var hCoa: texture_2d<f32>;
@group(0) @binding(10) var mDet: texture_2d<u32>;
@group(0) @binding(11) var mCoa: texture_2d<u32>;
@group(0) @binding(12) var noiseT: texture_2d<f32>;
@group(0) @binding(13) var sclamp: sampler;
@group(0) @binding(14) var ambT: texture_2d<f32>;
const PI = 3.14159265;
// terrain grids (tools/build_world.py)
const GD0 = vec2f(-448.0, -324.0); const GDD = 3.0; const GDN = vec2f(1065.0, 329.0);
const GC0 = vec2f(-2200.0, -1300.0); const GCD = 8.0; const GCN = vec2f(826.0, 351.0);
const MSIZE = array<f32, 18>(2.5, 3.6, 4.0, 4.0, 2.5, 3.0, 9.0, 3.0, 2.0, 2.4, 4.0, 2.0, 2.0, 2.1, 2.0, 2.0, 1.0, 1.6);

fn h21(p: vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 1597334677u) ^ (q.y * 3812015801u); h = (h ^ (h >> 15u)) * 2246822519u; h = h ^ (h >> 13u);
  return f32(h) * 2.3283064e-10;
}
// tileable noise texture: r fbm(4), g fbm(8), b cells, a fine
fn nz(p: vec2f) -> vec4f { return textureSampleLevel(noiseT, srep, p, 0.0); }
fn nzg(p: vec2f) -> vec4f { return textureSample(noiseT, srep, p); }
fn bil(t: texture_2d<f32>, q: vec2f, n: vec2f) -> f32 {
  let c = clamp(q, vec2f(0.0), n - 1.001); let i = vec2i(floor(c)); let f = c - floor(c);
  let a = textureLoad(t, i, 0).r; let b = textureLoad(t, i + vec2i(1, 0), 0).r;
  let d = textureLoad(t, i + vec2i(0, 1), 0).r; let e = textureLoad(t, i + vec2i(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
fn inDet(p: vec2f) -> bool { let q = (p - GD0) / GDD; return q.x > 0.0 && q.y > 0.0 && q.x < GDN.x - 1.0 && q.y < GDN.y - 1.0; }
fn terrainH(p: vec2f) -> f32 {
  if (inDet(p)) { return bil(hDet, (p - GD0) / GDD, GDN); }
  return bil(hCoa, (p - GC0) / GCD, GCN);
}
// surface class at a point (nearest texel of the detail mask at 1.5 m, else the coarse one at 8 m)
fn maskAt(p: vec2f) -> u32 {
  if (inDet(p)) { let q = vec2i(floor((p - GD0) / 1.5 + 1.0)); return textureLoad(mDet, clamp(q, vec2i(0), vec2i(2129, 657)), 0).r; }
  let q = vec2i(round((p - GC0) / GCD)); return textureLoad(mCoa, clamp(q, vec2i(0), vec2i(825, 350)), 0).r;
}

// ---------------------------------------------------------------- the atmosphere
// Rayleigh + Mie + ozone single scattering over a spherical Earth, the sky radiance kept in a lat-long table
// (skyLut, rebuilt each frame) and the ambient light and sun colour in ambT (8 x 1).
const RE = 6360000.0; const RA = 6460000.0;
const BR = vec3f(5.802e-6, 13.558e-6, 33.1e-6); const BMS = 3.996e-6; const BME = 4.44e-6; const BO = vec3f(0.65e-6, 1.881e-6, 0.085e-6);
const ESUN = 22.0;
fn dens(h: f32) -> vec3f {
  // coastal haze: extra Mie particles in the lowest few hundred metres
  return vec3f(exp(-h / 8000.0), exp(-h / 1200.0) + u.env.x * exp(-h / 350.0), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}
fn ext(d: vec3f) -> vec3f { return BR * d.x + vec3f(BME) * d.y + BO * d.z; }
fn rayTop(o: vec3f, d: vec3f) -> f32 { let b = dot(o, d); let c = dot(o, o) - RA * RA; return -b + sqrt(max(b * b - c, 0.0)); }
fn rayGround(o: vec3f, d: vec3f) -> f32 { let b = dot(o, d); let c = dot(o, o) - RE * RE; let k = b * b - c; if (k < 0.0 || b > 0.0) { return -1.0; } return -b - sqrt(k); }
fn transm(o: vec3f, d: vec3f) -> vec3f {
  if (rayGround(o, d) > 0.0) { return vec3f(0.0); }
  let t = rayTop(o, d); var od = vec3f(0.0); let n = 10.0;
  for (var i = 0.5; i < n; i += 1.0) { let p = o + d * (t * i / n); od += ext(dens(length(p) - RE)); }
  return exp(-od * t / n);
}
fn phaseR(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseM(c: f32) -> f32 { let g = 0.8; let k = 1.0 + g * g - 2.0 * g * c; return (1.0 - g * g) / (4.0 * PI * k * sqrt(k)); }
// radiance arriving from direction d at a viewer 20 m above the sea
fn skyRadiance(d: vec3f) -> vec3f {
  let o = vec3f(0.0, RE + 20.0, 0.0); let L = u.sun.xyz;
  var tmax = rayTop(o, d); let tg = rayGround(o, d); if (tg > 0.0) { tmax = tg; }
  let n = 24.0; var T = vec3f(1.0); var sum = vec3f(0.0); let c = dot(d, L);
  var tPrev = 0.0;
  for (var i = 0.0; i < n; i += 1.0) {
    let t = tmax * pow((i + 0.5) / n, 2.0); let dt = t - tPrev; tPrev = t;
    let p = o + d * t; let h = length(p) - RE; let de = dens(h);
    let e = ext(de); let ts = transm(p, L);
    sum += T * ts * (BR * de.x * phaseR(c) + vec3f(BMS) * de.y * phaseM(c)) * dt;
    T *= exp(-e * dt);
  }
  // single scattering misses roughly half the light of a hazy sky; multiple scattering lifts it evenly
  return sum * ESUN * 2.1;
}
// lat-long table: u = azimuth, v = elevation (more rows near the horizon)
fn lutUV(d: vec3f) -> vec2f {
  let el = asin(clamp(d.y, -1.0, 1.0)); let az = atan2(d.z, d.x);
  return vec2f(az / (2.0 * PI) + 0.5, 0.5 - 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)));
}
fn lutDir(uv: vec2f) -> vec3f {
  let az = (uv.x - 0.5) * 2.0 * PI; let s = (0.5 - uv.y) * 2.0; let el = sign(s) * s * s * 0.5 * PI;
  return vec3f(cos(el) * cos(az), sin(el), cos(el) * sin(az));
}
fn sky(d: vec3f) -> vec3f { return textureSampleLevel(skyLut, sclamp, lutUV(d), 0.0).rgb; }
fn sunE() -> vec3f { return textureLoad(ambT, vec2i(6, 0), 0).rgb; }
// diffuse sky light for a normal (ambient cube)
fn ambient(n: vec3f) -> vec3f {
  let w = n * n;
  let x = select(textureLoad(ambT, vec2i(1, 0), 0).rgb, textureLoad(ambT, vec2i(0, 0), 0).rgb, n.x > 0.0);
  let y = select(textureLoad(ambT, vec2i(3, 0), 0).rgb, textureLoad(ambT, vec2i(2, 0), 0).rgb, n.y > 0.0);
  let z = select(textureLoad(ambT, vec2i(5, 0), 0).rgb, textureLoad(ambT, vec2i(4, 0), 0).rgb, n.z > 0.0);
  return x * w.x + y * w.y + z * w.z;
}
// light lost and light gained between the camera and a point (aerial perspective)
fn aerial(c: vec3f, p: vec3f) -> vec3f {
  let v = p - u.cam.xyz; let l = length(v); let d = v / max(l, 0.001);
  let e = ext(dens(max(u.cam.y, 0.0) + max(d.y, 0.0) * min(l, 2000.0) * 0.5));
  let T = exp(-e * l);
  let hz = sky(normalize(vec3f(d.x, max(d.y, 0.0) * 0.5 + 0.002, d.z)));
  return c * T + hz * (1.0 - T);
}
// clouds: one layer at 1600 m, drifting with the wind
fn cloudDens(xz: vec2f) -> f32 {
  let q = xz / 9000.0 + u.wind.xy * u.cam.w * 0.00004;
  let n = nz(q).r * 0.7 + nz(q * 3.1 + 0.37).g * 0.3;
  return smoothstep(1.0 - u.sun.w, 1.0 - u.sun.w + 0.28, n);
}
fn cloudShadow(p: vec3f) -> f32 {
  let L = u.sun.xyz; let t = (1600.0 - p.y) / max(L.y, 0.05);
  return 1.0 - 0.65 * cloudDens(p.xz + L.xz * t);
}

// ---------------------------------------------------------------- shadows: three cascades
fn shadowAt(p: vec3f, n: vec3f) -> f32 {
  let vd = dot(p - u.cam.xyz, u.cf.xyz);
  var ci = 0; if (vd > u.split.x) { ci = 1; } if (vd > u.split.y) { ci = 2; } if (vd > u.split.z) { return 1.0; }
  let texel = u.split.w * f32(1 << u32(ci)) * 2.5;
  let q = u.csm[ci] * vec4f(p + n * texel * (0.6 + f32(ci) * 0.6), 1.0);
  let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || q.z > 1.0) { return 1.0; }
  let t = 1.0 / f32(textureDimensions(shadowTex).x); var s = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    s += textureSampleCompareLevel(shadowTex, scmp, uv + vec2f(f32(x), f32(y)) * t * 1.2, ci, q.z - 0.0003 * f32(ci + 1));
  } }
  s /= 9.0;
  // fade out at the far end of the last cascade
  return mix(s, 1.0, smoothstep(u.split.z * 0.85, u.split.z, vd));
}

// ---------------------------------------------------------------- lighting (GGX microfacets + sky)
struct S { base: vec3f, n: vec3f, rough: f32, metal: f32, ao: f32, trans: f32, emit: vec3f }
fn ggx(nh: f32, a: f32) -> f32 { let a2 = a * a; let d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
fn visSmith(nv: f32, nl: f32, a: f32) -> f32 { let k = a * 0.5; return 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k)); }
fn envSpec(r: vec3f, rough: f32, n: vec3f) -> vec3f {
  var c = sky(vec3f(r.x, max(r.y, 0.02), r.z));
  if (r.y < 0.0) { c = mix(c, ambient(vec3f(0.0, -1.0, 0.0)) * 0.6, smoothstep(0.0, -0.2, r.y)); }
  return mix(c, ambient(n), smoothstep(0.2, 0.75, rough));
}
fn shade(s: S, p: vec3f) -> vec3f {
  let V = normalize(u.cam.xyz - p); let L = u.sun.xyz; let n = s.n;
  let nl = max(dot(n, L), 0.0); let nv = max(dot(n, V), 0.001); let H = normalize(L + V); let nh = max(dot(n, H), 0.0);
  let a = max(s.rough * s.rough, 0.002);
  let f0 = mix(vec3f(0.04), s.base, s.metal);
  let F = f0 + (1.0 - f0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  var sh = 1.0; if (nl > 0.0 || s.trans > 0.0) { sh = shadowAt(p, n) * cloudShadow(p); }
  let E = sunE() * sh;
  let spec = F * ggx(nh, a) * visSmith(nv, nl, a);
  var c = (s.base * (1.0 - s.metal) * (1.0 - F) / PI + spec) * E * nl;
  // light through thin leaves and cloth
  c += s.base * s.trans * E * pow(max(dot(-V, L), 0.0), 3.0) * 0.35 + s.base * s.trans * E * max(-dot(n, L), 0.0) * 0.12;
  let Fa = f0 + (max(vec3f(1.0 - s.rough), f0) - f0) * pow(1.0 - nv, 5.0);
  c += s.base * (1.0 - s.metal) * ambient(n) * s.ao;
  c += envSpec(reflect(-V, n), s.rough, n) * Fa * s.ao;
  return c + s.emit;
}
// material layer sample with a world-space projection; returns albedo and the normal.xy, roughness, cavity
fn texA(l: u32, uv: vec2f) -> vec3f { return textureSample(matA, srep, uv, l).rgb; }
fn texN(l: u32, uv: vec2f) -> vec4f { return textureSample(matN, srep, uv, l); }
// perturb a normal by a tangent-space normal map sample on a surface with tangent t and bitangent b
fn bump(n: vec3f, t: vec3f, b: vec3f, m: vec4f, k: f32) -> vec3f {
  let d = (m.xy * 2.0 - 1.0) * k; return normalize(n + t * d.x + b * d.y);
}
`;

// ---------------------------------------------------------------- sky table + ambient + sun colour
const W_SKYLUT = W_COMMON + /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fsLut(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return vec4f(skyRadiance(lutDir(fc.xy / vec2f(192.0, 108.0))), 1.0);
}
// pixels 0-5: irradiance on the six axis-aligned planes (cosine-weighted average of the sky table, with ground
// bounce below the horizon); 6: sun irradiance after the atmosphere
@group(1) @binding(0) var lutIn: texture_2d<f32>;
@fragment fn fsAmb(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let k = i32(fc.x);
  if (k == 6) { return vec4f(transm(vec3f(0.0, RE + 20.0, 0.0), u.sun.xyz) * ESUN * smoothstep(-0.02, 0.02, u.sun.y), 1.0); }
  if (k > 6) { return vec4f(0.0); }
  var nrm = vec3f(0.0); nrm[k / 2] = select(-1.0, 1.0, (k & 1) == 0);
  let sunG = transm(vec3f(0.0, RE + 20.0, 0.0), u.sun.xyz) * ESUN * max(u.sun.y, 0.0);
  var sum = vec3f(0.0); var w = 0.0;
  for (var j = 0; j < 12; j++) { for (var i = 0; i < 24; i++) {
    let uv = vec2f((f32(i) + 0.5) / 24.0, (f32(j) + 0.5) / 12.0); let d = lutDir(uv);
    let c = max(dot(d, nrm), 0.0) * cos(asin(d.y));
    var L = textureLoad(lutIn, vec2i(uv * vec2f(192.0, 108.0)), 0).rgb;
    if (d.y < 0.0) { L = sunG * vec3f(0.25, 0.22, 0.18) / PI + L * 0.2; } // light bounced off the ground and sea
    sum += L * c; w += c;
  } }
  return vec4f(sum / max(w, 0.0001) * PI * 0.5, 1.0);
}
`;

// ---------------------------------------------------------------- sky: table + sun + clouds
const W_SKY = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) q: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
  let p = vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0);
  var o: O; o.pos = vec4f(p, 0.0, 1.0); o.q = p; return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let d = normalize(u.cf.xyz + u.cr.xyz * i.q.x * u.cr.w + u.cu.xyz * i.q.y * u.cu.w);
  var c = sky(d);
  let cs = dot(d, u.sun.xyz);
  let T = sunE() / ESUN;
  c += T * 40000.0 * smoothstep(0.999965, 0.99999, cs); // the sun's disc (0.27 degrees)
  if (d.y > 0.0) {
    let t = 1600.0 / max(d.y, 0.01); let xz = d.xz * t + u.cam.xz;
    let k = cloudDens(xz);
    // sunlit tops, darker bases, silver lining towards the sun
    let thick = nz(xz / 9000.0 * 2.3 + 0.11).g;
    let lit = sunE() * (0.06 + 0.22 * pow(max(cs, 0.0), 8.0)) * (1.1 - 0.6 * thick) + ambient(vec3f(0.0, -1.0, 0.0)) * 0.6 + ambient(vec3f(0.0, 1.0, 0.0)) * 0.35;
    let fade = smoothstep(0.0, 0.12, d.y) * (1.0 - smoothstep(25000.0, 60000.0, t));
    c = mix(c, mix(lit, sky(normalize(vec3f(d.x, 0.02, d.z))), smoothstep(8000.0, 50000.0, t) * 0.7), k * fade * 0.95);
  }
  return vec4f(c, 1.0);
}
`;

// ---------------------------------------------------------------- terrain: beach, prom, roads, gardens, cliffs
const W_TERRAIN = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f }
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f) -> O {
  var o: O; o.pos = u.vp * vec4f(p, 1.0); o.wp = p; o.n = n.xyz; return o;
}
@vertex fn vsShadow(@location(0) p: vec3f) -> @builtin(position) vec4f { return u.vp * vec4f(p, 1.0); }
struct Mt { a: vec3f, n: vec4f }
fn top(l: u32, p: vec3f, s: f32) -> Mt { let uv = p.xz / (MSIZE[l] * s); var m: Mt; m.a = texA(l, uv); m.n = texN(l, uv); return m; }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; var n = normalize(i.n);
  let dist = distance(p, u.cam.xyz);
  // nearest surface class, the lookup point wobbled so the edges are not pixel steps
  let wob = (nz(p.xz / 23.0).rg - 0.5) * 1.6;
  var cls = maskAt(p.xz + wob);
  let slope = 1.0 - n.y;
  let mac = nz(p.xz / 300.0); let mac2 = nz(p.xz / 61.0);
  var l = 4u; var tint = vec3f(1.0); var bumpK = 0.6; var rough = 1.0; var wet = 0.0;
  switch cls {
    case 1u: { l = 0u; }
    case 2u, 4u: { l = 1u; }
    case 3u: { l = 2u; }
    case 5u: { l = 4u; }
    case 6u: { l = 7u; }
    case 7u: { l = 5u; }
    case 8u: { l = 6u; }
    case 9u: { l = 4u; tint = vec3f(0.85, 0.95, 0.8); }
    case 10u: { l = 3u; }
    case 11u: { l = 4u; tint = vec3f(1.1, 1.15, 0.95); }
    case 12u: { l = 3u; tint = vec3f(0.15, 0.2, 0.2); }
    default: { l = select(1u, 4u, mac2.g > 0.5); tint = select(vec3f(1.0), vec3f(0.9), mac2.g > 0.5); }
  }
  // steep ground is bare sandstone (the cliffs), except under woods
  // steep ground is bare sandstone where the map says cliff or the scrub thins out; woods keep their floor
  let bare = select(smoothstep(0.62, 0.72, mac2.b + mac.g * 0.4), 1.0, cls == 8u);
  let steep = smoothstep(0.42, 0.6, slope + (mac2.r - 0.5) * 0.3) * bare;
  var m: Mt; var mN = vec4f(0.5, 0.5, 0.9, 0.5);
  // the ground's own material, two scales of the same texture hide the repeat
  let m1 = top(l, p, 1.0); let m2 = top(l, p, 3.7);
  let f = smoothstep(8.0, 60.0, dist) * 0.5 + 0.25;
  m.a = mix(m1.a, m2.a, f) * tint; mN = mix(m1.n, m2.n, f);
  var nn = bump(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), mN, bumpK * (1.0 - smoothstep(30.0, 150.0, dist)));
  // sandstone, projected on the vertical plane facing the slope, blended in where it is steep and bare
  let cliffOk = cls != 6u && cls != 2u && cls != 3u && cls != 4u && cls != 10u;
  if (steep > 0.01 && cliffOk) {
    let ax = select(vec2f(p.z, p.y), vec2f(p.x, p.y), abs(n.z) > abs(n.x));
    let uv = ax / MSIZE[6]; let ca = texA(6u, uv); let cn = texN(6u, uv); let ca2 = texA(6u, uv * 0.27);
    let t = normalize(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > abs(n.x)));
    let cnn = bump(n, t, vec3f(0.0, 1.0, 0.0), cn, 1.2);
    // ragged edge: the noise decides where the scrub ends
    let k = smoothstep(0.35, 0.65, steep + (nz(p.xz / 7.0).a - 0.5) * 0.6);
    m.a = mix(m.a, mix(ca, ca2, 0.4), k); mN = mix(mN, cn, k); nn = normalize(mix(nn, cnn, k));
  }
  n = nn;
  var base = m.a * (0.82 + 0.36 * mac.r);
  // the beach: damp below the reach of the waves, wet and glossy where they run up
  if (cls == 1u) {
    let swash = 0.25 + 0.12 * sin(u.cam.w * 0.75 + p.x * 0.011);
    let damp = 1.0 - smoothstep(0.35, 0.95, p.y + (mac2.g - 0.5) * 0.3);
    wet = 1.0 - smoothstep(swash - 0.05, swash + 0.1, p.y);
    base *= mix(1.0, 0.62, max(damp * 0.7, wet));
    rough = mix(1.0, 0.25, wet);
    n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), wet * 0.8));
  }
  var s: S; s.base = base; s.n = n; s.rough = clamp(mN.z * rough, 0.04, 1.0); s.metal = 0.0; s.ao = mix(0.55, 1.0, mN.w); s.trans = 0.0; s.emit = vec3f(0.0);
  return vec4f(aerial(shade(s, p), p), 1.0);
}
`;

// ---------------------------------------------------------------- objects: buildings, huts, piers, furniture, people
// Vertex: position, normal, uv (metres along the surface, metres up), colour (rgb tint, a = material layer or
// 20 glass, 21 lamp, 22 plain colour), extra (x mode: 0 textured, 1 facade with windows; y roughness scale;
// z floors / seed; w random)
const W_OBJ = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
  @location(3) c: vec4f, @location(4) e: vec4f }
fn out(wp: vec3f, n: vec3f, uv: vec2f, c: vec4f, e: vec4f) -> O { var o: O; o.pos = u.vp * vec4f(wp, 1.0); o.wp = wp; o.n = n; o.uv = uv; o.c = c; o.e = e; return o; }
fn rotY(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c); }
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f) -> O {
  return out(p, n.xyz, uv, c, e);
}
@vertex fn vsShadow(@location(0) p: vec3f) -> @builtin(position) vec4f { return u.vp * vec4f(p, 1.0); }
// walkers: the instance carries position, heading, walk phase, size and a seed; parts are coded in colour alpha
// (40 head, 41 torso, 42/43 legs, 44/45 arms, 46 hair)
fn person(p: vec3f, n: vec3f, part: u32, ia: vec4f, ib: vec4f) -> array<vec3f, 2> {
  var q = p; var nn = n; var piv = 0.0; var a = 0.0; let ph = ia.w;
  if (part == 42u) { piv = 0.9; a = sin(ph) * 0.42; } if (part == 43u) { piv = 0.9; a = -sin(ph) * 0.42; }
  if (part == 44u) { piv = 1.42; a = -sin(ph) * 0.3; } if (part == 45u) { piv = 1.42; a = sin(ph) * 0.3; }
  if (piv > 0.0) {
    let ca = cos(a); let sa = sin(a); let y = q.y - piv;
    q = vec3f(q.x * ca - y * sa, piv + q.x * sa + y * ca, q.z); nn = vec3f(nn.x * ca - nn.y * sa, nn.x * sa + nn.y * ca, nn.z);
  }
  q.y += abs(cos(ph)) * 0.03 * ib.w; q *= ib.y;
  return array<vec3f, 2>(ia.xyz + rotY(q, ib.x), rotY(nn, ib.x));
}
fn personCol(part: u32, seed: f32, beach: bool) -> vec4f {
  var shirt = array<vec3f, 12>(vec3f(0.6, 0.06, 0.06), vec3f(0.05, 0.12, 0.35), vec3f(0.85, 0.85, 0.82), vec3f(0.06, 0.3, 0.2), vec3f(0.8, 0.55, 0.08),
    vec3f(0.05, 0.05, 0.06), vec3f(0.35, 0.55, 0.75), vec3f(0.7, 0.3, 0.45), vec3f(0.3, 0.2, 0.45), vec3f(0.85, 0.4, 0.15), vec3f(0.45, 0.45, 0.42), vec3f(0.15, 0.35, 0.55));
  var legs = array<vec3f, 6>(vec3f(0.06, 0.09, 0.18), vec3f(0.12, 0.12, 0.13), vec3f(0.55, 0.48, 0.36), vec3f(0.2, 0.27, 0.4), vec3f(0.75, 0.73, 0.68), vec3f(0.25, 0.2, 0.15));
  var skin = array<vec3f, 5>(vec3f(0.85, 0.6, 0.47), vec3f(0.76, 0.52, 0.38), vec3f(0.6, 0.4, 0.26), vec3f(0.4, 0.25, 0.15), vec3f(0.22, 0.13, 0.08));
  var hair = array<vec3f, 5>(vec3f(0.03, 0.02, 0.015), vec3f(0.15, 0.08, 0.04), vec3f(0.55, 0.42, 0.22), vec3f(0.45, 0.45, 0.45), vec3f(0.35, 0.12, 0.04));
  let sk = vec4f(skin[u32(fract(seed * 7.13) * 5.0)], 11.0);
  let bare = beach && fract(seed * 3.7) < 0.5;
  if (part == 41u || part == 44u || part == 45u) { if (bare) { return sk; } return vec4f(shirt[u32(fract(seed * 13.7) * 12.0)], 10.0); }
  if (part == 42u || part == 43u) { if (beach) { return sk; } return vec4f(legs[u32(fract(seed * 29.3) * 6.0)], 10.0); }
  if (part == 46u) { return vec4f(hair[u32(fract(seed * 41.9) * 5.0)], 12.0); }
  return sk;
}
@vertex fn vsPeople(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f,
                    @location(5) ia: vec4f, @location(6) ib: vec4f) -> O {
  let part = u32(round(c.a * 255.0)); let r = person(p, n.xyz, part, ia, ib);
  let pc = personCol(part, ib.z, ib.w < 0.5);
  return out(r[0], r[1], uv, vec4f(pc.rgb, 22.0 / 255.0), vec4f(0.0, select(0.9, 0.5, pc.a > 11.5), 0.0, pc.a / 255.0));
}
@vertex fn vsPeopleShadow(@location(0) p: vec3f, @location(1) n: vec4f, @location(3) c: vec4f, @location(5) ia: vec4f, @location(6) ib: vec4f) -> @builtin(position) vec4f {
  return u.vp * vec4f(person(p, n.xyz, u32(round(c.a * 255.0)), ia, ib)[0], 1.0);
}
// gulls circling: ia = centre + radius, ib = angular speed, phase, scale; wings are parts 1 and 2
@vertex fn vsGull(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f,
                  @location(5) ia: vec4f, @location(6) ib: vec4f) -> O {
  let part = u32(round(e.z * 255.0)); let t = u.cam.w; let a = ib.y + ib.x * t;
  let pos = ia.xyz + vec3f(cos(a) * ia.w, sin(t * 0.3 + ib.y) * 1.5, sin(a) * ia.w);
  let hd = vec2f(-sin(a), cos(a)) * sign(ib.x);
  var q = p * ib.z; var nn = n.xyz;
  if (part > 0u) {
    let f = (sin(t * 5.0 + ib.y * 5.0) * 0.5 + 0.1) * select(-1.0, 1.0, part == 1u); let cf = cos(f); let sf = sin(f);
    q = vec3f(q.x, q.y * cf + q.z * sf, q.z * cf - q.y * sf); nn = vec3f(nn.x, nn.y * cf + nn.z * sf, nn.z * cf - nn.y * sf);
  }
  let r = vec3f(q.x * hd.x - q.z * hd.y, q.y, q.x * hd.y + q.z * hd.x); let rn = vec3f(nn.x * hd.x - nn.z * hd.y, nn.y, nn.x * hd.y + nn.z * hd.x);
  return out(pos + r, rn, uv, c, e);
}
// boats: ia = start x, z, speed, phase; ib = scale
@vertex fn vsBoat(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f,
                  @location(5) ia: vec4f, @location(6) ib: vec4f) -> O {
  let t = u.cam.w; let d = ia.x + 6000.0 + ia.z * t; let x = d - floor(d / 16000.0) * 16000.0 - 6000.0;
  let dir = sign(ia.z); let r = sin(t * 0.7 + ia.w) * 0.05;
  var q = p * ib.x; var nn = n.xyz;
  q = vec3f(q.x, q.y * cos(r) - q.z * sin(r), q.y * sin(r) + q.z * cos(r)); nn = vec3f(nn.x, nn.y * cos(r) - nn.z * sin(r), nn.y * sin(r) + nn.z * cos(r));
  q = vec3f(q.x * dir, q.y, q.z * dir); nn = vec3f(nn.x * dir, nn.y, nn.z * dir);
  return out(vec3f(x, 0.2 + sin(t * 0.9 + ia.w) * 0.15, ia.y) + q, nn, uv, c, e);
}

// facades: windows on every floor, with frames, sills, reflections and (in the evening) lit rooms
fn facade(s: ptr<function, S>, uv: vec2f, e: vec4f, n: vec3f, p: vec3f) {
  let seed = e.w; let floors = max(1.0, round(e.z * 255.0));
  let fh = 3.0; let pitch = mix(2.6, 3.6, fract(seed * 7.3)); let ww = pitch * mix(0.38, 0.55, fract(seed * 3.1));
  let wh = mix(1.3, 1.7, fract(seed * 5.7));
  let f = floor(uv.y / fh); let fy = uv.y - f * fh; let col = floor(uv.x / pitch); let fx = uv.x - col * pitch - pitch * 0.5;
  if (f >= floors) { return; }
  let y0 = 0.85; let inX = abs(fx) < ww * 0.5; let inY = fy > y0 && fy < y0 + wh;
  let fr = 0.07;
  if (inX && inY) {
    let core = abs(fx) < ww * 0.5 - fr && fy > y0 + fr && fy < y0 + wh - fr;
    if (core) {
      let mull = abs(fx) < 0.025 || abs(fy - (y0 + wh * 0.62)) < 0.025;
      if (mull) { (*s).base = vec3f(0.85); (*s).rough = 0.5; return; }
      let room = h21(vec2f(col, f) + seed * 91.0);
      (*s).base = vec3f(0.015, 0.017, 0.02) + vec3f(0.03, 0.025, 0.02) * room; (*s).rough = 0.06; (*s).metal = 0.0;
      let lit = step(0.55, h21(vec2f(col * 1.7, f * 3.1) + seed * 13.0)) * u.env.z;
      (*s).emit = vec3f(1.0, 0.7, 0.42) * 2.2 * lit * (0.6 + 0.4 * room);
      (*s).ao = 1.0;
    } else { (*s).base = vec3f(0.82, 0.82, 0.8); (*s).rough = 0.45; }
  } else if (inX && fy > y0 - 0.1 && fy <= y0) { (*s).base *= 0.75; (*s).n = normalize(n + vec3f(0.0, 0.4, 0.0)); }
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; var n = normalize(i.n);
  let V = u.cam.xyz - p; if (dot(n, V) < 0.0) { n = -n; }
  let code = u32(round(i.c.a * 255.0)); let mode = u32(round(i.e.x * 255.0));
  var s: S; s.n = n; s.metal = 0.0; s.ao = 1.0; s.trans = 0.0; s.emit = vec3f(0.0); s.rough = 0.8; s.base = i.c.rgb;
  if (code < 18u) {
    let uv = i.uv / MSIZE[code];
    s.base = texA(code, uv) * i.c.rgb; let m = texN(code, uv); s.rough = clamp(m.z * (i.e.y * 2.0), 0.03, 1.0); s.ao = mix(0.6, 1.0, m.w);
    // tangent along the surface: horizontal for walls, x for floors
    let t = normalize(select(cross(vec3f(0.0, 1.0, 0.0), n), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9));
    let b = select(vec3f(0.0, 1.0, 0.0), cross(n, t), abs(n.y) > 0.9);
    s.n = bump(n, t, b, m, 0.8);
    if (code == 16u) { s.metal = 0.0; }
  } else if (code == 20u) { s.base = vec3f(0.02); s.rough = 0.05; }
  else if (code == 21u) { s.emit = i.c.rgb * (0.4 + 6.0 * u.env.z); s.base = i.c.rgb * 0.5; }
  else { s.rough = i.e.y; if (code == 22u) { s.trans = select(0.0, 0.3, u32(round(i.e.w * 255.0)) == 10u); } }
  if (mode == 1u) { facade(&s, i.uv, i.e, n, p); }
  return vec4f(aerial(shade(s, p), p), 1.0);
}
`;

// ---------------------------------------------------------------- vegetation: trees, shrubs (instanced), grass tufts
// Base mesh: colour alpha = foliage layer (0-5) or 255 for bark; extra.x = wind weight.
// Instance: position + scale, rotation, tint, squash, kind
const W_VEG = W_COMMON + /*wgsl*/`
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
  @location(3) @interpolate(flat) l: u32, @location(4) tint: vec3f, @location(5) fade: f32 }
fn place(p: vec3f, n: vec3f, w: f32, ia: vec4f, ib: vec4f) -> array<vec3f, 2> {
  let s = ia.w; let c = cos(ib.x); let sn = sin(ib.x);
  var q = p * vec3f(s * ib.z, s, s * ib.z);
  let t = u.cam.w; let ph = ia.x * 0.07 + ia.z * 0.05;
  let sway = (sin(t * 0.9 + ph) * 0.6 + sin(t * 2.3 + ph * 2.0) * 0.25) * w * (0.02 + 0.03 * u.wind.z);
  q += vec3f(sway * q.y, 0.0, sway * 0.6 * q.y);
  let r = vec3f(q.x * c - q.z * sn, q.y, q.x * sn + q.z * c);
  return array<vec3f, 2>(ia.xyz + r, vec3f(n.x * c - n.z * sn, n.y, n.x * sn + n.z * c));
}
fn vtint(kind: f32, h: f32, l: u32) -> vec3f {
  if (l == 255u) { return mix(vec3f(0.9, 0.85, 0.8), vec3f(1.1, 0.9, 0.8), h); }
  return mix(vec3f(0.8, 0.85, 0.75), vec3f(1.15, 1.1, 0.95), h);
}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f,
              @location(5) ia: vec4f, @location(6) ib: vec4f) -> O {
  let r = place(p, n.xyz, e.x, ia, ib); let l = u32(round(c.a * 255.0));
  var o: O; o.pos = u.vp * vec4f(r[0], 1.0); o.wp = r[0]; o.n = r[1]; o.uv = uv; o.l = l; o.tint = c.rgb * vtint(ib.w, ib.y, l); o.fade = 1.0;
  return o;
}
struct SO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) l: u32 }
@vertex fn vsShadow(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @location(3) c: vec4f, @location(4) e: vec4f,
                    @location(5) ia: vec4f, @location(6) ib: vec4f) -> SO {
  var o: SO; o.pos = u.vp * vec4f(place(p, n.xyz, e.x, ia, ib)[0], 1.0); o.uv = uv; o.l = u32(round(c.a * 255.0)); return o;
}
@fragment fn fsShadow(i: SO) {
  if (i.l < 255u) { if (textureSampleLevel(folT, srep, i.uv, i.l, 1.0).a < 0.5) { discard; } }
}
// grass tufts on a grid around the camera; the ground decides where grass grows
@vertex fn vsGrass(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) uv: vec2f, @builtin(instance_index) ii: u32) -> O {
  let N = 180u; let sp = 0.5;
  let gi = vec2f(f32(ii % N), f32(ii / N)) - f32(N) * 0.5;
  let cell = floor(u.cam.xz / sp) + gi;
  let j = vec2f(h21(cell), h21(cell + 17.3));
  let xz = (cell + j) * sp;
  let d = length(xz - u.cam.xz);
  let cls = maskAt(xz);
  let grass = cls == 5u || cls == 9u || cls == 11u || cls == 7u || (cls == 0u && h21(cell * 0.37) > 0.6);
  let size = select(0.0, (0.25 + 0.3 * h21(cell + 3.1)) * (1.0 - smoothstep(20.0, 40.0, d)), grass && h21(cell + 1.3) > 0.35);
  let a = h21(cell + 9.7) * 6.2832; let c = cos(a); let s = sin(a);
  var q = p * size; let t = u.cam.w;
  q.x += (sin(t * 1.7 + xz.x * 0.3 + xz.y * 0.2) * 0.08 + 0.04) * q.y * u.wind.z;
  let wp = vec3f(xz.x, terrainH(xz) - 0.02, xz.y) + vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
  var o: O; o.pos = u.vp * vec4f(wp, 1.0); o.wp = wp; o.n = vec3f(0.0, 1.0, 0.0); o.uv = uv;
  o.l = select(3u, 4u, cls == 7u); o.tint = mix(vec3f(0.85, 0.9, 0.75), vec3f(1.1, 1.05, 0.85), h21(cell + 5.5)); o.fade = 1.0;
  if (size == 0.0) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  return o;
}
struct FO { @location(0) c: vec4f }
@fragment fn fs(i: O) -> FO {
  let p = i.wp; var n = normalize(i.n); let V = u.cam.xyz - p;
  var s: S; s.metal = 0.0; s.emit = vec3f(0.0); s.ao = 1.0; var a = 1.0;
  if (i.l == 255u) {
    let uv = i.uv / MSIZE[17]; s.base = texA(17u, uv) * i.tint; let m = texN(17u, uv); s.rough = 0.95; s.trans = 0.0;
    let t = normalize(cross(vec3f(0.0, 1.0, 0.0), n) + vec3f(0.0001)); s.n = bump(n, t, cross(n, t), m, 1.0); s.ao = mix(0.5, 1.0, m.w);
  } else {
    let f = textureSample(folT, srep, i.uv, i.l);
    a = f.a; s.base = f.rgb * i.tint; s.rough = 0.6; s.trans = 0.9;
    // foliage normals point out of the crown (set in the mesh), a little light comes through the leaves
    if (dot(n, V) < 0.0) { n = normalize(n * 0.3 + normalize(V) * 0.1); }
    s.n = n; s.ao = 0.75;
    a = clamp((a - 0.4) / max(fwidth(a), 0.0001) * 0.5 + 0.5, 0.0, 1.0);
    if (a < 0.05) { discard; }
  }
  var o: FO; o.c = vec4f(aerial(shade(s, p), p), a); return o;
}
`;

// ---------------------------------------------------------------- depth resolve: sample 0 of the MSAA depth, plus the distance
const W_DEPTH = /*wgsl*/`
@group(0) @binding(0) var d: texture_depth_multisampled_2d;
@group(0) @binding(1) var<uniform> near: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0); }
struct O { @builtin(frag_depth) z: f32, @location(0) l: f32 }
@fragment fn fs(@builtin(position) fc: vec4f) -> O {
  let z = textureLoad(d, vec2i(fc.xy), 0); var o: O; o.z = z; o.l = select(near.x / z, 1e7, z <= 0.0); return o;
}
`;

// ---------------------------------------------------------------- ambient occlusion (half resolution), then applied to the image
const W_AO = /*wgsl*/`
@group(0) @binding(0) var lin: texture_2d<f32>;
@group(0) @binding(1) var<uniform> c: array<vec4f, 4>; // right+tanx, up+tany, forward, size
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0); }
fn vpos(px: vec2f) -> vec3f {
  let sz = c[3].xy; let q = vec2f(px.x / sz.x * 2.0 - 1.0, 1.0 - px.y / sz.y * 2.0);
  let l = textureLoad(lin, vec2i(clamp(px, vec2f(0.0), sz - 1.0)), 0).r;
  return vec3f(q.x * c[0].w, q.y * c[1].w, 1.0) * l;
}
fn h(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy * 2.0; let P = vpos(px);
  if (P.z > 2000.0) { return vec4f(1.0); }
  let N = normalize(cross(vpos(px + vec2f(0.0, 2.0)) - P, vpos(px + vec2f(2.0, 0.0)) - P));
  let R = 0.9; let rpx = R / P.z / c[0].w * c[3].x * 0.5;
  if (rpx < 2.0) { return vec4f(1.0); }
  var occ = 0.0; let rot = h(fc.xy) * 6.2832;
  for (var k = 0; k < 8; k++) {
    let a = rot + f32(k) * 0.785; let dir = vec2f(cos(a), sin(a));
    for (var j = 1; j <= 3; j++) {
      let off = dir * rpx * (f32(j) / 3.0) * (0.75 + 0.25 * h(fc.xy + f32(k)));
      let Q = vpos(px + off); let v = Q - P; let dd = length(v);
      occ += max(dot(v / max(dd, 0.001), N) - 0.1, 0.0) * smoothstep(R * 1.6, R * 0.5, dd);
    }
  }
  return vec4f(clamp(1.0 - occ / 24.0 * 1.6, 0.0, 1.0));
}
`;
// composite: scene colour x blurred occlusion (depth aware)
const W_COMP = /*wgsl*/`
@group(0) @binding(0) var col: texture_2d<f32>;
@group(0) @binding(1) var ao: texture_2d<f32>;
@group(0) @binding(2) var lin: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let d0 = textureLoad(lin, p, 0).r; let hs = vec2i(textureDimensions(ao)) - 1;
  var s = 0.0; var w = 0.0;
  for (var y = -1; y <= 2; y++) { for (var x = -1; x <= 2; x++) {
    let q = clamp(p / 2 + vec2i(x, y), vec2i(0), hs); let d = textureLoad(lin, clamp(q * 2, vec2i(0), vec2i(textureDimensions(lin)) - 1), 0).r;
    let k = 1.0 / (0.001 + abs(d - d0) / max(d0, 0.1) * 20.0); s += textureLoad(ao, q, 0).r * k; w += k;
  } }
  let a = s / w;
  return vec4f(textureLoad(col, p, 0).rgb * mix(1.0, a, 0.8), 1.0);
}
`;

// ---------------------------------------------------------------- the sea
const W_SEA = W_COMMON + /*wgsl*/`
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var lin: texture_2d<f32>;
struct O { @builtin(position) pos: vec4f, @location(0) wp: vec3f }
const LEVEL = 0.2; // mid tide, metres above datum
fn wv(p: vec2f, t: f32, d: vec2f, L: f32, a: f32, ph: f32) -> vec3f {
  let k = 6.2831853 / L; let w = sqrt(9.81 * k); let x = dot(d, p) * k - w * t + ph; let c = cos(x);
  return vec3f(a * sin(x), a * k * c * d.x, a * k * c * d.y);
}
// swell from the south-west, plus wind chop
fn waves(p: vec2f, t: f32) -> vec3f {
  return wv(p, t, vec2f(0.24, 0.97), 46.0, 0.17, 0.0) + wv(p, t, vec2f(-0.3, 0.954), 25.0, 0.09, 1.3)
       + wv(p, t, vec2f(0.55, 0.835), 13.0, 0.05, 4.1) + wv(p, t, vec2f(-0.66, 0.75), 8.3, 0.03, 2.2)
       + wv(p, t, vec2f(0.9, 0.436), 5.1, 0.018, 0.7) + wv(p, t, vec2f(0.1, 0.995), 3.3, 0.01, 5.0);
}
fn ripples(p: vec2f, t: f32) -> vec2f {
  return (wv(p, t, vec2f(0.8, 0.6), 2.1, 0.012, 0.0) + wv(p, t, vec2f(-0.6, 0.8), 1.5, 0.009, 2.0)
        + wv(p, t, vec2f(0.1, -0.995), 0.95, 0.006, 4.0) + wv(p, t, vec2f(-0.95, -0.3), 0.6, 0.004, 1.0)).yz;
}
// the wash running up the sand and back, strongest in the shallows
fn swash(x: f32, t: f32, depth: f32) -> f32 {
  let s = 0.12 * sin(t * 0.75 + x * 0.011) + 0.05 * sin(t * 1.21 + x * 0.027 + 1.3);
  return (s + 0.05) * (1.0 - smoothstep(0.4, 2.5, depth));
}
@vertex fn vs(@location(0) o: vec2f) -> O {
  let t = u.cam.w; let p = floor(u.cam.xz / 3.0) * 3.0 + o;
  let depth = LEVEL - terrainH(p);
  let amp = clamp(depth / 3.0, 0.0, 1.0) * (1.0 - smoothstep(300.0, 2000.0, length(o)));
  let h = LEVEL + waves(p, t).x * amp + swash(p.x, t, depth);
  var r: O; r.wp = vec3f(p.x, h, p.y); r.pos = u.vp * vec4f(r.wp, 1.0); return r;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let p = i.wp; let t = u.cam.w;
  let ground = terrainH(p.xz); let depth = LEVEL - ground; let wd = p.y - ground;
  let dist = distance(p, u.cam.xyz);
  let amp = clamp(depth / 3.0, 0.0, 1.0) * (1.0 - smoothstep(300.0, 2000.0, dist));
  var g = waves(p.xz, t).yz * amp + ripples(p.xz, t) * (1.0 - smoothstep(20.0, 300.0, dist)) * (0.6 + 0.6 * u.wind.z);
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  let V = normalize(u.cam.xyz - p);
  let nv = max(dot(n, V), 0.0);
  let F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  // what lies under the surface: the scene behind, bent by the waves, dimmed and tinted by the water in between
  let sc = i.pos.xy; let sz = u.scr.xy;
  let behind0 = textureLoad(lin, vec2i(sc), 0).r;
  let thick0 = max(behind0 - dist, 0.0);
  let off = n.xz * min(thick0, 3.0) * 18.0 * (1.0 - smoothstep(30.0, 200.0, dist));
  var sp = clamp(sc + off, vec2f(0.0), sz - 1.0);
  var behind = textureLoad(lin, vec2i(sp), 0).r;
  if (behind < dist) { sp = sc; behind = behind0; }
  let thick = clamp(behind - dist, 0.0, 60.0);
  let under = textureLoad(scene, vec2i(sp), 0).rgb;
  // English Channel water: green-blue and a little murky
  let absorb = vec3f(0.55, 0.2, 0.24);
  let Tw = exp(-absorb * thick);
  let inscatter = vec3f(0.018, 0.06, 0.055) * (ambient(vec3f(0.0, 1.0, 0.0)) + sunE() * max(u.sun.y, 0.0) * 0.3);
  var body = under * Tw + inscatter * (1.0 - Tw.g);
  // reflection: sky and clouds, the sun's glitter
  let R = reflect(-V, n);
  var refl = sky(vec3f(R.x, max(R.y, 0.01), R.z));
  if (R.y > 0.0) { let tc = 1600.0 / max(R.y, 0.02); let k = cloudDens(R.xz * tc + p.xz); refl = mix(refl, ambient(vec3f(0.0, -1.0, 0.0)) * 0.7 + sunE() * 0.05, k * smoothstep(0.0, 0.1, R.y) * 0.85); }
  var c = mix(body, refl, F);
  let L = u.sun.xyz; let H = normalize(L + V); let rough = mix(0.04, 0.2, smoothstep(50.0, 3000.0, dist));
  let a2 = rough * rough; let nh = max(dot(n, H), 0.0); let dd = nh * nh * (a2 - 1.0) + 1.0;
  let sh = shadowAt(p, vec3f(0.0, 1.0, 0.0)) * cloudShadow(p);
  c += sunE() * sh * F * a2 / (PI * dd * dd) * 0.25 / max(nv, 0.05) * max(dot(n, L), 0.0);
  // foam: the edge of the wash, waves breaking over the shallows
  let fn1 = nz(p.xz / 9.0 + vec2f(t * 0.004, -t * 0.012)).a * 0.6 + nz(p.xz / 3.0 + vec2f(0.0, -t * 0.03)).a * 0.4;
  let edge = 1.0 - smoothstep(0.0, 0.05 + 0.14 * fn1, wd);
  let ph = fract(depth * 0.55 + t * 0.11 + nz(p.xz / 180.0).r * 1.2);
  let brk = pow(1.0 - ph, 8.0) * smoothstep(2.0, 0.7, depth) * smoothstep(0.1, 0.35, wd);
  let foam = clamp(max(edge * 0.95, brk) * smoothstep(0.2, 0.6, fn1 + max(edge, brk) * 0.35), 0.0, 1.0);
  var fs: S; fs.base = vec3f(0.85, 0.87, 0.87); fs.n = vec3f(0.0, 1.0, 0.0); fs.rough = 0.9; fs.metal = 0.0; fs.ao = 1.0; fs.trans = 0.0; fs.emit = vec3f(0.0);
  c = mix(c, shade(fs, p), foam);
  // the very edge fades into the wet sand
  let a = smoothstep(0.0, 0.03, wd);
  return vec4f(aerial(c, p), a);
}
`;

// ---------------------------------------------------------------- bloom (downsample + upsample chain)
const W_BLOOM = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var sm: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0); }
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let s = vec2f(textureDimensions(src)); let uv = fc.xy * 2.0 / s; let t = 1.0 / s;
  var c = textureSampleLevel(src, sm, uv, 0.0).rgb * 0.5;
  c += (textureSampleLevel(src, sm, uv + vec2f(-t.x, -t.y), 0.0).rgb + textureSampleLevel(src, sm, uv + vec2f(t.x, -t.y), 0.0).rgb
      + textureSampleLevel(src, sm, uv + vec2f(-t.x, t.y), 0.0).rgb + textureSampleLevel(src, sm, uv + vec2f(t.x, t.y), 0.0).rgb) * 0.125;
  return vec4f(min(c, vec3f(400.0)), 1.0);
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let s = vec2f(textureDimensions(src)); let uv = fc.xy / (s * 2.0); let t = 1.0 / s;
  var c = textureSampleLevel(src, sm, uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, sm, uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(src, sm, uv - vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, sm, uv + vec2f(0.0, t.y), 0.0).rgb + textureSampleLevel(src, sm, uv - vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, sm, uv + t, 0.0).rgb + textureSampleLevel(src, sm, uv - t, 0.0).rgb
     + textureSampleLevel(src, sm, uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(src, sm, uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}
`;

// ---------------------------------------------------------------- post: bloom, exposure, filmic tone map, grade, vignette, grain
const W_POST = /*wgsl*/`
@group(0) @binding(0) var<uniform> e: vec4f; // exposure, width, height, time
@group(0) @binding(1) var tx: texture_2d<f32>;
@group(0) @binding(2) var bl: texture_2d<f32>;
@group(0) @binding(3) var sm: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0); }
fn aces(x: vec3f) -> vec3f {
  // ACES (Narkowicz fit), applied per channel after a mild gamut squeeze
  let m = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  let o = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  let v = m * x; let a = v * (v + 0.0245786) - 0.000090537; let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), vec3f(0.0), vec3f(1.0));
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / e.yz;
  var c = textureSampleLevel(tx, sm, uv, 0.0).rgb + textureSampleLevel(bl, sm, uv, 0.0).rgb * 0.045;
  c = aces(c * e.x);
  let v = uv - 0.5; c *= 1.0 - dot(v, v) * 0.38;
  c = pow(c, vec3f(1.0 / 2.2));
  let g = fract(sin(dot(fc.xy + e.w * 37.0, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  return vec4f(c + g * 0.012, 1.0);
}
`;
