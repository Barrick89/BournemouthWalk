// ============================================================================
// renderer, walker, input and interface
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
let loaded = 0, dead;
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const fail = (m) => { throw new Error(m, { cause: 1 }); };
if (!navigator.gpu) fail('Dieser Spaziergang braucht WebGPU. Bitte einen aktuellen Chrome oder Edge verwenden.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('Kein WebGPU-Adapter gefunden.');
$('w').hidden = !!navigator.userAgentData;
const device = await adapter.requestDevice({ requiredLimits: { maxSampledTexturesPerShaderStage: min(16, adapter.limits.maxSampledTexturesPerShaderStage) } });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
device.lost.then((l) => {
  if (l.reason === 'destroyed') return;
  if (LV < 2) { keep('bwalk', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'Die Grafikkarte wurde zurückgesetzt. Bitte die Seite neu laden.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float', TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;
const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => { const b = device.createBuffer({ size: max(16, (data.byteLength + 3) & ~3), usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data); return b; };
const tex2 = (w, h, format, usage, samples = 1) => device.createTexture({ size: [w, h], format, usage, sampleCount: samples });

// ---------------------------------------------------------------- the world
await say('Lade die Küste…', 0.08, 500);
keep('bwalkLoad', 1);
addEventListener('pagehide', () => keep('bwalkLoad', ''));
await loadWorld();
await say('Baue Promenade, Piers und Strandhütten…', 0.3, 1200);
buildWorld();
initPeople(); initPlaces();
await say('Pflanze Kiefern und Ginster…', 0.55, 600);
const TD = terrainMesh(HD, GD, 64, null, true);
const dx1 = GD.x0 + (GD.nx - 1) * GD.d, dz1 = GD.z0 + (GD.nz - 1) * GD.d;
const TC = terrainMesh(HC, GC, 32, (x, z) => x > GD.x0 && x < dx1 && z > GD.z0 && z < dz1, false);
// static chunks into one buffer
const statics = []; let nStatic = 0;
for (const [, m] of CHUNKS) if (m.n) { statics.push({ m, first: nStatic, count: m.n, box: [...m.box3] }); nStatic += m.n; }
const vbStatic = device.createBuffer({ size: nStatic * 32, usage: BU.VERTEX | BU.COPY_DST });
for (const s of statics) { Q.writeBuffer(vbStatic, s.first * 32, s.m.pack()); s.m = null; }
CHUNKS.clear();
const meshBuf = (m) => { const b = m.pack(); return { vb: buf(b, BU.VERTEX), n: b.byteLength / 32 }; };
const mFar = meshBuf(FAR), mPine = meshBuf(pineMesh(0)), mPineL = meshBuf(pineMesh(1)), mBroad = meshBuf(broadMesh(0)), mBroadL = meshBuf(broadMesh(1));
const mShrub = meshBuf(shrubMesh()), mGrass = meshBuf(grassMesh()), mPerson = meshBuf(personMesh()), mGull = meshBuf(gullMesh()), mBoat = meshBuf(boatMesh());
console.log('static vertices', nStatic, 'trees', VEG.pine.length / 8 + VEG.broad.length / 8, 'shrubs', VEG.shrub.length / 8, 'terrain tris', (TD.ib.length + TC.ib.length) / 3);
const vegI = {}; for (const k of ['pine', 'broad', 'shrub']) { const c = chunkInstances(VEG[k], k === 'shrub' ? 1 : 0.4); vegI[k] = { b: buf(c.data, BU.VERTEX), chunks: c.chunks }; }
const iPeople = device.createBuffer({ size: WALK.n * 32, usage: BU.VERTEX | BU.COPY_DST });
const GULLS = buildGulls(), BOATS = buildBoats(), iGull = buf(GULLS, BU.VERTEX), iBoat = buf(BOATS, BU.VERTEX);
const SEA = seaGrid(), vbSea = buf(SEA.vb, BU.VERTEX), ibSea = buf(SEA.ib, BU.INDEX);
const vbTD = buf(TD.vb, BU.VERTEX), ibTD = buf(TD.ib, BU.INDEX), vbTC = buf(TC.vb, BU.VERTEX), ibTC = buf(TC.ib, BU.INDEX);
// data textures: heights (r32float) and surface classes (r8uint)
const dataTex = (w, h, format, data, bpp) => { const t = device.createTexture({ size: [w, h], format, usage: TU.TEXTURE_BINDING | TU.COPY_DST }); Q.writeTexture({ texture: t }, data, { bytesPerRow: w * bpp }, [w, h]); return t; };
const tHD = dataTex(GD.nx, GD.nz, 'r32float', HD, 4), tHC = dataTex(GC.nx, GC.nz, 'r32float', HC, 4);
const tMD = dataTex(GD.nx * WD.H.mdscale, GD.nz * WD.H.mdscale, 'r8uint', MD, 1), tMC = dataTex(GC.nx, GC.nz, 'r8uint', MC, 1);

// ---------------------------------------------------------------- textures, uniforms, bind groups
await say('Male Sand, Sandstein und Ziegel…', 0.75, 700);
const TX = makeTextures(device, 512);
const tLut = tex2(192, 108, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tAmb = tex2(8, 1, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const dLut = tex2(1, 1, HDR, TU.TEXTURE_BINDING), dAmb = tex2(8, 1, HDR, TU.TEXTURE_BINDING);
const tShadow = device.createTexture({ size: [SHADOW, SHADOW, 3], format: DEPTH, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const dShadow = device.createTexture({ size: [1, 1, 3], format: DEPTH, usage: TU.TEXTURE_BINDING });
const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: LV > 1 ? 2 : 8 });
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const sCmp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
const UF = 112, UB = new Float32Array(UF), UC = [new Float32Array(UF), new Float32Array(UF), new Float32Array(UF)];
const ubo = device.createBuffer({ size: UF * 4, usage: BU.UNIFORM | BU.COPY_DST }), uboC = [0, 1, 2].map(() => device.createBuffer({ size: UF * 4, usage: BU.UNIFORM | BU.COPY_DST }));
const VF = SS.VERTEX | SS.FRAGMENT;
const T2 = (b, sampleType = 'float', viewDimension = '2d') => ({ binding: b, visibility: VF, texture: { sampleType, viewDimension } });
const bgl = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} }, { binding: 1, visibility: VF, sampler: { type: 'comparison' } }, T2(2, 'depth', '2d-array'),
  { binding: 3, visibility: VF, sampler: {} }, T2(4, 'float', '2d-array'), T2(5, 'float', '2d-array'), T2(6, 'float', '2d-array'), T2(7),
  T2(8, 'unfilterable-float'), T2(9, 'unfilterable-float'), T2(10, 'uint'), T2(11, 'uint'), T2(12), { binding: 13, visibility: VF, sampler: {} }, T2(14)] });
const mkBG = (u, sh, lut, amb) => device.createBindGroup({ layout: bgl, entries: [
  { binding: 0, resource: { buffer: u } }, { binding: 1, resource: sCmp }, { binding: 2, resource: sh.createView({ dimension: '2d-array' }) }, { binding: 3, resource: sRep },
  { binding: 4, resource: TX.matA.createView({ dimension: '2d-array' }) }, { binding: 5, resource: TX.matN.createView({ dimension: '2d-array' }) }, { binding: 6, resource: TX.fol.createView({ dimension: '2d-array' }) },
  { binding: 7, resource: lut.createView() }, { binding: 8, resource: tHD.createView() }, { binding: 9, resource: tHC.createView() },
  { binding: 10, resource: tMD.createView() }, { binding: 11, resource: tMC.createView() }, { binding: 12, resource: TX.noise.createView() }, { binding: 13, resource: sClamp }, { binding: 14, resource: amb.createView() }] });
const bgMain = mkBG(ubo, tShadow, tLut, tAmb), bgLut = mkBG(ubo, dShadow, dLut, dAmb), bgCas = uboC.map((u) => mkBG(u, dShadow, tLut, tAmb));
const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

// ---------------------------------------------------------------- pipelines
await say('Stelle das Licht ein…', 0.88, 600);
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vTer = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const vTerS = { arrayStride: 16, attributes: [A(0, 0, 'float32x3')] };
const vObj = { arrayStride: 32, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4'), A(2, 16, 'float32x2'), A(3, 24, 'unorm8x4'), A(4, 28, 'unorm8x4')] };
const vObjS = { arrayStride: 32, attributes: [A(0, 0, 'float32x3')] };
const vInst = { arrayStride: 32, stepMode: 'instance', attributes: [A(5, 0, 'float32x4'), A(6, 16, 'float32x4')] };
const vSea = { arrayStride: 8, attributes: [A(0, 0, 'float32x2')] };
const ALPHA = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
const mSky = mod(W_SKY), mLut = mod(W_SKYLUT), mTer = mod(W_TERRAIN), mObj = mod(W_OBJ), mVeg = mod(W_VEG), mSea = mod(W_SEA);
const scene = (m, vs, buffers, o = {}) => device.createRenderPipeline({ layout: pl,
  vertex: { module: m, entryPoint: vs, buffers }, fragment: { module: m, entryPoint: o.fs || 'fs', targets: [{ format: HDR }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.sky, depthCompare: o.sky ? 'always' : 'greater' }, multisample: { count: AA, alphaToCoverageEnabled: !!o.a2c && AA > 1 } });
const shadow = (m, vs, buffers, fs) => device.createRenderPipeline({ layout: pl,
  vertex: { module: m, entryPoint: vs, buffers }, fragment: fs ? { module: m, entryPoint: fs, targets: [] } : undefined,
  primitive: { topology: 'triangle-list', cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 } });
const pSky = scene(mSky, 'vs', [], { sky: 1 }), pTer = scene(mTer, 'vs', [vTer]), pObj = scene(mObj, 'vs', [vObj]);
const pPeople = scene(mObj, 'vsPeople', [vObj, vInst]), pGull = scene(mObj, 'vsGull', [vObj, vInst]), pBoat = scene(mObj, 'vsBoat', [vObj, vInst]);
const pVeg = scene(mVeg, 'vs', [vObj, vInst], { a2c: 1 }), pGrass = scene(mVeg, 'vsGrass', [vObj], { a2c: 1 });
const sTer = shadow(mTer, 'vsShadow', [vTerS]), sObj = shadow(mObj, 'vsShadow', [vObjS]), sPeople = shadow(mObj, 'vsPeopleShadow', [vObj, vInst]), sVeg = shadow(mVeg, 'vsShadow', [vObj, vInst], 'fsShadow');
const pLut = device.createRenderPipeline({ layout: pl, vertex: { module: mLut, entryPoint: 'vs' }, fragment: { module: mLut, entryPoint: 'fsLut', targets: [{ format: HDR }] } });
const bglLut1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }] });
const pAmb = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl, bglLut1] }), vertex: { module: mLut, entryPoint: 'vs' }, fragment: { module: mLut, entryPoint: 'fsAmb', targets: [{ format: HDR }] } });
const bgAmb1 = device.createBindGroup({ layout: bglLut1, entries: [{ binding: 0, resource: tLut.createView() }] });
const bglSea1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }] });
const pSea = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl, bglSea1] }),
  vertex: { module: mSea, entryPoint: 'vs', buffers: [vSea] }, fragment: { module: mSea, entryPoint: 'fs', targets: [{ format: HDR, blend: ALPHA }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' } });
const auto = (code, fs, format, extra = {}) => { const m = mod(code); return device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: fs, targets: [{ format, blend: extra.blend }] }, depthStencil: extra.depth }); };
const pDepth = auto(AA > 1 ? W_DEPTH : W_DEPTH.replace('texture_depth_multisampled_2d', 'texture_depth_2d'), 'fs', 'r32float', { depth: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'always' } });
const pAO = auto(W_AO, 'fs', 'r8unorm'), pComp = auto(W_COMP, 'fs', HDR), pPost = auto(W_POST, 'fs', FMT);
const pDown = auto(W_BLOOM, 'fsDown', HDR), pUp = auto(W_BLOOM, 'fsUp', HDR, { blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } });
const ubNear = buf(new Float32Array([0.1, 0, 0, 0]), BU.UNIFORM), AOU = new Float32Array(16), ubAO = device.createBuffer({ size: 64, usage: BU.UNIFORM | BU.COPY_DST });
const PU = new Float32Array(4), ubPost = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

