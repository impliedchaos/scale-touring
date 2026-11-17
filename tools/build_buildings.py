"""Ikaho's buildings (and anything else OSM has around the course) as simple low-poly blocks.

    python3 tools/build_buildings.py            # uses data/raw/buildings_osm.json, fetching it once if missing
    python3 tools/build_buildings.py --fetch    # refresh it from Overpass
    python3 tools/build_buildings.py --site rio --flat   # another place (tools/build_site.py); --flat: no hipped roofs

Inputs : data/raw/buildings_osm.json (Overpass: every building way inside the terrain box)
         web/public/track/course.json + terrain.bin (from tools/build_track.py: frame, road, ground heights)
         web/public/track/roads.json, if there (tools/build_roads.py: run it first)
Output : web/public/track/buildings.json
         {credits, floor, buildings: [{p: [x, z, x, z, ...] footprint CCW, b: base y, t: wall top y, f: floors,
                                       w: wall colour, r: roof colour, h: hipped-roof rise (0 = flat)}]}

Heights come from building:levels when OSM has it, otherwise a guess from the kind and footprint size (Ikaho's
hotels are tall, sheds aren't). Our road is a smoothed copy of OSM's, so buildings that end up on it are nudged
off sideways, and ones the road (or another road, from roads.json) runs straight through are dropped. Footprints: © OpenStreetMap contributors (ODbL).
"""
import hashlib, json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# --site <name> works on another place (tools/build_site.py): web/public/track/<name>/ and data/raw/<name>_buildings_osm.json
SITE = sys.argv[sys.argv.index("--site") + 1] if "--site" in sys.argv else None
RAW = os.path.join(ROOT, "data", "raw", (SITE + "_" if SITE else "") + "buildings_osm.json")
TRACK = os.path.join(ROOT, "web", "public", "track", *([SITE] if SITE else []))
UA = {"User-Agent": "ghost-of-mount-akina/0.1 (hobby game project)"}

FLOOR = 3.1             # metres per storey
CLEAR = 6.5             # keep walls this far from the road centreline (3.5 m half-width + a pavement)
DROP_INSIDE = 3.0       # a footprint whose centre is this close to the centreline is on the road: drop it
WALLS = ["#d9d2c3", "#cfc6b4", "#e6e1d6", "#b9ae9a", "#c9b8a0", "#a89f92", "#d8cdb8", "#bfb6a8", "#8e7f6c"]
ROOFS = ["#4a4f57", "#3d434c", "#5a5550", "#6b3a2e", "#3e4a5c", "#55595f"]
# per-place palettes (repeats are weights). Rio: unpainted brick and raw concrete, with painted houses among them.
PALETTES = {"rio": (
    ["#b5573c"] * 4 + ["#a34a33"] * 2 + ["#9b9a94"] * 3 + ["#b4b0a6"] * 2 + ["#e6e1d6"] * 2
    + ["#4f86b8", "#e6c54a", "#6fae6a", "#d98ba0", "#e08a3c", "#5fb0a8", "#c7678a", "#8f6bb0", "#d9d2c3"],
    ["#8c8c88"] * 4 + ["#77777a"] * 2 + ["#b0583a"] * 3 + ["#9a4a30"] + ["#5d6670", "#a7a399"])}
PALETTES["hk"] = (   # Mid-Levels towers: tiled and painted concrete, pale and weathered
    ["#e6e1d6"] * 3 + ["#d4d0c6"] * 3 + ["#c9ced1"] * 2 + ["#b8c4cc"] * 2 + ["#d9c9a8", "#c7b79a", "#9fb2a6", "#e3d0c0", "#a9a39a", "#8d97a0"],
    ["#8c8c88"] * 3 + ["#6e7378"] * 2 + ["#a7a399", "#5d6670"])
PALETTES["amalfi"] = (   # Positano and the villages: painted plaster in sun-bleached pinks, ochres and creams, with a few whites and pale blues
    ["#e8d9bc"] * 3 + ["#e3b98f"] * 3 + ["#d9967a"] * 2 + ["#e9c46a"] * 2 + ["#f0e6d2"] * 3 + ["#d98b8b", "#c97b63", "#a9c4c9", "#efe3b8", "#d6a77a"],
    ["#b5573c"] * 5 + ["#a34a33"] * 3 + ["#c4694a"] * 2 + ["#8c8c88", "#b4b0a6"])
PALETTES["monaco"] = (   # Riviera apartment blocks: cream, ochre and pink render, white towers
    ["#efe6d2"] * 3 + ["#e8d9bc"] * 3 + ["#e3b98f"] * 2 + ["#d9967a"] + ["#f4f1ea"] * 3 + ["#d6c3a0", "#c9ced1", "#e9c46a", "#d98b8b", "#b8c4cc"],
    ["#b5573c"] * 3 + ["#a34a33"] * 2 + ["#8c8c88"] * 3 + ["#b4b0a6"] * 2 + ["#6e7378"])
