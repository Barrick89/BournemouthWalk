// ============================================================================
// renderer, walker, input and interface
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` over ~`ms` on the compositor, so it moves while this thread is busy
let loaded = 0, dead;
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const fail = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message that is shown as it is
if (!navigator.gpu) fail('Dieser Spaziergang braucht WebGPU. Bitte einen aktuellen Chrome oder Edge verwenden.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('Kein WebGPU-Adapter gefunden.');
$('w').hidden = !!navigator.userAgentData; // only Chromium-based browsers have it
const device = await adapter.requestDevice();
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
device.lost.then((l) => {
  if (l.reason === 'destroyed') return;
  if (LV < 2) { keep('bwalk', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'Die Grafikkarte wurde zurückgesetzt. Bitte die Seite neu laden.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;
const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data); return b; };
const tex = (w, h, format, usage, samples = 1) => device.createTexture({ size: [w, h], format, usage, sampleCount: samples });

// ---------------------------------------------------------------- the world
await say('Vermesse die Bucht…', 0.12, 500);
keep('bwalkLoad', 1);
addEventListener('pagehide', () => keep('bwalkLoad', ''));
const TER = buildTerrain();
await say('Stelle Strandhütten auf…', 0.4, 900);
buildScenery(); buildFar();
// collision buckets along x
const CF = new Float32Array(COLL);
{
  const L = Array.from({ length: CBN }, () => []);
  for (let i = 0; i < CF.length; i += 9) {
    const a = clamp(floor((CF[i] - CB0) / CBW), 0, CBN - 1), b = clamp(floor((CF[i + 1] - CB0) / CBW), 0, CBN - 1);
    for (let k = a; k <= b; k++) L[k].push(i);
  }
  CBK = L.map((l) => new Int32Array(l));
}
await say('Pflanze Kiefern…', 0.6, 700);
const PLANTS = buildPlants(), PEOPLE = buildPeople(), GULLS = buildGulls(), BOATS = buildBoats(), SEA = seaGrid();
const vbTerr = buf(TER.vb, BU.VERTEX), ibTerr = buf(TER.ib, BU.INDEX), nTerr = TER.ib.length;
const sc = S.pack(), vbScene = buf(sc, BU.VERTEX), nScene = sc.byteLength / 20;
const fc = FAR.pack(), vbFar = buf(fc, BU.VERTEX), nFar = fc.byteLength / 20;
const mk = (m) => { const b = m; return { vb: buf(b, BU.VERTEX), n: b.byteLength / 20 }; };
const mPine = mk(pineMesh()), mBush = mk(bushMesh()), mPerson = mk(personMesh()), mGull = mk(gullMesh()), mBoat = mk(boatMesh());
const inst = (a) => ({ b: buf(a, BU.VERTEX), n: a.length / 8 });
const iPine = inst(PLANTS.pines), iBush = inst(PLANTS.bushes), iPeople = inst(PEOPLE), iGull = inst(GULLS), iBoat = inst(BOATS);
const vbSea = buf(SEA.vb, BU.VERTEX), ibSea = buf(SEA.ib, BU.INDEX), nSea = SEA.ib.length;

// ---------------------------------------------------------------- pipelines
await say('Mische Farben…', 0.8, 600);
const UB = new Float32Array(72), UBS = new Float32Array(72), PU = new Float32Array(4);
const ubo = device.createBuffer({ size: 288, usage: BU.UNIFORM | BU.COPY_DST }), uboS = device.createBuffer({ size: 288, usage: BU.UNIFORM | BU.COPY_DST });
const ubP = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
const tShadow = device.createTexture({ size: [SHADOW, SHADOW], format: DEPTH, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const tDummy = device.createTexture({ size: [1, 1], format: DEPTH, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const sCmp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
const sLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const VF = SS.VERTEX | SS.FRAGMENT;
const bgl = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} }, { binding: 1, visibility: VF, sampler: { type: 'comparison' } },
  { binding: 2, visibility: VF, texture: { sampleType: 'depth' } }] });
const mkBG = (b, t) => device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: b } }, { binding: 1, resource: sCmp }, { binding: 2, resource: t.createView() }] });
const bgMain = mkBG(ubo, tShadow), bgShadow = mkBG(uboS, tDummy);
const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vTerr = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const vObj = { arrayStride: 20, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4'), A(2, 16, 'unorm8x4')] };
const vInst = { arrayStride: 32, stepMode: 'instance', attributes: [A(3, 0, 'float32x4'), A(4, 16, 'float32x4')] };
const vSea = { arrayStride: 8, attributes: [A(0, 0, 'float32x2')] };
const ALPHA = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const pipe = (m, vs, buffers, o = {}) => device.createRenderPipeline({ layout: pl,
  vertex: { module: m, entryPoint: vs, buffers },
  fragment: { module: m, entryPoint: o.fs || 'fs', targets: [{ format: HDR, blend: o.blend }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.sky, depthCompare: o.sky ? 'always' : 'greater' }, multisample: { count: AA } });
const spipe = (m, vs, buffers) => device.createRenderPipeline({ layout: pl,
  vertex: { module: m, entryPoint: vs, buffers }, primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 3, depthBiasSlopeScale: 2.5 } });
const mSky = mod(W_SKY), mTerr = mod(W_TERRAIN), mObj = mod(W_OBJ), mSea = mod(W_SEA), mPost = mod(W_POST);
const pSky = pipe(mSky, 'vs', [], { sky: 1 }), pTerr = pipe(mTerr, 'vs', [vTerr]), pMesh = pipe(mObj, 'vsMesh', [vObj]);
const pTree = pipe(mObj, 'vsTree', [vObj, vInst]), pPeople = pipe(mObj, 'vsPeople', [vObj, vInst]);
const pGull = pipe(mObj, 'vsGull', [vObj, vInst]), pBoat = pipe(mObj, 'vsBoat', [vObj, vInst]);
const pSea = pipe(mSea, 'vs', [vSea], { blend: ALPHA });
const sTerr = spipe(mTerr, 'vs', [vTerr]), sMesh = spipe(mObj, 'vsMesh', [vObj]), sTree = spipe(mObj, 'vsTree', [vObj, vInst]), sPeople = spipe(mObj, 'vsPeople', [vObj, vInst]);
const pPost = device.createRenderPipeline({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] } });

// ---------------------------------------------------------------- render targets (rebuilt on resize)
let W = 0, H = 0, tColor, tHDR, tDepth, bgPost;
const passShadow = { colorAttachments: [], depthStencilAttachment: { view: tShadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } };
const passMain = { colorAttachments: [{ view: null, resolveTarget: undefined, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }], depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' } };
const passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
function resize() {
  const r = rot.matches, cw = r ? innerHeight : innerWidth, ch = r ? innerWidth : innerHeight;
  const dpr = min(devicePixelRatio || 1, 2), k = min(1, sqrt(3.7e6 / (cw * ch * dpr * dpr)));
  const DW = max(1, round(cw * dpr * k)), DH = max(1, round(ch * dpr * k));
  if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
  const w = max(1, round(DW * SCALE)), h = max(1, round(DH * SCALE));
  if (w === W && h === H) return;
  W = w; H = h;
  for (const t of [tColor, tHDR, tDepth]) t?.destroy();
  tHDR = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  tDepth = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT, AA);
  if (AA > 1) { tColor = tex(W, H, HDR, TU.RENDER_ATTACHMENT, AA); passMain.colorAttachments[0].view = tColor.createView(); passMain.colorAttachments[0].resolveTarget = tHDR.createView(); }
  else { tColor = null; passMain.colorAttachments[0].view = tHDR.createView(); }
  passMain.depthStencilAttachment.view = tDepth.createView();
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubP } }, { binding: 1, resource: tHDR.createView() }, { binding: 2, resource: sLin }] });
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- time of day
// sun direction, sun colour, zenith, horizon, cloud cover, haze, ground bounce, exposure, evening
const TOD = [
  [0.72, 0.3, -0.62, 2.7, 2.25, 1.75, 0.2, 0.36, 0.7, 0.86, 0.8, 0.74, 0.32, 1.1e-4, 0.24, 0.21, 0.17, 1.0, 0],
  [0.18, 0.86, -0.48, 3.0, 2.9, 2.72, 0.17, 0.37, 0.8, 0.68, 0.8, 0.92, 0.26, 7e-5, 0.26, 0.24, 0.19, 0.9, 0],
  [-0.83, 0.075, -0.55, 2.9, 1.35, 0.55, 0.15, 0.22, 0.46, 0.98, 0.6, 0.4, 0.42, 9e-5, 0.2, 0.15, 0.12, 1.15, 1],
];
const TODN = ['Morgen', 'Mittag', 'Abend'];
let tod = 1;
try { const t = +localStorage.bwalkTod; if (t >= 0 && t < 3) tod = t; } catch {}
const CUR = Float32Array.from(TOD[tod]);
const setTod = (t) => { tod = (t + 3) % 3; keep('bwalkTod', tod); $('t').querySelectorAll('button').forEach((b, i) => b.className = i === tod ? 'on' : ''); };

// ---------------------------------------------------------------- walker
// position in seafront coordinates (x along, z inland, feet height); camera smoothing; step rhythm
let px = 0, pz = 0, feet = PROM, vy = 0, yaw = 0, pitch = 0, vx = 0, vz = 0, eyeY = PROM + 1.6, stepPh = 0, onGround = true;
let standOn = 0, TIME = 0, walked = 0, started = false, tStart = 0, done = false, shortcut = false;
const STEP = 0.65, RAD = 0.3, EYE = 1.62;
const topOf = (i, z) => { const zA = CF[i + 7], zB = CF[i + 8]; let t = (z - zA) / (zB - zA); t = t < 0 ? 0 : t > 1 ? 1 : t; return CF[i + 5] + (CF[i + 6] - CF[i + 5]) * t; };
// the ground under the feet: terrain, or the highest deck / groyne / step within reach
function groundAt(x, z, f) {
  let g = ground(x, z); standOn = 0;
  const b = floor((x - CB0) / CBW);
  if (b >= 0 && b < CBN) for (let j = 0, K = CBK[b]; j < K.length; j++) {
    const i = K[j];
    if (x < CF[i] || x > CF[i + 1] || z < CF[i + 2] || z > CF[i + 3]) continue;
    const t = topOf(i, z);
    if (t <= f + STEP && t > g) { g = t; standOn = 1; }
  }
  return g;
}
function blocked(x, z, f, d) {
  if (x < -430 || x > 2045 || z < -85 || z > 360) return true;
  const g = groundAt(x, z, f);
  if (g < -0.75) return true; // no swimming
  if (z > PW - 0.3 && !standOn ? g > f + 0.03 && g - f > d * 1.05 : g > f + STEP) return true; // too steep / too high
  const b0 = max(0, floor((x - RAD - CB0) / CBW)), b1 = min(CBN - 1, floor((x + RAD - CB0) / CBW));
  for (let b = b0; b <= b1; b++) for (let j = 0, K = CBK[b]; j < K.length; j++) {
    const i = K[j];
    if (b > b0 && CF[i] < CB0 + b * CBW) continue; // already seen in the previous bucket
    if (x + RAD < CF[i] || x - RAD > CF[i + 1] || z + RAD < CF[i + 2] || z - RAD > CF[i + 3]) continue;
    const t = topOf(i, clamp(z, CF[i + 2], CF[i + 3]));
    if (t > f + STEP && CF[i + 4] < f + 1.75) return true;
  }
  return false;
}
function walk(wx, wz) {
  const d = hypot(wx, wz); if (d < 1e-6) return;
  const n = Math.ceil(d / 0.12), sx = wx / n, swz = wz / n;
  for (let i = 0; i < n; i++) {
    const sz = swz - (bend(px + sx) - bend(px)), dd = hypot(sx, sz);
    if (!blocked(px + sx, pz + sz, feet, dd)) { px += sx; pz += sz; }
    else if (!blocked(px + sx, pz - (bend(px + sx) - bend(px)), feet, abs(sx))) { pz -= bend(px + sx) - bend(px); px += sx; }
    else if (!blocked(px, pz + swz, feet, abs(swz))) pz += swz;
    const g = groundAt(px, pz, feet); if (g > feet) feet = g;
  }
}
function teleport(i) {
  const p = POSES[i];
  px = p[0]; pz = p[1]; yaw = p[2]; pitch = p[3]; vx = vz = vy = 0;
  feet = groundAt(px, pz, 50); eyeY = feet + EYE;
  lkx = lky = l2x = l2y = 0;
  if (i > 0) shortcut = true;
}

// ---------------------------------------------------------------- input
let kf = 0, kb = 0, kl = 0, kr = 0, ks = 0, kj = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0;
let tId = -1, tN = 0, tx = 0, ty = 0, tx0 = 0, ty0 = 0;
let hud = false, hN = 0, hT = 0, hMax = 0, dynT = 0, dynN = 0;

// ---------------------------------------------------------------- per-frame
const SUBMIT = [null];
function render() {
  // camera basis
  const cx = px, cy = eyeY, cz = pz + bend(px);
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const TANH = 0.62, NEAR = 0.1, asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  // sun + shadow box (ortho, texel-snapped) around the ground in front of the walker
  let lx = CUR[0], ly = CUR[1], lz = CUR[2]; const ll = hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
  let ax = lz, az = -lx; const al = hypot(ax, az); ax /= al; az /= al; // right: horizontal, across the light
  const bx = ly * az, by = lz * ax - lx * az, bz = -ly * ax; // up in light space = L x right
  const R = 95, D = 600, fl = hypot(fx, fz) || 1, ox = cx + fx / fl * 65, oy = cy - 4, oz = cz + fz / fl * 65;
  const tx_ = 2 * R / SHADOW;
  const pr = round((ax * ox + az * oz) / tx_) * tx_, pu = round((bx * ox + by * oy + bz * oz) / tx_) * tx_;
  const S_ = UB;
  S_[16] = ax / R; S_[20] = 0; S_[24] = az / R; S_[28] = -pr / R;
  S_[17] = bx / R; S_[21] = by / R; S_[25] = bz / R; S_[29] = -pu / R;
  S_[18] = -lx / (2 * D); S_[22] = -ly / (2 * D); S_[26] = -lz / (2 * D); S_[30] = (lx * ox + ly * oy + lz * oz + D) / (2 * D);
  S_[19] = 0; S_[23] = 0; S_[27] = 0; S_[31] = 1;
  m[32] = cx; m[33] = cy; m[34] = cz; m[35] = TIME;
  m[36] = lx; m[37] = ly; m[38] = lz; m[39] = 1;
  m[40] = CUR[3]; m[41] = CUR[4]; m[42] = CUR[5]; m[43] = CUR[17];
  m[44] = CUR[6]; m[45] = CUR[7]; m[46] = CUR[8]; m[47] = CUR[12];
  m[48] = CUR[9]; m[49] = CUR[10]; m[50] = CUR[11]; m[51] = CUR[13];
  m[52] = CUR[14]; m[53] = CUR[15]; m[54] = CUR[16]; m[55] = 0;
  m[56] = rx; m[57] = 0; m[58] = rz; m[59] = TANH * asp;
  m[60] = ux; m[61] = uy; m[62] = uz; m[63] = TANH;
  m[64] = fx; m[65] = fy; m[66] = fz; m[67] = NEAR;
  m[68] = 1 / SHADOW; m[69] = CUR[18]; m[70] = W; m[71] = H;
  Q.writeBuffer(ubo, 0, UB);
  for (let i = 0; i < 16; i++) UBS[i] = UB[16 + i];
  UBS[35] = TIME;
  Q.writeBuffer(uboS, 0, UBS);
  PU[0] = CUR[17]; PU[1] = canvas.width; PU[2] = canvas.height; Q.writeBuffer(ubP, 0, PU);

  const e = device.createCommandEncoder();
  // shadows
  let r = e.beginRenderPass(passShadow);
  r.setBindGroup(0, bgShadow);
  r.setPipeline(sTerr); r.setVertexBuffer(0, vbTerr); r.setIndexBuffer(ibTerr, 'uint32'); r.drawIndexed(nTerr);
  r.setPipeline(sMesh); r.setVertexBuffer(0, vbScene); r.draw(nScene);
  r.setPipeline(sTree); r.setVertexBuffer(0, mPine.vb); r.setVertexBuffer(1, iPine.b); r.draw(mPine.n, iPine.n);
  r.setVertexBuffer(0, mBush.vb); r.setVertexBuffer(1, iBush.b); r.draw(mBush.n, iBush.n);
  r.setPipeline(sPeople); r.setVertexBuffer(0, mPerson.vb); r.setVertexBuffer(1, iPeople.b); r.draw(mPerson.n, iPeople.n);
  r.end();
  // scene
  r = e.beginRenderPass(passMain);
  r.setBindGroup(0, bgMain);
  r.setPipeline(pSky); r.draw(3);
  r.setPipeline(pTerr); r.setVertexBuffer(0, vbTerr); r.setIndexBuffer(ibTerr, 'uint32'); r.drawIndexed(nTerr);
  r.setPipeline(pMesh); r.setVertexBuffer(0, vbScene); r.draw(nScene); r.setVertexBuffer(0, vbFar); r.draw(nFar);
  r.setPipeline(pTree); r.setVertexBuffer(0, mPine.vb); r.setVertexBuffer(1, iPine.b); r.draw(mPine.n, iPine.n);
  r.setVertexBuffer(0, mBush.vb); r.setVertexBuffer(1, iBush.b); r.draw(mBush.n, iBush.n);
  r.setPipeline(pPeople); r.setVertexBuffer(0, mPerson.vb); r.setVertexBuffer(1, iPeople.b); r.draw(mPerson.n, iPeople.n);
  r.setPipeline(pGull); r.setVertexBuffer(0, mGull.vb); r.setVertexBuffer(1, iGull.b); r.draw(mGull.n, iGull.n);
  r.setPipeline(pBoat); r.setVertexBuffer(0, mBoat.vb); r.setVertexBuffer(1, iBoat.b); r.draw(mBoat.n, iBoat.n);
  r.setPipeline(pSea); r.setVertexBuffer(0, vbSea); r.setIndexBuffer(ibSea, 'uint32'); r.drawIndexed(nSea);
  r.end();
  // tone map to the screen
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  SUBMIT[0] = e.finish();
  Q.submit(SUBMIT);
}

let LAST = 0, poiCur = -1, poiT = 0;
const fmtT = (s) => `${s / 60 | 0}:${String(s % 60 | 0).padStart(2, '0')}`;
function frame(now) {
  requestAnimationFrame(frame);
  const dtr = now - LAST; LAST = now;
  const dt = min(dtr / 1000, 0.1);
  TIME += dt;
  // lower the resolution when frames take too long (checked every second)
  if (dtr < 500) { dynT += dtr; dynN++; }
  if (dynT > 1000) {
    const a = dynT / dynN;
    if (a > 20 && SCALE > 0.5) { SCALE = max(0.5, SCALE * 0.88); resize(); }
    else if (a < 11 && SCALE < 1) { SCALE = min(1, SCALE * 1.06); resize(); }
    dynT = dynN = 0;
  }
  // time of day eases towards the chosen one
  { const k = 1 - exp(-dt * 1.2), T = TOD[tod]; for (let i = 0; i < 19; i++) CUR[i] += (T[i] - CUR[i]) * k; }
  // look: mouse / touch through two low-pass stages
  if (tId >= 0) {
    const tr = 4 / min(innerWidth, innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
    jx = clamp(jx, -1, 1); jy = clamp(jy, -1, 1); lkx += jx * 1.4 * dt; lky += jy * 0.8 * dt;
  }
  {
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    yaw += dyw; pitch = clamp(pitch - dpt, -1.45, 1.45);
  }
  // walk: velocity eases towards the input, slower in the water
  {
    const wet = pz < 0 && feet < 0.2 && !standOn;
    const sp = (ks || tN > 1 ? 6.5 : 2.7) * (wet ? 0.5 : 1);
    const mf = tId >= 0 ? 1 : kf - kb, mr = kr - kl, l = hypot(mf, mr) || 1;
    const sy_ = sin(yaw), cy_ = cos(yaw), k = 1 - exp(-dt * 9);
    const tvx = (sy_ * mf + cy_ * mr) / l * sp, tvz = (-cy_ * mf + sy_ * mr) / l * sp;
    vx += (tvx - vx) * k; vz += (tvz - vz) * k;
    const ox = px, oz = pz;
    walk(vx * dt, vz * dt);
    const moved = hypot(px - ox, pz - oz);
    if (started && !done) walked += moved;
    // gravity, jumping, steps up and down
    const g = groundAt(px, pz, feet);
    if (kj && onGround) { vy = 4.2; onGround = false; }
    if (vy > 0 || feet > g + (onGround ? 0.35 : 0.001)) {
      vy -= 15 * dt; feet += vy * dt;
      if (feet <= g) { feet = g; vy = 0; onGround = true; } else onGround = false;
    } else { feet = g; vy = 0; onGround = true; }
    // footsteps and a little bob
    const sp2 = onGround ? moved / max(dt, 1e-4) : 0, before = floor(stepPh / PI);
    stepPh += sp2 * dt / 0.78 * PI;
    if (floor(stepPh / PI) !== before && sp2 > 0.5) playStep(standOn ? 3 : pz < -0.05 ? (feet < 0.45 ? 1 : 0) : pz < PW + 0.3 ? 2 : 4);
    const bob = -abs(sin(stepPh)) * 0.035 * min(sp2 / 2.7, 1.6);
    const target = feet + EYE + bob;
    eyeY = onGround ? eyeY + (target - eyeY) * min(1, dt * 16) : target;
    if (target - eyeY > 0.5) eyeY = target - 0.5;
  }
  // places along the way, progress and the finish
  {
    let p = -1;
    for (let i = 0; i < POI.length; i++) if (px > POI[i][0] && px < POI[i][1] && pz < 70) p = i;
    if (p !== poiCur && p >= 0 && !body.classList.contains('m')) { poiCur = p; $('pt').textContent = POI[p][2]; $('pp').textContent = POI[p][3]; poiT = 9; $('poi').className = 'on'; }
    if (p < 0) poiCur = -1;
    if (poiT > 0 && (poiT -= dt) <= 0) $('poi').className = '';
    $('dot').style.left = clamp(px / BOSC, 0, 1) * 100 + '%';
    if (started && hN % 10 === 0) $('rem').textContent = done ? 'Ziel erreicht' : `noch ${max(0, round((BOSC - px) / 10) * 10)} m bis Boscombe Pier`;
    if (started && !done && px > BOSC - 6 && pz > -240) {
      done = true;
      $('ft').textContent = `${fmtT((performance.now() - tStart) / 1000)} min · ${(walked / 1000).toFixed(2).replace('.', ',')} km gelaufen${shortcut ? ' (mit Abkürzung)' : ''}`;
      body.classList.add('f'); if (document.pointerLockElement) document.exitPointerLock();
    }
  }
  render();
  hN++;
  if (hud) {
    hT += dtr; if (dtr > hMax) hMax = dtr;
    if (hT > 500) { info.textContent = `${(hN * 1000 / hT).toFixed(0)} fps · max ${hMax.toFixed(1)} ms · ${W}×${H} (${SCALE * 100 | 0} %) · x ${px.toFixed(0)} z ${pz.toFixed(1)}`; hT = 0; hN = 0; hMax = 0; }
  }
}

// ---------------------------------------------------------------- input handlers
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': kf = v; break; case 'KeyS': case 'ArrowDown': kb = v; break;
    case 'KeyA': case 'ArrowLeft': kl = v; break; case 'KeyD': case 'ArrowRight': kr = v; break;
    case 'ShiftLeft': case 'ShiftRight': ks = v; break; case 'Space': kj = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') { hud = !hud; hT = hN = hMax = 0; info.textContent = ''; }
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'KeyT') setTod(tod + 1);
      else if (e.code === 'Escape') ui(true);
      else if (e.code >= 'Digit1' && e.code <= 'Digit5') teleport(e.code.charCodeAt(5) - 49);
    }
  }
};
addEventListener('keydown', (e) => { if (menu && !['KeyH', 'KeyM', 'KeyT'].includes(e.code)) return; if (e.code === 'Space') e.preventDefault(); sound(); key(e, 1); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ks = kj = 0; tId = -1; tN = 0; };
const capture = () => { sound(); const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', () => { if (!menu && !mob) capture(); });
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); if (menu) return; sound(); tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; }
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
let menu = true;
const bGo = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = (m ? 'm' : document.pointerLockElement ? 'g p' : 'g') + (body.classList.contains('f') && !m ? ' f' : '');
  if (m) { release(); setTimeout(() => menu && bGo.focus(), 100); } else document.activeElement.blur();
};
const go = () => {
  sound(); ui(false); bGo.textContent = 'Weiter';
  if (!started) { started = true; tStart = performance.now(); }
  if (mob) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation.lock('landscape')).catch(() => 0);
  else capture();
};
bGo.onclick = go; $('o').onclick = () => ui(true);
$('fb').onclick = () => { body.classList.remove('f'); if (!mob) capture(); };
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => { keep('bwalk', 2 - i); location.reload(); }; });
$('t').querySelectorAll('button').forEach((b, i) => { b.onclick = () => setTod(i); });
setTod(tod);
document.addEventListener('pointerlockchange', () => { if (!body.classList.contains('f')) ui(!document.pointerLockElement); });

// first frame, then the reveal
teleport(0); shortcut = false;
await say('Die Sonne kommt raus…', 1, 400);
render(); await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'bwalkLoad', '');
ui(true);
requestAnimationFrame((t) => { LAST = t; requestAnimationFrame(frame); });
