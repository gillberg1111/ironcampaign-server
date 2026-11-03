import { Router } from 'express';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, mintConsoleToken, makeOwnerAuth } from '../auth/owner.js';
import { createPairing, revokeDevice } from '../../../questlog-critical/sync-auth/pairing.js';
import { slidingWindowLimit } from '../middleware/rateLimit.js';

const SETUP_CODE_KEY = 'setup_code_sha256';

export function isServerClaimed(db) {
  const row = db.prepare('SELECT 1 FROM owners WHERE password_hash IS NOT NULL LIMIT 1').get();
  return !!row;
}

export function clearSetupCode(db) {
  db.prepare('DELETE FROM server_clock WHERE key = ?').run(SETUP_CODE_KEY);
}

/** While the node is unclaimed, rotate a one-time code and print it. Returns the code, or null if already claimed. */
export function issueSetupCode(db) {
  if (isServerClaimed(db)) return null;
  const code = randomBytes(9).toString('base64url');
  const hash = createHash('sha256').update(code).digest('hex');
  db.prepare(
    `INSERT INTO server_clock (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SETUP_CODE_KEY, hash);
  console.log(`IronCampaign setup code (rotates each boot until the node is claimed): ${code}`);
  return code;
}

export function setupCodeRequired(db) {
  return !!db.prepare('SELECT 1 FROM server_clock WHERE key = ?').get(SETUP_CODE_KEY);
}

export function assertSetupCode(db, setupCode) {
  const row = db.prepare('SELECT value FROM server_clock WHERE key = ?').get(SETUP_CODE_KEY);
  if (!row) return;
  const given = typeof setupCode === 'string' ? setupCode : '';
  const got = createHash('sha256').update(given).digest();
  const expected = Buffer.from(String(row.value), 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    const err = new Error('invalid setup code');
    err.status = 403;
    throw err;
  }
}

function sendError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
}

export default function ownerRoutes(db) {
  const router = Router();
  const auth = makeOwnerAuth(db);

  // A password login without a limiter is an open brute-force surface (same in-memory
  // pattern the pairing endpoints use; per-router instance so tests stay isolated).
  const loginAttempts = new Map();
  function rateLimitLogin(ip) {
    slidingWindowLimit(loginAttempts, ip || 'unknown', { windowMs: 15 * 60 * 1000, max: 10 });
  }

  router.get('/owner/status', (_req, res) => {
    res.json({ claimed: isServerClaimed(db), setupRequired: setupCodeRequired(db) });
  });

  router.get('/owner/setup', (_req, res) => {
    res.json({ claimed: isServerClaimed(db), setupRequired: setupCodeRequired(db) });
  });

  router.post('/owner/claim', (req, res) => {
    try {
      rateLimitLogin(req.ip);
      if (isServerClaimed(db)) {
        return res.status(409).json({ error: 'server already claimed' });
      }

      const { username, password, setupCode } = req.body || {};
      assertSetupCode(db, setupCode);
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
      clearSetupCode(db);

      res.status(201).json({ token });
    } catch (e) {
      sendError(res, e);
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
      sendError(res, e);
    }
  });

  router.post('/owner/logout', auth, (req, res) => {
    const revoked = revokeDevice(db, req.ownerDeviceTokenId);
    res.json({ revoked });
  });

  router.post('/owner/pairings', auth, async (req, res) => {
    try {
      const { phrase, expiresAt } = await createPairing(db, req.ownerProfileUuid);
      res.json({ phrase, expiresAt });
    } catch (e) {
      sendError(res, e);
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
