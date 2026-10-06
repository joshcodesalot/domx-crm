import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import PlatformIcon from '@/components/PlatformIcon';
import {
  getCreators,
  getFanCrmActivity,
  getStaff,
  type Creator,
  type FanCrmActivityAction,
  type FanCrmActivityEvent,
  type FanCrmActivitySummary,
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

const selectClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const ACTION_OPTIONS: { value: FanCrmActivityAction; label: string }[] = [
  { value: 'rename', label: 'Rename' },
  { value: 'note_add', label: 'Note added' },
  { value: 'note_remove', label: 'Note removed' },
  { value: 'note_edit', label: 'Note updated' },
  { value: 'list_add', label: 'List added' },
  { value: 'list_remove', label: 'List removed' },
  { value: 'list_bulk_add', label: 'List filled' },
];

const EMPTY_SUMMARY: FanCrmActivitySummary = {
  rename: 0,
  noteAdd: 0,
  noteRemove: 0,
  noteEdit: 0,
  listAdd: 0,
  listRemove: 0,
  listBulkAdd: 0,
};

function isIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getDefaultDateRange(timeZone: string): { startDate: string; endDate: string } {
  const endDate = formatLocalDateInput(new Date(), timeZone);
  const end = new Date(`${endDate}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 6);
  const startDate = end.toISOString().slice(0, 10);
  return { startDate, endDate };
}

function isAction(value: string): value is FanCrmActivityAction {
  return ACTION_OPTIONS.some((option) => option.value === value);
}

function actionLabel(action: FanCrmActivityAction): string {
  return ACTION_OPTIONS.find((option) => option.value === action)?.label || action;
}

function platformLabel(platform: FanCrmActivityEvent['platform']): string {
  return formatPlatformLabel(platform) || '--';
}

function shownValue(value: string): string {
  return value.trim() ? value : '(empty)';
}

function detailText(event: FanCrmActivityEvent): string {
  switch (event.action) {
    case 'rename':
      return `${shownValue(event.previousValue)} → ${shownValue(event.nextValue)}`;
    case 'note_add':
      return event.nextValue.trim() ? event.nextValue : '(empty)';
    case 'note_remove':
      return event.previousValue.trim() ? event.previousValue : '(empty)';
    case 'note_edit':
      return `${shownValue(event.previousValue)} → ${shownValue(event.nextValue)}`;
    case 'list_add':
    case 'list_remove':
      return event.listName || event.listId || 'List';
    case 'list_bulk_add':
      return `Added ${event.nextValue || '0'} fans to ${event.listName || 'list'}`;
    default:
      return '--';
  }
}

function CrmActivityRow({
  event,
  timeZone,
}: {
  event: FanCrmActivityEvent;
  timeZone: string;
}) {
  const when = formatSentTime(event.createdAt, timeZone);
  const detail = detailText(event);

  return (
    <tr className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/60 dark:hover:bg-white/[0.02]">
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div>{when.time}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{when.date}</div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">{event.chatterName || '--'}</td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2 min-w-[160px]">
          <CreatorAvatar
            avatarUrl={event.creatorAvatarUrl}
            displayName={event.creatorName || 'Creator'}
            className="w-8 h-8 rounded-full object-cover shrink-0"
            initialsClassName="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium shrink-0"
          />
          <div className="min-w-0">
            <div className="font-medium truncate inline-flex items-center gap-1.5">
              <PlatformIcon platform={event.platform} />
              <span className="truncate">{event.creatorName || '--'}</span>
            </div>
            {event.creatorUsername ? (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                @{event.creatorUsername}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">{platformLabel(event.platform)}</td>
      <td className="px-4 py-3 align-top whitespace-nowrap">{event.fanLabel || event.fanId || '--'}</td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300">
          {actionLabel(event.action)}
        </span>
      </td>
      <td className="px-4 py-3 align-top max-w-[360px]">
        <div className="line-clamp-3 whitespace-pre-wrap break-words" title={detail}>
          {detail}
        </div>
      </td>
    </tr>
  );
}

export default function CrmActivity() {
  const timeZone = useStaffTimeZone();
  const [searchParams] = useSearchParams();
  const defaultRange = useMemo(() => {
    const fallback = getDefaultDateRange(timeZone);
    const startFromUrl = searchParams.get('startDate');
    const endFromUrl = searchParams.get('endDate');
    return {
      startDate: isIsoDate(startFromUrl) ? startFromUrl : fallback.startDate,
      endDate: isIsoDate(endFromUrl) ? endFromUrl : fallback.endDate,
    };
  }, [searchParams, timeZone]);

  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [chatterId, setChatterId] = useState('');
  const [platform, setPlatform] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [events, setEvents] = useState<FanCrmActivityEvent[]>([]);
  const [summary, setSummary] = useState<FanCrmActivitySummary>(EMPTY_SUMMARY);
  const [chatters, setChatters] = useState<User[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateRangeLabel = formatCalendarRangeLabel(startDate, endDate);

  const filteredCreators = useMemo(() => {
    if (platform !== 'maloum' && platform !== '4based' && platform !== 'telegram') {
      return creators;
    }
    return creators.filter((creator) => creator.platform === platform);
  }, [creators, platform]);

  const summaryItems = [
    ['Renames', summary.rename],
    ['Notes added', summary.noteAdd],
    ['Notes removed', summary.noteRemove],
    ['Notes updated', summary.noteEdit],
    ['Lists added', summary.listAdd],
    ['Lists removed', summary.listRemove],
    ['Lists filled', summary.listBulkAdd],
  ] as const;

  const loadFilterOptions = useCallback(async () => {
    try {
      const [staffResult, creatorsResult] = await Promise.all([getStaff(), getCreators()]);
      setChatters(staffResult.staff);
      setCreators(creatorsResult.creators);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load filter options');
    }
  }, []);

  const loadEvents = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setError(null);

      try {
        const response = await getFanCrmActivity({
          startDate,
          endDate,
          chatterId: chatterId || undefined,
          creatorId: creatorId || undefined,
          platform:
            platform === 'maloum' || platform === '4based' || platform === 'telegram'
              ? platform
              : undefined,
          action: isAction(action) ? action : undefined,
          page,
          limit,
        });
        setEvents(response.data);
        setSummary(response.summary);
        setTotal(response.pagination.total);
        setFrom(response.pagination.from);
        setTo(response.pagination.to);
        setLastUpdated(response.lastUpdated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load CRM activity');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate, chatterId, creatorId, platform, action, page, limit]
  );

  useEffect(() => {
    void loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!creatorId) return;
    if (filteredCreators.some((creator) => creator.id === creatorId)) return;
    setCreatorId('');
    setPage(1);
  }, [creatorId, filteredCreators]);

  function handleResetFilters() {
    const range = getDefaultDateRange(timeZone);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setChatterId('');
    setPlatform('');
    setCreatorId('');
    setAction('');
    setPage(1);
    setLimit(20);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title="CRM Activity" activePage="crmActivity">
      <div className="space-y-0 -m-4 sm:-m-6 md:-m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              CRM Activity
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Fan renames, notes, and list changes.{' '}
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
            <span>
              Last updated: {lastUpdated ? formatInstant(lastUpdated, timeZone) : '--'}
            </span>
            <button
              type="button"
              onClick={() => void loadEvents({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {summaryItems.map(([label, count]) => (
              <span
                key={label}
                className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-1 text-xs text-gray-600 dark:text-gray-300"
              >
                {label}
                <span className="font-semibold text-gray-900 dark:text-gray-100">{count}</span>
              </span>
            ))}
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
                <option value="telegram">Telegram</option>
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
                {filteredCreators.map((creator) => {
                  const platform = formatPlatformLabel(creator.platform);
                  return (
                    <option key={creator.id} value={creator.id}>
                      {platform ? `${platform} · ` : ''}
                      {creator.displayName}
                    </option>
                  );
                })}
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
                Action
              </span>
              <select
                value={action}
                onChange={(event) => {
                  setAction(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
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

        <div className="table-scroll overflow-auto border-t border-gray-200 dark:border-white/10">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Time</th>
                <th className="px-4 py-3 text-left font-medium">Chatter</th>
                <th className="px-4 py-3 text-left font-medium">Model</th>
                <th className="px-4 py-3 text-left font-medium">Platform</th>
                <th className="px-4 py-3 text-left font-medium">Fan</th>
                <th className="px-4 py-3 text-left font-medium">Action</th>
                <th className="px-4 py-3 text-left font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading CRM activity...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No CRM activity in this range.
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <CrmActivityRow key={event.id} event={event} timeZone={timeZone} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
