import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, authHeader, postJson, seedVillain } from './helpers.js';

describe('Append-only union', () => {
  it('two distinct villain_events for same villain → both appended', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      seedVillain(db, 'p1', { uuid: 'v1' });

      const event1 = { uuid: 'e1', villain_uuid: 'v1', timestamp: 1, reason: 'confession', damage: 0, xp: 5 };
      const event2 = { uuid: 'e2', villain_uuid: 'v1', timestamp: 2, reason: 'glancing_blow', damage: 3, xp: 10, damage_roll: 50, result_stamp: 'small_tick' };

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'villain_events', uuid: 'e1', field: '__row__', value: event1, hlc: '019077fd307b0001', deviceId: 'dev-a' },
          { table: 'villain_events', uuid: 'e2', field: '__row__', value: event2, hlc: '019077fd307b0002', deviceId: 'dev-b' },
        ],
      }, authHeader(token));

      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 2, 'both events applied');

      const rows = db.prepare('SELECT uuid FROM villain_events WHERE profile_uuid = ? AND villain_uuid = ? ORDER BY uuid').all('p1', 'v1');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].uuid, 'e1');
      assert.equal(rows[1].uuid, 'e2');

      const logRows = db.prepare(
        'SELECT row_uuid FROM change_log WHERE profile_uuid = ? AND table_name = ? AND row_uuid IN (?, ?)'
      ).all('p1', 'villain_events', 'e1', 'e2');
      assert.equal(logRows.length, 2, 'one change_log row per event');
    } finally {
      srv.close();
    }
  });

  it('re-push same event uuid → append-duplicate, no dup row, no extra change_log', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      seedVillain(db, 'p1', { uuid: 'v1' });

      const event1 = { uuid: 'e1', villain_uuid: 'v1', timestamp: 1, reason: 'confession', damage: 0, xp: 5 };

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villain_events', uuid: 'e1', field: '__row__', value: event1, hlc: '019077fd307b0001', deviceId: 'dev-a' }],
      }, authHeader(token));

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villain_events', uuid: 'e1', field: '__row__', value: event1, hlc: '019077fd307b0001', deviceId: 'dev-a' }],
      }, authHeader(token));

      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 0);

      const results = res.data.results;
      const dup = results.find(r => r.uuid === 'e1');
      assert.equal(dup.decision, 'append-duplicate');

      const rows = db.prepare('SELECT uuid FROM villain_events WHERE profile_uuid = ? AND villain_uuid = ?').all('p1', 'v1');
      assert.equal(rows.length, 1, 'no duplicate row');

      const logCount = db.prepare(
        'SELECT COUNT(*) as c FROM change_log WHERE profile_uuid = ? AND row_uuid = ?'
      ).get('p1', 'e1');
      assert.equal(logCount.c, 1, 'only 1 change_log entry');
    } finally {
      srv.close();
    }
  });

  it('unknown column in append-only value → 400', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [{ table: 'villain_events', uuid: 'e1', field: '__row__', value: { uuid: 'e1', villain_uuid: 'v1', timestamp: 1, reason: 'confession', damage: 0, xp: 5, BOGUS_COLUMN: 'nope' }, hlc: '019077fd307b0001', deviceId: 'dev-a' }],
      }, authHeader(token));

      assert.equal(res.status, 400);
    } finally {
      srv.close();
    }
  });
});
