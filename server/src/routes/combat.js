import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import * as combat from '../services/combat.js';
import * as glancingBlow from '../services/glancingBlow.js';
import { authenticateDevice } from '../../../questlog-critical/sync-auth/pairing.js';

export default function combatRoutes(db) {
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

  router.post('/combat/session', auth, (req, res) => {
    const { villainUUID, durationMinutes, sessionType } = req.body;

    if (!villainUUID || typeof durationMinutes !== 'number') {
      return res.status(400).json({ error: 'invalid request' });
    }

    const type = sessionType || 'fullScheduled';
    // Validate against the known set rather than silently coercing an unknown type to Chipped Damage.
    if (!['fullScheduled', 'shortSession', 'mobilityRecovery'].includes(type)) {
      return res.status(400).json({ error: 'invalid sessionType' });
    }

    const villain = db.prepare('SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?').get(villainUUID, req.profileUuid);
    if (!villain) {
      return res.status(404).json({ error: 'villain not found' });
    }
    // The Drought (constant_minion) is weakened only by hydration — a training session must never
    // damage it (same invariant enforced on POST /data/sessions and in the iOS strike target).
    if (villain.slot === 'constant_minion') {
      return res.status(400).json({ error: 'This foe is weakened only by water.' });
    }

    const result = combat.executeSession(villain, type);

    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS (device convention)
    db.prepare('UPDATE villains SET hp = ?, updated_at = ?, last_session_at = ? WHERE uuid = ? AND profile_uuid = ?')
      .run(villain.hp, now, now, villainUUID, req.profileUuid);

    const eventUuid = randomUUID();
    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp, buff_stamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventUuid, req.profileUuid, villainUUID, now, result.reason, result.damageDealt, result.xpEarned, result.buffStamp);

    const xpUuid = randomUUID();
    db.prepare(`INSERT INTO xp_events (uuid, profile_uuid, timestamp, amount, reason, villain_uuid)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(xpUuid, req.profileUuid, now, result.xpEarned, result.reason, villainUUID);

    res.json({ result, villain });
  });

  router.post('/combat/glancing-blow', auth, (req, res) => {
    const { villainUUID } = req.body;

    if (!villainUUID) {
      return res.status(400).json({ error: 'villainUUID required' });
    }

    const villain = db.prepare('SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?').get(villainUUID, req.profileUuid);
    if (!villain) {
      return res.status(404).json({ error: 'villain not found' });
    }
    // A Glancing Blow is a training strike — never allowed against the water-only minion.
    if (villain.slot === 'constant_minion') {
      return res.status(400).json({ error: 'This foe is weakened only by water.' });
    }

    const roll = glancingBlow.execute(villainUUID);
    const event = glancingBlow.buildEvent(villainUUID, roll);

    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS (device convention)
    db.prepare('UPDATE villains SET hp = MAX(0, hp - ?), updated_at = ? WHERE uuid = ? AND profile_uuid = ?')
      .run(roll.damage, now, villainUUID, req.profileUuid);

    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp, damage_roll, result_stamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.uuid, req.profileUuid, villainUUID, now, 'glancing_blow', roll.damage, roll.xp, roll.roll, roll.stamp);

    const xpUuid = randomUUID();
    db.prepare(`INSERT INTO xp_events (uuid, profile_uuid, timestamp, amount, reason, villain_uuid)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(xpUuid, req.profileUuid, now, roll.xp, 'glancing_blow', villainUUID);

    res.json({ roll, event });
  });

  router.post('/combat/confession', auth, (req, res) => {
    const { villainUUID } = req.body;

    if (!villainUUID) {
      return res.status(400).json({ error: 'villainUUID required' });
    }

    const villain = db.prepare('SELECT * FROM villains WHERE uuid = ? AND profile_uuid = ?').get(villainUUID, req.profileUuid);
    if (!villain) {
      return res.status(404).json({ error: 'villain not found' });
    }

    const result = combat.confession(villain);

    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS (device convention)
    db.prepare('UPDATE villains SET hp = ?, updated_at = ? WHERE uuid = ? AND profile_uuid = ?')
      .run(villain.hp, now, villainUUID, req.profileUuid);

    const eventUuid = randomUUID();
    db.prepare(`INSERT INTO villain_events (uuid, profile_uuid, villain_uuid, timestamp, reason, damage, xp, buff_stamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventUuid, req.profileUuid, villainUUID, now, result.reason, 0, result.xpEarned, result.buffStamp);

    const xpUuid = randomUUID();
    db.prepare(`INSERT INTO xp_events (uuid, profile_uuid, timestamp, amount, reason, villain_uuid)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(xpUuid, req.profileUuid, now, result.xpEarned, 'confession', villainUUID);

    res.json({ result, villain });
  });

  return router;
}
