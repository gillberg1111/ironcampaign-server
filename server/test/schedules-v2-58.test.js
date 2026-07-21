import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { makeApp, addDevice, authHeader } from './helpers.js';

const H = (token) => ({ ...authHeader(token), 'Content-Type': 'application/json' });
const post = (base, path, token, body) =>
  fetch(base + path, { method: 'POST', headers: H(token), body: JSON.stringify(body) });
const del = (base, path, token) => fetch(base + path, { method: 'DELETE', headers: authHeader(token) });

async function makeTemplate(base, token, name) {
  const r = await post(base, '/data/templates', token, { name });
  return (await r.json()).uuid;
}

describe('Spec v2.58: rotation schedules + quicklog', () => {
  it('schema v20 adds schedule_group; registry parity', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 20);
    assert.ok(db.pragma('table_info(schedule_rules)').map(c => c.name).includes('schedule_group'));
    assert.ok(REGISTRY.schedule_rules.columns.includes('schedule_group'));
    assert.ok(REGISTRY.schedule_rules.mutableFields.includes('schedule_group'));
    assert.doesNotThrow(() => assertAllowed('schedule_rules', 'schedule_group'));
  });

  it('materializes A/Rest/B/Rest over the horizon with the group tag', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const a = await makeTemplate(base, token, 'Arms A');
      const b = await makeTemplate(base, token, 'Abs');
      const r = await post(base, '/data/schedules', token, {
        startDate: '2026-08-03', pattern: ['A', 'Rest', 'B', 'Rest'],
        assignments: { A: a, B: b }, weeks: 2,
      });
      assert.equal(r.status, 201);
      const { group, created } = await r.json();
      // 14 days, 4-slot cycle → slots 0,2,4,6,8,10,12 are workouts = 7
      assert.equal(created, 7);

      const rows = db.prepare(
        "SELECT name, start_date, template_uuid, schedule_group, recurrence FROM schedule_rules WHERE profile_uuid = 'p1' AND deleted = 0 ORDER BY start_date"
      ).all();
      assert.equal(rows.length, 7);
      assert.ok(rows.every(x => x.schedule_group === group && x.recurrence === 'once'));
      assert.equal(rows[0].start_date, '2026-08-03');
      assert.equal(rows[0].name, 'Arms A');
      assert.equal(rows[0].template_uuid, a);
      assert.equal(rows[1].start_date, '2026-08-05');
      assert.equal(rows[1].name, 'Abs');
      assert.equal(rows[1].template_uuid, b);
      assert.equal(rows[6].start_date, '2026-08-15'); // day offset 12
      assert.equal(rows[6].name, 'Arms A');
    } finally { srv.close(); }
  });

  it('GET /data/schedules groups; DELETE /data/schedules/:group cascades', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const a = await makeTemplate(base, token, 'A');
      const r1 = await post(base, '/data/schedules', token, {
        startDate: '2026-08-03', pattern: ['A', 'Rest'], assignments: { A: a }, weeks: 1, name: 'Every other day',
      });
      const { group } = await r1.json();
      await post(base, '/data/schedules', token, {
        startDate: '2026-09-01', pattern: ['A', 'Rest', 'Rest'], assignments: { A: a }, weeks: 1,
      });

      const list = await (await fetch(base + '/data/schedules', { headers: authHeader(token) })).json();
      assert.equal(list.schedules.length, 2);
      const first = list.schedules.find(s => s.group === group);
      assert.equal(first.remaining, 4);
      assert.equal(first.name, 'Every other day');

      const dr = await del(base, '/data/schedules/' + group, token);
      assert.equal(dr.status, 200);
      const live = db.prepare("SELECT COUNT(*) as c FROM schedule_rules WHERE profile_uuid = 'p1' AND deleted = 0 AND schedule_group = ?").get(group);
      assert.equal(live.c, 0, 'whole group tombstoned');
      const others = db.prepare("SELECT COUNT(*) as c FROM schedule_rules WHERE profile_uuid = 'p1' AND deleted = 0").get();
      assert.equal(others.c, 3, 'other schedule untouched');
    } finally { srv.close(); }
  });

  it('?shift=1 moves later workouts onto their predecessors dates and drops the last date', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const a = await makeTemplate(base, token, 'A');
      const b = await makeTemplate(base, token, 'B');
      await post(base, '/data/schedules', token, {
        startDate: '2026-08-03', pattern: ['A', 'Rest', 'B', 'Rest'], assignments: { A: a, B: b }, weeks: 1,
      });
      // Dates: 03 A, 05 B, 07 A, 09 B (7 days, slots 0,2,4,6 → 4 rules)
      const before = db.prepare("SELECT uuid, name, start_date FROM schedule_rules WHERE profile_uuid='p1' AND deleted=0 ORDER BY start_date").all();
      assert.equal(before.length, 4);

      // Delete the 05 B with shift → 07 A moves to 05, 09 B moves to 07; 09 empty
      const dr = await del(base, '/data/schedule-rules/' + before[1].uuid + '?shift=1', token);
      assert.equal((await dr.json()).shifted, true);

      const after = db.prepare("SELECT name, start_date FROM schedule_rules WHERE profile_uuid='p1' AND deleted=0 ORDER BY start_date").all();
      assert.deepEqual(after.map(r => [r.start_date, r.name]), [
        ['2026-08-03', 'A'],
        ['2026-08-05', 'A'],
        ['2026-08-07', 'B'],
      ]);
    } finally { srv.close(); }
  });

  it('DELETE /data/sagas/:uuid cascades chapters and planned workouts', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const saga = (await (await post(base, '/data/sagas', token, { name: 'Block' })).json()).uuid;
      const ch = (await (await post(base, '/data/chapters', token, { sagaUUID: saga, name: 'W1', weekIndex: 0 })).json()).uuid;
      await post(base, '/data/planned-workouts', token, { chapterUUID: ch, name: 'A', dayIndex: 0 });

      const dr = await del(base, '/data/sagas/' + saga, token);
      assert.equal(dr.status, 200);
      assert.equal(db.prepare('SELECT deleted FROM sagas WHERE uuid = ?').get(saga).deleted, 1);
      assert.equal(db.prepare('SELECT deleted FROM chapters WHERE uuid = ?').get(ch).deleted, 1);
      assert.equal(db.prepare("SELECT COUNT(*) as c FROM planned_workouts WHERE chapter_uuid = ? AND deleted = 0").get(ch).c, 0);
    } finally { srv.close(); }
  });
});

