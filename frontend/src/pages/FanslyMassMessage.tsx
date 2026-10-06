import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Image as ImageIcon,
  Loader2,
  Megaphone,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { isCreatorRosterEvent } from '@/lib/creatorAccessEvents';
import { useToast } from '@/context/ToastContext';
import fanslyIcon from '@/assets/fansly.svg';
import {
  deleteFanslyMassMessage,
  fanslyVaultPreviewSrc,
  getCreators,
  listFanslyLists,
  listFanslyMassMessages,
  listFanslyVaultAlbums,
  listFanslyVaultMedia,
  sendFanslyMassMessage,
  uploadFanslyMassMessage,
  type Creator,
  type FanslyFanList,
  type FanslyMassMessage,
  type FanslyMassMessageAudience,
  type FanslyMassMessageTab,
  type FanslyVaultAlbum,
  type FanslyVaultMedia,
} from '@/lib/api';

const MEDIA_CAP = 10;

function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatMessageTime(createdAt: number | null): string {
  if (createdAt == null || !Number.isFinite(createdAt)) return '';
  const ms = createdAt < 1e12 ? createdAt * 1000 : createdAt;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function previewSrc(
  creatorId: string,
  item: { mediaId?: string; previewUrl?: string | null; previewLocked?: boolean } | null
): string | null {
  if (!item?.mediaId) return null;
  return fanslyVaultPreviewSrc(creatorId, {
    mediaId: item.mediaId,
    previewUrl: item.previewUrl ?? null,
    previewLocked: item.previewLocked,
  });
}

export default function FanslyMassMessage() {
  const { onSyncEvent } = useStaffSync();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [tab, setTab] = useState<FanslyMassMessageTab>('sent');
  const [messages, setMessages] = useState<FanslyMassMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [mediaSource, setMediaSource] = useState<'upload' | 'vault'>('vault');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendPhase, setSendPhase] = useState<'idle' | 'uploading' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);

  const [followers, setFollowers] = useState(false);
  const [subscribers, setSubscribers] = useState(true);
  const [expiredSubscribers, setExpiredSubscribers] = useState(false);
  const [excludeCreators, setExcludeCreators] = useState(true);
  const [excludeOffline, setExcludeOffline] = useState(false);
  const [lists, setLists] = useState<FanslyFanList[]>([]);
  const [includeListIds, setIncludeListIds] = useState<string[]>([]);
  const [excludeListIds, setExcludeListIds] = useState<string[]>([]);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [albums, setAlbums] = useState<FanslyVaultAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [vaultMedia, setVaultMedia] = useState<FanslyVaultMedia[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItems, setSelectedVaultItems] = useState<FanslyVaultMedia[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const beforeRef = useRef<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((creator) => creator.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const audience = useMemo<FanslyMassMessageAudience>(
    () => ({
      followers,
      subscribers,
      expiredSubscribers,
      excludeCreators,
      excludeOffline,
      includeListIds,
      excludeListIds,
    }),
    [
      followers,
      subscribers,
      expiredSubscribers,
      excludeCreators,
      excludeOffline,
      includeListIds,
      excludeListIds,
    ]
  );

  const hasAudience = followers || subscribers || expiredSubscribers || includeListIds.length > 0;
  const hasMedia =
    (mediaSource === 'upload' && Boolean(uploadFile)) ||
    (mediaSource === 'vault' && selectedVaultItems.length > 0);
  const canSend = !sending && hasAudience && (draft.trim().length > 0 || hasMedia);

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fansly = list.filter((creator) => creator.platform === 'fansly');
      setCreators(fansly);
      setSelectedCreatorId((prev) => prev || fansly[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(
    async (opts?: { append?: boolean; tab?: FanslyMassMessageTab }) => {
      if (!selectedCreatorId) return;
      const nextTab = opts?.tab || tab;
      const append = Boolean(opts?.append);
      const before = append ? beforeRef.current || undefined : undefined;
      if (!append) setLoading(true);
      setListError(null);
      try {
        const result = await listFanslyMassMessages(selectedCreatorId, { tab: nextTab, before });
        const next = result.messages || [];
        setMessages((prev) => (append ? [...prev, ...next] : next));
        beforeRef.current = result.before;
        setHasMore(Boolean(result.hasMore) && next.length > 0);
        if (!append) setSelectedIds([]);
      } catch (err) {
        setListError(err instanceof Error ? err.message : 'Failed to load mass messages');
      } finally {
        setLoading(false);
      }
    },
    [selectedCreatorId, tab]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (!isCreatorRosterEvent(event)) return;
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  useEffect(() => {
    setSendError(null);
    setDraft('');
    setSelectedVaultItems([]);
    setUploadFile(null);
    setIncludeListIds([]);
    setExcludeListIds([]);
    setLists([]);
    if (!selectedCreatorId) return;
    listFanslyLists(selectedCreatorId)
      .then((result) => setLists(result.lists || []))
      .catch(() => setLists([]));
  }, [selectedCreatorId]);

  useEffect(() => {
    setMessages([]);
    beforeRef.current = null;
    setHasMore(false);
    setSelectedIds([]);
    if (!selectedCreatorId) return;
    void loadMessages();
  }, [selectedCreatorId, loadMessages]);

  useEffect(() => {
    if (!uploadFile) {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(uploadFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadFile]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId) return;
    let cancelled = false;
    setAlbumsLoading(true);
    setVaultError(null);
    listFanslyVaultAlbums(selectedCreatorId)
      .then((result) => {
        if (cancelled) return;
        const next = result.albums || [];
        setAlbums(next);
        setSelectedAlbumId((prev) => prev || next[0]?.id || null);
      })
      .catch((err) => {
        if (cancelled) return;
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
        setAlbums([]);
      })
      .finally(() => {
        if (!cancelled) setAlbumsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOpen, selectedCreatorId]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId || !selectedAlbumId) return;
    let cancelled = false;
    setVaultLoading(true);
    setVaultError(null);
    listFanslyVaultMedia(selectedCreatorId, selectedAlbumId)
      .then((result) => {
        if (!cancelled) setVaultMedia(result.media || []);
      })
      .catch((err) => {
        if (cancelled) return;
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault media');
        setVaultMedia([]);
      })
      .finally(() => {
        if (!cancelled) setVaultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOpen, selectedCreatorId, selectedAlbumId]);

  function switchTab(next: FanslyMassMessageTab) {
    if (next === tab) return;
    setTab(next);
  }

  function toggleList(kind: 'include' | 'exclude', listId: string) {
    if (kind === 'include') {
      setIncludeListIds((prev) =>
        prev.includes(listId) ? prev.filter((id) => id !== listId) : [...prev, listId]
      );
      setExcludeListIds((prev) => prev.filter((id) => id !== listId));
      return;
    }
    setExcludeListIds((prev) =>
      prev.includes(listId) ? prev.filter((id) => id !== listId) : [...prev, listId]
    );
    setIncludeListIds((prev) => prev.filter((id) => id !== listId));
  }

  function toggleVaultItem(item: FanslyVaultMedia) {
    setSelectedVaultItems((prev) => {
      const exists = prev.some((row) => row.mediaId === item.mediaId);
      if (exists) return prev.filter((row) => row.mediaId !== item.mediaId);
      if (prev.length >= MEDIA_CAP) return prev;
      return [...prev, item];
    });
  }

  async function handleSend() {
    if (!selectedCreatorId || !canSend) return;
    setSending(true);
    setSendError(null);
    try {
      if (mediaSource === 'upload' && uploadFile) {
        setSendPhase('uploading');
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('content', draft);
        form.append('audience', JSON.stringify(audience));
        await uploadFanslyMassMessage(selectedCreatorId, form);
      } else {
        setSendPhase('sending');
        await sendFanslyMassMessage(selectedCreatorId, {
          content: draft,
          mediaIds:
            mediaSource === 'vault' ? selectedVaultItems.map((item) => item.mediaId) : [],
          audience,
        });
      }
      setDraft('');
      setUploadFile(null);
      setSelectedVaultItems([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.success('Mass message sent');
      if (tab !== 'sent') setTab('sent');
      await loadMessages({ tab: 'sent' });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send mass message');
    } finally {
      setSending(false);
      setSendPhase('idle');
    }
  }

  const deleteIds = useCallback(
    async (ids: string[]) => {
      if (!selectedCreatorId || ids.length === 0 || deletingId) return;
      const ok = await confirm({
        title: ids.length === 1 ? 'Delete mass message' : 'Delete mass messages',
        message:
          ids.length === 1
            ? 'Recipients will no longer see this mass message.'
            : `Delete ${ids.length} mass messages? Recipients will no longer see them.`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(ids[0]);
      let removed = 0;
      try {
        for (const id of ids) {
          setDeletingId(id);
          await deleteFanslyMassMessage(selectedCreatorId, id);
          removed += 1;
        }
        setMessages((prev) => prev.filter((message) => !ids.includes(message.id)));
        setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
        toast.success(removed === 1 ? 'Mass message deleted' : `Deleted ${removed} mass messages`);
      } catch (err) {
        if (removed > 0) {
          setMessages((prev) => prev.filter((message) => !ids.slice(0, removed).includes(message.id)));
          setSelectedIds((prev) => prev.filter((id) => !ids.slice(0, removed).includes(id)));
        }
        toast.error(err instanceof Error ? err.message : 'Failed to delete mass message');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId, confirm, toast]
  );

  return (
    <AppShell
      title="Fansly Mass Message"
      activePage="chatter"
      bleed
      headerExtras={
        <WorkspaceDrawerButton
          id="fansly-mass-accounts"
          size="lg"
          label="Creators"
          className="lg:hidden"
        />
      }
    >
      <WorkspaceDrawer
        id="fansly-mass-accounts"
        size="lg"
        className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50"
      >
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fanslyIcon} alt="" className="w-5 h-5 object-contain" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Mass Message</span>
        </div>
        <div data-drawer-list className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">No Fansly creators</p>
          )}
          {creators.map((creator) => {
            const active = creator.id === selectedCreatorId;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left ${
                  active ? 'bg-gray-100 dark:bg-white/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={creator.avatarUrl}
                  displayName={creator.displayName}
                  className="w-10 h-10 rounded-full object-cover shrink-0"
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-sky-400 to-blue-600"
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
      </WorkspaceDrawer>

      {!selectedCreatorId ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
          {creatorsLoading ? 'Loading creators…' : 'Select a creator'}
        </div>
      ) : (
        <>
          <section className="w-full max-w-md border-r border-gray-200 dark:border-zinc-800/60 flex flex-col min-h-0 shrink-0 bg-white dark:bg-zinc-950">
            <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-3 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-sky-500/15 flex items-center justify-center border border-sky-500/30">
                <Megaphone className="w-4 h-4 text-sky-500" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                  New mass message
                </h1>
                <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
                  {selectedCreator?.displayName}
                </p>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <label className="block text-xs text-gray-500">
                Message
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={4}
                  placeholder="Write a message. Media is optional."
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-xl bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 outline-none resize-none"
                />
              </label>

              <div className="flex rounded-xl border border-gray-200 dark:border-zinc-800 p-1 gap-1">
                {(
                  [
                    { id: 'vault' as const, label: 'Vault', icon: ImageIcon },
                    { id: 'upload' as const, label: 'Upload', icon: Upload },
                  ] as const
                ).map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => setMediaSource(source.id)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
                      mediaSource === source.id
                        ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                    }`}
                  >
                    <source.icon className="w-3.5 h-3.5" />
                    {source.label}
                  </button>
                ))}
              </div>

              {mediaSource === 'upload' ? (
                <div className="space-y-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 p-4 text-sm text-gray-500 hover:border-sky-500/50"
                  >
                    {uploadFile ? uploadFile.name : 'Choose a photo or video'}
                  </button>
                  {uploadPreviewUrl && uploadFile?.type.startsWith('image/') && (
                    <img
                      src={uploadPreviewUrl}
                      alt=""
                      className="w-full max-h-48 object-cover rounded-xl border border-gray-200 dark:border-zinc-800"
                    />
                  )}
                  {uploadFile?.type.startsWith('video/') && (
                    <p className="text-xs text-gray-500">Video selected</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setVaultOpen(true)}
                    className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 p-4 text-sm text-gray-500 hover:border-sky-500/50"
                  >
                    {selectedVaultItems.length > 0
                      ? `${selectedVaultItems.length} vault item${selectedVaultItems.length === 1 ? '' : 's'} selected`
                      : 'Choose from vault'}
                  </button>
                  {selectedVaultItems.length > 0 && selectedCreatorId && (
                    <div className="flex gap-2 overflow-x-auto">
                      {selectedVaultItems.map((item) => {
                        const src = previewSrc(selectedCreatorId, item);
                        return (
                          <div key={item.mediaId} className="relative w-16 h-16 shrink-0">
                            {src ? (
                              <img
                                src={src}
                                alt=""
                                className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-zinc-800"
                              />
                            ) : (
                              <span className="w-16 h-16 flex items-center justify-center rounded-lg border border-gray-200 dark:border-zinc-800 text-[10px] text-gray-500">
                                Media
                              </span>
                            )}
                            <button
                              type="button"
                              aria-label="Remove media"
                              onClick={() =>
                                setSelectedVaultItems((prev) =>
                                  prev.filter((row) => row.mediaId !== item.mediaId)
                                )
                              }
                              className="absolute -top-1 -right-1 bg-gray-900 text-white rounded-full p-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <p className="text-[11px] text-gray-500">
                Media is sent unlocked. Recipients can view it without a purchase, follow, or
                subscription.
              </p>

              <div className="space-y-2 rounded-xl border border-gray-200 dark:border-zinc-800 p-3">
                <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Audience</p>
                {(
                  [
                    ['followers', 'Followers', followers, setFollowers],
                    ['subscribers', 'Subscribers', subscribers, setSubscribers],
                    ['expired', 'Expired subscribers', expiredSubscribers, setExpiredSubscribers],
                    ['creators', 'Exclude creators', excludeCreators, setExcludeCreators],
                    ['offline', 'Exclude offline', excludeOffline, setExcludeOffline],
                  ] as const
                ).map(([id, label, checked, setChecked]) => (
                  <label key={id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setChecked(event.target.checked)}
                    />
                    {label}
                  </label>
                ))}
                {!hasAudience && (
                  <p className="text-xs text-red-400">Select at least one audience</p>
                )}
              </div>

              {lists.length > 0 && (
                <div className="space-y-3 rounded-xl border border-gray-200 dark:border-zinc-800 p-3">
                  <div>
                    <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">
                      Include lists
                    </p>
                    <div className="mt-2 max-h-32 overflow-y-auto space-y-1">
                      {lists.map((list) => (
                        <label key={`in-${list.id}`} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={includeListIds.includes(list.id)}
                            onChange={() => toggleList('include', list.id)}
                          />
                          <span className="truncate">{list.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">
                      Exclude lists
                    </p>
                    <div className="mt-2 max-h-32 overflow-y-auto space-y-1">
                      {lists.map((list) => (
                        <label key={`out-${list.id}`} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={excludeListIds.includes(list.id)}
                            onChange={() => toggleList('exclude', list.id)}
                          />
                          <span className="truncate">{list.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {sendError && <p className="text-xs text-red-400">{sendError}</p>}
              {sendPhase !== 'idle' && (
                <p className="text-xs text-gray-500">
                  {sendPhase === 'uploading' ? 'Uploading media…' : 'Sending mass message…'}
                </p>
              )}

              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-sky-500 text-white font-semibold text-sm hover:bg-sky-400 disabled:opacity-40"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Send mass message
              </button>
            </div>
          </section>

          <main className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                  {selectedCreator?.displayName || 'Creator'} — Mass messages
                </h2>
                <div className="flex gap-3 mt-0.5">
                  {(
                    [
                      ['sent', 'Sent'],
                      ['deleted', 'Deleted'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => switchTab(id)}
                      className={`text-xs font-medium ${
                        tab === id
                          ? 'text-sky-600 dark:text-sky-400'
                          : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {tab === 'sent' && selectedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void deleteIds(selectedIds)}
                    disabled={Boolean(deletingId)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete {selectedIds.length}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadMessages()}
                  className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                  title="Refresh"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {loading && messages.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {listError && <p className="text-sm text-red-400">{listError}</p>}
              {!loading && !listError && messages.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  {tab === 'deleted' ? 'No deleted mass messages.' : 'No mass messages yet.'}
                </p>
              )}
              {messages.map((message) => {
                const thumb = message.media[0];
                const src = selectedCreatorId ? previewSrc(selectedCreatorId, thumb) : null;
                const checked = selectedIds.includes(message.id);
                return (
                  <article
                    key={message.id}
                    className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 flex gap-3"
                  >
                    {tab === 'sent' && (
                      <input
                        type="checkbox"
                        aria-label="Select mass message"
                        checked={checked}
                        onChange={() =>
                          setSelectedIds((prev) =>
                            prev.includes(message.id)
                              ? prev.filter((id) => id !== message.id)
                              : [...prev, message.id]
                          )
                        }
                        className="mt-1"
                      />
                    )}
                    {src && (
                      <img
                        src={src}
                        alt=""
                        className="w-16 h-16 rounded-xl object-cover border border-gray-200 dark:border-zinc-800 shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                        {message.content || (message.media.length ? 'Media' : '')}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        {formatMessageTime(message.createdAt)}
                        {message.media.length > 1 ? ` · ${message.media.length} media` : ''}
                        {` · ${message.stats.delivered} delivered · ${message.stats.read} read · ${message.stats.total} reachable`}
                      </p>
                    </div>
                    {tab === 'sent' && (
                      <button
                        type="button"
                        title="Delete mass message"
                        aria-label="Delete mass message"
                        disabled={Boolean(deletingId)}
                        onClick={() => void deleteIds([message.id])}
                        className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40 shrink-0"
                      >
                        {deletingId === message.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </article>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMessages({ append: true })}
                  disabled={loading}
                  className="w-full py-2 text-sm text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </main>
        </>
      )}

      {vaultOpen && selectedCreatorId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80"
            onClick={() => setVaultOpen(false)}
          />
          <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60">
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-white">Media Vault</h3>
                <p className="text-xs text-gray-500 dark:text-zinc-400">
                  Select up to {MEDIA_CAP} photos or videos
                </p>
              </div>
              <button
                type="button"
                aria-label="Close vault"
                onClick={() => setVaultOpen(false)}
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-1 min-h-0">
              <div className="w-52 shrink-0 border-r border-gray-200 dark:border-zinc-800 overflow-y-auto p-2">
                {albumsLoading && (
                  <p className="px-2 py-3 text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </p>
                )}
                {albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    onClick={() => setSelectedAlbumId(album.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate ${
                      album.id === selectedAlbumId
                        ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 font-medium'
                        : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900'
                    }`}
                  >
                    {album.title}
                    {album.itemCount > 0 ? ` (${album.itemCount})` : ''}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {vaultError && <p className="text-sm text-red-500 mb-3">{vaultError}</p>}
                {vaultLoading && (
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading media…
                  </p>
                )}
                {selectedAlbumId && !vaultLoading && vaultMedia.length === 0 && (
                  <p className="text-sm text-gray-500">This album is empty.</p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {vaultMedia.map((item) => {
                    const src = previewSrc(selectedCreatorId, item);
                    const selected = selectedVaultItems.some((row) => row.mediaId === item.mediaId);
                    const video = item.kind === 'video' || item.mediaType === 2;
                    const durationLabel = video ? formatDuration(item.duration) : '';
                    return (
                      <button
                        key={item.id || item.mediaId}
                        type="button"
                        onClick={() => toggleVaultItem(item)}
                        className={`relative aspect-square rounded-xl overflow-hidden border ${
                          selected
                            ? 'border-sky-500 ring-2 ring-sky-500/40'
                            : 'border-gray-200 dark:border-zinc-800'
                        }`}
                      >
                        {src ? (
                          <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-500 px-2">
                            {item.filename || 'Media'}
                          </span>
                        )}
                        {selected && (
                          <span className="absolute top-2 right-2 bg-sky-500 text-white rounded-full p-1">
                            <Check className="w-3 h-3" />
                          </span>
                        )}
                        {video && (
                          <span className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white">
                            Video
                          </span>
                        )}
                        {durationLabel && (
                          <span className="absolute bottom-2 right-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white pointer-events-none">
                            {durationLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-gray-200 dark:border-zinc-800 flex items-center justify-between">
              <p className="text-xs text-gray-500">
                {selectedVaultItems.length} / {MEDIA_CAP} selected
              </p>
              <button
                type="button"
                onClick={() => setVaultOpen(false)}
                className="px-4 py-2 rounded-xl bg-sky-500 text-white text-sm font-semibold"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
