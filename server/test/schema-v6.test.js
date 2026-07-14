import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { APPEND_ONLY_TABLES } from '../../questlog-critical/hlc-merge/merge.js';
import { makeApp, addDevice, authHeader, postJson, seedVillain } from './helpers.js';

describe('Schema v6 (exercises + set_logs)', () => {
  it('migration is idempotent and creates both tables', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('exercises'));
    assert.ok(tables.includes('set_logs'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 18);

    const exCols = db.pragma('table_info(exercises)').map(c => c.name);
    assert.ok(exCols.includes('name'));
    assert.ok(exCols.includes('notes'));
    assert.ok(exCols.includes('deleted'));
    assert.ok(exCols.includes('profile_uuid'));

    const slCols = db.pragma('table_info(set_logs)').map(c => c.name);
    assert.ok(slCols.includes('session_uuid'));
    assert.ok(slCols.includes('exercise_uuid'));
    assert.ok(slCols.includes('set_index'));
    assert.ok(slCols.includes('reps'));
    assert.ok(slCols.includes('weight_kg'));
    assert.ok(slCols.includes('rpe'));
    assert.ok(slCols.includes('timestamp'));
    assert.ok(slCols.includes('replaces_uuid'));
  });

  it('registry parity: set_logs appendOnly matches APPEND_ONLY_TABLES, exercises does not', () => {
    assert.equal(REGISTRY.set_logs.appendOnly, true);
    assert.equal(REGISTRY.exercises.appendOnly, false);
    assert.ok(APPEND_ONLY_TABLES.has('set_logs'));
    assert.equal(APPEND_ONLY_TABLES.has('exercises'), false);
  });

  it('registry allows mutable fields on exercises and rejects unknowns', () => {
    assert.ok(REGISTRY.exercises.mutableFields.includes('name'));
    assert.ok(REGISTRY.exercises.mutableFields.includes('notes'));
    assert.doesNotThrow(() => assertAllowed('exercises', 'name'));
    assert.doesNotThrow(() => assertAllowed('exercises', 'notes'));
    assert.throws(() => assertAllowed('exercises', 'bogus_field'));
  });

  it('set_log row round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const setLogRow = {
        uuid: 'sl-001',
        session_uuid: 'sess-1',
        exercise_uuid: 'ex-1',
        set_index: 0,
        reps: 10,
        weight_kg: 60.0,
        rpe: 7.5,
        completed: 1,
        duration_sec: null,
        distance_m: null,
        timestamp: 1700000000000,
        replaces_uuid: null,
      };

      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'set_logs', uuid: 'sl-001', field: '__row__', value: setLogRow, hlc: '019077fd307b0001', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(push.data.applied, 1);

      const row = db.prepare('SELECT * FROM set_logs WHERE uuid = ? AND profile_uuid = ?').get('sl-001', 'p1');
      assert.equal(row.reps, 10);
      assert.equal(row.weight_kg, 60.0);
      assert.equal(row.rpe, 7.5);
      assert.equal(row.set_index, 0);
      assert.equal(row.replaces_uuid, null);

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const slChange = pull.data.changes.find(c => c.uuid === 'sl-001');
      assert.ok(slChange);
      assert.equal(slChange.field, '__row__');
      assert.equal(slChange.value.reps, 10);
    } finally { srv.close(); }
  });

  it('exercise LWW change round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'exercises', uuid: 'ex-1', field: 'name', value: 'Bench Press', hlc: '019077fd307b0002', deviceId: 'dev-a' },
          { table: 'exercises', uuid: 'ex-1', field: 'notes', value: 'Focus on form', hlc: '019077fd307b0003', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(push.data.applied, 2);

      const row = db.prepare('SELECT * FROM exercises WHERE uuid = ? AND profile_uuid = ?').get('ex-1', 'p1');
      assert.equal(row.name, 'Bench Press');
      assert.equal(row.notes, 'Focus on form');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const nameChange = pull.data.changes.find(c => c.field === 'name');
      assert.equal(nameChange.value, 'Bench Press');
    } finally { srv.close(); }
  });

  it('duplicate set_log uuid → append-duplicate', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const setLogRow = {
        uuid: 'sl-dup',
        session_uuid: 'sess-1',
        exercise_uuid: 'ex-1',
        set_index: 0,
        reps: 5,
        weight_kg: 80,
        rpe: 8,
        completed: 1,
        duration_sec: null,
        distance_m: null,
        timestamp: 1700000000000,
        replaces_uuid: null,
      };

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'set_logs', uuid: 'sl-dup', field: '__row__', value: setLogRow, hlc: '019077fd307b0004', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'set_logs', uuid: 'sl-dup', field: '__row__', value: setLogRow, hlc: '019077fd307b0004', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 0);

      const dup = res.data.results.find(r => r.uuid === 'sl-dup');
      assert.equal(dup.decision, 'append-duplicate');

      const rows = db.prepare('SELECT uuid FROM set_logs WHERE profile_uuid = ? AND uuid = ?').all('p1', 'sl-dup');
      assert.equal(rows.length, 1);
    } finally { srv.close(); }
  });
});
