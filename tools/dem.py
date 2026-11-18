"""DEM-agnostic elevation lookup by WGS84 lat/lon, for the fly-over sites (Rio, Hong Kong, Big Sur).

    from dem import load
    d = load("assets/rio/dem_gavea")         # reads <base>.npy + <base>.json
    z = d.elev(lat, lon)                     # scalars or arrays, bilinear, NaN outside / on nodata

The sidecar JSON (written by tools/fetch_*_dem.py) names the grid CRS, the north-west corner (x0, y0),
the spacing and the source credit. Supported CRS: EPSG:31983 (SIRGAS 2000 / UTM 23S), EPSG:2326
(Hong Kong 1980 Grid) EPSG:26910 (NAD83 / UTM 10N), EPSG:26913 (NAD83 / UTM 13N) and EPSG:32632 (WGS 84 / UTM 32N) and EPSG:3857 (Web Mercator, the GSI tiles: `step` is in mercator metres, not ground metres). Add one by writing a `lonlat -> (x, y)` function and registering it in CRS.

The HK1980 datum is ~100 m off WGS84, so it goes through a 7-parameter Helmert shift. Parameters and
rotation convention were checked against the HK Geodetic Survey's official transform service
(three points on Peak/Stubbs Road, agreement ~1 mm). Do not "fix" the signs without re-running that check.
"""
import json, math, os
import numpy as np
from scipy.ndimage import map_coordinates

WGS84 = (6378137.0, 1 / 298.257223563)
INTL1924 = (6378388.0, 1 / 297.0)
ARCSEC = math.pi / 180 / 3600


def _tm(lon, lat, ell, lat0, lon0, k0, fe, fn):
    """Transverse Mercator (Snyder series), vectorised. Degrees in, metres out."""
    a, f = ell
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)

    def meridian(p):
        return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p
                    - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * p)
                    + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * p)
                    - (35 * e2**3 / 3072) * np.sin(6 * p))
    p, l = np.radians(lat), np.radians(lon)
    N = a / np.sqrt(1 - e2 * np.sin(p) ** 2)
    T, C, A = np.tan(p) ** 2, ep2 * np.cos(p) ** 2, np.cos(p) * (l - math.radians(lon0))
    x = k0 * N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120) + fe
    y = k0 * (meridian(p) - meridian(math.radians(lat0))
              + N * np.tan(p) * (A**2 / 2 + (5 - T + 9 * C + 4 * C**2) * A**4 / 24
                                 + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720)) + fn
    return x, y


def utm23s(lon, lat):
    """EPSG:31983. SIRGAS 2000 is within ~1 m of WGS84 here, so no datum shift."""
    return _tm(lon, lat, WGS84, 0.0, -45.0, 0.9996, 500000.0, 10000000.0)


def utm10n(lon, lat):
    """EPSG:26910 (NAD83 / UTM 10N; USGS 3DEP, central California). NAD83 is only ~1-2 m from WGS84 there, so no datum shift
    (fine for 1 m LiDAR under a road that OSM places to a few metres; not for anything needing sub-metre agreement)."""
    return _tm(lon, lat, WGS84, 0.0, -123.0, 0.9996, 500000.0, 0.0)


def utm13n(lon, lat):
    """EPSG:26913 (NAD83 / UTM 13N; USGS 3DEP, New Mexico). Same ~1-2 m NAD83 vs WGS84 caveat as utm10n."""
    return _tm(lon, lat, WGS84, 0.0, -105.0, 0.9996, 500000.0, 0.0)


def utm32n(lon, lat):
    """EPSG:32632 (WGS 84 / UTM 32N), which TINITALY uses for the whole of Italy, so the east (Amalfi is at E ~965 km) is far past the
    zone's own 6 degrees; the series is still good to well under a metre at ~5.5 degrees from the central meridian."""
    return _tm(lon, lat, WGS84, 0.0, 9.0, 0.9996, 500000.0, 0.0)


# HK80 -> WGS84 Helmert (translation m, rotation arc-seconds, scale ppm), Coordinate Frame convention
_HK_T = np.array([-162.619, -276.959, -161.764])
_HK_R = np.array([-0.067753, 2.243648, 1.158828]) * ARCSEC
_HK_S = -1.094246e-6


