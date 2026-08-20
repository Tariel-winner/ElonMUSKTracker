const fetch = require('node-fetch');
const fs = require('fs');
const db = require('./db');
const { cache, updateObservation, updateInference, clearInference, getCurrentState } = require('./memory-cache');
const { generateConclusion } = require('./ai-correlator');
const staticData = require('./static-data');
// location-inference / DeepSeek kept available for optional study experiments,
// but no_signal path no longer invents destinations without ADS-B.

// --- CONFIGURATION ---
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3001';
const RAILWAY_CACHE_FILE = '/tmp/railway_cache.json';

// --- Constants ---
const MAX_PROPERTY_DISTANCE_MILES = 50;
const MAX_HEADING_ANGLE_DEG = 45;
const MIN_CONFIDENCE_FOR_DESTINATION = 0.3;

let railwayCache = null;

// =============================================
// HELPERS
// =============================================

function loadRailwayCache() {
  try {
    if (fs.existsSync(RAILWAY_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RAILWAY_CACHE_FILE, 'utf8'));
      railwayCache = data;
      console.log('[CRON] ✅ Loaded Railway cache from', railwayCache.timestamp);
      return true;
    }
  } catch (e) {}
  return false;
}

function saveRailwayCache(data) {
  try {
    fs.writeFileSync(RAILWAY_CACHE_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      data: data
    }));
  } catch (e) {}
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x) * 180 / Math.PI;
  return (θ + 360) % 360;
}

function angleDiff(a, b) {
  let diff = ((a - b) % 360 + 360) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function isValidHeading(h) {
  return h !== null && h !== undefined && !isNaN(h);
}

/**
 * Nearest place using places[] + per-place max_radius + weight.
 * useCase: 'in_flight' | 'grounded'
 */
function findNearestProperty(lat, lng, maxDistance, useCase = 'grounded') {
  const { getPlacesFor, placeMaxRadius, placeWeight, coordQualityPenalty } = staticData;
  const candidates = getPlacesFor(useCase);
  
  let nearest = null;
  let bestScore = -Infinity;
  
  for (const prop of candidates) {
    if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) continue;
    const d = haversine(lat, lng, prop.lat, prop.lng);
    const radius = Math.min(placeMaxRadius(prop, maxDistance), maxDistance);
    if (d >= radius) continue;
    
    // Closer + higher weight + better coords wins
    const proximity = 1 - (d / radius);
    const score = proximity * placeWeight(prop) * coordQualityPenalty(prop);
    if (score > bestScore) {
      bestScore = score;
      nearest = prop;
    }
  }
  return nearest;
}

/**
 * Heading → destination using places[] fields (use_for, max_radius, weight).
 */
function predictDestinationByHeading(lat, lng, heading) {
  if (!isValidHeading(heading)) return null;
  
  const { getPlacesFor, placeMaxRadius, placeWeight, coordQualityPenalty, placeType } = staticData;
  const candidates = getPlacesFor('in_flight');
  
  let best = null;
  let bestScore = 0;
  
  for (const prop of candidates) {
    if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) continue;
    
    const distance = haversine(lat, lng, prop.lat, prop.lng);
    const maxR = placeMaxRadius(prop, 500);
    // In-flight targets can be farther than grounded radius, but still capped
    if (distance > Math.max(maxR * 8, 200)) continue;
    
    const bearing = calculateBearing(lat, lng, prop.lat, prop.lng);
    if (bearing === null) continue;
    
    const diff = angleDiff(heading, bearing);
    if (diff >= MAX_HEADING_ANGLE_DEG) continue;
    
    let score = (1 - diff / MAX_HEADING_ANGLE_DEG) * placeWeight(prop) * coordQualityPenalty(prop);
    const distancePenalty = Math.min(distance / 200, 1);
    score *= (1 - distancePenalty * 0.35);
    
    const t = placeType(prop);
    if (t === 'family' || prop.category === 'family') score += 0.03;
    if (t === 'friend' || prop.category === 'friend') score += 0.02;
    
    if (score > bestScore) {
      bestScore = score;
      best = prop;
    }
  }
  
  return best;
}

// =============================================
// MAIN CRON FUNCTION
// =============================================

