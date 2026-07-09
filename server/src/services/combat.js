export const COMBAT = {
  HEAVY_STRIKE_DAMAGE: 20,
  HEAVY_STRIKE_XP: 30,
  CHIPPED_DAMAGE_AMOUNT: 8,
  CHIPPED_DAMAGE_XP: 10,
  FORTIFY_DAMAGE: 3,
  FORTIFY_XP: 5,
  CONFESSION_HEAL: 15,
  CONFESSION_XP: 5,
  DECAY_THRESHOLD_DAYS: 14,
  DECAY_HP_PER_INTERVAL: 5,
};

export function heavyStrike(villain) {
  const damage = COMBAT.HEAVY_STRIKE_DAMAGE;
  villain.hp = Math.max(0, villain.hp - damage);
  return {
    reason: 'heavy_strike',
    damageDealt: damage,
    xpEarned: COMBAT.HEAVY_STRIKE_XP,
    stamp: null,
    buffStamp: null,
  };
}

export function chippedDamage(villain) {
  const damage = COMBAT.CHIPPED_DAMAGE_AMOUNT;
  villain.hp = Math.max(0, villain.hp - damage);
  return {
    reason: 'chipped_damage',
    damageDealt: damage,
    xpEarned: COMBAT.CHIPPED_DAMAGE_XP,
    stamp: null,
    buffStamp: null,
  };
}

export function fortify(villain) {
  const damage = COMBAT.FORTIFY_DAMAGE;
  villain.hp = Math.max(0, villain.hp - damage);
  return {
    reason: 'fortify',
    damageDealt: damage,
    xpEarned: COMBAT.FORTIFY_XP,
    stamp: null,
    buffStamp: 'FORTIFIED',
  };
}

export function confession(villain) {
  villain.hp = Math.min(villain.max_hp, villain.hp + COMBAT.CONFESSION_HEAL);
  return {
    reason: 'confession',
    damageDealt: 0,
    xpEarned: COMBAT.CONFESSION_XP,
    stamp: null,
    buffStamp: 'HONESTY LOGGED',
  };
}

export function applyDecay(villain, lastSessionAt) {
  const now = Date.now();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;

  if (now - lastSessionAt < fourteenDays) return null;

  villain.hp = Math.min(villain.max_hp, villain.hp + COMBAT.DECAY_HP_PER_INTERVAL);

  return {
    reason: 'decay',
    damageDealt: 0,
    xpEarned: 0,
    stamp: null,
    buffStamp: null,
  };
}

export function classification(durationMinutes) {
  return durationMinutes >= 30 ? 'fullScheduled' : 'shortSession';
}

export function executeSession(villain, sessionType) {
  switch (sessionType) {
    case 'fullScheduled':
      return heavyStrike(villain);
    case 'shortSession':
      return chippedDamage(villain);
    case 'mobilityRecovery':
      return fortify(villain);
    default:
      return chippedDamage(villain);
  }
}
