#!/usr/bin/env python3
"""Fetch a corridor of USGS 3DEP 1 m LiDAR terrain around a stitched route, without downloading the whole tiles.

Licence: USGS 3DEP elevation data is in the public domain (USGS data policy); credit is given anyway, see CREDITS.md.
Source : The National Map's 1 m DEM GeoTIFFs on S3 (prd-tnm.s3.amazonaws.com), found through the TNM Access API
         (tnmaccess.nationalmap.gov). They are 10 km tiles of 256 x 256 blocks (LZW + floating-point predictor), and S3 serves
         byte ranges, so only the blocks in the box around the route (its bounding box plus --margin; or within --margin of the line with --corridor) are fetched (~200 KB each), not the 70-370 MB files.

    python3 tools/fetch_3dep_dem.py --route data/bigsur_route.json --out assets/bigsur/dem_bigsur [--margin 600] [--step 2] [--corridor]
    python3 tools/fetch_3dep_dem.py --route data/abq_route.json --out assets/abq/dem_abq --epsg 26913 --opr --project NM_North_Central_FEMA

`--opr` reads the project's Original Product Resolution tiles (1.5 km, 512 px blocks) instead of the 10 km "1 meter" product, which some
projects (the FEMA 2016 one over the Sandias) don't publish for their whole area. `--project` picks the project by name: the default, the
newest, can be a neighbouring county's that only clips a corner of the route.

Needs `tifffile` and `imagecodecs` (the usual project Python has neither on its -I path: run it as
`PYTHONPATH=<dir with imagecodecs> python3 tools/fetch_3dep_dem.py ...`, from outside the repo's data folders).
Output : <out>.npy + <out>.json, the format tools/dem.py reads: float32 at --step metres (1 m source, block-averaged), rows
         north to south, grid CRS read from the tiles (--epsg: 26910 = NAD83 / UTM 10N, the default, or 26913 = UTM 13N; both are in dem.py). Nodata (the sea,
         outside the corridor) is NaN. The output goes in assets/ (an input, not committed).
Resumable: progress (sums, counts, finished blocks) is saved to <out>.part.npz / .part.json every 60 blocks and kept until
         the final files are written, so rerunning the same command carries on.
"""
import argparse, json, math, os, re, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib

API = "https://tnmaccess.nationalmap.gov/api/v1/products"
DATASET = "Digital Elevation Model (DEM) 1 meter"
OPR_DATASET = "Original Product Resolution (OPR) Digital Elevation Model (DEM)"
UA = {"User-Agent": "touring/0.1 (hobby project)"}
CHECKPOINT = 60
# OPR tiles are in NAD83(2011) UTM (6339..6348); the same projection as the NAD83 UTM zone dem.py knows, to a few cm
EPSG_ALIAS = {6342: 26913}


class RangeFile:
    """Just enough of a binary file for tifffile, reading byte ranges over HTTP (one connection per read, so thread-safe)."""
    def __init__(self, url):
        self.url, self.pos = url, 0
        self.size = int(urllib.request.urlopen(urllib.request.Request(url, headers=UA, method="HEAD"), timeout=60).headers["Content-Length"])
    closed = False
    def seek(self, o, w=0): self.pos = o if w == 0 else self.pos + o if w == 1 else self.size + o; return self.pos
    def tell(self): return self.pos
    def seekable(self): return True
    def close(self): pass
    def read(self, n=-1):
        n = self.size - self.pos if n < 0 else min(n, self.size - self.pos)
        if n <= 0: return b""
        d = get_range(self.url, self.pos, n); self.pos += len(d); return d
    def readinto(self, b): d = self.read(len(b)); b[:len(d)] = d; return len(d)


def get_range(url, off, n, tries=5):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={off}-{off + n - 1}"})
            return urllib.request.urlopen(req, timeout=90).read()
        except Exception as e:
            if k == tries - 1: raise
            print(f"  retry {k + 1} ({e})", file=sys.stderr)


