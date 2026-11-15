# Downloads the Overture Maps features (OpenStreetMap-derived, ODbL) around the seafront into raw/*.geojson.
# Reads the public GeoParquet files over plain HTTPS range requests and keeps only row groups whose bounding
# boxes overlap the area. Usage: python fetch_overture.py infra land landuse water seg bld land_cover
# Needs: pip install pyarrow shapely requests
import sys, json, time, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
REL='2026-10-21.0'; BB=(-1.905,50.700,-1.815,50.732)
import requests, io, re, os
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'raw'); os.makedirs(OUT, exist_ok=True)
HOST='https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'
S=requests.Session()
def listdir(prefix):
    out=[]; tok=None
    while True:
        p={'list-type':'2','prefix':prefix}
        if tok: p['continuation-token']=tok
        x=S.get(HOST+'/',params=p,timeout=60).text
        out+=[(k,int(z)) for k,z in re.findall(r'<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>',x)]
        m=re.search(r'<NextContinuationToken>([^<]+)<',x)
        if not m: return out
        tok=m.group(1)
class RF(io.RawIOBase):
    def __init__(s,key,size): s.k=key; s.n=size; s.p=0
    def readable(s): return True
    def seekable(s): return True
    def tell(s): return s.p
    def seek(s,o,w=0):
        s.p = o if w==0 else s.p+o if w==1 else s.n+o; return s.p
    def read(s,n=-1):
        if n<0: n=s.n-s.p
        n=min(n,s.n-s.p)
        if n<=0: return b''
        for a in range(5):
            try:
                r=S.get(HOST+'/'+s.k,headers={'Range':f'bytes={s.p}-{s.p+n-1}'},timeout=120); r.raise_for_status(); break
            except Exception as e:
                if a==4: raise
                time.sleep(2)
        s.p+=len(r.content); return r.content
    def readinto(s,b):
        d=s.read(len(b)); b[:len(d)]=d; return len(d)
def run(theme, typ, cols):
    base=f'overturemaps-us-west-2/release/{REL}/theme={theme}/type={typ}/'
    files=[(k,z) for k,z in listdir(base.split('/',1)[1]) if k.endswith('.parquet')]
    print(typ, len(files), 'files', flush=True)
    def scan(kz):
        pf=pq.ParquetFile(io.BufferedReader(RF(*kz), buffer_size=1<<20)); md=pf.metadata; names=[md.schema.column(i).path for i in range(md.num_columns)]
        ix={k:names.index('bbox.'+k) for k in ('xmin','xmax','ymin','ymax')}
        rgs=[]
        for r in range(md.num_row_groups):
            g=md.row_group(r); s={k:g.column(i).statistics for k,i in ix.items()}
            if s['xmin'].min>BB[2] or s['xmax'].max<BB[0] or s['ymin'].min>BB[3] or s['ymax'].max<BB[1]: continue
            rgs.append(r)
        out=[]
        if rgs:
            t=pf.read_row_groups(rgs, columns=cols).to_pylist()
            for row in t:
                b=row['bbox']
                if b['xmin']<=BB[2] and b['xmax']>=BB[0] and b['ymin']<=BB[3] and b['ymax']>=BB[1]: out.append(row)
        return out
    rows=[]
    with ThreadPoolExecutor(16) as ex:
        for r in ex.map(scan, files): rows+=r
    print(typ, len(rows), 'features', flush=True)
    return rows
import shapely.wkb
def dump(theme, typ, cols, name):
    rows=run(theme, typ, cols+['bbox','geometry'])
    feats=[]
    for r in rows:
        g=shapely.wkb.loads(r.pop('geometry')); r.pop('bbox')
        feats.append({'type':'Feature','geometry':g.__geo_interface__,'properties':r})
    json.dump({'type':'FeatureCollection','features':feats}, open(os.path.join(OUT, f'{name}.geojson'),'w'), default=str)
t=time.time()
which=sys.argv[1:]
if 'infra' in which: dump('base','infrastructure',['id','subtype','class','names','height','surface'],'infra')
if 'land' in which: dump('base','land',['id','subtype','class','names','elevation','surface'],'land')
if 'landuse' in which: dump('base','land_use',['id','subtype','class','names','surface'],'landuse')
if 'water' in which: dump('base','water',['id','subtype','class','names','is_salt'],'water')
if 'seg' in which: dump('transportation','segment',['id','subtype','class','names','subclass'],'segment')
if 'bld' in which: dump('buildings','building',['id','subtype','class','names','height','num_floors','roof_shape','roof_height','roof_color','facade_color','facade_material','roof_material','is_underground'],'building')
if 'land_cover' in which: dump('base','land_cover',['id','subtype'],'landcover')
print('done', round(time.time()-t), 's')
