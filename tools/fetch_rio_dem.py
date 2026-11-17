#!/usr/bin/env python3
"""Fetch Rio de Janeiro's 5 m LiDAR terrain model (IPP / Prefeitura do Rio, 2019, CC BY 4.0).

The city only serves it as an ArcGIS MapServer raster layer (Map + Query, no download, and
exports are colour-banded), but `identify` returns the true float elevation per point. This
samples a regular grid with multipoint identify (2000 points per request) and writes a
float32 .npy plus a small JSON sidecar. The output goes in assets/ (an input, not committed).

    python3 tools/fetch_rio_dem.py                       # default box: Rocinha / Estrada da Gavea
    python3 tools/fetch_rio_dem.py --bbox W S E N --step 5 --out assets/rio/dem_rocinha

--bbox is lon/lat (WGS84). Grid is in EPSG:31983 (SIRGAS 2000 / UTM 23S), rows run north to south.
Nodata is NaN. Credit: Instituto Pereira Passos, Prefeitura da Cidade do Rio de Janeiro (CC BY 4.0).
"""
import argparse, json, math, sys, time, urllib.parse, urllib.request
import numpy as np

URL = ("https://pgeo3.rio.rj.gov.br/arcgis/rest/services/Cartografia/"
       "Modelo_Digital_de_Terreno__Lidar_2019__escala_1_10_000_/MapServer/identify")
BATCH = 2000
DEFAULT_BBOX = (-43.2600, -22.9980, -43.2250, -22.9750)  # W S E N, rough; adjust once the road is chosen


def lonlat_to_utm23s(lon, lat):
    """WGS84 lon/lat -> UTM zone 23S (central meridian -45). SIRGAS 2000 is within ~1 m of WGS84 here."""
    a, f = 6378137.0, 1 / 298.257223563
    k0, lon0 = 0.9996, math.radians(-45)
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    phi, lam = math.radians(lat), math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    T, C, A = math.tan(phi) ** 2, ep2 * math.cos(phi) ** 2, math.cos(phi) * (lam - lon0)
    M = a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * phi)
             + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * phi)
             - (35 * e2**3 / 3072) * math.sin(6 * phi))
    x = k0 * N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120) + 500000
    y = k0 * (M + N * math.tan(phi) * (A**2 / 2 + (5 - T + 9 * C + 4 * C**2) * A**4 / 24
                                       + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720)) + 10000000
    return x, y


def pixel(res):
    """Elevation from one identify result; the service says 'NoData' for some points and omits others."""
    try:
        return float(res["attributes"]["Classify.Pixel Value"])
    except ValueError:
        return float("nan")


def identify(pts):
    g = json.dumps({"points": pts, "spatialReference": {"wkid": 31983}})
    q = dict(geometry=g, geometryType="esriGeometryMultipoint", sr=31983, layers="all", tolerance=0,
             mapExtent="%f,%f,%f,%f" % (pts[0][0] - 500, pts[0][1] - 500, pts[0][0] + 500, pts[0][1] + 500),
             imageDisplay="100,100,96", returnGeometry="false", f="json")
    req = urllib.request.Request(URL, data=urllib.parse.urlencode(q).encode())
    for attempt in range(5):
        try:
            r = json.load(urllib.request.urlopen(req, timeout=120))
            if "error" in r:
                raise RuntimeError(r["error"])
            return [pixel(x) for x in r.get("results", [])]
        except Exception as e:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def sample(pts):
    """Elevations for pts, NaN where nodata. Results carry no geometry and drop nodata points, so a
    short reply is bisected until the dropped points can be told apart."""
    try:
        got = identify(pts)
    except Exception as e:  # the server 500s on some batches; narrow it down, a lone bad point is nodata
        if len(pts) == 1:
            print(f"  point {pts[0]} failed ({e}); NaN", file=sys.stderr)
            return [float("nan")]
        h = len(pts) // 2
        return sample(pts[:h]) + sample(pts[h:])
    if len(got) == len(pts):
        return got
    if len(pts) == 1:
        return got if got else [float("nan")]
    h = len(pts) // 2
    return sample(pts[:h]) + sample(pts[h:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--step", type=float, default=5.0, help="grid spacing in metres (source is 5 m)")
    ap.add_argument("--out", default="assets/rio/dem")
    ap.add_argument("--delay", type=float, default=0.3, help="pause between requests, to be gentle")
    a = ap.parse_args()

    w, s, e, n = a.bbox
    x0, y0 = lonlat_to_utm23s(w, s); x1, y1 = lonlat_to_utm23s(e, n)
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    nx, ny = int((x1 - x0) / a.step) + 1, int((y1 - y0) / a.step) + 1
    print(f"grid {nx} x {ny} = {nx * ny} points, ~{nx * ny // BATCH + 1} requests", file=sys.stderr)

    xs = x0 + np.arange(nx) * a.step
    ys = y1 - np.arange(ny) * a.step  # north to south
    dem = np.full((ny, nx), np.nan, np.float32)
    flat = [(i, j) for i in range(ny) for j in range(nx)]
    for k in range(0, len(flat), BATCH):
        chunk = flat[k:k + BATCH]
        vals = sample([[float(xs[j]), float(ys[i])] for i, j in chunk])
        for (i, j), v in zip(chunk, vals):
            dem[i, j] = v
        if (k // BATCH) % 20 == 0:
            print(f"{min(k + BATCH, len(flat))}/{len(flat)}", file=sys.stderr, flush=True)
        time.sleep(a.delay)
    print(file=sys.stderr)

    import os
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    np.save(a.out + ".npy", dem)
    json.dump({"crs": "EPSG:31983", "x0": float(xs[0]), "y0": float(ys[0]), "step": a.step, "nx": nx, "ny": ny,
               "rows": "north_to_south", "bbox_lonlat": [w, s, e, n],
               "source": "Instituto Pereira Passos, Prefeitura do Rio de Janeiro, MDT LiDAR 2019 (5 m), CC BY 4.0"},
              open(a.out + ".json", "w"), indent=1)
    ok = np.isfinite(dem)
    print(f"wrote {a.out}.npy  valid {ok.mean():.1%}  z {np.nanmin(dem):.1f}..{np.nanmax(dem):.1f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
