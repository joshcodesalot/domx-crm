import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Loader2,
  Pin,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useStaffSync } from '@/context/StaffSyncContext';
import fourBasedIcon from '@/assets/4based_icon.ico';
import {
  fourBasedMediaUrl,
  fourBasedPreviewPath,
  getCreators,
  getFourBasedChat,
  getFourBasedCoinPackages,
  getFourBasedMessages,
  getFourBasedProfile,
  getFourBasedUser,
  listFourBasedChats,
  listFourBasedVault,
  sendFourBasedMessage,
  sendFourBasedPpv,
  type Creator,
  type FourBasedChat,
  type FourBasedChatUser,
  type FourBasedCoinPackage,
  type FourBasedMessage,
  type FourBasedUserProfile,
  type FourBasedVaultItem,
} from '@/lib/api';

type FanInfo = {
  id: string;
  name: string;
  avatarUrl: string | null;
  isOnline: boolean;
  verified: boolean;
  trustedUser: boolean;
  isCreator: boolean;
};

function fanFromChat(
  chat: FourBasedChat,
  providerUserId: string | null
): FanInfo {
  const other: FourBasedChatUser | undefined =
    chat.users?.find((u) => u._id && u._id !== providerUserId) ||
    chat.users?.[0];
  const fanId =
    other?._id ||
    chat.user_ids?.find((id) => id !== providerUserId) ||
    chat.user_ids?.[0] ||
    '';
  const avatarUrl =
    other?.avatar?.preview?.['100x100'] ||
    other?.avatar?.preview?.['80x80'] ||
    other?.avatar?.preview?.['60x60'] ||
    null;
  return {
    id: fanId,
    name: other?.name || fanId.slice(0, 8) || 'Fan',
    avatarUrl,
    isOnline: Boolean(other?.is_online),
    verified: Boolean(other?.verified),
    trustedUser: Boolean(other?.trusted_user),
    isCreator: Boolean(other?.creator),
  };
}

function formatTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} ${day === 1 ? 'day' : 'days'} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} ${month === 1 ? 'month' : 'months'} ago`;
  const year = Math.floor(month / 12);
  return `${year} ${year === 1 ? 'year' : 'years'} ago`;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSpent(salesVolume?: number): string | null {
  if (typeof salesVolume !== 'number' || salesVolume === 0) return null;
  const rounded =
    Math.abs(salesVolume) >= 100
      ? salesVolume.toFixed(0)
      : salesVolume.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}$`;
}

function spentBadgeClass(salesVolume?: number): string {
  if (typeof salesVolume !== 'number') return 'bg-emerald-600 text-white';
  if (salesVolume > 50000) return 'bg-amber-400 text-black';
  if (salesVolume > 10000) return 'bg-slate-300 text-black';
  return 'bg-emerald-600 text-white';
}

function vaultItemId(item: FourBasedVaultItem): string {
  return String(item._id || item.id || '');
}

function vaultItemGuid(item: FourBasedVaultItem): string {
  return String(item.guid || crypto.randomUUID());
}

function isVideoItem(item: FourBasedVaultItem | null | undefined): boolean {
  if (!item) return false;
  const type = String(item.fileStackType || item.type || '').toLowerCase();
  return type.includes('video');
}

function itemHasTag(item: FourBasedVaultItem, folder: string): boolean {
  const tag = item.tag;
  if (Array.isArray(tag)) return tag.includes(folder);
  if (typeof tag === 'string') return tag === folder;
  return false;
}

/** Rough dollars -> coins using packages when available; else ~121 coins per $1 from HAR ($10 = 1210). */
function dollarsToCoins(
  dollars: number,
  packages: FourBasedCoinPackage[]
): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  if (packages.length > 0) {
    const withBoth = packages.filter(
      (p) => typeof p.coins === 'number' && typeof p.price === 'number' && p.price > 0
    );
    if (withBoth.length > 0) {
      const rates = withBoth.map((p) => (p.coins as number) / (p.price as number));
      const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
      return Math.round(dollars * avg);
    }
  }
  return Math.round(dollars * 121);
}

