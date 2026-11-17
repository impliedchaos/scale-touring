"""Every other road OSM has inside the terrain box, as scenery: side streets of Ikaho, forestry tracks, the rest of
Route 33 beyond our course.

    python3 tools/build_roads.py            # uses data/raw/roads_osm.json, fetching it once if missing
    python3 tools/build_roads.py --fetch    # refresh it from Overpass
    python3 tools/build_roads.py --site rio --paths --fetch   # also footpaths, steps, pedestrian streets and cycleways

Inputs : data/raw/roads_osm.json (Overpass: every drivable highway way inside the terrain box)
         web/public/track/course.json + terrain.bin (from tools/build_track.py: frame, road, ground heights)
Output : web/public/track/roads.json
         {credits, roads: [{w: width m, k: 0 paved / 1 track / 2 footpath / 3 steps, p: [x, y, z, ...] centreline every 2 m}]}
With --paths the narrow ways (k 2 and 3: Rocinha's alleys and stairs) are drawn too; they don't push buildings aside.

Where a road meets our course it's cut a little way inside the course's edge, and its last stretch eases onto the
course's height (our road is a smoothed copy of OSM's and sits on its own cut), so it joins underneath. Everywhere
else it sits on the terrain, never under it. Geometry: © OpenStreetMap contributors (ODbL).
"""
import json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# --site <name> works on another place (tools/build_site.py): web/public/track/<name>/ and data/raw/<name>_roads_osm.json
SITE = sys.argv[sys.argv.index("--site") + 1] if "--site" in sys.argv else None
RAW = os.path.join(ROOT, "data", "raw", (SITE + "_" if SITE else "") + "roads_osm.json")
TRACK = os.path.join(ROOT, "web", "public", "track", *([SITE] if SITE else []))
UA = {"User-Agent": "ghost-of-mount-akina/0.1 (hobby game project)"}

STEP = 2.0
# carriageway width (m) and kind by highway tag; anything else (footways, steps, paths...) isn't drawn
WIDTH = {"motorway": 7.0, "trunk": 7.0, "primary": 7.0, "secondary": 6.5, "tertiary": 6.0, "unclassified": 4.5,
         "residential": 4.5, "living_street": 4.0, "service": 3.5, "track": 3.0}
for k in ("motorway", "trunk", "primary", "secondary", "tertiary"): WIDTH[k + "_link"] = 5.0
# only with --paths: pedestrian ways, thin enough that they sit on the ground like a painted line
PATHS = {"footway": 1.6, "path": 1.3, "pedestrian": 3.0, "cycleway": 2.0, "steps": 1.6, "corridor": 1.6}
WITH_PATHS = "--paths" in sys.argv
if WITH_PATHS: WIDTH.update(PATHS)
INSIDE = 1.0            # cut side roads this far inside the course's edge, so they tuck under it
BLEND = 30.0            # metres over which a side road eases from the course's height onto the ground

course = json.load(open(os.path.join(TRACK, "course.json")))
lat0 = course["origin_lat"] if SITE else json.load(open(os.path.join(ROOT, "data", "route33.json")))["origin"][0]
KX, KZ = 111320 * math.cos(math.radians(lat0)), 110540
slat, slon = course["start_latlon"]
T = course["terrain"]
H = np.fromfile(os.path.join(TRACK, T["file"]), np.float32).reshape(T["nz"], T["nx"])
HALF = course["road_half_width"]


def local(lat, lon): return (lon - slon) * KX, -(lat - slat) * KZ
def latlon(x, z): return slat - z / KZ, slon + x / KX


