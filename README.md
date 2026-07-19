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
docker compose exec ironcampaign node server/scripts/create-owner.mjs   # owner key — printed once
# open http://localhost:3000/owner → paste the key → create a pairing phrase (text + QR)
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

## Tests

```bash
npm install && cd server && npm install && npm test
```

## The app

The iOS client is a separate (closed-source) app. This server is and stays free software — run
your own node, keep your own data.
