const { fetch: undiciFetch } = require('undici');
const pool = require('../../../db/pool');
const {
  takeoverConversation,
  resumeConversation,
} = require('../review/suggestionService');
const { summarizeUsage } = require('../usage');

const BOT_API_ORIGIN = 'https://api.telegram.org';
const COMMANDS = new Set(['pause', 'resume', 'takeover', 'release', 'cost']);

let running = false;
let offset = 0;
let loopPromise = null;

function readConfig(env = process.env) {
  const token = String(env.TELEGRAM_ALERT_BOT_TOKEN || '').trim();
  const chatIds = String(env.TELEGRAM_ALERT_CHAT_IDS || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return { token, chatIds };
}

function isConfigured(config = readConfig()) {
  return Boolean(config.token && Array.isArray(config.chatIds) && config.chatIds.length);
}

function isAllowedChat(chatId, config = readConfig()) {
  if (chatId == null || chatId === '') return false;
  const id = String(chatId);
  return (config.chatIds || []).some((allowed) => String(allowed) === id);
}

function parseCommand(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(
    /^\/(pause|resume|takeover|release|cost)(?:@\S+)?(?:\s+(.+))?$/i
  );
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    arg: String(match[2] || '').trim(),
  };
}

function botMethodUrl(token, method) {
  return `${BOT_API_ORIGIN}/bot${token}/${method}`;
}

async function callBotApi(config, method, body, fetchImpl = undiciFetch) {
  const response = await fetchImpl(botMethodUrl(config.token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response?.ok) {
    const err = new Error(`alert_bot_${method}_failed`);
    err.status = response?.status;
    throw err;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function defaultSetCreatorPaused(creatorId, paused, client = pool) {
  const id = String(creatorId || '').trim();
  if (!id) return null;
  const result = await client.query(
    `INSERT INTO ai_creator_settings ("creatorId", mode, paused)
     VALUES ($1, 'suggest_only', $2)
     ON CONFLICT ("creatorId") DO UPDATE SET
       paused = EXCLUDED.paused,
       "updatedAt" = NOW()
     RETURNING "creatorId", mode, paused`,
    [id, Boolean(paused)]
  );
  return result.rows[0] || null;
}

function formatCost(summary) {
  const totals = summary?.totals || {};
  const cost = Number(totals.costUsd) || 0;
  const runs = Number(totals.runs) || 0;
  return `Today: ${runs} runs, $${cost.toFixed(4)}`;
}

async function dispatchCommand(command, deps = {}) {
  const name = command?.name;
  const arg = String(command?.arg || '').trim();
  if (!COMMANDS.has(name)) return 'Unknown command.';

  if (name === 'cost') {
    const summarize = deps.summarizeUsage || summarizeUsage;
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    const summary = await summarize({ from: from.toISOString() });
    return formatCost(summary);
  }

  if (name === 'pause' || name === 'resume') {
    if (!arg) return 'Usage: /pause <creatorId> or /resume <creatorId>';
    const setPaused = deps.setCreatorPaused || defaultSetCreatorPaused;
    const row = await setPaused(arg, name === 'pause');
    if (!row) return 'Creator not found.';
    return name === 'pause' ? `Paused ${arg}` : `Resumed ${arg}`;
  }

  if (name === 'takeover') {
    if (!arg) return 'Usage: /takeover <conversationId>';
    const takeover = deps.takeoverConversation || takeoverConversation;
    const row = await takeover({ conversationId: arg, userId: null });
    if (!row) return 'Conversation not found.';
    return `Takeover ${arg}`;
  }

  if (name === 'release') {
    if (!arg) return 'Usage: /release <conversationId>';
    const release = deps.resumeConversation || resumeConversation;
    const row = await release({ conversationId: arg });
    if (!row) return 'Conversation not found.';
    return `Released ${arg}`;
  }

  return 'Unknown command.';
}

async function notifyAlertChats(text, deps = {}) {
  const config = deps.config || readConfig();
  if (!isConfigured(config)) return { sent: 0 };
  const message = String(text || '').trim();
  if (!message) return { sent: 0 };
  const fetchImpl = deps.fetch || undiciFetch;
  let sent = 0;
  for (const chatId of config.chatIds) {
    try {
      await callBotApi(
        config,
        'sendMessage',
        { chat_id: chatId, text: message },
        fetchImpl
      );
      sent += 1;
    } catch (err) {
      console.error('AI alert bot notify error:', err);
    }
  }
  return { sent };
}

async function handleUpdate(update, deps = {}) {
  const config = deps.config || readConfig();
  if (!isConfigured(config)) return { handled: false, reason: 'not_configured' };

  const msg = update?.message;
  if (!msg) return { handled: false, reason: 'no_message' };

  const chatId = msg.chat?.id;
  if (!isAllowedChat(chatId, config)) {
    return { handled: false, reason: 'not_allowed' };
  }

  const command = parseCommand(msg.text);
  if (!command) return { handled: false, reason: 'not_command' };

  const reply = await dispatchCommand(command, deps);
  const fetchImpl = deps.fetch || undiciFetch;
  await callBotApi(
    config,
    'sendMessage',
    { chat_id: chatId, text: reply },
    fetchImpl
  );
  return { handled: true, command: command.name };
}

async function pollOnce(deps = {}) {
  const config = deps.config || readConfig();
  if (!isConfigured(config)) return [];
  const fetchImpl = deps.fetch || undiciFetch;
  const payload = await callBotApi(
    config,
    'getUpdates',
    { offset, timeout: deps.timeout == null ? 25 : deps.timeout },
    fetchImpl
  );
  const updates = Array.isArray(payload?.result) ? payload.result : [];
  for (const update of updates) {
    const next = Number(update?.update_id);
    if (Number.isFinite(next) && next >= offset) offset = next + 1;
    try {
      await handleUpdate(update, { ...deps, config, fetch: fetchImpl });
    } catch (err) {
      console.error('AI alert bot update error:', err);
    }
  }
  return updates;
}

async function loop(deps = {}) {
  while (running) {
    try {
      await pollOnce(deps);
    } catch (err) {
      console.error('AI alert bot poll error:', err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function startTelegramAlertBot(deps = {}) {
  const config = deps.config || readConfig();
  if (!isConfigured(config)) return { started: false };
  if (running) return { started: true, already: true };
  running = true;
  loopPromise = loop({ ...deps, config });
  return { started: true };
}

function stopTelegramAlertBot() {
  running = false;
  offset = 0;
  loopPromise = null;
}

module.exports = {
  BOT_API_ORIGIN,
  readConfig,
  isConfigured,
  isAllowedChat,
  parseCommand,
  botMethodUrl,
  notifyAlertChats,
  dispatchCommand,
  handleUpdate,
  pollOnce,
  startTelegramAlertBot,
  stopTelegramAlertBot,
};
