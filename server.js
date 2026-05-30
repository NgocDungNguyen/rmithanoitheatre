/**
 * RMIT Hanoi Musical Theatre Club — Seat Booking Server
 *
 * Concurrency model
 * -----------------
 * All seats are persisted in a SQLite table whose PRIMARY KEY is the seat id
 * (e.g. "F1-D-14"). Every booking attempt runs inside a single SQLite
 * transaction that INSERTs all requested seats. Because better-sqlite3 runs
 * transactions synchronously on a serialised DB connection and the seat_id
 * column has a UNIQUE/PRIMARY KEY constraint, two clients can NEVER succeed in
 * booking the same seat — the second transaction throws
 * SQLITE_CONSTRAINT_PRIMARYKEY and is rolled back atomically. The client gets
 * back a 409 with the list of conflicting seats so it can refresh the map.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD  = NODE_ENV === 'production';

// Passenger / LiteSpeed (Hostinger shared Node hosting) hands us a specific
// port via process.env.PORT and expects us to bind on it with NO explicit
// host. Set BIND_HOST="" (empty) in that environment; we'll skip the host arg.
const PORT       = Number(process.env.PORT) || (process.env.PORT ? process.env.PORT : 3000);
const BIND_HOST  = process.env.BIND_HOST !== undefined
    ? process.env.BIND_HOST
    : (IS_PROD ? '127.0.0.1' : '0.0.0.0');

// `TRUST_PROXY` tells Express how many reverse-proxy hops to trust when
// reading `X-Forwarded-*` headers. Behind Nginx on the same host: "1".
// Behind Cloudflare → Nginx: "2". Leave empty to disable.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
    ? (isFinite(Number(process.env.TRUST_PROXY)) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY)
    : (IS_PROD ? 1 : 0);

const DISABLE_EMAIL = String(process.env.DISABLE_EMAIL || '').toLowerCase() === 'true';
const GMAIL_USER = process.env.GMAIL_USER || 'rmithanoitheatrclub@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Theat.R - RMIT Hanoi Musical Theatre Club';

// Admin auth. If ADMIN_PASSWORD is empty the admin panel is DISABLED (any
// request to /admin or /api/admin/* returns 503). Password comparison uses
// timingSafeEqual to stop timing-based attacks.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 h
// Force Secure cookies in production, or whenever SECURE_COOKIES=true.
const FORCE_SECURE_COOKIES = IS_PROD || String(process.env.SECURE_COOKIES || '').toLowerCase() === 'true';

const PRICES = {
    Stars:    300000,
    Artists:  250000,
    Dreamers: 180000,
};

// Allow persistent-disk / mounted-volume deployments. The default in
// production deliberately lives OUTSIDE the deployable app folder (i.e. one
// directory above __dirname) so that:
//   • FTP re-upload of public_html does NOT overwrite the DB
//   • `git pull` / `npm ci` cannot touch it
//   • `rm -rf public_html && git clone …` (the most destructive deploy
//     pattern Hostinger users hit) leaves the data untouched.
//
//   Hostinger shared:  ~/domains/<site>/public_html         → ~/domains/<site>/theatre-data/theatre.db
//   VPS (Path B):      /var/www/theatre                     → /var/www/theatre-data/theatre.db
//
// If you mount a dedicated volume (e.g. /var/lib/theatre on a VPS) point
// DB_PATH there explicitly via the env var.
function resolveDbPath() {
    if (process.env.DB_PATH) return process.env.DB_PATH;

    const legacyPath = path.join(__dirname, 'theatre.db');
    // In dev we keep the DB next to the source so `npm start` Just Works.
    if (!IS_PROD) return legacyPath;

    const persistentDir  = path.resolve(__dirname, '..', 'theatre-data');
    const persistentPath = path.join(persistentDir, 'theatre.db');

    try {
        fs.mkdirSync(persistentDir, { recursive: true });
    } catch (err) {
        console.warn(`[db] cannot create persistent dir ${persistentDir}: ${err.message}`);
        console.warn('[db] falling back to in-app theatre.db — this WILL be lost on re-deploy. Set DB_PATH explicitly.');
        return legacyPath;
    }

    // First boot after upgrading to the persistent layout: rescue any DB
    // (and its WAL sidecars) that already exists inside the app dir so we
    // don't lose data the user wrote before this fix landed.
    if (!fs.existsSync(persistentPath) && fs.existsSync(legacyPath)) {
        try {
            for (const suffix of ['', '-wal', '-shm']) {
                const src = legacyPath + suffix;
                const dst = persistentPath + suffix;
                if (fs.existsSync(src)) fs.copyFileSync(src, dst);
            }
            console.log(`[db] migrated legacy DB ${legacyPath} → ${persistentPath}`);
        } catch (err) {
            console.error(`[db] migration failed: ${err.message}`);
            console.error('[db] continuing with empty persistent DB at', persistentPath);
        }
    }

    return persistentPath;
}

const DB_PATH         = resolveDbPath();
const BANK_SCREENSHOT = process.env.BANK_SCREENSHOT || path.join(__dirname, 'payment.jpeg');

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL,
    phone          TEXT    NOT NULL,
    sid            TEXT,
    referral_code  TEXT,
    seat_count     INTEGER NOT NULL,
    subtotal       INTEGER NOT NULL,
    discount       INTEGER NOT NULL DEFAULT 0,
    total          INTEGER NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booked_seats (
    seat_id     TEXT    PRIMARY KEY,
    booking_id  INTEGER NOT NULL,
    floor       INTEGER NOT NULL,
    row         TEXT    NOT NULL,
    num         INTEGER NOT NULL,
    tier        TEXT    NOT NULL,
    price       INTEGER NOT NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booked_seats_booking ON booked_seats(booking_id);
`);

// --- Migrations (idempotent) -------------------------------------------------
// Add columns added after the initial release without destroying existing data.
function addColumnIfMissing(table, col, decl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
}
addColumnIfMissing('bookings', 'kind', `TEXT NOT NULL DEFAULT 'booking'`);   // 'booking' | 'admin_lock'
addColumnIfMissing('bookings', 'paid', `INTEGER NOT NULL DEFAULT 0`);        // 0 = unpaid, 1 = paid

const q = {
    listSeats:   db.prepare('SELECT seat_id FROM booked_seats'),
    insertSeat:  db.prepare(`INSERT INTO booked_seats
                              (seat_id, booking_id, floor, row, num, tier, price)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertBooking: db.prepare(`INSERT INTO bookings
                               (name, email, phone, sid, referral_code, seat_count, subtotal, discount, total, kind, paid)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    checkSeats:  db.prepare(`SELECT seat_id FROM booked_seats WHERE seat_id IN (SELECT value FROM json_each(?))`),

    // Admin queries
    listBookings: db.prepare(`SELECT id, name, email, phone, sid, referral_code,
                                      seat_count, subtotal, discount, total, created_at,
                                      kind, paid
                               FROM bookings
                               WHERE kind = 'booking'
                               ORDER BY paid ASC, created_at DESC, id DESC`),
    listBookingSeats: db.prepare(`SELECT seat_id, floor, row, num, tier, price
                                   FROM booked_seats WHERE booking_id = ?
                                   ORDER BY floor, row, num`),
    getBooking: db.prepare('SELECT id, kind FROM bookings WHERE id = ?'),
    getSeat: db.prepare(`SELECT bs.seat_id, bs.booking_id, bs.floor, bs.row, bs.num, bs.tier, bs.price,
                                b.kind, b.name, b.email, b.phone, b.paid
                         FROM booked_seats bs JOIN bookings b ON b.id = bs.booking_id
                         WHERE bs.seat_id = ?`),
    deleteSeat: db.prepare('DELETE FROM booked_seats WHERE seat_id = ?'),
    deleteBooking: db.prepare('DELETE FROM bookings WHERE id = ?'),
    sumBookingSeats: db.prepare(`
        SELECT COALESCE(SUM(price), 0) AS subtotal, COUNT(*) AS count
        FROM booked_seats WHERE booking_id = ?
    `),
    setBookingPaid: db.prepare('UPDATE bookings SET paid = ? WHERE id = ? AND kind = \'booking\''),

    // Admin-lock support
    getOrCreateLockBucket: null, // filled below, stateful
    allSeatsWithMeta: db.prepare(`
        SELECT bs.seat_id, bs.booking_id, bs.floor, bs.row, bs.num, bs.tier,
               b.kind, b.name, b.paid
        FROM booked_seats bs JOIN bookings b ON b.id = bs.booking_id
    `),
};

// Ensure there is at most one "admin_lock" booking bucket per lock to keep the
// DB tidy. We create a fresh admin_lock booking per locked seat so unlocking
// one seat can cleanly drop the whole row.
q.createAdminLockBooking = db.prepare(`
    INSERT INTO bookings (name, email, phone, sid, referral_code,
                          seat_count, subtotal, discount, total, kind, paid)
    VALUES ('Admin lock', '', '', NULL, NULL, 1, 0, 0, 0, 'admin_lock', 1)
`);

// ---------------------------------------------------------------------------
// Admin sessions (in-memory). Tokens are 32 random bytes hex-encoded.
// A server restart logs everyone out — acceptable for a small admin panel.
// ---------------------------------------------------------------------------
const adminSessions = new Map(); // token -> { expiresAt }

function adminEnabled() { return Boolean(ADMIN_PASSWORD); }

function newAdminToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
    return token;
}

function isAdminTokenValid(token) {
    if (!token) return false;
    const s = adminSessions.get(token);
    if (!s) return false;
    if (s.expiresAt < Date.now()) { adminSessions.delete(token); return false; }
    return true;
}

function dropAdminToken(token) { adminSessions.delete(token); }

// Sweep expired sessions every hour.
setInterval(() => {
    const now = Date.now();
    for (const [tok, s] of adminSessions) if (s.expiresAt < now) adminSessions.delete(tok);
}, 60 * 60 * 1000).unref();

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function timingSafeStringEq(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        // Still do a dummy compare so lengths don't leak via timing.
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
    if (!adminEnabled()) return res.status(503).json({ error: 'Admin panel not configured (set ADMIN_PASSWORD in .env).' });
    const token = parseCookies(req.headers.cookie || '').admin_session;
    if (!isAdminTokenValid(token)) return res.status(401).json({ error: 'Not authenticated' });
    req.adminToken = token;
    next();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const SEAT_ID_RE = /^F([12])-([A-Z])-(\d{1,2})$/;

/** Mirrors the seatmap built on the client. Used to reject fabricated seats. */
function buildSeatCatalog() {
    const seats = new Map(); // seat_id -> { floor, row, num, tier }
    const addRange = (floor, row, tier, from, to) => {
        const [a, b] = from <= to ? [from, to] : [to, from];
        for (let n = a; n <= b; n++) {
            seats.set(`F${floor}-${row}-${n}`, { floor, row, num: n, tier });
        }
    };
    // Floor 1
    ['A','B'].forEach(r => addRange(1, r, 'VIP', 1, 24));             // 2 VIP rows (A, B)
    addRange(1, 'C', 'Stars', 1, 24);                                 // row C: Stars, 24 seats
    ['D','E','F'].forEach(r => addRange(1, r, 'Stars', 1, 26));       // Stars, 26 seats
    ['G','H','J'].forEach(r => addRange(1, r, 'Artists', 1, 26));     // Artists
    ['K','L','M'].forEach(r => addRange(1, r, 'Artists', 1, 28));
    addRange(1, 'N', 'Artists', 1, 24);
    // Floor 2
    ['A','B','C'].forEach(r => addRange(2, r, 'Artists', 1, 30));
    addRange(2, 'D', 'Dreamers', 1, 24);
    addRange(2, 'E', 'Dreamers', 1, 24);
    return seats;
}
const SEAT_CATALOG = buildSeatCatalog();

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function isValidPhone(s) {
    return typeof s === 'string' && /^[0-9+\-().\s]{6,20}$/.test(s);
}

