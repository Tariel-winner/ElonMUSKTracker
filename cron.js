const fetch = require('node-fetch');
const fs = require('fs');
const db = require('./db');
const { cache, updateObservation, updateInference, clearInference, getCurrentState, hydrateLastObservationFromDb, isLastObservationFreshEnoughForAi } = require('./memory-cache');
const { generateConclusion } = require('./ai-correlator');
const { inferLocationWhenGrounded } = require('./location-inference');
const staticData = require('./static-data');
const { askDeepSeek } = require('./deepseek-client');
const history = require('./history');

// --- CONFIGURATION ---
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3001';
const RAILWAY_CACHE_FILE = '/tmp/railway_cache.json';

// --- Constants ---
const MAX_PROPERTY_DISTANCE_MILES = 50;
const MAX_HEADING_ANGLE_DEG = 45;
const MIN_CONFIDENCE_FOR_DESTINATION = 0.3;
const AI_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — keeps ~24 calls/day if always no_signal
const AI_MAX_CALLS_PER_DAY = 40;

let railwayCache = null;
let lastAiResult = null;
let lastAiCallTime = 0;
let lastAiCacheKey = null;
let aiCallsToday = 0;
let aiCallsDayKey = null;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day
}

function canCallAi() {
  const day = todayKey();
  if (aiCallsDayKey !== day) {
    aiCallsDayKey = day;
    aiCallsToday = 0;
  }
  return aiCallsToday < AI_MAX_CALLS_PER_DAY;
}

function recordAiCall() {
  const day = todayKey();
  if (aiCallsDayKey !== day) {
    aiCallsDayKey = day;
    aiCallsToday = 0;
  }
  aiCallsToday += 1;
  console.log(`[DEEPSEEK] Calls today: ${aiCallsToday}/${AI_MAX_CALLS_PER_DAY}`);
}

function buildAiCacheKey(lastKnown) {
  if (!lastKnown) return 'none';
  const lat = Number(lastKnown.lat).toFixed(2);
  const lng = Number(lastKnown.lng).toFixed(2);
  return `${lat},${lng}`;
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      return null;
    }
  }
}

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

/** Compass label from degrees (0 = North). */
function headingToCardinal(deg) {
  if (!isValidHeading(deg)) return 'unknown direction';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return dirs[i];
}

/** Rough region from lat/lng (no external geocoder). */
function roughRegion(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'unknown area';
  // Very coarse US-centric bands for study UI
  if (lat > 49 && lng < -95) return 'northern plains / Canada border area';
  if (lat > 40 && lng > -80) return 'US Northeast / Mid-Atlantic area';
  if (lat > 40 && lng > -95 && lng <= -80) return 'US Midwest area';
  if (lat > 40 && lng <= -95) return 'US Northwest / northern Rockies area';
  if (lat > 30 && lng > -85) return 'US Southeast area';
  if (lat > 30 && lng > -100 && lng <= -85) return 'US South-Central area';
  if (lat > 30 && lng <= -100) return 'US Southwest / southern Rockies area';
  if (lat > 24 && lng > -100) return 'Gulf / South Texas area';
  if (lat > 24 && lng <= -100) return 'Southwest / Baja-adjacent area';
  return `${lat.toFixed(2)}°N, ${Math.abs(lng).toFixed(2)}°W`;
}

/** Nearest airport name if within maxMi. */
function nearestAirportLabel(lat, lng, maxMi = 80) {
  const airports = staticData.airports || [];
  let best = null;
  let bestD = Infinity;
  for (const a of airports) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;
    const d = haversine(lat, lng, a.lat, a.lng);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  if (best && bestD <= maxMi) {
    return `${best.name || best.code} (~${Math.round(bestD)} mi)`;
  }
  return null;
}

/**
 * Human explanation of where the aircraft is and which way it is going
 * (even when destination place is Unknown).
 */
