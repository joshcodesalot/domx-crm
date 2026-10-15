import { useCallback, useEffect, useRef, useState } from 'react';
import AppLayout from '@/components/AppLayout';
import { useDocumentVisible } from '@/hooks/useDocumentVisible';
import {
  getOpsEvents,
  getOpsSummary,
  type OpsEvent,
  type OpsSummary,
} from '@/lib/api';
import { formatInstant } from '@/lib/messagingDashboardFormat';
import { useStaffTimeZone } from '@/lib/berlinTime';

const REFRESH_MS = 30_000;

const EMPTY_SUMMARY: OpsSummary = {
  errorsLastHour: 0,
  slowRequestsLastHour: 0,
  heartbeats: [],
};

function display(value: string | number | null | undefined): string {
  if (value == null || value === '') return '--';
  return String(value);
}

export default function Ops() {
  const documentVisible = useDocumentVisible();
  const timeZone = useStaffTimeZone();
  const loadedOnce = useRef(false);
  const [summary, setSummary] = useState<OpsSummary>(EMPTY_SUMMARY);
  const [events, setEvents] = useState<OpsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent ?? loadedOnce.current;
    if (!silent) setLoading(true);
    setError(null);

    try {
      const [summaryResult, eventsResult] = await Promise.all([
        getOpsSummary(),
        getOpsEvents(),
      ]);
      setSummary({
        errorsLastHour: summaryResult.errorsLastHour,
        slowRequestsLastHour: summaryResult.slowRequestsLastHour,
        heartbeats: summaryResult.heartbeats || [],
      });
      setEvents(
        (eventsResult.events || []).filter(
          (event) => event.kind === 'error' || event.kind === 'slow_request'
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load operations');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!documentVisible) return;
    void load();
    const interval = window.setInterval(() => {
      void load({ silent: true });
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [documentVisible, load]);

  return (
    <AppLayout title="Operations" activePage="ops">
      <div className="space-y-0 -m-4 sm:-m-6 md:-m-8">
        <div className="border-b border-gray-200 dark:border-white/10 px-6 py-4">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Operations</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Errors, slow requests, and the latest heartbeat from each worker.
          </p>
        </div>

        {error ? (
          <div className="mx-6 mt-4 rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-3">
          <section className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-4 py-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Errors in the last hour
            </h3>
            <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {loading ? '--' : summary.errorsLastHour}
            </p>
          </section>
          <section className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-4 py-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Slow requests in the last hour
            </h3>
            <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {loading ? '--' : summary.slowRequestsLastHour}
            </p>
          </section>
          <section className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-4 py-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Workers
            </h3>
            {loading ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading operations...</p>
            ) : summary.heartbeats.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No worker heartbeats yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {summary.heartbeats.map((beat) => (
                  <li
                    key={beat.source}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="font-medium text-gray-900 dark:text-gray-100">{beat.source}</span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {formatInstant(beat.time, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="table-scroll overflow-auto border-t border-gray-200 dark:border-white/10">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Time</th>
                <th className="px-4 py-3 text-left font-medium">Message</th>
                <th className="px-4 py-3 text-left font-medium">Route</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading operations...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No errors or slow requests.
                  </td>
                </tr>
              ) : (
                events.map((event, index) => (
                  <tr
                    key={`${event.time}-${event.path || ''}-${index}`}
                    className="border-t border-gray-100 dark:border-white/5"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-200">
                      {formatInstant(event.time, timeZone)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-200">
                      {display(event.message)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-200">{display(event.path)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-200">
                      {display(event.status)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-200">
                      {event.durationMs == null ? '--' : `${event.durationMs} ms`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
