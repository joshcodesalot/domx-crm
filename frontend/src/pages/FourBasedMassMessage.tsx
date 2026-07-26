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
import fourBasedIcon from '@/assets/4based_icon.ico';
import { formatRelativeTime } from '@/components/fourbased/FourBasedChatPanels';
import { useStaffSync } from '@/context/StaffSyncContext';
import {
  countFourBasedMassMessageReceivers,
  deleteFourBasedMassMessage,
  fourBasedPreviewPath,
  getCreators,
  getFourBasedProfile,
  listFourBasedMassMessages,
  listFourBasedUserLists,
  listFourBasedVault,
  pickFourBasedPreviewUrl,
  resolveFourBasedMediaSrc,
  sendFourBasedMassMessage,
  translateToGerman,
  type Creator,
  type FourBasedMassMessage,
  type FourBasedMassMessageTab,
  type FourBasedUserList,
  type FourBasedVaultItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const CURRENCY_SYMBOL = '$';
const COINS_PER_DOLLAR = 121;
const PAGE_SIZE = 20;
const VAULT_PAGE_SIZE = 60;

type VaultTypeFilter = 'all' | 'image' | 'video';
type VaultPublishFilter = 'all' | 'published' | 'unpublished';

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function dollarsToCoins(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * COINS_PER_DOLLAR);
}

function vaultItemId(item: FourBasedVaultItem): string {
  return String(item._id || item.id || '');
}

function isVideoItem(item: FourBasedVaultItem | null | undefined): boolean {
  if (!item) return false;
  const type = String(item.fileStackType || item.type || '').toLowerCase();
  return type.includes('video');
}

function nearScrollEnd(target: HTMLElement, thresholdPx = 80): boolean {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= thresholdPx;
}

function massMessageId(msg: FourBasedMassMessage): string {
  return String(msg._id || msg.id || '');
}

function mediaThumbSrc(
  creatorId: string,
  providerUserId: string | null,
  fileStack: FourBasedMassMessage['file_stack'] | FourBasedVaultItem | null | undefined
): string | null {
  if (!fileStack) return null;
  const preview = pickFourBasedPreviewUrl(fileStack.preview, [
    '200x200',
    '100x100',
    '400x400',
    '500x500',
  ]);
  if (preview) return resolveFourBasedMediaSrc(creatorId, preview);
  const id = String(
    (fileStack as FourBasedVaultItem)._id ||
      (fileStack as FourBasedVaultItem).id ||
      ''
  );
  if (!providerUserId || !id) return null;
  return resolveFourBasedMediaSrc(
    creatorId,
    fourBasedPreviewPath(providerUserId, id, '200x200.jpg')
  );
}

