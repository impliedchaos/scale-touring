#!/usr/bin/env python3
"""Fetch the IGN (France) RGE ALTI terrain model around a stitched route and mosaic it into a grid for tools/dem.py.

Licence: RGE ALTI is open data under the Licence Ouverte / Open Licence 2.0 (Etalab), compatible with CC BY: free to reuse with credit
         "IGN, RGE ALTI". The credit is in CREDITS.md.
Source : Geoplateforme WMS-R, https://data.geopf.fr/wms-r/wms, layer ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES (bare-earth terrain, built
         from the 1 m LiDAR HD where it exists), asked for in EPSG:32632 (WGS 84 / UTM 32N, which tools/dem.py already knows) as 32-bit GeoTIFF.
         The service also covers Monaco. Sea and anything outside coverage comes back as -99999 and becomes NaN here.

    python3 -I tools/fetch_ign_dem.py --route data/monaco_route.json --out assets/monaco/dem_monaco [--margin 600] [--res 2]

Needs `tifffile` (pip install --target <dir> tifffile; PYTHONPATH=<dir>; run without -I then).
Resumable: each tile goes to <out folder>/tiles/<name>.tif.part and is renamed when complete, and finished tiles are reused.
Output : <out>.npy + <out>.json (crs EPSG:32632, rows north to south, x0/y0 = centre of the first pixel, nodata = NaN).
"""
import argparse, json, math, os, sys, time, urllib.request
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib

URL = "https://data.geopf.fr/wms-r/wms"
LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES"
UA = {"User-Agent": "touring-hobby-project/0.1"}
TILE = 1024  # pixels per request side


def get(tdir, name, minx, miny, maxx, maxy, w, h):
    import tifffile
    path = os.path.join(tdir, name + ".tif")
    if not os.path.exists(path):
        url = (f"{URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={LAYER}&STYLES=&CRS=EPSG:32632"
               f"&BBOX={minx},{miny},{maxx},{maxy}&WIDTH={w}&HEIGHT={h}&FORMAT=image/geotiff")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                    body = r.read()
                if body[:2] not in (b"II", b"MM"):
                    raise OSError("not a TIFF: " + body[:200].decode("utf-8", "replace"))
                with open(path + ".part", "wb") as f:
                    f.write(body)
                os.replace(path + ".part", path)
                break
            except OSError as e:
                print(f"  {name}: {e}; retrying", file=sys.stderr)
                time.sleep(2 ** attempt)
        else:
            sys.exit(f"gave up on {name}")
    a = tifffile.imread(path).astype(np.float32)
    return np.where(a < -1, np.nan, a)  # -99999 (nodata) and the stray negative values blended in at its edges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--margin", type=float, default=600.0, help="ground metres around the route")
    ap.add_argument("--res", type=float, default=2.0, help="metres per pixel (the source is 1 m)")
    a = ap.parse_args()
    pts = json.load(open(a.route))["points"]
    xy = np.array([demlib.CRS["EPSG:32632"](p["lon"], p["lat"]) for p in pts])
    lat = np.array([p["lat"] for p in pts]); lon = np.array([p["lon"] for p in pts])
    tile_m = TILE * a.res
    minx = math.floor((xy[:, 0].min() - a.margin) / tile_m) * tile_m; maxx = math.ceil((xy[:, 0].max() + a.margin) / tile_m) * tile_m
    miny = math.floor((xy[:, 1].min() - a.margin) / tile_m) * tile_m; maxy = math.ceil((xy[:, 1].max() + a.margin) / tile_m) * tile_m
    nx, ny = int(round((maxx - minx) / a.res)), int(round((maxy - miny) / a.res))
    tdir = os.path.join(os.path.dirname(os.path.abspath(a.out)), "tiles"); os.makedirs(tdir, exist_ok=True)
    grid = np.full((ny, nx), np.nan, np.float32)
    for r in range(ny // TILE):
        for c in range(nx // TILE):
            x0 = minx + c * tile_m; y1 = maxy - r * tile_m
            t = get(tdir, f"rgealti_{int(x0)}_{int(y1)}_{a.res:g}m", x0, y1 - tile_m, x0 + tile_m, y1, TILE, TILE)
            grid[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE] = t
    np.save(a.out + ".npy", grid)
    json.dump({"crs": "EPSG:32632", "x0": minx + a.res / 2, "y0": maxy - a.res / 2, "step": a.res, "nx": nx, "ny": ny, "rows": "north_to_south",
               "bbox_lonlat": [round(float(lon.min()), 5), round(float(lat.min()), 5), round(float(lon.max()), 5), round(float(lat.max()), 5)],
               "source": "IGN RGE ALTI (Licence Ouverte 2.0), 1 m LiDAR terrain model resampled to %g m" % a.res}, open(a.out + ".json", "w"), indent=1)
    print(f"wrote {a.out}.npy: {nx} x {ny}, {np.isfinite(grid).mean() * 100:.0f}% valid, {np.nanmin(grid):.1f} to {np.nanmax(grid):.1f} m")


if __name__ == "__main__":
    main()
