import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { applyBatch } from '../../../questlog-critical/hlc-merge/merge.js';
import { SqliteStorageAdapter } from '../sync/adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONSOLE_DEVICE_ID = 'server-console';

export function deterministicUUID(namespace, name) {
  const hash = createHash('sha256').update(`${namespace}:${name}`).digest();
  const bytes = Array.from(hash.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0F) | 0x50;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function tickConsoleClock(db, now) {
  const row = db.prepare("SELECT value FROM server_clock WHERE key = 'console_hlc'").get();
  const base = row ? row.value : (now.toString(16).padStart(12, '0') + '0000');
  let ms = parseInt(base.slice(0, 12), 16);
  let counter = parseInt(base.slice(12), 16);
  if (now > ms) { ms = now; counter = 0; } else { counter += 1; }
  if (counter > 0xffff) { ms += 1; counter = 0; }
  const hlc = ms.toString(16).padStart(12, '0') + counter.toString(16).padStart(4, '0');
  if (row) db.prepare("UPDATE server_clock SET value = ? WHERE key = 'console_hlc'").run(hlc);
  else db.prepare("INSERT INTO server_clock (key, value) VALUES ('console_hlc', ?)").run(hlc);
  return hlc;
}

export function applyConsoleChanges(db, profileUuid, changes) {
  const now = Date.now();
  const store = new SqliteStorageAdapter(db, profileUuid);
  const insertLog = db.prepare(
    `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const apply = db.transaction(() => {
    const results = applyBatch(store, changes);
    for (const { change, decision } of results) {
      if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
        insertLog.run(
          profileUuid, change.table, change.uuid, change.field,
          JSON.stringify(change.value), change.hlc, change.deviceId, null, now
        );
      }
    }
    return results;
  });
  return apply();
}

export function seedFoeCatalogIfNeeded(db, profileUuid) {
  const catalogPath = path.join(__dirname, '..', 'data', 'foe-catalog.json');
  const data = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) return { seeded: 0, refreshed: 0 };

  const namespace = profileUuid;
  const seenBuiltinIDs = new Set(
    db.prepare(
      'SELECT builtin_id FROM foe_catalog WHERE profile_uuid = ? AND builtin_id IS NOT NULL'
    ).all(profileUuid).map(r => r.builtin_id)
  );

  const now = Date.now();
  const changes = [];
  let newEntryCount = 0;

  for (const entry of data) {
    if (seenBuiltinIDs.has(entry.builtin_id)) continue;
    const uuid = deterministicUUID(namespace, entry.builtin_id);
    const existingRow = db.prepare(
      'SELECT uuid FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?'
    ).get(uuid, profileUuid);
    if (existingRow) continue;

    const hlc = tickConsoleClock(db, now);

    changes.push(
      { table: 'foe_catalog', uuid, field: 'name', value: entry.name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'tier', value: entry.tier, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'max_hp', value: entry.max_hp, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'xp_reward', value: entry.xp_reward, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'encounter_weight', value: entry.encounter_weight, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'enabled', value: true, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'builtin_id', value: entry.builtin_id, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'foe_catalog', uuid, field: 'description', value: entry.description ?? null, hlc, deviceId: CONSOLE_DEVICE_ID },
    );
    newEntryCount++;
  }

  // Phase 2: description refresh for existing builtins whose descriptions differ from catalog
  const catalogByBuiltin = {};
  for (const entry of data) {
    catalogByBuiltin[entry.builtin_id] = entry.description ?? null;
  }

  let descRefreshed = 0;
  if (seenBuiltinIDs.size > 0) {
    const existingRows = db.prepare(
      'SELECT uuid, builtin_id, description FROM foe_catalog WHERE profile_uuid = ? AND builtin_id IS NOT NULL AND deleted = 0'
    ).all(profileUuid);
    for (const row of existingRows) {
      const catDesc = catalogByBuiltin[row.builtin_id];
      if (catDesc === undefined || catDesc === null) continue;
      if (row.description === catDesc) continue;
      const hlc = tickConsoleClock(db, now);
      changes.push(
        { table: 'foe_catalog', uuid: row.uuid, field: 'description', value: catDesc, hlc, deviceId: CONSOLE_DEVICE_ID },
      );
      descRefreshed++;
    }
  }

  if (changes.length === 0) return { seeded: 0, refreshed: 0 };

  const store = new SqliteStorageAdapter(db, profileUuid);
  const insertLog = db.prepare(
    `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const apply = db.transaction(() => {
    const results = applyBatch(store, changes);
    for (const { change, decision } of results) {
      if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
        insertLog.run(
          profileUuid, change.table, change.uuid, change.field,
          JSON.stringify(change.value), change.hlc, change.deviceId, null, now
        );
      }
    }

    const live = db.prepare(
      'SELECT uuid, builtin_id FROM foe_catalog WHERE profile_uuid = ? AND deleted = 0 AND builtin_id IS NOT NULL'
    ).all(profileUuid);
    const groups = {};
    for (const row of live) {
      (groups[row.builtin_id] ??= []).push(row);
    }
    for (const [builtinId, rows] of Object.entries(groups)) {
      if (rows.length <= 1) continue;
      const sorted = rows.sort((a, b) => a.uuid.localeCompare(b.uuid));
      for (const dup of sorted.slice(1)) {
        const dedupHlc = tickConsoleClock(db, now);
        const dedupChanges = [
          { table: 'foe_catalog', uuid: dup.uuid, field: 'deleted', value: true, hlc: dedupHlc, deviceId: CONSOLE_DEVICE_ID },
        ];
        const dd = applyBatch(store, dedupChanges);
        for (const { change, decision } of dd) {
          if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
            insertLog.run(
              profileUuid, change.table, change.uuid, change.field,
              JSON.stringify(change.value), change.hlc, change.deviceId, null, now
            );
          }
        }
      }
    }
  });

  apply();
  return { seeded: newEntryCount, refreshed: descRefreshed };
}

