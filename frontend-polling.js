// frontend-polling.js
// Complete frontend logic with map, status card, and timeline slider
// OPTIMIZED: No re-render on every poll, only update changed values
// TIMELINE: Shows last 100 events with full date/time and active highlighting
// SYNC: Slider and event list stay in sync (bidirectional)
// ZOOM: Preserves user zoom/pan when poll updates location

class ElonTracker {
  constructor() {
    this.currentData = null;
    this.historyData = [];
    this.isLiveMode = true;
    this.pollingInterval = null;
    this.map = null;
    this.markers = { plane: null, destination: null, path: null, car: null };
    this.lastSliderValue = 100;
    this.dom = {};
    this.activeEventIndex = -1;
    this.eventElements = [];
    this.isUserInteracting = false;
    
    // --- SYNC FIXES ---
    this.syncing = false;           // Prevents slider ↔ scroll loop
    this.userScrolling = false;
    this.scrollTimeout = null;
    this.MAX_EVENTS = 100;
    this.pendingScrollJump = null;  // ✅ Debounce scroll jumps
    this.isUserBrowsingHistory = false;  // ✅ Track if user is browsing
    
    // --- ZOOM FIX ---
    this.userMovedMap = false;
    this.lastMapZoom = 4;
    this.lastMapCenter = null;
  }

