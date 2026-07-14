import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v11/v12 (tracking types, set_logs columns, planned_workouts)', () => {
  it('migrations are idempotent and add the new columns/table', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 18);

    const exCols = db.pragma('table_info(exercises)').map(c => c.name);
    assert.ok(exCols.includes('tracking_type'));
    const slCols = db.pragma('table_info(set_logs)').map(c => c.name);
    for (const c of ['completed', 'duration_sec', 'distance_m']) assert.ok(slCols.includes(c), c);
    const teCols = db.pragma('table_info(template_exercises)').map(c => c.name);
    assert.ok(teCols.includes('target_weight_kg'));
    const pwCols = db.pragma('table_info(planned_workouts)').map(c => c.name);
    for (const c of ['chapter_uuid', 'day_index', 'template_uuid', 'position', 'profile_uuid']) {
      assert.ok(pwCols.includes(c), c);
    }
  });

  it('registry: planned_workouts is LWW, new fields mutable, unknown fields rejected', () => {
    assert.equal(REGISTRY.planned_workouts.appendOnly, false);
    assert.ok(REGISTRY.exercises.mutableFields.includes('tracking_type'));
    assert.ok(REGISTRY.template_exercises.mutableFields.includes('target_weight_kg'));
    assert.throws(() => assertAllowed('planned_workouts', 'bogus'), /not mutable/);
  });

  it('planned_workouts round-trips through push and a missed cardio set_log is accepted', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'planned_workouts', uuid: 'pw-1', field: 'chapter_uuid', value: 'ch-1', hlc: '019077fd307b0100', deviceId: 'dev-a' },
          { table: 'planned_workouts', uuid: 'pw-1', field: 'day_index', value: 2, hlc: '019077fd307b0101', deviceId: 'dev-a' },
          { table: 'planned_workouts', uuid: 'pw-1', field: 'name', value: 'Push A', hlc: '019077fd307b0102', deviceId: 'dev-a' },
          { table: 'set_logs', uuid: 'sl-1', field: '__row__',
            value: { uuid: 'sl-1', session_uuid: 's1', exercise_uuid: 'e1', set_index: 0,
                     reps: 3, weight_kg: 100, rpe: null, completed: 0, duration_sec: null,
                     distance_m: null, timestamp: 100, replaces_uuid: null },
            hlc: '019077fd307b0103', deviceId: 'dev-a' },
          { table: 'set_logs', uuid: 'sl-2', field: '__row__',
            value: { uuid: 'sl-2', session_uuid: 's1', exercise_uuid: 'e2', set_index: 0,
                     reps: 0, weight_kg: null, rpe: null, completed: 1, duration_sec: 1800,
                     distance_m: 5000, timestamp: 101, replaces_uuid: null },
            hlc: '019077fd307b0104', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 5);

      const pw = db.prepare("SELECT day_index, name FROM planned_workouts WHERE uuid = 'pw-1' AND profile_uuid = 'p1'").get();
      assert.equal(pw.day_index, 2);
      assert.equal(pw.name, 'Push A');
      const miss = db.prepare("SELECT completed FROM set_logs WHERE uuid = 'sl-1'").get();
      assert.equal(miss.completed, 0);
      const cardio = db.prepare("SELECT duration_sec, distance_m FROM set_logs WHERE uuid = 'sl-2'").get();
      assert.equal(cardio.duration_sec, 1800);
      assert.equal(cardio.distance_m, 5000);
    } finally {
      srv.close();
    }
  });
});
