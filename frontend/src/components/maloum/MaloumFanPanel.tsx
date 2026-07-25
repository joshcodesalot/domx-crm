import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Check,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Unlock,
  X,
} from 'lucide-react';
import {
  getMaloumFanAssignedLists,
  getMaloumFanStats,
  listMaloumChatLists,
  setMaloumFanAssignedLists,
  updateMaloumFanNickname,
  updateMaloumFanNotes,
  type MaloumChat,
  type MaloumChatListItem,
  type MaloumChatPartner,
  type MaloumFanStats,
} from '@/lib/api';

const NOTES_DEBOUNCE_MS = 3500;

function partnerName(chat: MaloumChat | null | undefined): string {
  if (!chat?.chatPartner) return 'Fan';
  return (
    chat.chatPartner.nickname ||
    chat.chatPartner.username ||
    chat.chatPartner._id ||
    'Fan'
  );
}

function partnerId(chat: MaloumChat | null | undefined): string | null {
  return chat?.chatPartner?._id ? String(chat.chatPartner._id) : null;
}

function formatRelativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatEuro(amount?: number | null): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount}€`;
  }
}

function FanAvatar({
  partner,
  name,
}: {
  partner?: MaloumChatPartner | null;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const avatarUrl =
    partner?.profilePictureThumbnail?.url || partner?.profilePicture?.url;
  const httpsUrl =
    typeof avatarUrl === 'string' && avatarUrl.startsWith('https://')
      ? avatarUrl
      : null;
  const initial = (name || '?').charAt(0).toUpperCase();

  if (httpsUrl && !failed) {
    return (
      <img
        src={httpsUrl}
        alt=""
        className="w-12 h-12 rounded-full object-cover border border-gray-300 dark:border-zinc-700 shrink-0 bg-gray-100 dark:bg-zinc-800"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-sm font-medium border border-gray-300 dark:border-zinc-700 shrink-0 text-gray-700 dark:text-zinc-300">
      {initial}
    </div>
  );
}

export const DEFAULT_FAN_NOTES_TEMPLATE = `🖤 Fetishes / Kinks:
🎓 Experience Level:
🚫 Hard Limits:
🧸 Toys Owned:
💎 VIP Status:
⛓️ Ongoing Sessions / Tasks:
✅ Progress / Completed:
🤍 Aftercare Needs:
📝 Last Session Notes:
🎂 Age:
📍 Location:
💍 Relationship Status:`;

type TabId = 'faninfo' | 'ppvs';

type MaloumFanPanelProps = {
  creatorId: string;
  chatId: string;
  chat: MaloumChat | null;
  onChatUpdated?: (chat: MaloumChat) => void;
  className?: string;
  onClose?: () => void;
};

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
      {children}
    </h3>
  );
}

export default function MaloumFanPanel({
  creatorId,
  chatId,
  chat,
  onChatUpdated,
  className = '',
  onClose,
}: MaloumFanPanelProps) {
  const [tab, setTab] = useState<TabId>('faninfo');
  const fanId = partnerId(chat);
  const displayName = partnerName(chat);
  const username = chat?.chatPartner?.username || 'fan';
  const ltv = chat?.chatPartner?.totalSpendForCreator;
  const remoteNickname = chat?.chatPartner?.nickname || '';
  const remoteNotes =
    typeof chat?.chatPartner?.notes === 'string' ? chat.chatPartner.notes : '';

  const [nicknameDraft, setNicknameDraft] = useState(remoteNickname);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);

  const [notesDraft, setNotesDraft] = useState(() =>
    remoteNotes.trim() ? remoteNotes : DEFAULT_FAN_NOTES_TEMPLATE
  );
  const [notesStatus, setNotesStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesSavedBaselineRef = useRef(remoteNotes);
  const notesTimerRef = useRef<number | null>(null);
  const notesDraftRef = useRef(notesDraft);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const [assignedLists, setAssignedLists] = useState<MaloumChatListItem[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [allLists, setAllLists] = useState<MaloumChatListItem[]>([]);
  const [allListsNext, setAllListsNext] = useState<string | null>(null);
  const [allListsLoading, setAllListsLoading] = useState(false);
  const [listMutating, setListMutating] = useState(false);

  const [stats, setStats] = useState<MaloumFanStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    notesDraftRef.current = notesDraft;
  }, [notesDraft]);

  // Reset local state when switching chats
  useEffect(() => {
    setTab('faninfo');
    setEditingNickname(false);
    setNicknameDraft(remoteNickname);
    setNicknameError(null);
    const nextNotes = remoteNotes.trim() ? remoteNotes : DEFAULT_FAN_NOTES_TEMPLATE;
    setNotesDraft(nextNotes);
    notesSavedBaselineRef.current = remoteNotes;
    setNotesStatus('idle');
    setNotesError(null);
    setListPickerOpen(false);
    setAllLists([]);
    setAllListsNext(null);
    if (notesTimerRef.current != null) {
      window.clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync nickname/notes from chat when remote updates (and not mid-edit)
  useEffect(() => {
    if (!editingNickname) {
      setNicknameDraft(remoteNickname);
    }
  }, [remoteNickname, editingNickname]);

  useEffect(() => {
    if (notesStatus === 'dirty' || notesStatus === 'saving') return;
    if (remoteNotes.trim()) {
      setNotesDraft(remoteNotes);
      notesSavedBaselineRef.current = remoteNotes;
    } else if (!notesDraftRef.current.trim() || notesDraftRef.current === DEFAULT_FAN_NOTES_TEMPLATE) {
      setNotesDraft(DEFAULT_FAN_NOTES_TEMPLATE);
      notesSavedBaselineRef.current = '';
    }
  }, [remoteNotes, notesStatus]);

  const loadAssignedLists = useCallback(async () => {
    if (!fanId) {
      setAssignedLists([]);
      return;
    }
    setListsLoading(true);
    setListsError(null);
    try {
      const result = await getMaloumFanAssignedLists(creatorId, fanId);
      setAssignedLists(result.lists || []);
    } catch (err) {
      setListsError(err instanceof Error ? err.message : 'Failed to load lists');
    } finally {
      setListsLoading(false);
    }
  }, [creatorId, fanId]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const result = await getMaloumFanStats({
        creatorId,
        chatId,
        fanId: fanId || undefined,
      });
      setStats(result);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load PPV stats');
    } finally {
      setStatsLoading(false);
    }
  }, [creatorId, chatId, fanId]);

  useEffect(() => {
    void loadAssignedLists();
    void loadStats();
  }, [loadAssignedLists, loadStats]);

  const saveNotes = useCallback(
    async (value: string) => {
      const targetChatId = chatId;
      const next = value;
      if (next === notesSavedBaselineRef.current) {
        setNotesStatus('idle');
        return;
      }
      // Don't persist the untouched template preload
      if (!notesSavedBaselineRef.current.trim() && next === DEFAULT_FAN_NOTES_TEMPLATE) {
        setNotesStatus('idle');
        return;
      }
      setNotesStatus('saving');
      setNotesError(null);
      try {
        const result = await updateMaloumFanNotes(creatorId, targetChatId, next);
        if (chatIdRef.current !== targetChatId) return;
        notesSavedBaselineRef.current = next;
        if (result.chat) onChatUpdated?.(result.chat);
        setNotesStatus('saved');
        window.setTimeout(() => {
          setNotesStatus((s) => (s === 'saved' ? 'idle' : s));
        }, 1500);
      } catch (err) {
        if (chatIdRef.current !== targetChatId) return;
        setNotesError(err instanceof Error ? err.message : 'Failed to save notes');
        setNotesStatus('error');
      }
    },
    [creatorId, chatId, onChatUpdated]
  );

  const scheduleNotesSave = useCallback(
    (value: string) => {
      if (notesTimerRef.current != null) {
        window.clearTimeout(notesTimerRef.current);
      }
      setNotesStatus('dirty');
      notesTimerRef.current = window.setTimeout(() => {
        notesTimerRef.current = null;
        void saveNotes(value);
      }, NOTES_DEBOUNCE_MS);
    },
    [saveNotes]
  );

  useEffect(() => {
    return () => {
      if (notesTimerRef.current != null) {
        window.clearTimeout(notesTimerRef.current);
      }
    };
  }, []);

  const handleNicknameSave = useCallback(async () => {
    const next = nicknameDraft.trim();
    if (next === (remoteNickname || '').trim()) {
      setEditingNickname(false);
      return;
    }
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const result = await updateMaloumFanNickname(creatorId, chatId, next);
      if (result.chat) onChatUpdated?.(result.chat);
      setEditingNickname(false);
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : 'Failed to save nickname');
    } finally {
      setNicknameSaving(false);
    }
  }, [nicknameDraft, remoteNickname, creatorId, chatId, onChatUpdated]);

  const loadAllLists = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      setAllListsLoading(true);
      try {
        const result = await listMaloumChatLists(creatorId, {
          limit: 25,
          next: opts?.next || undefined,
        });
        const nextLists = (result.lists || []).filter((l) => !l.isManaged);
        setAllLists((prev) => {
          if (!opts?.append) return nextLists;
          const seen = new Set(prev.map((l) => l._id));
          return [...prev, ...nextLists.filter((l) => !seen.has(l._id))];
        });
        setAllListsNext(result.next || null);
      } catch (err) {
        setListsError(err instanceof Error ? err.message : 'Failed to load lists');
      } finally {
        setAllListsLoading(false);
      }
    },
    [creatorId]
  );

  const openListPicker = useCallback(() => {
    setListPickerOpen(true);
    if (allLists.length === 0) {
      void loadAllLists();
    }
  }, [allLists.length, loadAllLists]);

  const assignedIds = useMemo(
    () => new Set(assignedLists.map((l) => l._id)),
    [assignedLists]
  );

  const updateAssigned = useCallback(
    async (nextIds: string[]) => {
      if (!fanId) return;
      setListMutating(true);
      setListsError(null);
      try {
        const result = await setMaloumFanAssignedLists(creatorId, fanId, nextIds);
        setAssignedLists(result.lists || []);
      } catch (err) {
        setListsError(err instanceof Error ? err.message : 'Failed to update lists');
      } finally {
        setListMutating(false);
      }
    },
    [creatorId, fanId]
  );

  const addToList = useCallback(
    (listId: string) => {
      if (assignedIds.has(listId)) return;
      void updateAssigned([...assignedIds, listId]);
    },
    [assignedIds, updateAssigned]
  );

  const removeFromList = useCallback(
    (listId: string) => {
      void updateAssigned([...assignedIds].filter((id) => id !== listId));
    },
    [assignedIds, updateAssigned]
  );

  const availableLists = useMemo(
    () => allLists.filter((l) => !assignedIds.has(l._id)),
    [allLists, assignedIds]
  );

  const ltvLabel = formatEuro(typeof ltv === 'number' ? ltv : 0);

  return (
    <aside
      className={`flex flex-col h-full min-h-0 border-l border-gray-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-950 ${className}`}
    >
      <div className="h-12 px-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-1 shrink-0">
        {(
          [
            { id: 'faninfo' as const, label: 'Fan Info' },
            { id: 'ppvs' as const, label: 'PPVs' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors relative ${
              tab === t.id
                ? 'text-gray-900 dark:text-white'
                : 'text-gray-500 dark:text-zinc-500 hover:text-gray-800 dark:hover:text-zinc-300'
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-orange-500" />
            )}
          </button>
        ))}
        <div className="flex-1" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
            title="Close panel"
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Shared header */}
        <div className="px-4 pt-4 pb-3 flex items-start gap-3 border-b border-gray-200 dark:border-zinc-800/60">
          <FanAvatar partner={chat?.chatPartner} name={displayName} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                {displayName}
              </p>
              <span className="text-sm font-bold text-emerald-400 shrink-0">{ltvLabel}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">@{username}</p>
          </div>
        </div>

        {tab === 'faninfo' && (
          <div className="px-4 py-4 space-y-5">
            <section>
              <SectionHeading>Nickname</SectionHeading>
              {editingNickname ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={nicknameDraft}
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleNicknameSave();
                      }
                      if (e.key === 'Escape') {
                        setNicknameDraft(remoteNickname);
                        setEditingNickname(false);
                      }
                    }}
                    autoFocus
                    placeholder="Nickname"
                    className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white outline-none focus:border-orange-500/60"
                    disabled={nicknameSaving}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleNicknameSave()}
                      disabled={nicknameSaving}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-50"
                    >
                      {nicknameSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNicknameDraft(remoteNickname);
                        setEditingNickname(false);
                      }}
                      disabled={nicknameSaving}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingNickname(true)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-left hover:border-gray-300 dark:hover:border-zinc-700"
                >
                  <span
                    className={`text-sm truncate ${
                      remoteNickname
                        ? 'text-gray-900 dark:text-white'
                        : 'text-gray-400 dark:text-zinc-500'
                    }`}
                  >
                    {remoteNickname || 'Add nickname…'}
                  </span>
                  <Pencil className="w-3.5 h-3.5 text-gray-400 dark:text-zinc-500 shrink-0" />
                </button>
              )}
              {nicknameError && (
                <p className="mt-1.5 text-[11px] text-red-400">{nicknameError}</p>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-2">
                <SectionHeading>Notes</SectionHeading>
                <span className="text-[10px] text-gray-400 dark:text-zinc-500">
                  {notesStatus === 'saving' && 'Saving…'}
                  {notesStatus === 'saved' && (
                    <span className="inline-flex items-center gap-0.5 text-emerald-400">
                      <Check className="w-3 h-3" /> Saved
                    </span>
                  )}
                  {notesStatus === 'dirty' && 'Unsaved'}
                  {notesStatus === 'error' && 'Error'}
                </span>
              </div>
              <textarea
                value={notesDraft}
                onChange={(e) => {
                  const value = e.target.value;
                  setNotesDraft(value);
                  scheduleNotesSave(value);
                }}
                onBlur={() => {
                  if (notesTimerRef.current != null) {
                    window.clearTimeout(notesTimerRef.current);
                    notesTimerRef.current = null;
                  }
                  void saveNotes(notesDraft);
                }}
                rows={14}
                spellCheck={false}
                className="w-full px-3 py-2.5 text-xs leading-relaxed rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-zinc-200 outline-none focus:border-orange-500/60 resize-y min-h-[200px] font-mono"
                placeholder="Notes about this fan…"
              />
              {notesError && (
                <p className="mt-1.5 text-[11px] text-red-400">{notesError}</p>
              )}
            </section>

            <section>
              <SectionHeading>Lists</SectionHeading>
              {listsLoading && assignedLists.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-zinc-500 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {assignedLists.map((list) => (
                      <span
                        key={list._id}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-gray-100 dark:bg-zinc-800 text-gray-800 dark:text-zinc-200 border border-gray-200 dark:border-zinc-700"
                      >
                        {list.name || 'List'}
                        <button
                          type="button"
                          disabled={listMutating}
                          onClick={() => removeFromList(list._id)}
                          className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-500 dark:text-zinc-400"
                          title="Remove from list"
                          aria-label={`Remove from ${list.name || 'list'}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={openListPicker}
                      disabled={!fanId || listMutating}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border border-dashed border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 hover:border-orange-500/50 hover:text-orange-500 disabled:opacity-50"
                    >
                      <Plus className="w-3 h-3" /> List
                    </button>
                  </div>

                  {listPickerOpen && (
                    <div className="rounded-lg border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 overflow-hidden">
                      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-gray-200 dark:border-zinc-800">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
                          Add to list
                        </span>
                        <button
                          type="button"
                          onClick={() => setListPickerOpen(false)}
                          className="p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200"
                          aria-label="Close list picker"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {availableLists.length === 0 && !allListsLoading && (
                          <p className="px-2.5 py-3 text-xs text-gray-500 dark:text-zinc-500">
                            No more lists available.
                          </p>
                        )}
                        {availableLists.map((list) => (
                          <button
                            key={list._id}
                            type="button"
                            disabled={listMutating}
                            onClick={() => addToList(list._id)}
                            className="w-full text-left px-2.5 py-2 text-xs text-gray-800 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50 flex items-center justify-between gap-2"
                          >
                            <span className="truncate">{list.name || 'List'}</span>
                            {typeof list.totalMemberCount === 'number' && (
                              <span className="text-[10px] text-gray-400 dark:text-zinc-500 shrink-0">
                                {list.totalMemberCount}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      {(allListsNext || allListsLoading) && (
                        <button
                          type="button"
                          disabled={allListsLoading || !allListsNext}
                          onClick={() => void loadAllLists({ append: true, next: allListsNext })}
                          className="w-full px-2.5 py-2 text-[11px] font-medium text-orange-500 hover:bg-gray-100 dark:hover:bg-zinc-800 border-t border-gray-200 dark:border-zinc-800 disabled:opacity-50"
                        >
                          {allListsLoading ? 'Loading…' : 'Load more'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {listsError && (
                <p className="mt-1.5 text-[11px] text-red-400">{listsError}</p>
              )}
            </section>
          </div>
        )}

        {tab === 'ppvs' && (
          <div className="px-4 py-4 space-y-5">
            {statsLoading && !stats ? (
              <p className="text-xs text-gray-500 dark:text-zinc-500 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </p>
            ) : statsError ? (
              <p className="text-xs text-red-400">{statsError}</p>
            ) : (
              <>
                <section>
                  <SectionHeading>Purchase Rate</SectionHeading>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-zinc-500">Rate</span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {stats?.ppv.unlocked ?? 0}/{stats?.ppv.sent ?? 0} (
                        {stats?.ppv.ratePercent ?? 0}%)
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-zinc-500">
                        Highest price
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {stats?.ppv.highestPrice != null
                          ? formatEuro(stats.ppv.highestPrice)
                          : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-zinc-500">
                        Lowest price
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {stats?.ppv.lowestPrice != null
                          ? formatEuro(stats.ppv.lowestPrice)
                          : '—'}
                      </span>
                    </div>
                  </div>
                </section>

                <section>
                  <SectionHeading>PPV Media</SectionHeading>
                  {!stats?.ppvEntries?.length ? (
                    <p className="text-xs text-gray-500 dark:text-zinc-500">No PPVs sent.</p>
                  ) : (
                    <ul className="space-y-2">
                      {stats.ppvEntries.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-start justify-between gap-2 px-2.5 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {entry.purchased ? (
                                <Unlock className="w-3 h-3 text-emerald-400 shrink-0" />
                              ) : (
                                <Lock className="w-3 h-3 text-gray-400 dark:text-zinc-500 shrink-0" />
                              )}
                              <span
                                className={`text-sm font-semibold ${
                                  entry.purchased
                                    ? 'text-emerald-400'
                                    : 'text-gray-900 dark:text-white'
                                }`}
                              >
                                {formatEuro(entry.priceNet)}
                              </span>
                            </div>
                            <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-0.5">
                              {[
                                entry.pictureCount > 0
                                  ? `${entry.pictureCount} pic${entry.pictureCount === 1 ? '' : 's'}`
                                  : null,
                                entry.videoCount > 0
                                  ? `${entry.videoCount} video${entry.videoCount === 1 ? '' : 's'}`
                                  : null,
                                !entry.pictureCount && !entry.videoCount && entry.mediaCount > 0
                                  ? `${entry.mediaCount} media`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ') || 'Media'}
                              {entry.sentAt
                                ? ` · ${formatRelativeTime(entry.sentAt) || ''}`
                                : ''}
                            </p>
                          </div>
                          <span
                            className={`text-[10px] font-bold uppercase shrink-0 ${
                              entry.purchased
                                ? 'text-emerald-400'
                                : 'text-gray-400 dark:text-zinc-500'
                            }`}
                          >
                            {entry.purchased ? 'Unlocked' : 'Locked'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <SectionHeading>Tips</SectionHeading>
                  {!stats?.tips?.length ? (
                    <p className="text-xs text-gray-500 dark:text-zinc-500">No tips.</p>
                  ) : (
                    <ul className="space-y-2">
                      {stats.tips.map((tip) => (
                        <li
                          key={tip.id}
                          className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800"
                        >
                          <span className="text-sm font-semibold text-emerald-400">
                            {formatEuro(tip.priceNet)}
                          </span>
                          <span className="text-[10px] text-gray-500 dark:text-zinc-500">
                            {formatRelativeTime(tip.sentAt) || ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
