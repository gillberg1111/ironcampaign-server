import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authenticateDevice } from '../../../questlog-critical/sync-auth/pairing.js';
import * as combat from '../services/combat.js';
import * as rank from '../services/rank.js';
import * as encounter from '../services/encounter.js';
import * as schedule from '../services/schedule.js';
import { tickConsoleClock, applyConsoleChanges, CONSOLE_DEVICE_ID, seedFoeCatalogIfNeeded, seedExerciseLibraryIfNeeded } from '../services/consoleWriter.js';

export default function dataRoutes(db) {
  const router = Router();

  const auth = (req, res, next) => {
    try {
      const authResult = authenticateDevice(db, req.headers.authorization);
      req.profileUuid = authResult.profileUuid;
      req.deviceTokenId = authResult.deviceTokenId;
      next();
    } catch (e) {
      res.status(e.status || 401).json({ error: 'unauthorized' });
    }
  };

  // ── Read endpoints (§3) ──

  router.get('/data/overview', auth, (req, res) => {
    const puid = req.profileUuid;
    ensureConstants(db, puid); // web-only profiles get The Rust / The Drought here
    const villains = db.prepare(
      'SELECT uuid, name, hp, max_hp, active, deleted, tier, xp_reward, slot, catalog_uuid, last_session_at FROM villains WHERE profile_uuid = ? AND deleted = 0 AND active = 1'
    ).all(puid);
    const totalRow = db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM xp_events WHERE profile_uuid = ?'
    ).get(puid);
    const totalXP = totalRow.total;
    const currentRank = rank.rankFor(totalXP);

    res.json({ villains, totalXP, rank: { name: currentRank.name, threshold: currentRank.threshold } });
  });

  router.get('/data/sessions', auth, (req, res) => {
    const puid = req.profileUuid;
    const month = req.query.month; // yyyy-mm
    let sessions;
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const start = new Date(y, m - 1, 1).getTime();
      const end = new Date(y, m, 1).getTime();
      sessions = db.prepare(
        'SELECT * FROM sessions WHERE profile_uuid = ? AND date >= ? AND date < ? ORDER BY date DESC'
      ).all(puid, start, end);
    } else {
      sessions = db.prepare(
        'SELECT * FROM sessions WHERE profile_uuid = ? ORDER BY date DESC'
      ).all(puid);
    }
    res.json({ sessions });
  });

  router.get('/data/sets', auth, (req, res) => {
    const puid = req.profileUuid;
    const sid = req.query.session;
    if (!sid) return res.status(400).json({ error: 'session query param required' });
    const sets = db.prepare(
      'SELECT * FROM set_logs WHERE profile_uuid = ? AND session_uuid = ? ORDER BY set_index'
    ).all(puid, sid);
    res.json({ sets });
  });

  router.get('/data/history', auth, (req, res) => {
    const puid = req.profileUuid;
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'month query param required (yyyy-mm)' });

    const [y, m] = month.split('-').map(Number);
    const start = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 1).getTime();

    const sessions = db.prepare(
      'SELECT uuid, date, duration_minutes, xp_earned, combat_action_reason, villain_uuid FROM sessions WHERE profile_uuid = ? AND date >= ? AND date < ?'
    ).all(puid, start, end);

    const totalSessions = sessions.length;
    const totalXP = sessions.reduce((s, r) => s + r.xp_earned, 0);
    const totalDuration = sessions.reduce((s, r) => s + r.duration_minutes, 0);

    const sessionUuids = sessions.map(r => r.uuid);
    const setCounts = {};
    if (sessionUuids.length > 0) {
      const placeholders = sessionUuids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT session_uuid, COUNT(*) as cnt FROM set_logs WHERE profile_uuid = ? AND session_uuid IN (${placeholders}) GROUP BY session_uuid`
      ).all(puid, ...sessionUuids);
      for (const row of rows) setCounts[row.session_uuid] = row.cnt;
    }

    const dayBuckets = {};
    for (const s of sessions) {
      const d = new Date(s.date);
      const day = d.getDate();
      if (!dayBuckets[day]) dayBuckets[day] = { day, sessions: 0, xp: 0, damage: 0, sets: 0 };
      dayBuckets[day].sessions += 1;
      dayBuckets[day].xp += s.xp_earned;
      dayBuckets[day].damage += 0;
      dayBuckets[day].sets += setCounts[s.uuid] ?? 0;
    }

    const perVillain = {};
    for (const s of sessions) {
      if (!s.villain_uuid) continue;
      if (!perVillain[s.villain_uuid]) perVillain[s.villain_uuid] = { villainUUID: s.villain_uuid, villainName: '', damage: 0 };
      perVillain[s.villain_uuid].damage += 0;
    }
    for (const row of db.prepare(
      'SELECT uuid, name FROM villains WHERE profile_uuid = ?'
    ).all(puid)) {
      if (perVillain[row.uuid]) perVillain[row.uuid].villainName = row.name;
    }

    const measurementCountRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM measurements WHERE profile_uuid = ? AND timestamp >= ? AND timestamp < ?'
    ).get(puid, start, end);

    const setLogCountRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM set_logs WHERE profile_uuid = ? AND timestamp >= ? AND timestamp < ?'
    ).get(puid, start, end);

    res.json({
      monthLabel: `${y}-${String(m).padStart(2, '0')}`,
      totalSessions,
      totalXP,
      totalDamage: 0,
      measurementCount: measurementCountRow.cnt,
      setLogCount: setLogCountRow.cnt,
      dayBuckets: Object.values(dayBuckets).sort((a, b) => a.day - b.day),
      perVillainDmg: Object.values(perVillain),
      daysInMonth: new Date(y, m, 0).getDate(),
      firstWeekday: (new Date(y, m - 1, 1).getDay() + 6) % 7,
      sessions,
    });
  });

  router.get('/data/chronicle', auth, (req, res) => {
    const puid = req.profileUuid;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const xpEvents = db.prepare(
      'SELECT * FROM xp_events WHERE profile_uuid = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(puid, limit);
    const narrations = db.prepare(
      'SELECT * FROM narrations WHERE profile_uuid = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(puid, limit);
    const totalRow = db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM xp_events WHERE profile_uuid = ?'
    ).get(puid);

    res.json({ xpEvents, narrations, totalXP: totalRow.total });
  });

  router.get('/data/catalog', auth, (req, res) => {
    seedFoeCatalogIfNeeded(db, req.profileUuid);
    const catalog = db.prepare(
      'SELECT * FROM foe_catalog WHERE profile_uuid = ? AND deleted = 0 ORDER BY tier, name'
    ).all(req.profileUuid);
    res.json({ catalog });
  });

  router.get('/data/sagas', auth, (req, res) => {
    const puid = req.profileUuid;
    const sagas = db.prepare(
      'SELECT * FROM sagas WHERE profile_uuid = ? AND deleted = 0 ORDER BY created_at'
    ).all(puid);
    const result = [];
    for (const saga of sagas) {
      const chapters = db.prepare(
        'SELECT * FROM chapters WHERE profile_uuid = ? AND saga_uuid = ? ORDER BY week_index'
      ).all(puid, saga.uuid);
      const plannedWorkouts = [];
      for (const ch of chapters) {
        const pws = db.prepare(
          'SELECT * FROM planned_workouts WHERE profile_uuid = ? AND chapter_uuid = ? ORDER BY day_index, position'
        ).all(puid, ch.uuid);
        plannedWorkouts.push(...pws);
      }
      result.push({ ...saga, chapters, plannedWorkouts });
    }
    res.json({ sagas: result });
  });

  router.get('/data/schedule', auth, (req, res) => {
    const puid = req.profileUuid;
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'month query param required (yyyy-mm)' });

    const [y, m] = month.split('-').map(Number);
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0);

    const rules = db.prepare(
      'SELECT * FROM schedule_rules WHERE profile_uuid = ?'
    ).all(puid);
    const sessions = db.prepare(
      'SELECT * FROM sessions WHERE profile_uuid = ?'
    ).all(puid);

    const ruleOccurrences = schedule.expandOccurrences(rules, from, to, sessions);

    const sagas = db.prepare(
      'SELECT * FROM sagas WHERE profile_uuid = ? AND deleted = 0'
    ).all(puid);
    const sagaOccurrences = [];
    for (const saga of sagas) {
      const chapters = db.prepare(
        'SELECT * FROM chapters WHERE profile_uuid = ? AND saga_uuid = ?'
      ).all(puid, saga.uuid);
      const pws = db.prepare(
        'SELECT * FROM planned_workouts WHERE profile_uuid = ?'
      ).all(puid);
      sagaOccurrences.push(...schedule.expandSagaWorkouts(saga, chapters, pws, from, to, sessions));
    }

    const all = [...ruleOccurrences, ...sagaOccurrences].sort((a, b) => a.date - b.date);
    res.json({ occurrences: all });
  });

  // ── Write endpoints (via ConsoleWriter) ──

  router.post('/data/villains', auth, (req, res) => {
    const { name, maxHP, tier } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);

    // hp starts at max_hp exactly like device creation; tier stays unset for custom
    // villains (the phone leaves it nil — 'minion' would quietly enter gating math).
    const changes = [
      { table: 'villains', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'max_hp', value: maxHP ?? 100, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'hp', value: maxHP ?? 100, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'active', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (tier !== undefined) {
      changes.push({ table: 'villains', uuid, field: 'tier', value: tier, hlc, deviceId: CONSOLE_DEVICE_ID });
    }
    applyConsoleChanges(db, puid, changes);

    res.status(201).json({ uuid });
  });

  router.put('/data/villains/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const v = db.prepare('SELECT uuid FROM villains WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!v) return res.status(404).json({ error: 'not found' });

    // Rename ONLY — the exact edit surface the phone offers. hp/max_hp/slot etc. are
    // engine-owned: exposing hp here would let the web heal villains outside
    // confession/decay (invariant #1, review-blocking).
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['name']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'villains', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'only "name" is editable here' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.post('/data/villains/:uuid/archive', auth, (req, res) => {
    const puid = req.profileUuid;
    const v = db.prepare('SELECT uuid FROM villains WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!v) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'villains', uuid: req.params.uuid, field: 'active', value: false, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.json({ ok: true });
  });

    router.post('/data/catalog', auth, (req, res) => {
      const { name, tier, maxHP, xpReward, encounterWeight, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);

    applyConsoleChanges(db, puid, [
      { table: 'foe_catalog', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'tier', value: tier ?? 'minion', hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'max_hp', value: maxHP ?? 100, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'xp_reward', value: xpReward ?? 50, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'encounter_weight', value: encounterWeight ?? 30, hlc, deviceId: CONSOLE_DEVICE_ID },
        { table: 'foe_catalog', uuid, field: 'enabled', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
        { table: 'foe_catalog', uuid, field: 'description', value: description ?? null, hlc, deviceId: CONSOLE_DEVICE_ID },
      ]);

    res.status(201).json({ uuid });
  });

  router.put('/data/catalog/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const c = db.prepare('SELECT uuid FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!c) return res.status(404).json({ error: 'not found' });

    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
      const fields = ['name', 'tier', 'max_hp', 'xp_reward', 'encounter_weight', 'enabled', 'deleted', 'description'];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'foe_catalog', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields to update' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.post('/data/sessions', auth, (req, res) => {
    const { villainUUID, durationMinutes, sessionType, sagaUUID, chapterUUID, scheduleRuleUUID, plannedWorkoutUUID, scheduledDate } = req.body;
    if (!villainUUID || typeof durationMinutes !== 'number') return res.status(400).json({ error: 'villainUUID and durationMinutes required' });

    const puid = req.profileUuid;
    ensureConstants(db, puid);
    const villain = db.prepare('SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?').get(villainUUID, puid);
    if (!villain) return res.status(404).json({ error: 'villain not found' });
    // The Drought (constant_minion) is weakened only by hydration (POST /data/water). A training
    // session must never damage it — enforce the water-only invariant server-side, not just in the UI.
    if (villain.slot === 'constant_minion') return res.status(400).json({ error: 'This foe is weakened only by water.' });

    const type = sessionType || combat.classification(durationMinutes);
    if (!['fullScheduled', 'shortSession', 'mobilityRecovery'].includes(type)) return res.status(400).json({ error: 'invalid sessionType' });

    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const beforeHP = villain.hp;
    const gap = sessionGapDays(db, puid);
    const result = combat.executeSession(villain, type);

    const sessionUuid = randomUUID();
    const eventUuid = randomUUID();
    const xpUuid = randomUUID();
    const hlc = tickConsoleClock(db, nowMs);

    const changes = [
      { table: 'villains', uuid: villainUUID, field: 'hp', value: villain.hp, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid: villainUUID, field: 'last_session_at', value: now, hlc, deviceId: CONSOLE_DEVICE_ID },
      {
        table: 'villain_events', uuid: eventUuid, field: '__row__',
        value: { uuid: eventUuid, villain_uuid: villainUUID, timestamp: now, reason: result.reason, damage: result.damageDealt, xp: result.xpEarned, damage_roll: null, result_stamp: null, buff_stamp: result.buffStamp },
        hlc, deviceId: CONSOLE_DEVICE_ID,
      },
      {
        table: 'xp_events', uuid: xpUuid, field: '__row__',
        value: { uuid: xpUuid, timestamp: now, amount: result.xpEarned, reason: result.reason, villain_uuid: villainUUID, session_uuid: null },
        hlc, deviceId: CONSOLE_DEVICE_ID,
      },
    ];

    const sessionValue = {
      uuid: sessionUuid, saga_uuid: sagaUUID ?? null, chapter_uuid: chapterUUID ?? null,
      villain_uuid: villainUUID, date: now, duration_minutes: durationMinutes,
      status: 'completed', session_type: type, xp_earned: result.xpEarned,
      combat_action_reason: result.reason, created_at: now,
      schedule_rule_uuid: scheduleRuleUUID ?? null, planned_workout_uuid: plannedWorkoutUUID ?? null,
      scheduled_date: scheduledDate ?? null,
    };
    for (const [k, v] of Object.entries(sessionValue)) {
      if (v !== null && v !== undefined) {
        changes.push({ table: 'sessions', uuid: sessionUuid, field: k, value: v, hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }

    if (beforeHP > 0 && villain.hp <= 0) {
      changes.push(...defeatChanges(villain, now, tickConsoleClock(db, nowMs)));
    }

    if (gap === null || gap <= 3) {
      const heavy = db.prepare(
        "SELECT * FROM villains WHERE profile_uuid = ? AND slot = 'constant_heavy' AND deleted = 0 AND active = 1"
      ).get(puid);
      if (heavy && heavy.uuid !== villainUUID && result.damageDealt > 0) {
        const updatedHeavy = { ...heavy, hp: Math.max(0, heavy.hp - result.damageDealt) };
        const heavyHlc = tickConsoleClock(db, nowMs);
        const heavyEventUuid = randomUUID();
        changes.push(
          { table: 'villains', uuid: heavy.uuid, field: 'hp', value: updatedHeavy.hp, hlc: heavyHlc, deviceId: CONSOLE_DEVICE_ID },
          { table: 'villains', uuid: heavy.uuid, field: 'last_session_at', value: now, hlc: heavyHlc, deviceId: CONSOLE_DEVICE_ID },
          {
            table: 'villain_events', uuid: heavyEventUuid, field: '__row__',
            value: { uuid: heavyEventUuid, villain_uuid: heavy.uuid, timestamp: now, reason: result.reason, damage: result.damageDealt, xp: 0, damage_roll: null, result_stamp: null, buff_stamp: null },
            hlc: heavyHlc, deviceId: CONSOLE_DEVICE_ID,
          },
        );
        if (heavy.hp > 0 && updatedHeavy.hp <= 0) {
          changes.push(...defeatChanges(updatedHeavy, now, tickConsoleClock(db, nowMs)));
        }
      }
    }

    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ sessionUuid, villain });
  });

  router.post('/data/water', auth, (req, res) => {
    const oz = req.body.oz ?? combat.COMBAT.HYDRATION_MIN_OZ;
    if (oz < combat.COMBAT.HYDRATION_MIN_OZ) return res.status(400).json({ error: `minimum ${combat.COMBAT.HYDRATION_MIN_OZ} oz` });
    const puid = req.profileUuid;
    ensureConstants(db, puid);

    const minion = db.prepare(
      "SELECT * FROM villains WHERE profile_uuid = ? AND slot = 'constant_minion' AND deleted = 0 AND active = 1 AND hp > 0"
    ).get(puid);
    if (!minion) return res.status(400).json({ error: 'no active minion' });

    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const mUuid = randomUUID();
    const veUuid = randomUUID();
    const xpUuid = randomUUID();

    const changes = [
      {
        table: 'measurements', uuid: mUuid, field: '__row__',
        value: { uuid: mUuid, timestamp: now, kind: 'water_oz', value: oz, unit: 'oz', replaces_uuid: null },
        hlc, deviceId: CONSOLE_DEVICE_ID,
      },
      {
        table: 'villain_events', uuid: veUuid, field: '__row__',
        value: { uuid: veUuid, villain_uuid: minion.uuid, timestamp: now, reason: 'hydration', damage: combat.COMBAT.HYDRATION_DAMAGE, xp: combat.COMBAT.HYDRATION_XP, damage_roll: null, result_stamp: 'small_tick', buff_stamp: null },
        hlc, deviceId: CONSOLE_DEVICE_ID,
      },
      {
        table: 'xp_events', uuid: xpUuid, field: '__row__',
        value: { uuid: xpUuid, timestamp: now, amount: combat.COMBAT.HYDRATION_XP, reason: 'bonus', villain_uuid: minion.uuid, session_uuid: null },
        hlc, deviceId: CONSOLE_DEVICE_ID,
      },
      { table: 'villains', uuid: minion.uuid, field: 'hp', value: Math.max(0, minion.hp - combat.COMBAT.HYDRATION_DAMAGE), hlc, deviceId: CONSOLE_DEVICE_ID },
    ];

    const afterHP = Math.max(0, minion.hp - combat.COMBAT.HYDRATION_DAMAGE);
    if (minion.hp > 0 && afterHP <= 0) {
      changes.push(...defeatChanges({ ...minion, hp: afterHP }, now, tickConsoleClock(db, nowMs)));
    }

    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true, oz });
  });

  router.post('/data/encounter', auth, (req, res) => {
    const puid = req.profileUuid;
    seedFoeCatalogIfNeeded(db, puid);

    // Idempotent: a live featured foe keeps the slot (matches iOS ensureFeaturedFoe —
    // rolling must never stack featured villains). A defeated one vacates it first.
    const liveFeatured = db.prepare(
      "SELECT * FROM villains WHERE profile_uuid = ? AND slot = 'featured' AND active = 1 AND deleted = 0 AND hp > 0"
    ).get(puid);
    if (liveFeatured) return res.json({ villain: liveFeatured });

    const corpses = db.prepare(
      "SELECT uuid FROM villains WHERE profile_uuid = ? AND slot = 'featured' AND active = 1 AND deleted = 0 AND hp <= 0"
    ).all(puid);
    if (corpses.length > 0) {
      const vacateHlc = tickConsoleClock(db, Date.now());
      applyConsoleChanges(db, puid, corpses.map(c =>
        ({ table: 'villains', uuid: c.uuid, field: 'active', value: false, hlc: vacateHlc, deviceId: CONSOLE_DEVICE_ID })));
    }

    const catalog = db.prepare(
      'SELECT * FROM foe_catalog WHERE profile_uuid = ? AND deleted = 0 AND enabled = 1'
    ).all(puid);

    const gated = encounter.bossGatedIn(db, puid);
    const pick = encounter.weightedPick(catalog, gated);
    if (!pick) return res.status(400).json({ error: 'no eligible foes' });

    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);

    applyConsoleChanges(db, puid, [
      { table: 'villains', uuid, field: 'name', value: pick.name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'max_hp', value: pick.max_hp, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'hp', value: pick.max_hp, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'active', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'tier', value: pick.tier, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'xp_reward', value: pick.xp_reward, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'slot', value: 'featured', hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'villains', uuid, field: 'catalog_uuid', value: pick.uuid, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);

    const villain = db.prepare('SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?').get(uuid, puid);
    res.status(201).json({ villain });
  });

  // ── Saga CRUD ──

  router.post('/data/sagas', auth, (req, res) => {
    const { name, description, startDate } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [
      { table: 'sagas', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'sagas', uuid, field: 'active', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (description) changes.push({ table: 'sagas', uuid, field: 'description', value: description, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (startDate) changes.push({ table: 'sagas', uuid, field: 'start_date', value: startDate, hlc, deviceId: CONSOLE_DEVICE_ID });
    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ uuid });
  });

  router.put('/data/sagas/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const s = db.prepare('SELECT uuid FROM sagas WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!s) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['name', 'description', 'active', 'start_date', 'current_chapter_uuid']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'sagas', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.post('/data/chapters', auth, (req, res) => {
    const { sagaUUID, name, weekIndex } = req.body;
    if (!sagaUUID || !name) return res.status(400).json({ error: 'sagaUUID and name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'chapters', uuid, field: 'saga_uuid', value: sagaUUID, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'chapters', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'chapters', uuid, field: 'week_index', value: weekIndex ?? 0, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.status(201).json({ uuid });
  });

  router.put('/data/chapters/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const c = db.prepare('SELECT uuid FROM chapters WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!c) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['name', 'week_index', 'notes', 'saga_uuid']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'chapters', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.delete('/data/chapters/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const c = db.prepare('SELECT uuid FROM chapters WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!c) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const pws = db.prepare(
      'SELECT uuid FROM planned_workouts WHERE chapter_uuid = ? AND profile_uuid = ?'
    ).all(req.params.uuid, puid);
    applyConsoleChanges(db, puid, [
      { table: 'chapters', uuid: req.params.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
      ...pws.map(p => ({ table: 'planned_workouts', uuid: p.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID })),
    ]);
    res.json({ ok: true });
  });

  router.post('/data/planned-workouts', auth, (req, res) => {
    const { chapterUUID, name, dayIndex, templateUUID } = req.body;
    if (!chapterUUID || !name) return res.status(400).json({ error: 'chapterUUID and name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [
      { table: 'planned_workouts', uuid, field: 'chapter_uuid', value: chapterUUID, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'planned_workouts', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'planned_workouts', uuid, field: 'day_index', value: dayIndex ?? 0, hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (templateUUID) changes.push({ table: 'planned_workouts', uuid, field: 'template_uuid', value: templateUUID, hlc, deviceId: CONSOLE_DEVICE_ID });
    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ uuid });
  });

  router.post('/data/schedule-rules', auth, (req, res) => {
    const { name, templateUUID, plannedWorkoutUUID, startDate, recurrence, intervalDays, weekdayMask, endDate } = req.body;
    if (!name || !startDate) return res.status(400).json({ error: 'name and startDate required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [
      { table: 'schedule_rules', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'schedule_rules', uuid, field: 'start_date', value: startDate, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'schedule_rules', uuid, field: 'recurrence', value: recurrence ?? 'once', hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (templateUUID) changes.push({ table: 'schedule_rules', uuid, field: 'template_uuid', value: templateUUID, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (plannedWorkoutUUID) changes.push({ table: 'schedule_rules', uuid, field: 'planned_workout_uuid', value: plannedWorkoutUUID, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (intervalDays !== undefined) changes.push({ table: 'schedule_rules', uuid, field: 'interval_days', value: intervalDays, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (weekdayMask !== undefined) changes.push({ table: 'schedule_rules', uuid, field: 'weekday_mask', value: weekdayMask, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (endDate) changes.push({ table: 'schedule_rules', uuid, field: 'end_date', value: endDate, hlc, deviceId: CONSOLE_DEVICE_ID });
    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ uuid });
  });

  router.post('/data/exercises', auth, (req, res) => {
    const { name, trackingType } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000); // domain values in SECONDS; HLC wall clock stays ms
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [
      { table: 'exercises', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (trackingType) changes.push({ table: 'exercises', uuid, field: 'tracking_type', value: trackingType, hlc, deviceId: CONSOLE_DEVICE_ID });
    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ uuid });
  });

  router.post('/data/templates', auth, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'workout_templates', uuid, field: 'name', value: name, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.status(201).json({ uuid });
  });

  // ── Templates + exercises (Settings tab) ──

  router.get('/data/templates', auth, (req, res) => {
    const puid = req.profileUuid;
    const templates = db.prepare(
      'SELECT * FROM workout_templates WHERE profile_uuid = ? AND deleted = 0 ORDER BY name'
    ).all(puid);
    const result = [];
    for (const t of templates) {
      const exercises = db.prepare(
        'SELECT * FROM template_exercises WHERE profile_uuid = ? AND template_uuid = ? ORDER BY position'
      ).all(puid, t.uuid);
      result.push({ ...t, exercises });
    }
    res.json({ templates: result });
  });

  router.put('/data/templates/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const t = db.prepare('SELECT uuid FROM workout_templates WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!t) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['name', 'notes', 'est_minutes']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'workout_templates', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.delete('/data/templates/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const t = db.prepare('SELECT uuid FROM workout_templates WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!t) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'workout_templates', uuid: req.params.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.json({ ok: true });
  });

  router.post('/data/template-exercises', auth, (req, res) => {
    const { templateUUID, exerciseUUID, name, position, targetSets, targetReps } = req.body;
    if (!templateUUID) return res.status(400).json({ error: 'templateUUID required' });
    if (!exerciseUUID && !name) return res.status(400).json({ error: 'exerciseUUID or name required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [
      { table: 'template_exercises', uuid, field: 'template_uuid', value: templateUUID, hlc, deviceId: CONSOLE_DEVICE_ID },
    ];
    if (exerciseUUID) changes.push({ table: 'template_exercises', uuid, field: 'exercise_uuid', value: exerciseUUID, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (name) changes.push({ table: 'template_exercises', uuid, field: 'notes', value: name, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (position !== undefined) changes.push({ table: 'template_exercises', uuid, field: 'position', value: position, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (targetSets !== undefined) changes.push({ table: 'template_exercises', uuid, field: 'target_sets', value: targetSets, hlc, deviceId: CONSOLE_DEVICE_ID });
    if (targetReps !== undefined) changes.push({ table: 'template_exercises', uuid, field: 'target_reps', value: targetReps, hlc, deviceId: CONSOLE_DEVICE_ID });
    applyConsoleChanges(db, puid, changes);
    res.status(201).json({ uuid });
  });

  router.put('/data/template-exercises/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const te = db.prepare('SELECT uuid FROM template_exercises WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!te) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['exercise_uuid', 'target_sets', 'target_reps', 'target_weight_kg', 'notes', 'position']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'template_exercises', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.delete('/data/template-exercises/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const te = db.prepare('SELECT uuid FROM template_exercises WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!te) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'template_exercises', uuid: req.params.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.json({ ok: true });
  });

  // ── Measurements (Settings tab) ──

  router.post('/data/measurements', auth, (req, res) => {
    const { kind, value, unit, timestamp } = req.body;
    if (!kind || value === undefined || !unit) return res.status(400).json({ error: 'kind, value, and unit required' });
    const puid = req.profileUuid;
    const uuid = randomUUID();
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'measurements', uuid, field: '__row__', value: { uuid, timestamp: timestamp || Math.floor(nowMs / 1000), kind, value, unit, replaces_uuid: null }, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.status(201).json({ uuid });
  });

  router.get('/data/measurements', auth, (req, res) => {
    const puid = req.profileUuid;
    const kind = req.query.kind;
    let measurements;
    if (kind) {
      measurements = db.prepare(
        'SELECT * FROM measurements WHERE profile_uuid = ? AND kind = ? ORDER BY timestamp DESC'
      ).all(puid, kind);
    } else {
      measurements = db.prepare(
        'SELECT * FROM measurements WHERE profile_uuid = ? ORDER BY timestamp DESC'
      ).all(puid);
    }
    res.json({ measurements });
  });

  // ── Exercises (for exercise picker) ──

  router.get('/data/exercises', auth, (req, res) => {
    seedExerciseLibraryIfNeeded(db, req.profileUuid);
    const puid = req.profileUuid;
    const exercises = db.prepare(
      'SELECT uuid, name, tracking_type FROM exercises WHERE profile_uuid = ? AND deleted = 0 ORDER BY name'
    ).all(puid);
    res.json({ exercises });
  });

  // ── Planned workouts + schedule rules (editing) ──

  router.put('/data/planned-workouts/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const pw = db.prepare('SELECT uuid FROM planned_workouts WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!pw) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['chapter_uuid', 'day_index', 'template_uuid', 'name', 'notes', 'position']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'planned_workouts', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.delete('/data/planned-workouts/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const pw = db.prepare('SELECT uuid FROM planned_workouts WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!pw) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'planned_workouts', uuid: req.params.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.json({ ok: true });
  });

  router.put('/data/schedule-rules/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const sr = db.prepare('SELECT uuid FROM schedule_rules WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!sr) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    const changes = [];
    for (const f of ['name', 'template_uuid', 'planned_workout_uuid', 'start_date', 'recurrence', 'interval_days', 'weekday_mask', 'end_date', 'notes']) {
      if (req.body[f] !== undefined) {
        changes.push({ table: 'schedule_rules', uuid: req.params.uuid, field: f, value: req.body[f], hlc, deviceId: CONSOLE_DEVICE_ID });
      }
    }
    if (changes.length === 0) return res.status(400).json({ error: 'no fields' });
    applyConsoleChanges(db, puid, changes);
    res.json({ ok: true });
  });

  router.delete('/data/schedule-rules/:uuid', auth, (req, res) => {
    const puid = req.profileUuid;
    const sr = db.prepare('SELECT uuid FROM schedule_rules WHERE uuid = ? AND profile_uuid = ?').get(req.params.uuid, puid);
    if (!sr) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const hlc = tickConsoleClock(db, nowMs);
    applyConsoleChanges(db, puid, [
      { table: 'schedule_rules', uuid: req.params.uuid, field: 'deleted', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
    ]);
    res.json({ ok: true });
  });

  // ── Version ──

  router.get('/data/version', (_req, res) => {
    res.json({ version: '2.66.2' });
  });

  return router;
}

// Defeat semantics must match the device (v2.29/v2.30): bonus XP once, the corpse is
// deactivated (never healed — invariant #1), and a defeated constant is replaced by a
// FRESH row at full HP.
function defeatChanges(villain, nowSec, hlc) {
  const changes = [];
  if ((villain.xp_reward ?? 0) > 0) {
    const xpUuid = randomUUID();
    changes.push({
      table: 'xp_events', uuid: xpUuid, field: '__row__',
      value: { uuid: xpUuid, timestamp: nowSec, amount: villain.xp_reward, reason: 'villain_defeated', villain_uuid: villain.uuid, session_uuid: null },
      hlc, deviceId: CONSOLE_DEVICE_ID,
    });
  }
  changes.push({ table: 'villains', uuid: villain.uuid, field: 'active', value: false, hlc, deviceId: CONSOLE_DEVICE_ID });
  const def = villain.slot === 'constant_heavy' ? combat.CONSTANT_FOES.heavy
    : villain.slot === 'constant_minion' ? combat.CONSTANT_FOES.minion : null;
  if (def) changes.push(...newConstantChanges(def, hlc));
  return changes;
}

function newConstantChanges(def, hlc) {
  const uuid = randomUUID();
  const fields = {
    name: def.name, max_hp: def.maxHP, hp: def.maxHP, active: true,
    tier: def.tier, xp_reward: def.defeatXP, slot: def.slot,
  };
  return Object.entries(fields).map(([field, value]) =>
    ({ table: 'villains', uuid, field, value, hlc, deviceId: CONSOLE_DEVICE_ID }));
}

// Web-only profiles have no device to provision The Rust / The Drought (v2.30) — the
// console does it on demand, same one-live-row rule as iOS ensureConstants.
function ensureConstants(db, puid) {
  const changes = [];
  for (const def of [combat.CONSTANT_FOES.heavy, combat.CONSTANT_FOES.minion]) {
    const live = db.prepare(
      'SELECT uuid FROM villains WHERE profile_uuid = ? AND slot = ? AND active = 1 AND deleted = 0 AND hp > 0'
    ).get(puid, def.slot);
    if (!live) changes.push(...newConstantChanges(def, tickConsoleClock(db, Date.now())));
  }
  if (changes.length > 0) applyConsoleChanges(db, puid, changes);
}

// Calendar-day gap (matches iOS CombatService.sessionGapDays): session dates are SECONDS.
// Uses the server's local calendar — same semantics as the device using its own.
function sessionGapDays(db, profileUuid) {
  const last = db.prepare(
    'SELECT date FROM sessions WHERE profile_uuid = ? ORDER BY date DESC LIMIT 1'
  ).get(profileUuid);
  if (!last) return null;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const lastDay = startOfDay(new Date(last.date * 1000));
  const today = startOfDay(new Date());
  return Math.round((today - lastDay) / 86_400_000);
}
