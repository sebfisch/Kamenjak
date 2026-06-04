import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, launch, newPage, waitForApp, idbGetAll } from './helpers.mjs';

let server, browser, base;

before(async () => {
  server = await createServer();
  base   = server.url;
  browser = await launch();
});

after(async () => {
  await browser.close();
  server.close();
});

// Seed a legacy v1 IndexedDB + localStorage into an isolated browser context,
// then navigate to the app so migration runs. Returns the populated page handle.
async function seedLegacyAndLoad() {
  const h = await newPage(browser);

  // 1. Navigate to a blank same-origin page so we can run evaluate at this origin.
  await h.page.goto(base + '/blank', { waitUntil: 'load' });

  // 2. Write the legacy state into IDB v1 + localStorage.
  await h.page.evaluate(async () => {
    localStorage.setItem('kmap-pts2', JSON.stringify([
      { raw: { lat: 44,    lng: 13.9  }, px: 50,  py: 60,  accuracy: 5, timestamp: 1 },
      { raw: { lat: 44.01, lng: 13.91 }, px: 150, py: 160, accuracy: 5, timestamp: 2 },
    ]));
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('kamenjak-db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('maps');
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('maps', 'readwrite');
      tx.objectStore('maps').put(new Blob(['LEGACY-IMAGE-DATA'], { type: 'image/png' }), 'current');
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
    db.close();
  });

  // 3. Load the app — migration runs during startup.
  await h.page.goto(base + '/index.html', { waitUntil: 'load' });
  await waitForApp(h.page);

  return h;
}

// ── Legacy v1 migration ───────────────────────────────────────────────────────

describe('legacy v1 migration', () => {
  let h;
  before(async () => { h = await seedLegacyAndLoad(); });
  after(async  () => { await h.ctx.close(); });

  test('legacy calibration is restored as the active calibration', async () => {
    const pts = await h.page.evaluate(() => calPoints.length);
    assert.equal(pts, 2);
  });

  test('imported map record carries the 2 legacy calibration points', async () => {
    const metas   = await h.page.evaluate(idbGetAll);
    const imported = metas.find(m => m.id && !m.isDefault);
    assert.ok(imported, 'imported map record should exist');
    assert.equal(imported.calPoints.length, 2);
  });

  test('default map record is created alongside the imported map', async () => {
    const metas = await h.page.evaluate(idbGetAll);
    const def   = metas.find(m => m.isDefault);
    assert.ok(def, 'default map record should exist');
  });

  test('__state currentId points at the imported map, not "default"', async () => {
    const metas    = await h.page.evaluate(idbGetAll);
    const state    = metas.find(m => m.key === '__state');
    const imported = metas.find(m => m.id && !m.isDefault);
    assert.ok(state, '__state record should exist');
    assert.equal(state.currentId, imported.id);
    assert.notEqual(state.currentId, 'default');
  });

  test('legacy maps["current"] key is gone', async () => {
    const gone = await h.page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('kamenjak-db', 2);
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      });
      return new Promise((res, rej) => {
        const req = db.transaction('maps', 'readonly').objectStore('maps').get('current');
        req.onsuccess = () => res(req.result == null);
        req.onerror   = e => rej(e.target.error);
      });
    });
    assert.ok(gone, 'maps["current"] should no longer exist');
  });

  test('migration is idempotent: second reload keeps exactly 2 map records', async () => {
    await h.page.reload({ waitUntil: 'load' });
    await waitForApp(h.page);
    const metas = await h.page.evaluate(idbGetAll);
    const maps  = metas.filter(m => m.id);
    assert.equal(maps.length, 2);
  });

  test('calibration still present after idempotent reload', async () => {
    const pts = await h.page.evaluate(() => calPoints.length);
    assert.equal(pts, 2);
  });

  test('no JavaScript page errors during migration or reload', () => {
    assert.deepEqual(h.errors, []);
  });
});
