# Deploy to Hostinger — `rmithanoitheatre.shop`

This guide has **two paths**. Pick the one that matches the plan you bought:

| Path | Use when… | What manages Node |
|---|---|---|
| **A. Hostinger shared Node.js hosting** *(your current plan)* | You have **hPanel** with a **Node.js** card in the screenshot you shared. 50 GB disk, 3 GB RAM, 2 CPU, FTP credentials, IP `46.202.138.141`. | Phusion Passenger / LiteSpeed (managed for you) |
| **B. Hostinger VPS** | You SSH in as root and install everything yourself. | You run Nginx + PM2 + Certbot |

Path A is simpler — no SSH, no Nginx, no PM2, no Certbot. Hostinger handles all of that for you. Path B gives you more control; instructions are at the bottom of this file.

---

# Path A: Hostinger shared Node.js hosting (hPanel)

**Your setup (from the plan screenshot):**

```
Website:       https://rmithanoitheatre.shop
IP:            46.202.138.141
FTP host:      ftp://rmithanoitheatre.shop   (or ftp://46.202.138.141)
FTP user:      u960951907
Upload path:   public_html
Node versions: 24.x / 22.x / 20.x / 18.x   (we use ≥20)
```

## A-1. Upload the code

You have two good options. **Git is faster** if you have SSH access; otherwise use **FTP**.

### Option 1 — Git clone from hPanel's terminal (preferred if available)

Some Hostinger plans include a browser-based terminal under **Advanced → Terminal**. If yours does:

```bash
cd ~/domains/rmithanoitheatre.shop   # or wherever your site root is
rm -rf public_html && mkdir public_html && cd public_html
git clone https://github.com/HungLeeRMIT/June.git .
```

### Option 2 — FTP upload

Use FileZilla, Cyberduck, or the hPanel **File Manager**.

- **Host:** `ftp://rmithanoitheatre.shop`
- **User:** `u960951907`
- **Password:** set it from hPanel → **Advanced → FTP Accounts**
- **Remote folder:** `public_html/`

Upload **everything except** `node_modules/`, `.git/`, `.env`, and `*.db*`. If you don't want to think about it, upload this exact list:

```
.env.example       package.json        package-lock.json
server.js          club.html           admin.html
automatic_mail.md  payment.jpeg
594cfb0d-13b3-429b-a65f-7c0d48b75335.jpeg
ecosystem.config.js   (harmless on shared hosting; ignored there)
README.md             DEPLOY.md
deploy/               (whole folder)
```

## A-2. Create the Node.js app in hPanel

1. Open hPanel → pick **rmithanoitheatre.shop** → **Advanced → Node.js**.
2. Click **Create application** and fill in:

| Field                         | Value                               |
|-------------------------------|-------------------------------------|
| Application mode              | **Production**                      |
| Node.js version               | **20.x** or **22.x**                |
| Application root              | `public_html` (the folder you uploaded to) |
| Application URL               | `rmithanoitheatre.shop` (+ `www` alias)    |
| Application startup file      | `server.js`                         |

3. Click **Create**, then on the app's page click **Run NPM Install**. This builds `better-sqlite3` natively on the server — it takes ~60 s.

## A-3. Set environment variables

On the same Node.js app page, use the **Environment variables** editor and add:

| Name               | Value                                                       |
|--------------------|-------------------------------------------------------------|
| `NODE_ENV`         | `production`                                                |
| `BIND_HOST`        | *(leave empty)* — Passenger assigns this                    |
| `TRUST_PROXY`      | `1`                                                         |
| `SECURE_COOKIES`   | `true`                                                      |
| `GMAIL_USER`       | `rmithanoitheatrclub@gmail.com`                             |
| `GMAIL_APP_PASSWORD` | *the 16-char Google App Password*                        |
| `MAIL_FROM_NAME`   | `Theat.R - RMIT Hanoi Musical Theatre Club`                 |
| `ADMIN_USERNAME`   | `admin`                                                     |
| `ADMIN_PASSWORD`   | *a strong password — generate with `openssl rand -base64 24`* |

Do **not** set `PORT` — Hostinger fills it in.

> **Tip:** Hostinger also reads these from a `.env` file in the app root, but the hPanel editor is safer because it never gets overwritten by an FTP upload.

## A-4. Start (or restart) the app

