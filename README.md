# Touring

Pretty little drift tours: a drone flies over a real mountain road while a car drifts down it, with the real terrain
and every building from OpenStreetMap, in a tilt-shift "scale model" look. three.js, runs in the browser.

Forked from [Ghost of Mount Akina](../ghost-of-mount-akina/), a comedic touge game. That game keeps its own repo; this one
is only the fly-over. The race, rivals, story and soundtrack were removed; there is no manual driving, only the car
driving itself.

## Places
| Site | Road | URL |
|------|------|-----|
| Route 33 (Mt. Haruna, Japan) | Gunma Pref. Route 33, summit → Ikaho | (none) |
| Rio de Janeiro | Estrada da Gávea, through Rocinha | `?site=rio` |
| Hong Kong | Peak Road → Stubbs Road | `?site=hk` |

More are listed in [TODO.md](TODO.md).

## Running it
All from `web/`: `npm install`, then `npm run dev` (Vite; `predev` runs `tools/build_music.py`, a no-op while there are no songs) or `npm run build` →
`web/dist/`, `npm run preview -- --port 4173` to serve the build.

## The fly-by
It's the default page. **Esc** (or the ☰ button, or pad START) opens the options menu: place, time of day, weather, car,
starting direction, tilt-shift, shadows, pace, text overlay, frame rate, and credits. Pace, engine sound, music, text and frame rate apply live; the
rest rebuild the scene, so they're staged and an *Apply changes* row reloads the page with them. Choices are remembered
in `localStorage`. Keys: **Space** pause, **[ ]** pace, **H** hide text, **R** restart (pad: A, L1/R1, Y).

The URL overrides the saved options (so test links stay exact). Flags are on when present and not `0`/`false`/`off`/`no`/`none`.

| Param | Effect |
|-------|--------|
| `site=<name>` | which place (a folder in `web/public/track/`); none = Route 33. The menu's list is `PLACES` in `course/options.js` |
| `car=<id>` / `car=none` | the car to chase (default `ae86`; any id in `cars.json`); `none` = the drone just flies the road. Each car's tuning is in `course/drivers.js` |
| `tiltshift=0\|1\|2` | miniature look: off / 1 estimated (blur by screen height) / 2 depth map (default): a 30° lens, blur away from the car, which it keeps centred |
| `uphill=0` | start at the top and descend (default is uphill) |
| `engine`, `music` | sound on (both are off by default; the menu has rows for them) |
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
   `tools/fetch_hk_dem.py` (GeoTIFF tiles, 0.5 m, **resumable**: tiles download to `.part` and are renamed when complete, so a crash costs one tile).
   Any new fetcher should be resumable the same way. `tools/dem.py` reads them: a new CRS is one `lonlat → (x, y)` function in `dem.CRS`.
3. **Course.** Add the site to `SITES` in `tools/build_site.py`, then `python3 tools/build_site.py <site>`. It samples the DEM along the
   road, smooths it, carves the terrain around it, marks guardrails on the valley side and writes `course.json` + `terrain.bin`.
   Per-site knobs: `title`, `start_name`, `crest` (start at the road's highest point), `cell`, `dem_smooth` (hides LiDAR terraces),
   `forest` (tree counts and foliage hue, palms), `ground` (scrub / rock tints), `credits`.
4. **Roads and buildings.** `python3 tools/build_roads.py --site <site> && python3 tools/build_buildings.py --site <site> [--flat]`.
   `--flat` gives flat roofs (favelas, Hong Kong towers). Per-site wall and roof colours are in `PALETTES` in `build_buildings.py`.
5. **Look at it**, then add the data credits to `CREDITS.md` (it is rendered in-game on the credits card).

Route 33 (Japan) predates this and uses `build_route.py` → `build_track.py` (GSI tiles) instead of steps 1 to 3.

Checks worth running on a new road: `build_site.py` prints length, grade, tightest radius and any terrain outside the DEM.
Where hairpin legs run close at different heights, terrain can poke through the lower road; `build_site.py` caps grid
nodes near the road to prevent it. Check by eye at the tightest bends.

## Cars
`tools/build_car.py` converts Sketchfab downloads in `assets/<folder>/` → `web/public/models/<id>.glb` + `cars.json`.
Cars: `ae86`, `r32`, `gtr`, `supra`, `celica6`, `celica7`, and the RX-7 FC (from `assets/rx7fc-ivofficial/`).
GLB conventions: metres, Y up, facing -Z, origin on the ground between the axles; nodes `body`,
`wheel_FL/FR/RL/RR`, and `popups` on the AE86 and RX-7. `?garage` views every car (**←/→** to switch).

## Sound
There is no music at the moment. Engines and effects are synthesized live in `web/src/audio/`; the fly-by hears the chased car's engine from the drone
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
