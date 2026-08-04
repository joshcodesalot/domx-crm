import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ShieldAlert } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useToast } from '@/context/ToastContext';
import {
  createKeywordRule,
  deleteKeywordRule,
  getKeywordRules,
  getModerationEvents,
  updateKeywordRule,
  updateModerationEvent,
  type KeywordRule,
  type ModerationAction,
  type ModerationEvent,
  type ModerationEventStatus,
  type ModerationMatchMode,
} from '@/lib/api';

type Tab = 'rules' | 'review';

const ALL_ACTIONS: { value: ModerationAction; label: string; hint: string }[] = [
  {
    value: 'block_warn',
    label: 'Block & Warn Chatter',
    hint: 'Stop the send and warn the chatter',
  },
  {
    value: 'notify_management',
    label: 'Notify Management',
    hint: 'Alert managers and add to Review',
  },
  {
    value: 'log_for_review',
    label: 'Log for Review',
    hint: 'Quiet review queue entry only',
  },
];

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500';

const selectClassName =
  'px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function actionLabels(actions: ModerationAction[]): string {
  return actions
    .map((a) => ALL_ACTIONS.find((item) => item.value === a)?.label || a)
    .join(', ');
}

interface RuleFormState {
  name: string;
  englishKeywordText: string;
  germanKeywordText: string;
  actions: ModerationAction[];
  matchMode: ModerationMatchMode;
  caseSensitive: boolean;
  enabled: boolean;
}

const EMPTY_FORM: RuleFormState = {
  name: '',
  englishKeywordText: '',
  germanKeywordText: '',
  actions: ['notify_management'],
  matchMode: 'whole_word',
  caseSensitive: false,
  enabled: true,
};