describe('Spec v2.58: quicklog + progression', () => {
  async function setupCombat(base, token, db) {
    const ov = await (await fetch(base + '/data/overview', { headers: authHeader(token) })).json();
    return ov.villains.find(v => v.slot === 'constant_heavy');
  }

  it('logs a session with per-set set_logs and suggests increase when all sets complete', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const heavy = await setupCombat(base, token, db);
      const exs = await (await fetch(base + '/data/exercises', { headers: authHeader(token) })).json();
      const bench = exs.exercises.find(e => e.name === 'Bench Press');

      const r = await post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: [{ exerciseUUID: bench.uuid, weightKg: 56.7, targetSets: 3, targetReps: 5, completedSets: 3 }],
      });
      assert.equal(r.status, 201);
      const body = await r.json();

      const sets = db.prepare("SELECT * FROM set_logs WHERE profile_uuid = 'p1' AND session_uuid = ? ORDER BY set_index").all(body.sessionUuid);
      assert.equal(sets.length, 3);
      assert.ok(sets.every(s => s.completed === 1 && s.weight_kg === 56.7 && s.reps === 5));

      const session = db.prepare('SELECT * FROM sessions WHERE uuid = ?').get(body.sessionUuid);
      assert.ok(session, 'session row written');
      assert.ok(session.xp_earned > 0, 'combat path ran');

      assert.equal(body.suggestions.length, 1);
      assert.equal(body.suggestions[0].suggest, 'increase');
      assert.ok(Math.abs(body.suggestions[0].nextWeightKg - (56.7 + 2.26796185)) < 0.001);
    } finally { srv.close(); }
  });

  it('suggests deload only on the third consecutive failure', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const heavy = await setupCombat(base, token, db);
      const exs = await (await fetch(base + '/data/exercises', { headers: authHeader(token) })).json();
      const ohp = exs.exercises.find(e => e.name === 'Overhead Press');
      const fail = () => post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: [{ exerciseUUID: ohp.uuid, weightKg: 40, targetSets: 3, targetReps: 5, completedSets: 1, failed: true }],
      });

      const first = await (await fail()).json();
      assert.equal(first.suggestions.length, 0, 'first failure: no suggestion');
      const second = await (await fail()).json();
      assert.equal(second.suggestions.length, 0, 'second failure: no suggestion');
      const third = await (await fail()).json();
      assert.equal(third.suggestions.length, 1, 'third consecutive failure suggests deload');
      assert.equal(third.suggestions[0].suggest, 'deload');
      assert.ok(Math.abs(third.suggestions[0].nextWeightKg - 34) < 0.001, '15% off 40kg = 34kg');

      // A completed workout resets the streak
      await post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: [{ exerciseUUID: ohp.uuid, weightKg: 34, targetSets: 3, targetReps: 5, completedSets: 3 }],
      });
      const afterReset = await (await fail()).json();
      assert.equal(afterReset.suggestions.length, 0, 'streak broken by the completed workout');
    } finally { srv.close(); }
  });
});

