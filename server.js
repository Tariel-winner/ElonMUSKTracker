const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { runCronJob } = require('./cron');
const { getCurrentState, cache } = require('./memory-cache');
const history = require('./history');
const db = require('./db');

const app = express();
const port = process.env.PORT || 3000;

// =============================================
// SERVE STATIC FILES
// =============================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// =============================================
// API ENDPOINTS
// =============================================

app.get('/api/current', async (req, res) => {
  try {
    // ✅ Use getCurrentState() from memory-cache
    const state = getCurrentState();
    
    if (state.hasInference || state.hasObservation) {
      // Combine observation + inference for UI
      const response = {
        // Inference data (what we think is happening)
        state: state.latestConclusion?.state || 'unknown',
        phase: state.latestConclusion?.phase || state.latestConclusion?.state || 'unknown',
        status_message: state.latestConclusion?.status_message || null,
        hypothesis_type: state.latestConclusion?.hypothesis_type || null,
        current_location: state.latestConclusion?.current_location || 'Unknown',
        geo_label: state.latestConclusion?.geo_label || null,
        destination: state.latestConclusion?.destination || 'Unknown',
        confidence: state.latestConclusion?.confidence || 0,
        reasoning: state.latestConclusion?.reasoning || ['Waiting for data...'],
        prediction_type: state.latestConclusion?.prediction_type || 'unknown',
        timestamp: state.latestConclusion?.timestamp || new Date().toISOString(),
        
        // Observation data (what we actually know)
        observed_lat: state.lastObservedPosition?.lat || null,
        observed_lng: state.lastObservedPosition?.lng || null,
        observed_on_ground: state.lastObservedPosition?.on_ground ?? null,
        observed_age: state.flightAge || null,
        
        // Metadata
        _meta: {
          hasObservation: state.hasObservation,
          hasInference: state.hasInference,
          isStale: state.isStale || false,
          flightAge: state.flightAge || null,
          inferenceSource: state.inferenceSource || 'none',
          inferenceConfidence: state.inferenceConfidence || 0,
          lastUpdated: state.lastUpdated || null,
          cacheVersion: '2.0',
          phase: state.latestConclusion?.phase || null,
        }
      };
      return res.json(response);
    }
    
    // Fallback to DB if cache is empty
    const row = await history.getLatestConclusion();
    if (row) {
      res.json(row);
    } else {
      res.status(404).json({ error: 'No data yet' });
    }
  } catch (err) {
    console.error('[API] /api/current error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    // ✅ Get only inferences with reasonable confidence
    const rows = await history.getHistoryWithConfidence(0.1);
    // Limit to last 100 for frontend performance
    const limited = rows.slice(-100);
    res.json(limited);
  } catch (err) {
    console.error('[API] /api/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/snapshot', async (req, res) => {
  try {
    const { timestamp } = req.query;
    if (!timestamp) {
      return res.status(400).json({ error: 'Missing timestamp parameter' });
    }
    
    // ✅ Get combined state at timestamp
    const state = await history.getStateAtTimestamp(timestamp);
    if (state && (state.observation || state.inference)) {
      res.json(state);
    } else {
      res.status(404).json({ error: 'No data for that timestamp' });
    }
  } catch (err) {
    console.error('[API] /api/snapshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/flight-path', async (req, res) => {
  try {
    // ✅ Get raw flight data (observations only)
    const rows = await history.getFlightHistory24Hours();
    res.json(rows);
  } catch (err) {
    console.error('[API] /api/flight-path error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    // ✅ Full state for debugging
    const state = getCurrentState();
    res.json(state);
  } catch (err) {
    console.error('[API] /api/state error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  const state = getCurrentState();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasData: state.hasObservation || state.hasInference,
    hasObservation: state.hasObservation,
    hasInference: state.hasInference,
    isStale: state.isStale || false,
    flightAge: state.flightAge || null,
    cacheVersion: state.cacheVersion || '2.0'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================
// CRON JOB — align with OpenSky bridge (5 min)
// Bridge caches OpenSky; calling more often only re-reads cache.
// =============================================

cron.schedule('*/5 * * * *', async () => {
  await runCronJob();
});

// =============================================
// CLEANUP JOB (Every 12 hours)
// =============================================

cron.schedule('0 */12 * * *', async () => {
  try {
    // DB only — does NOT clear RAM lastObservedPosition (needed for AI approx)
    await history.cleanOldData(24);
    console.log('[CLEANUP] ✅ Old DB rows cleaned (older than 24 hours); RAM last point kept');
  } catch (err) {
    console.error('[CLEANUP] ❌ Cleanup error:', err.message);
  }
});

// =============================================
// START SERVER
// =============================================

app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${port} (PORT=${process.env.PORT})`);
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🛩️  FLIGHT STUDY TRACKER - BACKEND                    ║
╠══════════════════════════════════════════════════════════╣
║  🚀 HTTP Server:    http://localhost:${port}             ║
║  ⏰ Cron → bridge:  Every 5 minutes (matches OpenSky)  ║
║  🧹 Cleanup Job:    Every 12 hours                    ║
║  📊 Database:       SQLite (data.db)                   ║
╚══════════════════════════════════════════════════════════╝
  `);
  
  console.log('📌 Endpoints:');
  console.log(`   GET /              → Frontend UI`);
  console.log(`   GET /api/current   → Latest state (observation + inference)`);
  console.log(`   GET /api/history   → Last 24 hours (inferences only, max 100)`);
  console.log(`   GET /api/snapshot  → Combined state at specific timestamp`);
  console.log(`   GET /api/flight-path → Raw flight data (observations only)`);
  console.log(`   GET /api/state     → Full cache state (debug)`);
  console.log(`   GET /health        → Health check with cache status`);
});

// Run once on startup
setTimeout(async () => {
  await runCronJob();
}, 1000);