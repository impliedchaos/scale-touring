#!/usr/bin/env python3
"""Stitch Peak Road + Stubbs Road (Hong Kong) from raw OSM ways into one ordered polyline.

Input : data/raw/hk_route_osm.json   (Overpass `out body geom`: tags, way node ids and geometry)
Output: data/hk_route.json           (ordered lat/lon points, metres from the start, plus way ids used and `bridges`, `tunnels`:
                                      the lat/lon ends of each OSM bridge on the route, which build_site.py keeps level and uncarved)

The OSM data is a graph, not a line: paired one-way carriageways, service roads, a viaduct. This builds a
directed graph over OSM node ids, then takes the shortest path from the Peak to the Stubbs Road end.
Two-way roads are traversable both ways; `oneway=yes` ways only in their drawn direction. Viaduct/bridge/
tunnel and service/link edges cost extra so the route sticks to the surface road itself.
Road data: (c) OpenStreetMap contributors (ODbL).

    python3 tools/stitch_hk_route.py [--start LAT LON] [--end LAT LON]
"""
import argparse, heapq, json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVABLE = {"primary", "secondary", "tertiary", "residential", "unclassified", "service",
            "primary_link", "secondary_link", "tertiary_link"}
NAMES = ("Peak Road", "Stubbs Road")
START = (22.2713, 114.1495)  # the Peak (north end of Peak Road)
END = (22.2656, 114.1840)    # Stubbs Road, Happy Valley end, before the flyover tangle


def dist(a, b):
    return math.hypot((b[1] - a[1]) * 102800, (b[0] - a[0]) * 111000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", nargs=2, type=float, default=START)
    ap.add_argument("--end", nargs=2, type=float, default=END)
    ap.add_argument("--names", nargs="+", default=list(NAMES), help="road names to keep (substring of the OSM name)")
    ap.add_argument("--label", help="road name to record in the output instead of --names (for --names \"\", which keeps every way)")
    ap.add_argument("--exclude", nargs="*", default=[], help="drop ways whose name contains any of these")
    ap.add_argument("--raw", default=os.path.join(ROOT, "data", "raw", "hk_route_osm.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "hk_route.json"))
    a = ap.parse_args()

    ways = [w for w in json.load(open(a.raw))["elements"]
            if w["tags"].get("highway") in DRIVABLE | {"trunk", "trunk_link"} and "nodes" in w
            and any(n in w["tags"].get("name", "") for n in a.names)
            and not any(x in w["tags"].get("name", "") for x in a.exclude)]
    pos, adj = {}, {}
    for w in ways:
        t = w["tags"]
        penalty = 1.0
        if t.get("bridge") or t.get("tunnel"):
            penalty *= 3
        if t["highway"] in ("service", "primary_link", "secondary_link", "tertiary_link"):
            penalty *= 2
        oneway = t.get("oneway") in ("yes", "true", "1")
        reverse = t.get("oneway") == "-1"
        nodes, geom = w["nodes"], w["geometry"]
        for n, g in zip(nodes, geom):
            pos[n] = (g["lat"], g["lon"])
        for i in range(len(nodes) - 1):
            u, v = nodes[i], nodes[i + 1]
            if u == v:
                continue
            d = dist(pos[u], pos[v]) * penalty
            if not reverse:
                adj.setdefault(u, []).append((v, d, w["id"]))
            if not oneway:
                adj.setdefault(v, []).append((u, d, w["id"]))
            elif reverse:
                adj.setdefault(v, []).append((u, d, w["id"]))

    def nearest(p):
        return min(adj, key=lambda n: dist(pos[n], p))
    s, e = nearest(a.start), nearest(a.end)
    print(f"start node {s} at {pos[s]}, end node {e} at {pos[e]}", file=sys.stderr)

    best, prev, heap = {s: 0.0}, {}, [(0.0, s)]
    while heap:
        d, u = heapq.heappop(heap)
        if u == e:
            break
        if d > best.get(u, 1e18):
            continue
        for v, c, wid in adj.get(u, ()):
            if d + c < best.get(v, 1e18):
                best[v], prev[v] = d + c, (u, wid)
                heapq.heappush(heap, (d + c, v))
    if e not in prev and s != e:
        sys.exit("no path from start to end; check one-way directions or pick other endpoints")
    path, used, edge_way = [e], [], []
    while path[-1] != s:
        u, wid = prev[path[-1]]
        path.append(u)
        edge_way.append(wid)
        if not used or used[-1] != wid:
            used.append(wid)
    path.reverse(); used.reverse(); edge_way.reverse()    # edge_way[i] is the way from path[i] to path[i + 1]

    def spans(is_span):
        out, i = [], 0
        while i < len(edge_way):
            if edge_way[i] in is_span:
                j = i
                while j < len(edge_way) and edge_way[j] == edge_way[i]:
                    j += 1
                out.append({"way": edge_way[i], "a": list(pos[path[i]]), "b": list(pos[path[j]])})
                i = j
            else:
                i += 1
        return out
    # bridge spans (OSM bridge=*, not "no"): where the road is carried over a gap, the DEM under it is the ground below, not the deck
    bridges = spans({w["id"] for w in ways if w["tags"].get("bridge") not in (None, "no")})
    # tunnel spans (OSM tunnel=*, not "no"): the DEM over one is the hill, so build_site.py runs the road level between the portals, under it
    tunnels = spans({w["id"] for w in ways if w["tags"].get("tunnel") not in (None, "no")})

    pts, run = [], 0.0
    for i, n in enumerate(path):
        if i:
            run += dist(pos[path[i - 1]], pos[n])
        pts.append({"lat": pos[n][0], "lon": pos[n][1], "s": round(run, 2)})
    json.dump({"source": "OpenStreetMap contributors (ODbL)", "roads": [a.label] if a.label else a.names, "length_m": round(run, 1),
               "ways": used, "bridges": bridges, "tunnels": tunnels, "points": pts}, open(a.out, "w"), indent=1)
    print(f"wrote {a.out}: {len(pts)} points, {run:.0f} m, {len(used)} ways", file=sys.stderr)


if __name__ == "__main__":
    main()
