"""Turn car model downloads (JiggleSticks' Sketchfab cars, plus others) into lean, consistent, game-ready GLBs.

    python3 tools/build_car.py            # build every car in CARS
    python3 tools/build_car.py r32 gtr    # build just these

Source : assets/<folder>/scene.gltf + license.txt (JiggleSticks, CC-BY-4.0), or assets/<file>.glb with a `credit`
         (see CREDITS.md). Embedded textures are carried over.
Output : web/public/models/<id>.glb  + web/public/models/cars.json (dimensions manifest)

Every output GLB follows the same conventions, whatever the source model did:
- metres at real-world scale, Y up, car facing -Z (three.js forward),
  origin on the ground midway between the axles;
- nodes: `body`, `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR` (each pivoted on its axle, spin about X),
  plus any car-specific extras (the AE86's `popups`) and `brake_FL`.. (calipers on the wheel's pivot) where a model
  has them.
Wheels are found by node-name prefix and split into four by position, so it works whether the source
has one node per wheel or all four merged into one mesh.
"""
import json, os, struct, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "web", "public", "models")
TIRE_SEGMENTS = 20

# front:   which model-space axis the car's nose points along
# length:  real bumper-to-bumper length in metres (the models aren't to scale)
# wheels:  node-name prefixes whose meshes belong to the wheels (searched up the node path)
# brakes:  node-name prefixes of brake parts (calipers, discs) inside the wheels: they go to brake_FL.. nodes on the same
#          pivot, which steer with the front wheels but don't roll. Checked before `wheels`.
# discs:   node-name prefixes of the brake-disc meshes (wherever they are): they get their own copy of their material,
#          named `brake_disc`, which the game makes glow after hard braking (car.js)
# replace_tires: node prefix of tread-modelled tires to swap for generated low-poly ones
# hinged:  extra nodes that rotate about X: name -> node prefix, or dict(prefix, pivot=(y, z) in output metres,
#          closed=rad). The AE86's pivot/angle were fitted so the pods' curved back faces land flush in the hood
#          openings when folded (the back of a raised pop-up is the hood panel); without a pivot it hinges on the
#          rear-bottom edge. `closed` goes to cars.json as hinge_closed.
# file/credit: a single .glb under assets/ instead of folder/scene.gltf, and its attribution (replaces license.txt; without
#          one, the license.txt next to the file is used. The AE86 is a re-export of its scene.gltf with fixed normals)
# mirrors: generate door mirrors for a model that has none: dict(y, z) of the mount in output metres (the base of the
#          windscreen pillar), size=(out, tall, deep), material ids for the housing and the glass. Each one sits on the
#          body's side at that height, found from the mesh.
# donor_brakes: borrow another car's finished brake_FL.. nodes (calipers + glowing discs) for a model without any:
#          dict(car, inset=m toward the car's centre, scale=extra factor, hub=m). They're read from that car's built GLB
#          (so it builds first) and scaled by the ratio of wheel radii. Disc triangles within `hub` of the axle (donor
#          metres; the Supra's disc mesh includes its hub cap) get a plain copy of the material so they don't glow. The
#          donor's model is added to the credit.
# glass:   name of the model's window material (default "Glass"): replaced by GLASS, so every car's windows match
CARS = {
    "ae86": dict(file="hachi-roku/scene.edit.glb", name="Toyota AE86 Trueno", front="-x", length=4.18,
                 wheels=["Tires", "Rims"], replace_tires="Tires", glass="material_0", donor_brakes=dict(car="supra", hub=0.045),
                 hinged={"popups": dict(prefix="Pop Up", pivot=(0.673, -1.781), closed=-1.52)}),
    "r32": dict(folder="r32", name="Nissan Skyline R32", front="+z", length=4.545,
                wheels=["Front Wheel", "Rear Wheel", "Circle"], brakes=["Circle_Metal Brakes"],
                discs=["Circle_Rims"]),
    "gtr": dict(folder="gtr", name="Nissan GT-R", front="+x", length=4.71,
                wheels=["Roda"], brakes=["Circle"], discs=["Circle_Chapa"]),
    "supra": dict(folder="supra", name="Toyota Supra", front="-x", length=4.515,
                  wheels=["Tire "], glass="Vidros", brakes=["Brakes "], discs=[f"Brakes {w}_Rim Shinny" for w in ("FL", "FR", "RL", "RR")]),
    "celica6": dict(folder="celica6", name="Toyota Celica (6th gen)", front="-x", length=4.42,
                    wheels=["Rims"], brakes=["Brakes and Discs"], discs=["Brakes and Discs_Brake Discs"]),
    "celica7": dict(folder="celica7", name="Toyota Celica (7th gen)", front="+z", length=4.335,
                    wheels=["Wheels"], donor_brakes=dict(car="supra", hub=0.045)),
    "rx7": dict(file="rx7fc-ivofficial/Mazda RX-7 by IvOfficial - SnIoWlh7S2-edit.glb", name="Mazda RX-7 (FC)", front="+z",
                length=4.29, wheels=["FL_WHEEL", "FR_WHEEL", "RL_WHEEL", "RR_WHEEL"],
                hinged={"popups": dict(prefix="Headlights", closed=-1.45)},
                credit='Based on "Mazda RX-7" by IvOfficial (poly.pizza/m/SnIoWlh7S2), CC-BY-3.0'),
}

