#!/usr/bin/env python3
"""Fetch Hong Kong's 0.5 m LiDAR bare-earth terrain (CEDD 2020 survey) and mosaic it to a grid.

Source: Civil Engineering and Development Department (CEDD), HKSAR Government, "LiDAR Data" via the
CSDI portal / DATA.GOV.HK (free for commercial and non-commercial use with attribution:
https://data.gov.hk/en/terms-and-conditions). Credit goes in CREDITS.md.

Tiles are 750 x 600 m GeoTIFFs (float32, 0.5 m, HK1980 Grid EPSG:2326, nodata -9999) in zips of ~6 MB.
The tile index is a public Esri FeatureServer.

Resumable by design: every zip is downloaded to <cache>/<name>.part and renamed only when complete, so a
crash or Ctrl-C costs at most the tile in flight; a rerun skips tiles already cached. The mosaic is rebuilt
from the cache each run (fast, no network).

    python3 tools/fetch_hk_dem.py --bbox 114.135 22.262 114.160 22.285 --step 2 --out assets/hk/dem_peak
    python3 tools/fetch_hk_dem.py --bbox ... --list          # just show tiles and size, download nothing

--bbox is lon/lat (WGS84), used only to pick tiles (the index server reprojects it). The output grid is in
HK1980 Grid metres (north-aligned, rows north to south), --step a multiple of 0.5 (block mean). Nodata is NaN.
"""
import argparse, glob, io, json, os, sys, time, urllib.parse, urllib.request, zipfile
import numpy as np
from PIL import Image

INDEX = ("https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/rest/services/"
         "Digital_Terrain_Model_from_2020_LiDAR_Survey/FeatureServer/0/query")
UA = {"User-Agent": "ghost-of-mount-akina/0.1 (hobby game project)"}
SRC_STEP = 0.5
NODATA = -9999.0


def tiles_for(bbox):
    q = dict(geometry="%f,%f,%f,%f" % tuple(bbox), geometryType="esriGeometryEnvelope", inSR=4326,
             spatialRel="esriSpatialRelIntersects", outFields="TILE_NAME,FILENAME,URL",
             returnGeometry="false", f="json")
    with urllib.request.urlopen(urllib.request.Request(INDEX + "?" + urllib.parse.urlencode(q), headers=UA),
                                timeout=60) as r:
        d = json.load(r)
    if "error" in d:
        raise RuntimeError(d["error"])
    if d.get("exceededTransferLimit"):
        raise RuntimeError("tile index truncated; use a smaller bbox")
    return sorted((f["attributes"] for f in d["features"]), key=lambda a: a["FILENAME"])


def download(url, dest, tries=5):
    """Fetch url to dest atomically. Returns True if downloaded, False if it was already cached."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return False
    part = dest + ".part"
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(part, "wb") as f:
                while chunk := r.read(1 << 16):
                    f.write(chunk)
            zipfile.ZipFile(part).testzip()  # reject truncated downloads
            os.replace(part, dest)
            return True
        except Exception as e:
            print(f"  retry {attempt + 1}/{tries}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"giving up on {url}")


def read_tile(zpath):
    """(array float32 rows north->south with NaN nodata, x0 west edge, y0 north edge) from a tile zip."""
    with zipfile.ZipFile(zpath) as z:
        name = next(n for n in z.namelist() if n.lower().endswith((".tif", ".tiff")))
        im = Image.open(io.BytesIO(z.read(name)))
    scale, tie = im.tag_v2[33550], im.tag_v2[33922]
    if abs(scale[0] - SRC_STEP) > 1e-6 or abs(scale[1] - SRC_STEP) > 1e-6:
        raise RuntimeError(f"{zpath}: unexpected pixel size {scale[:2]}")
    a = np.array(im, np.float32)
    a[a <= NODATA + 1] = np.nan
    return a, tie[3], tie[4]


def mosaic(zips, step):
    k = int(round(step / SRC_STEP))
    if abs(k * SRC_STEP - step) > 1e-6:
        raise SystemExit("--step must be a multiple of 0.5")
    tiles = [read_tile(z) for z in zips]
    x0 = min(t[1] for t in tiles); y1 = max(t[2] for t in tiles)
    x1 = max(t[1] + t[0].shape[1] * SRC_STEP for t in tiles); y0 = min(t[2] - t[0].shape[0] * SRC_STEP for t in tiles)
    nx, ny = int(np.ceil((x1 - x0) / step)), int(np.ceil((y1 - y0) / step))
    full = np.full((ny * k, nx * k), np.nan, np.float32)  # at source resolution, then block-averaged
    for a, tx, ty in tiles:
        c, r = int(round((tx - x0) / SRC_STEP)), int(round((y1 - ty) / SRC_STEP))
        view = full[r:r + a.shape[0], c:c + a.shape[1]]
        np.copyto(view, a, where=np.isfinite(a))
    if k == 1:
        return full, x0, y1
    blocks = full.reshape(ny, k, nx, k)
    with np.errstate(all="ignore"):
        out = np.nanmean(blocks, axis=(1, 3)).astype(np.float32)  # all-NaN blocks stay NaN
    return out, x0, y1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--step", type=float, default=2.0, help="output grid metres, multiple of 0.5")
    ap.add_argument("--out", default="assets/hk/dem")
    ap.add_argument("--cache", default="assets/hk/tiles", help="downloaded zips live here; safe to delete afterwards")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--delay", type=float, default=0.5)
    a = ap.parse_args()

    tiles = tiles_for(a.bbox)
    print(f"{len(tiles)} tiles (~{len(tiles) * 5.7:.0f} MB)", file=sys.stderr)
    if a.list:
        for t in tiles:
            print(t["FILENAME"])
        return
    os.makedirs(a.cache, exist_ok=True)
    for i, t in enumerate(tiles, 1):
        got = download(t["URL"], os.path.join(a.cache, t["FILENAME"]))
        print(f"[{i}/{len(tiles)}] {t['FILENAME']} {'downloaded' if got else 'cached'}", file=sys.stderr, flush=True)
        if got:
            time.sleep(a.delay)

    grid, x0, y1 = mosaic([os.path.join(a.cache, t["FILENAME"]) for t in tiles], a.step)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    np.save(a.out + ".npy", grid)
    json.dump({"crs": "EPSG:2326", "x0": x0, "y0": y1, "step": a.step, "ny": grid.shape[0], "nx": grid.shape[1],
               "rows": "north_to_south", "bbox_lonlat": a.bbox,
               "source": "CEDD, HKSAR Government, LiDAR 2020 DTM (0.5 m), via CSDI / DATA.GOV.HK"},
              open(a.out + ".json", "w"), indent=1)
    ok = np.isfinite(grid)
    print(f"wrote {a.out}.npy {grid.shape[1]}x{grid.shape[0]} @ {a.step} m  valid {ok.mean():.1%}  "
          f"z {np.nanmin(grid):.1f}..{np.nanmax(grid):.1f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