export default function FourBasedMassMessage() {
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [providerUserId, setProviderUserId] = useState<string | null>(null);

  const [historyTab, setHistoryTab] = useState<FourBasedMassMessageTab>('sent');
  const [messages, setMessages] = useState<FourBasedMassMessage[]>([]);
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [userLists, setUserLists] = useState<FourBasedUserList[]>([]);
  const [listsOffset, setListsOffset] = useState(0);
  const [listsHasMore, setListsHasMore] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);
  const [includeIds, setIncludeIds] = useState<string[]>([]);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  const [receiverCount, setReceiverCount] = useState<number | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<FourBasedVaultItem[]>([]);
  const [vaultOffset, setVaultOffset] = useState(0);
  const [vaultHasMore, setVaultHasMore] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultLoadingMore, setVaultLoadingMore] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItems, setSelectedVaultItems] = useState<FourBasedVaultItem[]>(
    []
  );
  const [vaultTypeFilter, setVaultTypeFilter] = useState<VaultTypeFilter>('all');
  const [vaultPublishFilter, setVaultPublishFilter] =
    useState<VaultPublishFilter>('all');
  const [ppvPrice, setPpvPrice] = useState('');
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState('');

  const vaultLoadingMoreRef = useRef(false);
  const listNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const list of userLists) {
      if (list._id) map.set(list._id, list.name || 'Untitled list');
    }
    return map;
  }, [userLists]);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fourBased = list.filter((c) => c.platform === '4based');
      setCreators(fourBased);
      setSelectedCreatorId((prev) => prev || fourBased[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(
    async (opts?: { append?: boolean; tab?: FourBasedMassMessageTab }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      const tab = opts?.tab || historyTab;
      const offset = append ? messagesOffset : 0;
      if (!append) setMessagesLoading(true);
      setMessagesError(null);
      try {
        const result = await listFourBasedMassMessages(selectedCreatorId, {
          tab,
          limit: PAGE_SIZE,
          offset,
        });
        const next = Array.isArray(result.messages) ? result.messages : [];
        setMessages((prev) => (append ? [...prev, ...next] : next));
        setMessagesOffset(offset + next.length);
        setMessagesHasMore(next.length >= PAGE_SIZE);
        if (result.providerUserId) setProviderUserId(result.providerUserId);
      } catch (err) {
        setMessagesError(
          err instanceof Error ? err.message : 'Failed to load mass messages'
        );
        if (!append) {
          setMessages([]);
          setMessagesOffset(0);
          setMessagesHasMore(false);
        }
      } finally {
        setMessagesLoading(false);
      }
    },
    [selectedCreatorId, historyTab, messagesOffset]
  );

  const loadUserLists = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      const offset = append ? listsOffset : 0;
      if (!append) setListsLoading(true);
      try {
        const result = await listFourBasedUserLists(selectedCreatorId, {
          limit: 50,
          offset,
        });
        const next = Array.isArray(result.lists) ? result.lists : [];
        setUserLists((prev) => (append ? [...prev, ...next] : next));
        setListsOffset(offset + next.length);
        setListsHasMore(next.length >= 50);
      } catch {
        if (!append) {
          setUserLists([]);
          setListsOffset(0);
          setListsHasMore(false);
        }
      } finally {
        setListsLoading(false);
      }
    },
    [selectedCreatorId, listsOffset]
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
    setMessages([]);
    setMessagesOffset(0);
    setMessagesHasMore(false);
    setUserLists([]);
    setListsOffset(0);
    setListsHasMore(false);
    setIncludeIds([]);
    setExcludeIds([]);
    setDraft('');
    setSelectedVaultItems([]);
    setVaultFolders([]);
    setVaultItems([]);
    setSelectedFolder(null);
    setVaultOpen(false);
    setPpvPrice('');
    setSendError(null);
    setReceiverCount(null);
    setProviderUserId(null);
    setHistoryTab('sent');
    if (selectedCreatorId) {
      void loadMessages({ tab: 'sent' });
      void loadUserLists();
      void getFourBasedProfile(selectedCreatorId)
        .then((result) => {
          if (result.providerUserId) setProviderUserId(result.providerUserId);
          const folders = Array.isArray(result.profile?.folders)
            ? result.profile.folders.filter(
                (f): f is string => typeof f === 'string' && f.trim().length > 0
              )
            : [];
          setVaultFolders(folders);
        })
        .catch(() => {
          setVaultFolders([]);
        });
    }
    // Intentionally only when creator changes — avoid reloading on tab/offset churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCreatorId]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    setMessages([]);
    setMessagesOffset(0);
    setMessagesHasMore(false);
    void loadMessages({ tab: historyTab });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyTab]);

  useEffect(() => {
    if (!selectedCreatorId) {
      setReceiverCount(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void countFourBasedMassMessageReceivers(selectedCreatorId, {
        includeUserList: includeIds,
        excludeUserList: excludeIds,
      })
        .then((result) => {
          if (!cancelled) setReceiverCount(result.count);
        })
        .catch(() => {
          if (!cancelled) setReceiverCount(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedCreatorId, includeIds, excludeIds]);

  const buildVaultOptions = useCallback(
    (filters: {
      folder: string | null;
      type: VaultTypeFilter;
      publish: VaultPublishFilter;
      offset?: number;
    }) => {
      const options: {
        limit: number;
        offset: number;
        folder?: string;
        fileType?: 'image' | 'video';
        lastPublished?: boolean;
      } = {
        limit: VAULT_PAGE_SIZE,
        offset: filters.offset ?? 0,
      };
      if (filters.folder) options.folder = filters.folder;
      if (filters.type === 'image' || filters.type === 'video') {
        options.fileType = filters.type;
      }
      if (filters.publish === 'published') options.lastPublished = true;
      else if (filters.publish === 'unpublished') options.lastPublished = false;
      return options;
    },
    []
  );

  const loadVaultItems = useCallback(
    async (options?: {
      folder?: string | null;
      type?: VaultTypeFilter;
      publish?: VaultPublishFilter;
      append?: boolean;
      offset?: number;
    }) => {
      if (!selectedCreatorId) return;
      const folder =
        options?.folder !== undefined ? options.folder : selectedFolder;
      const type = options?.type !== undefined ? options.type : vaultTypeFilter;
      const publish =
        options?.publish !== undefined ? options.publish : vaultPublishFilter;
      const append = Boolean(options?.append);
      const offset = options?.offset ?? 0;

      if (append) {
        if (vaultLoadingMoreRef.current || !vaultHasMore) return;
        vaultLoadingMoreRef.current = true;
        setVaultLoadingMore(true);
      } else {
        setVaultLoading(true);
        setVaultError(null);
      }

      try {
        const result = await listFourBasedVault(
          selectedCreatorId,
          null,
          buildVaultOptions({ folder, type, publish, offset })
        );
        const items = Array.isArray(result.items) ? result.items : [];
        if (append) {
          setVaultItems((prev) => {
            const seen = new Set(prev.map((item) => vaultItemId(item)).filter(Boolean));
            const merged = [...prev];
            for (const item of items) {
              const id = vaultItemId(item);
              if (!id || seen.has(id)) continue;
              seen.add(id);
              merged.push(item);
            }
            return merged;
          });
        } else {
          setVaultItems(items);
        }
        setVaultOffset(offset + items.length);
        setVaultHasMore(items.length >= VAULT_PAGE_SIZE);
        if (result.providerUserId) setProviderUserId(result.providerUserId);
      } catch (err) {
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
        if (!append) {
          setVaultItems([]);
          setVaultOffset(0);
          setVaultHasMore(false);
        }
      } finally {
        if (append) {
          vaultLoadingMoreRef.current = false;
          setVaultLoadingMore(false);
        } else {
          setVaultLoading(false);
        }
      }
    },
    [
      selectedCreatorId,
      selectedFolder,
      vaultTypeFilter,
      vaultPublishFilter,
      vaultHasMore,
      buildVaultOptions,
    ]
  );

  const openVault = useCallback(async () => {
    if (!selectedCreatorId) return;
    setVaultOpen(true);
    setVaultTypeFilter('all');
    setVaultPublishFilter('all');
    setSelectedFolder(null);
    setVaultItems([]);
    setVaultOffset(0);
    setVaultHasMore(false);
    await loadVaultItems({
      folder: null,
      type: 'all',
      publish: 'all',
      offset: 0,
    });
  }, [selectedCreatorId, loadVaultItems]);

  const applyVaultFilters = useCallback(
    async (next: {
      folder?: string | null;
      type?: VaultTypeFilter;
      publish?: VaultPublishFilter;
    }) => {
      const folder = next.folder !== undefined ? next.folder : selectedFolder;
      const type = next.type !== undefined ? next.type : vaultTypeFilter;
      const publish =
        next.publish !== undefined ? next.publish : vaultPublishFilter;
      if (next.folder !== undefined) setSelectedFolder(next.folder);
      if (next.type !== undefined) setVaultTypeFilter(next.type);
      if (next.publish !== undefined) setVaultPublishFilter(next.publish);
      setVaultOffset(0);
      setVaultHasMore(false);
      await loadVaultItems({ folder, type, publish, offset: 0 });
    },
    [selectedFolder, vaultTypeFilter, vaultPublishFilter, loadVaultItems]
  );

  const handleVaultMediaScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!nearScrollEnd(event.currentTarget, 240)) return;
      void loadVaultItems({ append: true, offset: vaultOffset });
    },
    [loadVaultItems, vaultOffset]
  );

  const toggleVaultItem = useCallback((item: FourBasedVaultItem) => {
    const id = vaultItemId(item);
    if (!id) return;
    setSelectedVaultItems((prev) => {
      const exists = prev.some((entry) => vaultItemId(entry) === id);
      if (exists) return prev.filter((entry) => vaultItemId(entry) !== id);
      return [...prev, item];
    });
  }, []);

  const toggleList = useCallback((listId: string, mode: 'include' | 'exclude') => {
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
  }, []);

  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!selectedCreatorId || deletingId) return;
      if (!window.confirm('Unsend this mass message? Recipients will no longer see it.')) {
        return;
      }
      setDeletingId(messageId);
      try {
        await deleteFourBasedMassMessage(selectedCreatorId, messageId);
        setMessages((prev) => prev.filter((m) => massMessageId(m) !== messageId));
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to delete mass message');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId]
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

      const vaults = selectedVaultItems
        .map((item, index) => {
          const id = vaultItemId(item);
          if (!id) return null;
          return {
            id,
            guid: String(item.guid || crypto.randomUUID()),
            position: index,
            is_teaser: false,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      const dollars = Number(ppvPrice) || 0;
      const priceCoins =
        vaults.length > 0 && dollars > 0 ? dollarsToCoins(dollars) : 0;

      await sendFourBasedMassMessage(selectedCreatorId, {
        message: textToSend,
        includeUserList: includeIds,
        excludeUserList: excludeIds,
        vaults: vaults.length > 0 ? vaults : undefined,
        priceCoins: priceCoins > 0 ? priceCoins : undefined,
      });

      setDraft('');
      setSelectedVaultItems([]);
      setPpvPrice('');
      setPriceDraft('');
      setHistoryTab('sent');
      setMessages([]);
      setMessagesOffset(0);
      await loadMessages({ tab: 'sent' });
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
    loadMessages,
  ]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
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
              No 4based creators yet. Connect one from Manage Creators.
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
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-rose-500 to-orange-400"
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
                <div className="w-9 h-9 rounded-xl bg-4based-500/15 flex items-center justify-center border border-4based-500/30">
                  <Megaphone className="w-4 h-4 text-4based-500" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Mass messages
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Sent and Unsent (deleted). No scheduling.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-zinc-800 p-0.5 bg-gray-50 dark:bg-zinc-900/60">
                  {(
                    [
                      { id: 'sent' as const, label: 'Sent' },
                      { id: 'unsent' as const, label: 'Unsent' },
                    ]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setHistoryTab(tab.id)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                        historyTab === tab.id
                          ? 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void loadMessages({ tab: historyTab })}
                  className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                  title="Refresh"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${messagesLoading ? 'animate-spin' : ''}`}
                  />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {messagesLoading && messages.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {messagesError && (
                <p className="text-sm text-red-400">{messagesError}</p>
              )}
              {!messagesLoading && !messagesError && messages.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  {historyTab === 'unsent'
                    ? 'No unsent (deleted) mass messages.'
                    : 'No mass messages yet.'}
                </p>
              )}
              {messages.map((msg) => {
                const id = massMessageId(msg);
                const when = formatRelativeTime(
                  msg.processing_finished_at || msg.created_at || msg.updated_at
                );
                const priceCoins = Number(msg.file_stack?.price) || 0;
                const fileStack = msg.file_stack;
                const video = fileStack
                  ? String(fileStack.fileStackType || fileStack.type || '')
                      .toLowerCase()
                      .includes('video')
                  : false;
                const thumb = selectedCreatorId
                  ? mediaThumbSrc(selectedCreatorId, providerUserId, fileStack)
                  : null;
                const includeNames = (msg.include_user_list || [])
                  .map((listId) => listNameById.get(listId) || listId)
                  .filter(Boolean);
                return (
                  <article
                    key={id}
                    className={`rounded-2xl border p-4 ${
                      historyTab === 'unsent'
                        ? 'border-gray-200 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-900/40 opacity-70'
                        : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                          {msg.message || (
                            <span className="text-gray-400 italic">No text</span>
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-500 dark:text-zinc-500">
                          {when && <span>{when}</span>}
                          {historyTab === 'unsent' && (
                            <span className="text-red-400 font-medium">Unsent</span>
                          )}
                          {priceCoins > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-4based-500/15 text-4based-500 font-semibold">
                              <Lock className="w-3 h-3" />
                              {CURRENCY_SYMBOL}
                              {(priceCoins / COINS_PER_DOLLAR).toFixed(2)}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {msg.recipient_count ?? 0} recipients
                          </span>
                          <span>{msg.viewed_count ?? 0} views</span>
                        </div>
                        {includeNames.length > 0 && (
                          <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-500 truncate">
                            Include: {includeNames.join(', ')}
                          </p>
                        )}
                      </div>
                      {historyTab === 'sent' && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(id)}
                          disabled={deletingId === id}
                          className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                          title="Unsend mass message"
                        >
                          {deletingId === id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                    {fileStack && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        <div className="w-14 h-14 rounded-lg overflow-hidden border border-gray-200 dark:border-zinc-700 relative bg-gray-100 dark:bg-zinc-800">
                          {thumb ? (
                            <img
                              src={thumb}
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
                      </div>
                    )}
                  </article>
                );
              })}
              {messagesHasMore && (
                <button
                  type="button"
                  onClick={() => void loadMessages({ append: true, tab: historyTab })}
                  disabled={messagesLoading}
                  className="w-full py-2 text-sm text-4based-500 hover:underline disabled:opacity-40"
                >
                  {messagesLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>

            <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-950 p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <ListPicker
                  title="Include lists"
                  lists={userLists}
                  selectedIds={includeIds}
                  disabledIds={excludeIds}
                  loading={listsLoading}
                  onToggle={(id) => toggleList(id, 'include')}
                  onLoadMore={
                    listsHasMore
                      ? () => void loadUserLists({ append: true })
                      : undefined
                  }
                />
                <ListPicker
                  title="Exclude lists"
                  lists={userLists}
                  selectedIds={excludeIds}
                  disabledIds={includeIds}
                  loading={listsLoading}
                  onToggle={(id) => toggleList(id, 'exclude')}
                  onLoadMore={
                    listsHasMore
                      ? () => void loadUserLists({ append: true })
                      : undefined
                  }
                />
              </div>

              {receiverCount != null && (
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  About {receiverCount.toLocaleString()} recipients
                </p>
              )}

              {selectedVaultItems.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex gap-2 flex-wrap flex-1 min-w-0">
                    {selectedVaultItems.map((item) => {
                      const id = vaultItemId(item);
                      const src = selectedCreatorId
                        ? mediaThumbSrc(selectedCreatorId, providerUserId, item)
                        : null;
                      return (
                        <button
                          key={id || 'chip'}
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
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-4based-500/40 bg-4based-500/10 text-sm font-semibold text-4based-500"
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
                        className="text-sm font-medium text-4based-500"
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

              <div className="flex items-end gap-2 bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-2xl p-2 focus-within:border-4based-500/50">
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
                  className="p-3 rounded-xl bg-4based-500 text-white hover:opacity-90 shadow-lg shadow-4based-500/20 shrink-0 disabled:opacity-40"
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
                <div className="w-10 h-10 rounded-xl bg-4based-500/15 flex items-center justify-center border border-4based-500/30">
                  <Box className="w-5 h-5 text-4based-500" />
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
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-4based-500 text-white hover:opacity-90"
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

            <div className="shrink-0 border-b border-gray-200 dark:border-zinc-800/60 space-y-2 p-3">
              <div className="flex gap-2 overflow-x-auto">
                {(
                  [
                    { id: 'all' as const, label: 'All' },
                    { id: 'video' as const, label: 'Videos', icon: Video },
                    { id: 'image' as const, label: 'Images', icon: ImageIcon },
                  ] as const
                ).map((chip) => {
                  const active = vaultTypeFilter === chip.id;
                  const Icon = 'icon' in chip ? chip.icon : null;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => void applyVaultFilters({ type: chip.id })}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                        active
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {Icon && <Icon className="w-3 h-3" />}
                      {chip.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {(
                  [
                    { id: 'all' as const, label: 'All' },
                    { id: 'published' as const, label: 'Published' },
                    { id: 'unpublished' as const, label: 'Unpublished' },
                  ] as const
                ).map((chip) => {
                  const active = vaultPublishFilter === chip.id;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => void applyVaultFilters({ publish: chip.id })}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {chip.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => void applyVaultFilters({ folder: null })}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                    selectedFolder == null
                      ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                      : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800'
                  }`}
                >
                  All folders
                </button>
                {vaultFolders.map((folder) => {
                  const active = selectedFolder === folder;
                  return (
                    <button
                      key={folder}
                      type="button"
                      onClick={() => void applyVaultFilters({ folder })}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {folder}
                    </button>
                  );
                })}
              </div>
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
              {!vaultLoading && !vaultError && vaultItems.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-12">
                  No media available
                </p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {vaultItems.map((item) => {
                  const id = vaultItemId(item);
                  const src = selectedCreatorId
                    ? mediaThumbSrc(selectedCreatorId, providerUserId, item)
                    : null;
                  const selected = selectedVaultItems.some(
                    (entry) => vaultItemId(entry) === id
                  );
                  const video = isVideoItem(item);
                  return (
                    <button
                      key={id || src || 'item'}
                      type="button"
                      onClick={() => toggleVaultItem(item)}
                      className={`relative aspect-square rounded-xl overflow-hidden ${
                        selected
                          ? 'ring-2 ring-4based-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950'
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
                        <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-4based-500 text-white flex items-center justify-center">
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
              {vaultHasMore && (
                <button
                  type="button"
                  onClick={() => void loadVaultItems({ append: true, offset: vaultOffset })}
                  disabled={vaultLoadingMore}
                  className="w-full mt-4 py-2.5 text-sm font-medium text-4based-500 hover:underline disabled:opacity-40"
                >
                  {vaultLoadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
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
              className="w-full py-3 rounded-xl bg-4based-500 hover:opacity-90 disabled:opacity-40 text-white font-bold"
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
  lists: FourBasedUserList[];
  selectedIds: string[];
  disabledIds: string[];
  loading?: boolean;
  onToggle: (id: string) => void;
  onLoadMore?: () => void;
}) {
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
          const label = list.name || 'Untitled list';
          return (
            <button
              key={`${title}-${list._id}`}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(list._id)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 ${
                selected
                  ? 'bg-4based-500/15 text-4based-500 font-medium'
                  : disabled
                    ? 'opacity-40 cursor-not-allowed text-gray-400'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-300'
              }`}
              title={label}
            >
              <span
                className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                  selected
                    ? 'bg-4based-500 border-4based-500 text-white'
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
            className="w-full py-1.5 text-[11px] text-4based-500 hover:underline"
          >
            Load more lists
          </button>
        )}
      </div>
    </div>
  );
}
