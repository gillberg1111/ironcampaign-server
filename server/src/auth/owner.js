import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(stored, password) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const verify = scryptSync(password, salt, 64).toString('hex');
  // Constant-time compare — a === on hex strings leaks a (marginal) timing signal.
  const a = Buffer.from(verify, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintConsoleToken(db, profileUuid) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO device_tokens (profile_uuid, token_sha256, device_name, created_at) VALUES (?, ?, ?, ?)'
  ).run(profileUuid, tokenHash, 'Web console', now);
  return token;
}

export function authenticateOwner(db, authorizationHeader) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(authorizationHeader || '');
  if (!m) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  const tokenHash = createHash('sha256').update(m[1]).digest('hex');
  const row = db.prepare(
    'SELECT id, profile_uuid FROM device_tokens WHERE token_sha256 = ? AND revoked_at IS NULL'
  ).get(tokenHash);
  if (!row) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  db.prepare('UPDATE device_tokens SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { profileUuid: row.profile_uuid, deviceTokenId: row.id };
}

export function makeOwnerAuth(db) {
  return (req, res, next) => {
    try {
      const auth = authenticateOwner(db, req.headers.authorization);
      req.ownerProfileUuid = auth.profileUuid;
      next();
    } catch (e) {
      res.status(e.status || 401).json({ error: 'unauthorized' });
    }
  };
}
