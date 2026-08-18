const fs = require('fs');

// Load the static property database once when server starts
const staticData = JSON.parse(
  fs.readFileSync('./elon_musk_properties.json', 'utf8')
);

// Ensure all property types exist
staticData.secondary_properties = staticData.secondary_properties || [];

module.exports = staticData;