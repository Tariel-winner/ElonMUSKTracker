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
 * Event / seasonal places must be inside an active_window (or active: true).
 * Permanent places (work/home) stay eligible unless active === false.
 */
function isPlaceActive(place, now = new Date()) {
  if (!place) return false;
  if (place.active === false && !(place.active_windows && place.active_windows.length)) {
    return false;
  }

  const isEventLike =
    place.type === 'event' ||
    place.category === 'event' ||
    place.requires_schedule === true;

  const windows = place.active_windows;

  if (isEventLike) {
    // Events: only valid inside a dated window (no window ⇒ never suggest)
    if (!Array.isArray(windows) || windows.length === 0) {
      return place.active === true; // explicit override only
    }
    return windows.some((w) => inWindow(now, w));
  }

  // Non-events: optional windows (e.g. seasonal residence); else always on
  if (Array.isArray(windows) && windows.length > 0) {
    return windows.some((w) => inWindow(now, w));
  }

  if (place.active === false) return false;
  return true;
}

function inWindow(now, w) {
  if (!w || !w.start || !w.end) return false;
  const t = now.getTime();
  const start = Date.parse(w.start);
  const end = Date.parse(w.end);
  // end date inclusive through end-of-day UTC if date-only
  const endInclusive = Number.isFinite(end) && w.end.length <= 10
    ? end + 24 * 60 * 60 * 1000 - 1
    : end;
  return Number.isFinite(start) && Number.isFinite(endInclusive) && t >= start && t <= endInclusive;
}

/**
 * Places allowed for a use case: 'in_flight' | 'grounded'
 * Also drops inactive events (no UFC today, etc.)
 */
function getPlacesFor(useCase, now = new Date()) {
  return getPlaces().filter((p) => {
    if (!isPlaceActive(p, now)) return false;
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
module.exports.isPlaceActive = isPlaceActive;
module.exports.placeCategory = placeCategory;
module.exports.placeType = placeType;
module.exports.placeMaxRadius = placeMaxRadius;
module.exports.placeWeight = placeWeight;
module.exports.coordQualityPenalty = coordQualityPenalty;
