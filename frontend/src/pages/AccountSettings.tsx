import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Loader2, Settings } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { DEFAULT_TIMEZONE } from '@/components/PeriodDaysToggle';
import { useAuth } from '@/context/AuthContext';

const COMMON_TIMEZONES = [
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Vienna',
  'Europe/Zurich',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Toronto',
  'Asia/Manila',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Australia/Sydney',
  'UTC',
];

function listTimeZones(): string[] {
  try {
    const intlWithZones = Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    };
    if (typeof intlWithZones.supportedValuesOf === 'function') {
      return intlWithZones.supportedValuesOf('timeZone');
    }
  } catch {
    /* fall through */
  }
  return COMMON_TIMEZONES;
}

export default function AccountSettings() {
  const { user, updateTimezone } = useAuth();
  const allZones = useMemo(() => listTimeZones(), []);
  const [timezone, setTimezone] = useState(
    user?.timezone || DEFAULT_TIMEZONE
  );
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user?.timezone) {
      setTimezone(user.timezone);
    }
  }, [user?.timezone]);

  const options = useMemo(() => {
    const set = new Set([...COMMON_TIMEZONES, ...allZones]);
    if (timezone) set.add(timezone);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allZones, timezone]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setStatus('saving');
    try {
      await updateTimezone(timezone);
      setSaved(true);
      setStatus('idle');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Failed to save timezone');
    }
  }

  return (
    <AppLayout title="Account Settings" activePage="account">
      <div className="max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-900 dark:bg-white flex items-center justify-center">
            <Settings className="w-5 h-5 text-white dark:text-gray-900" />
          </div>
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Choose how analytics periods and day boundaries are calculated for you
            </p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-5 space-y-4"
        >
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {saved && (
            <div className="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2">
              Timezone saved. Analytics will use this zone for day boundaries.
            </div>
          )}

          <div>
            <label
              htmlFor="timezone"
              className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1.5"
            >
              Local timezone
            </label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                setSaved(false);
              }}
              className="w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#121212] px-3 py-2 text-sm"
            >
              {options.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Org schedules and activity day keys stay on Europe/Berlin. Your selection
              controls Overview, Charts, Creator Analytics, and team performance periods.
            </p>
          </div>

          <button
            type="submit"
            disabled={status === 'saving' || timezone === user?.timezone}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {status === 'saving' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save timezone'
            )}
          </button>
        </form>
      </div>
    </AppLayout>
  );
}
