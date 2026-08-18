// frontend-polling.js
// Complete frontend logic with map, status card, and timeline slider
// OPTIMIZED: No re-render on every poll, only update changed values

class ElonTracker {
  constructor() {
    this.currentData = null;
    this.historyData = [];
    this.isLiveMode = true;
    this.pollingInterval = null;
    this.map = null;
    this.markers = { plane: null, destination: null, path: null, car: null };
    this.lastSliderValue = 100;
    this.dom = {}; // Cache DOM elements
  }

  // =============================================
  // 1. INITIALIZE
  // =============================================
  async init() {
    console.log('🚀 Initializing Elon Musk Tracker...');
    
    // Cache DOM elements first
    this.cacheDomElements();
    
    this.initMap();
    await this.loadHistory();
    await this.loadCurrent();
    this.startPolling();
    this.setupSlider();
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
  // 2. MAP SETUP (Leaflet)
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
    
    console.log('🗺️ Map initialized (Dark Mode)');
  }

  // =============================================
  // 3. LOAD DATA
  // =============================================
  async loadHistory() {
    try {
      const res = await fetch('/api/history');
      this.historyData = await res.json();
      console.log(`📜 Loaded ${this.historyData.length} historical events`);
      this.renderTimeline(this.historyData);
    } catch (err) {
      console.error('Failed to load history:', err);
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
      
      // Only update if data actually changed
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

  // =============================================
  // 3.5 CHECK IF DATA CHANGED
  // =============================================
  hasDataChanged(newData) {
    if (!this.currentData) return true;
    
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
      if (this.isLiveMode) {
        this.loadCurrent();
      }
    }, 10000);
  }

