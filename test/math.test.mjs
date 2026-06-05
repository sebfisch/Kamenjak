import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, launch, newPage, waitForApp } from './helpers.mjs';

let server, browser, appUrl;

before(async () => {
  server = await createServer();
  appUrl = server.url + '/index.html';
  browser = await launch();
});

after(async () => {
  await browser.close();
  server.close();
});

async function freshPage() {
  const h = await newPage(browser);
  await h.page.goto(appUrl, { waitUntil: 'load' });
  await waitForApp(h.page);
  return h;
}

// ── geoToMeters ───────────────────────────────────────────────────────────────

describe('geoToMeters', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('reference point maps to (0, 0)', async () => {
    const r = await h.page.evaluate(() => geoToMeters({ lat: 44.0, lng: 13.9 }, 44.0, 13.9));
    assert.ok(Math.abs(r.u) < 1e-10, `u should be ~0, got ${r.u}`);
    assert.ok(Math.abs(r.v) < 1e-10, `v should be ~0, got ${r.v}`);
  });

  test('northward displacement produces positive v', async () => {
    const r = await h.page.evaluate(() => geoToMeters({ lat: 44.001, lng: 13.9 }, 44.0, 13.9));
    assert.ok(r.v > 0, `v should be positive for north offset, got ${r.v}`);
  });

  test('eastward displacement produces positive u', async () => {
    const r = await h.page.evaluate(() => geoToMeters({ lat: 44.0, lng: 13.901 }, 44.0, 13.9));
    assert.ok(r.u > 0, `u should be positive for east offset, got ${r.u}`);
  });
});

// ── fitFromPoints ─────────────────────────────────────────────────────────────

describe('fitFromPoints', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  test('returns null for empty array', async () => {
    const t = await h.page.evaluate(() => fitFromPoints([]));
    assert.equal(t, null);
  });

  test('returns null for single point', async () => {
    const t = await h.page.evaluate(() =>
      fitFromPoints([{ raw: { lat: 44, lng: 13.9 }, px: 100, py: 100 }])
    );
    assert.equal(t, null);
  });

  test('returns null for coincident GPS coords (degenerate matrix)', async () => {
    // Both points share the same lat/lng → geoToMeters returns {u:0,v:0} for both
    // → suv2 = 0 → matrix is singular → returns null
    const t = await h.page.evaluate(() =>
      fitFromPoints([
        { raw: { lat: 44, lng: 13.9 }, px: 100, py: 100 },
        { raw: { lat: 44, lng: 13.9 }, px: 200, py: 200 },
      ])
    );
    assert.equal(t, null);
  });

  test('round-trip: fit then apply recovers original pixel positions', async () => {
    const { ok, maxErr } = await h.page.evaluate(() => {
      const pts = [
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 200 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400 },
      ];
      const t = fitFromPoints(pts);
      if (!t) return { ok: false, maxErr: null };
      let maxErr = 0;
      for (const p of pts) {
        const out = applyTransform(t, p.raw);
        const err = Math.sqrt((out.px - p.px) ** 2 + (out.py - p.py) ** 2);
        if (err > maxErr) maxErr = err;
      }
      return { ok: true, maxErr };
    });
    assert.ok(ok, 'fitFromPoints should return a non-null transform');
    assert.ok(maxErr < 0.001, `round-trip pixel error too large: ${maxErr}`);
  });
});

// ── fitFromPoints (affine) ──────────────────────────────────────────────────

