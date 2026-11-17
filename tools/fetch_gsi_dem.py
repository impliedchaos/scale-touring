#!/usr/bin/env python3
"""Fetch the GSI (Geospatial Information Authority of Japan) 5 m DEM tiles around a stitched route and mosaic them into a grid for tools/dem.py.

Licence: GSI map and DEM tiles are published under the Government of Japan Standard Terms of Use v2.0 (compatible with CC BY 4.0): free to
         use and adapt with credit. Credit "出典：国土地理院" is in CREDITS.md (the Route 33 entry covers it too).
Source : https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png, zoom 15 (256 px tiles; 4.77 Web Mercator m per pixel, ~4 m of ground at 33 N).
         Height is 0.01 m x (R*65536 + G*256 + B) with 2^23 meaning no data. dem5a is airborne LiDAR bare earth where it exists (404 elsewhere).

    python3 -I tools/fetch_gsi_dem.py --route data/nagasaki_route.json --out assets/nagasaki/dem_inasa [--margin 700]

Resumable: each tile goes to assets/<out folder>/tiles/<name>.png.part and is renamed when complete, and finished tiles are reused.
Output : <out>.npy + <out>.json (crs EPSG:3857, rows north to south, nodata = NaN).
"""
import argparse, io, json, math, os, sys, time, urllib.request
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib

Z = 15
UA = {"User-Agent": "touring-hobby-project/0.1"}
LAYER = "dem5a_png"


def tile_of(lon, lat):
    n = 2 ** Z
    return (int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))


def get(tdir, tx, ty):
    path = os.path.join(tdir, f"{LAYER}_{Z}_{tx}_{ty}.png")
    if not os.path.exists(path):
        url = f"https://cyberjapandata.gsi.go.jp/xyz/{LAYER}/{Z}/{tx}/{ty}.png"
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r, open(path + ".part", "wb") as f:
                    f.write(r.read())
                os.replace(path + ".part", path)
                break
            except urllib.error.HTTPError as e:
                if e.code == 404: return None            # no 5 m LiDAR coverage here
                time.sleep(2 ** attempt)
            except OSError:
                time.sleep(2 ** attempt)
        else:
            sys.exit(f"gave up on {url}")
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int64)
    v = a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]
    return np.where(v < 2 ** 23, v * 0.01, np.where(v == 2 ** 23, np.nan, (v - 2 ** 24) * 0.01)).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--margin", type=float, default=700.0, help="ground metres around the route")
    a = ap.parse_args()
    route = json.load(open(a.route))["points"]
    lat = np.array([p["lat"] for p in route]); lon = np.array([p["lon"] for p in route])
    dlat, dlon = a.margin / 111000, a.margin / (111000 * math.cos(math.radians(lat.mean())))
    tx0, ty1 = tile_of(lon.min() - dlon, lat.min() - dlat); tx1, ty0 = tile_of(lon.max() + dlon, lat.max() + dlat)
    tdir = os.path.join(os.path.dirname(os.path.abspath(a.out)), "tiles"); os.makedirs(tdir, exist_ok=True)
    grid = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, np.float32)
    got = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            t = get(tdir, tx, ty)
            if t is not None:
                grid[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = t; got += 1
    print(f"{got} of {(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles had 5 m data")
    W = 2 * math.pi * 6378137.0; step = W / (256 * 2 ** Z)
    x0 = -W / 2 + (tx0 * 256 + 0.5) * step; y0 = W / 2 - (ty0 * 256 + 0.5) * step
    np.save(a.out + ".npy", grid)
    json.dump({"crs": "EPSG:3857", "x0": x0, "y0": y0, "step": step, "nx": grid.shape[1], "ny": grid.shape[0], "rows": "north_to_south",
               "bbox_lonlat": [round(float(lon.min()), 5), round(float(lat.min()), 5), round(float(lon.max()), 5), round(float(lat.max()), 5)],
               "source": "国土地理院 (GSI Japan) DEM5A airborne LiDAR, 5 m"}, open(a.out + ".json", "w"), indent=1)
    print(f"wrote {a.out}.npy: {grid.shape[1]} x {grid.shape[0]}, {np.isfinite(grid).mean() * 100:.0f}% valid, {np.nanmin(grid):.1f} to {np.nanmax(grid):.1f} m")


if __name__ == "__main__":
    main()
