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
  Pin,
  Plus,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import {
  addFourBasedFanToList,
  deleteFourBasedPivotField,
  getFourBasedFanLists,
  getFourBasedFanStats,
  getFourBasedPivot,
  listFourBasedUserLists,
  pinFourBasedChat,
  removeFourBasedFanFromList,
  updateFourBasedPivot,
  type FourBasedChat,
  type FourBasedUserList,
  type FourBasedUserProfile,
  type MaloumFanStats,
} from '@/lib/api';

const NOTES_DEBOUNCE_MS = 3500;
const COINS_PER_DOLLAR = 121;

function formatLtv(salesVolumeCoins?: number): string | null {
  if (typeof salesVolumeCoins !== 'number' || salesVolumeCoins === 0) return null;
  const dollars = salesVolumeCoins / COINS_PER_DOLLAR;
  const rounded =
    Math.abs(dollars) >= 100
      ? dollars.toFixed(0)
      : dollars.toFixed(2).replace(/\.?0+$/, '');
  return `$${rounded}`;
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

type FourBasedFanPanelProps = {
  creatorId: string;
  chatId: string;
  chat: FourBasedChat | null;
  fanId: string | null;
  fanName: string;
  fanUsername?: string | null;
  fanAvatarUrl?: string | null;
  fanProfile?: FourBasedUserProfile | null;
  onChatUpdated?: (patch: Partial<FourBasedChat>) => void;
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

function formatUsd(amount?: number | null): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function FanAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl?: string | null;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
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

export default function FourBasedFanPanel({
  creatorId,
  chatId,
  chat,
  fanId,
  fanName,
  fanUsername,
  fanAvatarUrl,
  fanProfile,
  onChatUpdated,
  className = '',
  onClose,
}: FourBasedFanPanelProps) {
  const [tab, setTab] = useState<TabId>('faninfo');
  const username = fanUsername || fanProfile?.name || fanName || 'fan';
  const ltv = formatLtv(chat?.sales_volume);
  const isPinned = Boolean(chat?.is_pinned);

  const [alias, setAlias] = useState('');
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);

  const [remoteNotes, setRemoteNotes] = useState('');
  const [notesDraft, setNotesDraft] = useState(DEFAULT_FAN_NOTES_TEMPLATE);
  const [notesStatus, setNotesStatus] = useState<
    'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  >('idle');
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesSavedBaselineRef = useRef('');
  const notesTimerRef = useRef<number | null>(null);
  const notesDraftRef = useRef(notesDraft);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const [allLists, setAllLists] = useState<FourBasedUserList[]>([]);
  const [assignedListIds, setAssignedListIds] = useState<string[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [listMutating, setListMutating] = useState(false);

  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const [stats, setStats] = useState<MaloumFanStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [pivotLoading, setPivotLoading] = useState(false);

  useEffect(() => {
    notesDraftRef.current = notesDraft;
  }, [notesDraft]);

  useEffect(() => {
    setTab('faninfo');
    setEditingNickname(false);
    setNicknameError(null);
    setNotesStatus('idle');
    setNotesError(null);
    setListPickerOpen(false);
    setPinError(null);
    if (notesTimerRef.current != null) {
      window.clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
  }, [chatId, fanId]);

  const loadPivot = useCallback(async () => {
    if (!fanId) {
      setAlias('');
      setNicknameDraft('');
      setRemoteNotes('');
      setNotesDraft(DEFAULT_FAN_NOTES_TEMPLATE);
      notesSavedBaselineRef.current = '';
      return;
    }
    setPivotLoading(true);
    try {
      const result = await getFourBasedPivot(creatorId, fanId);
      const nextAlias = result.alias || '';
      const nextNotes = result.note || '';
      setAlias(nextAlias);
      setNicknameDraft(nextAlias);
      setRemoteNotes(nextNotes);
      notesSavedBaselineRef.current = nextNotes;
      setNotesDraft(nextNotes.trim() ? nextNotes : DEFAULT_FAN_NOTES_TEMPLATE);
    } catch {
      // leave local state
    } finally {
      setPivotLoading(false);
    }
  }, [creatorId, fanId]);

  const loadLists = useCallback(async () => {
    if (!fanId) {
      setAllLists([]);
      setAssignedListIds([]);
      return;
    }
    setListsLoading(true);
    setListsError(null);
    try {
      const [listsResult, assignedResult] = await Promise.all([
        listFourBasedUserLists(creatorId, { limit: 50 }),
        getFourBasedFanLists(creatorId, fanId),
      ]);
      setAllLists(Array.isArray(listsResult.lists) ? listsResult.lists : []);
      setAssignedListIds(
        Array.isArray(assignedResult.userListIds)
          ? assignedResult.userListIds
          : []
      );
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
      const result = await getFourBasedFanStats({
        creatorId,
        chatId,
        fanId: fanId || undefined,
      });
      setStats(result);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load stats');
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [creatorId, chatId, fanId]);

  useEffect(() => {
    void loadPivot();
    void loadLists();
    void loadStats();
  }, [loadPivot, loadLists, loadStats]);

  useEffect(() => {
    if (!editingNickname) {
      setNicknameDraft(alias);
    }
  }, [alias, editingNickname]);

  async function handleNicknameSave() {
    if (!fanId) return;
    const next = nicknameDraft.trim();
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      if (!next) {
        const result = await deleteFourBasedPivotField(creatorId, fanId, 'alias');
        setAlias(result.alias || '');
        setNicknameDraft(result.alias || '');
      } else {
        const result = await updateFourBasedPivot(creatorId, fanId, {
          alias: next,
        });
        setAlias(result.alias || next);
        setNicknameDraft(result.alias || next);
      }
      setEditingNickname(false);
    } catch (err) {
      setNicknameError(
        err instanceof Error ? err.message : 'Failed to save nickname'
      );
    } finally {
      setNicknameSaving(false);
    }
  }

  async function handleNicknameRemove() {
    if (!fanId) return;
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const result = await deleteFourBasedPivotField(creatorId, fanId, 'alias');
      setAlias(result.alias || '');
      setNicknameDraft('');
      setEditingNickname(false);
    } catch (err) {
      setNicknameError(
        err instanceof Error ? err.message : 'Failed to remove nickname'
      );
    } finally {
      setNicknameSaving(false);
    }
  }

  async function saveNotes(value: string) {
    if (!fanId) return;
    if (chatIdRef.current !== chatId) return;
    const trimmed = value.trim();
    const baseline = notesSavedBaselineRef.current;
    const isTemplateOnly =
      !baseline.trim() && trimmed === DEFAULT_FAN_NOTES_TEMPLATE.trim();
    if (isTemplateOnly) {
      setNotesStatus('idle');
      return;
    }
    if (value === baseline) {
      setNotesStatus('idle');
      return;
    }
    setNotesStatus('saving');
    setNotesError(null);
    try {
      if (!trimmed) {
        const result = await deleteFourBasedPivotField(creatorId, fanId, 'note');
        notesSavedBaselineRef.current = result.note || '';
        setRemoteNotes(result.note || '');
      } else {
        const result = await updateFourBasedPivot(creatorId, fanId, {
          note: value,
        });
        notesSavedBaselineRef.current = result.note || value;
        setRemoteNotes(result.note || value);
      }
      if (chatIdRef.current === chatId) {
        setNotesStatus('saved');
        window.setTimeout(() => {
          if (chatIdRef.current === chatId) setNotesStatus('idle');
        }, 1500);
      }
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : 'Failed to save notes');
      setNotesStatus('error');
    }
  }

  function scheduleNotesSave(value: string) {
    setNotesStatus('dirty');
    if (notesTimerRef.current != null) {
      window.clearTimeout(notesTimerRef.current);
    }
    notesTimerRef.current = window.setTimeout(() => {
      notesTimerRef.current = null;
      void saveNotes(value);
    }, NOTES_DEBOUNCE_MS);
  }

  async function togglePin() {
    setPinSaving(true);
    setPinError(null);
    try {
      const next = !isPinned;
      await pinFourBasedChat(creatorId, chatId, next);
      onChatUpdated?.({ is_pinned: next });
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Failed to update pin');
    } finally {
      setPinSaving(false);
    }
  }

  const assignedLists = useMemo(
    () => allLists.filter((list) => assignedListIds.includes(list._id)),
    [allLists, assignedListIds]
  );

  const availableLists = useMemo(
    () => allLists.filter((list) => !assignedListIds.includes(list._id)),
    [allLists, assignedListIds]
  );

  async function addToList(listId: string) {
    if (!fanId) return;
    setListMutating(true);
    setListsError(null);
    try {
      await addFourBasedFanToList(creatorId, listId, fanId);
      setAssignedListIds((prev) =>
        prev.includes(listId) ? prev : [...prev, listId]
      );
      setListPickerOpen(false);
    } catch (err) {
      setListsError(err instanceof Error ? err.message : 'Failed to add to list');
    } finally {
      setListMutating(false);
    }
  }

  async function removeFromList(listId: string) {
    if (!fanId) return;
    setListMutating(true);
    setListsError(null);
    try {
      await removeFourBasedFanFromList(creatorId, listId, fanId);
      setAssignedListIds((prev) => prev.filter((id) => id !== listId));
    } catch (err) {
      setListsError(
        err instanceof Error ? err.message : 'Failed to remove from list'
      );
    } finally {
      setListMutating(false);
    }
  }

  const displayName = alias.trim() || fanName || username;

  return (
    <aside
      className={`flex flex-col h-full min-h-0 bg-white dark:bg-zinc-950 border-l border-gray-200 dark:border-zinc-800 ${className}`}
    >
      <div className="h-12 px-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-1 shrink-0">
        <div className="flex-1 flex items-center gap-1 min-w-0">
          {(
            [
              { id: 'faninfo' as const, label: 'Fan Info' },
              { id: 'ppvs' as const, label: 'PPVs' },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  active
                    ? 'bg-4based-500/15 text-4based-500'
                    : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void togglePin()}
          disabled={pinSaving}
          className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
            isPinned
              ? 'text-red-500 hover:bg-red-500/10'
              : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800'
          }`}
          title={isPinned ? 'Unpin chat' : 'Pin chat'}
          aria-label={isPinned ? 'Unpin chat' : 'Pin chat'}
        >
          {pinSaving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Pin className={`w-4 h-4 ${isPinned ? 'fill-current' : ''}`} />
          )}
        </button>
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
        <div className="px-4 pt-4 pb-3 flex items-start gap-3 border-b border-gray-200 dark:border-zinc-800/60">
          <FanAvatar avatarUrl={fanAvatarUrl} name={displayName} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
                {displayName}
              </p>
              {ltv && (
                <span className="text-sm font-bold text-emerald-400 shrink-0">
                  {ltv}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
              @{username}
            </p>
          </div>
        </div>

        {pinError && (
          <p className="px-4 pt-2 text-[11px] text-red-400">{pinError}</p>
        )}

        {tab === 'faninfo' && (
          <div className="px-4 py-4 space-y-5">
            {pivotLoading && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </p>
            )}

            <section>
              <div className="flex items-center justify-between mb-2">
                <SectionHeading>Nickname</SectionHeading>
                {alias && !editingNickname && (
                  <button
                    type="button"
                    onClick={() => void handleNicknameRemove()}
                    disabled={nicknameSaving || !fanId}
                    className="text-[10px] font-semibold text-red-400 hover:text-red-300 disabled:opacity-50 inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                )}
              </div>
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
                        setNicknameDraft(alias);
                        setEditingNickname(false);
                      }
                    }}
                    autoFocus
                    placeholder="Nickname"
                    className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white outline-none focus:border-4based-500/60"
                    disabled={nicknameSaving}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleNicknameSave()}
                      disabled={nicknameSaving}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-4based-500 text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {nicknameSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNicknameDraft(alias);
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
                  disabled={!fanId}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-left hover:border-gray-300 dark:hover:border-zinc-700 disabled:opacity-50"
                >
                  <span
                    className={`text-sm truncate ${
                      alias
                        ? 'text-gray-900 dark:text-white'
                        : 'text-gray-400 dark:text-zinc-500'
                    }`}
                  >
                    {alias || 'Add nickname…'}
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
                disabled={!fanId}
                className="w-full px-3 py-2.5 text-xs leading-relaxed rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-zinc-200 outline-none focus:border-4based-500/60 resize-y min-h-[200px] font-mono disabled:opacity-50"
                placeholder="Notes about this fan…"
              />
              {remoteNotes.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    setNotesDraft('');
                    void saveNotes('');
                  }}
                  disabled={!fanId}
                  className="mt-1.5 text-[10px] font-semibold text-red-400 hover:text-red-300 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Clear notes
                </button>
              )}
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
                          onClick={() => void removeFromList(list._id)}
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
                      onClick={() => setListPickerOpen((v) => !v)}
                      disabled={!fanId || listMutating}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border border-dashed border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 hover:border-4based-500/50 hover:text-4based-500 disabled:opacity-50"
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
                        {availableLists.length === 0 && (
                          <p className="px-2.5 py-3 text-xs text-gray-500 dark:text-zinc-500">
                            No more lists available.
                          </p>
                        )}
                        {availableLists.map((list) => (
                          <button
                            key={list._id}
                            type="button"
                            disabled={listMutating}
                            onClick={() => void addToList(list._id)}
                            className="w-full text-left px-2.5 py-2 text-xs text-gray-800 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                          >
                            <span className="truncate">{list.name || 'List'}</span>
                          </button>
                        ))}
                      </div>
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
                      <span className="text-xs text-gray-500 dark:text-zinc-500">
                        Rate
                      </span>
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
                          ? formatUsd(stats.ppv.highestPrice)
                          : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 dark:text-zinc-500">
                        Lowest price
                      </span>
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {stats?.ppv.lowestPrice != null
                          ? formatUsd(stats.ppv.lowestPrice)
                          : '—'}
                      </span>
                    </div>
                  </div>
                </section>

                <section>
                  <SectionHeading>PPV Media</SectionHeading>
                  {!stats?.ppvEntries?.length ? (
                    <p className="text-xs text-gray-500 dark:text-zinc-500">
                      No PPVs sent.
                    </p>
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
                                {formatUsd(entry.priceNet)}
                              </span>
                            </div>
                            <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-0.5">
                              {[
                                entry.pictureCount > 0
                                  ? `${entry.pictureCount} pic${
                                      entry.pictureCount === 1 ? '' : 's'
                                    }`
                                  : null,
                                entry.videoCount > 0
                                  ? `${entry.videoCount} video${
                                      entry.videoCount === 1 ? '' : 's'
                                    }`
                                  : null,
                                !entry.pictureCount &&
                                !entry.videoCount &&
                                entry.mediaCount > 0
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
                    <p className="text-xs text-gray-500 dark:text-zinc-500">
                      No tips.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {stats.tips.map((tip) => (
                        <li
                          key={tip.id}
                          className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800"
                        >
                          <span className="text-sm font-semibold text-emerald-400">
                            {formatUsd(tip.priceNet)}
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
