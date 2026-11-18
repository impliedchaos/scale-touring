"""Build the race course (road centreline + carved low-poly terrain) from the Route 33 data.

    python3 tools/build_track.py

Inputs : data/route33.json, data/heightmap.npy/.json   (from tools/build_route.py)
Outputs: web/public/track/harasu/course.json   centreline, guardrail sides, metadata
         web/public/track/harasu/terrain.bin   Float32 heights, row-major [nz][nx]

Frame: metres, x = east, z = south, y = real elevation above sea level.
       x/z origin is the start line (the summit of the pass).
"""
import json, math, os
import numpy as np
from scipy.ndimage import gaussian_filter1d, map_coordinates
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "track", "harasu")

# --- course choice (distances along chain 0 reversed, i.e. lake -> Shibukawa) ---
SUMMIT_SEARCH = (1500, 2300)   # start line = highest point in this window
COURSE_END = 10100             # hairpins finish around 10 km; flatter road after
RUNOFF = 150                   # metres of road past the finish line
STEP = 2.0                     # output centreline spacing (m)
XZ_SMOOTH = 4.0                # gaussian sigma (m) on the OSM polyline
Y_SMOOTH = 20.0                # gaussian sigma (m) on road elevation
ROAD_HALF = 3.5                # 7 m two-lane mountain road
CELL = 8.0                     # terrain grid spacing (m)
MARGIN = 600.0                 # terrain beyond the course bbox (m)
FLAT_R, BLEND_R = 12.0, 40.0   # terrain carving around the road
RAIL_DROP = 1.5                # guardrail where ground 10 m out is this far below the road
MIN_RAIL_GAP = 30.0            # fill guardrail gaps shorter than this (m)

route = json.load(open(os.path.join(ROOT, "data", "route33.json")))
lat0, lon0 = route["origin"]
KX, KZ = 111320 * math.cos(math.radians(lat0)), 110540

chain = route["chains"][0][::-1]
P = np.array([[p["x"], p["y"], p["z"]] for p in chain], float)
seg = np.linalg.norm(np.diff(P[:, [0, 2]], axis=0), axis=1)
keep = np.r_[True, seg > 1e-6]               # drop duplicate nodes
P = P[keep]
d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P[:, [0, 2]], axis=0), axis=1))]

# --- resample at 1 m, smooth, cut to the course ---
d1 = np.arange(0, d[-1], 1.0)
x, y, z = (np.interp(d1, d, P[:, k]) for k in range(3))
x, z = gaussian_filter1d(x, XZ_SMOOTH, mode="nearest"), gaussian_filter1d(z, XZ_SMOOTH, mode="nearest")
y = gaussian_filter1d(y, Y_SMOOTH, mode="nearest")
w = (d1 >= SUMMIT_SEARCH[0]) & (d1 <= SUMMIT_SEARCH[1])
start = d1[w][np.argmax(y[w])]
end = COURSE_END + RUNOFF
sel = (d1 >= start) & (d1 <= end)
x, y, z = x[sel], y[sel], z[sel]

# re-measure after smoothing and resample at STEP
dd = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(z)))]
ds = np.arange(0, dd[-1], STEP)
x, y, z = np.interp(ds, dd, x), np.interp(ds, dd, y), np.interp(ds, dd, z)
x0s, z0s = x[0], z[0]
x, z = x - x0s, z - z0s
finish = ds[-1] - RUNOFF

# --- geometry stats ---
tx, tz = np.gradient(x), np.gradient(z)
heading = np.unwrap(np.arctan2(tz, tx))
curv = np.gradient(heading) / STEP                 # 1/m, signed
grade = np.gradient(y) / STEP

# --- terrain: resample DEM onto a local metre grid ---
hm = np.load(os.path.join(ROOT, "data", "heightmap.npy"))
meta = json.load(open(os.path.join(ROOT, "data", "heightmap.json")))
n = 2 ** meta["zoom"]
gx0, gz0 = x.min() - MARGIN, z.min() - MARGIN
nx = int(math.ceil((x.max() + MARGIN - gx0) / CELL)) + 1
nz = int(math.ceil((z.max() + MARGIN - gz0) / CELL)) + 1
GX, GZ = np.meshgrid(gx0 + np.arange(nx) * CELL, gz0 + np.arange(nz) * CELL)