// ---------------------------------------------------------------- render targets (rebuilt on resize)
let W = 0, H = 0, RT = {}, bgDepth, bgAO, bgComp, bgSea1, bgPost, bloomBG = [], bloomPass = [];
const NB = 5;
const passLut = { colorAttachments: [{ view: tLut.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
const passAmb = { colorAttachments: [{ view: tAmb.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
const passCas = [0, 1, 2].map((i) => ({ colorAttachments: [], depthStencilAttachment: { view: tShadow.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }));
const passMain = { colorAttachments: [{ view: null, resolveTarget: undefined, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }], depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
const passDepth = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }], depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
const passAO = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] };
const passComp = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
const passSea = { colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }], depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' } };
const passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
function resize() {
  const r = rot.matches, cw = r ? innerHeight : innerWidth, ch = r ? innerWidth : innerHeight;
  const dpr = min(devicePixelRatio || 1, 2), k = min(1, sqrt(3.7e6 / (cw * ch * dpr * dpr)));
  const DW = max(1, round(cw * dpr * k)), DH = max(1, round(ch * dpr * k));
  if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
  const w = max(16, round(DW * SCALE)), h = max(16, round(DH * SCALE));
  if (w === W && h === H) return;
  W = w; H = h;
  for (const k in RT) RT[k]?.destroy?.();
  const RA = TU.RENDER_ATTACHMENT, TB = TU.TEXTURE_BINDING;
  RT = { scene: tex2(W, H, HDR, RA | TB), lit: tex2(W, H, HDR, RA | TB), msc: AA > 1 ? tex2(W, H, HDR, RA, AA) : null, msd: tex2(W, H, DEPTH, RA | TB, AA),
    d1: tex2(W, H, DEPTH, RA), lin: tex2(W, H, 'r32float', RA | TB), ao: tex2(max(1, W >> 1), max(1, H >> 1), 'r8unorm', RA | TB) };
  for (let i = 0; i < NB; i++) RT['b' + i] = tex2(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, RA | TB);
  const c0 = passMain.colorAttachments[0];
  if (AA > 1) { c0.view = RT.msc.createView(); c0.resolveTarget = RT.scene.createView(); } else { c0.view = RT.scene.createView(); c0.resolveTarget = undefined; }
  passMain.depthStencilAttachment.view = RT.msd.createView();
  passDepth.colorAttachments[0].view = RT.lin.createView(); passDepth.depthStencilAttachment.view = RT.d1.createView();
  passAO.colorAttachments[0].view = RT.ao.createView(); passComp.colorAttachments[0].view = RT.lit.createView();
  passSea.colorAttachments[0].view = RT.lit.createView(); passSea.depthStencilAttachment.view = RT.d1.createView();
  bgDepth = device.createBindGroup({ layout: pDepth.getBindGroupLayout(0), entries: [{ binding: 0, resource: RT.msd.createView() }, { binding: 1, resource: { buffer: ubNear } }] });
  bgAO = device.createBindGroup({ layout: pAO.getBindGroupLayout(0), entries: [{ binding: 0, resource: RT.lin.createView() }, { binding: 1, resource: { buffer: ubAO } }] });
  bgComp = device.createBindGroup({ layout: pComp.getBindGroupLayout(0), entries: [{ binding: 0, resource: RT.scene.createView() }, { binding: 1, resource: RT.ao.createView() }, { binding: 2, resource: RT.lin.createView() }] });
  bgSea1 = device.createBindGroup({ layout: bglSea1, entries: [{ binding: 0, resource: RT.scene.createView() }, { binding: 1, resource: RT.lin.createView() }] });
  // bloom: down from the lit image through NB levels, then back up adding each level
  const bb = (t) => device.createBindGroup({ layout: pDown.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: sClamp }] });
  const bu = (t) => device.createBindGroup({ layout: pUp.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: sClamp }] });
  bloomBG = []; bloomPass = [];
  for (let i = 0; i < NB; i++) { bloomBG.push(bb(i ? RT['b' + (i - 1)] : RT.lit)); bloomPass.push({ colorAttachments: [{ view: RT['b' + i].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }); }
  for (let i = NB - 1; i > 0; i--) { bloomBG.push(bu(RT['b' + i])); bloomPass.push({ colorAttachments: [{ view: RT['b' + (i - 1)].createView(), loadOp: 'load', storeOp: 'store' }] }); }
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubPost } }, { binding: 1, resource: RT.lit.createView() }, { binding: 2, resource: RT.b0.createView() }, { binding: 3, resource: sClamp }] });
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- time of day
// sun direction (x east, y up, z north), haze, cloud cover, exposure, evening (lamps and windows)
const TOD = [
  [0.912, 0.242, -0.332, 30, 0.35, 0.3, 0],
  [0.0, 0.819, -0.574, 16, 0.3, 0.2, 0],
  [-0.904, 0.07, -0.422, 24, 0.42, 0.55, 0.85],
];
const TODN = ['Morgen', 'Mittag', 'Abend'];
let tod = 1;
try { const t = +localStorage.bwalkTod; if (t >= 0 && t < 3) tod = t; } catch {}
const CUR = Float32Array.from(TOD[tod]);
const setTod = (t) => { tod = (t + 3) % 3; keep('bwalkTod', tod); $('t').querySelectorAll('button').forEach((b, i) => b.className = i === tod ? 'on' : ''); };

