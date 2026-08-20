const fetch = require('node-fetch');
const fs = require('fs');
const db = require('./db');
const cache = require('./memory-cache');
const { generateConclusion } = require('./ai-correlator');
const { inferLocationWhenGrounded } = require('./location-inference');
const staticData = require('./static-data');
const { askDeepSeek } = require('./deepseek-client');

// --- CONFIGURATION ---
// Set BRIDGE_URL in Railway environment variables
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3001';

// --- Railway Local Cache (fallback when bridge is down) ---
const RAILWAY_CACHE_FILE = '/tmp/railway_cache.json';
let railwayCache = null;

function loadRailwayCache() {
  try {
    if (fs.existsSync(RAILWAY_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RAILWAY_CACHE_FILE, 'utf8'));
      railwayCache = data;
      console.log('[CRON] ✅ Loaded Railway cache from', railwayCache.timestamp);
      return true;
    }
  } catch (e) {
    console.log('[CRON] No Railway cache found');
  }
  return false;
}

function saveRailwayCache(data) {
  try {
    fs.writeFileSync(RAILWAY_CACHE_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      data: data
    }));
    console.log('[CRON] 💾 Saved Railway cache');
  } catch (e) {
    console.error('[CRON] Failed to save cache:', e.message);
  }
}

// --- DeepSeek API Caching ---
let lastDeepSeekCallTime = 0;
let lastDeepSeekResult = null;
const DEEPSEEK_CACHE_TTL = 3600000; // 60 minutes

// --- Helper Functions ---
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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

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

