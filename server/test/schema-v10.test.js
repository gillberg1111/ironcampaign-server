import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { COMBAT, CONSTANT_FOES } from '../src/services/combat.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v10 (villain_events CHECK gains hydration)', () => {
  it('migration is idempotent and the CHECK stays fail-closed', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 18);

    const insert = db.prepare(`INSERT INTO villain_events
      (uuid, villain_uuid, timestamp, reason, damage, xp, profile_uuid)
      VALUES (?, 'v1', 1, ?, 2, 2, 'p1')`);
    insert.run('e-hydration', 'hydration'); // new reason accepted
    assert.throws(() => insert.run('e-bogus', 'bogus_reason'), /CHECK/); // CHECK intact
  });

  it('rebuild preserves existing rows (crash-safe: rebuild is transactional)', () => {
    const db = new Database(':memory:');
    migrate(db);
    // Rewind to v9 state: old-shape table (6-reason CHECK) with data, then re-migrate.
    db.exec('DROP TABLE villain_events');
    db.exec(`CREATE TABLE villain_events (
      uuid TEXT PRIMARY KEY, villain_uuid TEXT NOT NULL, timestamp INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('heavy_strike','chipped_damage','fortify','glancing_blow','confession','decay')),
      damage INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0,
      damage_roll INTEGER, result_stamp TEXT, buff_stamp TEXT, profile_uuid TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO villain_events (uuid, villain_uuid, timestamp, reason, damage, xp, profile_uuid)
      VALUES ('old-1', 'v1', 100, 'confession', 0, 5, 'p1'),
             ('old-2', 'v1', 200, 'decay', 0, 0, 'p1')`).run();
    db.prepare('DELETE FROM schema_version WHERE version >= 10').run();

    migrate(db);

    const rows = db.prepare('SELECT uuid FROM villain_events ORDER BY uuid').all().map(r => r.uuid);
    assert.deepEqual(rows, ['old-1', 'old-2']);
    db.prepare(`INSERT INTO villain_events (uuid, villain_uuid, timestamp, reason, damage, xp, profile_uuid)
      VALUES ('new-1', 'v1', 300, 'hydration', 2, 2, 'p1')`).run();
  });

  it('hydration villain_event round-trips through sync push', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      const res = await postJson(`${base}/api/v1/sync/push`, {
        changes: [{
          table: 'villain_events', uuid: 've-h1', field: '__row__',
          value: { uuid: 've-h1', villain_uuid: 'v1', timestamp: 100, reason: 'hydration',
                   damage: 2, xp: 2, damage_roll: null, result_stamp: 'small_tick', buff_stamp: null },
          hlc: '019077fd307b0100', deviceId: 'dev-a',
        }],
      }, authHeader(token));
      assert.equal(res.status, 200);
      assert.equal(res.data.applied, 1);
      const row = db.prepare("SELECT reason FROM villain_events WHERE uuid = 've-h1' AND profile_uuid = 'p1'").get();
      assert.equal(row.reason, 'hydration');
    } finally {
      srv.close();
    }
  });

  it('constant-foe and hydration constants match the iOS side', () => {
    assert.deepEqual(CONSTANT_FOES.heavy, { slot: 'constant_heavy', name: 'The Rust', tier: 'heavy', maxHP: 100, defeatXP: 30, description: 'Iron left out in the rain doesn\u2019t rust overnight\u2014it fades one thin layer at a time. Three days off is all it takes for the joints to stiffen. Get back under the bar before the surface hardens.' });
    assert.deepEqual(CONSTANT_FOES.minion, { slot: 'constant_minion', name: 'The Drought', tier: 'minion', maxHP: 16, defeatXP: 5, description: 'Your body runs on water the way an engine runs on oil. When the tank runs low, everything grinds a little harder. Fill up before you start the engine.' });
    assert.equal(COMBAT.HYDRATION_DAMAGE, 2);
    assert.equal(COMBAT.HYDRATION_XP, 2);
    assert.equal(COMBAT.HYDRATION_MIN_OZ, 8);
  });
});
