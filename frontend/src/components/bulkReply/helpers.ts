import { DEFAULT_FAN_NOTES_TEMPLATE } from '@/components/maloum/MaloumFanPanel';
import {
  fanFromChat,
  partnerName as fourBasedPartnerName,
} from '@/components/fourbased/FourBasedChatPanels';
import {
  messageText,
  partnerId,
  partnerName as maloumPartnerName,
} from '@/components/maloum/MaloumChatPanels';
import {
  createMessagingDashboardEntry,
  getFourBasedMessages,
  getFourBasedPivot,
  getMaloumChat,
  getMaloumMessages,
  listFourBasedChats,
  listMaloumChats,
  sendFourBasedMessage,
  sendMaloumMessage,
  suggestReply,
  type Creator,
  type FourBasedChat,
  type FourBasedMessage,
  type MaloumChat,
  type MaloumMessage,
  type SuggestReplyOption,
  type TranslateHistoryItem,
  type User,
} from '@/lib/api';
import type { BulkUnreadChat } from './types';

function sanitizeFanNotes(notes: string | null | undefined): string {
  const trimmed = typeof notes === 'string' ? notes.trim() : '';
  if (!trimmed || trimmed === DEFAULT_FAN_NOTES_TEMPLATE.trim()) return '';
  return trimmed;
}

export function previewText(value: string | null | undefined, max = 120): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    runNext()
  );
  await Promise.all(runners);
}

export function maloumChatToUnread(chat: MaloumChat): BulkUnreadChat {
  return {
    chatId: String(chat._id),
    fanId: partnerId(chat),
    fanName: maloumPartnerName(chat),
    lastMessagePreview: previewText(chat.lastRelevantMessage?.text),
    lastMessageAt: chat.lastRelevantMessage?.sentAt || null,
  };
}

export function fourBasedChatToUnread(
  chat: FourBasedChat,
  providerUserId: string | null
): BulkUnreadChat {
  const fan = fanFromChat(chat, providerUserId);
  return {
    chatId: String(chat._id),
    fanId: fan.id || null,
    fanName: fourBasedPartnerName(chat, providerUserId),
    lastMessagePreview: previewText(chat.last_message?.message),
    lastMessageAt:
      chat.last_message?.created_at ||
      chat.last_real_message_updated_at ||
      chat.updated_at ||
      null,
  };
}

export async function loadMaloumUnreadChats(
  creatorId: string,
  options: { limit?: number; next?: string | null } = {}
): Promise<{ chats: BulkUnreadChat[]; next: string | null }> {
  const result = await listMaloumChats(creatorId, {
    limit: options.limit ?? 40,
    next: options.next || undefined,
    filter: 'unread',
  });
  return {
    chats: (result.chats || []).map(maloumChatToUnread),
    next: result.next || null,
  };
}

export async function loadFourBasedUnreadChats(
  creatorId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ chats: BulkUnreadChat[]; providerUserId: string | null; hasMore: boolean }> {
  const limit = options.limit ?? 40;
  const offset = options.offset ?? 0;
  const result = await listFourBasedChats(creatorId, {
    limit,
    offset,
    filter: 'unread',
  });
  const providerUserId = result.providerUserId || null;
  const chats = (result.chats || []).map((chat) =>
    fourBasedChatToUnread(chat, providerUserId)
  );
  return {
    chats,
    providerUserId,
    hasMore: (result.chats || []).length >= limit,
  };
}

function maloumMessagesToHistory(
  messages: MaloumMessage[],
  providerUserId: string | null
): TranslateHistoryItem[] {
  // API returns newest-first; reverse for chronological suggest context.
  const chronological = [...messages].reverse();
  return chronological
    .filter((m) => messageText(m).trim())
    .slice(-12)
    .map((m) => ({
      role:
        providerUserId && m.senderId === providerUserId
          ? ('assistant' as const)
          : ('user' as const),
      content: messageText(m).trim(),
    }));
}

function fourBasedMessagesToHistory(
  messages: FourBasedMessage[],
  providerUserId: string | null
): TranslateHistoryItem[] {
  const chronological = [...messages].reverse();
  return chronological
    .filter((m) => typeof m.message === 'string' && m.message.trim())
    .slice(-12)
    .map((m) => ({
      role:
        m.user_id === providerUserId
          ? ('assistant' as const)
          : ('user' as const),
      content: m.message!.trim(),
    }));
}

