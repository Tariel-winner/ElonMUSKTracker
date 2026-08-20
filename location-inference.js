// location-inference.js
// Grounded inference using places[] schema (weight, max_radius, use_for, type)

const { haversine } = require('./ai-correlator');
const {
  getPlacesFor,
  placeMaxRadius,
  placeWeight,
  coordQualityPenalty,
  placeType,
  placeCategory,
} = require('./static-data');

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
const DEFAULT_MAX_MILES = 50;

function inferLocationWhenGrounded(lastKnown, staticData, cache, newsData) {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  const isWeekend = day === 0 || day === 6;
  const isWorkHours = hour >= WORK_START_HOUR && hour <= WORK_END_HOUR && !isWeekend;
  const isEvening = hour >= 18 || hour <= 6;

  const conclusion = {
    state: 'grounded',
    current_location: lastKnown.locationName || 'Unknown',
    destination: 'Unknown',
    confidence: 0.0,
    reasoning: [],
    prediction_type: 'grounded_inference',
    timestamp: now.toISOString(),
  };

  const allProperties = getPlacesFor('grounded');

  const residences = allProperties.filter((p) => {
    const t = placeType(p);
    const c = placeCategory(p);
    return t === 'home' || t === 'residence' || t === 'family' || t === 'friend'
      || c === 'residence' || c === 'family' || c === 'friend';
  });
  const hqs = allProperties.filter((p) => {
    const t = placeType(p);
    const c = placeCategory(p);
    return t === 'work' || c === 'corporate_hq';
  });
  const weekendPlaces = allProperties.filter((p) => {
    const t = placeType(p);
    const c = placeCategory(p);
    return t === 'home' || t === 'residence' || t === 'family' || t === 'friend' || t === 'vacation'
      || c === 'residence' || c === 'family' || c === 'friend' || c === 'vacation';
  });

  function findBest(lat, lng, properties) {
    if (!properties || properties.length === 0) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const prop of properties) {
      if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) continue;
      const dist = haversine(lat, lng, prop.lat, prop.lng);
      const radius = placeMaxRadius(prop, DEFAULT_MAX_MILES);
      if (dist >= radius) continue;
      const proximity = 1 - dist / radius;
      const score = proximity * placeWeight(prop) * coordQualityPenalty(prop);
      if (score > bestScore) {
        bestScore = score;
        best = prop;
      }
    }
    return best;
  }

  let candidate = null;
  let candidateType = '';

  if (isWeekend) {
    conclusion.reasoning.push(
      `Weekend (${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}) — prefer home/weekend places.`
    );
    candidate = findBest(lastKnown.lat, lastKnown.lng, weekendPlaces);
    candidateType = 'weekend';
  } else if (isWorkHours) {
    conclusion.reasoning.push(`Work hours (UTC ${hour}:00) — prefer work places.`);
    candidate = findBest(lastKnown.lat, lastKnown.lng, hqs);
    candidateType = 'work';
  } else if (isEvening) {
    conclusion.reasoning.push(`Evening (UTC ${hour}:00) — prefer residence.`);
    candidate = findBest(lastKnown.lat, lastKnown.lng, residences);
    candidateType = 'evening';
  } else {
    // Midday gap: any grounded place nearby
    candidate = findBest(lastKnown.lat, lastKnown.lng, allProperties);
    candidateType = 'nearby';
  }

  if (candidate) {
    const dist = haversine(lastKnown.lat, lastKnown.lng, candidate.lat, candidate.lng);
    const quality = candidate.coord_quality === 'precise' ? 0.4 : 0.3;
    conclusion.destination = candidate.name;
    conclusion.confidence = Math.min(quality * placeWeight(candidate), 0.55);
    conclusion.reasoning.push(
      `Nearest ${candidateType} place: ${candidate.name} (${dist.toFixed(0)} mi, weight ${placeWeight(candidate)}).`
    );
  }

  if (newsData && newsData.articles && newsData.articles.length > 0) {
    for (const article of newsData.articles.slice(0, 5)) {
      const title = (article.title || '').toLowerCase();
      const content = (article.content || '').toLowerCase();
      for (const prop of allProperties) {
        const propName = (prop.name || '').toLowerCase();
        const ownerName = (prop.owner || '').toLowerCase();
        const nameMatch = propName && (title.includes(propName) || content.includes(propName));
        const ownerMatch = ownerName && (title.includes(ownerName) || content.includes(ownerName));
        if (nameMatch && ownerMatch) {
          conclusion.destination = prop.name;
          conclusion.confidence = Math.min(conclusion.confidence + 0.15, 0.7);
          conclusion.reasoning.push(`News: "${article.title}" mentions ${prop.name}.`);
          break;
        }
      }
    }
  }

  if (conclusion.destination === 'Unknown' || conclusion.confidence < 0.1) {
    conclusion.destination = 'Unknown';
    conclusion.confidence = 0;
    conclusion.reasoning.push('No grounded place within radius — staying Unknown.');
  }

  if (lastKnown && lastKnown.locationName && lastKnown.locationName !== 'Unknown (no data)') {
    conclusion.current_location = lastKnown.locationName;
  }

  return conclusion;
}

module.exports = { inferLocationWhenGrounded };
