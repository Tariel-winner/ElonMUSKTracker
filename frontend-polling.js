// frontend-polling.js
// Complete frontend logic with map, status card, and horizontal cards track
// OPTIMIZED: No re-render on every poll, only update changed values
// CARDS: Horizontal scrollable cards synced with slider
// SYNC: Slider and cards stay in sync
// ZOOM: Preserves user zoom/pan when poll updates location

class ElonTracker {
  constructor() {
    this.currentData = null;
    this.historyData = [];
    this.isLiveMode = true;
    this.pollingInterval = null;
    this.map = null;
    this.markers = { plane: null, destination: null, path: null, car: null, flightPath: null };
    this.lastSliderValue = 100;
    this.dom = {};
    this.activeEventIndex = -1;
    this.cardElements = [];
    this.isUserInteracting = false;
    
    // --- SYNC FIXES ---
    this.syncing = false;
    this.scrollTimeout = null;
    this.MAX_EVENTS = 100;
    this.isUserBrowsingHistory = false;
    
    // --- ZOOM FIX ---
    this.userMovedMap = false;
    this.lastMapZoom = 4;
    this.lastMapCenter = null;

    // --- PLACES + OBSERVATION ---
    this.placesByName = {};
    this.flightPathPoints = [];
  }

  // =============================================
  // 1. INITIALIZE
  // =============================================
  async init() {
    console.log('🚀 Initializing tracker UI...');
    
    this.cacheDomElements();
    this.initMap();
    await this.loadPlaces();
    await this.loadFlightPath();
    await this.loadHistory();
    await this.loadCurrent();
    this.startPolling();
    this.setupSlider();
    this.setupScrollSync();
    this.updateUI();
    
    console.log('✅ Tracker initialized!');
  }

  // =============================================
  // 1.5 CACHE DOM ELEMENTS
  // =============================================
  cacheDomElements() {
    this.dom = {
      statusIcon: document.getElementById('status-icon'),
      statusState: document.getElementById('status-state'),
      statusBadge: document.getElementById('status-badge'),
      statusCard: document.getElementById('status-card'),
      currentLocation: document.getElementById('current-location'),
      destination: document.getElementById('destination'),
      confidence: document.getElementById('confidence'),
      confidenceFill: document.getElementById('confidence-fill'),
      reasoning: document.getElementById('reasoning'),
      timestamp: document.getElementById('timestamp'),
      statusText: document.getElementById('status-text'),
      statusDot: document.getElementById('status-dot'),
      lastUpdated: document.getElementById('last-updated'),
      sliderMode: document.getElementById('slider-mode'),
      timeSlider: document.getElementById('time-slider'),
      cardsTrack: document.getElementById('cards-track'),
      dataMeta: document.getElementById('data-meta'),
      observedCoords: document.getElementById('observed-coords'),
    };
  }

  // =============================================
  // 2. MAP SETUP (with zoom preservation)
  // =============================================
  initMap() {
    this.map = L.map('map', {
      center: [39.8283, -98.5795],
      zoom: 4,
      zoomControl: true,
      attributionControl: false,
    });
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; CartoDB',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(this.map);
    
    this.map.on('zoomstart', () => {
      this.userMovedMap = true;
      this.lastMapZoom = this.map.getZoom();
    });
    this.map.on('dragstart', () => {
      this.userMovedMap = true;
      this.lastMapCenter = this.map.getCenter();
    });
    this.map.on('zoomend', () => {
      this.lastMapZoom = this.map.getZoom();
    });
    this.map.on('moveend', () => {
      this.lastMapCenter = this.map.getCenter();
    });
    
    console.log('🗺️ Map initialized (Dark Mode)');
  }

  // =============================================
  // 3. LOAD DATA
  // =============================================
  async loadPlaces() {
    try {
      const res = await fetch('/elon_musk_properties.json');
      if (!res.ok) throw new Error(`places ${res.status}`);
      const data = await res.json();
      const places = data.places || [];
      this.placesByName = {};
      for (const p of places) {
        if (!p.name || p.lat == null || p.lng == null) continue;
        this.placesByName[p.name] = { lat: p.lat, lng: p.lng, ...p };
      }
      console.log(`📍 Loaded ${places.length} places for destination markers`);
    } catch (err) {
      console.warn('Places load failed, destination markers may be limited:', err.message);
    }
  }

