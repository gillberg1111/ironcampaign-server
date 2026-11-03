import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { applyAdminPassword } from '../src/bootstrap.js';
import { issueSetupCode, setupCodeRequired } from '../src/routes/owner.js';
import { slidingWindowLimit } from '../src/middleware/rateLimit.js';
import { pack, assertAcceptableDrift, MAX_DRIFT_MS } from '../../questlog-critical/hlc-merge/hlc.js';
import { MAX_OPEN_PAIRINGS } from '../../questlog-critical/sync-auth/pairing.js';
import { makeApp, addDevice, claimOwner, authHeader, postJson, getJson } from './helpers.js';

describe('HLC drift guard', () => {
  it('allows a clock 60s ahead and refuses 60s + 1ms', () => {
    const now = 1_700_000_000_000;
    assert.equal(MAX_DRIFT_MS, 60_000);
    assert.doesNotThrow(() => assertAcceptableDrift(pack(now + MAX_DRIFT_MS, 0), now));
    assert.throws(() => assertAcceptableDrift(pack(now + MAX_DRIFT_MS + 1, 0), now), /too far ahead/);
  });
});

describe('Push accepts the good changes in a mixed batch', () => {
  it('rejects invalid changes one at a time and still applies the valid one', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1', 'phone');
      const now = Date.now();
      const good = pack(now, 1);
      const ahead = pack(now + 120_000, 1);
      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'villains', uuid: 'v-good', field: 'name', value: 'The Rust', hlc: good, deviceId: 'phone', changeId: 1 },
          { table: 'villains', uuid: 'v-bad-field', field: 'not_a_field', value: 'x', hlc: good, deviceId: 'phone', changeId: 2 },
          { table: 'villains', uuid: 'v-future', field: 'name', value: 'Tomorrow', hlc: ahead, deviceId: 'phone', changeId: 3 },
          { table: 'villains', uuid: 'v-malformed', field: 'name', value: 'Nope', hlc: 'not-an-hlc', deviceId: 'phone', changeId: 4 },
        ],
      }, authHeader(token));

      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 1);
      assert.equal(res.data.results.length, 1);
      assert.equal(res.data.results[0].decision, 'applied');
      assert.equal(res.data.results.some(r => r.decision === 'rejected'), false);
      assert.equal(res.data.rejected.length, 3);
      const reasons = res.data.rejected.map(r => r.reason).join('\n');
      assert.match(reasons, /not mutable/);
      assert.match(reasons, /too far ahead/);
      assert.match(reasons, /malformed hlc/);

      const rows = db.prepare('SELECT uuid FROM villains WHERE profile_uuid = ?').all('p1');
      assert.deepEqual(rows.map(r => r.uuid), ['v-good']);
    } finally { srv.close(); }
  });
});

describe('Token kind and console expiry', () => {
  it('a phone token syncs and cannot call the owner API', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1', 'phone');
      const sync = await getJson(`${base}/api/v1/sync/status`, authHeader(token));
      assert.equal(sync.status, 200);
      const owner = await getJson(`${base}/api/v1/owner/devices`, authHeader(token));
      assert.equal(owner.status, 401);
    } finally { srv.close(); }
  });

  it('logout revokes the console token, and an expired console token is refused', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { token } = claimOwner(db, 'admin', 'password123');
      const out = await postJson(`${base}/api/v1/owner/logout`, {}, authHeader(token));
      assert.equal(out.status, 200);
      assert.equal(out.data.revoked, true);
      const after = await getJson(`${base}/api/v1/owner/devices`, authHeader(token));
      assert.equal(after.status, 401);

      const { token: fresh } = claimOwner(db, 'admin', 'password123');
      db.prepare("UPDATE device_tokens SET expires_at = ? WHERE kind = 'console' AND revoked_at IS NULL")
        .run(Date.now() - 1000);
      const owner = await getJson(`${base}/api/v1/owner/devices`, authHeader(fresh));
      assert.equal(owner.status, 401);
      const sync = await getJson(`${base}/api/v1/sync/status`, authHeader(fresh));
      assert.equal(sync.status, 401);
    } finally { srv.close(); }
  });

  it('migration marks existing Web console rows as console and leaves phones alone', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare('DELETE FROM schema_version WHERE version >= 21').run();
    const created = Date.now() - 1000;
    db.prepare(
      'INSERT INTO device_tokens (profile_uuid, token_sha256, device_name, created_at) VALUES (?, ?, ?, ?)'
    ).run('p', 'console-hash', 'Web console', created);
    db.prepare(
      'INSERT INTO device_tokens (profile_uuid, token_sha256, device_name, created_at) VALUES (?, ?, ?, ?)'
    ).run('p', 'phone-hash', 'iPhone', created);
    migrate(db);

    const consoleRow = db.prepare("SELECT kind, expires_at FROM device_tokens WHERE token_sha256 = 'console-hash'").get();
    const phoneRow = db.prepare("SELECT kind, expires_at FROM device_tokens WHERE token_sha256 = 'phone-hash'").get();
    assert.equal(consoleRow.kind, 'console');
    assert.ok(consoleRow.expires_at > Date.now());
    assert.equal(phoneRow.kind, 'device');
    assert.equal(phoneRow.expires_at, null);
  });
});

