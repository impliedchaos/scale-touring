"""Ikaho's buildings (and anything else OSM has around the course) as simple low-poly blocks.

    python3 tools/build_buildings.py            # uses data/raw/buildings_osm.json, fetching it once if missing
    python3 tools/build_buildings.py --fetch    # refresh it from Overpass
    python3 tools/build_buildings.py --site rio --flat   # another place (tools/build_site.py); --flat: no hipped roofs

Inputs : data/raw/buildings_osm.json (Overpass: every building way inside the terrain box)
         web/public/track/harasu/course.json + terrain.bin (from tools/build_track.py: frame, road, ground heights)
         web/public/track/harasu/roads.json, if there (tools/build_roads.py: run it first)
Output : web/public/track/harasu/buildings.json
         {credits, floor, buildings: [{p: [x, z, x, z, ...] footprint CCW, b: base y, t: wall top y, f: floors,
                                       w: wall colour, r: roof colour, h: roof rise (0 = flat), and optionally
                                       k: roof kind (0 flat, 1 hipped, 2 gabled, 3 flat with a parapet; absent = hipped if h > 0),
                                       q: the roof's rectangle, 4 corners with the first edge the long one (for p that isn't one),
                                       u: wall colour above sp metres (two-tone), v: 1 = beam ends (vigas) along the roofline}],
          style: {windows, eave, parapet, lines}}   (per place: STYLES below)

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
TRACK = os.path.join(ROOT, "web", "public", "track", SITE or "harasu")  # no --site = Route 33 / Mt. Haruna, which lives in track/harasu/
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
PALETTES["ah"] = (   # alpine resort: whitewashed and cream render, weathered larch timber, a few warm ochres
    ["#efe9dc"] * 4 + ["#e3d8c2"] * 3 + ["#8a6a4a"] * 3 + ["#6f5238"] * 2 + ["#a5815a"] * 2 + ["#d6c3a0", "#c9bfae", "#b8a68a", "#d9b98f"],
    ["#5d5f63"] * 4 + ["#6e7378"] * 3 + ["#4a3b30"] * 3 + ["#7a5a42"] * 2 + ["#8c8c88", "#a7a399"])
if SITE in PALETTES: WALLS, ROOFS = PALETTES[SITE]

# Per-place building character beyond colour (roof shapes, wall materials, windows, overhead lines). A place without an entry
# keeps the plain look above: hipped roofs on small four-corner buildings, flat on the rest.
#   roof     "jp" gabled and hipped tile roofs, flat parapeted blocks · "chalet" steep gables, timber over a stone base ·
#            "pueblo" flat parapets with beam ends, a few low metal gables
#   windows  texture variant in buildings.js · eave: roof overhang (m) · parapet: height (m) · lines: overhead cables (utilities.js)
STYLES = {
    "jp": dict(roof="jp", windows="bands", eave=0.75, parapet=0.35, lines="jp"),
    "ah": dict(roof="chalet", windows="shutters", eave=1.1),
    "abq": dict(roof="pueblo", windows="deep", eave=0.45, parapet=0.5),
    "rio": dict(lines="rio"),
}
STYLES["nagasaki"] = STYLES["jp"]
STYLE = STYLES.get(SITE or "jp", {})
if STYLE.get("roof") == "jp":    # kawara tile in blue-greys, the odd tin roof; white and cream plaster, dark timber, grey concrete
    WALLS = ["#e8e4da"] * 3 + ["#d9d4c6"] * 3 + ["#cfc8b8"] * 2 + ["#b9b6ae"] * 2 + ["#a9a79f"] + ["#c5ccd0"] * 2 + ["#6b5a48", "#8a7a66", "#d8cdb8"]
    ROOFS = ["#3a4350"] * 4 + ["#444c58"] * 3 + ["#2f353f"] * 2 + ["#5a626e"] + ["#8a3a30", "#2f5f55", "#4a5f7a", "#6b4a3a"]
elif STYLE.get("roof") == "chalet":
    LOWER = ["#e9e4d8"] * 3 + ["#d8d2c2"] * 2 + ["#b9b2a2"] * 2 + ["#9c9486"]      # whitewash and stone below
    UPPER = ["#8a6a4a"] * 3 + ["#6f5238"] * 2 + ["#a5815a"] * 2 + ["#7a5a3e"]      # larch timber above
elif STYLE.get("roof") == "pueblo":     # adobe and stucco; the roofs are the odd corrugated-metal ones
    WALLS = ["#c9a77c"] * 3 + ["#b98f64"] * 2 + ["#d4b78f"] * 3 + ["#a9835a"] + ["#c2a27d"] * 2 + ["#e0c9a3"]
    ROOFS = ["#5e7f5c"] * 2 + ["#8a3f2f"] * 2 + ["#6b645c"] + ["#7d6f5e"]

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


def obb(p):
    """the footprint's smallest enclosing rectangle: (corners A, B, C, D CCW with A-B the long side, how much of it the footprint fills)"""
    from scipy.spatial import ConvexHull
    h = p[ConvexHull(p).vertices]
    best = None
    for i in range(len(h)):
        e = h[(i + 1) % len(h)] - h[i]; L = np.linalg.norm(e)
        if L < 1e-6: continue
        u = e / L; w = np.array([-u[1], u[0]])
        a, b = h @ u, h @ w
        sz = (a.max() - a.min()) * (b.max() - b.min())
        if best is None or sz < best[0]: best = (sz, u, w, a.min(), a.max(), b.min(), b.max())
    sz, u, w, a0, a1, b0, b1 = best
    if (a1 - a0) < (b1 - b0): u, w, a0, a1, b0, b1 = w, -u, b0, b1, -a1, -a0   # long side first, still CCW
    c = [u * a0 + w * b0, u * a1 + w * b0, u * a1 + w * b1, u * a0 + w * b1]
    return c, min(1.0, abs(area(p)) / max(sz, 1e-6))


