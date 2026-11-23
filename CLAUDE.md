# Vital Ground — project brief for Claude Code

*Renamed from "Ground Truth" (PO, 15 Nov 2026). Repository: github.com/slipperyeel-svg/Vital-Ground; live at https://slipperyeel-svg.github.io/Vital-Ground/ . Internal storage keys keep the old name.*

Phone app that sets a short, Moltke-style tactical problem on the ground where the user is standing. The user walks to the positions they choose, answers, and gets directing-staff (DS) feedback based on computed terrain facts.

- **Primary users:** Army officers (2Lt–Maj) doing self-study, staff rides and TEWTs. **Secondary users:** serious military history and wargaming enthusiasts.
- **Product owner (PO):** a serving Royal Artillery officer. He judges whether a problem is tactically sound. He is not a developer: explain technical choices in plain English, and ask him before making product or tactical decisions.
- The original brief is in `docs/ORIGINAL_BRIEF.txt`. This file supersedes it where they differ.

---

## 1. Core principles (do not break these)

1. **Terrain facts are computed, never guessed.** Viewsheds, dead ground, slope and distances come from elevation data and geometry. An LLM may later write prose and critique answers, using only the computed facts it is given. It never decides what can be seen from where.
2. **Every problem has a real dilemma.** A problem with one obvious answer is a failure. The quality gate must reject it before the user sees it.
3. **Be honest about data resolution.** Show the data source and resolution on every problem, and pick an echelon the data can support. The default data (about 30 m) does not show hedges, walls, sunken lanes or small folds.
4. **~~Never send people onto private land or into danger.~~** *PO, 14–15 Nov 2026: he trusts users; stands are no longer restricted to public paths and exclusions are not enforced. Stands still never go in water or inside buildings, and every problem says to check access on the ground. DECISIONS.md 52, 76.*
5. **British military terminology and British English** (dead ground, OP, gun area, grid reference, reverse slope, NAI, battery, manoeuvre).

---

## 2. Status (14 Nov 2026)

| Milestone | State |
|---|---|
| **M1 – Terrain engine** | Done. Unit tests pass, including against real Terrarium tiles (`NETWORK=1`), 14 Nov 2026. |
| **M2 – Map view** | Done, with OS base maps. Live at https://slipperyeel-svg.github.io/Vital-Ground/ ; real OS Explorer tiles and elevation loaded there on 14 Nov 2026. Default base map is now the OS open map (natively Web Mercator, no warp). The Explorer grid-alignment check only matters if Explorer is used (optional, premium); not a priority (PO, 15 Nov 2026). |
| **M3 – Template A (OP and gun area) + quality gate** | Built, with map features from OSM, enemy approach/NAI and enemy OPs (`src/features/`, `src/tactics/`). Tested on real elevation. OSM features load and display correctly on the PO's device (Larkhill/Amesbury, 14 Nov 2026); Overpass is still unreachable from the cloud workspace. Problems resumed 15 Nov 2026: "Set a problem here" at a selected point; access gate dropped, obstacles used (DECISIONS.md 75–80). Awaiting PO testing on three pieces of ground, and PO answers in DECISIONS.md 46–50. |
| **Enemy layouts (platoon level, PO direction 15 Nov 2026)** | Section defence placement built (prepared/hasty), with scenario text and DS reveal (`src/tactics/sectionDefence.ts`, `sectionScenario.ts`; DECISIONS.md 97–104). PO answered: flank or rear fire preferred; reverse slopes good, with an outpost forward (DECISIONS.md 105–108). Awaiting PO judgement on real ground and the scoring weights. Enemy company generator built (DECISIONS.md 116–123). **"Set a problem here" now sets the infantry platoon scenario** (`platoonScenario.ts`, G1–G13, four task types, information levels, phase 2, covered-route DS and gate; DECISIONS.md 126–131); the artillery problem is no longer offered. **The situation is drawn in NATO APP-6 symbols** (friendly blue with axes and task graphic; enemy dashed red when only reported, full red layout in the ground-truth reveal; DECISIONS.md 133–140). **No school solution** (PO): "Reveal the ground truth" replaces "DS solution"; the best covered route is used only by the gate, never shown (DECISIONS.md 149–150). **Friendly 2-up situation** (BG and company mission, intent, scheme, flanks; boundary, start line, BG objective on the map; phase line removed, DECISIONS.md 205) and the **8 km box at 5 m** (DECISIONS.md 141–145). **Plan capture built** (route and positions by tap or GPS, answers, facts about the plan with the ground truth, saved on the phone with resume, text export; DECISIONS.md 153–157). **The situation develops from the marked route** (2 km/h, first one or two real events; route required; DECISIONS.md 158–159). Four routes (each section and Pl HQ) and positions as APP-6 graphics (SBF, ABF, FUP, ASLT PSN, block, OP, RV); DECISIONS.md 160–162. **Interface in modes chosen from a menu (top left): Problem (five stages), DS, Developer (`?dev=1`), Settings**; DECISIONS.md 167–171. Engine work paused while the interface is ordered (PO). **Enemy company: seven layouts chosen by the ground, DS can force one** (DECISIONS.md 197–200); spacing varies, favouring wide (201–202). **Your boundaries take in all, most or only part of the enemy you are tasked against** (DS can choose; DECISIONS.md 203). Boundaries between every unit detailed, including the far-flank battlegroup boundary (DECISIONS.md 206). Next on the PO's list: the user's own defensive problems (Template B). The LLM critique of reasoning is shelved: no paid features (PO, DECISIONS.md 192). Earlier direction (PO, 15 Nov 2026): scenario text and tasks around the enemy company (Russian doctrine + Ukraine lessons, optional mines/dummies/dispersal/drone concealment/ISR and fires), **intent-based platoon tasks**, Moltke-style **phases**, then the user's plan and DS feedback. Design basis: Moltke, Rommel, Lind. See DECISIONS.md 109–115, and **`docs/SCENARIO_GUIDELINES.md` (G1–G13, from Moltke's 66 problems): follow it for every scenario.** |
| M4 – Templates B and C, ground classification choosing between them, access-safe stands from OSM paths | Not started. |
| M5 – DS feedback, answer capture, then LLM prose and critique from computed facts only | Not started. |
| M6 – AR prototype (React Native/Expo, native) | Not started. Do not begin until Phase 1 is complete. |

