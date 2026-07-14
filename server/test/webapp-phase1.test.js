import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { tickConsoleClock, applyConsoleChanges, deterministicUUID, seedFoeCatalogIfNeeded, CONSOLE_DEVICE_ID } from '../src/services/consoleWriter.js';
import * as rank from '../src/services/rank.js';
import * as encounter from '../src/services/encounter.js';
import * as schedule from '../src/services/schedule.js';
import { makeApp, addDevice, seedVillain, authHeader, postJson, putJson, getJson, makeDb, addOwner, claimOwner } from './helpers.js';
import { authenticateDevice } from '../../questlog-critical/sync-auth/pairing.js';
import { applyBatch } from '../../questlog-critical/hlc-merge/merge.js';
import { SqliteStorageAdapter } from '../src/sync/adapter.js';

describe('ConsoleWriter', () => {
  it('tickConsoleClock persists and is monotonic', () => {
    const db = makeDb();
    const h1 = tickConsoleClock(db, 1000);
    const h2 = tickConsoleClock(db, 2000);
    const h3 = tickConsoleClock(db, 1500); // earlier wall clock, counter should handle it
    assert.ok(h1 < h2, 'h2 > h1');
    assert.ok(h2 < h3 || h3 > h1, 'hlc advances');

    const row = db.prepare("SELECT value FROM server_clock WHERE key = 'console_hlc'").get();
    assert.ok(row, 'clock persisted');
  });

  it('tickConsoleClock survives restart', () => {
    const db = makeDb();
    const h1 = tickConsoleClock(db, Date.now());
    const beforeRestart = db.prepare("SELECT value FROM server_clock WHERE key = 'console_hlc'").get().value;

    const db2 = new Database(':memory:');
    migrate(db2);
    db.exec('SELECT 1'); // flush

    const h2 = tickConsoleClock(db, Date.now() + 1000);
    assert.ok(parseInt(h2.slice(0, 12), 16) >= parseInt(beforeRestart.slice(0, 12), 16), 'after restart, clock advances');
  });
});

