import { randomUUID } from 'node:crypto';
import { REGISTRY } from '../sync/registry.js';

const SERVER_DEVICE_ID = 'server-compact';
const STALE_DAYS = 90;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

export function compactChangeLog(db) {
  if (process.env.COMPACTION_DISABLED === '1') return 0;
  const cutoff = Date.now() - STALE_MS;

  const profiles = db.prepare(
    `SELECT DISTINCT dc.profile_uuid FROM device_cursors dc
     JOIN device_tokens dt ON dt.id = dc.device_token_id
     WHERE dt.revoked_at IS NULL AND dc.last_seen_at > ?`
  ).all(cutoff);

  let deletedTotal = 0;
  for (const { profile_uuid } of profiles) {
    const safeSeq = db.prepare(
      `SELECT MIN(dc.cursor_seq) as min_seq FROM device_cursors dc
       JOIN device_tokens dt ON dt.id = dc.device_token_id
       WHERE dc.profile_uuid = ? AND dt.revoked_at IS NULL AND dc.last_seen_at > ?`
    ).get(profile_uuid, cutoff);

    if (!safeSeq || safeSeq.min_seq === null || safeSeq.min_seq <= 0) continue;

    const tx = db.transaction(() => {
      const result = db.prepare(
        'DELETE FROM change_log WHERE profile_uuid = ? AND seq <= ?'
      ).run(profile_uuid, safeSeq.min_seq);
      return result.changes;
    });

    deletedTotal += tx();
  }
  return deletedTotal;
}

export function bootstrapSnapshot(db, profileUuid) {
  if (process.env.COMPACTION_DISABLED === '1') return 0;

  const now = Date.now();
  const domainTables = Object.keys(REGISTRY).filter(t => {
    const entry = REGISTRY[t];
    return entry.columns.includes('profile_uuid') && entry.columns.includes('uuid');
  });

  // A MINIMAL HLC (below any real device write). The bootstrap only fills in state a device is
  // missing; any real write — the device's own unsynced edits, or a real tombstone still in the
  // feed — carries a realistic (far higher) HLC and wins LWW over the bootstrap. (The delivery used
  // Date.now() here, which is a *current* HLC and would clobber earlier real writes.)
  const bootstrapHlc = '0000000000000000';

  const insertLog = db.prepare(
    `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let inserted = 0;
  for (const table of domainTables) {
    const entry = REGISTRY[table];
    if (!entry) continue;

    // Bootstrap only LIVE rows. A deleted row is ABSENT state, not something to re-seed — emitting
    // it (and the delivery hardcoded deleted='false') resurrects the tombstone on the new device.
    const hasDeleted = entry.columns.includes('deleted');
    const where = hasDeleted ? 'WHERE profile_uuid = ? AND (deleted = 0 OR deleted IS NULL)' : 'WHERE profile_uuid = ?';
    const rows = db.prepare(`SELECT * FROM ${table} ${where}`).all(profileUuid);

    for (const row of rows) {
      if (entry.appendOnly) {
        // Append-only tables emit the full row as __row__
        const rowValue = {};
        for (const col of entry.columns) {
          if (col === 'profile_uuid') continue;
          rowValue[col] = row[col];
        }
        insertLog.run(
          profileUuid, table, row.uuid, '__row__',
          JSON.stringify(rowValue), bootstrapHlc, SERVER_DEVICE_ID, null, now
        );
        inserted++;
      } else {
        // LWW tables emit one change per mutable field. `deleted` is intentionally NOT emitted —
        // only live rows are bootstrapped, so the device's default (not-deleted) is already right.
        for (const field of (entry.mutableFields || [])) {
          if (row[field] === undefined || row[field] === null) continue;
          insertLog.run(
            profileUuid, table, row.uuid, field,
            JSON.stringify(row[field]), bootstrapHlc, SERVER_DEVICE_ID, null, now
          );
          inserted++;
        }
      }
    }
  }
  return inserted;
}