describe('Owner claim setup code', () => {
  it('requires the boot code once one has been issued', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const code = issueSetupCode(db);
      assert.equal(setupCodeRequired(db), true);
      const missing = await postJson(`${base}/api/v1/owner/claim`, { username: 'admin', password: 'password123' });
      assert.equal(missing.status, 403);
      const wrong = await postJson(`${base}/api/v1/owner/claim`, { username: 'admin', password: 'password123', setupCode: 'nope' });
      assert.equal(wrong.status, 403);
      const ok = await postJson(`${base}/api/v1/owner/claim`, { username: 'admin', password: 'password123', setupCode: code });
      assert.equal(ok.status, 201);
      assert.equal(setupCodeRequired(db), false);
      const status = await getJson(`${base}/api/v1/owner/status`);
      assert.equal(status.data.claimed, true);
      assert.equal(status.data.setupRequired, false);
    } finally { srv.close(); }
  });
});

describe('ADMIN_PASSWORD is one-shot and has a username', () => {
  it('sets admin once and does not reset the password on a later boot', async () => {
    const { app, db } = makeApp();
    const first = applyAdminPassword(db, { ADMIN_PASSWORD: 'password123' });
    assert.equal(first.applied, true);
    assert.equal(first.username, 'admin');
    const stored = db.prepare('SELECT password_hash FROM owners').get().password_hash;

    const second = applyAdminPassword(db, { ADMIN_PASSWORD: 'another-password' });
    assert.equal(second.applied, false);
    assert.equal(second.reason, 'already-set');
    assert.equal(db.prepare('SELECT password_hash FROM owners').get().password_hash, stored);

    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const login = await postJson(`${base}/api/v1/owner/login`, { username: 'admin', password: 'password123' });
      assert.equal(login.status, 200);
      const renamed = applyAdminPassword(db, { ADMIN_PASSWORD: 'password123', ADMIN_USERNAME: 'jake' });
      assert.equal(renamed.applied, false);
    } finally { srv.close(); }
  });
});

describe('Open pairing cap', () => {
  it('stops at a few open phrases and still lets a paired device create one', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1', 'phone');
      for (let i = 0; i < MAX_OPEN_PAIRINGS; i++) {
        const res = await postJson(`${base}/api/v1/sync/pairings`, {}, authHeader(token));
        assert.equal(res.status, 200, `open pairing ${i + 1}`);
      }
      const capped = await postJson(`${base}/api/v1/sync/pairings`, {}, authHeader(token));
      assert.equal(capped.status, 429);
      assert.match(capped.data.error, /too many open pairings/);
    } finally { srv.close(); }
  });
});

describe('Rate-limit map pruning', () => {
  it('drops expired buckets', () => {
    const map = new Map();
    const stale = Date.now() - 20 * 60 * 1000;
    for (let i = 0; i < 40; i++) map.set(`old-${i}`, { count: 9, windowStart: stale });
    slidingWindowLimit(map, 'fresh', { windowMs: 15 * 60 * 1000, max: 10 });
    assert.deepEqual([...map.keys()], ['fresh']);
  });
});