// ---------------------------------------------------------------- walker
let px = 0, pz = 0, feet = 3, vy = 0, yaw = 0, pitch = 0, vx = 0, vz = 0, eyeY = 5, stepPh = 0, onGround = true, standOn = 0;
let TIME = 0, walked = 0, started = false, tStart = 0, done = false, shortcut = false, shoreDist = 0, progS = 0;
const STEP = 0.55, RAD = 0.3, EYE = 1.62, LEVEL = 0.2;
for (const p of PLAT) { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of p.ring) { x0 = min(x0, x); x1 = max(x1, x); z0 = min(z0, z); z1 = max(z1, z); } p.bb = [x0, x1, z0, z1]; }
// what you stand on: the terrain, or a pier deck / groyne top within a step of your feet
function groundAt(x, z, f) {
  let g = terrainH(x, z); standOn = 0;
  for (let i = 0; i < PLAT.length; i++) {
    const p = PLAT[i], b = p.bb; if (x < b[0] || x > b[1] || z < b[2] || z > b[3] || !pip(p.ring, x, z)) continue;
    const t = p.groyne ? terrainH(x, z) + 0.75 : p.y;
    if (t <= f + STEP && t > g) { g = t; standOn = p.groyne ? 2 : 1; }
  }
  return g;
}
function blocked(x, z, f, d) {
  if (x < -2100 || x > 4300 || z < -1250 || z > 1450) return true;
  const g = groundAt(x, z, f);
  if (!standOn && g < LEVEL - 0.85) return true; // no swimming
  if (!standOn && g > f + 0.03 && g - f > d * 0.9 + 0.02) return true; // too steep (about 42 degrees)
  if (standOn && g > f + STEP) return true;
  const k0 = floor((x - RAD) / 8), k1 = floor((x + RAD) / 8), j0 = floor((z - RAD) / 8), j1 = floor((z + RAD) / 8);
  for (let kx = k0; kx <= k1; kx++) for (let kz = j0; kz <= j1; kz++) {
    const l = SEGH.get((kx + 4096) * 8192 + kz + 4096); if (!l) continue;
    for (let n = 0; n < l.length; n++) {
      const i = l[n], ax = SEGF[i], az = SEGF[i + 1], ex = SEGF[i + 2] - ax, ez = SEGF[i + 3] - az, l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1), qx = ax + ex * t - x, qz = az + ez * t - z;
      if (qx * qx + qz * qz > RAD * RAD) continue;
      if (SEGF[i + 5] > f + STEP && SEGF[i + 4] < f + 1.75) return true;
    }
  }
  return false;
}
function walk(wx, wz) {
  const d = hypot(wx, wz); if (d < 1e-6) return;
  const n = Math.ceil(d / 0.12), sx = wx / n, sz = wz / n;
  for (let i = 0; i < n; i++) {
    if (!blocked(px + sx, pz + sz, feet, hypot(sx, sz))) { px += sx; pz += sz; }
    else if (!blocked(px + sx, pz, feet, abs(sx))) px += sx;
    else if (!blocked(px, pz + sz, feet, abs(sz))) pz += sz;
    const g = groundAt(px, pz, feet); if (g > feet) feet = g;
  }
}
function teleport(i) {
  const p = POSES[i];
  px = p[0]; pz = p[1]; yaw = p[2]; pitch = p[3]; vx = vz = vy = 0;
  feet = groundAt(px, pz, 60); eyeY = feet + EYE; lkx = lky = l2x = l2y = 0;
  if (i > 0) shortcut = true;
}