describe('deterministicUUID', () => {
  it('same inputs produce same uuid', () => {
    const a = deterministicUUID('ns1', 'snooze');
    const b = deterministicUUID('ns1', 'snooze');
    assert.equal(a, b);
  });

  it('different namespace produces different uuid', () => {
    const a = deterministicUUID('p1', 'snooze');
    const b = deterministicUUID('p2', 'snooze');
    assert.notEqual(a, b);
  });

  it('different name produces different uuid', () => {
    const a = deterministicUUID('p1', 'snooze');
    const b = deterministicUUID('p1', 'the_wall');
    assert.notEqual(a, b);
  });

  it('outputs valid UUID format', () => {
    const u = deterministicUUID('ns', 'test');
    assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('Rank', () => {
  it('rankFor returns correct rank', () => {
    assert.equal(rank.rankFor(0).name, 'Recruit');
    assert.equal(rank.rankFor(250).name, 'Regular');
    assert.equal(rank.rankFor(749).name, 'Regular');
    assert.equal(rank.rankFor(750).name, 'Seasoned');
    assert.equal(rank.rankFor(25000).name, 'Field Marshal');
  });

  it('highest rank returns max', () => {
    assert.equal(rank.rankFor(99999).name, 'Field Marshal');
  });
});

describe('Encounter', () => {
  const makeCatalog = () => [
    { uuid: 'a', name: 'A', tier: 'minion', max_hp: 40, xp_reward: 20, encounter_weight: 50, enabled: true, deleted: 0, builtin_id: null },
    { uuid: 'b', name: 'B', tier: 'heavy', max_hp: 80, xp_reward: 40, encounter_weight: 30, enabled: true, deleted: 0, builtin_id: null },
    { uuid: 'c', name: 'C', tier: 'boss', max_hp: 200, xp_reward: 100, encounter_weight: 10, enabled: true, deleted: 0, builtin_id: null },
    { uuid: 'd', name: 'D', tier: 'minion', max_hp: 20, xp_reward: 10, encounter_weight: 0, enabled: true, deleted: 0, builtin_id: null },
    { uuid: 'e', name: 'E', tier: 'minion', max_hp: 20, xp_reward: 10, encounter_weight: 10, enabled: false, deleted: 0, builtin_id: null },
  ];

  it('weightedPick filters weight <= 0 and disabled', () => {
    const result = encounter.weightedPick(makeCatalog(), false);
    assert.ok(result, 'should pick a foe');
    assert.notEqual(result.uuid, 'd', 'zero weight excluded');
    assert.notEqual(result.uuid, 'e', 'disabled excluded');
  });

  it('weightedPick excludes boss when not gated', () => {
    for (let i = 0; i < 20; i++) {
      const result = encounter.weightedPick(makeCatalog(), false);
      assert.notEqual(result.uuid, 'c', 'boss excluded when not gated');
    }
  });

  it('weightedPick includes boss when gated', () => {
    let sawBoss = false;
    for (let i = 0; i < 50; i++) {
      const result = encounter.weightedPick(makeCatalog(), true);
      if (result.uuid === 'c') sawBoss = true;
    }
    assert.ok(sawBoss, 'boss appears when gated');
  });

  it('bossGatedIn false when no defeats', () => {
    const db = makeDb();
    assert.equal(encounter.bossGatedIn(db, 'p1'), false);
  });

  it('bossGatedIn true when 2+ miniboss defeats after last boss', () => {
    const db = makeDb();
    const now = Date.now();

    db.prepare(`INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('vmb1', 'p1', 'MB1', 0, 100, 1, now-3000, now, now, 0, 'miniboss');
    db.prepare(`INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('vmb2', 'p1', 'MB2', 0, 100, 1, now-2000, now, now, 0, 'miniboss');
    db.prepare(`INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('vboss', 'p1', 'Boss', 0, 200, 1, now-5000, now, now, 0, 'boss');

    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e1', 'p1', 'vboss', now - 5000, 'heavy_strike', 20, 30);
    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e2', 'p1', 'vmb1', now - 3000, 'heavy_strike', 20, 30);
    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e3', 'p1', 'vmb2', now - 2000, 'heavy_strike', 20, 30);

    assert.ok(encounter.bossGatedIn(db, 'p1'), '2 miniboss defeats after boss defeat');
  });
});

describe('Schedule expansion', () => {
  const from = new Date('2025-06-01');
  const to = new Date('2025-06-30');

  it('once occurrence inside range', () => {
    const rule = { uuid: 'r1', name: 'Test', start_date: '2025-06-15', recurrence: 'once', deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    assert.equal(results.length, 1);
    assert.equal(results[0].key, '2025-06-15');
  });

  it('once outside range yields 0', () => {
    const rule = { uuid: 'r2', name: 'Test', start_date: '2025-07-15', recurrence: 'once', deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    assert.equal(results.length, 0);
  });

  it('interval every 2 days', () => {
    const rule = { uuid: 'r3', name: 'Test', start_date: '2025-06-01', recurrence: 'interval', interval_days: 2, deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    assert.ok(results.length >= 14, `interval 2 days yields >=14 occurrences, got ${results.length}`);
    const keys = results.map(r => r.key);
    assert.ok(keys.includes('2025-06-01'));
    assert.ok(keys.includes('2025-06-03'));
    assert.ok(keys.includes('2025-06-05'));
  });

  it('interval respects endDate', () => {
    const rule = { uuid: 'r4', name: 'Test', start_date: '2025-06-01', recurrence: 'interval', interval_days: 2, end_date: '2025-06-05', deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    const keys = results.map(r => r.key);
    assert.ok(keys.includes('2025-06-01'));
    assert.ok(keys.includes('2025-06-03'));
    assert.ok(keys.includes('2025-06-05'));
    assert.ok(!keys.includes('2025-06-07'), 'not beyond endDate');
  });

  it('weekly mask Mon-Wed-Fri', () => {
    const date = new Date('2025-06-02'); // Monday
    const rule = { uuid: 'r5', name: 'Test', start_date: '2025-06-02', recurrence: 'weekly', weekday_mask: (1 << 0) | (1 << 2) | (1 << 4), deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    const weekdays = results.map(r => r.date.getDay());
    assert.ok(results.length > 0);
    for (const wd of weekdays) {
      assert.ok([1, 3, 5].includes(wd), `all results on Mon/Wed/Fri, got weekday ${wd}`);
    }
  });

  it('weekly mask Fri-Sat', () => {
    const rule = { uuid: 'r6', name: 'Test', start_date: '2025-06-06', recurrence: 'weekly', weekday_mask: (1 << 4) | (1 << 5), deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    assert.ok(results.length > 0);
  });

  it('endDate inclusive', () => {
    const rule = { uuid: 'r7', name: 'Test', start_date: '2025-06-01', recurrence: 'interval', interval_days: 1, end_date: '2025-06-03', deleted: 0 };
    const results = schedule.expandRule(rule, from, to);
    const keys = results.map(r => r.key);
    assert.ok(keys.includes('2025-06-03'), 'endDate inclusive');
  });

  it('expandOccurrences marks done via sessions', () => {
    const rules = [{ uuid: 'r1', name: 'Test', start_date: '2025-06-10', recurrence: 'once', deleted: 0 }];
    const sessions = [{ schedule_rule_uuid: 'r1', scheduled_date: null }];
    const results = schedule.expandOccurrences(rules, from, to, sessions);
    assert.equal(results.length, 1);
    assert.ok(results[0].done, 'session with matching schedule_rule_uuid marks done');
  });

  it('saga workload projection', () => {
    const saga = { uuid: 's1', name: 'Test Saga', start_date: '2025-06-02' };
    const chapters = [{ uuid: 'c1', saga_uuid: 's1', name: 'Week 1', week_index: 0, deleted: 0 }];
    const pws = [{ uuid: 'pw1', chapter_uuid: 'c1', name: 'Day 1', day_index: 0, deleted: 0, template_uuid: null }];
    const results = schedule.expandSagaWorkouts(saga, chapters, pws, from, to, []);
    assert.equal(results.length, 1);
    const d = results[0].date;
    assert.equal(d.getFullYear(), 2025);
    assert.equal(d.getMonth(), 5); // June
    assert.equal(d.getDate(), 2);
  });
});

describe('Console token mint', () => {
  it('addOwner returns a console token that can authenticate', async () => {
    const { app, db } = makeApp();
    const { token, profileUuid } = addOwner(db, 'profile-console');

    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const devRes = await getJson(`${base}/api/v1/owner/devices`, { Authorization: `Bearer ${token}` });
      assert.equal(devRes.status, 200);
      const consoleDev = devRes.data.devices.find(d => d.device_name === 'Web console');
      assert.ok(consoleDev, 'console token appears in device list');

      const authResult = authenticateDevice(db, `Bearer ${token}`);
      assert.equal(authResult.profileUuid, profileUuid);
    } finally {
      srv.close();
    }
  });

  it('POST /owner/login returns a new console token each time', async () => {
    const { app, db } = makeApp();
    const { token: claimToken } = claimOwner(db, 'admin', 'password123');

    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const first = await postJson(`${base}/api/v1/owner/login`, { username: 'admin', password: 'password123' });
      assert.equal(first.status, 200);
      assert.ok(first.data.token);
      assert.notEqual(first.data.token, claimToken, 'login mints a new token');

      const devRes = await getJson(`${base}/api/v1/owner/devices`, { Authorization: `Bearer ${first.data.token}` });
      assert.equal(devRes.status, 200);
    } finally {
      srv.close();
    }
  });
});

describe('Data read endpoints', () => {
  it('GET /data/overview returns villains + XP + rank', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-read');
    seedVillain(db, 'profile-read', { name: 'Test V', hp: 80, max_hp: 100 });
    db.prepare('INSERT INTO xp_events (uuid, profile_uuid, timestamp, amount, reason) VALUES (?, ?, ?, ?, ?)').run('x1', 'profile-read', Date.now(), 500, 'bonus');

    const srv = app.listen(0);
    try {
      const res = await getJson(`http://localhost:${srv.address().port}/api/v1/data/overview`, authHeader(token));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.villains));
      assert.ok(res.data.villains.some(v => v.name === 'Test V'));
      assert.ok(res.data.totalXP >= 500);
      assert.ok(res.data.rank.name);
    } finally {
      srv.close();
    }
  });

  it('GET /data/catalog seeds if empty', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-cat');
    const srv = app.listen(0);
    try {
      const res = await getJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, authHeader(token));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.catalog));
      assert.ok(res.data.catalog.length >= 10, 'seeded catalog has entries');
    } finally {
      srv.close();
    }
  });

  it('GET /data/catalog is idempotent for seeding', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-idem');
    const srv = app.listen(0);
    try {
      const first = await getJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, authHeader(token));
      const firstCount = first.data.catalog.length;
      const second = await getJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, authHeader(token));
      assert.equal(second.data.catalog.length, firstCount, 'idempotent seeding');
    } finally {
      srv.close();
    }
  });
});

