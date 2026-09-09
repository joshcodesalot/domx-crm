const pool = require('../../../db/pool');
const xaiClient = require('../providers/xaiClient');
const { extractJsonObject } = require('../providers/jsonExtract');
const maloumClient = require('../../maloumClient');
const fourBasedClient = require('../../fourBasedClient');
const telegramWorker = require('../../telegramWorker');
const {
  loadMaloumCreator,
  loadFourBasedCreator,
} = require('../../platformCreatorSession');
const { getFanMemory, upsertFanMemory, FACT_KINDS } = require('../memory');
const { resolveGivenName, looksLikeOpaqueId, sanitizeFanUsername } = require('../names');
const { withTimeout } = require('../generation/generateReply');
const { emitToUsers } = require('../../userEventBus');
const { getUserIdsWithCreatorAccess } = require('../../creatorAccess');

const EXTRACT_TIMEOUT_MS = 20000;
const EXTRACT_MESSAGE_LIMIT = 80;
const AI_NOTES_MARKER = '--- AI ---';
const FACT_KIND_SET = new Set(FACT_KINDS);

const EXTRACT_PROMPT = `Extract durable fan facts from a chat history.
Return JSON only:
{
  "givenName": null,
  "facts": [{ "kind": "name|preference|boundary|spend|other", "text": "short fact" }]
}
Rules:
- givenName only if the fan clearly stated their real/given name. Never use username, handle, or id.
- facts: kinks/preferences, limits/boundaries, spend, name. Max 12. No secrets.
- If unsure, omit.`.trim();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function compactMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-EXTRACT_MESSAGE_LIMIT)
    .map((msg) => ({
      role: msg.senderRole || (msg.direction === 'outbound' ? 'creator' : 'fan'),
      text: asText(msg.text).slice(0, 400),
      sentAt: msg.sentAt || null,
    }))
    .filter((msg) => msg.text.trim());
}

function normalizeExtracted(parsed, { username } = {}) {
  const facts = [];
  for (const raw of Array.isArray(parsed?.facts) ? parsed.facts : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = FACT_KIND_SET.has(raw.kind) ? raw.kind : 'other';
    const text = asText(raw.text).trim().slice(0, 300);
    if (!text) continue;
    facts.push({ kind, text });
    if (facts.length >= 12) break;
  }
  const usernameNorm = sanitizeFanUsername(username);
  let givenName = asText(parsed?.givenName).trim() || null;
  if (
    !givenName ||
    looksLikeOpaqueId(givenName) ||
    (usernameNorm && givenName.toLowerCase() === usernameNorm.toLowerCase())
  ) {
    givenName = null;
  }
  return { givenName, facts };
}

async function extractFanFacts(
  { messages, username, existingMemory, provider, timeoutMs } = {}
) {
  const impl = provider || xaiClient;
  const input = [
    { role: 'system', content: EXTRACT_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        username: sanitizeFanUsername(username) || null,
        existingNickname: existingMemory?.nickname || null,
        messages: compactMessages(messages),
      }),
    },
  ];
  const response = await withTimeout(
    impl.createResponse({ input }),
    timeoutMs == null ? EXTRACT_TIMEOUT_MS : timeoutMs,
    'extract_timeout'
  );
  const parsed = extractJsonObject(response?.outputText);
  return normalizeExtracted(parsed, { username });
}

function factsByKind(facts, kind) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact.kind === kind)
    .map((fact) => fact.text)
    .filter(Boolean);
}

const DEFAULT_FAN_NOTES_TEMPLATE = `🖤 Fetishes / Kinks:
🎓 Experience Level:
🚫 Hard Limits:
🧸 Toys Owned:
💎 VIP Status:
⛓️ Ongoing Sessions / Tasks:
✅ Progress / Completed:
🤍 Aftercare Needs:
📝 Last Session Notes:
🎂 Age:
📍 Location:
💍 Relationship Status:`;

const KINKS_LABEL_RE = /Fetishes\s*\/\s*Kinks:/i;
const LIMITS_LABEL_RE = /Hard Limits:/i;

function stripAiNotesBlock(existing) {
  const current = asText(existing);
  const idx = current.indexOf(AI_NOTES_MARKER);
  if (idx === -1) return current.trim();
  return current.slice(0, idx).trim();
}

