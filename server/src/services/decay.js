import { randomUUID } from 'node:crypto';
import { applyBatch } from '../../../questlog-critical/hlc-merge/merge.js';
import { SqliteStorageAdapter } from '../sync/adapter.js';
import { applyDecay } from './combat.js';
import { compactChangeLog } from './compaction.js';

// Domain timestamps (last_session_at, villain_events.timestamp) are SECONDS — the device
// convention. Only the HLC wall clock and change_log.created_at stay in milliseconds.
const DECAY_THRESHOLD_SEC = 14 * 24 * 60 * 60;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SERVER_DEVICE_ID = 'server-decay';

// Decay is the ONLY server-originated HP gain (spec §E / invariant A7). It is applied THROUGH the
// merge engine (not a raw UPDATE) so it participates in per-field LWW: it advances field_meta with a
// dedicated server-decay identity + persisted HLC, and it loses to any newer device write rather
// than silently clobbering it. Accepted changes are appended to change_log so devices observe them.
export function runDecaySweep(db) {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const cutoff = now - DECAY_THRESHOLD_SEC;

  const villains = db.prepare(
    `SELECT uuid, hp, max_hp, last_session_at, active, deleted, profile_uuid FROM villains
     WHERE active = 1 AND deleted = 0 AND hp > 0 AND last_session_at IS NOT NULL AND last_session_at <= ?`
  ).all(cutoff);

  const insertLog = db.prepare(
    `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let count = 0;
  for (const villain of villains) {
    const result = applyDecay(villain, villain.last_session_at); // mutates villain.hp (reads max_hp)
    if (!result) continue;

    const hlc = tickServerClock(db, nowMs);
    const eventUuid = randomUUID();
    const changes = [
      { table: 'villains', uuid: villain.uuid, field: 'hp', value: villain.hp, hlc, deviceId: SERVER_DEVICE_ID },
      {
        table: 'villain_events', uuid: eventUuid, field: '__row__', hlc, deviceId: SERVER_DEVICE_ID,
        value: {
          uuid: eventUuid, villain_uuid: villain.uuid, timestamp: now, reason: 'decay',
          damage: 0, xp: 0, damage_roll: null, result_stamp: null, buff_stamp: null,
        },
      },
    ];

    const store = new SqliteStorageAdapter(db, villain.profile_uuid);
    const apply = db.transaction(() => {
      const results = applyBatch(store, changes);
      for (const { change, decision } of results) {
        if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
          insertLog.run(
            villain.profile_uuid, change.table, change.uuid, change.field,
            JSON.stringify(change.value), change.hlc, change.deviceId, null, nowMs
          );
        }
      }
    });
    apply();
    count++;
  }

  return count;
}

// Minimal HLC generator for the internal server-decay writer. Persisted so the server clock is
// monotonic across restarts; mirrors the pack/unpack layout of questlog-critical/hlc-merge/hlc.js.
function tickServerClock(db, now) {
  const row = db.prepare("SELECT value FROM server_clock WHERE key = 'decay_hlc'").get();
  const base = row ? row.value : (now.toString(16).padStart(12, '0') + '0000');
  let ms = parseInt(base.slice(0, 12), 16);
  let counter = parseInt(base.slice(12), 16);
  if (now > ms) { ms = now; counter = 0; } else { counter += 1; }
  if (counter > 0xffff) { ms += 1; counter = 0; }
  const hlc = ms.toString(16).padStart(12, '0') + counter.toString(16).padStart(4, '0');
  if (row) db.prepare("UPDATE server_clock SET value = ? WHERE key = 'decay_hlc'").run(hlc);
  else db.prepare("INSERT INTO server_clock (key, value) VALUES ('decay_hlc', ?)").run(hlc);
  return hlc;
}

export function startDecayScheduler(db) {
  runDecaySweep(db);
  compactChangeLog(db);
  const timer = setInterval(() => {
    runDecaySweep(db);
    compactChangeLog(db);
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
