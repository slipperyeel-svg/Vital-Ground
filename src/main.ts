/**
 * M2 map screen: load the ground around you (or the map centre), show
 * hillshade, contours and the grid, and draw a viewshed from any tapped point.
 *
 * Testing indoors: add ?demo=ridge (or cone, valley, flat) to the address to
 * use invented ground; ?lat=..&lon=.. to choose where; &autoload=1 to load
 * straight away; &vs=x,y to draw a viewshed from local metres x,y.
 */
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre's own background worker must be shipped as a separate file and
// pointed to explicitly, or the map draws nothing once built.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import { Engine } from './app/engine';
import {
  boxCorners,
  boxOutlineGeoJSON,
  contoursGeoJSON,
  dsGeoJSON,
  EMPTY,
  hillshadeImage,
  pointGeoJSON,
  problemGeoJSON,
  sectionGeoJSON,
  sectionZonesImage,
  companyGeoJSON,
  companyZonesImage,
  scenarioGeoJSON,
  toDataURL,
  viewshedImage,
  type BoxGeo,
} from './app/overlays';
import { gridRef, inGreatBritain, toBNG, toUTM } from './geo/gridref';
import { addMineImages, ensurePointMeasure, ensureSymbol, type Echelon } from './app/symbols';
import * as Plan from './app/plan';
import { problemOfTheDay, SITES, ukDay } from './app/sites';
import { areaPosition, attackByFire, blockGraphic, supportByFire } from './app/graphics';
import { areaOutline, controlLine, enemyAxis, minefield, objective as objectiveGraphic, roundArea } from './app/graphics';
import { addOsOpenMap, BASE_MAPS, baseMapSources, GLYPHS_URL, LABEL_FONT, OS_KEY, OS_OPEN_PREFIX, registerOsProtocol, SPRITE_URL, type BaseMapId } from './app/basemaps';
import { gridLines } from './geo/gridlines';
import { latLonToLocal, localToLatLon } from './terrain/elevation';
import { BOX_M } from './worker/protocol';
import type { CompanyView, ScenarioView, DemoTerrain, Detail, LoadedGround, ProblemView, SectionView } from './worker/protocol';
import type { CompanyOptions, LayoutType, SpreadName } from './tactics/companyDefence';
import type { InfoLevel, LaneMode, ProblemType, TaskType } from './tactics/platoonScenario';
import type { Intel, Posture } from './tactics/sectionDefence';

// ---------- state ----------
const params = new URLSearchParams(location.search);
const demo = (params.get('demo') as DemoTerrain | null) ?? undefined;
const engine = new Engine();
let ground: LoadedGround | null = null;
let box: BoxGeo | null = null;
let myFix: { lat: number; lon: number; accuracy: number } | null = null;
let lastObserver: { x: number; y: number } | null = null;
let watchId: number | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string) => {
  $('status').textContent = msg;
  // While the loading screen is up, show the real progress on it too.
  const step = document.getElementById('loading-step');
  if (step) step.textContent = msg;
};

// ---------- Loading screen while the ground loads and the problem is written (PO, 15 Nov 2026) ----------
const LOADING_LINES = [
  'Asking the platoon sergeant where the map went…',
  'Counting the contour lines twice…',
  'Persuading the enemy to sit on the reverse slope…',
  'Discovering the track on the map is now a field…',
  'Waiting for the brew to boil…',
  'Sharpening the chinagraph pencils…',
  'Checking the grid reference with three different people…',
  'Hiding the dummy trenches really quite well…',
  'Finding the one bit of dead ground nobody mentioned…',
  'Re-reading Moltke, again…',
  'Folding the map the wrong way…',
  'Debating forward versus reverse slope, again…',
  'Waiting for comms to come back up…',
  'Measuring the DS\'s "just over that rise"…',
  'Locating the CQMS and the hot food…',
  'Telling the mortar line to stand by…',
  'Confirming first light with someone who owns a watch…',
  'Rehearsing "any questions?" at the end of orders…',
  'Laying out the model pit with string and twigs…',
  'Working out which way is actually north…',
  'Warning the enemy that they will not read this…',
  'Reminding everyone the ground does not lie…',
];
let loadingDepth = 0;
let loadingHide: number | undefined;
let loadingTimer: number | undefined;
function showLoading(on: boolean) {
  const box = $('loading');
  if (on) {
    clearTimeout(loadingHide);
    if (!box.hidden) return;
    box.hidden = false;
    $('loading-step').textContent = $('status').textContent ?? '';
    const lines = [...LOADING_LINES].sort(() => Math.random() - 0.5);
    let k = 0;
    const next = () => {
      const el = $('loading-line');
      el.classList.remove('show');
      // Fade the old line out, then the next one in.
      setTimeout(() => {
        el.textContent = lines[k++ % lines.length];
        el.classList.add('show');
      }, 250);
    };
    next();
    loadingTimer = window.setInterval(next, 3600);
  } else {
    // A short pause, so the screen does not flicker between loading the ground and writing the problem.
    loadingHide = window.setTimeout(() => {
      $('loading').hidden = true;
      clearInterval(loadingTimer);
    }, 400);
  }
}
async function building<T>(fn: () => Promise<T>): Promise<T> {
  loadingDepth++;
  showLoading(true);
  try {
    return await fn();
  } finally {
    if (--loadingDepth === 0) showLoading(false);
  }
}
/** A genuinely transparent 1×1 image, used to clear an overlay. */
const BLANK = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/png');
})();
const PLACEHOLDER: [[number, number], [number, number], [number, number], [number, number]] = [
  [-1.86, 51.21], [-1.84, 51.21], [-1.84, 51.19], [-1.86, 51.19],
];

// ---------- map ----------
maplibregl.setWorkerUrl(maplibreWorkerUrl);
registerOsProtocol();
const baseSources = baseMapSources();
const style: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS_URL,
  ...(SPRITE_URL ? { sprite: SPRITE_URL } : {}),
  sources: baseSources,
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f6f3ea' } },
    ...Object.keys(baseSources).map((id) => ({
      id: `base-${id}`,
      type: 'raster' as const,
      source: id,
      layout: { visibility: 'none' as const },
      paint: id === 'osm' ? { 'raster-opacity': 0.8, 'raster-saturation': -0.3 } : { 'raster-opacity': 0.9 },
    })),
  ],
};

const startLat = Number(params.get('lat') ?? 51.2);
const startLon = Number(params.get('lon') ?? -1.85);
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [startLon, startLat],
  zoom: params.has('lat') ? 13 : 6,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// ---------- base map ----------
const baseSelect = $('sel-base') as HTMLSelectElement;
for (const b of BASE_MAPS) {
  if (b.id !== 'osm' && !OS_KEY) continue; // OS maps need a key
  const opt = new Option(b.label, b.id);
  if (b.id === 'os-open') opt.disabled = true; // enabled once the OS style has loaded
  baseSelect.add(opt);
}
baseSelect.add(new Option('None (terrain layers only)', 'none'));
let baseChosenByUser = false;

let osOpenReady = false;

function setBaseMap(id: BaseMapId | 'none') {
  for (const src of Object.keys(baseSources)) {
    if (map.getLayer(`base-${src}`)) map.setLayoutProperty(`base-${src}`, 'visibility', src === id ? 'visible' : 'none');
  }
  if (osOpenReady) {
    const vis = id === 'os-open' ? 'visible' : 'none';
    for (const l of map.getStyle().layers) if (l.id.startsWith(OS_OPEN_PREFIX)) map.setLayoutProperty(l.id, 'visibility', vis);
  }
  baseSelect.value = id;
}

/** The free OS open map in Great Britain (if we have a key), OpenStreetMap elsewhere. */
function defaultBaseFor(lat: number, lon: number): BaseMapId {
  if (!OS_KEY || !inGreatBritain(lat, lon)) return 'osm';
  return osOpenReady ? 'os-open' : 'os-outdoor';
}

baseSelect.addEventListener('change', () => {
  baseChosenByUser = true;
  setBaseMap(baseSelect.value as BaseMapId | 'none');
});

// On wide screens the controls float over the left of the map: keep map content clear of them.
const wide = window.matchMedia('(min-width: 900px)');
const padForPanel = () => map.setPadding({ left: wide.matches ? 444 : 0, top: 0, right: 0, bottom: 0 });
padForPanel();
wide.addEventListener('change', padForPanel);

