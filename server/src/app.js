import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { migrate, SCHEMA_VERSION } from './db/schema.js';
import combatRoutes from './routes/combat.js';
import syncRoutes from './routes/sync.js';
import ownerRoutes, { isServerClaimed } from './routes/owner.js';
import { hashPassword } from './auth/owner.js';
import dataRoutes from './routes/data.js';
import { startDecayScheduler } from './services/decay.js';
import { requestLogger } from './middleware/log.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

export function createApp(db) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.static(publicDir));
  app.use(requestLogger);
  // No CORS middleware on purpose: the iOS app is not a browser, and the owner console is
  // served same-origin. Wide-open CORS was pure unneeded surface (removed in the 2.26.1 audit).
  app.use(express.json({ limit: '1mb' }));
  app.get('/vocabulary.json', (_req, res) => {
    res.sendFile(path.join(dataDir, 'vocabulary.json'));
  });
  const startTime = Date.now();
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'ironcampaign-sync',
      version: '2.70.0',
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      schema_version: SCHEMA_VERSION,
    });
  });
  // The web app lives at /owner; the bare root should not dead-end on "Cannot GET /".
  app.get('/', (_req, res) => res.redirect('/owner'));
  // Owner console (static single page). It calls /api/v1/owner/* with the owner key as a Bearer header.
  app.get('/owner', (req, res) => {
    const claimed = isServerClaimed(db);
    const html = fs.readFileSync(path.join(publicDir, 'owner.html'), 'utf8');
    const injected = html.replace('</head>',
      `<script>window.__IC_UNCLAIMED__ = ${!claimed};</script></head>`);
    res.type('html').send(injected);
  });
  app.use('/api/v1', combatRoutes(db));
  app.use('/api/v1', syncRoutes(db));
  app.use('/api/v1', ownerRoutes(db));
  app.use('/api/v1', dataRoutes(db));
  return app;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const __dirname = path.dirname(scriptPath);
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ironcampaign.db');

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(DB_PATH);
  migrate(db);

  if (process.env.ADMIN_PASSWORD) {
    const hash = hashPassword(process.env.ADMIN_PASSWORD);
    const existing = db.prepare('SELECT profile_uuid FROM owners LIMIT 1').get();
    if (existing) {
      db.prepare('UPDATE owners SET password_hash = ? WHERE profile_uuid = ?').run(hash, existing.profile_uuid);
    } else {
      const { randomUUID, randomBytes } = await import('node:crypto');
      const puid = randomUUID();
      db.prepare('INSERT INTO owners (profile_uuid, owner_key_sha256, created_at, password_hash) VALUES (?, ?, ?, ?)').run(puid, randomBytes(32).toString('hex'), Date.now(), hash);
    }
    console.log('ADMIN_PASSWORD detected: Admin account password has been force-reset.');
  }

  const app = createApp(db);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`IronCampaign sync node running on port ${PORT}`);
    startDecayScheduler(db);
  });

  process.on('SIGTERM', () => { db.close(); process.exit(0); });
  process.on('SIGINT', () => { db.close(); process.exit(0); });
}
