import { randomInt } from 'node:crypto';

export function weightedPick(catalog, bossGatedIn) {
  const eligible = catalog.filter(entry => {
    if (!entry.enabled || entry.deleted) return false;
    if (entry.tier === 'boss' && !bossGatedIn) return false;
    return entry.encounter_weight > 0;
  });
  if (eligible.length === 0) return null;

  const totalWeight = eligible.reduce((sum, e) => sum + e.encounter_weight, 0);
  if (totalWeight <= 0) {
    return eligible[randomInt(0, eligible.length)];
  }

  const roll = randomInt(0, totalWeight);
  let cumulative = 0;
  for (const entry of eligible) {
    cumulative += entry.encounter_weight;
    if (roll < cumulative) return entry;
  }
  return eligible[eligible.length - 1];
}

export function bossGatedIn(db, profileUuid) {
  const events = db.prepare(
    `SELECT ve.villain_uuid, ve.timestamp, v.tier, v.hp, v.deleted
     FROM villain_events ve
     JOIN villains v ON v.profile_uuid = ? AND v.uuid = ve.villain_uuid
     WHERE ve.profile_uuid = ?
     ORDER BY ve.timestamp ASC`
  ).all(profileUuid, profileUuid);

  const lastEventTime = {};
  for (const e of events) {
    lastEventTime[e.villain_uuid] = Math.max(lastEventTime[e.villain_uuid] ?? 0, e.timestamp);
  }

  const miniBossDefeatTimes = [];
  let lastBossDefeat = -1;

  for (const [uuid, time] of Object.entries(lastEventTime)) {
    const v = db.prepare(
      'SELECT hp, deleted, tier FROM villains WHERE uuid = ? AND profile_uuid = ?'
    ).get(uuid, profileUuid);
    if (!v || v.hp > 0 || v.deleted) continue;

    if (v.tier === 'miniboss') {
      miniBossDefeatTimes.push(time);
    } else if (v.tier === 'boss') {
      lastBossDefeat = Math.max(lastBossDefeat, time);
    }
  }

  return miniBossDefeatTimes.filter(t => t > lastBossDefeat).length >= 2;
}
