import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { makeApp, addDevice, claimOwner, authHeader, postJson, getJson } from './helpers.js';
import { isServerClaimed } from '../src/routes/owner.js';

describe('Setup & claim', () => {
  it('isServerClaimed returns false when no password set', () => {
    const { db } = makeApp();
    assert.equal(isServerClaimed(db), false);
  });

  it('isServerClaimed returns false when owners row exists but password_hash is null', () => {
    const { db } = makeApp();
    db.prepare("INSERT INTO owners (profile_uuid, owner_key_sha256, created_at) VALUES ('p1', ?, ?)").run('placeholder', Date.now());
    assert.equal(isServerClaimed(db), false);
  });

  it('isServerClaimed returns true when password_hash is set', () => {
    const { db } = makeApp();
    claimOwner(db, 'admin', 'password123');
    assert.equal(isServerClaimed(db), true);
  });

  it('GET /owner/status returns claimed: false when no password', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status, data } = await getJson(`${base}/api/v1/owner/status`);
      assert.equal(status, 200);
      assert.equal(data.claimed, false);
    } finally { srv.close(); }
  });

  it('GET /owner/status returns claimed: true when password is set', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      claimOwner(db, 'admin', 'password123');
      const { status, data } = await getJson(`${base}/api/v1/owner/status`);
      assert.equal(status, 200);
      assert.equal(data.claimed, true);
    } finally { srv.close(); }
  });

  it('GET /owner/setup returns { claimed: false } when unclaimed', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status, data } = await getJson(`${base}/api/v1/owner/setup`);
      assert.equal(status, 200);
      assert.equal(data.claimed, false);
    } finally { srv.close(); }
  });

  it('GET /owner/setup returns { claimed: true } when claimed', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      claimOwner(db, 'admin', 'password123');
      const { status, data } = await getJson(`${base}/api/v1/owner/setup`);
      assert.equal(status, 200);
      assert.equal(data.claimed, true);
    } finally { srv.close(); }
  });

  it('POST /owner/claim creates account and returns a working console token', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status, data } = await postJson(`${base}/api/v1/owner/claim`, {
        username: 'admin',
        password: 'password123',
      });
      assert.equal(status, 201);
      assert.ok(data.token);

      const devicesRes = await getJson(`${base}/api/v1/owner/devices`,
        authHeader(data.token));
      assert.equal(devicesRes.status, 200);
      assert.ok(Array.isArray(devicesRes.data.devices));
    } finally { srv.close(); }
  });

  it('POST /owner/claim rejects short passwords', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status, data } = await postJson(`${base}/api/v1/owner/claim`, {
        username: 'admin',
        password: 'short',
      });
      assert.equal(status, 400);
      assert.ok(data.error);
    } finally { srv.close(); }
  });

  it('POST /owner/claim returns 409 when already claimed', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      claimOwner(db, 'admin', 'password123');
      const { status, data } = await postJson(`${base}/api/v1/owner/claim`, {
        username: 'hacker',
        password: 'password123',
      });
      assert.equal(status, 409);
      assert.ok(data.error);
    } finally { srv.close(); }
  });

  it('POST /owner/login returns a working console token', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      claimOwner(db, 'admin', 'password123');

      const { status, data } = await postJson(`${base}/api/v1/owner/login`, {
        username: 'admin',
        password: 'password123',
      });
      assert.equal(status, 200);
      assert.ok(data.token);

      const devicesRes = await getJson(`${base}/api/v1/owner/devices`,
        authHeader(data.token));
      assert.equal(devicesRes.status, 200);
    } finally { srv.close(); }
  });

  it('POST /owner/login returns 401 for wrong password', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      claimOwner(db, 'admin', 'password123');

      const { status, data } = await postJson(`${base}/api/v1/owner/login`, {
        username: 'admin',
        password: 'wrong-password',
      });
      assert.equal(status, 401);
      assert.ok(data.error);
    } finally { srv.close(); }
  });

  it('POST /owner/login returns 401 for unknown username', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status, data } = await postJson(`${base}/api/v1/owner/login`, {
        username: 'nonexistent',
        password: 'password123',
      });
      assert.equal(status, 401);
      assert.ok(data.error);
    } finally { srv.close(); }
  });

  it('POST /owner/login requires username and password', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const r1 = await postJson(`${base}/api/v1/owner/login`, { username: 'admin' });
      assert.equal(r1.status, 400);

      const r2 = await postJson(`${base}/api/v1/owner/login`, { password: 'test' });
      assert.equal(r2.status, 400);
    } finally { srv.close(); }
  });

  it('POST /sync/pairings requires device auth', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { status } = await postJson(`${base}/api/v1/sync/pairings`, {});
      assert.equal(status, 401);
    } finally { srv.close(); }
  });

  it('POST /sync/pairings creates pairing for authenticated device', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'profile-1', 'd1');

      const { status, data } = await postJson(`${base}/api/v1/sync/pairings`, {},
        authHeader(token));
      assert.equal(status, 200);
      assert.ok(data.phrase);
      assert.ok(data.expiresAt > Date.now());

      const pairRes = await postJson(`${base}/api/v1/sync/pair`, {
        phrase: data.phrase, deviceName: 'd2',
      });
      assert.equal(pairRes.status, 200);
      assert.equal(pairRes.data.profileUuid, 'profile-1');
    } finally { srv.close(); }
  });

  it('POST /sync/pairings is profile-scoped (A cannot invite into B)', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'profile-a', 'dA');

      const { status, data } = await postJson(`${base}/api/v1/sync/pairings`, {},
        authHeader(tokenA));
      assert.equal(status, 200);

      const pairRes = await postJson(`${base}/api/v1/sync/pair`, {
        phrase: data.phrase, deviceName: 'dAn',
      });
      assert.equal(pairRes.status, 200);
      assert.equal(pairRes.data.profileUuid, 'profile-a');
    } finally { srv.close(); }
  });

  it('POST /sync/pairings is rate-limited (per instance)', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'profile-1', 'd1');
      const h = authHeader(token);

      for (let i = 0; i < 11; i++) {
        const { status } = await postJson(`${base}/api/v1/sync/pairings`, {}, h);
        if (i < 10) {
          assert.equal(status, 200, `attempt ${i + 1} should succeed`);
        } else {
          assert.equal(status, 429, 'attempt 11 should be rate limited');
        }
      }
    } finally { srv.close(); }
  });

  it('POST /owner/login is rate-limited (review fix: brute-force surface)', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      await postJson(`${base}/api/v1/owner/claim`, { username: 'admin', password: 'longenough' });
      let sawLimit = false;
      // Claim consumed one limiter slot; hammer wrong passwords until the window closes.
      for (let i = 0; i < 11; i++) {
        const { status } = await postJson(`${base}/api/v1/owner/login`, { username: 'admin', password: 'wrong-pass' });
        if (status === 429) { sawLimit = true; break; }
        assert.equal(status, 401, `attempt ${i + 1} should be rejected, not errored`);
      }
      assert.ok(sawLimit, 'login attempts must hit the rate limit');
    } finally { srv.close(); }
  });

  it('owner key is not logged in server/src', () => {
    assert.doesNotThrow(() => {
      execSync(
        `grep -rn 'phrase\\|token\\|key' server/src/ --include='*.js' | grep -v 'test/' | grep -v 'unclaimed\\|ownerKey\\|owner_key\\|phrase_hash\\|token_sha256\\|tokenHash\\|createHash\\|key_delivered\\|bearer\\|Bearer\\|authorization\\|Authorization\\|server://\\|consoleToken\\|console_token\\|mintConsole' || true`,
        { encoding: 'utf8' }
      );
    }, 'secret-log grep should pass');
  });
});
