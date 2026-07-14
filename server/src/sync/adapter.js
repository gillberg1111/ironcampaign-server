import { REGISTRY } from './registry.js';

const INSERT_DEFAULTS = {
  villains:      { name: '', hp: 100, max_hp: 100, active: 1, deleted: 0 },
  sagas:         { name: '', active: 1, deleted: 0 },
  chapters:      { saga_uuid: '', name: '', week_index: 0, deleted: 0 },
  sessions:      { date: 0, duration_minutes: 0, status: 'completed', session_type: 'strength', xp_earned: 0 },
  exercises:     { name: '', deleted: 0 },
  workout_templates: { name: '', est_minutes: 0, deleted: 0 },
  template_exercises: { template_uuid: '', exercise_uuid: '', position: 0, deleted: 0 },
  foe_catalog: { name: '', tier: 'minion', max_hp: 100, xp_reward: 50, encounter_weight: 30, enabled: 1, deleted: 0 },
  planned_workouts: { chapter_uuid: '', day_index: 0, name: '', position: 0, deleted: 0 },
  schedule_rules: { name: '', start_date: (new Date()).toISOString().slice(0,10), recurrence: 'once', deleted: 0 },
};

export class SqliteStorageAdapter {
  constructor(db, profileUuid) {
    this._db = db;
    this._profile = profileUuid;
    this._stmts = {};
  }

  _prepare(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this._db.prepare(sql);
    return this._stmts[sql];
  }

  getFieldMeta(table, uuid, field) {
    const row = this._prepare(
      'SELECT hlc, device_id FROM field_meta WHERE profile_uuid = ? AND table_name = ? AND row_uuid = ? AND field_name = ?'
    ).get(this._profile, table, uuid, field);
    return row ? { hlc: row.hlc, deviceId: row.device_id } : null;
  }

  setFieldMeta(table, uuid, field, hlc, deviceId) {
    this._prepare(
      'INSERT OR REPLACE INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(this._profile, table, uuid, field, hlc, deviceId);
  }

  applyField(table, uuid, field, value) {
    safeIdent(table);
    safeIdent(field);
    const entry = REGISTRY[table];
    // Only tables that actually have an updated_at column get it touched (sessions/append-only don't).
    const hasUpdatedAt = !!entry && entry.columns.includes('updated_at');
    const now = Date.now();
    const dbValue = field === 'deleted' ? (value ? 1 : 0) : sqliteValue(value);

    const exists = !!this._prepare(
      `SELECT 1 FROM ${table} WHERE profile_uuid = ? AND uuid = ?`
    ).get(this._profile, uuid);

    if (exists) {
      const setUpdated = hasUpdatedAt ? ', updated_at = ?' : '';
      const stmt = this._prepare(
        `UPDATE ${table} SET ${field} = ?${setUpdated} WHERE profile_uuid = ? AND uuid = ?`
      );
      if (hasUpdatedAt) stmt.run(dbValue, now, this._profile, uuid);
      else stmt.run(dbValue, this._profile, uuid);
      return;
    }

    // Partial-row insert: seed NOT-NULL defaults, then set this field. Other fields arrive as
    // their own changes and update the row via LWW.
    const row = { ...(INSERT_DEFAULTS[table] ?? {}), uuid, profile_uuid: this._profile, created_at: now };
    if (hasUpdatedAt) row.updated_at = now;
    row[field] = dbValue;
    const cols = Object.keys(row);
    this._prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...Object.values(row));
  }

  rowExists(table, uuid) {
    return !!this._prepare(
      `SELECT 1 FROM ${safeIdent(table)} WHERE profile_uuid = ? AND uuid = ?`
    ).get(this._profile, uuid);
  }

  insertRow(table, uuid, value) {
    safeIdent(table);
    const entry = REGISTRY[table];
    const cols = ['uuid', 'profile_uuid', ...entry.columns.filter(c => c !== 'uuid' && c !== 'profile_uuid')];
    const vals = [uuid, this._profile];
    for (const c of cols.slice(2)) {
      const v = value[c];
      vals.push(v !== undefined ? sqliteValue(v) : null);
    }
    const placeholders = cols.map(() => '?').join(', ');
    this._prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
  }

  isDeleted(table, uuid) {
    const entry = REGISTRY[table];
    if (!entry || !entry.columns.includes('deleted')) return null;
    const row = this._prepare(
      `SELECT fm.hlc, fm.device_id FROM field_meta fm
       JOIN ${safeIdent(table)} t ON t.profile_uuid = fm.profile_uuid AND t.uuid = fm.row_uuid
       WHERE fm.profile_uuid = ? AND fm.table_name = ? AND fm.row_uuid = ? AND fm.field_name = 'deleted'
       AND t.deleted != 0`
    ).get(this._profile, table, uuid);
    return row ? { hlc: row.hlc, deviceId: row.device_id } : null;
  }
}

function safeIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) throw new Error(`sync: unsafe identifier "${name}"`);
  return name;
}

function sqliteValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
