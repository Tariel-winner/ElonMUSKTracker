const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = 3001;

// Cache file
const CACHE_FILE = path.join(__dirname, 'flight_cache.json');
let flightCache = {
  lastUpdated: null,
  data: null
};

// Load cache from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      flightCache = data;
      console.log(`[BRIDGE] ✅ Loaded cache from ${flightCache.lastUpdated}`);
    }
  } catch (e) {
    console.log('[BRIDGE] No cache found');
  }
}

// Save cache to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(flightCache, null, 2));
  } catch (e) {
    console.error('[BRIDGE] Failed to save cache');
  }
}

// OpenSky credentials
const CLIENT_ID = "tarel.tarik23@gmail.com-api-client";
const CLIENT_SECRET = "yEluqjz2pROsOSHXqPYhX3rBg2edHR4U";
let openSkyToken = null;
let tokenExpiry = null;

// Get OAuth2 token
async function getOpenSkyToken() {
  if (openSkyToken && tokenExpiry && Date.now() < tokenExpiry - 120000) {
    return openSkyToken;
  }
  
  try {
    console.log('[BRIDGE] 🔑 Getting token...');
    const response = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET
        }),
        timeout: 15000
      }
    );
    
    if (!response.ok) throw new Error(`Token failed: ${response.status}`);
    
    const data = await response.json();
    openSkyToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);
    console.log('[BRIDGE] ✅ Token obtained');
    return openSkyToken;
  } catch (err) {
    console.error('[BRIDGE] ❌ Token error:', err.message);
    return null;
  }
}

// Fetch from OpenSky
async function fetchFlightData() {
  try {
    const token = await getOpenSkyToken();
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    console.log('[BRIDGE] 📡 Fetching flights...');
    const response = await fetch('https://opensky-network.org/api/states/all?time=0', {
      headers,
      timeout: 15000
    });
    
    if (!response.ok) {
      throw new Error(`OpenSky returned ${response.status}`);
    }
    
    const data = await response.json();
    
    flightCache = {
      lastUpdated: new Date().toISOString(),
      data: data
    };
    saveCache();
    
    console.log(`[BRIDGE] ✅ Fetched ${(data.states || []).length} flights`);
    return data;
    
  } catch (error) {
    console.error('[BRIDGE] ❌ Error:', error.message);
    if (flightCache.data) {
      console.log('[BRIDGE] ⚠️ Returning cached data');
      return flightCache.data;
    }
    throw error;
  }
}

// API endpoint for Railway
app.get('/api/flights', async (req, res) => {
  try {
    const data = await fetchFlightData();
    res.json({
      success: true,
      source: 'live',
      timestamp: new Date().toISOString(),
      data: data
    });
  } catch (error) {
    if (flightCache.data) {
      res.json({
        success: true,
        source: 'cache',
        timestamp: new Date().toISOString(),
        data: flightCache.data
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasCache: !!flightCache.data,
    cacheAge: flightCache.lastUpdated
  });
});

// Start server
loadCache();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║  🌉 OPENSKY BRIDGE SERVER                  ║
╠════════════════════════════════════════════╣
║  🚀 Port: ${PORT}                          ║
║  📊 Cache: ${flightCache.data ? '✅ Loaded' : '❌ Empty'} ║
║  📍 Endpoint: http://localhost:${PORT}/api/flights ║
╚════════════════════════════════════════════╝
  `);
});

// Auto-refresh every 30 seconds
cron.schedule('*/60 * * * * *', async () => {
  try {
    await fetchFlightData();
  } catch (e) {
    // Silent fail
  }
});

module.exports = app;