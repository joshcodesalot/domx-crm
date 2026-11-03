const OpenAI = require('openai');

const XAI_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_XAI_MODEL = 'grok-4.20-0309-non-reasoning';

let client = null;

function getClient() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is not set');
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: XAI_BASE_URL,
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
    model: model || process.env.XAI_MODEL || DEFAULT_XAI_MODEL,
    messages: input,
  });
  const outputText = readOutputText(response.choices?.[0]?.message?.content);
  return {
    outputText,
    usage: response.usage || null,
  };
}

module.exports = {
  XAI_BASE_URL,
  DEFAULT_XAI_MODEL,
  createResponse,
};
