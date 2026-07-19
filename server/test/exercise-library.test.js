import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v17 (exercises.builtin_id + exercise library)', () => {
  it('migration is idempotent and adds the column', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 19);

    const cols = db.pragma('table_info(exercises)').map(c => c.name);
    assert.ok(cols.includes('builtin_id'));
  });

  it('registry parity: builtin_id is in columns but not mutable', () => {
    assert.ok(REGISTRY.exercises.columns.includes('builtin_id'));
    assert.ok(!REGISTRY.exercises.mutableFields.includes('builtin_id'));
    assert.throws(() => assertAllowed('exercises', 'builtin_id'), /not mutable/);
  });

  it('builtin_id is in registry columns but immutable', () => {
    assert.ok(REGISTRY.exercises.columns.includes('builtin_id'));
    assert.ok(!REGISTRY.exercises.mutableFields.includes('builtin_id'));
  });

  it('GET /data/exercises seeds library on first access', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${srv.address().port}/api/v1/data/exercises`, {
        headers: authHeader(token),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.exercises));
      assert.ok(body.exercises.length >= 20, 'should seed at least 20 built-in exercises');

      const squat = body.exercises.find(e => e.name === 'Squat');
      assert.ok(squat, 'Squat must be seeded');
      assert.equal(squat.tracking_type, 'strength');

      const treadmill = body.exercises.find(e => e.name === 'Treadmill');
      assert.ok(treadmill, 'Treadmill must be seeded');
      assert.equal(treadmill.tracking_type, 'cardio');
    } finally { srv.close(); }
  });

  it('exercise library seeding is idempotent', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const url = `http://localhost:${srv.address().port}/api/v1/data/exercises`;
      const res1 = await fetch(url, { headers: authHeader(token) });
      const body1 = await res1.json();
      const res2 = await fetch(url, { headers: authHeader(token) });
      const body2 = await res2.json();
      assert.equal(body1.exercises.length, body2.exercises.length);
    } finally { srv.close(); }
  });
});