  // =============================================
  // 5. SLIDER
  // =============================================
  setupSlider() {
    const slider = this.dom.timeSlider;
    
    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      this.lastSliderValue = val;
      
      if (this.historyData.length === 0) return;
      
      const index = Math.round((val / 100) * (this.historyData.length - 1));
      const dataPoint = this.historyData[index];
      
      if (dataPoint) {
        this.isLiveMode = false;
        this.dom.sliderMode.textContent = '⏸️ PAUSED';
        this.dom.sliderMode.className = 'live-label paused';
        this.currentData = dataPoint;
        this.updateUI();
        this.updateMap();
        this.updateStatusCard();
      }
    });
    
    slider.addEventListener('mouseup', () => {
      setTimeout(() => {
        this.isLiveMode = true;
        this.dom.sliderMode.textContent = '🔴 LIVE';
        this.dom.sliderMode.className = 'live-label';
        this.loadCurrent();
      }, 3000);
    });
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
        }
      }
    }
  }

  // =============================================
  // 7. MAP UPDATE (All Cases Covered)
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
        }
      }
      
      if (data.destination && data.destination !== 'Unknown') {
        const destCoords = this.getDestinationCoords(data.destination);
        if (destCoords) {
          const bounds = L.latLngBounds([[lat, lng], [destCoords.lat, destCoords.lng]]);
          this.map.fitBounds(bounds, { padding: [50, 50] });
          return;
        }
      }
      this.map.setView([lat, lng], 6);
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
          
          const bounds = L.latLngBounds([[lat, lng], [destCoords.lat, destCoords.lng]]);
          this.map.fitBounds(bounds, { padding: [50, 50] });
          return;
        }
      }
      this.map.setView([lat, lng], 6);
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
          
          const bounds = L.latLngBounds([[lat, lng], [destCoords.lat, destCoords.lng]]);
          this.map.fitBounds(bounds, { padding: [50, 50] });
          return;
        }
      }
      this.map.setView([lat, lng], 6);
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
      
      this.map.setView([lat, lng], 4);
    }
  }

  // =============================================
  // 8. GET DESTINATION COORDINATES (Full List)
  // =============================================
  getDestinationCoords(destName) {
    const knownCoords = {
      // Corporate HQs
      'Tesla HQ': { lat: 30.2655, lng: -97.7044 },
      'SpaceX HQ': { lat: 33.9207, lng: -118.3271 },
      'xAI HQ': { lat: 37.4450, lng: -122.1470 },
      'The Boring Company HQ': { lat: 30.2455, lng: -97.7120 },
      'Neuralink HQ': { lat: 37.4880, lng: -121.9380 },
      // Residences
      'Bel Air Mansion': { lat: 34.0882, lng: -118.4420 },
      'Manhattan Penthouse': { lat: 40.7773, lng: -73.9760 },
      'Austin Ranch': { lat: 30.2500, lng: -97.5000 },
      'Lake Austin Property': { lat: 30.3140, lng: -97.8680 },
      'Jackson Hole Property': { lat: 43.4800, lng: -110.7620 },
      // Family Properties
      'Kimbal\'s Farm': { lat: 40.0145, lng: -105.2705 },
      'Kimbal\'s NYC Restaurant': { lat: 40.7422, lng: -73.9885 },
      'Maye\'s NYC Apartment': { lat: 40.7580, lng: -73.9855 },
      'Maye\'s LA Residence': { lat: 34.0522, lng: -118.2437 },
      'Grimes\' Malibu House': { lat: 34.0250, lng: -118.7800 },
      // Friends Properties
      'Larry Ellison\'s Lanai Estate': { lat: 20.6789, lng: -156.0000 },
      'Peter Thiel\'s LA Mansion': { lat: 34.0845, lng: -118.4485 },
      // Event Destinations
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
  // 9. STATUS CARD UPDATE (No Re-render!)
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
    
    // Update card class (only if changed)
    const newClass = `status-card ${stateInfo.color}`;
    if (d.statusCard.className !== newClass) {
      d.statusCard.className = newClass;
    }
    
    // Update icon
    if (d.statusIcon.textContent !== stateInfo.icon) {
      d.statusIcon.textContent = stateInfo.icon;
    }
    
    // Update state label
    if (d.statusState.textContent !== stateInfo.label) {
      d.statusState.textContent = stateInfo.label;
      d.statusState.className = `state ${stateInfo.color}`;
    }
    
    // Update badge
    const badgeText = this.isLiveMode ? '● LIVE' : '⏸️ PAUSED';
    if (d.statusBadge.textContent !== badgeText) {
      d.statusBadge.textContent = badgeText;
      d.statusBadge.style.color = this.isLiveMode ? '#00ff88' : '#ffaa00';
    }
    
    // Current location
    const locationText = data.current_location || 'Unknown';
    if (d.currentLocation.textContent !== locationText) {
      d.currentLocation.textContent = locationText;
    }
    
    // Destination
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
    
    // Confidence
    const pct = Math.round((data.confidence || 0) * 100);
    const confText = `${pct}%`;
    if (d.confidence.textContent !== confText) {
      d.confidence.textContent = confText;
    }
    d.confidenceFill.style.width = `${pct}%`;
    
    // Reasoning
    const reasoningEl = d.reasoning;
    if (data.reasoning && data.reasoning.length > 0) {
      const newReasoning = data.reasoning.map(r => `<li>${r}</li>`).join('');
      if (reasoningEl.innerHTML !== newReasoning) {
        reasoningEl.innerHTML = newReasoning;
      }
    } else if (reasoningEl.innerHTML !== '<li>No reasoning available</li>') {
      reasoningEl.innerHTML = '<li>No reasoning available</li>';
    }
    
    // Timestamp
    const tsText = data.timestamp ? `⏰ ${new Date(data.timestamp).toLocaleString()}` : '—';
    if (d.timestamp.textContent !== tsText) {
      d.timestamp.textContent = tsText;
    }
  }

  // =============================================
  // 10. TIMELINE RENDER
  // =============================================
  renderTimeline(history) {
    const container = this.dom.timelineEvents;
    container.innerHTML = '';
    
    if (!history || history.length === 0) {
      container.innerHTML = '<span class="event">No events yet</span>';
      return;
    }
    
    const events = history.slice(-20);
    for (const item of events) {
      const el = document.createElement('span');
      el.className = 'event';
      const time = new Date(item.timestamp).toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      const dest = item.destination || item.state || 'unknown';
      const conf = Math.round((item.confidence || 0) * 100);
      const icon = item.state === 'landed' ? '🛬' : 
                   item.state === 'in_flight' ? '🛫' : 
                   item.state === 'grounded' || item.state === 'parked' ? '🅿️' : '❓';
      el.innerHTML = `<span class="time">${time}</span> ${icon} → <span class="dest">${dest}</span> <span class="conf">(${conf}%)</span>`;
      container.appendChild(el);
    }
  }
}

// =============================================
// 11. START
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  const tracker = new ElonTracker();
  tracker.init();
});