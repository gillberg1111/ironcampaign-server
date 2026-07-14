import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY } from '../src/sync/registry.js';
import { APPEND_ONLY_TABLES } from '../../questlog-critical/hlc-merge/merge.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v8 (measurements)', () => {
  it('migration is idempotent and creates the table', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('measurements'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 18);

    const cols = db.pragma('table_info(measurements)').map(c => c.name);
    assert.ok(cols.includes('timestamp'));
    assert.ok(cols.includes('kind'));
    assert.ok(cols.includes('value'));
    assert.ok(cols.includes('unit'));
    assert.ok(cols.includes('replaces_uuid'));
    assert.ok(cols.includes('profile_uuid'));
  });

  it('registry parity: measurements is appendOnly and in APPEND_ONLY_TABLES', () => {
    assert.equal(REGISTRY.measurements.appendOnly, true);
    assert.ok(APPEND_ONLY_TABLES.has('measurements'));
  });

  it('measurement row round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const row = {
        uuid: 'm-001',
        timestamp: 1700000000000,
        kind: 'bodyweight',
        value: 82.5,
        unit: 'kg',
        replaces_uuid: null,
      };

      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'measurements', uuid: 'm-001', field: '__row__', value: row, hlc: '019077fd307b0001', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(push.data.applied, 1);

      const dbRow = db.prepare('SELECT * FROM measurements WHERE uuid = ? AND profile_uuid = ?').get('m-001', 'p1');
      assert.equal(dbRow.kind, 'bodyweight');
      assert.equal(dbRow.value, 82.5);
      assert.equal(dbRow.unit, 'kg');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const mChange = pull.data.changes.find(c => c.uuid === 'm-001');
      assert.ok(mChange);
      assert.equal(mChange.field, '__row__');
      assert.equal(mChange.value.kind, 'bodyweight');
    } finally { srv.close(); }
  });

  it('duplicate measurement uuid → append-duplicate', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const row = {
        uuid: 'm-dup',
        timestamp: 1700000000000,
        kind: 'waist',
        value: 85,
        unit: 'cm',
        replaces_uuid: null,
      };

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'measurements', uuid: 'm-dup', field: '__row__', value: row, hlc: '019077fd307b0002', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'measurements', uuid: 'm-dup', field: '__row__', value: row, hlc: '019077fd307b0002', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 0);

      const dup = res.data.results.find(r => r.uuid === 'm-dup');
      assert.equal(dup.decision, 'append-duplicate');

      const rows = db.prepare('SELECT uuid FROM measurements WHERE profile_uuid = ? AND uuid = ?').all('p1', 'm-dup');
      assert.equal(rows.length, 1);
    } finally { srv.close(); }
  });
});
