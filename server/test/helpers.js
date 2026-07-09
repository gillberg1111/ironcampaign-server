import Database from 'better-sqlite3';
import express from 'express';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { migrate } from '../src/db/schema.js';
import combatRoutes from '../src/routes/combat.js';
import syncRoutes from '../src/routes/sync.js';
import ownerRoutes from '../src/routes/owner.js';
import { createOwnerKey } from '../src/auth/owner.js';

export function makeDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

export function makeApp() {
  const db = makeDb();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', combatRoutes(db));
  app.use('/api/v1', syncRoutes(db));
  app.use('/api/v1', ownerRoutes(db));
  return { app, db };
}

export function addDevice(db, profileUuid, deviceName = 'test') {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare(
    'INSERT INTO device_tokens (profile_uuid, token_sha256, device_name, created_at) VALUES (?, ?, ?, ?)'
  ).run(profileUuid, tokenHash, deviceName, Date.now());
  return token;
}

export function seedVillain(db, profileUuid, overrides = {}) {
  const now = Date.now();
  const uuid = overrides.uuid || randomUUID();
  const villain = {
    uuid,
    profile_uuid: profileUuid,
    name: overrides.name ?? 'Test Villain',
    hp: overrides.hp ?? 100,
    max_hp: overrides.max_hp ?? 100,
    active: overrides.active ?? 1,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_session_at: overrides.last_session_at ?? null,
    deleted: overrides.deleted ?? 0,
  };
  db.prepare(
    'INSERT INTO villains (uuid, profile_uuid, name, hp, max_hp, active, created_at, updated_at, last_session_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(villain.uuid, villain.profile_uuid, villain.name, villain.hp, villain.max_hp, villain.active, villain.created_at, villain.updated_at, villain.last_session_at, villain.deleted);
  if (overrides.fieldMeta) {
    for (const fm of overrides.fieldMeta) {
      db.prepare(
        'INSERT OR REPLACE INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(profileUuid, fm.table ?? 'villains', uuid, fm.field, fm.hlc, fm.deviceId);
    }
  }
  return villain;
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

export function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(r => r.json().then(d => ({ status: r.status, data: d })));
}

export function getJson(url, headers = {}) {
  return fetch(url, {
    headers: { ...headers },
  }).then(r => r.json().then(d => ({ status: r.status, data: d })));
}

export function addOwner(db, profileUuid) {
  return createOwnerKey(db, profileUuid);
}
