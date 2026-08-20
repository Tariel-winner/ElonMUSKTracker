// news.js — optional weak prior only (not location proof)
// Prefer dated event windows in elon_musk_properties.json over news→destination.

const fetch = require('node-fetch');

/**
 * Fetch recent headlines. Caller must NOT treat a name mention as "is there now".
 * Returns { articles: [{ title, publishedAt, url }] } or null.
 */
async function getRecentNews(query, { pageSize = 3 } = {}) {
  try {
    const API_KEY = process.env.NEWS_API_KEY;
    if (!API_KEY || API_KEY === 'YOUR_API_KEY') {
      console.log('[NEWS] Skipped — set NEWS_API_KEY to enable');
      return null;
    }

    const q = encodeURIComponent(query);
    const url =
      `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=${pageSize}&language=en`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();

    const cutoff = Date.now() - 48 * 60 * 60 * 1000; // last 48h only
    const articles = (data.articles || [])
      .filter((a) => a.publishedAt && Date.parse(a.publishedAt) >= cutoff)
      .map((a) => ({
        title: a.title,
        publishedAt: a.publishedAt,
        url: a.url,
        content: a.description || '',
      }));

    return { articles };
  } catch (e) {
    console.log('[NEWS] Error:', e.message);
    return null;
  }
}

module.exports = { getRecentNews };
