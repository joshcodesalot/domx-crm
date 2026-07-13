const crypto = require('crypto');
const {
  buildMarkRenderedMessageScript,
  resolveConfirmedMessageIdFromDom,
  getCurrentMaloumFanInfo,
  setCachedFanInfo,
  getResponseTimeSnapshot,
} = require('./maloumChatUi');

const SEND_MESSAGE_API_REGEX =
  /^https:\/\/api\.maloum\.com\/chats\/([^/]+)\/messages$/;

const CHAT_LOAD_API_REGEX =
  /^https:\/\/api\.maloum\.com\/chats\/([^/]+)(?:\/messages)?(?:\?|$)/;

const CHAT_DETAIL_API_REGEX =
  /^https:\/\/api\.maloum\.com\/chats\/([^/]+)$/;

const CHAT_MESSAGES_LIST_API_REGEX =
  /^https:\/\/api\.maloum\.com\/chats\/([^/]+)\/messages(?:\?|$)/;

const SEND_CLICK_ATTRIBUTION_WINDOW_MS = 5000;
const TRANSLATION_ATTRIBUTION_WINDOW_MS = 15000;
const RETRY_MARK_INTERVAL_MS = 3000;
const REAPPLY_BADGE_DELAYS_MS = [0, 400, 1000, 2000, 4000, 8000];

let mainWindowRef = null;
let retryMarkInterval = null;

const accountIdToCreatorId = new Map();
const recordsById = new Map();
const pendingByRequestId = new Map();
const responseStatusByRequestId = new Map();
const trackerStateByAccount = new Map();
const reapplyTimersByAccount = new Map();
const chatFanInfoByChatId = new Map();
const chatLoadRequestIds = new Set();
const chatMessagesRequestMeta = new Map();
const chatMessagesByChatId = new Map();
const chatDetailByChatId = new Map();
const accountIdToMaloumSenderId = new Map();
const loadingFinishedSendRequestIds = new Set();
const translationSnapshotsByAccount = new Map();

const TRANSLATION_CONSOLE_PREFIX = '__DOMX_TRANSLATION__:';
const MAX_STORED_TRANSLATIONS_PER_ACCOUNT = 20;

function normalizeMessageText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textsMatch(left, right) {
  const normalizedLeft = normalizeMessageText(left);
  const normalizedRight = normalizeMessageText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft === normalizedRight;
}

function storeTranslationSnapshot(accountId, snapshot) {
  if (!accountId || !snapshot?.translatedGermanText) {
    return;
  }

  const existing = translationSnapshotsByAccount.get(accountId) || [];
  const next = [
    {
      chatId: snapshot.chatId || null,
      originalEnglishText: snapshot.originalEnglishText || null,
      translatedGermanText: snapshot.translatedGermanText,
      translatedAt: snapshot.translatedAt || Date.now(),
    },
    ...existing.filter(
      (entry) =>
        !(
          textsMatch(entry.translatedGermanText, snapshot.translatedGermanText) &&
          entry.chatId === (snapshot.chatId || null)
        )
    ),
  ].slice(0, MAX_STORED_TRANSLATIONS_PER_ACCOUNT);

  translationSnapshotsByAccount.set(accountId, next);
}

function findStoredTranslationSnapshot(accountId, chatId, actualSentText) {
  const entries = translationSnapshotsByAccount.get(accountId) || [];
  const now = Date.now();

  for (const entry of entries) {
    if (now - entry.translatedAt > TRANSLATION_ATTRIBUTION_WINDOW_MS) {
      continue;
    }

    if (chatId && entry.chatId && entry.chatId !== chatId) {
      continue;
    }

    if (textsMatch(entry.translatedGermanText, actualSentText)) {
      return entry;
    }
  }

  return null;
}

function resolveEnglishMessage(translationSnapshot, actualSentText) {
  if (
    translationSnapshot?.originalEnglishText &&
    translationSnapshot?.translatedGermanText &&
    textsMatch(translationSnapshot.translatedGermanText, actualSentText)
  ) {
    return translationSnapshot.originalEnglishText;
  }

  if (
    translationSnapshot?.originalEnglishText &&
    textsMatch(translationSnapshot.originalEnglishText, actualSentText)
  ) {
    return translationSnapshot.originalEnglishText;
  }

  return actualSentText;
}

function resolveGermanMessage(translationSnapshot, actualSentText) {
  if (
    translationSnapshot?.translatedGermanText &&
    textsMatch(translationSnapshot.translatedGermanText, actualSentText)
  ) {
    return translationSnapshot.translatedGermanText;
  }

  return actualSentText;
}

function handleTranslationConsoleMessage(accountId, message) {
  if (!message || !message.startsWith(TRANSLATION_CONSOLE_PREFIX)) {
    return;
  }

  try {
    const snapshot = JSON.parse(message.slice(TRANSLATION_CONSOLE_PREFIX.length));
    storeTranslationSnapshot(accountId, snapshot);
  } catch {
    // Ignore malformed translation console payloads
  }
}