# every car's windows: near-black, a hint of blue-green, glossy and opaque. car.js gives it a sky to reflect.
GLASS = {"name": "glass", "doubleSided": True,
         "pbrMetallicRoughness": {"baseColorFactor": [0.012, 0.016, 0.02, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.06}}

CT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
# rotation about Y taking the model's nose direction to -Z
FRONT_ROT = {
    "-x": [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    "+x": [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    "+z": [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    "-z": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
}


def local_matrix(nd):
    if "matrix" in nd: return np.array(nd["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in nd: m = np.diag(list(nd["scale"]) + [1]) @ m
    if "rotation" in nd:
        x, y, z, w = nd["rotation"]
        R = np.eye(4)
        R[:3, :3] = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
        m = R @ m
    if "translation" in nd: m[:3, 3] += nd["translation"]
    return m


def tire_mesh(r_out, r_in, width, seg):
    """Low-poly tire ring around the X axle, centred on the origin."""
    P, N, I = [], [], []
    a = np.linspace(0, 2 * np.pi, seg + 1)
    hw = width / 2
    def ring(x, r, normal_fn):
        base = len(P)
        for t in a:
            c, s = np.cos(t), np.sin(t)
            P.append((x, r * c, r * s)); N.append(normal_fn(c, s))
        return base
    b0 = ring(-hw, r_out, lambda c, s: (0, c, s)); b1 = ring(hw, r_out, lambda c, s: (0, c, s))
    for k in range(seg): I += [(b0 + k, b0 + k + 1, b1 + k), (b1 + k, b0 + k + 1, b1 + k + 1)]
    for x, nx in ((-hw, -1), (hw, 1)):
        o = ring(x, r_out, lambda c, s, nx=nx: (nx, 0, 0)); i_ = ring(x, r_in, lambda c, s, nx=nx: (nx, 0, 0))
        for k in range(seg): I += [(o + k, i_ + k, o + k + 1), (o + k + 1, i_ + k, i_ + k + 1)]
    P, N, I = np.array(P), np.array(N, float), np.array(I, np.uint32)
    tri_n = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
    bad = (tri_n * N[I[:, 0]]).sum(1) < 0   # make winding agree with normals
    I[bad] = I[bad][:, ::-1]
    return P, N, I


def box_mesh(lo, hi):
    """Axis-aligned box from corner lo to hi: flat-shaded, outward normals. Returns faces as {name: (P, N, I)}."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    faces = {"-x": ([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], (-1, 0, 0)),
             "+x": ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (1, 0, 0)),
             "-y": ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0)),
             "+y": ([(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)], (0, 1, 0)),
             "-z": ([(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)], (0, 0, -1)),
             "+z": ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1))}
    out = {}
    for k, (q, n) in faces.items():
        P = np.array(q, float); N = np.tile(n, (4, 1)).astype(float); I = np.array([(0, 1, 2), (0, 2, 3)], np.uint32)
        tri_n = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
        bad = (tri_n * N[I[:, 0]]).sum(1) < 0; I[bad] = I[bad][:, ::-1]
        out[k] = (P, N, I)
    return out


def two_sided(prims, lo, hi):
    """Give every triangle inside box lo..hi (centroid) a back-facing twin with reversed normals. For pieces of a
    source model wound inconsistently (some faces inside out, shown see-through by back-face culling) where no single
    rule can tell which way they should face: whichever side you look from, a correctly lit face is drawn."""
    lo, hi = np.array(lo), np.array(hi)
    n_added = 0
    for p in prims:
        if p["group"] != "body": continue
        P, I = p["P"], p["I"]
        sel = np.all((P[I].mean(1) > lo) & (P[I].mean(1) < hi), axis=1)
        if not sel.any(): continue
        idx = I[sel].reshape(-1)
        base = len(P)
        p["P"] = np.vstack([P, P[idx]]); p["N"] = np.vstack([p["N"], -p["N"][idx]])
        if p["UV"] is not None: p["UV"] = np.vstack([p["UV"], p["UV"][idx]])
        p["I"] = np.vstack([I, (base + np.arange(len(idx))).reshape(-1, 3)[:, ::-1].astype(np.uint32)])
        n_added += sel.sum()
    print(f"  two-sided: {n_added} triangles")


def make_mirrors(prims, m):
    """Two door mirrors at station z on the body's sides (beltline height `belt`): a short arm out from the skin and
    the housing on its end with the glass facing back."""
    body = np.vstack([p["P"] for p in prims if p["group"] == "body"])
    z, belt = m["z"], m["belt"]
    near = body[(body[:, 1] > belt - 0.06) & (body[:, 1] < belt) & (np.abs(body[:, 2] - z) < 0.12)]
    skin = np.abs(near[:, 0]).max()                         # door skin just under the beltline
    w, h, d = m["size"]
    out = []

    def box(lo, hi, material, skip=()):
        faces = box_mesh(lo, hi)
        fs = [faces[k] for k in faces if k not in skip]
        P = np.vstack([f[0] for f in fs]); N = np.vstack([f[1] for f in fs])
        I = np.vstack([f[2] + 4 * i for i, f in enumerate(fs)])
        out.append(dict(group="body", material=material, P=P, N=N, UV=None, I=I))

    for s in (-1, 1):
        X = lambda a, b: sorted((s * a, s * b))              # inboard..outboard span on this side
        (ax0, ax1), (hx0, hx1) = X(skin - 0.03, skin + 0.05), X(skin + 0.02, skin + 0.02 + w)
        box((ax0, belt + 0.01, z - 0.018), (ax1, belt + 0.045, z + 0.018), m["housing"])        # arm
        hy0 = belt + 0.02
        box((hx0, hy0, z - d / 2), (hx1, hy0 + h, z + d / 2), m["housing"], skip=("+z",))     # housing
        g = box_mesh((hx0 + 0.01, hy0 + 0.01, z + d / 2), (hx1 - 0.01, hy0 + h - 0.01, z + d / 2 + 0.004))["+z"]
        out.append(dict(group="body", material=m["glass"], P=g[0], N=g[1], UV=None, I=g[2]))
    return out


def subset(p, mask):
    """Keep triangles where mask is true; compact vertices."""
    I = p["I"][mask]
    used, inv = np.unique(I, return_inverse=True)
    return dict(p, P=p["P"][used], N=p["N"][used], UV=None if p["UV"] is None else p["UV"][used],
                I=inv.reshape(-1, 3).astype(np.uint32))


def write_glb(path, out_nodes, materials, extensions, copyright_, tex=None):
    """tex: optional dict(images=[(bytes, mime)], samplers=[...], textures=[...]) copied as-is (images embedded)."""
    blob = bytearray(); views = []; accessors = []
    def add(arr, target, comp, typ, minmax=False):
        arr = np.ascontiguousarray(arr)
        while len(blob) % 4: blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": arr.nbytes, "target": target})
        blob.extend(arr.tobytes())
        acc = {"bufferView": len(views) - 1, "componentType": comp, "count": len(arr), "type": typ}
        if minmax: acc["min"] = arr.min(0).tolist(); acc["max"] = arr.max(0).tolist()
        accessors.append(acc); return len(accessors) - 1

    meshes, nodes, tris = [], [], 0
    for name, t, plist in out_nodes:
        gp = []
        for p in plist:
            if not len(p["I"]): continue
            attrs = {"POSITION": add(p["P"].astype(np.float32), 34962, 5126, "VEC3", True),
                     "NORMAL": add(p["N"].astype(np.float32), 34962, 5126, "VEC3")}
            if p["UV"] is not None: attrs["TEXCOORD_0"] = add(p["UV"].astype(np.float32), 34962, 5126, "VEC2")
            prim = {"attributes": attrs, "indices": add(p["I"].reshape(-1), 34963, 5125, "SCALAR")}
            if p["material"] is not None: prim["material"] = p["material"]
            gp.append(prim); tris += len(p["I"])
        meshes.append({"name": name, "primitives": gp})
        nodes.append({"name": name, "mesh": len(meshes) - 1, "translation": [float(v) for v in t]})
    nodes.append({"name": "car", "children": list(range(len(nodes)))})
    doc = {
        "asset": {"version": "2.0", "generator": "ghost-of-mount-akina/tools/build_car.py", "copyright": copyright_},
        "scene": 0, "scenes": [{"nodes": [len(nodes) - 1]}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": views,
    }
    if extensions: doc["extensionsUsed"] = extensions
    if tex and tex["textures"]:
        imgs = []
        for data, mime in tex["images"]:
            while len(blob) % 4: blob.append(0)
            views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
            blob.extend(data); imgs.append({"bufferView": len(views) - 1, "mimeType": mime})
        doc.update(images=imgs, textures=tex["textures"])
        if tex["samplers"]: doc["samplers"] = tex["samplers"]
    doc["buffers"] = [{"byteLength": len(blob) + (-len(blob) % 4)}]
    while len(blob) % 4: blob.append(0)
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(blob), 0x004E4942)); f.write(blob)
    return tris


def normalize_materials(materials):
    """three.js dropped KHR_materials_pbrSpecularGlossiness; convert factor-only spec/gloss to metal/rough.
    Returns (materials, extensionsUsed) with extensionsUsed recomputed from what's actually present."""
    out = []
    for m in materials:
        m = json.loads(json.dumps(m))
        ext = m.get("extensions", {})
        sg = ext.pop("KHR_materials_pbrSpecularGlossiness", None)
        if sg is not None:
            if "diffuseTexture" in sg or "specularGlossinessTexture" in sg:
                raise ValueError(f"material {m.get('name')}: textured spec/gloss not supported")
            m["pbrMetallicRoughness"] = {"baseColorFactor": sg.get("diffuseFactor", [1, 1, 1, 1]),
                                         "metallicFactor": 0.0,
                                         "roughnessFactor": 1.0 - sg.get("glossinessFactor", 1.0)}
        if not ext: m.pop("extensions", None)
        out.append(m)
    used = sorted({k for m in out for k in m.get("extensions", {})})
    return out, used


def read_glb(path):
    """(gltf json, binary buffer) of a .glb file."""
    d = open(path, "rb").read()
    magic, _, _ = struct.unpack("<III", d[:12])
    if magic != 0x46546C67: raise ValueError(f"{path}: not a GLB")
    off, g, buf = 12, None, b""
    while off < len(d):
        ln, typ = struct.unpack("<II", d[off:off + 8]); chunk = d[off + 8:off + 8 + ln]; off += 8 + ln
        if typ == 0x4E4F534A: g = json.loads(chunk)
        elif typ == 0x004E4942: buf = chunk
    return g, buf


def read_accessor(g, buf, ai):
    a = g["accessors"][ai]; bv = g["bufferViews"][a["bufferView"]]
    n = NC[a["type"]]
    arr = np.frombuffer(buf, dtype=CT[a["componentType"]], count=a["count"] * n,
                        offset=bv.get("byteOffset", 0) + a.get("byteOffset", 0))
    return arr.reshape(-1, n) if n > 1 else arr


def donor_brakes(spec, wheels, materials):
    """Another car's built brake_FL.. nodes, fitted to these wheels: {label: [prims]} relative to the wheel centre.
    Their materials are appended to `materials` (untextured, so no texture remapping). Returns (parts, donor credit)."""
    path = os.path.join(OUT_DIR, f"{spec['car']}.glb")
    g, buf = read_glb(path)
    dr = json.load(open(os.path.join(OUT_DIR, "cars.json")))[spec["car"]]["wheel_radius"]
    remap, out = {}, {}
    for nd in g["nodes"]:
        if not nd.get("name", "").startswith("brake_"): continue
        label = nd["name"][6:]
        k = wheels[label]["radius"] / dr * spec.get("scale", 1.0)
        side = 1 if label.endswith("R") else -1               # right wheels are at +x
        prims = []
        for p in g["meshes"][nd["mesh"]]["primitives"]:
            mi = p["material"]
            if mi not in remap:
                m = json.loads(json.dumps(g["materials"][mi]))
                if any(k_ in json.dumps(m) for k_ in ("Texture", "texture")): raise ValueError(f"{path}: textured brake")
                materials.append(m); remap[mi] = len(materials) - 1
                if m.get("name") == "brake_disc":
                    materials.append(dict(m, name="brake_hub")); remap[("hub", mi)] = len(materials) - 1
            P0 = read_accessor(g, buf, p["attributes"]["POSITION"]).astype(float)
            I = read_accessor(g, buf, p["indices"]).astype(np.uint32).reshape(-1, 3)
            P = P0 * k
            P[:, 0] -= side * spec.get("inset", 0.0)
            prim = dict(material=remap[mi], P=P, N=read_accessor(g, buf, p["attributes"]["NORMAL"]).astype(float),
                        UV=None, I=I)
            if ("hub", mi) in remap and spec.get("hub"):
                c = P0[I].mean(1); hub = np.hypot(c[:, 1], c[:, 2]) < spec["hub"]
                prims += [subset(prim, ~hub), dict(subset(prim, hub), material=remap[("hub", mi)])]
            else: prims.append(prim)
        out[label] = prims
    return out, g["asset"]["copyright"].replace("Based on ", "brakes from ")


def load_source(cfg):
    """(gltf json, binary buffer, folder) for a car: a .glb file, or folder/scene.gltf with its .bin."""
    if "file" in cfg:
        path = os.path.join(ROOT, "assets", cfg["file"])
        g, buf = read_glb(path)
        return g, buf, os.path.dirname(path)
    src = os.path.join(ROOT, "assets", cfg["folder"])
    g = json.load(open(os.path.join(src, "scene.gltf")))
    return g, open(os.path.join(src, g["buffers"][0]["uri"]), "rb").read(), src


def source_textures(g, buf, src):
    """Images (as bytes), samplers and textures of the source, for write_glb."""
    images = []
    for im in g.get("images", []):
        if "bufferView" in im:
            bv = g["bufferViews"][im["bufferView"]]; o = bv.get("byteOffset", 0)
            images.append((buf[o:o + bv["byteLength"]], im.get("mimeType", "image/png")))
        else:
            images.append((open(os.path.join(src, im["uri"]), "rb").read(),
                           im.get("mimeType", "image/jpeg" if im["uri"].lower().endswith((".jpg", ".jpeg")) else "image/png")))
    return dict(images=images, samplers=g.get("samplers", []), textures=g.get("textures", []))


def build(car_id, cfg):
    g, buf, src = load_source(cfg)

    def read(ai): return read_accessor(g, buf, ai)

    parent = {c: i for i, n in enumerate(g["nodes"]) for c in n.get("children", [])}
    def world(i):
        m = local_matrix(g["nodes"][i])
        while i in parent:
            i = parent[i]; m = local_matrix(g["nodes"][i]) @ m
        return m
    def names_up(i):
        out = [g["nodes"][i].get("name", "")]
        while i in parent:
            i = parent[i]; out.append(g["nodes"][i].get("name", ""))
        return out
    # nearest matching ancestor wins (the AE86 nests its Rims node inside Tires)
    hinged = {h: (v if isinstance(v, dict) else dict(prefix=v)) for h, v in cfg.get("hinged", {}).items()}
    rules = ([("brake", p) for p in cfg.get("brakes", ())] + [("wheel", p) for p in cfg["wheels"]]
             + [(h, v["prefix"]) for h, v in hinged.items()])
    if cfg.get("replace_tires"): rules.insert(0, ("tire", cfg["replace_tires"]))
    def classify(i):
        for n in names_up(i):
            for group, pre in rules:
                if n.strip().startswith(pre.strip()) and not (group == "wheel" and pre == cfg.get("replace_tires")):
                    return group
        return "body"

    # ---- bake every primitive into (unscaled) game orientation ----
    R = np.eye(4); R[:3, :3] = FRONT_ROT[cfg["front"]]
    prims = []
    for ni, nd in enumerate(g["nodes"]):
        if "mesh" not in nd: continue
        W = R @ world(ni)
        nmat = np.linalg.inv(W[:3, :3]).T
        flip = np.linalg.det(W[:3, :3]) < 0
        group = classify(ni)
        for p in g["meshes"][nd["mesh"]]["primitives"]:
            P = read(p["attributes"]["POSITION"]).astype(float) @ W[:3, :3].T + W[:3, 3]
            N = read(p["attributes"]["NORMAL"]).astype(float) @ nmat.T
            N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
            UV = read(p["attributes"]["TEXCOORD_0"]).astype(float) if "TEXCOORD_0" in p["attributes"] else None
            I = (read(p["indices"]).astype(np.uint32).reshape(-1, 3) if "indices" in p
                 else np.arange(len(P), dtype=np.uint32).reshape(-1, 3))
            if flip: I = I[:, ::-1]
            disc = any(nd.get("name", "").startswith(d) for d in cfg.get("discs", ()))
            prims.append(dict(group=group, material=p.get("material"), P=P, N=N, UV=UV, I=I, disc=disc))

    materials, extensions = normalize_materials(g["materials"])
    glass = [i for i, m in enumerate(materials) if m.get("name") == cfg.get("glass", "Glass")]
    if not glass: raise ValueError(f"{car_id}: no glass material {cfg.get('glass', 'Glass')!r}")
    for i in glass: materials[i] = json.loads(json.dumps(GLASS))
    extensions = sorted({k for m in materials for k in m.get("extensions", {})})
    disc_mat = {}  # source material -> its brake_disc copy
    for p in prims:
        if not p["disc"]: continue
        if p["material"] not in disc_mat:
            m = json.loads(json.dumps(materials[p["material"]])); m["name"] = "brake_disc"
            materials.append(m); disc_mat[p["material"]] = len(materials) - 1
        p["material"] = disc_mat[p["material"]]

    # ---- scale to real length, then place origin on ground between axles ----
    allP = np.vstack([p["P"] for p in prims])
    scale = cfg["length"] / (allP[:, 2].max() - allP[:, 2].min())
    for p in prims: p["P"] = p["P"] * scale

    wheel_like = [p for p in prims if p["group"] in ("wheel", "tire")]
    wP = np.vstack([p["P"] for p in wheel_like])
    xmid, zmid = (wP[:, 0].min() + wP[:, 0].max()) / 2, (wP[:, 2].min() + wP[:, 2].max()) / 2
    quads = {"FL": (-1, -1), "FR": (1, -1), "RL": (-1, 1), "RR": (1, 1)}
    def quadrant_mask(p, sx, sz):
        c = p["P"][p["I"]].mean(1)
        return (np.sign(c[:, 0] - xmid) == sx) & (np.sign(c[:, 2] - zmid) == sz)

    wheels = {}
    for label, (sx, sz) in quads.items():
        q = np.vstack([subset(p, quadrant_mask(p, sx, sz))["P"] for p in wheel_like])
        lo, hi = q.min(0), q.max(0)
        wheels[label] = dict(center=(lo + hi) / 2, radius=(hi[1] - lo[1]) / 2, width=hi[0] - lo[0])
    ground = wP[:, 1].min()
    axle_mid = np.mean([w["center"][2] for w in wheels.values()])
    offset = np.array([-xmid, -ground, -axle_mid])
    for p in prims: p["P"] = p["P"] + offset
    for w in wheels.values(): w["center"] = w["center"] + offset

    body_w = np.ptp(np.vstack([p["P"] for p in prims])[:, 0])  # width as quoted for real cars: without mirrors
    for box in cfg.get("two_sided", ()): two_sided(prims, *box)
    if cfg.get("mirrors"): prims += make_mirrors(prims, cfg["mirrors"])

    # ---- assemble nodes ----
    out_nodes = [("body", [0, 0, 0], [p for p in prims if p["group"] == "body"])]
    for h, hv in hinged.items():
        hp = [p for p in prims if p["group"] == h]
        P = np.vstack([p["P"] for p in hp])
        if "pivot" in hv: hinge = np.array([P[:, 0].mean(), *hv["pivot"]])
        else: hinge = np.array([P[:, 0].mean(), P[:, 1].min(), P[:, 2].max()])  # rear-bottom edge
        out_nodes.append((h, hinge.tolist(), [dict(p, P=p["P"] - hinge) for p in hp]))
    tire_mat = next((p["material"] for p in prims if p["group"] == "tire"), None)
    donor, donor_credit = donor_brakes(cfg["donor_brakes"], wheels, materials) if cfg.get("donor_brakes") else ({}, None)
    for label, (sx, sz) in quads.items():
        c = wheels[label]["center"]
        parts = []
        for p in prims:
            if p["group"] != "wheel": continue
            s = subset(p, quadrant_mask(dict(p, P=p["P"] - offset), sx, sz))
            if len(s["I"]): parts.append(dict(s, P=s["P"] - c))
        if cfg.get("replace_tires"):
            rp = np.vstack([s["P"] for s in parts])
            rim_r = np.sqrt(rp[:, 1] ** 2 + rp[:, 2] ** 2).max()
            w = wheels[label]
            TP, TN, TI = tire_mesh(w["radius"], min(rim_r, w["radius"] * 0.95), w["width"], TIRE_SEGMENTS)
            parts.append(dict(material=tire_mat, P=TP, N=TN, UV=None, I=TI))
        out_nodes.append((f"wheel_{label}", c.tolist(), parts))
        brake = [dict(s, P=s["P"] - c) for p in prims if p["group"] == "brake"
                 for s in [subset(p, quadrant_mask(dict(p, P=p["P"] - offset), sx, sz))] if len(s["I"])]
        brake += donor.get(label, [])
        if brake: out_nodes.append((f"brake_{label}", c.tolist(), brake))

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{car_id}.glb")
    if "credit" in cfg: copyright_ = cfg["credit"]
    else:
        lic = open(os.path.join(src, "license.txt")).read()
        title = next(l.split("\t", 1)[1].strip() for l in lic.splitlines() if l.startswith("* title:"))
        copyright_ = f'Based on "{title}" by JiggleSticks, CC-BY-4.0'
    if donor_credit: copyright_ += f"; {donor_credit}"
    tris = write_glb(out, out_nodes, materials, extensions, copyright_, source_textures(g, buf, src))

    final = np.vstack([p["P"] + np.array(t) for _, t, pl in out_nodes for p in pl])
    lo, hi = final.min(0), final.max(0)
    fl, rl = wheels["FL"]["center"], wheels["RL"]["center"]
    info = dict(id=car_id, name=cfg["name"], file=f"models/{car_id}.glb", credit=copyright_,
                length=round(float(hi[2] - lo[2]), 3), width=round(float(body_w), 3),
                height=round(float(hi[1] - lo[1]), 3),
                wheelbase=round(float(rl[2] - fl[2]), 3),
                track=round(float(wheels["FR"]["center"][0] - fl[0]), 3),
                wheel_radius=round(float(np.mean([w["radius"] for w in wheels.values()])), 3),
                hinged=list(hinged),
                hinge_closed={h: hv["closed"] for h, hv in hinged.items() if "closed" in hv})
    print(f"{car_id:8s} {os.path.getsize(out)/1024:6.0f} KB {tris:6d} tris  L{info['length']} W{info['width']} "
          f"H{info['height']}  wb {info['wheelbase']} track {info['track']} r {info['wheel_radius']}  "
          f"(scale x{scale:.3f})")
    return info


if __name__ == "__main__":
    ids = sys.argv[1:] or list(CARS)
    donors = {CARS[c]["donor_brakes"]["car"] for c in ids if CARS[c].get("donor_brakes")}
    ids = [c for c in ids if c in donors] + [c for c in ids if c not in donors]   # donors build first
    manifest_path = os.path.join(OUT_DIR, "cars.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    for cid in ids:
        manifest[cid] = build(cid, CARS[cid])
    json.dump({k: manifest[k] for k in CARS if k in manifest}, open(manifest_path, "w"), indent=2)
