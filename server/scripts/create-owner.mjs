#!/usr/bin/env node

// Sets or resets the web admin credentials from the terminal — the recovery path when the
// password is lost (equivalent to booting with ADMIN_PASSWORD, but explicit and one-shot).
// v2.42 replaced the owner-key model with username/password login; the old createOwnerKey
// this script used no longer exists.
//
//   node scripts/create-owner.mjs <username> <password>

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'node:crypto';
import { migrate } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/owner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ironcampaign.db');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/create-owner.mjs <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
migrate(db);

try {
  const hashed = hashPassword(password);
  const existing = db.prepare('SELECT profile_uuid FROM owners LIMIT 1').get();
  if (existing) {
    db.prepare('UPDATE owners SET username = ?, password_hash = ? WHERE profile_uuid = ?')
      .run(username, hashed, existing.profile_uuid);
    console.log(`Admin credentials reset for profile ${existing.profile_uuid}.`);
  } else {
    const profileUuid = randomUUID();
    const placeholderKey = createHash('sha256').update(randomUUID()).digest('hex');
    db.prepare('INSERT INTO owners (profile_uuid, owner_key_sha256, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(profileUuid, placeholderKey, username, hashed, Date.now());
    console.log(`Admin account created for new profile ${profileUuid}.`);
  }
  console.log('Log in at /owner with these credentials.');
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
} finally {
  db.close();
}
