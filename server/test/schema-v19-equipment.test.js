import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { seedExerciseLibraryIfNeeded } from '../src/services/consoleWriter.js';
import { makeApp, addDevice, authHeader } from './helpers.js';

describe('Schema v19 (exercises.equipment)', () => {
  it('migration is idempotent and adds the column', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 19);

    const cols = db.pragma('table_info(exercises)').map(c => c.name);
    assert.ok(cols.includes('equipment'));
  });

  it('registry parity: equipment is in columns and mutable', () => {
    assert.ok(REGISTRY.exercises.columns.includes('equipment'));
    assert.ok(REGISTRY.exercises.mutableFields.includes('equipment'));
    assert.doesNotThrow(() => assertAllowed('exercises', 'equipment'));
  });

  it('seed carries equipment: barbell lifts tagged, kettlebell builtins present', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${srv.address().port}/api/v1/data/exercises`, {
        headers: authHeader(token),
      });
      assert.equal(res.status, 200);
      const { exercises } = await res.json();

      const squat = exercises.find(e => e.name === 'Squat');
      assert.equal(squat.equipment, 'barbell');
      const rdl = exercises.find(e => e.name === 'Romanian Deadlift');
      assert.equal(rdl.equipment, 'barbell');

      const swing = exercises.find(e => e.name === 'Kettlebell Swing');
      assert.ok(swing, 'kettlebell builtins must seed');
      assert.equal(swing.equipment, 'kettlebell');
      assert.equal(swing.tracking_type, 'strength');
      const getup = exercises.find(e => e.name === 'Turkish Get-Up');
      assert.equal(getup.equipment, 'kettlebell');

      const pullUp = exercises.find(e => e.name === 'Pull-Up');
      assert.equal(pullUp.equipment, null, 'non-barbell strength stays untagged');
    } finally { srv.close(); }
  });

  it('backfills NULL equipment on pre-v19 seeded rows and inserts new builtins', () => {
    const { db } = makeApp();
    seedExerciseLibraryIfNeeded(db, 'p1');

    // Simulate a pre-v19 install: equipment never seeded, kettlebell builtins never existed
    db.prepare("UPDATE exercises SET equipment = NULL WHERE profile_uuid = 'p1'").run();
    db.prepare("DELETE FROM exercises WHERE profile_uuid = 'p1' AND builtin_id LIKE 'kettlebell%'").run();
    db.prepare("DELETE FROM exercises WHERE profile_uuid = 'p1' AND builtin_id IN ('goblet_squat', 'turkish_getup')").run();

    const result = seedExerciseLibraryIfNeeded(db, 'p1');
    assert.equal(result.seeded, 4, 'the four kettlebell builtins re-seed');
    assert.equal(result.backfilled, 8, 'the eight barbell builtins get the flag');

    const squat = db.prepare(
      "SELECT equipment FROM exercises WHERE profile_uuid = 'p1' AND builtin_id = 'squat'"
    ).get();
    assert.equal(squat.equipment, 'barbell');
    const swing = db.prepare(
      "SELECT equipment, deleted FROM exercises WHERE profile_uuid = 'p1' AND builtin_id = 'kettlebell_swing'"
    ).get();
    assert.equal(swing.equipment, 'kettlebell');
    assert.equal(swing.deleted, 0);
  });

  it('seeding and backfill are idempotent; custom rows untouched', () => {
    const { db } = makeApp();
    seedExerciseLibraryIfNeeded(db, 'p1');
    db.prepare(
      `INSERT INTO exercises (uuid, profile_uuid, name, tracking_type, created_at, updated_at, deleted)
       VALUES ('custom-1', 'p1', 'My Sled Push', 'strength', 1, 1, 0)`
    ).run();

    const again = seedExerciseLibraryIfNeeded(db, 'p1');
    assert.equal(again.seeded, 0);
    assert.equal(again.backfilled, 0);

    const custom = db.prepare("SELECT equipment FROM exercises WHERE uuid = 'custom-1'").get();
    assert.equal(custom.equipment, null);
  });

  it('POST /data/exercises accepts equipment and rejects unknown values', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1/data/exercises`;
      const ok = await fetch(base, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'KB Snatch', trackingType: 'strength', equipment: 'kettlebell' }),
      });
      assert.equal(ok.status, 201);
      const { uuid } = await ok.json();
      const row = db.prepare('SELECT equipment FROM exercises WHERE uuid = ?').get(uuid);
      assert.equal(row.equipment, 'kettlebell');

      const bad = await fetch(base, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', equipment: 'machine' }),
      });
      assert.equal(bad.status, 400);
    } finally { srv.close(); }
  });
});
