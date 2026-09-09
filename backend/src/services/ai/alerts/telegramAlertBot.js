const { fetch: undiciFetch } = require('undici');
const pool = require('../../../db/pool');
const {
  takeoverConversation,
  resumeConversation,
} = require('../review/suggestionService');
const { summarizeUsage } = require('../usage');

const BOT_API_ORIGIN = 'https://api.telegram.org';
const COMMANDS = new Set([
  'pause',
  'resume',
  'takeover',
  'release',
  'cost',
  'help',
  'commands',
]);
const HELP_TEXT = `AI alert bot commands:
/help
/commands
/cost
/pause <creatorId>
/resume <creatorId>
/takeover <conversationId>
/release <conversationId>`;

let running = false;
let offset = 0;
let loopPromise = null;

const ALERT_DRAFT_MAX = 140;

function firstLinePreview(text, max = ALERT_DRAFT_MAX) {
  const line = String(text || '')
    .split(/\r?\n/)[0]
    .trim();
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formatHandlingAlertTarget({ creatorName, platform, fanLabel } = {}) {
  const creator = String(creatorName || '').trim() || 'Creator';
  const plat = String(platform || '').trim() || '—';
  const fan = String(fanLabel || '').trim() || 'Fan';
  return `${creator} · ${plat} · ${fan}`;
}

function formatNeedsReviewAlert(input = {}) {
  const draft = firstLinePreview(input.replyEnglish || input.reply);
  const head = `AI needs review · ${formatHandlingAlertTarget(input)}`;
  return draft ? `${head}\n${draft}` : head;
}

function formatAutoSendOkAlert(input = {}) {
  return `AI auto-send ok · ${formatHandlingAlertTarget(input)}`;
}

function parseTopicId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseChatEntry(part) {
  const trimmed = String(part || '').trim();
  const match = trimmed.match(/^(-?\d+)(?::(\d+))?$/);
  if (!match) return { chatId: trimmed, topicId: null };
  return {
    chatId: match[1],
    topicId: parseTopicId(match[2]),
  };
}

function readConfig(env = process.env) {
  const token = String(env.TELEGRAM_ALERT_BOT_TOKEN || '').trim();
  const defaultTopicId = parseTopicId(env.TELEGRAM_ALERT_TOPIC_ID);
  const topicsByChat = {};
  const chatIds = String(env.TELEGRAM_ALERT_CHAT_IDS || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const entry = parseChatEntry(part);
      if (entry.topicId != null) topicsByChat[entry.chatId] = entry.topicId;
      return entry.chatId;
    })
    .filter(Boolean);
  return { token, chatIds, topicsByChat, defaultTopicId };
}

function isConfigured(config = readConfig()) {
  return Boolean(config.token && Array.isArray(config.chatIds) && config.chatIds.length);
}

function isAllowedChat(chatId, config = readConfig()) {
  if (chatId == null || chatId === '') return false;
  const id = String(chatId);
  return (config.chatIds || []).some((allowed) => String(allowed) === id);
}

function topicForChat(chatId, config = {}) {
  const id = String(chatId);
  const byChat = config.topicsByChat && config.topicsByChat[id];
  const fromEntry = parseTopicId(byChat);
  if (fromEntry != null) return fromEntry;
  return parseTopicId(config.defaultTopicId);
}

function buildSendPayload(chatId, text, threadId) {
  const payload = { chat_id: chatId, text };
  const topic = parseTopicId(threadId);
  if (topic != null) payload.message_thread_id = topic;
  return payload;
}

function parseCommand(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(
    /^\/(pause|resume|takeover|release|cost|help|commands)(?:@\S+)?(?:\s+(.+))?$/i
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

  if (name === 'help' || name === 'commands') {
    return HELP_TEXT;
  }

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
        buildSendPayload(chatId, message, topicForChat(chatId, config)),
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
    buildSendPayload(chatId, reply, msg.message_thread_id),
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
  HELP_TEXT,
  ALERT_DRAFT_MAX,
  firstLinePreview,
  formatNeedsReviewAlert,
  formatAutoSendOkAlert,
  parseChatEntry,
  parseTopicId,
  readConfig,
  isConfigured,
  isAllowedChat,
  topicForChat,
  buildSendPayload,
  parseCommand,
  botMethodUrl,
  notifyAlertChats,
  dispatchCommand,
  handleUpdate,
  pollOnce,
  startTelegramAlertBot,
  stopTelegramAlertBot,
};