async function resolveTranslationSnapshot(webContents, accountId, chatId, actualSentText) {
  const pageSnapshot = await getRecentTranslationSnapshot(webContents);

  if (
    pageSnapshot &&
    textsMatch(pageSnapshot.translatedGermanText, actualSentText)
  ) {
    storeTranslationSnapshot(accountId, {
      chatId,
      originalEnglishText: pageSnapshot.originalEnglishText,
      translatedGermanText: pageSnapshot.translatedGermanText,
      translatedAt: pageSnapshot.translatedAt,
    });
    return pageSnapshot;
  }

  const storedSnapshot = findStoredTranslationSnapshot(accountId, chatId, actualSentText);
  if (storedSnapshot) {
    return storedSnapshot;
  }

  if (
    pageSnapshot &&
    textsMatch(pageSnapshot.originalEnglishText, actualSentText)
  ) {
    return {
      originalEnglishText: actualSentText,
      translatedGermanText: actualSentText,
      translatedAt: pageSnapshot.translatedAt,
    };
  }

  return null;
}

function rememberFanInfo(chatId, fanInfo) {
  if (!chatId || !fanInfo?.fanUsername) {
    return;
  }

  chatFanInfoByChatId.set(chatId, {
    fanId: fanInfo.fanId || null,
    fanUsername: fanInfo.fanUsername,
  });
}

let activeChatter = { userId: null, userName: null };

function isMaloumSendMessageUrl(url) {
  return SEND_MESSAGE_API_REGEX.test(url);
}

function extractChatIdFromSendMessageUrl(url) {
  const match = url.match(SEND_MESSAGE_API_REGEX);
  return match ? match[1] : null;
}

function extractChatIdFromChatLoadUrl(url) {
  const match = url.match(CHAT_LOAD_API_REGEX);
  return match ? match[1] : null;
}

function extractChatIdFromMaloumPageUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('maloum.com')) {
      return null;
    }

    const pathMatch = parsed.pathname.match(/\/chat\/([^/]+)/i);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

function isMaloumChatLoadUrl(url, method) {
  return method === 'GET' && CHAT_LOAD_API_REGEX.test(url);
}

function isMaloumChatDetailUrl(url, method) {
  return method === 'GET' && CHAT_DETAIL_API_REGEX.test(url);
}

function isMaloumChatMessagesListUrl(url, method) {
  return method === 'GET' && CHAT_MESSAGES_LIST_API_REGEX.test(url);
}

function extractChatIdFromMessagesListUrl(url) {
  const match = url.match(CHAT_MESSAGES_LIST_API_REGEX);
  return match ? match[1] : null;
}

function isPaginatedMessagesRequest(url) {
  try {
    const parsed = new URL(url);
    return ['before', 'after', 'cursor', 'next', 'offset'].some((key) =>
      parsed.searchParams.has(key)
    );
  } catch {
    return false;
  }
}

function sortMessagesNewestFirst(messages) {
  return [...messages].sort(
    (left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime()
  );
}

function learnCreatorSenderId(accountId, senderId) {
  if (accountId && senderId) {
    accountIdToMaloumSenderId.set(accountId, String(senderId));
  }
}

function normalizeApiMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const id = message._id || message.id || null;
  const senderId = message.senderId || null;
  const sentAt = message.sentAt || null;

  if (!id || !senderId || !sentAt) {
    return null;
  }

  return {
    id: String(id),
    senderId: String(senderId),
    sentAt: String(sentAt),
  };
}

function parseMessagesListResponse(responseBody) {
  if (!responseBody) {
    return [];
  }

  try {
    const parsed = JSON.parse(responseBody);
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    return data.map(normalizeApiMessage).filter(Boolean);
  } catch {
    return [];
  }
}

function setRecentChatMessagesForChat(chatId, incomingMessages) {
  if (!chatId || !Array.isArray(incomingMessages) || incomingMessages.length === 0) {
    return;
  }

  const sorted = sortMessagesNewestFirst(incomingMessages);

  chatMessagesByChatId.set(chatId, {
    messages: sorted,
    lastMessage: sorted[0] || null,
    updatedAt: Date.now(),
  });
}

function mergeOlderChatMessagesForChat(chatId, olderMessages) {
  if (!chatId || !Array.isArray(olderMessages) || olderMessages.length === 0) {
    return;
  }

  const existing = chatMessagesByChatId.get(chatId) || {
    messages: [],
    lastMessage: null,
    updatedAt: 0,
  };
  const byId = new Map(existing.messages.map((message) => [message.id, message]));

  for (const message of olderMessages) {
    byId.set(message.id, message);
  }

  chatMessagesByChatId.set(chatId, {
    messages: sortMessagesNewestFirst(Array.from(byId.values())),
    lastMessage: existing.lastMessage,
    updatedAt: Date.now(),
  });
}