export async function draftMaloumSuggestReply(
  creatorId: string,
  chatId: string,
  fanName: string
): Promise<{ suggestions: SuggestReplyOption[] }> {
  const [messagesResult, chatResult] = await Promise.all([
    getMaloumMessages(creatorId, chatId, { limit: 20 }),
    getMaloumChat(creatorId, chatId).catch(() => null),
  ]);

  const providerUserId =
    messagesResult.providerUserId || chatResult?.providerUserId || null;
  const history = maloumMessagesToHistory(messagesResult.messages || [], providerUserId);
  if (history.length === 0) {
    throw new Error('No messages available to draft a reply');
  }

  const notesFromChat =
    typeof chatResult?.chat?.chatPartner?.notes === 'string'
      ? chatResult.chat.chatPartner.notes
      : '';

  return suggestReply({
    messages: history,
    fanNotes: sanitizeFanNotes(notesFromChat),
    fanName,
  });
}

export async function draftFourBasedSuggestReply(
  creatorId: string,
  chatId: string,
  fanId: string | null,
  fanName: string,
  providerUserIdHint: string | null
): Promise<{ suggestions: SuggestReplyOption[] }> {
  const messagesResult = await getFourBasedMessages(creatorId, chatId, {
    limit: 20,
    offset: 0,
  });
  const providerUserId =
    messagesResult.providerUserId || providerUserIdHint || null;
  const history = fourBasedMessagesToHistory(
    messagesResult.messages || [],
    providerUserId
  );
  if (history.length === 0) {
    throw new Error('No messages available to draft a reply');
  }

  let fanNotes = '';
  if (fanId) {
    try {
      const pivot = await getFourBasedPivot(creatorId, fanId);
      fanNotes = sanitizeFanNotes(pivot.note);
    } catch {
      fanNotes = '';
    }
  }

  return suggestReply({
    messages: history,
    fanNotes,
    fanName,
  });
}

export async function sendMaloumBulkReply(options: {
  creator: Creator;
  user: User;
  chatId: string;
  fanId: string | null;
  fanName: string;
  english: string;
  german: string;
}): Promise<void> {
  const { creator, user, chatId, fanId, fanName, english, german } = options;
  const textToSend = german.trim();
  if (!textToSend) throw new Error('Reply text is empty');

  const optimisticMessageId = crypto.randomUUID();
  const result = await sendMaloumMessage(creator.id, chatId, {
    text: textToSend,
    optimisticMessageId,
  });
  const messageId = result.messageId || result.message?._id;
  if (!messageId) {
    throw new Error('Send succeeded but no message id returned');
  }

  void createMessagingDashboardEntry({
    id: crypto.randomUUID(),
    creatorId: creator.id,
    creatorName: creator.displayName,
    creatorUsername: creator.username,
    creatorAvatarUrl: creator.avatarUrl,
    chatterId: user.id,
    chatterName: user.name,
    chatterEmail: user.email,
    chatId,
    fanId,
    fanUsername: fanName,
    maloumMessageId: messageId,
    optimisticMessageId: result.optimisticMessageId || optimisticMessageId,
    contentType: 'text',
    englishMessage: english.trim() || textToSend,
    germanTranslatedMessage: textToSend,
    actualSentText: textToSend,
    priceNet: null,
    currency: 'EUR',
    purchased: false,
    mediaCount: 0,
    pictureCount: 0,
    videoCount: 0,
    mediaJson: null,
    previousFanMessageAt: null,
    responseTimeSeconds: null,
    sentAt: new Date().toISOString(),
  }).catch(() => {
    // Non-blocking
  });
}

export async function sendFourBasedBulkReply(options: {
  creator: Creator;
  user: User;
  chatId: string;
  fanId: string | null;
  fanName: string;
  english: string;
  german: string;
}): Promise<void> {
  const { creator, user, chatId, fanId, fanName, english, german } = options;
  const textToSend = german.trim();
  if (!textToSend) throw new Error('Reply text is empty');

  const localId = crypto.randomUUID();
  const result = await sendFourBasedMessage(creator.id, chatId, {
    message: textToSend,
    localId,
  });

  const messageId = result.message?._id;
  if (!messageId) {
    throw new Error('Send succeeded but no message id returned');
  }

  void createMessagingDashboardEntry({
    id: crypto.randomUUID(),
    creatorId: creator.id,
    creatorName: creator.displayName,
    creatorUsername: creator.username,
    creatorAvatarUrl: creator.avatarUrl,
    chatterId: user.id,
    chatterName: user.name,
    chatterEmail: user.email,
    chatId,
    fanId,
    fanUsername: fanName,
    maloumMessageId: `4based:${messageId}`,
    optimisticMessageId: localId,
    contentType: 'text',
    englishMessage: english.trim() || textToSend,
    germanTranslatedMessage: textToSend,
    actualSentText: textToSend,
    priceNet: null,
    currency: 'USD',
    purchased: false,
    mediaCount: 0,
    pictureCount: 0,
    videoCount: 0,
    mediaJson: null,
    previousFanMessageAt: null,
    responseTimeSeconds: null,
    sentAt: new Date().toISOString(),
  }).catch(() => {
    // Non-blocking
  });
}