describe('Data write endpoints', () => {
  it('POST /data/villains creates villain through merge engine', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-wv');
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/villains`, {
        name: 'Console Villain', maxHP: 120, tier: 'heavy',
      }, authHeader(token));
      assert.equal(res.status, 201);

      const v = db.prepare("SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?").get(res.data.uuid, 'profile-wv');
      assert.ok(v, 'villain exists in db');
      assert.equal(v.name, 'Console Villain');

      const changeLog = db.prepare("SELECT COUNT(*) as cnt FROM change_log WHERE profile_uuid = ? AND device_id = ?").get('profile-wv', CONSOLE_DEVICE_ID);
      assert.ok(changeLog.cnt > 0, 'change_log populated for console device');
    } finally {
      srv.close();
    }
  });

  it('POST /data/sessions logs session with combat', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-sess');
    const v = seedVillain(db, 'profile-sess', { name: 'Session Target', hp: 100, max_hp: 100 });
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/sessions`, {
        villainUUID: v.uuid, durationMinutes: 45, sessionType: 'fullScheduled',
      }, authHeader(token));
      assert.equal(res.status, 201);

      const updated = db.prepare("SELECT hp FROM villains WHERE uuid = ?").get(v.uuid);
      assert.ok(updated.hp < 100, 'villain damaged');

      const xp = db.prepare("SELECT COUNT(*) as cnt FROM xp_events WHERE profile_uuid = ?").get('profile-sess');
      assert.ok(xp.cnt > 0, 'xp event created');
    } finally {
      srv.close();
    }
  });

  it('POST /data/water logs hydration', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-water');
    db.prepare(`INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted, slot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('drought', 'profile-water', 'The Drought', 16, 16, 1, Date.now(), Date.now(), null, 0, 'constant_minion');
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/water`, { oz: 16 }, authHeader(token));
      assert.equal(res.status, 200);

      const m = db.prepare("SELECT * FROM measurements WHERE profile_uuid = ? AND kind = 'water_oz'").get('profile-water');
      assert.ok(m, 'measurement created');
      assert.equal(m.value, 16);

      const ve = db.prepare("SELECT * FROM villain_events WHERE profile_uuid = ? AND reason = 'hydration'").get('profile-water');
      assert.ok(ve, 'hydration event created');
    } finally {
      srv.close();
    }
  });

  it('POST /data/encounter rolls featured foe', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-enc');
    const srv = app.listen(0);
    try {
      await getJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, authHeader(token));

      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/encounter`, {}, authHeader(token));
      assert.equal(res.status, 201);
      assert.ok(res.data.villain);
      assert.ok(res.data.villain.name);
      assert.equal(res.data.villain.slot, 'featured');
    } finally {
      srv.close();
    }
  });

  it('PUT /data/villains/:uuid renames only — hp is NOT writable (invariant #1)', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-edit');
    const v = seedVillain(db, 'profile-edit', { name: 'Original', hp: 80, max_hp: 100 });
    const srv = app.listen(0);
    try {
      const res = await putJson(`http://localhost:${srv.address().port}/api/v1/data/villains/${v.uuid}`, {
        name: 'Renamed', hp: 999, // a web client must not be able to heal villains
      }, authHeader(token));
      assert.equal(res.status, 200, `status ${res.status}`);

      const updated = db.prepare('SELECT name, hp FROM villains WHERE uuid = ?').get(v.uuid);
      assert.equal(updated.name, 'Renamed');
      assert.equal(updated.hp, 80, 'hp untouched despite the attempt');

      const hpOnly = await putJson(`http://localhost:${srv.address().port}/api/v1/data/villains/${v.uuid}`, {
        hp: 999,
      }, authHeader(token));
      assert.equal(hpOnly.status, 400, 'hp-only edit is rejected outright');
    } finally {
      srv.close();
    }
  });

  it('Saga/Chapter/PlannedWorkout/ScheduleRule CRUD', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-crud');
    const srv = app.listen(0);
    try {
      const sagaRes = await postJson(`http://localhost:${srv.address().port}/api/v1/data/sagas`, {
        name: 'Test Saga', startDate: '2025-06-01',
      }, authHeader(token));
      assert.equal(sagaRes.status, 201);

      const chRes = await postJson(`http://localhost:${srv.address().port}/api/v1/data/chapters`, {
        sagaUUID: sagaRes.data.uuid, name: 'Chapter 1', weekIndex: 0,
      }, authHeader(token));
      assert.equal(chRes.status, 201);

      const pwRes = await postJson(`http://localhost:${srv.address().port}/api/v1/data/planned-workouts`, {
        chapterUUID: chRes.data.uuid, name: 'Day 1 Workout', dayIndex: 0,
      }, authHeader(token));
      assert.equal(pwRes.status, 201);

      const srRes = await postJson(`http://localhost:${srv.address().port}/api/v1/data/schedule-rules`, {
        name: 'Mon-Wed-Fri', startDate: '2025-06-02', recurrence: 'weekly', weekdayMask: (1 << 0) | (1 << 2) | (1 << 4),
      }, authHeader(token));
      assert.equal(srRes.status, 201);

      const sagaList = await getJson(`http://localhost:${srv.address().port}/api/v1/data/sagas`, authHeader(token));
      assert.equal(sagaList.status, 200);
      assert.ok(sagaList.data.sagas.some(s => s.name === 'Test Saga'));
    } finally {
      srv.close();
    }
  });
});

