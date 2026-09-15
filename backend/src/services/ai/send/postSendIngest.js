const telegramWorker = require('../../telegramWorker');
const maloumClient = require('../../maloumClient');
const fourBasedClient = require('../../fourBasedClient');
const {
  loadMaloumCreator,
  loadFourBasedCreator,
} = require('../../platformCreatorSession');
const { ingestConversation } = require('../ingest');
const {
  mapTelegramMessagesForIngest,
} = require('../poller/telegramInboundPoller');
const { mapMaloumMessagesForIngest } = require('../poller/maloumInboundPoller');
const {
  mapFourBasedMessagesForIngest,
} = require('../poller/fourBasedInboundPoller');
const { isChatNotFoundError, resolvePlatformChat } = require('./resolvePlatformChat');

const POST_SEND_PAGE_LIMIT = 15;

function normalizeMessages(payload) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function latestInboundId(mapped) {
  const inbounds = (Array.isArray(mapped) ? mapped : []).filter(
    (msg) => msg && msg.direction === 'inbound' && msg.platformMessageId
  );
  if (inbounds.length === 0) return null;
  return inbounds.reduce((latest, msg) => {
    const latestAt = Date.parse(latest.sentAt);
    const msgAt = Date.parse(msg.sentAt);
    if (Number.isFinite(msgAt) && Number.isFinite(latestAt)) {
      return msgAt >= latestAt ? msg : latest;
    }
    if (Number.isFinite(msgAt)) return msg;
    return latest;
  }).platformMessageId;
}

function resolvePostSendDeps(deps = {}) {
  return {
    listTelegramMessages:
      deps.listTelegramMessages ||
      telegramWorker.listMessages.bind(telegramWorker),
    getMaloumMessages:
      deps.getMaloumMessages || maloumClient.getMessages.bind(maloumClient),
    getFourBasedMessages:
      deps.getFourBasedMessages ||
      fourBasedClient.getMessages.bind(fourBasedClient),
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    ingestConversation: deps.ingestConversation || ingestConversation,
    markTelegramRead:
      deps.markTelegramRead || telegramWorker.markChatRead.bind(telegramWorker),
    markMaloumRead:
      deps.markMaloumRead || maloumClient.markRead.bind(maloumClient),
    markFourBasedReceived:
      deps.markFourBasedReceived ||
      fourBasedClient.markReceived.bind(fourBasedClient),
    resolvePlatformChat: deps.resolvePlatformChat || resolvePlatformChat,
    sleep:
      deps.sleep ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    confirmDelayMs:
      deps.confirmDelayMs == null ? 1500 : Number(deps.confirmDelayMs) || 0,
  };
}

async function persistIngest(d, {
  mapped,
  platform,
  creatorId,
  platformChatId,
  platformFanId,
  fanUsername,
}) {
  if (!mapped.length) return;
  await d.ingestConversation({
    creatorId,
    platform,
    platformChatId,
    platformFanId:
      platformFanId || (platform === 'telegram' ? platformChatId : null),
    fanUsername: fanUsername || null,
    source: 'post_send',
    skipProcess: false,
    messages: mapped,
  });
}