function addMessageToChatCache(chatId, message) {
  const normalized = normalizeApiMessage(message);
  if (!chatId || !normalized) {
    return;
  }

  const existing = chatMessagesByChatId.get(chatId) || {
    messages: [],
    lastMessage: null,
    updatedAt: 0,
  };
  const byId = new Map(existing.messages.map((entry) => [entry.id, entry]));
  byId.set(normalized.id, normalized);

  chatMessagesByChatId.set(chatId, {
    messages: sortMessagesNewestFirst(Array.from(byId.values())),
    lastMessage: normalized,
    updatedAt: Date.now(),
  });
}

function getCreatorMaloumSenderId(accountId, chatId) {
  const mapped = accountIdToMaloumSenderId.get(accountId);
  if (mapped) {
    return mapped;
  }

  const fanId = getCachedFanInfo(chatId)?.fanId;
  const cache = chatMessagesByChatId.get(chatId);

  if (!cache?.messages?.length) {
    return null;
  }

  const senderCounts = new Map();

  for (const message of cache.messages) {
    if (fanId && message.senderId === fanId) {
      continue;
    }

    senderCounts.set(message.senderId, (senderCounts.get(message.senderId) || 0) + 1);
  }

  let bestSenderId = null;
  let bestCount = 0;

  for (const [senderId, count] of senderCounts.entries()) {
    if (count > bestCount) {
      bestSenderId = senderId;
      bestCount = count;
    }
  }

  if (bestSenderId) {
    learnCreatorSenderId(accountId, bestSenderId);
  }

  return bestSenderId;
}

function parseChatDetailFromResponse(responseBody) {
  if (!responseBody) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody);
    const lastRelevantMessage = normalizeApiMessage(parsed?.lastRelevantMessage);

    return {
      lastRelevantMessage,
    };
  } catch {
    return null;
  }
}

function rememberChatDetail(chatId, detail) {
  if (!chatId || !detail) {
    return;
  }

  chatDetailByChatId.set(String(chatId), {
    lastRelevantMessage: detail.lastRelevantMessage || null,
    updatedAt: Date.now(),
  });
}

function findLatestFanMessageForResponseTime(chatId, accountId) {
  const fanId = getCachedFanInfo(chatId)?.fanId || null;
  const creatorSenderId = getCreatorMaloumSenderId(accountId, chatId);
  const candidates = [];
  const cache = chatMessagesByChatId.get(chatId);

  if (cache?.messages?.length) {
    candidates.push(...cache.messages);
  }

  const detail = chatDetailByChatId.get(chatId);

  if (detail?.lastRelevantMessage) {
    const alreadyCached = candidates.some((message) => message.id === detail.lastRelevantMessage.id);

    if (!alreadyCached) {
      candidates.push(detail.lastRelevantMessage);
    }
  }

  if (!candidates.length) {
    return null;
  }

  const sorted = sortMessagesNewestFirst(candidates);
  let latestFan = null;
  let latestCreator = null;

  for (const message of sorted) {
    if (isLastMessageFromFan(message, fanId, creatorSenderId)) {
      if (!latestFan) {
        latestFan = message;
      }
      continue;
    }

    if (!latestCreator) {
      latestCreator = message;
    }

    if (latestFan && latestCreator) {
      break;
    }
  }

  if (!latestFan?.sentAt) {
    return null;
  }

  if (latestCreator?.sentAt) {
    const fanMs = new Date(latestFan.sentAt).getTime();
    const creatorMs = new Date(latestCreator.sentAt).getTime();

    if (!Number.isNaN(fanMs) && !Number.isNaN(creatorMs) && fanMs <= creatorMs) {
      return null;
    }
  } else {
    const newest = sorted[0];

    if (newest && !isLastMessageFromFan(newest, fanId, creatorSenderId)) {
      return null;
    }
  }

  return latestFan;
}

function buildResponseTimeSnapshot(previousFanMessageAt) {
  const fanSentAtMs = new Date(previousFanMessageAt).getTime();

  if (Number.isNaN(fanSentAtMs)) {
    return null;
  }

  const responseTimeSeconds = Math.max(0, Math.floor((Date.now() - fanSentAtMs) / 1000));

  return {
    previousFanMessageAt,
    responseTimeSeconds,
  };
}

function isLastMessageFromFan(lastMessage, fanId, creatorSenderId) {
  if (!lastMessage?.senderId) {
    return false;
  }

  const senderId = String(lastMessage.senderId);

  if (fanId && senderId === String(fanId)) {
    return true;
  }

  if (creatorSenderId && senderId === String(creatorSenderId)) {
    return false;
  }

  return Boolean(creatorSenderId);
}

function computeResponseTimeSnapshot(chatId, accountId) {
  const fanMessage = findLatestFanMessageForResponseTime(chatId, accountId);

  if (!fanMessage?.sentAt) {
    return {
      previousFanMessageAt: null,
      responseTimeSeconds: null,
    };
  }

  return buildResponseTimeSnapshot(fanMessage.sentAt);
}