  // =============================================
  // 1. INITIALIZE
  // =============================================
  async init() {
    console.log('🚀 Initializing Elon Musk Tracker...');
    
    this.cacheDomElements();
    this.initMap();
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
      timelineEvents: document.getElementById('timeline-events'),
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
  async loadHistory({ soft = false } = {}) {
    try {
      const res = await fetch('/api/history');
      const rows = await res.json();
      
      if (soft) {
        this.appendNewHistory(rows);
      } else {
        this.historyData = rows;
        this.renderTimeline(rows);
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
      
      // ✅ FIX: Only re-render if we have new events
      this.renderTimeline(this.historyData, { 
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
    
    const fields = ['state', 'destination', 'confidence', 'current_location', 'lat', 'lng'];
    for (const field of fields) {
      if (this.currentData[field] !== newData[field]) {
        return true;
      }
    }
    return false;
  }

  // =============================================
  // 4. POLLING
  // =============================================
  startPolling() {
    this.pollingInterval = setInterval(() => {
      if (this.isLiveMode && !this.isUserInteracting) {
        this.refreshLive();
      }
    }, 10000);
  }

  async refreshLive() {
    await this.loadCurrent();
    await this.loadHistory({ soft: true });
  }

  // =============================================
  // 5. SLIDER - SYNCED WITH TIMELINE (FIXED)
  // =============================================
  setupSlider() {
    const slider = this.dom.timeSlider;
    
    slider.addEventListener('input', (e) => {
      if (this.syncing) return;
      
      this.isUserInteracting = true;
      this.isUserBrowsingHistory = true;  // ✅ User is browsing
      
      const val = parseInt(e.target.value);
      this.lastSliderValue = val;
      
      if (this.historyData.length === 0) return;
      
      const index = Math.round((val / 100) * (this.historyData.length - 1));
      this.jumpToEvent(index, 'slider');
    });
    
    // ✅ FIX: Don't auto-return to live after 3s - let user decide
    slider.addEventListener('mouseup', () => {
      this.isUserInteracting = false;
      // User can click "LIVE" button or we keep showing selected
    });
  }

  // ✅ FIX: Scroll sync listener with proper debounce
  setupScrollSync() {
    const list = this.dom.timelineEvents;
    if (!list) return;
    
    let scrollTimeout = null;
    
    list.addEventListener('scroll', () => {
      if (this.syncing) return;
      if (this.historyData.length === 0 || this.eventElements.length === 0) return;
      
      // ✅ FIX: Debounce scroll events
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this.handleScrollSync();
      }, 100);
    });
  }

  // ✅ FIX: Handle scroll sync with proper geometry
  handleScrollSync() {
    if (this.syncing) return;
    if (this.historyData.length === 0 || this.eventElements.length === 0) return;
    
    const container = this.dom.timelineEvents;
    if (!container) return;
    
    // ✅ FIX: Use getBoundingClientRect for accurate geometry
    const cRect = container.getBoundingClientRect();
    const centerX = cRect.left + cRect.width / 2;
    
    let best = 0;
    let bestDist = Infinity;
    
    this.eventElements.forEach((el, i) => {
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
  // 6. UI UPDATES
  // =============================================
  updateUI() {
    if (!this.currentData) return;
    
    const data = this.currentData;
    
    if (data.state) {
      this.dom.statusText.textContent = data.state.toUpperCase();
      this.dom.statusDot.className = 'dot live';
    }
    
    if (this.isLiveMode) {
      this.dom.sliderMode.textContent = '🔴 LIVE';
      this.dom.sliderMode.className = 'live-label';
      if (this.historyData.length > 0) {
        const index = this.historyData.findIndex(h => h.timestamp === data.timestamp);
        if (index !== -1) {
          const pct = (index / (this.historyData.length - 1)) * 100;
          this.dom.timeSlider.value = pct;
          this.highlightActiveEvent(index);
          this.scrollToActiveEvent(index);
        }
      }
    }
  }

  // =============================================
  // 7. MAP UPDATE (✅ Preserves zoom/pan)
  // =============================================
  updateMap() {
    if (!this.currentData || !this.map) return;
    
    const data = this.currentData;
    const lat = data.current_lat || data.lat || 39.8283;
    const lng = data.current_lng || data.lng || -98.5795;
    
    // Remove old markers
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

    // IN FLIGHT
    if (data.state === 'in_flight') {
      const planeIcon = L.divIcon({
        html: '🛩️',
        className: 'plane-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: planeIcon })
        .addTo(this.map)
        .bindPopup(`<b>✈️ IN FLIGHT</b><br>${data.current_location || 'Unknown'}`);
      
      if (data.destination && data.destination !== 'Unknown') {
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
            .bindPopup(`🎯 ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
          if (data.confidence > 0.15) {
            const opacity = Math.min(data.confidence + 0.2, 0.8);
            this.markers.path = L.polyline(
              [[lat, lng], [destCoords.lat, destCoords.lng]],
              {
                color: '#00d4ff',
                weight: 2,
                dashArray: '8, 8',
                opacity: opacity,
                className: 'ghost-path'
              }
            ).addTo(this.map);
          }
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    }
    
    // LANDED
    else if (data.state === 'landed') {
      const landedIcon = L.divIcon({
        html: '🛬',
        className: 'landed-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: landedIcon })
        .addTo(this.map)
        .bindPopup(`<b>🛬 LANDED</b><br>${data.current_location || 'Unknown'}`);
      
      if (data.destination && data.destination !== 'Unknown') {
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
            .bindPopup(`🎯 ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
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
            .bindPopup(`🚗 Motorcade en route to ${data.destination}`);
          
          this.markers.path = L.polyline(
            [[lat, lng], [destCoords.lat, destCoords.lng]],
            {
              color: '#00ff88',
              weight: 3,
              opacity: 0.8,
              className: 'route-path'
            }
          ).addTo(this.map);
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    }
    
    // GROUNDED / PARKED
    else if (data.state === 'grounded' || data.state === 'parked') {
      const parkedIcon = L.divIcon({
        html: '🅿️',
        className: 'parked-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: parkedIcon })
        .addTo(this.map)
        .bindPopup(`<b>🅿️ PARKED</b><br>${data.current_location || 'Unknown'}`);
      
      if (data.destination && data.destination !== 'Unknown') {
        const destCoords = this.getDestinationCoords(data.destination);
        if (destCoords) {
          const destIcon = L.divIcon({
            html: '📍',
            className: 'dest-marker',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });
          
          this.markers.destination = L.marker([destCoords.lat, destCoords.lng], { icon: destIcon })
            .addTo(this.map)
            .bindPopup(`📍 ${data.destination}<br>Confidence: ${Math.round(data.confidence * 100)}%`);
          
          shouldFitBounds = true;
          fitBoundsCoords = [[lat, lng], [destCoords.lat, destCoords.lng]];
        }
      }
    }
    
    // UNKNOWN
    else {
      const unknownIcon = L.divIcon({
        html: '❓',
        className: 'unknown-marker',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      this.markers.plane = L.marker([lat, lng], { icon: unknownIcon })
        .addTo(this.map)
        .bindPopup(`<b>❓ UNKNOWN</b><br>${data.current_location || 'Unknown'}`);
      
      shouldFitBounds = false;
      fitBoundsCoords = null;
    }

    // ✅ ZOOM FIX: Only auto-fit if user hasn't moved the map
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
    } else if (!shouldFitBounds) {
      if (!this.userMovedMap) {
        this.map.setView([lat, lng], this.map.getZoom() || 4);
      } else {
        const markerLatLng = L.latLng(lat, lng);
        if (!this.map.getBounds().contains(markerLatLng)) {
          this.map.panTo(markerLatLng, { animate: true });
        }
      }
    }
  }

  // =============================================
  // 8. GET DESTINATION COORDINATES
  // =============================================
  getDestinationCoords(destName) {
    const knownCoords = {
      'Tesla HQ': { lat: 30.2655, lng: -97.7044 },
      'SpaceX HQ': { lat: 33.9207, lng: -118.3271 },
      'xAI HQ': { lat: 37.4450, lng: -122.1470 },
      'The Boring Company HQ': { lat: 30.2455, lng: -97.7120 },
      'Neuralink HQ': { lat: 37.4880, lng: -121.9380 },
      'Bel Air Mansion': { lat: 34.0882, lng: -118.4420 },
      'Manhattan Penthouse': { lat: 40.7773, lng: -73.9760 },
      'Austin Ranch': { lat: 30.2500, lng: -97.5000 },
      'Lake Austin Property': { lat: 30.3140, lng: -97.8680 },
      'Jackson Hole Property': { lat: 43.4800, lng: -110.7620 },
      'Kimbal\'s Farm': { lat: 40.0145, lng: -105.2705 },
      'Kimbal\'s NYC Restaurant': { lat: 40.7422, lng: -73.9885 },
      'Maye\'s NYC Apartment': { lat: 40.7580, lng: -73.9855 },
      'Maye\'s LA Residence': { lat: 34.0522, lng: -118.2437 },
      'Grimes\' Malibu House': { lat: 34.0250, lng: -118.7800 },
      'Larry Ellison\'s Lanai Estate': { lat: 20.6789, lng: -156.0000 },
      'Peter Thiel\'s LA Mansion': { lat: 34.0845, lng: -118.4485 },
      'Miami (F1/Events)': { lat: 25.7617, lng: -80.1918 },
      'Las Vegas (UFC/Events)': { lat: 36.1699, lng: -115.1398 },
      'Sun Valley, Idaho': { lat: 43.6941, lng: -114.3521 },
      'Boca Chica (SpaceX Launch)': { lat: 25.9973, lng: -97.1560 },
    };
    
    if (knownCoords[destName]) return knownCoords[destName];
    
    for (const [key, coords] of Object.entries(knownCoords)) {
      if (destName.includes(key) || key.includes(destName)) {
        return coords;
      }
    }
    
    return null;
  }

  // =============================================
  // 9. STATUS CARD UPDATE
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
    
    const badgeText = this.isLiveMode ? '● LIVE' : '⏸️ PAUSED';
    if (d.statusBadge.textContent !== badgeText) {
      d.statusBadge.textContent = badgeText;
      d.statusBadge.style.color = this.isLiveMode ? '#00ff88' : '#ffaa00';
    }
    
    const locationText = data.current_location || 'Unknown';
    if (d.currentLocation.textContent !== locationText) {
      d.currentLocation.textContent = locationText;
    }
    
    const destEl = d.destination;
    if (data.destination && data.destination !== 'Unknown') {
      if (destEl.textContent !== data.destination) {
        destEl.textContent = data.destination;
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
    if (data.reasoning && data.reasoning.length > 0) {
      const newReasoning = data.reasoning.map(r => `<li>${r}</li>`).join('');
      if (reasoningEl.innerHTML !== newReasoning) {
        reasoningEl.innerHTML = newReasoning;
      }
    } else if (reasoningEl.innerHTML !== '<li>No reasoning available</li>') {
      reasoningEl.innerHTML = '<li>No reasoning available</li>';
    }
    
    const tsText = data.timestamp ? `⏰ ${this.formatTimestamp(data.timestamp)}` : '—';
    if (d.timestamp.textContent !== tsText) {
      d.timestamp.textContent = tsText;
    }
  }

  // =============================================
  // 10. TIMELINE RENDER (✅ FIXED: preserves active & scroll)
  // =============================================
  renderTimeline(history, options = {}) {
    const container = this.dom.timelineEvents;
    
    // Save scroll position before re-render
    const savedScrollLeft = container ? container.scrollLeft : 0;
    const savedActiveIndex = this.activeEventIndex;
    
    container.innerHTML = '';
    this.eventElements = [];
    
    if (!history || history.length === 0) {
      container.innerHTML = '<span class="event">No events yet</span>';
      return;
    }
    
    const events = history.length > this.MAX_EVENTS 
      ? history.slice(-this.MAX_EVENTS) 
      : history;
    
    if (history.length > this.MAX_EVENTS) {
      const countEl = document.createElement('span');
      countEl.className = 'event count-info';
      countEl.textContent = `📊 Showing last ${this.MAX_EVENTS} of ${history.length} events`;
      container.appendChild(countEl);
    }
    
    for (let i = 0; i < events.length; i++) {
      const item = events[i];
      const el = document.createElement('span');
      el.className = 'event';
      el.dataset.index = i;
      el.dataset.globalIndex = history.length - events.length + i;
      
      const time = this.formatTimestamp(item.timestamp);
      const dest = item.destination || item.state || 'unknown';
      const conf = Math.round((item.confidence || 0) * 100);
      const icon = item.state === 'landed' ? '🛬' : 
                   item.state === 'in_flight' ? '🛫' : 
                   item.state === 'grounded' || item.state === 'parked' ? '🅿️' : '❓';
      
      el.innerHTML = `<span class="time">${time}</span> ${icon} → <span class="dest">${dest}</span> <span class="conf">(${conf}%)</span>`;
      
      el.addEventListener('click', () => {
        const globalIndex = parseInt(el.dataset.globalIndex, 10);
        this.isUserBrowsingHistory = true;
        this.jumpToEvent(globalIndex, 'click');
      });
      
      container.appendChild(el);
      this.eventElements.push(el);
    }
    
    // ✅ FIX: Restore active highlight or highlight last
    const shouldPreserveActive = options.preserveActive && savedActiveIndex >= 0;
    const isLiveMode = this.isLiveMode && !this.isUserBrowsingHistory;
    
    if (shouldPreserveActive) {
      // User was browsing history - restore their selection
      this.highlightActiveEvent(savedActiveIndex);
    } else if (isLiveMode && this.eventElements.length > 0) {
      // Live mode - highlight the latest event
      const lastIndex = this.eventElements.length - 1;
      this.eventElements[lastIndex].classList.add('active');
      this.activeEventIndex = history.length - 1;
    } else if (this.eventElements.length > 0) {
      // Not live, not preserving - highlight last as default
      const lastIndex = this.eventElements.length - 1;
      this.eventElements[lastIndex].classList.add('active');
    }
    
    // ✅ FIX: Restore scroll position or scroll to end in live mode
    const shouldPreserveScroll = options.preserveScroll && savedScrollLeft > 0;
    
    if (shouldPreserveScroll) {
      container.scrollLeft = savedScrollLeft;
    } else if (isLiveMode) {
      container.scrollLeft = container.scrollWidth;
    } else {
      // If we have an active event, scroll to it
      if (this.activeEventIndex >= 0) {
        this.scrollToActiveEvent(this.activeEventIndex);
      } else {
        container.scrollLeft = container.scrollWidth;
      }
    }
  }

  // =============================================
  // 11. HELPER: Format Timestamp with Date
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
  // 12. HELPER: Convert local index to global
  // =============================================
  localToGlobal(localIndex) {
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    return localIndex + (this.historyData.length - events.length);
  }

  // =============================================
  // 13. JUMP TO EVENT
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
    
    this.highlightActiveEvent(index);
    
    if (reason !== 'scroll') {
      this.scrollToActiveEvent(index);
    }
  }

  // =============================================
  // 14. HIGHLIGHT ACTIVE EVENT
  // =============================================
  highlightActiveEvent(index) {
    this.clearActiveHighlight();
    
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    
    const localIndex = index - (this.historyData.length - events.length);
    
    if (localIndex >= 0 && localIndex < this.eventElements.length) {
      this.eventElements[localIndex].classList.add('active');
      this.activeEventIndex = index;
    }
  }

  // =============================================
  // 15. SCROLL TO ACTIVE EVENT
  // =============================================
  scrollToActiveEvent(index) {
    const events = this.historyData.length > this.MAX_EVENTS 
      ? this.historyData.slice(-this.MAX_EVENTS) 
      : this.historyData;
    
    const localIndex = index - (this.historyData.length - events.length);
    
    if (localIndex >= 0 && localIndex < this.eventElements.length) {
      const el = this.eventElements[localIndex];
      const container = this.dom.timelineEvents;
      
      this.syncing = true;
      const scrollOffset = el.offsetLeft - (container.clientWidth / 2) + (el.offsetWidth / 2);
      container.scrollTo({
        left: Math.max(0, scrollOffset),
        behavior: 'smooth'
      });
      setTimeout(() => { this.syncing = false; }, 200);
    }
  }

  clearActiveHighlight() {
    if (this.eventElements) {
      this.eventElements.forEach(el => el.classList.remove('active'));
    }
  }

  // =============================================
  // 16. GO BACK TO LIVE MODE
  // =============================================
  goLive() {
    this.isLiveMode = true;
    this.isUserBrowsingHistory = false;
    this.activeEventIndex = -1;
    this.dom.sliderMode.textContent = '🔴 LIVE';
    this.dom.sliderMode.className = 'live-label';
    this.clearActiveHighlight();
    this.loadCurrent();
    this.dom.timeSlider.value = 100;
  }
}

// =============================================
// 17. START
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  const tracker = new ElonTracker();
  tracker.init();
  
  // ✅ Add LIVE button functionality (click on mode label to go live)
  const modeLabel = document.getElementById('slider-mode');
  if (modeLabel) {
    modeLabel.style.cursor = 'pointer';
    modeLabel.addEventListener('click', () => {
      tracker.goLive();
    });
  }
});