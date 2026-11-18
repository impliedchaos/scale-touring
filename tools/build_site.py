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
from scipy.ndimage import binary_dilation, binary_erosion, gaussian_filter, gaussian_filter1d, map_coordinates
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SITES = {
    "rio": dict(title=["ESTRADA DA GÁVEA", "ROCINHA → AV. PREF. MENDES DE MORAIS · RIO DE JANEIRO"], start_name="the crest", route="data/rio_route.json", dem="assets/rio/dem_gavea", crest=True, crest_extra=520,  # past the crest: through the left-hand hairpin, ending on the short straight after it
                cell=6.0, margin=500.0, dem_smooth=0.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
                forest=dict(count=0, young=0, wideBroadleaf=16000, palms=3500, foliage=dict(hue=0.30, span=0.05),
                            sparse=dict(below=12, palmRoad=15)),  # São Conrado coastal plain (ground under 12 m): no trees, only a line of palms by the road
                sea=0.4,                                    # sea level in metres: the bay is a flat 0.1 m in the DEM
                ground=dict(green="#2f5a2a", scrub="#7d8442", rock="#7b6f62", rockFlat=0.82, sand="#d2c08f", sandBelow=2.5),
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
    "bigsur": dict(title=["PACIFIC COAST HIGHWAY", "BIG SUR · BIXBY CREEK BRIDGE · CALIFORNIA"], start_name="the north end", route="data/bigsur_route.json",
                   dem="assets/bigsur/dem_bigsur", crest=False,   # stored north to south: the default (uphill) drive heads north with the sea on the left
                   cell=6.0, margin=500.0, dem_smooth=0.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
                   forest=dict(count=120, young=0, roadsideBroadleaf=60, wideBroadleaf=900, wideBias=1.0, foliage=dict(hue=0.24, span=0.05), sparse=dict(below=2.0, palmRoad=0)),
                   sea=1.3,
                   ground=dict(green="#5c6a35", scrub="#7a6f3c", rock="#8a7c66", rockFlat=0.78, sand="#d8c8a0", sandBelow=2.0),
                   credits=["Terrain: U.S. Geological Survey, 3D Elevation Program (3DEP) 1 m DEM, CA_AZ_FEMA_R9_Lidar_2017_D18 (public domain)",
                            "Road: © OpenStreetMap contributors (ODbL)"]),
    "amalfi": dict(title=["COSTIERA AMALFITANA", "STRADA STATALE 163 · POSITANO → FURORE · ITALY"], start_name="Positano", route="data/amalfi_route.json",
                   dem="assets/amalfi/dem_amalfi", crest=False,   # stored west to east: the default (uphill) drive heads west with the sea on the left, into Positano
                   cell=6.0, margin=500.0, dem_smooth=2.0, flat_r=8.0, blend_r=28.0, y_smooth=50.0,
                   forest=dict(count=300, young=0, roadsideBroadleaf=250, wideBroadleaf=2500, wideBias=1.0, foliage=dict(hue=0.25, span=0.05), sparse=dict(below=3.0, palmRoad=0)),
                   sea=0.3,
                   ground=dict(green="#586a3a", scrub="#76733f", rock="#a39884", rockFlat=0.75, sand="#d8c8a0", sandBelow=2.0),
                   credits=["Terrain: INGV TINITALY/1.1 10 m DEM (Tarquini et al., 2012), CC BY 4.0",
                            "Road: © OpenStreetMap contributors (ODbL)"]),
    "monaco": dict(title=["MONACO", "MOYENNE CORNICHE → PORT HERCULE · MONACO"], start_name="Èze", route="data/monaco_route.json",
                   dem="assets/monaco/dem_monaco", crest=False,
                   cell=6.0, margin=500.0, dem_smooth=2.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
                   sea=0.3,
                   forest=dict(sparse=dict(below=3.0, palmRoad=0)),
                   ground=dict(green="#586a3a", scrub="#76733f", rock="#a39884", rockFlat=0.75, sand="#d8c8a0", sandBelow=2.0),
                   credits=["Terrain: IGN RGE ALTI (Licence Ouverte 2.0), 1 m LiDAR terrain model",
                            "Road: © OpenStreetMap contributors (ODbL)"]),
    "ah": dict(title=["L'ALPE D'HUEZ", "D 211 · BOURG-D'OISANS → L'ALPE D'HUEZ · 21 HAIRPINS · FRANCE"], start_name="L'Alpe d'Huez", route="data/ah_route.json",
               dem="assets/ah/dem_ah", crest=False,   # stored resort to valley, like the others: the default (uphill) drive climbs the hairpins
               cell=6.0, margin=500.0, dem_smooth=2.0, flat_r=8.0, blend_r=28.0, y_smooth=60.0,
               forest=dict(count=24000, young=4000, roadsideBroadleaf=600, wideBroadleaf=0),
               ground=dict(green="#4a5d3a", scrub="#7a6f55", rock="#8a857c", rockFlat=0.7,
                           snow=dict(above=1000, band=240, flat=0.5, color="#eef2f7")),   # a winter scene: snow from 1,000 m, the valley floor stays bare
               credits=["Terrain: IGN RGE ALTI® digital terrain model, derived from LiDAR HD (Licence Ouverte 2.0)",
                        "Road: © OpenStreetMap contributors (ODbL)"]),
    "abq": dict(title=["SANDIA CREST SCENIC BYWAY", "NM 536 · SANDIA PARK → SANDIA CREST · NEW MEXICO"], start_name="Sandia Crest", route="data/abq_route.json",
                dem="assets/abq/dem_abq", crest=False,   # stored crest to NM 14: the default (uphill) drive climbs to the crest
                cell=8.0, margin=500.0, dem_smooth=0.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,   # 8 m cells: the 22 km road's box is 10 x 7 km
                forest=dict(count=30000, young=4000, roadsideBroadleaf=300, wideBroadleaf=0),
                ground=dict(green="#8f7d5c", scrub="#6f6249", rock="#9d9087", rockFlat=0.78,
                            bush="#b89a6c", tuft="#b5a265", brush=0.25),   # dry high-desert scrub, pink-grey Sandia granite
                credits=["Terrain: U.S. Geological Survey, 3D Elevation Program (3DEP) 1 m DEM, NM_North_Central_FEMA_R6_Lidar_2016_D17 (public domain)",
                         "Road: © OpenStreetMap contributors (ODbL)"]),
    "nagasaki": dict(title=["INASAYAMA", "MT. INASA ROADS · NAGASAKI · JAPAN"], start_name="the summit", route="data/nagasaki_route.json",
                     dem="assets/nagasaki/dem_inasa", crest=False,   # stored summit to harbour: the default (uphill) drive climbs to the summit
                     cell=6.0, margin=500.0, dem_smooth=1.0, flat_r=8.0, blend_r=28.0, y_smooth=15.0,
                     credits=["Terrain: 出典：国土地理院 (GSI Japan) DEM5A airborne LiDAR, 5 m",
                              "Road: © OpenStreetMap contributors (ODbL)"]),
}

STEP = 2.0                     # output centreline spacing (m)
XZ_SMOOTH = 4.0                # gaussian sigma (m) on the OSM polyline
ROAD_HALF = 3.5                # same two-lane road as Japan
RUNOFF = 150                   # metres of road kept past the finish line
RAIL_DROP = 1.5
MIN_RAIL_GAP = 30.0


def push_under_road(terrain, x, y, z, tx, tz, gx0, gz0, cell, keep, skip, clear=0.15, rounds=30):
    """Lower terrain nodes until no point across the road's width has ground within `clear` m of the road surface; returns how far
    each node went down. The hairpin cap leaves the upper leg of a stacked hairpin (one passing over 6 m above another, a cell or
    so away: a retaining wall) alone, and the triangle from its nodes down to the lower leg's can still slope through the lower road.
    Checked on the mesh's own triangles (buildTerrain's alternating diagonal) and bilinearly (tools/check_terrain.py), and only the
    nodes standing above the road are lowered, in proportion to their weight. `keep`: nodes never lowered (a tunnel's roof);
    `skip`: road points not checked (tunnels and their portals)."""
    nz, nx = terrain.shape
    before = terrain.copy()
    n = np.hypot(tx, tz)
    rx, rz = -tz / n, tx / n
    lats = np.linspace(-ROAD_HALF, ROAD_HALF, 7)
    sx = (x[:, None] + rx[:, None] * lats).ravel()
    sz = (z[:, None] + rz[:, None] * lats).ravel()
    sy = np.repeat(y, len(lats))
    ok = ~np.repeat(skip, len(lats))
    u, v = (sx - gx0) / cell, (sz - gz0) / cell
    i = np.clip(np.floor(u).astype(int), 0, nx - 2); j = np.clip(np.floor(v).astype(int), 0, nz - 2)
    fu, fv = u - i, v - j
    # weights of the cell's corners (i, j), (i+1, j), (i, j+1), (i+1, j+1), as rendered and as checked
    odd = ((i + j) & 1) == 1
    up = fu >= fv
    lo = fu + fv <= 1
    tri = np.stack([
        np.where(odd, np.where(lo, 1 - fu - fv, 0), np.where(up, 1 - fu, 1 - fv)),
        np.where(odd, np.where(lo, fu, 1 - fv), np.where(up, fu - fv, 0)),
        np.where(odd, np.where(lo, fv, 1 - fu), np.where(up, 0, fv - fu)),
        np.where(odd, np.where(lo, 0, fu + fv - 1), np.where(up, fv, fu)),
    ], 1)
    bil = np.stack([(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv], 1)
    ci = np.stack([i, i + 1, i, i + 1], 1); cj = np.stack([j, j, j + 1, j + 1], 1)
    target = sy - clear
    for _ in range(rounds):
        h = terrain[cj, ci]
        moved = False
        for w in (tri, bil):
            excess = (h * w).sum(1) - target
            for k in np.flatnonzero(ok & (excess > 1e-4)):
                high = (h[k] > target[k]) & ~keep[cj[k], ci[k]] & (w[k] > 0)
                if not high.any():
                    continue
                drop = np.minimum(excess[k] / w[k][high].sum(), h[k][high] - target[k])
                terrain[cj[k][high], ci[k][high]] -= drop.astype(terrain.dtype)
                h = terrain[cj, ci]
                moved = True
        if not moved:
            break
    return before - terrain


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
    if cfg.get("sea") is not None:
        filled[~np.isfinite(d.grid)] = 0.0                # ...except where the site has a sea: no data there is open water, not land
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
    # Bridges (route["bridges"], from tools/stitch_hk_route.py): the DEM under a deck is the valley floor, so the deck runs level
    # between its two ends instead, and the terrain below it is left uncarved (below)
    deck = np.zeros(len(d1), bool)
    for br in route.get("bridges", []):
        ends = [int(np.argmin(np.hypot(x - (br[k][1] - lon0) * KX, z + (br[k][0] - lat0) * KZ))) for k in ("a", "b")]
        ia, ib = sorted(ends)
        if ib - ia < 3: continue   # a culvert-sized span: no deck to draw (a zero-length span breaks buildBridges)
        y[ia:ib + 1] = np.linspace(y[ia], y[ib], ib - ia + 1)
        deck[ia:ib + 1] = True
    # Tunnels (route["tunnels"]): the DEM over a tunnel is the hill, so the road runs level between the portals, inside it, and the
    # terrain above is kept (raised to a roof if the hill is thin); the car disappears into the hill and comes out the other side
    tun = np.zeros(len(d1), bool)
    for tn in route.get("tunnels", []):
        ends = [int(np.argmin(np.hypot(x - (tn[k][1] - lon0) * KX, z + (tn[k][0] - lat0) * KZ))) for k in ("a", "b")]
        ia, ib = sorted(ends)
        y[ia:ib + 1] = np.linspace(y[ia], y[ib], ib - ia + 1)
        tun[ia:ib + 1] = True
    x, z = gaussian_filter1d(x, XZ_SMOOTH, mode="nearest"), gaussian_filter1d(z, XZ_SMOOTH, mode="nearest")
    y = gaussian_filter1d(y, cfg["y_smooth"], mode="nearest")
    start = max(int(np.argmax(y)) - int(cfg.get("crest_extra", 0)), 0) if cfg["crest"] else 0   # `crest_extra`: metres of road kept past the crest
    x, y, z, deck, tun = x[start:], y[start:], z[start:], deck[start:], tun[start:]

    dd = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(z)))]
    ds = np.arange(0, dd[-1], STEP)
    x, y, z = np.interp(ds, dd, x), np.interp(ds, dd, y), np.interp(ds, dd, z)
    deck = np.interp(ds, dd, deck.astype(float)) > 0.5
    tun = np.interp(ds, dd, tun.astype(float)) > 0.5
    tun_in = binary_erosion(tun, iterations=3)            # inside the hill; the last 6 m at each end is the portal cutting
    deck_in = binary_erosion(deck, iterations=3)          # the deck proper: the last 6 m at each end are the abutment, on an embankment
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
    under = deck_in[idx]                                  # nodes nearest to a bridge deck: the valley stays as it is
    terrain[under] = np.minimum(raw[under], y[idx][under] - 0.4)   # ...but never above the deck (the bridge slab, 1.3 m thick, hides this)
    roof = tun_in[idx] & (dist_r < cfg["blend_r"])
    terrain[roof] = np.maximum(raw[roof], y[idx][roof] + 6.0)   # the hill over a tunnel stays (and is at least a 6 m roof)
    # Where two legs of a hairpin run close, a grid triangle can span both and slope up through the lower road.
    # Nodes within a cell and a half of the road edge never sit above any road surface that close to them.
    near = ROAD_HALF + 1.5 * CELL
    for i, js in enumerate(tree.query_ball_point(np.c_[GX.ravel(), GZ.ravel()], near)):
        r_, c_ = divmod(i, GX.shape[1])
        if js and not under[r_, c_] and not roof[r_, c_]:
            lv = y[js]
            lv = lv[lv >= y[idx[r_, c_]] - 6.0]          # only legs within 6 m in height (hairpin legs); a far lower road is just a valley below
            terrain[r_, c_] = min(terrain[r_, c_], lv.min() - 0.25)
    pushed = push_under_road(terrain, x, y, z, tx, tz, gx0, gz0, CELL, keep=roof, skip=binary_dilation(tun_in, iterations=4))
    if pushed.any():
        print(f"stacked hairpins: lowered {np.count_nonzero(pushed)} terrain nodes by up to {pushed.max():.2f} m")

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
    rail_r, rail_l = rail_mask(10.0) & ~tun_in, rail_mask(-10.0) & ~tun_in   # no guardrail inside a tunnel

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
    runs = np.flatnonzero(np.diff(np.r_[0, deck_in.astype(int), 0]))
    if len(runs):
        course["bridges"] = [[round(float(ds[a_]), 1), round(float(ds[b_ - 1]), 1)] for a_, b_ in zip(runs[::2], runs[1::2]) if b_ - a_ > 2]   # deck spans, in s (a zero-length span breaks buildBridges)
        if not course["bridges"]: del course["bridges"]
    truns = np.flatnonzero(np.diff(np.r_[0, tun_in.astype(int), 0]))
    if len(truns):
        course["tunnels"] = [[round(float(ds[a_]), 1), round(float(ds[b_ - 1]), 1)] for a_, b_ in zip(truns[::2], truns[1::2])]   # tunnel spans, in s
    if cfg.get("forest"):
        course["forest"] = cfg["forest"]                  # createWorld's tree settings for this place
    if cfg.get("sea") is not None:
        course["sea"] = cfg["sea"]                        # world.js lays a sheet of water at this height
    if cfg.get("ground"):
        course["ground"] = cfg["ground"]                  # buildTerrain's scrub / rock tints
    json.dump(course, open(os.path.join(out_dir, "course.json"), "w"), separators=(",", ":"))

    hairpins = int(np.sum(np.abs(np.diff(np.sign(curv[np.abs(curv) > 1 / 25])))) / 2)
    print(f"{a.site}: {ds[-1]:.0f} m ({finish:.0f} m to the finish), {len(x)} points, crest start={cfg['crest']}")
    print(f"elevation {y[0]:.0f} m -> {y[int(finish / STEP)]:.0f} m at finish; "
          f"grade max {np.abs(grade).max() * 100:.1f}%, mean {(-grade).mean() * 100:.1f}%")
    print(f"tightest radius {1 / np.abs(curv).max():.1f} m; stretches tighter than 25 m radius: ~{hairpins}")
    if "tunnels" in course:
        print(f"tunnels (s, m): {course['tunnels']}")
    if "bridges" in course:
        print(f"bridges (s, m): {course['bridges']}")
    print(f"guardrail coverage: left {rail_l.mean() * 100:.0f}%, right {rail_r.mean() * 100:.0f}%")
    print(f"terrain {nx}x{nz} @ {CELL} m = {(nx - 1) * CELL / 1000:.1f} x {(nz - 1) * CELL / 1000:.1f} km, "
          f"{terrain.min():.0f}-{terrain.max():.0f} m, {os.path.getsize(os.path.join(out_dir, 'terrain.bin')) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
