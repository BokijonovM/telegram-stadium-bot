import Database from 'better-sqlite3';
import {
    hoursList
} from './time.js';


const dbPath = process.env.DB_FILE || './db.sqlite';
export const db = new Database(dbPath);


db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');


db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    hour TEXT NOT NULL,
    remaining INTEGER NOT NULL,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, hour)
    );
    CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    hour TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | canceled
    canceled_by TEXT, -- user | admin | null
    created_at TEXT NOT NULL
    );
`);

const DEFAULT_CAP = Number(process.env.SLOT_CAPACITY || 2);


export function ensureSlots(date) {
    const ins = db.prepare(`INSERT OR IGNORE INTO slots(date,hour,remaining) VALUES(?,?,?)`);
    for (const h of hoursList()) ins.run(date, h, DEFAULT_CAP);
}


export function getSlots(date) {
    ensureSlots(date);
    return db.prepare(`SELECT hour, remaining, is_blocked FROM slots WHERE date=? ORDER BY hour`).all(date);
}


export function decrementSlot(date, hour) {
    const upd = db.prepare(`UPDATE slots SET remaining = remaining - 1 WHERE date=? AND hour=? AND remaining > 0 AND is_blocked = 0`);
    const res = upd.run(date, hour);
    return res.changes === 1;
}


export function incrementSlot(date, hour) {
    const upd = db.prepare(`UPDATE slots SET remaining = remaining + 1 WHERE date=? AND hour=?`);
    upd.run(date, hour);
}


export function insertBooking({
    user_id,
    full_name,
    phone,
    date,
    hour,
    created_at
}) {
    const ins = db.prepare(`INSERT INTO bookings(user_id, full_name, phone, date, hour, created_at) VALUES (?,?,?,?,?,?)`);
    ins.run(user_id, full_name, phone, date, hour, created_at);
}

export function getUserActiveBookings(user_id) {
    return db.prepare(`SELECT id, date, hour, status FROM bookings WHERE user_id=? AND status='confirmed' ORDER BY date, hour`).all(user_id);
}


export function getBookingById(id) {
    return db.prepare(`SELECT * FROM bookings WHERE id=?`).get(id);
}


export function cancelBooking(id, who) {
    const b = getBookingById(id);
    if (!b || b.status !== 'confirmed') return false;
    const tx = db.transaction(() => {
        db.prepare(`UPDATE bookings SET status='canceled', canceled_by=? WHERE id=?`).run(who, id);
        incrementSlot(b.date, b.hour);
    });
    tx();
    return true;
}


export function listBookingsByDate(date) {
    return db.prepare(`SELECT id, user_id, full_name, phone, date, hour, status, created_at FROM bookings WHERE date=? ORDER BY hour, created_at`).all(date);
}


export function toggleBlock(date, hour) {
    const row = db.prepare(`SELECT is_blocked FROM slots WHERE date=? AND hour=?`).get(date, hour);
    if (!row) return null;
    const next = row.is_blocked ? 0 : 1;
    db.prepare(`UPDATE slots SET is_blocked=? WHERE date=? AND hour=?`).run(next, date, hour);
    return next;
}