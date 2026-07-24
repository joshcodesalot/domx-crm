import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Pin,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  User,
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
const BADGE_POLL_INTERVAL_MS = 20_000;

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
  const badgeClass = hasUnread
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-400';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${badgeClass}`}
      title={label}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      <span>{count > 99 ? '99+' : count}</span>
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

function formatSpent(salesVolumeCoins?: number): string | null {
  if (typeof salesVolumeCoins !== 'number' || salesVolumeCoins === 0) return null;
  const dollars = coinsToDollars(salesVolumeCoins);
  const rounded =
    Math.abs(dollars) >= 100
      ? dollars.toFixed(0)
      : dollars.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}$`;
}

function formatPpvDollars(priceCoins?: number): string | null {
  if (typeof priceCoins !== 'number' || priceCoins <= 0) return null;
  return `$${coinsToDollars(priceCoins).toFixed(2)}`;
}

/** Badge tiers use raw coin amounts (same as 4based user-info-item). */
function spentBadgeClass(salesVolumeCoins?: number): string {
  if (typeof salesVolumeCoins !== 'number') return 'bg-emerald-600 text-white';
  if (salesVolumeCoins > 50000) return 'bg-amber-400 text-black';
  if (salesVolumeCoins > 10000) return 'bg-slate-300 text-black';
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
  const dim = size === 'sm' ? 'w-10 h-10' : 'w-9 h-9';
  const initials = (name || '?').slice(0, 1).toUpperCase();
  return (
    <div className={`relative shrink-0 ${dim}`}>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
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
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FourBasedVaultItem | null>(null);
  const [vaultPreviewPlaying, setVaultPreviewPlaying] = useState(false);
  const [selectedVaultItem, setSelectedVaultItem] = useState<FourBasedVaultItem | null>(
    null
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
    setDraft('');
    setSendError(null);
    setSelectedVaultItem(null);
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
    const results = await Promise.allSettled(
      creatorIds.map(async (creatorId) => {
        const badges = await getFourBasedBadges(creatorId);
        return {
          creatorId,
          messages: Number(badges.messages) || 0,
          notifications: Number(badges.notifications) || 0,
        };
      })
    );
    setBadgeCountsByCreatorId((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        next[result.value.creatorId] = {
          messages: result.value.messages,
          notifications: result.value.notifications,
        };
      }
      return next;
    });
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
    setPlayingMsgId(null);
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyInFlightRef.current.clear();
    void loadMessages(selectedCreatorId, selectedChatId);
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

  // Silent 5s refresh — keeps going even when panel is hidden (never unloads)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const creatorId = selectedCreatorIdRef.current;
      if (!creatorId) return;
      void loadChats(creatorId, true);
      void refreshCreatorBadges([creatorId]);
      const chatId = selectedChatIdRef.current;
      if (chatId) {
        void loadMessages(creatorId, chatId, true);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadChats, loadMessages, refreshCreatorBadges]);

  async function handleSendText() {
    if (!selectedCreatorId || !selectedChatId || sending || translatingOutgoing) return;
    const text = draft.trim();
    if (!text && !selectedVaultItem) return;

    setSending(true);
    setSendError(null);
    const localId = crypto.randomUUID();
    const englishDraft = text;
    const vaultForLog = selectedVaultItem;
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

      if (vaultForLog) {
        const vaultId = vaultItemId(vaultForLog);
        const dollars = dollarsForLog;
        const result = await sendFourBasedPpv(selectedCreatorId, selectedChatId, {
          message: messageToSend || vaultForLog.description || '',
          vaultId,
          vaultGuid: vaultItemGuid(vaultForLog),
          priceCoins: dollars > 0 ? priceCoins : 0,
          localId,
        });
        sentMessage = result.message;
        setSelectedVaultItem(null);
        setPpvDollars('10');
      } else {
        const result = await sendFourBasedMessage(selectedCreatorId, selectedChatId, {
          message: messageToSend,
          localId,
        });
        sentMessage = result.message;
      }

      if (user?.id && sentMessage?._id) {
        const isVideo = isVideoItem(vaultForLog);
        const hasMedia = Boolean(vaultForLog);
        const actualSent =
          messageToSend ||
          (vaultForLog ? vaultForLog.description || '' : '') ||
          englishDraft;
        void createMessagingDashboardEntry({
          id: crypto.randomUUID(),
          creatorId: selectedCreatorId,
          creatorName: selectedCreator?.displayName,
          creatorUsername: selectedCreator?.username,
          creatorAvatarUrl: selectedCreator?.avatarUrl,
          chatterId: user.id,
          chatterName: user.name,
          chatterEmail: user.email,
          chatId: selectedChatId,
          fanId: fan.id || null,
          fanUsername: fan.name || null,
          maloumMessageId: `4based:${sentMessage._id}`,
          optimisticMessageId: localId,
          contentType: hasMedia ? 'chat_product' : 'text',
          englishMessage: englishDraft || actualSent || null,
          germanTranslatedMessage: actualSent || null,
          actualSentText: actualSent || null,
          priceNet: vaultForLog && dollarsForLog > 0 ? dollarsForLog : null,
          currency: 'USD',
          purchased: false,
          mediaCount: hasMedia ? 1 : 0,
          pictureCount: hasMedia && !isVideo ? 1 : 0,
          videoCount: hasMedia && isVideo ? 1 : 0,
          mediaJson: hasMedia
            ? [
                {
                  mediaId: vaultItemId(vaultForLog!),
                  type: isVideo ? 'video' : 'image',
                },
              ]
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
            {creators.map((creator) => {
              const unread = badgeCountsByCreatorId[creator.id] || {
                messages: 0,
                notifications: 0,
              };
              return (
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
                <div className="min-w-0 flex-1">
                  <span className="text-sm truncate block">{creator.displayName}</span>
                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
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
          <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-3 bg-white dark:bg-[#0a0a0a]">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Translation
            </p>
            <label className="flex items-start gap-3 cursor-pointer">
              <ToggleSwitch
                checked={autoTranslateOutgoing}
                onChange={handleAutoTranslateOutgoingChange}
                aria-label="Auto-translate outgoing messages"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  Auto-translate outgoing
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Translate messages to German before sending
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <ToggleSwitch
                checked={autoTranslateHistory}
                onChange={handleAutoTranslateHistoryChange}
                aria-label="Auto-translate chat history"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  Auto-translate chat history
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Show English translations under messages
                </span>
              </span>
            </label>
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
                void refreshCreatorBadges([selectedCreatorId]);
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
                <button
                  type="button"
                  onClick={closeOpenThread}
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 shrink-0"
                  title="Close conversation"
                  aria-label="Close conversation"
                >
                  <X className="w-4 h-4" />
                </button>
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
              const msgKey = String(msg._id || msg.local_id || '');
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
              return (
                <div
                  key={msgKey}
                  className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
                      mine
                        ? 'bg-brand-600 text-white'
                        : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {msg.file_stack && (mediaUrl || videoUrl) && (
                      <div className="mb-2 relative overflow-hidden rounded-lg bg-black min-w-[200px]">
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
                                className="max-h-56 w-full object-cover"
                              />
                            ) : (
                              <div className="h-40 flex items-center justify-center bg-black/40">
                                <Play className="w-10 h-10 text-white/80" />
                              </div>
                            )}
                            {isVideo && (
                              <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                                <Play className="w-12 h-12 text-white drop-shadow fill-white/20" />
                              </span>
                            )}
                          </button>
                        )}
                        {typeof duration === 'number' && duration > 0 && !isPlaying && (
                          <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white flex items-center gap-1 z-10 pointer-events-none">
                            <Play className="w-2.5 h-2.5 fill-white" />
                            {formatDuration(duration)}
                          </span>
                        )}
                        {ppvLabel && !isPlaying && (
                          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
                            <span className="px-3 py-1 rounded-full bg-white text-gray-900 text-sm font-semibold shadow-lg whitespace-nowrap">
                              {ppvLabel}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                    {msg.message && (
                      <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                    )}
                    {historyEn && (
                      <p
                        className={`mt-1.5 pt-1.5 border-t text-xs whitespace-pre-wrap break-words ${
                          mine
                            ? 'border-white/25 text-white/80'
                            : 'border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400'
                        }`}
                      >
                        {historyEn}
                      </p>
                    )}
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
              {mediaSrcForVaultItem(selectedVaultItem, '200x200.jpg') && (
                <img
                  src={mediaSrcForVaultItem(selectedVaultItem, '200x200.jpg')!}
                  alt=""
                  loading="lazy"
                  decoding="async"
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

          {translatingOutgoing && (
            <p className="px-4 text-xs text-gray-500 dark:text-gray-400">
              Translating to German…
            </p>
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
              disabled={!selectedChatId || sending || translatingOutgoing}
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
                translatingOutgoing ||
                (!draft.trim() && !selectedVaultItem)
              }
              className="p-2.5 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
              title="Send"
            >
              {sending || translatingOutgoing ? (
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
                    setVaultPreviewPlaying(false);
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
                    const thumb = mediaSrcForVaultItem(item, '200x200.jpg');
                    const video = isVideoItem(item);
                    return (
                      <button
                        key={vaultItemId(item)}
                        type="button"
                        onClick={() => {
                          setVaultPreviewPlaying(false);
                          setPreviewItem(item);
                        }}
                        className="relative aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-white/5 group"
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