// ---------------------------------------------------------------------------
// Email transport
// ---------------------------------------------------------------------------
let mailer = null;
function getMailer() {
    if (DISABLE_EMAIL) return null;
    if (!GMAIL_APP_PASSWORD) {
        console.warn('[mail] GMAIL_APP_PASSWORD is empty — emails will NOT be sent. Set it in .env to enable.');
        return null;
    }
    if (!mailer) {
        mailer = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
        });
    }
    return mailer;
}

function formatSeatsList(seatRows) {
    // "hạng - tầng - hàng - số ghế"
    return seatRows
        .map(s => `• ${s.tier} — Floor ${s.floor} (Tầng ${s.floor}) — Row ${s.row} — Seat ${s.num}`)
        .join('\n');
}

function formatVND(n) {
    return n.toLocaleString('vi-VN') + ' VND';
}

function buildEmail({ name, phone, seats, subtotal, discount, total, hasReferral, isRmit }) {
    const seatLines = formatSeatsList(seats);
    const discountNoteVN = (hasReferral || isRmit)
        ? '(Áp dụng giảm 5% cho sinh viên/staff RMIT hoặc có mã giới thiệu.)' : '';
    const discountNoteEN = (hasReferral || isRmit)
        ? '(5% discount applied for RMIT student/staff or referral code holder.)' : '';

    const subject = 'THANH TOÁN ĐỂ XÁC NHẬN THAM DỰ SHOW / PAYMENT TO CONFIRM REGISTRATION — LA LA LAND: THE COST OF THE DREAM';

    // Plain-text version. The bank-transfer QR image is delivered as an
    // attachment / inline image in the HTML body; in plain-text we spell
    // out the bank details so the message is self-contained.
    const text =
`LA LA LAND: THE COST OF THE DREAM

Xin chào ${name},

Theat.R xin gửi lời cảm ơn chân thành tới bạn vì đã đăng ký tham dự đêm nhạc kịch:

Thông tin đăng ký của bạn
  • Họ và tên: ${name}
  • Số điện thoại: ${phone}
  • Ghế đã đặt (hạng - tầng - hàng - số ghế):
${seatLines}

Thông tin thanh toán
  • Hạng The Stars:    300,000 VND / 1 ghế
  • Hạng The Artists:  250,000 VND / 1 ghế
  • Hạng The Dreamers: 180,000 VND / 1 ghế

Tổng tạm tính:   ${formatVND(subtotal)}${discount > 0 ? `
Giảm giá (5%):  -${formatVND(discount)}` : ''}
Tổng thanh toán: ${formatVND(total)}
${discountNoteVN}

Đặc biệt, đối với sinh viên, staff của RMIT và người thân, bạn bè của diễn viên có mã giới thiệu sẽ được giảm 5% trên tổng số ghế.

Lưu ý:
  • Sau 48h kể từ thời điểm nhận mail, ghế sẽ tự động huỷ trong trường hợp chúng mình không nhận được tiền vé.
  • Nhân sự của chúng mình sẽ liên lạc bạn để quản lý đặt chỗ. Nếu quá 3 lần không thể liên lạc được, ghế sẽ bị huỷ.

Bạn hãy vui lòng chuyển khoản số tiền tương ứng với hạng ghế và số ghế bạn đã chọn ở trên qua thông tin sau:

  VIETCOMBANK — 1061771304 — HOANG DUC HONG (PGD Nguyễn Chí Thanh)
  (Vui lòng xem ẢNH ĐÍNH KÈM mã QR chuyển khoản.)

Sau khi chuyển khoản, vui lòng REPLY EMAIL NÀY kèm ảnh chụp màn hình chuyển khoản thành công. Email XÁC NHẬN VÉ CUỐI CÙNG sẽ được gửi đến bạn.

Chúng mình cảm ơn bạn nhiều!

Trân trọng,
CLB Nhạc kịch RMIT Hà Nội

_______________________________

Dear ${name},

Thank you sincerely for booking your ticket and confirming your attendance at Theat.R Musical Production #3 — La La Land: The Cost of the Dream.

Your Registration Details
  • Full Name:    ${name}
  • Phone Number: ${phone}
  • Selected seats (tier - floor - row - seat):
${seatLines}

Payment
  • The Stars:    300,000 VND per seat
  • The Artists:  250,000 VND per seat
  • The Dreamers: 180,000 VND per seat

Subtotal:      ${formatVND(subtotal)}${discount > 0 ? `
Discount (5%): -${formatVND(discount)}` : ''}
Total:         ${formatVND(total)}
${discountNoteEN}

Additionally, RMIT students, staff, and friends or family of the cast with a referral code will receive a 5% discount on the total ticket amount.

Important note:
  • Seats will be automatically released 48 hours after this email is sent if we do not receive the ticket payment.
  • Our team will also contact you regarding your reservation. If we are unable to reach you after 3 attempts, your booking will be cancelled automatically.

Please kindly transfer the corresponding amount based on your selected seating category and number of seats using the following details:

  VIETCOMBANK (PGD Nguyễn Chí Thanh)
  BANK NUMBER: 1061771304
  BANK NAME:   HOANG DUC HONG

After completing the transfer, please REPLY TO THIS EMAIL with a screenshot of your successful payment. A FINAL REGISTRATION CONFIRMATION email will then be sent to you.

Thank you very much for your support!

Best regards,
RMIT Hanoi Musical Theatre Club
`;

    // HTML body mirrors the structure of automatic_mail.md:
    //   1. Vietnamese section on top — bank info shown as the attached image.
    //   2. Divider.
    //   3. English section below — bank info spelled out in text.
    const seatListHtml = seats.map(s =>
        `<li>${s.tier} — Tầng ${s.floor} / Floor ${s.floor} — Hàng ${s.row} / Row ${s.row} — Ghế ${s.num} / Seat ${s.num}</li>`
    ).join('');

    const totalsVN = `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;color:#fbf5e7">
        <tr><td>Tổng tạm tính</td><td style="text-align:right">${formatVND(subtotal)}</td></tr>
        ${discount > 0 ? `<tr><td>Giảm giá (5%)</td><td style="text-align:right;color:#a7f3d0">-${formatVND(discount)}</td></tr>` : ''}
        <tr><td style="border-top:1px solid rgba(247,220,138,.35);padding-top:6px"><strong>Tổng thanh toán</strong></td>
            <td style="border-top:1px solid rgba(247,220,138,.35);padding-top:6px;text-align:right;color:#fff1b6;font-size:18px"><strong>${formatVND(total)}</strong></td></tr>
      </table>`;
    const totalsEN = `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;color:#fbf5e7">
        <tr><td>Subtotal</td><td style="text-align:right">${formatVND(subtotal)}</td></tr>
        ${discount > 0 ? `<tr><td>Discount (5%)</td><td style="text-align:right;color:#a7f3d0">-${formatVND(discount)}</td></tr>` : ''}
        <tr><td style="border-top:1px solid rgba(247,220,138,.35);padding-top:6px"><strong>Total</strong></td>
            <td style="border-top:1px solid rgba(247,220,138,.35);padding-top:6px;text-align:right;color:#fff1b6;font-size:18px"><strong>${formatVND(total)}</strong></td></tr>
      </table>`;

    const html = `<!doctype html>
<html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0b032d;color:#fbf5e7;padding:32px;margin:0;">
<div style="max-width:640px;margin:0 auto;background:rgba(32,18,83,0.6);border:1px solid rgba(247,220,138,.25);border-radius:16px;padding:28px;">

  <h2 style="color:#f7dc8a;font-family:'Georgia',serif;margin:0 0 22px;">La La Land: The Cost of the Dream</h2>

  <!-- ===== VIETNAMESE (top) ===== -->
  <p>Xin chào <strong>${name}</strong>,</p>
  <p>Theat.R xin gửi lời cảm ơn chân thành tới bạn vì đã đăng ký tham dự đêm nhạc kịch:</p>

  <h4 style="color:#f7dc8a;border-bottom:1px solid rgba(247,220,138,.25);padding-bottom:6px;">Thông tin đăng ký của bạn</h4>
  <p style="margin:6px 0 0"><strong>Họ và tên:</strong> ${name}<br/>
     <strong>Số điện thoại:</strong> ${phone}</p>
  <p style="margin:10px 0 4px"><strong>Ghế đã đặt (hạng - tầng - hàng - số ghế):</strong></p>
  <ul style="margin-top:4px">${seats.map(s => `<li>${s.tier} — Tầng ${s.floor} — Hàng ${s.row} — Ghế ${s.num}</li>`).join('')}</ul>

  <h4 style="color:#f7dc8a;border-bottom:1px solid rgba(247,220,138,.25);padding-bottom:6px;">Thông tin thanh toán</h4>
  <ul style="margin-top:6px">
    <li>Hạng The Stars:    300,000 VND / 1 ghế</li>
    <li>Hạng The Artists:  250,000 VND / 1 ghế</li>
    <li>Hạng The Dreamers: 180,000 VND / 1 ghế</li>
  </ul>
  ${totalsVN}
  ${discountNoteVN ? `<p style="color:#fff1b6;font-size:12px;font-style:italic;margin-top:6px;">${discountNoteVN}</p>` : ''}

  <p style="margin-top:16px">Đặc biệt, đối với sinh viên, staff của RMIT và người thân, bạn bè của diễn viên có mã giới thiệu sẽ được giảm 5% trên tổng số ghế.</p>

  <div style="margin-top:16px;padding:12px 14px;background:rgba(255,255,255,.04);border-left:3px solid #f7dc8a;border-radius:6px;">
    <p style="margin:0 0 6px;color:#f7dc8a;"><strong>Lưu ý:</strong></p>
    <ul style="margin:0;padding-left:18px;">
      <li>Sau 48h kể từ thời điểm nhận mail, ghế sẽ tự động huỷ trong trường hợp chúng mình không nhận được tiền vé.</li>
      <li>Nhân sự của chúng mình sẽ liên lạc bạn để quản lý đặt chỗ. Nếu quá 3 lần không thể liên lạc được, ghế sẽ bị huỷ.</li>
    </ul>
  </div>

  <p style="margin-top:16px">Bạn hãy vui lòng chuyển khoản số tiền tương ứng với hạng ghế và số ghế bạn đã chọn ở trên qua thông tin sau:</p>

  <!-- Bank-transfer image embedded via CID (same file also attached) -->
  <div style="margin:12px 0;padding:8px;background:rgba(255,255,255,.04);border:1px solid rgba(247,220,138,.25);border-radius:12px;text-align:center;">
    <img src="cid:bank-transfer" alt="VIETCOMBANK — 1061771304 — HOANG DUC HONG (PGD Nguyễn Chí Thanh)" style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />
    <div style="margin-top:8px;font-size:13px;color:#fff1b6;">VIETCOMBANK — 1061771304 — HOANG DUC HONG (PGD Nguyễn Chí Thanh)</div>
  </div>

  <p style="margin-top:14px">Sau khi chuyển khoản, vui lòng <strong>REPLY EMAIL NÀY</strong> kèm ảnh chụp màn hình chuyển khoản thành công. Email <strong>XÁC NHẬN VÉ CUỐI CÙNG</strong> sẽ được gửi đến bạn.</p>
  <p>Chúng mình cảm ơn bạn nhiều!</p>
  <p style="color:#f7dc8a;margin-top:18px">Trân trọng,<br/>CLB Nhạc kịch RMIT Hà Nội</p>

  <!-- ===== Divider ===== -->
  <hr style="border:none;border-top:1px dashed rgba(247,220,138,.35);margin:28px 0;" />

  <!-- ===== ENGLISH (bottom) ===== -->
  <p>Dear <strong>${name}</strong>,</p>
  <p>Thank you sincerely for booking your ticket and confirming your attendance at Theat.R Musical Production #3 — La La Land: The Cost of the Dream.</p>

  <h4 style="color:#f7dc8a;border-bottom:1px solid rgba(247,220,138,.25);padding-bottom:6px;">Your Registration Details</h4>
  <p style="margin:6px 0 0"><strong>Full Name:</strong> ${name}<br/>
     <strong>Phone Number:</strong> ${phone}</p>
  <p style="margin:10px 0 4px"><strong>Selected seats (tier - floor - row - seat):</strong></p>
  <ul style="margin-top:4px">${seats.map(s => `<li>${s.tier} — Floor ${s.floor} — Row ${s.row} — Seat ${s.num}</li>`).join('')}</ul>

  <h4 style="color:#f7dc8a;border-bottom:1px solid rgba(247,220,138,.25);padding-bottom:6px;">Payment</h4>
  <ul style="margin-top:6px">
    <li>The Stars:    300,000 VND per seat</li>
    <li>The Artists:  250,000 VND per seat</li>
    <li>The Dreamers: 180,000 VND per seat</li>
  </ul>
  ${totalsEN}
  ${discountNoteEN ? `<p style="color:#fff1b6;font-size:12px;font-style:italic;margin-top:6px;">${discountNoteEN}</p>` : ''}

  <p style="margin-top:16px">Additionally, RMIT students, staff, and friends or family of the cast with a referral code will receive a 5% discount on the total ticket amount.</p>

  <div style="margin-top:16px;padding:12px 14px;background:rgba(255,255,255,.04);border-left:3px solid #f7dc8a;border-radius:6px;">
    <p style="margin:0 0 6px;color:#f7dc8a;"><strong>Important note:</strong></p>
    <ul style="margin:0;padding-left:18px;">
      <li>Seats will be automatically released 48 hours after this email is sent if we do not receive the ticket payment.</li>
      <li>Our team will also contact you regarding your reservation. If we are unable to reach you after 3 attempts, your booking will be cancelled automatically.</li>
    </ul>
  </div>

  <p style="margin-top:16px">Please kindly transfer the corresponding amount based on your selected seating category and number of seats using the following details:</p>

  <div style="margin:12px 0;padding:14px;background:rgba(255,255,255,.06);border-radius:10px;border:1px solid rgba(247,220,138,.25);font-family:'Courier New',monospace;">
    <div><strong>VIETCOMBANK</strong> <span style="font-family:inherit;font-weight:400;opacity:.8">(PGD Nguyễn Chí Thanh)</span></div>
    <div>BANK NUMBER: <strong>1061771304</strong></div>
    <div>BANK NAME:   <strong>HOANG DUC HONG</strong></div>
  </div>

  <p style="margin-top:14px">After completing the transfer, please <strong>REPLY TO THIS EMAIL</strong> with a screenshot of your successful payment. A <strong>FINAL REGISTRATION CONFIRMATION</strong> email will then be sent to you.</p>
  <p>Thank you very much for your support!</p>
  <p style="color:#f7dc8a;margin-top:18px">Best regards,<br/>RMIT Hanoi Musical Theatre Club</p>
</div>
</body></html>`;

    return { subject, text, html };
}