def _ecef(lon, lat, ell):
    a, f = ell; e2 = f * (2 - f)
    p, l = np.radians(lat), np.radians(lon)
    N = a / np.sqrt(1 - e2 * np.sin(p) ** 2)
    return np.stack([N * np.cos(p) * np.cos(l), N * np.cos(p) * np.sin(l), N * (1 - e2) * np.sin(p)])


def _geodetic(P, ell):
    a, f = ell; e2 = f * (2 - f)
    x, y, z = P
    l, r = np.arctan2(y, x), np.hypot(x, y)
    p = np.arctan2(z, r * (1 - e2))
    for _ in range(8):
        N = a / np.sqrt(1 - e2 * np.sin(p) ** 2)
        h = r / np.cos(p) - N
        p = np.arctan2(z, r * (1 - e2 * N / (N + h)))
    return np.degrees(l), np.degrees(p)


def hk1980(lon, lat):
    """EPSG:2326 (HK1980 Grid) from WGS84. Returns (easting, northing)."""
    lon, lat = np.broadcast_arrays(np.asarray(lon, float), np.asarray(lat, float))
    rx, ry, rz = _HK_R
    R = np.array([[1, rz, -ry], [-rz, 1, rx], [ry, -rx, 1]]) * (1 + _HK_S)
    P = _ecef(lon, lat, WGS84).reshape(3, -1) - _HK_T[:, None]
    hk = np.linalg.solve(R, P).reshape(3, *lon.shape)
    lo, la = _geodetic(hk, INTL1924)
    return _tm(lo, la, INTL1924, 22.3121333333, 114.1785555556, 1.0, 836694.05, 819069.80)


def web_mercator(lon, lat):
    """EPSG:3857 (spherical Web Mercator, what slippy-map tiles use). Ground metres are 1/cos(lat) smaller than these units."""
    lon, lat = np.broadcast_arrays(np.asarray(lon, float), np.asarray(lat, float))
    R = 6378137.0
    return R * np.radians(lon), R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


CRS = {"EPSG:31983": utm23s, "EPSG:2326": hk1980, "EPSG:26910": utm10n, "EPSG:26913": utm13n, "EPSG:32632": utm32n, "EPSG:3857": web_mercator}


class Dem:
    def __init__(self, grid, meta):
        if meta["crs"] not in CRS:
            raise ValueError(f"unsupported CRS {meta['crs']}; add it to dem.CRS")
        if meta.get("rows", "north_to_south") != "north_to_south":
            raise ValueError("expected rows running north to south")
        self.grid, self.meta, self.step = grid, meta, float(meta["step"])
        self.x0, self.y0 = float(meta["x0"]), float(meta["y0"])
        self.project = CRS[meta["crs"]]
        self.source = meta.get("source", "")

    def xy(self, lat, lon):
        """Grid-CRS metres for WGS84 lat/lon."""
        return self.project(np.asarray(lon, float), np.asarray(lat, float))

    def elev(self, lat, lon, order=1, mode="constant"):
        """Bilinear elevation (m). NaN outside the grid or touching nodata (mode="nearest" extends the edge instead)."""
        x, y = self.xy(lat, lon)
        shape = np.shape(x)
        col, row = np.atleast_1d((x - self.x0) / self.step), np.atleast_1d((self.y0 - y) / self.step)
        out = map_coordinates(self.grid, [row.ravel(), col.ravel()], order=order, mode=mode, cval=np.nan)
        out = out.reshape(row.shape)
        return float(out[0]) if shape == () else out.reshape(shape)

    def contains(self, lat, lon):
        x, y = self.xy(lat, lon)
        col, row = (x - self.x0) / self.step, (self.y0 - y) / self.step
        return (col >= 0) & (row >= 0) & (col <= self.grid.shape[1] - 1) & (row <= self.grid.shape[0] - 1)

    def filled(self):
        """Copy with nodata replaced by the nearest valid cell (for smoothing / sampling the sea or gaps)."""
        from scipy.ndimage import distance_transform_edt
        bad = ~np.isfinite(self.grid)
        if not bad.any():
            return self.grid.copy()
        idx = distance_transform_edt(bad, return_distances=False, return_indices=True)
        return self.grid[tuple(idx)]


def load(base):
    base = os.fspath(base)
    if base.endswith((".npy", ".json")):
        base = base.rsplit(".", 1)[0]
    return Dem(np.load(base + ".npy"), json.load(open(base + ".json")))
