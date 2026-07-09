#!/usr/bin/env node --experimental-json-modules

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/schema.js';
import { createOwnerKey } from '../src/auth/owner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ironcampaign.db');

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
migrate(db);

const profileUuid = process.argv[2] || randomUUID();

try {
  const result = createOwnerKey(db, profileUuid);
  console.log(`Profile UUID: ${result.profileUuid}`);
  console.log(`Owner key:    ${result.key}`);
  console.log('');
  console.log('SAVE THIS KEY. It will not be shown again.');
  console.log('Use it as: Authorization: Bearer <key>');
  console.log('');
  console.log('To rotate (replace) the key, run this command again with the same profile UUID.');
} catch (e) {
  console.error('Failed to create owner key:', e.message);
  process.exit(1);
} finally {
  db.close();
}