export default function KeywordModeration() {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const { toast } = useToast();
  const canManage = hasPermission('moderation.manage');
  const canReview = hasPermission('moderation.review');

  const [activeTab, setActiveTab] = useState<Tab>(canManage ? 'rules' : 'review');
  const [rules, setRules] = useState<KeywordRule[]>([]);
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ModerationEventStatus | ''>('open');
  const [platformFilter, setPlatformFilter] = useState<'maloum' | '4based' | ''>('');
  const [search, setSearch] = useState('');
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    if (!canManage) return;
    const res = await getKeywordRules();
    setRules(res.rules);
  }, [canManage]);

  const loadEvents = useCallback(async () => {
    if (!canReview) return;
    const res = await getModerationEvents({
      status: statusFilter,
      platform: platformFilter,
      search: search.trim() || undefined,
      limit: 200,
    });
    setEvents(res.events);
  }, [canReview, statusFilter, platformFilter, search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'rules') {
        await loadRules();
      } else {
        await loadEvents();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeTab, loadRules, loadEvents]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (rule: KeywordRule) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      englishKeywordText: (rule.englishKeywords || []).join(', '),
      germanKeywordText: (rule.germanKeywords || []).join(', '),
      actions: [...rule.actions],
      matchMode: rule.matchMode,
      caseSensitive: rule.caseSensitive,
      enabled: rule.enabled,
    });
    setShowForm(true);
  };

  const toggleAction = (action: ModerationAction) => {
    setForm((prev) => {
      const has = prev.actions.includes(action);
      return {
        ...prev,
        actions: has
          ? prev.actions.filter((a) => a !== action)
          : [...prev.actions, action],
      };
    });
  };

  const saveRule = async () => {
    if (!form.englishKeywordText.trim() && !form.germanKeywordText.trim()) {
      toast.error('Enter at least one English or German keyword');
      return;
    }
    if (form.actions.length === 0) {
      toast.error('Select at least one action');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateKeywordRule(editingId, {
          name: form.name,
          englishKeywordText: form.englishKeywordText,
          germanKeywordText: form.germanKeywordText,
          actions: form.actions,
          matchMode: form.matchMode,
          caseSensitive: form.caseSensitive,
          enabled: form.enabled,
        });
        toast.success('Rule updated');
      } else {
        await createKeywordRule({
          name: form.name,
          englishKeywordText: form.englishKeywordText,
          germanKeywordText: form.germanKeywordText,
          actions: form.actions,
          matchMode: form.matchMode,
          caseSensitive: form.caseSensitive,
          enabled: form.enabled,
        });
        toast.success('Rule created');
      }
      setShowForm(false);
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (rule: KeywordRule) => {
    const ok = await confirm({
      title: 'Delete keyword rule?',
      message: `Delete rule? EN: ${(rule.englishKeywords || []).join(', ') || '—'} · DE: ${(rule.germanKeywords || []).join(', ') || '—'}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteKeywordRule(rule.id);
      toast.success('Rule deleted');
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  };

  const toggleEnabled = async (rule: KeywordRule) => {
    try {
      await updateKeywordRule(rule.id, { enabled: !rule.enabled });
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update rule');
    }
  };

  const setEventStatus = async (event: ModerationEvent, status: ModerationEventStatus) => {
    try {
      await updateModerationEvent(event.id, status);
      await loadEvents();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update event');
    }
  };

  const tabs = useMemo(() => {
    const list: { id: Tab; label: string }[] = [];
    if (canManage) list.push({ id: 'rules', label: 'Rules' });
    if (canReview) list.push({ id: 'review', label: 'Review' });
    return list;
  }, [canManage, canReview]);

  return (
    <AppLayout title="Keyword Moderation" activePage="moderation">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" />
              Keyword Moderation
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Monitor 1:1 chat messages. Block & warn chatters, notify management, or log for review.
            </p>
          </div>
          {activeTab === 'rules' && canManage && (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              Add rule
            </button>
          )}
        </div>

        <div className="flex gap-2 border-b border-gray-200 dark:border-white/10">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                activeTab === tab.id
                  ? 'border-gray-900 text-gray-900 dark:border-white dark:text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400">Loading...</p>
        ) : activeTab === 'rules' && canManage ? (
          <div className="overflow-x-auto border border-gray-200 dark:border-white/10 rounded-xl">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">English (before)</th>
                  <th className="px-4 py-3 font-medium">German (after)</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                  <th className="px-4 py-3 font-medium">Match</th>
                  <th className="px-4 py-3 font-medium">Enabled</th>
                  <th className="px-4 py-3 font-medium text-right">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                      No keyword rules yet. Add one to start monitoring.
                    </td>
                  </tr>
                ) : (
                  rules.map((rule) => (
                    <tr key={rule.id} className="bg-white dark:bg-transparent">
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">
                        {rule.name || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {(rule.englishKeywords || []).join(', ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {(rule.germanKeywords || []).join(', ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {actionLabels(rule.actions)}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {rule.matchMode === 'whole_word' ? 'Whole word' : 'Contains'}
                        {rule.caseSensitive ? ' · case' : ''}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(rule)}
                          className={`text-xs px-2 py-1 rounded-full ${
                            rule.enabled
                              ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-400'
                          }`}
                        >
                          {rule.enabled ? 'On' : 'Off'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => openEdit(rule)}
                          className="text-sm text-gray-700 dark:text-gray-200 hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeRule(rule)}
                          className="text-sm text-red-600 dark:text-red-400 hover:underline"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 items-center">
              <select
                className={selectClassName}
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as ModerationEventStatus | '')
                }
              >
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="reviewed">Reviewed</option>
                <option value="dismissed">Dismissed</option>
              </select>
              <select
                className={selectClassName}
                value={platformFilter}
                onChange={(e) =>
                  setPlatformFilter(e.target.value as 'maloum' | '4based' | '')
                }
              >
                <option value="">All platforms</option>
                <option value="maloum">Maloum</option>
                <option value="4based">4based</option>
              </select>
              <input
                className={`${inputClassName} max-w-xs`}
                placeholder="Search keyword, message, fan..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="overflow-x-auto border border-gray-200 dark:border-white/10 rounded-xl">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Chatter</th>
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Platform</th>
                    <th className="px-4 py-3 font-medium">Fan Username</th>
                    <th className="px-4 py-3 font-medium">Trigger Keyword</th>
                    <th className="px-4 py-3 font-medium">English Message</th>
                    <th className="px-4 py-3 font-medium">German Message</th>
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                  {events.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                        No moderation events match these filters.
                      </td>
                    </tr>
                  ) : (
                    events.map((event) => {
                      const expanded = expandedMessageId === event.id;
                      const englishMsg = event.englishMessageText || '';
                      const germanMsg = event.messageText || '';
                      const clip = (value: string) =>
                        value.length > 80 && !expanded
                          ? `${value.slice(0, 80)}…`
                          : value;
                      return (
                        <tr key={event.id} className="bg-white dark:bg-transparent align-top">
                          <td className="px-4 py-3 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                            {event.chatterName || '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                            {event.creatorName || '—'}
                          </td>
                          <td className="px-4 py-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            {event.platform}
                          </td>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            {event.fanUsername || '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 text-xs font-medium">
                              {event.matchedKeyword || '—'}
                            </span>
                            {event.matchedStage && (
                              <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">
                                {event.matchedStage === 'german'
                                  ? 'After translation'
                                  : 'Before translation'}
                              </div>
                            )}
                            {event.blocked && (
                              <div className="text-xs text-red-500 mt-1">Blocked</div>
                            )}
                          </td>
                          <td className="px-4 py-3 max-w-xs text-gray-700 dark:text-gray-300">
                            <button
                              type="button"
                              className="text-left whitespace-pre-wrap break-words hover:underline"
                              title={englishMsg}
                              onClick={() =>
                                setExpandedMessageId(expanded ? null : event.id)
                              }
                            >
                              {clip(englishMsg) || '—'}
                            </button>
                          </td>
                          <td className="px-4 py-3 max-w-xs text-gray-700 dark:text-gray-300">
                            <button
                              type="button"
                              className="text-left whitespace-pre-wrap break-words hover:underline"
                              title={germanMsg}
                              onClick={() =>
                                setExpandedMessageId(expanded ? null : event.id)
                              }
                            >
                              {clip(germanMsg) || '—'}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                            {formatDate(event.createdAt)}
                          </td>
                          <td className="px-4 py-3 text-right space-y-1">
                            <div className="text-xs text-gray-500 mb-1 capitalize">
                              {event.status}
                            </div>
                            {event.status === 'open' ? (
                              <div className="flex flex-col items-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => void setEventStatus(event, 'reviewed')}
                                  className="text-xs text-gray-700 dark:text-gray-200 hover:underline"
                                >
                                  Mark reviewed
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void setEventStatus(event, 'dismissed')}
                                  className="text-xs text-gray-500 hover:underline"
                                >
                                  Dismiss
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void setEventStatus(event, 'open')}
                                className="text-xs text-gray-500 hover:underline"
                              >
                                Reopen
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/40 dark:bg-black/70"
            aria-label="Close"
            onClick={() => setShowForm(false)}
          />
          <div className="relative w-full max-w-lg bg-white dark:bg-[#111] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {editingId ? 'Edit rule' : 'New keyword rule'}
            </h3>

            <label className="block space-y-1">
              <span className="text-xs text-gray-500">Name (optional)</span>
              <input
                className={inputClassName}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Tip keywords"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-gray-500">
                English keywords (before translation), e.g. tip, tips
              </span>
              <input
                className={inputClassName}
                value={form.englishKeywordText}
                onChange={(e) =>
                  setForm((p) => ({ ...p, englishKeywordText: e.target.value }))
                }
                placeholder="tip, tips"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-gray-500">
                German keywords (after translation / as sent), e.g. Trinkgeld
              </span>
              <input
                className={inputClassName}
                value={form.germanKeywordText}
                onChange={(e) =>
                  setForm((p) => ({ ...p, germanKeywordText: e.target.value }))
                }
                placeholder="Trinkgeld, Tipps"
              />
            </label>

            <div className="space-y-2">
              <span className="text-xs text-gray-500">Actions (combine as needed)</span>
              {ALL_ACTIONS.map((action) => (
                <label
                  key={action.value}
                  className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.actions.includes(action.value)}
                    onChange={() => toggleAction(action.value)}
                  />
                  <span>
                    <span className="font-medium">{action.label}</span>
                    <span className="block text-xs text-gray-500">{action.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">Match mode</span>
                <select
                  className={selectClassName}
                  value={form.matchMode}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      matchMode: e.target.value as ModerationMatchMode,
                    }))
                  }
                >
                  <option value="whole_word">Whole word</option>
                  <option value="contains">Contains</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm mt-6 text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.caseSensitive}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, caseSensitive: e.target.checked }))
                  }
                />
                Case sensitive
              </label>
              <label className="flex items-center gap-2 text-sm mt-6 text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, enabled: e.target.checked }))
                  }
                />
                Enabled
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveRule()}
                className="px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
