#!/usr/bin/env bash
#
# Deploy the Theat.R booking app on a Hostinger VPS (or any Linux box).
#
# First-time setup:
#   1. Provision a VPS, point your DNS A-record at it.
#   2. sudo apt update && sudo apt install -y curl git nginx ufw
#   3. Install Node 20 LTS:
#        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
#        sudo apt install -y nodejs build-essential
#   4. Install PM2 globally: sudo npm i -g pm2
#   5. Clone this repo to /var/www/theatre (or wherever), cd in.
#   6. cp .env.example .env && nano .env           # fill in secrets
#   7. Run: ./deploy/deploy.sh first-run
#   8. Configure Nginx (deploy/nginx.conf.example) and Certbot — see DEPLOY.md.
#
# Subsequent deploys (after git pull):
#   ./deploy/deploy.sh
#
# Exit non-zero on any failure so CI / scripting can detect it.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

MODE="${1:-update}"

echo "▶ Deploy from: $APP_DIR  (mode: $MODE)"

# Sanity checks
command -v node >/dev/null 2>&1 || { echo "✗ node not found — install Node 20 LTS first"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found";  exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "✗ pm2 not found — run: sudo npm i -g pm2"; exit 1; }

[ -f .env ] || { echo "✗ .env is missing. Copy from .env.example and fill it in."; exit 1; }

# Pull latest code (if it's a git clone). Harmless otherwise.
if [ -d .git ] && [ "${SKIP_GIT:-0}" != "1" ]; then
    echo "▶ git pull"
    git pull --ff-only
fi

# Install only production deps. --omit=dev avoids pulling the test stuff.
echo "▶ npm ci"
npm ci --omit=dev

# Make sure the log dir exists (PM2 ecosystem.config.js writes here).
mkdir -p logs

# First run vs. update
if [ "$MODE" = "first-run" ]; then
    echo "▶ pm2 start ecosystem.config.js --env production"
    pm2 start ecosystem.config.js --env production
    pm2 save
    echo
    echo "⚠  Enable auto-start on boot with:   sudo env PATH=\$PATH:/usr/bin pm2 startup systemd -u \$USER --hp \$HOME"
    echo "   (pm2 prints the exact sudo command; run it, then 'pm2 save' again.)"
else
    if pm2 describe theatre >/dev/null 2>&1; then
        echo "▶ pm2 reload theatre"
        pm2 reload theatre --update-env
    else
        echo "▶ pm2 start ecosystem.config.js --env production"
        pm2 start ecosystem.config.js --env production
        pm2 save
    fi
fi

# Quick health check (the app writes a log line when it binds).
echo
sleep 1
pm2 status theatre
echo
echo "Tail logs with:   pm2 logs theatre"
echo "Done."
