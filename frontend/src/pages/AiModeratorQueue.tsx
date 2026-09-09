import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import {
  approveAiSuggestion,
  editSendAiSuggestion,
  getAiConversationMessages,
  getAiQueue,
  getCreators,
  ignoreAiConversation,
  pauseAiConversation,
  rejectAiSuggestion,
  resumeAiConversation,
  sendFourBasedMessage,
  sendMaloumMessage,
  sendTelegramMessage,
  takeoverAiConversation,
  unignoreAiConversation,
  type AiConversationMessage,
  type AiConversationState,
  type AiIngestPlatform,
  type AiQueueBucket,
  type AiQueueItem,
  type Creator,
} from '@/lib/api';
import { useAiSuggestionEvents } from '@/hooks/useAiSuggestionEvents';

type DashboardTab = 'all' | AiQueueBucket;

const TABS: { id: DashboardTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'ai_handling', label: 'AI handling' },
  { id: 'taken_over', label: 'Taken over' },
  { id: 'paused', label: 'Paused' },
  { id: 'ignored', label: 'Ignored' },
];

const STATS: { id: AiQueueBucket; label: string }[] = [
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

const STATUS_LABEL: Record<AiQueueBucket, string> = {
  needs_review: 'Needs review',
  ai_handling: 'AI handling',
  taken_over: 'Taken over',
  paused: 'Paused',
  ignored: 'Ignored',
};

const STATE_STYLE: Record<AiConversationState, string> = {
  NEW: 'bg-blue-950 text-blue-200 border-blue-800',
  DISCOVERY: 'bg-sky-950 text-sky-200 border-sky-800',
  KINK_DISCOVERY: 'bg-violet-950 text-violet-200 border-violet-800',
  WARMUP: 'bg-amber-950 text-amber-200 border-amber-800',
  INTENSE_WARMUP: 'bg-orange-950 text-orange-200 border-orange-800',
  SALES_READY: 'bg-red-950 text-red-200 border-red-800',
  OFFERED: 'bg-pink-950 text-pink-200 border-pink-800',
  PURCHASED: 'bg-emerald-950 text-emerald-200 border-emerald-800',
  FULFILLMENT: 'bg-green-950 text-green-200 border-green-800',
  RETENTION: 'bg-indigo-950 text-indigo-200 border-indigo-800',
};

const STATUS_STYLE: Record<AiQueueBucket, string> = {
  needs_review: 'bg-[#cca700] text-black',
  ai_handling: 'bg-[#3794ff] text-white',
  taken_over: 'bg-[#89d185] text-black',
  paused: 'bg-[#858585] text-white',
  ignored: 'bg-gray-500 text-white',
};

const PLATFORM_STYLE: Record<AiIngestPlatform, string> = {
  maloum: 'bg-[#0e639c] text-white',
  '4based': 'bg-[#89d185] text-black',
  telegram: 'bg-[#3794ff] text-white',
};

const selectClassName =
  'bg-white dark:bg-[#1e1e1e] text-gray-800 dark:text-[#cccccc] border border-gray-200 dark:border-[#3c3c3c] rounded py-1 px-3 text-xs outline-none focus:border-domx-500 dark:focus:border-[#0e639c]';

const ghostBtn =
  'text-xs text-[#0e639c] dark:text-[#3794ff] hover:underline disabled:opacity-50 disabled:cursor-not-allowed bg-transparent border-none p-0';

function formatRelative(value: string | null): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round(Math.max(0, Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function fanLabel(item: AiQueueItem): string {
  return item.fanLabel || item.fanUsername || 'Fan';
}

function draftPreview(item: AiQueueItem): string {
  return item.suggestion?.replyEnglish?.trim() || item.suggestion?.reply?.trim() || '';
}

function isTakenOver(item: AiQueueItem): boolean {
  return item.humanTakeover || item.effectiveMode === 'human_takeover';
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
  const [bucket, setBucket] = useState<DashboardTab>('all');
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiConversationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [humanText, setHumanText] = useState('');
  const [editGerman, setEditGerman] = useState('');
  const [editEnglish, setEditEnglish] = useState('');
  const [editing, setEditing] = useState(false);

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
        bucket: bucket === 'all' ? undefined : bucket,
        creatorId: creatorId || undefined,
        platform: platform || undefined,
        state: state || undefined,
        limit: 100,
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

  const selected = useMemo(
    () => items.find((item) => item.conversationId === selectedId) || null,
    [items, selectedId]
  );

  const loadMessages = useCallback(async (conversationId: string) => {
    setMessagesLoading(true);
    try {
      const result = await getAiConversationMessages(conversationId, 20);
      setMessages(result.messages || []);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setEditing(false);
      setHumanText('');
      return;
    }
    void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  useEffect(() => {
    if (!selected) {
      setEditing(false);
      return;
    }
    setEditGerman(selected.suggestion?.reply || '');
    setEditEnglish(selected.suggestion?.replyEnglish || '');
  }, [selected]);

  const creatorOptions = useMemo(
    () =>
      creators
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [creators]
  );

  const emptyAll =
    !loading && Object.values(counts).every((count) => !count);

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
      if (selectedId === item.conversationId) {
        await loadMessages(item.conversationId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusyId(null);
    }
  };

  const sendAsHuman = async () => {
    if (!selected || !humanText.trim()) return;
    const text = humanText.trim();
    await runRowAction(selected, async () => {
      if (selected.platform === 'maloum') {
        await sendMaloumMessage(selected.creatorId, selected.platformChatId, {
          text,
        });
      } else if (selected.platform === '4based') {
        await sendFourBasedMessage(selected.creatorId, selected.platformChatId, {
          message: text,
        });
      } else {
        await sendTelegramMessage(selected.creatorId, selected.platformChatId, text);
      }
    });
    setHumanText('');
  };

  const submitEdit = async () => {
    if (!selected?.suggestion?.id) return;
    const text = editGerman.trim();
    if (!text) {
      setError('German text is required');
      return;
    }
    await runRowAction(selected, () =>
      editSendAiSuggestion(selected.suggestion!.id, {
        text,
        englishText: editEnglish.trim() || undefined,
      })
    );
    setEditing(false);
  };

  return (
    <AppLayout title="AI Dashboard" activePage="aiQueue">
      <div className="-m-8 flex flex-col h-[calc(100vh-4rem)] bg-white dark:bg-[#1e1e1e] text-gray-800 dark:text-[#cccccc]">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#3c3c3c] shrink-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white m-0">
            AI Dashboard
          </h1>
          <p className="text-gray-500 dark:text-[#858585] mt-1 text-sm">
            Live AI conversations. Click a row to takeover, pause, or reply.
          </p>
          <div className="flex gap-4 mt-4">
            {STATS.map((stat) => (
              <div
                key={stat.id}
                className="flex-1 p-3 bg-gray-50 dark:bg-[#252526] border border-gray-200 dark:border-[#3c3c3c] rounded"
              >
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {counts[stat.id] || 0}
                </div>
                <div className="text-gray-500 dark:text-[#858585] text-xs mt-1">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-between items-center px-6 py-3 border-b border-gray-200 dark:border-[#3c3c3c] bg-gray-50 dark:bg-[#252526] shrink-0">
          <div className="flex gap-6">
            {TABS.map((tab) => {
              const active = bucket === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setBucket(tab.id)}
                  className={`pb-2 -mb-[13px] border-b-2 text-sm transition-colors ${
                    active
                      ? 'border-[#0e639c] text-gray-900 dark:text-white font-bold'
                      : 'border-transparent text-gray-500 dark:text-[#858585]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-3">
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
            <select
              value={state}
              onChange={(event) =>
                setState(event.target.value as AiConversationState | '')
              }
              className={selectClassName}
            >
              <option value="">All states</option>
              {FUNNEL_STATES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-red-500 px-6 py-2 shrink-0">{error}</p>
        ) : null}

        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {loading && items.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-[#858585] mt-6">
                Loading queue…
              </p>
            ) : items.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-[#858585] mt-6">
                {emptyAll
                  ? 'No ingested AI conversations.'
                  : 'Nothing in this filter.'}
              </p>
            ) : (
              <table className="w-full text-left border-collapse text-sm">
                <thead className="sticky top-0 bg-white dark:bg-[#1e1e1e] z-10">
                  <tr>
                    {[
                      'Creator',
                      'Fan',
                      'Platform',
                      'State',
                      'Status',
                      'Last inbound',
                      'AI draft',
                      'Actions',
                    ].map((heading) => (
                      <th
                        key={heading}
                        className="py-3 px-2 border-b border-gray-200 dark:border-[#3c3c3c] text-gray-500 dark:text-[#858585] font-normal"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const href = chatterHref(item);
                    const busy = busyId === item.conversationId;
                    const takenOver = isTakenOver(item);
                    const selectedRow = selectedId === item.conversationId;
                    return (
                      <tr
                        key={item.conversationId}
                        className={`cursor-pointer transition-colors border-b border-gray-100 dark:border-[#3c3c3c] align-top ${
                          selectedRow
                            ? 'bg-gray-100 dark:bg-[#37373d]'
                            : 'hover:bg-gray-50 dark:hover:bg-[#2a2d2e]'
                        }`}
                        onClick={() => setSelectedId(item.conversationId)}
                      >
                        <td className="py-3 px-2 text-gray-900 dark:text-[#cccccc]">
                          {item.creatorName}
                        </td>
                        <td
                          className="py-3 px-2 max-w-[8rem] truncate"
                          title={fanLabel(item)}
                        >
                          {fanLabel(item)}
                        </td>
                        <td className="py-3 px-2">
                          <span
                            className={`px-2 py-[2px] rounded-full text-[11px] whitespace-nowrap ${PLATFORM_STYLE[item.platform]}`}
                          >
                            {item.platform}
                          </span>
                        </td>
                        <td className="py-3 px-2">
                          <span
                            className={`px-2 py-[2px] rounded-full text-[11px] whitespace-nowrap border ${STATE_STYLE[item.state]}`}
                          >
                            {item.state}
                          </span>
                        </td>
                        <td className="py-3 px-2">
                          <span
                            className={`px-2 py-[2px] rounded-full text-[11px] whitespace-nowrap ${STATUS_STYLE[item.bucket]}`}
                          >
                            {STATUS_LABEL[item.bucket]}
                          </span>
                        </td>
                        <td className="py-3 px-2">
                          <div className="text-[11px] text-gray-500 dark:text-[#858585] mb-1">
                            {formatRelative(item.lastInboundAt)}
                          </div>
                          <div
                            className="max-w-[150px] truncate text-xs"
                            title={item.lastInboundPreview || ''}
                          >
                            {item.lastInboundPreview || '—'}
                          </div>
                        </td>
                        <td className="py-3 px-2">
                          <div
                            className={`max-w-[150px] truncate text-xs ${
                              draftPreview(item)
                                ? 'text-gray-800 dark:text-[#cccccc]'
                                : 'text-gray-400 dark:text-[#858585]'
                            }`}
                            title={draftPreview(item)}
                          >
                            {draftPreview(item) || 'No draft pending'}
                          </div>
                        </td>
                        <td className="py-3 px-2" onClick={(event) => event.stopPropagation()}>
                          <div className="flex gap-2 flex-wrap">
                            {href ? (
                              <Link to={href} className={ghostBtn}>
                                Open
                              </Link>
                            ) : null}
                            {item.aiIgnored ? (
                              <button
                                type="button"
                                className={ghostBtn}
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
                                className={ghostBtn}
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
                                className={ghostBtn}
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
                            {item.aiIgnored || item.creatorPaused || item.aiPaused ? null : (
                              <button
                                type="button"
                                className={ghostBtn}
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
                            {item.aiIgnored || !item.suggestion ? null : (
                              <>
                                <button
                                  type="button"
                                  className={ghostBtn}
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
                                  className={ghostBtn}
                                  disabled={busy}
                                  onClick={() => {
                                    setSelectedId(item.conversationId);
                                    setEditing(true);
                                  }}
                                >
                                  Edit & send
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {selected ? (
            <div className="w-[400px] border-l border-gray-200 dark:border-[#3c3c3c] bg-gray-50 dark:bg-[#252526] flex flex-col shrink-0">
              <div className="p-4 border-b border-gray-200 dark:border-[#3c3c3c] shrink-0">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-bold text-gray-900 dark:text-white text-base truncate">
                    {selected.creatorName} → {fanLabel(selected)}
                  </span>
                  <button
                    type="button"
                    className="text-gray-400 hover:text-gray-700 dark:hover:text-white text-sm"
                    onClick={() => setSelectedId(null)}
                  >
                    Close
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className={`px-2 py-[2px] rounded-full ${PLATFORM_STYLE[selected.platform]}`}>
                    {selected.platform}
                  </span>
                  <span
                    className={`px-2 py-[2px] rounded-full border ${STATE_STYLE[selected.state]}`}
                  >
                    {selected.state}
                  </span>
                  <span className={`px-2 py-[2px] rounded-full ${STATUS_STYLE[selected.bucket]}`}>
                    {STATUS_LABEL[selected.bucket]}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {chatterHref(selected) ? (
                    <Link to={chatterHref(selected)!} className={ghostBtn}>
                      Open
                    </Link>
                  ) : null}
                  {selected.aiIgnored ? (
                    <button
                      type="button"
                      className={ghostBtn}
                      disabled={busyId === selected.conversationId}
                      onClick={() =>
                        void runRowAction(selected, () =>
                          unignoreAiConversation(selected.conversationId)
                        )
                      }
                    >
                      Un-ignore
                    </button>
                  ) : (
                    <>
                      {isTakenOver(selected) ? (
                        <button
                          type="button"
                          className={ghostBtn}
                          disabled={busyId === selected.conversationId}
                          onClick={() =>
                            void runRowAction(selected, () =>
                              resumeAiConversation(selected.conversationId)
                            )
                          }
                        >
                          Resume AI
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={ghostBtn}
                          disabled={busyId === selected.conversationId}
                          onClick={() =>
                            void runRowAction(selected, () =>
                              takeoverAiConversation(selected.conversationId)
                            )
                          }
                        >
                          Takeover
                        </button>
                      )}
                      {selected.aiPaused ? null : (
                        <button
                          type="button"
                          className={ghostBtn}
                          disabled={busyId === selected.conversationId}
                          onClick={() =>
                            void runRowAction(selected, () =>
                              pauseAiConversation(selected.conversationId)
                            )
                          }
                        >
                          Pause
                        </button>
                      )}
                      <button
                        type="button"
                        className={ghostBtn}
                        disabled={busyId === selected.conversationId}
                        onClick={() =>
                          void runRowAction(selected, () =>
                            ignoreAiConversation(selected.conversationId)
                          )
                        }
                      >
                        Ignore
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 min-h-0">
                {messagesLoading ? (
                  <p className="text-xs text-gray-500">Loading messages…</p>
                ) : messages.length === 0 ? (
                  <p className="text-xs text-gray-500">No messages yet.</p>
                ) : (
                  messages.map((msg) => {
                    const fan = msg.direction === 'inbound';
                    return (
                      <div
                        key={`${msg.platformMessageId}-${msg.sentAt}`}
                        className={`${fan ? 'self-start bg-white dark:bg-[#1e1e1e] text-gray-800 dark:text-[#cccccc]' : 'self-end bg-[#0e639c] text-white'} px-3 py-2 rounded max-w-[85%]`}
                      >
                        <div className="text-[10px] opacity-70 mb-1">
                          {fan ? fanLabel(selected) : selected.creatorName}
                        </div>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap">
                          {msg.text || (msg.hasMedia ? '[media]' : '')}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {selected.suggestion && !selected.aiIgnored ? (
                <div className="m-4 p-3 bg-white dark:bg-[#1e1e1e] border-l-4 border-[#cca700] rounded-r shrink-0">
                  <div className="text-[11px] text-gray-500 dark:text-[#858585] mb-1 font-bold">
                    PENDING AI DRAFT
                  </div>
                  {editing ? (
                    <>
                      <textarea
                        value={editGerman}
                        onChange={(event) => setEditGerman(event.target.value)}
                        rows={3}
                        className="w-full mb-2 px-2 py-1 text-xs border border-gray-200 dark:border-[#3c3c3c] rounded bg-white dark:bg-[#252526]"
                      />
                      <textarea
                        value={editEnglish}
                        onChange={(event) => setEditEnglish(event.target.value)}
                        rows={2}
                        className="w-full mb-2 px-2 py-1 text-xs border border-gray-200 dark:border-[#3c3c3c] rounded bg-white dark:bg-[#252526]"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="bg-[#0e639c] text-white text-xs px-3 py-1.5 rounded font-bold"
                          onClick={() => void submitEdit()}
                        >
                          Send
                        </button>
                        <button
                          type="button"
                          className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-[#3c3c3c]"
                          onClick={() => setEditing(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm mb-3 whitespace-pre-wrap">
                        {selected.suggestion.reply}
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="bg-[#0e639c] text-white text-xs px-3 py-1.5 rounded font-bold"
                          onClick={() =>
                            void runRowAction(selected, () =>
                              approveAiSuggestion(selected.suggestion!.id)
                            )
                          }
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-[#3c3c3c]"
                          onClick={() => setEditing(true)}
                        >
                          Edit & send
                        </button>
                        <button
                          type="button"
                          className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-[#3c3c3c]"
                          onClick={() =>
                            void runRowAction(selected, () =>
                              rejectAiSuggestion(selected.suggestion!.id)
                            )
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              <div className="relative p-4 border-t border-gray-200 dark:border-[#3c3c3c] shrink-0">
                {!isTakenOver(selected) ? (
                  <div className="absolute inset-0 bg-white/80 dark:bg-[#1e1e1e]/80 backdrop-blur-[1px] flex items-center justify-center p-4 text-center z-10">
                    <div>
                      <div className="mb-3 font-bold text-gray-900 dark:text-white text-sm">
                        Take over first to type as the creator
                      </div>
                      <button
                        type="button"
                        className="bg-[#0e639c] text-white text-xs px-4 py-2 rounded font-bold"
                        onClick={() =>
                          void runRowAction(selected, () =>
                            takeoverAiConversation(selected.conversationId)
                          )
                        }
                      >
                        Takeover Chat
                      </button>
                    </div>
                  </div>
                ) : null}
                <textarea
                  value={humanText}
                  onChange={(event) => setHumanText(event.target.value)}
                  rows={3}
                  placeholder="Send as human…"
                  disabled={!isTakenOver(selected)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-[#3c3c3c] rounded bg-white dark:bg-[#1e1e1e] disabled:opacity-50"
                />
                <button
                  type="button"
                  className="mt-2 bg-[#0e639c] text-white text-xs px-3 py-1.5 rounded font-bold disabled:opacity-50"
                  disabled={!isTakenOver(selected) || !humanText.trim() || busyId === selected.conversationId}
                  onClick={() => void sendAsHuman()}
                >
                  Send as human
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
