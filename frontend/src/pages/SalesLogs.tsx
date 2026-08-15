import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import {
  getCreators,
  getMessagingDashboard,
  getStaff,
  type Creator,
  type CurrencyAmount,
  type MessagingDashboardEntry,
  type User,
} from '@/lib/api';
import {
  formatLocalDateInput,
  formatMoney,
  formatSentTime,
  netTakeAmount,
  resolveDashboardCurrency,
} from '@/lib/messagingDashboardFormat';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const selectClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function isIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getDefaultSalesLogsDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return {
    startDate: formatLocalDateInput(start),
    endDate: formatLocalDateInput(end),
  };
}

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

function formatCurrencyAmounts(amounts: CurrencyAmount[] | undefined): string {
  if (!amounts || amounts.length === 0) {
    return formatMoney(0, 'EUR');
  }
  return amounts.map((item) => formatMoney(item.amount, item.currency)).join(' · ');
}

function platformLabel(platform: MessagingDashboardEntry['platform']): string {
  if (platform === '4based') return '4based';
  if (platform === 'maloum') return 'Maloum';
  return '--';
}

function SalesLogRow({ entry }: { entry: MessagingDashboardEntry }) {
  const sentTime = formatSentTime(entry.sentAt);
  const moneyCurrency = resolveDashboardCurrency(entry.currency, entry.platform);
  const listed = entry.priceNet;
  const net = netTakeAmount(entry.priceNet, entry.platform);
  const isTip = entry.contentType === 'tip';
  const partyLabel = isTip ? entry.creatorName : entry.chatterName;

  return (
    <tr className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/60 dark:hover:bg-white/[0.02]">
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div>{sentTime.time}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{sentTime.date}</div>
        {entry.contentType === 'chat_product' && entry.unlockedAt ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Unlocked {formatSentTime(entry.unlockedAt).date}{' '}
            {formatSentTime(entry.unlockedAt).time}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300">
          {isTip ? 'Tip' : 'PPV'}
        </span>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div className="font-medium">{formatMoney(net, moneyCurrency)}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Listed {formatMoney(listed, moneyCurrency)}
        </div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">{platformLabel(entry.platform)}</td>
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
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {isTip ? 'Tip recipient' : 'PPV sender'}
        </div>
        <div>{partyLabel || '--'}</div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">{entry.fanUsername || '--'}</td>
    </tr>
  );
}

export default function SalesLogs() {
  const [searchParams] = useSearchParams();
  const defaultRange = useMemo(() => {
    const fallback = getDefaultSalesLogsDateRange();
    const startFromUrl = searchParams.get('startDate');
    const endFromUrl = searchParams.get('endDate');
    return {
      startDate: isIsoDate(startFromUrl) ? startFromUrl : fallback.startDate,
      endDate: isIsoDate(endFromUrl) ? endFromUrl : fallback.endDate,
    };
  }, [searchParams]);

  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [chatterId, setChatterId] = useState('');
  const [platform, setPlatform] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [contentType, setContentType] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [entries, setEntries] = useState<MessagingDashboardEntry[]>([]);
  const [chatters, setChatters] = useState<User[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [totals, setTotals] = useState<CurrencyAmount[]>([]);
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
      setChatters(
        staffResult.staff.filter(
          (member) => member.role === 'chatter' || member.role === 'team_leader'
        )
      );
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
          contentType:
            contentType === 'chat_product' || contentType === 'tip'
              ? contentType
              : undefined,
          salesOnly: true,
          page,
          limit,
        });

        setEntries(response.data);
        setTotals(response.totals || []);
        setTotal(response.pagination.total);
        setFrom(response.pagination.from);
        setTo(response.pagination.to);
        setLastUpdated(response.lastUpdated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sales logs');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate, chatterId, creatorId, platform, contentType, page, limit]
  );

  useEffect(() => {
    void loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    if (!creatorId) return;
    if (filteredCreators.some((creator) => creator.id === creatorId)) return;
    setCreatorId('');
    setPage(1);
  }, [creatorId, filteredCreators]);

  function handleResetFilters() {
    const range = getDefaultSalesLogsDateRange();
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setChatterId('');
    setPlatform('');
    setCreatorId('');
    setContentType('');
    setPage(1);
    setLimit(20);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title="Sales Logs" activePage="salesLogs">
      <div className="max-w-[1600px] mx-auto space-y-0 -m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Sales Logs
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Purchased PPVs and tips.{' '}
              <Link
                to="/dashboard"
                className="text-gray-700 dark:text-gray-300 underline-offset-2 hover:underline"
              >
                Overview
              </Link>
            </p>
          </div>

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
            <span className="font-medium text-gray-800 dark:text-gray-200">
              Total Sales: {formatCurrencyAmounts(totals)}
              <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
                (verified PPV + tips)
              </span>
            </span>
            <span className="hidden sm:inline h-4 w-px bg-gray-200 dark:bg-white/10" />
            <span>
              Last updated:{' '}
              {lastUpdated ? new Date(lastUpdated).toLocaleString() : '--'}
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
                Model / tip recipient
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
                    {creator.platform === '4based' ? '4based · ' : 'Maloum · '}
                    {creator.displayName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                PPV sender
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
                Type
              </span>
              <select
                value={contentType}
                onChange={(event) => {
                  setContentType(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All sales</option>
                <option value="chat_product">PPV</option>
                <option value="tip">Tip</option>
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
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Net amount</th>
                <th className="px-4 py-3 text-left font-medium">Platform</th>
                <th className="px-4 py-3 text-left font-medium">Model</th>
                <th className="px-4 py-3 text-left font-medium">PPV sender / tip recipient</th>
                <th className="px-4 py-3 text-left font-medium">Fan</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading sales logs...
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No sales found for the selected filters.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => <SalesLogRow key={entry.id} entry={entry} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
