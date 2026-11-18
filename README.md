# Touring

Pretty little drift tours: a drone flies over a real mountain road while a car drifts down it, with the real terrain
and every building from OpenStreetMap, in a tilt-shift "scale model" look. three.js, runs in the browser.

Forked from [Ghost of Mount Akina](../ghost-of-mount-akina/), a comedic touge game. That game keeps its own repo; this one
is only the fly-over. The race, rivals, story and soundtrack were removed; there is no manual driving, only the car
driving itself.

## Places
| Site | Road | URL |
|------|------|-----|
| Route 33 (Mt. Haruna, Japan) | Gunma Pref. Route 33, summit → Ikaho | `?site=` |
| Rio de Janeiro | Estrada da Gávea, through Rocinha | `?site=rio` (default) |
| Hong Kong | Peak Road → Stubbs Road | `?site=hk` |
| Big Sur, California | Pacific Coast Highway (CA 1), Rocky Creek → Bixby Creek Bridge → Hurricane Point, 8 km | `?site=bigsur` |
| Amalfi Coast, Italy | SS 163 (Strada Statale Amalfitana), Positano → Fiordo di Furore, 12 km | `?site=amalfi` |
| Nagasaki, Japan | Mt. Inasa summit road down to the harbour, 4 km (GSI 5 m DEM) | `?site=nagasaki` |
| Monaco | Moyenne Corniche (D 6007) from Èze down through Monaco to Port Hercule, 7.5 km (IGN RGE ALTI) | `?site=monaco` |
| Sandia Crest, New Mexico | Sandia Crest Scenic Byway (NM 536), Sandia Park → Sandia Crest, 21 km, 2,100 m to 3,240 m (USGS 3DEP 1 m) | `?site=abq` |
| L'Alpe d'Huez, France | D 211, Bourg-d'Oisans → L'Alpe d'Huez, 14 km, 21 hairpins, 720 m to 1,850 m, with snow on the high ground (IGN RGE ALTI) | `?site=ah` |

More are listed in [TODO.md](TODO.md).

## Running it
All from `web/`: `npm install`, then `npm run dev` (Vite; `predev` runs `tools/build_music.py`, a no-op while there are no songs) or `npm run build` →
`web/dist/`, `npm run preview -- --port 4173` to serve the build.

## GitHub Pages
`.github/workflows/pages.yml` builds `web/` and publishes `web/dist/` to GitHub Pages on every push to `main` (or by hand from the Actions tab).
One-off setup in the repo: Settings → Pages → Source: *GitHub Actions*. The build uses relative paths, so it works from `https://<user>.github.io/<repo>/`
and the `?site=` links work as they do locally.

## The fly-by
It's the default page. **Esc** (or the ☰ button, or pad START) opens the options menu: place, time of day, weather, car,
starting direction, tilt-shift, shadows, pace, text overlay, frame rate, and credits. Pace, engine and music volume, text and frame rate apply live; the
rest rebuild the scene (no page reload: the old scene and its GPU memory are freed and the new place, car and weather are built, and the music carries on). *Song* picks a track from `music/playlist.json`. Choices are remembered
in `localStorage`. Keys: **Space** pause, **[ ]** pace, **H** hide text, **R** restart (pad: A, L1/R1, Y).

The URL overrides the saved options (so test links stay exact). Flags are on when present and not `0`/`false`/`off`/`no`/`none`.

