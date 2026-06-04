# Kamenjak — offline map with GPS

[A single-page web app](https://sebfisch.github.io/Kamenjak/) that turns any photo or scanned map into a pannable,
zoomable map with live GPS tracking. Runs entirely in the browser — no server,
no account, no internet connection required after the initial load.

## Features

- **Any map image** — load a JPEG, PNG, or PDF from your device; stored in
  IndexedDB so it reloads automatically on the next visit
- **Multiple maps, each with its own calibration** — every map you load is kept,
  along with its calibration. Switch between maps from the Maps panel and each
  one comes back exactly as you left it; loading the same file again restores
  its calibration rather than starting over
- **GPS tracking** — shows your location as a blue dot once calibrated
- **Calibration** — tap the crosshair button, walk to a couple of known spots,
  and confirm your position on the map; two points are enough to establish scale,
  rotation, and position — more points reduce noise further
- **Similarity transform** — calibration fits a constrained transform (uniform
  scale + rotation + translation, no shear), so the map's right angles stay right
  angles; GPS coordinates are first projected to local Cartesian metres to remove
  the cos(latitude) distortion before fitting
- **Rotation-aware** — maps where North is not aligned with the top work correctly
- **Compass** — once calibrated, a needle in the top-right corner shows which
  direction on screen is North
- **Accuracy badge** — live ±N m indicator above the GPS button, colour-coded
  green / orange / red

## How to use

1. Open the app (hosted on GitHub Pages).
2. Tap the GPS button (bottom-right) to start location tracking.
3. Tap the crosshair button and walk to a recognisable spot on the map. Pan
   the map until the crosshair is exactly on your position, then tap
   **Set point**. One more point from a different spot is enough — two points
   determine scale and rotation exactly.
4. Your position appears as a blue dot. The compass shows which way North is.

To switch maps, tap the Maps button (above the GPS button). The panel lists every
map you have loaded — including the bundled default — showing how many calibration
points each has and when it was last used. Tap a map to switch to it; its
calibration is restored automatically. Tap **Load new map** to import another image
or PDF. Calibration for the current map is saved continuously, so changing maps and
coming back never loses your work. To remove a saved map, tap the ✕ on its row and
tap again to confirm (the bundled default cannot be removed).

## Calibration tips

- Spread your calibration spots as far apart as possible for the best transform.
- The accuracy badge shows GPS quality; calibrate when it is green (≤ 20 m).
- The app opens Google-Maps-style fresh GPS fixes every 30 seconds and whenever
  you switch back to the tab, to maintain WiFi-assisted accuracy.
- To review or remove individual points, open calibration mode — existing points
  appear on the map as orange crosses with accuracy circles. Tap a cross to see
  its GPS accuracy and fit residual, then delete it if needed. The ↺ button
  clears all points at once.

## Technical notes

- Built with [Leaflet](https://leafletjs.com/) (`L.CRS.Simple`) and
  [PDF.js](https://mozilla.github.io/pdf.js/), both self-hosted.
- Calibration uses a **similarity transform** (4 parameters: scale, rotation,
  x/y translation) fitted by least-squares over the normal equations. GPS
  coordinates are converted to local Cartesian metres (correcting for
  cos(latitude) compression of longitudes) before fitting, so the transform
  parameters are metric and shear-free by construction.
- Maps and their calibration are stored together in `IndexedDB` (one record per
  map, identified by a content hash so re-imports are de-duplicated). The map
  currently in view is remembered across reloads. Calibration from older versions
  (kept in `localStorage`) is migrated automatically on first launch.
- No build step — the entire app is a single `index.html`.

## Running the tests

The tests use [Playwright](https://playwright.dev/) for headless-browser automation
and Node's built-in test runner (`node:test`). Node 22 is required.

Install test dependencies once, then install the Chromium browser Playwright needs:

```sh
npm install
npx playwright install chromium
```

Run the suite:

```sh
npm test
```

The tests spin up a local HTTP server, launch a headless Chromium browser, and
exercise the app end-to-end across two test files:

- `test/core.test.mjs` — fresh install, Maps panel UI, per-map calibration
  persistence, map switching, dedup on re-import, and delete
- `test/migration.test.mjs` — one-time, idempotent migration from the legacy
  single-map + `localStorage` model to the current per-map IndexedDB model

---

> **About the name:** *Kamenjak* is the name of a nature reserve on the Istrian
> peninsula in Croatia (Rt Kamenjak). The default `map.jpg` is a photo of the
> tourist map board at the park entrance. That is where the first version of this
> app was developed and tested.
