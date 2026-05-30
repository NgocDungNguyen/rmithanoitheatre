/**
 * Concurrency stress test for the booking system.
 *
 * Spawns N worker threads that each try to book a random overlapping subset of
 * seats against the same SQLite DB, mirroring exactly what `server.js` does
 * inside `POST /api/book`. At the end, the main thread audits the DB to prove:
 *
 *   1. No seat was booked more than once (the hard guarantee the user asked for).
 *   2. Every seat in `booked_seats` belongs to exactly one `bookings` row.
 *   3. `bookings.seat_count` matches the actual seats attached.
 *   4. Total successful seats across workers = total booked seats in DB.
 *
 * Usage:  node test-concurrency.js [workers] [attemptsPerWorker] [seatPoolSize]
 *         defaults: 16 workers × 30 attempts, seat pool = 40
 *
 * Running N×30 attempts against a pool of 40 guarantees massive collision
 * pressure: workers constantly fight for the same seats.
 */

const { Worker, isMainThread, parentPort, workerData, threadId } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'test-concurrency.db');

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------
function resetDb() {
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
        try { fs.unlinkSync(f); } catch {}
    }
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
        CREATE TABLE bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
            seat_count INTEGER NOT NULL, total INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE booked_seats (
            seat_id TEXT PRIMARY KEY,
            booking_id INTEGER NOT NULL,
            floor INTEGER NOT NULL, row TEXT NOT NULL, num INTEGER NOT NULL,
            tier TEXT NOT NULL, price INTEGER NOT NULL,
            FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
        );
    `);
    db.close();
}

function openDb() {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');   // wait up to 5 s for writer lock
    db.pragma('foreign_keys = ON');
    return db;
}

// Small seat pool from the real catalog; size is tunable via CLI arg.
function makePool(size) {
    const rows = 'DEFGHJ';  // Stars rows
    const pool = [];
    outer:
    for (let r = 0; r < rows.length; r++) {
        for (let n = 1; n <= 26; n++) {
            pool.push({ seat_id: `F1-${rows[r]}-${n}`, floor: 1, row: rows[r], num: n, tier: 'Stars', price: 300000 });
            if (pool.length >= size) break outer;
        }
    }
    return pool;
}

function pickSubset(pool, k) {
    const copy = pool.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
}

// -----------------------------------------------------------------------------
// Worker code
// -----------------------------------------------------------------------------
if (!isMainThread) {
    const { workerId, attempts, pool, seatsPerAttempt } = workerData;
    const db = openDb();
    const insB = db.prepare(`INSERT INTO bookings (name, email, phone, seat_count, total) VALUES (?, ?, ?, ?, ?)`);
    const insS = db.prepare(`INSERT INTO booked_seats (seat_id, booking_id, floor, row, num, tier, price) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const tx = db.transaction((payload) => {
        const info = insB.run(payload.name, payload.email, payload.phone, payload.seats.length, payload.total);
        const id = info.lastInsertRowid;
        for (const s of payload.seats) insS.run(s.seat_id, id, s.floor, s.row, s.num, s.tier, s.price);
        return id;
    });

    const report = { workerId, threadId, success: 0, conflict: 0, error: 0, bookedSeats: [] };

    for (let i = 0; i < attempts; i++) {
        const seats = pickSubset(pool, seatsPerAttempt);
        const total = seats.reduce((a, s) => a + s.price, 0);
        try {
            tx({
                name: `W${workerId}-${i}`,
                email: `w${workerId}-${i}@test.local`,
                phone: `0${workerId}${i}`,
                seats,
                total,
            });
            report.success++;
            for (const s of seats) report.bookedSeats.push(s.seat_id);
        } catch (err) {
            if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
                report.conflict++;
            } else {
                report.error++;
                report.lastError = err.message;
            }
        }
    }

    db.close();
    parentPort.postMessage(report);
    return;
}

// -----------------------------------------------------------------------------
// Main thread
// -----------------------------------------------------------------------------
const NUM_WORKERS       = Number(process.argv[2]) || 16;
const ATTEMPTS_EACH     = Number(process.argv[3]) || 30;
const POOL_SIZE         = Number(process.argv[4]) || 40;
const SEATS_PER_ATTEMPT = 3;

