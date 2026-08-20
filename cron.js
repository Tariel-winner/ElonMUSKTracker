const fetch = require('node-fetch');
const fs = require('fs');
const db = require('./db');
const cache = require('./memory-cache');
const { generateConclusion } = require('./ai-correlator');
const { inferLocationWhenGrounded } = require('./location-inference');
const staticData = require('./static-data');
const { askDeepSeek } = require('./deepseek-client');

// --- OpenSky OAuth2 Token Management with Persistent Cache ---
const TOKEN_CACHE_FILE = '/tmp/opensky_token_cache.json';

let openSkyToken = null;
let tokenExpiry = null;
const CLIENT_ID = "tarel.tarik23@gmail.com-api-client";
const CLIENT_SECRET = "yEluqjz2pROsOSHXqPYhX3rBg2edHR4U";

// Check if running on Railway
const isRailway = !!process.env.RAILWAY_SERVICE_ID;

// Load token from file cache on startup
function loadTokenFromCache() {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      if (data.token && data.expiry && Date.now() < data.expiry - 60000) {
        openSkyToken = data.token;
        tokenExpiry = data.expiry;
        console.log(`[CRON] ✅ Loaded cached token (expires in ${Math.round((tokenExpiry - Date.now()) / 60000)} min)`);
        return true;
      }
    }
  } catch (e) {
    // Ignore cache errors
  }
  return false;
}

// Save token to file cache
function saveTokenToCache(token, expiry) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({
      token: token,
      expiry: expiry
    }));
  } catch (e) {
    // Ignore write errors
  }
}

async function getOpenSkyToken() {
  // On Railway, skip OAuth2 entirely (avoid ETIMEDOUT)
  if (isRailway) {
    console.log('[CRON] 🚀 Running on Railway: Skipping OAuth2, using anonymous access.');
    return null;
  }
  
  // Try to load from cache if not already loaded
  if (!openSkyToken || !tokenExpiry) {
    loadTokenFromCache();
  }
  
  // If token is still valid (within 2 min of expiry), return it
  if (openSkyToken && tokenExpiry && Date.now() < tokenExpiry - 120000) {
    return openSkyToken;
  }
  
  try {
    console.log('[CRON] 🔑 Requesting new OpenSky OAuth2 token...');
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
        timeout: 10000
      }
    );
    
    if (!response.ok) {
      throw new Error(`Token request failed: ${response.status}`);
    }
    
    const data = await response.json();
    openSkyToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);
    
    // Save to file cache
    saveTokenToCache(openSkyToken, tokenExpiry);
    
    console.log(`[CRON] ✅ OpenSky OAuth2 token obtained (expires in ${data.expires_in}s)`);
    return openSkyToken;
  } catch (err) {
    console.error('[CRON] ❌ Failed to get OpenSky token:', err.message);
    // If token fails, use anonymous access
    return null;
  }
}

// --- DeepSeek API Caching ---
let lastDeepSeekCallTime = 0;
let lastDeepSeekResult = null;
const DEEPSEEK_CACHE_TTL = 3600000; // 60 minutes

// Helper: Normalize location names to avoid false mismatches
function normalizeLocation(name) {
  if (!name) return name;
  const map = {
    'Austin-Bergstrom Airport': 'Tesla HQ',
    'Teterboro Airport': 'Manhattan Penthouse',
    'Van Nuys Airport': 'Bel Air Mansion',
    'Austin Ranch': 'Austin Ranch',
    'Bel Air Mansion': 'Bel Air Mansion',
    'Manhattan Penthouse': 'Manhattan Penthouse',
    'SpaceX HQ': 'SpaceX HQ',
    'Tesla HQ': 'Tesla HQ',
    'xAI HQ': 'xAI HQ',
    'The Boring Company HQ': 'The Boring Company HQ',
    'Neuralink HQ': 'Neuralink HQ',
    'Lake Austin Property': 'Lake Austin Property',
    'Jackson Hole Property': 'Jackson Hole Property',
  };
  return map[name] || name;
}

