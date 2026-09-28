const path = require('path');
const fs = require('fs');

const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;
const IS_VERCEL = !!process.env.VERCEL;

let isPg = false;
let pgPool = null;
let sqliteDb = null;

if (POSTGRES_URL) {
  isPg = true;
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('📦 Connected to Cloud Database (PostgreSQL / Vercel Storage)');
} else {
  const Database = require('better-sqlite3');
  const DATA_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqliteDb = new Database(path.join(DATA_DIR, 'attendance.db'));
  if (!IS_VERCEL) {
    sqliteDb.pragma('journal_mode = WAL');
  } else {
    sqliteDb.pragma('journal_mode = MEMORY');
  }
  sqliteDb.pragma('foreign_keys = ON');
  console.log('📦 Connected to Local Database (SQLite)');
}

function convertSqliteToPg(sqlText) {
  let idx = 1;
  let converted = sqlText.replace(/\?/g, () => `$${idx++}`);
  
  // Replace SQLite specific syntax with PG equivalents
  converted = converted.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  converted = converted.replace(/datetime\('now',\s*'localtime'\)/gi, 'CURRENT_TIMESTAMP');
  
  return converted;
}

async function query(sqlText, params = []) {
  if (isPg) {
    const pgSql = convertSqliteToPg(sqlText);
    const res = await pgPool.query(pgSql, params);
    return res;
  } else {
    const stmt = sqliteDb.prepare(sqlText);
    if (sqlText.trim().toUpperCase().startsWith('SELECT') || sqlText.includes('RETURNING') || sqlText.toUpperCase().startsWith('PRAGMA')) {
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    } else {
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  }
}

async function get(sqlText, params = []) {
  if (isPg) {
    const pgSql = convertSqliteToPg(sqlText);
    const res = await pgPool.query(pgSql, params);
    return res.rows[0] || undefined;
  } else {
    const stmt = sqliteDb.prepare(sqlText);
    return stmt.get(...params);
  }
}

async function all(sqlText, params = []) {
  if (isPg) {
    const pgSql = convertSqliteToPg(sqlText);
    const res = await pgPool.query(pgSql, params);
    return res.rows;
  } else {
    const stmt = sqliteDb.prepare(sqlText);
    return stmt.all(...params);
  }
}

async function run(sqlText, params = []) {
  if (isPg) {
    let pgSql = convertSqliteToPg(sqlText);
    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
    if (isInsert && !pgSql.toUpperCase().includes('RETURNING') && !pgSql.toUpperCase().includes('ON CONFLICT')) {
      pgSql += ' RETURNING id';
    }
    const res = await pgPool.query(pgSql, params);
    const lastInsertRowid = res.rows.length > 0 && res.rows[0].id ? res.rows[0].id : null;
    return { changes: res.rowCount, lastInsertRowid };
  } else {
    const stmt = sqliteDb.prepare(sqlText);
    const info = stmt.run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
}

async function upsertSetting(key, value) {
  if (isPg) {
    await pgPool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value).trim()]
    );
  } else {
    sqliteDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value).trim());
  }
}

async function initDb() {
  if (isPg) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        nama TEXT NOT NULL,
        nip TEXT NOT NULL UNIQUE,
        shift TEXT NOT NULL DEFAULT 'Otomatis',
        descriptor TEXT NOT NULL,
        foto TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        tanggal TEXT NOT NULL,
        jam_masuk TEXT,
        jam_keluar TEXT,
        shift TEXT,
        foto_masuk TEXT,
        foto_keluar TEXT,
        UNIQUE(employee_id, tanggal, shift)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        hari TEXT NOT NULL,
        shift TEXT NOT NULL DEFAULT 'Shift 1',
        piket INTEGER NOT NULL DEFAULT 0,
        UNIQUE(employee_id, hari)
      );
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama TEXT NOT NULL,
        nip TEXT NOT NULL UNIQUE,
        shift TEXT NOT NULL DEFAULT 'Otomatis',
        descriptor TEXT NOT NULL,
        foto TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        tanggal TEXT NOT NULL,
        jam_masuk TEXT,
        jam_keluar TEXT,
        shift TEXT,
        foto_masuk TEXT,
        foto_keluar TEXT,
        UNIQUE(employee_id, tanggal, shift),
        FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        hari TEXT NOT NULL,
        shift TEXT NOT NULL DEFAULT 'Shift 1',
        piket INTEGER NOT NULL DEFAULT 0,
        UNIQUE(employee_id, hari),
        FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE
      );
    `);
  }

  const defaultSettings = {
    shift1_start: '06:00',
    shift1_end: '14:00',
    shift2_start: '14:00',
    shift2_end: '22:00',
    shift3_start: '22:00',
    shift3_end: '06:00',
    late_tolerance: '30',
    admin_pin: '1234'
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    if (isPg) {
      await pgPool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
    } else {
      sqliteDb.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}

module.exports = {
  isPg,
  initDb,
  query,
  get,
  all,
  run,
  upsertSetting
};
