# Locations to add

The brief: a road with real, tight, fun corners **and** lots of buildings, so the tilt-shift scale-model look has
something to chew on. Each entry notes where the terrain data would come from; the DEM is usually the hard part.
Anything coarser than ~5 m looks blocky (30 m global models such as Copernicus GLO-30 are a last resort).

## Done
- [x] Monaco: Moyenne Corniche (D 6007) from Èze down through Monaco to Port Hercule, 7.5 km, 365 m to 1 m. IGN RGE ALTI via `fetch_ign_dem.py` (WMS-R in UTM 32N, 2 m, resumable; needs `tifffile`; covers Monaco too). Route stitched with `--exclude "Rue Plati"` (the shortest path used it and the 31% terraces put terrain through the road). One stacked hairpin at s~5310 still has 0.2 m of terrain through the road. Local Overpass (Provence extract). 2 tunnels, flat roofs.
- [x] Sandia Crest, New Mexico: NM 536, 21 km, 3DEP 1 m (OPR tiles, `fetch_3dep_dem.py --opr --project`). Long and sparse (~120 buildings), by design.
- [x] L'Alpe d'Huez: D 211, 14 km, 21 hairpins, IGN RGE ALTI, first place with snow (`ground.snow`). Not done: falling snow, snowy trees and roofs, a treeline.
- [x] Nagasaki, Japan: Mt. Inasa summit road down to the harbour, 3.9 km, 289 m to 3 m. GSI dem5a (5 m) via `fetch_gsi_dem.py`; route stitched from a local Overpass (wiktorn/overpass-api, Kyushu extract). Notes: starts at the end of the summit car park (the loop through it put terrain through the road); tightest bend radius 2.6 m, worth a look by eye; 6050 OSM buildings.
- [x] Amalfi Coast, Italy: SS163 from Positano east to the Fiordo di Furore, 12 km (13.5 km before smoothing). INGV TINITALY 10 m via `fetch_tinitaly_dem.py` (tile w45095; the tile map on the download page runs west to east, and the names don't follow the UTM easting). Notes: the road is the surface SS163 only (no Amalfi town: the route ends at Furore); 6 OSM tunnels are built as hills over a level road (`tunnels` in course.json; `buildTunnels` in structures.js adds a dark tube and a concrete frame at each end, and the terrain shader cuts an arch-shaped opening into the hill at each portal), 11 bridges; `y_smooth=50` because 10 m terrain turns hairpins into 30-50% grades (max now 30%); no sun-facing terraces or lemon groves, buildings only from OSM.
- [x] Big Sur: Pacific Coast Highway (CA 1), 8 km from Rocky Creek over Bixby Creek Bridge to Hurricane Point. USGS 3DEP 1 m LiDAR via `fetch_3dep_dem.py`; bridge decks run level. Notes: the DEM flattens open water to 0.6 / 1.14 m, so `sea` is 1.3 and `forest.sparse` clears trees below 2 m; the datum is ~1-2 m off WGS84; only 47 OSM buildings; bridges are built in `buildBridges` (structures.js): slab, arch ribs and columns, which also cast the shadow into the valley.
- [x] Route 33, Mt. Haruna, Japan (GSI DEM)
- [x] Rio de Janeiro: Estrada da Gávea through Rocinha (IPP 5 m LiDAR)
- [x] Hong Kong: Peak Road → Stubbs Road (CEDD 0.5 m LiDAR)

## Candidates
- [ ] **Valparaíso, Chile**: the cerros, steep colourful streets stacked up the hills, switchbacks like Cerro Alegre's.
  DEM: no obvious national LiDAR; check IDE Chile, otherwise a 12.5 m ALOS PALSAR DEM.
- [ ] **Kotor serpentine, Montenegro**: 25 hairpins up from Kotor's old town. DEM: probably only 30 m; weakest data of the list.
- [ ] **Onomichi / Kobe Rokko, Japan**: same data source as Route 33, so the cheapest to add.
- [ ] **San Francisco, USA**: Twin Peaks, Lombard Street, Vermont Street. DEM: USGS 3DEP 1 m LiDAR.
- [ ] **Cape Town, South Africa**: Signal Hill and Kloof Nek Road above the city, or Chapman's Peak. DEM: City of Cape Town LiDAR (open data, check licence).
- [ ] **Madeira, Portugal**: Funchal's hillside roads, Caminho do Monte. DEM: Madeira regional LiDAR, or the national 5 m model.
- [ ] **Santorini, Greece**: the Athinios port zigzag and Fira's cliff-top town. DEM: Hellenic Cadastre 5 m (check access).
- [ ] **Medellín, Colombia**: the comunas climbing the valley sides. DEM: city LiDAR if open, otherwise coarser.
- [ ] **Taxco / Guanajuato, Mexico**: dense hillside towns, narrow switchbacks. DEM: INEGI 5 m LiDAR terrain model.
- [ ] **Hong Kong, second road**: Shek O Road, Tai Mo Shan Road, or Cape Collinson Road. Data already downloaded and
  the pipeline proven, so only a new stitch and build.

## Housekeeping
- [x] `tools/fetch_rio_dem.py` now checkpoints (`<out>.part.npy`) and resumes, like the HK fetcher.
- [x] Rio: the route now carries on past the foot of Gávea (imaginary ~30 m link onto Rua Henrique Midosi) and along Av. Mendes de Morais to the Niemeyer junction (`tools/extend_rio_route.py`).
- [x] Rio: São Conrado's coastal plain is thinned (`forest.sparse`) and has a sea (`sea`), both per-site settings in `SITES`.
- [ ] Rio: OSM building coverage is patchy on the far hillside.
- [x] Footpaths and steps are drawn as narrow paths in Rio (`build_roads.py --site rio --paths`; 308 of 682 pieces).
- [ ] Hong Kong: only ~45% of buildings have height tags, the rest are guessed.
- [ ] Confirm the CSDI portal's terms for the CEDD LiDAR data (the credit follows the DATA.GOV.HK attribution terms).
- [x] A way to pick a site from the page, instead of editing the URL (the Esc menu's place row, and auto-cycle).
- [x] Strip the race, rivals, director, HUD, map, demo and songs (done); the default page is the fly-by with an Esc options menu.
- [x] Add new music (see README, Sound), and hook the audio engine up to the fly-by car (`course/audio.js`; engine and music off by default).
- [ ] The palms: the new frond geometry is ~20 boxes each, so check frame rate on weaker machines.
