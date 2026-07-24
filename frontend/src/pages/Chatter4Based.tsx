import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Box,
  Check,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Languages,
  Loader2,
  Lock,
  MessageSquare,
  Pin,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import fourBasedIcon from '@/assets/4based_icon.ico';
import {
  createMessagingDashboardEntry,
  fourBasedMediaUrl,
  fourBasedPreviewPath,
  getCreators,
  getFourBasedBadges,
  getFourBasedChat,
  getFourBasedCoinPackages,
  getFourBasedMessages,
  getFourBasedProfile,
  getFourBasedUser,
  getMessagingDashboardSenders,
  listFourBasedChats,
  listFourBasedVault,
  sendFourBasedMessage,
  sendFourBasedPpv,
  translateToGerman,
  type Creator,
  type FourBasedChat,
  type FourBasedChatUser,
  type FourBasedCoinPackage,
  type FourBasedMessage,
  type FourBasedUserProfile,
  type FourBasedVaultItem,
  type TranslateHistoryItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const HISTORY_TRANSLATE_API_URL = 'https://translate.low7labs.cloud/translate';
const MAX_TRANSLATION_HISTORY = 8;
const BADGE_POLL_INTERVAL_MS = 30_000;

type CreatorUnreadCounts = { messages: number; notifications: number };

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function UnreadBadge({
  icon: Icon,
  count,
  label,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
}) {
  const hasUnread = count > 0;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium ${
        hasUnread ? 'text-4based-500' : 'text-zinc-500'
      }`}
      title={label}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      <span>
        {count > 99 ? '99+' : count} {hasUnread ? 'new' : ''}
      </span>
    </span>
  );
}

async function translateTextToEnglish(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const response = await fetch(HISTORY_TRANSLATE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'de',
      target: 'en',
      format: 'text',
    }),
  });
  if (!response.ok) {
    throw new Error('Translation API failed with status ' + response.status);
  }
  const data = (await response.json()) as { translatedText?: string };
  return data?.translatedText?.trim() || null;
}

function parseFourBasedMessageTime(value?: string): number | null {
  if (!value) return null;
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function computeFourBasedResponseTime(
  messages: FourBasedMessage[],
  providerUserId: string | null
): { responseTimeSeconds: number | null; previousFanMessageAt: string | null } {
  if (!providerUserId) {
    return { responseTimeSeconds: null, previousFanMessageAt: null };
  }

  let latestFanAt: number | null = null;
  let latestCreatorAt: number | null = null;

  for (const msg of messages) {
    const at = parseFourBasedMessageTime(msg.created_at);
    if (at == null) continue;
    if (msg.user_id === providerUserId) {
      if (latestCreatorAt == null || at > latestCreatorAt) latestCreatorAt = at;
    } else if (msg.user_id) {
      if (latestFanAt == null || at > latestFanAt) latestFanAt = at;
    }
  }

  if (latestFanAt == null) {
    return { responseTimeSeconds: null, previousFanMessageAt: null };
  }
  if (latestCreatorAt != null && latestFanAt <= latestCreatorAt) {
    return { responseTimeSeconds: null, previousFanMessageAt: null };
  }

  return {
    responseTimeSeconds: Math.max(0, Math.floor((Date.now() - latestFanAt) / 1000)),
    previousFanMessageAt: new Date(latestFanAt).toISOString(),
  };
}

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

/**
 * 4based stores sales_volume / PPV price in coins.
 * Website display: (coins / payment_config.tax) / 100 with tax ≈ 1.21
 * → equivalent to coins / 121 (e.g. 34484 → 284.99$, 1210 → $10.00).
 */
const COINS_PER_DOLLAR = 121;

function coinsToDollars(coins: number): number {
  if (!Number.isFinite(coins) || coins === 0) return 0;
  return coins / COINS_PER_DOLLAR;
}

/** 4based is USD-only in the chatter UI. */
function formatSpent(salesVolumeCoins?: number): string | null {
  if (typeof salesVolumeCoins !== 'number' || salesVolumeCoins === 0) return null;
  const dollars = coinsToDollars(salesVolumeCoins);
  const rounded =
    Math.abs(dollars) >= 100
      ? dollars.toFixed(0)
      : dollars.toFixed(2).replace(/\.?0+$/, '');
  return `$${rounded}`;
}

function formatPpvDollars(priceCoins?: number): string | null {
  if (typeof priceCoins !== 'number' || priceCoins <= 0) return null;
  return `$${coinsToDollars(priceCoins).toFixed(2)}`;
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

/** Dollars -> PPV coins. Prefer 121 (HAR / tax 1.21); packages are fan purchase rates (~100). */
function dollarsToCoins(
  dollars: number,
  _packages: FourBasedCoinPackage[]
): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * COINS_PER_DOLLAR);
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
  const dim = size === 'sm' ? 'w-10 h-10' : 'w-10 h-10';
  const initials = (name || '?').slice(0, 1).toUpperCase();
  return (
    <div className={`relative shrink-0 ${dim}`}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${dim} rounded-full object-cover bg-zinc-800 border border-zinc-700`}
        />
      ) : (
        <div
          className={`${dim} rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 flex items-center justify-center text-sm font-medium`}
        >
          {initials}
        </div>
      )}
      {isOnline && (
        <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-zinc-950" />
      )}
    </div>
  );
}

