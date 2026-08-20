// history.js
// Database access layer for history
// LAYERED: Observations (raw_flight_data) vs Inferences (ai_conclusions) are separate

const db = require('./db');

// --- LAYER A: OBSERVATIONS (raw flight data) ---

/**
 * Get all flight data (raw) for the last 24 hours
 * Used for drawing the exact flight path on the map
 * This is the SOURCE OF TRUTH for movement
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

/**
 * Get flight data for a specific time range
 */
function getFlightHistoryRange(startTime, endTime) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT timestamp, lat, lng, altitude, speed, heading, on_ground
       FROM raw_flight_data 
       WHERE timestamp BETWEEN ? AND ?
       ORDER BY timestamp ASC`,
      [startTime, endTime],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Get the most recent flight observation
 */
function getLatestFlight() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT timestamp, lat, lng, altitude, speed, heading, on_ground
       FROM raw_flight_data 
       ORDER BY timestamp DESC 
       LIMIT 1`,
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

// --- LAYER C/D: INFERENCES (ai_conclusions) ---

/**
 * Get the latest AI conclusion (inference)
 * Always check if it's from cache or inference
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
 * This is a history of STORIES, not movement
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
 * Get conclusions with confidence filter
 * Only show inferences above a threshold
 */
function getHistoryWithConfidence(minConfidence = 0.1) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM ai_conclusions 
       WHERE timestamp > datetime('now', '-24 hours')
       AND confidence >= ?
       ORDER BY timestamp ASC`,
      [minConfidence],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Get the conclusion at a specific timestamp (for slider scrubbing)
 * Returns the closest inference at or before the timestamp
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

// --- LAYER E: COMBINED (for UI) ---

/**
 * Get combined state at a timestamp
 * Returns both observation and inference if available
 */
function getStateAtTimestamp(timestamp) {
  return new Promise((resolve, reject) => {
    const result = {
      timestamp: timestamp,
      observation: null,
      inference: null
    };
    
    // Get flight at timestamp
    db.get(
      `SELECT timestamp, lat, lng, altitude, speed, heading, on_ground
       FROM raw_flight_data 
       WHERE timestamp <= ?
       ORDER BY timestamp DESC 
       LIMIT 1`,
      [timestamp],
      (err, row) => {
        if (err) { reject(err); return; }
        result.observation = row;
        
        // Get inference at timestamp
        db.get(
          `SELECT * FROM ai_conclusions 
           WHERE timestamp <= ?
           ORDER BY timestamp DESC 
           LIMIT 1`,
          [timestamp],
          (err, row2) => {
            if (err) { reject(err); return; }
            result.inference = row2;
            resolve(result);
          }
        );
      }
    );
  });
}

// --- CLEANUP ---

/**
 * Clean old data (keep last N hours)
 */
function cleanOldData(hoursToKeep = 24) {
  return new Promise((resolve, reject) => {
    const cutoff = new Date(Date.now() - hoursToKeep * 60 * 60 * 1000).toISOString();
    
    db.run(
      `DELETE FROM raw_flight_data WHERE timestamp < ?`,
      [cutoff],
      (err) => {
        if (err) { reject(err); return; }
        db.run(
          `DELETE FROM ai_conclusions WHERE timestamp < ?`,
          [cutoff],
          (err2) => {
            if (err2) reject(err2);
            else resolve({ cleaned: true, cutoff: cutoff });
          }
        );
      }
    );
  });
}

// --- EXPORT ---
module.exports = {
  // Observations
  getFlightHistory24Hours,
  getFlightHistoryRange,
  getLatestFlight,
  
  // Inferences
  getLatestConclusion,
  getHistory24Hours,
  getHistoryWithConfidence,
  getSnapshot,
  
  // Combined
  getStateAtTimestamp,
  
  // Cleanup
  cleanOldData
};