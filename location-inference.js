// location-inference.js
// Handles inference when jet is on the ground
// Now includes ALL property types: corporate HQs, residences, family, friends, events

const { haversine } = require('./ai-correlator');

function inferLocationWhenGrounded(lastKnown, staticData, cache, newsData) {
  const now = new Date();
  const day = now.getDay(); // 0=Sunday, 1=Monday...
  const hour = now.getHours();
  const isWeekend = day === 0 || day === 6;
  const isWorkHours = hour >= 9 && hour <= 17 && !isWeekend;

  const conclusion = {
    state: 'grounded',
    current_location: lastKnown.locationName || 'Unknown',
    destination: 'Unknown',
    confidence: 0.0,
    reasoning: [],
    prediction_type: 'grounded_inference',
    timestamp: now.toISOString()
  };

  // --- COMBINE ALL PROPERTY TYPES ---
  const allProperties = [
    ...(staticData.corporate_hqs || []),
    ...(staticData.residences || []),
    ...(staticData.family_properties || []),
    ...(staticData.friends_properties || []),
    ...(staticData.frequent_destinations || [])
  ];

  // --- FILTER BY TYPE FOR TIME-BASED INFERENCE ---
  const residences = allProperties.filter(p => p.type === 'residence' || p.type === 'family');
  const hqs = allProperties.filter(p => p.type === 'corporate_hq');
  const vacationProps = allProperties.filter(p => p.type === 'residence' || p.type === 'family' || p.type === 'friend');

  // 1. Time-based inference
  if (isWeekend) {
    conclusion.reasoning.push('Weekend - likely at a residence, vacation, or family property.');
    const nearest = findNearest(lastKnown.lat, lastKnown.lng, vacationProps);
    if (nearest) {
      conclusion.destination = nearest.name;
      conclusion.confidence = 0.4;
      // Add context about property type
      if (nearest.type === 'family') {
        const rel = nearest.relationship || 'family';
        const owner = nearest.owner || 'relative';
        conclusion.reasoning.push(`Weekend pattern: likely at ${owner}'s ${rel} property (${nearest.name}).`);
      } else if (nearest.type === 'friend') {
        const owner = nearest.owner || 'friend';
        conclusion.reasoning.push(`Weekend pattern: likely at ${owner}'s property (${nearest.name}).`);
      } else {
        conclusion.reasoning.push(`Weekend pattern: likely at ${nearest.name}.`);
      }
    }
  } else if (isWorkHours) {
    conclusion.reasoning.push('Work hours - likely at a corporate HQ or business location.');
    const nearest = findNearest(lastKnown.lat, lastKnown.lng, hqs);
    if (nearest) {
      conclusion.destination = nearest.name;
      conclusion.confidence = 0.5;
      conclusion.reasoning.push(`Work hours: likely at ${nearest.name}.`);
    } else {
      // If no HQ nearby, check if there's a corporate event
      const events = allProperties.filter(p => p.type === 'event' || p.type === 'corporate');
      const nearestEvent = findNearest(lastKnown.lat, lastKnown.lng, events);
      if (nearestEvent) {
        conclusion.destination = nearestEvent.name;
        conclusion.confidence = 0.35;
        conclusion.reasoning.push(`Work hours: possible event at ${nearestEvent.name}.`);
      }
    }
  } else {
    conclusion.reasoning.push('Evening - likely at a residence, family, or friend property.');
    const nearest = findNearest(lastKnown.lat, lastKnown.lng, residences);
    if (nearest) {
      conclusion.destination = nearest.name;
      conclusion.confidence = 0.6;
      if (nearest.type === 'family') {
        const rel = nearest.relationship || 'family';
        const owner = nearest.owner || 'relative';
        conclusion.reasoning.push(`Evening: likely at ${owner}'s ${rel} property (${nearest.name}).`);
      } else {
        conclusion.reasoning.push(`Evening: likely at ${nearest.name}.`);
      }
    }
  }

  // 2. Check news events
  if (newsData && newsData.articles && newsData.articles.length > 0) {
    for (const article of newsData.articles) {
      const title = article.title.toLowerCase();
      const content = (article.content || '').toLowerCase();
      
      // Check all properties for mentions
      for (const prop of allProperties) {
        const propName = prop.name.toLowerCase();
        const ownerName = (prop.owner || '').toLowerCase();
        if (title.includes(propName) || content.includes(propName) ||
            title.includes(ownerName) || content.includes(ownerName)) {
          conclusion.destination = prop.name;
          conclusion.confidence = Math.min(conclusion.confidence + 0.2, 0.95);
          const source = prop.type === 'family' ? 'family' : 
                         prop.type === 'friend' ? "friend's" : '';
          conclusion.reasoning.push(`📰 News event: "${article.title}" mentions ${source} ${prop.name}.`);
          break;
        }
      }
    }
  }

  // 3. Default fallback if nothing found
  if (conclusion.destination === 'Unknown') {
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day];
    const timeOfDay = isWorkHours ? 'work' : 'evening';
    conclusion.reasoning.push(`No specific data - using historical patterns for ${dayName} ${timeOfDay}.`);
    conclusion.confidence = 0.15;
    
    if (isWorkHours && day >= 1 && day <= 5) {
      // Check if there's any corporate property nearby
      const nearestHQ = findNearest(lastKnown.lat, lastKnown.lng, hqs);
      if (nearestHQ) {
        conclusion.destination = nearestHQ.name + ' (historical pattern)';
      } else {
        conclusion.destination = 'Tesla HQ or SpaceX HQ (historical pattern)';
      }
    } else if (isWeekend) {
      const nearestVacation = findNearest(lastKnown.lat, lastKnown.lng, vacationProps);
      if (nearestVacation) {
        conclusion.destination = nearestVacation.name + ' (historical pattern)';
      } else {
        conclusion.destination = 'Bel Air Mansion or Austin Ranch (weekend pattern)';
      }
    } else {
      const nearestResidence = findNearest(lastKnown.lat, lastKnown.lng, residences);
      if (nearestResidence) {
        conclusion.destination = nearestResidence.name + ' (historical pattern)';
      } else {
        conclusion.destination = 'Manhattan Penthouse (evening pattern)';
      }
    }
  }

  if (lastKnown && lastKnown.locationName) {
    conclusion.current_location = lastKnown.locationName;
  }

  return conclusion;
}

// Helper: Find nearest property to coordinates
function findNearest(lat, lng, properties) {
  if (!properties || properties.length === 0) return null;
  
  let nearest = null;
  let minDist = Infinity;
  
  for (const prop of properties) {
    if (!prop.lat || !prop.lng) continue;
    const dist = haversine(lat, lng, prop.lat, prop.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = prop;
    }
  }
  return nearest;
}

module.exports = { inferLocationWhenGrounded };