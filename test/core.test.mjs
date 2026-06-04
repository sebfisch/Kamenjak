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
});

// ── Calibration persistence ───────────────────────────────────────────────────

describe('calibration persistence', () => {
  let h;
  before(async () => {
    h = await freshPage();
    // Inject 2 calibration points and save them to IDB.
    await h.page.evaluate(() => {
      calPoints = [
        { raw: { lat: 44.0, lng: 13.9 },   px: 100, py: 100, accuracy: 5, timestamp: 1 },
        { raw: { lat: 44.001, lng: 13.901 }, px: 200, py: 200, accuracy: 5, timestamp: 2 },
      ];
      savePoints();
      fitTransform();
      updateBadge();
    });
    // Wait for the async write to complete.
    await h.page.waitForTimeout(300);
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
    await h.page.evaluate(() => deleteMap(window._delIdB));
    await h.page.waitForTimeout(200);
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
    await h.page.evaluate(() => deleteMap('default'));
    await h.page.waitForTimeout(200);
    const after  = (await h.page.evaluate(idbGetAll)).filter(m => m.id).length;
    assert.equal(after, before);
  });
});