async function computeResponseTimeSnapshotWithFallback(
  webContents,
  chatId,
  accountId,
  optimisticMessageId = null
) {
  if (webContents && !webContents.isDestroyed()) {
    try {
      const domSnapshot = await getResponseTimeSnapshot(webContents, optimisticMessageId);

      if (domSnapshot?.responseTimeSeconds != null && domSnapshot?.previousFanMessageAt) {
        return {
          previousFanMessageAt: domSnapshot.previousFanMessageAt,
          responseTimeSeconds: domSnapshot.responseTimeSeconds,
        };
      }
    } catch {
      // DOM is preferred when available; API is the fallback.
    }
  }

  return computeResponseTimeSnapshot(chatId, accountId);
}

function extractMediaCounts(content) {
  const media = Array.isArray(content?.media) ? content.media : [];

  const pictureCount = media.filter((item) => item.type === 'picture').length;
  const videoCount = media.filter((item) => item.type === 'video').length;

  return {
    media,
    mediaCount: media.length,
    pictureCount,
    videoCount,
  };
}

function extractMessageTextFromPayload(payload) {
  if (!payload?.content) {
    return '';
  }

  if (payload.content.type === 'text') {
    return payload.content.text || '';
  }

  if (payload.content.type === 'chat_product') {
    return payload.content.text || '';
  }

  return payload.content.text || '';
}

function extractFanInfoFromChatPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    payload.user,
    payload.fan,
    payload.participant,
    payload.member,
    payload.customer,
    payload.chatPartner,
    payload.otherUser,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fanId = candidate.id || candidate._id || candidate.userId || null;
    const fanUsername =
      candidate.username ||
      candidate.userName ||
      candidate.name ||
      candidate.displayName ||
      null;

    if (fanId || fanUsername) {
      return {
        fanId: fanId ? String(fanId) : null,
        fanUsername: fanUsername ? String(fanUsername) : null,
      };
    }
  }

  if (Array.isArray(payload.participants)) {
    for (const participant of payload.participants) {
      const info = extractFanInfoFromChatPayload({ user: participant });
      if (info) {
        return info;
      }
    }
  }

  return null;
}

function parseFanInfoFromChatResponse(responseBody) {
  if (!responseBody) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody);
    return extractFanInfoFromChatPayload(parsed);
  } catch {
    return null;
  }
}

function getCachedFanInfo(chatId) {
  if (!chatId) {
    return null;
  }

  return chatFanInfoByChatId.get(chatId) || null;
}

function setMainWindow(win) {
  mainWindowRef = win;
}

function setActiveChatter({ userId, userName }) {
  activeChatter = {
    userId: userId || null,
    userName: userName || null,
  };
}

function registerCreatorIdMapping(accountId, creatorId) {
  if (accountId && creatorId) {
    accountIdToCreatorId.set(accountId, creatorId);
  }
}

function registerCreatorIdMappings(sessions) {
  if (!Array.isArray(sessions)) {
    return;
  }

  for (const entry of sessions) {
    if (entry?.accountId && entry?.creatorId) {
      registerCreatorIdMapping(entry.accountId, entry.creatorId);
    }
  }
}

function hydrateSentMessageRecords(accountId, records) {
  if (!accountId || !Array.isArray(records)) {
    return { hydrated: 0 };
  }

  let hydrated = 0;

  for (const record of records) {
    if (!record?.id || record.status !== 'confirmed' || !record.maloumMessageId) {
      continue;
    }

    const existing = recordsById.get(record.id);
    const next = {
      ...(existing || {}),
      id: record.id,
      accountId,
      creatorId: record.creatorId || existing?.creatorId || '',
      chatId: record.chatId || existing?.chatId || '',
      maloumMessageId: record.maloumMessageId,
      optimisticMessageId: record.optimisticMessageId ?? existing?.optimisticMessageId ?? null,
      contentText: record.contentText || existing?.contentText || '',
      sentByUserId: record.sentByUserId || existing?.sentByUserId,
      sentByUserName: record.sentByUserName || existing?.sentByUserName,
      sentAt: record.sentAt || existing?.sentAt,
      status: 'confirmed',
      domMarked: existing?.domMarked ?? false,
    };

    recordsById.set(record.id, next);
    hydrated += 1;
  }

  const state = trackerStateByAccount.get(accountId);
  if (state?.webContents && !state.webContents.isDestroyed()) {
    scheduleReapplySentBadgesForOpenChat(state.webContents, accountId);
  }

  return { hydrated };
}

function getCreatorIdForAccount(accountId) {
  return accountIdToCreatorId.get(accountId) || null;
}

function emitSentMessageEvent(record, accountId) {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return;
  }

  mainWindowRef.webContents.send('creator:sent-message-tracked', {
    accountId,
    record: { ...record },
  });
}

function saveSentMessageRecord(record) {
  recordsById.set(record.id, { ...record });
  emitSentMessageEvent(record, record.accountId);
}

function updateSentMessageRecord(recordId, updates) {
  const existing = recordsById.get(recordId);
  if (!existing) {
    return null;
  }

  const next = { ...existing, ...updates };
  recordsById.set(recordId, next);

  const updateKeys = Object.keys(updates);
  const isDomMarkedOnly =
    updateKeys.length > 0 && updateKeys.every((key) => key === 'domMarked');

  if (!isDomMarkedOnly) {
    emitSentMessageEvent(next, next.accountId);
  }

  return next;
}

