import { APPEND_ONLY_TABLES } from '../../../questlog-critical/hlc-merge/merge.js';

export const REGISTRY = {
  villains: {
    appendOnly: false,
    columns: ['uuid', 'name', 'hp', 'max_hp', 'active', 'created_at', 'updated_at', 'last_session_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'hp', 'max_hp', 'active', 'last_session_at'],
  },
  sagas: {
    appendOnly: false,
    columns: ['uuid', 'name', 'description', 'active', 'created_at', 'updated_at', 'deleted', 'current_chapter_uuid', 'profile_uuid'],
    mutableFields: ['name', 'description', 'active', 'current_chapter_uuid'],
  },
  chapters: {
    appendOnly: false,
    columns: ['uuid', 'saga_uuid', 'name', 'week_index', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['saga_uuid', 'name', 'week_index', 'notes'],
  },
  sessions: {
    appendOnly: false,
    columns: ['uuid', 'saga_uuid', 'chapter_uuid', 'villain_uuid', 'date', 'duration_minutes', 'status', 'session_type', 'xp_earned', 'combat_action_reason', 'created_at', 'profile_uuid'],
    mutableFields: ['saga_uuid', 'chapter_uuid', 'villain_uuid', 'date', 'duration_minutes', 'status', 'session_type', 'xp_earned', 'combat_action_reason'],
  },
  xp_events: {
    appendOnly: true,
    columns: ['uuid', 'timestamp', 'amount', 'reason', 'villain_uuid', 'session_uuid', 'profile_uuid'],
  },
  villain_events: {
    appendOnly: true,
    columns: ['uuid', 'villain_uuid', 'timestamp', 'reason', 'damage', 'xp', 'damage_roll', 'result_stamp', 'buff_stamp', 'profile_uuid'],
  },
  narrations: {
    appendOnly: true,
    columns: ['uuid', 'timestamp', 'message', 'severity', 'villain_uuid', 'session_uuid', 'profile_uuid'],
  },
  exercises: {
    appendOnly: false,
    columns: ['uuid', 'name', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'notes'],
  },
  set_logs: {
    appendOnly: true,
    columns: ['uuid', 'session_uuid', 'exercise_uuid', 'set_index', 'reps', 'weight_kg', 'rpe', 'timestamp', 'replaces_uuid', 'profile_uuid'],
  },
  workout_templates: {
    appendOnly: false,
    columns: ['uuid', 'name', 'est_minutes', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'est_minutes', 'notes'],
  },
  template_exercises: {
    appendOnly: false,
    columns: ['uuid', 'template_uuid', 'exercise_uuid', 'position', 'target_sets', 'target_reps', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['template_uuid', 'exercise_uuid', 'position', 'target_sets', 'target_reps', 'notes'],
  },
  measurements: {
    appendOnly: true,
    columns: ['uuid', 'timestamp', 'kind', 'value', 'unit', 'replaces_uuid', 'profile_uuid'],
  },
};

// Every table the server hosts must agree with the engine on append-only-ness. The engine's
// APPEND_ONLY_TABLES is a superset (it also lists tables this node doesn't host, e.g. set_logs,
// measurements) — that's fine; we only assert consistency for the tables in this registry.
for (const [table, entry] of Object.entries(REGISTRY)) {
  if (!!entry.appendOnly !== APPEND_ONLY_TABLES.has(table)) {
    throw new Error(`sync: registry appendOnly for "${table}" disagrees with merge.js APPEND_ONLY_TABLES`);
  }
}

export function assertAllowed(table, field) {
  const entry = REGISTRY[table];
  if (!entry) {
    const err = new Error(`sync: unknown table "${table}"`);
    err.status = 400;
    throw err;
  }
  if (entry.appendOnly) return;
  if (field === 'deleted') {
    if (!entry.columns.includes('deleted')) {
      const err = new Error(`sync: table "${table}" has no "deleted" column`);
      err.status = 400;
      throw err;
    }
    return;
  }
  if (!entry.mutableFields.includes(field)) {
    const err = new Error(`sync: field "${field}" not mutable on table "${table}"`);
    err.status = 400;
    throw err;
  }
}

export function validateAppendColumns(table, value) {
  const entry = REGISTRY[table];
  if (!entry || !entry.appendOnly) return;
  const allowed = new Set(entry.columns);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const err = new Error(`sync: unknown column "${key}" on append-only table "${table}"`);
      err.status = 400;
      throw err;
    }
  }
}