if SITE in PALETTES: WALLS, ROOFS = PALETTES[SITE]

course = json.load(open(os.path.join(TRACK, "course.json")))
lat0 = course["origin_lat"] if SITE else json.load(open(os.path.join(ROOT, "data", "route33.json")))["origin"][0]
KX, KZ = 111320 * math.cos(math.radians(lat0)), 110540
slat, slon = course["start_latlon"]
T = course["terrain"]
H = np.fromfile(os.path.join(TRACK, T["file"]), np.float32).reshape(T["nz"], T["nx"])


def local(lat, lon): return (lon - slon) * KX, -(lat - slat) * KZ
def latlon(x, z): return slat - z / KZ, slon + x / KX


def fetch():
    x1 = T["x0"] + (T["nx"] - 1) * T["cell"]; z1 = T["z0"] + (T["nz"] - 1) * T["cell"]
    (n, w), (s, e) = latlon(T["x0"], T["z0"]), latlon(x1, z1)
    bbox = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    q = f'[out:json][timeout:90];(way["building"]({bbox});relation["building"]({bbox}););out geom tags;'
    req = urllib.request.Request(os.environ.get("OVERPASS", "https://overpass-api.de/api/interpreter"),
                                 data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(RAW, "wb") as f: f.write(r.read())
    print("fetched", RAW)


def ground(x, z):
    fx = np.clip((np.asarray(x) - T["x0"]) / T["cell"], 0, T["nx"] - 1.001)
    fz = np.clip((np.asarray(z) - T["z0"]) / T["cell"], 0, T["nz"] - 1.001)
    i, j = fx.astype(int), fz.astype(int); u, v = fx - i, fz - j
    return (H[j, i] * (1 - u) + H[j, i + 1] * u) * (1 - v) + (H[j + 1, i] * (1 - u) + H[j + 1, i + 1] * u) * v


def h01(s, salt=""):
    return int(hashlib.md5(f"{s}{salt}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def simplify(pts, tol=0.35):
    """drop duplicate and nearly collinear corners"""
    out = list(pts)
    changed = True
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, b, c = np.array(out[i - 1]), np.array(out[i]), np.array(out[(i + 1) % len(out)])
            ac = c - a; L = np.linalg.norm(ac)
            d = np.linalg.norm(b - a) if L < 1e-6 else abs(ac[0] * (b - a)[1] - ac[1] * (b - a)[0]) / L
            if d < tol:
                out.pop(i); changed = True; break
    return np.array(out)


def area(p): return 0.5 * (np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))


def storeys(tags, a, key):
    for k in ("building:levels",):
        try: return max(1, int(round(float(tags[k]))))
        except (KeyError, ValueError): pass
    if "height" in tags:
        try: return max(1, round(float(tags["height"].split()[0]) / FLOOR))
        except ValueError: pass
    kind = tags.get("building", "yes")
    r = h01(key, "h")
    if kind == "hotel": return 4 + int(r * 4)                     # Ikaho's onsen hotels: 4-7 storeys
    if kind in ("garage", "toilets", "roof", "allotment_house", "shed", "hut"): return 1
    if kind in ("house", "retail", "civic", "public"): return 2
    if a < 45: return 1
    if a < 160: return 1 + (r < 0.75)
    if a < 600: return 2 + (r < 0.4)
    if a < 1500: return 3 + int(r * 2)
    return 4 + int(r * 3)


def hip_rise(p, tags, a):
    """small 4-corner buildings get a hipped tile roof; big ones and modern blocks stay flat"""
    shape = tags.get("roof:shape")
    if "--flat" in sys.argv: return 0.0                        # concrete slab roofs (Rocinha), no tile
    if shape == "flat" or len(p) != 4 or a > 260 or tags.get("building") == "hotel": return 0.0
    if shape is None and tags.get("building") not in ("yes", "house"): return 0.0
    w = min(np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[2] - p[1]))
    return round(float(np.clip(w * 0.32, 0.8, 3.2)), 2)


def main():
    if "--fetch" in sys.argv or not os.path.exists(RAW): fetch()
    elements = json.load(open(RAW))["elements"]
    P = np.array(course["points"])
    road = cKDTree(P[:, [0, 2]])
    step = course["step"]
    fwd = np.gradient(P[:, [0, 2]], axis=0); fwd /= np.linalg.norm(fwd, axis=1, keepdims=True) + 1e-9
    # other roads: a centreline point every 2 m with its half-width and direction
    rpath = os.path.join(TRACK, "roads.json")
    side = json.load(open(rpath))["roads"] if os.path.exists(rpath) else []
    spts = []
    for r in side:
        if r.get("k", 0) >= 2: continue  # footpaths and steps don't push buildings aside (Rocinha's alleys run between them)
        q = np.array(r["p"]).reshape(-1, 3)[:, [0, 2]]
        d = np.gradient(q, axis=0) if len(q) > 1 else np.array([[1.0, 0.0]])
        d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
        spts += [[*q[i], r["w"] / 2, *d[i]] for i in range(len(q))]
    spts = np.array(spts).reshape(-1, 5)
    sroad = cKDTree(spts[:, :2]) if len(spts) else None
    inside = lambda x, z: T["x0"] + 10 < x < T["x0"] + (T["nx"] - 1) * T["cell"] - 10 and \
        T["z0"] + 10 < z < T["z0"] + (T["nz"] - 1) * T["cell"] - 10

    out, dropped, nudged = [], 0, 0
    for el in elements:
        if el["type"] != "way" or len(el.get("geometry", [])) < 4: continue
        tags = el.get("tags", {})
        p = np.array([local(g["lat"], g["lon"]) for g in el["geometry"]])
        if np.allclose(p[0], p[-1]): p = p[:-1]
        p = simplify(p)
        if len(p) < 3: continue
        if area(p) < 0: p = p[::-1]
        a = area(p)
        if a < 8: continue
        c = p.mean(0)
        if not inside(*c): continue
        # off the road: test points every metre round the outline
        for _ in range(3):
            edge = np.vstack([p[i] + (p[(i + 1) % len(p)] - p[i]) * t for i in range(len(p))
                              for t in np.linspace(0, 1, max(2, int(np.linalg.norm(p[(i + 1) % len(p)] - p[i])) + 1))])
            d, k = road.query(edge)
            if d.min() >= CLEAR: break
            j = k[d.argmin()]
            n = np.array([-fwd[j, 1], fwd[j, 0]])            # road normal, pointed at the building's side
            if np.dot(c - P[j, [0, 2]], n) < 0: n = -n
            if road.query(c)[0] < DROP_INSIDE: p = None; break
            off = d.min() if np.dot(edge[d.argmin()] - P[j, [0, 2]], n) > 0 else -d.min()
            p = p + n * (CLEAR - off + 0.05); c = p.mean(0); nudged += 1
        if p is None or road.query(edge)[0].min() < CLEAR - 0.5: dropped += 1; continue
        if sroad is not None:                                    # a side road through the middle of it: step aside
            sd, sk = sroad.query(p.mean(0))
            if sd < spts[sk, 2] + 0.5:
                o, half, dr = spts[sk, :2], spts[sk, 2], spts[sk, 3:]
                n = np.array([-dr[1], dr[0]])
                if np.dot(p.mean(0) - o, n) < 0: n = -n
                p = p + n * (half + 0.5 - (p - o) @ n).max()     # its nearest corner to the road's edge + 0.5 m
                # that can push it at the course (junctions): then slide it up the side road, away from the course
                for _ in range(3):
                    dc, kc = road.query(p)
                    if dc.min() >= CLEAR: break
                    along = dr if np.dot(c - P[kc[dc.argmin()], [0, 2]], dr) > 0 else -dr
                    p = p + along * (CLEAR - dc.min() + 0.05); c = p.mean(0)
                c = p.mean(0); nudged += 1
                if road.query(p)[0].min() < CLEAR - 0.5 or sroad.query(c)[0] < half: dropped += 1; continue

        key = el["id"]
        f = storeys(tags, a, key)
        gy = ground(p[:, 0], p[:, 1]); gc = float(ground(*c))
        base = float(gy.min()) - 0.6
        top = max(float(gy.max()) + 1.0, gc + f * FLOOR)       # on a hillside the uphill wall still gets its storeys
        wall = tags.get("building:colour") or WALLS[int(h01(key, "w") * len(WALLS))]
        roof = tags.get("roof:colour") or ROOFS[int(h01(key, "r") * len(ROOFS))]
        out.append({"id": key, "name": tags.get("name:en") or tags.get("name"), "kind": tags.get("building"),
                    "p": [round(float(v), 1) for v in p.ravel()], "b": round(base, 2), "t": round(top, 2),
                    "f": f, "w": wall, "r": roof, "h": hip_rise(p, tags, a),
                    "s": round(float(road.query(c)[1] * step))})

    doc = {"credits": ["Building footprints: © OpenStreetMap contributors (ODbL)"], "floor": FLOOR,
           "buildings": [{k: v for k, v in b.items() if k not in ("id", "name", "kind") and v is not None} for b in out]}
    json.dump(doc, open(os.path.join(TRACK, "buildings.json"), "w"), separators=(",", ":"))
    named = [b for b in out if b["name"]]
    print(f"{len(out)} buildings ({nudged} nudges off the road, {dropped} dropped), "
          f"{sum(b['h'] > 0 for b in out)} hipped roofs, {len(named)} named; "
          f"{os.path.getsize(os.path.join(TRACK, 'buildings.json')) / 1024:.0f} KB")
    near = [b for b in out if abs(b["s"] - course["finish"]) < 400]
    print(f"{len(near)} within 400 m (along the road) of the finish; tallest: "
          + ", ".join(f"{b['name'] or b['kind']} {b['f']}F" for b in sorted(out, key=lambda b: -b["f"])[:6]))


if __name__ == "__main__":
    main()