function getConfirmedSentMessages(accountId, chatId = null) {
  const results = [];

  for (const record of recordsById.values()) {
    if (record.accountId !== accountId) {
      continue;
    }

    if (record.status !== 'confirmed' || !record.maloumMessageId) {
      continue;
    }

    if (chatId && record.chatId !== chatId) {
      continue;
    }

    results.push(record);
  }

  return results;
}

function getConfirmedUnmarkedSentMessages(accountId) {
  return getConfirmedSentMessages(accountId).filter((record) => !record.domMarked);
}

function resolveChatterAttribution(webContents) {
  if (activeChatter.userId && activeChatter.userName) {
    return {
      sentByUserId: activeChatter.userId,
      sentByUserName: activeChatter.userName,
    };
  }

  return getSendClickAttribution(webContents);
}

async function getSendClickAttribution(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { sentByUserId: 'unknown', sentByUserName: 'Unknown' };
  }

  try {
    const attribution = await webContents.executeJavaScript(`
      (function() {
        const clickAt = window.__domxLastSendButtonClickAt || 0;
        const now = Date.now();
        const withinWindow = now - clickAt <= ${SEND_CLICK_ATTRIBUTION_WINDOW_MS};
        const snapshot = window.__domxSendClickAttribution;

        if (withinWindow && snapshot && snapshot.userId) {
          return {
            sentByUserId: snapshot.userId,
            sentByUserName: snapshot.userName || 'Unknown',
          };
        }

        return null;
      })()
    `);

    if (attribution?.sentByUserId) {
      return attribution;
    }
  } catch {
    // Page may be navigating
  }

  return { sentByUserId: 'unknown', sentByUserName: 'Unknown' };
}

async function getRecentTranslationSnapshot(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }

  try {
    return await webContents.executeJavaScript(`
      (function() {
        const translatedAt = window.__domxLastTranslationAt || null;
        if (!translatedAt) return null;

        const ageMs = Date.now() - translatedAt;
        if (ageMs > ${TRANSLATION_ATTRIBUTION_WINDOW_MS}) {
          return null;
        }

        return {
          originalEnglishText: window.__domxLastOriginalEnglishText || null,
          translatedGermanText: window.__domxLastTranslatedGermanText || null,
          translatedAt,
        };
      })()
    `);
  } catch {
    return null;
  }
}

function parseMaloumMessageIdFromResponse(responseBody) {
  if (!responseBody) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody);

    if (typeof parsed === 'string') {
      return parsed;
    }

    if (parsed?._id) {
      return String(parsed._id);
    }

    if (parsed?.id) {
      return String(parsed.id);
    }

    if (parsed?.messageId) {
      return String(parsed.messageId);
    }
  } catch {
    const trimmed = String(responseBody).replaceAll('"', '').trim();
    return trimmed || null;
  }

  return null;
}

function parseConfirmedSendMessageFromResponse(responseBody) {
  if (!responseBody) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody);
    return normalizeApiMessage(parsed);
  } catch {
    return null;
  }
}

async function markRenderedMaloumMessage(webContents, record) {
  if (!record?.maloumMessageId || !webContents || webContents.isDestroyed()) {
    return false;
  }

  try {
    const marked = await webContents.executeJavaScript(buildMarkRenderedMessageScript(record));

    return Boolean(marked);
  } catch (error) {
    console.warn('Failed to mark rendered Maloum message:', error);
    return false;
  }
}

async function reapplySentBadgesForOpenChat(webContents, accountId, chatId = null) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  let resolvedChatId = chatId;

  if (!resolvedChatId) {
    resolvedChatId = extractChatIdFromMaloumPageUrl(webContents.getURL());
  }

  const records = getConfirmedSentMessages(accountId, resolvedChatId || null);

  for (const record of records) {
    const marked = await markRenderedMaloumMessage(webContents, record);

    if (marked) {
      updateSentMessageRecord(record.id, { domMarked: true });
    } else if (record.domMarked) {
      updateSentMessageRecord(record.id, { domMarked: false });
    }
  }
}

function clearScheduledReapply(accountId) {
  const timers = reapplyTimersByAccount.get(accountId);
  if (!timers) {
    return;
  }

  for (const timer of timers) {
    clearTimeout(timer);
  }

  reapplyTimersByAccount.delete(accountId);
}

function scheduleReapplySentBadgesForOpenChat(webContents, accountId, chatId = null) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  clearScheduledReapply(accountId);

  const timers = REAPPLY_BADGE_DELAYS_MS.map((delayMs) =>
    setTimeout(() => {
      if (webContents.isDestroyed()) {
        return;
      }

      void reapplySentBadgesForOpenChat(webContents, accountId, chatId);
    }, delayMs)
  );

  reapplyTimersByAccount.set(accountId, timers);
}

async function retryMarkUnmarkedSentMessages(webContents, accountId) {
  await reapplySentBadgesForOpenChat(webContents, accountId);
}

