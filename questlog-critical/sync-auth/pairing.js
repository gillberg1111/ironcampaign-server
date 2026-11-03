// questlog sync node — Pairing & Device Token Auth
// Spec §5.4 / §8.B. The security boundary of the entire sync node. Zero deps beyond argon2 + better-sqlite3.
//
// Flow:
//   1. Owner (web UI, already authenticated) calls createPairing(profileUuid)
//      -> returns an 8-word one-time phrase (shown once, argon2id-hashed at rest, 10-min expiry).
//   2. Device POSTs /sync/v1/pair {phrase, deviceName}
//      -> verifyAndConsumePairing() checks hash, single-use, expiry; issues a 256-bit device token.
//      -> token returned ONCE; only its SHA-256 lands in the DB. Device stores it in Keychain.
//   3. Every sync request carries Authorization: Bearer <token>.
//      -> authenticateDevice() hashes and looks up; profile scoping derives ONLY from this row.
//   4. Owner can revoke any device in the web UI (revoked_at set; row kept for audit).
//
// Design notes:
//  - Phrase entropy: 8 words from a 2048-word list = 88 bits — plus argon2id at rest, 10-minute
//    lifetime, single use, and rate limiting. Brute force is not a realistic path.
//  - Token lookup is by SHA-256(token): the digest itself acts as the secret index, so a timing
//    side-channel on the DB index reveals nothing an attacker can use without inverting SHA-256.
//  - This module NEVER logs phrases or tokens. Callers must not either (reviewer grep: 'phrase', 'token').

import { randomBytes, createHash, randomInt } from 'node:crypto';
import argon2 from 'argon2';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PHRASE_WORDS = 8;
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
const MAX_PAIR_ATTEMPTS_PER_WINDOW = 10;         // per-IP, enforced here as a second layer behind Caddy
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
// Each open phrase is an argon2id verify on every pair attempt. Cap them so a paired
// device cannot pile up work. The shipped app still creates phrases; owner-only would break it.
export const MAX_OPEN_PAIRINGS = 3;

/** WORDLIST: bundle the EFF short wordlist (2048 words) as wordlist.json — lowercase, unique. */
import WORDLIST from './wordlist.json' with { type: 'json' };
if (!Array.isArray(WORDLIST) || WORDLIST.length !== 2048) throw new Error('pairing: wordlist must be exactly 2048 words');

/* Schema (migration lives with the rest; shown for review context):
CREATE TABLE pairings (
  id INTEGER PRIMARY KEY, profile_uuid TEXT NOT NULL, phrase_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE device_tokens (
  id INTEGER PRIMARY KEY, profile_uuid TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'device', expires_at INTEGER
);
CREATE INDEX idx_tokens_hash ON device_tokens(token_sha256);
*/

const attempts = new Map(); // ip -> {count, windowStart} — in-memory is fine; Caddy is the primary limiter

function rateLimit(ip) {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) attempts.delete(key);
  }
  const a = attempts.get(ip);
  if (!a) { attempts.set(ip, { count: 1, windowStart: now }); return; }
  a.count += 1;
  if (a.count > MAX_PAIR_ATTEMPTS_PER_WINDOW) { const e = new Error('rate limited'); e.status = 429; throw e; }
}

function generatePhrase() {
  const words = [];
  for (let i = 0; i < PHRASE_WORDS; i++) words.push(WORDLIST[randomInt(0, WORDLIST.length)]); // crypto-backed
  return words.join('-');
}

function normalizePhrase(input) {
  if (typeof input !== 'string' || input.length > 200) return null;
  const norm = input.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return /^[a-z]+(-[a-z]+){7}$/.test(norm) ? norm : null;
}

