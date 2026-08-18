const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Use Railway volume if available, otherwise /tmp, fallback to local
const isRailway = process.env.RAILWAY_SERVICE_ID;
const dbDir = isRailway 
  ? (process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp')
  : __dirname;

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'data.db');
const db = new sqlite3.Database(dbPath);

// Initialize tables (run once)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS raw_flight_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      lat REAL,
      lng REAL,
      altitude INTEGER,
      speed INTEGER,
      heading INTEGER,
      on_ground INTEGER,
      vert_rate INTEGER,
      raw_json TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_conclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      state TEXT,
      current_location TEXT,
      destination TEXT,
      confidence REAL,
      reasoning TEXT,
      prediction_type TEXT,
      raw_json TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS historical_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_airport TEXT,
      to_destination TEXT,
      occurrences INTEGER,
      confidence REAL,
      last_observed TEXT
    )
  `);
});

console.log(`📊 Database initialized at: ${dbPath}`);
module.exports = db;