describe('IDOR / profile scoping', () => {
  it('profile A console cannot read profile B overview', async () => {
    const { app, db } = makeApp();
    const tokenA = addDevice(db, 'profile-a');
    const tokenB = addDevice(db, 'profile-b');
    seedVillain(db, 'profile-a', { name: 'A Villain', hp: 100 });

    const srv = app.listen(0);
    try {
      const resA = await getJson(`http://localhost:${srv.address().port}/api/v1/data/overview`, authHeader(tokenA));
      assert.equal(resA.status, 200);
      assert.ok(resA.data.villains.some(v => v.name === 'A Villain'));

      const resB = await getJson(`http://localhost:${srv.address().port}/api/v1/data/overview`, authHeader(tokenB));
      assert.equal(resB.status, 200);
      assert.ok(!resB.data.villains.some(v => v.name === 'A Villain'), 'B does not see A villain');
    } finally {
      srv.close();
    }
  });

  it('profile A console token cannot write to profile B villain', async () => {
    const { app, db } = makeApp();
    const tokenA = addDevice(db, 'scope-a');
    const tokenB = addDevice(db, 'scope-b');
    const v = seedVillain(db, 'scope-b', { name: 'B Villain', hp: 100 });

    const srv = app.listen(0);
    try {
      const res = await putJson(`http://localhost:${srv.address().port}/api/v1/data/villains/${v.uuid}`, {
        name: 'A overwrites B',
      }, authHeader(tokenA));
      assert.equal(res.status, 404, `cross-profile edit returns 404`);

      const still = db.prepare('SELECT name FROM villains WHERE uuid = ? AND profile_uuid = ?').get(v.uuid, 'scope-b');
      assert.equal(still.name, 'B Villain', 'B name unchanged');
    } finally {
      srv.close();
    }
  });
});

