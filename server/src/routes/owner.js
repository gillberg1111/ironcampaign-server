import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, mintConsoleToken, makeOwnerAuth } from '../auth/owner.js';
import { createPairing, revokeDevice } from '../../../questlog-critical/sync-auth/pairing.js';

export function isServerClaimed(db) {
  const row = db.prepare('SELECT 1 FROM owners WHERE password_hash IS NOT NULL LIMIT 1').get();
  return !!row;
}

export default function ownerRoutes(db) {
  const router = Router();
  const auth = makeOwnerAuth(db);

  // A password login without a limiter is an open brute-force surface (same in-memory
  // pattern the pairing endpoints use; per-router instance so tests stay isolated).
  const loginAttempts = new Map();
  function rateLimitLogin(ip) {
    const now = Date.now();
    const WINDOW_MS = 15 * 60 * 1000;
    const MAX = 10;
    const a = loginAttempts.get(ip);
    if (!a || now - a.windowStart > WINDOW_MS) {
      loginAttempts.set(ip, { count: 1, windowStart: now });
      return;
    }
    a.count += 1;
    if (a.count > MAX) { const e = new Error('rate limited'); e.status = 429; throw e; }
  }

  router.get('/owner/status', (_req, res) => {
    res.json({ claimed: isServerClaimed(db) });
  });

  router.get('/owner/setup', (_req, res) => {
    res.json({ claimed: isServerClaimed(db) });
  });

  router.post('/owner/claim', (req, res) => {
    try {
      rateLimitLogin(req.ip);
      if (isServerClaimed(db)) {
        return res.status(409).json({ error: 'server already claimed' });
      }

      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'username and password required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
      }

      const profileUuid = randomUUID();
      const hashed = hashPassword(password);
      const now = Date.now();

      let ownerRow = db.prepare('SELECT profile_uuid FROM owners LIMIT 1').get();
      if (ownerRow) {
        db.prepare('UPDATE owners SET username = ?, password_hash = ? WHERE profile_uuid = ?')
          .run(username.trim(), hashed, ownerRow.profile_uuid);
      } else {
        const placeholderKey = createHash('sha256').update(randomUUID()).digest('hex');
        db.prepare('INSERT INTO owners (profile_uuid, owner_key_sha256, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(profileUuid, placeholderKey, username.trim(), hashed, now);
      }

      const puid = ownerRow ? ownerRow.profile_uuid : profileUuid;
      const token = mintConsoleToken(db, puid);

      res.status(201).json({ token });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/owner/login', (req, res) => {
    try {
      rateLimitLogin(req.ip);
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'username and password required' });
      }

      const row = db.prepare(
        'SELECT profile_uuid, password_hash FROM owners WHERE username = ?'
      ).get(username.trim());

      if (!row || !row.password_hash) {
        return res.status(401).json({ error: 'invalid username or password' });
      }

      if (!verifyPassword(row.password_hash, password)) {
        return res.status(401).json({ error: 'invalid username or password' });
      }

      const token = mintConsoleToken(db, row.profile_uuid);

      res.status(200).json({ token });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/owner/pairings', auth, async (req, res) => {
    try {
      const { phrase, expiresAt } = await createPairing(db, req.ownerProfileUuid);
      res.json({ phrase, expiresAt });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.get('/owner/devices', auth, (req, res) => {
    const rows = db.prepare(
      'SELECT id, device_name, created_at, last_seen_at, revoked_at FROM device_tokens WHERE profile_uuid = ? ORDER BY created_at DESC'
    ).all(req.ownerProfileUuid);

    res.json({ devices: rows });
  });

  router.post('/owner/devices/:id/revoke', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid device id' });
    }

    const target = db.prepare(
      'SELECT id FROM device_tokens WHERE id = ? AND profile_uuid = ?'
    ).get(id, req.ownerProfileUuid);

    if (!target) {
      return res.status(404).json({ error: 'device not found' });
    }

    const revoked = revokeDevice(db, id);
    res.json({ revoked });
  });

  return router;
}
