import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

// Spec v2.9: per-device echo suppression on /sync/changes. The load-bearing rule under test:
// lastSeq reflects the SCANNED window, never the filtered result, so an all-own-changes window
// still advances the client cursor.
describe('Pull filtering (spec v2.9)', () => {
  async function pushTwoChangesAsDevA(base, token) {
    const res = await postJson(`${base}/api/v1/sync/push`, {
      changes: [
        { table: 'villains', uuid: 'v1', field: 'name', value: 'A', hlc: '019077fd307b0001', deviceId: 'dev-a' },
        { table: 'villains', uuid: 'v1', field: 'hp', value: 42, hlc: '019077fd307b0002', deviceId: 'dev-a' },
      ],
    }, authHeader(token));
    assert.equal(res.data.applied, 2);
  }

  it('all-own window → empty changes but lastSeq advances', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      await pushTwoChangesAsDevA(base, token);

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-a' }, authHeader(token));
      assert.equal(pull.status, 200);
      assert.deepEqual(pull.data.changes, [], 'own changes are suppressed');
      assert.equal(pull.data.lastSeq, 2, 'cursor still advances past the scanned window');
    } finally { srv.close(); }
  });

  it('another device still sees those changes', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      await pushTwoChangesAsDevA(base, token);

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      assert.equal(pull.data.changes.length, 2);
      assert.equal(pull.data.lastSeq, 2);
      assert.ok(pull.data.changes.every(c => c.deviceId === 'dev-a'));
    } finally { srv.close(); }
  });

  it('no deviceId in the request → unfiltered (back-compat)', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      await pushTwoChangesAsDevA(base, token);

      const pull = await postJson(`${base}/api/v1/sync/changes`, { since: 0 }, authHeader(token));
      assert.equal(pull.data.changes.length, 2);
      assert.equal(pull.data.lastSeq, 2);
    } finally { srv.close(); }
  });
});