/** Caller has already authenticated (owner console or a paired device). Returns the phrase — display ONCE, never store plaintext. */
export async function createPairing(db, profileUuid) {
  if (typeof profileUuid !== 'string' || profileUuid.length === 0 || profileUuid.length > 64) throw new Error('bad profile');
  const now = Date.now();
  db.prepare('DELETE FROM pairings WHERE expires_at < ? AND consumed_at IS NULL').run(now); // opportunistic GC
  const open = db.prepare(
    'SELECT COUNT(*) AS n FROM pairings WHERE profile_uuid = ? AND consumed_at IS NULL AND expires_at >= ?'
  ).get(profileUuid, now);
  if (open.n >= MAX_OPEN_PAIRINGS) {
    const e = new Error('too many open pairings');
    e.status = 429;
    throw e;
  }
  const phrase = generatePhrase();
  const hash = await argon2.hash(phrase, ARGON2_OPTS);
  db.prepare('INSERT INTO pairings (profile_uuid, phrase_hash, created_at, expires_at) VALUES (?,?,?,?)')
    .run(profileUuid, hash, now, now + PAIRING_TTL_MS);
  return { phrase, expiresAt: now + PAIRING_TTL_MS };
}

/** Device pairing endpoint core. Returns {token, profileUuid} exactly once, or throws. */
export async function verifyAndConsumePairing(db, rawPhrase, deviceName, ip) {
  rateLimit(ip);
  const phrase = normalizePhrase(rawPhrase);
  const name = typeof deviceName === 'string' ? deviceName.trim().slice(0, 64) : '';
  if (!phrase || !name) { const e = new Error('invalid request'); e.status = 400; throw e; }

  const now = Date.now();
  const candidates = db.prepare(
    'SELECT id, profile_uuid, phrase_hash FROM pairings WHERE consumed_at IS NULL AND expires_at >= ?').all(now);

  let matched = null;
  for (const row of candidates) {                       // argon2.verify is constant-time internally
    if (await argon2.verify(row.phrase_hash, phrase)) { matched = row; break; }
  }
  if (!matched) { const e = new Error('pairing failed'); e.status = 401; throw e; } // uniform error, no detail

  // Single-use: consume atomically; a raced duplicate loses.
  const consumed = db.prepare('UPDATE pairings SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now, matched.id);
  if (consumed.changes !== 1) { const e = new Error('pairing failed'); e.status = 401; throw e; }

  const token = randomBytes(32).toString('base64url');  // 256-bit
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO device_tokens (profile_uuid, token_sha256, device_name, created_at, kind) VALUES (?,?,?,?,?)')
    .run(matched.profile_uuid, tokenHash, name, now, 'device');

  return { token, profileUuid: matched.profile_uuid };  // token appears here and NOWHERE else, ever
}

/** Middleware core: resolve Bearer token -> {profileUuid, deviceTokenId} or throw 401. */
export function authenticateDevice(db, authorizationHeader) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(authorizationHeader || '');
  if (!m) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  const tokenHash = createHash('sha256').update(m[1]).digest('hex');
  const row = db.prepare(
    'SELECT id, profile_uuid, kind, expires_at FROM device_tokens WHERE token_sha256 = ? AND revoked_at IS NULL').get(tokenHash);
  if (!row) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  // Console sessions expire. Phone tokens do not: the shipped app has no refresh, and an
  // expiry would lock out every paired device. kind defaults to 'device' for rows minted
  // before the column existed.
  if (row.kind === 'console' && !(row.expires_at > Date.now())) {
    const e = new Error('unauthorized'); e.status = 401; throw e;
  }
  db.prepare('UPDATE device_tokens SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { profileUuid: row.profile_uuid, deviceTokenId: row.id };
  // CRITICAL INVARIANT: profileUuid comes ONLY from this row. Any handler reading a profile id
  // from the request body/query instead is a review-blocking IDOR defect.
}

/** Owner-only revocation (web UI). Keeps the row for audit. */
export function revokeDevice(db, deviceTokenId) {
  return db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), deviceTokenId).changes === 1;
}
