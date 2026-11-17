# Locations to add

The brief: a road with real, tight, fun corners **and** lots of buildings, so the tilt-shift scale-model look has
something to chew on. Each entry notes where the terrain data would come from; the DEM is usually the hard part.
Anything coarser than ~5 m looks blocky (30 m global models such as Copernicus GLO-30 are a last resort).

## Done
- [x] Route 33, Mt. Haruna, Japan (GSI DEM)
- [x] Rio de Janeiro: Estrada da Gávea through Rocinha (IPP 5 m LiDAR)
- [x] Hong Kong: Peak Road → Stubbs Road (CEDD 0.5 m LiDAR)

## Candidates
- [ ] **Valparaíso, Chile**: the cerros, steep colourful streets stacked up the hills, switchbacks like Cerro Alegre's.
  DEM: no obvious national LiDAR; check IDE Chile, otherwise a 12.5 m ALOS PALSAR DEM.
- [ ] **Amalfi Coast, Italy**: SS163 through Positano and Amalfi, villages stacked down the cliff. DEM: Italy's
  TINITALY 10 m, or regional LiDAR (Campania).
- [ ] **Kotor serpentine, Montenegro**: 25 hairpins up from Kotor's old town. DEM: probably only 30 m; weakest data of the list.
- [ ] **Nagasaki, Japan**: Mt. Inasa and the hillside neighbourhoods, dense and steep. DEM: GSI dem5a (already supported by `build_track.py`).
- [ ] **Onomichi / Kobe Rokko, Japan**: same data source as Route 33, so the cheapest to add.
- [ ] **Monaco / La Turbie, France**: Moyenne Corniche down into Monaco's towers. DEM: IGN LiDAR HD (0.5 m, free).
- [ ] **San Francisco, USA**: Twin Peaks, Lombard Street, Vermont Street. DEM: USGS 3DEP 1 m LiDAR.
- [ ] **Cape Town, South Africa**: Signal Hill and Kloof Nek Road above the city, or Chapman's Peak. DEM: City of Cape Town LiDAR (open data, check licence).
- [ ] **Madeira, Portugal**: Funchal's hillside roads, Caminho do Monte. DEM: Madeira regional LiDAR, or the national 5 m model.
- [ ] **Santorini, Greece**: the Athinios port zigzag and Fira's cliff-top town. DEM: Hellenic Cadastre 5 m (check access).
- [ ] **Medellín, Colombia**: the comunas climbing the valley sides. DEM: city LiDAR if open, otherwise coarser.
- [ ] **Taxco / Guanajuato, Mexico**: dense hillside towns, narrow switchbacks. DEM: INEGI 5 m LiDAR terrain model.
- [ ] **Hong Kong, second road**: Shek O Road, Tai Mo Shan Road, or Cape Collinson Road. Data already downloaded and
  the pipeline proven, so only a new stitch and build.

## Housekeeping
- [ ] Retrofit checkpointing to `tools/fetch_rio_dem.py` (the HK fetcher resumes; this one restarts from scratch).
- [ ] Rio: the route stops ~100 m short of São Conrado beach (a gap in the OSM road). Decide whether to bridge it by hand.
- [ ] Rio: OSM building coverage is patchy on the far hillside.
- [ ] Draw footpaths and steps as narrow paths (Rocinha's alleys are missing).
- [ ] Hong Kong: only ~45% of buildings have height tags, the rest are guessed.
- [ ] Confirm the CSDI portal's terms for the CEDD LiDAR data (the credit follows the DATA.GOV.HK attribution terms).
- [ ] A way to pick a site from the page, instead of editing the URL.
- [x] Strip the race, rivals, director, HUD, map, demo and songs (done); the default page is the fly-by with an Esc options menu.
- [ ] Add new music (see README, Sound), and hook the audio engine up to the fly-by car if wanted.
- [ ] The palms: the new frond geometry is ~20 boxes each, so check frame rate on weaker machines.