async function tryGetSendResponseBody(debuggerSession, requestId) {
  try {
    const bodyResult = await debuggerSession.sendCommand('Network.getResponseBody', {
      requestId,
    });
    return bodyResult?.body || '';
  } catch (error) {
    return {
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleSendMessageResponse(webContents, accountId, requestId, debuggerSession) {
  const record = pendingByRequestId.get(requestId);
  if (!record) {
    return;
  }

  const status = responseStatusByRequestId.get(requestId);

  if (!status) {
    loadingFinishedSendRequestIds.add(requestId);
    return;
  }

  pendingByRequestId.delete(requestId);
  responseStatusByRequestId.delete(requestId);
  loadingFinishedSendRequestIds.delete(requestId);

  if (status < 200 || status >= 300) {
    updateSentMessageRecord(record.id, { status: 'failed' });
    return;
  }

  const bodyResult = await tryGetSendResponseBody(debuggerSession, requestId);
  const responseBody = typeof bodyResult === 'string' ? bodyResult : bodyResult?.body || '';
  const confirmedSendMessage = parseConfirmedSendMessageFromResponse(responseBody);
  let maloumMessageId = confirmedSendMessage?.id || parseMaloumMessageIdFromResponse(responseBody);
  let confirmationSource = responseBody ? 'network-body' : null;

  if (confirmedSendMessage?.senderId) {
    learnCreatorSenderId(accountId, confirmedSendMessage.senderId);
  }

  if (confirmedSendMessage && record.chatId) {
    addMessageToChatCache(record.chatId, confirmedSendMessage);
  }

  if (!maloumMessageId) {
    maloumMessageId = await resolveConfirmedMessageIdFromDom(
      webContents,
      record.optimisticMessageId,
      record.actualSentText
    );
    if (maloumMessageId) {
      confirmationSource = 'dom-fallback';
    }
  }

  if (!maloumMessageId) {
    updateSentMessageRecord(record.id, { status: 'failed' });
    return;
  }

  const confirmed = updateSentMessageRecord(record.id, {
    maloumMessageId,
    status: 'confirmed',
  });

  if (!confirmed) {
    return;
  }

  const marked = await markRenderedMaloumMessage(webContents, confirmed);

  if (marked) {
    updateSentMessageRecord(confirmed.id, { domMarked: true });
  }

  void scheduleReapplySentBadgesForOpenChat(webContents, accountId, confirmed.chatId);
}

async function handleChatMessagesResponse(webContents, accountId, requestId, debuggerSession) {
  const meta = chatMessagesRequestMeta.get(requestId);
  chatMessagesRequestMeta.delete(requestId);

  if (!meta?.chatId) {
    return;
  }

  const { chatId, paginated } = meta;

  const status = responseStatusByRequestId.get(requestId);
  responseStatusByRequestId.delete(requestId);

  if (!status || status < 200 || status >= 300) {
    return;
  }

  let responseBody = '';

  try {
    const bodyResult = await debuggerSession.sendCommand('Network.getResponseBody', {
      requestId,
    });
    responseBody = bodyResult?.body || '';
  } catch {
    return;
  }

  const messages = parseMessagesListResponse(responseBody);

  if (paginated) {
    mergeOlderChatMessagesForChat(chatId, messages);
  } else {
    setRecentChatMessagesForChat(chatId, messages);
  }

  getCreatorMaloumSenderId(accountId, chatId);
}

async function handleChatLoadResponse(webContents, accountId, requestId, debuggerSession) {
  if (!chatLoadRequestIds.has(requestId)) {
    return;
  }

  chatLoadRequestIds.delete(requestId);

  const status = responseStatusByRequestId.get(requestId);
  responseStatusByRequestId.delete(requestId);

  if (!status || status < 200 || status >= 300) {
    return;
  }

  let responseBody = '';

  try {
    const bodyResult = await debuggerSession.sendCommand('Network.getResponseBody', {
      requestId,
    });
    responseBody = bodyResult?.body || '';
  } catch {
    return;
  }

  let chatId = extractChatIdFromMaloumPageUrl(webContents.getURL());

  try {
    const parsed = JSON.parse(responseBody);
    chatId = chatId || parsed?.id || parsed?.chatId || parsed?._id || null;
  } catch {
    // Ignore parse errors
  }

  const fanInfo = parseFanInfoFromChatResponse(responseBody);
  const chatDetail = parseChatDetailFromResponse(responseBody);

  if (chatId && fanInfo && (fanInfo.fanId || fanInfo.fanUsername)) {
    rememberFanInfo(String(chatId), fanInfo);
    await setCachedFanInfo(webContents, fanInfo);
  }

  if (chatId && chatDetail) {
    rememberChatDetail(String(chatId), chatDetail);

    if (chatDetail.lastRelevantMessage && !chatMessagesByChatId.has(String(chatId))) {
      setRecentChatMessagesForChat(String(chatId), [chatDetail.lastRelevantMessage]);
    }
  }
}

async function handleChatLoadRequest(webContents, accountId, params) {
  const { request } = params;
  const url = request?.url || '';
  const method = request?.method || '';

  if (!isMaloumChatLoadUrl(url, method)) {
    return;
  }

  const chatId = extractChatIdFromChatLoadUrl(url);

  if (isMaloumChatDetailUrl(url, method)) {
    chatLoadRequestIds.add(params.requestId);
  }

  if (isMaloumChatMessagesListUrl(url, method)) {
    const messagesChatId = extractChatIdFromMessagesListUrl(url);
    if (messagesChatId) {
      chatMessagesRequestMeta.set(params.requestId, {
        chatId: messagesChatId,
        paginated: isPaginatedMessagesRequest(url),
      });
    }
  }

  if (chatId) {
    void getCurrentMaloumFanInfo(webContents)
      .then((fanInfo) => {
        if (fanInfo?.fanUsername) {
          rememberFanInfo(chatId, fanInfo);
          return setCachedFanInfo(webContents, fanInfo);
        }
        return null;
      })
      .catch(() => null);
  }

  scheduleReapplySentBadgesForOpenChat(webContents, accountId, chatId);
}

async function handleSendMessageRequest(webContents, accountId, params) {
  const { request } = params;
  const url = request?.url || '';
  const method = request?.method || '';

  if (!isMaloumSendMessageUrl(url) || method !== 'POST') {
    return;
  }

  const chatId = extractChatIdFromSendMessageUrl(url);
  const creatorId = getCreatorIdForAccount(accountId);

  let payload = null;

  try {
    payload = request.postData ? JSON.parse(request.postData) : null;
  } catch {
    payload = null;
  }

  if (!payload?.content) {
    return;
  }

  const content = payload.content;
  const optimisticMessageId = payload.optimisticMessageId || null;
  const actualSentText = extractMessageTextFromPayload(payload);
  const mediaInfo = extractMediaCounts(content);
  const attribution = await resolveChatterAttribution(webContents);
  const translationSnapshot = await resolveTranslationSnapshot(
    webContents,
    accountId,
    chatId,
    actualSentText
  );
  const responseTimeSnapshot = await computeResponseTimeSnapshotWithFallback(
    webContents,
    chatId,
    accountId,
    optimisticMessageId
  );
  const pageFanInfo = await getCurrentMaloumFanInfo(webContents);
  const cachedFanInfo = getCachedFanInfo(chatId);

  if (pageFanInfo?.fanUsername) {
    rememberFanInfo(chatId, pageFanInfo);
  }

  const activeFan = pageFanInfo?.fanUsername ? pageFanInfo : cachedFanInfo || null;
  const sentAt = new Date().toISOString();
  const englishMessage = resolveEnglishMessage(translationSnapshot, actualSentText);
  const germanTranslatedMessage = resolveGermanMessage(translationSnapshot, actualSentText);

  const record = {
    id: crypto.randomUUID(),
    accountId,
    creatorId: creatorId || '',
    chatId: chatId || '',
    maloumMessageId: null,
    optimisticMessageId,
    contentText: actualSentText,
    sentByUserId: attribution.sentByUserId,
    sentByUserName: attribution.sentByUserName,
    sentAt,
    status: 'pending',
    domMarked: false,
    originalEnglishText: translationSnapshot?.originalEnglishText || null,
    translatedGermanText: translationSnapshot?.translatedGermanText || null,
    translatedAt: translationSnapshot?.translatedAt || null,
    contentType: content.type || 'text',
    englishMessage,
    germanTranslatedMessage,
    actualSentText,
    priceNet: typeof content.priceNet === 'number' ? content.priceNet : null,
    currency: 'EUR',
    purchased: false,
    mediaCount: mediaInfo.mediaCount,
    pictureCount: mediaInfo.pictureCount,
    videoCount: mediaInfo.videoCount,
    mediaJson: mediaInfo.media,
    fanId: activeFan?.fanId || null,
    fanUsername: activeFan?.fanUsername || null,
    previousFanMessageAt: responseTimeSnapshot?.previousFanMessageAt || null,
    responseTimeSeconds:
      responseTimeSnapshot?.responseTimeSeconds != null
        ? responseTimeSnapshot.responseTimeSeconds
        : null,
  };

  if (translationSnapshot) {
    console.log('DomX pre-send translation logged:', {
      originalEnglishText: translationSnapshot.originalEnglishText,
      translatedGermanText: translationSnapshot.translatedGermanText,
      contentText: actualSentText,
    });
  }

  pendingByRequestId.set(params.requestId, record);
  saveSentMessageRecord(record);
}

function getTrackerState(accountId) {
  if (!trackerStateByAccount.has(accountId)) {
    trackerStateByAccount.set(accountId, {
      attached: false,
      debuggerHandler: null,
      webContents: null,
    });
  }
  return trackerStateByAccount.get(accountId);
}

async function installMaloumSentMessageTracker(webContents, accountId) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  const state = getTrackerState(accountId);
  state.webContents = webContents;

  if (state.attached) {
    return;
  }

  const debuggerSession = webContents.debugger;

  try {
    if (!debuggerSession.isAttached()) {
      debuggerSession.attach('1.3');
    }
  } catch (error) {
    if (!String(error?.message || error).includes('Already attached')) {
      console.warn('Failed to attach CDP debugger for sent-message tracking:', error);
      return;
    }
  }

  const onConsoleMessage = (_event, _level, message) => {
    handleTranslationConsoleMessage(accountId, message);
  };

  const onDebuggerMessage = async (_event, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        await handleSendMessageRequest(webContents, accountId, params);
        await handleChatLoadRequest(webContents, accountId, params);
        return;
      }

      if (method === 'Network.responseReceived') {
        const { response, requestId } = params;
        if (response?.url) {
          if (isMaloumSendMessageUrl(response.url)) {
            responseStatusByRequestId.set(requestId, response.status);

            if (loadingFinishedSendRequestIds.has(requestId)) {
              loadingFinishedSendRequestIds.delete(requestId);
              await handleSendMessageResponse(
                webContents,
                accountId,
                requestId,
                debuggerSession
              );
            }
          } else if (isMaloumChatDetailUrl(response.url, 'GET')) {
            responseStatusByRequestId.set(requestId, response.status);
          } else if (isMaloumChatMessagesListUrl(response.url, 'GET')) {
            responseStatusByRequestId.set(requestId, response.status);
          }
        }
        return;
      }

      if (method === 'Network.loadingFinished') {
        if (pendingByRequestId.has(params.requestId)) {
          await handleSendMessageResponse(
            webContents,
            accountId,
            params.requestId,
            debuggerSession
          );
          return;
        }

        if (chatLoadRequestIds.has(params.requestId)) {
          await handleChatLoadResponse(
            webContents,
            accountId,
            params.requestId,
            debuggerSession
          );
          return;
        }

        if (chatMessagesRequestMeta.has(params.requestId)) {
          await handleChatMessagesResponse(
            webContents,
            accountId,
            params.requestId,
            debuggerSession
          );
        }
      }
    } catch (error) {
      console.warn('Maloum sent-message tracker CDP handler error:', error);
    }
  };

  debuggerSession.on('message', onDebuggerMessage);
  webContents.on('console-message', onConsoleMessage);

  try {
    await debuggerSession.sendCommand('Network.enable');
  } catch (error) {
    console.warn('Failed to enable Network domain for sent-message tracking:', error);
  }

  state.attached = true;
  state.debuggerHandler = onDebuggerMessage;
  state.consoleHandler = onConsoleMessage;
}

