import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { makeDb, makeApp, postJson } from './helpers.js';
import { createPairing } from '../../questlog-critical/sync-auth/pairing.js';

describe('trust proxy', () => {
  it('is set to loopback', () => {
    const db = makeDb();
    const app = createApp(db);
    assert.equal(app.get('trust proxy'), 'loopback');
  });

  it('is never set to true', () => {
    const db = makeDb();
    const app = createApp(db);
    assert.notEqual(app.get('trust proxy'), true);
  });
});

describe('request logger', () => {
  let originalLog;
  let logs;

  before(() => {
    originalLog = console.log;
    logs = [];
    console.log = (...args) => logs.push(args.join(' '));
  });

  after(() => {
    console.log = originalLog;
    delete process.env.LOG_REQUESTS;
  });

  it('disabled by default', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      await fetch(`${base}/health`);
      assert.equal(logs.length, 0, 'no log output when LOG_REQUESTS not set');
    } finally {
      srv.close();
    }
  });

  it('emits exactly method path status duration_ms when enabled', async () => {
    process.env.LOG_REQUESTS = '1';
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;

    logs.length = 0;

    try {
      await fetch(`${base}/health`);
      await new Promise(r => setTimeout(r, 50));

      const logLine = logs.find(l => l.includes('/health'));
      assert.ok(logLine, 'log line exists for health request');

      const parts = logLine.split(' ');
      assert.equal(parts.length, 4, 'exactly four fields');
      assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(parts[0]), 'method is an HTTP verb');
      assert.ok(parts[1].startsWith('/'), 'path starts with /');
      assert.ok(!parts[1].includes('?'), 'path excludes query strings');
      assert.ok(/^\d{3}$/.test(parts[2]), 'status is a three-digit code');
      assert.ok(parseFloat(parts[3]) >= 0, 'duration_ms is non-negative');
    } finally {
      srv.close();
    }
  });

  it('pairing log line contains no phrase', async () => {
    process.env.LOG_REQUESTS = '1';
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;

    const { phrase } = await createPairing(db, 'profile-log-test');

    logs.length = 0;

    try {
      await postJson(`${base}/api/v1/sync/pair`, {
        phrase,
        deviceName: 'test-device',
      });

      await new Promise(r => setTimeout(r, 50));

      const pairLog = logs.find(l => l.includes('/sync/pair'));
      assert.ok(pairLog, 'log line exists for pairing request');
      assert.ok(!pairLog.includes(phrase), 'phrase absent from log line');
    } finally {
      srv.close();
    }
  });
});

describe('backup integrity', () => {
  it('.backup of in-memory db restores and passes integrity_check', async () => {
    const srcPath = path.join(os.tmpdir(), `backup-src-${Date.now()}.db`);
    const src = new Database(srcPath);
    src.prepare('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)').run();
    src.prepare('INSERT INTO test (id, val) VALUES (?, ?)').run(1, 'hello');
    src.prepare('INSERT INTO test (id, val) VALUES (?, ?)').run(2, 'world');

    const tmp = path.join(os.tmpdir(), `backup-test-${Date.now()}.db`);
    try {
      await src.backup(tmp);
      src.close();

      const dest = new Database(tmp);
      const row = dest.prepare('SELECT * FROM test ORDER BY id').all();
      assert.equal(row.length, 2);
      assert.deepStrictEqual(row[0], { id: 1, val: 'hello' });
      assert.deepStrictEqual(row[1], { id: 2, val: 'world' });

      const check = dest.pragma('integrity_check');
      assert.deepStrictEqual(check, [{ integrity_check: 'ok' }]);
      dest.close();
    } finally {
      try { src.close(); } catch (_) { /* ok */ }
      try { fs.unlinkSync(srcPath); } catch (_) { /* ok */ }
      try { fs.unlinkSync(tmp); } catch (_) { /* ok */ }
      try { fs.unlinkSync(tmp + '-wal'); } catch (_) { /* ok */ }
      try { fs.unlinkSync(tmp + '-shm'); } catch (_) { /* ok */ }
    }
  });
});

// 2.26.1 audit: explicit push batch cap
import { makeApp as makeApp2261, addDevice as addDevice2261, authHeader as authHeader2261, postJson as postJson2261 } from './helpers.js';
import { describe as describe2261, it as it2261 } from 'node:test';
import assert2261 from 'node:assert/strict';

describe2261('Push batch cap (2.26.1 audit)', () => {
  it2261('rejects >500 changes with 413', async () => {
    const { app, db } = makeApp2261();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice2261(db, 'p1');
      const changes = Array.from({ length: 501 }, (_, i) => (
        { table: 'villains', uuid: `v${i}`, field: 'name', value: 'x', hlc: '019077fd307b0001', deviceId: 'd' }
      ));
      const res = await postJson2261(`${base}/api/v1/sync/push`, { changes }, authHeader2261(token));
      assert2261.equal(res.status, 413);
      assert2261.equal(db.prepare('SELECT COUNT(*) c FROM villains').get().c, 0, 'nothing applied');
    } finally { srv.close(); }
  });
});

describe('GET /health (v2.54)', () => {
  it('returns uptime_s and schema_version', async () => {
    const db = makeDb();
    const app = createApp(db);
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.ok(typeof body.uptime_s === 'number');
      assert.ok(body.uptime_s >= 0);
      assert.ok(typeof body.schema_version === 'number');
      assert.ok(body.schema_version >= 1);
    } finally { srv.close(); }
  });
});
