import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, launch, newPage, waitForApp, idbGetAll } from './helpers.mjs';

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

// Helper: open a fresh isolated context (fresh IDB/localStorage), navigate
// to the app, and wait for startup. Returns { page, errors, ctx }.
async function freshPage() {
  const h = await newPage(browser);
  await h.page.goto(appUrl, { waitUntil: 'load' });
  await waitForApp(h.page);
  return h;
}

// ── Fresh install ─────────────────────────────────────────────────────────────

describe('fresh install', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('default map record is created', async () => {
    const metas = await h.page.evaluate(idbGetAll);
    const maps  = metas.filter(m => m.id);
    assert.equal(maps.length, 1);
    assert.ok(maps[0].isDefault);
    assert.equal(maps[0].id, 'default');
  });

  test('__state currentId is "default"', async () => {
    const metas = await h.page.evaluate(idbGetAll);
    const state = metas.find(m => m.key === '__state');
    assert.ok(state, '__state record should exist');
    assert.equal(state.currentId, 'default');
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Maps panel ────────────────────────────────────────────────────────────────

describe('maps panel', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('FAB opens the maps panel', async () => {
    await h.page.click('#load-btn');
    await h.page.waitForSelector('.map-row');   // rows render async after .active
    assert.ok(await h.page.isVisible('#maps-ui'));
  });

  test('panel shows exactly one row for the default map', async () => {
    const count = await h.page.locator('.map-row').count();
    assert.equal(count, 1);
  });

  test('Close button hides the panel', async () => {
    await h.page.click('#maps-close');
    await h.page.waitForFunction(() => !document.getElementById('maps-ui').classList.contains('active'));
    assert.ok(!(await h.page.isVisible('#maps-ui')));
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Calibration persistence ───────────────────────────────────────────────────

describe('calibration persistence', () => {
  let h;
  before(async () => {
    h = await freshPage();
    // Inject 2 calibration points and save them to IDB.
    await h.page.evaluate(async () => {
      calPoints = [
        { raw: { lat: 44.0, lng: 13.9 },   px: 100, py: 100, accuracy: 5, timestamp: 1 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 200, py: 200, accuracy: 5, timestamp: 2 },
      ];
      fitTransform();
      updateBadge();
      await savePoints();   // wait for the IDB write to actually land
    });
    // Reload — the app should restore the points.
    await h.page.reload({ waitUntil: 'load' });
    await waitForApp(h.page);
  });
  after(async () => { await h.ctx.close(); });

  test('calPoints restored across reload', async () => {
    const pts = await h.page.evaluate(() => calPoints.length);
    assert.equal(pts, 2);
  });

  test('calibration badge shows correct count', async () => {
    const badge = await h.page.textContent('#cal-count');
    assert.equal(badge.trim(), '2');
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Affine transform toggle ───────────────────────────────────────────────────

describe('affine transform toggle', () => {
  // Seed the active map with n calibration points and refresh the UI.
  async function seedPoints(page, n) {
    await page.evaluate(async (count) => {
      calPoints = Array.from({ length: count }, (_, i) => ({
        raw: { lat: 44 + i * 0.001, lng: 13.9 + (i % 2) * 0.001 },
        px: 100 + i * 50, py: 100 + (i % 2) * 40, accuracy: 5, timestamp: i + 1,
      }));
      fitTransform();
      updateBadge();
      await savePoints();
    }, n);
  }

  test('toggle is disabled below 3 points, enabled at 3', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 2);
      assert.equal(await h.page.evaluate(() => document.getElementById('cal-affine').disabled), true);
      await seedPoints(h.page, 3);
      assert.equal(await h.page.evaluate(() => document.getElementById('cal-affine').disabled), false);
    } finally { await h.ctx.close(); }
  });

  test('clicking the toggle switches the fit to affine', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 3);
      await h.page.evaluate(() => document.getElementById('cal-affine').click());
      const { mode, kind, active } = await h.page.evaluate(() => ({
        mode: transformMode, kind: T && T.kind,
        active: document.getElementById('cal-affine').classList.contains('active'),
      }));
      assert.equal(mode, 'affine');
      assert.equal(kind, 'affine');
      assert.equal(active, true);
    } finally { await h.ctx.close(); }
  });

  test('a disabled toggle ignores clicks (stays similarity)', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 2);
      await h.page.evaluate(() => document.getElementById('cal-affine').click());
      const mode = await h.page.evaluate(() => transformMode);
      assert.equal(mode, 'similarity');
    } finally { await h.ctx.close(); }
  });

  test('transform mode persists per-map across reload', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 3);
      await h.page.evaluate(async () => {
        document.getElementById('cal-affine').click();
        await saveTransformMode();
      });
      // The mode is stored in the map's meta record.
      const stored = await h.page.evaluate(idbGetAll);
      assert.equal(stored.find(m => m.id === 'default').transformMode, 'affine');
      // …and restored after a reload.
      await h.page.reload({ waitUntil: 'load' });
      await waitForApp(h.page);
      assert.equal(await h.page.evaluate(() => transformMode), 'affine');
    } finally { await h.ctx.close(); }
  });
});

