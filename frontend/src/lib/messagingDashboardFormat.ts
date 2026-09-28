import { DEFAULT_TIMEZONE } from '@/components/PeriodDaysToggle';
import { berlinDateString } from '@/lib/berlinTime';

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
  platform?: 'maloum' | '4based' | 'telegram' | null;
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
  unlockedAt?: string | null;
  payoutVerified?: boolean;
  payoutTxnId?: string | null;
  attributionSource?: string | null;
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
  totals?: { currency: 'EUR' | 'USD'; amount: number }[];
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

export function formatLocalDateInput(
  date: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  return berlinDateString(date, timeZone);
}

function shiftCalendarDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getDefaultMessagingDashboardDateRange(
  timeZone: string = DEFAULT_TIMEZONE
): {
  startDate: string;
  endDate: string;
} {
  const endDate = formatLocalDateInput(new Date(), timeZone);
  return {
    startDate: shiftCalendarDate(endDate, -30),
    endDate,
  };
}

export function formatCalendarRangeLabel(startDate: string, endDate: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

export function formatInstant(
  date: string | Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
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

export function resolveDashboardCurrency(
  currency?: string | null,
  platform?: 'maloum' | '4based' | 'telegram' | null
): 'EUR' | 'USD' {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (normalized === 'USD' || normalized === 'EUR') {
    return normalized;
  }
  return platform === '4based' || platform === 'telegram' ? 'USD' : 'EUR';
}

/** Net take: Maloum 80%, 4based 70%, Telegram/Throne 100%. */
export function netTakeAmount(
  priceNet: number | null | undefined,
  platform?: 'maloum' | '4based' | 'telegram' | null
): number | null {
  if (priceNet == null || Number.isNaN(Number(priceNet))) {
    return null;
  }
  const take =
    platform === '4based' ? 0.7 : platform === 'telegram' ? 1 : 0.8;
  return Math.abs(Number(priceNet)) * take;
}

/** Format an ISO 4217 amount. USD uses en-US, EUR uses de-DE; other codes use the runtime locale. */
export function formatMoney(
  amount: number | null | undefined,
  currency: string = 'EUR'
): string {
  if (amount == null) {
    return '--';
  }

  const raw = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const code = /^[A-Z]{3}$/.test(raw) ? raw : 'EUR';
  const locale = code === 'USD' ? 'en-US' : code === 'EUR' ? 'de-DE' : undefined;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
    }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${code}`;
  }
}

/** @deprecated Prefer formatMoney — kept for Maloum EUR call sites. */
export function formatEuro(amount: number | null | undefined): string {
  return formatMoney(amount, 'EUR');
}

export function formatSentTime(
  date: string | Date,
  timeZone: string = DEFAULT_TIMEZONE
): { time: string; date: string } {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) {
    return { time: '--', date: '--' };
  }

  return {
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(value),
    date: new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }).format(value),
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