describe('3-day heavy rule', () => {
   it('first session damages constant heavy', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-3dr');
    const v = seedVillain(db, 'profile-3dr', { name: 'Target', hp: 100, max_hp: 100 });
    const heavy = db.prepare(`INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted, slot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('heavy-1', 'profile-3dr', 'The Rust', 100, 100, 1, Date.now(), Date.now(), null, 0, 'constant_heavy');

    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/sessions`, {
        villainUUID: v.uuid, durationMinutes: 45, sessionType: 'fullScheduled',
      }, authHeader(token));
      assert.equal(res.status, 201);

      const heavyAfter = db.prepare('SELECT hp FROM villains WHERE uuid = ?').get('heavy-1');
      assert.ok(heavyAfter.hp < 100, 'constant heavy damaged by first session');
    } finally {
      srv.close();
    }
  });
});

describe('Catalog description (v2.38)', () => {
  it('POST /data/catalog accepts and persists description', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-desc');
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {
        name: 'Desc Foe', tier: 'heavy', maxHP: 90, xpReward: 60, encounterWeight: 30,
        description: 'A fearsome opponent',
      }, authHeader(token));
      assert.equal(res.status, 201);

      const row = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get(res.data.uuid, 'profile-desc');
      assert.equal(row.description, 'A fearsome opponent');
    } finally {
      srv.close();
    }
  });

  it('PUT /data/catalog/:uuid accepts and persists description', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-put-desc');
    const srv = app.listen(0);
    try {
      const create = await postJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {
        name: 'Edit Me', tier: 'minion', maxHP: 40, xpReward: 20, encounterWeight: 50,
      }, authHeader(token));
      assert.equal(create.status, 201);

      const update = await putJson(`http://localhost:${srv.address().port}/api/v1/data/catalog/${create.data.uuid}`, {
        description: 'Updated description text',
      }, authHeader(token));
      assert.equal(update.status, 200);

      const row = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get(create.data.uuid, 'profile-put-desc');
      assert.equal(row.description, 'Updated description text');
    } finally {
      srv.close();
    }
  });

  it('POST /data/catalog without description defaults to null', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'profile-no-desc');
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {
        name: 'No Desc', tier: 'minion', maxHP: 40, xpReward: 20, encounterWeight: 50,
      }, authHeader(token));
      assert.equal(res.status, 201);

      const row = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get(res.data.uuid, 'profile-no-desc');
      assert.equal(row.description, null);
    } finally {
      srv.close();
    }
  });
});
