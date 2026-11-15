# Builds source/data/world.bin: everything the game knows about the real seafront, in one compact file.
#
# Input (see fetch_dem.py and fetch_overture.py): raw/dem.npy (terrain, ~3 m) and raw/*.geojson (Overture Maps,
# derived from OpenStreetMap, ODbL). Output: a raw-deflated buffer the page inflates at load time:
#   u32 header length | header JSON | binary sections (offsets in the header)
# Local coordinates: metres, x east, z north, origin at the shore end of Bournemouth Pier.
# Needs: pip install numpy pillow shapely
import json, math, os, sys, zlib, struct
import numpy as np
import shapely, shapely.geometry as sg, shapely.ops as so
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
OUT = os.path.join(HERE, '..', 'source', 'data', 'world.bin')
DEBUG = '--debug' in sys.argv

LAT0, LON0 = 50.71585, -1.87563
KX = 111320 * math.cos(math.radians(LAT0)); KZ = 110574
def to_xz(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KZ)
def tf(g): return shapely.transform(g, lambda c: np.column_stack(to_xz(c[:, 0], c[:, 1])))
def load(n): return json.load(open(os.path.join(RAW, n + '.geojson')))['features']

# ---------------------------------------------------------------- terrain source
DEM = np.load(os.path.join(RAW, 'dem.npy')); DZ, DTX, DTY = map(int, open(os.path.join(RAW, 'dem.txt')).read().split())
def dem(x, z):
    lon = LON0 + x / KX; lat = LAT0 + z / KZ; n = 2 ** DZ
    px = ((lon + 180) / 360 * n - DTX) * 256 - 0.5
    py = ((1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n - DTY) * 256 - 0.5
    i = np.clip(np.floor(py).astype(int), 0, DEM.shape[0] - 2); j = np.clip(np.floor(px).astype(int), 0, DEM.shape[1] - 2)
    fy = np.clip(py - i, 0, 1); fx = np.clip(px - j, 0, 1)
    return (DEM[i, j] * (1 - fx) + DEM[i, j + 1] * fx) * (1 - fy) + (DEM[i + 1, j] * (1 - fx) + DEM[i + 1, j + 1] * fx) * fy

# ---------------------------------------------------------------- land and coastline
gb = [f for f in load('land') if f['properties']['class'] == 'island'][0]
box_ll = sg.box(-1.905, 50.700, -1.815, 50.732)
LAND = tf(sg.shape(gb['geometry']).intersection(box_ll).buffer(0))
if LAND.geom_type == 'MultiPolygon': LAND = max(LAND.geoms, key=lambda g: g.area)
coast_all = LAND.boundary.difference(tf(box_ll).boundary.buffer(1))
COAST = max(coast_all.geoms, key=lambda g: g.length) if hasattr(coast_all, 'geoms') else coast_all
# orient the coastline west to east
if COAST.coords[0][0] > COAST.coords[-1][0]: COAST = sg.LineString(COAST.coords[::-1])
LAND_P = shapely.prepared.prep(LAND) if hasattr(shapely, 'prepared') else None

PIERS = []
for f in load('infra'):
    p = f['properties']
    if p['class'] == 'pier' and f['geometry']['type'] == 'Polygon':
        PIERS.append({'name': (p['names'] or {}).get('primary', ''), 'g': tf(sg.shape(f['geometry']))})
BPIER = [p for p in PIERS if 'Bournemouth' in p['name']][0]['g']; SPIER = [p for p in PIERS if 'Boscombe' in p['name']][0]['g']
def coast_s(x, z): return COAST.project(sg.Point(x, z))
def root(g):  # the landward end of a pier: its point nearest the land polygon interior
    pts = list(g.exterior.coords); return max(pts, key=lambda p: p[1])
S_B, S_S = coast_s(*root(BPIER)), coast_s(*root(SPIER))
print('coast length', round(COAST.length), 'Bournemouth pier at s', round(S_B), 'Boscombe at s', round(S_S), 'walk', round(S_S - S_B))

# ---------------------------------------------------------------- heightfields
def grid(x0, x1, z0, z1, d):
    nx = int(round((x1 - x0) / d)) + 1; nz = int(round((z1 - z0) / d)) + 1
    X, Z = np.meshgrid(x0 + np.arange(nx) * d, z0 + np.arange(nz) * d)
    H = dem(X, Z)
    inside = shapely.contains_xy(LAND, X, Z)
    dist = shapely.distance(COAST, shapely.points(X.ravel(), Z.ravel())).reshape(X.shape)
    # the sea: a synthetic sea bed from the coastline down (the elevation tiles carry no bathymetry here)
    sea = np.where(dist < 50, 0.7 - dist * 0.032, -0.9 - (dist - 50) * 0.012)
    sea = np.maximum(sea, -9)
    H = np.where(inside, np.maximum(H, 0.5 + np.minimum(dist, 3) * 0.05), sea)
    return dict(x0=x0, z0=z0, d=d, nx=nx, nz=nz), H.astype(np.float32), X, Z

GC, HC, XC, ZC = grid(-2200, 4400, -1300, 1500, 8)
GD, HD, XD, ZD = grid(-448, 2744, -324, 660, 3)  # aligned to the coarse grid (multiples of 24 m)
print('grids', GC['nx'], GC['nz'], GD['nx'], GD['nz'])

# ---------------------------------------------------------------- surface map (rasterised)
# 0 town ground, 1 sand, 2 promenade, 3 road, 4 footway, 5 grass, 6 woodland, 7 heath/scrub, 8 bare cliff,
# 9 gardens, 10 steps, 11 golf/lawn, 12 pond
segs = load('segment'); landuse = load('landuse'); landf = load('land'); water = load('water')
near_coast = COAST.buffer(1500)
def geoms(feats, pred):
    for f in feats:
        p = f['properties']
        if pred(p, f['geometry']['type']):
            g = tf(sg.shape(f['geometry']))
            if g.intersects(near_coast): yield p, g
ROADW = {'motorway': 6, 'trunk': 5.5, 'primary': 5, 'secondary': 4.5, 'tertiary': 4, 'residential': 3.5, 'unclassified': 3.5,
         'living_street': 3, 'service': 2.5, 'unknown': 2.5, 'pedestrian': 3, 'footway': 1.1, 'path': 1, 'cycleway': 1.4,
         'steps': 1.1, 'track': 1.5}
PROM_NAMES = ('Undercliff', 'Promenade', 'Pier Approach')
def is_prom(p, g):
    n = (p.get('names') or {}).get('primary') or ''
    return any(k in n for k in PROM_NAMES) or (p['class'] in ('pedestrian', 'service', 'cycleway', 'footway', 'unknown') and g.distance(COAST) < 75)

def raster(G, scale):
    W, Hh = G['nx'] * scale, G['nz'] * scale; d = G['d'] / scale
    im = Image.new('L', (W, Hh), 0); dr = ImageDraw.Draw(im)
    def P(c): return [((x - G['x0']) / d + 0.5 * scale - 0.5 + 0.5, (z - G['z0']) / d + 0.5 * scale - 0.5 + 0.5) for x, z in c]
    def poly(g, v):
        for q in (g.geoms if hasattr(g, 'geoms') else [g]):
            if q.geom_type != 'Polygon' or q.area < 1: continue
            dr.polygon(P(q.exterior.coords), fill=v)
            for r in q.interiors: dr.polygon(P(r.coords), fill=0)
    def line(g, w, v):
        poly(g.buffer(w, cap_style='flat' if False else 'round', quad_segs=2), v)
    LU = {'grass': 5, 'park': 5, 'garden': 9, 'pitch': 11, 'fairway': 11, 'green': 11, 'tee': 11, 'rough': 7, 'golf_course': 5,
          'meadow': 5, 'recreation_ground': 5, 'playground': 5, 'cemetery': 5, 'grave_yard': 5, 'residential': 9, 'allotments': 9,
          'school': 9, 'university': 9, 'religious': 9, 'retail': 0, 'commercial': 0, 'pedestrian': 4, 'bunker': 1}
    for p, g in geoms(landuse, lambda p, t: 'Polygon' in t):
        v = LU.get(p['class'])
        if v is not None: poly(g, v)
    for p, g in geoms(landf, lambda p, t: 'Polygon' in t):
        v = {'wood': 6, 'forest': 6, 'heath': 7, 'scrub': 7, 'shrub': 7, 'bare_rock': 8, 'scree': 8, 'grass': 5, 'beach': 1, 'sand': 1}.get(p['class'])
        if v is not None: poly(g, v)
    for p, g in geoms(landf, lambda p, t: p['class'] == 'cliff'): line(g, 3, 8)
    for p, g in geoms(water, lambda p, t: 'Polygon' in t and p['subtype'] in ('pond',)): poly(g, 12)
    for p, g in geoms(segs, lambda p, t: p['subtype'] == 'road'):
        c = p['class']; w = ROADW.get(c, 2)
        if is_prom(p, g): continue
        line(g, w, 10 if c == 'steps' else 4 if c in ('footway', 'path', 'cycleway', 'pedestrian', 'track') else 3)
    for p, g in geoms(segs, lambda p, t: p['subtype'] == 'road'):
        if is_prom(p, g): line(g, 6.5 if p['class'] in ('pedestrian', 'service', 'unknown') else 2.5, 2)
    # everything seaward of the land is sand / sea bed
    sea = tf(box_ll).difference(LAND)
    poly(sea, 1)
    M = np.asarray(im, dtype=np.uint8).copy()
    # unclassified land by the shore: low ground is beach, slopes along the cliffs are heath and scrub
    X = G['x0'] + (np.arange(W) + 0.5) * d - G['d'] / 2; Z = G['z0'] + (np.arange(Hh) + 0.5) * d - G['d'] / 2
    X, Z = np.meshgrid(X, Z); un = M == 0
    dist = np.full(M.shape, 1e9); dist[un] = shapely.distance(COAST, shapely.points(X[un], Z[un]))
    h = dem(X, Z)
    M[un & (dist < 130) & (h < 3.2)] = 1
    gx, gz = np.gradient(h, d)
    M[(M == 0) & (dist < 260) & (np.hypot(gx, gz) > 0.35)] = 7
    return M

MC = raster(GC, 1); MD = raster(GD, 2)  # coarse 8 m, detail 1.5 m
print('masks', MC.shape, MD.shape)

# ---------------------------------------------------------------- the promenade: centre line and width, every 4 m along the shore
def prom_line():
    out = []; sd = MD; d = GD['d'] / 2
    for s_ in np.arange(1700, 5800, 4.0):
        p = COAST.interpolate(s_); q = COAST.interpolate(s_ + 3); tx, tz = q.x - p.x, q.y - p.y; l = math.hypot(tx, tz)
        nx, nz = -tz / l, tx / l
        if not shapely.contains_xy(LAND, p.x + nx * 5, p.y + nz * 5): nx, nz = -nx, -nz
        run = []
        for o in np.arange(0, 160, 0.75):
            x, z = p.x + nx * o, p.y + nz * o
            i, j = int((z - GD['z0'] + GD['d'] / 2) / d), int((x - GD['x0'] + GD['d'] / 2) / d)
            if not (0 <= i < sd.shape[0] and 0 <= j < sd.shape[1]): break
            if sd[i, j] == 2: run.append(o)
            elif run and o - run[-1] > 4: break
        if run: out.append([s_, (run[0] + run[-1]) / 2, run[-1] - run[0], nx, nz, p.x, p.y])
    a = np.array(out)
    # smooth the offset and width, drop outliers
    for k in (1, 2):
        v = a[:, k].copy(); a[:, k] = np.convolve(np.pad(v, 3, mode='edge'), np.ones(7) / 7, mode='valid')
    pts = [[round(r[5] + r[3] * r[1], 1), round(r[6] + r[4] * r[1], 1), round(max(r[2], 4), 1)] for r in a]
    return pts
PROM = prom_line()
print('promenade points', len(PROM))

# ---------------------------------------------------------------- buildings and beach huts
DEFH = {'apartments': 12, 'detached': 7.5, 'semidetached_house': 7.5, 'house': 7.5, 'terrace': 8, 'garages': 2.6, 'garage': 2.6,
        'hut': 2.6, 'beach_hut': 2.5, 'hotel': 16, 'church': 13, 'commercial': 10, 'retail': 7, 'office': 12, 'hospital': 12,
        'school': 8, 'university': 12, 'industrial': 8, 'warehouse': 8, 'shed': 2.5, 'kiosk': 3, 'toilets': 3.2}
ROOF = {'flat': 0, 'hipped': 1, 'half_hipped': 1, 'gabled': 2, 'saltbox': 2, 'gambrel': 2, 'round': 3, 'dome': 3, 'pyramidal': 1}
CLS = ['', 'apartments', 'detached', 'semidetached_house', 'house', 'terrace', 'garages', 'garage', 'hut', 'beach_hut', 'hotel',
       'church', 'commercial', 'retail', 'office', 'hospital', 'school', 'university', 'industrial', 'warehouse', 'shed', 'kiosk',
       'toilets', 'outbuilding', 'roof', 'service', 'civic', 'entertainment']
def colour(s):
    if not s or not isinstance(s, str) or not s.startswith('#') or len(s) not in (4, 7): return 0
    s = s[1:]; s = ''.join(c * 2 for c in s) if len(s) == 3 else s
    try: return 0x1000000 | int(s, 16)
    except ValueError: return 0
blds, huts = [], []
coast_buf = COAST.buffer(1200)
for f in load('building'):
    p = f['properties']
    if p.get('is_underground'): continue
    g = tf(sg.shape(f['geometry']))
    for q in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
        if q.area < 4 or not coast_buf.contains(q.centroid): continue
        q = q.simplify(0.25)
        ring = list(q.exterior.coords)[:-1]
        if len(ring) < 3: continue
        if not sg.LinearRing(ring).is_ccw: ring = ring[::-1]
        c = p.get('class') or ''
        h = p.get('height') or ((p.get('num_floors') or 0) * 3.0 + 1.0 if p.get('num_floors') else 0) or DEFH.get(c, 7.0)
        h = max(2.2, min(float(h), 120))
        hut = c == 'beach_hut' or (c in ('hut', 'shed', '') and q.area < 25 and q.distance(COAST) < 160)
        rec = dict(r=ring, h=h, roof=ROOF.get(p.get('roof_shape') or '', 255), c=CLS.index(c) if c in CLS else 0,
                   fc=colour(p.get('facade_color')), rc=colour(p.get('roof_color')), fl=int(p.get('num_floors') or 0))
        (huts if hut else blds).append(rec)
print('buildings', len(blds), 'huts', len(huts))

def pack_rings(recs, q=0.2):
    n = np.array([len(r['r']) for r in recs], np.uint8)
    co = []
    for r in recs:
        px, pz = 0, 0
        for x, z in r['r']:
            ix, iz = int(round(x / q)), int(round(z / q)); co += [ix - px, iz - pz]; px, pz = ix, iz
    co = np.array(co, np.int32)
    assert np.abs(co).max() < 2 ** 31
    return n, co
bn, bco = pack_rings(blds); hn, hco = pack_rings(huts)
assert bn.max() < 256

# ---------------------------------------------------------------- points and lines near the shore
shore = COAST.buffer(450)
def pts(feats, classes, buf=shore):
    out = []
    for f in feats:
        p = f['properties']
        if p['class'] in classes and f['geometry']['type'] == 'Point':
            x, z = to_xz(*f['geometry']['coordinates'][:2])
            if buf.contains(sg.Point(x, z)): out += [round(x, 1), round(z, 1)]
    return out
infra = load('infra')
POINTS = {k: pts(infra, v) for k, v in {'bench': ('bench',), 'bin': ('waste_basket', 'recycling'), 'lamp': ('street_lamp',),
          'info': ('information',), 'water': ('drinking_water',), 'art': ('artwork',), 'view': ('viewpoint',)}.items()}
POINTS['tree'] = pts(landf, ('tree',), COAST.buffer(1200))
for p, g in geoms(landf, lambda p, t: p['class'] == 'tree_row'):
    for s in np.arange(0, g.length, 7): q = g.interpolate(s); POINTS['tree'] += [round(q.x, 1), round(q.y, 1)]
def lines(feats, pred, buf=shore):
    out = []
    for f in feats:
        p = f['properties']
        if f['geometry']['type'] == 'LineString' and pred(p):
            g = tf(sg.shape(f['geometry']))
            if g.intersects(buf): out.append([round(v, 1) for c in g.simplify(0.3).coords for v in c])
    return out
LINES = {k: lines(infra, lambda p, v=v: p['class'] in v) for k, v in {'wall': ('wall', 'retaining_wall'), 'fence': ('fence',),
         'rail': ('handrail',), 'hedge': ('hedge',)}.items()}
LINES['funicular'] = lines(segs, lambda p: p['class'] == 'funicular', COAST.buffer(3000))
LINES['steps'] = lines(segs, lambda p: p['class'] == 'steps')
names = []
for f in segs:
    p = f['properties']; n = (p['names'] or {}).get('primary')
    if n and ('Zig' in n or 'Chine' in n):
        g = tf(sg.shape(f['geometry']))
        if g.distance(COAST) < 300: c = g.interpolate(0.5, normalized=True); names.append([n, round(c.x), round(c.y)])

# ---------------------------------------------------------------- write
def q16(H, s=0.05): return np.clip(np.round(H / s), -32768, 32767).astype(np.int16)
def delta2(a):  # row-wise horizontal deltas: smooth terrain compresses far better
    d = a.astype(np.int32).copy(); d[:, 1:] = a[:, 1:].astype(np.int32) - a[:, :-1].astype(np.int32); return d.astype(np.int16)
secs = []; meta = {}
def add(name, arr):
    b = np.ascontiguousarray(arr).tobytes(); meta[name] = [sum(len(s) for s in secs), len(b), str(arr.dtype)]
    secs.append(b + b'\0' * ((-len(b)) % 4))
add('hc', delta2(q16(HC))); add('hd', delta2(q16(HD))); add('mc', MC); add('md', MD)
add('bn', bn); add('bco', bco); add('hn', hn); add('hco', hco)
add('bh', np.array([round(r['h'] * 10) for r in blds], np.uint16)); add('broof', np.array([r['roof'] for r in blds], np.uint8))
add('bcls', np.array([r['c'] for r in blds], np.uint8)); add('bfl', np.array([min(r['fl'], 255) for r in blds], np.uint8))
add('bfc', np.array([r['fc'] for r in blds], np.uint32)); add('brc', np.array([r['rc'] for r in blds], np.uint32))
add('hh', np.array([round(r['h'] * 10) for r in huts], np.uint16))
header = dict(meta=meta, origin=[LAT0, LON0], gc=GC, gd=GD, hq=0.05, mdscale=2, ringq=0.2,
              coast=[round(v, 1) for c in COAST.simplify(0.5).coords for v in c],
              piers=[dict(name=p['name'], ring=[round(v, 2) for c in p['g'].exterior.coords for v in c]) for p in PIERS],
              sB=round(S_B, 1), sS=round(S_S, 1), prom=[v for p in PROM for v in p], points=POINTS, lines=LINES, names=names, classes=CLS)
hj = json.dumps(header, separators=(',', ':')).encode()
blob = struct.pack('<I', len(hj)) + hj + b'\0' * ((-len(hj)) % 4) + b''.join(secs)
c = zlib.compressobj(9, zlib.DEFLATED, -15, 9); z = c.compress(blob) + c.flush()
os.makedirs(os.path.dirname(OUT), exist_ok=True); open(OUT, 'wb').write(z)
print('world.bin', len(blob) // 1024, 'kB raw ->', len(z) // 1024, 'kB deflated')
for k, (o, l, t) in meta.items(): print(f'  {k:6s} {l // 1024:6d} kB {t}')
print('  header', len(hj) // 1024, 'kB')

if DEBUG:
    pal = np.array([[90, 90, 90], [230, 210, 160], [200, 200, 200], [50, 50, 55], [170, 160, 150], [120, 190, 90], [30, 90, 40],
                    [120, 110, 60], [200, 140, 80], [100, 160, 90], [220, 220, 220], [150, 220, 120], [60, 100, 200]], np.uint8)
    Image.fromarray(pal[MD][::-1]).save(os.path.join(RAW, 'mask_detail.png'))
    shade = np.clip((HD + 2) / 45, 0, 1); Image.fromarray((shade[::-1] * 255).astype(np.uint8)).save(os.path.join(RAW, 'h_detail.png'))