def to_pixels(lx, lz):
    """local course coords -> heightmap pixel coords (row, col)"""
    lon = lon0 + (lx + x0s) / KX
    lat = lat0 - (lz + z0s) / KZ
    px = ((lon + 180) / 360 * n - meta["tile_x0"]) * 256 - 0.5
    py = ((1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n - meta["tile_y0"]) * 256 - 0.5
    return py, px

raw = map_coordinates(hm, to_pixels(GX, GZ), order=1, mode="nearest").astype(np.float32)

# --- carve the terrain to the road ---
tree = cKDTree(np.c_[x, z])
dist, idx = tree.query(np.c_[GX.ravel(), GZ.ravel()])
dist, idx = dist.reshape(GX.shape), idx.reshape(GX.shape)
road_level = y[idx] - 0.25                       # sit just under the road surface
t = np.clip((dist - FLAT_R) / (BLEND_R - FLAT_R), 0, 1)
t = t * t * (3 - 2 * t)                          # smoothstep
terrain = (road_level * (1 - t) + raw * t).astype(np.float32)

# --- guardrails on the valley side ---
nxr, nzr = -tz / np.hypot(tx, tz), tx / np.hypot(tx, tz)   # unit "right" when driving (x east, z south, y up)
def ground_at(off):
    return map_coordinates(hm, to_pixels(x + nxr * off, z + nzr * off), order=1, mode="nearest")
def rail_mask(off):
    m = ground_at(off) < y - RAIL_DROP
    # fill short gaps, drop short stubs
    k = int(MIN_RAIL_GAP / STEP)
    for val in (True, False):
        runs, i = [], 0
        while i < len(m):
            j = i
            while j < len(m) and m[j] == m[i]: j += 1
            if m[i] != val and (j - i) < k and i > 0 and j < len(m): m[i:j] = val
            i = j
    return m
rail_r, rail_l = rail_mask(10.0), rail_mask(-10.0)

# --- write ---
os.makedirs(OUT, exist_ok=True)
terrain.tofile(os.path.join(OUT, "terrain.bin"))
course = {
    "frame": "metres; x east, z south, y elevation above sea level; x/z origin at start line",
    "start_latlon": [lat0 - z0s / KZ, lon0 + x0s / KX],
    "step": STEP, "road_half_width": ROAD_HALF,
    "length": round(float(ds[-1]), 1), "finish": round(float(finish), 1),
    "points": [[round(float(a), 2), round(float(b), 2), round(float(c), 2)] for a, b, c in zip(x, y, z)],
    "rail_left": "".join("1" if v else "0" for v in rail_l),
    "rail_right": "".join("1" if v else "0" for v in rail_r),
    "terrain": {"file": "terrain.bin", "dtype": "float32", "nx": nx, "nz": nz,
                "x0": round(float(gx0), 2), "z0": round(float(gz0), 2), "cell": CELL},
    "credits": route["credits"],
}
json.dump(course, open(os.path.join(OUT, "course.json"), "w"), separators=(",", ":"))

hairpins = int(np.sum(np.abs(np.diff(np.sign(curv[np.abs(curv) > 1 / 25])))) / 2)
print(f"course: {ds[-1]:.0f} m ({finish:.0f} m to the finish), {len(x)} points")
print(f"elevation {y[0]:.0f} m -> {y[int(finish/STEP)]:.0f} m at finish; "
      f"grade max {np.abs(grade).max()*100:.1f}%, mean {(-grade).mean()*100:.1f}%")
print(f"tightest radius {1/np.abs(curv).max():.1f} m; stretches tighter than 25 m radius: ~{hairpins}")
print(f"guardrail coverage: left {rail_l.mean()*100:.0f}%, right {rail_r.mean()*100:.0f}%")
print(f"terrain {nx}x{nz} @ {CELL} m = {(nx-1)*CELL/1000:.1f} x {(nz-1)*CELL/1000:.1f} km, "
      f"{terrain.min():.0f}-{terrain.max():.0f} m, {os.path.getsize(os.path.join(OUT,'terrain.bin'))/1024:.0f} KB")
print(f"course.json {os.path.getsize(os.path.join(OUT,'course.json'))/1024:.0f} KB")