describe('fitFromPoints (affine mode)', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  test('returns null for fewer than 3 points', async () => {
    const t = await h.page.evaluate(() =>
      fitFromPoints([
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 200 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400 },
      ], 'affine')
    );
    assert.equal(t, null);
  });

  test('returns null for collinear points (degenerate matrix)', async () => {
    const t = await h.page.evaluate(() =>
      fitFromPoints([
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 100 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 200, py: 200 },
        { raw: { lat: 44.002, lng: 13.902 }, px: 300, py: 300 },
      ], 'affine')
    );
    assert.equal(t, null);
  });

  test('tags the transform with kind "affine"', async () => {
    const kind = await h.page.evaluate(() => {
      const t = fitFromPoints([
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 200 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400 },
        { raw: { lat: 44.002, lng: 13.899 }, px: 500, py: 150 },
      ], 'affine');
      return t && t.kind;
    });
    assert.equal(kind, 'affine');
  });

  test('round-trip: fit then apply recovers original pixel positions', async () => {
    const { ok, maxErr } = await h.page.evaluate(() => {
      const pts = [
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 200 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400 },
        { raw: { lat: 44.002, lng: 13.899 }, px: 500, py: 150 },
      ];
      const t = fitFromPoints(pts, 'affine');
      if (!t) return { ok: false, maxErr: null };
      let maxErr = 0;
      for (const p of pts) {
        const out = applyTransform(t, p.raw);
        const err = Math.sqrt((out.px - p.px) ** 2 + (out.py - p.py) ** 2);
        if (err > maxErr) maxErr = err;
      }
      return { ok: true, maxErr };
    });
    assert.ok(ok, 'affine fitFromPoints should return a non-null transform');
    assert.ok(maxErr < 0.001, `round-trip pixel error too large: ${maxErr}`);
  });

  test('fits a stretched map that similarity cannot (lower RMSE)', async () => {
    // Build pixel targets from a deliberately anisotropic map: the east axis is
    // scaled differently from the north axis, so no similarity transform fits.
    const { simRmse, affRmse } = await h.page.evaluate(() => {
      const lat0 = 44.0, lng0 = 13.9;
      const R = 6371000, rad = Math.PI / 180;
      const coslat0 = Math.cos(lat0 * rad);
      const gps = [
        { lat: 44.000, lng: 13.900 },
        { lat: 44.001, lng: 13.901 },
        { lat: 44.002, lng: 13.899 },
        { lat: 43.999, lng: 13.902 },
      ];
      const pts = gps.map(raw => {
        const u = (raw.lng - lng0) * coslat0 * R * rad;
        const v = (raw.lat - lat0) * R * rad;
        // 8 px/m east, 3 px/m north → pure stretch, no shear/rotation.
        const X = 8 * u + 1000, Y = 3 * v + 1000;
        return { raw, px: X, py: 1000 - Y };
      });
      const sim = fitFromPoints(pts, 'similarity');
      const aff = fitFromPoints(pts, 'affine');
      return { simRmse: rmseMetres(pts, sim), affRmse: rmseMetres(pts, aff) };
    });
    assert.ok(simRmse > 1, `similarity should misfit a stretched map, got ${simRmse}`);
    assert.ok(affRmse < 0.01, `affine should fit a stretched map, got ${affRmse}`);
  });
});

// ── applyTransform ────────────────────────────────────────────────────────────

describe('applyTransform', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('returns null for null transform', async () => {
    const r = await h.page.evaluate(() => applyTransform(null, { lat: 44, lng: 13.9 }));
    assert.equal(r, null);
  });
});

// ── pxPerMetre ────────────────────────────────────────────────────────────────

describe('pxPerMetre', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('returns 0 for null transform', async () => {
    const s = await h.page.evaluate(() => pxPerMetre(null));
    assert.equal(s, 0);
  });

  test('extracts uniform scale: {a:3, b:4} → 5', async () => {
    const s = await h.page.evaluate(() => pxPerMetre({ a: 3, b: 4 }));
    assert.ok(Math.abs(s - 5) < 1e-10, `expected 5, got ${s}`);
  });

  test('affine: √|det| of the linear part (8 px/m east, 2 px/m north → 4)', async () => {
    const s = await h.page.evaluate(() =>
      pxPerMetre({ kind: 'affine', a: 8, b: 0, c: 0, d: 2 })
    );
    assert.ok(Math.abs(s - 4) < 1e-10, `expected 4, got ${s}`);
  });
});

// ── pxPerMetreHoriz ───────────────────────────────────────────────────────────

