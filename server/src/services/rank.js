const RANKS = [
  { name: 'Recruit', threshold: 0 },
  { name: 'Regular', threshold: 250 },
  { name: 'Seasoned', threshold: 750 },
  { name: 'Veteran', threshold: 1500 },
  { name: 'Campaigner', threshold: 3000 },
  { name: 'Field Officer', threshold: 6000 },
  { name: 'Commander', threshold: 12000 },
  { name: 'Field Marshal', threshold: 25000 },
];

export function rankFor(totalXP) {
  let current = RANKS[0];
  for (const r of RANKS) {
    if (totalXP >= r.threshold) current = r;
  }
  return current;
}

export function progressFraction(totalXP, currentRank) {
  const idx = RANKS.indexOf(currentRank);
  if (idx < 0 || idx >= RANKS.length - 1) return 1;
  const next = RANKS[idx + 1];
  const range = next.threshold - currentRank.threshold;
  const progress = totalXP - currentRank.threshold;
  return Math.min(Math.max(progress / range, 0), 1);
}
