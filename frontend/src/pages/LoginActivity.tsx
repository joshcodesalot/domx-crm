import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import {
  getLoginActivity,
  getStaff,
  type LoginActivityChange,
  type LoginActivityEvent,
  type LoginActivitySummary,
  type LoginShareUser,
  type SharedDeviceGroup,
  type SharedIpGroup,
  type User,
} from '@/lib/api';
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

const EMPTY_SUMMARY: LoginActivitySummary = {
  logins: 0,
  ipChanged: 0,
  deviceChanged: 0,
  eitherChanged: 0,
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

function isChange(value: string): value is LoginActivityChange {
  return value === 'ip' || value === 'device' || value === 'either';
}

function changeText(previous: string, current: string, changed: boolean): string {
  const next = current.trim() || '--';
  if (!changed) return next;
  const prior = previous.trim() || '(none)';
  return `${prior} → ${next}`;
}

function sameAccount(user: LoginShareUser, event: LoginActivityEvent): boolean {
  if (user.userId && event.userId) return user.userId === event.userId;
  return user.userEmail.toLowerCase() === event.userEmail.toLowerCase();
}

function otherNames(users: LoginShareUser[], event: LoginActivityEvent): string {
  return users
    .filter((user) => !sameAccount(user, event))
    .map((user) => user.userName || user.userEmail || 'Staff')
    .join(', ');
}

function ShareList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-4">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
      <div className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">{children || empty}</div>
    </div>
  );
}

function accountLine(user: LoginShareUser, timeZone: string): string {
  const when = formatSentTime(user.lastSeenAt, timeZone);
  const name = user.userName || user.userEmail || 'Staff';
  return `${name} · ${when.date} ${when.time}`;
}

function LoginActivityRow({
  event,
  timeZone,
  sharedDeviceNames,
  sharedIpNames,
}: {
  event: LoginActivityEvent;
  timeZone: string;
  sharedDeviceNames: string;
  sharedIpNames: string;
}) {
  const when = formatSentTime(event.createdAt, timeZone);
  const ip = changeText(event.previousIp, event.ipAddress, event.ipChanged);
  const device = changeText(event.previousDeviceLabel, event.deviceLabel, event.deviceChanged);

  return (
    <tr className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50/60 dark:hover:bg-white/[0.02]">
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div>{when.time}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{when.date}</div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div className="font-medium">{event.userName || '--'}</div>
        {event.userEmail ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">{event.userEmail}</div>
        ) : null}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap" title={ip}>
        {ip}
      </td>
      <td className="px-4 py-3 align-top" title={device}>
        {device}
      </td>
      <td className="px-4 py-3 align-top max-w-[320px]">
        <div className="flex flex-wrap gap-1">
          {event.ipChanged ? (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              IP changed
            </span>
          ) : null}
          {event.deviceChanged ? (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Device changed
            </span>
          ) : null}
          {sharedDeviceNames ? (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300">
              Shared device with {sharedDeviceNames}
            </span>
          ) : null}
          {sharedIpNames ? (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300">
              Shared IP with {sharedIpNames}
            </span>
          ) : null}
          {!event.ipChanged && !event.deviceChanged && !sharedDeviceNames && !sharedIpNames ? (
            <span className="text-xs text-gray-400">--</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export default function LoginActivity() {
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
  const [userId, setUserId] = useState('');
  const [change, setChange] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [events, setEvents] = useState<LoginActivityEvent[]>([]);
  const [sharedDevices, setSharedDevices] = useState<SharedDeviceGroup[]>([]);
  const [sharedIps, setSharedIps] = useState<SharedIpGroup[]>([]);
  const [summary, setSummary] = useState<LoginActivitySummary>(EMPTY_SUMMARY);
  const [staff, setStaff] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateRangeLabel = formatCalendarRangeLabel(startDate, endDate);
  const summaryItems = [
    ['Logins', summary.logins],
    ['IP changes', summary.ipChanged],
    ['Device changes', summary.deviceChanged],
    ['Either change', summary.eitherChanged],
  ] as const;

  const loadFilterOptions = useCallback(async () => {
    try {
      const staffResult = await getStaff();
      setStaff(staffResult.staff);
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
        const response = await getLoginActivity({
          startDate,
          endDate,
          userId: userId || undefined,
          change: isChange(change) ? change : undefined,
          page,
          limit,
        });
        setEvents(response.data);
        setSharedDevices(response.sharedDevices || []);
        setSharedIps(response.sharedIps || []);
        setSummary(response.summary);
        setTotal(response.pagination.total);
        setFrom(response.pagination.from);
        setTo(response.pagination.to);
        setLastUpdated(response.lastUpdated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load login activity');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate, userId, change, page, limit]
  );

  useEffect(() => {
    void loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  function handleResetFilters() {
    const range = getDefaultDateRange(timeZone);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setUserId('');
    setChange('');
    setPage(1);
    setLimit(20);
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title="Login Activity" activePage="loginActivity">
      <div className="max-w-[1600px] mx-auto space-y-0 -m-4 sm:-m-6 md:-m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Login Activity
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Staff sign-ins, including device and IP changes.{' '}
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
                Staff
              </span>
              <select
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Change
              </span>
              <select
                value={change}
                onChange={(event) => {
                  setChange(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All logins</option>
                <option value="ip">IP changed</option>
                <option value="device">Device changed</option>
                <option value="either">IP or device changed</option>
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

        <div className="grid grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-2">
          <ShareList title="Shared devices" empty="No shared devices.">
            {sharedDevices.length === 0
              ? null
              : sharedDevices.map((group) => (
                  <div key={group.deviceId}>
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {group.deviceLabel || 'Unknown device'}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {group.users.map((user) => accountLine(user, timeZone)).join(' · ')}
                    </div>
                  </div>
                ))}
          </ShareList>
          <ShareList title="Shared IPs" empty="No shared IPs.">
            {sharedIps.length === 0
              ? null
              : sharedIps.map((group) => (
                  <div key={group.ipAddress}>
                    <div className="font-medium text-gray-900 dark:text-gray-100">{group.ipAddress}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {group.users.map((user) => accountLine(user, timeZone)).join(' · ')}
                    </div>
                  </div>
                ))}
          </ShareList>
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
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Time</th>
                <th className="px-4 py-3 text-left font-medium">Staff</th>
                <th className="px-4 py-3 text-left font-medium">IP</th>
                <th className="px-4 py-3 text-left font-medium">Device</th>
                <th className="px-4 py-3 text-left font-medium">Changes</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading login activity...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No logins in this range.
                  </td>
                </tr>
              ) : (
                events.map((event) => {
                  const deviceGroup = sharedDevices.find((group) => group.deviceId === event.deviceId);
                  const ipGroup = sharedIps.find((group) => group.ipAddress === event.ipAddress);
                  return (
                    <LoginActivityRow
                      key={event.id}
                      event={event}
                      timeZone={timeZone}
                      sharedDeviceNames={deviceGroup ? otherNames(deviceGroup.users, event) : ''}
                      sharedIpNames={ipGroup ? otherNames(ipGroup.users, event) : ''}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
