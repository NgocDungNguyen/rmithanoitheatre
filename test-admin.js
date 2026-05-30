/**
 * End-to-end smoke test for the admin panel.
 *
 * Starts the Express app on a random port (listen on 127.0.0.1 with port 0),
 * drives the public + admin endpoints over real HTTP, and asserts every step.
 * The DB is a temp file that's cleaned up afterwards.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

// Force a temp DB + admin credentials BEFORE loading server.js.
const TMP_DB = path.join(__dirname, 'theatre-admin-smoke.db');
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

process.env.DISABLE_EMAIL = 'true';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'testpass123';
process.env.PORT = '0';

// server.js hard-codes DB_PATH = './theatre.db'. For the smoke test we back up
// all three SQLite files (.db + -wal + -shm) by renaming them aside, run the
// test against a fresh theatre.db, then restore afterwards so real data is
// never touched.
const PROD_FILES = ['theatre.db', 'theatre.db-wal', 'theatre.db-shm'].map(f => path.join(__dirname, f));
const BAK_SUFFIX = '.smoke-bak';
const backedUp = [];
for (const f of PROD_FILES) {
    if (fs.existsSync(f)) { fs.renameSync(f, f + BAK_SUFFIX); backedUp.push(f); }
}
function restoreProdDb() {
    for (const f of PROD_FILES) {
        try { fs.unlinkSync(f); } catch {}
    }
    for (const f of backedUp) {
        try { fs.renameSync(f + BAK_SUFFIX, f); } catch {}
    }
}
process.on('exit', restoreProdDb);
process.on('SIGINT', () => { restoreProdDb(); process.exit(2); });

// Swap the hard-coded app.listen port via a proxy on the net module. Simpler:
// require and monkey-patch BEFORE it binds. server.js listens on `PORT` env.
// We already set PORT=0 so the OS will pick a free one.
// Intercept the listen log so we can pluck the port.

// Override http.Server.prototype.listen to force binding to 127.0.0.1:0
// (the sandbox here refuses 0.0.0.0). Also capture the server instance so we
// can shut it down cleanly.
let capturedServer = null;
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
    // Normalise args → (port, host, backlog?, callback?)
    // server.js calls: app.listen(PORT, callback)
    let cb;
    if (typeof args[args.length - 1] === 'function') cb = args.pop();
    const r = origListen.call(this, 0, '127.0.0.1', cb);
    if (!capturedServer) capturedServer = this;
    return r;
};

require('./server.js');

if (!capturedServer) {
    console.error('Failed to capture server');
    process.exit(1);
}

let passed = true;
function check(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) passed = false; }

function httpJson({ method = 'GET', pathname, body = null, cookie = null }) {
    return new Promise((resolve, reject) => {
        const addr = capturedServer.address();
        const opts = {
            host: '127.0.0.1', port: addr.port, path: pathname, method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (cookie) opts.headers['Cookie'] = cookie;
        const req = http.request(opts, (res) => {
            let chunks = '';
            res.on('data', d => chunks += d);
            res.on('end', () => {
                let json;
                try { json = JSON.parse(chunks); } catch { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw: chunks });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function extractCookie(headers) {
    const sc = headers['set-cookie'];
    if (!sc) return null;
    for (const line of sc) {
        const m = /^admin_session=([^;]+)/.exec(line);
        if (m) return `admin_session=${m[1]}`;
    }
    return null;
}

async function waitForListen() {
    for (let i = 0; i < 100; i++) {
        if (capturedServer.listening) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('server did not start listening');
}

(async () => {
    await waitForListen();
    console.log('\n=== Admin smoke test ===');
    console.log(`  server listening on port ${capturedServer.address().port}\n`);

    // 1. Make a public booking so we have something to show in admin.
    console.log('--- public booking ---');
    const bookRes = await httpJson({
        method: 'POST', pathname: '/api/book',
        body: {
            name: 'Test Guest', email: 'guest@test.local', phone: '0987654321',
            seats: ['F1-D-14', 'F1-D-13', 'F2-E-1'],
        },
    });
    check(bookRes.status === 200 && bookRes.body.ok, 'public /api/book succeeds');
    check(bookRes.body.seats && bookRes.body.seats.length === 3, '3 seats booked');
    const bookingId = bookRes.body.bookingId;

    // 2. Admin endpoints are locked when not authenticated.
    console.log('\n--- unauthenticated ---');
    const unauth = await httpJson({ pathname: '/api/admin/bookings' });
    check(unauth.status === 401, '/api/admin/bookings returns 401 without cookie');

    // 3. Login with wrong password fails.
    console.log('\n--- login failures ---');
    const wrong = await httpJson({ method: 'POST', pathname: '/api/admin/login', body: { username: 'admin', password: 'wrong' } });
    check(wrong.status === 401, 'wrong password → 401');

    const empty = await httpJson({ method: 'POST', pathname: '/api/admin/login', body: {} });
    check(empty.status === 400, 'missing creds → 400');

    // 4. Real login issues a cookie.
    console.log('\n--- login success ---');
    const login = await httpJson({ method: 'POST', pathname: '/api/admin/login', body: { username: 'admin', password: 'testpass123' } });
    check(login.status === 200 && login.body.ok, 'correct creds → 200');
    const cookie = extractCookie(login.headers);
    check(Boolean(cookie), 'Set-Cookie: admin_session=…');
    const setCookieLine = login.headers['set-cookie'][0];
    check(/HttpOnly/i.test(setCookieLine), 'cookie is HttpOnly');
    check(/SameSite=Strict/i.test(setCookieLine), 'cookie is SameSite=Strict');

    // 5. Me endpoint reflects auth state.
    const me = await httpJson({ pathname: '/api/admin/me', cookie });
    check(me.status === 200 && me.body.authenticated === true && me.body.username === 'admin', '/api/admin/me reports authenticated');

    // Verify the updated seat-catalog: only D/E/F are Stars; G/H/J are Artists.
    console.log('\n--- seat-catalog tiers ---');
    const tierProbe = await httpJson({
        method: 'POST', pathname: '/api/book',
        body: { name: 'Tier Probe', email: 't@t.local', phone: '0987654321', seats: ['F1-F-26', 'F1-G-26'] },
    });
    check(tierProbe.status === 200, 'probe booking succeeds');
    const tiers = Object.fromEntries(tierProbe.body.seats.map(s => [s.seat_id, s.tier]));
    check(tiers['F1-F-26'] === 'Stars',   'row F is Stars');
    check(tiers['F1-G-26'] === 'Artists', 'row G is Artists (was Stars)');
    // Clean up this probe so it doesn't pollute later assertions.
    await httpJson({ method: 'DELETE', pathname: `/api/admin/bookings/${tierProbe.body.bookingId}`, cookie });

    // 6. Fetch bookings.
    console.log('\n--- admin list ---');
    const list = await httpJson({ pathname: '/api/admin/bookings', cookie });
    check(list.status === 200 && list.body.ok, '/api/admin/bookings → 200');
    check(list.body.bookings.length === 1, '1 booking returned');
    check(list.body.bookings[0].seats.length === 3, 'booking has 3 seats');
    check(list.body.stats.totalBookings === 1 && list.body.stats.totalSeats === 3, 'stats totals correct');
    check(list.body.stats.byTier.Stars === 2 && list.body.stats.byTier.Dreamers === 1, 'byTier: 2 Stars + 1 Dreamers');

    // 7. Cancel a single seat; booking stays with 2 seats.
    console.log('\n--- cancel single seat ---');
    const cancel1 = await httpJson({ method: 'DELETE', pathname: '/api/admin/seats/F1-D-14', cookie });
    check(cancel1.status === 200 && cancel1.body.ok && cancel1.body.removedBooking === false, 'cancel F1-D-14 → booking preserved');

    const afterOne = await httpJson({ pathname: '/api/admin/bookings', cookie });
    check(afterOne.body.bookings.length === 1 && afterOne.body.bookings[0].seats.length === 2, 'booking now has 2 seats');
    check(!afterOne.body.bookings[0].seats.some(s => s.seat_id === 'F1-D-14'), 'F1-D-14 is gone');

    // Subtotal/total should reflect 2 seats (Stars 300k + Dreamers 180k = 480k, no discount → 480k).
    check(afterOne.body.bookings[0].subtotal === 480000 && afterOne.body.bookings[0].total === 480000, 'subtotal/total recomputed: 480k');

    // 8. Seat must be bookable again.
    console.log('\n--- seat released back to pool ---');
    const publicSeats = await httpJson({ pathname: '/api/seats' });
    check(!publicSeats.body.sold.includes('F1-D-14'), 'F1-D-14 no longer in public sold list');

    const rebook = await httpJson({
        method: 'POST', pathname: '/api/book',
        body: { name: 'Second', email: 's@t.local', phone: '0111222333', seats: ['F1-D-14'] },
    });
    if (rebook.status !== 200) console.log('    rebook response:', rebook.status, rebook.body);
    check(rebook.status === 200 && rebook.body.ok, 'another guest can rebook F1-D-14');

    // 9. Cancel entire booking.
    console.log('\n--- cancel entire booking ---');
    const cancelAll = await httpJson({ method: 'DELETE', pathname: `/api/admin/bookings/${bookingId}`, cookie });
    check(cancelAll.status === 200 && cancelAll.body.ok, `cancel booking #${bookingId} → 200`);

    const after = await httpJson({ pathname: '/api/admin/bookings', cookie });
    const stillThere = after.body.bookings.find(b => b.id === bookingId);
    check(!stillThere, 'original booking is gone');
    check(after.body.bookings.length === 1, 'only the second guest’s booking remains');

    const seatsAfter = await httpJson({ pathname: '/api/seats' });
    check(!seatsAfter.body.sold.includes('F1-D-13'), 'F1-D-13 released');
    check(!seatsAfter.body.sold.includes('F2-E-1'), 'F2-E-1 released');

    // 10. Cancel non-existent things.
    console.log('\n--- 404 paths ---');
    const nf1 = await httpJson({ method: 'DELETE', pathname: '/api/admin/seats/F1-A-1', cookie });
    check(nf1.status === 404, 'cancelling a non-booked seat → 404');
    const nf2 = await httpJson({ method: 'DELETE', pathname: '/api/admin/bookings/99999', cookie });
    check(nf2.status === 404, 'cancelling a non-existent booking → 404');
    const bad = await httpJson({ method: 'DELETE', pathname: '/api/admin/seats/not-a-seat', cookie });
    check(bad.status === 400, 'invalid seat id → 400');

    // 11. Mark-as-paid toggles the paid flag.
    console.log('\n--- mark as paid ---');
    // Grab the remaining booking (the "Second" guest's).
    const currentList = await httpJson({ pathname: '/api/admin/bookings', cookie });
    const bid = currentList.body.bookings[0].id;
    check(currentList.body.bookings[0].paid === false, 'booking starts as unpaid');

    const pay = await httpJson({ method: 'POST', pathname: `/api/admin/bookings/${bid}/paid`, cookie, body: { paid: true } });
    check(pay.status === 200 && pay.body.ok && pay.body.paid === true, `mark booking #${bid} as paid → 200`);
    check(pay.body.emailed === true, 'first unpaid→paid transition triggers payment email');

    const afterPay = await httpJson({ pathname: '/api/admin/bookings', cookie });
    check(afterPay.body.bookings[0].paid === true, 'booking now marked paid');

    // Marking-as-paid again (no transition) should NOT email.
    const payAgain = await httpJson({ method: 'POST', pathname: `/api/admin/bookings/${bid}/paid`, cookie, body: { paid: true } });
    check(payAgain.body.emailed === false, 'already-paid → paid does NOT re-send email');

    // Unmark
    const unpay = await httpJson({ method: 'POST', pathname: `/api/admin/bookings/${bid}/paid`, cookie, body: { paid: false } });
    check(unpay.status === 200 && unpay.body.paid === false, 'can flip back to unpaid');
    check(unpay.body.emailed === false, 'paid→unpaid does NOT email');

    // 12. Seat map endpoint includes rich metadata.
    console.log('\n--- seat map ---');
    const map1 = await httpJson({ pathname: '/api/admin/map', cookie });
    check(map1.status === 200 && map1.body.ok, '/api/admin/map → 200');
    check(map1.body.seats['F1-D-14'] && map1.body.seats['F1-D-14'].status === 'booked', 'F1-D-14 is booked on the map');
    check(map1.body.seats['F1-D-14'].guestName === 'Second', 'map carries guest name');

    // 13. Lock an available seat.
    console.log('\n--- lock / unlock ---');
    const lock = await httpJson({ method: 'POST', pathname: '/api/admin/seats/F1-F-5/lock', cookie });
    check(lock.status === 200 && lock.body.ok, 'lock F1-F-5 → 200');

    // Public /api/seats must now include it as "sold".
    const pub = await httpJson({ pathname: '/api/seats' });
    check(pub.body.sold.includes('F1-F-5'), 'locked seat appears in public sold list');

    // Map shows it as locked with no guest name.
    const map2 = await httpJson({ pathname: '/api/admin/map', cookie });
    check(map2.body.seats['F1-F-5'] && map2.body.seats['F1-F-5'].status === 'locked', 'F1-F-5 shows status=locked');
    check(map2.body.seats['F1-F-5'].guestName === null, 'locked seat has no guest name');

    // It should not show up in the bookings list (kind='admin_lock' filtered out).
    const listAfterLock = await httpJson({ pathname: '/api/admin/bookings', cookie });
    check(!listAfterLock.body.bookings.some(b => b.seats.some(s => s.seat_id === 'F1-F-5')),
        'locked seat is hidden from bookings list');

    // Guests cannot book a locked seat.
    const conflict = await httpJson({
        method: 'POST', pathname: '/api/book',
        body: { name: 'X', email: 'x@y.z', phone: '0987654321', seats: ['F1-F-5'] },
    });
    check(conflict.status === 409, 'public booking of locked seat → 409');

    // Locking it twice conflicts.
    const lockAgain = await httpJson({ method: 'POST', pathname: '/api/admin/seats/F1-F-5/lock', cookie });
    check(lockAgain.status === 409, 'double-lock → 409');

    // Can't lock VIP.
    const lockVip = await httpJson({ method: 'POST', pathname: '/api/admin/seats/F1-A-1/lock', cookie });
    check(lockVip.status === 400, 'lock VIP seat → 400');

    // Unlock via the same seat-cancel endpoint.
    const unlock = await httpJson({ method: 'DELETE', pathname: '/api/admin/seats/F1-F-5', cookie });
    check(unlock.status === 200 && unlock.body.removedBooking === true, 'unlock deletes admin-lock booking');

    const pubAfter = await httpJson({ pathname: '/api/seats' });
    check(!pubAfter.body.sold.includes('F1-F-5'), 'F1-F-5 back in available pool');

    // A guest can now book it.
    const bookAfterUnlock = await httpJson({
        method: 'POST', pathname: '/api/book',
        body: { name: 'After', email: 'a@b.c', phone: '0987654321', seats: ['F1-F-5'] },
    });
    check(bookAfterUnlock.status === 200, 'guest can book F1-F-5 once unlocked');

    // 14. Logout invalidates the cookie.
    console.log('\n--- logout ---');
    await httpJson({ method: 'POST', pathname: '/api/admin/logout', cookie });
    const afterLogout = await httpJson({ pathname: '/api/admin/bookings', cookie });
    check(afterLogout.status === 401, 'cookie no longer valid after logout');

    console.log(passed ? '\n🎉 Admin smoke test PASSED\n' : '\n❌ Admin smoke test FAILED\n');
    capturedServer.close(() => {
        // Clean up our temp DBs (server used theatre.db because we renamed the prod one out of the way).
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
        restoreProdDb();
        process.exit(passed ? 0 : 1);
    });
})().catch(err => { console.error(err); restoreProdDb(); process.exit(1); });
