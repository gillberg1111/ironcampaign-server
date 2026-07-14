const SCHEMA_VERSION = 18;

function columnExists(db, table, column) {
  const rows = db.pragma(`table_info(${table})`);
  return rows.some(r => r.name === column);
}

function addColumnIfMissing(db, table, column, type) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

      CREATE TABLE IF NOT EXISTS villains (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hp INTEGER NOT NULL DEFAULT 100,
        max_hp INTEGER NOT NULL DEFAULT 100,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_session_at INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        uuid TEXT PRIMARY KEY,
        saga_uuid TEXT,
        chapter_uuid TEXT,
        villain_uuid TEXT,
        date INTEGER NOT NULL,
        duration_minutes REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        session_type TEXT NOT NULL DEFAULT 'strength',
        xp_earned INTEGER NOT NULL DEFAULT 0,
        combat_action_reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (villain_uuid) REFERENCES villains(uuid)
      );

      CREATE TABLE IF NOT EXISTS xp_events (
        uuid TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        villain_uuid TEXT,
        session_uuid TEXT,
        FOREIGN KEY (villain_uuid) REFERENCES villains(uuid),
        FOREIGN KEY (session_uuid) REFERENCES sessions(uuid)
      );

      CREATE TABLE IF NOT EXISTS villain_events (
        uuid TEXT PRIMARY KEY,
        villain_uuid TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('heavy_strike','chipped_damage','fortify','glancing_blow','confession','decay')),
        damage INTEGER NOT NULL DEFAULT 0,
        xp INTEGER NOT NULL DEFAULT 0,
        damage_roll INTEGER,
        result_stamp TEXT,
        buff_stamp TEXT,
        FOREIGN KEY (villain_uuid) REFERENCES villains(uuid)
      );

      CREATE TABLE IF NOT EXISTS narrations (
        uuid TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        message TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        villain_uuid TEXT,
        session_uuid TEXT
      );

      CREATE TABLE IF NOT EXISTS sagas (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chapters (
        uuid TEXT PRIMARY KEY,
        saga_uuid TEXT NOT NULL,
        name TEXT NOT NULL,
        week_index INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (saga_uuid) REFERENCES sagas(uuid)
      );

      CREATE TABLE IF NOT EXISTS field_meta (
        table_name TEXT NOT NULL,
        row_uuid TEXT NOT NULL,
        field_name TEXT NOT NULL,
        hlc TEXT NOT NULL,
        device_id TEXT NOT NULL,
        PRIMARY KEY (table_name, row_uuid, field_name)
      );

      CREATE TABLE IF NOT EXISTS sync_cursor (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pairings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_uuid TEXT NOT NULL,
        phrase_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_uuid TEXT NOT NULL,
        token_sha256 TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_sha256);
      CREATE INDEX IF NOT EXISTS idx_villain_events_villain ON villain_events(villain_uuid);
      CREATE INDEX IF NOT EXISTS idx_villain_events_timestamp ON villain_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_xp_events_timestamp ON xp_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
      CREATE INDEX IF NOT EXISTS idx_narrations_timestamp ON narrations(timestamp);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS change_log (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name   TEXT    NOT NULL,
        row_uuid     TEXT    NOT NULL,
        field_name   TEXT    NOT NULL,
        value_json   TEXT,
        hlc          TEXT    NOT NULL,
        device_id    TEXT    NOT NULL,
        change_id    INTEGER,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS owners (
        profile_uuid    TEXT PRIMARY KEY,
        owner_key_sha256 TEXT NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL,
        rotated_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_owners_key ON owners(owner_key_sha256);
    `,
  },
];

function applyV5(db) {
  addColumnIfMissing(db, 'sagas', 'current_chapter_uuid', 'TEXT');
}

function applyV6(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS exercises (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS set_logs (
    uuid TEXT PRIMARY KEY,
    session_uuid TEXT NOT NULL,
    exercise_uuid TEXT NOT NULL,
    set_index INTEGER NOT NULL,
    reps INTEGER NOT NULL,
    weight_kg REAL,
    rpe REAL,
    timestamp INTEGER NOT NULL,
    replaces_uuid TEXT,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_exercises_profile_uuid ON exercises(profile_uuid, uuid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_set_logs_profile_uuid ON set_logs(profile_uuid, uuid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_set_logs_session ON set_logs(session_uuid)');
}

function applyV7(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS workout_templates (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    est_minutes INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS template_exercises (
    uuid TEXT PRIMARY KEY,
    template_uuid TEXT NOT NULL,
    exercise_uuid TEXT NOT NULL,
    position INTEGER NOT NULL,
    target_sets INTEGER,
    target_reps INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_workout_templates_profile_uuid ON workout_templates(profile_uuid, uuid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_template_exercises_profile_uuid ON template_exercises(profile_uuid, uuid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_template_exercises_template ON template_exercises(template_uuid)');
}

function applyV8(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS measurements (
    uuid TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    kind TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    replaces_uuid TEXT,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_profile_uuid ON measurements(profile_uuid, uuid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_measurements_kind ON measurements(kind)');
}

function applyV9(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS foe_catalog (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('minion','heavy','miniboss','boss')),
    max_hp INTEGER NOT NULL,
    xp_reward INTEGER NOT NULL,
    encounter_weight INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_foe_catalog_profile_uuid ON foe_catalog(profile_uuid, uuid)');
  addColumnIfMissing(db, 'villains', 'tier', 'TEXT');
  addColumnIfMissing(db, 'villains', 'xp_reward', 'INTEGER');
  addColumnIfMissing(db, 'villains', 'slot', 'TEXT');
  addColumnIfMissing(db, 'villains', 'catalog_uuid', 'TEXT');
  // xp_events.reason has no CHECK constraint; the new 'villain_defeated' value needs no DDL.
}

function applyV10(db) {
  if (!columnExists(db, 'villain_events', 'reason')) return;
  // Atomic on purpose: without the transaction, a crash between DROP and RENAME leaves the DB
  // with no villain_events, and the columnExists guard above would then skip the repair forever.
  const rebuild = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS villain_events_v10');
    db.exec(`CREATE TABLE villain_events_v10 (
        uuid TEXT PRIMARY KEY,
        villain_uuid TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('heavy_strike','chipped_damage','fortify','glancing_blow','confession','decay','hydration')),
        damage INTEGER NOT NULL DEFAULT 0,
        xp INTEGER NOT NULL DEFAULT 0,
        damage_roll INTEGER,
        result_stamp TEXT,
        buff_stamp TEXT,
        profile_uuid TEXT NOT NULL
      )
    `);
    db.exec('INSERT INTO villain_events_v10 SELECT * FROM villain_events');
    db.exec('DROP TABLE villain_events');
    db.exec('ALTER TABLE villain_events_v10 RENAME TO villain_events');
    db.exec('CREATE INDEX IF NOT EXISTS idx_villain_events_villain ON villain_events(villain_uuid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_villain_events_timestamp ON villain_events(timestamp)');
  });
  rebuild();
}

function applyV14(db) {
  addColumnIfMissing(db, 'owners', 'setup_key_delivered_at', 'INTEGER');
}

function migrate(db) {
  db.pragma('journal_mode = WAL');
  // FKs are intentionally OFF on the sync node: it is a relay, and merged changes can arrive
  // out of referential order (e.g. an event before its villain, or a partial-row insert whose
  // parent uuid arrives in a later field change). The device is the source of truth for
  // referential integrity; enforcing FKs here would spuriously roll back valid sync batches.
  db.pragma('foreign_keys = OFF');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');

  const currentVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      db.exec(m.sql);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(m.version);
    }
  }

  if (currentVersion < 3) {
    applyV3(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(3);
  }

  if (currentVersion < 5) {
    applyV5(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(5);
  }

  if (currentVersion < 6) {
    applyV6(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(6);
  }

  if (currentVersion < 7) {
    applyV7(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(7);
  }

  if (currentVersion < 8) {
    applyV8(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(8);
  }

  if (currentVersion < 9) {
    applyV9(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(9);
  }

  if (currentVersion < 10) {
    applyV10(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(10);
  }

  if (currentVersion < 11) {
    applyV11(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(11);
  }

  if (currentVersion < 12) {
    applyV12(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(12);
  }

  if (currentVersion < 13) {
    applyV13(db);
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(13);
  }

    if (currentVersion < 14) {
      applyV14(db);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(14);
    }

    if (currentVersion < 15) {
      applyV15(db);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(15);
    }

    if (currentVersion < 16) {
      applyV16(db);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(16);
    }

    if (currentVersion < 17) {
      applyV17(db);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(17);
    }

    if (currentVersion < 18) {
      applyV18(db);
      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(18);
    }
  }

function applyV11(db) {
  addColumnIfMissing(db, 'exercises', 'tracking_type', "TEXT NOT NULL DEFAULT 'strength'");
  addColumnIfMissing(db, 'set_logs', 'completed', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'set_logs', 'duration_sec', 'INTEGER');
  addColumnIfMissing(db, 'set_logs', 'distance_m', 'INTEGER');
}

function applyV12(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS planned_workouts (
    uuid TEXT PRIMARY KEY,
    chapter_uuid TEXT NOT NULL,
    day_index INTEGER NOT NULL,
    template_uuid TEXT,
    name TEXT NOT NULL,
    notes TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_planned_workouts_profile_uuid ON planned_workouts(profile_uuid, uuid)');
  addColumnIfMissing(db, 'template_exercises', 'target_weight_kg', 'REAL');
}

function applyV13(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_rules (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    template_uuid TEXT,
    planned_workout_uuid TEXT,
    start_date TEXT NOT NULL,
    recurrence TEXT NOT NULL CHECK (recurrence IN ('once','interval','weekly')),
    interval_days INTEGER,
    weekday_mask INTEGER,
    end_date TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    profile_uuid TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_schedule_rules_profile_uuid ON schedule_rules(profile_uuid, uuid)');
  addColumnIfMissing(db, 'sessions', 'schedule_rule_uuid', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'planned_workout_uuid', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'scheduled_date', 'TEXT');
  addColumnIfMissing(db, 'sagas', 'start_date', 'TEXT');
}

function applyV15(db) {
    addColumnIfMissing(db, 'foe_catalog', 'description', 'TEXT');
  }

  function applyV16(db) {
    addColumnIfMissing(db, 'owners', 'username', 'TEXT');
    addColumnIfMissing(db, 'owners', 'password_hash', 'TEXT');
  }

  function applyV17(db) {
    addColumnIfMissing(db, 'exercises', 'builtin_id', 'TEXT');
  }

  function applyV18(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS device_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_uuid TEXT NOT NULL,
      device_token_id INTEGER NOT NULL,
      cursor_seq INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      FOREIGN KEY (device_token_id) REFERENCES device_tokens(id),
      UNIQUE(profile_uuid, device_token_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_device_cursors_profile_seen ON device_cursors(profile_uuid, last_seen_at)');
  }

  function applyV3(db) {
  const domainTables = ['villains', 'sagas', 'chapters', 'sessions', 'xp_events', 'villain_events', 'narrations'];
  for (const t of domainTables) {
    addColumnIfMissing(db, t, 'profile_uuid', "TEXT NOT NULL DEFAULT '__migrate__'");
  }
  addColumnIfMissing(db, 'change_log', 'profile_uuid', "TEXT NOT NULL DEFAULT '__migrate__'");

  recreateFieldMeta(db);

  db.exec('CREATE TABLE IF NOT EXISTS server_clock (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  db.exec('DROP TABLE IF EXISTS sync_cursor');

  db.exec('CREATE INDEX IF NOT EXISTS idx_change_log_profile_seq ON change_log(profile_uuid, seq)');
  for (const t of domainTables) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_profile_uuid ON ${t}(profile_uuid, uuid)`);
  }
}

function recreateFieldMeta(db) {
  const hasProfile = columnExists(db, 'field_meta', 'profile_uuid');
  if (hasProfile) return;

  const rows = db.prepare('SELECT table_name, row_uuid, field_name, hlc, device_id FROM field_meta').all();

  db.exec('DROP TABLE IF EXISTS field_meta');
  db.exec(`
    CREATE TABLE field_meta (
      profile_uuid TEXT NOT NULL,
      table_name   TEXT NOT NULL,
      row_uuid     TEXT NOT NULL,
      field_name   TEXT NOT NULL,
      hlc          TEXT NOT NULL,
      device_id    TEXT NOT NULL,
      PRIMARY KEY (profile_uuid, table_name, row_uuid, field_name)
    )
  `);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run('__migrate__', r.table_name, r.row_uuid, r.field_name, r.hlc, r.device_id);
  }
}

export { migrate, SCHEMA_VERSION };
