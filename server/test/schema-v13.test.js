import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { APPEND_ONLY_TABLES } from '../../questlog-critical/hlc-merge/merge.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v14 (schedule_rules + session/saga fields)', () => {
  it('migration is idempotent and creates the table', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('schedule_rules'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 19);

    const srCols = db.pragma('table_info(schedule_rules)').map(c => c.name);
    assert.ok(srCols.includes('name'));
    assert.ok(srCols.includes('start_date'));
    assert.ok(srCols.includes('recurrence'));
    assert.ok(srCols.includes('interval_days'));
    assert.ok(srCols.includes('weekday_mask'));
    assert.ok(srCols.includes('end_date'));
    assert.ok(srCols.includes('profile_uuid'));

    const sCols = db.pragma('table_info(sessions)').map(c => c.name);
    assert.ok(sCols.includes('schedule_rule_uuid'));
    assert.ok(sCols.includes('planned_workout_uuid'));
    assert.ok(sCols.includes('scheduled_date'));

    const sagaCols = db.pragma('table_info(sagas)').map(c => c.name);
    assert.ok(sagaCols.includes('start_date'));
  });

  it('registry parity: schedule_rules is LWW and not appendOnly', () => {
    assert.equal(REGISTRY.schedule_rules.appendOnly, false);
    assert.ok(!APPEND_ONLY_TABLES.has('schedule_rules'));
    assert.ok(REGISTRY.schedule_rules.mutableFields.includes('name'));
    assert.ok(REGISTRY.schedule_rules.mutableFields.includes('recurrence'));
    assert.ok(REGISTRY.schedule_rules.mutableFields.includes('start_date'));
  });

  it('registry accepts new session and saga fields', () => {
    assert.ok(REGISTRY.sessions.mutableFields.includes('schedule_rule_uuid'));
    assert.ok(REGISTRY.sessions.mutableFields.includes('planned_workout_uuid'));
    assert.ok(REGISTRY.sessions.mutableFields.includes('scheduled_date'));
    assert.ok(REGISTRY.sagas.mutableFields.includes('start_date'));
  });

  it('registry rejects unknown schedule_rules field', () => {
    assert.throws(() => assertAllowed('schedule_rules', 'bogus_field'), /not mutable/);
  });

  it('schedule_rules row round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'schedule_rules', uuid: 'sr-001', field: 'name', value: 'Morning Run', hlc: '019077fd307b0400', deviceId: 'dev-a' },
          { table: 'schedule_rules', uuid: 'sr-001', field: 'start_date', value: '2025-01-01', hlc: '019077fd307b0401', deviceId: 'dev-a' },
          { table: 'schedule_rules', uuid: 'sr-001', field: 'recurrence', value: 'weekly', hlc: '019077fd307b0402', deviceId: 'dev-a' },
          { table: 'schedule_rules', uuid: 'sr-001', field: 'weekday_mask', value: 5, hlc: '019077fd307b0403', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const dbRow = db.prepare('SELECT * FROM schedule_rules WHERE uuid = ? AND profile_uuid = ?').get('sr-001', 'p1');
      assert.equal(dbRow.name, 'Morning Run');
      assert.equal(dbRow.recurrence, 'weekly');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const changes = pull.data.changes.filter(c => c.uuid === 'sr-001');
      assert.ok(changes.length >= 1);
    } finally { srv.close(); }
  });

  it('scoping: profile A cannot read profile B schedule rules', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'p1');
      const tokenB = addDevice(db, 'p2');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'schedule_rules', uuid: 'sr-scope', field: 'name', value: 'A Rule', hlc: '019077fd307b0500', deviceId: 'dev-a' },
          { table: 'schedule_rules', uuid: 'sr-scope', field: 'start_date', value: '2025-06-01', hlc: '019077fd307b0501', deviceId: 'dev-a' },
          { table: 'schedule_rules', uuid: 'sr-scope', field: 'recurrence', value: 'once', hlc: '019077fd307b0502', deviceId: 'dev-a' },
        ],
      }, authHeader(tokenA));

      const pullB = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(tokenB));
      const bChanges = pullB.data.changes.filter(c => c.uuid === 'sr-scope');
      assert.equal(bChanges.length, 0);
    } finally { srv.close(); }
  });
});
