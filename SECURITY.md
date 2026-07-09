# IronCampaign — Security Model

Audited systematically at v2.26.1 (beyond the per-change review that runs on every delivery).

## Threat model
Self-hosted, single-owner sync node. The server is the **user's own infrastructure** — the
developer never holds user data. Trust boundaries, strongest first:

1. **Internet → node:** TLS + rate limiting via Caddy (deploy kit); `POST /sync/pair` additionally
   rate-limited in-module (per-IP, defense-in-depth). Pairing phrases: 8 words / 2048-word list
   (88 bits), argon2id at rest, 10-minute TTL, single use.
2. **Device → node:** 256-bit bearer tokens, SHA-256 at rest, digest-indexed lookup (no usable
   timing side channel). `profileUuid` derives ONLY from the token row — enforced by tests (IDOR
   suites at both the sync and owner layers). Owner key: same construction, rotatable via CLI.
3. **Node → device (pull):** identifiers bounded + SQL fully parameterized (`safeIdent` +
   placeholders); unknown columns skipped at the device store. **Accepted risk:** a *compromised
   own-node* can still write valid in-registry game data to paired devices — it cannot execute
   code, exfiltrate the Keychain token (never sent back), or touch other profiles.
4. **Watch → phone:** WatchConnectivity only; the watch holds zero credentials.

## Enforced invariants (CI-gated where possible)
- No secrets in logs: grep gate over `server/src` (code near `log`, comments excluded); the opt-in
  request logger emits exactly `METHOD PATH STATUS MS` and uses `req.path` (query strings never
  logged). Owner console keeps the key in-tab only.
- Payload bounds: 1MB JSON body cap; 500-change push batch cap (413 above).
- `trust proxy = 'loopback'` — X-Forwarded-For is honored only from the same-host proxy.
- No CORS middleware: the app is native; the console is same-origin.
- Owner console: no external origins (CI-tested grep), vendored QR encoder (functionally verified
  via CoreImage decode), all dynamic HTML escaped.
- Backups: AES-256-GCM, PBKDF2 ≥600k, header-as-AAD, no wrong-passphrase/corrupt oracle,
  fresh salt+nonce per export (tamper/oracle behavior under test). Plain exports carry an explicit
  unencrypted warning. Server-side `.db` + backup dir permissions documented in the runbook.
- Supply chain: npm `0 vulnerabilities` at audit time; lockfiles committed; GRDB pinned
  `exactVersion` (no floating updates); QR encoder vendored, not fetched.
- iOS: ATS default (plain HTTP blocked except local networking for dev); tokens in Keychain;
  HealthKit write-only (`read: []`); privacy manifest declares no collection (self-hosted rationale
  cited in CHANGELOG 2.26.0).

## Known accepted risks / non-goals
- A user's compromised node can corrupt that user's own game data on paired devices (see above).
- No owner-key MFA / account system — the owner key is a bearer credential; guard it like one.
- `deviceId` in sync payloads is data, not identity (documented in the code; never authorizes).
- Rate limiting at internet scale is Caddy's job; the in-module limiter is a backstop only.

## Re-audit triggers
New endpoint or table; any change to `questlog-critical/`; a new third-party dependency; enabling
any cross-origin client; declaring HealthKit read types.