function describeAirborneSituation(flight, heading) {
  const lat = flight.lat;
  const lon = flight.lon ?? flight.lng;
  const speed = flight.gs ?? flight.speed ?? 0;
  const alt = flight.alt_baro ?? flight.altitude;
  const region = roughRegion(lat, lon);
  const nearApt = nearestAirportLabel(lat, lon);
  const card = headingToCardinal(heading);
  const parts = [];

  parts.push(
    `Aircraft is airborne over the ${region}` +
      (nearApt ? `, near ${nearApt}` : '') +
      ` at ${Number(lat).toFixed(3)}°, ${Number(lon).toFixed(3)}°.`
  );

  if (isValidHeading(heading)) {
    parts.push(
      `Track/heading ≈ ${Number(heading).toFixed(0)}° (${card})` +
        (speed > 0 ? ` at ~${Math.round(speed)} kt` : '') +
        (alt != null ? `, alt ~${Math.round(alt)}` : '') +
        `.`
    );
  } else {
    parts.push('Heading not available from ADS-B.');
  }

  // Closest place in the direction of travel (info only — may still be Unknown dest)
  if (isValidHeading(heading)) {
    let best = null;
    let bestScore = Infinity;
    for (const p of staticData.getPlacesFor('in_flight')) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      const dist = haversine(lat, lon, p.lat, p.lng);
      if (dist > 800) continue;
      const brg = calculateBearing(lat, lon, p.lat, p.lng);
      if (brg == null) continue;
      const diff = angleDiff(heading, brg);
      // Prefer somewhat ahead; report even if outside tight cone
      if (diff < 90 && dist < bestScore) {
        bestScore = dist;
        best = { p, dist, diff };
      }
    }
    if (best) {
      parts.push(
        `No list place in the tight heading cone; nearest place somewhat ahead: ${best.p.name} (~${Math.round(best.dist)} mi, ${Math.round(best.diff)}° off track) — not set as destination.`
      );
    } else {
      parts.push('No known place from the study list lies roughly ahead on this track.');
    }
  }

  return parts;
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
    // After restart: restore last ADS-B from DB if < 1h old (keeps AI approx possible)
    await hydrateLastObservationFromDb(history);

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

      // Takeoff / landing edges — invalidate AI cache when flight returns
      if (prev && prev.on_ground === 1 && flight.on_ground === 0) {
        clearInference();
        lastAiResult = null;
        lastAiCacheKey = null;
        console.log('[CRON] Jet took off.');
      }

      // Detect landing
      if (prev && prev.on_ground === 0 && flight.on_ground === 1) {
        cache.landingDetected = true;
        cache.lastLandingTime = now;
        console.log('[CRON] LANDING DETECTED at', flight.lat, flight.lon);
        clearInference();
        lastAiResult = null;
        lastAiCacheKey = null;

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

      if (!flight.on_ground) {
        const explain = describeAirborneSituation(flight, heading);
        // Replace vague correlator line with concrete where / heading
        conclusion.reasoning = [
          ...explain,
          ...(conclusion.destination !== 'Unknown'
            ? [`Listed destination hypothesis: ${conclusion.destination}.`]
            : ['Destination place: Unknown (no strong match in places list).']),
        ];
        conclusion.current_location =
          `Airborne · ${roughRegion(flight.lat, flight.lon)} · ${headingToCardinal(heading)} (${isValidHeading(heading) ? heading.toFixed(0) + '°' : 'n/a'})`;
        conclusion.status_message =
          conclusion.destination !== 'Unknown'
            ? `In flight — ${headingToCardinal(heading)}; place hypothesis: ${conclusion.destination}.`
            : `In flight over ${roughRegion(flight.lat, flight.lon)}, heading ${headingToCardinal(heading)} — no matching place in list.`;
      } else {
        conclusion.status_message = conclusion.destination !== 'Unknown'
          ? 'Aircraft on ground — nearby place is a hypothesis only.'
          : 'Aircraft on ground — no strong place match.';
      }
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

    // --- 4. NO AIRCRAFT SIGNAL — last ADS-B + optional cached AI approximation ---
    else {
      console.log('[CRON] Jet not found — no_signal + optional AI hypothesis.');

      const lastKnown = cache.lastObservedPosition;
      const ageSec = lastKnown?.timestamp
        ? Math.round((Date.now() - new Date(lastKnown.timestamp).getTime()) / 1000)
        : null;

      const base = {
        state: 'no_signal',
        phase: 'no_signal',
        current_location: lastKnown
          ? `Last ADS-B: ${Number(lastKnown.lat).toFixed(4)}, ${Number(lastKnown.lng).toFixed(4)}`
          : 'No ADS-B observation yet',
        destination: 'Unknown',
        confidence: 0,
        hypothesis_type: null,
        status_message: lastKnown
          ? 'Aircraft not in feed — pin is last ADS-B. Any destination below is an unverified approximation.'
          : 'No aircraft data — waiting for ADS-B.',
        reasoning: [
          'No live aircraft state in bridge response.',
          lastKnown
            ? `Last observation age: ${ageSec != null ? ageSec + 's' : 'unknown'}.`
            : 'No prior observation in memory.',
        ],
        prediction_type: 'no_signal',
        timestamp: now,
        data_source: dataSource,
        from_cache: true,
      };

      let conclusion = { ...base };

      // Rules prior (nearby active place only) — weak, no AI yet
      if (lastKnown && Number.isFinite(lastKnown.lat) && Number.isFinite(lastKnown.lng)) {
        const rules = inferLocationWhenGrounded(
          { lat: lastKnown.lat, lng: lastKnown.lng, locationName: base.current_location },
          staticData,
          cache,
          null
        );
        if (rules.destination && rules.destination !== 'Unknown' && rules.confidence >= 0.25) {
          conclusion.destination = rules.destination;
          conclusion.confidence = Math.min(rules.confidence, 0.4);
          conclusion.hypothesis_type = 'rules_no_signal';
          conclusion.prediction_type = 'no_signal_rules';
          conclusion.reasoning = [...base.reasoning, ...rules.reasoning];
        }
      }

      // Budgeted DeepSeek: 1h cache per lastKnown cell, max 40/day
      const cacheKey = buildAiCacheKey(lastKnown);
      const nowMs = Date.now();
      const aiCacheFresh =
        lastAiResult &&
        lastAiCacheKey === cacheKey &&
        nowMs - lastAiCallTime < AI_CACHE_TTL_MS;

      if (aiCacheFresh) {
        console.log('[DEEPSEEK] Using 1h cached hypothesis.');
        conclusion = {
          ...conclusion,
          ...lastAiResult,
          current_location: base.current_location,
          phase: 'no_signal',
          state: 'no_signal',
          status_message: base.status_message,
          timestamp: now,
          prediction_type: 'no_signal_ai_cached',
          hypothesis_type: 'ai_unverified',
          from_cache: true,
          ai_calls_today: aiCallsToday,
        };
      } else if (lastKnown && isLastObservationFreshEnoughForAi() && canCallAi()) {
        const candidates = staticData
          .getPlacesFor('grounded')
          .slice(0, 25)
          .map((p) => ({
            name: p.name,
            type: p.type || p.category,
            lat: p.lat,
            lng: p.lng,
            weight: p.weight,
          }));

        const prompt = `
STUDY HYPOTHESIS (not live GPS).
Last ADS-B: lat=${lastKnown.lat}, lng=${lastKnown.lng}, age_sec=${ageSec}
UTC now: ${new Date().toISOString()}

Candidates (pick ONE name or Unknown):
${JSON.stringify(candidates, null, 2)}

Rules prior: ${conclusion.destination} (conf ${conclusion.confidence})

Task: If last ADS-B is near a candidate, you may pick it with confidence <= 0.45.
If unsure, destination must be "Unknown" and confidence 0.
Return ONLY JSON.
`;

        console.log('[DEEPSEEK] Calling API for no_signal hypothesis...');
        const raw = await askDeepSeek(prompt);
        recordAiCall();
        lastAiCallTime = nowMs;
        lastAiCacheKey = cacheKey;

        const aiResult = extractJsonObject(raw);
        if (aiResult) {
          let dest = aiResult.destination || 'Unknown';
          let conf = Number(aiResult.confidence) || 0;
          const allowed = new Set(candidates.map((c) => c.name).concat(['Unknown']));
          if (!allowed.has(dest)) {
            dest = 'Unknown';
            conf = 0;
          }
          conf = Math.min(conf, 0.45);

          const aiConclusion = {
            destination: dest,
            confidence: dest === 'Unknown' ? 0 : conf,
            reasoning: [
              ...base.reasoning,
              ...(Array.isArray(aiResult.reasoning) ? aiResult.reasoning : [String(aiResult.reasoning || 'AI hypothesis')]),
              'AI approximation only — not an observation.',
            ],
            prediction_type: 'no_signal_ai',
            hypothesis_type: 'ai_unverified',
          };
          lastAiResult = aiConclusion;
          conclusion = {
            ...conclusion,
            ...aiConclusion,
            current_location: base.current_location,
            phase: 'no_signal',
            state: 'no_signal',
            status_message: base.status_message,
            timestamp: now,
            data_source: dataSource,
            from_cache: false,
            ai_calls_today: aiCallsToday,
          };
          console.log(`[DEEPSEEK] Hypothesis: ${dest} (${Math.round(conf * 100)}%)`);
        } else {
          console.log('[DEEPSEEK] Parse failed — keeping rules/Unknown.');
        }
      } else if (lastKnown && !isLastObservationFreshEnoughForAi()) {
        conclusion.reasoning.push('Last ADS-B older than 1h — skipping AI approx (pin still shown if present).');
        console.log('[DEEPSEEK] Skip — last observation older than 1h.');
      } else if (!canCallAi()) {
        conclusion.reasoning.push(`AI daily budget exhausted (${AI_MAX_CALLS_PER_DAY}/day).`);
        console.log('[DEEPSEEK] Daily budget hit — skip call.');
      }

      // Never promote AI into observation
      db.run(
        `INSERT INTO ai_conclusions (timestamp, state, current_location, destination, confidence, reasoning, prediction_type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [now, conclusion.state, conclusion.current_location, conclusion.destination, conclusion.confidence, JSON.stringify(conclusion.reasoning), conclusion.prediction_type, JSON.stringify(conclusion)],
        (err) => { if (err) console.error('[DB] Insert conclusion error:', err); }
      );

      updateInference(conclusion);
      console.log(
        `[CRON] no_signal dest=${conclusion.destination} conf=${conclusion.confidence} type=${conclusion.hypothesis_type || 'none'}`
      );
    }

  } catch (err) {
    console.error('[CRON] ❌ Error:', err.message);
    console.error('[CRON] Stack:', err.stack);
    console.log('[CRON] ⚠️ Keeping cached data for next cycle');
  }
}

module.exports = { runCronJob };