// ── Leave-one-out summary ─────────────────────────────────────────────────────

describe('leave-one-out summary', () => {
  async function seedPoints(page, n) {
    await page.evaluate(count => {
      calPoints = Array.from({ length: count }, (_, i) => ({
        raw: { lat: 44 + i * 0.001, lng: 13.9 + (i % 2) * 0.0012 + i * 0.0001 },
        px: 100 + i * 50, py: 100 + (i % 3) * 37, accuracy: 5, timestamp: i + 1,
      }));
      fitTransform();
    }, n);
  }

  test('summary is empty below threshold and populated at/above it', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 2);
      assert.equal(await h.page.textContent('#cal-loo'), '');
      await seedPoints(h.page, 3);
      const txt = await h.page.textContent('#cal-loo');
      assert.match(txt, /Leave-one-out/);
      assert.match(txt, /mean/);
      assert.match(txt, /median/);
    } finally { await h.ctx.close(); }
  });

  test('selecting a point appends its LOO deviation to the residual line', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 3);
      await h.page.evaluate(() => openPtConfirm(0));
      const info = await h.page.textContent('#cal-pt-info');
      assert.match(info, /residual/);
      assert.match(info, /LOO/);
    } finally { await h.ctx.close(); }
  });

  test('affine mode appends scale-ratio and shear diagnostics; similarity does not', async () => {
    const h = await freshPage();
    try {
      await seedPoints(h.page, 4);
      // Similarity (default): geometry diagnostics are uninformative, so omitted.
      const sim = await h.page.textContent('#cal-loo');
      assert.doesNotMatch(sim, /scale ratio/);
      assert.doesNotMatch(sim, /shear/);
      // Switch to affine and re-fit: diagnostics appear alongside the LOO line.
      await h.page.evaluate(() => { transformMode = 'affine'; fitTransform(); });
      const aff = await h.page.textContent('#cal-loo');
      assert.match(aff, /Leave-one-out/);
      assert.match(aff, /scale ratio/);
      assert.match(aff, /shear/);
    } finally { await h.ctx.close(); }
  });

  test('selecting a point appends excluded-fit geometry in affine mode only', async () => {
    const h = await freshPage();
    try {
      // 4 points so the fit excluding one still leaves ≥3 for an affine refit.
      await seedPoints(h.page, 4);
      // Similarity (default): per-point line shows residual + LOO, no geometry.
      await h.page.evaluate(() => openPtConfirm(0));
      const sim = await h.page.textContent('#cal-pt-info');
      assert.match(sim, /residual/);
      assert.match(sim, /LOO/);
      assert.doesNotMatch(sim, /scale ratio/);
      assert.doesNotMatch(sim, /shear/);
      // Affine: the excluded-fit scale ratio and shear are appended.
      await h.page.evaluate(() => { transformMode = 'affine'; fitTransform(); openPtConfirm(0); });
      const aff = await h.page.textContent('#cal-pt-info');
      assert.match(aff, /residual/);
      assert.match(aff, /LOO/);
      assert.match(aff, /scale ratio/);
      assert.match(aff, /shear/);
    } finally { await h.ctx.close(); }
  });
});

// ── Per-map isolation ─────────────────────────────────────────────────────────

