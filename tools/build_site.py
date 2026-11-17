"""Build a fly-over course (road centreline + carved terrain) for another place from a stitched route and a DEM.

    python3 tools/build_site.py rio
    python3 tools/build_site.py hk
    python3 tools/build_site.py rio --cell 4 --crest        # override a SITES default

Same algorithm and output format as tools/build_track.py (Route 33), but the road comes from data/<route>.json
(tools/stitch_hk_route.py) and heights from a DEM through tools/dem.py (any CRS it knows), not GSI tiles.
Then build roads and buildings for it:  python3 tools/build_roads.py --site rio && python3 tools/build_buildings.py --site rio

Inputs : data/<route>.json, <dem>.npy/.json
Outputs: web/public/track/<site>/course.json, terrain.bin   (view with ?route&site=<site>)

Frame: metres, x east, z south, y elevation. x/z origin is the start line. course.json also carries `origin_lat`,
the latitude the metre scale is taken at, which build_roads/build_buildings use for --site (Japan's comes from route33.json).
"""
import argparse, json, math, os, sys
import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d, map_coordinates
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SITES = {
    "rio": dict(title=["ESTRADA DA GÁVEA", "ROCINHA · RIO DE JANEIRO"], start_name="the crest", route="data/rio_route.json", dem="assets/rio/dem_gavea", crest=True,
                cell=6.0, margin=500.0, dem_smooth=0.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
                forest=dict(count=0, young=0, wideBroadleaf=16000, palms=3500, foliage=dict(hue=0.30, span=0.05)),
                ground=dict(green="#2f5a2a", scrub="#7d8442", rock="#7b6f62", rockFlat=0.82),
                credits=["Terrain: Instituto Pereira Passos, Prefeitura da Cidade do Rio de Janeiro, "
                         "Modelo Digital de Terreno LiDAR 2019 (CC BY 4.0)",
                         "Road: © OpenStreetMap contributors (ODbL)"]),
    "hk": dict(title=["PEAK ROAD", "THE PEAK → STUBBS ROAD · HONG KONG"], start_name="the Peak", route="data/hk_route.json", dem="assets/hk/dem_peak", crest=False,
               forest=dict(count=0, young=0, wideBroadleaf=14000, foliage=dict(hue=0.29, span=0.05)),
               cell=6.0, margin=500.0, dem_smooth=6.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
               ground=dict(green="#2c5428", scrub="#6f7d3e", rock="#8a8173", rockFlat=0.8),
               credits=["Terrain: Civil Engineering and Development Department, HKSAR Government, "
                        "LiDAR 2020 Digital Terrain Model, via CSDI / DATA.GOV.HK",
                        "Road: © OpenStreetMap contributors (ODbL)"]),
}

