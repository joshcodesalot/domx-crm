import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageIcon, RefreshCw, VideoIcon } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import {
  getCreators,
  getMessagingDashboard,
  getStaff,
  type Creator,
  type MessagingDashboardEntry,
  type User,
} from '@/lib/api';
import {
  formatEuro,
  formatMediaLabel,
  formatResponseTime,
  formatSentTime,
  getDefaultMessagingDashboardDateRange,
} from '@/lib/messagingDashboardFormat';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const selectClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function formatDateRangeLabel(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function purchasedBadgeClass(purchased: boolean): string {
  return purchased
    ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
    : 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400';
}

function MessagingDashboardRow({ entry }: { entry: MessagingDashboardEntry }) {
  const sentTime = formatSentTime(entry.sentAt);
  const mediaLabel = formatMediaLabel(entry);
  const platformLabel =
    entry.platform === '4based'
      ? '4based'
      : entry.platform === 'maloum'
        ? 'Maloum'
        : null;

  return (
    <tr className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/60 dark:hover:bg-white/[0.02]">
      <td className="px-4 py-3 align-top whitespace-nowrap">{entry.chatterName}</td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {formatEuro(entry.chatterSalesTotal)}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2 min-w-[160px]">
          <CreatorAvatar
            avatarUrl={entry.creatorAvatarUrl}
            displayName={entry.creatorName}
            className="w-8 h-8 rounded-full object-cover shrink-0"
            initialsClassName="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium shrink-0"
          />
          <div className="min-w-0">
            <div className="font-medium truncate">{entry.creatorName}</div>
            {entry.creatorUsername ? (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                @{entry.creatorUsername}
              </div>
            ) : null}
            {platformLabel ? (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {platformLabel}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top max-w-[220px]">
        <div className="line-clamp-2" title={entry.englishMessage || undefined}>
          {entry.englishMessage || '--'}
        </div>
      </td>
      <td className="px-4 py-3 align-top max-w-[220px]">
        <div className="line-clamp-2" title={entry.germanTranslatedMessage || undefined}>
          {entry.germanTranslatedMessage || '--'}
        </div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {formatResponseTime(entry.responseTimeSeconds)}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div>{sentTime.time}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{sentTime.date}</div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {formatEuro(entry.priceNet)}
      </td>
      <td className="px-4 py-3 align-top">
        <span
          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${purchasedBadgeClass(entry.purchased)}`}
        >
          {entry.purchased ? 'Yes' : 'No'}
        </span>
      </td>
      <td className="px-4 py-3 align-top">
        {mediaLabel === '--' ? (
          '--'
        ) : (
          <div className="flex items-center gap-1.5">
            {entry.videoCount > 0 ? (
              <VideoIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
            ) : null}
            {entry.pictureCount > 0 ? (
              <ImageIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
            ) : null}
            <span>{mediaLabel}</span>
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {entry.fanUsername || '--'}
      </td>
    </tr>
  );
}

export default function MessagingDashboard() {
  const defaultRange = useMemo(() => getDefaultMessagingDashboardDateRange(), []);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [chatterId, setChatterId] = useState('');
  const [platform, setPlatform] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [purchased, setPurchased] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [entries, setEntries] = useState<MessagingDashboardEntry[]>([]);
  const [chatters, setChatters] = useState<User[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateRangeLabel = formatDateRangeLabel(startDate, endDate);

  const filteredCreators = useMemo(() => {
    if (platform !== 'maloum' && platform !== '4based') return creators;
    return creators.filter((creator) => creator.platform === platform);
  }, [creators, platform]);

  const loadFilterOptions = useCallback(async () => {
    try {
      const [staffResult, creatorsResult] = await Promise.all([getStaff(), getCreators()]);
      setChatters(staffResult.staff.filter((member) => member.role === 'chatter'));
      setCreators(creatorsResult.creators);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load filter options');
    }
  }, []);

  const loadEntries = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      setError(null);

      try {
        const response = await getMessagingDashboard({
          startDate,
          endDate,
          chatterId: chatterId || undefined,
          creatorId: creatorId || undefined,
          platform:
            platform === 'maloum' || platform === '4based' ? platform : undefined,
          purchased:
            purchased === 'true' ? true : purchased === 'false' ? false : undefined,
          page,
          limit,
        });

        setEntries(response.data);
        setTotal(response.pagination.total);
        setFrom(response.pagination.from);
        setTo(response.pagination.to);
        setLastUpdated(response.lastUpdated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load messaging dashboard');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate, chatterId, creatorId, platform, purchased, page, limit]
  );

  useEffect(() => {
    void loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadEntries({ silent: true });
    }, 20000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loadEntries]);

  useEffect(() => {
    if (!creatorId) return;
    const stillValid = filteredCreators.some((creator) => creator.id === creatorId);
    if (!stillValid) {
      setCreatorId('');
      setPage(1);
    }
  }, [creatorId, filteredCreators]);

  function handleResetFilters() {
    const range = getDefaultMessagingDashboardDateRange();
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setChatterId('');
    setPlatform('');
    setCreatorId('');
    setPurchased('');
    setPage(1);
    setLimit(20);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title="Messaging Dashboard" activePage="analytics">
      <div className="max-w-[1600px] mx-auto space-y-0 -m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Messaging Dashboard
          </h2>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                setPage(1);
              }}
              className={inputClassName}
            />
            <span className="hidden sm:inline text-gray-400">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => {
                setEndDate(event.target.value);
                setPage(1);
              }}
              className={inputClassName}
            />
          </div>
        </div>

        <div className="border-b border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] px-6 py-4">
          <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>Showing data from {dateRangeLabel}</span>
            <span className="hidden sm:inline h-4 w-px bg-gray-200 dark:bg-white/10" />
            <span>
              Last updated:{' '}
              {lastUpdated
                ? new Date(lastUpdated).toLocaleString()
                : '--'}
            </span>
            <button
              type="button"
              onClick={() => void loadEntries({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
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
                <option value="maloum">Maloum</option>
                <option value="4based">4based</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Sender (Chatter)
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
                Creator
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
                    {creator.displayName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Purchased
              </span>
              <select
                value={purchased}
                onChange={(event) => {
                  setPurchased(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            onClick={handleResetFilters}
            className="mt-4 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5"
          >
            Reset Filters
          </button>
        </div>

        {error ? (
          <div className="mx-6 mt-4 rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 px-6 py-4 text-sm text-gray-500 dark:text-gray-400 md:flex-row md:items-center md:justify-between">
          <span>
            Showing {from} to {to} of {total} results
          </span>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span>Page size</span>
              <select
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  setPage(1);
                }}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1 || loading}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages || loading}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-auto border-t border-gray-200 dark:border-white/10">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Sender</th>
                <th className="px-4 py-3 text-left font-medium">Chatter Sales</th>
                <th className="px-4 py-3 text-left font-medium">Creator</th>
                <th className="px-4 py-3 text-left font-medium">English Message</th>
                <th className="px-4 py-3 text-left font-medium">German Translated Message</th>
                <th className="px-4 py-3 text-left font-medium">Response Time</th>
                <th className="px-4 py-3 text-left font-medium">Sent Time</th>
                <th className="px-4 py-3 text-left font-medium">Price</th>
                <th className="px-4 py-3 text-left font-medium">Purchased</th>
                <th className="px-4 py-3 text-left font-medium">Media</th>
                <th className="px-4 py-3 text-left font-medium">Fan</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading messaging dashboard...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No messages found for the selected filters.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => <MessagingDashboardRow key={entry.id} entry={entry} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
