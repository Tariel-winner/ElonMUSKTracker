const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { runCronJob } = require('./cron');
const cache = require('./memory-cache');
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
    if (cache.latestConclusion) {
      return res.json(cache.latestConclusion);
    }
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
    const rows = await history.getHistory24Hours();
    // ✅ OPTIMIZED: Limit to last 100 for frontend performance
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
    const row = await history.getSnapshot(timestamp);
    if (row) {
      res.json(row);
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
    const rows = await history.getFlightHistory24Hours();
    res.json(rows);
  } catch (err) {
    console.error('[API] /api/flight-path error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasData: !!cache.latestConclusion
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================
// CRON JOB (Every 60 seconds)
// =============================================

cron.schedule('*/60 * * * * *', async () => {
  await runCronJob();
});

// =============================================
// CLEANUP JOB (Every 12 hours - keeps 12 hours of data)
// =============================================

// Run every 12 hours
cron.schedule('0 */12 * * *', async () => {
  try {
    // Keep only last 12 hours of data (720 rows at 1/minute)
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    
    db.run(
      `DELETE FROM raw_flight_data WHERE timestamp < ?`,
      [twelveHoursAgo],
      (err) => {
        if (!err) console.log('[CLEANUP] ✅ Old flight data removed (older than 12 hours)');
        else console.error('[CLEANUP] ❌ Failed to clean flight data:', err);
      }
    );
    
    db.run(
      `DELETE FROM ai_conclusions WHERE timestamp < ?`,
      [twelveHoursAgo],
      (err) => {
        if (!err) console.log('[CLEANUP] ✅ Old conclusions removed (older than 12 hours)');
        else console.error('[CLEANUP] ❌ Failed to clean conclusions:', err);
      }
    );
  } catch (err) {
    console.error('[CLEANUP] ❌ Cleanup error:', err.message);
  }
});

// =============================================
// START SERVER
// =============================================

app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🛩️  ELON MUSK TRACKER - BACKEND SERVER                 ║
╠══════════════════════════════════════════════════════════╣
║  🚀 HTTP Server:    http://localhost:${port}             ║
║  ⏰ Cron Job:       Every 60 seconds                   ║
║  🧹 Cleanup Job:    Every 12 hours                    ║
║  📊 Database:       SQLite (data.db)                   ║
╚══════════════════════════════════════════════════════════╝
  `);
  
  console.log('📌 Endpoints:');
  console.log(`   GET /              → Frontend UI`);
  console.log(`   GET /api/current   → Latest conclusion`);
  console.log(`   GET /api/history   → Last 24 hours (max 100 events)`);
  console.log(`   GET /api/snapshot  → Specific timestamp`);
  console.log(`   GET /api/flight-path → Raw flight data`);
  console.log(`   GET /health        → Health check`);
});

// Run once on startup
setTimeout(async () => {
  await runCronJob();
}, 1000);