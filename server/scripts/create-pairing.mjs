#!/usr/bin/env node --experimental-json-modules

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/schema.js';
import { createPairing } from '../../questlog-critical/sync-auth/pairing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ironcampaign.db');

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
migrate(db);

const profileUuid = process.argv[2] || randomUUID();

try {
  const { phrase, expiresAt } = await createPairing(db, profileUuid);
  console.log(`Profile UUID: ${profileUuid}`);
  console.log(`Pairing phrase: ${phrase}`);
  console.log(`Expires at: ${new Date(expiresAt).toISOString()}`);
  console.log('');
  console.log('Enter this phrase on the device within 10 minutes to pair.');
} catch (e) {
  console.error('Failed to create pairing:', e.message);
  process.exit(1);
} finally {
  db.close();
}
