#!/usr/bin/env bash
#
# Daily SQLite backup. Uses the online-backup API (safe while the app is
# running) so no downtime and no WAL corruption.
#
# Install as a cron job:
#   crontab -e
#     0 3 * * *  /var/www/theatre/deploy/backup.sh >> /var/www/theatre/logs/backup.log 2>&1
#
# Keeps the last 14 backups (rolling) in BACKUP_DIR.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${DB_PATH:-$APP_DIR/theatre.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"

[ -f "$DB_PATH" ] || { echo "$(date '+%F %T')  DB not found at $DB_PATH — skipping."; exit 0; }

STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT="$BACKUP_DIR/theatre-$STAMP.db"

# .backup is SQLite's native online-backup; safe with concurrent writes.
sqlite3 "$DB_PATH" ".backup '$OUT'"
gzip -q "$OUT"
echo "$(date '+%F %T')  wrote $(basename "$OUT").gz ($(du -h "$OUT.gz" | cut -f1))"

# Prune old backups
ls -1t "$BACKUP_DIR"/theatre-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