// ---------------------------------------------------------------- input state
let kf = 0, kb = 0, kl = 0, kr = 0, ks = 0, kj = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0;
let tId = -1, tN = 0, tx = 0, ty = 0, tx0 = 0, ty0 = 0;
let hud = false, hN = 0, hT = 0, hMax = 0, dynT = 0, dynN = 0;

// ---------------------------------------------------------------- culling
const FR = new Float32Array(16); // 4 planes of the view frustum
function frustum(m) {
  const P = (k, s, r) => { FR[k] = m[3] + s * m[r]; FR[k + 1] = m[7] + s * m[r + 4]; FR[k + 2] = m[11] + s * m[r + 8]; FR[k + 3] = m[15] + s * m[r + 12]; };
  P(0, 1, 0); P(4, -1, 0); P(8, 1, 1); P(12, -1, 1);
}
const inView = (b) => { for (let k = 0; k < 16; k += 4) { const x = FR[k] > 0 ? b[3] : b[0], y = FR[k + 1] > 0 ? b[4] : b[1], z = FR[k + 2] > 0 ? b[5] : b[2]; if (FR[k] * x + FR[k + 1] * y + FR[k + 2] * z + FR[k + 3] < 0) return false; } return true; };
// cascade boxes: centre and the two light-space axes, half size
const CAS = [0, 1, 2].map(() => ({ c: new Float64Array(3), R: 1 }));
let LA = [1, 0, 0], LB = [0, 1, 0];
const inCas = (b, k) => {
  const c = CAS[k], hx = (b[3] - b[0]) / 2, hy = (b[4] - b[1]) / 2, hz = (b[5] - b[2]) / 2, mx = (b[0] + b[3]) / 2 - c.c[0], my = (b[1] + b[4]) / 2 - c.c[1], mz = (b[2] + b[5]) / 2 - c.c[2];
  for (const a of [LA, LB]) { const e = abs(a[0] * hx) + abs(a[1] * hy) + abs(a[2] * hz); if (abs(a[0] * mx + a[1] * my + a[2] * mz) > c.R + e) return false; }
  return true;
};
const boxDist = (b, x, y, z) => hypot(max(b[0] - x, 0, x - b[3]), max(b[1] - y, 0, y - b[4]), max(b[2] - z, 0, z - b[5]));

