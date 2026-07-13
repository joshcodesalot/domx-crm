export interface MessagingDashboardMediaItem {
  mediaId?: string;
  type?: string;
  width?: number;
  height?: number;
}

export interface MessagingDashboardEntry {
  id: string;
  creatorId: string;
  creatorName: string;
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  chatterId: string;
  chatterName: string;
  chatterEmail: string | null;
  chatId: string;
  fanId: string | null;
  fanUsername: string | null;
  maloumMessageId: string;
  optimisticMessageId: string | null;
  contentType: string;
  englishMessage: string | null;
  germanTranslatedMessage: string | null;
  actualSentText: string | null;
  priceNet: number | null;
  currency: string;
  purchased: boolean;
  chatterSalesTotal: number;
  mediaCount: number;
  pictureCount: number;
  videoCount: number;
  mediaJson: MessagingDashboardMediaItem[] | null;
  previousFanMessageAt: string | null;
  responseTimeSeconds: number | null;
  sentAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingDashboardPagination {
  page: number;
  limit: number;
  total: number;
  from: number;
  to: number;
}

export interface MessagingDashboardResponse {
  data: MessagingDashboardEntry[];
  pagination: MessagingDashboardPagination;
  lastUpdated: string;
}

export interface CreateMessagingDashboardEntryInput {
  id: string;
  creatorId: string;
  creatorName?: string;
  creatorUsername?: string | null;
  creatorAvatarUrl?: string | null;
  chatterId: string;
  chatterName: string;
  chatterEmail?: string | null;
  chatId: string;
  fanId?: string | null;
  fanUsername?: string | null;
  maloumMessageId: string;
  optimisticMessageId?: string | null;
  contentType: string;
  englishMessage?: string | null;
  germanTranslatedMessage?: string | null;
  actualSentText?: string | null;
  priceNet?: number | null;
  currency?: string;
  purchased?: boolean;
  mediaCount?: number;
  pictureCount?: number;
  videoCount?: number;
  mediaJson?: MessagingDashboardMediaItem[] | null;
  previousFanMessageAt?: string | null;
  responseTimeSeconds?: number | null;
  sentAt: string;
}

export function formatLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDefaultMessagingDashboardDateRange(): {
  startDate: string;
  endDate: string;
} {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);

  return {
    startDate: formatLocalDateInput(start),
    endDate: formatLocalDateInput(end),
  };
}

export function formatResponseTime(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(Number(seconds))) {
    return '--';
  }

  const totalSeconds = Math.max(0, Math.floor(Number(seconds)));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}

export function formatEuro(amount: number | null | undefined): string {
  if (amount == null) {
    return '--';
  }

  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
}

export function formatSentTime(date: string | Date): { time: string; date: string } {
  const value = typeof date === 'string' ? new Date(date) : date;

  return {
    time: value.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    date: value.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }),
  };
}

export function formatMediaLabel(entry: {
  pictureCount: number;
  videoCount: number;
}): string {
  const parts: string[] = [];

  if (entry.videoCount === 1) {
    parts.push('1 Video');
  } else if (entry.videoCount > 1) {
    parts.push(`${entry.videoCount} Videos`);
  }

  if (entry.pictureCount === 1) {
    parts.push('1 Picture');
  } else if (entry.pictureCount > 1) {
    parts.push(`${entry.pictureCount} Pictures`);
  }

  return parts.length ? parts.join(', ') : '--';
}
