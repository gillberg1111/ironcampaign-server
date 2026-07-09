import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, addOwner, authHeader, postJson, getJson } from './helpers.js';
import { createPairing, authenticateDevice, revokeDevice } from '../../questlog-critical/sync-auth/pairing.js';
import { createOwnerKey, authenticateOwner } from '../src/auth/owner.js';

describe('Owner auth & endpoints', () => {
  it('createOwnerKey → key authenticates', () => {
    const { db } = makeApp();
    const result = createOwnerKey(db, 'profile-1');
    assert.ok(result.key);
    assert.equal(result.profileUuid, 'profile-1');

    const auth = authenticateOwner(db, `Bearer ${result.key}`);
    assert.equal(auth.profileUuid, 'profile-1');
  });

  it('wrong / blank owner key → 401', () => {
    const { db } = makeApp();
    createOwnerKey(db, 'profile-1');

    assert.throws(
      () => authenticateOwner(db, 'Bearer bad-key-here-nope-fake-tok'),
      (e) => e.status === 401
    );
    assert.throws(
      () => authenticateOwner(db, ''),
      (e) => e.status === 401
    );
    assert.throws(
      () => authenticateOwner(db, undefined),
      (e) => e.status === 401
    );
  });

  it('rotation invalidates old key', () => {
    const { db } = makeApp();
    const first = createOwnerKey(db, 'profile-1');
    const second = createOwnerKey(db, 'profile-1');

    assert.notEqual(first.key, second.key);

    assert.doesNotThrow(() => authenticateOwner(db, `Bearer ${second.key}`));
    assert.throws(
      () => authenticateOwner(db, `Bearer ${first.key}`),
      (e) => e.status === 401
    );
  });

  it('POST /owner/pairings mints a working phrase', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const owner = addOwner(db, 'profile-1');

      const res = await postJson(`${base}/api/v1/owner/pairings`, {}, authHeader(owner.key));
      assert.equal(res.status, 200);
      assert.ok(res.data.phrase);
      assert.ok(res.data.expiresAt);

      const pairRes = await postJson(`${base}/api/v1/sync/pair`, {
        phrase: res.data.phrase,
        deviceName: 'test-device',
      });
      assert.equal(pairRes.status, 200);
      assert.equal(pairRes.data.profileUuid, 'profile-1');
    } finally {
      srv.close();
    }
  });

  it('POST /owner/pairings without owner key → 401', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await postJson(`${base}/api/v1/owner/pairings`, {}, {});
      assert.equal(res.status, 401);
    } finally {
      srv.close();
    }
  });

  it('GET /owner/devices returns only own devices, no token/hash', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const ownerA = addOwner(db, 'profile-a');
      addOwner(db, 'profile-b');

      addDevice(db, 'profile-a', 'device-a1');
      addDevice(db, 'profile-a', 'device-a2');
      addDevice(db, 'profile-b', 'device-b1');

      const res = await getJson(`${base}/api/v1/owner/devices`, authHeader(ownerA.key));
      assert.equal(res.status, 200);
      assert.equal(res.data.devices.length, 2);

      for (const d of res.data.devices) {
        assert.ok(!('token_sha256' in d), 'must not leak token hash');
        assert.ok(!('token' in d), 'must not leak token');
        assert.ok(d.device_name);
        assert.ok(d.created_at);
      }

      const names = res.data.devices.map(d => d.device_name).sort();
      assert.deepStrictEqual(names, ['device-a1', 'device-a2']);
    } finally {
      srv.close();
    }
  });

  it('owner A cannot revoke device belonging to owner B', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const ownerA = addOwner(db, 'profile-a');
      addOwner(db, 'profile-b');

      const tokenB = addDevice(db, 'profile-b', 'device-b1');

      const devicesB = db.prepare(
        'SELECT id FROM device_tokens WHERE profile_uuid = ? ORDER BY id'
      ).all('profile-b');
      const deviceBId = devicesB[0].id;

      const res = await postJson(`${base}/api/v1/owner/devices/${deviceBId}/revoke`, {}, authHeader(ownerA.key));
      assert.equal(res.status, 404, 'owner A should get 404 for B device');

      const gotTokenB = db.prepare(
        'SELECT id, revoked_at FROM device_tokens WHERE id = ?'
      ).get(deviceBId);
      assert.equal(gotTokenB.revoked_at, null, 'B device not revoked by A');

      assert.doesNotThrow(() => authenticateDevice(db, `Bearer ${tokenB}`));
    } finally {
      srv.close();
    }
  });

  it('revoke works and device token fails authenticateDevice', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const owner = addOwner(db, 'profile-1');
      const token = addDevice(db, 'profile-1', 'to-revoke');

      const devices = db.prepare(
        'SELECT id FROM device_tokens WHERE profile_uuid = ? ORDER BY id'
      ).all('profile-1');
      const deviceId = devices[0].id;

      const res = await postJson(`${base}/api/v1/owner/devices/${deviceId}/revoke`, {}, authHeader(owner.key));
      assert.equal(res.status, 200);
      assert.equal(res.data.revoked, true);

      assert.throws(
        () => authenticateDevice(db, `Bearer ${token}`),
        (e) => e.status === 401
      );
    } finally {
      srv.close();
    }
  });
});