// ---------------------------------------------------------------- per frame
const SUBMIT = [null];
const SPLITS = LV > 1 ? [16, 60, 220] : [20, 75, 300];
const TANH = 0.6, NEAR = 0.1;
function setCam(m, cx, cy, cz, rx, rz, ux, uy, uz, fx, fy, fz) {
  const asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
}
function drawVeg(r, k, near, far, cascade, maxD, cx, cy, cz) {
  const I = vegI[k]; r.setVertexBuffer(1, I.b);
  for (let pass = 0; pass < 2; pass++) {
    const mesh = pass ? far : near; if (!mesh) continue; r.setVertexBuffer(0, mesh.vb);
    for (const c of I.chunks) {
      const d = boxDist(c.box, cx, cy, cz); if (d > maxD) continue;
      if ((pass === 0) !== (d < (far ? 140 : 1e9))) continue;
      if (cascade < 0 ? !inView(c.box) : !inCas(c.box, cascade)) continue;
      r.draw(mesh.n, c.count, 0, c.first);
    }
  }
}
function render() {
  const cx = px, cy = eyeY, cz = pz;
  // forward (sin yaw, ., -cos yaw); right = up x forward (x east, z north: facing east, the right hand points south)
  const cp = cos(pitch), fy = sin(pitch), sw = sin(yaw), cw = cos(yaw), fx = cp * sw, fz = -cp * cw, rx = -cw, rz = -sw;
  const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  const m = UB; setCam(m, cx, cy, cz, rx, rz, ux, uy, uz, fx, fy, fz); frustum(m);
  // sun and cascades
  let lx = CUR[0], ly = CUR[1], lz = CUR[2]; const ll = hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
  let ax = lz, az = -lx; const al = hypot(ax, az) || 1; ax /= al; az /= al; LA = [ax, 0, az];
  LB = [ly * az, lz * ax - lx * az, -ly * ax];
  const asp = W / H;
  for (let k = 0; k < 3; k++) {
    const n = k ? SPLITS[k - 1] : NEAR, f = SPLITS[k], mid = (n + f) / 2;
    const R = hypot(f * TANH * asp, f * TANH, (f - n) / 2) * 1.02, D = 700, c = CAS[k]; c.R = R;
    let ox = cx + fx * mid, oy = cy + fy * mid, oz = cz + fz * mid;
    const tx_ = 2 * R / SHADOW, pa = round((ax * ox + az * oz) / tx_) * tx_, pb = round((LB[0] * ox + LB[1] * oy + LB[2] * oz) / tx_) * tx_;
    c.c[0] = ox; c.c[1] = oy; c.c[2] = oz;
    const o = 48 + k * 16;
    m[o] = ax / R; m[o + 4] = 0; m[o + 8] = az / R; m[o + 12] = -pa / R;
    m[o + 1] = LB[0] / R; m[o + 5] = LB[1] / R; m[o + 9] = LB[2] / R; m[o + 13] = -pb / R;
    m[o + 2] = -lx / (2 * D); m[o + 6] = -ly / (2 * D); m[o + 10] = -lz / (2 * D); m[o + 14] = (lx * ox + ly * oy + lz * oz + D) / (2 * D);
    m[o + 3] = 0; m[o + 7] = 0; m[o + 11] = 0; m[o + 15] = 1;
  }
  m[16] = cx; m[17] = cy; m[18] = cz; m[19] = TIME;
  m[20] = lx; m[21] = ly; m[22] = lz; m[23] = CUR[4];
  m[24] = CUR[3]; m[25] = 0; m[26] = CUR[6]; m[27] = CUR[5];
  m[28] = rx; m[29] = 0; m[30] = rz; m[31] = TANH * asp;
  m[32] = ux; m[33] = uy; m[34] = uz; m[35] = TANH;
  m[36] = fx; m[37] = fy; m[38] = fz; m[39] = NEAR;
  m[40] = W; m[41] = H; m[42] = 1 / W; m[43] = 1 / H;
  m[44] = 1; m[45] = 0.3; m[46] = 1; m[47] = 0;
  m[96] = SPLITS[0]; m[97] = SPLITS[1]; m[98] = SPLITS[2]; m[99] = 2 * CAS[0].R / SHADOW;
  Q.writeBuffer(ubo, 0, UB);
  for (let k = 0; k < 3; k++) { const c = UC[k]; c.set(UB); for (let i = 0; i < 16; i++) c[i] = UB[48 + k * 16 + i]; Q.writeBuffer(uboC[k], 0, c); }
  AOU[0] = rx; AOU[1] = 0; AOU[2] = rz; AOU[3] = TANH * asp; AOU[4] = ux; AOU[5] = uy; AOU[6] = uz; AOU[7] = TANH; AOU[8] = fx; AOU[9] = fy; AOU[10] = fz; AOU[12] = W; AOU[13] = H;
  Q.writeBuffer(ubAO, 0, AOU);
  PU[0] = CUR[5]; PU[1] = canvas.width; PU[2] = canvas.height; PU[3] = TIME % 100; Q.writeBuffer(ubPost, 0, PU);
  Q.writeBuffer(iPeople, 0, WALK.data);

  const e = device.createCommandEncoder();
  // sky table and ambient light
  let r = e.beginRenderPass(passLut); r.setPipeline(pLut); r.setBindGroup(0, bgLut); r.draw(3); r.end();
  r = e.beginRenderPass(passAmb); r.setPipeline(pAmb); r.setBindGroup(0, bgLut); r.setBindGroup(1, bgAmb1); r.draw(3); r.end();
  // shadow cascades
  for (let k = 0; k < 3; k++) {
    r = e.beginRenderPass(passCas[k]); r.setBindGroup(0, bgCas[k]);
    r.setPipeline(sTer);
    r.setVertexBuffer(0, vbTD); r.setIndexBuffer(ibTD, 'uint32'); for (const t of TD.tiles) if (inCas(t.box, k)) r.drawIndexed(t.count, 1, t.first);
    r.setVertexBuffer(0, vbTC); r.setIndexBuffer(ibTC, 'uint32'); for (const t of TC.tiles) if (inCas(t.box, k)) r.drawIndexed(t.count, 1, t.first);
    r.setPipeline(sObj); r.setVertexBuffer(0, vbStatic); for (const s of statics) if (inCas(s.box, k) && boxDist(s.box, cx, cy, cz) < SPLITS[k] + 200) r.draw(s.count, 1, s.first);
    r.setPipeline(sVeg);
    drawVeg(r, 'pine', mPine, mPineL, k, SPLITS[k] + 150, cx, cy, cz); drawVeg(r, 'broad', mBroad, mBroadL, k, SPLITS[k] + 100, cx, cy, cz);
    if (k < 2) drawVeg(r, 'shrub', mShrub, null, k, SPLITS[k] + 10, cx, cy, cz);
    if (k < 2) { r.setPipeline(sPeople); r.setVertexBuffer(0, mPerson.vb); r.setVertexBuffer(1, iPeople); r.draw(mPerson.n, WALK.n); }
    r.end();
  }
  // the scene
  r = e.beginRenderPass(passMain); r.setBindGroup(0, bgMain);
  r.setPipeline(pSky); r.draw(3);
  r.setPipeline(pTer);
  r.setVertexBuffer(0, vbTD); r.setIndexBuffer(ibTD, 'uint32'); for (const t of TD.tiles) if (inView(t.box)) r.drawIndexed(t.count, 1, t.first);
  r.setVertexBuffer(0, vbTC); r.setIndexBuffer(ibTC, 'uint32'); for (const t of TC.tiles) if (inView(t.box)) r.drawIndexed(t.count, 1, t.first);
  r.setPipeline(pObj); r.setVertexBuffer(0, vbStatic); for (const s of statics) if (inView(s.box) && boxDist(s.box, cx, cy, cz) < 4500) r.draw(s.count, 1, s.first);
  r.setVertexBuffer(0, mFar.vb); r.draw(mFar.n);
  r.setPipeline(pPeople); r.setVertexBuffer(0, mPerson.vb); r.setVertexBuffer(1, iPeople); r.draw(mPerson.n, WALK.n);
  r.setPipeline(pGull); r.setVertexBuffer(0, mGull.vb); r.setVertexBuffer(1, iGull); r.draw(mGull.n, GULLS.length / 8);
  r.setPipeline(pBoat); r.setVertexBuffer(0, mBoat.vb); r.setVertexBuffer(1, iBoat); r.draw(mBoat.n, BOATS.length / 8);
  r.setPipeline(pVeg);
  drawVeg(r, 'pine', mPine, mPineL, -1, 3000, cx, cy, cz); drawVeg(r, 'broad', mBroad, mBroadL, -1, 2200, cx, cy, cz); drawVeg(r, 'shrub', mShrub, null, -1, 450, cx, cy, cz);
  r.setPipeline(pGrass); r.setVertexBuffer(0, mGrass.vb); r.draw(mGrass.n, LV > 1 ? 120 * 120 : 180 * 180);
  r.end();
  // depth -> distance, ambient occlusion, composite
  r = e.beginRenderPass(passDepth); r.setPipeline(pDepth); r.setBindGroup(0, bgDepth); r.draw(3); r.end();
  r = e.beginRenderPass(passAO); r.setPipeline(pAO); r.setBindGroup(0, bgAO); r.draw(3); r.end();
  r = e.beginRenderPass(passComp); r.setPipeline(pComp); r.setBindGroup(0, bgComp); r.draw(3); r.end();
  // the sea, over the lit scene
  r = e.beginRenderPass(passSea); r.setPipeline(pSea); r.setBindGroup(0, bgMain); r.setBindGroup(1, bgSea1);
  r.setVertexBuffer(0, vbSea); r.setIndexBuffer(ibSea, 'uint32'); r.drawIndexed(SEA.ib.length); r.end();
  // bloom and the final image
  for (let i = 0; i < bloomPass.length; i++) { r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end(); }
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  SUBMIT[0] = e.finish(); Q.submit(SUBMIT);
}

