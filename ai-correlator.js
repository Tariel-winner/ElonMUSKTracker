const staticData = require('./static-data');
const db = require('./db');

/**
 * AI Correlation Engine
 * Input: flight data, traffic data (optional)
 * Output: conclusion object
 */
function generateConclusion(flight, trafficData) {
  const conclusion = {
    state: 'unknown',
    current_location: 'unknown',
    destination: 'unknown',
    confidence: 0.0,
    reasoning: [],
    prediction_type: 'unknown',
    timestamp: new Date().toISOString(),
  };

  // 1. Determine flight state
  if (flight.on_ground === 1) {
    conclusion.state = 'landed';
    conclusion.current_location = getAirportByCoords(flight.lat, flight.lng);
  } else {
    conclusion.state = 'in_flight';
    conclusion.current_location = `${flight.lat}, ${flight.lng}`;
  }

  // 2. If landed, find candidate destinations within 50 miles
  if (conclusion.state === 'landed') {
    const candidates = findNearbyProperties(flight.lat, flight.lng, 50);
    if (candidates.length === 0) {
      conclusion.destination = 'Unknown';
      conclusion.confidence = 0.0;
      conclusion.reasoning.push('No known properties within 50 miles.');
      return conclusion;
    }

    const sorted = candidates.sort((a, b) => a.dist - b.dist);
    const nearest = sorted[0];

    let trafficConfidence = 0.0;
    if (trafficData && trafficData.jams) {
      const route = getRoute(flight.lat, flight.lng, nearest.lat, nearest.lng);
      const jam = trafficData.jams.find(j => j.street && j.street.includes(route.street));
      if (jam) {
        trafficConfidence = 0.6;
        conclusion.reasoning.push(`Traffic jam detected on ${route.street} (confirms route).`);
      } else {
        conclusion.reasoning.push('No traffic jam detected on the expected route.');
      }
    }

    const historicalConfidence = getHistoricalConfidence(
      conclusion.current_location,
      nearest.name
    );

    let confidence = 0.0;
    // Base from geometry (places weight × proximity), not only historical anecdotes
    if (nearest.score != null) {
      confidence += Math.min(0.45, 0.25 + nearest.score * 0.35);
    } else if (nearest.dist != null) {
      confidence += Math.max(0.25, 0.45 * (1 - nearest.dist / 50));
    }
    if (historicalConfidence > 0.5) {
      confidence += historicalConfidence * 0.6;
      conclusion.reasoning.push(
        `Historical pattern: ${Math.round(historicalConfidence * 100)}% confidence.`
      );
    }
    if (trafficConfidence > 0) {
      confidence += trafficConfidence * 0.2;
    }

    // Add context about property type
    if (nearest.type === 'family') {
      const rel = nearest.relationship || 'family';
      const owner = nearest.owner || 'relative';
      conclusion.reasoning.push(`👨‍👩‍👧 Family property: ${owner} (${rel}).`);
    } else if (nearest.type === 'friend') {
      const owner = nearest.owner || 'friend';
      conclusion.reasoning.push(`🤝 Friend's property: ${owner}.`);
    } else if (nearest.type === 'event') {
      conclusion.reasoning.push(`🎪 Event destination: ${nearest.name}.`);
    }

    conclusion.confidence = Math.min(confidence, 0.99);
    conclusion.destination = nearest.name;
    conclusion.prediction_type = 'motorcade';
    conclusion.reasoning.push(`Nearest property: ${nearest.name} (${Math.round(nearest.dist)} miles).`);
  }

  // 7. If in flight, use heading to predict destination
  if (conclusion.state === 'in_flight') {
    const heading = flight.heading;
    const prediction = predictDestinationByHeading(flight.lat, flight.lng, heading);
    if (prediction) {
      conclusion.destination = prediction.name;
      conclusion.confidence = 0.3;
      conclusion.prediction_type = 'in_flight_prediction';
      
      // Add context about property type
      if (prediction.type === 'family') {
        const rel = prediction.relationship || 'family';
        conclusion.reasoning.push(`Heading ${heading}° points toward ${prediction.name} (${rel} property).`);
      } else if (prediction.type === 'friend') {
        conclusion.reasoning.push(`Heading ${heading}° points toward ${prediction.name} (friend's property).`);
      } else if (prediction.type === 'event') {
        conclusion.reasoning.push(`Heading ${heading}° points toward ${prediction.name} (event destination).`);
      } else {
        conclusion.reasoning.push(`Heading ${heading}° points toward ${prediction.name}.`);
      }
    } else {
      conclusion.destination = 'Unknown';
      conclusion.confidence = 0.0;
      const h = flight.heading;
      const dir = (h !== null && h !== undefined && !isNaN(h))
        ? `${Math.round(h)}°`
        : 'unknown';
      conclusion.reasoning.push(
        `No listed place matches this heading (${dir}). Position ${flight.lat}, ${flight.lng} is still tracked.`
      );
    }
  }

  return conclusion;
}