Click **Start application**. The status dot should turn green.

Open the **Logs** tab — you should see:

```
🎭  Theat.R booking server running → http://localhost:<port>
    Env:         production
    Binding:     (auto):<port>   trust proxy: 1
    Secure cookies: on
    Mail:        enabled as rmithanoitheatrclub@gmail.com
    Admin:       enabled (user "admin")
```

Then hit `https://rmithanoitheatre.shop` in a browser.

## A-5. Point the domain at your hosting (DNS)

Your screenshot shows the current nameservers are `nova.dns-parking.com` / `cosmos.dns-parking.com` — those are Hostinger's, so DNS is already managed there. You just need the `A` records:

1. hPanel → **Domains → rmithanoitheatre.shop → DNS Zone Editor**.
2. Delete any existing `@` and `www` A/AAAA/CNAME records that point to a parking page.
3. Add:

| Type | Name | Value              | TTL |
|------|------|--------------------|-----|
| A    | `@`  | `46.202.138.141`   | 300 |
| A    | `www`| `46.202.138.141`   | 300 |

Verify:

```bash
dig rmithanoitheatre.shop +short        # should print 46.202.138.141
dig www.rmithanoitheatre.shop +short    # same
```

DNS propagation is usually under a minute inside Hostinger's own zone. Give it 5–10 minutes if you had a previous CNAME.

## A-6. Enable HTTPS