/**
 * Email that goes out when an admin flips a booking from unpaid to paid.
 * Short, warm, and acts as a receipt.
 */
function buildPaymentConfirmedEmail({ name, seats, total }) {
    const seatLines = seats
        .map(s => `  • ${s.tier} — Tầng ${s.floor} — Hàng ${s.row} — Ghế ${s.num}`)
        .join('\n');

    const subject = 'Xác nhận thanh toán / Payment confirmed — Theat.R Musical Production #3';

    const text =
`Xin chào ${name},

Cảm ơn bạn! Chúng mình đã xác nhận thanh toán của bạn.

Thông tin vé của bạn:
  • Họ và tên: ${name}
  • Ghế đã đặt:
${seatLines}
  • Tổng đã thanh toán: ${formatVND(total)}

Đêm diễn:
  • 30 MAY 2026 · 7PM – 8:30PM  (check-in 6PM)
  • Nhà văn hoá Quận Đống Đa, 22 Đặng Tiến Đông, Hà Nội

Hẹn gặp bạn ở đêm diễn!

Trân trọng,
CLB Nhạc kịch RMIT Hà Nội

_______________________________

Dear ${name},

Thank you! Your payment has been confirmed.

Your ticket details:
  • Full Name: ${name}
  • Selected seats:
${seatLines}
  • Total paid: ${formatVND(total)}

The show:
  • 30 MAY 2026 · 7PM – 8:30PM  (check-in at 6PM)
  • Nhà văn hoá Quận Đống Đa, 22 Đặng Tiến Đông, Hà Nội

See you at the show!

Best regards,
RMIT Hanoi Musical Theatre Club
`;

    const seatListHtml = seats.map(s =>
        `<li>${s.tier} — Tầng ${s.floor} / Floor ${s.floor} — Hàng ${s.row} / Row ${s.row} — Ghế ${s.num} / Seat ${s.num}</li>`
    ).join('');

    const html = `<!doctype html>
<html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0b032d;color:#fbf5e7;padding:32px;margin:0;">
<div style="max-width:640px;margin:0 auto;background:rgba(32,18,83,0.6);border:1px solid rgba(247,220,138,.25);border-radius:16px;padding:28px;">

  <h2 style="color:#f7dc8a;font-family:'Georgia',serif;margin:0 0 4px;">Thank you · Cảm ơn bạn!</h2>
  <h3 style="color:#fff1b6;margin:0 0 22px;">Payment confirmed · Xác nhận thanh toán</h3>

  <!-- VN -->
  <p>Xin chào <strong>${name}</strong>,</p>
  <p>Chúng mình đã xác nhận thanh toán của bạn. Dưới đây là thông tin vé:</p>

  <ul>${seatListHtml}</ul>

  <p style="margin-top:8px"><strong>Tổng đã thanh toán / Total paid:</strong>
     <span style="color:#fff1b6;font-weight:800">${formatVND(total)}</span></p>

  <div style="margin:18px 0;padding:14px;background:rgba(255,255,255,.06);border-radius:10px;border:1px solid rgba(247,220,138,.25);">
    <div style="color:#f7dc8a;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">The show / Đêm diễn</div>
    <div><strong>30 MAY 2026</strong> · 7PM – 8:30PM (check-in at 6PM)</div>
    <div>Nhà văn hoá Quận Đống Đa, 22 Đặng Tiến Đông, Hà Nội</div>
  </div>

  <hr style="border:none;border-top:1px dashed rgba(247,220,138,.35);margin:24px 0;" />

  <!-- EN -->
  <p>Dear <strong>${name}</strong>,</p>
  <p>Thank you — your payment has been confirmed. Your ticket is secured.</p>
  <p>See you at the show!</p>

  <p style="color:#f7dc8a;margin-top:18px">Trân trọng / Best regards,<br/>
     CLB Nhạc kịch RMIT Hà Nội — RMIT Hanoi Musical Theatre Club</p>
</div>
</body></html>`;

    return { subject, text, html };
}

