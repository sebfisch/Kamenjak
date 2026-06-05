import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
};

// Static file server for the repo root.
// GET /blank returns a minimal HTML page (used to seed legacy IDB state at the
// same origin before navigating to the app).
export function createServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/blank') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body></body></html>');
      return;
    }
    try {
      const file = urlPath === '/' ? '/index.html' : urlPath;
      const buf  = await readFile(path.join(ROOT, file));
      const ext  = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        url:   `http://localhost:${port}`,
        close: () => server.close(),
      });
    });
  });
}

// Launch a Chromium browser instance.
export function launch() {
  return chromium.launch();
}

// Open a fresh browser context + page.
// Fresh context = isolated storage (IDB, localStorage) per test group.
// Returns { page, errors, ctx }.
export async function newPage(browser) {
  const errors = [];
  const ctx    = await browser.newContext();
  const page   = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  return { page, errors, ctx };
}

// Wait for the app's async startup to fully settle. Awaits window.__appReady,
// which resolves only after activateMap and its IndexedDB writes have committed,
// so a test can inject + persist state without a pending startup write clobbering
// it. The currentMapId check is a defensive fallback for the IDB-unavailable path.
export async function waitForApp(page) {
  await page.waitForFunction(() => window.__appReady !== undefined, { timeout: 8000 });
  await page.evaluate(() => window.__appReady);
  await page.waitForFunction(() => window.currentMapId !== null, { timeout: 8000 });
}

// Serialisable function: passed to page.evaluate to read all IDB meta records.
// The app uses a classic <script> tag so window.indexedDB is available.
export async function idbGetAll() {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('kamenjak-db', 2);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  return new Promise((res, rej) => {
    const tx  = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// Delete the IDB database so the next page load starts completely fresh.
// Call this before navigating, not after.
export function clearIDB(page) {
  return page.evaluate(() => {
    return new Promise(res => {
      const req = indexedDB.deleteDatabase('kamenjak-db');
      req.onsuccess = res;
      req.onerror   = res;   // resolve either way
    });
  });
}