### First job in a new session: verify against real data

The earlier work was done without internet access to the data servers. Before anything else:

1. **Check network access** to `s3.amazonaws.com`, `api.os.uk` and `tile.openstreetmap.org` (e.g. `curl -I` each). If any is blocked, tell the PO which; it is set in the cloud environment's network settings.
2. `npm install`, then `npm test`, `npm run typecheck`, and `NETWORK=1 npm test` (loads real Terrarium tiles for Salisbury Plain).
3. Load real ground with `npm run build && npx vite preview`, then open `?lat=51.2&lon=-1.85&autoload=1`. If Chrome is available, take headless screenshots (see section 6) and check:
   - Terrarium tiles decode to plausible heights (Salisbury Plain about 100–200 m).
   - **OS Explorer alignment** (only if Explorer is in use; it is no longer the default): the app's blue 1 km grid lines should sit on the OS map's own grid lines. This tests the BNG→Web Mercator warp in `src/geo/osTiles.ts`.
   - OS Outdoor and OpenStreetMap layers load; attribution shows.
   - CORS works for the Terrarium tiles from a browser (`fetch(..., {mode: 'cors'})` in `src/terrain/tiles-browser.ts`).
4. Fix anything found, then report to the PO in plain English.

---

## 3. How to run

```
npm install
npm run dev              # local dev server
npm run build            # installable app into dist/
npm test                 # unit tests (synthetic terrain, no network)
NETWORK=1 npm test       # also loads real AWS elevation tiles
RENDER=1 npm test        # draws docs/m1-*.png for a visual check
npm run typecheck
```

- **OS key:** set `VITE_OS_KEY` as an environment variable, or in `.env.local` (git-ignored). Never commit the key. Without it the app uses OpenStreetMap only.
- **Developer page:** open the app with `?dev=1` (remembered on that device) to see the Developer tab (ground detail, viewshed, features, enemy company and section tools).
- **Demo ground for indoor testing:** `?demo=ridge` (or `cone`, `valley`, `flat`). Other URL options: `?lat=..&lon=..` to choose the place, `&autoload=1` to load straight away, `&vs=x,y` to draw a viewshed from local metres x,y.
- **Real-ground check of the tactics:** `NETWORK=1 npm test`; add `LAT=.. LON=..` to choose the place and `RENDER=out` to draw `out-N.png` etc.
- **Network:** the environment also allows `overpass-api.de` (features), `environment.data.gov.uk` (LIDAR) and the live site, but Overpass drops connections from the cloud workspace (DECISIONS.md 44).
- **Hosting:** phones only allow location on https sites. `.github/workflows/pages.yml` builds, tests and deploys to GitHub Pages on every push to `main` (Repository Settings → Pages → Source: GitHub Actions). The workflow passes the OS key to the build from a repository secret named `VITE_OS_KEY`; the PO needs to create it (Settings → Secrets and variables → Actions).
- Claude.ai artifacts **cannot** host this app: they block location, outside servers and service workers.

