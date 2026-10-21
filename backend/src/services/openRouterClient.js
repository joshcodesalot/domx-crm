const OpenAI = require('openai');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'cognitivecomputations/dolphin-mistral-24b-venice-edition';

let client = null;

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return client;
}

function readOutputText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

async function createResponse({ input, model } = {}) {
  const response = await getClient().chat.completions.create({
    model: model || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    messages: input,
  });
  const outputText = readOutputText(response.choices?.[0]?.message?.content);
  return {
    outputText,
    usage: response.usage || null,
  };
}

module.exports = {
  OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  createResponse,
};
