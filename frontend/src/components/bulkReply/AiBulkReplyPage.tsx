import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react';
import {
  Check,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import { formatRelativeTime as formatMaloumRelativeTime } from '@/components/maloum/MaloumChatPanels';
import { formatRelativeTime as formatFourBasedRelativeTime } from '@/components/fourbased/FourBasedChatPanels';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useToast } from '@/context/ToastContext';
import {
  getCreators,
  type Creator,
  type SuggestReplyId,
  type SuggestReplyOption,
} from '@/lib/api';
import {
  draftFourBasedSuggestReply,
  draftMaloumSuggestReply,
  loadFourBasedUnreadChats,
  loadMaloumUnreadChats,
  runWithConcurrency,
  sendFourBasedBulkReply,
  sendMaloumBulkReply,
} from './helpers';
import {
  DRAFT_CONCURRENCY,
  MAX_BULK_SELECTION,
  SEND_DELAY_MS,
  type BulkReplyPlatform,
  type BulkReplyRow,
  type BulkUnreadChat,
} from './types';

export interface AiBulkReplyPageProps {
  platform: BulkReplyPlatform;
  platformLabel: string;
  platformIcon: ReactNode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nearScrollEnd(target: HTMLElement, thresholdPx = 80): boolean {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= thresholdPx;
}

function formatWhen(
  platform: BulkReplyPlatform,
  value: string | null
): string {
  if (!value) return '';
  if (platform === 'maloum') {
    return formatMaloumRelativeTime(value) || '';
  }
  return formatFourBasedRelativeTime(value) || '';
}

function optionForId(
  suggestions: SuggestReplyOption[] | null,
  id: SuggestReplyId
): SuggestReplyOption | null {
  return suggestions?.find((s) => s.id === id) || null;
}

function makeReadyRow(
  chat: BulkUnreadChat,
  suggestions: SuggestReplyOption[]
): BulkReplyRow {
  const preferred =
    suggestions.find((s) => s.id === 'rapport') || suggestions[0];
  return {
    chatId: chat.chatId,
    fanId: chat.fanId,
    fanName: chat.fanName,
    lastMessagePreview: chat.lastMessagePreview,
    status: 'ready',
    error: null,
    suggestions,
    selectedId: preferred.id,
    english: preferred.english,
    german: preferred.german,
  };
}

export default function AiBulkReplyPage({
  platform,
  platformLabel,
  platformIcon,
}: AiBulkReplyPageProps) {
  const { user } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const { toast } = useToast();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [unreadChats, setUnreadChats] = useState<BulkUnreadChat[]>([]);
  const [unreadLoading, setUnreadLoading] = useState(false);
  const [unreadError, setUnreadError] = useState<string | null>(null);
  const [loadingMoreUnread, setLoadingMoreUnread] = useState(false);
  const [providerUserId, setProviderUserId] = useState<string | null>(null);

  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(
    () => new Set()
  );

  const [rows, setRows] = useState<BulkReplyRow[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);

  const loadingMoreUnreadRef = useRef(false);
  const unreadNextRef = useRef<string | null>(null);
  const unreadOffsetRef = useRef(0);
  const unreadHasMoreRef = useRef(false);
  const draftAbortRef = useRef(0);
  const sendAbortRef = useRef(0);
  const rowsRef = useRef<BulkReplyRow[]>([]);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const selectedCount = selectedChatIds.size;
  const readyCount = rows.filter((r) => r.status === 'ready').length;
  const draftingCount = rows.filter((r) => r.status === 'drafting').length;
  const sentCount = rows.filter((r) => r.status === 'sent').length;

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const filtered = list.filter((c) => c.platform === platform);
      setCreators(filtered);
      setSelectedCreatorId((prev) => prev || filtered[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, [platform]);

  const loadUnread = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);

      if (append) {
        if (loadingMoreUnreadRef.current) return;
        if (platform === 'maloum' && !unreadNextRef.current) return;
        if (platform === '4based' && !unreadHasMoreRef.current) return;
        loadingMoreUnreadRef.current = true;
        setLoadingMoreUnread(true);
      } else {
        setUnreadLoading(true);
        setUnreadError(null);
      }

      try {
        if (platform === 'maloum') {
          const result = await loadMaloumUnreadChats(selectedCreatorId, {
            limit: 40,
            next: append ? unreadNextRef.current : null,
          });
          setUnreadChats((prev) =>
            append ? [...prev, ...result.chats] : result.chats
          );
          unreadNextRef.current = result.next;
          unreadHasMoreRef.current = Boolean(result.next);
        } else {
          const offset = append ? unreadOffsetRef.current : 0;
          const result = await loadFourBasedUnreadChats(selectedCreatorId, {
            limit: 40,
            offset,
          });
          setUnreadChats((prev) =>
            append ? [...prev, ...result.chats] : result.chats
          );
          setProviderUserId(result.providerUserId);
          const nextOffset = offset + result.chats.length;
          unreadOffsetRef.current = nextOffset;
          unreadHasMoreRef.current = result.hasMore;
        }

        if (!append) {
          setSelectedChatIds(new Set());
          setRows([]);
        }
      } catch (err) {
        if (!append) {
          setUnreadError(
            err instanceof Error ? err.message : 'Failed to load unread chats'
          );
          setUnreadChats([]);
        }
      } finally {
        if (append) {
          loadingMoreUnreadRef.current = false;
          setLoadingMoreUnread(false);
        } else {
          setUnreadLoading(false);
        }
      }
    },
    [platform, selectedCreatorId]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    return onSyncEvent(() => {
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  useEffect(() => {
    setUnreadChats([]);
    unreadNextRef.current = null;
    unreadOffsetRef.current = 0;
    unreadHasMoreRef.current = false;
    setProviderUserId(null);
    setSelectedChatIds(new Set());
    setRows([]);
    setUnreadError(null);
    draftAbortRef.current += 1;
    sendAbortRef.current += 1;
    setDrafting(false);
    setSendingAll(false);
    if (selectedCreatorId) {
      void loadUnread();
    }
  }, [selectedCreatorId, loadUnread]);

  const handleUnreadScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!nearScrollEnd(event.currentTarget)) return;
      void loadUnread({ append: true });
    },
    [loadUnread]
  );

  const toggleChat = useCallback(
    (chatId: string) => {
      if (
        !selectedChatIds.has(chatId) &&
        selectedChatIds.size >= MAX_BULK_SELECTION
      ) {
        toast.error(`You can select at most ${MAX_BULK_SELECTION} chats`);
        return;
      }
      setSelectedChatIds((prev) => {
        const next = new Set(prev);
        if (next.has(chatId)) {
          next.delete(chatId);
        } else {
          next.add(chatId);
        }
        return next;
      });
    },
    [toast, selectedChatIds]
  );

  const selectVisibleUpToCap = useCallback(() => {
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      for (const chat of unreadChats) {
        if (next.size >= MAX_BULK_SELECTION) break;
        next.add(chat.chatId);
      }
      return next;
    });
  }, [unreadChats]);

  const clearSelection = useCallback(() => {
    setSelectedChatIds(new Set());
  }, []);

  const updateRow = useCallback(
    (chatId: string, patch: Partial<BulkReplyRow>) => {
      setRows((prev) =>
        prev.map((row) => (row.chatId === chatId ? { ...row, ...patch } : row))
      );
    },
    []
  );

  const draftOne = useCallback(
    async (chat: BulkUnreadChat): Promise<BulkReplyRow> => {
      if (!selectedCreatorId) {
        throw new Error('No creator selected');
      }
      try {
        const result =
          platform === 'maloum'
            ? await draftMaloumSuggestReply(selectedCreatorId, chat.chatId)
            : await draftFourBasedSuggestReply(
                selectedCreatorId,
                chat.chatId,
                chat.fanId,
                providerUserId
              );
        return makeReadyRow(chat, result.suggestions);
      } catch (err) {
        return {
          chatId: chat.chatId,
          fanId: chat.fanId,
          fanName: chat.fanName,
          lastMessagePreview: chat.lastMessagePreview,
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to draft reply',
          suggestions: null,
          selectedId: 'rapport',
          english: '',
          german: '',
        };
      }
    },
    [platform, selectedCreatorId, providerUserId]
  );

  const generateDrafts = useCallback(async () => {
    if (!selectedCreatorId || drafting || sendingAll) return;
    const selected = unreadChats.filter((c) => selectedChatIds.has(c.chatId));
    if (selected.length === 0) {
      toast.error('Select at least one unread chat');
      return;
    }
    if (selected.length > MAX_BULK_SELECTION) {
      toast.error(`Select at most ${MAX_BULK_SELECTION} chats`);
      return;
    }

    const runId = draftAbortRef.current + 1;
    draftAbortRef.current = runId;
    setDrafting(true);

    const initialRows: BulkReplyRow[] = selected.map((chat) => ({
      chatId: chat.chatId,
      fanId: chat.fanId,
      fanName: chat.fanName,
      lastMessagePreview: chat.lastMessagePreview,
      status: 'drafting',
      error: null,
      suggestions: null,
      selectedId: 'rapport',
      english: '',
      german: '',
    }));
    setRows(initialRows);

    await runWithConcurrency(selected, DRAFT_CONCURRENCY, async (chat) => {
      if (draftAbortRef.current !== runId) return;
      const drafted = await draftOne(chat);
      if (draftAbortRef.current !== runId) return;
      setRows((prev) =>
        prev.map((row) => (row.chatId === chat.chatId ? drafted : row))
      );
    });

    if (draftAbortRef.current === runId) {
      setDrafting(false);
    }
  }, [
    selectedCreatorId,
    drafting,
    sendingAll,
    unreadChats,
    selectedChatIds,
    toast,
    draftOne,
  ]);

  const redraftRow = useCallback(
    async (chatId: string) => {
      if (drafting || sendingAll) return;
      const chat = unreadChats.find((c) => c.chatId === chatId);
      if (!chat) return;
      updateRow(chatId, {
        status: 'drafting',
        error: null,
        suggestions: null,
        english: '',
        german: '',
      });
      const drafted = await draftOne(chat);
      updateRow(chatId, drafted);
    },
    [drafting, sendingAll, unreadChats, updateRow, draftOne]
  );

  const selectSuggestion = useCallback(
    (chatId: string, option: SuggestReplyOption) => {
      updateRow(chatId, {
        selectedId: option.id,
        english: option.english,
        german: option.german,
        status: 'ready',
        error: null,
      });
    },
    [updateRow]
  );

  const sendOne = useCallback(
    async (row: BulkReplyRow): Promise<boolean> => {
      if (!selectedCreator || !user) return false;
      const german = row.german.trim();
      if (!german) {
        updateRow(row.chatId, {
          status: 'error',
          error: 'Reply text is empty',
        });
        return false;
      }

      updateRow(row.chatId, { status: 'sending', error: null });
      try {
        if (platform === 'maloum') {
          await sendMaloumBulkReply({
            creator: selectedCreator,
            user,
            chatId: row.chatId,
            fanId: row.fanId,
            fanName: row.fanName,
            english: row.english,
            german,
          });
        } else {
          await sendFourBasedBulkReply({
            creator: selectedCreator,
            user,
            chatId: row.chatId,
            fanId: row.fanId,
            fanName: row.fanName,
            english: row.english,
            german,
          });
        }
        updateRow(row.chatId, { status: 'sent', error: null });
        setSelectedChatIds((prev) => {
          const next = new Set(prev);
          next.delete(row.chatId);
          return next;
        });
        return true;
      } catch (err) {
        updateRow(row.chatId, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to send',
        });
        return false;
      }
    },
    [selectedCreator, user, platform, updateRow]
  );

  const handleSendRow = useCallback(
    async (chatId: string) => {
      if (sendingAll) return;
      const row = rows.find((r) => r.chatId === chatId);
      if (!row || row.status === 'sending' || row.status === 'sent') return;
      const ok = await sendOne(row);
      if (ok) toast.success('Reply sent');
    },
    [sendingAll, rows, sendOne, toast]
  );

  const handleSkipRow = useCallback(
    (chatId: string) => {
      updateRow(chatId, { status: 'skipped', error: null });
      setSelectedChatIds((prev) => {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    },
    [updateRow]
  );

  const handleSendAllReady = useCallback(async () => {
    if (!selectedCreator || !user || drafting || sendingAll) return;
    const readyIds = rowsRef.current
      .filter((r) => r.status === 'ready' && r.german.trim())
      .map((r) => r.chatId);
    if (readyIds.length === 0) {
      toast.error('No ready replies to send');
      return;
    }

    const runId = sendAbortRef.current + 1;
    sendAbortRef.current = runId;
    setSendingAll(true);

    let success = 0;
    let failed = 0;
    for (const chatId of readyIds) {
      if (sendAbortRef.current !== runId) break;
      const current = rowsRef.current.find((r) => r.chatId === chatId);
      if (!current || current.status !== 'ready' || !current.german.trim()) {
        continue;
      }
      const ok = await sendOne(current);
      if (ok) success += 1;
      else failed += 1;
      await sleep(SEND_DELAY_MS);
    }

    if (sendAbortRef.current === runId) {
      setSendingAll(false);
      if (success > 0 && failed === 0) {
        toast.success(
          `Sent ${success} ${success === 1 ? 'reply' : 'replies'}`
        );
      } else if (success > 0) {
        toast.error(`Sent ${success}, failed ${failed}`);
      } else {
        toast.error('Failed to send replies');
      }
    }
  }, [selectedCreator, user, drafting, sendingAll, sendOne, toast]);

  // Drop sent chats from the unread list once marked sent.
  useEffect(() => {
    const sentIds = new Set(
      rows.filter((r) => r.status === 'sent').map((r) => r.chatId)
    );
    if (sentIds.size === 0) return;
    setUnreadChats((prev) => {
      const filtered = prev.filter((c) => !sentIds.has(c.chatId));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [rows]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          {platformIcon}
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            AI Bulk Reply
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              Loading creators…
            </p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              No {platformLabel} creators yet. Connect one from Manage Creators.
            </p>
          )}
          {creators.map((creator) => {
            const active = selectedCreatorId === creator.id;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
                  active
                    ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={creator.avatarUrl}
                  displayName={creator.displayName}
                  className="w-10 h-10 rounded-full object-cover shrink-0"
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-orange-400 to-rose-500"
                />
                <span
                  className={`text-sm truncate ${
                    active
                      ? 'font-semibold text-gray-900 dark:text-white'
                      : 'font-medium text-gray-700 dark:text-zinc-300'
                  }`}
                >
                  {creator.displayName}
                </span>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-4">
          <p className="text-[11px] text-gray-500 dark:text-zinc-500 leading-relaxed">
            Select unread chats, draft AI replies, review, then send. Max{' '}
            {MAX_BULK_SELECTION} per run.
          </p>
        </div>
      </aside>

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!selectedCreatorId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            Select a creator
          </div>
        ) : (
          <>
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                  <Sparkles className="w-4 h-4 text-domx-400" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — AI Bulk Reply
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Managers and above only · Review before send
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadUnread()}
                disabled={unreadLoading || drafting || sendingAll}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                title="Refresh unread"
              >
                <RefreshCw
                  className={`w-4 h-4 ${unreadLoading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>

            <div className="flex-1 min-h-0 flex">
              {/* Unread selection */}
              <section className="w-[min(22rem,40%)] border-r border-gray-200 dark:border-zinc-800/60 flex flex-col min-h-0 shrink-0">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-2 shrink-0">
                  <div>
                    <p className="text-xs font-semibold text-gray-900 dark:text-white">
                      Unread chats
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                      {selectedCount}/{MAX_BULK_SELECTION} selected
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={selectVisibleUpToCap}
                      disabled={unreadChats.length === 0 || drafting || sendingAll}
                      className="px-2 py-1 text-[11px] rounded-md text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={clearSelection}
                      disabled={selectedCount === 0 || drafting || sendingAll}
                      className="px-2 py-1 text-[11px] rounded-md text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div
                  className="flex-1 min-h-0 overflow-y-auto"
                  onScroll={handleUnreadScroll}
                >
                  {unreadLoading && unreadChats.length === 0 && (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                    </div>
                  )}
                  {unreadError && (
                    <p className="text-sm text-red-400 px-4 py-6">{unreadError}</p>
                  )}
                  {!unreadLoading && !unreadError && unreadChats.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-zinc-500 text-center px-4 py-12">
                      No unread chats.
                    </p>
                  )}
                  <ul className="divide-y divide-gray-100 dark:divide-zinc-800/80">
                    {unreadChats.map((chat) => {
                      const checked = selectedChatIds.has(chat.chatId);
                      const atCap =
                        !checked && selectedCount >= MAX_BULK_SELECTION;
                      const when = formatWhen(platform, chat.lastMessageAt);
                      return (
                        <li key={chat.chatId}>
                          <label
                            className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                              checked
                                ? 'bg-domx-600/5 dark:bg-domx-500/10'
                                : atCap
                                  ? 'opacity-50 cursor-not-allowed'
                                  : 'hover:bg-gray-50 dark:hover:bg-zinc-900/50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={atCap || drafting || sendingAll}
                              onChange={() => toggleChat(chat.chatId)}
                              className="mt-1 rounded border-gray-300 dark:border-zinc-600"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                                  {chat.fanName}
                                </p>
                                {when && (
                                  <span className="text-[10px] text-gray-400 dark:text-zinc-500 shrink-0">
                                    {when}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 dark:text-zinc-500 line-clamp-2 mt-0.5">
                                {chat.lastMessagePreview || (
                                  <span className="italic">No preview</span>
                                )}
                              </p>
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {loadingMoreUnread && (
                    <div className="flex justify-center py-3">
                      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-3">
                  <button
                    type="button"
                    onClick={() => void generateDrafts()}
                    disabled={
                      selectedCount === 0 || drafting || sendingAll || !user
                    }
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-domx-600 hover:bg-domx-500 text-white text-sm font-medium disabled:opacity-40 transition-colors"
                  >
                    {drafting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Drafting {draftingCount > 0 ? `(${draftingCount})` : '…'}
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        Generate drafts ({selectedCount})
                      </>
                    )}
                  </button>
                </div>
              </section>

              {/* Review queue */}
              <section className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="px-4 md:px-6 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0">
                  <div>
                    <p className="text-xs font-semibold text-gray-900 dark:text-white">
                      Review queue
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                      {readyCount} ready
                      {sentCount > 0 ? ` · ${sentCount} sent` : ''}
                      {draftingCount > 0 ? ` · ${draftingCount} drafting` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSendAllReady()}
                    disabled={readyCount === 0 || drafting || sendingAll || !user}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-domx-600 hover:bg-domx-500 text-white text-xs font-medium disabled:opacity-40 transition-colors"
                  >
                    {sendingAll ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Send all ready
                  </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 space-y-3">
                  {rows.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-16">
                      Select unread chats and generate drafts to review replies
                      here.
                    </p>
                  )}

                  {rows.map((row) => {
                    const rapport = optionForId(row.suggestions, 'rapport');
                    const upsell = optionForId(row.suggestions, 'upsell');
                    const busy =
                      row.status === 'drafting' ||
                      row.status === 'sending' ||
                      drafting ||
                      sendingAll;
                    const canSend =
                      (row.status === 'ready' || row.status === 'error') &&
                      row.german.trim() &&
                      !busy;

                    return (
                      <article
                        key={row.chatId}
                        className={`rounded-2xl border p-4 ${
                          row.status === 'sent'
                            ? 'border-emerald-500/30 bg-emerald-500/5 opacity-80'
                            : row.status === 'skipped'
                              ? 'border-gray-200 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-900/40 opacity-60'
                              : row.status === 'error'
                                ? 'border-red-400/40 bg-red-500/5'
                                : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                              {row.fanName}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-zinc-500 line-clamp-2 mt-0.5">
                              {row.lastMessagePreview || (
                                <span className="italic">No preview</span>
                              )}
                            </p>
                          </div>
                          <StatusBadge status={row.status} />
                        </div>

                        {row.status === 'drafting' && (
                          <div className="flex items-center gap-2 py-6 text-sm text-gray-500 dark:text-zinc-400 justify-center">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Drafting replies…
                          </div>
                        )}

                        {row.status !== 'drafting' && row.suggestions && (
                          <div className="flex flex-wrap gap-2 mb-3">
                            {rapport && (
                              <SuggestionChip
                                option={rapport}
                                active={row.selectedId === 'rapport'}
                                disabled={
                                  busy ||
                                  row.status === 'sent' ||
                                  row.status === 'skipped'
                                }
                                onSelect={() =>
                                  selectSuggestion(row.chatId, rapport)
                                }
                              />
                            )}
                            {upsell && (
                              <SuggestionChip
                                option={upsell}
                                active={row.selectedId === 'upsell'}
                                disabled={
                                  busy ||
                                  row.status === 'sent' ||
                                  row.status === 'skipped'
                                }
                                onSelect={() =>
                                  selectSuggestion(row.chatId, upsell)
                                }
                              />
                            )}
                          </div>
                        )}

                        {row.status !== 'drafting' &&
                          row.status !== 'skipped' &&
                          (row.suggestions || row.german || row.error) && (
                            <>
                              {row.english && (
                                <p className="text-[11px] text-gray-500 dark:text-zinc-400 mb-2 leading-relaxed">
                                  EN: {row.english}
                                </p>
                              )}
                              <textarea
                                value={row.german}
                                onChange={(e) =>
                                  updateRow(row.chatId, {
                                    german: e.target.value,
                                    status:
                                      row.status === 'sent'
                                        ? 'sent'
                                        : 'ready',
                                    error: null,
                                  })
                                }
                                disabled={
                                  row.status === 'sent' ||
                                  row.status === 'sending' ||
                                  sendingAll
                                }
                                rows={3}
                                placeholder="German reply…"
                                className="w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-gray-900 dark:text-zinc-100 resize-y min-h-[4.5rem] focus:outline-none focus:ring-2 focus:ring-domx-500/40 disabled:opacity-60"
                              />
                            </>
                          )}

                        {row.error && (
                          <p className="text-xs text-red-400 mt-2">{row.error}</p>
                        )}

                        {row.status !== 'sent' &&
                          row.status !== 'skipped' &&
                          row.status !== 'drafting' && (
                            <div className="flex flex-wrap items-center gap-2 mt-3">
                              <button
                                type="button"
                                onClick={() => void handleSendRow(row.chatId)}
                                disabled={!canSend || !user}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-domx-600 hover:bg-domx-500 text-white text-xs font-medium disabled:opacity-40"
                              >
                                {row.status === 'sending' ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Send className="w-3.5 h-3.5" />
                                )}
                                Send
                              </button>
                              <button
                                type="button"
                                onClick={() => void redraftRow(row.chatId)}
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-zinc-700 text-xs font-medium text-gray-700 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-40"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Redraft
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSkipRow(row.chatId)}
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-40"
                              >
                                <X className="w-3.5 h-3.5" />
                                Skip
                              </button>
                            </div>
                          )}

                        {row.status === 'sent' && (
                          <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 inline-flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            Sent
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: BulkReplyRow['status'] }) {
  const label: Record<BulkReplyRow['status'], string> = {
    idle: 'Idle',
    drafting: 'Drafting',
    ready: 'Ready',
    sending: 'Sending',
    sent: 'Sent',
    skipped: 'Skipped',
    error: 'Error',
  };
  const color: Record<BulkReplyRow['status'], string> = {
    idle: 'bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400',
    drafting: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    ready: 'bg-domx-600/15 text-domx-600 dark:text-domx-400',
    sending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    sent: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    skipped: 'bg-gray-100 text-gray-500 dark:bg-zinc-800 dark:text-zinc-500',
    error: 'bg-red-500/15 text-red-500',
  };
  return (
    <span
      className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${color[status]}`}
    >
      {label[status]}
    </span>
  );
}

function SuggestionChip({
  option,
  active,
  disabled,
  onSelect,
}: {
  option: SuggestReplyOption;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 ${
        active
          ? 'border-domx-500/50 bg-domx-600/15 text-domx-700 dark:text-domx-300'
          : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800'
      }`}
      title={option.english}
    >
      {option.label}
      <span className="ml-1 text-[10px] opacity-70">
        {option.id === 'rapport' ? 'Tame' : 'Aggressive'}
      </span>
    </button>
  );
}
