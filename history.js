// history.js
const db = require('./db');

/**
 * Get the latest AI conclusion
 */
function getLatestConclusion() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM ai_conclusions 
       ORDER BY timestamp DESC 
       LIMIT 1`,
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Get all conclusions for the last 24 hours
 */
function getHistory24Hours() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM ai_conclusions 
       WHERE timestamp > datetime('now', '-24 hours')
       ORDER BY timestamp ASC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Get the conclusion at a specific timestamp (for slider scrubbing)
 */
function getSnapshot(timestamp) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM ai_conclusions 
       WHERE timestamp <= ?
       ORDER BY timestamp DESC 
       LIMIT 1`,
      [timestamp],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Get all flight data (raw) for the last 24 hours
 * Used for drawing the exact flight path on the map
 */
function getFlightHistory24Hours() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT timestamp, lat, lng, altitude, speed, heading, on_ground
       FROM raw_flight_data 
       WHERE timestamp > datetime('now', '-24 hours')
       ORDER BY timestamp ASC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

module.exports = {
  getLatestConclusion,
  getHistory24Hours,
  getSnapshot,
  getFlightHistory24Hours
};