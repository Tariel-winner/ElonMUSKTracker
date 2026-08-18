const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { runCronJob } = require('./cron');
const cache = require('./memory-cache');
const history = require('./history');

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
    res.json(rows);
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
// CRON JOB (Every 30 seconds)
// =============================================

cron.schedule('*/30 * * * * *', async () => {
  await runCronJob();
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
║  ⏰ Cron Job:       Every 30 seconds                   ║
║  📊 Database:       SQLite (data.db)                   ║
╚══════════════════════════════════════════════════════════╝
  `);
  
  console.log('📌 Endpoints:');
  console.log(`   GET /              → Frontend UI`);
  console.log(`   GET /api/current   → Latest conclusion`);
  console.log(`   GET /api/history   → Last 24 hours`);
  console.log(`   GET /api/snapshot  → Specific timestamp`);
  console.log(`   GET /api/flight-path → Raw flight data`);
  console.log(`   GET /health        → Health check`);
});

// Run once on startup
setTimeout(async () => {
  await runCronJob();
}, 1000);