import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
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

  return (
    <aside className="flex flex-col h-full min-h-0 bg-white dark:bg-zinc-950 border-l border-gray-200 dark:border-zinc-800">
      <div className="h-12 px-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between shrink-0">
        <p className="text-sm font-semibold">Fan</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close fan panel"
          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-5">
        {loading && (
          <p className="text-sm text-gray-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading fan…
          </p>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {profile && (
          <>
            <div>
              <p className="text-sm font-bold truncate">{displayName}</p>
              <p className="text-xs text-gray-500 truncate">@{username.replace(/^@/, '')}</p>
              <p className="mt-2 text-sm font-semibold text-emerald-500">
                {formatMills(profile.lifetimeGrossMills)}
                <span className="ml-1 text-xs font-normal text-gray-500">lifetime</span>
              </p>
            </div>

            <section className="space-y-2">
              <p className="text-xs font-semibold text-gray-500">Nickname</p>
              <input
                value={nicknameDraft}
                onChange={(event) => setNicknameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveNickname();
                  }
                }}
                placeholder="Custom username"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5"
              />
              <button
                type="button"
                onClick={() => void saveNickname()}
                disabled={nicknameSaving}
                className="text-xs font-semibold text-sky-600 disabled:opacity-50"
              >
                {nicknameSaving ? 'Saving…' : 'Save nickname'}
              </button>
              {nicknameError && <p className="text-xs text-red-500">{nicknameError}</p>}
            </section>

            <section className="space-y-2">
              <p className="text-xs font-semibold text-gray-500">PPVs</p>
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
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-gray-500">Notes</p>
                <span className="text-[10px] text-gray-400">
                  {notesStatus === 'saving'
                    ? 'Saving…'
                    : notesStatus === 'saved'
                      ? 'Saved'
                      : notesStatus === 'error'
                        ? 'Not saved'
                        : 'CRM'}
                </span>
              </div>
              <textarea
                value={notesDraft}
                onChange={(event) => {
                  setNotesDraft(event.target.value);
                  setNotesStatus('idle');
                }}
                rows={6}
                placeholder="Notes stay in DomX"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 resize-y"
              />
              {notesError && <p className="text-xs text-red-500">{notesError}</p>}
            </section>
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