let LAST = 0, poiCur = -1, poiT = 0;
const fmtT = (s) => `${s / 60 | 0}:${String(s % 60 | 0).padStart(2, '0')}`;
function frame(now) {
  requestAnimationFrame(frame);
  const dtr = now - LAST; LAST = now;
  const dt = min(dtr / 1000, 0.1);
  TIME += dt;
  if (dtr < 500) { dynT += dtr; dynN++; }
  if (dynT > 1000) {
    const a = dynT / dynN;
    if (a > 21 && SCALE > 0.5) { SCALE = max(0.5, SCALE * 0.88); resize(); }
    else if (a < 11 && SCALE < 1) { SCALE = min(1, SCALE * 1.06); resize(); }
    dynT = dynN = 0;
  }
  { const k = 1 - exp(-dt * 1.2), T = TOD[tod]; for (let i = 0; i < 7; i++) CUR[i] += (T[i] - CUR[i]) * k; }
  if (tId >= 0) {
    const tr = 4 / min(innerWidth, innerHeight); const jx = clamp((tx - tx0) * tr, -1, 1), jy = clamp((ty - ty0) * tr, -1, 1);
    lkx += jx * 1.4 * dt; lky += jy * 0.8 * dt;
  }
  {
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    yaw -= dyw; pitch = clamp(pitch - dpt, -1.45, 1.45);
  }
  {
    const wet = !standOn && feet < LEVEL + 0.15;
    const sp = (ks || tN > 1 ? 6.5 : 2.7) * (wet ? 0.5 : 1);
    const mf = tId >= 0 ? 1 : kf - kb, mr = kr - kl, l = hypot(mf, mr) || 1;
    const sy_ = sin(yaw), cy_ = cos(yaw), k = 1 - exp(-dt * 9);
    vx += ((sy_ * mf - cy_ * mr) / l * sp - vx) * k; vz += ((-cy_ * mf - sy_ * mr) / l * sp - vz) * k;
    const ox = px, oz = pz;
    walk(vx * dt, vz * dt);
    const moved = hypot(px - ox, pz - oz);
    if (started && !done) walked += moved;
    const g = groundAt(px, pz, feet);
    if (kj && onGround) { vy = 4.2; onGround = false; }
    if (vy > 0 || feet > g + (onGround ? 0.4 : 0.001)) {
      vy -= 15 * dt; feet += vy * dt;
      if (feet <= g) { feet = g; vy = 0; onGround = true; } else onGround = false;
    } else { feet = g; vy = 0; onGround = true; }
    const sp2 = onGround ? moved / max(dt, 1e-4) : 0, before = floor(stepPh / PI);
    stepPh += sp2 * dt / 0.78 * PI;
    if (floor(stepPh / PI) !== before && sp2 > 0.5) { const c = maskAt(px, pz); playStep(standOn ? 3 : c === 1 ? (feet < 0.9 ? 1 : 0) : c === 5 || c === 6 || c === 7 || c === 9 || c === 11 ? 4 : 2); }
    const bob = -abs(sin(stepPh)) * 0.035 * min(sp2 / 2.7, 1.6), target = feet + EYE + bob;
    eyeY = onGround ? eyeY + (target - eyeY) * min(1, dt * 16) : target;
    if (target - eyeY > 0.5) eyeY = target - 0.5;
  }
  updatePeople(dt);
  // progress along the shore, places, the finish
  {
    progS = plProject(COAST, px, pz); shoreDist = _pl[0] + 15;
    let p = -1;
    for (let i = 0; i < POI.length; i++) if (hypot(px - POI[i][0], pz - POI[i][1]) < POI[i][2]) p = i;
    if (p !== poiCur && p >= 0 && !body.classList.contains('m')) { poiCur = p; $('pt').textContent = POI[p][3]; $('pp').textContent = POI[p][4]; poiT = 9; $('poi').className = 'on'; }
    if (p < 0) poiCur = -1;
    if (poiT > 0 && (poiT -= dt) <= 0) $('poi').className = '';
    $('dot').style.left = clamp((progS - S_B) / (S_S - S_B), 0, 1) * 100 + '%';
    if (started && hN % 10 === 0) $('rem').textContent = done ? 'Ziel erreicht' : `noch ${max(0, round((S_S - progS) / 10) * 10)} m bis Boscombe Pier`;
    if (started && !done && progS > S_S - 15 && progS < S_S + 80) {
      done = true;
      $('ft').textContent = `${fmtT((performance.now() - tStart) / 1000)} min · ${(walked / 1000).toFixed(2).replace('.', ',')} km gelaufen${shortcut ? ' (mit Abkürzung)' : ''}`;
      body.classList.add('f'); if (document.pointerLockElement) document.exitPointerLock();
    }
  }
  render();
  hN++;
  if (hud) {
    hT += dtr; if (dtr > hMax) hMax = dtr;
    if (hT > 500) { info.textContent = `${(hN * 1000 / hT).toFixed(0)} fps · max ${hMax.toFixed(1)} ms · ${W}×${H} (${SCALE * 100 | 0} %) · x ${px.toFixed(0)} z ${pz.toFixed(0)} h ${feet.toFixed(1)}`; hT = 0; hN = 0; hMax = 0; }
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
// Chrome can report one huge jump right after the mouse is captured: skip the first moments and any absurd jumps
let lockT = 0;
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas || performance.now() - lockT < 150 || abs(e.movementX) > 400 || abs(e.movementY) > 400) return;
  mdx += e.movementX; mdy += e.movementY;
});
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
document.addEventListener('pointerlockchange', () => { lockT = performance.now(); mdx = mdy = 0; if (!body.classList.contains('f')) ui(!document.pointerLockElement); });

window.__bw = () => ({ px, pz, feet, eyeY, yaw, pitch, W, H, SCALE, progS, standOn }); // for testing
window.__go = (x, z, y, p, t) => { px = x; pz = z; yaw = y; pitch = p; feet = groundAt(px, pz, 60); eyeY = feet + EYE; vx = vz = 0; if (t != null) { tod = t; CUR.set(TOD[t]); } };
teleport(0); shortcut = false;
updatePeople(0);
await say('Die Sonne kommt raus…', 1, 400);
render(); await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'bwalkLoad', '');
ui(true);
requestAnimationFrame((t) => { LAST = t; requestAnimationFrame(frame); });