describe('Spec v2.58: quicklog input bounds (v2.74.1 hardening)', () => {
  async function withApp(fn) {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}/api/v1`;
      const ov = await (await fetch(base + '/data/overview', { headers: authHeader(token) })).json();
      const heavy = ov.villains.find(v => v.slot === 'constant_heavy');
      await fn({ base, token, db, heavy });
    } finally { srv.close(); }
  }

  const entry = (over = {}) => ({
    exerciseUUID: 'ex-1', templateExerciseUUID: 'te-1',
    targetSets: 3, targetReps: 5, weightKg: 60, completedSets: 3, ...over,
  });

  it('rejects an absurd targetSets instead of inserting a row per set', async () => {
    await withApp(async ({ base, token, db, heavy }) => {
      const r = await post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: [entry({ targetSets: 200000, completedSets: 0 })],
      });
      assert.equal(r.status, 400, 'unbounded targetSets must be refused');
      const rows = db.prepare("SELECT COUNT(*) c FROM set_logs WHERE profile_uuid = 'p1'").get().c;
      assert.equal(rows, 0, 'no set_logs written for a rejected request');
    });
  });

  it('rejects non-integer / out-of-range set and rep counts', async () => {
    await withApp(async ({ base, token, heavy }) => {
      const bad = [
        entry({ targetSets: 0 }), entry({ targetSets: 2.5 }), entry({ targetSets: 101 }),
        entry({ targetReps: -1 }), entry({ targetReps: 1001 }),
        entry({ completedSets: 4 }),           // > targetSets
        // Infinity/NaN can't survive JSON (both serialize to null, which is a VALID
        // "bodyweight, no load" value) — a non-numeric weight is the reachable bad case.
        entry({ weightKg: 'heavy' }),
      ];
      for (const e of bad) {
        const r = await post(base, '/data/quicklog', token, {
          villainUUID: heavy.uuid, durationMinutes: 45, entries: [e],
        });
        assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(e)}`);
      }
    });
  });

  it('rejects more entries than a real workout holds', async () => {
    await withApp(async ({ base, token, heavy }) => {
      const r = await post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: Array.from({ length: 51 }, () => entry()),
      });
      assert.equal(r.status, 400);
    });
  });

  it('rejects NaN/Infinity durationMinutes that typeof-number let through', async () => {
    await withApp(async ({ base, token, heavy }) => {
      // JSON has no NaN literal; a client sending one serializes null, and Infinity -> null too.
      // The finite-range guard also covers absurd-but-valid numbers.
      for (const d of [null, -5, 5000]) {
        const r = await post(base, '/data/quicklog', token, {
          villainUUID: heavy.uuid, durationMinutes: d, entries: [entry()],
        });
        assert.equal(r.status, 400, `expected 400 for durationMinutes=${d}`);
      }
    });
  });

  it('still accepts a normal workout', async () => {
    await withApp(async ({ base, token, db, heavy }) => {
      const r = await post(base, '/data/quicklog', token, {
        villainUUID: heavy.uuid, durationMinutes: 45,
        entries: [entry({ targetSets: 3, completedSets: 2 })],
      });
      assert.equal(r.status, 201);
      const rows = db.prepare("SELECT completed FROM set_logs WHERE profile_uuid = 'p1' ORDER BY set_index").all();
      assert.deepEqual(rows.map(x => x.completed), [1, 1, 0]);
    });
  });
});
