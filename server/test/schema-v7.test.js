import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { APPEND_ONLY_TABLES } from '../../questlog-critical/hlc-merge/merge.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v7 (workout_templates + template_exercises)', () => {
  it('migration is idempotent and creates both tables', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('workout_templates'));
    assert.ok(tables.includes('template_exercises'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 19);

    const wtCols = db.pragma('table_info(workout_templates)').map(c => c.name);
    assert.ok(wtCols.includes('name'));
    assert.ok(wtCols.includes('est_minutes'));
    assert.ok(wtCols.includes('notes'));
    assert.ok(wtCols.includes('deleted'));
    assert.ok(wtCols.includes('profile_uuid'));

    const teCols = db.pragma('table_info(template_exercises)').map(c => c.name);
    assert.ok(teCols.includes('template_uuid'));
    assert.ok(teCols.includes('exercise_uuid'));
    assert.ok(teCols.includes('position'));
    assert.ok(teCols.includes('target_sets'));
    assert.ok(teCols.includes('target_reps'));
  });

  it('registry parity: both tables are LWW, neither in APPEND_ONLY_TABLES', () => {
    assert.equal(REGISTRY.workout_templates.appendOnly, false);
    assert.equal(REGISTRY.template_exercises.appendOnly, false);
    assert.equal(APPEND_ONLY_TABLES.has('workout_templates'), false);
    assert.equal(APPEND_ONLY_TABLES.has('template_exercises'), false);
  });

  it('registry allows mutable fields and rejects unknowns', () => {
    assert.ok(REGISTRY.workout_templates.mutableFields.includes('name'));
    assert.ok(REGISTRY.workout_templates.mutableFields.includes('est_minutes'));
    assert.ok(REGISTRY.workout_templates.mutableFields.includes('notes'));
    assert.doesNotThrow(() => assertAllowed('workout_templates', 'name'));
    assert.throws(() => assertAllowed('workout_templates', 'bogus_field'));

    assert.ok(REGISTRY.template_exercises.mutableFields.includes('position'));
    assert.ok(REGISTRY.template_exercises.mutableFields.includes('template_uuid'));
    assert.doesNotThrow(() => assertAllowed('template_exercises', 'position'));
    assert.throws(() => assertAllowed('template_exercises', 'bogus_field'));
  });

  it('workout_templates LWW change round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'workout_templates', uuid: 'wt-1', field: 'name', value: 'Upper B', hlc: '019077fd307b0001', deviceId: 'dev-a' },
          { table: 'workout_templates', uuid: 'wt-1', field: 'est_minutes', value: 45, hlc: '019077fd307b0002', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const row = db.prepare('SELECT * FROM workout_templates WHERE uuid = ? AND profile_uuid = ?').get('wt-1', 'p1');
      assert.equal(row.name, 'Upper B');
      assert.equal(row.est_minutes, 45);

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const nameChange = pull.data.changes.find(c => c.field === 'name');
      assert.equal(nameChange.value, 'Upper B');
    } finally { srv.close(); }
  });

  it('template_exercises LWW change round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'template_exercises', uuid: 'te-1', field: 'template_uuid', value: 'wt-1', hlc: '019077fd307b0003', deviceId: 'dev-a' },
          { table: 'template_exercises', uuid: 'te-1', field: 'exercise_uuid', value: 'ex-1', hlc: '019077fd307b0004', deviceId: 'dev-a' },
          { table: 'template_exercises', uuid: 'te-1', field: 'position', value: 0, hlc: '019077fd307b0005', deviceId: 'dev-a' },
          { table: 'template_exercises', uuid: 'te-1', field: 'target_sets', value: 3, hlc: '019077fd307b0006', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const row = db.prepare('SELECT * FROM template_exercises WHERE uuid = ? AND profile_uuid = ?').get('te-1', 'p1');
      assert.equal(row.template_uuid, 'wt-1');
      assert.equal(row.position, 0);
      assert.equal(row.target_sets, 3);

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const posChange = pull.data.changes.find(c => c.field === 'position');
      assert.equal(posChange.value, 0);
    } finally { srv.close(); }
  });
});
