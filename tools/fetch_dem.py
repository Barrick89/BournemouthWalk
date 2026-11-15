# Downloads the terrain (Mapzen / AWS "Terrarium" elevation tiles, zoom 15, ~3 m per pixel) around the seafront
# and stores the mosaic as raw/dem.npy plus raw/dem.txt (zoom, first tile x, first tile y).
# Needs: pip install numpy pillow
import math, os, io, urllib.request, numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raw'); os.makedirs(OUT, exist_ok=True)
Z = 15
def tile(lat, lon):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
x0, y0 = tile(50.735, -1.910); x1, y1 = tile(50.697, -1.810)
X = range(int(x0), int(x1) + 1); Y = range(int(y0), int(y1) + 1)
def get(a):
    tx, ty = a
    url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png'
    im = np.asarray(Image.open(io.BytesIO(urllib.request.urlopen(url).read())).convert('RGB')).astype(np.float64)
    return a, im[:, :, 0] * 256 + im[:, :, 1] + im[:, :, 2] / 256 - 32768
M = np.zeros((len(Y) * 256, len(X) * 256))
with ThreadPoolExecutor(8) as ex:
    for (tx, ty), h in ex.map(get, [(a, b) for a in X for b in Y]):
        M[(ty - Y[0]) * 256:(ty - Y[0] + 1) * 256, (tx - X[0]) * 256:(tx - X[0] + 1) * 256] = h
np.save(os.path.join(OUT, 'dem.npy'), M)
open(os.path.join(OUT, 'dem.txt'), 'w').write(f'{Z} {X[0]} {Y[0]}')
print(M.shape, M.min(), M.max())