describe('per-map isolation', () => {
  let h, ids;
  before(async () => {
    h = await freshPage();
    ids = await h.page.evaluate(async () => {
      const mk = txt => new Blob([txt], { type: 'image/png' });
      const idA = await createOrGetMap(mk('MAP-A'), 'mapA.png');
      await activateMap(idA);
      // Calibrate map A with 3 points.
      calPoints = [
        { raw: { lat: 1,   lng: 1   }, px: 10, py: 10, accuracy: 5, timestamp: 1 },
        { raw: { lat: 1.1, lng: 1.1 }, px: 20, py: 20, accuracy: 5, timestamp: 2 },
        { raw: { lat: 1.2, lng: 1.0 }, px: 30, py: 15, accuracy: 5, timestamp: 3 },
      ];
      savePoints();
      const idB = await createOrGetMap(mk('MAP-B'), 'mapB.png');
      await activateMap(idB);
      return { idA, idB };
    });
  });
  after(async () => { await h.ctx.close(); });

  test('switching to a new map starts with 0 calibration points', async () => {
    const pts = await h.page.evaluate(() => calPoints.length);
    assert.equal(pts, 0);
  });

  test('switching back to map A restores its 3 calibration points', async () => {
    await h.page.evaluate(id => activateMap(id), ids.idA);
    const pts = await h.page.evaluate(() => calPoints.length);
    assert.equal(pts, 3);
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Dedup ─────────────────────────────────────────────────────────────────────

describe('dedup on re-import', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('identical blob bytes produce the same map id', async () => {
    const { id1, id2 } = await h.page.evaluate(async () => {
      const mk  = () => new Blob(['IDENTICAL-BYTES'], { type: 'image/png' });
      const id1 = await createOrGetMap(mk(), 'first-import.png');
      const id2 = await createOrGetMap(mk(), 'second-import.png');
      return { id1, id2 };
    });
    assert.equal(id1, id2);
  });

  test('dedup does not create a second meta record', async () => {
    const metas = await h.page.evaluate(idbGetAll);
    // Should have: default + the one deduplicated import = 2 map records.
    const maps = metas.filter(m => m.id);
    assert.equal(maps.length, 2);
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Delete ────────────────────────────────────────────────────────────────────

describe('delete', () => {
  let h;
  before(async () => {
    h = await freshPage();
    // Create maps A and B; activate A so B is inactive when deleted.
    await h.page.evaluate(async () => {
      const mk = txt => new Blob([txt], { type: 'image/png' });
      const idA = await createOrGetMap(mk('DEL-A'), 'delA.png');
      const idB = await createOrGetMap(mk('DEL-B'), 'delB.png');
      await activateMap(idA);
      window._delIdB = idB;
    });
  });
  after(async () => { await h.ctx.close(); });

  test('deleteMap removes the map record from IDB', async () => {
    const before = (await h.page.evaluate(idbGetAll)).filter(m => m.id).length;
    await h.page.evaluate(() => deleteMap(window._delIdB));   // Promise → awaited
    const after  = (await h.page.evaluate(idbGetAll)).filter(m => m.id).length;
    assert.equal(after, before - 1);
  });

  test('maps panel row count decrements after delete', async () => {
    await h.page.click('#load-btn');
    await h.page.waitForSelector('.map-row');   // rows render async after .active
    const count = await h.page.locator('.map-row').count();
    // default + A (B was deleted) = 2
    assert.equal(count, 2);
    await h.page.click('#maps-close');
  });

  test('default map cannot be deleted', async () => {
    const before = (await h.page.evaluate(idbGetAll)).filter(m => m.id).length;
    await h.page.evaluate(() => deleteMap('default'));   // Promise → awaited (no-op delete)
    const after  = (await h.page.evaluate(idbGetAll)).filter(m => m.id).length;
    assert.equal(after, before);
  });
});

// ── Calibration badge CSS state ───────────────────────────────────────────────

describe('calibration badge state', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('0 points: badge class is empty (hidden)', async () => {
    const cls = await h.page.evaluate(() => {
      calPoints = [];
      updateBadge();
      return document.getElementById('cal-count').className;
    });
    assert.equal(cls, '');
  });

  test('1 point: badge has class "one" (orange)', async () => {
    const cls = await h.page.evaluate(() => {
      calPoints = [{ raw: { lat: 44, lng: 13.9 }, px: 100, py: 100, accuracy: 5, timestamp: 1 }];
      updateBadge();
      return document.getElementById('cal-count').className;
    });
    assert.equal(cls, 'one');
  });

  test('2+ points: badge has class "many" (green)', async () => {
    const cls = await h.page.evaluate(() => {
      calPoints = [
        { raw: { lat: 44,     lng: 13.9   }, px: 100, py: 100, accuracy: 5, timestamp: 1 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 200, py: 200, accuracy: 5, timestamp: 2 },
      ];
      updateBadge();
      return document.getElementById('cal-count').className;
    });
    assert.equal(cls, 'many');
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Compass visibility ────────────────────────────────────────────────────────

describe('compass visibility', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('compass is not visible on fresh page (no calibration)', async () => {
    const visible = await h.page.evaluate(() =>
      document.getElementById('compass').classList.contains('visible')
    );
    assert.ok(!visible);
  });

  test('compass becomes visible after ≥2 calibration points are fit', async () => {
    const visible = await h.page.evaluate(() => {
      window.imgH = 1000;
      calPoints = [
        { raw: { lat: 44,     lng: 13.9   }, px: 100, py: 200, accuracy: 5, timestamp: 1 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400, accuracy: 5, timestamp: 2 },
      ];
      fitTransform();
      return document.getElementById('compass').classList.contains('visible');
    });
    assert.ok(visible);
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Scale bar visibility ──────────────────────────────────────────────────────

describe('scale bar visibility', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('scale bar is not visible on fresh page (no calibration)', async () => {
    const visible = await h.page.evaluate(() =>
      document.getElementById('scale-bar').classList.contains('visible')
    );
    assert.ok(!visible);
  });

  test('scale bar becomes visible and labelled after ≥2 calibration points are fit', async () => {
    // The scale needs the map image (imgH) and view to be ready; wait for it.
    await h.page.waitForFunction(() => typeof imgH !== 'undefined' && imgH > 0);
    const res = await h.page.evaluate(() => {
      calPoints = [
        { raw: { lat: 44,     lng: 13.9   }, px: 100, py: 200, accuracy: 5, timestamp: 1 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 300, py: 400, accuracy: 5, timestamp: 2 },
      ];
      fitTransform();
      return {
        visible: document.getElementById('scale-bar').classList.contains('visible'),
        label:   document.getElementById('scale-label').textContent,
        width:   parseFloat(document.getElementById('scale-track').style.width),
      };
    });
    assert.ok(res.visible, 'scale bar should be visible');
    assert.match(res.label, /^\d+(\.\d+)? (m|km)$/, `unexpected label "${res.label}"`);
    assert.ok(res.width > 0, `track width should be > 0, got ${res.width}`);
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Active map row highlight ──────────────────────────────────────────────────

describe('active map row highlight', () => {
  let h;
  before(async () => { h = await freshPage(); });
  after(async () => { await h.ctx.close(); });

  test('current map row has .active class in maps panel', async () => {
    await h.page.click('#load-btn');
    await h.page.waitForSelector('.map-row');
    const activeCount = await h.page.locator('.map-row.active').count();
    assert.equal(activeCount, 1);
    await h.page.click('#maps-close');
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});

// ── Delete active map falls back to default ───────────────────────────────────

describe('delete active map falls back to default', () => {
  let h;
  before(async () => {
    h = await freshPage();
    // Create map A and make it the active map.
    await h.page.evaluate(async () => {
      const idA = await createOrGetMap(new Blob(['FALLBACK-A'], { type: 'image/png' }), 'fallback.png');
      await activateMap(idA);
      window._fallbackId = idA;
    });
  });
  after(async () => { await h.ctx.close(); });

  test('deleting the active map switches currentMapId to "default"', async () => {
    await h.page.evaluate(() => deleteMap(window._fallbackId));   // Promise → awaited
    const id = await h.page.evaluate(() => currentMapId);
    assert.equal(id, 'default');
  });

  test('__state.currentId is "default" in IDB after fallback', async () => {
    const metas = await h.page.evaluate(idbGetAll);
    const state = metas.find(m => m.key === '__state');
    assert.ok(state, '__state record should exist');
    assert.equal(state.currentId, 'default');
  });

  test('no JS errors', () => { assert.deepEqual(h.errors, []); });
});
