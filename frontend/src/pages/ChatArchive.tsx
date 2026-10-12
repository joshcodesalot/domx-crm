import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import PlatformIcon from '@/components/PlatformIcon';
import {
  downloadChatArchiveExport,
  getChatArchiveThread,
  getCreators,
  getStaff,
  searchChatArchive,
  type ChatArchiveHit,
  type ChatArchiveMessage,
  type ChatArchivePlatform,
  type ChatArchiveThread,
  type Creator,
  type User,
} from '@/lib/api';
import { formatPlatformLabel } from '@/lib/formatCreator';
import {
  formatCalendarRangeLabel,
  formatInstant,
  formatLocalDateInput,
  formatSentTime,
} from '@/lib/messagingDashboardFormat';
import { useStaffTimeZone } from '@/lib/berlinTime';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const selectClassName = inputClassName;

const PLATFORMS: ChatArchivePlatform[] = ['maloum', '4based', 'telegram', 'fansly'];

function isPlatform(value: string): value is ChatArchivePlatform {
  return PLATFORMS.includes(value as ChatArchivePlatform);
}

function getDefaultDateRange(timeZone: string): { startDate: string; endDate: string } {
  const endDate = formatLocalDateInput(new Date(), timeZone);
  const end = new Date(`${endDate}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 6);
  const startDate = end.toISOString().slice(0, 10);
  return { startDate, endDate };
}

function highlight(text: string, phrase: string) {
  const needle = phrase.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  let index = lower.indexOf(target, cursor);
  while (index >= 0) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
    index = lower.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.map((part, partIndex) =>
    part.match ? (
      <mark
        key={partIndex}
        className="rounded bg-amber-200/80 px-0.5 text-gray-900 dark:bg-amber-400/40 dark:text-gray-100"
      >
        {part.text}
      </mark>
    ) : (
      <span key={partIndex}>{part.text}</span>
    )
  );
}

function messageBody(message: { textEn: string | null; textDe: string | null; textSent: string }) {
  const english = (message.textEn || '').trim();
  const german = (message.textDe || '').trim();
  const sent = (message.textSent || '').trim();
  if (english && german && english.toLowerCase() !== german.toLowerCase()) {
    return { primary: english, secondary: german };
  }
  return { primary: english || sent, secondary: '' };
}

function sentLabel(value: string | null, timeZone: string): string {
  if (!value) return '--';
  const when = formatSentTime(value, timeZone);
  return `${when.time} ${when.date}`;
}

function priceLabel(price: number | null, currency: string | null): string | null {
  if (price == null) return null;
  const code = currency || '';
  return code ? `${price} ${code}` : String(price);
}

export default function ChatArchive() {
  const timeZone = useStaffTimeZone();
  const defaultRange = useMemo(() => getDefaultDateRange(timeZone), [timeZone]);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [phrase, setPhrase] = useState('');
  const [submittedPhrase, setSubmittedPhrase] = useState('');
  const [chatterId, setChatterId] = useState('');
  const [platform, setPlatform] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [direction, setDirection] = useState('');
  const [includeMass, setIncludeMass] = useState(false);
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<ChatArchiveHit[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [chatters, setChatters] = useState<User[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ChatArchiveThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'thread' | 'search' | null>(null);

  const dateRangeLabel = formatCalendarRangeLabel(startDate, endDate);
  const readyPhrase = submittedPhrase.trim();
  const canSearch = readyPhrase.length >= 3;

  const filteredCreators = useMemo(() => {
    if (!isPlatform(platform)) return creators;
    return creators.filter((creator) => creator.platform === platform);
  }, [creators, platform]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [staffResult, creatorsResult] = await Promise.all([getStaff(), getCreators()]);
        if (cancelled) return;
        setChatters(staffResult.staff);
        setCreators(creatorsResult.creators);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load filter options');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadHits = useCallback(async () => {
    if (readyPhrase.length < 3) {
      setHits([]);
      setTotal(0);
      setFrom(0);
      setTo(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await searchChatArchive({
        q: readyPhrase,
        startDate,
        endDate,
        chatterId: chatterId || undefined,
        creatorId: creatorId || undefined,
        platform: isPlatform(platform) ? platform : undefined,
        direction: direction === 'inbound' || direction === 'outbound' ? direction : undefined,
        includeMass,
        page,
        limit: 20,
      });
      setHits(response.data);
      setTotal(response.pagination.total);
      setFrom(response.pagination.from);
      setTo(response.pagination.to);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search chat archive');
    } finally {
      setLoading(false);
    }
  }, [readyPhrase, startDate, endDate, chatterId, creatorId, platform, direction, includeMass, page]);

  useEffect(() => {
    void loadHits();
  }, [loadHits]);

  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    void getChatArchiveThread(selectedId, includeMass)
      .then((result) => {
        if (!cancelled) setThread(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setThread(null);
          setThreadError(err instanceof Error ? err.message : 'Failed to load archived chat');
        }
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, includeMass]);

  const filters = {
    q: canSearch ? readyPhrase : undefined,
    startDate,
    endDate,
    chatterId: chatterId || undefined,
    creatorId: creatorId || undefined,
    platform: isPlatform(platform) ? platform : undefined,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : undefined,
    includeMass,
  } as const;

  async function exportSearch() {
    setExporting('search');
    setError(null);
    try {
      await downloadChatArchiveExport(filters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  async function exportThread() {
    if (!selectedId) return;
    setExporting('thread');
    setThreadError(null);
    try {
      await downloadChatArchiveExport({ conversationId: selectedId, includeMass });
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <AppLayout title="Chat Archive" activePage="chatArchive">
      <div className="space-y-0 -m-4 sm:-m-6 md:-m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Chat Archive</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Search stored fan and chatter messages. Opening a chat reads the archive only.{' '}
              <Link
                to="/dashboard"
                className="text-gray-700 underline-offset-2 hover:underline dark:text-gray-300"
              >
                Overview
              </Link>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void exportSearch()}
            disabled={exporting !== null}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-200 dark:hover:bg-white/5"
          >
            <Download className="h-4 w-4" />
            {exporting === 'search' ? 'Exporting…' : 'Export filter'}
          </button>
        </div>

        <div className="border-b border-gray-200 bg-gray-50/60 px-6 py-4 dark:border-white/10 dark:bg-white/[0.02]">
          <form
            className="mb-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSubmittedPhrase(phrase);
            }}
          >
            <input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="Search a phrase in English or German"
              aria-label="Search archived messages"
              className={inputClassName}
            />
            <button
              type="submit"
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Search
            </button>
          </form>

          <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>Showing data from {dateRangeLabel}</span>
            <button
              type="button"
              onClick={() => void loadHits()}
              disabled={loading || !canSearch}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white p-2 text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-300 dark:hover:bg-white/5"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                From
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setPage(1);
                }}
                className={inputClassName}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                To
              </span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setPage(1);
                }}
                className={inputClassName}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Platform
              </span>
              <select
                value={platform}
                onChange={(event) => {
                  setPlatform(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {PLATFORMS.map((value) => (
                  <option key={value} value={value}>
                    {formatPlatformLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Model
              </span>
              <select
                value={creatorId}
                onChange={(event) => {
                  setCreatorId(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {filteredCreators.map((creator) => (
                  <option key={creator.id} value={creator.id}>
                    {formatPlatformLabel(creator.platform)
                      ? `${formatPlatformLabel(creator.platform)} · `
                      : ''}
                    {creator.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Chatter
              </span>
              <select
                value={chatterId}
                onChange={(event) => {
                  setChatterId(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {chatters.map((chatter) => (
                  <option key={chatter.id} value={chatter.id}>
                    {chatter.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Direction
              </span>
              <select
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                <option value="inbound">Fan</option>
                <option value="outbound">Chatter</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={includeMass}
                onChange={(event) => {
                  setIncludeMass(event.target.checked);
                  setPage(1);
                }}
              />
              Include mass messages
            </label>
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-w-0 border-gray-200 dark:border-white/10 xl:border-r">
            {!canSearch ? (
              <p className="px-6 py-10 text-sm text-gray-500 dark:text-gray-400">
                Enter at least 3 characters to search stored messages.
              </p>
            ) : loading && hits.length === 0 ? (
              <p className="px-6 py-10 text-sm text-gray-500 dark:text-gray-400">Searching…</p>
            ) : hits.length === 0 ? (
              <p className="px-6 py-10 text-sm text-gray-500 dark:text-gray-400">
                No archived messages match that phrase.
              </p>
            ) : (
              <ul className="divide-y divide-gray-200 dark:divide-white/10">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(hit.conversationId)}
                      className={`w-full px-6 py-4 text-left hover:bg-gray-50 dark:hover:bg-white/[0.03] ${
                        selectedId === hit.conversationId ? 'bg-gray-50 dark:bg-white/[0.04]' : ''
                      }`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <PlatformIcon platform={hit.platform} />
                        <span>{formatPlatformLabel(hit.platform)}</span>
                        <span>{hit.creatorName || 'Creator'}</span>
                        <span>{hit.fanLabel || 'Fan'}</span>
                        <span>{hit.direction === 'inbound' ? 'Fan' : hit.chatterName || 'Chatter'}</span>
                        <span>{sentLabel(hit.sentAt, timeZone)}</span>
                        {hit.deleted && <span>Deleted</span>}
                        {hit.isPpv && <span>PPV {priceLabel(hit.priceNet, hit.currency)}</span>}
                      </div>
                      <p className={`text-sm text-gray-900 dark:text-gray-100 ${hit.deleted ? 'line-through' : ''}`}>
                        {highlight(hit.snippet, readyPhrase)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {canSearch && total > 0 && (
              <div className="flex items-center justify-between px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                <span>
                  {from}–{to} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    className="rounded-lg border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-white/10"
                  >
                    Previous
                  </button>
                  <span>
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((current) => current + 1)}
                    className="rounded-lg border border-gray-200 px-3 py-1 disabled:opacity-40 dark:border-white/10"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          <aside className="min-h-[420px] bg-gray-50/40 dark:bg-white/[0.02]">
            {!selectedId ? (
              <p className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">
                Select a result to open the stored thread.
              </p>
            ) : threadLoading ? (
              <p className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">Loading archived chat…</p>
            ) : threadError ? (
              <p className="px-5 py-8 text-sm text-red-600 dark:text-red-300">{threadError}</p>
            ) : thread ? (
              <ThreadPanel
                thread={thread}
                timeZone={timeZone}
                exporting={exporting === 'thread'}
                onExport={() => void exportThread()}
              />
            ) : null}
          </aside>
        </div>
      </div>
    </AppLayout>
  );
}

function ThreadPanel({
  thread,
  timeZone,
  exporting,
  onExport,
}: {
  thread: ChatArchiveThread;
  timeZone: string;
  exporting: boolean;
  onExport: () => void;
}) {
  const conversation = thread.conversation;
  const captured =
    conversation.capturedFrom && conversation.capturedTo
      ? `${formatInstant(conversation.capturedFrom, timeZone)} – ${formatInstant(conversation.capturedTo, timeZone)}`
      : 'No stored messages yet';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 px-5 py-4 dark:border-white/10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              <PlatformIcon platform={conversation.platform} />
              <span>{conversation.fanLabel || 'Fan'}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {conversation.creatorName || 'Creator'} · {formatPlatformLabel(conversation.platform)} ·{' '}
              {conversation.messageCount} stored
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Archived copy. {captured}</p>
            {conversation.truncated && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Showing the latest 1000 messages.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-200"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {thread.messages.map((message) => (
          <ArchiveBubble key={message.id} message={message} timeZone={timeZone} />
        ))}
      </div>
    </div>
  );
}

function ArchiveBubble({ message, timeZone }: { message: ChatArchiveMessage; timeZone: string }) {
  const body = messageBody(message);
  const outbound = message.direction === 'outbound';
  const who = outbound ? message.chatterName || 'Chatter' : 'Fan';
  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${
          outbound
            ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
            : 'border border-gray-200 bg-white text-gray-900 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-100'
        } ${message.deleted ? 'opacity-70' : ''}`}
      >
        <div className={`mb-1 text-[11px] ${outbound ? 'text-white/70 dark:text-gray-500' : 'text-gray-500'}`}>
          {who}
          {message.sentAt ? ` · ${sentLabel(message.sentAt, timeZone)}` : ''}
          {message.deleted ? ' · Deleted' : ''}
          {message.isPpv ? ` · PPV ${priceLabel(message.priceNet, message.currency) || ''}` : ''}
          {message.hasMedia ? ' · Media' : ''}
        </div>
        <p className={message.deleted ? 'line-through' : ''}>{body.primary || (message.hasMedia ? 'Media' : '')}</p>
        {body.secondary && (
          <p className={`mt-1 text-xs ${outbound ? 'text-white/70 dark:text-gray-500' : 'text-gray-500'}`}>
            DE: {body.secondary}
          </p>
        )}
      </div>
    </div>
  );
}