// Helper: Calculate heading from two positions
function calculateHeadingFromPositions(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  
  const lat1Rad = lat1 * Math.PI / 180;
  const lon1Rad = lon1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const lon2Rad = lon2 * Math.PI / 180;
  
  const dLon = lon2Rad - lon1Rad;
  
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - 
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  
  let heading = Math.atan2(y, x) * 180 / Math.PI;
  heading = (heading + 360) % 360;
  return heading;
}

// Helper: Find nearest property (includes ALL property types)
function findNearestProperty(lat, lng) {
  const allProps = [
    ...staticData.corporate_hqs,
    ...staticData.residences,
    ...(staticData.family_properties || []),
    ...(staticData.friends_properties || []),
    ...(staticData.frequent_destinations || [])
  ];
  let nearest = null;
  let minDist = Infinity;
  
  for (const prop of allProps) {
    if (!prop.lat || !prop.lng) continue;
    const d = haversine(lat, lng, prop.lat, prop.lng);
    if (d < minDist) {
      minDist = d;
      nearest = prop;
    }
  }
  return nearest;
}

// Helper: Haversine distance
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function runCronJob() {
  console.log('[CRON] Fetching data at', new Date().toISOString());

  try {
    // --- 1. Get OAuth2 Token (cached, skips on Railway) ---
    const token = await getOpenSkyToken();
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      console.log('[CRON] Using OAuth2 authentication');
    } else {
      console.log('[CRON] Using anonymous access');
    }
    
    // --- 2. Fetch flight data with timeout ---
    let adsbRes;
    try {
      adsbRes = await fetch('https://opensky-network.org/api/states/all?time=0', { 
        headers,
        timeout: 15000
      });
    } catch (fetchErr) {
      if (fetchErr.message.includes('ETIMEDOUT') || fetchErr.message.includes('connect')) {
        console.warn('[CRON] ⚠️ OpenSky API timed out. Using cached data.');
        if (cache.currentFlight) {
          console.log('[CRON] Using cached flight data from', cache.currentFlight.timestamp);
        }
        return;
      }
      throw fetchErr;
    }
    
    // If rate limited, retry with exponential backoff
    if (adsbRes.status === 429) {
      console.warn('[CRON] ⚠️ Rate limited. Retrying with exponential backoff...');
      let retryDelay = 5000;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryCount++;
        console.warn(`[CRON] Retry ${retryCount}/${maxRetries} after ${retryDelay}ms...`);
        
        // Refresh token before retry (or skip on Railway)
        const newToken = await getOpenSkyToken();
        const retryHeaders = {};
        if (newToken) {
          retryHeaders['Authorization'] = `Bearer ${newToken}`;
        }
        
        adsbRes = await fetch('https://opensky-network.org/api/states/all?time=0', { headers: retryHeaders, timeout: 15000 });
        
        if (adsbRes.ok) {
          console.warn('[CRON] ✅ Retry successful!');
          break;
        }
        
        if (adsbRes.status !== 429) {
          throw new Error(`OpenSky API returned ${adsbRes.status}`);
        }
        
        // Double the delay for next retry (exponential backoff)
        retryDelay *= 2;
      }
      
      if (!adsbRes.ok && adsbRes.status === 429) {
        console.warn('[CRON] ⚠️ Still rate limited after retries. Skipping this cycle.');
        return;
      }
    }
    
    if (!adsbRes.ok) {
      throw new Error(`OpenSky API returned ${adsbRes.status}`);
    }
    
    // Check rate limit headers
    const remaining = adsbRes.headers.get('x-rate-limit-remaining');
    if (remaining) {
      console.log(`[CRON] 📊 Credits remaining: ${remaining}`);
    }
    
    const adsbData = await adsbRes.json();
    const states = adsbData.states || [];
    const flightState = states.find(f => f[1] && f[1].trim() === 'N628TS');

    const now = new Date().toISOString();

    // --- 3. IF JET IS FLYING ---
    if (flightState) {
      const flight = {
        lat: flightState[6],
        lon: flightState[5],
        alt_baro: flightState[7],
        on_ground: flightState[8],
        gs: flightState[9],
        track: flightState[10],
        vert_rate: flightState[11],
        timestamp: flightState[4],
        callsign: flightState[1],
        icao24: flightState[0]
      };

      console.log(`[CRON] Jet found: ${flight.callsign} at ${flight.lat}, ${flight.lon}`);

      // --- Insert raw flight data (sqlite3 callback) ---
      db.run(
        `INSERT INTO raw_flight_data (timestamp, lat, lng, altitude, speed, heading, on_ground, vert_rate, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, flight.lat, flight.lon, flight.alt_baro, flight.gs, flight.track, flight.on_ground ? 1 : 0, flight.vert_rate, JSON.stringify(flight)],
        (err) => { if (err) console.error('[DB] Insert flight error:', err); }
      );

      const prev = cache.currentFlight;
      let landingDetected = false;
      let trafficData = null;

      // Reset DeepSeek cache if jet took off
      if (prev && prev.on_ground === 1 && flight.on_ground === 0) {
        lastDeepSeekCallTime = 0;
        lastDeepSeekResult = null;
        console.log('[CRON] Jet took off - DeepSeek cache reset.');
      }

      if (prev && prev.on_ground === 0 && flight.on_ground === 1) {
        landingDetected = true;
        cache.landingDetected = true;
        cache.lastLandingTime = now;
        console.log('[CRON] LANDING DETECTED at', flight.lat, flight.lon);

        lastDeepSeekCallTime = 0;
        lastDeepSeekResult = null;
        console.log('[CRON] Landing detected - DeepSeek cache reset for fresh ground analysis.');

        try {
          const wazeUrl = `https://www.waze.com/row-rtserver/web/TGeoRSS?tk=0&format=JSON&lon=${flight.lon}&lat=${flight.lat}&zoom=12`;
          const wazeRes = await fetch(wazeUrl);
          if (wazeRes.ok) trafficData = await wazeRes.json();
        } catch (wazeErr) {
          console.log('[CRON] Waze error:', wazeErr.message);
        }
      }

      // --- FALLBACK: If heading is missing, use previous or calculated ---
      let heading = flight.track;
      let headingSource = 'OpenSky';
      
      const hasValidHeading = heading !== null && heading !== undefined && heading !== 0;
      
      if (!hasValidHeading) {
        if (cache.previousFlight && cache.previousFlight.heading && cache.previousFlight.heading !== 0) {
          heading = cache.previousFlight.heading;
          headingSource = 'cache';
          console.log(`[CRON] Using cached heading: ${heading.toFixed(1)}°`);
        } else if (cache.previousFlight && cache.previousFlight.lat && cache.previousFlight.lng) {
          const calculated = calculateHeadingFromPositions(
            cache.previousFlight.lat,
            cache.previousFlight.lng,
            flight.lat,
            flight.lon
          );
          if (calculated !== null && calculated !== 0) {
            heading = calculated;
            headingSource = 'calculated';
            console.log(`[CRON] Calculated heading from position: ${heading.toFixed(1)}°`);
          } else {
            console.log('[CRON] Could not calculate heading - positions too close or invalid.');
          }
        } else {
          console.log('[CRON] No previous position available for heading calculation.');
        }
      } else {
        console.log(`[CRON] OpenSky heading: ${heading}°`);
      }

      // --- Build conclusion ---
      const conclusion = generateConclusion({
        lat: flight.lat,
        lng: flight.lon,
        on_ground: flight.on_ground ? 1 : 0,
        altitude: flight.alt_baro || 0,
        speed: flight.gs || 0,
        heading: heading || 0,
        vert_rate: flight.vert_rate || 0,
      }, trafficData);

      // --- If destination is Unknown and we have a heading, try one more time ---
      if (conclusion.destination === 'Unknown' && heading && heading !== 0) {
        const prediction = predictDestinationByHeading(flight.lat, flight.lng, heading);
        if (prediction) {
          conclusion.destination = prediction.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.25);
          conclusion.reasoning.push(`Heading ${heading.toFixed(1)}° (${headingSource}) points toward ${prediction.name}.`);
          console.log(`[CRON] Heading ${heading.toFixed(1)}° → ${prediction.name}`);
        } else {
          console.log(`[CRON] Heading ${heading.toFixed(1)}° does not point to any known property.`);
        }
      }

      // --- Nearest property fallback (when heading doesn't match) ---
      if (conclusion.destination === 'Unknown') {
        const nearest = findNearestProperty(flight.lat, flight.lng);
        if (nearest && haversine(flight.lat, flight.lng, nearest.lat, nearest.lng) < 200) {
          const dist = Math.round(haversine(flight.lat, flight.lng, nearest.lat, nearest.lng));
          conclusion.destination = nearest.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.15);
          conclusion.reasoning.push(`Using nearest property: ${nearest.name} (${dist} miles).`);
          console.log(`[CRON] Nearest property fallback: ${nearest.name} (${dist} miles)`);
        } else {
          console.log('[CRON] No nearby properties found within 200 miles.');
        }
      }

      // --- Save conclusion (sqlite3 callback) ---
      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      cache.previousFlight = cache.currentFlight;
      cache.currentFlight = {
        lat: flight.lat, lng: flight.lon, on_ground: flight.on_ground,
        altitude: flight.alt_baro, speed: flight.gs, heading: flight.track,
        vert_rate: flight.vert_rate, timestamp: now,
      };
      cache.lastKnownLocation = {
        lat: flight.lat, lng: flight.lon,
        locationName: conclusion.current_location || 'Unknown',
        timestamp: now
      };
      cache.latestConclusion = conclusion;

      console.log(`[CRON] State: ${conclusion.state}, Destination: ${conclusion.destination || 'Unknown'}, Confidence: ${conclusion.confidence}`);

      if (conclusion.confidence === 0) {
        console.warn('[CRON] ⚠️ WARNING: Confidence is 0. Check heading data or property database.');
        console.warn(`[CRON] Debug - heading: ${heading}, headingSource: ${headingSource}, destination: ${conclusion.destination}`);
      }
    }

    // --- 4. IF JET IS NOT FLYING (Ground Inference with CACHED DeepSeek) ---
    else {
      console.log('[CRON] Jet not found - using cached DeepSeek AI.');

      const lastKnown = cache.lastKnownLocation || {
        lat: 34.0882, lng: -118.4420,
        locationName: 'Bel Air Mansion',
        timestamp: new Date().toISOString()
      };

      const nowMs = Date.now();
      
      // --- Proper cache validation ---
      const hasValidCache = lastDeepSeekResult !== null && 
                            lastDeepSeekResult.destination !== 'Unknown' &&
                            (nowMs - lastDeepSeekCallTime) < DEEPSEEK_CACHE_TTL;

      let conclusion;

      if (hasValidCache) {
        console.log('[CRON] Using cached DeepSeek result (avoiding API call).');
        conclusion = {
          ...lastDeepSeekResult,
          timestamp: now,
          prediction_type: 'grounded_inference_cached'
        };
      } else {
        console.log('[CRON] DeepSeek cache expired or no valid cache - calling API...');

        const prompt = `
          You are an expert analyst tracking Elon Musk.
          
          CURRENT CONTEXT:
          - Time: ${new Date().toLocaleString()}
          - Day: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}
          - Hour: ${new Date().getHours()}:00
          
          LAST KNOWN LOCATION:
          - Name: ${lastKnown.locationName || 'Unknown'}
          - Coordinates: ${lastKnown.lat}, ${lastKnown.lng}
          
          KNOWN PROPERTIES:
          ${JSON.stringify(staticData, null, 2)}
          
          TASK:
          Based on the time of day, day of week, and last known location, where is Elon Musk most likely RIGHT NOW?
          
          Return ONLY a JSON object with:
          - "destination": the most likely location name
          - "confidence": a number between 0 and 1
          - "reasoning": a list of 2-3 sentences explaining your logic
        `;

        const deepSeekResponse = await askDeepSeek(prompt);
        
        if (deepSeekResponse) {
          try {
            const aiResult = JSON.parse(deepSeekResponse);
            conclusion = {
              state: 'grounded',
              current_location: lastKnown.locationName || 'Unknown',
              destination: aiResult.destination || 'Unknown',
              confidence: aiResult.confidence || 0.3,
              reasoning: Array.isArray(aiResult.reasoning) ? aiResult.reasoning : [aiResult.reasoning || 'AI analysis complete'],
              prediction_type: 'grounded_inference_deepseek',
              timestamp: now
            };
            lastDeepSeekResult = conclusion;
            lastDeepSeekCallTime = nowMs;
            console.log('[DEEPSEEK] AI analysis completed and cached.');
          } catch (e) {
            console.log('[DEEPSEEK] Parse error, using raw response:', deepSeekResponse);
            conclusion = {
              state: 'grounded',
              current_location: lastKnown.locationName || 'Unknown',
              destination: 'Unknown',
              confidence: 0.3,
              reasoning: [deepSeekResponse],
              prediction_type: 'grounded_inference_deepseek_raw',
              timestamp: now
            };
          }
        } else {
          console.log('[DEEPSEEK] API failed, falling back to rule-based logic.');
          const fallback = inferLocationWhenGrounded(lastKnown, staticData, cache, null);
          conclusion = {
            state: 'grounded',
            current_location: lastKnown.locationName || 'Unknown',
            destination: fallback.destination,
            confidence: fallback.confidence,
            reasoning: fallback.reasoning,
            prediction_type: 'grounded_inference_fallback',
            timestamp: now
          };
        }
      }

      // --- Final fallback: nearest property ---
      if (conclusion.destination === 'Unknown') {
        const nearest = findNearestProperty(lastKnown.lat, lastKnown.lng);
        if (nearest) {
          conclusion.destination = nearest.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.15);
          conclusion.reasoning.push(`Final fallback: nearest property ${nearest.name}.`);
        }
      }

      // --- Save conclusion (sqlite3 callback) ---
      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      cache.latestConclusion = conclusion;
      if (conclusion.destination && conclusion.destination !== 'Unknown') {
        cache.lastKnownLocation = {
          ...cache.lastKnownLocation,
          locationName: conclusion.destination,
          timestamp: now
        };
      }

      console.log(`[CRON] Ground inference: ${conclusion.destination} (${Math.round(conclusion.confidence * 100)}%)`);
    }

  } catch (err) {
    console.error('[CRON] Error:', err.message);
    console.error('[CRON] Stack:', err.stack);
  }
}

module.exports = { runCronJob };

// Helper: Predict destination by heading (ALL properties)
function predictDestinationByHeading(lat, lng, heading) {
  if (!heading || heading === 0) return null;
  
  const allProps = [
    ...staticData.corporate_hqs,
    ...staticData.residences,
    ...(staticData.family_properties || []),
    ...(staticData.friends_properties || []),
    ...(staticData.frequent_destinations || [])
  ];
  
  let best = null;
  let bestScore = 0;
  
  for (const prop of allProps) {
    if (!prop.lat || !prop.lng) continue;
    const dx = prop.lng - lng;
    const dy = prop.lat - lat;
    const angle = Math.atan2(dx, dy) * 180 / Math.PI;
    const diff = Math.abs((heading - angle + 360) % 360);
    if (diff < 90) {
      let score = 1 - (diff / 90);
      if (prop.type === 'family') score += 0.05;
      if (prop.type === 'friend') score += 0.03;
      if (prop.type === 'event') score += 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = prop;
      }
    }
  }
  return best;
}