async function main() {
    console.log(`\n=== Concurrency test ===`);
    console.log(`  workers:             ${NUM_WORKERS}`);
    console.log(`  attempts per worker: ${ATTEMPTS_EACH}`);
    console.log(`  seat pool size:      ${POOL_SIZE}`);
    console.log(`  seats per attempt:   ${SEATS_PER_ATTEMPT}`);
    console.log(`  total attempts:      ${NUM_WORKERS * ATTEMPTS_EACH}`);
    console.log(`  max possible success (if no conflicts): ${POOL_SIZE / SEATS_PER_ATTEMPT | 0} bookings (${POOL_SIZE - (POOL_SIZE % SEATS_PER_ATTEMPT)} seats)\n`);

    resetDb();
    const pool = makePool(POOL_SIZE);
    const t0 = Date.now();

    const workers = [];
    const results = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
        const w = new Worker(__filename, {
            workerData: { workerId: i, attempts: ATTEMPTS_EACH, pool, seatsPerAttempt: SEATS_PER_ATTEMPT }
        });
        workers.push(new Promise((resolve, reject) => {
            w.on('message', (msg) => { results.push(msg); resolve(); });
            w.on('error', reject);
            w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
        }));
    }
    await Promise.all(workers);
    const elapsed = Date.now() - t0;

    // ---- Aggregate worker reports -------------------------------------------
    const totalSuccess   = results.reduce((a, r) => a + r.success, 0);
    const totalConflict  = results.reduce((a, r) => a + r.conflict, 0);
    const totalError     = results.reduce((a, r) => a + r.error, 0);
    const workerReported = results.flatMap(r => r.bookedSeats);

    console.log('Worker-reported tallies:');
    for (const r of results.sort((a, b) => a.workerId - b.workerId)) {
        console.log(`  W${String(r.workerId).padStart(2,'0')}  success=${String(r.success).padStart(3)}  conflict=${String(r.conflict).padStart(3)}  error=${r.error}${r.lastError ? `  (${r.lastError})` : ''}`);
    }
    console.log(`  ------------------------------------------------`);
    console.log(`  TOTAL  success=${totalSuccess}  conflict=${totalConflict}  error=${totalError}   (elapsed ${elapsed} ms)\n`);

    // ---- DB-side audit -------------------------------------------------------
    const db = openDb();

    const booked = db.prepare('SELECT seat_id, booking_id FROM booked_seats').all();
    const bookings = db.prepare('SELECT id, seat_count FROM bookings').all();
    const dupes = db.prepare(`
        SELECT seat_id, COUNT(*) AS c FROM booked_seats GROUP BY seat_id HAVING c > 1
    `).all();

    // Cross-check seat_count vs actual
    const mismatches = [];
    const actualCounts = new Map();
    for (const r of booked) actualCounts.set(r.booking_id, (actualCounts.get(r.booking_id) || 0) + 1);
    for (const b of bookings) {
        const actual = actualCounts.get(b.id) || 0;
        if (actual !== b.seat_count) mismatches.push({ bookingId: b.id, expected: b.seat_count, actual });
    }

    // Compare worker-reported seats vs DB seats (should match exactly)
    const dbSeatSet = new Set(booked.map(r => r.seat_id));
    const reportedSet = new Set(workerReported);
    const onlyReported = [...reportedSet].filter(s => !dbSeatSet.has(s));
    const onlyDb = [...dbSeatSet].filter(s => !reportedSet.has(s));

    let passed = true;
    const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) passed = false; };

    console.log('DB audit:');
    console.log(`  bookings rows:          ${bookings.length}`);
    console.log(`  booked_seats rows:      ${booked.length}`);
    console.log(`  seats in DB (unique):   ${dbSeatSet.size}`);
    console.log(`  duplicate seat_id rows: ${dupes.length}`);
    console.log(``);

    check(dupes.length === 0,                        'no seat_id appears more than once in booked_seats');
    check(booked.length === dbSeatSet.size,          'booked_seats row count == unique seat count');
    check(mismatches.length === 0,                   'bookings.seat_count matches actual booked_seats');
    check(bookings.length === totalSuccess,          `bookings.count (${bookings.length}) == worker-reported successes (${totalSuccess})`);
    check(booked.length === totalSuccess * SEATS_PER_ATTEMPT, `booked_seats.count (${booked.length}) == successes × seats/attempt (${totalSuccess * SEATS_PER_ATTEMPT})`);
    check(onlyReported.length === 0,                 `no seats reported by workers that are missing from DB (${onlyReported.length})`);
    check(onlyDb.length === 0,                       `no seats in DB that were not reported by any worker (${onlyDb.length})`);
    check(totalError === 0,                          'no unexpected errors (non-constraint) during transactions');

    db.close();

    // Cleanup
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
        try { fs.unlinkSync(f); } catch {}
    }

    console.log(passed ? '\n🎉 Concurrency test PASSED — no double-bookings under contention.\n'
                       : '\n❌ Concurrency test FAILED. See above.\n');
    process.exit(passed ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