describe('pxPerMetreHoriz', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('returns 0 for null transform', async () => {
    const s = await h.page.evaluate(() => pxPerMetreHoriz(null));
    assert.equal(s, 0);
  });

  test('similarity: equals the uniform scale (= pxPerMetre)', async () => {
    const { horiz, iso } = await h.page.evaluate(() => ({
      horiz: pxPerMetreHoriz({ a: 3, b: 4 }),
      iso: pxPerMetre({ a: 3, b: 4 }),
    }));
    assert.ok(Math.abs(horiz - 5) < 1e-10, `expected 5, got ${horiz}`);
    assert.ok(Math.abs(horiz - iso) < 1e-10, 'horizontal scale should match pxPerMetre for similarity');
  });

  test('affine pure stretch: picks the east (horizontal) scale, not √|det|', async () => {
    // 8 px/m east, 3 px/m north. Horizontal bar runs along image-X (east) → 8.
    const { horiz, iso } = await h.page.evaluate(() => ({
      horiz: pxPerMetreHoriz({ kind: 'affine', a: 8, b: 0, c: 0, d: 3 }),
      iso: pxPerMetre({ kind: 'affine', a: 8, b: 0, c: 0, d: 3 }),
    }));
    assert.ok(Math.abs(horiz - 8) < 1e-10, `expected 8, got ${horiz}`);
    assert.ok(Math.abs(iso - Math.sqrt(24)) < 1e-10, `geometric mean should be √24, got ${iso}`);
  });

  test('returns 0 for a degenerate (near-singular) linear part', async () => {
    const s = await h.page.evaluate(() =>
      pxPerMetreHoriz({ kind: 'affine', a: 0, b: 0, c: 0, d: 0 })
    );
    assert.equal(s, 0);
  });
});

// ── transformDiagnostics ──────────────────────────────────────────────────────

describe('transformDiagnostics', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  test('returns null for null transform', async () => {
    const d = await h.page.evaluate(() => transformDiagnostics(null));
    assert.equal(d, null);
  });

  test('similarity is conformal: relScale 1, shear 0, not reflected', async () => {
    const d = await h.page.evaluate(() => transformDiagnostics({ a: 6, b: 2 }));
    assert.ok(Math.abs(d.relScale - 1) < 1e-10, `relScale should be 1, got ${d.relScale}`);
    assert.ok(Math.abs(d.shearDeg) < 1e-10, `shear should be 0, got ${d.shearDeg}`);
    assert.equal(d.reflected, false);
  });

  test('affine pure stretch: relScale = max/min scale ratio, shear 0', async () => {
    // 8 px/m east, 3 px/m north → σmax/σmin = 8/3, no shear.
    const d = await h.page.evaluate(() =>
      transformDiagnostics({ kind: 'affine', a: 8, b: 0, c: 0, d: 3 })
    );
    assert.ok(Math.abs(d.relScale - 8 / 3) < 1e-10, `relScale should be 8/3, got ${d.relScale}`);
    assert.ok(Math.abs(d.shearDeg) < 1e-10, `shear should be 0, got ${d.shearDeg}`);
    assert.equal(d.reflected, false);
  });

  test('affine shear: east/north depart from perpendicular by a known angle', async () => {
    // east = (1, 0), north = (tan30°, 1): unit-length columns skewed by 30°.
    const d = await h.page.evaluate(() => {
      const k = Math.tan(30 * Math.PI / 180);
      return transformDiagnostics({ kind: 'affine', a: 1, b: k, c: 0, d: 1 });
    });
    assert.ok(Math.abs(Math.abs(d.shearDeg) - 30) < 1e-6, `shear should be ~30°, got ${d.shearDeg}`);
  });

  test('detects reflection (det < 0)', async () => {
    const d = await h.page.evaluate(() =>
      transformDiagnostics({ kind: 'affine', a: 8, b: 0, c: 0, d: -3 })
    );
    assert.equal(d.reflected, true);
  });

  test('derived from a fitted anisotropic transform', async () => {
    const d = await h.page.evaluate(() => {
      const lat0 = 44.0, lng0 = 13.9;
      const R = 6371000, rad = Math.PI / 180, coslat0 = Math.cos(lat0 * rad);
      const gps = [
        { lat: 44.000, lng: 13.900 },
        { lat: 44.001, lng: 13.901 },
        { lat: 44.002, lng: 13.899 },
        { lat: 43.999, lng: 13.902 },
      ];
      const pts = gps.map(raw => {
        const u = (raw.lng - lng0) * coslat0 * R * rad;
        const v = (raw.lat - lat0) * R * rad;
        const X = 8 * u + 1000, Y = 3 * v + 1000; // 8 px/m east, 3 px/m north
        return { raw, px: X, py: 1000 - Y };
      });
      return transformDiagnostics(fitFromPoints(pts, 'affine'));
    });
    assert.ok(Math.abs(d.relScale - 8 / 3) < 1e-3, `relScale should be ~8/3, got ${d.relScale}`);
    assert.ok(Math.abs(d.shearDeg) < 1e-3, `shear should be ~0, got ${d.shearDeg}`);
  });
});

