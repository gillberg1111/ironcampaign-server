// questlog — Merge Engine
// Spec §5.3. MUST behave identically to Merge.swift. Verified by test-vectors.json.
// Pure logic: storage is injected via an adapter so device (GRDB) and node (better-sqlite3)
// share this exact decision procedure.
//
// A change:  { table, uuid, field, value, hlc, deviceId, changeId? }
//   - field 'deleted' with value=truthy is the tombstone write (deleted_hlc semantics).
// Field metadata: per (table, uuid, field) we store the winning {hlc, deviceId}.
//
// Rules, in order:
//   R1 different fields of same record: both apply (handled naturally — decisions are per-field)
//   R2 same field: higher (hlc, deviceId) wins
//   R3 append-only tables: union by uuid, never overwrite
//   R4 tombstone beats field edits: once deleted at HLC D, any field edit with hlc <= D is suppressed;
//      field edits with hlc > D are ALSO suppressed unless the edit IS an explicit un-delete
//      (deleted=false with higher hlc), which must arrive first.

import { compare } from './hlc.js';

export const APPEND_ONLY_TABLES = new Set(['set_logs', 'xp_events', 'villain_events', 'narrations', 'measurements']);
export const TOMBSTONE_FIELD = 'deleted';

/**
 * StorageAdapter interface (implement per platform):
 *   getFieldMeta(table, uuid, field) -> {hlc, deviceId} | null
 *   setFieldMeta(table, uuid, field, hlc, deviceId) -> void
 *   applyField(table, uuid, field, value) -> void          // upsert the materialized row's column
 *   rowExists(table, uuid) -> boolean                       // for append-only union
 *   insertRow(table, uuid, value) -> void                   // append-only insert (value = full row object)
 *   isDeleted(table, uuid) -> {hlc, deviceId} | null        // current tombstone meta, if any
 */

/**
 * Decide and apply one incoming change. Returns a decision string (also used by test vectors):
 *   'applied' | 'ignored-older' | 'ignored-tombstoned' | 'appended' | 'append-duplicate' | 'undeleted'
 * All writes MUST happen inside a single transaction owned by the caller (one txn per sync batch).
 */
export function applyChange(store, change) {
  const { table, uuid, field, value, hlc, deviceId } = change;
  validate(change);

  // R3 — append-only tables: union semantics, field is ignored (value = whole row)
  if (APPEND_ONLY_TABLES.has(table)) {
    if (store.rowExists(table, uuid)) return 'append-duplicate';
    store.insertRow(table, uuid, value);
    store.setFieldMeta(table, uuid, '__row__', hlc, deviceId);
    return 'appended';
  }

  const tomb = store.isDeleted(table, uuid);

  // Tombstone writes (deleted=true / deleted=false)
  if (field === TOMBSTONE_FIELD) {
    const existing = store.getFieldMeta(table, uuid, TOMBSTONE_FIELD);
    if (existing && compare(hlc, existing.hlc, deviceId, existing.deviceId) <= 0) return 'ignored-older';
    store.applyField(table, uuid, TOMBSTONE_FIELD, !!value);
    store.setFieldMeta(table, uuid, TOMBSTONE_FIELD, hlc, deviceId);
    return value ? 'applied' : 'undeleted';
  }

  // R4 — record currently tombstoned: suppress field edits regardless of their hlc.
  // (An un-delete with higher hlc must be applied first; ordering within a batch is by hlc,
  //  so a legitimate un-delete+edit pair replays correctly.)
  if (tomb) return 'ignored-tombstoned';

  // R2 — per-field last-write-wins with deterministic tie-break
  const existing = store.getFieldMeta(table, uuid, field);
  if (existing && compare(hlc, existing.hlc, deviceId, existing.deviceId) <= 0) return 'ignored-older';

  store.applyField(table, uuid, field, value);
  store.setFieldMeta(table, uuid, field, hlc, deviceId);
  return 'applied';
}

/**
 * Apply a batch: sort by (hlc, deviceId, changeId) FIRST — this ordering is load-bearing
 * (guarantees un-delete-then-edit pairs and multi-field edits replay deterministically),
 * then apply each. Caller wraps in one transaction and, on success, advances its cursor
 * and calls hlc.receive() with the max hlc seen.
 */
export function applyBatch(store, changes) {
  const sorted = [...changes].sort((a, b) =>
    compare(a.hlc, b.hlc, a.deviceId, b.deviceId) || ((a.changeId ?? 0) - (b.changeId ?? 0)));
  return sorted.map((c) => ({ change: c, decision: applyChange(store, c) }));
}

function validate(c) {
  for (const k of ['table', 'uuid', 'field', 'hlc', 'deviceId']) {
    if (typeof c[k] !== 'string' || c[k].length === 0) throw new Error(`merge: missing/invalid ${k}`);
  }
  if (!/^[0-9a-f]{16}$/.test(c.hlc)) throw new Error('merge: malformed hlc');
  if (c.table.length > 64 || c.field.length > 64 || c.uuid.length > 64) throw new Error('merge: identifier too long');
  // Table/field allowlisting against the schema happens one layer up (server §8.B / app A1);
  // this module assumes identifiers were already allowlisted but still bounds them defensively.
}