def style_roof(p, tags, a, key, f):
    """(kind, rise, rectangle or None) under this place's STYLE; None = the plain legacy roof"""
    roof = STYLE.get("roof")
    if not roof: return None
    kind, shape = tags.get("building", "yes"), tags.get("roof:shape")
    q, fill = obb(p)
    L, W = np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[3] - q[0])
    boxy = fill >= 0.72 and W >= 3.0
    qq = [round(float(v), 1) for c in q for v in c]
    r = h01(key, "k")
    if roof == "jp":
        block = a > 400 or f >= 4 or kind in ("apartments", "commercial", "industrial", "hotel", "retail", "school", "office", "hospital", "public")
        if shape == "flat" or block or not boxy: return (3 if block or shape == "flat" else 0), 0.0, None
        rise = float(np.clip(W / 2 * (0.4 if a > 24 else 0.3), 0.7, 3.2))
        return (2 if r < 0.68 else 1), round(rise, 2), qq
    if roof == "chalet":
        if shape == "flat" or not boxy or kind in ("service", "construction", "garage"): return 0, 0.0, None
        pitch = 0.78 if a < 400 else 0.45                      # tall gables on the chalets, a gentler pitch on the big resort blocks
        return 2, round(float(np.clip(W / 2 * pitch, 1.1, 4.8)), 2), qq
    if roof == "pueblo":
        if a > 25 and boxy and r < 0.3 and shape != "flat": return 2, round(float(np.clip(W / 2 * 0.22, 0.5, 1.6)), 2), qq
        return 3, 0.0, None
    return None


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
        rec = {"id": key, "name": tags.get("name:en") or tags.get("name"), "kind": tags.get("building"),
               "p": [round(float(v), 1) for v in p.ravel()], "b": round(base, 2), "t": round(top, 2),
               "f": f, "w": wall, "r": roof, "h": hip_rise(p, tags, a),
               "s": round(float(road.query(c)[1] * step))}
        sr = style_roof(p, tags, a, key, f)
        if sr:
            rec["k"], rec["h"] = sr[0], sr[1]
            if sr[2]: rec["q"] = sr[2]
        if STYLE.get("roof") == "chalet" and "building:colour" not in tags and h01(key, "tt") < 0.75:
            rec["w"] = LOWER[int(h01(key, "lo") * len(LOWER))]; rec["u"] = UPPER[int(h01(key, "up") * len(UPPER))]
            rec["sp"] = FLOOR if f >= 2 else 0.75            # the stone storey, or a low plinth under a single storey of timber
        if STYLE.get("roof") == "pueblo" and rec.get("k") == 3 and a > 40 and h01(key, "vg") < 0.6: rec["v"] = 1
        out.append(rec)

    doc = {"credits": ["Building footprints: © OpenStreetMap contributors (ODbL)"], "floor": FLOOR,
           "buildings": [{k: v for k, v in b.items() if k not in ("id", "name", "kind") and v is not None} for b in out]}
    st = {k: v for k, v in STYLE.items() if k != "roof"}
    if st: doc["style"] = st
    json.dump(doc, open(os.path.join(TRACK, "buildings.json"), "w"), separators=(",", ":"))
    named = [b for b in out if b["name"]]
    print(f"{len(out)} buildings ({nudged} nudges off the road, {dropped} dropped), "
          f"{sum(b['h'] > 0 for b in out)} pitched roofs, {len(named)} named; "
          f"{os.path.getsize(os.path.join(TRACK, 'buildings.json')) / 1024:.0f} KB")
    near = [b for b in out if abs(b["s"] - course["finish"]) < 400]
    print(f"{len(near)} within 400 m (along the road) of the finish; tallest: "
          + ", ".join(f"{b['name'] or b['kind']} {b['f']}F" for b in sorted(out, key=lambda b: -b["f"])[:6]))


if __name__ == "__main__":
    main()
