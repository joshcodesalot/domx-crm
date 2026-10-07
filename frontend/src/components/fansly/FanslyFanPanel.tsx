import { useEffect, useRef, useState } from 'react';
import { Loader2, Lock, Pencil, Plus, Unlock, X } from 'lucide-react';
import {
  addFanslyFanToList,
  getFanslyFan,
  getFanslyFanLists,
  getFanslyGroup,
  getMaloumFanStats,
  listFanslyLists,
  removeFanslyFanFromList,
  saveFanslyFanNotes,
  saveFanslyNickname,
  type FanslyFanList,
  type FanslyFanProfile,
  type MaloumFanStats,
} from '@/lib/api';

const NOTES_DEBOUNCE_MS = 800;

function formatMills(mills: number): string {
  const dollars = (Number(mills) || 0) / 1000;
  return `$${dollars.toFixed(2)}`;
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

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
      {children}
    </h3>
  );
}

type FanslyFanPanelProps = {
  creatorId: string;
  groupId: string;
  partnerAccountId: string | null;
  partnerUsername: string;
  onNickname: (nickname: string) => void;
  onClose: () => void;
};

export default function FanslyFanPanel({
  creatorId,
  groupId,
  partnerAccountId,
  partnerUsername,
  onNickname,
  onClose,
}: FanslyFanPanelProps) {
  const [profile, setProfile] = useState<FanslyFanProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [noteId, setNoteId] = useState<string | null>(null);
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesStatus, setNotesStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [notesError, setNotesError] = useState<string | null>(null);
  const [tab, setTab] = useState<'faninfo' | 'ppvs'>('faninfo');
  const [editingNickname, setEditingNickname] = useState(false);
  const [allLists, setAllLists] = useState<FanslyFanList[]>([]);
  const [assignedLists, setAssignedLists] = useState<FanslyFanList[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [listMutating, setListMutating] = useState(false);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [stats, setStats] = useState<MaloumFanStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const notesBaseline = useRef('');
  const notesDraftRef = useRef('');
  const fanIdRef = useRef('');
  const creatorIdRef = useRef(creatorId);
  notesDraftRef.current = notesDraft;
  creatorIdRef.current = creatorId;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProfile(null);
    setTab('faninfo');
    setEditingNickname(false);
    setAllLists([]);
    setAssignedLists([]);
    setListsError(null);
    setListPickerOpen(false);

    async function load() {
      let fanId = partnerAccountId || '';
      if (!fanId) {
        const group = await getFanslyGroup(creatorId, groupId);
        const users = group.group?.users || [];
        const other = users.find(
          (user) => user?.userId && String(user.userId) !== String(group.providerUserId)
        );
        fanId = other?.userId ? String(other.userId) : '';
      }
      if (!fanId) throw new Error('Chat partner is required');
      fanIdRef.current = fanId;
      setListsLoading(true);
      const [profileResult, catalog, membership] = await Promise.all([
        getFanslyFan(creatorId, fanId),
        listFanslyLists(creatorId).catch(() => ({ lists: [] as FanslyFanList[] })),
        getFanslyFanLists(creatorId, fanId).catch((err: unknown) => {
          if (!cancelled) {
            setListsError(err instanceof Error ? err.message : 'Failed to load lists');
          }
          return { lists: [] as FanslyFanList[] };
        }),
      ]);
      if (!cancelled) {
        setAllLists(catalog.lists || []);
        setAssignedLists(membership.lists || []);
      }
      return profileResult;
    }

    load()
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setNicknameDraft(result.nickname || '');
        setNoteId(result.noteId);
        setNotesDraft(result.notes || '');
        notesBaseline.current = result.notes || '';
        onNickname(result.nickname || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load fan');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setListsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [creatorId, groupId, onNickname, partnerAccountId]);

  useEffect(() => {
    const fanId = fanIdRef.current;
    if (!fanId || notesDraft === notesBaseline.current) return;
    const timer = window.setTimeout(() => {
      const value = notesDraft;
      setNotesStatus('saving');
      setNotesError(null);
      saveFanslyFanNotes(creatorId, fanId, value)
        .then((result) => {
          notesBaseline.current = result.notes;
          setNotesStatus('saved');
        })
        .catch((err) => {
          setNotesError(err instanceof Error ? err.message : 'Failed to save notes');
          setNotesStatus('error');
        });
    }, NOTES_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [creatorId, notesDraft]);

  useEffect(() => {
    return () => {
      const fanId = fanIdRef.current;
      const value = notesDraftRef.current;
      if (!fanId || value === notesBaseline.current) return;
      void saveFanslyFanNotes(creatorIdRef.current, fanId, value).catch(() => {});
    };
  }, []);

  async function saveNickname() {
    const fanId = fanIdRef.current;
    if (!fanId || nicknameSaving) return;
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const saved = await saveFanslyNickname(creatorId, fanId, {
        nickname: nicknameDraft,
        noteId,
      });
      setNicknameDraft(saved.nickname || '');
      setNoteId(saved.noteId);
      setProfile((current) =>
        current
          ? { ...current, nickname: saved.nickname || '', noteId: saved.noteId }
          : current
      );
      onNickname(saved.nickname || '');
      setEditingNickname(false);
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : 'Failed to save nickname');
    } finally {
      setNicknameSaving(false);
    }
  }

  async function changeList(listId: string, action: 'add' | 'remove') {
    const fanId = fanIdRef.current;
    if (!fanId || listMutating) return;
    setListMutating(true);
    setListsError(null);
    try {
      const result =
        action === 'add'
          ? await addFanslyFanToList(creatorId, fanId, listId)
          : await removeFanslyFanFromList(creatorId, fanId, listId);
      setAssignedLists(result.lists || []);
      if (action === 'add') setListPickerOpen(false);
    } catch (err) {
      setListsError(err instanceof Error ? err.message : 'Failed to update lists');
    } finally {
      setListMutating(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setStatsLoading(true);
    setStatsError(null);
    getMaloumFanStats({
      creatorId,
      chatId: groupId,
      fanId: partnerAccountId || undefined,
    })
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatsError(err instanceof Error ? err.message : 'Failed to load PPV stats');
        }
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creatorId, groupId, partnerAccountId]);

  const assignedIds = new Set(assignedLists.map((list) => list.id));
  const availableLists = allLists.filter((list) => !assignedIds.has(list.id));

  const displayName =
    (profile?.nickname || '').trim() ||
    profile?.displayName ||
    partnerUsername;
  const username = profile?.username || partnerUsername;

  const handle = username.replace(/^@/, '');

  return (
    <aside className="flex flex-col h-full min-h-0 border-l border-gray-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-950">
      <div className="h-12 px-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-1 shrink-0">
        {(
          [
            { id: 'faninfo' as const, label: 'Fan Info' },
            { id: 'ppvs' as const, label: 'PPVs' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wider relative ${
              tab === item.id
                ? 'text-gray-900 dark:text-white'
                : 'text-gray-500 dark:text-zinc-500 hover:text-gray-800 dark:hover:text-zinc-300'
            }`}
          >
            {item.label}
            {tab === item.id && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-sky-500" />
            )}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close fan panel"
          className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && (
          <p className="px-4 py-4 text-sm text-gray-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading fan…
          </p>
        )}
        {error && <p className="px-4 py-4 text-sm text-red-500">{error}</p>}
        {profile && (
          <>
            <div className="px-4 pt-4 pb-3 flex items-start gap-3 border-b border-gray-200 dark:border-zinc-800/60">
              <span className="w-10 h-10 shrink-0 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300 text-sm font-semibold flex items-center justify-center">
                {(displayName.trim()[0] || '?').toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-bold text-gray-900 dark:text-white truncate">{displayName}</p>
                  <span className="text-sm font-bold text-emerald-400 shrink-0">
                    {formatMills(profile.lifetimeGrossMills)}
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">@{handle}</p>
              </div>
            </div>

            {tab === 'faninfo' && (
              <div className="px-4 py-4 space-y-5">
                <section className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
                    Nickname
                  </p>
                  {editingNickname ? (
                    <div className="space-y-2">
                      <input
                        value={nicknameDraft}
                        onChange={(event) => setNicknameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void saveNickname();
                          }
                          if (event.key === 'Escape') setEditingNickname(false);
                        }}
                        autoFocus
                        placeholder="Custom username"
                        className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white outline-none focus:border-sky-500/60"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveNickname()}
                          disabled={nicknameSaving}
                          className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-sky-500 text-white disabled:opacity-50"
                        >
                          {nicknameSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingNickname(false)}
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
                          nicknameDraft.trim()
                            ? 'text-gray-900 dark:text-white'
                            : 'text-gray-400 dark:text-zinc-500'
                        }`}
                      >
                        {nicknameDraft.trim() || 'Add nickname…'}
                      </span>
                      <Pencil className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    </button>
                  )}
                  {nicknameError && <p className="text-xs text-red-500">{nicknameError}</p>}
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
                      Notes
                    </p>
                    <span className="text-[10px] text-gray-400">
                      {notesStatus === 'saving'
                        ? 'Saving…'
                        : notesStatus === 'saved'
                          ? 'Saved'
                          : notesStatus === 'error'
                            ? 'Not saved'
                            : 'DomX'}
                    </span>
                  </div>
                  <textarea
                    value={notesDraft}
                    onChange={(event) => {
                      setNotesDraft(event.target.value);
                      setNotesStatus('idle');
                    }}
                    rows={8}
                    placeholder="Notes stay in DomX"
                    className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-white outline-none focus:border-sky-500/60 resize-y"
                  />
                  {notesError && <p className="text-xs text-red-500">{notesError}</p>}
                </section>

                <section className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
                    Lists
                  </p>
                  {listsLoading && assignedLists.length === 0 ? (
                    <p className="text-xs text-gray-500 flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {assignedLists.map((list) => (
                          <span
                            key={list.id}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-gray-100 dark:bg-zinc-800 text-gray-800 dark:text-zinc-200 border border-gray-200 dark:border-zinc-700"
                          >
                            {list.label}
                            <button
                              type="button"
                              disabled={listMutating}
                              onClick={() => void changeList(list.id, 'remove')}
                              className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-500 dark:text-zinc-400"
                              aria-label={`Remove from ${list.label}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() => setListPickerOpen((open) => !open)}
                          disabled={!fanIdRef.current || listMutating}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border border-dashed border-gray-300 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 hover:border-sky-500/50 hover:text-sky-600 dark:hover:text-sky-300 disabled:opacity-50"
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
                              <p className="px-2.5 py-3 text-xs text-gray-500">No more lists available.</p>
                            )}
                            {availableLists.map((list) => (
                              <button
                                key={list.id}
                                type="button"
                                disabled={listMutating}
                                onClick={() => void changeList(list.id, 'add')}
                                className="w-full text-left px-2.5 py-2 text-xs text-gray-800 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                              >
                                <span className="truncate">{list.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {listsError && <p className="text-xs text-red-500">{listsError}</p>}
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
                          <span className="text-xs text-gray-500 dark:text-zinc-500">Highest price</span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-white">
                            {stats?.ppv.highestPrice != null ? formatUsd(stats.ppv.highestPrice) : '—'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-gray-500 dark:text-zinc-500">Lowest price</span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-white">
                            {stats?.ppv.lowestPrice != null ? formatUsd(stats.ppv.lowestPrice) : '—'}
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
                                    {formatUsd(entry.priceNet)}
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
                                  {entry.sentAt ? ` · ${formatRelativeTime(entry.sentAt) || ''}` : ''}
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
          </>
        )}
      </div>
    </aside>
  );
}
