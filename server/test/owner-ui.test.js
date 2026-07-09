import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { makeDb, addOwner } from './helpers.js';

const htmlPath = path.resolve('public', 'owner.html');

describe('Owner console page', () => {
  it('GET /owner serves the HTML console', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await fetch(`${base}/owner`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Owner console/);
      assert.match(html, /\/api\/v1\/owner/);
    } finally { srv.close(); }
  });

  it('the console API path works with an owner key from the bootstrap', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { key } = addOwner(db, 'p1');
      const res = await fetch(`${base}/api/v1/owner/devices`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(res.status, 200);
      const { devices } = await res.json();
      assert.deepEqual(devices, []);
    } finally { srv.close(); }
  });

  // v2.23 — QR console
  it('GET /qr.js serves with correct content-type', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await fetch(`${base}/qr.js`);
      assert.equal(res.status, 200);
      const ct = res.headers.get('content-type');
      assert.ok(ct && (ct.includes('javascript') || ct.includes('text/js')), 'qr.js served as JavaScript: ' + ct);
    } finally { srv.close(); }
  });

  it('owner.html contains no external script or img origins', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const hits = html.match(/ (src|href)=["']https?:\/\//g);
    assert.equal(hits, null, 'owner.html must reference no external origins: ' + JSON.stringify(hits));
  });

  it('owner.html references vendored qr.js script', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /<script src="qr\.js"/);
  });
});
