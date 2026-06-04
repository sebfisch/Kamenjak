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
