import { randomBytes, createHash } from 'node:crypto';

export function createOwnerKey(db, profileUuid) {
  const key = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  const now = Date.now();

  const existing = db.prepare('SELECT profile_uuid FROM owners WHERE profile_uuid = ?').get(profileUuid);
  if (existing) {
    db.prepare('UPDATE owners SET owner_key_sha256 = ?, rotated_at = ? WHERE profile_uuid = ?')
      .run(hash, now, profileUuid);
  } else {
    db.prepare('INSERT INTO owners (profile_uuid, owner_key_sha256, created_at) VALUES (?, ?, ?)')
      .run(profileUuid, hash, now);
  }

  return { key, profileUuid };
}

export function authenticateOwner(db, authorizationHeader) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(authorizationHeader || '');
  if (!m) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  const hash = createHash('sha256').update(m[1]).digest('hex');
  const row = db.prepare(
    'SELECT profile_uuid FROM owners WHERE owner_key_sha256 = ?'
  ).get(hash);
  if (!row) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  return { profileUuid: row.profile_uuid };
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