  async loadFlightPath() {
    try {
      const res = await fetch('/api/flight-path');
      if (!res.ok) return;
      const rows = await res.json();
      this.flightPathPoints = (rows || [])
        .filter(r => r.lat != null && r.lng != null)
        .map(r => [r.lat, r.lng]);
      this.drawFlightPath();
    } catch (err) {
      console.warn('Flight path load failed:', err.message);
    }
  }

  drawFlightPath() {
    if (!this.map || this.flightPathPoints.length < 2) return;
    if (this.markers.flightPath) {
      this.map.removeLayer(this.markers.flightPath);
      this.markers.flightPath = null;
    }
    this.markers.flightPath = L.polyline(this.flightPathPoints, {
      color: '#446688',
      weight: 2,
      opacity: 0.55,
    }).addTo(this.map);
  }

  /** Prefer observation coords; never invent USA center when unknown. */
  getPosition(data) {
    if (!data) return null;
    const lat = data.observed_lat ?? data.lat ?? data.current_lat;
    const lng = data.observed_lng ?? data.lng ?? data.current_lng;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, source: 'observation' };
    }
    // History rows sometimes store "lat, lng" as current_location
    if (typeof data.current_location === 'string' && data.current_location.includes(',')) {
      const parts = data.current_location.split(',').map(s => parseFloat(s.trim()));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        return { lat: parts[0], lng: parts[1], source: 'parsed' };
      }
    }
    return null;
  }

  async loadHistory({ soft = false } = {}) {
    try {
      const res = await fetch('/api/history');
      const rows = await res.json();
      
      if (soft) {
        this.appendNewHistory(rows);
      } else {
        this.historyData = rows;
        this.renderCards(rows);
      }
      
      console.log(`📜 Loaded ${this.historyData.length} historical events (soft: ${soft})`);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  appendNewHistory(rows) {
    if (!rows || rows.length === 0) return;
    
    const lastTimestamp = this.historyData.length > 0 
      ? this.historyData[this.historyData.length - 1].timestamp 
      : null;
    
    const newEvents = lastTimestamp 
      ? rows.filter(r => r.timestamp > lastTimestamp)
      : rows;
    
    if (newEvents.length > 0) {
      const wasBrowsing = this.isUserBrowsingHistory;
      this.historyData.push(...newEvents);
      
      this.renderCards(this.historyData, {
        preserveScroll: wasBrowsing,
        preserveActive: wasBrowsing && this.activeEventIndex >= 0
      });
      
      console.log(`📜 Appended ${newEvents.length} new events`);
    }
  }

  async loadCurrent() {
    try {
      const res = await fetch('/api/current');
      if (res.status === 404) {
        console.log('⏳ No data yet, waiting...');
        return;
      }
      const newData = await res.json();
      
      if (this.hasDataChanged(newData)) {
        this.currentData = newData;
        this.updateUI();
        this.updateMap();
        this.updateStatusCard();
      }
      
      this.dom.lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
      
    } catch (err) {
      console.error('Failed to load current data:', err);
      this.dom.statusText.textContent = 'Error';
      this.dom.statusDot.className = 'dot error';
    }
  }

  hasDataChanged(newData) {
    if (!this.currentData) return true;
    if (this.currentData.timestamp !== newData.timestamp) return true;
    
    const fields = [
      'state', 'destination', 'confidence', 'current_location',
      'observed_lat', 'observed_lng', 'observed_on_ground', 'observed_age',
    ];
    for (const field of fields) {
      if (this.currentData[field] !== newData[field]) return true;
    }

    const oldMeta = this.currentData._meta || {};
    const newMeta = newData._meta || {};
    if (oldMeta.isStale !== newMeta.isStale) return true;
    if (oldMeta.inferenceSource !== newMeta.inferenceSource) return true;
    if (oldMeta.flightAge !== newMeta.flightAge) return true;
    if (oldMeta.lastUpdated !== newMeta.lastUpdated) return true;

    return false;
  }

  async refreshLive() {
    await this.loadCurrent();
    await this.loadHistory({ soft: true });
    await this.loadFlightPath();
  }

  // =============================================
  // 4. POLLING
  // =============================================
  // Poll local /api/current — OpenSky only updates ~every 5 min via bridge
  startPolling() {
    const POLL_MS = 60 * 1000; // 1 min UI refresh (does NOT hit OpenSky)
    this.pollingInterval = setInterval(() => {
      if (this.isLiveMode && !this.isUserInteracting) {
        this.refreshLive();
      }
    }, POLL_MS);
  }

  // =============================================
  // 5. SLIDER - SYNCED WITH CARDS
  // =============================================
  setupSlider() {
    const slider = this.dom.timeSlider;
    
    slider.addEventListener('input', (e) => {
      if (this.syncing) return;
      
      this.isUserInteracting = true;
      this.isUserBrowsingHistory = true;
      
      const val = parseInt(e.target.value);
      this.lastSliderValue = val;
      
      if (this.historyData.length === 0) return;
      
      const index = Math.round((val / 100) * (this.historyData.length - 1));
      this.jumpToEvent(index, 'slider');
    });
    
    slider.addEventListener('mouseup', () => {
      this.isUserInteracting = false;
    });
  }

  // =============================================
  // 6. SCROLL SYNC (Cards only)
  // =============================================
  setupScrollSync() {
    const cards = this.dom.cardsTrack;
    if (!cards) return;
    
    let cardsScrollTimeout = null;
    cards.addEventListener('scroll', () => {
      if (this.syncing) return;
      if (this.historyData.length === 0 || this.cardElements.length === 0) return;
      
      clearTimeout(cardsScrollTimeout);
      cardsScrollTimeout = setTimeout(() => {
        this.handleScrollSync();
      }, 100);
    });
  }

  handleScrollSync() {
    if (this.syncing) return;
    
    const container = this.dom.cardsTrack;
    const elements = this.cardElements;
    
    if (!container || elements.length === 0) return;
    
    const cRect = container.getBoundingClientRect();
    const centerX = cRect.left + cRect.width / 2;
    
    let best = 0;
    let bestDist = Infinity;
    
    elements.forEach((el, i) => {
      const elRect = el.getBoundingClientRect();
      const elCenter = elRect.left + elRect.width / 2;
      const dist = Math.abs(elCenter - centerX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    
    const globalIndex = this.localToGlobal(best);
    if (globalIndex !== this.activeEventIndex) {
      this.isUserBrowsingHistory = true;
      this.jumpToEvent(globalIndex, 'scroll');
    }
  }

  // =============================================
  // 7. UI UPDATES
  // =============================================
  updateUI() {
    if (!this.currentData) return;
    
    const data = this.currentData;
    const meta = data._meta || {};
    
    if (data.state) {
      this.dom.statusText.textContent = data.state.toUpperCase();
      this.dom.statusDot.className = meta.isStale ? 'dot error' : 'dot live';
    }
    
    if (this.isLiveMode) {
      this.dom.sliderMode.textContent = '🔴 LIVE';
      this.dom.sliderMode.className = 'live-label';
      if (this.historyData.length > 0) {
        const index = this.historyData.findIndex(h => h.timestamp === data.timestamp);
        if (index !== -1) {
          const pct = (index / (this.historyData.length - 1)) * 100;
          this.dom.timeSlider.value = pct;
          this.highlightActiveCard(index);
          this.scrollToActiveCard(index);
        }
      }
    }
  }

  // =============================================
  // 8. MAP UPDATE (Preserves zoom/pan)
  // =============================================
  updateMap() {
    if (!this.currentData || !this.map) return;
    
    const data = this.currentData;
    const pos = this.getPosition(data);
    if (!pos) {
      console.warn('No observed position yet — skipping map pin update');
      return;
    }
    const { lat, lng } = pos;
    
    if (this.markers.plane) {
      this.map.removeLayer(this.markers.plane);
      this.markers.plane = null;
    }
    if (this.markers.destination) {
      this.map.removeLayer(this.markers.destination);
      this.markers.destination = null;
    }
    if (this.markers.path) {
      this.map.removeLayer(this.markers.path);
      this.markers.path = null;
    }
    if (this.markers.car) {
      this.map.removeLayer(this.markers.car);
      this.markers.car = null;
    }

    let shouldFitBounds = false;
    let fitBoundsCoords = null;
    const showDest = data.destination && data.destination !== 'Unknown' && (data.confidence || 0) >= 0.3;

    if (data.state === 'in_flight') {
      const planeIcon = L.divIcon({
        html: '🛩️',
        className: 'plane-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: planeIcon })
        .addTo(this.map)
        .bindPopup(`<b>✈️ IN FLIGHT</b><br>Observed: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      
      if (showDest) {
        const destCoords = this.getDestinationCoords(data.destination);
        if (destCoords) {
          const destIcon = L.divIcon({
            html: '⭐',
            className: 'dest-marker',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          });
          
          this.markers.destination = L.marker([destCoords.lat, destCoords.lng], { icon: destIcon })
            .addTo(this.map)
            .bindPopup(`🎯 Guess: ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
          const opacity = Math.min(data.confidence + 0.2, 0.8);
          this.markers.path = L.polyline(
            [[lat, lng], [destCoords.lat, destCoords.lng]],
            { color: '#00d4ff', weight: 2, dashArray: '8, 8', opacity }
          ).addTo(this.map);
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    } else if (data.state === 'landed') {
      const landedIcon = L.divIcon({
        html: '🛬',
        className: 'landed-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: landedIcon })
        .addTo(this.map)
        .bindPopup(`<b>🛬 LANDED</b><br>Observed: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      
      if (showDest) {
        const destCoords = this.getDestinationCoords(data.destination);
        if (destCoords) {
          const destIcon = L.divIcon({
            html: '⭐',
            className: 'dest-marker',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          });
          
          this.markers.destination = L.marker([destCoords.lat, destCoords.lng], { icon: destIcon })
            .addTo(this.map)
            .bindPopup(`🎯 Guess: ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
          const midLat = (lat + destCoords.lat) / 2;
          const midLng = (lng + destCoords.lng) / 2;
          const carIcon = L.divIcon({
            html: '🚗',
            className: 'car-marker',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });
          this.markers.car = L.marker([midLat, midLng], { icon: carIcon })
            .addTo(this.map)
            .bindPopup(`🚗 En route guess → ${data.destination}`);
          
          this.markers.path = L.polyline(
            [[lat, lng], [destCoords.lat, destCoords.lng]],
            { color: '#00ff88', weight: 3, opacity: 0.8 }
          ).addTo(this.map);
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    } else if (data.state === 'grounded' || data.state === 'parked' || data.state === 'no_signal') {
      const iconHtml = data.state === 'no_signal' ? '📡' : '🅿️';
      const title = data.state === 'no_signal' ? 'NO SIGNAL (last ADS-B)' : 'GROUNDED';
      const parkedIcon = L.divIcon({
        html: iconHtml,
        className: 'parked-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: parkedIcon })
        .addTo(this.map)
        .bindPopup(`<b>${title}</b><br>Observed: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      
      if (showDest) {
        const destCoords = this.getDestinationCoords(data.destination);
        if (destCoords) {
          const destIcon = L.divIcon({
            html: '📍',
            className: 'dest-marker',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });
          const hypo = data.hypothesis_type === 'ai_unverified' ? 'AI approx' : 'Guess';
          
          this.markers.destination = L.marker([destCoords.lat, destCoords.lng], { icon: destIcon })
            .addTo(this.map)
            .bindPopup(`📍 ${hypo}: ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    } else {
      const unknownIcon = L.divIcon({
        html: '❓',
        className: 'unknown-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: unknownIcon })
        .addTo(this.map)
        .bindPopup(`Observed: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    }

    if (shouldFitBounds && fitBoundsCoords) {
      if (!this.userMovedMap) {
        const bounds = L.latLngBounds(fitBoundsCoords);
        this.map.fitBounds(bounds, { padding: [50, 50] });
        this.lastMapZoom = this.map.getZoom();
        this.lastMapCenter = this.map.getCenter();
      } else {
        const markerLatLng = L.latLng(lat, lng);
        if (!this.map.getBounds().contains(markerLatLng)) {
          this.map.panTo(markerLatLng, { animate: true });
        }
      }
    } else if (!this.userMovedMap) {
      this.map.setView([lat, lng], this.map.getZoom() || 6);
    } else {
      const markerLatLng = L.latLng(lat, lng);
      if (!this.map.getBounds().contains(markerLatLng)) {
        this.map.panTo(markerLatLng, { animate: true });
      }
    }
  }

  // =============================================
  // 9. GET DESTINATION COORDINATES (from places JSON)
  // =============================================
  getDestinationCoords(destName) {
    if (!destName) return null;
    if (this.placesByName[destName]) {
      const p = this.placesByName[destName];
      return { lat: p.lat, lng: p.lng };
    }
    for (const [name, p] of Object.entries(this.placesByName)) {
      if (destName.includes(name) || name.includes(destName)) {
        return { lat: p.lat, lng: p.lng };
      }
    }
    return null;
  }

  // =============================================
  // 10. STATUS CARD UPDATE
  // =============================================
  updateStatusCard() {
    if (!this.currentData) return;
    
    const data = this.currentData;
    const d = this.dom;
    
    const stateMap = {
      'landed': { icon: '🛬', color: 'landed', label: '🟢 LANDED' },
      'in_flight': { icon: '🛫', color: 'in_flight', label: '🟠 IN FLIGHT' },
      'grounded': { icon: '🅿️', color: 'grounded', label: '🔵 GROUNDED' },
      'parked': { icon: '🅿️', color: 'grounded', label: '🔵 PARKED' },
      'no_signal': { icon: '📡', color: 'unknown', label: '⚫ NO SIGNAL' },
      'unknown': { icon: '❓', color: 'unknown', label: '⚫ UNKNOWN' }
    };
    
    const stateInfo = stateMap[data.state] || stateMap['unknown'];
    
    const newClass = `status-card ${stateInfo.color}`;
    if (d.statusCard.className !== newClass) {
      d.statusCard.className = newClass;
    }
    
    if (d.statusIcon.textContent !== stateInfo.icon) {
      d.statusIcon.textContent = stateInfo.icon;
    }
    
    if (d.statusState.textContent !== stateInfo.label) {
      d.statusState.textContent = stateInfo.label;
      d.statusState.className = `state ${stateInfo.color}`;
    }
    
    const meta = data._meta || {};
    let badgeText = this.isLiveMode ? '● LIVE' : '⏸️ PAUSED';
    if (meta.isStale) badgeText = '⚠ STALE';
    if (d.statusBadge.textContent !== badgeText) {
      d.statusBadge.textContent = badgeText;
      d.statusBadge.style.color = meta.isStale ? '#ffaa00' : (this.isLiveMode ? '#00ff88' : '#ffaa00');
    }
    
    const locationText = data.current_location || 'Unknown';
    if (d.currentLocation.textContent !== locationText) {
      d.currentLocation.textContent = locationText;
    }

    if (d.observedCoords) {
      const pos = this.getPosition(data);
      const obsText = pos
        ? `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`
        : 'No observation yet';
      if (d.observedCoords.textContent !== obsText) {
        d.observedCoords.textContent = obsText;
      }
    }

    if (d.dataMeta) {
      const age = meta.flightAge != null ? `${meta.flightAge}s` : (data.observed_age != null ? `${data.observed_age}s` : '—');
      const source = meta.inferenceSource || data.prediction_type || 'none';
      const phase = data.phase || data.state || '—';
      const hypo = data.hypothesis_type ? ` · hypo: ${data.hypothesis_type}` : '';
      const metaText = `${phase} · ${source} · age ${age}${meta.isStale ? ' · STALE' : ''}${hypo}`;
      if (d.dataMeta.textContent !== metaText) {
        d.dataMeta.textContent = metaText;
      }
    }
    
    const destEl = d.destination;
    if (data.destination && data.destination !== 'Unknown') {
      const prefix = (data.hypothesis_type === 'ai_unverified' || data.state === 'no_signal') ? '≈ ' : '';
      const destText = `${prefix}${data.destination}`;
      if (destEl.textContent !== destText) {
        destEl.textContent = destText;
      }
      const color = data.confidence > 0.7 ? '#00ff88' : 
                    data.confidence > 0.3 ? '#ffaa00' : '#ff4444';
      if (destEl.style.color !== color) {
        destEl.style.color = color;
      }
    } else {
      if (destEl.textContent !== '❓ Unknown') {
        destEl.textContent = '❓ Unknown';
        destEl.style.color = '#666';
      }
    }
    
    const pct = Math.round((data.confidence || 0) * 100);
    const confText = `${pct}%`;
    if (d.confidence.textContent !== confText) {
      d.confidence.textContent = confText;
    }
    d.confidenceFill.style.width = `${pct}%`;
    
    const reasoningEl = d.reasoning;
    const statusLine = data.status_message ? [`${data.status_message}`] : [];
    const reasons = [
      ...statusLine,
      ...((data.reasoning && data.reasoning.length) ? data.reasoning : ['No reasoning available']),
    ];
    const newReasoning = reasons.map(r => `<li>${r}</li>`).join('');
    if (reasoningEl.innerHTML !== newReasoning) {
      reasoningEl.innerHTML = newReasoning;
    }
    
    const tsText = data.timestamp ? `⏰ ${this.formatTimestamp(data.timestamp)}` : '—';
    if (d.timestamp.textContent !== tsText) {
      d.timestamp.textContent = tsText;
    }
  }

  // =============================================
  // 11. RENDER CARDS
  // =============================================
  renderCards(history, options = {}) {
    const container = this.dom.cardsTrack;
    if (!container) return;
    
    const savedScrollLeft = container.scrollLeft;
    const savedActiveIndex = this.activeEventIndex;
    
    container.innerHTML = '';
    this.cardElements = [];
    
    if (!history || history.length === 0) {
      container.innerHTML = '<div class="card-item">No cards yet</div>';
      return;
    }
    
    const events = history.length > this.MAX_EVENTS 
      ? history.slice(-this.MAX_EVENTS) 
      : history;
    
    for (let i = 0; i < events.length; i++) {
      const item = events[i];
      const card = document.createElement('div');
      card.className = 'card-item';
      card.dataset.index = i;
      card.dataset.globalIndex = history.length - events.length + i;
      
      const time = this.formatTimestamp(item.timestamp);
      const dest = item.destination || 'Unknown';
      const conf = Math.round((item.confidence || 0) * 100);
      const state = item.state || 'unknown';
      const stateIcon = state === 'landed' ? '🛬' : 
                        state === 'in_flight' ? '🛫' : 
                        state === 'grounded' ? '🅿️' : '❓';
      const stateLabel = state.toUpperCase();
      
      card.innerHTML = `
        <div class="card-time">${time}</div>
        <div class="card-dest">${stateIcon} ${dest}</div>
        <div class="card-conf">Confidence: ${conf}%</div>
        <div class="card-state">${stateLabel}</div>
      `;
      
      card.addEventListener('click', () => {
        const globalIndex = parseInt(card.dataset.globalIndex, 10);
        this.isUserBrowsingHistory = true;
        this.jumpToEvent(globalIndex, 'click');
      });
      
      container.appendChild(card);
      this.cardElements.push(card);
    }
    
    // Restore active state
    const shouldPreserveActive = options.preserveActive && savedActiveIndex >= 0;
    const isLiveMode = this.isLiveMode && !this.isUserBrowsingHistory;
    
    if (shouldPreserveActive && savedActiveIndex < this.historyData.length) {
      this.highlightActiveCard(savedActiveIndex);
    } else if (isLiveMode && this.cardElements.length > 0) {
      const lastIndex = this.cardElements.length - 1;
      this.cardElements[lastIndex].classList.add('active');
      this.activeEventIndex = history.length - 1;
    } else if (this.cardElements.length > 0 && this.activeEventIndex >= 0) {
      this.highlightActiveCard(this.activeEventIndex);
    } else if (this.cardElements.length > 0) {
      const lastIndex = this.cardElements.length - 1;
      this.cardElements[lastIndex].classList.add('active');
      this.activeEventIndex = history.length - 1;
    }
    
    // Restore scroll
    const shouldPreserveScroll = options.preserveScroll && savedScrollLeft > 0;
    
    if (shouldPreserveScroll && savedScrollLeft <= container.scrollWidth) {
      container.scrollLeft = savedScrollLeft;
    } else if (isLiveMode) {
      container.scrollLeft = container.scrollWidth;
    } else if (this.activeEventIndex >= 0) {
      this.scrollToActiveCard(this.activeEventIndex);
    } else {
      container.scrollLeft = container.scrollWidth;
    }
  }

  // =============================================
  // 12. HELPER: Format Timestamp with Date
  // =============================================
  formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    
    const date = new Date(timestamp);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (date >= today) {
      return `Today ${timeStr}`;
    } else if (date >= yesterday) {
      return `Yesterday ${timeStr}`;
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
    }
  }

  // =============================================
  // 13. HELPER: Convert local index to global
  // =============================================
  localToGlobal(localIndex) {
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    return localIndex + (this.historyData.length - events.length);
  }

  // =============================================
  // 14. JUMP TO EVENT
  // =============================================
  jumpToEvent(index, reason) {
    if (index < 0 || index >= this.historyData.length) return;
    if (this.syncing) return;
    
    const dataPoint = this.historyData[index];
    this.isLiveMode = false;
    this.activeEventIndex = index;
    this.currentData = dataPoint;
    
    if (reason !== 'slider') {
      this.syncing = true;
      const pct = (index / (this.historyData.length - 1)) * 100;
      this.dom.timeSlider.value = pct;
      setTimeout(() => { this.syncing = false; }, 100);
    }
    
    const formattedTime = this.formatTimestamp(dataPoint.timestamp);
    this.dom.sliderMode.textContent = `⏸️ ${formattedTime}`;
    this.dom.sliderMode.className = 'live-label paused';
    
    this.updateUI();
    this.updateMap();
    this.updateStatusCard();
    
    this.highlightActiveCard(index);
    this.scrollToActiveCard(index);
  }

  // =============================================
  // 15. HIGHLIGHT ACTIVE CARD
  // =============================================
  highlightActiveCard(index) {
    this.clearActiveCardHighlight();
    
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    
    const localIndex = index - (this.historyData.length - events.length);
    
    if (localIndex >= 0 && localIndex < this.cardElements.length) {
      this.cardElements[localIndex].classList.add('active');
      this.activeEventIndex = index;
    }
  }

  // =============================================
  // 16. SCROLL TO ACTIVE CARD
  // =============================================
  scrollToActiveCard(index) {
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    
    const localIndex = index - (this.historyData.length - events.length);
    
    if (localIndex >= 0 && localIndex < this.cardElements.length) {
      const el = this.cardElements[localIndex];
      const container = this.dom.cardsTrack;
      
      this.syncing = true;
      const scrollOffset = el.offsetLeft - (container.clientWidth / 2) + (el.offsetWidth / 2);
      container.scrollTo({
        left: Math.max(0, scrollOffset),
        behavior: 'smooth'
      });
      setTimeout(() => { this.syncing = false; }, 200);
    }
  }

  clearActiveCardHighlight() {
    if (this.cardElements) {
      this.cardElements.forEach(el => el.classList.remove('active'));
    }
  }

  // =============================================
  // 17. GO BACK TO LIVE MODE
  // =============================================
  goLive() {
    this.isLiveMode = true;
    this.isUserBrowsingHistory = false;
    this.activeEventIndex = -1;
    this.dom.sliderMode.textContent = '🔴 LIVE';
    this.dom.sliderMode.className = 'live-label';
    this.clearActiveCardHighlight();
    this.loadCurrent();
    this.dom.timeSlider.value = 100;
  }
}

// =============================================
// 18. START
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  const tracker = new ElonTracker();
  tracker.init();
  
  const modeLabel = document.getElementById('slider-mode');
  if (modeLabel) {
    modeLabel.style.cursor = 'pointer';
    modeLabel.addEventListener('click', () => {
      tracker.goLive();
    });
  }
});