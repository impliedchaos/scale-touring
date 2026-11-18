#!/usr/bin/env python3
"""Export a site's terrain (and road ribbon) as a Wavefront OBJ that Blender imports directly.

    python3 -I tools/export_blender.py harasu            # -> data/blender/harasu.obj
    python3 -I tools/export_blender.py rio --out /some/where.obj --no-road

Reads web/public/track/<site>/course.json + terrain.bin (no network, no DEM). Metres, 1 unit = 1 m.
Axes: the file is written in the game's frame (x east, y up, z south). Blender's OBJ importer defaults
(Forward -Z, Up Y) turn that into Z-up with +Y = north, so east stays east. Origin is the start line.
Two objects: "terrain" (one quad grid, `cell` m spacing) and "road" (a ribbon road_half_width either side,
lifted 2 cm so it doesn't z-fight). Terrain heights already include the carved road bed.
"""
import argparse, json, os
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--out"); ap.add_argument("--no-road", action="store_true")
    a = ap.parse_args()
    folder = os.path.join(ROOT, "web", "public", "track", a.site)
    c = json.load(open(os.path.join(folder, "course.json")))
    t = c["terrain"]; nx, nz = t["nx"], t["nz"]
    h = np.fromfile(os.path.join(folder, t["file"]), dtype="<f4").reshape(nz, nx)
    out = a.out or os.path.join(ROOT, "data", "blender", f"{a.site}.obj")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    xs = t["x0"] + np.arange(nx) * t["cell"]; zs = t["z0"] + np.arange(nz) * t["cell"]
    gx, gz = np.meshgrid(xs, zs)
    v = np.stack([gx, h, gz], -1).reshape(-1, 3)
    i = (np.arange(nz - 1)[:, None] * nx + np.arange(nx - 1)[None, :]).ravel() + 1   # OBJ is 1-based
    # winding so the normals point up (+y) in the game frame
    quads = np.stack([i, i + nx, i + nx + 1, i + 1], -1)

    tmp = out + ".part"
    with open(tmp, "w") as f:
        f.write(f"# {a.site}: terrain {nx}x{nz} @ {t['cell']} m, from tools/export_blender.py\n# Credits: {'; '.join(c.get('credits', []))}\no terrain\n")
        np.savetxt(f, v, fmt="v %.3f %.3f %.3f")
        np.savetxt(f, quads, fmt="f %d %d %d %d")
        if not a.no_road:
            p = np.array(c["points"], dtype=float)                       # [x, y, z] per step
            d = np.gradient(p[:, [0, 2]], axis=0); d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
            right = np.stack([-d[:, 1], d[:, 0]], -1)                    # perpendicular in the x/z plane
            w = c["road_half_width"]
            L = p.copy(); R = p.copy()
            L[:, [0, 2]] -= right * w; R[:, [0, 2]] += right * w
            L[:, 1] += 0.02; R[:, 1] += 0.02
            base = len(v); n = len(p)
            f.write("o road\n")
            np.savetxt(f, np.concatenate([L, R]), fmt="v %.3f %.3f %.3f")
            k = np.arange(n - 1) + base + 1
            np.savetxt(f, np.stack([k, k + 1, k + 1 + n, k + n], -1), fmt="f %d %d %d %d")
    os.replace(tmp, out)
    print(f"{out}: {len(v)} terrain verts, {len(quads)} quads" + ("" if a.no_road else f", road {len(c['points'])} points")
          + f", {os.path.getsize(out)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