hPanel → **SSL** → enable **Free SSL (Let's Encrypt)** for both `rmithanoitheatre.shop` and `www.rmithanoitheatre.shop`. One click each. Certs auto-renew.

Hostinger will also enable HTTP→HTTPS redirect automatically. Confirm:

```bash
curl -I http://rmithanoitheatre.shop/    # → 301 redirect to https://
curl -I https://rmithanoitheatre.shop/   # → 200 OK
```

Open `https://rmithanoitheatre.shop` → booking page.
Open `https://rmithanoitheatre.shop/admin` → admin login.

## A-7. Point Gmail at a proper App Password

Admin emails go through Gmail SMTP. Because we never store your password:

1. Enable 2-Step Verification on `rmithanoitheatrclub@gmail.com` (https://myaccount.google.com/security).
2. Create an App Password for "Mail" at https://myaccount.google.com/apppasswords.
3. Paste the 16-char password into the `GMAIL_APP_PASSWORD` env var in hPanel.
4. **Restart application** from the Node.js panel so the new value is picked up.

If you're iterating locally and don't want real emails, set `DISABLE_EMAIL=true`.

## A-8. Backups

On shared hosting, Hostinger keeps their own backups of your account (see **Files → Backups**). If you want an extra safety net specifically for the booking DB, add a cron job:

hPanel → **Advanced → Cron Jobs**. Command:

```
0 3 * * *  /bin/bash /home/u960951907/domains/rmithanoitheatre.shop/public_html/deploy/backup.sh
```

(Adjust the absolute path to your actual account home — hPanel's File Manager shows it at the top of any folder.)

## A-9. Updating the site later

Pushed new code to GitHub and want it live?

- **Git terminal:** `cd public_html && git pull && <click "Run NPM Install" if package.json changed> && <click "Restart application">`
- **FTP:** Upload changed files, then in hPanel click **Restart application**.

Restart is required for `server.js` changes. Static files (`club.html`, `admin.html`) are reloaded by the browser on next request — no restart needed.

> **Where is the booking DB?** In production the server stores `theatre.db`
> **outside** `public_html`, at `~/domains/rmithanoitheatre.shop/theatre-data/theatre.db`,
> so FTP overwrites and re-clones cannot delete it. The first time you run
> the upgraded server it will automatically copy any pre-existing
> `public_html/theatre.db` (and `-wal`/`-shm` sidecars) into the new
> location — check the **Logs** tab for a `[db] migrated legacy DB …` line.
> To pin the DB to an explicit path instead, set `DB_PATH` in the env-var
> editor.

## A-10. Troubleshooting (Path A specifics)

| Symptom | Fix |
|---|---|
| `npm install` fails on `better-sqlite3` | Make sure the Node version is **20 or 22**. Delete `node_modules/` and re-run **Run NPM Install**. If it still fails, open a Hostinger support ticket — they have Python/toolchain on the shared box by default but occasionally it's missing. |
| App status: "Running" but `/` returns 502 / app didn't start | Check **Logs** tab. Most common causes: bad `GMAIL_APP_PASSWORD` (not fatal — only logged), missing file permissions on `theatre.db`, or `BIND_HOST` set to `127.0.0.1` (delete that env var — Passenger wants it empty). |
| Admin cookie set but login doesn't stick | You're on HTTP instead of HTTPS. Enable Let's Encrypt (A-6) or set `SECURE_COOKIES=false` while debugging. |
| Bookings email never arrives | Gmail rejects non-App-Password logins. 2FA + 16-char App Password is mandatory. Check Logs tab for `[mail] failed:` lines. |
| SQLite `disk I/O error` on first boot | The app can't write `theatre.db` in the app root. In File Manager, set `public_html` folder permissions to `755` and make sure the Node user owns it (Hostinger usually does this automatically). |

---

# Path B: Hostinger VPS

Use this if you actually have a VPS plan with SSH/root (KVM 1+). You bring Nginx, PM2 and Certbot yourself; the deploy/*.sh scripts automate the repetitive parts.

## B-1. Point DNS at your VPS

In hPanel → **Domains → rmithanoitheatre.shop → DNS Zone Editor**:

| Type | Name  | Points to           | TTL |
|------|-------|---------------------|-----|
| A    | `@`   | `<your VPS IPv4>`   | 300 |
| A    | `www` | `<your VPS IPv4>`   | 300 |

```bash
dig rmithanoitheatre.shop +short
dig www.rmithanoitheatre.shop +short
```

Wait for both to return the VPS IP before continuing.

## B-2. One-time VPS setup

```bash
ssh root@<ip>
adduser theatre && usermod -aG sudo theatre
rsync --archive --chown=theatre:theatre ~/.ssh /home/theatre
su - theatre

sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw sqlite3 build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## B-3. Clone & configure

```bash
sudo mkdir -p /var/www && sudo chown theatre:theatre /var/www
cd /var/www
git clone https://github.com/HungLeeRMIT/June.git theatre
cd theatre
cp .env.example .env
nano .env          # fill in GMAIL_APP_PASSWORD, ADMIN_PASSWORD; keep BIND_HOST=127.0.0.1
chmod 600 .env
```

## B-4. Launch under PM2

```bash
./deploy/deploy.sh first-run
pm2 status theatre
pm2 logs theatre --lines 30
curl -I http://127.0.0.1:3000/           # → 200 OK
```

Enable auto-start on reboot (PM2 prints the sudo line — run it):

```bash
pm2 startup systemd -u $USER --hp $HOME
pm2 save
```

## B-5. Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/theatre
sudo ln -sf /etc/nginx/sites-available/theatre /etc/nginx/sites-enabled/theatre
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx \
    -d rmithanoitheatre.shop \
    -d www.rmithanoitheatre.shop \
    --agree-tos --email you@example.com --redirect --non-interactive

sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

## B-6. Nightly backup

```bash
crontab -e
# add:
0 3 * * *  /var/www/theatre/deploy/backup.sh >> /var/www/theatre/logs/backup.log 2>&1
```

## B-7. Subsequent deploys

```bash
cd /var/www/theatre
./deploy/deploy.sh       # git pull + npm ci + pm2 reload (zero-downtime)
```

## B-8. VPS troubleshooting

| Symptom | Fix |
|---|---|
| `502 Bad Gateway` | `pm2 status theatre`; if offline `pm2 logs theatre`. Also `sudo systemctl status nginx`. |
| Admin cookie doesn't stick | Make sure you're on HTTPS. `SECURE_COOKIES=false` to debug over plain HTTP. |
| `NXDOMAIN` from Certbot | DNS hasn't propagated yet. Re-run after `dig` returns the VPS IP. |
| `req.ip` always `::ffff:127.0.0.1` | `TRUST_PROXY=1` (Nginx on same host), `=2` (Cloudflare → Nginx). |
| `better-sqlite3` build fails | `sudo apt install -y build-essential python3`, then `rm -rf node_modules && npm ci --omit=dev`. |
| Gmail rejects mail | 16-char **App Password** required. Enable 2FA first. |
| `www` resolves but apex doesn't | Missing `@` A-record. Add it in hPanel DNS, retry certbot. |