function uninstallMaloumSentMessageTracker(accountId) {
  clearScheduledReapply(accountId);

  const state = trackerStateByAccount.get(accountId);
  if (!state) {
    return;
  }

  const { webContents, debuggerHandler, consoleHandler } = state;

  if (webContents && !webContents.isDestroyed() && debuggerHandler) {
    try {
      webContents.debugger.removeListener('message', debuggerHandler);
    } catch {
      // Ignore detach errors
    }

    if (consoleHandler) {
      try {
        webContents.removeListener('console-message', consoleHandler);
      } catch {
        // Ignore detach errors
      }
    }

    try {
      if (webContents.debugger.isAttached()) {
        webContents.debugger.detach();
      }
    } catch {
      // Ignore detach errors
    }
  }

  trackerStateByAccount.delete(accountId);

  for (const [requestId, record] of pendingByRequestId.entries()) {
    if (record.accountId === accountId) {
      pendingByRequestId.delete(requestId);
      responseStatusByRequestId.delete(requestId);
    }
  }

  for (const requestId of chatLoadRequestIds) {
    chatLoadRequestIds.delete(requestId);
    responseStatusByRequestId.delete(requestId);
  }

  for (const requestId of chatMessagesRequestMeta.keys()) {
    chatMessagesRequestMeta.delete(requestId);
    responseStatusByRequestId.delete(requestId);
  }

  accountIdToMaloumSenderId.delete(accountId);
  translationSnapshotsByAccount.delete(accountId);
}

function startRetryMarkInterval(getPreparedViews) {
  if (retryMarkInterval) {
    return;
  }

  retryMarkInterval = setInterval(() => {
    const views = typeof getPreparedViews === 'function' ? getPreparedViews() : [];

    for (const { accountId, webContents } of views) {
      if (!webContents || webContents.isDestroyed()) {
        continue;
      }

      void reapplySentBadgesForOpenChat(webContents, accountId);
    }
  }, RETRY_MARK_INTERVAL_MS);
}

function stopRetryMarkInterval() {
  if (retryMarkInterval) {
    clearInterval(retryMarkInterval);
    retryMarkInterval = null;
  }
}

module.exports = {
  setMainWindow,
  setActiveChatter,
  registerCreatorIdMapping,
  registerCreatorIdMappings,
  getCreatorIdForAccount,
  installMaloumSentMessageTracker,
  uninstallMaloumSentMessageTracker,
  retryMarkUnmarkedSentMessages,
  reapplySentBadgesForOpenChat,
  scheduleReapplySentBadgesForOpenChat,
  hydrateSentMessageRecords,
  startRetryMarkInterval,
  stopRetryMarkInterval,
  getActiveChatter: () => ({ ...activeChatter }),
};
