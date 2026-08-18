// Holds the latest state in RAM so we don't query DB every 30 seconds
const cache = {
    currentFlight: null,      // Last flight data from ADS-B
    previousFlight: null,     // Flight data from previous cron run
    latestConclusion: null,   // Last AI conclusion
    landingDetected: false,   // Flag to trigger Waze fetch only once
    lastLandingTime: null,    // Timestamp of last landing
  };
  
  module.exports = cache;