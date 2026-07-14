import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANT_FOES, COMBAT } from '../src/services/combat.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

function withServer(fn) {
  return async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try { await fn(base, db); } finally { srv.close(); }
  };
}

describe('Web app Phase 1 — review fixes', () => {
  it('overview provisions The Rust + The Drought for a web-only profile', withServer(async (base, db) => {
    const token = addDevice(db, 'web-only');
    const res = await fetch(`${base}/api/v1/data/overview`, { headers: { Authorization: authHeader(token).Authorization } });
    const body = await res.json();
    const slots = body.villains.map(v => v.slot).sort();
    assert.ok(slots.includes('constant_heavy'));
    assert.ok(slots.includes('constant_minion'));
    // Provisioning went through the merge engine: change_log rows exist for devices to pull.
    const logged = db.prepare("SELECT COUNT(*) AS c FROM change_log WHERE profile_uuid = 'web-only' AND table_name = 'villains'").get();
    assert.ok(logged.c > 0);
  }));

  it('water defeats the minion → bonus XP once + a FRESH minion row (old row never healed)', withServer(async (base, db) => {
    const token = addDevice(db, 'hydra');
    await fetch(`${base}/api/v1/data/overview`, { headers: { Authorization: authHeader(token).Authorization } }); // provision
    const minion = db.prepare("SELECT * FROM villains WHERE profile_uuid = 'hydra' AND slot = 'constant_minion'").get();

    const logs = CONSTANT_FOES.minion.maxHP / COMBAT.HYDRATION_DAMAGE; // 8 logs at 2 dmg
    for (let i = 0; i < logs; i++) {
      const r = await postJson(`${base}/api/v1/data/water`, {}, authHeader(token));
      assert.equal(r.status, 200, `water log ${i + 1}`);
    }

    const corpse = db.prepare('SELECT hp, active FROM villains WHERE uuid = ?').get(minion.uuid);
    assert.equal(corpse.hp, 0, 'old row stays at 0 — never healed (invariant #1)');
    assert.equal(corpse.active, 0, 'corpse deactivated');

    const fresh = db.prepare(
      "SELECT hp FROM villains WHERE profile_uuid = 'hydra' AND slot = 'constant_minion' AND active = 1 AND hp > 0"
    ).all();
    assert.equal(fresh.length, 1, 'exactly one fresh minion');
    assert.equal(fresh[0].hp, CONSTANT_FOES.minion.maxHP);

    const bonus = db.prepare(
      "SELECT COUNT(*) AS c FROM xp_events WHERE profile_uuid = 'hydra' AND reason = 'villain_defeated'"
    ).get();
    assert.equal(bonus.c, 1, 'defeat bonus granted exactly once');

    // All timestamps in SECONDS (device convention), not milliseconds.
    const m = db.prepare("SELECT timestamp FROM measurements WHERE profile_uuid = 'hydra' LIMIT 1").get();
    assert.ok(m.timestamp < 1e11, `measurement timestamp in seconds, got ${m.timestamp}`);
  }));

  it('a session cannot damage The Drought — it is weakened only by water (invariant)', withServer(async (base, db) => {
    const token = addDevice(db, 'drought-sess');
    await fetch(`${base}/api/v1/data/overview`, { headers: { Authorization: authHeader(token).Authorization } }); // provision
    const minion = db.prepare(
      "SELECT uuid, hp FROM villains WHERE profile_uuid = 'drought-sess' AND slot = 'constant_minion' AND active = 1 AND hp > 0"
    ).get();
    assert.equal(minion.hp, CONSTANT_FOES.minion.maxHP);

    const r = await postJson(
      `${base}/api/v1/data/sessions`,
      { villainUUID: minion.uuid, durationMinutes: 45, sessionType: 'fullScheduled' },
      authHeader(token)
    );
    assert.equal(r.status, 400, 'session against the water-only minion is rejected');

    const after = db.prepare('SELECT hp FROM villains WHERE uuid = ?').get(minion.uuid);
    assert.equal(after.hp, minion.hp, 'The Drought HP unchanged — no training damage applied');
    const sessions = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE profile_uuid = 'drought-sess'").get();
    assert.equal(sessions.c, 0, 'no session row written');
  }));

  it('/data/history and month-filtered /data/sessions see seconds-dated rows', withServer(async (base, db) => {
    const token = addDevice(db, 'hist');
    await fetch(`${base}/api/v1/data/overview`, { headers: { Authorization: authHeader(token).Authorization } }); // provision
    const heavy = db.prepare(
      "SELECT uuid FROM villains WHERE profile_uuid = 'hist' AND slot = 'constant_heavy' AND active = 1"
    ).get();
    const s = await postJson(`${base}/api/v1/data/sessions`,
      { villainUUID: heavy.uuid, durationMinutes: 45, sessionType: 'fullScheduled' }, authHeader(token));
    assert.equal(s.status, 201);
    await postJson(`${base}/api/v1/data/water`, {}, authHeader(token));

    // The month the session was just logged in (server-local, matching the endpoint's math)
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const hist = await fetch(`${base}/api/v1/data/history?month=${ym}`, { headers: { Authorization: authHeader(token).Authorization } });
    const h = await hist.json();
    // Regression: bounds were MILLISECONDS against seconds-valued date columns, so every
    // month returned zeros and the web History tab was permanently empty.
    assert.equal(h.totalSessions, 1, 'history sees the session just logged');
    assert.equal(h.measurementCount, 1, 'history sees the water measurement');
    assert.equal(h.dayBuckets.length, 1);
    assert.equal(h.dayBuckets[0].day, now.getDate(), 'session bucketed on the right day');

    const sess = await fetch(`${base}/api/v1/data/sessions?month=${ym}`, { headers: { Authorization: authHeader(token).Authorization } });
    const sj = await sess.json();
    assert.equal(sj.sessions.length, 1, 'month-filtered sessions list sees it too');
  }));

  it('encounter is idempotent: a live featured foe keeps the slot', withServer(async (base, db) => {
    const token = addDevice(db, 'enc');
    const first = await postJson(`${base}/api/v1/data/encounter`, {}, authHeader(token));
    assert.equal(first.status, 201);
    const second = await postJson(`${base}/api/v1/data/encounter`, {}, authHeader(token));
    assert.equal(second.data.villain.uuid, first.data.villain.uuid, 'no re-roll while alive');

    const featured = db.prepare(
      "SELECT COUNT(*) AS c FROM villains WHERE profile_uuid = 'enc' AND slot = 'featured' AND active = 1"
    ).get();
    assert.equal(featured.c, 1, 'never stacks featured villains');
  }));

  it('web write → device pull: a phone receives the console change via /sync/changes', withServer(async (base, db) => {
    const token = addDevice(db, 'conv');
    const created = await postJson(`${base}/api/v1/data/villains`, { name: 'Web Foe', maxHP: 60 }, authHeader(token));
    assert.equal(created.status, 201);

    const pull = await postJson(`${base}/api/v1/sync/changes`, { since: 0, deviceId: 'phone-1' }, authHeader(token));
    assert.equal(pull.status, 200);
    const mine = pull.data.changes.filter(c => c.uuid === created.data.uuid);
    assert.ok(mine.length >= 4, 'console-written fields arrive in the pull feed');
    assert.ok(mine.every(c => c.deviceId === 'server-console'), 'stamped with the console identity');
    const nameChange = mine.find(c => c.field === 'name');
    assert.equal(nameChange.value, 'Web Foe');
  }));

  it('session dates are seconds and the session syncs with its origin fields', withServer(async (base, db) => {
    const token = addDevice(db, 'sess');
    const enc = await postJson(`${base}/api/v1/data/encounter`, {}, authHeader(token));
    const res = await postJson(`${base}/api/v1/data/sessions`, {
      villainUUID: enc.data.villain.uuid, durationMinutes: 45,
      scheduleRuleUUID: 'rule-9', scheduledDate: '2026-07-10',
    }, authHeader(token));
    assert.equal(res.status, 201);

    const s = db.prepare("SELECT date, schedule_rule_uuid, scheduled_date FROM sessions WHERE profile_uuid = 'sess'").get();
    assert.ok(s.date < 1e11, `session date in seconds, got ${s.date}`);
    assert.equal(s.schedule_rule_uuid, 'rule-9');
    assert.equal(s.scheduled_date, '2026-07-10');
    // The constant heavy took the chain hit (first-ever session qualifies).
    const heavy = db.prepare("SELECT hp, max_hp FROM villains WHERE profile_uuid = 'sess' AND slot = 'constant_heavy' AND active = 1").get();
    assert.equal(heavy.hp, heavy.max_hp - 20, 'heavy strike damage applied to the chain');
  }));
});
