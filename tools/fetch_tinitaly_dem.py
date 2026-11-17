#!/usr/bin/env python3
"""Cut a window of the TINITALY 1.1 10 m DEM (Italy) around a stitched route out of its GeoTIFF tile.

Licence: TINITALY/1.1 is CC BY 4.0 (INGV, Istituto Nazionale di Geofisica e Vulcanologia) per its download page and accompanying notes
         (tinitaly.pi.ingv.it); credit is in CREDITS.md. Citation: Tarquini S., Vinci S., Favalli M., Doumaz F., Fornaciai A., Nannipieri L.
         (2012), Release of a 10-m-resolution DEM for the Italian territory, Computers & Geosciences 38, 168-170, doi:10.1016/j.cageo.2011.04.018.
Source : the 50 x 50 km tiles at https://tinitaly.pi.ingv.it/ (zip of a float32 GeoTIFF, EPSG:32632 for all of Italy, nodata -9999 = the sea).
         Amalfi is tile w45095 (E 950-1000 km, N 4500-4550 km; the page's tile map is ordered west to east). Download and unzip it by hand
         into assets/<site>/ (a one-off 70 MB file; use curl to a .part file and rename, so a failed download isn't mistaken for a tile).

    PYTHONPATH=<dir with tifffile> python3 tools/fetch_tinitaly_dem.py --route data/amalfi_route.json --tif assets/amalfi/dl_w45095/w45095_s10/w45095_s10.tif \\
        --out assets/amalfi/dem_amalfi [--margin 700]

Output : <out>.npy + <out>.json, the format tools/dem.py reads (10 m, rows north to south, nodata = NaN). Local only, nothing to resume.
"""
import argparse, json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True); ap.add_argument("--tif", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--margin", type=float, default=700.0)
    a = ap.parse_args()
    import tifffile
    route = json.load(open(a.route))["points"]
    lat = np.array([p["lat"] for p in route]); lon = np.array([p["lon"] for p in route])
    rx, ry = demlib.utm32n(lon, lat)
    with tifffile.TiffFile(a.tif) as tf:
        page = tf.pages[0]
        g = page.tags["GeoKeyDirectoryTag"].value
        epsg = next(g[i + 3] for i in range(4, len(g), 4) if g[i] == 3072)
        if epsg != 32632: sys.exit(f"expected EPSG:32632, got {epsg}")
        E0, N0 = page.tags["ModelTiepointTag"].value[3:5]; S = page.tags["ModelPixelScaleTag"].value[0]
        c0 = int((rx.min() - a.margin - E0) // S); c1 = int(math.ceil((rx.max() + a.margin - E0) / S))
        r0 = int((N0 - ry.max() - a.margin) // S); r1 = int(math.ceil((N0 - ry.min() + a.margin) / S))
        if c0 < 0 or r0 < 0 or c1 > page.imagewidth or r1 > page.imagelength:
            sys.exit(f"the route plus margin leaves this tile (cols {c0}-{c1}, rows {r0}-{r1} of {page.imagewidth} x {page.imagelength}): use a different or a second tile")
        grid = page.asarray()[r0:r1, c0:c1].astype(np.float32)
    grid[grid < -9000] = np.nan
    np.save(a.out + ".npy", grid)
    json.dump({"crs": "EPSG:32632", "x0": E0 + (c0 + 0.5) * S, "y0": N0 - (r0 + 0.5) * S, "step": float(S), "nx": grid.shape[1], "ny": grid.shape[0],
               "rows": "north_to_south",
               "bbox_lonlat": [round(float(lon.min()), 5), round(float(lat.min()), 5), round(float(lon.max()), 5), round(float(lat.max()), 5)],
               "source": "INGV TINITALY/1.1 10 m DEM (Tarquini et al. 2012), CC BY 4.0"}, open(a.out + ".json", "w"), indent=1)
    print(f"wrote {a.out}.npy: {grid.shape[1]} x {grid.shape[0]}, {np.isfinite(grid).mean() * 100:.0f}% land, {np.nanmin(grid):.1f} to {np.nanmax(grid):.1f} m")


if __name__ == "__main__":
    main()