function FanAvatar({
  name,
  avatarUrl,
  isOnline,
  size = 'md',
}: {
  name: string;
  avatarUrl: string | null;
  isOnline?: boolean;
  size?: 'sm' | 'md';
}) {
  const dim = size === 'sm' ? 'w-10 h-10' : 'w-9 h-9';
  const initials = (name || '?').slice(0, 1).toUpperCase();
  return (
    <div className={`relative shrink-0 ${dim}`}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className={`${dim} rounded-full object-cover bg-gray-200 dark:bg-white/10`}
        />
      ) : (
        <div
          className={`${dim} rounded-full bg-blue-900 text-blue-200 flex items-center justify-center text-sm font-semibold`}
        >
          {initials}
        </div>
      )}
      {isOnline && (
        <span className="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white dark:border-[#0a0a0a]" />
      )}
    </div>
  );
}

export default function Chatter4Based() {
  const { onSyncEvent } = useStaffSync();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [providerUserId, setProviderUserId] = useState<string | null>(null);
  const [chats, setChats] = useState<FourBasedChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  const [messages, setMessages] = useState<FourBasedMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const [fanProfile, setFanProfile] = useState<FourBasedUserProfile | null>(null);
  const [fanProfileLoading, setFanProfileLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultItems, setVaultItems] = useState<FourBasedVaultItem[]>([]);
  const [vaultFolders, setVaultFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FourBasedVaultItem | null>(null);
  const [selectedVaultItem, setSelectedVaultItem] = useState<FourBasedVaultItem | null>(
    null
  );
  const [ppvDollars, setPpvDollars] = useState('10');
  const [coinPackages, setCoinPackages] = useState<FourBasedCoinPackage[]>([]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const selectedCreatorIdRef = useRef<string | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );
  const selectedChat = useMemo(
    () => chats.find((c) => c._id === selectedChatId) || null,
    [chats, selectedChatId]
  );
  const fan = useMemo(
    () =>
      selectedChat
        ? fanFromChat(selectedChat, providerUserId)
        : {
            id: '',
            name: '',
            avatarUrl: null,
            isOnline: false,
            verified: false,
            trustedUser: false,
            isCreator: false,
          },
    [selectedChat, providerUserId]
  );

  const sortedChats = useMemo(() => {
    return [...chats].sort((a, b) => {
      const pinA = a.is_pinned ? 1 : 0;
      const pinB = b.is_pinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      const ta = a.last_real_message_updated_at || a.updated_at || '';
      const tb = b.last_real_message_updated_at || b.updated_at || '';
      return tb.localeCompare(ta);
    });
  }, [chats]);

  const priceCoins = dollarsToCoins(Number(ppvDollars) || 0, coinPackages);

  const fanIsOnline =
    fanProfile?.is_online != null ? Boolean(fanProfile.is_online) : fan.isOnline;
  const fanLastOnline =
    fanProfile?.last_activity_date ||
    fanProfile?.last_seen_at ||
    fanProfile?.last_login ||
    null;
  const fanVerified =
    fanProfile?.verified != null ? Boolean(fanProfile.verified) : fan.verified;

  useEffect(() => {
    selectedCreatorIdRef.current = selectedCreatorId;
  }, [selectedCreatorId]);

  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCreatorsLoading(true);
      try {
        const { creators: list } = await getCreators();
        if (cancelled) return;
        const fourBased = list.filter((c) => c.platform === '4based');
        setCreators(fourBased);
        if (fourBased.length > 0) {
          setSelectedCreatorId((prev) => prev || fourBased[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setChatsError(err instanceof Error ? err.message : 'Failed to load creators');
        }
      } finally {
        if (!cancelled) setCreatorsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadChats = useCallback(async (creatorId: string, silent = false) => {
    if (!silent) {
      setChatsLoading(true);
      setChatsError(null);
    }
    try {
      const result = await listFourBasedChats(creatorId, { limit: 50 });
      if (selectedCreatorIdRef.current !== creatorId) return;
      setChats(Array.isArray(result.chats) ? result.chats : []);
      setProviderUserId(result.providerUserId || null);
    } catch (err) {
      if (!silent && selectedCreatorIdRef.current === creatorId) {
        setChatsError(err instanceof Error ? err.message : 'Failed to load chats');
        setChats([]);
      }
    } finally {
      if (!silent && selectedCreatorIdRef.current === creatorId) {
        setChatsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedCreatorId) return;
    setSelectedChatId(null);
    setMessages([]);
    setFanProfile(null);
    setSelectedVaultItem(null);
    setVaultFolders([]);
    setSelectedFolder(null);
    void loadChats(selectedCreatorId);
    void getFourBasedCoinPackages(selectedCreatorId)
      .then((r) => setCoinPackages(r.packages || []))
      .catch(() => setCoinPackages([]));
    void getFourBasedProfile(selectedCreatorId)
      .then((r) => {
        const folders = Array.isArray(r.profile?.folders)
          ? r.profile.folders.filter((f): f is string => typeof f === 'string')
          : [];
        setVaultFolders(folders);
        if (r.providerUserId) setProviderUserId(r.providerUserId);
      })
      .catch(() => setVaultFolders([]));
  }, [selectedCreatorId, loadChats]);

  const loadMessages = useCallback(
    async (creatorId: string, chatId: string, silent = false) => {
      if (!silent) {
        setMessagesLoading(true);
        setMessagesError(null);
      }
      try {
        if (!silent) {
          await getFourBasedChat(creatorId, chatId);
        }
        const result = await getFourBasedMessages(creatorId, chatId, { limit: 40 });
        if (
          selectedCreatorIdRef.current !== creatorId ||
          selectedChatIdRef.current !== chatId
        ) {
          return;
        }
        const list = Array.isArray(result.messages) ? result.messages : [];
        // API returns newest first
        setMessages([...list].reverse());
        if (result.providerUserId) {
          setProviderUserId(result.providerUserId);
        }
      } catch (err) {
        if (
          !silent &&
          selectedCreatorIdRef.current === creatorId &&
          selectedChatIdRef.current === chatId
        ) {
          setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
          setMessages([]);
        }
      } finally {
        if (
          !silent &&
          selectedCreatorIdRef.current === creatorId &&
          selectedChatIdRef.current === chatId
        ) {
          setMessagesLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedCreatorId || !selectedChatId) return;
    void loadMessages(selectedCreatorId, selectedChatId);
  }, [selectedCreatorId, selectedChatId, loadMessages]);

  useEffect(() => {
    if (!selectedCreatorId || !fan.id) {
      setFanProfile(null);
      return;
    }
    let cancelled = false;
    setFanProfileLoading(true);
    void getFourBasedUser(selectedCreatorId, fan.id)
      .then((r) => {
        if (!cancelled) setFanProfile(r.user || null);
      })
      .catch(() => {
        if (!cancelled) setFanProfile(null);
      })
      .finally(() => {
        if (!cancelled) setFanProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCreatorId, fan.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== '4based:event') return;
      if (!selectedCreatorId || event.creatorId !== selectedCreatorId) return;
      void loadChats(selectedCreatorId, true);
      if (selectedChatId) {
        void loadMessages(selectedCreatorId, selectedChatId, true);
      }
    });
  }, [onSyncEvent, selectedCreatorId, selectedChatId, loadChats, loadMessages]);

  // Silent 5s refresh — keeps going even when panel is hidden (never unloads)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const creatorId = selectedCreatorIdRef.current;
      if (!creatorId) return;
      void loadChats(creatorId, true);
      const chatId = selectedChatIdRef.current;
      if (chatId) {
        void loadMessages(creatorId, chatId, true);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadChats, loadMessages]);

  async function handleSendText() {
    if (!selectedCreatorId || !selectedChatId || sending) return;
    const text = draft.trim();
    if (!text && !selectedVaultItem) return;

    setSending(true);
    setSendError(null);
    const localId = crypto.randomUUID();

    try {
      if (selectedVaultItem) {
        const vaultId = vaultItemId(selectedVaultItem);
        const dollars = Number(ppvDollars) || 0;
        await sendFourBasedPpv(selectedCreatorId, selectedChatId, {
          message: text || selectedVaultItem.description || '',
          vaultId,
          vaultGuid: vaultItemGuid(selectedVaultItem),
          priceCoins: dollars > 0 ? priceCoins : 0,
          localId,
        });
        setSelectedVaultItem(null);
        setPpvDollars('10');
      } else {
        await sendFourBasedMessage(selectedCreatorId, selectedChatId, {
          message: text,
          localId,
        });
      }
      setDraft('');
      await loadMessages(selectedCreatorId, selectedChatId, true);
      await loadChats(selectedCreatorId, true);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  async function loadVaultItems(folder: string | null) {
    if (!selectedCreatorId || !fan.id) return;
    setVaultLoading(true);
    setVaultError(null);
    try {
      const result = await listFourBasedVault(selectedCreatorId, fan.id, {
        limit: 60,
        ...(folder ? { tag: folder } : {}),
      });
      let items = Array.isArray(result.items) ? result.items : [];
      // Client-side fallback if server ignored the tag filter
      if (folder && items.length > 0 && items.every((it) => !itemHasTag(it, folder))) {
        // Keep server result as-is when tags are empty (common); trust server filter
      } else if (folder) {
        const tagged = items.filter((it) => itemHasTag(it, folder));
        if (tagged.length > 0) items = tagged;
      }
      setVaultItems(items);
      if (result.providerUserId) setProviderUserId(result.providerUserId);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
      setVaultItems([]);
    } finally {
      setVaultLoading(false);
    }
  }

  async function openVault() {
    if (!selectedCreatorId || !fan.id) {
      setVaultError('Open a conversation first to browse vault for that fan.');
      setVaultOpen(true);
      return;
    }
    setVaultOpen(true);
    setPreviewItem(null);
    setSelectedFolder(null);

    if (vaultFolders.length === 0) {
      try {
        const r = await getFourBasedProfile(selectedCreatorId);
        const folders = Array.isArray(r.profile?.folders)
          ? r.profile.folders.filter((f): f is string => typeof f === 'string')
          : [];
        setVaultFolders(folders);
      } catch {
        // keep empty
      }
    }

    await loadVaultItems(null);
  }

  async function selectVaultFolder(folder: string | null) {
    setSelectedFolder(folder);
    setPreviewItem(null);
    await loadVaultItems(folder);
  }

  function mediaSrcForVaultItem(item: FourBasedVaultItem, size = '500x500.jpg'): string | null {
    if (!selectedCreatorId || !providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    return fourBasedMediaUrl(
      selectedCreatorId,
      fourBasedPreviewPath(providerUserId, id, size)
    );
  }

  function fullMediaSrc(item: FourBasedVaultItem): string | null {
    if (!selectedCreatorId || !providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    if (isVideoItem(item)) {
      return fourBasedMediaUrl(
        selectedCreatorId,
        `protected/${providerUserId}/${id}/preview/900xxx.jpg`
      );
    }
    return fourBasedMediaUrl(
      selectedCreatorId,
      fourBasedPreviewPath(providerUserId, id, '900xxx.jpg')
    );
  }

  function videoStreamSrc(item: FourBasedVaultItem): string | null {
    if (!selectedCreatorId || !providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    return fourBasedMediaUrl(
      selectedCreatorId,
      `protected/${providerUserId}/${id}/file.mp4`
    );
  }

  function messageMediaUrl(msg: FourBasedMessage): string | null {
    if (!selectedCreatorId || !providerUserId || !msg.file_stack?._id) return null;
    return fourBasedMediaUrl(
      selectedCreatorId,
      fourBasedPreviewPath(providerUserId, msg.file_stack._id, '500x500.jpg')
    );
  }

  return (
    <div className="bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 h-screen flex antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <main className="flex-1 flex min-w-0 overflow-hidden">
        {/* Creators column */}
        <aside className="w-56 border-r border-gray-200 dark:border-white/10 flex flex-col shrink-0">
          <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center gap-2">
            <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
            <span className="text-sm font-medium">4based</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {creatorsLoading && (
              <p className="text-xs text-gray-500 p-3">Loading creators…</p>
            )}
            {!creatorsLoading && creators.length === 0 && (
              <p className="text-xs text-gray-500 p-3">
                No 4based creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-2 p-2 rounded-lg text-left transition-colors ${
                  selectedCreatorId === creator.id
                    ? 'bg-brand-50 dark:bg-brand-900/20 border border-brand-200 dark:border-brand-800'
                    : 'hover:bg-gray-50 dark:hover:bg-white/5 border border-transparent'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={creator.avatarUrl}
                  displayName={creator.displayName}
                  className="w-8 h-8 rounded-full object-cover shrink-0"
                  initialsClassName="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium shrink-0"
                />
                <span className="text-sm truncate">{creator.displayName}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* Conversations */}
        <aside className="w-80 border-r border-gray-200 dark:border-white/10 flex flex-col shrink-0">
          <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">
              {selectedCreator?.displayName || 'Chats'}
            </span>
            <button
              type="button"
              onClick={() => {
                if (!selectedCreatorId || chatsLoading) return;
                void loadChats(selectedCreatorId);
                if (selectedChatId) {
                  void loadMessages(selectedCreatorId, selectedChatId);
                }
              }}
              disabled={!selectedCreatorId || chatsLoading}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-40"
              title="Refresh chats"
              aria-label="Refresh chats"
            >
              {chatsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {chatsError && (
              <p className="text-xs text-red-600 dark:text-red-400 p-3">{chatsError}</p>
            )}
            {!chatsLoading && !chatsError && chats.length === 0 && selectedCreatorId && (
              <p className="text-xs text-gray-500 p-3">No conversations yet.</p>
            )}
            {sortedChats.map((chat) => {
              const peer = fanFromChat(chat, providerUserId);
              const active = chat._id === selectedChatId;
              const spent = formatSpent(chat.sales_volume);
              const relative = formatRelativeTime(
                chat.last_message?.created_at ||
                  chat.last_real_message_updated_at ||
                  chat.updated_at
              );
              return (
                <button
                  key={chat._id}
                  type="button"
                  onClick={() => setSelectedChatId(chat._id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-white/5 transition-colors ${
                    active
                      ? 'bg-brand-50 dark:bg-brand-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <FanAvatar
                      name={peer.name}
                      avatarUrl={peer.avatarUrl}
                      isOnline={peer.isOnline}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-medium truncate">{peer.name}</span>
                        {peer.verified && !peer.isCreator && (
                          <span
                            title="Trusted user — verified payment"
                            className="shrink-0 text-amber-400"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <span title="Fan" className="shrink-0 text-gray-400">
                          <User className="w-3 h-3" />
                        </span>
                        {spent && (
                          <span
                            className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${spentBadgeClass(
                              chat.sales_volume
                            )}`}
                          >
                            {spent}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1 shrink-0">
                          {(chat.unread_message_count || 0) > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white">
                              {chat.unread_message_count}
                            </span>
                          )}
                          {chat.is_pinned && (
                            <Pin className="w-3.5 h-3.5 text-red-500 fill-red-500" />
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                        {chat.last_message?.message || '—'}
                      </p>
                      {relative && (
                        <p className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">
                          {relative}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Thread */}
        <section className="flex-1 flex flex-col min-w-0">
          <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 min-w-0">
            {selectedChat ? (
              <>
                <FanAvatar
                  name={fan.name}
                  avatarUrl={fan.avatarUrl}
                  isOnline={fanIsOnline}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium truncate">{fan.name}</span>
                    {fanVerified && !fan.isCreator && (
                      <span
                        title="Trusted user — verified payment"
                        className="shrink-0 text-amber-400"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                      </span>
                    )}
                    <span title="Fan" className="shrink-0 text-gray-400">
                      <User className="w-3 h-3" />
                    </span>
                    {formatSpent(selectedChat.sales_volume) && (
                      <span
                        className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${spentBadgeClass(
                          selectedChat.sales_volume
                        )}`}
                      >
                        {formatSpent(selectedChat.sales_volume)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 truncate">
                    {fanProfileLoading
                      ? '…'
                      : fanIsOnline
                        ? 'Online'
                        : fanLastOnline
                          ? `Last online ${formatRelativeTime(fanLastOnline)}`
                          : 'Offline'}
                  </p>
                </div>
              </>
            ) : (
              <span className="text-sm text-gray-500">Select a conversation</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messagesLoading && (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
              </div>
            )}
            {messagesError && (
              <p className="text-sm text-red-600 dark:text-red-400">{messagesError}</p>
            )}
            {messages.map((msg) => {
              const mine = msg.user_id === providerUserId;
              const mediaUrl = messageMediaUrl(msg);
              const price = msg.file_stack?.price;
              return (
                <div
                  key={msg._id || msg.local_id}
                  className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
                      mine
                        ? 'bg-brand-600 text-white'
                        : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {mediaUrl && (
                      <div className="mb-2 overflow-hidden rounded-lg">
                        <img
                          src={mediaUrl}
                          alt=""
                          className="max-h-48 w-full object-cover"
                        />
                        {typeof price === 'number' && price > 0 && (
                          <p
                            className={`text-xs mt-1 ${
                              mine ? 'text-white/80' : 'text-amber-600'
                            }`}
                          >
                            PPV · {price} coins
                          </p>
                        )}
                      </div>
                    )}
                    {msg.message && <p className="whitespace-pre-wrap break-words">{msg.message}</p>}
                    <p
                      className={`text-[10px] mt-1 ${
                        mine ? 'text-white/60' : 'text-gray-400'
                      }`}
                    >
                      {formatTime(msg.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {selectedVaultItem && (
            <div className="px-4 py-2 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] flex items-center gap-3">
              {mediaSrcForVaultItem(selectedVaultItem) && (
                <img
                  src={mediaSrcForVaultItem(selectedVaultItem)!}
                  alt=""
                  className="w-12 h-12 rounded object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  {selectedVaultItem.name || vaultItemId(selectedVaultItem)}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <label className="text-xs text-gray-500">Price $</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ppvDollars}
                    onChange={(e) => setPpvDollars(e.target.value)}
                    className="w-20 px-2 py-1 text-xs rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5"
                  />
                  <span className="text-xs text-gray-400">
                    ≈ {priceCoins} coins {Number(ppvDollars) > 0 ? '(PPV)' : '(free)'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedVaultItem(null)}
                className="p-1 text-gray-400 hover:text-gray-600"
                aria-label="Clear attachment"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {sendError && (
            <p className="px-4 text-xs text-red-600 dark:text-red-400">{sendError}</p>
          )}

          <div className="p-3 border-t border-gray-200 dark:border-white/10 flex items-end gap-2">
            <button
              type="button"
              onClick={() => void openVault()}
              disabled={!selectedChatId}
              className="p-2 rounded-lg border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
              title="Open vault"
            >
              <ImageIcon className="w-5 h-5" />
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSendText();
                }
              }}
              disabled={!selectedChatId || sending}
              rows={2}
              placeholder={
                selectedChatId ? 'Type a message…' : 'Select a conversation to chat'
              }
              className="flex-1 resize-none px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleSendText()}
              disabled={
                !selectedChatId ||
                sending ||
                (!draft.trim() && !selectedVaultItem)
              }
              className="p-2.5 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
              title="Send"
            >
              {sending ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </section>
      </main>

      {/* Vault modal */}
      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setVaultOpen(false);
              setPreviewItem(null);
            }}
          />
          <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col border border-gray-200 dark:border-white/10">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-white/10">
              <h3 className="font-semibold">Vault</h3>
              <button
                type="button"
                onClick={() => {
                  setVaultOpen(false);
                  setPreviewItem(null);
                }}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Folder bar */}
            <div className="px-3 py-2 border-b border-gray-100 dark:border-white/10 overflow-x-auto flex gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void selectVaultFolder(null)}
                className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                  selectedFolder === null
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5'
                }`}
              >
                All
              </button>
              {vaultFolders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => void selectVaultFolder(folder)}
                  className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors max-w-[180px] truncate ${
                    selectedFolder === folder
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                  title={folder}
                >
                  {folder}
                </button>
              ))}
            </div>

            {previewItem ? (
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <button
                  type="button"
                  onClick={() => setPreviewItem(null)}
                  className="text-sm text-brand-600"
                >
                  ← Back to grid
                </button>
                <div className="flex justify-center bg-black/5 dark:bg-black/40 rounded-lg p-2 min-h-[240px]">
                  {isVideoItem(previewItem) ? (
                    <video
                      controls
                      poster={fullMediaSrc(previewItem) || undefined}
                      src={videoStreamSrc(previewItem) || undefined}
                      className="max-h-[60vh] max-w-full rounded"
                    >
                      <track kind="captions" />
                    </video>
                  ) : (
                    fullMediaSrc(previewItem) && (
                      <img
                        src={fullMediaSrc(previewItem)!}
                        alt=""
                        className="max-h-[60vh] max-w-full rounded object-contain"
                      />
                    )
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVaultItem(previewItem);
                      setPpvDollars('0');
                      setVaultOpen(false);
                      setPreviewItem(null);
                    }}
                    className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10"
                  >
                    Attach free
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVaultItem(previewItem);
                      setPpvDollars('10');
                      setVaultOpen(false);
                      setPreviewItem(null);
                    }}
                    className="px-3 py-2 text-sm rounded-lg bg-brand-600 text-white"
                  >
                    Attach as PPV
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4">
                {vaultLoading && (
                  <div className="flex justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                )}
                {vaultError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{vaultError}</p>
                )}
                {!vaultLoading && !vaultError && vaultItems.length === 0 && (
                  <p className="text-sm text-gray-500">
                    {selectedFolder
                      ? `No media in “${selectedFolder}”.`
                      : 'Vault is empty.'}
                  </p>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                  {vaultItems.map((item) => {
                    const thumb = mediaSrcForVaultItem(item);
                    const video = isVideoItem(item);
                    return (
                      <button
                        key={vaultItemId(item)}
                        type="button"
                        onClick={() => setPreviewItem(item)}
                        className="relative aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-white/5 group"
                      >
                        {thumb ? (
                          <img
                            src={thumb}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <ImageIcon className="w-6 h-6" />
                          </div>
                        )}
                        {video && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30">
                            <Play className="w-8 h-8 text-white drop-shadow" />
                          </span>
                        )}
                        {video && item.duration != null && (
                          <span className="absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/70 text-white">
                            {formatDuration(Number(item.duration))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