STEP = 2.0                     # output centreline spacing (m)
XZ_SMOOTH = 4.0                # gaussian sigma (m) on the OSM polyline
ROAD_HALF = 3.5                # same two-lane road as Japan
RUNOFF = 150                   # metres of road kept past the finish line
RAIL_DROP = 1.5
MIN_RAIL_GAP = 30.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site", choices=sorted(SITES))
    ap.add_argument("--route"); ap.add_argument("--dem")
    ap.add_argument("--cell", type=float); ap.add_argument("--margin", type=float)
    ap.add_argument("--dem-smooth", type=float, help="gaussian sigma (m) applied to the DEM; hides LiDAR terraces")
    ap.add_argument("--flat-r", type=float); ap.add_argument("--blend-r", type=float)
    ap.add_argument("--y-smooth", type=float)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--crest", dest="crest", action="store_true", default=None, help="start at the road's highest point")
    g.add_argument("--no-crest", dest="crest", action="store_false")
    a = ap.parse_args()
    cfg = dict(SITES[a.site])
    for k in ("route", "dem", "cell", "margin", "dem_smooth", "flat_r", "blend_r", "y_smooth", "crest"):
        if getattr(a, k) is not None:
            cfg[k] = getattr(a, k)
    out_dir = os.path.join(ROOT, "web", "public", "track", a.site)

    # ---- DEM (optionally smoothed) ----
    d = demlib.load(os.path.join(ROOT, cfg["dem"]))
    filled = d.filled()                                   # sea / gaps take the nearest land height
    if cfg["dem_smooth"] > 0:
        filled = gaussian_filter(filled, cfg["dem_smooth"] / d.step, mode="nearest")
    d = demlib.Dem(filled, d.meta)
    elev = lambda lat, lon: d.elev(lat, lon, mode="nearest")

    # ---- route: lat/lon -> local metres, resample at 1 m, DEM heights ----
    route = json.load(open(os.path.join(ROOT, cfg["route"])))
    la = np.array([p["lat"] for p in route["points"]]); lo = np.array([p["lon"] for p in route["points"]])
    lat0, lon0 = float(la[0]), float(lo[0])
    KX, KZ = 111320 * math.cos(math.radians(lat0)), 110540
    px, pz = (lo - lon0) * KX, -(la - lat0) * KZ
    seg = np.hypot(np.diff(px), np.diff(pz))
    keep = np.r_[True, seg > 1e-6]
    px, pz, la, lo = px[keep], pz[keep], la[keep], lo[keep]
    dist = np.r_[0, np.cumsum(np.hypot(np.diff(px), np.diff(pz)))]
    d1 = np.arange(0, dist[-1], 1.0)
    x, z = np.interp(d1, dist, px), np.interp(d1, dist, pz)
    y = elev(lat0 - z / KZ, lon0 + x / KX)               # on the real road, before the polyline is smoothed
    if np.isnan(y).any():
        sys.exit("route runs off the DEM")
    x, z = gaussian_filter1d(x, XZ_SMOOTH, mode="nearest"), gaussian_filter1d(z, XZ_SMOOTH, mode="nearest")
    y = gaussian_filter1d(y, cfg["y_smooth"], mode="nearest")
    start = int(np.argmax(y)) if cfg["crest"] else 0
    x, y, z = x[start:], y[start:], z[start:]

    dd = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(z)))]
    ds = np.arange(0, dd[-1], STEP)
    x, y, z = np.interp(ds, dd, x), np.interp(ds, dd, y), np.interp(ds, dd, z)
    x0s, z0s = x[0], z[0]
    x, z = x - x0s, z - z0s
    finish = ds[-1] - RUNOFF

    tx, tz = np.gradient(x), np.gradient(z)
    heading = np.unwrap(np.arctan2(tz, tx))
    curv = np.gradient(heading) / STEP
    grade = np.gradient(y) / STEP

    # ---- terrain on a local metre grid ----
    CELL = cfg["cell"]
    gx0, gz0 = x.min() - cfg["margin"], z.min() - cfg["margin"]
    nx = int(math.ceil((x.max() + cfg["margin"] - gx0) / CELL)) + 1
    nz = int(math.ceil((z.max() + cfg["margin"] - gz0) / CELL)) + 1
    GX, GZ = np.meshgrid(gx0 + np.arange(nx) * CELL, gz0 + np.arange(nz) * CELL)

    def ground(lx, lz):
        return elev(lat0 - (lz + z0s) / KZ, lon0 + (lx + x0s) / KX)
    raw = ground(GX, GZ).astype(np.float32)
    outside = ~d.contains(lat0 - (GZ + z0s) / KZ, lon0 + (GX + x0s) / KX)   # edge-extended, not real data
    if outside.any():
        print(f"note: {outside.mean():.1%} of the terrain grid lies outside the DEM (edge height continued)", file=sys.stderr)

    tree = cKDTree(np.c_[x, z])
    dist_r, idx = tree.query(np.c_[GX.ravel(), GZ.ravel()])
    dist_r, idx = dist_r.reshape(GX.shape), idx.reshape(GX.shape)
    road_level = y[idx] - 0.25
    t = np.clip((dist_r - cfg["flat_r"]) / (cfg["blend_r"] - cfg["flat_r"]), 0, 1)
    t = t * t * (3 - 2 * t)
    terrain = (road_level * (1 - t) + raw * t).astype(np.float32)
    # Where two legs of a hairpin run close, a grid triangle can span both and slope up through the lower road.
    # Nodes within a cell and a half of the road edge never sit above any road surface that close to them.
    near = ROAD_HALF + 1.5 * CELL
    for i, js in enumerate(tree.query_ball_point(np.c_[GX.ravel(), GZ.ravel()], near)):
        if js:
            r_, c_ = divmod(i, GX.shape[1])
            lv = y[js]
            lv = lv[lv >= y[idx[r_, c_]] - 1.5]          # only legs at a similar height; a far lower leg is just a valley below
            terrain[r_, c_] = min(terrain[r_, c_], lv.min() - 0.25)

    # ---- guardrails on the valley side ----
    nxr, nzr = -tz / np.hypot(tx, tz), tx / np.hypot(tx, tz)

    def rail_mask(offset):
        m = ground(x + nxr * offset, z + nzr * offset) < y - RAIL_DROP
        k = int(MIN_RAIL_GAP / STEP)
        for val in (True, False):
            i = 0
            while i < len(m):
                j = i
                while j < len(m) and m[j] == m[i]:
                    j += 1
                if m[i] != val and (j - i) < k and i > 0 and j < len(m):
                    m[i:j] = val
                i = j
        return m
    rail_r, rail_l = rail_mask(10.0), rail_mask(-10.0)

    # ---- write ----
    os.makedirs(out_dir, exist_ok=True)
    terrain.tofile(os.path.join(out_dir, "terrain.bin"))
    course = {
        "frame": "metres; x east, z south, y elevation above sea level; x/z origin at start line",
        "origin_lat": lat0,
        "start_latlon": [lat0 - z0s / KZ, lon0 + x0s / KX],
        "step": STEP, "road_half_width": ROAD_HALF,
        "length": round(float(ds[-1]), 1), "finish": round(float(finish), 1),
        "points": [[round(float(p), 2), round(float(q), 2), round(float(r), 2)] for p, q, r in zip(x, y, z)],
        "rail_left": "".join("1" if v else "0" for v in rail_l),
        "rail_right": "".join("1" if v else "0" for v in rail_r),
        "terrain": {"file": "terrain.bin", "dtype": "float32", "nx": nx, "nz": nz,
                    "x0": round(float(gx0), 2), "z0": round(float(gz0), 2), "cell": CELL},
        "credits": cfg["credits"],
    }
    course["title"], course["startName"] = cfg["title"], cfg["start_name"]   # the fly-by's title card and HUD
    if cfg.get("forest"):
        course["forest"] = cfg["forest"]                  # createWorld's tree settings for this place
    if cfg.get("ground"):
        course["ground"] = cfg["ground"]                  # buildTerrain's scrub / rock tints
    json.dump(course, open(os.path.join(out_dir, "course.json"), "w"), separators=(",", ":"))

    hairpins = int(np.sum(np.abs(np.diff(np.sign(curv[np.abs(curv) > 1 / 25])))) / 2)
    print(f"{a.site}: {ds[-1]:.0f} m ({finish:.0f} m to the finish), {len(x)} points, crest start={cfg['crest']}")
    print(f"elevation {y[0]:.0f} m -> {y[int(finish / STEP)]:.0f} m at finish; "
          f"grade max {np.abs(grade).max() * 100:.1f}%, mean {(-grade).mean() * 100:.1f}%")
    print(f"tightest radius {1 / np.abs(curv).max():.1f} m; stretches tighter than 25 m radius: ~{hairpins}")
    print(f"guardrail coverage: left {rail_l.mean() * 100:.0f}%, right {rail_r.mean() * 100:.0f}%")
    print(f"terrain {nx}x{nz} @ {CELL} m = {(nx - 1) * CELL / 1000:.1f} x {(nz - 1) * CELL / 1000:.1f} km, "
          f"{terrain.min():.0f}-{terrain.max():.0f} m, {os.path.getsize(os.path.join(out_dir, 'terrain.bin')) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
