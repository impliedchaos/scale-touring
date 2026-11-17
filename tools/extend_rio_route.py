#!/usr/bin/env python3
"""Extend Rio's route past the foot of Estrada da Gávea, along São Conrado beach, to where Av. Niemeyer becomes Av. Mendes de Morais.

Input : data/rio_route_gavea.json   (the Gávea-only route; copied from data/rio_route.json the first time this runs)
        data/raw/rio_roads_osm.json (Overpass `out geom`; ways looked up by id)
Output: data/rio_route.json

The route (crest to beach): down Estrada da Gávea, then an *imaginary link* (about 30 m, no OSM road) onto the top of
Rua Henrique Midosi, down it, then east along Av. Prefeito Mendes de Morais (the beach front) to the Niemeyer junction.
Driven uphill (the default) that is: from the junction west along the beach, right onto Henrique Midosi, right onto Gávea.
The Mendes de Morais ways are the eastbound carriageway as drawn in OSM, which is the direction this route runs.
Road data: (c) OpenStreetMap contributors (ODbL).

    python3 -I tools/extend_rio_route.py
"""
import json, math, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "rio_route.json")
BASE = os.path.join(ROOT, "data", "rio_route_gavea.json")
RAW = os.path.join(ROOT, "data", "raw", "rio_roads_osm.json")
# Henrique Midosi (top, at Gávea, to bottom), then Mendes de Morais from there east to the Niemeyer junction (all drawn in that direction)
CHAIN = [(360201982, True), (144336677, False), (144336679, False), (164102099, False), (374900693, False), (799526774, False)]  # (way id, reverse?)
KX, KZ = 102800, 111000  # metres per degree here, near enough for 1 m checks and projection


def xy(p): return (p[1] * KX, p[0] * KZ)


def main():
    if not os.path.exists(BASE):
        shutil.copy(OUT, BASE)
    route = json.load(open(BASE))
    ways = {e["id"]: e for e in json.load(open(RAW))["elements"]}
    pts = [(p["lat"], p["lon"]) for p in route["points"]]

    chain = []
    for wid, rev in CHAIN:
        g = [(q["lat"], q["lon"]) for q in ways[wid]["geometry"]]
        chain += g[::-1] if rev else g
    # the top of Midosi is the end of way 360201982 as drawn; drop the duplicate join nodes between ways
    out = []
    for p in chain:
        if not out or math.dist(xy(out[-1]), xy(p)) > 0.5:
            out.append(p)
        elif out and math.dist(xy(out[-1]), xy(p)) > 1e-6:
            sys.exit(f"ways don't join cleanly near {p}")
    chain = out

    # where Gávea passes the top of Midosi: project it onto the route and cut the route there
    top = chain[0]
    tx, ty = xy(top)
    best = (1e9, 0, 0.0)
    for i in range(len(pts) - 1):
        ax, ay = xy(pts[i]); bx, by = xy(pts[i + 1])
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((tx - ax) * dx + (ty - ay) * dy) / (dx * dx + dy * dy)))
        d = math.hypot(ax + t * dx - tx, ay + t * dy - ty)
        if d < best[0]:
            best = (d, i, t)
    d, i, t = best
    cut = (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
    print(f"Midosi's top is {d:.1f} m from Gávea (segment {i} of {len(pts) - 1}); the imaginary link is that long")
    if d > 60:
        sys.exit("that's too far to be the right junction")

    full = pts[:i + 1] + [cut] + chain
    s, points = 0.0, []
    for k, p in enumerate(full):
        if k:
            s += math.dist(xy(full[k - 1]), xy(p))
        points.append({"lat": round(p[0], 7), "lon": round(p[1], 7), "s": round(s, 2)})
    route.update(points=points, length_m=round(s, 1), roads=route["roads"] + ["Rua Henrique Midosi", "Avenida Prefeito Mendes de Morais"],
                 ways=route["ways"] + [w for w, _ in CHAIN],
                 source=str(route.get("source", "")) + "; extended by tools/extend_rio_route.py (imaginary link Gávea to Henrique Midosi)")
    json.dump(route, open(OUT, "w"))
    print(f"{len(points)} points, {s:.0f} m (was {json.load(open(BASE))['length_m']} m); ends at {full[-1]}")


if __name__ == "__main__":
    main()