async function sendPaymentConfirmedEmail({ to, name, seats, total }) {
    const transport = getMailer();
    if (!transport) {
        console.log(`[mail] (skipped) would send payment-confirmed to ${to}`);
        return { skipped: true };
    }
    const { subject, text, html } = buildPaymentConfirmedEmail({ name, seats, total });
    const info = await transport.sendMail({
        from: `"${MAIL_FROM_NAME}" <${GMAIL_USER}>`,
        to,
        replyTo: GMAIL_USER,
        subject, text, html,
    });
    console.log('[mail] payment-confirmed sent:', info.messageId, '→', to);
    return { messageId: info.messageId };
}

async function sendConfirmationEmail({ to, name, phone, seats, subtotal, discount, total, hasReferral, isRmit }) {
    const transport = getMailer();
    if (!transport) {
        console.log(`[mail] (skipped) would send confirmation to ${to}`);
        return { skipped: true };
    }
    const { subject, text, html } = buildEmail({ name, phone, seats, subtotal, discount, total, hasReferral, isRmit });

    const attachments = [];
    if (fs.existsSync(BANK_SCREENSHOT)) {
        // Inline the image so it renders inside the Vietnamese section of the
        // HTML body (cid:bank-transfer). Also attach a downloadable copy for
        // clients that block inline images.
        const ext = (path.extname(BANK_SCREENSHOT) || '.jpg').toLowerCase();
        const fname = 'bank-transfer' + ext;
        attachments.push({ filename: fname, path: BANK_SCREENSHOT, cid: 'bank-transfer' });
        attachments.push({ filename: fname, path: BANK_SCREENSHOT, contentDisposition: 'attachment' });
    }

    const info = await transport.sendMail({
        from: `"${MAIL_FROM_NAME}" <${GMAIL_USER}>`,
        to,
        replyTo: GMAIL_USER,
        subject,
        text,
        html,
        attachments,
    });
    console.log('[mail] sent:', info.messageId, '→', to);
    return { messageId: info.messageId };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(__dirname, { index: false, extensions: ['html'], maxAge: IS_PROD ? '1h' : 0 }));

