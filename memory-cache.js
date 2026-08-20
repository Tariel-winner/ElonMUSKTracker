// memory-cache.js
// Holds the latest state in RAM so we don't query DB every 30 seconds
// LAYERED: Observations (facts) vs Inferences (guesses) are kept separate

const cache = {
  // === LAYER A: OBSERVATIONS (facts from ADS-B) ===
  currentFlight: null,      // Last flight data from ADS-B
  previousFlight: null,     // Flight data from previous cron run
  lastObservedPosition: null, // Last known real position {lat, lng, timestamp, source}
  
  // === LAYER B: FEATURES ===
  flightAge: null,          // Age of current flight data in seconds
  isStale: false,           // True if flight data is older than threshold
  onGroundEdge: null,       // 'takeoff' | 'landing' | null
  
  // === LAYER C/D: INFERENCES (guesses) ===
  latestConclusion: null,   // Last AI conclusion (may be guess)
  lastInference: null,      // Last rule-based inference
  inferenceSource: null,    // 'rules' | 'deepseek' | 'fallback'
  inferenceConfidence: 0,   // Confidence of last inference
  
  // === LAYER E: PRESENTATION ===
  landingDetected: false,   // Flag to trigger Waze fetch only once
  lastLandingTime: null,    // Timestamp of last landing
  
  // === METADATA ===
  lastUpdated: null,        // When cache was last updated
  cacheVersion: '2.0',      // For cache invalidation
};

// --- HELPERS ---

/**
 * Update observation (flight data)
 * This is a FACT - never overwrite with guesses
 */
function updateObservation(flightData) {
  if (!flightData) return;
  
  cache.currentFlight = flightData;
  cache.lastObservedPosition = {
    lat: flightData.lat,
    lng: flightData.lon || flightData.lng,
    timestamp: flightData.timestamp || new Date().toISOString(),
    source: 'opensky',
    on_ground: flightData.on_ground
  };
  
  // Calculate age
  if (flightData.timestamp) {
    const ageMs = Date.now() - new Date(flightData.timestamp).getTime();
    cache.flightAge = Math.round(ageMs / 1000);
    cache.isStale = cache.flightAge > 300; // 5 minutes
  }
  
  cache.lastUpdated = new Date().toISOString();
}

/**
 * Update inference (guess)
 * Always mark as inference, never mix with observations
 */
function updateInference(conclusion) {
  if (!conclusion) return;
  
  cache.latestConclusion = conclusion;
  cache.lastInference = conclusion;
  cache.inferenceSource = conclusion.prediction_type || 'unknown';
  cache.inferenceConfidence = conclusion.confidence || 0;
  cache.lastUpdated = new Date().toISOString();
}

/**
 * Get the current state with labels
 * UI can see what's observation vs inference
 */
function getCurrentState() {
  return {
    // Observations
    currentFlight: cache.currentFlight,
    lastObservedPosition: cache.lastObservedPosition,
    isStale: cache.isStale,
    flightAge: cache.flightAge,
    
    // Inferences
    latestConclusion: cache.latestConclusion,
    inferenceSource: cache.inferenceSource,
    inferenceConfidence: cache.inferenceConfidence,
    
    // Metadata
    lastUpdated: cache.lastUpdated,
    onGroundEdge: cache.onGroundEdge,
    landingDetected: cache.landingDetected,
    lastLandingTime: cache.lastLandingTime,
    
    // Helper for UI
    hasObservation: !!cache.currentFlight,
    hasInference: !!cache.latestConclusion,
  };
}

/**
 * Clear inference (when we want to reset guesses)
 */
function clearInference() {
  // IMPORTANT: do NOT clear lastObservedPosition / currentFlight
  // AI no_signal path needs the last ADS-B point
  cache.latestConclusion = null;
  cache.lastInference = null;
  cache.inferenceSource = null;
  cache.inferenceConfidence = 0;
  cache.landingDetected = false;
  cache.lastLandingTime = null;
}

/**
 * Keep last ADS-B in RAM for AI approx (default 1 hour window for "fresh enough").
 * Position itself is not deleted by cleanup — only marked too old for AI if desired.
 */
const LAST_OBS_AI_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function isLastObservationFreshEnoughForAi(maxAgeMs = LAST_OBS_AI_MAX_AGE_MS) {
  const p = cache.lastObservedPosition;
  if (!p || !p.timestamp) return false;
  const age = Date.now() - new Date(p.timestamp).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

/**
 * After process restart, RAM is empty — reload newest raw_flight_data row if recent.
 */
async function hydrateLastObservationFromDb(historyModule, maxAgeMs = LAST_OBS_AI_MAX_AGE_MS) {
  if (cache.lastObservedPosition) return cache.lastObservedPosition;
  try {
    const row = await historyModule.getLatestFlight();
    if (!row || row.lat == null || row.lng == null) return null;
    const age = Date.now() - new Date(row.timestamp).getTime();
    if (!Number.isFinite(age) || age > maxAgeMs) {
      console.log('[CACHE] DB last flight too old for hydrate', row.timestamp);
      return null;
    }
    updateObservation({
      lat: row.lat,
      lon: row.lng,
      lng: row.lng,
      on_ground: row.on_ground,
      heading: row.heading,
      altitude: row.altitude,
      speed: row.speed,
      timestamp: row.timestamp,
      source: 'db_hydrate',
    });
    console.log('[CACHE] Hydrated lastObservedPosition from DB', row.lat, row.lng);
    return cache.lastObservedPosition;
  } catch (e) {
    console.warn('[CACHE] Hydrate failed:', e.message);
    return null;
  }
}

/**
 * Invalidate stale observation
 */
function invalidateObservation() {
  if (cache.isStale) {
    // Keep the data but mark as stale
    // Don't clear it - UI can show "stale" indicator
  }
}

// --- EXPORT ---
module.exports = {
  cache,
  updateObservation,
  updateInference,
  getCurrentState,
  clearInference,
  invalidateObservation,
  hydrateLastObservationFromDb,
  isLastObservationFreshEnoughForAi,
  LAST_OBS_AI_MAX_AGE_MS,
};