async function ingestAfterSend(
  {
    platform,
    creatorId,
    platformChatId,
    platformFanId,
    fanUsername,
    answeredInboundId,
    skipMarkRead = false,
  } = {},
  deps = {}
) {
  const d = resolvePostSendDeps(deps);
  try {
    let chatId = platformChatId;
    let fetched;
    try {
      fetched = await fetchMappedMessages(d, {
        platform,
        creatorId,
        platformChatId: chatId,
      });
    } catch (err) {
      if (!isChatNotFoundError(err)) throw err;
      const loaded =
        platform === 'maloum'
          ? await d.loadMaloumCreator(creatorId)
          : platform === '4based'
            ? await d.loadFourBasedCreator(creatorId)
            : null;
      const resolved = await d.resolvePlatformChat(
        {
          platform,
          creator: loaded?.creator,
          platformChatId: chatId,
          platformFanId,
        },
        d
      );
      if (!resolved?.platformChatId) throw err;
      chatId = resolved.platformChatId;
      fetched = await fetchMappedMessages(d, {
        platform,
        creatorId,
        platformChatId: chatId,
      });
    }
    const { mapped, creator } = fetched;
    await persistIngest(d, {
      mapped,
      platform,
      creatorId,
      platformChatId: chatId,
      platformFanId,
      fanUsername,
    });
    const latestInbound = latestInboundId(mapped);
    const answered = answeredInboundId || null;
    if (skipMarkRead || !answered || latestInbound !== answered) {
      return {
        markedRead: false,
        latestInbound,
        ingested: mapped.length,
      };
    }
    const delayMs = d.confirmDelayMs;
    if (delayMs > 0) await d.sleep(delayMs);
    const second = await fetchMappedMessages(d, {
      platform,
      creatorId,
      platformChatId: chatId,
    });
    await persistIngest(d, {
      mapped: second.mapped,
      platform,
      creatorId,
      platformChatId: chatId,
      platformFanId,
      fanUsername,
    });
    const latestConfirm = latestInboundId(second.mapped);
    if (!answered || latestConfirm !== answered) {
      return {
        markedRead: false,
        latestInbound: latestConfirm,
        ingested: mapped.length + second.mapped.length,
      };
    }
    await markReadAfterSend(d, {
      platform,
      creatorId,
      platformChatId: chatId,
      creator: second.creator || creator,
    });
    return {
      markedRead: true,
      latestInbound: latestConfirm,
      ingested: mapped.length + second.mapped.length,
    };
  } catch (err) {
    console.error('AI post-send ingest error:', err);
    return { markedRead: false, error: true };
  }
}

async function fetchMappedMessages(d, { platform, creatorId, platformChatId }) {
  if (platform === 'telegram') {
    const payload = await d.listTelegramMessages(creatorId, platformChatId, {
      limit: POST_SEND_PAGE_LIMIT,
      markRead: false,
    });
    return {
      mapped: mapTelegramMessagesForIngest(normalizeMessages(payload)),
      creator: null,
    };
  }
  if (platform === 'maloum') {
    const loaded = await d.loadMaloumCreator(creatorId);
    const creator = loaded?.creator || null;
    if (!creator) return { mapped: [], creator: null };
    const payload = await d.getMaloumMessages(creator, platformChatId, {
      limit: POST_SEND_PAGE_LIMIT,
    });
    return {
      mapped: mapMaloumMessagesForIngest(
        normalizeMessages(payload),
        creator.providerUserId || null
      ),
      creator,
    };
  }
  if (platform === '4based') {
    const loaded = await d.loadFourBasedCreator(creatorId);
    const creator = loaded?.creator || null;
    if (!creator) return { mapped: [], creator: null };
    const payload = await d.getFourBasedMessages(creator, platformChatId, {
      limit: POST_SEND_PAGE_LIMIT,
    });
    return {
      mapped: mapFourBasedMessagesForIngest(
        normalizeMessages(payload),
        creator.providerUserId || null
      ),
      creator,
    };
  }
  return { mapped: [], creator: null };
}

async function markReadAfterSend(d, { platform, creatorId, platformChatId, creator }) {
  if (platform === 'telegram') {
    await d.markTelegramRead(creatorId, platformChatId);
    return;
  }
  if (platform === 'maloum') {
    const loaded = creator || (await d.loadMaloumCreator(creatorId))?.creator;
    if (loaded) await d.markMaloumRead(loaded, platformChatId);
    return;
  }
  if (platform === '4based') {
    const loaded = creator || (await d.loadFourBasedCreator(creatorId))?.creator;
    if (loaded) await d.markFourBasedReceived(loaded, platformChatId);
  }
}

module.exports = {
  POST_SEND_PAGE_LIMIT,
  normalizeMessages,
  latestInboundId,
  ingestAfterSend,
};
