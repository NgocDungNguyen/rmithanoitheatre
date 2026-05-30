# RMIT Hanoi Musical Theatre Club — Seat Booking

Static landing page + seat‑map booking flow (`club.html`) wired to a small Node.js / Express backend that stores bookings in SQLite and emails confirmations from `rmithanoitheatrclub@gmail.com`.

> **Deploying to production?** See [`DEPLOY.md`](./DEPLOY.md) for the full Hostinger (VPS) walkthrough — Nginx, TLS, PM2, and nightly backups.

## What's included

| File | Purpose |
|---|---|
| `club.html`             | Front‑end (Tailwind CDN). Self‑contained, served by the backend. |
| `server.js`             | Express API: seat availability, atomic booking, Gmail auto‑mail. |
| `package.json`          | Node dependencies (`express`, `better-sqlite3`, `nodemailer`, `dotenv`). |
| `.env.example`          | Template for secrets (copy → `.env`). |
| `theatre.db`            | SQLite file (auto‑created on first run). |
| `payment.jpeg`          | Bank‑transfer QR image attached to every confirmation email. |
| `DEPLOY.md`             | Step-by-step Hostinger VPS deployment (Nginx + PM2 + Certbot). |
| `deploy/deploy.sh`      | One-shot deploy script (`git pull && npm ci && pm2 reload`). |
| `deploy/backup.sh`      | Nightly SQLite backup (online-safe, gzipped, 14-day rolling). |
| `deploy/nginx.conf.example` | Nginx vhost template. |
| `ecosystem.config.js`   | PM2 process definition. |

## 1. Prerequisites

- Node.js **18+** (`node -v` to check)
- A Google **App Password** for `rmithanoitheatrclub@gmail.com`
  - Enable 2‑Step Verification → https://myaccount.google.com/security
  - Create an app password → https://myaccount.google.com/apppasswords
  - You'll get a 16‑character password — paste it into `.env`

## 2. Install & configure

```bash
cd /Users/hunle/June
npm install
cp .env.example .env
# then edit .env and set GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
```

## 3. Run

```bash
npm start
# 🎭  Theat.R booking server running → http://localhost:3000
```

Open `http://localhost:3000` — the seat map renders exactly as in the reference image. Guests can pick seats, fill the registration form and confirm. A bilingual confirmation e‑mail is sent automatically with the bank‑transfer screenshot attached.

## 4. How concurrency is handled

Two guests booking the **same seat** at the **same moment** cannot both succeed:

- Every booking is executed inside a single SQLite transaction.
- Each seat id (e.g. `F1-D-14`) is a `PRIMARY KEY` in `booked_seats`.
- If any seat in the request is already present, SQLite throws `SQLITE_CONSTRAINT_PRIMARYKEY` and the entire transaction is **rolled back atomically** — no partial writes.
- The API responds `409 Conflict` with the list of conflicting seat ids.
- The client greys those seats out immediately and asks the guest to re‑pick.
- The client also polls `/api/seats` every 15 s so browsers stay in sync.

This gives the strongest possible guarantee with zero external dependencies (no Redis, no locking service): at most one booking per seat, forever.

## 5. API reference

### Public

| Method | Path           | Description |
|--------|----------------|-------------|
| GET    | `/api/seats`    | `{ sold: ["F1-D-14", ...] }` — currently booked seat ids. |
| GET    | `/api/pricing`  | Authoritative price map + discount percentage. |
| POST   | `/api/book`     | Atomic booking. Body: `{ name, email, phone, sid?, referralCode?, seats: ["F1-..."] }`. |
| GET    | `/api/health`   | `{ ok: true, bookedSeats: N }`. |

### Admin (`/admin` — requires login)

Set `ADMIN_PASSWORD` in `.env` and visit `http://localhost:3000/admin`. Optional `ADMIN_USERNAME` (defaults to `admin`). Sessions live 8 h in an HTTP‑only cookie; login is throttled to 10 attempts / 10 min / IP.

