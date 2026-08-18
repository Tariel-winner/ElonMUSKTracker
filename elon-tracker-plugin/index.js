// dsh-plugin.js - Updated to use DeepSeek LLM

module.exports = {
  name: 'elon-tracker',
  description: 'Tracks Elon Musk using DeepSeek AI',
  
  async query(args) {
    try {
      // 1. Fetch flight data from OpenSky
      const fetch = require('node-fetch');
      const adsbRes = await fetch('https://opensky-network.org/api/states/all');
      
      if (!adsbRes.ok) {
        throw new Error(`OpenSky API error: ${adsbRes.status}`);
      }
      
      const adsbData = await adsbRes.json();
      const states = adsbData.states || [];
      const flight = states.find(f => f[1] && f[1].trim() === 'N628TS');
      
      // 2. Get static properties (from Harness or local)
      let staticData = {};
      try {
        staticData = this.app.plugins.get('static-data') || require('./static-data');
      } catch (e) {
        // Fallback to hardcoded properties
        staticData = {
          corporate_hqs: [
            { name: 'Tesla HQ', lat: 30.2655, lng: -97.7044 },
            { name: 'SpaceX HQ', lat: 33.9207, lng: -118.3271 },
            { name: 'xAI HQ', lat: 37.4450, lng: -122.1470 }
          ],
          residences: [
            { name: 'Bel Air Mansion', lat: 34.0882, lng: -118.4420 },
            { name: 'Manhattan Penthouse', lat: 40.7773, lng: -73.9760 }
          ]
        };
      }
      
      // 3. Get the LLM plugin (REAL AI)
      const llm = this.app.plugins.get('llm');
      if (!llm) {
        return {
          success: false,
          error: 'LLM plugin not available. Please add your DeepSeek API key.'
        };
      }
      
      // 4. Build the prompt
      const flightInfo = flight ? {
        lat: flight[6],
        lng: flight[5],
        altitude: flight[7],
        on_ground: flight[8],
        speed: flight[9],
        heading: flight[10],
        callsign: flight[1]
      } : null;
      
      const prompt = `
        You are an expert intelligence analyst tracking Elon Musk.
        
        CURRENT DATA:
        - Time: ${new Date().toLocaleString()}
        - Flight Status: ${flightInfo ? 'Jet is in the air' : 'Jet is not in the air (grounded)'}
        ${flightInfo ? `- Location: ${flightInfo.lat}, ${flightInfo.lng}` : ''}
        ${flightInfo ? `- Heading: ${flightInfo.heading}°` : ''}
        ${flightInfo ? `- Speed: ${flightInfo.speed} knots` : ''}
        ${flightInfo ? `- Altitude: ${flightInfo.altitude} feet` : ''}
        
        KNOWN PROPERTIES:
        Corporate HQs: ${JSON.stringify(staticData.corporate_hqs)}
        Residences: ${JSON.stringify(staticData.residences)}
        
        TASK:
        1. If the jet is in the air: predict where it's heading based on its heading direction.
        2. If the jet is grounded: infer where Elon is based on time of day and property locations.
        3. Return ONLY a JSON object with:
           - "destination": the most likely location name
           - "confidence": a number between 0 and 1
           - "reasoning": a list of 2-3 sentences explaining your logic
      `;
      
      // 5. Call DeepSeek LLM
      const aiResponse = await llm.complete({
        messages: [
          { role: 'system', content: 'You are an expert tracking billionaire movements.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      });
      
      // 6. Parse and return
      let conclusion;
      try {
        // Try to parse as JSON
        conclusion = JSON.parse(aiResponse);
      } catch (e) {
        // If not JSON, use as text
        conclusion = {
          destination: 'Unknown',
          confidence: 0,
          reasoning: [aiResponse || 'No analysis available']
        };
      }
      
      return {
        success: true,
        data: {
          flight: flightInfo || { status: 'grounded' },
          conclusion,
          timestamp: new Date().toISOString()
        }
      };
      
    } catch (error) {
      console.error('[dsh-plugin] Error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
};