async function runCronJob() {
  console.log('[CRON] Fetching data at', new Date().toISOString());

  try {
    // --- 1. Fetch from Bridge ---
    let adsbData = null;
    let fromCache = false;
    let dataSource = 'unknown';
    
    try {
      console.log('[CRON] 📡 Calling bridge...');
      const bridgeResponse = await fetch(`${BRIDGE_URL}/api/flights`, {
        timeout: 20000,
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'User-Agent': 'ElonTracker/1.0'
        }
      });
      
      if (bridgeResponse.ok) {
        const bridgeResult = await bridgeResponse.json();
        if (bridgeResult.success && bridgeResult.data) {
          adsbData = bridgeResult.data;
          dataSource = bridgeResult.source || 'live';
          console.log(`[CRON] ✅ Data from bridge (${dataSource})`);
          saveRailwayCache(adsbData);
        } else {
          throw new Error('Bridge returned invalid data');
        }
      } else {
        throw new Error(`Bridge responded with ${bridgeResponse.status}`);
      }
    } catch (bridgeError) {
      console.warn('[CRON] ⚠️ Bridge error:', bridgeError.message);
      dataSource = 'cache_fallback';
      
      if (loadRailwayCache() && railwayCache && railwayCache.data) {
        adsbData = railwayCache.data;
        fromCache = true;
        console.log('[CRON] ✅ Using Railway cache from', railwayCache.timestamp);
      } else if (cache.currentFlight) {
        console.log('[CRON] ⚠️ Using memory cache');
      } else {
        throw new Error('No data available');
      }
    }
    
    // --- 2. Find flight ---
    let flightState = null;
    let isUsingCachedFlight = false;
    
    if (adsbData) {
      const states = adsbData.states || [];
      flightState = states.find(f => f[1] && f[1].trim() === 'N628TS');
      console.log(`[CRON] N628TS: ${flightState ? '✅ found' : '❌ not found'}`);
    }
    
    if (!flightState && cache.currentFlight) {
      console.log('[CRON] ⚠️ Using cached flight data');
      isUsingCachedFlight = true;
    }
    
    const now = new Date().toISOString();

    // --- 3. IF JET IS FLYING ---
    if (flightState || isUsingCachedFlight) {
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
        console.log(`[CRON] Using cached flight from ${cache.currentFlight.timestamp}`);
      }

      // Insert raw flight data (only if live)
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

      // Takeoff / landing edges
      if (prev && prev.on_ground === 1 && flight.on_ground === 0) {
        clearInference();
        console.log('[CRON] Jet took off.');
      }

      // Detect landing
      if (prev && prev.on_ground === 0 && flight.on_ground === 1) {
        cache.landingDetected = true;
        cache.lastLandingTime = now;
        console.log('[CRON] LANDING DETECTED at', flight.lat, flight.lon);
        clearInference();

        try {
          const wazeUrl = `https://www.waze.com/row-rtserver/web/TGeoRSS?tk=0&format=JSON&lon=${flight.lon}&lat=${flight.lat}&zoom=12`;
          const wazeRes = await fetch(wazeUrl);
          if (wazeRes.ok) trafficData = await wazeRes.json();
        } catch (wazeErr) {
          console.log('[CRON] Waze error:', wazeErr.message);
        }
      }

      // --- Heading handling (0° = North is valid) ---
      let heading = flight.track;
      let headingSource = 'OpenSky';
      
      if (!isValidHeading(heading)) {
        if (cache.previousFlight && isValidHeading(cache.previousFlight.heading)) {
          heading = cache.previousFlight.heading;
          headingSource = 'cache';
          console.log(`[CRON] Using cached heading: ${heading.toFixed(1)}°`);
        } else if (cache.previousFlight && Number.isFinite(cache.previousFlight.lat) && Number.isFinite(cache.previousFlight.lng)) {
          const calculated = calculateBearing(
            cache.previousFlight.lat,
            cache.previousFlight.lng,
            flight.lat,
            flight.lon
          );
          if (calculated !== null && !isNaN(calculated)) {
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

      // --- Heading prediction (only while airborne and moving) ---
      const speed = flight.gs || 0;
      const isAirborneMoving = !flight.on_ground && speed > 50;

      if (
        conclusion.destination === 'Unknown' &&
        isAirborneMoving &&
        isValidHeading(heading)
      ) {
        const prediction = predictDestinationByHeading(flight.lat, flight.lon, heading);
        if (prediction) {
          const distance = haversine(flight.lat, flight.lon, prediction.lat, prediction.lng);
          if (distance < 200) {
            conclusion.destination = prediction.name;
            conclusion.confidence = Math.max(conclusion.confidence, 0.35);
            conclusion.hypothesis_type = 'heading';
            conclusion.reasoning.push(
              `Heading ${heading.toFixed(1)}° → ${prediction.name} (${distance.toFixed(0)} mi) [hypothesis].`
            );
            console.log(`[CRON] Heading ${heading.toFixed(1)}° → ${prediction.name} (${distance.toFixed(0)} mi)`);
          }
        }
      }

      // --- Nearest place only when ON GROUND (landed), not while flying ---
      if (conclusion.destination === 'Unknown' && flight.on_ground) {
        const nearest = findNearestProperty(flight.lat, flight.lon, MAX_PROPERTY_DISTANCE_MILES, 'grounded');
        if (nearest) {
          const dist = haversine(flight.lat, flight.lon, nearest.lat, nearest.lng);
          conclusion.destination = nearest.name;
          conclusion.confidence = Math.max(conclusion.confidence, 0.32);
          conclusion.hypothesis_type = 'nearest_on_ground';
          conclusion.reasoning.push(
            `On ground near ${nearest.name} (${dist.toFixed(0)} mi) [hypothesis].`
          );
          console.log(`[CRON] Nearest property: ${nearest.name} (${dist.toFixed(0)} mi)`);
        } else {
          conclusion.destination = 'Unknown';
          conclusion.confidence = 0;
          conclusion.reasoning.push('On ground — no known place within radius.');
        }
      }

      if (conclusion.confidence < MIN_CONFIDENCE_FOR_DESTINATION) {
        conclusion.destination = 'Unknown';
        conclusion.confidence = 0;
        conclusion.hypothesis_type = null;
      }

      conclusion.phase = flight.on_ground ? 'landed' : 'in_flight';
      conclusion.status_message = flight.on_ground
        ? (conclusion.destination !== 'Unknown'
          ? 'Aircraft on ground — nearby place is a hypothesis only.'
          : 'Aircraft on ground — no strong place match.')
        : (conclusion.destination !== 'Unknown'
          ? 'In flight — destination is a heading hypothesis only.'
          : 'In flight — tracking position; destination unknown.');
      conclusion.data_source = dataSource;
      conclusion.from_cache = fromCache || isUsingCachedFlight;

      // --- Save conclusion ---
      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      // ✅ Update observation (FACT) if we have live data
      if (flightState) {
        // Save previous BEFORE overwriting current
        cache.previousFlight = cache.currentFlight ? { ...cache.currentFlight } : null;

        const observation = {
          lat: flight.lat,
          lon: flight.lon,
          lng: flight.lon,
          on_ground: flight.on_ground,
          heading: heading,
          altitude: flight.alt_baro,
          speed: flight.gs,
          vert_rate: flight.vert_rate,
          timestamp: now,
          source: dataSource
        };
        updateObservation(observation);
      }
      
      // ✅ Update inference (GUESS) with conclusion
      updateInference(conclusion);

      console.log(`[CRON] State: ${conclusion.state}, Destination: ${conclusion.destination || 'Unknown'}, Confidence: ${conclusion.confidence}`);
      console.log(`[CRON] Data source: ${dataSource}${fromCache ? ' (cached)' : ''}`);
    }

    // --- 4. NO AIRCRAFT SIGNAL — honest, no invented destination ---
    else {
      console.log('[CRON] Jet not found — returning no_signal (no destination guess).');

      const lastKnown = cache.lastObservedPosition;
      const ageSec = lastKnown?.timestamp
        ? Math.round((Date.now() - new Date(lastKnown.timestamp).getTime()) / 1000)
        : null;

      const conclusion = {
        state: 'no_signal',
        phase: 'no_signal',
        current_location: lastKnown
          ? `Last ADS-B: ${Number(lastKnown.lat).toFixed(4)}, ${Number(lastKnown.lng).toFixed(4)}`
          : 'No ADS-B observation yet',
        destination: 'Unknown',
        confidence: 0,
        hypothesis_type: null,
        status_message: lastKnown
          ? 'Aircraft not in current feed — showing last observed position only. Destination unknown.'
          : 'No aircraft data — waiting for ADS-B.',
        reasoning: [
          'No live aircraft state in bridge response.',
          lastKnown
            ? `Last observation age: ${ageSec != null ? ageSec + 's' : 'unknown'}.`
            : 'No prior observation in memory.',
          'Skipping AI/person guess — not enough evidence.',
        ],
        prediction_type: 'no_signal',
        timestamp: now,
        data_source: dataSource,
        from_cache: true,
      };

      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      updateInference(conclusion);
      console.log('[CRON] no_signal — destination forced Unknown');
    }

  } catch (err) {
    console.error('[CRON] ❌ Error:', err.message);
    console.error('[CRON] Stack:', err.stack);
    console.log('[CRON] ⚠️ Keeping cached data for next cycle');
  }
}

module.exports = { runCronJob };