| Method | Path                                   | Description |
|--------|----------------------------------------|-------------|
| GET    | `/admin`                               | Admin dashboard HTML (login, bookings, seat map). |
| GET    | `/api/admin/me`                        | `{ authenticated, username }`. |
| POST   | `/api/admin/login`                     | Body: `{ username, password }`. Sets `admin_session` cookie. |
| POST   | `/api/admin/logout`                    | Clears session. |
| GET    | `/api/admin/bookings`                  | Guest bookings only (admin locks filtered out) + stats (`totalBookings`, `totalSeats`, `totalRevenue`, `byTier`). |
| GET    | `/api/admin/map`                       | Every booked / locked seat with full metadata: `{ status: 'booked'\|'locked', bookingId, guestName, paid, tier, ... }`. |
| POST   | `/api/admin/bookings/:id/paid`         | Body: `{ paid: true \| false }` (default `true`). Flips the paid flag. |
| DELETE | `/api/admin/bookings/:id`              | Cancel an entire booking (all seats freed). |
| POST   | `/api/admin/seats/:seatId/lock`        | Admin‑lock a seat so no guest can book it. Returns 409 if already booked/locked. VIP seats can't be locked. |
| DELETE | `/api/admin/seats/:seatId`             | Cancel a single seat or **unlock** an admin lock (same endpoint handles both — admin locks are internally one‑seat "bookings" with `kind='admin_lock'`). Recomputes `seat_count`/`subtotal`/`total` preserving discount %, or removes the parent booking if that was its last seat. |

#### UI features

- **Stats cards** — bookings, seats sold, revenue, per‑tier breakdown (now using larger, more legible tier pills).
- **Bookings tab** — searchable table (name, email, phone, seat id). Per‑row **Mark as Paid** button disappears once the booking is marked paid (status becomes a green badge). Filter pills to show *All / Paid / Unpaid*. Per‑seat `×` to release individual seats.
- **Seat Map tab** — live map of the venue. Click any seat:
  - *available* → pops a menu to **Lock** the seat (prevents guests from booking it, e.g. for staff hold or technical reservation)
  - *locked by admin* → **Unlock** (returns it to the pool)
  - *booked* → shows guest name, booking id, paid status, with **Release seat** and **View in list** buttons
- Colour coding on the map: tier colour = available · dark red = booked+paid · amber = booked+unpaid · diagonal black stripes = admin lock · red wine = VIP (always unavailable).
- Both tabs auto‑refresh the seat map every 10 s so multiple admins stay in sync.

#### Concurrency (admin locks)

Admin locks use the same atomic‑booking path as guest bookings: a single SQLite transaction inserts a row with a synthetic `kind='admin_lock'` booking into `bookings`, plus one row into `booked_seats`. The `seat_id` primary key on `booked_seats` guarantees that a guest cannot book a seat while an admin is locking it — whichever transaction commits first wins; the loser gets `409 Conflict`. Verified by `npm run test:admin` (45 assertions across auth, CRUD, concurrency-with-lock, paid toggle, and public-facing visibility).

`POST /api/book` returns:

- `200 { ok: true, bookingId, subtotal, discount, total, seats }` on success
- `400` for validation errors (bad email, unknown seat, VIP attempt, > 20 seats)
- `409 { conflicts: [...] }` if any seat was just booked by someone else

## 6. Pricing & discount

| Tier       | Price (VND) |
|------------|------------:|
| The Stars  | 300,000 |
| The Artists| 250,000 |
| The Dreamers| 180,000 |
| VIP        | n/a (guests only — not selectable) |

Users who fill either the **sID** field or a **referral code** automatically receive a **5%** discount on the subtotal (calculated server‑side — clients cannot forge it).

## 7. Seat map spec

| Floor | Row(s)     | Tier      | Layout                               |
|:-----:|------------|-----------|--------------------------------------|
| 1     | A, B, C    | VIP       | 12 + 12 (numbered 24‑13 · 12‑1)      |
| 1     | D, E, F    | Stars     | 13 + 13 (numbered 26‑14 · 13‑1)      |
| 1     | G, H, J    | Stars     | 13 + 13 (numbered 26‑14 · 13‑1)      |
| 1     | K, L, M    | Artists   | 14 + 14 (numbered 28‑15 · 14‑1)      |
| 1     | N          | Artists   | 24 seats in a single strip (24‑1)    |
| 2     | A, B, C    | Artists   | 15 + 15 (numbered 30‑16 · 15‑1)      |
| 2     | D          | Dreamers  | 12 + 12 (numbered 24‑13 · 12‑1)      |
| 2     | E          | Dreamers  | 24 seats in a single strip (24‑1)    |

Internal seat id format: `F{floor}-{row}-{num}` (e.g. `F2-D-5`).

## 8. Resetting the booking database

```bash
rm theatre.db theatre.db-wal theatre.db-shm  # removes all bookings
```

The schema is re‑created on next server start.

## 9. Troubleshooting

- **Email not sending** → check server log; make sure `GMAIL_APP_PASSWORD` is the 16‑char app password (not your Google password), and 2FA is enabled. Set `DISABLE_EMAIL=true` for local dev.
- **`better-sqlite3` install fails** → needs a C++ toolchain. On macOS: `xcode-select --install`.
- **Port 3000 in use** → set `PORT=4000` (or similar) in `.env`.