---

## 4. Architecture (as built)

Vite + TypeScript, no UI framework. MapLibre GL JS for the map, proj4 for grid references. All terrain analysis runs in a Web Worker on `Float32Array` grids. The engine in `src/terrain/` is pure and framework-free, so it can later run in a native app or on a server.

**Conventions:** a local metric grid centred on the box. x is east and y is north, in metres; row 0 is the north edge. Bearings are degrees clockwise from grid north. True north is up (a local tangent-plane projection).

| Path | What it is |
|---|---|
| `src/terrain/grid.ts` | Grid type, coordinates, bilinear sampling |
| `src/terrain/slope.ts` | Slope, aspect, hillshade (Horn's method) |
| `src/terrain/tpi.ts` | Topographic position index (summed-area table); landform classes |
| `src/terrain/viewshed.ts` | Radial-sweep viewshed, line of sight, union viewshed, dead ground, exposure, coverage; optional obstacles (woods, buildings, hedges) |
| `src/terrain/crest.ts` | Topographical and military crests relative to the enemy; `isSilhouetted` |
| `src/terrain/classify.ts` | flat / rolling / ridge / valley, with plain-English reasons |
| `src/terrain/contours.ts` | Marching-squares contours |
| `src/terrain/lidar.ts` | Environment Agency LIDAR (bare ground + surface) for a box, sampled onto the local grid |
| `src/terrain/tiff.ts` | Small reader for float32 GeoTIFFs |
| `src/terrain/elevation.ts` | Terrarium tile loader (injected `TileSource`); OS Terrain 50 ASCII grid parser |
| `src/terrain/tiles-browser.ts` | Browser tile fetch and decode |
| `src/terrain/analyse.ts` | Runs the whole analysis on a box (placeholder enemy observers) |
| `src/terrain/synthetic.ts` | Test terrains: cone, straight ridge, rounded ridge, V valley, flat, rolling |
| `src/geo/gridref.ts` | BNG six- and eight-figure references (truncated, not rounded); MGRS outside GB |
| `src/geo/gridlines.ts` | 1 km BNG/UTM grid lines |
| `src/geo/osTiles.ts` | Warps OS British National Grid tiles into Web Mercator tiles |
| `src/worker/` | Worker protocol; keeps the loaded grid; answers viewshed requests |
| `src/app/engine.ts` | Promise wrapper around the worker |
| `src/app/overlays.ts` | Hillshade, viewshed, contour and box layers |
| `src/app/basemaps.ts` | OS Explorer, OS Outdoor and OpenStreetMap; registers the `os27700://` protocol |
| `src/features/osm.ts` | Overpass query; OSM tags → feature kinds; parse to local metres |
| `src/features/layers.ts` | Features → grid layers: land cover, routes, going, exclusions, stand-allowed cells |
| `src/features/mvt.ts` | Small reader for vector tiles (no dependency) |
| `src/features/osVector.ts` | OS open-data features from the Vector Tile API; combining with OSM paths and hedges |
| `src/features/obstacles.ts` | Woods (15 m, see 15 m in), buildings (8 m), hedges (2 m) as obstacles to sight |
| `src/features/render.ts` | Draws the captured features as a see-through map picture ("Show features") |
| `src/tactics/approach.ts` | Least-cost enemy approach, corridor, NAI and what channels it |
| `src/tactics/enemyOps.ts` | Likely enemy OPs: best viewpoints on the enemy side |
| `src/tactics/templateA.ts` | Template A: OP candidates, gun areas, line of communication, dilemma test, quality gate |
| `src/tactics/sectionDefence.ts` | Enemy section defence: route from the start, candidate scoring, direction choice, fire-team layout, kill zone and dead ground |
| `src/tactics/sectionScenario.ts` | Section scenario text for each intelligence level, and DS notes |
| `src/tactics/companyDefence.ts` | Enemy company: routes, defensibility; **seven layouts chosen by the ground** (two up one back, one up two back, three up, all-round strongpoint, forward screen, counter-attack force in BMPs, echeloned along the route; DECISIONS.md 197–200); sections/teams, outposts, HQ, gaps; optional mines, dummies, dispersal, drone concealment, ISR/fires |
| `src/tactics/platoonScenario.ts` | Infantry platoon scenario (G1–G13): task, information with sources, light, ground facts, questions, phase 2, DS routes and gate |
| `src/tactics/sun.ts` | Sunrise, sunset, first and last light |
| `src/tactics/planFacts.ts` | Computed facts about the user's plan against the real enemy (fire, mines, who sees what); no verdict |
| `src/tactics/planEvents.ts` | "The situation develops" worked out along the user's marked route: first fire, mines, drones/artillery, or the enemy reacting; reports from the user's OP/fire support position |
| `src/app/plan.ts` | The user's plan: route, positions, answers; saving, resume key and text export |
| `src/app/symbols.ts` | NATO APP-6 unit symbols (milsymbol) as map images: infantry, mechanised infantry (Boxer, cross with armour oval), motorised infantry, armour, recce (plain, motorised, armoured); mine symbols |
| `src/app/graphics.ts` | Tactical graphics: axes of advance, objective, task graphics, minefields, control lines; planned positions (SBF, ABF, FUP/assault areas, block) |
| `src/tactics/problem.ts` | Tries each enemy direction, ranks passes, writes the problem and DS notes |
| `src/main.ts`, `index.html`, `src/style.css` | The map screen (phone-first, high contrast). **Three modes** (DECISIONS.md 167–170): **Problem** (five stages: Start, Read, Plan, Develops, Truth), **DS** (full picture for the problem on this phone), **Developer** (engine tools; only with `?dev=1`). Elements are tagged `data-modes`. |
| `public/sw.js`, `public/manifest.webmanifest` | Offline cache and installable-app manifest |
| `DECISIONS.md` | Every significant choice so far, with reasons. **Read it before changing behaviour.** |

The standard box is 8 km at 5 m (DECISIONS.md 144); tactics are analysed at 10 m. The analysis of a 4 km box at 10 m cells takes about 0.2 s on a desktop-class CPU, inside the 5-second phone target with room to spare.

---

## 5. Data sources

| Data | Source | Notes |
|---|---|---|
| Elevation (default, global) | AWS Terrain Tiles, Terrarium PNG, zoom 13 | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. Decode: `(R*256 + G + B/256) - 32768`. In GB this is mostly **EU-DEM (~30 m, a surface model)**: woods and towns may read as raised ground. Reported resolution is never finer than 30 m. |
| Elevation (GB, fallback) | OS Terrain 50 (ASCII grid) | Parser done; wiring a GPS position to it needs BNG conversion (available in `gridref.ts`). |
| Elevation (England, fine) | **Environment Agency LIDAR**, DTM + first-return DSM, via WCS at `environment.data.gov.uk` | **Default and problems: 8 km box at 5 m** (fetched in four 4 km pieces, about 34 MB; DECISIONS.md 144). Fine = 2 km at 2 m. `src/terrain/lidar.ts`, `src/terrain/tiff.ts`. DSM − DTM = measured obstacle heights. Server sometimes hangs: 15 s timeout, 3 tries. DECISIONS.md 86–96. |
| Base map, GB (default) | **OS open map**: OS Vector Tile API, OS's own style, tiles capped at zoom 15 | OS OpenData: free and unlimited. Never request vector tiles above zoom 15 (premium MasterMap). |
| Base map, GB (optional) | OS Maps API: `Leisure_27700` (1:25k, premium, warped in-app) and `Outdoor_3857` | Premium beyond the free £1,000/month: not sustainable for public release (DECISIONS.md 56). |
| Base map, elsewhere | OpenStreetMap standard tiles | Fine for development only. **Needs a proper provider before wider release.** |
| Map label fonts | OpenFreeMap glyphs | |
| Woods, water, buildings, roads, railways (GB) | OS open data via the OS Vector Tile API, zoom 14 | Free. `src/features/osVector.ts`. |
| Paths, tracks, hedges (and everything outside GB) | OpenStreetMap via Overpass | Respect the usage policy; self-host before public release. |

**Attribution** must show as each licence requires (EU-DEM/Copernicus, Environment Agency, USGS, OS, OSM). The full Joerd attribution list (github.com/tilezen/joerd/blob/master/docs/attribution.md) has not yet been checked.

---

## 6. Testing notes

- Write tests alongside code. The terrain engine must stay fully unit-tested.
- Headless screenshots at phone size:
  `google-chrome --headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=390,844 --force-device-scale-factor=2 --virtual-time-budget=20000 --screenshot=out.png "http://localhost:4173/?demo=ridge&lat=51.2&lon=-1.85&vs=0,1500"`
- For browser console errors, add `--enable-logging=stderr --v=0 --dump-dom`.
- Lessons already learned:
  - MapLibre's worker file must be bundled and set with `setWorkerUrl`, or the built map is blank.
  - Placeholder images must be truly transparent.
  - `fitBounds` should use `animate: false`.

---

## 7. Decisions waiting for the PO

Items 1, 2, 4 and 6 were answered on 14 Nov 2026 (see DECISIONS.md 33–36): crest definition and 10 m kept; NAI on the best mobility corridor; enemy OPs at the best viewpoints on the enemy side. Still open: 3 and 5.

1. **Military crest definition.** Currently: the highest point on the forward slope from which a man (eye at 2 m) sees the ground itself all the way to the foot of the slope.
2. **Smallest crest.** The ground must fall at least 10 m towards the enemy. Is that right for 30 m data?
3. **Skylining with only a threat direction.** A notional enemy observer is placed 1,500 m away on that bearing.
4. **How to choose likely enemy OP positions** for Template A. Currently a placeholder line of seven observers 300 m in from the enemy edge. **This blocks M3.**
5. **OS terms:** whether OS tiles may be cached offline (currently *not* cached), and whether the OS logo is required on the map.
6. Before M3, also ask how the NAI should be placed (the brief says: on the enemy approach, from the side of the box with the lowest ground).

---

## 8. Remaining milestones (from the brief)

**M3 – Template A: OP and gun area (artillery). Build this first.**
- **Applies to:** rolling, ridge or valley ground with relief of 20 m or more.
- **Enemy approach:** by default, from the side of the box with the lowest ground.
- **Compute:**
  - an NAI on the enemy approach;
  - candidate OPs in the forward friendly area, scored by the share of the NAI each can see;
  - each OP's exposure (how many likely enemy positions can see it) and whether it is silhouetted;
  - covered gun areas: out of enemy view, slope under about 6°, big enough for a battery.
- **Dilemma test:** the OP with the best view is exposed or skylined, and a second OP at least 300 m away sees at least 60% as much with less exposure. Or: the best covered gun area forces a long, exposed line of communication to the OP.
- **Requirement:** site the OP (walk to it), site the gun area, state what the enemy can see of you, give outline orders. Write it in the classic format: General Situation, Special Situation, Requirement, Time allowed.
- **Acceptance:** the PO tests it on at least three pieces of ground he knows well.

**Quality gate (run before showing any problem).** Reject and retry (move the box, change template, change enemy direction) unless all of these hold:
- at least two viable courses of action exist, with a measurable trade-off;
- the template's dilemma test passes;
- ~~every stand is within a 3 km round trip of the start~~ (PO, 15 Nov 2026: no walking limit; the ground decides where the enemy is, DECISIONS.md 146–147; public-path and exclusion rules already dropped, DECISIONS.md 76);
- the echelon fits the data resolution.

If nothing passes, fall back to Template C, or tell the user plainly why this ground offers no good problem.

**M4 – Templates B and C, ground classification choosing between them, and access-safe stand placement using OSM paths.**
- **B: forward or reverse slope.** For ridges, or any ground with a clear crest across the enemy approach. Compare the field of fire (within about 1,500 m) with exposure. Requirement: a company group defensive position.
- **C: screen on open ground.** For flat ground. Compare coverage from 2 m and 5 m observer height, and choose the best pair of OPs for a 3 km frontage. Requirement: two OPs; identify the gaps.

**M5 – DS feedback and answer capture.**
- **User flow:** walk to the positions and mark them, type answers, then reveal overlays and computed facts per candidate. Save or export.
- **Then:** LLM-written prose and a short critique of the user's reasoning, decision and orders (Claude), using only the computed facts. **No model answer** (PO, DECISIONS.md 149–150).

**M6 – AR prototype (native, later).** Enemy icons, NAI and dead-ground shading on the camera.

---

## 9. Working style

- Work milestone by milestone. At the end of each, summarise in plain English what was built and what the PO should test.
- Keep `DECISIONS.md` up to date for every significant technical choice.
- **Ask the PO** before any choice that affects tactics or teaching (observer heights, NAI placement, thresholds), and before adding any dependency. Current runtime dependencies: `maplibre-gl`, `proj4`, `milsymbol` (APP-6 symbols, DECISIONS.md 133). Dev only: `vite`, `vitest`, `typescript`, `pngjs`.
- Prefer simple, readable code over clever code. The PO may read it.
- Do not commit the OS key or any other secret. Do not commit or push unless asked.
