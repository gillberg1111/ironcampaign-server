import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { makeDb, addOwner, claimOwner } from './helpers.js';

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
      assert.match(html, /IronCampaign/);
      assert.match(html, /['"]\/api\/v1['"]/);
      assert.match(html, /login/);
      // Console is merged into Settings; pairing + device elements must exist
      assert.match(html, /id="phraseBox"/);
      assert.match(html, /id="devices"/);
      assert.match(html, /id="pairMsg"/);
    } finally { srv.close(); }
  });

  it('the console API path works with a console token from claim', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { token } = claimOwner(db, 'admin', 'password123');
      const res = await fetch(`${base}/api/v1/owner/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const { devices } = await res.json();
      assert.ok(Array.isArray(devices));
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

  it('owner.html has all six tab views (Today, Calendar, Sagas, History, Roster, Settings)', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    for (const tab of ['today', 'calendar', 'sagas', 'history', 'roster', 'settings']) {
      assert.match(html, new RegExp('id="view-' + tab + '"'), 'missing tab view: ' + tab);
    }
    assert.ok(!html.includes('data-tab="console"'), 'console tab must be removed');
  });

  it('owner.html has no TTRPG jargon in copy', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const buzz = ['roll [2-9]d', 'dice', 'saving throw', 'modifier', 'proficiency'];
    for (const b of buzz) {
      assert.ok(!new RegExp(b, 'i').test(html), 'TTRPG jargon found: ' + b);
    }
  });

  it('owner.html has no nudge/streak/reminder copy', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const buzz = ['streak', 'reminder', 'don\'t break', 'keep going!', 'you haven\'t', 'daily goal'];
    for (const b of buzz) {
      assert.ok(!new RegExp(b, 'i').test(html), 'nudge copy found: ' + b);
    }
  });

  it('owner.html stores console token in localStorage', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /localStorage/);
    assert.match(html, /ic_console_token/);
  });

  // XSS regression (security review of v2.35): synced names AND uuids are device-controlled;
  // JS arguments inside onclick attributes must be jsArg-encoded (JSON + HTML escape), never
  // built with raw \' quote concatenation, and the escaper must cover quotes.
  it('owner.html builds no onclick handlers by raw quote concatenation', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const lines = html.split('\n');
    const offenders = lines.filter(l => /onclick="[^"]*$/.test(l) === false && /onclick=/.test(l) && /\\'' \+|\+ '\\''/.test(l));
    assert.deepEqual(offenders, [], 'raw-quote onclick concatenation found');
    assert.match(html, /const jsArg = /, 'jsArg helper must exist');
    assert.match(html, /\[&<>"'`\]/, 'escaper must cover single quotes and backticks');
  });

  it('vocabulary.json is served and decodes correctly', async () => {
    const dataPath = path.resolve('src', 'data', 'vocabulary.json');
    const raw = fs.readFileSync(dataPath, 'utf8');
    const entries = JSON.parse(raw);
    assert.ok(Array.isArray(entries), 'vocabulary.json must be a JSON array');
    assert.ok(entries.length >= 10, 'must have at least 10 entries');

    const byTerm = Object.fromEntries(entries.map(e => [e.term, e]));
    assert.ok(byTerm.programs, 'must contain programs term');
    assert.equal(byTerm.programs.flavor, 'Sagas');
    assert.equal(byTerm.programs.serious, 'Programs');
    assert.ok(byTerm.villains, 'must contain villains term');
    assert.equal(byTerm.villains.flavor, 'Villains');
    assert.equal(byTerm.villains.serious, 'Goals');
    assert.ok(byTerm.encounter, 'must contain encounter term');
    assert.equal(byTerm.encounter.flavor, 'Encounter');
    assert.equal(byTerm.encounter.serious, 'Workout');
  });

  it('vocabulary.json is served as valid JSON from /vocabulary.json route', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await fetch(`${base}/vocabulary.json`);
      assert.equal(res.status, 200);
      const ct = res.headers.get('content-type');
      assert.ok(ct && ct.includes('json'), 'vocabulary.json served as JSON: ' + ct);
      const entries = await res.json();
      assert.ok(Array.isArray(entries));
      assert.ok(entries.length >= 10);
      const byTerm = Object.fromEntries(entries.map(e => [e.term, e]));
      assert.equal(byTerm.villains.serious, 'Goals');
    } finally { srv.close(); }
  });
});
