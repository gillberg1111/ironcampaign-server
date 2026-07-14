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

describe('The Drought is weakened only by water (never a training strike)', () => {
  function withMinion(fn) {
    return async () => {
      const { app, db } = makeApp();
      const srv = app.listen(0);
      const base = `http://localhost:${srv.address().port}`;
      try {
        const token = addDevice(db, 'p1');
        seedVillain(db, 'p1', { uuid: 'drought', hp: 16, max_hp: 16 });
        db.prepare("UPDATE villains SET slot = 'constant_minion' WHERE uuid = 'drought'").run();
        await fn(base, db, token);
      } finally { srv.close(); }
    };
  }

  it('POST /combat/session against the minion → 400, HP unchanged', withMinion(async (base, db, token) => {
    const res = await postJson(`${base}/api/v1/combat/session`,
      { villainUUID: 'drought', durationMinutes: 45, sessionType: 'fullScheduled' }, authHeader(token));
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT hp FROM villains WHERE uuid=?').get('drought').hp, 16, 'no training damage');
  }));

  it('POST /combat/glancing-blow against the minion → 400, HP unchanged', withMinion(async (base, db, token) => {
    const res = await postJson(`${base}/api/v1/combat/glancing-blow`,
      { villainUUID: 'drought' }, authHeader(token));
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT hp FROM villains WHERE uuid=?').get('drought').hp, 16, 'no strike damage');
  }));
});