// Helper: Find properties within radius using places[] schema
function findNearbyProperties(lat, lng, radiusMiles) {
  const results = [];
  const {
    getPlacesFor,
    placeMaxRadius,
    placeWeight,
    coordQualityPenalty,
  } = staticData;

  for (const prop of getPlacesFor('grounded')) {
    if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) continue;
    const dist = haversine(lat, lng, prop.lat, prop.lng);
    const maxR = Math.min(placeMaxRadius(prop, radiusMiles), radiusMiles);
    if (dist <= maxR) {
      results.push({
        ...prop,
        dist,
        score: (1 - dist / maxR) * placeWeight(prop) * coordQualityPenalty(prop),
      });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// Helper: Haversine formula for distance in miles
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Helper: Get airport name from coordinates
function getAirportByCoords(lat, lng) {
  const airports = staticData.airports || [];
  let nearest = null;
  let minDist = Infinity;
  for (const apt of airports) {
    if (!Number.isFinite(apt.lat) || !Number.isFinite(apt.lng)) continue;
    const d = haversine(lat, lng, apt.lat, apt.lng);
    if (d < minDist) { minDist = d; nearest = apt; }
  }
  return nearest ? nearest.name : `${lat}, ${lng}`;
}

// Helper: Historical confidence
function getHistoricalConfidence(from, to) {
  if (from.includes('Teterboro') && to.includes('Manhattan')) return 0.94;
  if (from.includes('Van Nuys') && to.includes('Bel Air')) return 0.89;
  if (from.includes('Austin') && to.includes('Tesla')) return 0.92;
  if (from.includes('Jackson Hole') && to.includes('Jackson Hole')) return 0.88;
  return 0.0;
}

// Helper: Get route between two points (legacy routes + places by name)
function getRoute(lat1, lng1, lat2, lng2) {
  const routes = staticData.routes || [];
  const places = staticData.getPlaces();
  for (const r of routes) {
    const fromAirport = (staticData.airports || []).find(a => a.name === r.from || a.code === r.from_airport);
    const toName = r.to || r.to_place;
    const toProp = places.find(p => p.name === toName || p.id === toName);
    if (fromAirport && toProp) {
      const d1 = haversine(lat1, lng1, fromAirport.lat, fromAirport.lng);
      const d2 = haversine(lat2, lng2, toProp.lat, toProp.lng);
      if (d1 < 5 && d2 < 5) {
        const street = (r.route || 'route').split('→')[0].trim();
        return { street };
      }
    }
  }
  return { street: 'unknown' };
}

// Helper: Predict destination by heading using places[]
function predictDestinationByHeading(lat, lng, heading) {
  if (heading === null || heading === undefined || isNaN(heading)) return null;

  const {
    getPlacesFor,
    placeMaxRadius,
    placeWeight,
    coordQualityPenalty,
  } = staticData;

  let best = null;
  let bestScore = 0;
  const MAX_ANGLE = 45;

  for (const prop of getPlacesFor('in_flight')) {
    if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) continue;
    const distance = haversine(lat, lng, prop.lat, prop.lng);
    const maxR = placeMaxRadius(prop, 500);
    if (distance > Math.max(maxR * 8, 200)) continue;

    const φ1 = lat * Math.PI / 180;
    const φ2 = prop.lat * Math.PI / 180;
    const Δλ = (prop.lng - lng) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    bearing = (bearing + 360) % 360;

    let diff = ((heading - bearing) % 360 + 360) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff >= MAX_ANGLE) continue;

    let score = (1 - diff / MAX_ANGLE) * placeWeight(prop) * coordQualityPenalty(prop);
    score *= (1 - Math.min(distance / 200, 1) * 0.35);

    if (score > bestScore) {
      bestScore = score;
      best = prop;
    }
  }
  return best;
}

module.exports = {
  generateConclusion,
  haversine
};