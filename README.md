# Kamenjak — offline map with GPS

[A single-page web app](https://sebfisch.github.io/Kamenjak/) that turns any photo or scanned map into a pannable,
zoomable map with live GPS tracking. Runs entirely in the browser — no server,
no account, no internet connection required after the initial load.

## Features

- **Any map image** — load a JPEG, PNG, or PDF from your device; stored in
  IndexedDB so it reloads automatically on the next visit
- **GPS tracking** — shows your location as a blue dot once calibrated
- **Calibration** — tap the crosshair button, walk to a few known spots, and
  confirm your position on the map; the app learns the mapping from GPS
  coordinates to image pixels using least-squares regression
- **Rotation-aware** — calibration uses a full affine transform, so maps where
  North is not aligned with the top work correctly
- **Position smoothing** — displayed location is a rolling weighted average of
  all GPS readings from the last 60 seconds, weighted by reported accuracy
- **Compass** — once calibrated, a needle in the top-right corner shows which
  direction on screen is North
- **Accuracy badge** — live ±N m indicator above the GPS button, colour-coded
  green / orange / red

## How to use

1. Open the app (hosted on GitHub Pages).
2. Tap the GPS button (bottom-right) to start location tracking.
3. Tap the crosshair button and walk to a recognisable spot on the map. Pan
   the map until the crosshair is exactly on your position, then tap
   **Set point**. Repeat from at least two other distinct spots — three points
   are needed to establish scale and rotation.
4. Your position appears as a blue dot. The compass shows which way North is.

To use a different map, tap the folder button and pick an image or PDF file.
Calibration is cleared automatically since it belongs to the previous map.

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
- Calibration data is stored in `localStorage`; map image in `IndexedDB`.
- No build step — the entire app is a single `index.html`.

---

> **About the name:** *Kamenjak* is the name of a nature reserve on the Istrian
> peninsula in Croatia (Rt Kamenjak). The default `map.jpg` is a photo of the
> tourist map board at the park entrance. That is where the first version of this
> app was developed and tested.
