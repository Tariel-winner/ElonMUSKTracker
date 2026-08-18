// news.js - Fetch news about Elon Musk
const fetch = require('node-fetch');

async function getElonNews() {
  try {
    // Free API key from newsapi.org
    const API_KEY = process.env.NEWS_API_KEY || 'YOUR_API_KEY';
    const url = `https://newsapi.org/v2/everything?q=Elon Musk&sortBy=publishedAt&pageSize=3`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log('[NEWS] Error fetching news:', e.message);
    return null;
  }
}

module.exports = { getElonNews };