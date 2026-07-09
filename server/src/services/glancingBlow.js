import { randomInt, randomUUID } from 'node:crypto';

export const ROLL_TABLE = [
  { threshold: 60, damage: 1, xp: 1, stamp: 'small_tick' },
  { threshold: 85, damage: 2, xp: 2, stamp: 'small_tick' },
  { threshold: 95, damage: 3, xp: 3, stamp: 'double_tick' },
  { threshold: 99, damage: 4, xp: 4, stamp: 'solid_hit' },
  { threshold: 100, damage: 6, xp: 6, stamp: 'clean_hit' },
];

export function execute(villainUUID) {
  const roll = randomInt(1, 101);

  const result = ROLL_TABLE.find((r) => roll <= r.threshold);

  return {
    roll,
    damage: result.damage,
    xp: result.xp,
    stamp: result.stamp,
  };
}

export function buildEvent(villainUUID, roll) {
  const uuid = randomUUID();
  const now = Date.now();

  return {
    uuid,
    villain_uuid: villainUUID,
    timestamp: now,
    reason: 'glancing_blow',
    damage: roll.damage,
    xp: roll.xp,
    damage_roll: roll.roll,
    result_stamp: roll.stamp,
    buff_stamp: null,
  };
}
