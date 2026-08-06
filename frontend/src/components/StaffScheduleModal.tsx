import { useEffect, useMemo, useState } from 'react';
import {
  getStaffSchedule,
  updateStaffSchedule,
  type StaffScheduleDay,
  type User,
} from '@/lib/api';

const DAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Display order Mon–Sun while storing JS DOW 0–6 */
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

interface DayDraft {
  enabled: boolean;
  startTime: string;
  endTime: string;
}

interface StaffScheduleModalProps {
  member: User;
  canEdit: boolean;
  onClose: () => void;
}

function emptyWeek(): Record<number, DayDraft> {
  const week: Record<number, DayDraft> = {};
  for (let d = 0; d <= 6; d += 1) {
    week[d] = { enabled: false, startTime: '09:00', endTime: '17:00' };
  }
  return week;
}

function daysToDraft(days: StaffScheduleDay[]): Record<number, DayDraft> {
  const week = emptyWeek();
  for (const day of days) {
    week[day.dayOfWeek] = {
      enabled: true,
      startTime: day.startTime.slice(0, 5),
      endTime: day.endTime.slice(0, 5),
    };
  }
  return week;
}

function isOvernight(startTime: string, endTime: string): boolean {
  return Boolean(startTime && endTime && endTime <= startTime);
}

const inputClassName =
  'px-2 py-1.5 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

export default function StaffScheduleModal({
  member,
  canEdit,
  onClose,
}: StaffScheduleModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [week, setWeek] = useState<Record<number, DayDraft>>(emptyWeek);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await getStaffSchedule(member.id);
        if (!cancelled) setWeek(daysToDraft(result.days || []));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load schedule');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [member.id]);

  const payloadDays = useMemo(() => {
    return DISPLAY_DAYS.flatMap((dow) => {
      const day = week[dow];
      if (!day?.enabled) return [];
      return [
        {
          dayOfWeek: dow,
          startTime: day.startTime,
          endTime: day.endTime,
        },
      ];
    });
  }, [week]);

  function updateDay(dow: number, patch: Partial<DayDraft>) {
    setWeek((prev) => ({
      ...prev,
      [dow]: { ...prev[dow], ...patch },
    }));
  }

  function applyToAllDays() {
    const source =
      week[DISPLAY_DAYS.find((d) => week[d]?.enabled) ?? 1] || week[1];
    const next = emptyWeek();
    for (const dow of DISPLAY_DAYS) {
      next[dow] = {
        enabled: true,
        startTime: source.startTime,
        endTime: source.endTime,
      };
    }
    setWeek(next);
  }

  function clearAll() {
    setWeek(emptyWeek());
  }

  async function handleSave() {
    if (!canEdit) return;
    for (const day of payloadDays) {
      if (day.startTime === day.endTime) {
        setError('Start and end time cannot be the same');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await updateStaffSchedule(member.id, payloadDays);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-[#1a1a1a] rounded-xl border border-gray-200 dark:border-white/10 shadow-xl">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-1">Work schedule</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {member.name} — hours in Europe/Berlin (CET/CEST)
          </p>
          <p className="text-xs text-gray-400 mb-4">
            Overnight shifts are supported (e.g. 23:00–08:00). Cleared days count as
            days off. No schedule means all-day stats.
          </p>

          {error ? (
            <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-gray-400 py-8 text-center">Loading schedule...</p>
          ) : (
            <>
              {canEdit ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={applyToAllDays}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    Apply first enabled to all days
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    Clear all (all day)
                  </button>
                </div>
              ) : null}

              <div className="space-y-3">
                {DISPLAY_DAYS.map((dow) => {
                  const day = week[dow];
                  const overnight = isOvernight(day.startTime, day.endTime);
                  return (
                    <div
                      key={dow}
                      className="flex flex-wrap items-center gap-3 border border-gray-100 dark:border-white/5 rounded-lg px-3 py-2"
                    >
                      <label className="flex items-center gap-2 w-28 shrink-0 text-sm font-medium">
                        <input
                          type="checkbox"
                          checked={day.enabled}
                          disabled={!canEdit}
                          onChange={(e) =>
                            updateDay(dow, { enabled: e.target.checked })
                          }
                          className="rounded border-gray-300 dark:border-white/20"
                        />
                        {DAY_LABELS[dow]}
                      </label>
                      <input
                        type="time"
                        value={day.startTime}
                        disabled={!canEdit || !day.enabled}
                        onChange={(e) => updateDay(dow, { startTime: e.target.value })}
                        className={inputClassName}
                      />
                      <span className="text-xs text-gray-400">to</span>
                      <input
                        type="time"
                        value={day.endTime}
                        disabled={!canEdit || !day.enabled}
                        onChange={(e) => updateDay(dow, { endTime: e.target.value })}
                        className={inputClassName}
                      />
                      {day.enabled && overnight ? (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          Overnight
                        </span>
                      ) : null}
                      {!day.enabled ? (
                        <span className="text-xs text-gray-400">Off / all day</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex gap-3 pt-6">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5"
            >
              {canEdit ? 'Cancel' : 'Close'}
            </button>
            {canEdit ? (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={loading || saving}
                className="flex-1 px-4 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save schedule'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
