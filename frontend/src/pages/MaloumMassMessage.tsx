import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  Box,
  Check,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Lock,
  Megaphone,
  RefreshCw,
  Send,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import maloumIcon from '@/assets/maloum_icon.png';
import { useStaffSync } from '@/context/StaffSyncContext';
import {
  formatRelativeTime,
  friendlyVaultFolderName,
  isVideoAsset,
  vaultDirectUrl,
  vaultUploadId,
} from '@/components/maloum/MaloumChatPanels';
import {
  getCreators,
  listMaloumBroadcasts,
  listMaloumChatLists,
  listMaloumVaultFolders,
  listMaloumVaultMedia,
  maloumMediaUrl,
  revokeMaloumBroadcast,
  sendMaloumBroadcast,
  translateToGerman,
  type Creator,
  type MaloumBroadcast,
  type MaloumChatListItem,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const CURRENCY_SYMBOL = '€';

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function broadcastThumbUrl(
  creatorId: string,
  media: { _id?: string; thumbnailUrl?: string; url?: string }
): string | null {
  if (media.thumbnailUrl && /^https?:\/\//i.test(media.thumbnailUrl)) {
    return media.thumbnailUrl;
  }
  if (media.url && /^https?:\/\//i.test(media.url)) {
    return media.url;
  }
  if (media._id) {
    return maloumMediaUrl(creatorId, { uploadId: media._id, variant: 'thumbnail' });
  }
  return null;
}

/** Maloum managed lists arrive as opaque codes like __0h7fd89v__; show native labels. */
const MANAGED_LIST_LABELS_BY_NAME: Record<string, string> = {
  __0h7fd89v__: 'All free followers and subscribers',
  __9a5ju9d3__: 'All free followers',
  __x0y89z7l__: 'All subscribers',
};

const MANAGED_LIST_LABELS_BY_ORDER = [
  'All free followers and subscribers',
  'All free followers',
  'All subscribers',
] as const;

function isManagedListCode(name: string): boolean {
  return /^__[\w]+__$/.test(name);
}

function isManagedChatList(list: MaloumChatListItem): boolean {
  const name = (list.name || '').trim();
  return Boolean(list.isManaged) || isManagedListCode(name);
}

/** Rank among managed lists in API order (0, 1, 2…) — works across creators whose codes differ. */
function buildManagedListRanks(lists: MaloumChatListItem[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let index = 0;
  for (const list of lists) {
    if (!isManagedChatList(list)) continue;
    ranks.set(list._id, index);
    index += 1;
  }
  return ranks;
}

function friendlyListName(
  list: MaloumChatListItem,
  managedRanks?: Map<string, number>
): string {
  const raw = (list.name || '').trim();
  if (raw && MANAGED_LIST_LABELS_BY_NAME[raw]) {
    return MANAGED_LIST_LABELS_BY_NAME[raw];
  }
  if (isManagedChatList(list)) {
    const rank = managedRanks?.get(list._id);
    if (rank != null && rank >= 0 && rank < MANAGED_LIST_LABELS_BY_ORDER.length) {
      return MANAGED_LIST_LABELS_BY_ORDER[rank];
    }
    if (raw && isManagedListCode(raw)) {
      // Single managed list shown without siblings (e.g. sent-broadcast summary)
      return MANAGED_LIST_LABELS_BY_NAME[raw] || 'Managed list';
    }
  }
  return raw || 'Untitled list';
}

function listLabel(
  list: MaloumChatListItem,
  managedRanks?: Map<string, number>
): string {
  const name = friendlyListName(list, managedRanks);
  const count =
    typeof list.totalMemberCount === 'number' ? ` (${list.totalMemberCount})` : '';
  return `${name}${count}`;
}

function nearScrollEnd(
  target: HTMLElement,
  thresholdPx = 80,
  axis: 'vertical' | 'horizontal' = 'vertical'
): boolean {
  if (axis === 'horizontal') {
    const remaining =
      target.scrollWidth - target.scrollLeft - target.clientWidth;
    return remaining <= thresholdPx;
  }
  const remaining =
    target.scrollHeight - target.scrollTop - target.clientHeight;
  return remaining <= thresholdPx;
}

function mergeVaultFolders(
  prev: MaloumVaultFolder[],
  incoming: MaloumVaultFolder[]
): MaloumVaultFolder[] {
  const seen = new Set(prev.map((f) => f._id));
  const next = [...prev];
  for (const folder of incoming) {
    if (!folder?._id || seen.has(folder._id)) continue;
    seen.add(folder._id);
    next.push(folder);
  }
  return next;
}

function mergeVaultMediaItems(
  prev: MaloumVaultMediaItem[],
  incoming: MaloumVaultMediaItem[]
): MaloumVaultMediaItem[] {
  const seen = new Set(
    prev.map((item) => vaultUploadId(item)).filter(Boolean) as string[]
  );
  const next = [...prev];
  for (const item of incoming) {
    const id = vaultUploadId(item);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    next.push(item);
  }
  return next;
}

export default function MaloumMassMessage() {
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [broadcasts, setBroadcasts] = useState<MaloumBroadcast[]>([]);
  const [broadcastsNext, setBroadcastsNext] = useState<string | null>(null);
  const [broadcastsLoading, setBroadcastsLoading] = useState(false);
  const [broadcastsError, setBroadcastsError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [chatLists, setChatLists] = useState<MaloumChatListItem[]>([]);
  const [chatListsNext, setChatListsNext] = useState<string | null>(null);
  const [chatListsLoading, setChatListsLoading] = useState(false);
  const [includeIds, setIncludeIds] = useState<string[]>([]);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<MaloumVaultFolder[]>([]);
  const [vaultFoldersNext, setVaultFoldersNext] = useState<number | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<MaloumVaultMediaItem[]>([]);
  const [vaultMediaNext, setVaultMediaNext] = useState<number | null>(null);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [loadingMoreFolders, setLoadingMoreFolders] = useState(false);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItems, setSelectedVaultItems] = useState<MaloumVaultMediaItem[]>(
    []
  );
  const [vaultTypeFilter, setVaultTypeFilter] = useState<'all' | 'image' | 'video'>(
    'all'
  );
  const [ppvPrice, setPpvPrice] = useState('');
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState('');

  const loadingMoreFoldersRef = useRef(false);
  const loadingMoreMediaRef = useRef(false);
  const vaultFoldersNextRef = useRef<number | null>(null);
  const vaultMediaNextRef = useRef<number | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const maloum = list.filter((c) => c.platform === 'maloum');
      setCreators(maloum);
      setSelectedCreatorId((prev) => prev || maloum[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const loadBroadcasts = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) setBroadcastsLoading(true);
      setBroadcastsError(null);
      try {
        const result = await listMaloumBroadcasts(selectedCreatorId, {
          limit: 15,
          filter: 'ALL',
          next: opts?.next || undefined,
        });
        setBroadcasts((prev) =>
          append ? [...prev, ...(result.broadcasts || [])] : result.broadcasts || []
        );
        setBroadcastsNext(result.next || null);
      } catch (err) {
        setBroadcastsError(
          err instanceof Error ? err.message : 'Failed to load mass messages'
        );
      } finally {
        setBroadcastsLoading(false);
      }
    },
    [selectedCreatorId]
  );

  const loadChatLists = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) setChatListsLoading(true);
      try {
        const result = await listMaloumChatLists(selectedCreatorId, {
          limit: 25,
          next: opts?.next || undefined,
        });
        setChatLists((prev) =>
          append ? [...prev, ...(result.lists || [])] : result.lists || []
        );
        setChatListsNext(result.next || null);
      } catch {
        if (!append) setChatLists([]);
      } finally {
        setChatListsLoading(false);
      }
    },
    [selectedCreatorId]
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
    setBroadcasts([]);
    setBroadcastsNext(null);
    setChatLists([]);
    setChatListsNext(null);
    setIncludeIds([]);
    setExcludeIds([]);
    setDraft('');
    setSelectedVaultItems([]);
    setSelectedFolderId(null);
    setVaultFolders([]);
    setVaultItems([]);
    vaultFoldersNextRef.current = null;
    vaultMediaNextRef.current = null;
    setVaultFoldersNext(null);
    setVaultMediaNext(null);
    setVaultOpen(false);
    setPpvPrice('');
    setSendError(null);
    if (selectedCreatorId) {
      void loadBroadcasts();
      void loadChatLists();
    }
  }, [selectedCreatorId, loadBroadcasts, loadChatLists]);

  const loadVaultFolders = useCallback(
    async (opts?: { append?: boolean; next?: number | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (append) {
        if (
          loadingMoreFoldersRef.current ||
          opts?.next == null ||
          !Number.isFinite(opts.next)
        ) {
          return;
        }
        loadingMoreFoldersRef.current = true;
        setLoadingMoreFolders(true);
      } else {
        setVaultLoading(true);
      }
      setVaultError(null);
      try {
        const result = await listMaloumVaultFolders(selectedCreatorId, {
          limit: 15,
          next: append && opts?.next != null ? opts.next : undefined,
        });
        const folders = result.folders || [];
        const next =
          typeof result.next === 'number' && Number.isFinite(result.next)
            ? result.next
            : null;
        vaultFoldersNextRef.current = next;
        setVaultFoldersNext(next);
        setVaultFolders((prev) =>
          append ? mergeVaultFolders(prev, folders) : folders
        );
        if (!append) {
          setSelectedFolderId((prev) => prev || folders[0]?._id || null);
        }
      } catch (err) {
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
      } finally {
        if (append) {
          loadingMoreFoldersRef.current = false;
          setLoadingMoreFolders(false);
        } else {
          setVaultLoading(false);
        }
      }
    },
    [selectedCreatorId]
  );

  const loadMoreVaultFolders = useCallback(() => {
    const next = vaultFoldersNextRef.current;
    if (next == null) return;
    void loadVaultFolders({ append: true, next });
  }, [loadVaultFolders]);

  const loadVaultMedia = useCallback(
    async (opts?: { append?: boolean; next?: number | null; folderId?: string }) => {
      if (!selectedCreatorId) return;
      const folderId = opts?.folderId || selectedFolderId;
      if (!folderId) return;
      const append = Boolean(opts?.append);
      if (append) {
        if (
          loadingMoreMediaRef.current ||
          opts?.next == null ||
          !Number.isFinite(opts.next)
        ) {
          return;
        }
        loadingMoreMediaRef.current = true;
        setLoadingMoreMedia(true);
      } else {
        setVaultLoading(true);
        setVaultItems([]);
        vaultMediaNextRef.current = null;
        setVaultMediaNext(null);
      }
      setVaultError(null);
      try {
        const result = await listMaloumVaultMedia(selectedCreatorId, folderId, {
          limit: 50,
          next: append && opts?.next != null ? opts.next : undefined,
        });
        const items = result.items || [];
        const next =
          typeof result.next === 'number' && Number.isFinite(result.next)
            ? result.next
            : null;
        vaultMediaNextRef.current = next;
        setVaultMediaNext(next);
        setVaultItems((prev) =>
          append ? mergeVaultMediaItems(prev, items) : items
        );
      } catch (err) {
        setVaultError(err instanceof Error ? err.message : 'Failed to load media');
      } finally {
        if (append) {
          loadingMoreMediaRef.current = false;
          setLoadingMoreMedia(false);
        } else {
          setVaultLoading(false);
        }
      }
    },
    [selectedCreatorId, selectedFolderId]
  );

  const loadMoreVaultMedia = useCallback(() => {
    const next = vaultMediaNextRef.current;
    if (next == null) return;
    void loadVaultMedia({ append: true, next });
  }, [loadVaultMedia]);

  const openVault = useCallback(async () => {
    if (!selectedCreatorId) return;
    setVaultOpen(true);
    setVaultTypeFilter('all');
    setVaultFolders([]);
    vaultFoldersNextRef.current = null;
    setVaultFoldersNext(null);
    await loadVaultFolders();
  }, [selectedCreatorId, loadVaultFolders]);

  useEffect(() => {
    if (!vaultOpen || !selectedFolderId || !selectedCreatorId) return;
    void loadVaultMedia({ folderId: selectedFolderId });
  }, [vaultOpen, selectedFolderId, selectedCreatorId, loadVaultMedia]);

  const handleVaultFoldersScroll = useCallback(
    (event: UIEvent<HTMLElement>, axis: 'vertical' | 'horizontal' = 'vertical') => {
      if (!nearScrollEnd(event.currentTarget, 80, axis)) return;
      const next = vaultFoldersNextRef.current;
      if (next == null) return;
      void loadVaultFolders({ append: true, next });
    },
    [loadVaultFolders]
  );

  const handleVaultMediaScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!nearScrollEnd(event.currentTarget)) return;
      const next = vaultMediaNextRef.current;
      if (next == null) return;
      void loadVaultMedia({ append: true, next });
    },
    [loadVaultMedia]
  );

  const filteredVaultItems = useMemo(() => {
    if (vaultTypeFilter === 'all') return vaultItems;
    return vaultItems.filter((item) => {
      const video = isVideoAsset(item.media?.type);
      return vaultTypeFilter === 'video' ? video : !video;
    });
  }, [vaultItems, vaultTypeFilter]);

  const toggleVaultItem = useCallback((item: MaloumVaultMediaItem) => {
    const id = vaultUploadId(item);
    if (!id) return;
    setSelectedVaultItems((prev) => {
      const exists = prev.some((entry) => vaultUploadId(entry) === id);
      if (exists) return prev.filter((entry) => vaultUploadId(entry) !== id);
      return [...prev, item];
    });
  }, []);

  const toggleList = useCallback(
    (listId: string, mode: 'include' | 'exclude') => {
      if (mode === 'include') {
        setExcludeIds((prev) => prev.filter((id) => id !== listId));
        setIncludeIds((prev) =>
          prev.includes(listId) ? prev.filter((id) => id !== listId) : [...prev, listId]
        );
      } else {
        setIncludeIds((prev) => prev.filter((id) => id !== listId));
        setExcludeIds((prev) =>
          prev.includes(listId) ? prev.filter((id) => id !== listId) : [...prev, listId]
        );
      }
    },
    []
  );

  const handleRevoke = useCallback(
    async (broadcastId: string) => {
      if (!selectedCreatorId || revokingId) return;
      if (!window.confirm('Delete this mass message? Recipients will no longer see it.')) {
        return;
      }
      setRevokingId(broadcastId);
      try {
        await revokeMaloumBroadcast(selectedCreatorId, broadcastId);
        setBroadcasts((prev) =>
          prev.map((b) => (b._id === broadcastId ? { ...b, isRevoked: true } : b))
        );
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to delete mass message');
      } finally {
        setRevokingId(null);
      }
    },
    [selectedCreatorId, revokingId]
  );

  const handleSend = useCallback(async () => {
    if (!selectedCreatorId || sending || translatingOutgoing) return;
    const englishDraft = draft.trim();
    if (!englishDraft && selectedVaultItems.length === 0) {
      setSendError('Add text or media');
      return;
    }
    if (includeIds.length === 0) {
      setSendError('Select at least one include list');
      return;
    }

    setSending(true);
    setSendError(null);
    try {
      let textToSend = englishDraft;
      if (autoTranslateOutgoing && englishDraft) {
        setTranslatingOutgoing(true);
        try {
          textToSend = await translateToGerman(englishDraft, []);
        } catch (err) {
          setSendError(
            err instanceof Error
              ? err.message
              : 'Translation failed. Message was not sent.'
          );
          return;
        } finally {
          setTranslatingOutgoing(false);
        }
      }

      const mediaPayload = selectedVaultItems.map((item) => {
        const uploadId = vaultUploadId(item);
        if (!uploadId) throw new Error('Selected vault item is missing uploadId');
        return {
          mediaId: uploadId,
          type: item.media?.type || 'picture',
          width: item.media?.width,
          height: item.media?.height,
        };
      });

      const priceNet = Number(ppvPrice) || 0;
      await sendMaloumBroadcast(selectedCreatorId, {
        includeFromLists: includeIds,
        excludeFromLists: excludeIds,
        text: textToSend,
        media: mediaPayload.length > 0 ? mediaPayload : undefined,
        priceNet: mediaPayload.length > 0 && priceNet > 0 ? priceNet : undefined,
      });

      setDraft('');
      setSelectedVaultItems([]);
      setPpvPrice('');
      setPriceDraft('');
      setIncludeIds([]);
      setExcludeIds([]);
      await loadBroadcasts();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send mass message');
    } finally {
      setSending(false);
    }
  }, [
    selectedCreatorId,
    sending,
    translatingOutgoing,
    draft,
    selectedVaultItems,
    includeIds,
    excludeIds,
    autoTranslateOutgoing,
    ppvPrice,
    loadBroadcasts,
  ]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Mass Message
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              No Maloum creators yet. Connect one from Manage Creators.
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
          <label className="flex items-center justify-between cursor-pointer group gap-3">
            <span className="text-xs font-medium text-gray-700 dark:text-zinc-300">
              Auto-translate Out
            </span>
            <ToggleSwitch
              checked={autoTranslateOutgoing}
              onChange={(enabled) => {
                setAutoTranslateOutgoing(enabled);
                localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
              }}
              aria-label="Auto-translate outgoing messages"
            />
          </label>
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
                  <Megaphone className="w-4 h-4 text-domx-400" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Sent mass messages
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Managers and above only
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadBroadcasts()}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw
                  className={`w-4 h-4 ${broadcastsLoading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {broadcastsLoading && broadcasts.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {broadcastsError && (
                <p className="text-sm text-red-400">{broadcastsError}</p>
              )}
              {!broadcastsLoading && !broadcastsError && broadcasts.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  No mass messages yet.
                </p>
              )}
              {broadcasts.map((broadcast) => {
                const media = broadcast.content?.media || [];
                const price = Number(broadcast.content?.price) || 0;
                const when = formatRelativeTime(broadcast.processedAt);
                return (
                  <article
                    key={broadcast._id}
                    className={`rounded-2xl border p-4 ${
                      broadcast.isRevoked
                        ? 'border-gray-200 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-900/40 opacity-70'
                        : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                          {broadcast.content?.text || (
                            <span className="text-gray-400 italic">No text</span>
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-500 dark:text-zinc-500">
                          {when && <span>{when}</span>}
                          {broadcast.isSending && (
                            <span className="text-amber-500 font-medium">Sending…</span>
                          )}
                          {broadcast.isRevoked && (
                            <span className="text-red-400 font-medium">Deleted</span>
                          )}
                          {price > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-domx-600/15 text-domx-600 dark:text-domx-400 font-semibold">
                              <Lock className="w-3 h-3" />
                              {CURRENCY_SYMBOL}
                              {price}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {broadcast.recipientCount ?? 0} recipients
                          </span>
                          <span>{broadcast.viewerCount ?? 0} views</span>
                          <span>{broadcast.buyerCount ?? 0} buys</span>
                        </div>
                        {(broadcast.includeFromLists?.length || 0) > 0 && (
                          <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-500 truncate">
                            Include:{' '}
                            {(() => {
                              const ranks = buildManagedListRanks(
                                broadcast.includeFromLists || []
                              );
                              return broadcast.includeFromLists
                                ?.map((l) => friendlyListName(l, ranks))
                                .join(', ');
                            })()}
                          </p>
                        )}
                      </div>
                      {!broadcast.isRevoked && (
                        <button
                          type="button"
                          onClick={() => void handleRevoke(broadcast._id)}
                          disabled={revokingId === broadcast._id}
                          className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                          title="Delete mass message"
                        >
                          {revokingId === broadcast._id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                    {media.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {media.slice(0, 8).map((item, idx) => {
                          const src = broadcastThumbUrl(selectedCreatorId, item);
                          const video = isVideoAsset(item.type);
                          return (
                            <div
                              key={item._id || `${broadcast._id}-${idx}`}
                              className="w-14 h-14 rounded-lg overflow-hidden border border-gray-200 dark:border-zinc-700 relative bg-gray-100 dark:bg-zinc-800"
                            >
                              {src ? (
                                <img
                                  src={src}
                                  alt=""
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400">
                                  <ImageIcon className="w-4 h-4" />
                                </div>
                              )}
                              {video && (
                                <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                                  <Video className="w-4 h-4 text-white" />
                                </span>
                              )}
                            </div>
                          );
                        })}
                        {media.length > 8 && (
                          <span className="text-xs text-gray-500 self-center">
                            +{media.length - 8}
                          </span>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
              {broadcastsNext && (
                <button
                  type="button"
                  onClick={() => void loadBroadcasts({ append: true, next: broadcastsNext })}
                  disabled={broadcastsLoading}
                  className="w-full py-2 text-sm text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                >
                  {broadcastsLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>

            <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-950 p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <ListPicker
                  title="Include lists"
                  lists={chatLists}
                  selectedIds={includeIds}
                  disabledIds={excludeIds}
                  loading={chatListsLoading}
                  onToggle={(id) => toggleList(id, 'include')}
                  onLoadMore={
                    chatListsNext
                      ? () => void loadChatLists({ append: true, next: chatListsNext })
                      : undefined
                  }
                />
                <ListPicker
                  title="Exclude lists"
                  lists={chatLists}
                  selectedIds={excludeIds}
                  disabledIds={includeIds}
                  loading={chatListsLoading}
                  onToggle={(id) => toggleList(id, 'exclude')}
                  onLoadMore={
                    chatListsNext
                      ? () => void loadChatLists({ append: true, next: chatListsNext })
                      : undefined
                  }
                />
              </div>

              {selectedVaultItems.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex gap-2 flex-wrap flex-1 min-w-0">
                    {selectedVaultItems.map((item) => {
                      const uploadId = vaultUploadId(item);
                      const src = vaultDirectUrl(item);
                      return (
                        <button
                          key={uploadId || src || 'chip'}
                          type="button"
                          onClick={() => toggleVaultItem(item)}
                          className="w-12 h-12 rounded-lg relative group overflow-hidden border border-gray-300 dark:border-zinc-700 shrink-0"
                          title="Remove"
                        >
                          {src ? (
                            <img src={src} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 text-gray-500">
                              <ImageIcon className="w-4 h-4" />
                            </div>
                          )}
                          <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/35 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <X className="w-3 h-3" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    {Number(ppvPrice) > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setPriceDraft(ppvPrice);
                            setPriceModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-domx-500/40 bg-domx-600/10 text-sm font-semibold text-domx-600 dark:text-domx-400"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          {CURRENCY_SYMBOL}
                          {ppvPrice}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPpvPrice('');
                            setPriceDraft('');
                          }}
                          className="p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
                          aria-label="Remove price"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setPriceDraft('');
                          setPriceModalOpen(true);
                        }}
                        className="text-sm font-medium text-domx-600 dark:text-domx-400"
                      >
                        Add price for your media +
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedVaultItems([]);
                        setPpvPrice('');
                        setPriceDraft('');
                      }}
                      className="p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
                      aria-label="Clear attachment"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {sendError && <p className="text-xs text-red-400">{sendError}</p>}
              {translatingOutgoing && (
                <p className="text-xs text-gray-500">Translating to German…</p>
              )}

              <div className="flex items-end gap-2 bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-2xl p-2 focus-within:border-domx-500/50">
                <button
                  type="button"
                  onClick={() => void openVault()}
                  className="p-2 rounded-xl text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 shrink-0"
                  title="Open Media Vault"
                >
                  <ImageIcon className="w-5 h-5" />
                </button>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder={
                    autoTranslateOutgoing
                      ? 'Type a mass message… (Auto-translates to German)'
                      : 'Type a mass message…'
                  }
                  className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-gray-900 dark:text-white focus:outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={
                    sending ||
                    translatingOutgoing ||
                    (!draft.trim() && selectedVaultItems.length === 0) ||
                    includeIds.length === 0
                  }
                  className="p-3 rounded-xl bg-domx-600 text-white hover:bg-domx-500 shadow-lg shadow-domx-600/20 shrink-0 disabled:opacity-40"
                  title="Send mass message"
                >
                  {sending || translatingOutgoing ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80 backdrop-blur-sm"
            onClick={() => setVaultOpen(false)}
          />
          <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                  <Box className="w-5 h-5 text-domx-400" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-gray-900 dark:text-white">
                    Media Vault
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">
                    {selectedVaultItems.length} item
                    {selectedVaultItems.length === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setVaultOpen(false)}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500"
                >
                  Insert Media
                </button>
                <button
                  type="button"
                  onClick={() => setVaultOpen(false)}
                  className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white rounded-lg"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex flex-1 overflow-hidden min-h-0">
              <div
                className="w-48 sm:w-56 border-r border-gray-200 dark:border-zinc-800/60 p-3 overflow-y-auto hidden md:block shrink-0"
                onScroll={(e) => handleVaultFoldersScroll(e, 'vertical')}
              >
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3 px-2">
                  Folders
                </h4>
                <ul className="space-y-1">
                  {vaultFolders.map((folder) => {
                    const active = selectedFolderId === folder._id;
                    const folderLabel = friendlyVaultFolderName(folder);
                    return (
                      <li key={folder._id}>
                        <button
                          type="button"
                          onClick={() => setSelectedFolderId(folder._id)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                              : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500'
                          }`}
                          title={folderLabel}
                        >
                          {active ? (
                            <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 shrink-0" />
                          )}
                          <span className="truncate">{folderLabel}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {vaultFoldersNext != null && (
                  <button
                    type="button"
                    onClick={loadMoreVaultFolders}
                    disabled={loadingMoreFolders}
                    className="w-full mt-2 py-2 text-xs font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                  >
                    {loadingMoreFolders ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
              <div className="flex-1 flex flex-col min-w-0">
                <div className="p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
                  {(
                    [
                      { id: 'all' as const, label: 'All Types' },
                      { id: 'image' as const, label: 'Images' },
                      { id: 'video' as const, label: 'Videos' },
                    ]
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setVaultTypeFilter(chip.id)}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap ${
                        vaultTypeFilter === chip.id
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
                <div
                  className="flex-1 overflow-y-auto p-4"
                  onScroll={handleVaultMediaScroll}
                >
                  {vaultLoading && vaultItems.length === 0 && (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                    </div>
                  )}
                  {vaultError && <p className="text-sm text-red-400">{vaultError}</p>}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {filteredVaultItems.map((item) => {
                      const uploadId = vaultUploadId(item);
                      const src = vaultDirectUrl(item);
                      const selected = selectedVaultItems.some(
                        (entry) => vaultUploadId(entry) === uploadId
                      );
                      const video = isVideoAsset(item.media?.type);
                      return (
                        <button
                          key={uploadId || src || 'item'}
                          type="button"
                          onClick={() => toggleVaultItem(item)}
                          className={`relative aspect-square rounded-xl overflow-hidden ${
                            selected
                              ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950'
                              : 'border border-gray-200 dark:border-zinc-800'
                          }`}
                        >
                          {src ? (
                            <img
                              src={src}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                              <ImageIcon className="w-6 h-6" />
                            </div>
                          )}
                          {selected && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center">
                              <Check className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {video && (
                            <span className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                              <Video className="w-5 h-5 text-white" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {vaultMediaNext != null && (
                    <button
                      type="button"
                      onClick={loadMoreVaultMedia}
                      disabled={loadingMoreMedia}
                      className="w-full mt-4 py-2.5 text-sm font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                    >
                      {loadingMoreMedia ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {priceModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close media price"
            className="absolute inset-0 bg-black/40 dark:bg-black/70 backdrop-blur-sm"
            onClick={() => setPriceModalOpen(false)}
          />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 shadow-2xl p-6">
            <button
              type="button"
              onClick={() => setPriceModalOpen(false)}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-900 dark:hover:text-white"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-center text-lg font-bold text-gray-800 dark:text-white mb-6">
              Media price
            </h3>
            <div className="flex items-center gap-3 border-b border-gray-200 dark:border-zinc-700 pb-3 mb-5">
              <span className="text-2xl font-medium text-gray-700 dark:text-zinc-300">
                {CURRENCY_SYMBOL}
              </span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                autoFocus
                value={priceDraft}
                onChange={(e) => setPriceDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const net = Number(priceDraft);
                    if (Number.isFinite(net) && net > 0) {
                      setPpvPrice(String(net));
                      setPriceModalOpen(false);
                    }
                  }
                }}
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const net = Number(priceDraft);
                if (!Number.isFinite(net) || net <= 0) return;
                setPpvPrice(String(net));
                setPriceModalOpen(false);
              }}
              disabled={!Number.isFinite(Number(priceDraft)) || Number(priceDraft) <= 0}
              className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white font-bold"
            >
              Set price
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ListPicker({
  title,
  lists,
  selectedIds,
  disabledIds,
  loading,
  onToggle,
  onLoadMore,
}: {
  title: string;
  lists: MaloumChatListItem[];
  selectedIds: string[];
  disabledIds: string[];
  loading?: boolean;
  onToggle: (id: string) => void;
  onLoadMore?: () => void;
}) {
  const managedRanks = useMemo(() => buildManagedListRanks(lists), [lists]);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden flex flex-col max-h-40">
      <div className="px-3 py-2 border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/50 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700 dark:text-zinc-300">
          {title}
        </span>
        <span className="text-[10px] text-gray-500">{selectedIds.length} selected</span>
      </div>
      <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5">
        {loading && lists.length === 0 && (
          <p className="text-xs text-gray-500 p-2">Loading lists…</p>
        )}
        {!loading && lists.length === 0 && (
          <p className="text-xs text-gray-500 p-2">No lists found</p>
        )}
        {lists.map((list) => {
          const selected = selectedIds.includes(list._id);
          const disabled = disabledIds.includes(list._id);
          const label = listLabel(list, managedRanks);
          return (
            <button
              key={`${title}-${list._id}`}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(list._id)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 ${
                selected
                  ? 'bg-domx-600/15 text-domx-600 dark:text-domx-400 font-medium'
                  : disabled
                    ? 'opacity-40 cursor-not-allowed text-gray-400'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-300'
              }`}
              title={label}
            >
              <span
                className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                  selected
                    ? 'bg-domx-600 border-domx-600 text-white'
                    : 'border-gray-300 dark:border-zinc-600'
                }`}
              >
                {selected && <Check className="w-2.5 h-2.5" />}
              </span>
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        {onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full py-1.5 text-[11px] text-domx-600 dark:text-domx-400 hover:underline"
          >
            Load more lists
          </button>
        )}
      </div>
    </div>
  );
}
