import type { SuggestReplyId, SuggestReplyOption } from '@/lib/api';

export type BulkReplyPlatform = 'maloum' | '4based';

export type BulkReplyRowStatus =
  | 'idle'
  | 'drafting'
  | 'ready'
  | 'sending'
  | 'sent'
  | 'skipped'
  | 'error';

export interface BulkUnreadChat {
  chatId: string;
  fanId: string | null;
  fanName: string;
  lastMessagePreview: string;
  lastMessageAt: string | null;
}

export interface BulkReplyRow {
  chatId: string;
  fanId: string | null;
  fanName: string;
  lastMessagePreview: string;
  status: BulkReplyRowStatus;
  error: string | null;
  suggestions: SuggestReplyOption[] | null;
  selectedId: SuggestReplyId;
  english: string;
  german: string;
}

export const MAX_BULK_SELECTION = 20;
export const DRAFT_CONCURRENCY = 3;
export const SEND_DELAY_MS = 350;
