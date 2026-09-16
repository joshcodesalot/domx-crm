const OpenAI = require('openai');

const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning';

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: XAI_BASE_URL,
    });
  }
  return client;
}

async function createResponse({ input, model } = {}) {
  const response = await getClient().responses.create({
    model: model || XAI_MODEL,
    input,
  });
  return {
    outputText: response.output_text || '',
    usage: response.usage || null,
  };
}

module.exports = {
  XAI_MODEL,
  XAI_BASE_URL,
  createResponse,
};