| Param | Effect |
|-------|--------|
| `site=<name>` | which place (a folder in `web/public/track/`); default Rio; `site=harasu` (or empty) = Route 33, Mt. Haruna. The menu's list is `PLACES` in `course/options.js` |
| `car=<id>` / `car=none` | the car to chase (default `rx7`; any id in `cars.json`); `none` = the drone just flies the road. Each car's tuning is in `course/drivers.js` |
| `tiltshift=0\|1\|2` | miniature look: off / 1 estimated (blur by screen height) / 2 depth map (default): a 30° lens, blur away from the car, which it keeps centred |
| `uphill=0` | start at the top and descend (default is uphill) |
| `engine=<0..1>`, `music=<0..1>` | volume (both off by default; a bare `engine` or `music` = full, `0` = off; the menu has a slider for each) |
| `cycle=0` | auto-cycle is on by default: after a full up-and-down run the next place loads (the menu's list order, wrapping). `cycle=0` stays put; `?s=` links never cycle |
| `day` | daylight (default is night) |
| `weather=clear\|wet\|rain\|fog\|wetfog` | weather |
| `shadows=0\|1\|2` | moon shadows off / low / high (default 2) |
| `s=<metres>`, `speed=<m/s>`, `still`, `fps`, `menu` | start point, drone speed (no car), freeze (screenshots), frame-rate counter, open the menu |

The title card and HUD take their text from the site's `course.json` (`title`, `startName`).

## Making a new place
Each place is a folder `web/public/track/<site>/` holding `course.json` (road centreline, guardrail flags, terrain
header, title, tree and ground settings), `terrain.bin` (height grid), `roads.json` (every other road) and
`buildings.json`. The pipeline, all in `tools/`, is the same for every place:

1. **Road.** Download the area's roads from Overpass (`out body geom`, which keeps node ids) into `data/raw/<site>_route_osm.json`, then
   `python3 tools/stitch_hk_route.py --names "<road name>" [--exclude ...] --start LAT LON --end LAT LON --raw ... --out data/<site>_route.json`.
   It builds a directed graph over OSM node ids, so one-way carriageways and junction tangles are handled and the
   result is one ordered polyline.
2. **Terrain.** Get the best DEM you can (the coarser, the blockier; 30 m is too coarse). A fetcher writes
   `assets/<site>/<dem>.npy` + `.json` (grid CRS, corner, spacing, credit): `tools/fetch_rio_dem.py` (ArcGIS identify, 5 m) or
   `tools/fetch_hk_dem.py` (GeoTIFF tiles, 0.5 m, **resumable**: tiles download to `.part` and are renamed when complete, so a crash costs one tile) or
   `tools/fetch_3dep_dem.py` (USGS 3DEP 1 m LiDAR for the US: reads only the 256 px blocks around the route out of the 70-370 MB tiles by HTTP range requests; resumable; needs `tifffile` and `imagecodecs`, e.g. `pip install --target <dir> imagecodecs` and `PYTHONPATH=<dir>`).
   `tools/fetch_tinitaly_dem.py` (Italy, 10 m: cuts a window out of a hand-downloaded TINITALY tile; needs `tifffile`).
   Any new fetcher that downloads should be resumable the same way. `tools/dem.py` reads them: a new CRS is one `lonlat → (x, y)` function in `dem.CRS`.
3. **Course.** Add the site to `SITES` in `tools/build_site.py`, then `python3 tools/build_site.py <site>`. It samples the DEM along the
   road, smooths it, carves the terrain around it, marks guardrails on the valley side and writes `course.json` + `terrain.bin`.
   Per-site knobs: `title`, `start_name`, `crest` (start at the road's highest point), `crest_extra` (metres of road kept past it), `cell`, `dem_smooth` (hides LiDAR terraces),
   `forest` (tree counts and foliage hue, palms, `roadsideBroadleaf` = the dense verge trees (default 9000), `wideBias`, `sparse` = `{below, palmRoad}` clears low ground of trees except palms by the road), `sea` (sea level in metres: a water sheet), `ground` (scrub / rock tints), `credits`.
4. **Roads and buildings.** `python3 tools/build_roads.py --site <site> && python3 tools/build_buildings.py --site <site> [--flat]`.
   `--flat` gives flat roofs (favelas, Hong Kong towers). `build_roads.py --paths` (with `--fetch` the first time) also draws footpaths, steps, pedestrian streets and cycleways as thin lines (Rio uses it); they don't push buildings aside. Per-site wall and roof colours are in `PALETTES` in `build_buildings.py`.
5. **Look at it**, then add the data credits to `CREDITS.md` (it is rendered in-game on the credits card).

**Bridges.** The stitcher records OSM `bridge=*` spans in the route (`bridges`). `build_site.py` runs a bridge's deck level between its ends
(bare-earth LiDAR has the valley floor under it, not the deck), leaves the terrain below it uncarved, and writes the spans to `course.json` (`bridges`, in metres of `s`); `buildBridges` in `structures.js` puts a slab, an arch and columns under each span (cast shadows). Tunnels (`tunnels` in the route, OSM `tunnel=*`) are the reverse: the road runs level between the portals under the hill, the terrain above is kept (at least a 6 m roof), there is no guardrail, `buildTunnels` (structures.js) adds a dark arch tube and a concrete frame at each end, and the terrain material discards the arch-shaped volume at each portal (`tunnelPortals` / `cutPortals`; the 6 m heightfield can only make a ramp over the road, so the opening is cut in the shader), and `check_terrain.py` skips them (+8 m at each portal). Routes without those fields (Rio, Hong Kong) are unaffected.

Big Sur's route is stored north to south so that the default (uphill) drive heads north with the sea on the left; `stitch_hk_route.py --names "" --label "..."` keeps every way in a CA 1 query.

Sandia's route is stored crest to NM 14 (the default drive climbs to the crest). Its LiDAR project is published as 1.5 km "original resolution" tiles only over the crest, so it was fetched with `fetch_3dep_dem.py --epsg 26913 --opr --project NM_North_Central_FEMA` (the newest project over the area, Santa Fe County's, only clips a corner). OSM has just ~120 buildings along it.
Alpe d'Huez's route is stored valley to resort (the default drive climbs the hairpins). Its LiDAR is terraced and the hairpins stack, so `build_site.py` smooths the road height hard (`y_smooth=60`; 15 gave a 43% grade, the real road peaks near 13%). Snow is the `ground.snow` block (`above`, `band`, `flat`, `color`), painted by `buildTerrain` above a ragged line and mostly shed by steep rock.

Amalfi's route is stored west to east (Positano first) so that the default drive heads west with the sea on the left and ends in Positano.

Rio's route is stitched, then extended by `tools/extend_rio_route.py` (an imaginary link from Gávea onto Rua Henrique Midosi, then Av. Mendes de Morais along the beach).

Route 33 (Japan) predates this and uses `build_route.py` → `build_track.py` (GSI tiles) instead of steps 1 to 3.

Checks worth running on a new road: `build_site.py` prints length, grade, tightest radius and any terrain outside the DEM, and
`python3 -I tools/check_terrain.py [site ...]` fails (exit 1) if terrain rises through any road, listing where (rerun it after every `build_site.py`).
Where hairpin legs run close at different heights, terrain can poke through the lower road; `build_site.py` caps grid
nodes near the road to prevent it. Check by eye at the tightest bends.

## Cars
`tools/build_car.py` converts Sketchfab downloads in `assets/<folder>/` → `web/public/models/<id>.glb` + `cars.json`.
Cars: `ae86`, `r32`, `gtr`, `supra`, `celica6`, `celica7`, and the RX-7 FC (from `assets/rx7fc-ivofficial/`).
GLB conventions: metres, Y up, facing -Z, origin on the ground between the axles; nodes `body`,
`wheel_FL/FR/RL/RR`, and `popups` on the AE86 and RX-7. `?garage` views every car (**←/→** to switch).

## Sound
The soundtrack is "Maximum Overdrive", "Retroracing Nightlife" and "A Distant Sunrise" by Bogart VGM (CC-BY 3.0 and 4.0). Engines and effects are synthesized live in `web/src/audio/`; the fly-by hears the chased car's engine from the drone
(`course/audio.js`, positional with Doppler) and plays the music. Both are off by default and start on the first click or key
(browser autoplay rules). `?audiotest` checks the engine voice. When songs come back: originals and `tracks.json` go in `assets/songs/`,
and `tools/build_music.py` (run before dev/build; a no-op without `tracks.json`) re-encodes them into `web/public/music/`
(generated) and **fails the build if a track isn't credited in `CREDITS.md`**. The `Music` class in `audio/sound.js` plays that playlist.

## Inherited from the game
Still in the tree: the garage (`?garage`), the audio engine (`web/src/audio/`), the car rig and drift choreography
(`game/car.js`, `course/drift.js`). The race, rivals, director, HUD/menus, route map, demo and the music were removed. The Android
app and the itch.io upload script were left behind on purpose.

## Headless screenshots
Virtual time is fine without audio:

    google-chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader --mute-audio \
      --virtual-time-budget=60000 --window-size=1000,560 --screenshot=out.png \
      "http://localhost:4173/?site=hk&day&still&s=2500"

Anything involving audio or real timers: `node tools/cdp-eval.mjs <url> <secs> "<js expr>"`.
