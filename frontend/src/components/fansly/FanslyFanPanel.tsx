import { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, X } from 'lucide-react';
import {
  getFanslyFan,
  getFanslyGroup,
  saveFanslyFanNotes,
  saveFanslyNickname,
  type FanslyFanProfile,
  type FanslyFanPurchase,
} from '@/lib/api';

const NOTES_DEBOUNCE_MS = 800;

function formatMills(mills: number): string {
  const dollars = (Number(mills) || 0) / 1000;
  return `$${dollars.toFixed(2)}`;
}

function formatWhen(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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
      return getFanslyFan(creatorId, fanId);
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
        if (!cancelled) setLoading(false);
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
              </div>
            )}

            {tab === 'ppvs' && (
              <div className="px-4 py-4 space-y-2">
                {profile.purchases.length === 0 ? (
                  <p className="text-sm text-gray-500">No purchases.</p>
                ) : (
                  <ul className="space-y-2">
                    {profile.purchases.map((purchase) => (
                      <PurchaseRow key={purchase.id} purchase={purchase} />
                    ))}
                  </ul>
                )}
                {profile.hasMorePurchases && (
                  <p className="text-[11px] text-gray-400">Showing the latest 30.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function PurchaseRow({ purchase }: { purchase: FanslyFanPurchase }) {
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="text-gray-500">{formatWhen(purchase.createdAt) || 'Purchase'}</span>
      <span className="font-medium">{formatMills(purchase.grossMills)}</span>
    </li>
  );
}
