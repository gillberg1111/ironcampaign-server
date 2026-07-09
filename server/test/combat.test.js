import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, seedVillain, authHeader, postJson } from './helpers.js';

describe('Combat session', () => {
  it('rejects an unknown sessionType with 400', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      seedVillain(db, 'p1', { uuid: 'v1', hp: 100 });
      const res = await postJson(`${base}/api/v1/combat/session`,
        { villainUUID: 'v1', durationMinutes: 30, sessionType: 'bogus' }, authHeader(token));
      assert.equal(res.status, 400);
      // villain untouched
      assert.equal(db.prepare('SELECT hp FROM villains WHERE uuid=?').get('v1').hp, 100);
    } finally { srv.close(); }
  });

  it('applies Heavy Strike for a full scheduled session', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      seedVillain(db, 'p1', { uuid: 'v1', hp: 100 });
      const res = await postJson(`${base}/api/v1/combat/session`,
        { villainUUID: 'v1', durationMinutes: 30, sessionType: 'fullScheduled' }, authHeader(token));
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT hp FROM villains WHERE uuid=?').get('v1').hp, 80); // -20
    } finally { srv.close(); }
  });

  it('defaults to Heavy Strike when sessionType is omitted', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      seedVillain(db, 'p1', { uuid: 'v1', hp: 100 });
      const res = await postJson(`${base}/api/v1/combat/session`,
        { villainUUID: 'v1', durationMinutes: 30 }, authHeader(token));
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT hp FROM villains WHERE uuid=?').get('v1').hp, 80);
    } finally { srv.close(); }
  });
});
