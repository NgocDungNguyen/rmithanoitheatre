/*
 * Import seat locks from a CSV into the SQLite DB.
 *
 * Usage:
 *   node scripts/import_theatre_csv.js [path/to/theatre_data.csv]
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CSV_PATH = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'theatre_data.csv');

const PRICES = {
    Stars: 300000,
    Artists: 250000,
    Dreamers: 180000,
};

const SEAT_ID_RE = /^F([12])-([A-Z])-(\d{1,2})$/;

function resolveDbPath() {
    if (process.env.DB_PATH) return process.env.DB_PATH;

    const legacyPath = path.join(__dirname, '..', 'theatre.db');
    if (process.env.NODE_ENV !== 'production') return legacyPath;

    const persistentDir = path.resolve(__dirname, '..', '..', 'theatre-data');
    const persistentPath = path.join(persistentDir, 'theatre.db');

    try {
        fs.mkdirSync(persistentDir, { recursive: true });
    } catch (err) {
        console.warn(`[db] cannot create persistent dir ${persistentDir}: ${err.message}`);
        console.warn('[db] falling back to in-app theatre.db');
        return legacyPath;
    }

    return persistentPath;
}

function buildSeatCatalog() {
    const seats = new Map();
    const addRange = (floor, row, tier, from, to) => {
        const [a, b] = from <= to ? [from, to] : [to, from];
        for (let n = a; n <= b; n++) {
            seats.set(`F${floor}-${row}-${n}`, { floor, row, num: n, tier });
        }
    };
    ['A', 'B'].forEach(r => addRange(1, r, 'VIP', 1, 24));
    addRange(1, 'C', 'Stars', 1, 24);
    ['D', 'E', 'F'].forEach(r => addRange(1, r, 'Stars', 1, 26));
    ['G', 'H', 'J'].forEach(r => addRange(1, r, 'Artists', 1, 26));
    ['K', 'L', 'M'].forEach(r => addRange(1, r, 'Artists', 1, 28));
    addRange(1, 'N', 'Artists', 1, 24);
    ['A', 'B', 'C'].forEach(r => addRange(2, r, 'Artists', 1, 30));
    addRange(2, 'D', 'Dreamers', 1, 24);
    addRange(2, 'E', 'Dreamers', 1, 24);
    return seats;
}

function parseCsvRows(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < 7) continue;
        const [seatId, bookingId, floor, row, num, tier, price] = cols.map(c => c.trim());
        rows.push({
            seatId,
            bookingId,
            floor: Number(floor),
            row,
            num: Number(num),
            tier,
            price: Number(price),
        });
    }
    return rows;
}

function main() {
    if (!fs.existsSync(CSV_PATH)) {
        console.error(`CSV not found: ${CSV_PATH}`);
        process.exit(1);
    }

    const dbPath = resolveDbPath();
    const db = new Database(dbPath);
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
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        kind           TEXT    NOT NULL DEFAULT 'booking',
        paid           INTEGER NOT NULL DEFAULT 0
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

    const seatCatalog = buildSeatCatalog();
    const existing = new Set(db.prepare('SELECT seat_id FROM booked_seats').all().map(r => r.seat_id));

    const rows = parseCsvRows(fs.readFileSync(CSV_PATH, 'utf8'));
    const grouped = new Map();

    const skipped = { invalid: 0, unknown: 0, vip: 0, exists: 0, badTier: 0 };

    for (const row of rows) {
        if (!SEAT_ID_RE.test(row.seatId)) { skipped.invalid++; continue; }
        if (existing.has(row.seatId)) { skipped.exists++; continue; }

        const catalog = seatCatalog.get(row.seatId);
        if (!catalog) { skipped.unknown++; continue; }
        if (catalog.tier === 'VIP') { skipped.vip++; continue; }

        if (row.tier && row.tier !== catalog.tier) skipped.badTier++;

        const price = Number.isFinite(row.price) && row.price > 0
            ? row.price
            : (PRICES[catalog.tier] || 0);

        const bucketKey = row.bookingId || `csv-${row.seatId}`;
        if (!grouped.has(bucketKey)) grouped.set(bucketKey, []);
        grouped.get(bucketKey).push({
            seat_id: row.seatId,
            floor: catalog.floor,
            row: catalog.row,
            num: catalog.num,
            tier: catalog.tier,
            price,
        });
    }

    const insertBooking = db.prepare(`INSERT INTO bookings
        (name, email, phone, sid, referral_code, seat_count, subtotal, discount, total, kind, paid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertSeat = db.prepare(`INSERT INTO booked_seats
        (seat_id, booking_id, floor, row, num, tier, price)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);

    let bookingCount = 0;
    let seatCount = 0;

    const tx = db.transaction(() => {
        for (const seats of grouped.values()) {
            if (seats.length === 0) continue;
            const subtotal = seats.reduce((sum, s) => sum + (s.price || 0), 0);
            const info = insertBooking.run(
                'Imported lock', '', '', null, null,
                seats.length, subtotal, 0, subtotal,
                'admin_lock', 1,
            );
            const bookingId = info.lastInsertRowid;
            for (const s of seats) {
                insertSeat.run(s.seat_id, bookingId, s.floor, s.row, s.num, s.tier, s.price || 0);
                seatCount++;
            }
            bookingCount++;
        }
    });

    tx();

    console.log('Import complete.');
    console.log(`DB: ${dbPath}`);
    console.log(`Bookings inserted: ${bookingCount}`);
    console.log(`Seats inserted: ${seatCount}`);
    console.log('Skipped:', skipped);
}

main();