def fetch():
    x1 = T["x0"] + (T["nx"] - 1) * T["cell"]; z1 = T["z0"] + (T["nz"] - 1) * T["cell"]
    (n, w), (s, e) = latlon(T["x0"], T["z0"]), latlon(x1, z1)
    bbox = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    kinds = "|".join(sorted(WIDTH))
    q = f'[out:json][timeout:90];way["highway"~"^({kinds})$"]({bbox});out geom tags;'
    req = urllib.request.Request(os.environ.get("OVERPASS", "https://overpass-api.de/api/interpreter"),
                                 data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(RAW + ".part", "wb") as f: f.write(r.read())
    os.replace(RAW + ".part", RAW)
    print("fetched", RAW)


def ground(x, z):
    fx = np.clip((np.asarray(x) - T["x0"]) / T["cell"], 0, T["nx"] - 1.001)
    fz = np.clip((np.asarray(z) - T["z0"]) / T["cell"], 0, T["nz"] - 1.001)
    i, j = fx.astype(int), fz.astype(int); u, v = fx - i, fz - j
    return (H[j, i] * (1 - u) + H[j, i + 1] * u) * (1 - v) + (H[j + 1, i] * (1 - u) + H[j + 1, i + 1] * u) * v


def resample(p):
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < STEP: return p
    t = np.linspace(0, s[-1], int(round(s[-1] / STEP)) + 1)
    return np.stack([np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])], 1)


def smooth(y, r):
    if len(y) < 3: return y
    k = np.ones(2 * r + 1)
    pad = np.pad(y, r, mode="edge")
    return np.convolve(pad, k, "valid") / k.sum()


def main():
    if "--fetch" in sys.argv or not os.path.exists(RAW): fetch()
    elements = json.load(open(RAW))["elements"]
    P = np.array(course["points"])
    tree = cKDTree(P[:, [0, 2]])
    m = 3 * T["cell"]
    xa, xb = T["x0"] + m, T["x0"] + (T["nx"] - 1) * T["cell"] - m
    za, zb = T["z0"] + m, T["z0"] + (T["nz"] - 1) * T["cell"] - m

    out, total = [], 0.0
    for el in elements:
        if el["type"] != "way" or len(el.get("geometry", [])) < 2: continue
        hw = el.get("tags", {}).get("highway")
        if hw not in WIDTH: continue
        w = WIDTH[hw]
        p = resample(np.array([local(g["lat"], g["lon"]) for g in el["geometry"]]))
        inbox = (p[:, 0] > xa) & (p[:, 0] < xb) & (p[:, 1] > za) & (p[:, 1] < zb)
        d, k = tree.query(p)
        keep = inbox & (d > HALF - INSIDE)
        # runs of kept points; each run takes one more point at an end that meets the course, so it reaches under it
        i = 0
        while i < len(p):
            if not keep[i]: i += 1; continue
            j = i
            while j < len(p) and keep[j]: j += 1
            a = i - 1 if i > 0 and inbox[i - 1] else i
            b = j if j < len(p) and inbox[j] else j - 1
            q, dq, kq = p[a:b + 1], d[a:b + 1], k[a:b + 1]
            i = j
            if len(q) < 2: continue
            # on the ground (highest point across the width, so the terrain's 8 m cells don't poke through)...
            f = np.gradient(q, axis=0); f /= np.linalg.norm(f, axis=1, keepdims=True) + 1e-9
            n = np.stack([-f[:, 1], f[:, 0]], 1)
            g = np.max([ground(*(q + n * l).T) for l in (-w / 2 - 0.3, 0, w / 2 + 0.3)], axis=0) + 0.15
            y = np.maximum(smooth(g, 5), g)
            # ...except near the course, where it eases onto the course's own height
            blend = np.clip(1 - (dq - HALF) / BLEND, 0, 1) ** 2
            blend[dq > HALF + BLEND] = 0
            y = y * (1 - blend) + P[kq, 1] * blend
            y[dq < HALF] = P[kq[dq < HALF], 1] - 0.05
            out.append({"w": w, "k": 3 if hw == "steps" else 2 if hw in PATHS else int(hw == "track"),
                        "p": [round(float(v), 2) for v in np.stack([q[:, 0], y, q[:, 1]], 1).ravel()]})
            total += STEP * (len(q) - 1)

    doc = {"credits": ["Other roads: © OpenStreetMap contributors (ODbL)"], "roads": out}
    path = os.path.join(TRACK, "roads.json")
    json.dump(doc, open(path, "w"), separators=(",", ":"))
    print(f"{len(out)} road pieces, {total / 1000:.1f} km ({sum(r['k'] == 1 for r in out)} tracks, {sum(r['k'] >= 2 for r in out)} paths); "
          f"{os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
