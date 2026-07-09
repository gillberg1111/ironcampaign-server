#!/bin/bash
set -euo pipefail

# WAL-safe online backup of the IronCampaign SQLite database.
# NOTE: sqlite3's .backup writes to a FILE argument — it cannot stream to stdout.
# We back up to a temp file, then gzip it. The output is a binary DB image (.db.gz), not SQL.

DB="${DB_PATH:-/var/lib/ironcampaign/ironcampaign.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/ironcampaign/backups}"
DATE=$(date +%Y-%m-%d_%H%M%S)
TMP="$BACKUP_DIR/.inprogress_$DATE.db"
OUT="$BACKUP_DIR/backup_$DATE.db.gz"

mkdir -p "$BACKUP_DIR"

sqlite3 "$DB" ".backup '$TMP'"
gzip -c "$TMP" > "$OUT"
rm -f "$TMP"

# Rotate: keep 14 days
find "$BACKUP_DIR" -name "backup_*.db.gz" -mtime +14 -delete

echo "backup written: $OUT"

# Restore (with the service STOPPED):
#   gunzip -c backup_YYYY-MM-DD_HHMMSS.db.gz > /var/lib/ironcampaign/ironcampaign.db
#   rm -f /var/lib/ironcampaign/ironcampaign.db-wal /var/lib/ironcampaign/ironcampaign.db-shm
#   systemctl start ironcampaign
