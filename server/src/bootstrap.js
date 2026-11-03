import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hashPassword } from './auth/owner.js';
import { clearSetupCode } from './routes/owner.js';

/**
 * One-shot owner bootstrap. A password already stored is left alone — repeating the env var
 * on every boot used to reset it, and a fresh row with no username could not log in.
 * Resets go through scripts/create-owner.mjs.
 */
export function applyAdminPassword(db, env = process.env) {
  const password = env.ADMIN_PASSWORD;
  if (!password) return { applied: false, reason: 'unset' };

  const existing = db.prepare('SELECT profile_uuid, password_hash FROM owners LIMIT 1').get();
  if (existing?.password_hash) return { applied: false, reason: 'already-set' };

  const username = (typeof env.ADMIN_USERNAME === 'string' && env.ADMIN_USERNAME.trim()) || 'admin';
  const hashed = hashPassword(password);
  if (existing) {
    db.prepare('UPDATE owners SET username = ?, password_hash = ? WHERE profile_uuid = ?')
      .run(username, hashed, existing.profile_uuid);
  } else {
    const profileUuid = randomUUID();
    const placeholderKey = createHash('sha256').update(randomBytes(32)).digest('hex');
    db.prepare(
      'INSERT INTO owners (profile_uuid, owner_key_sha256, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(profileUuid, placeholderKey, username, hashed, Date.now());
  }
  clearSetupCode(db);
  return { applied: true, username };
}

/**
 * Express trust-proxy setting. Default stays loopback (a same-host Caddy). Docker's published
 * port is reached via the bridge gateway, which is not loopback inside the container; set
 * TRUST_PROXY=uniquelocal only when that port is bound to 127.0.0.1. Boolean trust is refused:
 * it would honor X-Forwarded-For from any client.
 */
export function resolveTrustProxy(env = process.env) {
  const raw = (env.TRUST_PROXY || '').trim();
  if (raw === '' || raw === 'loopback') return 'loopback';
  if (raw === 'true' || raw === 'false' || /^\d+$/.test(raw)) return 'loopback';
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return 'loopback';
  return parts.length === 1 ? parts[0] : parts;
}
