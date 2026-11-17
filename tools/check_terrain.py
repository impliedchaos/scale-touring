#!/usr/bin/env python3
"""Check that no terrain pokes up through a road: reads web/public/track/<site>/course.json + terrain.bin (no network, no DEM).

For every road point it samples the terrain at 7 offsets across the road's width and reports any run of points where the ground is
more than --tol metres above the road surface (default 0.1), as `from s - to s (worst poke)`. Tunnel spans (`tunnels` in course.json, plus 8 m at each portal) are skipped. Exits 1 if anything pokes, so it can
gate a build. With no site argument it checks every folder under web/public/track/ that has a course.json (Route 33 included).

    python3 -I tools/check_terrain.py [site ...] [--tol 0.1]

The terrain is sampled bilinearly, not along the mesh's triangles, so it's an approximation: a ~0.1 m miss is possible either way.
Fix pokes in tools/build_site.py (the hairpin cap and the bridge `under` cap), not here.
"""
import argparse, json, os, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACK = os.path.join(ROOT, "web", "public", "track")


def check(folder, tol):
    c = json.load(open(os.path.join(folder, "course.json"))); t = c["terrain"]
    H = np.fromfile(os.path.join(folder, t["file"]), np.float32).reshape(t["nz"], t["nx"])
    P = np.array([p[:3] for p in c["points"]]); half = c["road_half_width"]; step = c["step"]
    f = np.gradient(P[:, [0, 2]], axis=0); f /= np.linalg.norm(f, axis=1, keepdims=True) + 1e-9
    r = np.c_[-f[:, 1], f[:, 0]]                                   # across the road

    def ground(x, z):
        u, v = (x - t["x0"]) / t["cell"], (z - t["z0"]) / t["cell"]
        i = np.clip(np.floor(u).astype(int), 0, t["nx"] - 2); j = np.clip(np.floor(v).astype(int), 0, t["nz"] - 2)
        a, b = u - i, v - j
        return H[j, i] * (1 - a) * (1 - b) + H[j, i + 1] * a * (1 - b) + H[j + 1, i] * (1 - a) * b + H[j + 1, i + 1] * a * b

    worst = np.full(len(P), -np.inf)
    for lat in np.linspace(-half, half, 7):
        worst = np.maximum(worst, ground(P[:, 0] + r[:, 0] * lat, P[:, 2] + r[:, 1] * lat) - P[:, 1])
    for a_, b_ in c.get("tunnels", []):                               # inside a tunnel the hill is meant to be above the road
        worst[max(int((a_ - 8) / step), 0):int((b_ + 8) / step) + 1] = -np.inf   # padded 8 m: the portal cutting
    bad = np.flatnonzero(worst > tol)
    runs = np.split(bad, np.flatnonzero(np.diff(bad) > 3) + 1) if len(bad) else []
    return [(q[0] * step, q[-1] * step, float(worst[q].max())) for q in runs], float(worst.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sites", nargs="*"); ap.add_argument("--tol", type=float, default=0.1, help="metres of poke to allow")
    a = ap.parse_args()
    sites = a.sites or sorted(d for d in os.listdir(TRACK) if os.path.exists(os.path.join(TRACK, d, "course.json")))
    folders = {s: os.path.join(TRACK, s) for s in sites}
    if not a.sites and os.path.exists(os.path.join(TRACK, "course.json")):
        folders = {"route33": TRACK, **folders}
    failed = False
    for s, folder in folders.items():
        runs, worst = check(folder, a.tol)
        if runs:
            failed = True
            print(f"{s}: terrain through the road in {len(runs)} place(s) (worst {worst:.2f} m): "
                  + ", ".join(f"s {a_:.0f}-{b_:.0f} m ({w:.1f} m)" for a_, b_, w in runs))
        else:
            print(f"{s}: ok (highest ground above the road surface: {worst:.2f} m)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
