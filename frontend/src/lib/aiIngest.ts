import {
  ingestAiMessages,
  type AiIngestMessage,
  type AiIngestPlatform,
  type FourBasedMessage,
  type MaloumMessage,
  type TelegramMessage,
} from '@/lib/api';

export type { AiIngestMessage, AiIngestPlatform };

const FOURBASED_COINS_PER_DOLLAR = 121;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function maloumHasMedia(msg: MaloumMessage): boolean {
  const content = msg.content;
  if (!content) return false;
  return (
    (Array.isArray(content.media) && content.media.length > 0) ||
    (Array.isArray(content.thumbnails) && content.thumbnails.length > 0)
  );
}

function maloumPriceNet(msg: MaloumMessage): number | null {
  const net = msg.content?.price?.net;
  if (typeof net === 'number' && Number.isFinite(net)) return net;
  const fallback = msg.content?.priceNet;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return null;
}

export function mapMaloumMessagesForIngest(
  messages: MaloumMessage[],
  providerUserId: string | null
): AiIngestMessage[] {
  const mapped: AiIngestMessage[] = [];
  for (const msg of messages) {
    if (msg.domxUnsent) continue;
    const platformMessageId = String(msg._id || '').trim();
    if (!platformMessageId) continue;
    const mine = Boolean(
      providerUserId && msg.senderId && msg.senderId === providerUserId
    );
    mapped.push({
      platformMessageId,
      direction: mine ? 'outbound' : 'inbound',
      senderRole: mine ? 'creator' : 'fan',
      text: asText(msg.content?.text),
      hasMedia: maloumHasMedia(msg),
      isPpv: msg.content?.type === 'chat_product',
      priceNet: maloumPriceNet(msg),
      sentAt: msg.sentAt || null,
    });
  }
  return mapped;
}

export function mapFourBasedMessagesForIngest(
  messages: FourBasedMessage[],
  providerUserId: string | null
): AiIngestMessage[] {
  const mapped: AiIngestMessage[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.deleted_user_ids) && msg.deleted_user_ids.length > 0) {
      continue;
    }
    const platformMessageId = String(msg._id || '').trim();
    if (!platformMessageId) continue;
    const mine = Boolean(
      providerUserId && msg.user_id && msg.user_id === providerUserId
    );
    const priceCoins = msg.file_stack?.price;
    const isPpv = typeof priceCoins === 'number' && priceCoins > 0;
    mapped.push({
      platformMessageId,
      direction: mine ? 'outbound' : 'inbound',
      senderRole: mine ? 'creator' : 'fan',
      text: asText(msg.message),
      hasMedia: Boolean(msg.file_stack || msg.file_stack_id),
      isPpv,
      priceNet:
        isPpv && typeof priceCoins === 'number'
          ? priceCoins / FOURBASED_COINS_PER_DOLLAR
          : null,
      sentAt: msg.created_at || null,
    });
  }
  return mapped;
}

export function mapTelegramMessagesForIngest(
  messages: TelegramMessage[]
): AiIngestMessage[] {
  const mapped: AiIngestMessage[] = [];
  for (const msg of messages) {
    if (msg.deleted) continue;
    const platformMessageId = String(msg.id || '').trim();
    if (!platformMessageId) continue;
    const outbound = Boolean(msg.isOutgoing);
    mapped.push({
      platformMessageId,
      direction: outbound ? 'outbound' : 'inbound',
      senderRole: outbound ? 'creator' : 'fan',
      text: asText(msg.text),
      hasMedia: Boolean(msg.hasMedia) || (Boolean(msg.kind) && msg.kind !== 'text'),
      isPpv: false,
      priceNet: null,
      sentAt: msg.date || null,
    });
  }
  return mapped;
}

export function latestInboundPlatformMessageId(
  messages: AiIngestMessage[]
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].direction === 'inbound') {
      return messages[i].platformMessageId;
    }
  }
  return null;
}

export async function ingestLatestPage(options: {
  creatorId: string;
  platform: AiIngestPlatform;
  platformChatId: string;
  platformFanId?: string | null;
  source: string;
  seenIds: Set<string>;
  messages: AiIngestMessage[];
}): Promise<void> {
  const unseen: AiIngestMessage[] = [];
  let hasNewInbound = false;
  for (const msg of options.messages) {
    const id = String(msg.platformMessageId || '').trim();
    if (!id || options.seenIds.has(id)) continue;
    unseen.push(msg);
    if (msg.direction === 'inbound') hasNewInbound = true;
  }
  if (!hasNewInbound || unseen.length === 0) return;

  try {
    await ingestAiMessages({
      creatorId: options.creatorId,
      platform: options.platform,
      platformChatId: options.platformChatId,
      platformFanId: options.platformFanId || null,
      source: options.source,
      messages: unseen,
    });
    for (const msg of unseen) {
      options.seenIds.add(msg.platformMessageId);
    }
  } catch {
    // Chat UX must stay unchanged if ingest fails.
  }
}
