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

function buildAiNotesBlock({ givenName, facts } = {}) {
  const kinks = factsByKind(facts, 'preference');
  const limits = factsByKind(facts, 'boundary');
  const spend = factsByKind(facts, 'spend');
  const lines = [AI_NOTES_MARKER];
  if (givenName) lines.push(`Name: ${givenName}`);
  if (kinks.length) lines.push(`Kinks: ${kinks.join('; ')}`);
  if (limits.length) lines.push(`Limits: ${limits.join('; ')}`);
  if (spend.length) lines.push(`Spend: ${spend.join('; ')}`);
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

async function extractAndSyncFanMemory(
  { conversation, creatorId, platform, messages } = {},
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
    provider: deps.provider || null,
  };

  const platformFanId = String(conversation?.platformFanId || '').trim();
  if (!conversation?.id || !platformFanId) {
    return { skipped: true, reason: 'missing_fan' };
  }

  const existing = await d.getFanMemory({
    creatorId,
    platform,
    platformFanId,
  });
  const extracted = await d.extractFanFacts({
    messages,
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

  const notesBlock = buildAiNotesBlock({
    givenName,
    facts: mergedFacts,
  });

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
        }
        if (notesBlock) {
          const existingNotes = await readMaloumNotes(
            d.getChat,
            loaded.creator,
            conversation.platformChatId
          );
          await d.updateFanNotes(
            loaded.creator,
            conversation.platformChatId,
            mergeAiNotesBlock(existingNotes, notesBlock)
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
        if (givenName) patch.alias = givenName;
        if (notesBlock) patch.note = mergeAiNotesBlock(existingNotes, notesBlock);
        if (Object.keys(patch).length) {
          await d.updatePivot(loaded.creator, platformFanId, patch);
        }
      }
    } else if (platform === 'telegram') {
      if (givenName) {
        await d.writeTelegramNickname(creatorId, platformFanId, givenName, d.pool);
      }
      if (notesBlock) {
        const existingNotes = await readTelegramNotes(platformFanId, d.pool);
        await d.upsertFanNotes(
          platformFanId,
          mergeAiNotesBlock(existingNotes, notesBlock)
        );
      }
    }
  } catch (err) {
    console.error('AI memory platform sync error:', err);
  }

  return { skipped: false, givenName, memory };
}

module.exports = {
  AI_NOTES_MARKER,
  EXTRACT_PROMPT,
  extractFanFacts,
  normalizeExtracted,
  buildAiNotesBlock,
  mergeAiNotesBlock,
  extractAndSyncFanMemory,
};