export function seedExerciseLibraryIfNeeded(db, profileUuid) {
  const existing = db.prepare(
    "SELECT COUNT(*) as cnt FROM exercises WHERE profile_uuid = ? AND builtin_id IS NOT NULL"
  ).get(profileUuid);
  if (existing.cnt > 0) return { seeded: 0 };

  const libPath = path.join(__dirname, '..', 'data', 'exercise-library.json');
  const data = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) return { seeded: 0 };

  const namespace = profileUuid;
  const seenBuiltinIDs = new Set(
    db.prepare(
      "SELECT builtin_id FROM exercises WHERE profile_uuid = ? AND builtin_id IS NOT NULL"
    ).all(profileUuid).map(r => r.builtin_id)
  );

  const now = Date.now();
  const changes = [];

  for (const entry of data) {
    if (seenBuiltinIDs.has(entry.builtin_id)) continue;
    const uuid = deterministicUUID(namespace, 'ex:' + entry.builtin_id);
    const existingRow = db.prepare(
      'SELECT uuid FROM exercises WHERE uuid = ? AND profile_uuid = ?'
    ).get(uuid, profileUuid);
    if (existingRow) continue;

    const hlc = tickConsoleClock(db, now);
    changes.push(
      { table: 'exercises', uuid, field: 'name', value: entry.name, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'exercises', uuid, field: 'tracking_type', value: entry.tracking_type, hlc, deviceId: CONSOLE_DEVICE_ID },
      { table: 'exercises', uuid, field: 'builtin_id', value: entry.builtin_id, hlc, deviceId: CONSOLE_DEVICE_ID },
    );
  }

  if (changes.length === 0) return { seeded: 0 };

  const store = new SqliteStorageAdapter(db, profileUuid);
  const insertLog = db.prepare(
    `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const apply = db.transaction(() => {
    const results = applyBatch(store, changes);
    let applied = 0;
    for (const { change, decision } of results) {
      if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
        insertLog.run(
          profileUuid, change.table, change.uuid, change.field,
          JSON.stringify(change.value), change.hlc, change.deviceId, null, now
        );
        applied++;
      }
    }

    // Dedupe: keep lowest-uuid builtin, tombstone duplicates
    const live = db.prepare(
      "SELECT uuid, builtin_id FROM exercises WHERE profile_uuid = ? AND deleted = 0 AND builtin_id IS NOT NULL"
    ).all(profileUuid);
    const groups = {};
    for (const row of live) {
      (groups[row.builtin_id] ??= []).push(row);
    }
    for (const [builtinId, rows] of Object.entries(groups)) {
      if (rows.length <= 1) continue;
      const sorted = rows.sort((a, b) => a.uuid.localeCompare(b.uuid));
      for (const dup of sorted.slice(1)) {
        const dedupHlc = tickConsoleClock(db, now);
        const dedupChanges = [
          { table: 'exercises', uuid: dup.uuid, field: 'deleted', value: true, hlc: dedupHlc, deviceId: CONSOLE_DEVICE_ID },
        ];
        const dd = applyBatch(store, dedupChanges);
        for (const { change, decision } of dd) {
          if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
            insertLog.run(
              profileUuid, change.table, change.uuid, change.field,
              JSON.stringify(change.value), change.hlc, change.deviceId, null, now
            );
          }
        }
      }
    }

    return applied / 3;
  });

  const count = apply();
  return { seeded: count };
}