// ── rmseMetres ────────────────────────────────────────────────────────────────

describe('rmseMetres', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  test('near-zero RMSE when all points are used to fit the transform', async () => {
    // 2 points exactly determine the 4-DOF similarity transform, so residuals
    // on those same 2 points must be zero (to floating-point precision).
    const rmse = await h.page.evaluate(() => {
      const pts = [
        { raw: { lat: 44.000, lng: 13.900 }, px: 100, py: 200 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400 },
      ];
      const t = fitFromPoints(pts);
      if (!t) return -1;
      return rmseMetres(pts, t);
    });
    assert.ok(rmse >= 0 && rmse < 0.01, `RMSE should be near 0, got ${rmse}`);
  });
});

// ── looResiduals ──────────────────────────────────────────────────────────────

describe('looResiduals', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  // Build pixel targets from a known similarity transform (a=6, b=2: uniform
  // scale + rotation, no shear). Every point is mutually consistent, so leaving
  // any one out still recovers the same transform.
  function consistentPts(n) {
    return `(() => {
      const lat0 = 44.0, lng0 = 13.9, R = 6371000, rad = Math.PI / 180;
      const coslat0 = Math.cos(lat0 * rad);
      const gps = [
        { lat: 44.000, lng: 13.900 }, { lat: 44.001, lng: 13.901 },
        { lat: 44.002, lng: 13.899 }, { lat: 43.999, lng: 13.902 },
        { lat: 44.0015, lng: 13.8985 },
      ].slice(0, ${n});
      return gps.map(raw => {
        const u = (raw.lng - lng0) * coslat0 * R * rad;
        const v = (raw.lat - lat0) * R * rad;
        const X = 6 * u - 2 * v + 1000, Y = 2 * u + 6 * v + 1000;
        return { raw, px: X, py: 1000 - Y, accuracy: 5, timestamp: 1 };
      });
    })()`;
  }

  test('returns [] below threshold (2 points, similarity)', async () => {
    const r = await h.page.evaluate(pts => looResiduals(pts, 'similarity'),
      await h.page.evaluate(consistentPts(2)));
    assert.deepEqual(r, []);
  });

  test('returns [] when affine has exactly its minimum (3 points)', async () => {
    const r = await h.page.evaluate(pts => looResiduals(pts, 'affine'),
      await h.page.evaluate(consistentPts(3)));
    assert.deepEqual(r, []);
  });

  test('one value per point at/above threshold', async () => {
    const simLen = await h.page.evaluate(pts => looResiduals(pts, 'similarity').length,
      await h.page.evaluate(consistentPts(3)));
    assert.equal(simLen, 3);
    const affLen = await h.page.evaluate(pts => looResiduals(pts, 'affine').length,
      await h.page.evaluate(consistentPts(4)));
    assert.equal(affLen, 4);
  });

  test('near-zero deviations when every point is mutually consistent', async () => {
    const r = await h.page.evaluate(pts => looResiduals(pts, 'similarity'),
      await h.page.evaluate(consistentPts(4)));
    assert.equal(r.length, 4);
    for (const d of r) assert.ok(d < 0.01, `LOO deviation should be ~0, got ${d}`);
  });

  test('an inconsistent point deviates more under LOO than its full-fit residual', async () => {
    const { loo, fullRes, looMean, fullRmse, bad } = await h.page.evaluate(basePts => {
      const pts = JSON.parse(JSON.stringify(basePts));
      const bad = 1;
      pts[bad].px += 40;   // pull one point off the consistent grid
      const T = fitFromPoints(pts, 'similarity');
      const loo = looResiduals(pts, 'similarity');
      const fullRes = pts.map(p => pixelResidualM(p, T));
      return { loo, fullRes, looMean: loo.reduce((a, b) => a + b, 0) / loo.length,
               fullRmse: rmseMetres(pts, T), bad };
    }, await h.page.evaluate(consistentPts(3)));

    // LOO never undershoots the full-fit residual: the full fit includes the
    // point it is scored against, so it always fits it at least as well.
    loo.forEach((d, i) => assert.ok(d >= fullRes[i] - 1e-6,
      `LOO[${i}]=${d} should be ≥ full residual ${fullRes[i]}`));
    // The offset point is much worse out-of-sample, dragging the mean above RMSE.
    assert.ok(loo[bad] > fullRes[bad] + 1, `offset point LOO ${loo[bad]} should exceed its residual ${fullRes[bad]}`);
    assert.ok(looMean > fullRmse, `mean LOO ${looMean} should exceed full RMSE ${fullRmse}`);
  });
});

