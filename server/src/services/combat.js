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
  HYDRATION_DAMAGE: 2,
  HYDRATION_XP: 2,
  HYDRATION_MIN_OZ: 8,
};

export const CONSTANT_FOES = {
  heavy: { slot: 'constant_heavy', name: 'The Rust', tier: 'heavy', maxHP: 100, defeatXP: 30, description: 'Iron left out in the rain doesn\u2019t rust overnight\u2014it fades one thin layer at a time. Three days off is all it takes for the joints to stiffen. Get back under the bar before the surface hardens.' },
  minion: { slot: 'constant_minion', name: 'The Drought', tier: 'minion', maxHP: 16, defeatXP: 5, description: 'Your body runs on water the way an engine runs on oil. When the tank runs low, everything grinds a little harder. Fill up before you start the engine.' },
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
  // Domain timestamps are SECONDS (device convention: timeIntervalSince1970). The old ms
  // math meant every device-synced last_session_at (~1.7e9) sat below an ms cutoff
  // (~1.7e12), so decay fired on villains that were active yesterday.
  const now = Math.floor(Date.now() / 1000);
  const fourteenDays = 14 * 24 * 60 * 60;

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
