# IronCampaign Deployment & Ops Runbook (v2.22)

## 1. Installation
- Install Node.js (LTS), Caddy, and SQLite3.
- Deploy the repo to `/opt/ironcampaign`; run `npm install` at the repo root AND in `server/`
  (the root install provides argon2 for the frozen pairing module).
- Create the service user: `useradd --system --home /var/lib/ironcampaign --shell /usr/sbin/nologin ironcampaign`.
- Create data directory: `mkdir -p /var/lib/ironcampaign && chown ironcampaign: /var/lib/ironcampaign`.

## 2. Service Management
- Enable components:
  `systemctl enable --now ironcampaign.service`
  `systemctl enable --now backup.timer`

## 3. Initial Setup & Pairing
1. **Bootstrap the owner key** (printed ONCE — store it in a password manager):
   `cd /opt/ironcampaign/server && node scripts/create-owner.mjs`
2. **Open the owner console** at `https://your-domain.com/owner`, paste the owner key, and
   create a pairing phrase (10-minute, single-use; shown as text + QR).
3. **Pair the device**: in the app's Settings sheet, type the phrase or scan the QR — the app
   redeems it via `POST /api/v1/sync/pair` and stores its device token in the Keychain.

## 4. Backups & Recovery
- **Automatic**: Nightly backups are stored in `/var/lib/ironcampaign/backups`.
- **Recovery**: the `.db` file contains all state. Stop the service, then:
  `gunzip -c backup_<stamp>.db.gz > /var/lib/ironcampaign/ironcampaign.db`
  `rm -f /var/lib/ironcampaign/ironcampaign.db-wal /var/lib/ironcampaign/ironcampaign.db-shm`
  and restart. Backups are NOT encrypted — the backup directory needs the same protection as the DB.
- **Warning**: guard the `.db` file; it is the entire database of every profile on the node.

## 5. Key Rotation & Security
- Rotate an owner key by re-running `node scripts/create-owner.mjs <profileUuid>` — the old key
  stops working immediately (the console has no rotate button).
- Revoke compromised device tokens via the Owner Console.
- Caddy handles automatic TLS for the domain configured in `Caddyfile`.
