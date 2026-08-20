const fs = require('fs');
const path = require('path');

// Load place database once at startup
const staticData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'elon_musk_properties.json'), 'utf8')
);

staticData.places = staticData.places || [];
staticData.airports = staticData.airports || [];
staticData.routes = staticData.routes || [];
staticData.airport_to_place = staticData.airport_to_place || [];

/**
 * All candidate places (new schema).
 * Falls back to legacy arrays if someone reverts JSON.
 */
function getPlaces() {
  if (staticData.places && staticData.places.length > 0) {
    return staticData.places;
  }
  return [
    ...(staticData.corporate_hqs || []),
    ...(staticData.residences || []),
    ...(staticData.family_properties || []),
    ...(staticData.friends_properties || []),
    ...(staticData.frequent_destinations || []),
  ];
}

/**
 * Places allowed for a use case: 'in_flight' | 'grounded'
 */
function getPlacesFor(useCase) {
  return getPlaces().filter((p) => {
    if (!p.use_for || p.use_for.length === 0) return true;
    return p.use_for.includes(useCase);
  });
}

function placeCategory(p) {
  return p.category || p.type || '';
}

function placeType(p) {
  return p.type || p.category || '';
}

/**
 * Max radius for a place: prefer per-place field, else global default.
 */
function placeMaxRadius(p, fallbackMiles) {
  if (Number.isFinite(p.max_radius_miles)) return p.max_radius_miles;
  return fallbackMiles;
}

function placeWeight(p) {
  if (Number.isFinite(p.weight)) return p.weight;
  return 1;
}

function coordQualityPenalty(p) {
  if (p.coord_quality === 'approximate') return 0.7;
  if (p.coord_quality === 'rough') return 0.5;
  return 1;
}

module.exports = staticData;
module.exports.getPlaces = getPlaces;
module.exports.getPlacesFor = getPlacesFor;
module.exports.placeCategory = placeCategory;
module.exports.placeType = placeType;
module.exports.placeMaxRadius = placeMaxRadius;
module.exports.placeWeight = placeWeight;
module.exports.coordQualityPenalty = coordQualityPenalty;
