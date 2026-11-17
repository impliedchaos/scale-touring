# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Touring": pretty fly-overs of real mountain roads with every building around them, in a tilt-shift scale-model
look. A drone flies over, a car drifts down the road. **Not a joke or a game**: a sincere, pretty toy.
It was forked from `../ghost-of-mount-akina/` (a comedic touge game, which keeps its own repo, itch.io page and
Android app). Fixes to shared code (`world.js`, `track.js`, `flyby.js`, audio, car rig) may be worth porting between the two by hand.
README.md has the user-facing docs and the per-site pipeline; TODO.md has the list of places to add.

## Rules that aren't visible in the code

- **Credit everything, CC0 included.** `CREDITS.md` is the single source; it is rendered in-game
  (`web/src/game/credits.js` imports it `?raw`). `tools/build_music.py` fails the build if a track title isn't in it (there are no songs right now).
  Every new place needs its terrain source and OSM (ODbL) added.
- **Check a data source's licence before using it** and record it in the fetcher's docstring and `CREDITS.md`.
- `assets/fc/` (RX-7 FC) is **CC-BY-ND** and was deliberately not copied here. Never convert or ship it.
  The RX-7 used is `assets/rx7fc-ivofficial/` (CC-BY 3.0, fine).
- Original characters only; no manga characters, team names, shop decals or soundtrack.
- **Don't deploy anywhere** unless asked in that moment. There is no itch.io or Android tooling in this repo
  (left behind on purpose, so nothing here can push to the game's page).
- Downloaders must be resumable: write to `.part` and rename when complete, so a crash doesn't lose finished work.
- Dave views changes on his own dev server (`:5174`); a preview on `:4173` is just for tests.
- Per-place content goes in `SITES` in `tools/build_site.py` (title, forest, ground, credits), not in selection logic in the web code.

## Commands

All from `web/`:

- `npm run dev`: Vite dev server (`predev` runs `tools/build_music.py`, a no-op while there are no songs). `npm run build`: `web/dist/`.
  `npm run preview -- --port 4173` serves it. Stop it with `pkill -f "vite previe[w]"` (the bracket keeps pkill from matching its own shell).
- There is no test suite or linter. Verify by eye: build, then screenshot headless:
  `google-chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader --mute-audio --virtual-time-budget=60000 --window-size=1000,560 --screenshot=out.png "http://localhost:4173/?site=hk&day&still&s=2500"`
- `?still` freezes (for screenshots), `?s=<metres>` picks the position, `?fps` shows a frame counter.
  Anything involving audio or real timers: `node tools/cdp-eval.mjs <url> <secs> "<js expr>"` (`CDP_NO_AUTOPLAY=1` simulates autoplay blocked).

Data pipeline (Python 3 + numpy/scipy/Pillow; outputs are committed to `web/public/track/<site>/`, so rerun only when inputs change).
Run Python on downloaded data with `-I`. For a place: `tools/stitch_hk_route.py` → `tools/build_site.py <site>` → `tools/build_roads.py --site <site>` →
`tools/build_buildings.py --site <site> [--flat]`. Route 33 (Japan): `build_route.py` → `build_track.py` → `build_roads.py` → `build_buildings.py`.
The README walks through it.

## Architecture

`web/src/main.js` routes by query string: the default is the fly-by (`course/flyby.js`; the product), plus the dev tools `?garage` and
`?audiotest`. No racing: the car drives itself (`course/showcase.js` `BootlegCar`, tuning per car in `course/drivers.js`).

**Options.** `course/options.js` merges defaults ← `localStorage` ← URL params (URL wins). `course/menu.js` is the Esc menu: LIVE options
(pace, engine, music, text, fps) apply at once, WORLD options (place, time, weather, car, direction, tilt-shift, shadows) are staged and *Apply* reloads
the page. A new option = a default in `DEFAULTS`, a parse line in `loadOptions`, and a row in `flyby.js`. A new place = a folder in
`web/public/track/` **and** an entry in `PLACES` (options.js).

**Look.** Synthwave palette and the thin wide-tracked type are CSS variables at the top of `web/index.html`; the night sky is indigo in `world.js`.

**Sites.** `createWorld({ site })` in `game/world.js` loads `track/<site>/` (none = Japan's `track/`). A site's `course.json`
may carry `title` / `startName` (fly-by title card and HUD), `forest` (overrides `buildForest` options: tree counts,
`wideBroadleaf`, `palms`, `foliage`), `ground` (scrub / rock tints read by `buildTerrain`) and `origin_lat` (the latitude the
metre scale is taken at, which `build_roads.py` and `build_buildings.py` use for `--site`; Japan's comes from `route33.json`).
Missing blocks fall back to Japan's look, so adding a field must not change Route 33's output.

**Frame.** Metres, x east, z south, y elevation; origin at the start line. `TrackPath.sample(s, lateral)` maps arc length `s`
along the road to pos / forward / right / curvature. Everything positions itself in `(s, lateral)` road coordinates.

**Terrain data (`tools/dem.py`).** DEM-agnostic loader: `load(base)` reads `<base>.npy` + `.json` (grid CRS, corner, spacing),
`elev(lat, lon)` is bilinear. Supported CRS: EPSG:31983 (Rio), EPSG:26910 (Big Sur, plain UTM 10N with no datum shift, so ~1-2 m off WGS84) and EPSG:2326 (Hong Kong, via a 7-parameter Helmert shift validated to 1 mm
against the HK Geodetic Survey's service; don't change the signs without redoing that check). Add one by registering a `lonlat → (x, y)` function in `CRS`.

**`tools/check_terrain.py`.** Run after any `build_site.py`: exits 1 and lists the `s` ranges where terrain pokes through the road (all sites by default). Fix them in `build_site.py`, not by tolerating them.

**`tools/build_site.py`.** Samples DEM heights on the road, smooths them, carves the terrain around the road (flat to `flat_r`, blending to the
raw ground by `blend_r`), caps grid nodes near the road so hairpin legs at different heights don't poke through the lower one, marks guardrails
on the valley side. Always fills DEM nodata (sea would otherwise give NaN terrain heights). Bridges (`bridges` in the route JSON) are run level between their ends with the terrain under them left uncarved.

**Buildings (`tools/build_buildings.py`).** OSM footprints nudged off the road; heights from tags or guessed; walls and roofs from
`PALETTES[site]` (else Japan's), `--flat` for flat roofs. Rendered as one merged mesh with a window texture that lights at night.

**Fly-by look.** `course/flyby.js` (drone shots), `course/tiltshift.js` (lens and blur: by scene depth around the car at level 2, screen height at level 1), `game/beams.js` (fake volumetric headlight cones),
`game/taillights.js`, `game/weather.js`, `game/world.js` (moon shadows).

**Cars.** `tools/build_car.py` builds `web/public/models/<id>.glb` and `cars.json` from `assets/<folder>/`.

**Inherited.** The audio engine (`src/audio/`; the fly-by drives it from `course/audio.js` (the car is the positional "rival" voice; engine and music off by default); the `Music` class waits for songs), the car rig (`game/car.js`)
and the 86's drift choreography (`course/drift.js`), and `garage.js`. The game's race, rivals, director, HUD and map were removed.
See the game's CLAUDE.md for how the shared parts work.