export default function Chatter4Based() {
  const { onSyncEvent } = useStaffSync();
  const { user } = useAuth();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [badgeCountsByCreatorId, setBadgeCountsByCreatorId] = useState<
    Record<string, CreatorUnreadCounts>
  >({});

  const [providerUserId, setProviderUserId] = useState<string | null>(null);
  const [chats, setChats] = useState<FourBasedChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  const [messages, setMessages] = useState<FourBasedMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>(
    {}
  );

  const [fanProfile, setFanProfile] = useState<FourBasedUserProfile | null>(null);
  const [fanProfileLoading, setFanProfileLoading] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);

  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const [autoTranslateHistory, setAutoTranslateHistory] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true)
  );
  /** Cache key: `${messageId}::${text}` → English translation */
  const [historyTranslations, setHistoryTranslations] = useState<
    Record<string, string>
  >({});
  const historyTranslationsRef = useRef<Record<string, string>>({});
  const historyInFlightRef = useRef<Set<string>>(new Set());

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultItems, setVaultItems] = useState<FourBasedVaultItem[]>([]);
  const [vaultFolders, setVaultFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [vaultTypeFilter, setVaultTypeFilter] = useState<'all' | 'image' | 'video'>(
    'all'
  );
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FourBasedVaultItem | null>(null);
  const [vaultPreviewPlaying, setVaultPreviewPlaying] = useState(false);
  const [selectedVaultItems, setSelectedVaultItems] = useState<FourBasedVaultItem[]>(
    []
  );
  const [ppvDollars, setPpvDollars] = useState('10');
  const [coinPackages, setCoinPackages] = useState<FourBasedCoinPackage[]>([]);
  /** Message id currently streaming video (lazy — poster only until clicked). */
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);

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
    historyTranslationsRef.current = historyTranslations;
  }, [historyTranslations]);

  const handleAutoTranslateOutgoingChange = useCallback((enabled: boolean) => {
    setAutoTranslateOutgoing(enabled);
    localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
  }, []);

  const handleAutoTranslateHistoryChange = useCallback((enabled: boolean) => {
    setAutoTranslateHistory(enabled);
    localStorage.setItem(AUTO_TRANSLATE_HISTORY_KEY, String(enabled));
  }, []);

  const closeOpenThread = useCallback(() => {
    setSelectedChatId(null);
    setMessages([]);
    setMessagesError(null);
    setMessagesLoading(false);
    setMessageSenders({});
    setDraft('');
    setSendError(null);
    setSelectedVaultItems([]);
    setPlayingMsgId(null);
    setFanProfile(null);
    setVaultOpen(false);
    setPreviewItem(null);
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyInFlightRef.current.clear();
  }, []);

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

  const refreshCreatorBadges = useCallback(async (creatorIds: string[]) => {
    if (creatorIds.length === 0) return;
    // Serialize to avoid burning concurrent ISP proxy sessions.
    const updates: Record<string, CreatorUnreadCounts> = {};
    for (const creatorId of creatorIds) {
      try {
        const badges = await getFourBasedBadges(creatorId);
        updates[creatorId] = {
          messages: Number(badges.messages) || 0,
          notifications: Number(badges.notifications) || 0,
        };
      } catch {
        // Best-effort; leave previous counts for this creator
      }
    }
    if (Object.keys(updates).length === 0) return;
    setBadgeCountsByCreatorId((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    if (creators.length === 0) return;
    const creatorIds = creators.map((c) => c.id);
    void refreshCreatorBadges(creatorIds);
    const timer = window.setInterval(() => {
      void refreshCreatorBadges(creatorIds);
    }, BADGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [creators, refreshCreatorBadges]);

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
    setSelectedVaultItems([]);
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
    setPlayingMsgId(null);
    setMessageSenders({});
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyInFlightRef.current.clear();
    void loadMessages(selectedCreatorId, selectedChatId);
    void getMessagingDashboardSenders({
      creatorId: selectedCreatorId,
      chatId: selectedChatId,
      limit: 200,
    })
      .then((result) => {
        if (
          selectedCreatorIdRef.current === selectedCreatorId &&
          selectedChatIdRef.current === selectedChatId
        ) {
          setMessageSenders(result.senders || {});
        }
      })
      .catch(() => {
        // best-effort
      });
  }, [selectedCreatorId, selectedChatId, loadMessages]);

  useEffect(() => {
    if (!autoTranslateHistory) return;
    const pending: Array<{ key: string; text: string }> = [];
    for (const msg of messages) {
      const text = typeof msg.message === 'string' ? msg.message.trim() : '';
      if (!text) continue;
      const msgKey = String(msg._id || msg.local_id || '');
      if (!msgKey) continue;
      const cacheKey = `${msgKey}::${text}`;
      if (historyTranslationsRef.current[cacheKey]) continue;
      if (historyInFlightRef.current.has(cacheKey)) continue;
      pending.push({ key: cacheKey, text });
    }
    if (pending.length === 0) return;

    let cancelled = false;
    for (const item of pending) {
      historyInFlightRef.current.add(item.key);
    }

    void (async () => {
      const updates: Record<string, string> = {};
      await Promise.all(
        pending.map(async (item) => {
          try {
            const translated = await translateTextToEnglish(item.text);
            if (translated && !cancelled) {
              updates[item.key] = translated;
            }
          } catch {
            // Best-effort; leave bubble without overlay on failure
          } finally {
            historyInFlightRef.current.delete(item.key);
          }
        })
      );
      if (cancelled || Object.keys(updates).length === 0) return;
      setHistoryTranslations((prev) => ({ ...prev, ...updates }));
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, autoTranslateHistory]);

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
      void refreshCreatorBadges([selectedCreatorId]);
      if (selectedChatId) {
        void loadMessages(selectedCreatorId, selectedChatId, true);
      }
    });
  }, [onSyncEvent, selectedCreatorId, selectedChatId, loadChats, loadMessages, refreshCreatorBadges]);

  // Silent 5s refresh — chats/messages only (badges poll separately to spare proxy sessions)
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

  function toggleVaultItem(item: FourBasedVaultItem) {
    const id = vaultItemId(item);
    if (!id) return;
    setSelectedVaultItems((prev) => {
      const exists = prev.some((entry) => vaultItemId(entry) === id);
      if (exists) {
        return prev.filter((entry) => vaultItemId(entry) !== id);
      }
      return [...prev, item];
    });
  }

  async function handleSendText() {
    if (!selectedCreatorId || !selectedChatId || sending || translatingOutgoing) return;
    const text = draft.trim();
    if (!text && selectedVaultItems.length === 0) return;

    setSending(true);
    setSendError(null);
    const localId = crypto.randomUUID();
    const englishDraft = text;
    const vaultForLog = selectedVaultItems;
    const dollarsForLog = Number(ppvDollars) || 0;
    const responseSnapshot = computeFourBasedResponseTime(messages, providerUserId);

    try {
      let messageToSend = text;

      if (autoTranslateOutgoing && text) {
        setTranslatingOutgoing(true);
        try {
          const history: TranslateHistoryItem[] = messages
            .filter((m) => typeof m.message === 'string' && m.message.trim())
            .slice(-MAX_TRANSLATION_HISTORY)
            .map((m) => ({
              role: m.user_id === providerUserId ? 'assistant' : 'user',
              content: m.message!.trim(),
            }));
          messageToSend = await translateToGerman(text, history);
        } catch (err) {
          setSendError(
            err instanceof Error ? err.message : 'Translation failed. Message was not sent.'
          );
          return;
        } finally {
          setTranslatingOutgoing(false);
        }
      }

      let sentMessage: FourBasedMessage | null = null;

      if (vaultForLog.length > 0) {
        const dollars = dollarsForLog;
        const result = await sendFourBasedPpv(selectedCreatorId, selectedChatId, {
          message: messageToSend || vaultForLog[0]?.description || '',
          vaults: vaultForLog.map((item, index) => ({
            id: vaultItemId(item),
            guid: vaultItemGuid(item),
            position: index,
            is_teaser: false,
          })),
          priceCoins: dollars > 0 ? priceCoins : 0,
          localId,
        });
        sentMessage = result.message;
        setSelectedVaultItems([]);
        setPpvDollars('10');
      } else {
        const result = await sendFourBasedMessage(selectedCreatorId, selectedChatId, {
          message: messageToSend,
          localId,
        });
        sentMessage = result.message;
      }

      if (user?.id && sentMessage?._id) {
        const pictureCount = vaultForLog.filter((item) => !isVideoItem(item)).length;
        const videoCount = vaultForLog.filter((item) => isVideoItem(item)).length;
        const hasMedia = vaultForLog.length > 0;
        const actualSent =
          messageToSend ||
          (vaultForLog[0] ? vaultForLog[0].description || '' : '') ||
          englishDraft;
        const chatterName = user.name;
        const dashboardMessageId = `4based:${sentMessage._id}`;
        setMessageSenders((prev) => ({
          ...prev,
          [dashboardMessageId]: chatterName,
          [localId]: chatterName,
        }));
        void createMessagingDashboardEntry({
          id: crypto.randomUUID(),
          creatorId: selectedCreatorId,
          creatorName: selectedCreator?.displayName,
          creatorUsername: selectedCreator?.username,
          creatorAvatarUrl: selectedCreator?.avatarUrl,
          chatterId: user.id,
          chatterName,
          chatterEmail: user.email,
          chatId: selectedChatId,
          fanId: fan.id || null,
          fanUsername: fan.name || null,
          maloumMessageId: dashboardMessageId,
          optimisticMessageId: localId,
          contentType: hasMedia ? 'chat_product' : 'text',
          englishMessage: englishDraft || actualSent || null,
          germanTranslatedMessage: actualSent || null,
          actualSentText: actualSent || null,
          priceNet: hasMedia && dollarsForLog > 0 ? dollarsForLog : null,
          currency: 'USD',
          purchased: false,
          mediaCount: vaultForLog.length,
          pictureCount,
          videoCount,
          mediaJson: hasMedia
            ? vaultForLog.map((item) => ({
                mediaId: vaultItemId(item),
                type: isVideoItem(item) ? 'video' : 'image',
              }))
            : null,
          previousFanMessageAt: responseSnapshot.previousFanMessageAt,
          responseTimeSeconds: responseSnapshot.responseTimeSeconds,
          sentAt: sentMessage.created_at || new Date().toISOString(),
        }).catch(() => {
          // Persistence failures are non-blocking for the chatter UI.
        });
      }

      setDraft('');
      await loadMessages(selectedCreatorId, selectedChatId, true);
      await loadChats(selectedCreatorId, true);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
      setTranslatingOutgoing(false);
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
    setVaultPreviewPlaying(false);
    setSelectedFolder(null);
    setVaultTypeFilter('all');

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
    setVaultPreviewPlaying(false);
    await loadVaultItems(folder);
  }

  function mediaSrcForVaultItem(item: FourBasedVaultItem, size = '200x200.jpg'): string | null {
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

  function messageMediaPath(msg: FourBasedMessage, size = '400x400.jpg'): string | null {
    if (!providerUserId || !msg.file_stack?._id) return null;
    const fs = msg.file_stack;
    const preview = fs.preview as Record<string, string> | undefined;
    const sizeKey = size.replace(/\.jpg$/i, '');
    const preferred =
      preview?.[sizeKey] ||
      preview?.['400x400'] ||
      preview?.['500x500'] ||
      preview?.['340xxx'] ||
      preview?.['200x200'];
    if (typeof preferred === 'string' && preferred.includes('/protected/')) {
      const idx = preferred.indexOf('/protected/');
      return preferred.slice(idx + 1); // strip leading slash → protected/...
    }
    const vaultId = fs.vault_file_stack_id;
    if (vaultId) {
      return `protected/${providerUserId}/${fs._id}/v/${vaultId}/preview/${size}`;
    }
    return fourBasedPreviewPath(providerUserId, fs._id, size);
  }

  function messageMediaUrl(msg: FourBasedMessage, size = '400x400.jpg'): string | null {
    if (!selectedCreatorId) return null;
    const path = messageMediaPath(msg, size);
    if (!path) return null;
    return fourBasedMediaUrl(selectedCreatorId, path);
  }

  function messageVideoUrl(msg: FourBasedMessage): string | null {
    if (!selectedCreatorId || !providerUserId || !msg.file_stack?._id) return null;
    const fs = msg.file_stack;
    const vaultId = fs.vault_file_stack_id;
    if (vaultId) {
      return fourBasedMediaUrl(
        selectedCreatorId,
        `protected/${providerUserId}/${fs._id}/v/${vaultId}/file.mp4`
      );
    }
    return fourBasedMediaUrl(
      selectedCreatorId,
      `protected/${providerUserId}/${fs._id}/file.mp4`
    );
  }

  function isMessageVideo(msg: FourBasedMessage): boolean {
    const fs = msg.file_stack;
    if (!fs) return false;
    const type = String(fs.fileStackType || fs.type || '').toLowerCase();
    return type.includes('video');
  }

  const filteredVaultItems = useMemo(() => {
    if (vaultTypeFilter === 'all') return vaultItems;
    return vaultItems.filter((item) => {
      const video = isVideoItem(item);
      return vaultTypeFilter === 'video' ? video : !video;
    });
  }, [vaultItems, vaultTypeFilter]);

  return (
    <div className="bg-zinc-950 text-zinc-300 h-screen flex antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <main className="flex-1 flex min-w-0 overflow-hidden">
        {/* Creators column */}
        <aside className="w-64 border-r border-zinc-800/60 flex flex-col shrink-0 bg-zinc-950/50 glass-panel">
          <div className="h-16 px-4 border-b border-zinc-800/60 flex items-center gap-2">
            <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
            <span className="text-sm font-semibold text-white">4based</span>
            <span className="w-2 h-2 rounded-sm bg-4based-500 ml-0.5" />
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 animate-fade-in">
            {creatorsLoading && (
              <p className="text-xs text-zinc-500 p-3">Loading creators…</p>
            )}
            {!creatorsLoading && creators.length === 0 && (
              <p className="text-xs text-zinc-500 p-3">
                No 4based creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => {
              const unread = badgeCountsByCreatorId[creator.id] || {
                messages: 0,
                notifications: 0,
              };
              const active = selectedCreatorId === creator.id;
              return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
                  active
                    ? 'bg-zinc-800/50 border border-zinc-700/50 hover:bg-zinc-800'
                    : 'hover:bg-zinc-800/30 border border-transparent'
                }`}
              >
                <div className="relative shrink-0">
                  <CreatorAvatar
                    avatarUrl={creator.avatarUrl}
                    displayName={creator.displayName}
                    className="w-10 h-10 rounded-full object-cover shadow-md"
                    initialsClassName="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-sm font-bold text-white shadow-md"
                  />
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-4based-500 border-2 border-zinc-900 rounded-sm flex items-center justify-center text-[7px] font-bold text-white">
                    4B
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-sm truncate block transition-colors ${
                      active
                        ? 'font-semibold text-zinc-100 group-hover:text-white'
                        : 'font-medium text-zinc-300 group-hover:text-white'
                    }`}
                  >
                    {creator.displayName}
                  </span>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <UnreadBadge
                      icon={MessageSquare}
                      count={unread.messages}
                      label="Unread messages"
                    />
                    <UnreadBadge
                      icon={Bell}
                      count={unread.notifications}
                      label="Unread notifications"
                    />
                  </div>
                </div>
              </button>
              );
            })}
          </div>
          <div className="shrink-0 border-t border-zinc-800/60 p-4 space-y-3 bg-zinc-950/80">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Assist Settings
            </p>
            <label className="flex items-center justify-between cursor-pointer group gap-3">
              <span className="text-xs font-medium text-zinc-300 group-hover:text-white transition-colors">
                Auto-translate Out
              </span>
              <ToggleSwitch
                checked={autoTranslateOutgoing}
                onChange={handleAutoTranslateOutgoingChange}
                aria-label="Auto-translate outgoing messages"
              />
            </label>
            <label className="flex items-center justify-between cursor-pointer group gap-3">
              <span className="text-xs font-medium text-zinc-300 group-hover:text-white transition-colors">
                Show Translation UI
              </span>
              <ToggleSwitch
                checked={autoTranslateHistory}
                onChange={handleAutoTranslateHistoryChange}
                aria-label="Auto-translate chat history"
              />
            </label>
          </div>
        </aside>

        {/* Conversations */}
        <aside className="w-80 border-r border-zinc-800/60 flex flex-col shrink-0 bg-[#0a0a0c] glass-panel">
          <div className="h-16 px-5 border-b border-zinc-800/60 flex items-center justify-between gap-2 shrink-0 bg-zinc-900/20">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 min-w-0">
              <span className="truncate">
                {selectedCreator?.displayName || 'Creator'}
              </span>
              {selectedCreator && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
                  Active
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={() => {
                if (!selectedCreatorId || chatsLoading) return;
                void loadChats(selectedCreatorId);
                void refreshCreatorBadges([selectedCreatorId]);
                if (selectedChatId) {
                  void loadMessages(selectedCreatorId, selectedChatId);
                }
              }}
              disabled={!selectedCreatorId || chatsLoading}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-40"
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
          <div className="flex-1 overflow-y-auto animate-fade-in">
            {chatsError && (
              <p className="text-xs text-red-400 p-3">{chatsError}</p>
            )}
            {!chatsLoading && !chatsError && chats.length === 0 && selectedCreatorId && (
              <p className="text-xs text-zinc-500 p-3">No chats yet.</p>
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
              const unreadCount = chat.unread_message_count || 0;
              return (
                <button
                  key={chat._id}
                  type="button"
                  onClick={() => setSelectedChatId(chat._id)}
                  className={`w-full text-left p-3 border-l-2 transition-colors relative ${
                    active
                      ? 'border-4based-500 bg-zinc-900/60 hover:bg-zinc-900/80'
                      : 'border-transparent hover:bg-zinc-900/40 border-b border-b-zinc-800/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="relative shrink-0">
                      <FanAvatar
                        name={peer.name}
                        avatarUrl={peer.avatarUrl}
                        isOnline={peer.isOnline}
                        size="sm"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between min-w-0 mb-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`text-sm truncate ${
                              active
                                ? 'font-semibold text-white'
                                : 'font-medium text-zinc-200'
                            }`}
                          >
                            {peer.name}
                          </span>
                          {peer.verified && !peer.isCreator && (
                            <span
                              title="Trusted user — verified payment"
                              className="shrink-0 text-amber-400"
                            >
                              <ShieldCheck className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {chat.is_pinned && (
                            <Pin className="w-3 h-3 text-red-500 fill-red-500 shrink-0" />
                          )}
                        </div>
                        <span className="text-[10px] text-zinc-500 shrink-0 ml-2">
                          {relative || ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-zinc-400 truncate flex-1">
                          {chat.last_message?.message || '—'}
                        </p>
                        {spent && (
                          <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            {spent}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {unreadCount > 0 && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-[9px] font-bold text-white shadow-[0_0_8px_rgba(239,68,68,0.4)]">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Thread */}
        <section className="flex-1 flex flex-col min-w-0 relative chatter-thread-bg">
          <div className="absolute inset-0 bg-zinc-950/95 z-0 pointer-events-none" />

          <div className="h-16 px-4 md:px-6 border-b border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 relative z-10 bg-zinc-950/80 backdrop-blur-md min-w-0">
            {selectedChat ? (
              <>
                <div className="flex items-center gap-4 min-w-0">
                  <div className="relative shrink-0 hidden sm:block">
                    <FanAvatar
                      name={fan.name}
                      avatarUrl={fan.avatarUrl}
                      isOnline={fanIsOnline}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h2 className="text-base font-bold text-white truncate">{fan.name}</h2>
                      {fanVerified && !fan.isCreator && (
                        <span
                          title="Trusted user — verified payment"
                          className="shrink-0 text-amber-400"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                        </span>
                      )}
                      {formatSpent(selectedChat.sales_volume) && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                          LTV: {formatSpent(selectedChat.sales_volume)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 truncate mt-0.5">
                      {fanProfileLoading
                        ? '…'
                        : fanIsOnline
                          ? 'Online'
                          : fanLastOnline
                            ? `Last online ${formatRelativeTime(fanLastOnline)}`
                            : 'Offline'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeOpenThread}
                  className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all border border-transparent hover:border-zinc-700 shrink-0"
                  title="Close chat"
                  aria-label="Close chat"
                >
                  <X className="w-4 h-4" />
                </button>
              </>
            ) : (
              <span className="text-sm text-zinc-500 relative z-10">
                Select a creator chat to start
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 min-h-0 relative z-10 scroll-smooth animate-fade-in">
            {messagesLoading && (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            )}
            {messagesError && (
              <p className="text-sm text-red-400">{messagesError}</p>
            )}
            {messages.map((msg) => {
              const mine = msg.user_id === providerUserId;
              const msgKey = String(msg._id || msg.local_id || '');
              const localKey =
                typeof msg.local_id === 'string' ? msg.local_id : '';
              const sentBy = mine
                ? messageSenders[`4based:${msg._id}`] ||
                  (localKey ? messageSenders[localKey] : undefined) ||
                  (msgKey ? messageSenders[msgKey] : undefined)
                : undefined;
              const mediaUrl = messageMediaUrl(msg, '400x400.jpg');
              const isVideo = isMessageVideo(msg);
              const videoUrl = isVideo ? messageVideoUrl(msg) : null;
              const isPlaying = Boolean(isVideo && videoUrl && playingMsgId === msgKey);
              const price = msg.file_stack?.price;
              const ppvLabel = formatPpvDollars(price);
              const duration = msg.file_stack?.duration;
              const msgText = typeof msg.message === 'string' ? msg.message.trim() : '';
              const historyEn =
                autoTranslateHistory && msgKey && msgText
                  ? historyTranslations[`${msgKey}::${msgText}`]
                  : undefined;
              const hasMedia = Boolean(msg.file_stack && (mediaUrl || videoUrl));
              return (
                <div
                  key={msgKey}
                  className={`flex animate-slide-up ${mine ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] md:max-w-[70%] flex flex-col ${
                      mine ? 'items-end' : 'items-start'
                    }`}
                  >
                    {hasMedia || ppvLabel ? (
                      <div
                        className={`rounded-2xl p-1.5 shadow-lg relative overflow-hidden ${
                          mine
                            ? 'bg-zinc-900 border border-4based-500/30 text-white chat-bubble-out'
                            : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 chat-bubble-in'
                        }`}
                      >
                        {ppvLabel && !isPlaying && (
                          <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/60 backdrop-blur border border-white/10 text-[10px] font-bold tracking-widest text-emerald-400 flex items-center gap-1">
                            <Lock className="w-3 h-3" /> PPV · {ppvLabel}
                          </div>
                        )}
                        {hasMedia && (
                          <div className="mb-2 relative overflow-hidden rounded-xl bg-black min-w-[200px]">
                            {isPlaying ? (
                              <video
                                controls
                                autoPlay
                                playsInline
                                preload="auto"
                                poster={mediaUrl || undefined}
                                src={videoUrl || undefined}
                                className="max-h-56 w-full object-contain bg-black"
                              >
                                <track kind="captions" />
                              </video>
                            ) : (
                              <button
                                type="button"
                                className="relative block w-full text-left"
                                onClick={() => {
                                  if (isVideo && videoUrl) {
                                    setPlayingMsgId(msgKey);
                                  }
                                }}
                                aria-label={isVideo ? 'Play video' : 'Media'}
                              >
                                {mediaUrl ? (
                                  <img
                                    src={mediaUrl}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    className="max-h-56 w-full object-cover group-hover:scale-105 transition-transform duration-500"
                                  />
                                ) : (
                                  <div className="h-40 flex items-center justify-center bg-black/40">
                                    <Play className="w-10 h-10 text-white/80" />
                                  </div>
                                )}
                                {isVideo && (
                                  <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                                    <span className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center">
                                      <Play className="w-5 h-5 ml-0.5 text-white" />
                                    </span>
                                  </span>
                                )}
                              </button>
                            )}
                            {typeof duration === 'number' && duration > 0 && !isPlaying && (
                              <span className="absolute bottom-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white backdrop-blur z-10 pointer-events-none">
                                {formatDuration(duration)}
                              </span>
                            )}
                          </div>
                        )}
                        {msg.message && (
                          <div className="px-3 pb-2 pt-1 text-sm">
                            <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className={`rounded-2xl px-4 py-3 text-sm shadow-sm backdrop-blur-sm ${
                          mine
                            ? 'bg-4based-600 text-white chat-bubble-out shadow-md'
                            : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 chat-bubble-in'
                        }`}
                      >
                        {msg.message && (
                          <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                        )}
                      </div>
                    )}

                    {historyEn && (
                      <div
                        className={`mt-1.5 rounded-xl px-3 py-2 text-[11px] italic shadow-sm w-fit max-w-full flex items-center gap-1.5 ${
                          mine
                            ? 'bg-zinc-800/60 border border-zinc-700/50 text-zinc-300'
                            : 'bg-zinc-900/80 border border-zinc-800 text-zinc-400'
                        }`}
                      >
                        {!mine && (
                          <Languages className="w-3 h-3 text-zinc-500 shrink-0" />
                        )}
                        <span className="whitespace-pre-wrap break-words">{historyEn}</span>
                      </div>
                    )}

                    <div
                      className={`mt-2 flex flex-col gap-1.5 ${
                        mine ? 'items-end mr-1' : 'items-start ml-1'
                      }`}
                    >
                      <span className="text-[10px] text-zinc-600">
                        {formatTime(msg.created_at)}
                      </span>
                      {sentBy && (
                        <div className="px-2.5 py-0.5 rounded-full bg-zinc-900/90 border border-zinc-800 text-[9px] font-medium text-zinc-400 shadow-sm">
                          Sent by {sentBy}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-zinc-800/80 bg-zinc-950 p-4 shrink-0 relative z-10 shadow-[0_-10px_40px_rgba(0,0,0,0.3)]">
            {selectedVaultItems.length > 0 && (
              <div className="flex items-center gap-4 mb-3 px-1 animate-fade-in">
                <div className="flex gap-2 max-w-[40%] overflow-x-auto">
                  {selectedVaultItems.map((item) => {
                    const thumb = mediaSrcForVaultItem(item, '200x200.jpg');
                    const id = vaultItemId(item);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleVaultItem(item)}
                        className="w-12 h-12 rounded-lg relative group overflow-hidden border border-zinc-700 shrink-0"
                        title="Remove"
                      >
                        {thumb ? (
                          <img
                            src={thumb}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full bg-zinc-800" />
                        )}
                        <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <X className="w-3 h-3" />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="h-8 w-px bg-zinc-800" />
                <div className="flex items-center gap-3">
                  <div className="flex flex-col">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-0.5">
                      PPV Price
                    </label>
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 text-xs">
                        $
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={ppvDollars}
                        onChange={(e) => setPpvDollars(e.target.value)}
                        className="w-20 pl-6 pr-2 py-1 rounded-md border border-zinc-700 bg-zinc-900 text-sm text-white focus:border-domx-500 focus:outline-none transition-colors"
                      />
                    </div>
                  </div>
                  <span className="text-xs text-zinc-400 mt-4">
                    {selectedVaultItems.length} item
                    {selectedVaultItems.length === 1 ? '' : 's'} · ≈ {priceCoins} coins
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedVaultItems([])}
                  className="p-1 text-zinc-500 hover:text-white ml-auto"
                  aria-label="Clear attachment"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {sendError && (
              <p className="text-xs text-red-400 mb-2">{sendError}</p>
            )}
            {translatingOutgoing && (
              <p className="text-xs text-zinc-500 mb-2">Translating to German…</p>
            )}

            <div className="flex items-end gap-2 bg-zinc-900/80 border border-zinc-800 rounded-2xl p-2 focus-within:border-domx-500/50 focus-within:bg-zinc-900 transition-all shadow-inner">
              <button
                type="button"
                onClick={() => void openVault()}
                disabled={!selectedChatId}
                className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors shrink-0 disabled:opacity-40"
                title="Open Media Vault"
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
                disabled={!selectedChatId || sending || translatingOutgoing}
                rows={1}
                placeholder={
                  selectedChatId
                    ? autoTranslateOutgoing
                      ? 'Type a message… (Auto-translates to German)'
                      : 'Type a message…'
                    : 'Select a creator chat to start'
                }
                className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-white focus:outline-none placeholder:text-zinc-600 leading-relaxed disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void handleSendText()}
                disabled={
                  !selectedChatId ||
                  sending ||
                  translatingOutgoing ||
                  (!draft.trim() && selectedVaultItems.length === 0)
                }
                className="p-3 mb-0.5 rounded-xl bg-domx-600 text-white hover:bg-domx-500 transition-all shadow-lg shadow-domx-600/20 shrink-0 transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                title="Send"
              >
                {sending || translatingOutgoing ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Vault modal */}
      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => {
              setVaultOpen(false);
              setPreviewItem(null);
            }}
          />
          <div className="relative bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-slide-up">
            <div className="flex items-center justify-between p-5 border-b border-zinc-800/60 bg-zinc-900/50 backdrop-blur-md">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                  <Box className="w-5 h-5 text-domx-400" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-white">Media Vault</h3>
                  <p className="text-xs text-zinc-400">
                    {selectedVaultItems.length} item
                    {selectedVaultItems.length === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {selectedVaultItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedVaultItems([])}
                    className="px-3 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    Clear Selection
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setPreviewItem(null);
                    setVaultPreviewPlaying(false);
                  }}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500 transition-colors shadow-lg shadow-domx-600/20"
                >
                  Insert Media
                </button>
                <div className="w-px h-6 bg-zinc-800 mx-1" />
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setPreviewItem(null);
                    setVaultPreviewPlaying(false);
                  }}
                  className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {previewItem ? (
              <div className="flex-1 overflow-y-auto p-4 space-y-4 animate-fade-in">
                <button
                  type="button"
                  onClick={() => setPreviewItem(null)}
                  className="text-sm text-domx-400 hover:text-domx-500"
                >
                  ← Back to grid
                </button>
                <div className="flex justify-center bg-black/40 rounded-xl p-2 min-h-[240px]">
                  {isVideoItem(previewItem) ? (
                    vaultPreviewPlaying ? (
                      <video
                        controls
                        autoPlay
                        playsInline
                        poster={fullMediaSrc(previewItem) || undefined}
                        src={videoStreamSrc(previewItem) || undefined}
                        className="max-h-[60vh] max-w-full rounded"
                      >
                        <track kind="captions" />
                      </video>
                    ) : (
                      <button
                        type="button"
                        className="relative max-h-[60vh] max-w-full"
                        onClick={() => setVaultPreviewPlaying(true)}
                        aria-label="Play video"
                      >
                        {fullMediaSrc(previewItem) ? (
                          <img
                            src={fullMediaSrc(previewItem)!}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="max-h-[60vh] max-w-full rounded object-contain"
                          />
                        ) : (
                          <div className="w-64 h-40 flex items-center justify-center rounded bg-black/40">
                            <Play className="w-12 h-12 text-white" />
                          </div>
                        )}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/25 rounded">
                          <Play className="w-14 h-14 text-white drop-shadow fill-white/20" />
                        </span>
                      </button>
                    )
                  ) : (
                    fullMediaSrc(previewItem) && (
                      <img
                        src={fullMediaSrc(previewItem)!}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="max-h-[60vh] max-w-full rounded object-contain"
                      />
                    )
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      toggleVaultItem(previewItem);
                      setPpvDollars('0');
                      setPreviewItem(null);
                    }}
                    className="px-3 py-2 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800"
                  >
                    Toggle free attach
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const id = vaultItemId(previewItem);
                      setSelectedVaultItems((prev) => {
                        if (prev.some((entry) => vaultItemId(entry) === id)) {
                          return prev;
                        }
                        return [...prev, previewItem];
                      });
                      setPpvDollars('10');
                      setPreviewItem(null);
                    }}
                    className="px-3 py-2 text-sm rounded-lg bg-domx-600 text-white hover:bg-domx-500"
                  >
                    Add as PPV
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 overflow-hidden min-h-0">
                <div className="w-48 sm:w-56 border-r border-zinc-800/60 bg-zinc-900/20 p-3 overflow-y-auto hidden md:block shrink-0">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-3 px-2">
                    Folders
                  </h4>
                  <ul className="space-y-1">
                    <li>
                      <button
                        type="button"
                        onClick={() => void selectVaultFolder(null)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                          selectedFolder === null
                            ? 'bg-zinc-800 text-white font-medium'
                            : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {selectedFolder === null ? (
                          <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                        ) : (
                          <Folder className="w-4 h-4 shrink-0" />
                        )}
                        All Media
                      </button>
                    </li>
                    {vaultFolders.map((folder) => {
                      const active = selectedFolder === folder;
                      return (
                        <li key={folder}>
                          <button
                            type="button"
                            onClick={() => void selectVaultFolder(folder)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 truncate ${
                              active
                                ? 'bg-zinc-800 text-white font-medium'
                                : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'
                            }`}
                            title={folder}
                          >
                            {active ? (
                              <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                            ) : (
                              <Folder className="w-4 h-4 shrink-0" />
                            )}
                            <span className="truncate">{folder}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="flex-1 flex flex-col min-w-0">
                  <div className="p-3 border-b border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0 md:hidden">
                    <button
                      type="button"
                      onClick={() => void selectVaultFolder(null)}
                      className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                        selectedFolder === null
                          ? 'bg-zinc-800 text-white border-zinc-700'
                          : 'bg-zinc-900/50 text-zinc-400 border-zinc-800'
                      }`}
                    >
                      All
                    </button>
                    {vaultFolders.map((folder) => (
                      <button
                        key={folder}
                        type="button"
                        onClick={() => void selectVaultFolder(folder)}
                        className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors max-w-[160px] truncate ${
                          selectedFolder === folder
                            ? 'bg-zinc-800 text-white border-zinc-700'
                            : 'bg-zinc-900/50 text-zinc-400 border-zinc-800'
                        }`}
                        title={folder}
                      >
                        {folder}
                      </button>
                    ))}
                  </div>
                  <div className="p-3 border-b border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
                    {(
                      [
                        { id: 'all' as const, label: 'All Types' },
                        { id: 'image' as const, label: 'Images', icon: ImageIcon },
                        { id: 'video' as const, label: 'Videos', icon: Video },
                      ] as const
                    ).map((chip) => {
                      const active = vaultTypeFilter === chip.id;
                      const Icon = 'icon' in chip ? chip.icon : null;
                      return (
                        <button
                          key={chip.id}
                          type="button"
                          onClick={() => setVaultTypeFilter(chip.id)}
                          className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                            active
                              ? 'bg-zinc-800 text-white border-zinc-700'
                              : 'bg-zinc-900/50 text-zinc-400 hover:text-white border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          {Icon && <Icon className="w-3 h-3" />}
                          {chip.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex-1 overflow-y-auto p-4">
                    {vaultLoading && (
                      <div className="flex justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                      </div>
                    )}
                    {vaultError && (
                      <p className="text-sm text-red-400">{vaultError}</p>
                    )}
                    {!vaultLoading &&
                      !vaultError &&
                      filteredVaultItems.length === 0 && (
                        <p className="text-sm text-zinc-500">
                          {selectedFolder
                            ? `No media in “${selectedFolder}”.`
                            : 'Vault is empty.'}
                        </p>
                      )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {filteredVaultItems.map((item) => {
                        const thumb = mediaSrcForVaultItem(item, '200x200.jpg');
                        const video = isVideoItem(item);
                        const id = vaultItemId(item);
                        const selected = selectedVaultItems.some(
                          (entry) => vaultItemId(entry) === id
                        );
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => toggleVaultItem(item)}
                            onDoubleClick={() => {
                              setVaultPreviewPlaying(false);
                              setPreviewItem(item);
                            }}
                            className={`relative aspect-square rounded-xl overflow-hidden group transition-all ${
                              selected
                                ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-zinc-950'
                                : 'border border-zinc-800 hover:border-zinc-600'
                            }`}
                            title="Click to select · double-click to preview"
                          >
                            {thumb ? (
                              <img
                                src={thumb}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                                <ImageIcon className="w-6 h-6" />
                              </div>
                            )}
                            {selected && (
                              <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center z-10 shadow-lg">
                                <Check className="w-3.5 h-3.5" />
                              </span>
                            )}
                            {video && (
                              <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                                <span className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white/90">
                                  <Play className="w-5 h-5 ml-0.5" />
                                </span>
                              </span>
                            )}
                            {video && item.duration != null && (
                              <span className="absolute bottom-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white backdrop-blur">
                                {formatDuration(Number(item.duration))}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
