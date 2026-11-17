"""Stitch OSM Route 33 ways into a single polyline and attach GSI DEM elevations.

Inputs : data/raw/route33_osm.json (Overpass output)
Outputs: data/raw/dem/*.png        (cached GSI dem5a/dem10b tiles)
         data/route33.json         (ordered points: lat, lon, x/z metres, elevation)
         data/heightmap.npy + .json (terrain grid around the pass)

Elevation: 国土地理院 (GSI Japan) DEM tiles. Road: © OpenStreetMap contributors (ODbL).
"""
import json, math, os, sys, time, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
DEM = os.path.join(RAW, "dem")
os.makedirs(DEM, exist_ok=True)
UA = {"User-Agent": "ghost-of-mount-akina/0.1 (hobby game project)"}

# ---------- stitch ways ----------
ways = json.load(open(os.path.join(RAW, "route33_osm.json")))["elements"]
segs = [[(round(p["lat"], 7), round(p["lon"], 7)) for p in w["geometry"]] for w in ways]

def key(p): return p
chains = [segs.pop(0)]
while segs:
    c = chains[-1]
    for i, s in enumerate(segs):
        if s[0] == c[-1]: c.extend(s[1:]); break
        if s[-1] == c[0]: chains[-1] = s[:-1] + c; break
        if s[-1] == c[-1]: c.extend(s[::-1][1:]); break
        if s[0] == c[0]: chains[-1] = s[::-1][:-1] + c; break
    else:
        chains.append(segs.pop(0)); continue
    segs.pop(i)
print("chains:", [(len(c), c[0], c[-1]) for c in chains])

# ---------- DEM tiles ----------
def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y

_cache = {}
def tile(z, tx, ty):
    k = (z, tx, ty)
    if k in _cache: return _cache[k]
    arr = None
    for layer in ("dem5a_png", "dem5b_png", "dem_png"):
        zz = z if layer != "dem_png" else z  # dem_png (10m) also served up to z14
        path = os.path.join(DEM, f"{layer}_{z}_{tx}_{ty}.png")
        if not os.path.exists(path):
            url = f"https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{tx}/{ty}.png"
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                    open(path, "wb").write(r.read())
                time.sleep(0.1)
            except Exception:
                continue
        rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.int64)
        v = rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]
        h = np.where(v < 2**23, v * 0.01, (v - 2**24) * 0.01).astype(float)
        h[v == 2**23] = np.nan
        if arr is None: arr = h
        else: arr = np.where(np.isnan(arr), h, arr)
        if not np.isnan(arr).any(): break
    _cache[k] = arr
    return arr

def elev(lat, lon, z=15):
    x, y = tile_xy(lat, lon, z)
    tx, ty = int(x), int(y)
    t = tile(z, tx, ty)
    if t is None: return float("nan")
    px, py = min(int((x - tx) * 256), 255), min(int((y - ty) * 256), 255)
    return float(t[py, px])

# ---------- route output ----------
lat0, lon0 = 36.4766, 138.8800  # local origin near Lake Haruna
def local(lat, lon):
    return ((lon - lon0) * 111320 * math.cos(math.radians(lat0)),
            -(lat - lat0) * 110540)  # x east, z south (three.js style)

out = []
for c in chains:
    pts = []
    for lat, lon in c:
        x, z = local(lat, lon)
        pts.append({"lat": lat, "lon": lon, "x": round(x, 2), "z": round(z, 2), "y": round(elev(lat, lon), 2)})
    out.append(pts)
json.dump({"origin": [lat0, lon0], "chains": out,
           "credits": ["© OpenStreetMap contributors (ODbL)", "出典: 国土地理院 (GSI Japan) DEM"]},
          open(os.path.join(ROOT, "data", "route33.json"), "w"))
for i, c in enumerate(out):
    ys = [p["y"] for p in c]
    L = sum(math.dist((a["x"], a["z"]), (b["x"], b["z"])) for a, b in zip(c, c[1:]))
    print(f"chain {i}: {len(c)} pts, {L/1000:.2f} km, elev {np.nanmin(ys):.0f}-{np.nanmax(ys):.0f} m, ends {c[0]['y']:.0f} -> {c[-1]['y']:.0f}")

# ---------- terrain heightmap (z14 ~ 8m/px at this latitude) ----------
Z = 14
lats = [p["lat"] for c in out for p in c]; lons = [p["lon"] for c in out for p in c]
pad = 0.01
x0, y0 = tile_xy(max(lats) + pad, min(lons) - pad, Z)
x1, y1 = tile_xy(min(lats) - pad, max(lons) + pad, Z)
rows = []
for ty in range(int(y0), int(y1) + 1):
    rows.append(np.hstack([tile(Z, tx, ty) if tile(Z, tx, ty) is not None else np.full((256, 256), np.nan)
                           for tx in range(int(x0), int(x1) + 1)]))
hm = np.vstack(rows).astype(np.float32)
np.save(os.path.join(ROOT, "data", "heightmap.npy"), hm)
json.dump({"zoom": Z, "tile_x0": int(x0), "tile_y0": int(y0), "shape": hm.shape,
           "min": float(np.nanmin(hm)), "max": float(np.nanmax(hm)), "nan": int(np.isnan(hm).sum())},
          open(os.path.join(ROOT, "data", "heightmap.json"), "w"))
print("heightmap", hm.shape, np.nanmin(hm), np.nanmax(hm), "nan:", int(np.isnan(hm).sum()))
