<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="server/public/ironcampaign-mark-cream.svg">
    <img src="server/public/favicon.svg" alt="The Standing Bar — IronCampaign mark" width="72">
  </picture>
</p>

# IronCampaign Sync Node

Self-hosted sync server for **IronCampaign**, a strength-training field guide for iOS.
Your training data lives on **your** machine — the app pairs to this node; no third party ever
holds your log.

## Quick start (Docker)

```bash
docker compose up -d --build
docker compose logs ironcampaign    # setup code, printed each boot until the node is claimed
# open http://127.0.0.1:3000/owner → setup code + username + password → pairing phrase (text + QR)
```

The port is bound to localhost. To create the account from the shell instead of the claim screen:

```bash
docker compose exec ironcampaign node server/scripts/create-owner.mjs <username> <password>
```

Bare-metal, TLS (Caddy), systemd units, and nightly WAL-safe backups: see [`deploy/README.md`](deploy/README.md).
Security model and threat boundaries: [`SECURITY.md`](SECURITY.md).

## What's in here

- `server/` — Node (ESM) sync + combat API: Express, better-sqlite3, per-profile scoping,
  device pairing (8-word phrases, argon2id at rest), owner console with client-side QR.
- `questlog-critical/` — the load-bearing sync core: a Hybrid Logical Clock and a per-field
  CRDT-style merge engine (last-write-wins + append-only union + tombstones), shared test vectors.
  These files are interface-frozen; the iOS client ships byte-compatible Swift implementations
  verified against the same vectors.
- `deploy/` — Caddyfile, systemd units, backup tooling, runbook.

## Sync protocol (for alternative clients)

`POST /api/v1/sync/pair` (phrase → 256-bit device token) ·
`POST /api/v1/sync/push` (HLC-stamped field changes, ≤500/batch) ·
`POST /api/v1/sync/changes` (cursor pull; optional `deviceId` echo suppression — `lastSeq` always
reflects the scanned window) · `GET /api/v1/sync/status`. Owner API under `/api/v1/owner/*`.
The merge semantics are exactly `questlog-critical/hlc-merge/merge.js`, fixtures in
`test-vectors.json`.

### Push: per-change rejection

`POST /api/v1/sync/push` returns **200** for any array of at most 500 changes. Valid changes are
merged. Invalid ones are not written. The response keeps the fields shipped clients already read,
and adds `rejected`, which those clients ignore:

```json
{
  "applied": 1,
  "ignored": 0,
  "results": [{ "uuid": "…", "field": "name", "decision": "applied" }],
  "rejected": [{ "uuid": "…", "field": "nope", "changeId": null, "reason": "sync: field \"nope\" not mutable on table \"villains\"" }]
}
```

`results[].decision` is only `applied`, `ignored-older`, `ignored-tombstoned`, `appended`,
`append-duplicate`, or `undeleted`. A later app build should quarantine rows listed in `rejected`
(unknown table or field, malformed HLC, append-only column not in the registry, or an HLC more
than 60 seconds ahead of the server) instead of retrying them. A batch larger than 500 is still
**413** and writes nothing. An empty batch is `{ "applied": 0, "ignored": 0, "results": [], "rejected": [] }`.

## Tests

```bash
npm install && cd server && npm install && npm test
```

## The app

The iOS client is a separate (closed-source) app. This server is and stays free software — run
your own node, keep your own data.
