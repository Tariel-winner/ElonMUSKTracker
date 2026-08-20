const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'YOUR_DEEPSEEK_API_KEY_HERE',
  baseURL: 'https://api.deepseek.com/v1',
});

/**
 * Ask DeepSeek for a structured hypothesis.
 * Returns raw message content (expect JSON) or null.
 */
async function askDeepSeek(prompt) {
  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            'You rank location HYPOTHESES for a study dashboard. ' +
            'You do not have live GPS. Prefer Unknown when evidence is weak. ' +
            'Only pick from the provided candidate place names. ' +
            'Return ONLY valid JSON: {"destination":"Name or Unknown","confidence":0-1,"reasoning":["..."]}. ' +
            'Cap confidence at 0.45 unless last ADS-B is very near a candidate.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('[DEEPSEEK] Error:', error.message);
    return null;
  }
}

module.exports = { askDeepSeek };
