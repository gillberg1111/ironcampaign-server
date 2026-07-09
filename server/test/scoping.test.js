import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, seedVillain, authHeader, postJson, getJson } from './helpers.js';

describe('Scoping / IDOR', () => {
  it('B cannot pull A changes', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'profile-a');
      const tokenB = addDevice(db, 'profile-b');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villains', uuid: 'vA', field: 'name', value: 'A Villain', hlc: '019077fd307b0001', deviceId: 'dev-a' }],
      }, authHeader(tokenA));

      const pushB = await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villains', uuid: 'vB', field: 'name', value: 'B Villain', hlc: '019077fd307b0001', deviceId: 'dev-b' }],
      }, authHeader(tokenB));

      const pullA = await postJson(`${base}/api/v1/sync/changes`, { since: 0 }, authHeader(tokenA));
      assert.equal(pullA.status, 200);
      const aUuids = pullA.data.changes.map(c => c.uuid);
      assert.ok(aUuids.includes('vA'), 'A sees own villain');
      assert.ok(!aUuids.includes('vB'), 'A must not see B villain');

      const pullB = await postJson(`${base}/api/v1/sync/changes`, { since: 0 }, authHeader(tokenB));
      const bUuids = pullB.data.changes.map(c => c.uuid);
      assert.ok(bUuids.includes('vB'), 'B sees own villain');
      assert.ok(!bUuids.includes('vA'), 'B must not see A villain');
    } finally {
      srv.close();
    }
  });

  it('B push referencing A uuid does not modify A row', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'profile-a');
      const tokenB = addDevice(db, 'profile-b');

      seedVillain(db, 'profile-a', { uuid: 'vA', name: 'Original A', hp: 80 });

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villains', uuid: 'vA', field: 'name', value: 'B tries overwrite', hlc: '019077fd307b0005', deviceId: 'dev-b' }],
      }, authHeader(tokenB));

      const aVillain = db.prepare('SELECT name, hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('vA', 'profile-a');
      assert.ok(aVillain, 'A villain still exists');
      assert.equal(aVillain.name, 'Original A', 'A villain name unchanged');
      assert.equal(aVillain.hp, 80, 'A villain hp unchanged');
    } finally {
      srv.close();
    }
  });

  it('B /combat access to A villain → 404', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'profile-a');
      const tokenB = addDevice(db, 'profile-b');

      seedVillain(db, 'profile-a', { uuid: 'vA', name: 'A Villain', hp: 100 });

      const res = await postJson(`${base}/api/v1/combat/glancing-blow`, { villainUUID: 'vA' }, authHeader(tokenB));
      assert.equal(res.status, 404);

      const aVillain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('vA', 'profile-a');
      assert.equal(aVillain.hp, 100, 'A hp untouched');
    } finally {
      srv.close();
    }
  });
});