function isBareTemplate(text) {
  const trimmed = asText(text).trim();
  if (!trimmed) return true;
  const templateLines = DEFAULT_FAN_NOTES_TEMPLATE.split('\n').map((line) =>
    line.trim()
  );
  const bodyLines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!bodyLines.length) return true;
  for (const line of bodyLines) {
    const template = templateLines.find(
      (label) => line === label || (label && line.startsWith(label))
    );
    if (!template) return false;
    const extra = line.slice(template.length).trim();
    if (extra) return false;
  }
  return true;
}

function splitNoteValues(text) {
  return asText(text)
    .split(/;|,/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeNoteValues(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const part of [...splitNoteValues(existing), ...(incoming || [])]) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

function upsertLabeledLine(body, labelRe, values) {
  if (!Array.isArray(values) || !values.length) return body;
  const lines = asText(body).split('\n');
  const idx = lines.findIndex((line) => labelRe.test(line));
  if (idx === -1) return body;
  const line = lines[idx];
  const match = line.match(labelRe);
  if (!match) return body;
  const prefix = line.slice(0, match.index + match[0].length).trimEnd();
  const current = line.slice(match.index + match[0].length).trim();
  const merged = mergeNoteValues(current, values);
  lines[idx] = `${prefix} ${merged.join('; ')}`.trimEnd();
  return lines.join('\n');
}

function hasLabeledLine(body, labelRe) {
  return asText(body)
    .split('\n')
    .some((line) => labelRe.test(line));
}

function buildAiNotesBlock({ givenName, facts } = {}) {
  const spend = factsByKind(facts, 'spend');
  const other = factsByKind(facts, 'other');
  const lines = [AI_NOTES_MARKER];
  if (givenName) lines.push(`Name: ${givenName}`);
  if (spend.length) lines.push(`Spend: ${spend.join('; ')}`);
  if (other.length) lines.push(`Other: ${other.join('; ')}`);
  if (lines.length === 1) return '';
  return lines.join('\n');
}

function mergeAiNotesBlock(existing, block) {
  const nextBlock = asText(block).trim();
  if (!nextBlock) return asText(existing).trim();
  const current = asText(existing);
  const idx = current.indexOf(AI_NOTES_MARKER);
  if (idx === -1) {
    return current.trim() ? `${current.trim()}\n\n${nextBlock}` : nextBlock;
  }
  const prefix = current.slice(0, idx).trim();
  return prefix ? `${prefix}\n\n${nextBlock}` : nextBlock;
}

function applyFanNotesTemplate(existing, { givenName, facts } = {}) {
  const kinks = factsByKind(facts, 'preference');
  const limits = factsByKind(facts, 'boundary');
  let body = stripAiNotesBlock(existing);
  if (!body || isBareTemplate(body)) {
    body = DEFAULT_FAN_NOTES_TEMPLATE;
  } else if (
    (kinks.length && !hasLabeledLine(body, KINKS_LABEL_RE)) ||
    (limits.length && !hasLabeledLine(body, LIMITS_LABEL_RE))
  ) {
    body = `${DEFAULT_FAN_NOTES_TEMPLATE}\n\n${body}`;
  }
  body = upsertLabeledLine(body, KINKS_LABEL_RE, kinks);
  body = upsertLabeledLine(body, LIMITS_LABEL_RE, limits);
  const appendix = buildAiNotesBlock({ givenName, facts });
  if (!appendix) return body.trim();
  return `${body.trim()}\n\n${appendix}`;
}

function shouldWriteFanNotes(facts, givenName) {
  return Boolean(
    factsByKind(facts, 'preference').length ||
      factsByKind(facts, 'boundary').length ||
      factsByKind(facts, 'spend').length ||
      factsByKind(facts, 'other').length ||
      givenName
  );
}

async function readMaloumNotes(getChat, creator, chatId) {
  const chat = await getChat(creator, chatId);
  return (
    asText(chat?.chatPartner?.notes).trim() ||
    asText(chat?.notes).trim() ||
    ''
  );
}

async function readFourBasedNotes(getPivot, creator, fanId) {
  if (!fanId) return '';
  const pivot = await getPivot(creator, fanId);
  return asText(pivot?.note).trim() || asText(pivot?.notes).trim() || '';
}

async function readTelegramNotes(telegramUserId, client = pool) {
  if (!telegramUserId) return '';
  const result = await client.query(
    `SELECT notes FROM telegram_fan_notes WHERE "telegramUserId" = $1`,
    [telegramUserId]
  );
  return asText(result.rows[0]?.notes).trim();
}

async function writeTelegramNickname(creatorId, telegramUserId, nickname, client = pool) {
  await client.query(
    `INSERT INTO telegram_fan_profiles (
       "creatorId", "telegramUserId", nickname, "displayName"
     )
     VALUES ($1, $2, $3, '')
     ON CONFLICT ("creatorId", "telegramUserId")
     DO UPDATE SET nickname = EXCLUDED.nickname, "updatedAt" = NOW()`,
    [creatorId, telegramUserId, nickname]
  );
}

async function defaultLoadTriggerInbound(
  { conversationId, inboundPlatformMessageId } = {},
  client = pool
) {
  const convoId = String(conversationId || '').trim();
  const inboundId = String(inboundPlatformMessageId || '').trim();
  if (!convoId || !inboundId) return null;
  const result = await client.query(
    `SELECT "platformMessageId", direction, "senderRole", text, "sentAt"
     FROM ai_messages
     WHERE "conversationId" = $1 AND "platformMessageId" = $2
     LIMIT 1`,
    [convoId, inboundId]
  );
  return result.rows[0] || null;
}

function hasInboundMessage(messages, inboundPlatformMessageId) {
  const inboundId = String(inboundPlatformMessageId || '').trim();
  if (!inboundId) return true;
  return (Array.isArray(messages) ? messages : []).some(
    (msg) => String(msg?.platformMessageId || '') === inboundId
  );
}

async function ensureTriggerInbound(
  messages,
  { conversationId, inboundPlatformMessageId, loadTriggerInbound } = {}
) {
  const list = Array.isArray(messages) ? [...messages] : [];
  if (hasInboundMessage(list, inboundPlatformMessageId)) return list;
  const row = await loadTriggerInbound({
    conversationId,
    inboundPlatformMessageId,
  });
  if (row) list.push(row);
  return list;
}

function toFanMemoryEvent({
  creatorId,
  platform,
  platformChatId,
  platformFanId,
  nickname,
  notes,
} = {}) {
  return {
    type: 'ai:fan-memory',
    creatorId: creatorId || null,
    platform: platform || null,
    platformChatId: platformChatId || null,
    platformFanId: platformFanId || null,
    nickname: nickname || null,
    notes: notes || null,
  };
}

async function emitFanMemoryEvent(payload = {}, deps = {}) {
  if (!payload.creatorId || (!payload.nickname && !payload.notes)) {
    return { emitted: false, reason: 'empty' };
  }
  const loadAccess = deps.getUserIdsWithCreatorAccess || getUserIdsWithCreatorAccess;
  const emit = deps.emitToUsers || emitToUsers;
  const userIds = await loadAccess(payload.creatorId);
  emit(userIds, toFanMemoryEvent(payload));
  return { emitted: true };
}

async function extractAndSyncFanMemory(
  { conversation, creatorId, platform, messages, inboundPlatformMessageId } = {},
  deps = {}
) {
  const d = {
    pool: deps.pool || pool,
    getFanMemory: deps.getFanMemory || getFanMemory,
    upsertFanMemory: deps.upsertFanMemory || upsertFanMemory,
    extractFanFacts: deps.extractFanFacts || extractFanFacts,
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    getChat: deps.getChat || maloumClient.getChat.bind(maloumClient),
    updateFanNickname:
      deps.updateFanNickname || maloumClient.updateFanNickname.bind(maloumClient),
    updateFanNotes:
      deps.updateFanNotes || maloumClient.updateFanNotes.bind(maloumClient),
    getPivot: deps.getPivot || fourBasedClient.getPivot.bind(fourBasedClient),
    updatePivot: deps.updatePivot || fourBasedClient.updatePivot.bind(fourBasedClient),
    upsertFanNotes:
      deps.upsertFanNotes || telegramWorker.upsertFanNotes.bind(telegramWorker),
    writeTelegramNickname: deps.writeTelegramNickname || writeTelegramNickname,
    loadTriggerInbound: deps.loadTriggerInbound || defaultLoadTriggerInbound,
    emitFanMemoryEvent: deps.emitFanMemoryEvent || emitFanMemoryEvent,
    provider: deps.provider || null,
  };

  const platformFanId = String(conversation?.platformFanId || '').trim();
  if (!conversation?.id || !platformFanId) {
    console.error('AI memory extract skipped: missing_fan');
    return { skipped: true, reason: 'missing_fan' };
  }

  let history = Array.isArray(messages) ? messages : [];
  try {
    history = await ensureTriggerInbound(history, {
      conversationId: conversation.id,
      inboundPlatformMessageId:
        inboundPlatformMessageId || conversation.lastInboundPlatformMessageId,
      loadTriggerInbound: (input) => d.loadTriggerInbound(input, d.pool),
    });
  } catch (err) {
    console.error('AI memory extract trigger inbound load error:', err);
  }

  const existing = await d.getFanMemory({
    creatorId,
    platform,
    platformFanId,
  });
  const extracted = await d.extractFanFacts({
    messages: history,
    username: conversation.fanUsername,
    existingMemory: existing,
    provider: d.provider || undefined,
  });
  const givenName = resolveGivenName({
    statedName: extracted.givenName,
    nickname: existing.nickname,
    notes: existing.sourceNotes,
    memories: [...(existing.facts || []), ...(extracted.facts || [])],
    username: conversation.fanUsername,
  });

  const mergedFacts = [];
  const seen = new Set();
  for (const fact of [...(existing.facts || []), ...(extracted.facts || [])]) {
    const key = `${fact.kind}:${String(fact.text || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedFacts.push(fact);
    if (mergedFacts.length >= 20) break;
  }

  const memory = await d.upsertFanMemory({
    creatorId,
    platform,
    platformFanId,
    nickname: givenName,
    facts: mergedFacts,
  });

  const writeNotes = shouldWriteFanNotes(mergedFacts, givenName);
  let writtenNickname = null;
  let writtenNotes = null;

  try {
    if (platform === 'maloum') {
      const loaded = await d.loadMaloumCreator(creatorId);
      if (!loaded?.error && loaded?.creator) {
        if (givenName) {
          await d.updateFanNickname(
            loaded.creator,
            conversation.platformChatId,
            givenName
          );
          writtenNickname = givenName;
        }
        if (writeNotes) {
          const existingNotes = await readMaloumNotes(
            d.getChat,
            loaded.creator,
            conversation.platformChatId
          );
          writtenNotes = applyFanNotesTemplate(existingNotes, {
            givenName,
            facts: mergedFacts,
          });
          await d.updateFanNotes(
            loaded.creator,
            conversation.platformChatId,
            writtenNotes
          );
        }
      }
    } else if (platform === '4based') {
      const loaded = await d.loadFourBasedCreator(creatorId);
      if (!loaded?.error && loaded?.creator) {
        const existingNotes = await readFourBasedNotes(
          d.getPivot,
          loaded.creator,
          platformFanId
        );
        const patch = {};
        if (givenName) {
          patch.alias = givenName;
          writtenNickname = givenName;
        }
        if (writeNotes) {
          writtenNotes = applyFanNotesTemplate(existingNotes, {
            givenName,
            facts: mergedFacts,
          });
          patch.note = writtenNotes;
        }
        if (Object.keys(patch).length) {
          await d.updatePivot(loaded.creator, platformFanId, patch);
        }
      }
    } else if (platform === 'telegram') {
      if (givenName) {
        await d.writeTelegramNickname(creatorId, platformFanId, givenName, d.pool);
        writtenNickname = givenName;
      }
      if (writeNotes) {
        const existingNotes = await readTelegramNotes(platformFanId, d.pool);
        writtenNotes = applyFanNotesTemplate(existingNotes, {
          givenName,
          facts: mergedFacts,
        });
        await d.upsertFanNotes(platformFanId, writtenNotes);
      }
    }
  } catch (err) {
    console.error('AI memory platform sync error:', err);
  }

  if (writtenNickname || writtenNotes) {
    try {
      await d.emitFanMemoryEvent({
        creatorId,
        platform,
        platformChatId: conversation.platformChatId || null,
        platformFanId,
        nickname: writtenNickname,
        notes: writtenNotes,
      });
    } catch (err) {
      console.error('AI memory event emit error:', err);
    }
  }

  return { skipped: false, givenName, memory, notes: writtenNotes };
}

module.exports = {
  AI_NOTES_MARKER,
  DEFAULT_FAN_NOTES_TEMPLATE,
  EXTRACT_PROMPT,
  extractFanFacts,
  normalizeExtracted,
  buildAiNotesBlock,
  mergeAiNotesBlock,
  applyFanNotesTemplate,
  ensureTriggerInbound,
  toFanMemoryEvent,
  emitFanMemoryEvent,
  extractAndSyncFanMemory,
};
