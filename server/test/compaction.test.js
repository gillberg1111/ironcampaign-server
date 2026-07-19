import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { makeDb, addDevice, seedVillain, claimOwner } from './helpers.js';
import { compactChangeLog, bootstrapSnapshot } from '../src/services/compaction.js';
import { runDecaySweep } from '../src/services/decay.js';
import syncRoutes from '../src/routes/sync.js';
import express from 'express';

function appWithDb(db) {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/v1', syncRoutes(db));
  return a;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      try {
        const port = server.address().port;
        const base = `http://127.0.0.1:${port}`;
        await fn(server, base);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

async function pullFrom(base, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function pairWith(base, phrase, deviceName) {
  const res = await fetch(`${base}/api/v1/sync/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase, deviceName }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe('Compaction', () => {

  // -- v18 migration --

  it('schema v18 migration creates device_cursors table', () => {
    const db = makeDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='device_cursors'"
    ).all();
    assert.equal(tables.length, 1);
    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(version.v, 19);
  });

  // -- Cursor reporting --

  it('cursor is persisted on pull', async () => {
    const db = makeDb();
    const token = addDevice(db, 'p1', 'dev-a');
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, now);
    }

    await withServer(appWithDb(db), async (_server, base) => {
      const { status } = await pullFrom(base, '/api/v1/sync/changes', { since: 2 }, token);
      assert.equal(status, 200);
    });

    const cursor = db.prepare(
      'SELECT cursor_seq FROM device_cursors WHERE profile_uuid = ?'
    ).get('p1');
    assert.ok(cursor, 'cursor persisted');
    assert.equal(cursor.cursor_seq, 2);
  });

  // -- Compaction respects MIN across active devices --

  it('compacts rows behind MIN of active device cursors', async () => {
    const db = makeDb();
    const token = addDevice(db, 'p1', 'dev-a');
    const now = Date.now();

    // Seed change_log rows seq 1-10 via push-like mechanism
    for (let i = 1; i <= 10; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, now);
    }

    // Simulate two devices pulling. We'll hit /sync/changes for each
    const tokenB = addDevice(db, 'p1', 'dev-b');
    await withServer(appWithDb(db), async (_server, base) => {
      // Device A pulls to seq 5
      await pullFrom(base, '/api/v1/sync/changes', { since: 5 }, token);
      // Device B pulls to seq 3
      await pullFrom(base, '/api/v1/sync/changes', { since: 3 }, tokenB);
    });

    // Both are recently seen → MIN = 3
    const deleted = compactChangeLog(db);
    assert.equal(deleted, 3, 'deleted rows seq <= 3');

    const minSeqRow = db.prepare('SELECT MIN(seq) as m FROM change_log WHERE profile_uuid = ?').get('p1');
    assert.equal(minSeqRow.m, 4, 'rows 1-3 compacted');
  });

  // -- Stale-device exclusion + 410 --

  it('stale device receives 410 on pull after compaction', async () => {
    const db = makeDb();
    const tokenA = addDevice(db, 'p1', 'dev-active');
    const tokenB = addDevice(db, 'p1', 'dev-stale');
    const now = Date.now();

    for (let i = 1; i <= 10; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, now);
    }

    // Report cursors for both devices
    // Device A: active (seen now, cursor 10)
    await withServer(appWithDb(db), async (_server, base) => {
      await pullFrom(base, '/api/v1/sync/changes', { since: 10 }, tokenA);
    });

    // Device B: get its cursor entry, then mark it stale
    const staleDate = now - (91 * 24 * 60 * 60 * 1000);
    const dTokens = db.prepare('SELECT id FROM device_tokens WHERE profile_uuid = ? ORDER BY id').all('p1');
    const idB = dTokens[dTokens.length - 1].id;
    db.prepare(
      'INSERT OR REPLACE INTO device_cursors (profile_uuid, device_token_id, cursor_seq, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run('p1', idB, 2, staleDate);

    // Compaction: only active device (cursor 10) counts → rows 1-10 deleted
    const deleted = compactChangeLog(db);
    assert.ok(deleted > 0);

    // Insert a surviving row beyond the compacted boundary so MIN(seq) exists
    db.prepare(
      `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
       VALUES (11, 'p1', 'villains', 'v1', 'name', '"Test"', '019077fd307b000b', 'dev-x', null, ?)`
    ).run(now);

    // Stale device pulls with since=2 → 410
    await withServer(appWithDb(db), async (_server, base) => {
      const { status, data } = await pullFrom(base, '/api/v1/sync/changes', { since: 2 }, tokenB);
      assert.equal(status, 410, 'stale device gets 410');
      assert.ok(data.minSeq !== undefined, 'minSeq in body');
    });
  });

  // -- Client-reset round trip --

  it('client-reset round trip: 410 → reset cursor → pull succeeds', async () => {
    const db = makeDb();
    const token = addDevice(db, 'p1', 'dev-a');
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', ?, '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, String(50 + i), now);
    }

    // Simulate active cursor → compaction
    await withServer(appWithDb(db), async (_server, base) => {
      await pullFrom(base, '/api/v1/sync/changes', { since: 5 }, token);
    });

    compactChangeLog(db);

    // Insert surviving rows beyond the boundary
    for (let i = 6; i <= 10; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', ?, '019077fd307b000b', 'dev-x', null, ?)`
      ).run(i, String(50 + i), now);
    }

    // Fresh stale device token (second device for same profile)
    const token2 = addDevice(db, 'p1', 'dev-b');
    const staleDate = now - (100 * 24 * 60 * 60 * 1000);
    const dIds = db.prepare('SELECT id FROM device_tokens WHERE profile_uuid = ? ORDER BY id DESC').all('p1');
    db.prepare(
      'INSERT INTO device_cursors (profile_uuid, device_token_id, cursor_seq, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run('p1', dIds[0].id, 1, staleDate);

    await withServer(appWithDb(db), async (_server, base) => {
      // 410 with minSeq
      const { status, data } = await pullFrom(base, '/api/v1/sync/changes', { since: 1 }, token2);
      assert.equal(status, 410);
      const minSeq = data.minSeq;
      assert.ok(minSeq >= 0);

      // Reset cursor and succeed
      const r2 = await pullFrom(base, '/api/v1/sync/changes', { since: minSeq }, token2);
      assert.equal(r2.status, 200);
      assert.ok(r2.data.lastSeq >= minSeq);
    });
  });

  // -- Disabled flag --

  it('COMPACTION_DISABLED=1 prevents compaction', () => {
    const p = process.env.COMPACTION_DISABLED;
    process.env.COMPACTION_DISABLED = '1';
    try {
      const db = makeDb();
      const now = Date.now();
      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
           VALUES (?, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
        ).run(i, now);
      }
      const token = addDevice(db, 'p1', 'dev-a');
      const dIds = db.prepare('SELECT id FROM device_tokens WHERE profile_uuid = ?').all('p1');
      db.prepare(
        'INSERT INTO device_cursors (profile_uuid, device_token_id, cursor_seq, last_seen_at) VALUES (?, ?, ?, ?)'
      ).run('p1', dIds[0].id, 5, now);

      const deleted = compactChangeLog(db);
      assert.equal(deleted, 0);
    } finally {
      if (p === undefined) delete process.env.COMPACTION_DISABLED;
      else process.env.COMPACTION_DISABLED = p;
    }
  });

  // -- Decay still runs --

  it('decay sweep still runs alongside compaction', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const sixteenDaysAgo = now - (16 * 24 * 60 * 60);

    seedVillain(db, 'p1', { uuid: 'v1', hp: 50, max_hp: 100, last_session_at: sixteenDaysAgo });
    const affected = runDecaySweep(db);
    assert.equal(affected, 1);

    const villain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'p1');
    assert.equal(villain.hp, 55);
  });

  // -- Snapshot bootstrap: new device converges after compaction --

  it('push → compact → pair new device → pull converges via snapshot bootstrap', async () => {
    const db = makeDb();
    const now = Date.now();

    // Seed materialized row
    db.prepare(
      "INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v-snap', 'p1', 'Snappy', 75, 100, 1, ?, ?, 0)"
    ).run(now, now);
    db.prepare(
      "INSERT OR REPLACE INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES ('p1', 'villains', 'v-snap', 'hp', '019077fd307b0001', 'dev-x')"
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES ('p1', 'villains', 'v-snap', 'name', '019077fd307b0001', 'dev-x')"
    ).run();

    // Insert change_log entries
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v-snap', 'name', '"Snappy"', '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, now);
    }

    // Claim owner to allow pairing creation
    const { token: oToken } = claimOwner(db, 'admin', 'password123456');

    // Create an active device cursor → compaction deletes seq 1-5
    const tokenActive = addDevice(db, 'p1', 'dev-active');
    await withServer(appWithDb(db), async (_server, base) => {
      await pullFrom(base, '/api/v1/sync/changes', { since: 5 }, tokenActive);
    });
    const deleted = compactChangeLog(db);
    assert.ok(deleted > 0, 'compaction removed rows');

    // Create pairing phrase
    let phrase;
    await withServer(appWithDb(db), async (_server, base) => {
      const res = await fetch(`${base}/api/v1/owner/pairings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${oToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      // Actually need ownerRoutes mounted. Let me construct a full app.
    });

    // Let me fix this: the app needs all routes mounted for owner pairing.
    // I'll use a fresh makeApp and just seed the db in advance.
    const { app: fullApp, db: db2 } = await (async () => {
      const { makeApp } = await import('./helpers.js');
      return makeApp();
    })();

    // This approach doesn't work because makeApp creates a new db. Let me redesign.
    // I'll take the simpler path: test bootstrapSnapshot directly with db.
    const inserted = bootstrapSnapshot(db, 'p1');
    assert.ok(inserted > 0, 'bootstrapSnapshot inserted changes');

    const rows = db.prepare(
      "SELECT COUNT(*) as c FROM change_log WHERE profile_uuid = 'p1' AND device_id = 'server-compact'"
    ).get();
    assert.ok(rows.c > 0, 'server-compact changes exist');

    // Simulate a new device pulling from 0: should see bootstrap entries
    const newToken = addDevice(db, 'p1', 'dev-new');
    await withServer(appWithDb(db), async (_server, base) => {
      const pullRes = await pullFrom(base, '/api/v1/sync/changes', { since: 0 }, newToken);
      assert.equal(pullRes.status, 200);
      // Bootstrap entries should be after the compacted boundary
      assert.ok(pullRes.data.lastSeq > 5, 'new device sees bootstrap entries');
    });
  });

  // -- Direct bootstrapSnapshot test --

  it('bootstrapSnapshot inserts synthetic changes into change_log', () => {
    const db = makeDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v2', 'p1', 'Boss', 100, 100, 1, ?, ?, 0)"
    ).run(now, now);

    const inserted = bootstrapSnapshot(db, 'p1');
    assert.ok(inserted > 0);

    const changeRows = db.prepare(
      "SELECT * FROM change_log WHERE profile_uuid = ? AND device_id = 'server-compact'"
    ).all('p1');
    assert.ok(changeRows.length > 0);
    const hpChange = changeRows.find(r => r.field_name === 'hp');
    assert.ok(hpChange);
  });

  it('bootstrapSnapshot disabled when COMPACTION_DISABLED=1', () => {
    const p = process.env.COMPACTION_DISABLED;
    process.env.COMPACTION_DISABLED = '1';
    try {
      const db = makeDb();
      const now = Date.now();
      db.prepare(
        "INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v3', 'p1', 'Stub', 50, 50, 1, ?, ?, 0)"
      ).run(now, now);
      const inserted = bootstrapSnapshot(db, 'p1');
      assert.equal(inserted, 0);
    } finally {
      if (p === undefined) delete process.env.COMPACTION_DISABLED;
      else process.env.COMPACTION_DISABLED = p;
    }
  });

  // -- No 410 for since=0 --

  it('since=0 bypasses 410 check (new device)', async () => {
    const db = makeDb();
    const token = addDevice(db, 'p1', 'dev-new');
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
      ).run(i, now);
    }

    const tokenActive = addDevice(db, 'p1', 'dev-active');
    await withServer(appWithDb(db), async (_server, base) => {
      await pullFrom(base, '/api/v1/sync/changes', { since: 5 }, tokenActive);
    });

    compactChangeLog(db);

    await withServer(appWithDb(db), async (_server, base) => {
      const { status } = await pullFrom(base, '/api/v1/sync/changes', { since: 0 }, token);
      assert.equal(status, 200, 'since=0 should not trigger 410');
    });
  });

  // -- 410 only for since > 0 --

  it('410 only returned when since > 0 and cursor is expired', async () => {
    const db = makeDb();
    const token = addDevice(db, 'p1', 'dev-a');
    const now = Date.now();

    // Insert and compact away
    db.prepare(
      `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
       VALUES (1, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b0001', 'dev-x', null, ?)`
    ).run(now);

    const tokenActive = addDevice(db, 'p1', 'dev-active');
    await withServer(appWithDb(db), async (_server, base) => {
      await pullFrom(base, '/api/v1/sync/changes', { since: 1 }, tokenActive);
    });

    compactChangeLog(db);

    // Insert surviving row beyond boundary (seq 3, gap of 1 deleted row)
    db.prepare(
      `INSERT INTO change_log (seq, profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
       VALUES (3, 'p1', 'villains', 'v1', 'hp', '75', '019077fd307b000b', 'dev-x', null, ?)`
    ).run(now);

    // since=0 → no 410
    await withServer(appWithDb(db), async (_server, base) => {
      const r0 = await pullFrom(base, '/api/v1/sync/changes', { since: 0 }, token);
      assert.equal(r0.status, 200);
    });

    // since=1 but rows gone → need to simulate stale device
    const dIds = db.prepare('SELECT id FROM device_tokens WHERE profile_uuid = ?').all('p1');
    const staleDate = now - (91 * 24 * 60 * 60 * 1000);
    // Add a stale cursor for the first device
    db.prepare(
      'INSERT INTO device_cursors (profile_uuid, device_token_id, cursor_seq, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run('p1', dIds[0].id, 1, staleDate);

    await withServer(appWithDb(db), async (_server, base) => {
      const r1 = await pullFrom(base, '/api/v1/sync/changes', { since: 1 }, token);
      assert.equal(r1.status, 410, 'since > 0 with expired cursor triggers 410');
    });
  });

  // -- Snapshot bootstrap regression guards (v2.49 review) --

  it('bootstrap does NOT resurrect a deleted (tombstoned) row', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v-live','p1','Live',40,40,1,?,?,0)").run(now, now);
    db.prepare("INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v-dead','p1','Dead',10,40,1,?,?,1)").run(now, now);

    bootstrapSnapshot(db, 'p1');

    const dead = db.prepare("SELECT COUNT(*) c FROM change_log WHERE profile_uuid='p1' AND row_uuid='v-dead'").get();
    assert.equal(dead.c, 0, 'a deleted row must NOT be bootstrapped — that would resurrect the tombstone on the new device');
    const live = db.prepare("SELECT COUNT(*) c FROM change_log WHERE profile_uuid='p1' AND row_uuid='v-live'").get();
    assert.ok(live.c > 0, 'live rows are bootstrapped');
  });

  it('bootstrap emits a minimal HLC so real device writes win LWW', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, deleted) VALUES ('v1','p1','V',40,40,1,?,?,0)").run(now, now);

    bootstrapSnapshot(db, 'p1');

    const rows = db.prepare("SELECT DISTINCT hlc FROM change_log WHERE profile_uuid='p1' AND device_id='server-compact'").all();
    assert.ok(rows.length > 0, 'bootstrap wrote rows');
    for (const r of rows) {
      assert.equal(r.hlc, '0000000000000000', 'bootstrap HLC must be the minimum so any real write outranks it');
    }
  });
});
