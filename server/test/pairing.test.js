import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.js';
import {
  createPairing,
  verifyAndConsumePairing,
  authenticateDevice,
  revokeDevice,
} from '../../questlog-critical/sync-auth/pairing.js';

describe('Pairing e2e', () => {
  it('create → verify consumes and returns token → token authenticates', async () => {
    const db = makeDb();
    const { phrase } = await createPairing(db, 'p1');

    const result = await verifyAndConsumePairing(db, phrase, 'test-device', '127.0.0.1');
    assert.ok(result.token);
    assert.equal(result.profileUuid, 'p1');

    const auth = authenticateDevice(db, `Bearer ${result.token}`);
    assert.equal(auth.profileUuid, 'p1');
  });

  it('reuse of same phrase → 401', async () => {
    const db = makeDb();
    const { phrase } = await createPairing(db, 'p1');

    await verifyAndConsumePairing(db, phrase, 'dev1', '127.0.0.1');

    await assert.rejects(
      () => verifyAndConsumePairing(db, phrase, 'dev2', '127.0.0.1'),
      (e) => e.status === 401
    );
  });

  it('expired pairing → 401', async () => {
    const db = makeDb();
    const { phrase } = await createPairing(db, 'p1');

    db.prepare('UPDATE pairings SET expires_at = ?').run(Date.now() - 1000);

    await assert.rejects(
      () => verifyAndConsumePairing(db, phrase, 'dev', '127.0.0.1'),
      (e) => e.status === 401
    );
  });

  it('revoked device token → authenticateDevice throws 401', async () => {
    const db = makeDb();
    const { phrase } = await createPairing(db, 'p1');

    const result = await verifyAndConsumePairing(db, phrase, 'test-device', '127.0.0.1');

    const auth = authenticateDevice(db, `Bearer ${result.token}`);
    revokeDevice(db, auth.deviceTokenId);

    assert.throws(
      () => authenticateDevice(db, `Bearer ${result.token}`),
      (e) => e.status === 401
    );
  });
});