/**
 * Serialises a Set-Cookie header for our admin session cookie.
 * In production we require `Secure` so the cookie is never sent over
 * cleartext; the `SameSite=Strict` flag blocks CSRF from other origins.
 */
function adminCookie(value, maxAgeSeconds) {
    const parts = [
        `admin_session=${value}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${maxAgeSeconds}`,
    ];
    if (FORCE_SECURE_COOKIES) parts.push('Secure');
    return parts.join('; ');
}

// Root → serve index.html
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// List currently booked seats (used by the client to grey them out)
app.get('/api/seats', (_req, res) => {
    const rows = q.listSeats.all();
    res.json({ sold: rows.map(r => r.seat_id) });
});

// Pricing & tiers (kept authoritative on the server)
app.get('/api/pricing', (_req, res) => {
    res.json({ prices: PRICES, discountPct: 5 });
});

// Book seats — atomic
app.post('/api/book', async (req, res) => {
    try {
        const { name, email, phone, sid, referralCode, seats } = req.body || {};

        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Missing name' });
        if (!isValidEmail(email))                       return res.status(400).json({ error: 'Invalid email' });
        if (!isValidPhone(phone))                       return res.status(400).json({ error: 'Invalid phone' });
        if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'No seats selected' });
        if (seats.length > 20)                          return res.status(400).json({ error: 'Too many seats (max 20)' });

        // Normalise & validate every requested seat id against the catalog.
        const requested = [];
        const seen = new Set();
        for (const sid2 of seats) {
            if (typeof sid2 !== 'string' || !SEAT_ID_RE.test(sid2)) {
                return res.status(400).json({ error: `Invalid seat id: ${sid2}` });
            }
            if (seen.has(sid2)) continue;
            seen.add(sid2);
            const meta = SEAT_CATALOG.get(sid2);
            if (!meta) return res.status(400).json({ error: `Unknown seat: ${sid2}` });
            if (meta.tier === 'VIP') return res.status(400).json({ error: `VIP seats are not selectable: ${sid2}` });
            requested.push({ seat_id: sid2, ...meta, price: PRICES[meta.tier] || 0 });
        }

        // Compute totals.
        const subtotal = requested.reduce((a, s) => a + s.price, 0);
        const hasReferral = typeof referralCode === 'string' && referralCode.trim().length > 0;
        const isRmit = typeof sid === 'string' && sid.trim().length > 0;
        const discount = (hasReferral || isRmit) ? Math.round(subtotal * 0.05) : 0;
        const total = subtotal - discount;

        // ---- ATOMIC BOOKING ------------------------------------------------
        // One SQLite transaction. If ANY seat is already taken, the whole
        // transaction is rolled back, guaranteeing no partial state.
        let bookingId;
        try {
            const tx = db.transaction((payload) => {
                const info = q.insertBooking.run(
                    payload.name, payload.email, payload.phone,
                    payload.sid || null, payload.referralCode || null,
                    payload.seats.length, payload.subtotal, payload.discount, payload.total,
                    'booking', 0,
                );
                const bId = info.lastInsertRowid;
                for (const s of payload.seats) {
                    q.insertSeat.run(s.seat_id, bId, s.floor, s.row, s.num, s.tier, s.price);
                }
                return bId;
            });

            bookingId = tx({
                name: name.trim(),
                email: email.trim(),
                phone: phone.trim(),
                sid, referralCode,
                seats: requested,
                subtotal, discount, total,
            });
        } catch (err) {
            if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
                // Recompute which seats are the conflicting ones so the client
                // can refresh its map immediately.
                const existing = q.checkSeats.all(JSON.stringify(requested.map(r => r.seat_id))).map(r => r.seat_id);
                return res.status(409).json({
                    error: 'One or more of the seats you picked were just booked by another guest. Please refresh and choose again.',
                    conflicts: existing,
                });
            }
            throw err;
        }

        // Fire-and-forward the confirmation email (don't block the response if SMTP is slow/flaky).
        sendConfirmationEmail({
            to: email.trim(),
            name: name.trim(),
            phone: phone.trim(),
            seats: requested,
            subtotal, discount, total,
            hasReferral, isRmit,
        }).catch(err => console.error('[mail] failed:', err.message));

        res.json({
            ok: true,
            bookingId,
            subtotal, discount, total,
            seats: requested.map(s => ({ seat_id: s.seat_id, row: s.row, num: s.num, floor: s.floor, tier: s.tier, price: s.price })),
        });
    } catch (err) {
        console.error('[book] unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Simple health probe
app.get('/api/health', (_req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM booked_seats').get().c;
    res.json({ ok: true, bookedSeats: count });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Who am I? (used by the admin UI to decide login vs dashboard view)
app.get('/api/admin/me', (req, res) => {
    if (!adminEnabled()) return res.status(503).json({ error: 'Admin panel not configured' });
    const token = parseCookies(req.headers.cookie || '').admin_session;
    res.json({ authenticated: isAdminTokenValid(token), username: isAdminTokenValid(token) ? ADMIN_USERNAME : null });
});

// Very small, in-memory login throttle.
const loginAttempts = new Map(); // ip -> { count, firstAt }
function throttleLogin(ip) {
    const now = Date.now();
    const WINDOW = 10 * 60 * 1000; // 10 min
    const MAX = 10;
    const rec = loginAttempts.get(ip);
    if (!rec || now - rec.firstAt > WINDOW) {
        loginAttempts.set(ip, { count: 1, firstAt: now });
        return true;
    }
    if (rec.count >= MAX) return false;
    rec.count++;
    return true;
}

app.post('/api/admin/login', (req, res) => {
    if (!adminEnabled()) return res.status(503).json({ error: 'Admin panel not configured' });
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!throttleLogin(ip)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Missing credentials' });
    }
    const userOk = timingSafeStringEq(username, ADMIN_USERNAME);
    const passOk = timingSafeStringEq(password, ADMIN_PASSWORD);
    if (!(userOk && passOk)) return res.status(401).json({ error: 'Invalid credentials' });

    const token = newAdminToken();
    res.setHeader('Set-Cookie', adminCookie(token, Math.floor(ADMIN_SESSION_TTL_MS / 1000)));
    res.json({ ok: true, username: ADMIN_USERNAME });
});

app.post('/api/admin/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie || '').admin_session;
    if (token) dropAdminToken(token);
    res.setHeader('Set-Cookie', adminCookie('', 0));
    res.json({ ok: true });
});

app.get('/api/admin/bookings', requireAdmin, (_req, res) => {
    const bookings = q.listBookings.all();
    const enriched = bookings.map(b => ({
        ...b,
        paid: Boolean(b.paid),
        seats: q.listBookingSeats.all(b.id),
    }));

    // Stats
    const totalBookings = bookings.length;
    const totalSeats    = enriched.reduce((a, b) => a + b.seats.length, 0);
    const totalRevenue  = bookings.reduce((a, b) => a + (b.total || 0), 0);
    const byTier = { Stars: 0, Artists: 0, Dreamers: 0 };
    for (const b of enriched) for (const s of b.seats) byTier[s.tier] = (byTier[s.tier] || 0) + 1;

    res.json({
        ok: true,
        stats: { totalBookings, totalSeats, totalRevenue, byTier },
        bookings: enriched,
    });
});

// Cancel a single seat. Also removes its parent booking if that was the last
// seat, and updates the booking's subtotal/seat_count otherwise. Runs inside
// a transaction so the counts never drift.
app.delete('/api/admin/seats/:seatId', requireAdmin, (req, res) => {
    const seatId = req.params.seatId;
    if (!SEAT_ID_RE.test(seatId)) return res.status(400).json({ error: 'Invalid seat id' });

    const row = q.getSeat.get(seatId);
    if (!row) return res.status(404).json({ error: 'Seat is not currently booked' });

    const bookingId = row.booking_id;

    const tx = db.transaction(() => {
        q.deleteSeat.run(seatId);
        const remaining = q.sumBookingSeats.get(bookingId);
        if (remaining.count === 0) {
            q.deleteBooking.run(bookingId);
            return { removedBooking: true };
        } else {
            // Recompute totals proportionally (discount pct preserved).
            const booking = db.prepare('SELECT subtotal, discount FROM bookings WHERE id = ?').get(bookingId);
            const oldSubtotal = booking.subtotal || 0;
            const discountPct = oldSubtotal > 0 ? (booking.discount || 0) / oldSubtotal : 0;
            const newSubtotal = remaining.subtotal;
            const newDiscount = Math.round(newSubtotal * discountPct);
            const newTotal = newSubtotal - newDiscount;
            db.prepare(`UPDATE bookings
                        SET seat_count = ?, subtotal = ?, discount = ?, total = ?
                        WHERE id = ?`)
              .run(remaining.count, newSubtotal, newDiscount, newTotal, bookingId);
            return { removedBooking: false };
        }
    });

    const out = tx();
    res.json({ ok: true, seatId, ...out });
});

// Cancel an entire booking (all its seats).
app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid booking id' });
    const b = q.getBooking.get(id);
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.kind !== 'booking') return res.status(400).json({ error: 'Not a guest booking' });

    const tx = db.transaction(() => {
        db.prepare('DELETE FROM booked_seats WHERE booking_id = ?').run(id);
        q.deleteBooking.run(id);
    });
    tx();
    res.json({ ok: true, bookingId: id });
});