def find_tiles(bbox, dataset=DATASET, project=None):
    q = urllib.parse.urlencode({"datasets": dataset, "bbox": ",".join(f"{v:.5f}" for v in bbox), "max": 500})
    items = json.load(urllib.request.urlopen(urllib.request.Request(f"{API}?{q}", headers=UA), timeout=90))["items"]
    proj = {}
    for it in items:
        m = re.search(r"/Projects/([^/]+)/", it["downloadURL"])
        proj.setdefault(m.group(1) if m else "?", []).append(it)
    if project:
        match = [k for k in proj if project in k]
        if len(match) != 1: sys.exit(f"--project {project!r} matches {match or 'nothing'}; projects here: {', '.join(proj)}")
        return match[0], proj[match[0]]
    best = max(proj, key=lambda k: max(i["publicationDate"] for i in proj[k]))  # the most recently published project
    if len(proj) > 1:
        print(f"note: {len(proj)} LiDAR projects cover this area ({', '.join(proj)}); using {best}. Pass --project to choose, "
              f"as the newest can be a neighbouring county's that only clips the corner.", file=sys.stderr)
    return best, proj[best]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--margin", type=float, default=700.0, help="metres around the route to fetch")
    ap.add_argument("--corridor", action="store_true", help="only fetch blocks within --margin of the road, not the whole box around it "
                    "(cells outside it come out as nodata, which a site with a sea turns into water; use only if the box is mostly sea)")
    ap.add_argument("--epsg", type=int, default=26910, help="the tiles' grid CRS, a NAD83 UTM zone dem.py knows: 26910 (zone 10N, California) or 26913 (zone 13N, New Mexico)")
    ap.add_argument("--project", help="LiDAR project to use (a substring of its name); default: the most recently published one covering the route")
    ap.add_argument("--opr", action="store_true", help="read the Original Product Resolution DEM tiles (about 1.5 km, 1 m) instead of the 10 km '1 meter' product, "
                    "for areas where a project is published only as OPR (Sandia Crest is)")
    ap.add_argument("--step", type=int, default=2, help="output spacing in metres (whole number; the source is 1 m)")
    a = ap.parse_args()
    S = a.step

    route = json.load(open(a.route))["points"]
    lat = np.array([p["lat"] for p in route]); lon = np.array([p["lon"] for p in route])
    rx, ry = demlib.CRS[f"EPSG:{a.epsg}"](lon, lat)
    # densify the route so "distance to the road" is distance to the line, not to a node
    seg = np.hypot(np.diff(rx), np.diff(ry))
    dx, dy = [], []
    for i in range(len(seg)):
        k = max(1, int(seg[i] // 20))
        dx += list(rx[i] + (rx[i + 1] - rx[i]) * np.arange(k) / k); dy += list(ry[i] + (ry[i + 1] - ry[i]) * np.arange(k) / k)
    from scipy.spatial import cKDTree
    tree = cKDTree(np.c_[dx + [rx[-1]], dy + [ry[-1]]])

    # output grid: step-aligned, covers the route's box plus the margin; cell (r, c) spans E in [Eo + c*S, Eo + (c+1)*S], N in [No - (r+1)*S, No - r*S]
    Eo = S * math.floor((rx.min() - a.margin) / S); No = S * math.ceil((ry.max() + a.margin) / S)
    nx = int((S * math.ceil((rx.max() + a.margin) / S) - Eo) // S); ny = int((No - S * math.floor((ry.min() - a.margin) / S)) // S)
    print(f"grid {nx} x {ny} cells of {S} m ({nx * S / 1000:.1f} x {ny * S / 1000:.1f} km)", file=sys.stderr)

    pad = 0.03
    project, tiles = find_tiles((lon.min() - pad, lat.min() - pad, lon.max() + pad, lat.max() + pad), OPR_DATASET if a.opr else DATASET, a.project)
    print(f"{len(tiles)} tiles from {project}", file=sys.stderr)

    part_npz, part_json = a.out + ".part.npz", a.out + ".part.json"
    ident = {"route": os.path.basename(a.route), "margin": a.margin, "step": S, "corridor": a.corridor, "project": project, "grid": [Eo, No, nx, ny]}
    total, count, done = np.zeros((ny, nx), np.float32), np.zeros((ny, nx), np.float32), set()
    if os.path.exists(part_json) and os.path.exists(part_npz):
        j = json.load(open(part_json))
        if j["ident"] == ident:
            z = np.load(part_npz); total, count, done = z["total"], z["count"], {tuple(d) for d in j["done"]}
            print(f"resuming: {len(done)} blocks already done", file=sys.stderr)

    def save():
        np.savez(part_npz + ".tmp.npz", total=total, count=count); os.replace(part_npz + ".tmp.npz", part_npz)
        json.dump({"ident": ident, "done": sorted(done)}, open(part_json + ".tmp", "w")); os.replace(part_json + ".tmp", part_json)

    import tifffile
    crs = None
    for tile in tiles:
        url = tile["downloadURL"]
        rf = RangeFile(url)
        with tifffile.TiffFile(rf) as tf:
            page = tf.pages[0]
            tp, scale = page.tags["ModelPixelScaleTag"].value, page.tags["ModelTiepointTag"].value
            geokeys = page.tags["GeoKeyDirectoryTag"].value
            epsg = next(geokeys[i + 3] for i in range(4, len(geokeys), 4) if geokeys[i] == 3072)
            if EPSG_ALIAS.get(epsg, epsg) != a.epsg or abs(tp[0] - 1) > 1e-6 or abs(tp[1] - 1) > 1e-6:
                sys.exit(f"{url}: expected 1 m pixels in EPSG:{a.epsg}, got EPSG:{epsg} at {tp[:2]} m")
            crs = f"EPSG:{a.epsg}"
            E0, N0 = round(scale[3]), round(scale[4])         # NW corner of the NW pixel (integer metres)
            W, H = page.imagewidth, page.imagelength
            if not page.is_tiled: sys.exit(f"{url}: not an internally tiled GeoTIFF, so it can't be read block by block")
            BW, BH = page.tilewidth, page.tilelength
            per = -(-W // BW)
            offsets, counts = page.dataoffsets, page.databytecounts
            want = []
            for br in range(-(-H // BH)):
                for bc in range(per):
                    cx, cy = E0 + bc * BW + BW / 2, N0 - br * BH - BH / 2
                    near = (tree.query([cx, cy])[0] <= a.margin + max(BW, BH) * 0.71 if a.corridor
                            else Eo - BW <= cx <= Eo + nx * S + BW and No - ny * S - BH <= cy <= No + BH)
                    if near and (url, br, bc) not in done:
                        want.append((br, bc))
            print(f"{os.path.basename(url)}: {len(want)} blocks to fetch", file=sys.stderr)
            if not want: continue

            def work(b):
                br, bc = b; i = br * per + bc
                return b, page.decode(get_range(url, offsets[i], counts[i]), i)[0]
            with ThreadPoolExecutor(8) as ex:
                for n, (b, segarr) in enumerate(ex.map(work, want), 1):
                    br, bc = b
                    v = np.squeeze(segarr)[:min(BH, H - br * BH), :min(BW, W - bc * BW)].astype(np.float32)
                    rr, cc = np.mgrid[0:v.shape[0], 0:v.shape[1]]
                    top = N0 - (br * BH + rr)                   # top edge of each pixel (N)
                    left = E0 + bc * BW + cc                    # left edge of each pixel (E)
                    cell_r, cell_c = (No - top) // S, (left - Eo) // S
                    ok = np.isfinite(v) & (v > -1000) & (cell_r >= 0) & (cell_r < ny) & (cell_c >= 0) & (cell_c < nx)
                    flat = (cell_r * nx + cell_c)[ok]
                    total += np.bincount(flat, weights=v[ok], minlength=ny * nx).reshape(ny, nx).astype(np.float32)
                    count += np.bincount(flat, minlength=ny * nx).reshape(ny, nx).astype(np.float32)
                    done.add((url, br, bc))
                    if n % CHECKPOINT == 0:
                        save(); print(f"  {n}/{len(want)}", file=sys.stderr)
            save()

    grid = np.where(count > 0, total / np.maximum(count, 1), np.nan).astype(np.float32)
    np.save(a.out + ".npy", grid)
    json.dump({"crs": crs, "x0": Eo + S / 2, "y0": No - S / 2, "step": float(S), "nx": nx, "ny": ny, "rows": "north_to_south",
               "bbox_lonlat": [round(float(lon.min()), 5), round(float(lat.min()), 5), round(float(lon.max()), 5), round(float(lat.max()), 5)],
               "source": f"U.S. Geological Survey, 3D Elevation Program (3DEP) 1 m DEM, {project} (public domain)"},
              open(a.out + ".json", "w"), indent=1)
    for p in (part_npz, part_json):
        if os.path.exists(p): os.remove(p)
    valid = np.isfinite(grid)
    print(f"wrote {a.out}.npy: {nx} x {ny}, {valid.mean() * 100:.0f}% of cells have data, {np.nanmin(grid):.1f} to {np.nanmax(grid):.1f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