// --- MAIN CRON FUNCTION ---
async function runCronJob() {
  console.log('[CRON] Fetching data at', new Date().toISOString());

  try {
    // --- 1. Fetch from Bridge (with ngrok bypass header) ---
    let adsbData = null;
    let fromCache = false;
    let dataSource = 'unknown';
    
    try {
      console.log('[CRON] 📡 Calling bridge...');
      
      const bridgeResponse = await fetch(`${BRIDGE_URL}/api/flights`, {
        timeout: 20000,
        headers: {
          'ngrok-skip-browser-warning': 'true',  // Bypass ngrok warning page
          'User-Agent': 'ElonTracker/1.0'         // Custom user agent
        }
      });
      
      if (bridgeResponse.ok) {
        const bridgeResult = await bridgeResponse.json();
        if (bridgeResult.success && bridgeResult.data) {
          adsbData = bridgeResult.data;
          dataSource = bridgeResult.source || 'live';
          console.log(`[CRON] ✅ Data from bridge (${dataSource})`);
          
          // Save to Railway cache for fallback
          saveRailwayCache(adsbData);
        } else {
          throw new Error('Bridge returned invalid data structure');
        }
      } else {
        throw new Error(`Bridge responded with ${bridgeResponse.status}`);
      }
    } catch (bridgeError) {
      console.warn('[CRON] ⚠️ Bridge error:', bridgeError.message);
      dataSource = 'cache_fallback';
      
      // Try Railway file cache
      if (loadRailwayCache() && railwayCache && railwayCache.data) {
        adsbData = railwayCache.data;
        fromCache = true;
        console.log('[CRON] ✅ Using Railway cache from', railwayCache.timestamp);
      } 
      // Fallback to memory cache
      else if (cache.currentFlight) {
        console.log('[CRON] ⚠️ Using memory cache (last known flight state)');
        // Don't return - keep using the cached flight data
        // The flightState will be null, and we'll use the cached flight data below
      } 
      else {
        throw new Error('No data available from any source');
      }
    }
    
    // --- 2. Process the data ---
    // If we have adsbData from bridge or cache, use it to find flight
    let flightState = null;
    let isUsingCachedFlight = false;
    
    if (adsbData) {
      const states = adsbData.states || [];
      flightState = states.find(f => f[1] && f[1].trim() === 'N628TS');
      console.log(`[CRON] Found ${states.length} states in data, N628TS: ${flightState ? '✅ found' : '❌ not found'}`);
    }
    
    // If no flight in current data but we have a cached flight in memory, use it
    if (!flightState && cache.currentFlight) {
      console.log('[CRON] ⚠️ No flight in current data, keeping previous flight state in memory');
      isUsingCachedFlight = true;
      // We'll use the cached flight data below
    }
    
    const now = new Date().toISOString();

    // --- 3. IF JET IS FLYING (or we have cached flight data) ---
    if (flightState || isUsingCachedFlight) {
      // Use flightState if available, otherwise use cached flight
      const flight = flightState ? {
        lat: flightState[6],
        lon: flightState[5],
        alt_baro: flightState[7],
        on_ground: flightState[8],
        gs: flightState[9],
        track: flightState[10],
        vert_rate: flightState[11],
        timestamp: flightState[4],
        callsign: flightState[1] || 'N628TS',
        icao24: flightState[0] || 'ac5e8d'
      } : cache.currentFlight;

      if (flightState) {
        console.log(`[CRON] Jet found: ${flight.callsign} at ${flight.lat}, ${flight.lon}`);
      } else {
        console.log(`[CRON] Using cached flight data from ${cache.currentFlight.timestamp}`);
      }

      // Insert raw flight data (if live data, not cached)
      if (flightState) {
        db.run(
          `INSERT INTO raw_flight_data (timestamp, lat, lng, altitude, speed, heading, on_ground, vert_rate, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [now, flight.lat, flight.lon, flight.alt_baro, flight.gs, flight.track, flight.on_ground ? 1 : 0, flight.vert_rate, JSON.stringify(flight)],
          (err) => { if (err) console.error('[DB] Insert flight error:', err); }
        );
      }

      const prev = cache.currentFlight;
      let trafficData = null;

      // Reset DeepSeek cache if jet took off
      if (prev && prev.on_ground === 1 && flight.on_ground === 0) {
        lastDeepSeekCallTime = 0;
        lastDeepSeekResult = null;
        console.log('[CRON] Jet took off - DeepSeek cache reset.');
      }

      // Detect landing
      if (prev && prev.on_ground === 0 && flight.on_ground === 1) {
        cache.landingDetected = true;
        cache.lastLandingTime = now;
        console.log('[CRON] LANDING DETECTED at', flight.lat, flight.lon);

        lastDeepSeekCallTime = 0;
        lastDeepSeekResult = null;
        console.log('[CRON] Landing detected - DeepSeek cache reset.');

        // Get traffic data if available
        try {
          const wazeUrl = `https://www.waze.com/row-rtserver/web/TGeoRSS?tk=0&format=JSON&lon=${flight.lon}&lat=${flight.lat}&zoom=12`;
          const wazeRes = await fetch(wazeUrl);
          if (wazeRes.ok) trafficData = await wazeRes.json();
        } catch (wazeErr) {
          console.log('[CRON] Waze error:', wazeErr.message);
        }
      }

      // --- Heading fallback ---
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
            console.log(`[CRON] Calculated heading: ${heading.toFixed(1)}°`);
          }
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

      // --- If destination Unknown, try heading prediction ---
      if (conclusion.destination === 'Unknown' && heading && heading !== 0) {
        const prediction = predictDestinationByHeading(flight.lat, flight.lng, heading);
        if (prediction) {
          conclusion.destination = prediction.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.25);
          conclusion.reasoning.push(`Heading ${heading.toFixed(1)}° points toward ${prediction.name}.`);
          console.log(`[CRON] Heading ${heading.toFixed(1)}° → ${prediction.name}`);
        }
      }

      // --- Nearest property fallback ---
      if (conclusion.destination === 'Unknown') {
        const nearest = findNearestProperty(flight.lat, flight.lng);
        if (nearest && haversine(flight.lat, flight.lng, nearest.lat, nearest.lng) < 200) {
          const dist = Math.round(haversine(flight.lat, flight.lng, nearest.lat, nearest.lng));
          conclusion.destination = nearest.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.15);
          conclusion.reasoning.push(`Using nearest property: ${nearest.name} (${dist} miles).`);
          console.log(`[CRON] Nearest property: ${nearest.name} (${dist} miles)`);
        }
      }

      // Add data source info to conclusion
      conclusion.data_source = dataSource;
      conclusion.from_cache = fromCache || isUsingCachedFlight;

      // --- Save conclusion ---
      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      // Update cache (only if we have live data, not cached)
      if (flightState) {
        cache.previousFlight = cache.currentFlight;
        cache.currentFlight = {
          lat: flight.lat, lng: flight.lon, on_ground: flight.on_ground,
          altitude: flight.alt_baro, speed: flight.gs, heading: flight.track,
          vert_rate: flight.vert_rate, timestamp: now,
        };
      }
      
      cache.lastKnownLocation = {
        lat: flight.lat, lng: flight.lon,
        locationName: conclusion.current_location || 'Unknown',
        timestamp: now
      };
      cache.latestConclusion = conclusion;

      console.log(`[CRON] State: ${conclusion.state}, Destination: ${conclusion.destination || 'Unknown'}, Confidence: ${conclusion.confidence}`);
      console.log(`[CRON] Data source: ${dataSource}${fromCache ? ' (cached)' : ''}`);
    }

    // --- 4. IF JET IS NOT FLYING (Ground Inference) ---
    else {
      console.log('[CRON] Jet not found - using ground inference.');

      const lastKnown = cache.lastKnownLocation || {
        lat: 34.0882, lng: -118.4420,
        locationName: 'Bel Air Mansion',
        timestamp: new Date().toISOString()
      };

      const nowMs = Date.now();
      
      const hasValidCache = lastDeepSeekResult !== null && 
                            lastDeepSeekResult.destination !== 'Unknown' &&
                            (nowMs - lastDeepSeekCallTime) < DEEPSEEK_CACHE_TTL;

      let conclusion;

      if (hasValidCache) {
        console.log('[CRON] Using cached DeepSeek result.');
        conclusion = {
          ...lastDeepSeekResult,
          timestamp: now,
          prediction_type: 'grounded_inference_cached',
          data_source: dataSource,
          from_cache: fromCache
        };
      } else {
        console.log('[CRON] Calling DeepSeek API...');

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
              timestamp: now,
              data_source: dataSource,
              from_cache: fromCache
            };
            lastDeepSeekResult = conclusion;
            lastDeepSeekCallTime = nowMs;
            console.log('[DEEPSEEK] AI analysis completed and cached.');
          } catch (e) {
            console.log('[DEEPSEEK] Parse error, using raw response');
            conclusion = {
              state: 'grounded',
              current_location: lastKnown.locationName || 'Unknown',
              destination: 'Unknown',
              confidence: 0.3,
              reasoning: [deepSeekResponse],
              prediction_type: 'grounded_inference_deepseek_raw',
              timestamp: now,
              data_source: dataSource,
              from_cache: fromCache
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
            timestamp: now,
            data_source: 'fallback',
            from_cache: true
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

      // --- Save conclusion ---
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
    console.error('[CRON] ❌ Error:', err.message);
    console.error('[CRON] Stack:', err.stack);
    
    // Don't throw - keep the service running with cached data
    console.log('[CRON] ⚠️ Keeping cached data for next cycle');
  }
}

module.exports = { runCronJob };