// ── looStats ──────────────────────────────────────────────────────────────────

describe('looStats', () => {
  let h;
  before(async () => {
    h = await freshPage();
    await h.page.evaluate(() => { window.imgH = 1000; });
  });
  after(async () => { await h.ctx.close(); });

  function pts(n) {
    return `Array.from({ length: ${n} }, (_, i) => ({
      raw: { lat: 44 + i * 0.001, lng: 13.9 + (i % 2) * 0.0012 + i * 0.0001 },
      px: 100 + i * 50, py: 100 + (i % 3) * 37, accuracy: 5, timestamp: i + 1,
    }))`;
  }

  test('returns null below threshold (2 points)', async () => {
    const s = await h.page.evaluate(p => looStats(p, 'similarity'),
      await h.page.evaluate(pts(2)));
    assert.equal(s, null);
  });

  test('mean and median match a direct computation (odd count → middle value)', async () => {
    const { stats, manual } = await h.page.evaluate(p => {
      const r = looResiduals(p, 'similarity').filter(Number.isFinite);
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const srt = [...r].sort((a, b) => a - b), m = Math.floor(srt.length / 2);
      const median = srt.length % 2 ? srt[m] : (srt[m - 1] + srt[m]) / 2;
      return { stats: looStats(p, 'similarity'), manual: { mean, median, n: r.length } };
    }, await h.page.evaluate(pts(3)));
    assert.equal(stats.n, 3);
    assert.equal(stats.n, manual.n);
    assert.ok(Math.abs(stats.mean - manual.mean) < 1e-9, `mean ${stats.mean} vs ${manual.mean}`);
    assert.ok(Math.abs(stats.median - manual.median) < 1e-9, `median ${stats.median} vs ${manual.median}`);
  });

  test('median averages the middle two for an even count', async () => {
    const { stats, manual } = await h.page.evaluate(p => {
      const r = looResiduals(p, 'similarity').filter(Number.isFinite);
      const srt = [...r].sort((a, b) => a - b), m = srt.length / 2;
      const median = (srt[m - 1] + srt[m]) / 2;
      return { stats: looStats(p, 'similarity'), manual: { median, n: r.length } };
    }, await h.page.evaluate(pts(4)));
    assert.equal(stats.n, 4);
    assert.ok(Math.abs(stats.median - manual.median) < 1e-9, `median ${stats.median} vs ${manual.median}`);
  });
});

// ── niceScaleMetres ───────────────────────────────────────────────────────────

describe('niceScaleMetres', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('picks the largest 1/2/5 ×10ⁿ value not exceeding the max', async () => {
    const cases = [
      [130, 100], [80, 50], [12, 10], [9, 5], [1.5, 1], [0.8, 0.5],
      [100, 100], [50, 50], [1000, 1000],
    ];
    for (const [max, want] of cases) {
      const got = await h.page.evaluate(m => niceScaleMetres(m), max);
      assert.ok(Math.abs(got - want) < 1e-9, `niceScaleMetres(${max}) → ${got}, want ${want}`);
    }
  });

  test('result never exceeds the input', async () => {
    for (const max of [1, 3, 7, 23, 99, 4567]) {
      const got = await h.page.evaluate(m => niceScaleMetres(m), max);
      assert.ok(got <= max, `niceScaleMetres(${max}) = ${got} should be ≤ ${max}`);
    }
  });

  test('returns 0 for non-positive or non-finite input', async () => {
    for (const bad of [0, -5, Infinity, NaN]) {
      const got = await h.page.evaluate(m => niceScaleMetres(m), bad);
      assert.equal(got, 0, `niceScaleMetres(${bad}) should be 0, got ${got}`);
    }
  });
});

// ── formatScale ───────────────────────────────────────────────────────────────

describe('formatScale', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('renders metres below 1000 and kilometres at/above 1000', async () => {
    const cases = [[500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km']];
    for (const [m, want] of cases) {
      const got = await h.page.evaluate(x => formatScale(x), m);
      assert.equal(got, want, `formatScale(${m}) → "${got}", want "${want}"`);
    }
  });
});
