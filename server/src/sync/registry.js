import { APPEND_ONLY_TABLES } from '../../../questlog-critical/hlc-merge/merge.js';

export const REGISTRY = {
  villains: {
    appendOnly: false,
    columns: ['uuid', 'name', 'hp', 'max_hp', 'active', 'created_at', 'updated_at', 'last_session_at', 'deleted', 'tier', 'xp_reward', 'slot', 'catalog_uuid', 'profile_uuid'],
    mutableFields: ['name', 'hp', 'max_hp', 'active', 'last_session_at', 'tier', 'xp_reward', 'slot', 'catalog_uuid'],
  },
  sagas: {
    appendOnly: false,
    columns: ['uuid', 'name', 'description', 'active', 'created_at', 'updated_at', 'deleted', 'current_chapter_uuid', 'start_date', 'profile_uuid'],
    mutableFields: ['name', 'description', 'active', 'current_chapter_uuid', 'start_date'],
  },
  chapters: {
    appendOnly: false,
    columns: ['uuid', 'saga_uuid', 'name', 'week_index', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['saga_uuid', 'name', 'week_index', 'notes'],
  },
  sessions: {
    appendOnly: false,
    columns: ['uuid', 'saga_uuid', 'chapter_uuid', 'villain_uuid', 'date', 'duration_minutes', 'status', 'session_type', 'xp_earned', 'combat_action_reason', 'created_at', 'schedule_rule_uuid', 'planned_workout_uuid', 'scheduled_date', 'profile_uuid'],
    mutableFields: ['saga_uuid', 'chapter_uuid', 'villain_uuid', 'date', 'duration_minutes', 'status', 'session_type', 'xp_earned', 'combat_action_reason', 'schedule_rule_uuid', 'planned_workout_uuid', 'scheduled_date'],
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
    columns: ['uuid', 'name', 'notes', 'tracking_type', 'equipment', 'builtin_id', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'notes', 'tracking_type', 'equipment'],
  },
  set_logs: {
    appendOnly: true,
    columns: ['uuid', 'session_uuid', 'exercise_uuid', 'set_index', 'reps', 'weight_kg', 'rpe', 'completed', 'duration_sec', 'distance_m', 'timestamp', 'replaces_uuid', 'profile_uuid'],
  },
  workout_templates: {
    appendOnly: false,
    columns: ['uuid', 'name', 'est_minutes', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'est_minutes', 'notes'],
  },
  template_exercises: {
    appendOnly: false,
    columns: ['uuid', 'template_uuid', 'exercise_uuid', 'position', 'target_sets', 'target_reps', 'target_weight_kg', 'notes', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['template_uuid', 'exercise_uuid', 'position', 'target_sets', 'target_reps', 'target_weight_kg', 'notes'],
  },
  measurements: {
    appendOnly: true,
    columns: ['uuid', 'timestamp', 'kind', 'value', 'unit', 'replaces_uuid', 'profile_uuid'],
  },
    foe_catalog: {
      appendOnly: false,
      columns: ['uuid', 'name', 'tier', 'max_hp', 'xp_reward', 'encounter_weight', 'enabled', 'builtin_id', 'description', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
      mutableFields: ['name', 'tier', 'max_hp', 'xp_reward', 'encounter_weight', 'enabled', 'description'],
    },
  planned_workouts: {
    appendOnly: false,
    columns: ['uuid', 'chapter_uuid', 'day_index', 'template_uuid', 'name', 'notes', 'position', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['chapter_uuid', 'day_index', 'template_uuid', 'name', 'notes', 'position'],
  },
  schedule_rules: {
    appendOnly: false,
    columns: ['uuid', 'name', 'template_uuid', 'planned_workout_uuid', 'start_date', 'recurrence', 'interval_days', 'weekday_mask', 'end_date', 'notes', 'schedule_group', 'created_at', 'updated_at', 'deleted', 'profile_uuid'],
    mutableFields: ['name', 'template_uuid', 'planned_workout_uuid', 'start_date', 'recurrence', 'interval_days', 'weekday_mask', 'end_date', 'notes', 'schedule_group'],
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
