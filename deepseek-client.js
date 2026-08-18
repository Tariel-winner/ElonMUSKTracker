const OpenAI = require('openai');

// Initialize DeepSeek client (OpenAI-compatible)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'YOUR_DEEPSEEK_API_KEY_HERE',
  baseURL: 'https://api.deepseek.com/v1',
});

async function askDeepSeek(prompt) {
  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are an expert intelligence analyst tracking Elon Musk. Combine flight data, time patterns, news, and property data to infer his current location.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500,
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('[DEEPSEEK] Error:', error.message);
    return null;
  }
}

module.exports = { askDeepSeek };