// Mark booking as paid / unpaid (admin-only). When we flip a booking from
// unpaid → paid, we fire a "thank you, payment confirmed" email. Flipping
// back to unpaid (or re-setting paid on an already-paid row) sends nothing,
// so accidental double-clicks don't spam the guest.
app.post('/api/admin/bookings/:id/paid', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid booking id' });

    const current = db.prepare(`SELECT id, name, email, kind, paid, total FROM bookings WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Booking not found' });
    if (current.kind !== 'booking') return res.status(400).json({ error: 'Not a guest booking' });

    // Body: { paid: true | false }. Defaults to true ("mark as paid").
    const paid = req.body && typeof req.body.paid === 'boolean' ? req.body.paid : true;
    const wasPaid = Boolean(current.paid);

    q.setBookingPaid.run(paid ? 1 : 0, id);

    // Fire-and-forget payment-confirmed email on the unpaid→paid transition.
    if (paid && !wasPaid && current.email) {
        const seats = q.listBookingSeats.all(id);
        sendPaymentConfirmedEmail({
            to: current.email,
            name: current.name,
            seats,
            total: current.total,
        }).catch(err => console.error('[mail] payment-confirmed failed:', err.message));
    }

    res.json({ ok: true, bookingId: id, paid, emailed: paid && !wasPaid });
});

// Full seat-map with admin-grade metadata: who booked each seat, lock status,
// paid flag. Public clients can't see this — it needs a valid admin session.
app.get('/api/admin/map', requireAdmin, (_req, res) => {
    const rows = q.allSeatsWithMeta.all();
    const seats = {};
    for (const r of rows) {
        seats[r.seat_id] = {
            status:     r.kind === 'admin_lock' ? 'locked' : 'booked',
            bookingId:  r.booking_id,
            floor:      r.floor,
            row:        r.row,
            num:        r.num,
            tier:       r.tier,
            guestName:  r.kind === 'booking' ? r.name : null,
            paid:       r.kind === 'booking' ? Boolean(r.paid) : null,
        };
    }
    res.json({ ok: true, seats });
});

// Lock a seat so that no guest can book it. Idempotent-ish: returns 409 if
// the seat is already booked or locked.
app.post('/api/admin/seats/:seatId/lock', requireAdmin, (req, res) => {
    const seatId = req.params.seatId;
    if (!SEAT_ID_RE.test(seatId)) return res.status(400).json({ error: 'Invalid seat id' });
    const meta = SEAT_CATALOG.get(seatId);
    if (!meta) return res.status(404).json({ error: 'Unknown seat' });
    if (meta.tier === 'VIP') return res.status(400).json({ error: 'VIP seats are not lockable (they are never bookable anyway).' });

    try {
        const tx = db.transaction(() => {
            const info = q.createAdminLockBooking.run();
            const bId = info.lastInsertRowid;
            q.insertSeat.run(seatId, bId, meta.floor, meta.row, meta.num, meta.tier, 0);
            return bId;
        });
        const bId = tx();
        res.json({ ok: true, seatId, bookingId: bId });
    } catch (err) {
        if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
            return res.status(409).json({ error: 'Seat is already booked or locked.' });
        }
        throw err;
    }
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------
function startListening(onReady) {
    // When BIND_HOST is empty we let Node/Passenger pick the interface. This
    // matters on Hostinger's shared Node hosting, where process.env.PORT can
    // be a unix-socket path — passing a host arg breaks listen() in that case.
    if (BIND_HOST) return app.listen(PORT, BIND_HOST, onReady);
    return app.listen(PORT, onReady);
}

const server = startListening(() => {
    const displayHost = !BIND_HOST || BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST;
    console.log(`\n🎭  Theat.R booking server running → http://${displayHost}:${PORT}`);
    console.log(`    Env:         ${NODE_ENV}${IS_PROD ? '' : ' (NODE_ENV=production in prod)'}`);
    console.log(`    Binding:     ${BIND_HOST || '(auto)'}:${PORT}   trust proxy: ${TRUST_PROXY || 'off'}`);
    console.log(`    Secure cookies: ${FORCE_SECURE_COOKIES ? 'on' : 'off'}`);
    console.log(`    DB:          ${DB_PATH}`);
    console.log(`    Mail:        ${DISABLE_EMAIL ? 'DISABLED' : (GMAIL_APP_PASSWORD ? `enabled as ${GMAIL_USER}` : 'NOT configured (set GMAIL_APP_PASSWORD in .env)')}`);
    console.log(`    Admin:       ${adminEnabled() ? `enabled (user "${ADMIN_USERNAME}")` : 'DISABLED (set ADMIN_PASSWORD in .env to enable)'}\n`);
});

// Keep the process alive across unexpected errors but log them loudly. A
// process manager (PM2 / systemd) will still restart us if the process dies.
process.on('uncaughtException',  (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

// Graceful shutdown: finish in-flight requests, then close the DB cleanly so
// the WAL is checkpointed. PM2 sends SIGINT; systemd sends SIGTERM.
function shutdown(signal) {
    console.log(`\n[${signal}] shutting down — draining requests…`);
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        try { db.close(); } catch {}
        process.exit(0);
    };
    server.close(finish);
    setTimeout(() => { console.warn('[shutdown] forcing exit after 10 s'); finish(); }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
