import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import {
  approveAiSuggestion,
  editSendAiSuggestion,
  getAiQueue,
  getCreators,
  pauseAiConversation,
  rejectAiSuggestion,
  resumeAiConversation,
  takeoverAiConversation,
  unignoreAiConversation,
  type AiConversationState,
  type AiIngestPlatform,
  type AiQueueBucket,
  type AiQueueItem,
  type Creator,
} from '@/lib/api';
import { useAiSuggestionEvents } from '@/hooks/useAiSuggestionEvents';

const TABS: { id: AiQueueBucket; label: string }[] = [
  { id: 'needs_review', label: 'Needs review' },
  { id: 'ai_handling', label: 'AI handling' },
  { id: 'taken_over', label: 'Taken over' },
  { id: 'paused', label: 'Paused' },
  { id: 'ignored', label: 'Ignored' },
];

const FUNNEL_STATES: AiConversationState[] = [
  'NEW',
  'DISCOVERY',
  'KINK_DISCOVERY',
  'WARMUP',
  'INTENSE_WARMUP',
  'SALES_READY',
  'OFFERED',
  'PURCHASED',
  'FULFILLMENT',
  'RETENTION',
];

const selectClassName =
  'px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const actionBtn =
  'text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed';

function formatWhen(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMode(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw.replace(/_/g, ' ');
}

function fanLabel(item: AiQueueItem): string {
  return item.platformFanId || item.platformChatId || '—';
}

function draftPreview(item: AiQueueItem): string {
  return (
    item.suggestion?.replyEnglish?.trim() ||
    item.suggestion?.reply?.trim() ||
    item.lastInboundPreview?.trim() ||
    '—'
  );
}

export function chatterHref(item: AiQueueItem): string | null {
  if (!item.creatorId || !item.platformChatId) return null;
  if (item.platform === 'telegram') {
    const params = new URLSearchParams({
      creatorId: item.creatorId,
      peerId: item.platformChatId,
    });
    return `/chatter/telegram?${params.toString()}`;
  }
  const params = new URLSearchParams({
    creatorId: item.creatorId,
    chatId: item.platformChatId,
  });
  if (item.platform === 'maloum') return `/chatter?${params.toString()}`;
  if (item.platform === '4based') return `/chatter/4based?${params.toString()}`;
  return null;
}

export default function AiModeratorQueue() {
  const [bucket, setBucket] = useState<AiQueueBucket>('needs_review');
  const [creatorId, setCreatorId] = useState('');
  const [platform, setPlatform] = useState<AiIngestPlatform | ''>('');
  const [state, setState] = useState<AiConversationState | ''>('');
  const [creators, setCreators] = useState<Creator[]>([]);
  const [items, setItems] = useState<AiQueueItem[]>([]);
  const [counts, setCounts] = useState<Record<AiQueueBucket, number>>({
    needs_review: 0,
    ai_handling: 0,
    taken_over: 0,
    paused: 0,
    ignored: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<AiQueueItem | null>(null);
  const [editGerman, setEditGerman] = useState('');
  const [editEnglish, setEditEnglish] = useState('');

  useEffect(() => {
    void getCreators()
      .then((result) => setCreators(result.creators || []))
      .catch(() => {
        // Filters stay empty if the creator list fails.
      });
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAiQueue({
        bucket,
        creatorId: creatorId || undefined,
        platform: platform || undefined,
        state: state || undefined,
      });
      setItems(result.items || []);
      setCounts(result.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [bucket, creatorId, platform, state]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useAiSuggestionEvents({
    onSuggestion: () => {
      void loadQueue();
    },
  });

  const creatorOptions = useMemo(
    () =>
      creators
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [creators]
  );

  const emptyAll =
    !loading &&
    Object.values(counts).every((count) => !count);

  const runRowAction = async (
    item: AiQueueItem,
    fn: () => Promise<unknown>
  ) => {
    if (busyId) return;
    setBusyId(item.conversationId);
    setError(null);
    try {
      await fn();
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (item: AiQueueItem) => {
    setEditItem(item);
    setEditGerman(item.suggestion?.reply || '');
    setEditEnglish(item.suggestion?.replyEnglish || '');
  };

  const submitEdit = async () => {
    if (!editItem?.suggestion?.id) return;
    const text = editGerman.trim();
    if (!text) {
      setError('German text is required');
      return;
    }
    const suggestionId = editItem.suggestion.id;
    const item = editItem;
    setEditItem(null);
    await runRowAction(item, () =>
      editSendAiSuggestion(suggestionId, {
        text,
        englishText: editEnglish.trim() || undefined,
      })
    );
  };

  return (
    <AppLayout title="AI Queue" activePage="aiQueue">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {TABS.map((tab) => {
          const active = bucket === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBucket(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                active
                  ? 'border-domx-600/40 bg-domx-50 dark:bg-domx-950/40 text-domx-700 dark:text-domx-300'
                  : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-white/5'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-gray-400">
                {counts[tab.id] || 0}
              </span>
            </button>
          );
        })}
        <select
          value={state}
          onChange={(event) =>
            setState(event.target.value as AiConversationState | '')
          }
          className={`${selectClassName} ml-auto`}
        >
          <option value="">All states</option>
          {FUNNEL_STATES.map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={creatorId}
          onChange={(event) => setCreatorId(event.target.value)}
          className={selectClassName}
        >
          <option value="">All creators</option>
          {creatorOptions.map((creator) => (
            <option key={creator.id} value={creator.id}>
              {creator.displayName}
            </option>
          ))}
        </select>
        <select
          value={platform}
          onChange={(event) =>
            setPlatform(event.target.value as AiIngestPlatform | '')
          }
          className={selectClassName}
        >
          <option value="">All platforms</option>
          <option value="maloum">Maloum</option>
          <option value="4based">4based</option>
          <option value="telegram">Telegram</option>
        </select>
      </div>

      {error ? (
        <p className="text-sm text-red-500 mb-4">{error}</p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-gray-500">Loading queue…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">
          {emptyAll
            ? 'No ingested AI conversations.'
            : 'Nothing in this filter.'}
        </p>
      ) : (
        <div className="border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Creator</th>
                <th className="px-4 py-2 font-medium">Fan / chat id</th>
                <th className="px-4 py-2 font-medium">Platform</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Mode</th>
                <th className="px-4 py-2 font-medium">Last activity</th>
                <th className="px-4 py-2 font-medium">Draft</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const href = chatterHref(item);
                const busy = busyId === item.conversationId;
                const takenOver = item.humanTakeover || item.effectiveMode === 'human_takeover';
                return (
                  <tr
                    key={item.conversationId}
                    className="border-t border-gray-100 dark:border-white/10 align-top"
                  >
                    <td className="px-4 py-3 text-gray-900 dark:text-zinc-100">
                      {item.creatorName}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-[8rem] truncate" title={fanLabel(item)}>
                      {fanLabel(item)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{item.platform}</td>
                    <td className="px-4 py-3 text-gray-500">{item.state}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatMode(item.effectiveMode)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {formatWhen(item.lastMessageAt || item.lastInboundAt)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-zinc-300 max-w-xs truncate">
                      {draftPreview(item)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {href ? (
                          <Link to={href} className={actionBtn}>
                            Open
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-400 px-2 py-1">Open</span>
                        )}
                        {item.aiIgnored ? (
                          <button
                            type="button"
                            className={actionBtn}
                            disabled={busy}
                            onClick={() =>
                              void runRowAction(item, () =>
                                unignoreAiConversation(item.conversationId)
                              )
                            }
                          >
                            Un-ignore
                          </button>
                        ) : takenOver || item.aiPaused ? (
                          <button
                            type="button"
                            className={actionBtn}
                            disabled={busy}
                            onClick={() =>
                              void runRowAction(item, () =>
                                resumeAiConversation(item.conversationId)
                              )
                            }
                          >
                            Resume
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={actionBtn}
                            disabled={busy}
                            onClick={() =>
                              void runRowAction(item, () =>
                                takeoverAiConversation(item.conversationId)
                              )
                            }
                          >
                            Takeover
                          </button>
                        )}
                        {item.aiIgnored ? null : item.creatorPaused ? (
                          <span className="text-xs text-gray-400 px-2 py-1">
                            Creator paused
                          </span>
                        ) : item.aiPaused ? null : (
                          <button
                            type="button"
                            className={actionBtn}
                            disabled={busy}
                            onClick={() =>
                              void runRowAction(item, () =>
                                pauseAiConversation(item.conversationId)
                              )
                            }
                          >
                            Pause
                          </button>
                        )}
                        {item.aiIgnored ? null : item.suggestion ? (
                          <>
                            <button
                              type="button"
                              className={actionBtn}
                              disabled={busy}
                              onClick={() =>
                                void runRowAction(item, () =>
                                  approveAiSuggestion(item.suggestion!.id)
                                )
                              }
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className={actionBtn}
                              disabled={busy}
                              onClick={() => openEdit(item)}
                            >
                              Edit & send
                            </button>
                            <button
                              type="button"
                              className={actionBtn}
                              disabled={busy}
                              onClick={() =>
                                void runRowAction(item, () =>
                                  rejectAiSuggestion(item.suggestion!.id)
                                )
                              }
                            >
                              Reject
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100 mb-3">
              Edit & send
            </h2>
            <label className="block text-xs text-gray-500 mb-1">German</label>
            <textarea
              value={editGerman}
              onChange={(event) => setEditGerman(event.target.value)}
              rows={4}
              className="w-full mb-3 px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#111] text-gray-900 dark:text-gray-100"
            />
            <label className="block text-xs text-gray-500 mb-1">English</label>
            <textarea
              value={editEnglish}
              onChange={(event) => setEditEnglish(event.target.value)}
              rows={3}
              className="w-full mb-4 px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#111] text-gray-900 dark:text-gray-100"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={actionBtn}
                onClick={() => setEditItem(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={actionBtn}
                onClick={() => void submitEdit()}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppLayout>
  );
}