map.on('load', () => {
  setBaseMap(defaultBaseFor(startLat, startLon));
  // Keep the attribution folded behind its small (i) button so it does not
  // cover the map. The map opens it again whenever new sources are added, so
  // fold it each time the map settles, unless the user has opened it.
  let attribOpenedByUser = false;
  document.querySelector('.maplibregl-ctrl-attrib-button')?.addEventListener('click', () => {
    attribOpenedByUser = !attribOpenedByUser;
  });
  const foldAttribution = () => {
    if (!attribOpenedByUser) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  };
  foldAttribution();
  map.on('idle', foldAttribution);
  map.addSource('hillshade', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('viewshed', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('features', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('section-zones', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('company-zones', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('company', { type: 'geojson', data: EMPTY });
  map.addSource('scenario', { type: 'geojson', data: EMPTY });
  map.addSource('graphics', { type: 'geojson', data: EMPTY });
  map.addSource('units', { type: 'geojson', data: EMPTY });
  map.addSource('plan', { type: 'geojson', data: EMPTY });
  map.addSource('section', { type: 'geojson', data: EMPTY });
  map.addSource('contours', {
    type: 'geojson',
    data: EMPTY,
    attribution: 'Elevation: Terrain Tiles (Mapzen/AWS); EU-DEM © Copernicus/EU; © Environment Agency; USGS',
  });
  map.addSource('grid', { type: 'geojson', data: EMPTY });
  map.addSource('box', { type: 'geojson', data: EMPTY });
  map.addSource('me', { type: 'geojson', data: EMPTY });
  map.addSource('tap', { type: 'geojson', data: EMPTY });
  map.addSource('problem', { type: 'geojson', data: EMPTY });
  map.addSource('ds', { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'hillshade', type: 'raster', source: 'hillshade', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'features', type: 'raster', source: 'features', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'viewshed', type: 'raster', source: 'viewshed', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'section-zones', type: 'raster', source: 'section-zones', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'company-zones', type: 'raster', source: 'company-zones', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({
    id: 'contours',
    type: 'line',
    source: 'contours',
    paint: {
      'line-color': '#b5651d',
      'line-width': ['case', ['get', 'index'], 1.6, 0.7],
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'contour-labels',
    type: 'symbol',
    source: 'contours',
    filter: ['==', ['get', 'index'], true],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-font': [LABEL_FONT],
      'text-size': 11,
      'symbol-spacing': 400,
    },
    paint: { 'text-color': '#8a4a12', 'text-halo-color': '#f6f3ea', 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#1f5fa8', 'line-width': 0.9, 'line-opacity': 0.7 } });
  map.addLayer({
    id: 'grid-labels',
    type: 'symbol',
    source: 'grid',
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-font': [LABEL_FONT],
      'text-size': 12,
      'symbol-spacing': 250,
    },
    paint: { 'text-color': '#1f5fa8', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'box', type: 'line', source: 'box', paint: { 'line-color': '#2f3a2a', 'line-width': 2, 'line-dasharray': [3, 2] } });
  map.addLayer({
    id: 'nai-fill', type: 'fill', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    paint: { 'fill-color': '#e67800', 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'nai-line', type: 'line', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    paint: { 'line-color': '#b35c00', 'line-width': 2.5 },
  });
  map.addLayer({
    id: 'enemy-route', type: 'line', source: 'problem', filter: ['==', ['get', 'kind'], 'route'],
    paint: { 'line-color': '#c00', 'line-width': 2.5, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'nai-label', type: 'symbol', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONT], 'text-size': 14 },
    paint: { 'text-color': '#7a3d00', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'ds-loc', type: 'line', source: 'ds', filter: ['==', ['get', 'kind'], 'loc'],
    paint: { 'line-color': '#2e7d32', 'line-width': 2, 'line-dasharray': [1, 1.5] },
  });
  map.addLayer({
    id: 'ds-points', type: 'circle', source: 'ds', filter: ['!=', ['get', 'kind'], 'loc'],
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'kind'], 'enemy', '#c00', 'own', '#1a73e8', 'guns', '#2e7d32', '#888'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'ds-labels', type: 'symbol', source: 'ds', filter: ['!=', ['get', 'kind'], 'loc'],
    layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONT], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#1d2118', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'scenario-routes', type: 'line', source: 'scenario', filter: ['==', ['get', 'kind'], 'direct'],
    paint: {
      'line-color': ['match', ['get', 'kind'], 'direct', '#c62828', '#2e7d32'],
      'line-width': 3,
      'line-dasharray': ['match', ['get', 'kind'], 'direct', ['literal', [2, 1.5]], ['literal', [1, 0]]],
    },
  });
  map.addLayer({
    id: 'scenario-objective', type: 'circle', source: 'scenario', filter: ['==', ['get', 'kind'], 'objective'],
    paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1a73e8', 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'company-areas', type: 'line', source: 'company', filter: ['==', ['get', 'kind'], 'area'],
    paint: { 'line-color': '#7a0000', 'line-width': 2, 'line-dasharray': [3, 1.5] },
  });
  map.addLayer({
    id: 'company-routes', type: 'line', source: 'company', filter: ['==', ['get', 'kind'], 'route'],
    paint: { 'line-color': '#1a73e8', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'company-points', type: 'circle', source: 'company', filter: ['match', ['get', 'kind'], ['section', 'team', 'outpost', 'hq', 'dummy', 'gap'], true, false],
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'team', 5, 'gap', 6, 7],
      'circle-color': ['match', ['get', 'kind'], 'outpost', '#e8a000', 'hq', '#5a2d82', 'dummy', '#ffffff', 'gap', '#1a73e8', '#c00'],
      'circle-stroke-color': ['match', ['get', 'kind'], 'dummy', '#c00', '#fff'],
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'company-labels', type: 'symbol', source: 'company', filter: ['match', ['get', 'kind'], ['area', 'route'], false, true],
    layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONT], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' },
    paint: { 'text-color': '#1d2118', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'section-route', type: 'line', source: 'section', filter: ['==', ['get', 'kind'], 'route'],
    paint: { 'line-color': '#1a73e8', 'line-width': 2.5, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'section-points', type: 'circle', source: 'section', filter: ['!=', ['get', 'kind'], 'route'],
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'alt', 5, 8],
      'circle-color': ['match', ['get', 'kind'], 'gun', '#7a0000', 'team', '#c00', 'outpost', '#e8a000', '#c88'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'section-labels', type: 'symbol', source: 'section', filter: ['!=', ['get', 'kind'], 'route'],
    layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONT], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#1d2118', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  // Tactical graphics (APP-6 control measures): friendly in blue, enemy in red.
  map.addLayer({
    id: 'graphics-fill', type: 'fill', source: 'graphics', filter: ['==', ['get', 'kind'], 'minefield'],
    paint: { 'fill-color': '#c00', 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: 'graphics-lines', type: 'line', source: 'graphics',
    filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'dashed'], true]],
    paint: {
      'line-color': ['match', ['get', 'side'], 'hostile', '#c00', '#0a3fa8'],
      'line-width': ['match', ['get', 'kind'], 'axis', 2, 2.5],
    },
  });
  // Echelon dots on a platoon boundary.
  map.addLayer({
    id: 'graphics-dots', type: 'fill', source: 'graphics', filter: ['==', ['get', 'kind'], 'dot'],
    paint: { 'fill-color': ['match', ['get', 'side'], 'hostile', '#c00', '#0a3fa8'] },
  });
  // Planned or suspected (APP-6): a dashed outline.
  map.addLayer({
    id: 'graphics-dashed', type: 'line', source: 'graphics',
    filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dashed'], true]],
    paint: { 'line-color': ['match', ['get', 'side'], 'hostile', '#c00', '#0a3fa8'], 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
  });
  // APP-6 mine symbols inside minefields.
  addMineImages(map);
  map.addLayer({
    id: 'graphics-mines', type: 'symbol', source: 'graphics', filter: ['==', ['get', 'kind'], 'mine'],
    layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.9, 14, 1.2, 16, 2, 18, 2.8],
    },
  });
  map.addLayer({
    id: 'graphics-labels', type: 'symbol', source: 'graphics', filter: ['==', ['get', 'kind'], 'label'],
    layout: {
      'text-field': ['get', 'text'], 'text-font': [LABEL_FONT], 'text-size': ['interpolate', ['linear'], ['zoom'],
        12, ['case', ['==', ['get', 'big'], true], 18, 12],
        14, ['case', ['==', ['get', 'big'], true], 22, 14],
        16, ['case', ['==', ['get', 'big'], true], 30, 18]],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': ['match', ['get', 'side'], 'hostile', '#c00', '#0a3fa8'], 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  // APP-6 unit symbols.
  map.addLayer({
    id: 'units', type: 'symbol', source: 'units',
    layout: {
      'icon-image': ['get', 'icon'], 'icon-anchor': 'top-left', 'icon-offset': ['get', 'off'],
      // Symbols grow as you zoom in, so they stay readable on a big screen (PO, 15 Nov 2026).
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.9, 14, 1.2, 16, 2, 18, 2.8],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', 'text'], 'text-font': [LABEL_FONT],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 13, 14, 15, 16, 20, 18, 26],
      'text-offset': [0, 1.5], 'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#1d2118', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 8, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'tap',
    type: 'circle',
    source: 'tap',
    paint: { 'circle-radius': 7, 'circle-color': '#ffd400', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
  });
  // Unit symbols sit on top, so the selected point does not hide "You".
  map.moveLayer('units');
  // The user's plan, on top of everything: a dashed blue route (planned, APP-6) and labelled positions.
  map.addLayer({
    id: 'plan-route', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'route'],
    paint: { 'line-color': '#0a3fa8', 'line-width': 3.5, 'line-dasharray': [2, 1] },
  });
  map.addLayer({
    id: 'plan-points', type: 'circle', source: 'plan', filter: ['==', ['get', 'kind'], 'vertex'],
    paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#0a3fa8', 'circle-stroke-width': 2 },
  });
  // Planned positions as APP-6 control measures: lines and areas (SBF, ABF, FUP, block)...
  map.addLayer({
    id: 'plan-lines', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'plan'],
    paint: { 'line-color': '#0a3fa8', 'line-width': 3 },
  });
  // ...point measures and the platoon HQ symbol...
  map.addLayer({
    id: 'plan-icons', type: 'symbol', source: 'plan', filter: ['==', ['get', 'kind'], 'icon'],
    layout: {
      'icon-image': ['get', 'icon'], 'icon-anchor': ['get', 'anchor'], 'icon-offset': ['get', 'off'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.9, 14, 1.2, 16, 2, 18, 2.8],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', 'text'], 'text-font': [LABEL_FONT], 'text-anchor': 'left', 'text-offset': [1.2, -0.6],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 13, 16, 18], 'text-optional': true,
    },
    paint: { 'text-color': '#0a3fa8', 'text-halo-color': '#fff', 'text-halo-width': 2.5 },
  });
  // ...and the labels: on each graphic, and at the end of each route ("1 Sect").
  map.addLayer({
    id: 'plan-labels', type: 'symbol', source: 'plan', filter: ['in', ['get', 'kind'], ['literal', ['label', 'routeLabel']]],
    layout: {
      'text-field': ['get', 'text'], 'text-font': [LABEL_FONT],
      'text-anchor': ['case', ['==', ['get', 'kind'], 'routeLabel'], 'bottom-left', 'center'],
      'text-offset': ['case', ['==', ['get', 'kind'], 'routeLabel'], ['literal', [0.4, -0.2]], ['literal', [0, 0]]],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 13, 16, 18], 'text-allow-overlap': true,
    },
    paint: { 'text-color': '#0a3fa8', 'text-halo-color': '#fff', 'text-halo-width': 2.5 },
  });

  // The free OS open map goes beneath all our own layers.
  void addOsOpenMap(map, 'hillshade')
    .then((ok) => {
      osOpenReady = ok;
      if (!ok) return;
      const opt = [...baseSelect.options].find((o) => o.value === 'os-open');
      if (opt) opt.disabled = false;
      if (!baseChosenByUser) setBaseMap(defaultBaseFor(map.getCenter().lat, map.getCenter().lng));
    })
    .catch(() => undefined);

  if (params.get('autoload') === '1' || demo) void loadGround(startLat, startLon);
});

// ---------- position ----------
function showPosition() {
  if (!myFix) return;
  const six = gridRef(myFix.lat, myFix.lon, 3);
  const eight = gridRef(myFix.lat, myFix.lon, 4);
  $('pos-ref').textContent = six.ref;
  let detail = `${eight.system} ${eight.ref} · ±${Math.round(myFix.accuracy)} m`;
  if (box) {
    const p = latLonToLocal(box.centre, myFix.lat, myFix.lon);
    const out = Math.abs(p.x) > box.halfM || Math.abs(p.y) > box.halfM;
    if (out) detail += ' · outside the loaded box';
  }
  $('pos-detail').textContent = detail;
  (map.getSource('me') as GeoJSONSource | undefined)?.setData(pointGeoJSON(myFix.lon, myFix.lat));
}

function startWatching(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This device cannot report its position'));
    if (watchId !== null && myFix) return resolve();
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        myFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        showPosition();
        if (first) {
          first = false;
          resolve();
        }
      },
      (err) => {
        if (first) reject(new Error(err.code === 1 ? 'Location permission refused' : `Location unavailable: ${err.message}`));
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  });
}

// ---------- loading ground ----------
function setBusy(busy: boolean) {
  for (const id of ['btn-start-here', 'btn-go-plan', 'btn-sc-develop', 'btn-sc-ds', 'btn-here', 'btn-load-point', 'btn-vs-me', 'btn-problem', 'btn-features', 'btn-pt-problem', 'btn-pt-section', 'btn-sec-new', 'btn-pt-company', 'btn-co-new', 'btn-sc-new']) ($(id) as HTMLButtonElement).disabled = busy;
}

/** The ground detail chosen in the panel, unless a caller insists on one. */
const chosenDetail = () => ($('sel-detail') as HTMLSelectElement).value as Detail;

/** True if the loaded ground is what the problem engine needs: a 4 km box at 10 m. */
const groundFitsProblems = () => !!ground && ground.cellM === 10 && ground.width * ground.cellM === 4000;

/** Load ground, with the loading screen up meanwhile. */
function loadGround(lat: number, lon: number, detail: Detail = chosenDetail()): Promise<void> {
  return building(() => loadGroundInner(lat, lon, detail));
}
async function loadGroundInner(lat: number, lon: number, detail: Detail) {
  setBusy(true);
  status(demo ? 'Building demo ground…' : 'Fetching elevation data…');
  try {
    ground = await engine.load(lat, lon, { demo, detail }, status);
    box = { centre: { lat, lon }, halfM: (ground.width * ground.cellM) / 2 };
    if (!baseChosenByUser) setBaseMap(defaultBaseFor(lat, lon));
    const corners = boxCorners(box);

    (map.getSource('hillshade') as ImageSource).updateImage({
      url: hillshadeImage(ground.width, ground.height, ground.hillshade),
      coordinates: corners,
    });
    (map.getSource('viewshed') as ImageSource).updateImage({ url: BLANK, coordinates: corners });
    (map.getSource('contours') as GeoJSONSource).setData(contoursGeoJSON(ground.contours, box.centre));
    (map.getSource('box') as GeoJSONSource).setData(boxOutlineGeoJSON(box));
    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const bounds = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
    (map.getSource('grid') as GeoJSONSource).setData(gridLines(bounds) as never);
    (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
    lastObserver = null;
    $('vs-info').textContent = '';
    map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 16, animate: false });

    const g = ground.ground;
    $('ground-class').textContent = g.ground;
    $('ground-detail').textContent =
      `${g.reasons.join(' ')} Heights ${Math.round(ground.minM)}–${Math.round(ground.maxM)} m; contours every ${ground.contourIntervalM} m.`;
    const m = ground.meta;
    $('data-source').textContent =
      `Source: ${m.source}. Data resolution about ${Math.round(m.sourceResolutionM)} m. ${m.notes.join(' ')}` +
      (ground.detailNote ? ` ${ground.detailNote}` : '');
    $('ground-info').hidden = false;
    $('vs-block').hidden = false;
    clearProblem();
    clearFeatures();
    clearSection();
    clearCompany();
    // The artillery problem panel stays hidden (kept for a possible artillery problem type).
    clearScenario();
    status(`Ground loaded · ${gridRef(lat, lon).ref}`);
    showPosition();

    const vs = params.get('vs');
    if (vs) {
      const [x, y] = vs.split(',').map(Number);
      await runViewshed(x, y);
    }
  } catch (err) {
    status(`Could not load ground: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

// ---------- map features ----------
let featuresShown = false;

function clearFeatures() {
  featuresShown = false;
  if (box) (map.getSource('features') as ImageSource | undefined)?.updateImage({ url: BLANK, coordinates: boxCorners(box) });
  $('feat-legend').hidden = true;
  $('feat-note').textContent = '';
  ($('btn-features') as HTMLButtonElement).textContent = 'Show features';
}

async function toggleFeatures() {
  if (!box || !ground) return;
  if (featuresShown) {
    clearFeatures();
    return;
  }
  setBusy(true);
  try {
    const f = await engine.features(status);
    $('feat-note').textContent = f.note;
    if (!f.ok || !f.image) {
      status('Map features not available');
      return;
    }
    (map.getSource('features') as ImageSource).updateImage({
      url: toDataURL(ground.width, ground.height, f.image),
      coordinates: boxCorners(box),
    });
    featuresShown = true;
    $('feat-legend').hidden = false;
    ($('btn-features') as HTMLButtonElement).textContent = 'Hide features';
    status('Features shown');
  } catch (err) {
    status(`Could not load features: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-features').addEventListener('click', () => void toggleFeatures());

// ---------- infantry platoon scenario ----------
let scenario: ScenarioView | null = null;
// ---------- the user's plan (PO, 15 Nov 2026) ----------
let plan: Plan.PlanState = Plan.emptyPlan();
let problemKey: Plan.ProblemKey | null = null;
/** What a tap on the map does while a problem is open: add to the route, place a position, or (null) select a point. */
let planTool: 'route' | 'mark' | null = null;
let lastPlanFacts: Awaited<ReturnType<typeof engine.planFacts>> | null = null;

function clearScenario() {
  scenario = null;
  document.body.classList.remove('defence');
  planTool = null;
  plan = Plan.emptyPlan();
  (map.getSource('plan') as GeoJSONSource | undefined)?.setData(EMPTY);
  $('sc-plan-facts-block').hidden = true;
  phase2Shown = false;
  dsShown = false;
  revealed = false;
  (map.getSource('units') as GeoJSONSource | undefined)?.setData(EMPTY);
  (map.getSource('graphics') as GeoJSONSource | undefined)?.setData(EMPTY);
  $('sc').hidden = true;
  $('sc-phase2').hidden = true;
  $('sc-ds').hidden = true;
  $('sc-note').textContent = '';
  if (box) (map.getSource('company-zones') as ImageSource | undefined)?.updateImage({ url: BLANK, coordinates: boxCorners(box) });
  (map.getSource('company') as GeoJSONSource | undefined)?.setData(EMPTY);
  (map.getSource('scenario') as GeoJSONSource | undefined)?.setData(EMPTY);
  setStage('start');
}

// ---------- the situation map: APP-6 symbols and tactical graphics ----------
let phase2Shown = false;
/** The ground truth is drawn on the map (Problem page after the reveal, or the DS page). */
let dsShown = false;
/** The user has revealed the ground truth on the Problem page: the plan is then fixed. */
let revealed = false;

type P = { x: number; y: number };
function unitFeature(p: P, spec: Parameters<typeof ensureSymbol>[1], text: { designation?: string; higher?: string } = {}, label = '') {
  const c = box!.centre;
  const ll = localToLatLon(c, p.x, p.y);
  const { name, offset } = ensureSymbol(map, spec, text);
  return { type: 'Feature' as const, properties: { icon: name, off: offset, text: label }, geometry: { type: 'Point' as const, coordinates: [ll.lon, ll.lat] } };
}

/**
 * Draw the situation. Friendly units, axes and the task graphic are always
 * shown. Enemy: before the DS reveal, only what the scenario says has been
 * seen, as suspected (dashed frames), adding what "the situation develops"
 * reveals once opened; with the DS reveal, the whole enemy layout in red.
 */
/**
 * Zoom the map to the problem area (your company, the reported enemy and the
 * objectives), so the symbols can be read; the whole 8 km box is a zoom-out away.
 */
function zoomToSituation() {
  const s = scenario?.scenario;
  if (!box || !s) return;
  const m = s.markers;
  const pts: P[] = s.problemType === 'defence'
    ? [
        // Your area and the ground about 1 km in front of it.
        ...(m.area?.outline ?? []),
        { x: m.task.objective.x * 0.35, y: m.task.objective.y * 0.35 },
        ...m.friendly.filter((f) => f.echelon === 'platoon' || f.hq).map((f) => f.point),
      ]
    : [
        ...m.friendly.filter((f) => f.echelon === 'platoon' || f.hq).map((f) => f.point),
        ...m.sightings.filter((x) => x.phase === 1).map((x) => x.point),
        m.task.objective,
      ];
  const ll = pts.map((p) => localToLatLon(box!.centre, p.x, p.y));
  const lons = ll.map((q) => q.lon), lats = ll.map((q) => q.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 50, animate: false, maxZoom: 15 });
}

function renderSituation() {
  const s = scenario?.scenario;
  if (!box || !s) {
    (map.getSource('units') as GeoJSONSource | undefined)?.setData(EMPTY);
    (map.getSource('graphics') as GeoJSONSource | undefined)?.setData(EMPTY);
    return;
  }
  const c = box.centre;
  const m = s.markers;
  const units: object[] = [];
  const graphics: object[] = [];
  // Once the situation has developed, your own platoon is shown by its sections where they now are.
  const elements = phase2Shown ? (plan.developed?.elements ?? []) : [];
  for (const f of m.friendly) {
    if (f.own && elements.length) continue;
    units.push(unitFeature(f.point, { identity: 'friend', echelon: f.echelon as Echelon, hq: f.hq, kind: f.kind }, { designation: f.designation, higher: f.higher }, f.own ? 'You' : ''));
  }
  const ownKind = m.friendly.find((f) => f.own)?.kind ?? 'infantry';
  for (const e of elements) {
    const hq = /HQ/.test(e.who);
    const num = e.who.match(/^(\d)/)?.[1] ?? '';
    const short = { 'in contact': 'contact', 'at mines': 'mines', 'under shellfire': 'shelled', moving: '', 'at the end of its route': '', 'in position': '' }[e.state];
    units.push(unitFeature(e.point, { identity: 'friend', echelon: hq ? 'platoon' : 'section', hq, kind: ownKind }, hq ? { designation: '2', higher: 'B' } : { designation: num, higher: '2' }, short));
  }
  // No axis arrows or task graphics: they cluttered the map (PO, 15 Nov 2026). Objectives,
  // the boundary, start line and phase line stay; the task is in the text.
  for (const l of m.control) graphics.push(...controlLine(c, l.kind, l.path, l.label, l.sides));
  if (m.bgObjective.onMap) graphics.push(...objectiveGraphic(c, m.bgObjective.point, 250, m.bgObjective.name));
  // Your objective, by its codename (secure and neutralise; find-and-fix and screen have no objective to draw).
  if (m.task.code) graphics.push(...objectiveGraphic(c, m.task.objective, 150, m.task.code));
  // Defence (PO, 23 Nov 2026): your platoon area; the enemy's axes (only those reported, dashed, until the ground truth).
  if (m.area) graphics.push(...areaOutline(c, m.area.outline, m.area.label, 'friend'));
  for (const a of m.enemyAxes ?? []) if (dsShown || a.reported) graphics.push(...enemyAxis(c, a.path, dsShown ? a.label : 'Expected', !dsShown));
  if (dsShown && m.enemyAssembly) graphics.push(...roundArea(c, m.enemyAssembly, 250, 'AA', 'hostile'));

  if (dsShown && s.problemType === 'defence') {
    // The attack as it really came: overwatch, and the groups where they formed up.
    for (const o of m.enemyOverwatch ?? [])
      units.push(unitFeature(o.point, { identity: 'hostile', echelon: 'section', kind: scenario?.attack?.options.mounted ? 'mechanisedInfantry' : 'infantry' }, {}, o.label));
    for (const a of m.enemyAxes ?? [])
      units.push(unitFeature(a.path[Math.min(a.path.length - 1, 2)], { identity: 'hostile', echelon: a.kind === 'infiltration' ? 'team' : 'section', kind: a.kind === 'mounted' ? 'mechanisedInfantry' : 'infantry' }, {}, a.label));
    for (const x of m.sightings) if (x.phase === 2 && phase2Shown) units.push(unitFeature(x.point, { identity: 'hostile', echelon: x.echelon as Echelon }, {}, x.label));
  } else if (dsShown && scenario?.company?.platoons) {
    const co = scenario.company;
    for (const pl of co.platoons!) {
      // Each platoon is shown by its dashed outline and label; its sections and teams carry the symbols.
      // The counter-attack force: a platoon in BMPs, shown as mechanised infantry.
      const mounted = pl.role === 'reserve';
      for (const x of pl.positions) {
        const echelon: Echelon = x.kind === 'section' ? 'section' : 'team';
        units.push(unitFeature(x.point, { identity: 'hostile', echelon, kind: mounted ? 'mechanisedInfantry' : 'infantry' }, {}, x.kind === 'outpost' ? 'OP' : mounted ? 'BMP' : ''));
      }
    }
    if (co.hq) units.push(unitFeature(co.hq.point, { identity: 'hostile', echelon: 'company', hq: true }));
    for (const d of co.dummies ?? []) units.push(unitFeature(d.point, { identity: 'hostile', echelon: 'section', dummy: true }));
    // DS: the minefields as laid, in APP-6 (solid outline, AT and AP mine symbols inside).
    for (const outline of co.minefields ?? []) graphics.push(...minefield(c, outline, 'mixed', 'hostile', false));
  } else {
    for (const x of m.sightings) {
      if (x.phase === 2 && !phase2Shown) continue;
      units.push(unitFeature(x.point, { identity: 'hostile', echelon: x.echelon as Echelon, suspected: !x.dummy, dummy: x.dummy }, {}, x.label));
    }
    for (const mf of m.minefields) {
      if (mf.phase === 2 && !phase2Shown) continue;
      graphics.push(...minefield(c, mf.outline, mf.phase === 1 ? 'unspecified' : 'ap', 'hostile', mf.phase === 1));
    }
  }
  (map.getSource('units') as GeoJSONSource).setData({ type: 'FeatureCollection', features: units } as never);
  (map.getSource('graphics') as GeoJSONSource).setData({ type: 'FeatureCollection', features: graphics } as never);
}

function el(tag: string, text: string, cls?: string) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function showScenario() {
  const s = scenario?.scenario;
  if (!s) return;
  $('sc-title').textContent = s.title;
  $('sc-you').textContent = s.you;
  $('sc-force').replaceChildren(...s.force.map((f) => {
    const tr = document.createElement('tr');
    tr.append(el('td', f.element), el('td', f.detail));
    return tr;
  }));
  $('sc-situation').textContent = s.situation;
  $('sc-friendly').replaceChildren(...s.friendlyForces.map((f) => {
    const tr = document.createElement('tr');
    tr.append(el('td', f.element), el('td', f.detail));
    return tr;
  }));
  $('sc-task').textContent = s.task_text;
  $('sc-enemy').replaceChildren(...s.enemy.map((e) => {
    const li = el('li', e.text + ' ');
    li.append(el('span', `(${e.source}; reliability ${e.reliability})`, 'rel'));
    return li;
  }));
  $('sc-gaps').textContent = `Not known: ${s.enemyGaps}`; // a phrase completing "Not known:"
  $('sc-time').textContent = s.time;
  fillList('sc-ground', s.ground);
  $('sc-own').textContent = s.ownTroops;
  $('sc-weather').textContent = s.weather;
  fillList('sc-q', s.questions);
  $('sc-allowed').textContent = `Time allowed: ${s.timeAllowed}`;
  $('sc-p2time').textContent = s.phase2.time;
  $('sc-p2msgs').replaceChildren(...s.phase2.messages.map((m) => el('li', `${m.time}, from ${m.from}: "${m.text}"`)));
  fillList('sc-p2q', s.phase2.questions);
  answerBoxes('plan-answers', s.questions, plan.answers);
  answerBoxes('plan-answers2', s.phase2.questions, plan.answers2);
  fillList('sc-ds-list', [...s.ds, `Data: ${s.dataNote}`]);
  $('sc-data').textContent = s.dataNote;
  $('sc').hidden = false;
}

/** Draw (or remove) the ground truth on the map: the whole enemy, fire, dead ground, mines, the obvious route. */
function showScenarioDS(show: boolean) {
  const v = scenario;
  if (box && v?.attack && v.scenario) {
    // Defence: dead ground from your area (where the enemy could close unseen) and the attack itself.
    const a = v.attack;
    $('sc-ds').hidden = !show;
    (map.getSource('company-zones') as ImageSource).updateImage({
      url: show ? companyZonesImage(a.maskWidth, a.maskHeight, new Uint8Array(a.maskWidth * a.maskHeight), a.deadFromArea, null) : BLANK,
      coordinates: boxCorners(box),
    });
    (map.getSource('company') as GeoJSONSource).setData(EMPTY);
    (map.getSource('scenario') as GeoJSONSource).setData(EMPTY);
    dsShown = show;
    renderSituation();
    renderPlan();
    void showPlanFacts(show);
    return;
  }
  if (!box || !v?.company || !v.scenario) return;
  const c = v.company;
  $('sc-ds').hidden = !show;
  (map.getSource('company-zones') as ImageSource).updateImage({
    // Mines are drawn as APP-6 minefields (renderSituation), not shaded.
    url: show ? companyZonesImage(c.maskWidth!, c.maskHeight!, c.killZone!, c.deadGround!, null) : BLANK,
    coordinates: boxCorners(box),
  });
  // Platoon areas and the gap outline only: the units themselves are APP-6 symbols.
  (map.getSource('company') as GeoJSONSource).setData(
    show
      ? (companyGeoJSON(box.centre, { platoons: c.platoons!.map((p) => ({ ...p, positions: [] })), hq: null, dummies: [], gaps: c.gaps, routes: [] }) as never)
      : EMPTY,
  );
  (map.getSource('scenario') as GeoJSONSource).setData(show ? (scenarioGeoJSON(box.centre, v.scenario) as never) : EMPTY);
  dsShown = show;
  renderSituation();
  renderPlan();
  void showPlanFacts(show);
}

// ---------- modes: Problem, DS, Developer (PO, 15 Nov 2026) ----------
type Mode = 'problem' | 'ds' | 'dev' | 'settings';
let mode: Mode = 'problem';
type Stage = 'start' | 'read' | 'plan' | 'develop' | 'truth';
let stage: Stage = 'start';

/** The Developer page appears only with ?dev=1 (then remembered on this phone). */
const devAllowed = (() => {
  try {
    if (new URLSearchParams(location.search).get('dev') === '1') localStorage.setItem('ground-truth.dev', '1');
    return localStorage.getItem('ground-truth.dev') === '1';
  } catch {
    return new URLSearchParams(location.search).get('dev') === '1';
  }
})();
document.querySelector<HTMLButtonElement>('[data-mode-tab="dev"]')!.hidden = !devAllowed;

const MODE_NAME: Record<Mode, string> = { problem: 'Problem', ds: 'DS', dev: 'Developer', settings: 'Settings' };
function setMode(m: Mode) {
  mode = m;
  if (m !== 'problem') closeStartPopup();
  document.body.dataset.mode = m;
  $('mode-name').textContent = `· ${MODE_NAME[m]}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')) b.classList.toggle('active', b.dataset.modeTab === m);
  planTool = null;
  // The ground truth shows on the DS page at any time, and on the Problem page once revealed
  // (Settings leaves the map as it was).
  if (scenario?.scenario && m !== 'settings') showScenarioDS(m === 'ds' || (m === 'problem' && revealed));
  if (m === 'ds') void fillDsPage();
  renderPlan();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]'))
  b.addEventListener('click', () => {
    setMode(b.dataset.modeTab as Mode);
    openMenu(false);
  });

/** The menu, top left: opens over the map; closes on a choice, a tap outside it, or Escape. */
function openMenu(open: boolean) {
  $('menu').hidden = !open;
  $('menu-backdrop').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
}
$('btn-menu').addEventListener('click', () => openMenu($('menu').hidden === true));
$('menu-backdrop').addEventListener('click', () => openMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') openMenu(false);
});

/** Which stages of the Problem page can be opened: each once it has been reached. */
function updateStepbar() {
  const has = !!scenario?.scenario;
  const open: Record<Stage, boolean> = { start: true, read: has, plan: has, develop: has && !!plan.developed, truth: has && revealed };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-stage-tab]')) {
    const st = b.dataset.stageTab as Stage;
    b.disabled = !open[st];
    b.classList.toggle('current', st === stage);
  }
}
function setStage(st: Stage) {
  stage = st;
  if (st !== 'start') closeStartPopup();
  $('panel').dataset.stage = st;
  for (const el of document.querySelectorAll<HTMLElement>('.stage')) el.classList.toggle('current', el.dataset.stage === st);
  if (st !== 'plan') planTool = null;
  updateStepbar();
  renderPlan();
  $('panel').scrollTop = 0;
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-stage-tab]')) b.addEventListener('click', () => setStage(b.dataset.stageTab as Stage));

/** The DS page: the full enemy layout and the student's plan against it, for the problem on this phone. */
async function fillDsPage() {
  const s = scenario?.scenario;
  $('ds-empty').hidden = !!s;
  $('ds-page').hidden = !s;
  if (!s) return;
  $('ds-title').textContent = s.title;
  $('ds-summary').textContent = `Information given to the student: ${s.info}. ${s.time}`;
  fillList('ds-list', [...s.ds, `Data: ${s.dataNote}`]);
  if (!Plan.drawnRoutes(plan).length && !plan.marks.length) {
    fillList('ds-plan', ['No plan marked yet.']);
    return;
  }
  try {
    const f = await engine.planFacts(planInput());
    fillList('ds-plan', [...f.route, ...f.positions.map((p) => `${p.label}: ${p.facts.join(' ')}`)]);
  } catch (err) {
    fillList('ds-plan', [`Could not work out facts for the plan: ${(err as Error).message}`]);
  }
}

/** The time the problem is set for: now, or the date and time the DS chose in Problem options. */
function problemTime(): number {
  if (($('sel-time') as HTMLSelectElement).value === 'set') {
    const v = ($('inp-time') as HTMLInputElement).value; // local time, e.g. 2026-11-16T05:30
    const t = v ? new Date(v).getTime() : NaN;
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}
$('sel-time').addEventListener('change', () => {
  const set = ($('sel-time') as HTMLSelectElement).value === 'set';
  const inp = $('inp-time') as HTMLInputElement;
  inp.hidden = !set;
  if (set && !inp.value) {
    // Start from now, to the minute, in local time.
    const d = new Date();
    d.setSeconds(0, 0);
    inp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
});

type ProblemKind = 'normal' | 'quick' | 'daily';
/** For a Quick problem: two questions and ten minutes (PO, 15 Nov 2026: read and answer only). */
const QUICK_QUESTIONS = ['What do you decide to do, and why?', 'Give your outline orders to your section commanders.'];

/** Set a problem, with the loading screen up meanwhile. */
function runScenario(...args: Parameters<typeof runScenarioInner>): Promise<void> {
  return building(() => runScenarioInner(...args));
}
async function runScenarioInner(
  seed: number,
  resume?: Plan.SavedPlan,
  opts: { kind?: ProblemKind; now?: number; label?: string } = {},
) {
  closeStartPopup();
  if (!box) return;
  clearScenario();
  clearCompany();
  $('scenario-block').hidden = false;
  setBusy(true);
  try {
    const kind: ProblemKind = resume?.problem.kind ?? opts.kind ?? 'normal';
    // The Problem of the day ignores the options, so it is the same for everyone.
    const task = kind === 'daily' ? '' : (($('sel-task') as HTMLSelectElement).value as TaskType | '');
    const info = kind === 'daily' ? '' : (($('sel-info') as HTMLSelectElement).value as InfoLevel | '');
    const layoutChoice = resume?.problem.layout ?? (kind === 'daily' ? '' : ($('sel-layout') as HTMLSelectElement).value);
    const spreadChoice = resume?.problem.spread ?? (kind === 'daily' ? '' : ($('sel-spread') as HTMLSelectElement).value);
    const now = resume?.problem.now ?? opts.now ?? problemTime();
    const label = resume?.problem.label ?? opts.label;
    const laneChoice = resume?.problem.lane ?? (kind === 'daily' ? '' : ($('sel-lane') as HTMLSelectElement).value);
    // Attack or defence (PO, 23 Nov 2026): as chosen, else at random (the Problem of the day leaves it to its seed).
    const typeChoice = resume?.problem.type ?? (kind === 'daily' ? '' : ($('sel-type') as HTMLSelectElement).value);
    scenario = await engine.scenario({ task: task || undefined, info: info || undefined, options: {}, seed, now, layout: (layoutChoice || undefined) as LayoutType | undefined, spread: (spreadChoice || undefined) as SpreadName | undefined, lane: (laneChoice || undefined) as LaneMode | undefined, problemType: (typeChoice || undefined) as ProblemType | undefined }, status);
    if (!scenario.found || !scenario.scenario) {
      $('sc-note').textContent = `${scenario.featureNote} ${scenario.log.join(' ')} Try a point a little way off.`;
      status('No problem fits here');
      return;
    }
    $('sc-note').textContent = scenario.featureNote;
    problemKey = { lat: box.centre.lat, lon: box.centre.lon, seed, task, info, detail: chosenDetail(), now, kind, label, layout: layoutChoice, spread: spreadChoice, lane: laneChoice, type: typeChoice };
    plan = resume ? resume.plan : Plan.emptyPlan();
    if (kind === 'quick') {
      scenario.scenario.questions = QUICK_QUESTIONS;
      scenario.scenario.timeAllowed = '10 minutes.';
      scenario.scenario.title = `Quick problem: ${scenario.scenario.title}`;
    } else if (kind === 'daily') scenario.scenario.title = `Problem of the day, ${label}: ${scenario.scenario.title}`;
    document.body.classList.toggle('quick', kind === 'quick');
    document.body.classList.toggle('defence', scenario.scenario.problemType === 'defence');
    $('quick-block').hidden = kind !== 'quick';
    showScenario();
    if (kind === 'quick') answerBoxes('quick-answers', QUICK_QUESTIONS, plan.answers);
    renderPlan();
    if (!resume) Plan.savePlan(problemKey, plan);
    else if (plan.developed) showDeveloped(plan.developed);
    revealed = !!plan.revealed;
    renderSituation();
    zoomToSituation();
    status(`Problem set (${(scenario.timeMs / 1000).toFixed(1)} s)`);
    setStage(revealed ? 'truth' : plan.developed ? 'develop' : resume ? 'plan' : 'read');
    setMode(mode);
  } catch (err) {
    status(`Could not set a problem: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

// A new problem of the same kind: another Quick problem after a Quick one.
$('btn-sc-new').addEventListener('click', () => void (problemKey?.kind === 'quick' ? startQuick() : runScenario(Math.floor(Math.random() * 1e9))));
// The situation develops from the plan the user marked (PO, 15 Nov 2026): a
// route is needed; what happens is worked out once along it, then fixed.
$('btn-sc-develop').addEventListener('click', async () => {
  const s = scenario?.scenario;
  if (!s || !box) return;
  if (plan.developed) return setStage('develop');
  if (s.problemType === 'defence') {
    // Defence: the situation develops from where the sections are sited.
    const missingS = ['1 Sect', '2 Sect', '3 Sect'].filter((k) => !plan.marks.some((m) => m.kind === k));
    if (missingS.length) {
      $('plan-mode').textContent = `Site ${missingS.join(', ')} first: the situation develops from where you put your sections.`;
      status('Site every section before the situation develops');
      return;
    }
  }
  const missing = s.problemType === 'defence' ? [] : Plan.missingRoutes(plan);
  if (missing.length) {
    $('plan-mode').textContent = `Draw a route for ${missing.map((w) => Plan.WHO_NAME[w]).join(', ')} first: the situation develops from the routes you choose.`;
    status('Mark every route before the situation develops');
    return;
  }
  planTool = null;
  setBusy(true);
  status('Working out what happens on your route…');
  try {
    const d = await engine.develop(
      planInput(),
      s.startMs,
    );
    plan.developed = d;
    savePlanNow();
    showDeveloped(d);
    setStage('develop');
    status('The situation develops');
  } catch (err) {
    status(`Could not develop the situation: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
});

/** Show the developed situation: messages, new (suspected) enemy and mines on the map. */
function showDeveloped(d: Plan.PlanState['developed'] & object) {
  const s = scenario?.scenario;
  if (!s) return;
  s.phase2.time = d.time;
  s.phase2.messages = d.messages;
  s.markers.sightings = [...s.markers.sightings.filter((x) => x.phase === 1), ...d.sightings.map((x) => ({ ...x, phase: 2 as const }))];
  s.markers.minefields = [...s.markers.minefields.filter((x) => x.phase === 1), ...d.minefields.map((x) => ({ ...x, phase: 2 as const }))];
  $('sc-p2time').textContent = d.time;
  $('sc-p2msgs').replaceChildren(...d.messages.map((m) => el('li', `${m.time}, from ${m.from}: "${m.text}"`)));
  // Where each section and Pl HQ is now, as shown on the map.
  $('sc-p2pos').textContent = d.elements?.length
    ? `Your platoon at ${d.asAt} (shown on the map): ` +
      d.elements.map((e) => {
        const ll = localToLatLon(box!.centre, e.point.x, e.point.y);
        return `${e.who} at ${gridRef(ll.lat, ll.lon, 3).ref}, ${e.state}`;
      }).join('; ') + '.'
    : '';
  $('sc-phase2').hidden = false;
  phase2Shown = true;
  renderSituation();
  renderPlan();
}
// Reveal the ground truth: shown from now on, and the plan is fixed (decide first, then see).
$('btn-sc-ds').addEventListener('click', () => {
  revealed = true;
  plan.revealed = true;
  planTool = null;
  savePlanNow();
  showScenarioDS(true);
  setStage('truth');
});
$('btn-go-plan').addEventListener('click', () => setStage('plan'));
$('btn-quick-reveal').addEventListener('click', () => $('btn-sc-ds').click());

/** Quick problem: on one of the well-known sites, chosen at random; read and answer, then reveal. */
async function startQuick() {
  const site = SITES[Math.floor(Math.random() * SITES.length)];
  status(`Quick problem: loading ${site.name}…`);
  await loadGround(site.lat, site.lon, 'medium');
  if (!boxCentredOn(site)) return;
  await runScenario(Math.floor(Math.random() * 1e9), undefined, { kind: 'quick' });
}
/** Problem of the day: the same site, problem and time for everyone on a given UK date. */
async function startDaily() {
  const day = ukDay();
  const d = problemOfTheDay(day);
  const label = `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(new Date(d.now))}, ${d.site.name}`;
  status(`Problem of the day: loading ${d.site.name}…`);
  await loadGround(d.site.lat, d.site.lon, 'medium');
  if (!boxCentredOn(d.site)) return;
  await runScenario(d.seed, undefined, { kind: 'daily', now: d.now, label });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-action]'))
  b.addEventListener('click', () => {
    openMenu(false);
    setMode('problem');
    if (b.dataset.action === 'quick') void startQuick();
    else void startDaily();
  });

const toLocal = (p: Plan.LatLon) => latLonToLocal(box!.centre, p.lat, p.lon);
const ref8 = (p: Plan.LatLon) => gridRef(p.lat, p.lon, 4).ref;

/** The plan in local metres, for the worker: one route per element, and the positions. */
function planInput() {
  return {
    routes: Plan.drawnRoutes(plan).map((r) => ({ who: Plan.WHO_NAME[r.who], points: r.points.map(toLocal) })),
    positions: plan.marks.map((m) => ({ kind: m.kind, label: m.label, point: toLocal(m) })),
  };
}

function savePlanNow() {
  if (problemKey) Plan.savePlan(problemKey, plan);
}

/**
 * A planned position as its APP-6 graphic (PO, 15 Nov 2026), facing the
 * objective: OP triangle; support by fire (SBF) and attack by fire (ABF)
 * positions; FUP and assault position areas; cut-off as a block; Pl HQ as
 * the HQ unit symbol; RV and other points as labelled pins.
 */
function markFeatures(m: Plan.PlanMarkLL): object[] {
  const c = box!.centre;
  const p = toLocal(m);
  const s = scenario?.scenario;
  const obj = s?.markers.task.objective ?? { x: p.x, y: p.y + 1 };
  let d = { x: obj.x - p.x, y: obj.y - p.y };
  const len = Math.hypot(d.x, d.y);
  // Too close to the objective to tell: face the way the platoon is advancing.
  if (len < 50 && s) d = { x: obj.x - s.markers.friendly[0].point.x, y: obj.y - s.markers.friendly[0].point.y };
  const n = Math.hypot(d.x, d.y) || 1;
  const dir = { x: d.x / n, y: d.y / n };
  const num = m.label.match(/ (\d+)$/)?.[1] ?? '';
  const withNum = (t: string) => (num ? `${t} ${num}` : t);
  const icon = (name: string, anchor: string, text: string, off: [number, number] = [0, 0]) => [
    { type: 'Feature', properties: { kind: 'icon', icon: name, anchor, text, off }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] } },
  ];
  const ownKind = s?.bgType === 'mechanised' ? 'mechanisedInfantry' : 'infantry';
  switch (m.kind) {
    case '1 Sect':
    case '2 Sect':
    case '3 Sect': {
      const { name, offset } = ensureSymbol(map, { identity: 'friend', echelon: 'section', kind: ownKind }, { designation: m.kind[0], higher: '2' });
      return icon(name, 'top-left', '', offset);
    }
    case 'Killing area':
      return areaPosition(c, p, dir, withNum('EA'), 240, 160);
    case 'Obstacle':
      return blockGraphic(c, p, dir, withNum('OBS'));
    case 'OP':
      return icon(ensurePointMeasure(map, 'op'), 'center', withNum('OP'));
    case 'Fire support':
      return supportByFire(c, p, dir, withNum('SBF'));
    case 'Attack by fire':
      return attackByFire(c, p, dir, withNum('ABF'));
    case 'FUP':
      return areaPosition(c, p, dir, withNum('FUP'));
    case 'Assault position':
      return areaPosition(c, p, dir, withNum('ASLT PSN'), 200);
    case 'Cut-off':
      return blockGraphic(c, p, dir, withNum('B'));
    case 'Pl HQ': {
      const { name, offset } = ensureSymbol(map, { identity: 'friend', echelon: 'platoon', hq: true, kind: ownKind }, { designation: '2', higher: 'B' });
      return icon(name, 'top-left', '', offset);
    }
    case 'RV':
      return icon(ensurePointMeasure(map, 'pin', withNum('RV')), 'bottom', '');
    default:
      return icon(ensurePointMeasure(map, 'pin', withNum('PT')), 'bottom', '');
  }
}

/** Draw the plan on the map and list it in the panel; set the tool buttons. */
function renderPlan() {
  const features: object[] = [];
  const pt = (p: Plan.LatLon) => ({ type: 'Point', coordinates: [p.lon, p.lat] });
  for (const w of Plan.ROUTE_WHO) {
    const r = plan.routes[w];
    if (r.length >= 2) features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: r.map((p) => [p.lon, p.lat]) } });
    for (const p of r) features.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: pt(p) });
    if (r.length) features.push({ type: 'Feature', properties: { kind: 'routeLabel', text: w }, geometry: pt(r[r.length - 1]) });
  }
  // Defence: once the situation develops, the sections and Pl HQ are shown where they now are (renderSituation).
  const shownElsewhere = (m: Plan.PlanMarkLL) => phase2Shown && scenario?.scenario?.problemType === 'defence' && (/^\d Sect$/.test(m.kind) || m.kind === 'Pl HQ');
  if (box) for (const m of plan.marks) if (!shownElsewhere(m)) features.push(...markFeatures(m));
  (map.getSource('plan') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features } as never);

  const items: HTMLElement[] = [];
  for (const w of Plan.ROUTE_WHO) {
    const r = plan.routes[w];
    if (r.length) items.push(el('li', `${Plan.WHO_NAME[w]} route: ${r.length} point${r.length > 1 ? 's' : ''}, ${ref8(r[0])} to ${ref8(r[r.length - 1])}`));
  }
  plan.marks.forEach((m, i) => {
    const li = el('li', `${m.label}: ${ref8(m)}`);
    if (!revealed) {
      const del = el('button', 'Remove', 'del') as HTMLButtonElement;
      del.addEventListener('click', () => {
        Plan.removeMark(plan, i);
        savePlanNow();
        renderPlan();
      });
      li.append(del);
    }
    items.push(li);
  });
  $('plan-list').replaceChildren(...items);

  const locked = revealed;
  for (const id of ['btn-plan-route', 'btn-plan-mark', 'btn-plan-here', 'btn-plan-undo']) ($(id) as HTMLButtonElement).disabled = locked;
  ($('sel-mark') as HTMLSelectElement).disabled = locked;
  ($('sel-route') as HTMLSelectElement).disabled = locked || planTool === 'route';
  for (const t of document.querySelectorAll<HTMLTextAreaElement>('#plan-answers textarea, #plan-answers2 textarea')) t.readOnly = locked;
  // Route buttons (✓ once drawn) and the palette of positions; the bar over the map while marking.
  const markKind = ($('sel-mark') as HTMLSelectElement).value;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.route-btn')) {
    const w = b.dataset.who as Plan.RouteWho;
    b.classList.toggle('done', plan.routes[w].length >= 2);
    b.classList.toggle('active', planTool === 'route' && w === ($('sel-route') as HTMLSelectElement).value);
    b.disabled = locked;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.pos-btn')) {
    b.classList.toggle('active', planTool === 'mark' && b.dataset.kind === markKind);
    b.disabled = locked;
  }
  const drawing = !!planTool && mode === 'problem' && !locked;
  $('map-toolbar').hidden = !drawing;
  if (drawing) {
    const w = ($('sel-route') as HTMLSelectElement).value as Plan.RouteWho;
    const n = plan.routes[w].length;
    $('map-toolbar-text').textContent =
      planTool === 'route' ? `${Plan.WHO_NAME[w]} route: tap each point in order (${n} so far)` : `Tap the map to place: ${markKind === 'Other' ? 'a point' : markKind}`;
  }
  $('btn-plan-route').classList.toggle('active', planTool === 'route');
  $('btn-plan-mark').classList.toggle('active', planTool === 'mark');
  const who = ($('sel-route') as HTMLSelectElement).value as Plan.RouteWho;
  $('btn-plan-route').textContent = planTool === 'route' ? `Finish ${who} route` : plan.routes[who].length ? `Add to ${who} route` : `Draw ${who} route`;
  $('plan-mode').textContent = locked
    ? 'Your plan is fixed now the ground truth has been revealed.'
    : planTool === 'route'
      ? `Tap the map to add each point of the ${Plan.WHO_NAME[who]} route, in order. Tap "Finish ${who} route" when done.`
      : planTool === 'mark'
        ? `Tap the map where your ${($('sel-mark') as HTMLSelectElement).value} is to go.`
        : '';
}

function addPlanPoint(p: Plan.LatLon) {
  if (planTool === 'route') Plan.addRoutePoint(plan, ($('sel-route') as HTMLSelectElement).value as Plan.RouteWho, p);
  else if (planTool === 'mark') {
    Plan.addMark(plan, ($('sel-mark') as HTMLSelectElement).value, p);
    planTool = null; // one tap, one position
  }
  savePlanNow();
  renderPlan();
}

/** Text boxes for answers, saved as they are typed. */
function answerBoxes(id: string, questions: string[], answers: string[]) {
  $(id).replaceChildren(
    ...questions.map((q, i) => {
      const label = el('label', `${i + 1}. ${q}`);
      const t = document.createElement('textarea');
      t.value = answers[i] ?? '';
      t.addEventListener('input', () => {
        answers[i] = t.value;
        savePlanNow();
      });
      label.append(t);
      return label;
    }),
  );
}

/** With the ground truth: computed facts about the user's own plan (facts only, no verdict). */
async function showPlanFacts(show: boolean) {
  lastPlanFacts = null;
  $('sc-plan-facts-block').hidden = true;
  if (!show || !box || (!Plan.drawnRoutes(plan).length && !plan.marks.length)) return;
  try {
    const f = await engine.planFacts(planInput());
    lastPlanFacts = f;
    const items: HTMLElement[] = [];
    if (f.route.length) items.push(el('li', f.route.join(' ')));
    for (const p of f.positions) {
      const li = el('li', `${p.label}:`);
      const ul = document.createElement('ul');
      ul.append(...p.facts.map((t) => el('li', t)));
      li.append(ul);
      items.push(li);
    }
    $('sc-plan-facts').replaceChildren(...items);
    $('sc-plan-facts-block').hidden = false;
  } catch (err) {
    status(`Could not work out facts for your plan: ${(err as Error).message}`);
  }
}

$('btn-plan-route').addEventListener('click', () => {
  planTool = planTool === 'route' ? null : 'route';
  renderPlan();
});
$('btn-plan-mark').addEventListener('click', () => {
  planTool = planTool === 'mark' ? null : 'mark';
  renderPlan();
});
$('sel-mark').addEventListener('change', () => renderPlan());
// Route buttons: tap to draw that element's route; tap again (or Done) to finish.
for (const b of document.querySelectorAll<HTMLButtonElement>('.route-btn'))
  b.addEventListener('click', () => {
    const sel = $('sel-route') as HTMLSelectElement;
    planTool = planTool === 'route' && sel.value === b.dataset.who ? null : 'route';
    sel.value = b.dataset.who!;
    renderPlan();
  });
// Position palette: tap a symbol, then tap the map.
for (const b of document.querySelectorAll<HTMLButtonElement>('.pos-btn'))
  b.addEventListener('click', () => {
    const sel = $('sel-mark') as HTMLSelectElement;
    planTool = planTool === 'mark' && sel.value === b.dataset.kind ? null : 'mark';
    sel.value = b.dataset.kind!;
    renderPlan();
  });
$('btn-tb-undo').addEventListener('click', () => $('btn-plan-undo').click());
$('btn-tb-done').addEventListener('click', () => {
  planTool = null;
  renderPlan();
});
$('sel-route').addEventListener('change', () => renderPlan());
$('btn-plan-undo').addEventListener('click', () => {
  Plan.undo(plan);
  savePlanNow();
  renderPlan();
});
$('btn-plan-here').addEventListener('click', async () => {
  if (!box || !scenario?.scenario) return;
  try {
    await startWatching();
  } catch (err) {
    status((err as Error).message);
    return;
  }
  if (!myFix) return;
  const p = { lat: myFix.lat, lon: myFix.lon };
  const q = toLocal(p);
  if (Math.abs(q.x) > box.halfM || Math.abs(q.y) > box.halfM) {
    status('You are outside the problem area');
    return;
  }
  if (planTool === 'route') Plan.addRoutePoint(plan, ($('sel-route') as HTMLSelectElement).value as Plan.RouteWho, p);
  else Plan.addMark(plan, ($('sel-mark') as HTMLSelectElement).value, p);
  savePlanNow();
  renderPlan();
  status(`Marked at ${ref8(p)} (±${Math.round(myFix.accuracy)} m)`);
});

/** The problem text, for the exported record. */
function problemText(): { heading: string; lines: string[] }[] {
  const s = scenario!.scenario!;
  const out = [
    { heading: 'You', lines: [s.you, ...s.force.map((f) => `${f.element}: ${f.detail}`)] },
    { heading: 'Situation', lines: [s.situation] },
    { heading: 'Friendly forces', lines: s.friendlyForces.map((f) => `${f.element}: ${f.detail}`) },
    { heading: 'Your task', lines: [s.task_text] },
    { heading: 'Enemy', lines: [...s.enemy.map((e) => `${e.text} (${e.source}; reliability ${e.reliability})`), `Not known: ${s.enemyGaps}`] },
    { heading: 'Time and light', lines: [s.time] },
    { heading: 'Ground', lines: s.ground },
    { heading: 'Own troops', lines: [s.ownTroops] },
    { heading: 'Weather', lines: [s.weather] },
  ];
  if (phase2Shown) out.push({ heading: 'The situation develops', lines: [s.phase2.time, ...s.phase2.messages.map((m) => `${m.time}, from ${m.from}: "${m.text}"`)] });
  return out;
}

$('btn-plan-export').addEventListener('click', async () => {
  const s = scenario?.scenario;
  if (!s) return;
  const when = new Date();
  const text = Plan.planReport({
    title: s.title,
    problemText: problemText(),
    questions: s.questions,
    questions2: phase2Shown ? s.phase2.questions : null,
    plan,
    ref: ref8,
    facts: revealed ? lastPlanFacts : null,
    when,
  });
  const stamp = when.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `vital-ground-plan-${stamp}.txt`;
  const file = new File([text], name, { type: 'text/plain' });
  // On a phone, offer the share sheet (mail, messages, files); otherwise download.
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: s.title });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

// Resume the last problem after a reload (same ground, enemy, task, times and plan).
const savedPlan = Plan.loadSavedPlan();
if (savedPlan) {
  $('btn-resume').hidden = false;
  $('btn-resume').title = `Saved ${new Date(savedPlan.savedAt).toLocaleString('en-GB')}`;
}
$('btn-resume').addEventListener('click', async () => {
  const sp = Plan.loadSavedPlan();
  if (!sp) return;
  const k = sp.problem;
  ($('sel-type') as HTMLSelectElement).value = k.type ?? '';
  ($('sel-task') as HTMLSelectElement).value = k.task;
  ($('sel-info') as HTMLSelectElement).value = k.info;
  ($('sel-detail') as HTMLSelectElement).value = k.detail;
  await loadGround(k.lat, k.lon, k.detail as Detail);
  if (!box) return;
  await runScenario(k.seed, sp);
});


// Problem type and task (PO, 23 Nov 2026): the task list shows the tasks of the type chosen;
// choosing a task of the other type changes the type to match.
function syncTaskList() {
  const type = ($('sel-type') as HTMLSelectElement).value;
  const task = $('sel-task') as HTMLSelectElement;
  for (const o of Array.from(task.options)) o.hidden = !!type && !!o.dataset.type && o.dataset.type !== type;
  if (task.selectedOptions[0]?.hidden) task.value = '';
}
$('sel-type').addEventListener('change', syncTaskList);
$('sel-task').addEventListener('change', () => {
  const t = ($('sel-task') as HTMLSelectElement).selectedOptions[0]?.dataset.type;
  if (t) ($('sel-type') as HTMLSelectElement).value = t;
  syncTaskList();
});

// ---------- enemy company (DS view) ----------
let company: CompanyView | null = null;

function clearCompany() {
  company = null;
  $('co-result').hidden = true;
  $('btn-co-toggle').hidden = true;
  $('co-note').textContent = '';
  if (box) (map.getSource('company-zones') as ImageSource | undefined)?.updateImage({ url: BLANK, coordinates: boxCorners(box) });
  (map.getSource('company') as GeoJSONSource | undefined)?.setData(EMPTY);
}

function showCompany(show: boolean) {
  if (!box || !company?.found) return;
  const c = company;
  ($('btn-co-toggle') as HTMLButtonElement).textContent = show ? 'Hide layout' : 'Show layout';
  $('co-result').hidden = !show;
  (map.getSource('company-zones') as ImageSource).updateImage({
    url: show ? companyZonesImage(c.maskWidth!, c.maskHeight!, c.killZone!, c.deadGround!, c.mines ?? null) : BLANK,
    coordinates: boxCorners(box),
  });
  (map.getSource('company') as GeoJSONSource).setData(show ? (companyGeoJSON(box.centre, { platoons: c.platoons!, hq: c.hq, dummies: c.dummies, gaps: c.gaps, routes: c.routes }) as never) : EMPTY);
}

/** Elements forced on or off, or none (the generator decides). */
function companyOptions(): Partial<CompanyOptions> {
  if (($('co-auto') as HTMLInputElement).checked) return {};
  const on = (id: string) => ($(id) as HTMLInputElement).checked;
  return { mines: on('co-mines'), dummies: on('co-dummies'), dispersed: on('co-dispersed'), droneConcealment: on('co-drone'), isrFires: on('co-isr') };
}

const groundFitsCompany = () => !!ground && ground.width * ground.cellM === BOX_M;

async function runCompany(seed: number) {
  if (!box) return;
  clearCompany();
  $('company-block').hidden = false;
  setBusy(true);
  try {
    company = await engine.company(companyOptions(), seed, status, (($('sel-co-layout') as HTMLSelectElement).value || undefined) as LayoutType | undefined);
    $('co-note').textContent = company.featureNote;
    if (!company.found) {
      $('co-note').textContent = `${company.featureNote} ${company.log.join(' ')}`;
      status('No enemy company defence fits here');
      return;
    }
    const o = company.options!;
    const names: [keyof CompanyOptions, string][] = [['mines', 'mines and obstacles'], ['dummies', 'dummy positions'], ['dispersed', 'dispersed small teams'], ['droneConcealment', 'concealment from drones'], ['isrFires', 'drone surveillance and fires']];
    const on = names.filter(([k]) => o[k]).map(([, n]) => n);
    $('co-options-used').textContent = `Optional elements in this layout: ${on.length ? on.join(', ') : 'none'}.`;
    fillList('co-notes', company.notes ?? []);
    $('btn-co-toggle').hidden = false;
    showCompany(true);
    status(`Enemy company placed (${(company.timeMs / 1000).toFixed(1)} s)`);
  } catch (err) {
    status(`Could not place an enemy company: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-pt-company').addEventListener('click', async () => {
  if (!selected) return;
  if (!boxCentredOn(selected) || !groundFitsCompany()) {
    const p = selected;
    // A company needs the standard 8 km box: LIDAR 5 m in England, else standard data.
    await loadGround(p.lat, p.lon, 'medium');
    if (!boxCentredOn(p)) return;
    await selectPoint(p.lat, p.lon);
  }
  await runCompany(Math.floor(Math.random() * 1e9));
});
$('btn-co-new').addEventListener('click', () => void runCompany(Math.floor(Math.random() * 1e9)));
$('btn-co-toggle').addEventListener('click', () => showCompany($('co-result').hidden === true));
$('co-auto').addEventListener('change', () => {
  $('co-options').hidden = ($('co-auto') as HTMLInputElement).checked;
});

// ---------- enemy section problem ----------
let section: SectionView | null = null;

function clearSection() {
  section = null;
  $('section').hidden = true;
  $('sec-ds').hidden = true;
  $('btn-sec-ds').hidden = true;
  $('sec-note').textContent = '';
  if (box) (map.getSource('section-zones') as ImageSource | undefined)?.updateImage({ url: BLANK, coordinates: boxCorners(box) });
  (map.getSource('section') as GeoJSONSource | undefined)?.setData(EMPTY);
}

function showSectionText() {
  if (!section?.text) return;
  const t = section.text[($('sel-intel') as HTMLSelectElement).value as Intel];
  $('sec-title').textContent = t.title;
  $('sec-situation').textContent = t.situation;
  $('sec-enemy').textContent = t.enemy;
  $('sec-mission').textContent = t.mission;
  fillList('sec-req', t.requirement);
  $('sec-time').textContent = t.timeAllowed;
  fillList('sec-ds-list', t.dsNotes);
  $('sec-data').textContent = t.dataNote;
}

function showSectionLayout(show: boolean) {
  if (!box || !section?.ds) return;
  const ds = section.ds;
  $('sec-ds').hidden = !show;
  ($('btn-sec-ds') as HTMLButtonElement).textContent = show ? 'Hide enemy layout' : 'Reveal enemy layout';
  (map.getSource('section-zones') as ImageSource).updateImage({
    url: show ? sectionZonesImage(ds.maskWidth, ds.maskHeight, ds.killZone, ds.deadGround) : BLANK,
    coordinates: boxCorners(box),
  });
  (map.getSource('section') as GeoJSONSource).setData(show ? (sectionGeoJSON(box.centre, ds) as never) : EMPTY);
}

async function runSection(random?: number) {
  if (!box) return;
  clearSection();
  $('section-block').hidden = false;
  setBusy(true);
  status('Reading the ground…');
  try {
    section = await engine.section(($('sel-posture') as HTMLSelectElement).value as Posture, random, status);
    $('sec-note').textContent = section.featureNote;
    if (!section.found) {
      $('sec-note').textContent = `${section.featureNote} ${section.log.join(' ')} Try a point a little way off.`;
      status('No enemy position found here');
      return;
    }
    showSectionText();
    $('section').hidden = false;
    $('btn-sec-ds').hidden = false;
    showSectionLayout(false);
    status(`Enemy section placed (${(section.timeMs / 1000).toFixed(1)} s)`);
    $('section-block').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status(`Could not place an enemy section: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-pt-section').addEventListener('click', async () => {
  if (!selected) return;
  if (!boxCentredOn(selected) && !(await loadAtSelected())) return;
  await runSection();
});
$('btn-sec-new').addEventListener('click', () => void runSection(Math.random()));
$('btn-sec-ds').addEventListener('click', () => showSectionLayout($('sec-ds').hidden === true));
$('sel-intel').addEventListener('change', showSectionText);
$('sel-posture').addEventListener('change', () => {
  if (section) void runSection();
});

// ---------- tactical problem ----------
let problem: ProblemView | null = null;

function clearProblem() {
  problem = null;
  $('problem').hidden = true;
  $('pr-ds').hidden = true;
  $('btn-ds').hidden = true;
  $('pr-log').hidden = true;
  $('pr-features').textContent = '';
  (map.getSource('problem') as GeoJSONSource | undefined)?.setData(EMPTY);
  (map.getSource('ds') as GeoJSONSource | undefined)?.setData(EMPTY);
}

function fillList(id: string, items: string[]) {
  const el = $(id);
  el.replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

async function setProblem() {
  if (!box) return;
  if (!groundFitsProblems()) {
    // The problem engine works on a 4 km box at 10 m: LIDAR in England, else standard.
    status('Loading the 4 km box at 10 m for the problem…');
    const c = box.centre;
    await loadGround(c.lat, c.lon, 'problem');
    if (!box || !groundFitsProblems()) return;
  }
  clearProblem();
  setBusy(true);
  status('Reading the ground…');
  try {
    problem = await engine.problem(status);
    $('pr-features').textContent = problem.featureNote;
    fillList('pr-log-list', problem.log);
    $('pr-log').hidden = false;
    if (!problem.found || !problem.text) {
      status('No good problem on this ground');
      $('pr-features').textContent =
        `${problem.featureNote} This ground offers no problem with a real dilemma that passes the quality gate. ` +
        'Try loading ground a little way off. See below for why.';
      return;
    }
    const t = problem.text;
    $('pr-title').textContent = t.title;
    $('pr-gs').textContent = t.generalSituation;
    $('pr-ss').textContent = t.specialSituation;
    fillList('pr-req', t.requirement);
    $('pr-time').textContent = t.timeAllowed;
    fillList('pr-ds-list', t.dsNotes);
    $('pr-data').textContent = t.dataNote;
    $('problem').hidden = false;
    $('btn-ds').hidden = false;
    ($('btn-ds') as HTMLButtonElement).textContent = 'Reveal the ground truth';
    (map.getSource('problem') as GeoJSONSource).setData(problemGeoJSON(box.centre, problem.nai!, problem.route ?? []) as never);
    status(`Problem set (${(problem.timeMs / 1000).toFixed(1)} s)`);
  } catch (err) {
    status(`Could not set a problem: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-problem').addEventListener('click', () => void setProblem());
$('btn-ds').addEventListener('click', () => {
  if (!problem?.ds || !box) return;
  const showing = !$('pr-ds').hidden;
  $('pr-ds').hidden = showing;
  (map.getSource('ds') as GeoJSONSource).setData(showing ? EMPTY : (dsGeoJSON(box.centre, problem.ds) as never));
  ($('btn-ds') as HTMLButtonElement).textContent = showing ? 'Reveal the ground truth' : 'Hide the ground truth';
});

// ---------- viewshed ----------
async function runViewshed(x: number, y: number) {
  if (!ground || !box) return;
  const obsH = Number(($('sel-obs') as HTMLSelectElement).value);
  const tgtH = Number(($('sel-target') as HTMLSelectElement).value);
  const range = Number(($('sel-range') as HTMLSelectElement).value);
  lastObserver = { x, y };
  const ll = localToLatLon(box.centre, x, y);
  (map.getSource('tap') as GeoJSONSource).setData(pointGeoJSON(ll.lon, ll.lat));
  selected = ll;
  status('Computing viewshed…');
  try {
    const useObstacles = ($('tg-obstacles') as HTMLInputElement).checked;
    const r = await engine.viewshed(x, y, obsH, tgtH, range, useObstacles, status);
    (map.getSource('viewshed') as ImageSource).updateImage({
      url: viewshedImage(ground.width, ground.height, ground.cellM, r.mask, { x, y }, range),
      coordinates: boxCorners(box),
    });
    const ref = gridRef(ll.lat, ll.lon, 4);
    $('vs-info').textContent =
      `From ${ref.ref} (ground ${Math.round(r.observerGroundM)} m): observer ${obsH} m, target ${tgtH} m. ` +
      `Sees ${Math.round(r.visibleShare * 100)}% of the ground within ${range.toLocaleString('en-GB')} m. ${r.obstaclesNote} (${r.timeMs} ms)`;
    status('Viewshed shown');
  } catch (err) {
    status(`Viewshed failed: ${(err as Error).message}`);
  }
}

// ---------- selecting a point ----------
let selected: { lat: number; lon: number } | null = null;

/** Grid bearing (degrees) and distance (m) from a to b, in BNG in Great Britain, else UTM. */
function gridBearingDistance(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  let ea: { e: number; n: number };
  let eb: { e: number; n: number };
  if (inGreatBritain(a.lat, a.lon) && inGreatBritain(b.lat, b.lon)) {
    const p = toBNG(a.lat, a.lon);
    const q = toBNG(b.lat, b.lon);
    ea = { e: p.easting, n: p.northing };
    eb = { e: q.easting, n: q.northing };
  } else {
    const p = toUTM(a.lat, a.lon);
    const q = toUTM(b.lat, b.lon);
    ea = { e: p.easting, n: p.northing };
    eb = { e: q.easting, n: q.northing };
  }
  const de = eb.e - ea.e;
  const dn = eb.n - ea.n;
  return { bearingDeg: ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360, distanceM: Math.hypot(de, dn) };
}

async function selectPoint(lat: number, lon: number) {
  selected = { lat, lon };
  (map.getSource('tap') as GeoJSONSource).setData(pointGeoJSON(lon, lat));
  const ref = gridRef(lat, lon, 4);
  $('pt-ref').textContent = ref.ref;
  const parts: string[] = [];
  let inBox = false;
  if (box) {
    const p = latLonToLocal(box.centre, lat, lon);
    inBox = Math.abs(p.x) <= box.halfM && Math.abs(p.y) <= box.halfM;
    if (inBox) {
      const h = await engine.height(p.x, p.y);
      if (h !== null) parts.push(`Height ${Math.round(h)} m`);
    }
  }
  if (myFix) {
    const { bearingDeg, distanceM } = gridBearingDistance(myFix, selected);
    const mils = Math.round((bearingDeg * 6400) / 360) % 6400;
    const dist = distanceM >= 1000 ? `${(distanceM / 1000).toFixed(2)} km` : `${Math.round(distanceM)} m`;
    parts.push(`${dist} from you, grid bearing ${String(mils).padStart(4, '0')} mils (${Math.round(bearingDeg)}°)`);
  }
  if (!box) parts.push('Load ground to see its height and run a viewshed.');
  else if (!inBox) parts.push('Outside the loaded box: no height or viewshed here.');
  $('pt-detail').textContent = parts.join(' · ');
  ($('btn-pt-vs') as HTMLButtonElement).disabled = !inBox;
  $('point-block').hidden = false;
  status(`Selected ${ref.ref}`);
  // On the Problem page, confirm on the map itself: one tap to choose, one to set (PO, 15 Nov 2026).
  if (mode === 'problem' && stage === 'start') showStartPopup(lat, lon, gridRef(lat, lon, 3).ref, myFix ? parts[parts.length - 1] : '');
}

/** A small card on the map at the chosen place: its grid reference and "Set a problem here". */
let startPopup: maplibregl.Popup | null = null;
function closeStartPopup() {
  startPopup?.remove();
  startPopup = null;
}
function showStartPopup(lat: number, lon: number, ref: string, fromYou: string) {
  closeStartPopup();
  const div = document.createElement('div');
  div.className = 'start-pop';
  div.append(el('div', ref, 'gr'));
  if (fromYou) div.append(el('div', fromYou.replace(/, grid bearing.*$/, ' from you'), 'detail'));
  const go = el('button', 'Set a problem here', 'primary') as HTMLButtonElement;
  go.addEventListener('click', () => {
    closeStartPopup();
    $('btn-pt-problem').click();
  });
  div.append(go);
  startPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '260px', className: 'start-popup', offset: 14 })
    .setLngLat([lon, lat])
    .setDOMContent(div)
    .addTo(map);
  startPopup.on('close', () => {
    startPopup = null;
    (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
  });
}

function clearPoint() {
  selected = null;
  (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
  $('point-block').hidden = true;
}

// A single tap or click selects a point. The first tap of a double tap
// (which zooms) must not, so wait briefly to see whether a second follows.
let tapTimer: number | undefined;
map.on('click', (e: MapMouseEvent) => {
  if (tapTimer !== undefined) {
    clearTimeout(tapTimer);
    tapTimer = undefined;
    return; // second tap of a double tap: leave it to the zoom
  }
  const { lat, lng } = e.lngLat;
  tapTimer = window.setTimeout(() => {
    tapTimer = undefined;
    if (planTool && scenario?.scenario && !revealed && mode === 'problem') addPlanPoint({ lat, lon: lng });
    // Selecting a point: on the Start stage of the Problem page, or anywhere on the Developer page.
    else if (mode === 'dev' || (mode === 'problem' && stage === 'start')) void selectPoint(lat, lng);
  }, 300);
});

// On touchscreens the map reports only the first tap of a double tap, then
// zooms: if the map starts zooming or moving, that tap was not a selection.
const cancelTap = () => {
  if (tapTimer !== undefined) {
    clearTimeout(tapTimer);
    tapTimer = undefined;
  }
};
map.on('zoomstart', cancelTap);
map.on('dblclick', cancelTap);

$('btn-pt-vs').addEventListener('click', () => {
  if (!selected || !box) return;
  const p = latLonToLocal(box.centre, selected.lat, selected.lon);
  void runViewshed(p.x, p.y);
});
$('btn-pt-clear').addEventListener('click', clearPoint);

// Crosshair: a fixed mark at the centre of the map; move the map under it.
class CrosshairControl implements maplibregl.IControl {
  private el = document.createElement('div');
  onAdd() {
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group ctrl-crosshair';
    const b = document.createElement('button');
    b.type = 'button';
    b.title = 'Crosshair: move the map under it to pick a point precisely';
    b.setAttribute('aria-label', 'Crosshair');
    b.textContent = '⌖';
    b.addEventListener('click', () => {
      const on = $('crosshair').hidden === true;
      $('crosshair').hidden = !on;
      $('btn-crosshair-select').hidden = !on;
      b.classList.toggle('on', on);
    });
    this.el.appendChild(b);
    return this.el;
  }
  onRemove() {
    this.el.remove();
  }
}
map.addControl(new CrosshairControl(), 'top-right');
$('btn-crosshair-select').addEventListener('click', () => {
  const c = map.getCenter();
  void selectPoint(c.lat, c.lng);
});

// ---------- buttons ----------
$('btn-here').addEventListener('click', async () => {
  status('Finding your position…');
  try {
    await startWatching();
    if (myFix) await loadGround(myFix.lat, myFix.lon);
  } catch (err) {
    status((err as Error).message);
  }
});

/** Is the loaded box centred on this point (within 50 m)? */
function boxCentredOn(p: { lat: number; lon: number }): boolean {
  if (!box) return false;
  const d = latLonToLocal(box.centre, p.lat, p.lon);
  return Math.hypot(d.x, d.y) < 50;
}

/** Load the standard box centred on the selected point, keeping the selection. */
async function loadAtSelected(): Promise<boolean> {
  if (!selected) {
    status('First select a point: tap the map, or use the ⌖ crosshair');
    return false;
  }
  const p = selected;
  await loadGround(p.lat, p.lon);
  if (!boxCentredOn(p)) return false; // loading failed; the status says why
  await selectPoint(p.lat, p.lon);
  return true;
}

$('btn-load-point').addEventListener('click', () => void loadAtSelected());

// "Set a problem here" now sets the infantry platoon scenario (PO, DECISIONS.md 125–126).
// The artillery problem (Template A) is kept in the code but no longer offered.
$('btn-pt-problem').addEventListener('click', async () => {
  if (!selected) return;
  if (!boxCentredOn(selected) || !groundFitsCompany()) {
    const p = selected;
    await loadGround(p.lat, p.lon, 'medium');
    if (!boxCentredOn(p)) return;
    await selectPoint(p.lat, p.lon);
  }
  await runScenario(Math.floor(Math.random() * 1e9));
});

// ---------- Problem page: Start ----------
$('btn-start-here').addEventListener('click', async () => {
  status('Finding your position…');
  try {
    await startWatching();
  } catch (err) {
    status((err as Error).message);
    return;
  }
  if (!myFix) return;
  const p = { lat: myFix.lat, lon: myFix.lon };
  if (!boxCentredOn(p) || !groundFitsCompany()) {
    await loadGround(p.lat, p.lon, 'medium');
    if (!boxCentredOn(p)) return;
  }
  await runScenario(Math.floor(Math.random() * 1e9));
});
$('btn-truth-export').addEventListener('click', () => $('btn-plan-export').click());

$('btn-vs-me').addEventListener('click', async () => {
  if (!box) return;
  try {
    await startWatching();
  } catch (err) {
    status((err as Error).message);
    return;
  }
  if (!myFix) return;
  const p = latLonToLocal(box.centre, myFix.lat, myFix.lon);
  if (Math.abs(p.x) > box.halfM || Math.abs(p.y) > box.halfM) {
    status('You are outside the loaded box');
    return;
  }
  void runViewshed(p.x, p.y);
});

$('btn-vs-clear').addEventListener('click', () => {
  if (!box) return;
  (map.getSource('viewshed') as ImageSource).updateImage({ url: BLANK, coordinates: boxCorners(box) });
  (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
  lastObserver = null;
  $('vs-info').textContent = '';
});

for (const id of ['sel-obs', 'sel-target', 'sel-range', 'tg-obstacles']) {
  $(id).addEventListener('change', () => {
    if (lastObserver) void runViewshed(lastObserver.x, lastObserver.y);
  });
}

const toggles: Record<string, string[]> = {
  'tg-hillshade': ['hillshade'],
  'tg-contours': ['contours', 'contour-labels'],
  'tg-grid': ['grid', 'grid-labels'],
};
for (const [id, layers] of Object.entries(toggles)) {
  $(id).addEventListener('change', (e) => {
    const vis = (e.target as HTMLInputElement).checked ? 'visible' : 'none';
    for (const l of layers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis);
  });
}

// If location permission was already granted, show position straight away.
navigator.permissions
  ?.query({ name: 'geolocation' as PermissionName })
  .then((p) => {
    if (p.state === 'granted') void startWatching().catch(() => undefined);
  })
  .catch(() => undefined);

// ---------- offline support ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

// Start on the Problem page, at the Start stage.
setMode('problem');
setStage('start');
