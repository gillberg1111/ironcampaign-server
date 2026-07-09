import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { migrate } from './db/schema.js';
import combatRoutes from './routes/combat.js';
import syncRoutes from './routes/sync.js';
import ownerRoutes from './routes/owner.js';
import { startDecayScheduler } from './services/decay.js';
import { requestLogger } from './middleware/log.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(db) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.static(publicDir));
  app.use(requestLogger);
  // No CORS middleware on purpose: the iOS app is not a browser, and the owner console is
  // served same-origin. Wide-open CORS was pure unneeded surface (removed in the 2.26.1 audit).
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', name: 'ironcampaign-sync', version: '2.27.1' });
  });
  // Owner console (static single page). It calls /api/v1/owner/* with the owner key as a Bearer header.
  app.get('/owner', (req, res) => res.sendFile(path.join(publicDir, 'owner.html')));
  app.use('/api/v1', combatRoutes(db));
  app.use('/api/v1', syncRoutes(db));
  app.use('/api/v1', ownerRoutes(db));
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

  const app = createApp(db);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`IronCampaign sync node running on port ${PORT}`);
    startDecayScheduler(db);
  });

  process.on('SIGTERM', () => { db.close(); process.exit(0); });
  process.on('SIGINT', () => { db.close(); process.exit(0); });
}
