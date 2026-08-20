// reverse-geocode.js — lat/lng → human place name (city / town / area)
// Uses OpenStreetMap Nominatim (free). Cache aggressively; 1 req/sec polite use.

const fetch = require('node-fetch');

const cache = new Map(); // key "lat,lng" → { label, at }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROUND = 2; // ~1km cells — enough for "near Memphis"

let lastRequestAt = 0;

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(ROUND)},${Number(lng).toFixed(ROUND)}`;
}

/**
 * Build a short label from Nominatim address parts.
 */
function labelFromAddress(addr, displayName) {
  if (!addr || typeof addr !== 'object') {
    return displayName ? displayName.split(',').slice(0, 2).join(',').trim() : null;
  }

  const locality =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.hamlet ||
    addr.suburb ||
    addr.county;

  const region = addr.state || addr.region;
  const country = addr.country_code ? String(addr.country_code).toUpperCase() : addr.country;

  if (locality && region) return `${locality}, ${region}`;
  if (locality && country) return `${locality}, ${country}`;
  if (locality) return locality;
  if (region && country) return `${region}, ${country}`;
  if (displayName) return displayName.split(',').slice(0, 2).join(',').trim();
  return null;
}

/**
 * Reverse geocode. Returns string like "Memphis, Tennessee" or null.
 * Never throws — safe for cron.
 */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.label;
  }

  // Nominatim: ≤1 request/second
  const wait = 1100 - (Date.now() - lastRequestAt);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();

  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lng)}&zoom=10&addressdetails=1`;

    const res = await fetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'WebsiteNew-FlightStudy/1.0 (local learning; contact: local)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn('[GEO] Nominatim status', res.status);
      return null;
    }

    const data = await res.json();
    const label = labelFromAddress(data.address, data.display_name);
    if (label) {
      cache.set(key, { label, at: Date.now() });
    }
    return label;
  } catch (e) {
    console.warn('[GEO] Reverse geocode failed:', e.message);
    return null;
  }
}

/**
 * Sync-friendly: return cached label only (no network).
 */
function reverseGeocodeCached(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const hit = cache.get(cacheKey(lat, lng));
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;
  return null;
}

module.exports = {
  reverseGeocode,
  reverseGeocodeCached,
};
