import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  Ban,
  Box,
  Check,
  Eye,
  Image as ImageIcon,
  Languages,
  Loader2,
  Lock,
  Pin,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import QuickEmojiBar from '@/components/QuickEmojiBar';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import {
  createMessagingDashboardEntry,
  deleteFourBasedMessage,
  fourBasedMediaUrl,
  fourBasedPreviewPath,
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
  updateMessagingDashboardPurchased,
  type Creator,
  type FourBasedChat,
  type FourBasedChatUser,
  type FourBasedCoinPackage,
  type FourBasedLastMessage,
  type FourBasedMessage,
  type FourBasedUserProfile,
  type FourBasedVaultItem,
  type TranslateHistoryItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const HISTORY_TRANSLATE_API_URL = 'https://translate.low7labs.cloud/translate';
const MAX_TRANSLATION_HISTORY = 8;
const POLL_MS = 5000;

export const TRANSLATION_SETTINGS_EVENT = 'domx-translation-settings';
export const FOURBASED_MESSAGE_DELETED_EVENT = 'domx-4based-message-deleted';

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function emitTranslationSettings() {
  window.dispatchEvent(new Event(TRANSLATION_SETTINGS_EVENT));
}

export function UnreadBadge({
  icon: Icon,
  count,
  label,
  accentClass = 'text-4based-500',
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  accentClass?: string;
}) {
  const hasUnread = count > 0;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium ${
        hasUnread ? accentClass : 'text-gray-500 dark:text-zinc-500'
      }`}
      title={label}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      <span>{count > 99 ? '99+' : count}</span>
    </span>
  );
}

/** Assist toggles shared by the chatter page and Message Pro; syncs via localStorage + event. */
export function FourBasedTranslationToggles({
  className = '',
  compact = false,
}: {
  className?: string;
  /** Horizontal header layout (Message Pro). */
  compact?: boolean;
}) {
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const [autoTranslateHistory, setAutoTranslateHistory] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true)
  );

  useEffect(() => {
    const sync = () => {
      setAutoTranslateOutgoing(readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true));
      setAutoTranslateHistory(readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true));
    };
    window.addEventListener(TRANSLATION_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(TRANSLATION_SETTINGS_EVENT, sync);
  }, []);

  const handleOutgoingChange = useCallback((enabled: boolean) => {
    setAutoTranslateOutgoing(enabled);
    localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  const handleHistoryChange = useCallback((enabled: boolean) => {
    setAutoTranslateHistory(enabled);
    localStorage.setItem(AUTO_TRANSLATE_HISTORY_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  if (compact) {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-400 whitespace-nowrap">
            Translate Outgoing
          </span>
          <ToggleSwitch
            checked={autoTranslateOutgoing}
            onChange={handleOutgoingChange}
            aria-label="Translate outgoing messages"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-400 whitespace-nowrap">
            Translate History
          </span>
          <ToggleSwitch
            checked={autoTranslateHistory}
            onChange={handleHistoryChange}
            aria-label="Translate chat history"
          />
        </label>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
        Assist Settings
      </p>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
          Auto-translate Out
        </span>
        <ToggleSwitch
          checked={autoTranslateOutgoing}
          onChange={handleOutgoingChange}
          aria-label="Auto-translate outgoing messages"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
          Show Translation UI
        </span>
        <ToggleSwitch
          checked={autoTranslateHistory}
          onChange={handleHistoryChange}
          aria-label="Auto-translate chat history"
        />
      </label>
    </div>
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

export type FanInfo = {
  id: string;
  name: string;
  avatarUrl: string | null;
  isOnline: boolean;
  verified: boolean;
  trustedUser: boolean;
  isCreator: boolean;
};

const EMPTY_FAN: FanInfo = {
  id: '',
  name: '',
  avatarUrl: null,
  isOnline: false,
  verified: false,
  trustedUser: false,
  isCreator: false,
};

export function fanFromChat(
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

/** Display name for a chat partner, e.g. Message Pro tab labels. */
export function partnerName(
  chat: FourBasedChat | null | undefined,
  providerUserId: string | null = null
): string {
  if (!chat) return 'Fan';
  return fanFromChat(chat, providerUserId).name || 'Fan';
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

export function formatRelativeTime(value?: string): string {
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
 *
 * Chatter input is native-style provision P (not creator net, not fan checkout):
 * - API coins = P × 121
 * - You receive = P × 70%
 * - Fan pays = P × 1.21 (tax handled by 4based)
 */
const COINS_PER_DOLLAR = 121;
const CREATOR_SHARE = 0.7;
const FAN_TAX = 1.21;

function coinsToDollars(coins: number): number {
  if (!Number.isFinite(coins) || coins === 0) return 0;
  return coins / COINS_PER_DOLLAR;
}

function formatUsdAmount(dollars: number): string {
  if (!Number.isFinite(dollars)) return '0.00';
  return dollars.toFixed(2);
}

function isFourBasedPpvSold(
  fileStack: FourBasedMessage['file_stack'] | null | undefined
): boolean {
  const paid = fileStack?.user_paid;
  return Array.isArray(paid) && paid.length > 0;
}

/** 4based is USD-only in the chatter UI. */
export function formatSpent(salesVolumeCoins?: number): string | null {
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

function isPersistedFourBasedMessageId(id?: string | null): boolean {
  if (!id) return false;
  if (id.startsWith('temp-') || id.startsWith('optimistic-')) return false;
  return /^[a-f0-9]{24}$/i.test(id);
}

function isDeletedFourBasedMessage(
  msg: Pick<FourBasedMessage, 'deleted_user_ids'> | FourBasedLastMessage | null | undefined
): boolean {
  return Array.isArray(msg?.deleted_user_ids) && msg.deleted_user_ids.length > 0;
}

function lastMessagePreview(chat: FourBasedChat): string {
  const last = chat.last_message;
  if (!last) return '—';
  if (isDeletedFourBasedMessage(last)) return 'Message deleted';
  const text = typeof last.message === 'string' ? last.message.trim() : '';
  return text || '—';
}

function emitFourBasedMessageDeleted(detail: {
  creatorId: string;
  chatId: string;
  message: FourBasedMessage;
}) {
  window.dispatchEvent(
    new CustomEvent(FOURBASED_MESSAGE_DELETED_EVENT, { detail })
  );
}

const VAULT_PAGE_SIZE = 60;

type VaultCategoryFilter =
  | 'all'
  | 'image'
  | 'video'
  | 'not_purchased'
  | 'purchased';
type VaultSentFilter = 'all' | 'sent' | 'not_sent';

/** Dollars -> PPV coins. Prefer 121 (HAR / tax 1.21); packages are fan purchase rates (~100). */
function dollarsToCoins(
  dollars: number,
  _packages: FourBasedCoinPackage[]
): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * COINS_PER_DOLLAR);
}

export function FanAvatar({
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
          className={`${dim} rounded-full object-cover bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700`}
        />
      ) : (
        <div
          className={`${dim} rounded-full bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 text-gray-700 dark:text-zinc-300 flex items-center justify-center text-sm font-medium`}
        >
          {initials}
        </div>
      )}
      {isOnline && (
        <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-gray-200 dark:border-zinc-950" />
      )}
    </div>
  );
}

type FourBasedChatListProps = {
  creatorId: string;
  creatorName?: string;
  selectedChatId?: string | null;
  onSelectChat: (chat: FourBasedChat) => void;
  className?: string;
  showHeader?: boolean;
  /** Optional hint shown on each row, e.g. "Open tab" in Message Pro. */
  openActionLabel?: string;
  /** Extra work to run alongside a manual refresh, e.g. badge reload. */
  onRefreshExtra?: () => void;
};

export function FourBasedChatList({
  creatorId,
  creatorName,
  selectedChatId,
  onSelectChat,
  className = '',
  showHeader = true,
  openActionLabel,
  onRefreshExtra,
}: FourBasedChatListProps) {
  const { onSyncEvent } = useStaffSync();
  const [chats, setChats] = useState<FourBasedChat[]>([]);
  const [providerUserId, setProviderUserId] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const creatorIdRef = useRef(creatorId);

  useEffect(() => {
    creatorIdRef.current = creatorId;
  }, [creatorId]);

  const loadChats = useCallback(
    async (silent = false) => {
      if (!silent) {
        setChatsLoading(true);
        setChatsError(null);
      }
      try {
        const result = await listFourBasedChats(creatorId, { limit: 50 });
        if (creatorIdRef.current !== creatorId) return;
        setChats(Array.isArray(result.chats) ? result.chats : []);
        setProviderUserId(result.providerUserId || null);
      } catch (err) {
        if (!silent && creatorIdRef.current === creatorId) {
          setChatsError(err instanceof Error ? err.message : 'Failed to load chats');
          setChats([]);
        }
      } finally {
        if (!silent && creatorIdRef.current === creatorId) {
          setChatsLoading(false);
        }
      }
    },
    [creatorId]
  );

  useEffect(() => {
    setChats([]);
    setProviderUserId(null);
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadChats(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadChats]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== '4based:event') return;
      if (event.creatorId !== creatorId) return;
      void loadChats(true);
    });
  }, [onSyncEvent, creatorId, loadChats]);

  useEffect(() => {
    const onDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{
        creatorId: string;
        chatId: string;
        message: FourBasedMessage;
      }>).detail;
      if (!detail || detail.creatorId !== creatorId) return;
      setChats((prev) =>
        prev.map((chat) => {
          if (chat._id !== detail.chatId) return chat;
          const lastId = chat.last_message?._id;
          if (lastId && lastId !== detail.message._id) return chat;
          return {
            ...chat,
            last_message: {
              ...(chat.last_message || {}),
              _id: detail.message._id,
              message: detail.message.message,
              user_id: detail.message.user_id,
              created_at: detail.message.created_at,
              file_stack: null,
              deleted_user_ids: detail.message.deleted_user_ids || ['deleted'],
            },
          };
        })
      );
    };
    window.addEventListener(FOURBASED_MESSAGE_DELETED_EVENT, onDeleted);
    return () =>
      window.removeEventListener(FOURBASED_MESSAGE_DELETED_EVENT, onDeleted);
  }, [creatorId]);

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

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-[#F7F8FA] dark:bg-[#0a0a0c] ${className}`}
    >
      {showHeader && (
        <div className="h-16 px-5 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-2 shrink-0 bg-gray-100/40 dark:bg-zinc-900/20">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 min-w-0">
            <span className="truncate">{creatorName || 'Creator'}</span>
            {creatorName && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border border-gray-300 dark:border-zinc-700 shrink-0">
                Active
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => {
              if (chatsLoading) return;
              void loadChats();
              onRefreshExtra?.();
            }}
            disabled={chatsLoading}
            className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all disabled:opacity-40"
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
      )}
      <div className="flex-1 overflow-y-auto min-h-0 animate-fade-in">
        {chatsError && <p className="text-xs text-red-400 p-3">{chatsError}</p>}
        {!chatsLoading && !chatsError && chats.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">No chats yet.</p>
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
              onClick={() => onSelectChat(chat)}
              className={`w-full text-left p-3 border-l-2 transition-colors relative ${
                active
                  ? 'border-4based-500 bg-gray-50/60 dark:bg-zinc-900/60 hover:bg-white/80 dark:hover:bg-zinc-900/80'
                  : 'border-transparent hover:bg-gray-100 dark:hover:bg-zinc-900/40 border-b border-b-gray-200 dark:border-b-zinc-800/30'
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
                            ? 'font-semibold text-gray-900 dark:text-white'
                            : 'font-medium text-gray-800 dark:text-zinc-200'
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
                    <span className="text-[10px] text-gray-500 dark:text-zinc-500 shrink-0 ml-2">
                      {relative || ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <p
                      className={`text-xs truncate flex-1 ${
                        isDeletedFourBasedMessage(chat.last_message)
                          ? 'italic text-gray-400 dark:text-zinc-500'
                          : 'text-gray-500 dark:text-zinc-400'
                      }`}
                    >
                      {isDeletedFourBasedMessage(chat.last_message) ? (
                        <span className="inline-flex items-center gap-1">
                          <Ban className="w-3 h-3 shrink-0" />
                          Message deleted
                        </span>
                      ) : (
                        lastMessagePreview(chat)
                      )}
                    </p>
                    {spent && (
                      <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {spent}
                      </span>
                    )}
                    {openActionLabel && (
                      <span className="text-[10px] text-4based-500 shrink-0">
                        {openActionLabel}
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
    </div>
  );
}

type FourBasedChatThreadProps = {
  creator: Creator;
  chatId: string;
  initialChat?: FourBasedChat | null;
  onClose?: () => void;
  className?: string;
  /** Show assist toggles under the composer (e.g. Message Pro). */
  showTranslationToggles?: boolean;
};

export function FourBasedChatThread({
  creator,
  chatId,
  initialChat = null,
  onClose,
  className = '',
  showTranslationToggles = false,
}: FourBasedChatThreadProps) {
  const { user } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const creatorId = creator.id;

  const [chat, setChat] = useState<FourBasedChat | null>(initialChat);
  const [providerUserId, setProviderUserId] = useState<string | null>(
    creator.accountId || null
  );
  const [messages, setMessages] = useState<FourBasedMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>({});

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
  const [vaultCategoryFilter, setVaultCategoryFilter] =
    useState<VaultCategoryFilter>('all');
  const [vaultSentFilter, setVaultSentFilter] = useState<VaultSentFilter>('all');
  const [vaultOffset, setVaultOffset] = useState(0);
  const [vaultHasMore, setVaultHasMore] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultLoadingMore, setVaultLoadingMore] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FourBasedVaultItem | null>(null);
  const [vaultPreviewPlaying, setVaultPreviewPlaying] = useState(false);
  const [selectedVaultItems, setSelectedVaultItems] = useState<FourBasedVaultItem[]>(
    []
  );
  const vaultLoadingMoreRef = useRef(false);
  /** Empty = free (Maloum-style). Dollars string when priced. */
  const [ppvDollars, setPpvDollars] = useState('');
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState('');
  /** Vault item id marked as unlocked teaser/preview (paid multi only). */
  const [teaserVaultId, setTeaserVaultId] = useState<string | null>(null);
  const [coinPackages, setCoinPackages] = useState<FourBasedCoinPackage[]>([]);
  /** Message id currently streaming video (lazy — poster only until clicked). */
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const threadKeyRef = useRef(`${creatorId}:${chatId}`);
  /** Message ids already PATCHed to purchased=true for chat-log sync. */
  const purchasedSyncedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    threadKeyRef.current = `${creatorId}:${chatId}`;
    purchasedSyncedRef.current.clear();
  }, [creatorId, chatId]);

  function syncSoldPpvToChatLog(messagesList: FourBasedMessage[]) {
    for (const msg of messagesList) {
      const id = msg._id;
      if (!isPersistedFourBasedMessageId(id)) continue;
      const price = msg.file_stack?.price;
      if (typeof price !== 'number' || price <= 0) continue;
      if (!isFourBasedPpvSold(msg.file_stack)) continue;
      if (purchasedSyncedRef.current.has(id)) continue;
      purchasedSyncedRef.current.add(id);
      void updateMessagingDashboardPurchased(`4based:${id}`, true).catch(() => {
        purchasedSyncedRef.current.delete(id);
      });
    }
  }

  const fan = useMemo(
    () => (chat ? fanFromChat(chat, providerUserId) : EMPTY_FAN),
    [chat, providerUserId]
  );

  const ppvDollarsNum = Number(ppvDollars);
  const hasPpvPrice = Number.isFinite(ppvDollarsNum) && ppvDollarsNum > 0;
  const priceCoins = hasPpvPrice
    ? dollarsToCoins(ppvDollarsNum, coinPackages)
    : 0;

  function clearMediaAttachments() {
    setSelectedVaultItems([]);
    setPpvDollars('');
    setPriceDraft('');
    setPriceModalOpen(false);
    setTeaserVaultId(null);
  }

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
    historyTranslationsRef.current = historyTranslations;
  }, [historyTranslations]);

  useEffect(() => {
    const sync = () => {
      setAutoTranslateOutgoing(readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true));
      setAutoTranslateHistory(readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true));
    };
    window.addEventListener(TRANSLATION_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(TRANSLATION_SETTINGS_EVENT, sync);
  }, []);

  const loadMessages = useCallback(
    async (silent = false) => {
      const key = `${creatorId}:${chatId}`;
      if (!silent) {
        setMessagesLoading(true);
        setMessagesError(null);
      }
      try {
        if (!silent) {
          const chatResult = await getFourBasedChat(creatorId, chatId).catch(
            () => null
          );
          if (threadKeyRef.current !== key) return;
          if (chatResult?.chat) setChat(chatResult.chat);
          if (chatResult?.providerUserId) {
            setProviderUserId(chatResult.providerUserId);
          }
        }
        const result = await getFourBasedMessages(creatorId, chatId, { limit: 40 });
        if (threadKeyRef.current !== key) return;
        const list = Array.isArray(result.messages) ? result.messages : [];
        // API returns newest first
        const chronological = [...list].reverse();
        setMessages(chronological);
        syncSoldPpvToChatLog(chronological);
        if (result.providerUserId) {
          setProviderUserId(result.providerUserId);
        }
      } catch (err) {
        if (!silent && threadKeyRef.current === key) {
          setMessagesError(
            err instanceof Error ? err.message : 'Failed to load messages'
          );
          setMessages([]);
        }
      } finally {
        if (!silent && threadKeyRef.current === key) {
          setMessagesLoading(false);
        }
      }
    },
    [creatorId, chatId]
  );

  const loadFanProfile = useCallback(
    async (fanId: string) => {
      if (!fanId) {
        setFanProfile(null);
        return;
      }
      const key = `${creatorId}:${chatId}`;
      setFanProfileLoading(true);
      try {
        const result = await getFourBasedUser(creatorId, fanId);
        if (threadKeyRef.current !== key) return;
        setFanProfile(result.user || null);
      } catch {
        if (threadKeyRef.current === key) setFanProfile(null);
      } finally {
        if (threadKeyRef.current === key) setFanProfileLoading(false);
      }
    },
    [creatorId, chatId]
  );

  useEffect(() => {
    setChat(initialChat);
    setMessages([]);
    setMessageSenders({});
    setFanProfile(null);
    setDraft('');
    setSendError(null);
    clearMediaAttachments();
    setPlayingMsgId(null);
    setVaultOpen(false);
    setPreviewItem(null);
    setVaultPreviewPlaying(false);
    setSelectedFolder(null);
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyInFlightRef.current.clear();
    void loadMessages();
    void getMessagingDashboardSenders({ creatorId, chatId, limit: 200 })
      .then((result) => {
        if (threadKeyRef.current !== `${creatorId}:${chatId}`) return;
        setMessageSenders(result.senders || {});
      })
      .catch(() => {
        // best-effort
      });
  }, [creatorId, chatId, initialChat, loadMessages]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadMessages(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadMessages]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== '4based:event') return;
      if (event.creatorId !== creatorId) return;
      void loadMessages(true);
    });
  }, [onSyncEvent, creatorId, loadMessages]);

  useEffect(() => {
    let cancelled = false;
    void getFourBasedCoinPackages(creatorId)
      .then((r) => {
        if (!cancelled) setCoinPackages(r.packages || []);
      })
      .catch(() => {
        if (!cancelled) setCoinPackages([]);
      });
    void getFourBasedProfile(creatorId)
      .then((r) => {
        if (cancelled) return;
        const folders = Array.isArray(r.profile?.folders)
          ? r.profile.folders.filter((f): f is string => typeof f === 'string')
          : [];
        setVaultFolders(folders);
        if (r.providerUserId) setProviderUserId(r.providerUserId);
      })
      .catch(() => {
        if (!cancelled) setVaultFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [creatorId]);

  useEffect(() => {
    if (!fan.id) {
      setFanProfile(null);
      return;
    }
    void loadFanProfile(fan.id);
  }, [fan.id, loadFanProfile]);

  useEffect(() => {
    if (!autoTranslateHistory) return;
    const pending: Array<{ key: string; text: string }> = [];
    for (const msg of messages) {
      if (isDeletedFourBasedMessage(msg)) continue;
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

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    if (Object.keys(historyTranslations).length === 0) return;
    scrollToBottom();
  }, [historyTranslations, scrollToBottom]);

  function toggleVaultItem(item: FourBasedVaultItem) {
    const id = vaultItemId(item);
    if (!id) return;
    setSelectedVaultItems((prev) => {
      const exists = prev.some((entry) => vaultItemId(entry) === id);
      if (exists) {
        const next = prev.filter((entry) => vaultItemId(entry) !== id);
        if (teaserVaultId === id) setTeaserVaultId(null);
        if (next.length === 0) {
          setPpvDollars('');
          setPriceDraft('');
          setPriceModalOpen(false);
          setTeaserVaultId(null);
        }
        return next;
      }
      return [...prev, item];
    });
  }

  function setVaultItemAsTeaser(itemId: string) {
    if (!hasPpvPrice || selectedVaultItems.length < 2) return;
    setTeaserVaultId((prev) => (prev === itemId ? null : itemId));
  }

  function buildVaultSendEntries(items: FourBasedVaultItem[]) {
    const canTease =
      hasPpvPrice && items.length >= 2 && Boolean(teaserVaultId);
    const teaserId = canTease ? teaserVaultId : null;
    const ordered =
      teaserId && items.some((item) => vaultItemId(item) === teaserId)
        ? [
            ...items.filter((item) => vaultItemId(item) === teaserId),
            ...items.filter((item) => vaultItemId(item) !== teaserId),
          ]
        : items;
    return ordered.map((item, index) => ({
      id: vaultItemId(item),
      guid: vaultItemGuid(item),
      position: index,
      is_teaser: Boolean(teaserId && vaultItemId(item) === teaserId),
    }));
  }

  async function handleDeleteMessage(messageId: string) {
    if (!isPersistedFourBasedMessageId(messageId) || deletingMessageId) return;
    if (!window.confirm('Delete this message?')) return;
    setDeletingMessageId(messageId);
    setDeleteError(null);
    try {
      const result = await deleteFourBasedMessage(creatorId, chatId, messageId);
      const deletedIds =
        Array.isArray(result.message?.deleted_user_ids) &&
        result.message.deleted_user_ids.length > 0
          ? result.message.deleted_user_ids
          : [providerUserId, fan.id].filter(Boolean) as string[];
      const updated: FourBasedMessage = {
        ...(result.message || {}),
        _id: result.message?._id || messageId,
        deleted_user_ids: deletedIds,
        file_stack: null,
        file_stack_id: null,
      };
      setMessages((prev) =>
        prev.map((m) => {
          if (m._id !== messageId) return m;
          return {
            ...m,
            ...updated,
            deleted_user_ids: deletedIds,
            file_stack: null,
            file_stack_id: null,
          };
        })
      );
      emitFourBasedMessageDeleted({
        creatorId,
        chatId,
        message: {
          ...updated,
          created_at: updated.created_at || messages.find((m) => m._id === messageId)?.created_at,
          user_id: updated.user_id || providerUserId || undefined,
        },
      });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete message');
    } finally {
      setDeletingMessageId(null);
    }
  }

  async function handleSendText() {
    if (sending || translatingOutgoing) return;
    const text = draft.trim();
    if (!text && selectedVaultItems.length === 0) return;

    setSending(true);
    setSendError(null);
    const localId = crypto.randomUUID();
    const englishDraft = text;
    const vaultForLog = selectedVaultItems;
    const dollarsForLog = hasPpvPrice ? ppvDollarsNum : 0;
    const coinsForLog = dollarsForLog > 0 ? priceCoins : 0;
    const vaultEntries = buildVaultSendEntries(vaultForLog);
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
        // HAR: free media with no caption uses a single space as message body
        const mediaMessage = messageToSend || (dollarsForLog > 0 ? '' : ' ');
        const result = await sendFourBasedPpv(creatorId, chatId, {
          message: mediaMessage,
          vaults: vaultEntries,
          priceCoins: coinsForLog,
          localId,
        });
        sentMessage = result.message;
        clearMediaAttachments();
      } else {
        const result = await sendFourBasedMessage(creatorId, chatId, {
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
          creatorId,
          creatorName: creator.displayName,
          creatorUsername: creator.username,
          creatorAvatarUrl: creator.avatarUrl,
          chatterId: user.id,
          chatterName,
          chatterEmail: user.email,
          chatId,
          fanId: fan.id || null,
          fanUsername: fan.name || null,
          maloumMessageId: dashboardMessageId,
          optimisticMessageId: localId,
          contentType: hasMedia
            ? dollarsForLog > 0
              ? 'chat_product'
              : 'media'
            : 'text',
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
      await loadMessages(true);
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
      setTranslatingOutgoing(false);
    }
  }

  function buildVaultListOptions(filters: {
    folder: string | null;
    category: VaultCategoryFilter;
    sent: VaultSentFilter;
    offset?: number;
  }) {
    const options: {
      limit: number;
      offset: number;
      folder?: string;
      fileType?: 'image' | 'video';
      sold?: boolean;
      sent?: boolean;
    } = {
      limit: VAULT_PAGE_SIZE,
      offset: filters.offset ?? 0,
    };
    if (filters.folder) options.folder = filters.folder;
    if (filters.category === 'image' || filters.category === 'video') {
      options.fileType = filters.category;
    } else if (filters.category === 'purchased') {
      options.sold = true;
    } else if (filters.category === 'not_purchased') {
      options.sold = false;
    }
    if (filters.sent === 'sent') options.sent = true;
    else if (filters.sent === 'not_sent') options.sent = false;
    return options;
  }

  async function loadVaultItems(options?: {
    folder?: string | null;
    category?: VaultCategoryFilter;
    sent?: VaultSentFilter;
    append?: boolean;
    offset?: number;
  }) {
    if (!fan.id) return;
    const folder = options?.folder !== undefined ? options.folder : selectedFolder;
    const category =
      options?.category !== undefined ? options.category : vaultCategoryFilter;
    const sent = options?.sent !== undefined ? options.sent : vaultSentFilter;
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
        creatorId,
        fan.id,
        buildVaultListOptions({ folder, category, sent, offset })
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
  }

  async function openVault() {
    if (!fan.id) {
      setVaultError('Open a conversation first to browse vault for that fan.');
      setVaultOpen(true);
      return;
    }
    setVaultOpen(true);
    setPreviewItem(null);
    setVaultPreviewPlaying(false);
    setSelectedFolder(null);
    setVaultCategoryFilter('all');
    setVaultSentFilter('all');
    setVaultOffset(0);
    setVaultHasMore(false);

    if (vaultFolders.length === 0) {
      try {
        const r = await getFourBasedProfile(creatorId);
        const folders = Array.isArray(r.profile?.folders)
          ? r.profile.folders.filter((f): f is string => typeof f === 'string')
          : [];
        setVaultFolders(folders);
      } catch {
        // keep empty
      }
    }

    await loadVaultItems({
      folder: null,
      category: 'all',
      sent: 'all',
      offset: 0,
    });
  }

  async function applyVaultFilters(next: {
    folder?: string | null;
    category?: VaultCategoryFilter;
    sent?: VaultSentFilter;
  }) {
    const folder = next.folder !== undefined ? next.folder : selectedFolder;
    const category =
      next.category !== undefined ? next.category : vaultCategoryFilter;
    const sent = next.sent !== undefined ? next.sent : vaultSentFilter;
    if (next.folder !== undefined) setSelectedFolder(next.folder);
    if (next.category !== undefined) setVaultCategoryFilter(next.category);
    if (next.sent !== undefined) setVaultSentFilter(next.sent);
    setPreviewItem(null);
    setVaultPreviewPlaying(false);
    setVaultOffset(0);
    setVaultHasMore(false);
    await loadVaultItems({ folder, category, sent, offset: 0 });
  }

  function loadMoreVaultItems() {
    void loadVaultItems({ append: true, offset: vaultOffset });
  }

  function handleVaultMediaScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return;
    loadMoreVaultItems();
  }

  function mediaSrcForVaultItem(
    item: FourBasedVaultItem,
    size = '200x200.jpg'
  ): string | null {
    if (!providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    return fourBasedMediaUrl(
      creatorId,
      fourBasedPreviewPath(providerUserId, id, size)
    );
  }

  function fullMediaSrc(item: FourBasedVaultItem): string | null {
    if (!providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    return fourBasedMediaUrl(
      creatorId,
      fourBasedPreviewPath(providerUserId, id, '900xxx.jpg')
    );
  }

  function videoStreamSrc(item: FourBasedVaultItem): string | null {
    if (!providerUserId) return null;
    const id = vaultItemId(item);
    if (!id) return null;
    return fourBasedMediaUrl(creatorId, `protected/${providerUserId}/${id}/file.mp4`);
  }

  function messageMediaPath(
    msg: FourBasedMessage,
    size = '400x400.jpg'
  ): string | null {
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

  function messageMediaUrl(
    msg: FourBasedMessage,
    size = '400x400.jpg'
  ): string | null {
    const path = messageMediaPath(msg, size);
    if (!path) return null;
    return fourBasedMediaUrl(creatorId, path);
  }

  function messageVideoUrl(msg: FourBasedMessage): string | null {
    if (!providerUserId || !msg.file_stack?._id) return null;
    const fs = msg.file_stack;
    const vaultId = fs.vault_file_stack_id;
    if (vaultId) {
      return fourBasedMediaUrl(
        creatorId,
        `protected/${providerUserId}/${fs._id}/v/${vaultId}/file.mp4`
      );
    }
    return fourBasedMediaUrl(
      creatorId,
      `protected/${providerUserId}/${fs._id}/file.mp4`
    );
  }

  function isMessageVideo(msg: FourBasedMessage): boolean {
    const fs = msg.file_stack;
    if (!fs) return false;
    const type = String(fs.fileStackType || fs.type || '').toLowerCase();
    return type.includes('video');
  }

  const spent = formatSpent(chat?.sales_volume);

  return (
    <div
      className={`flex-1 flex flex-col min-w-0 min-h-0 relative chatter-thread-bg ${className}`}
    >
      <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95 z-0 pointer-events-none" />

      <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 relative z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md min-w-0">
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
              <h2 className="text-base font-bold text-gray-900 dark:text-white truncate">
                {fan.name || 'Fan'}
              </h2>
              {fanVerified && !fan.isCreator && (
                <span
                  title="Trusted user — verified payment"
                  className="shrink-0 text-amber-400"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                </span>
              )}
              {spent && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  LTV: {spent}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate mt-0.5">
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
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              void loadMessages();
              if (fan.id) void loadFanProfile(fan.id);
            }}
            className="p-2 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all border border-transparent hover:border-gray-300 dark:hover:border-zinc-700"
            title="Refresh"
            aria-label="Refresh messages"
          >
            {messagesLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all border border-transparent hover:border-gray-300 dark:hover:border-zinc-700"
              title="Close chat"
              aria-label="Close chat"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 min-h-0 relative z-10 scroll-smooth animate-fade-in">
        {messagesLoading && messages.length === 0 && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-500 dark:text-zinc-400" />
          </div>
        )}
        {messagesError && <p className="text-sm text-red-400">{messagesError}</p>}
        {deleteError && <p className="text-sm text-red-400">{deleteError}</p>}
        {messages.map((msg) => {
          const mine = msg.user_id === providerUserId;
          const msgKey = String(msg._id || msg.local_id || '');
          const deleted = isDeletedFourBasedMessage(msg);
          const canDelete =
            mine && !deleted && isPersistedFourBasedMessageId(msg._id);
          const deleting = deletingMessageId === msg._id;
          const localKey = typeof msg.local_id === 'string' ? msg.local_id : '';
          const sentBy = mine
            ? messageSenders[`4based:${msg._id}`] ||
              (localKey ? messageSenders[localKey] : undefined) ||
              (msgKey ? messageSenders[msgKey] : undefined)
            : undefined;
          const mediaUrl = deleted ? null : messageMediaUrl(msg, '400x400.jpg');
          const isVideo = !deleted && isMessageVideo(msg);
          const videoUrl = isVideo ? messageVideoUrl(msg) : null;
          const isPlaying = Boolean(isVideo && videoUrl && playingMsgId === msgKey);
          const price = deleted ? undefined : msg.file_stack?.price;
          const ppvLabel = formatPpvDollars(price);
          const isSold = Boolean(ppvLabel && isFourBasedPpvSold(msg.file_stack));
          const isFreeMedia = Boolean(
            !deleted &&
              msg.file_stack &&
              (typeof price !== 'number' || price <= 0)
          );
          const duration = msg.file_stack?.duration;
          const msgText =
            deleted || typeof msg.message !== 'string' ? '' : msg.message.trim();
          const historyEn =
            !deleted && autoTranslateHistory && msgKey && msgText
              ? historyTranslations[`${msgKey}::${msgText}`]
              : undefined;
          const hasMedia = Boolean(!deleted && msg.file_stack && (mediaUrl || videoUrl));
          return (
            <div
              key={msgKey}
              className={`group/msg flex animate-slide-up ${mine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] md:max-w-[70%] flex flex-col ${
                  mine ? 'items-end' : 'items-start'
                }`}
              >
                {canDelete && (
                  <div className={`mb-1 flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMessage(msg._id)}
                      disabled={deleting}
                      className="opacity-0 group-hover/msg:opacity-100 focus:opacity-100 p-1 rounded-md text-gray-500 dark:text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                      title="Delete message"
                      aria-label="Delete message"
                    >
                      {deleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                )}
                {deleted ? (
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm shadow-sm backdrop-blur-sm italic flex items-center gap-2 ${
                      mine
                        ? 'bg-4based-600/70 text-white/90 chat-bubble-out'
                        : 'bg-gray-100/80 dark:bg-zinc-800/80 border border-gray-200 dark:border-zinc-700/50 text-gray-500 dark:text-zinc-400 chat-bubble-in'
                    }`}
                  >
                    <Ban className="w-4 h-4 shrink-0 opacity-80" />
                    <span>Message deleted</span>
                  </div>
                ) : hasMedia || ppvLabel ? (
                  <div
                    className={`rounded-2xl p-1.5 shadow-lg relative overflow-hidden ${
                      mine
                        ? 'bg-emerald-50 dark:bg-zinc-900 border border-4based-500/30 text-white chat-bubble-out'
                        : 'bg-gray-100/80 dark:bg-zinc-800/80 border border-gray-200 dark:border-zinc-700/50 text-gray-800 dark:text-zinc-200 chat-bubble-in'
                    }`}
                  >
                    {isSold && ppvLabel && !isPlaying ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-emerald-600/90 backdrop-blur border border-emerald-400/40 text-[10px] font-bold tracking-widest text-white flex items-center gap-1">
                        <Check className="w-3 h-3" /> Sold · {ppvLabel}
                      </div>
                    ) : ppvLabel && !isPlaying ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/35 dark:bg-black/60 backdrop-blur border border-gray-200 dark:border-white/10 text-[10px] font-bold tracking-widest text-amber-300 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> PPV · {ppvLabel}
                      </div>
                    ) : isFreeMedia && hasMedia && !isPlaying ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/35 dark:bg-black/60 backdrop-blur border border-gray-200 dark:border-white/10 text-[10px] font-bold tracking-widest text-zinc-300 flex items-center gap-1">
                        Free
                      </div>
                    ) : null}
                    {hasMedia && (
                      <div className="mb-2 relative overflow-hidden rounded-xl bg-gray-900 dark:bg-black min-w-[200px]">
                        {isPlaying ? (
                          <video
                            controls
                            autoPlay
                            playsInline
                            preload="auto"
                            poster={mediaUrl || undefined}
                            src={videoUrl || undefined}
                            className="max-h-56 w-full object-contain bg-gray-900 dark:bg-black"
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
                              <div className="h-40 flex items-center justify-center bg-black/10 dark:bg-black/40">
                                <Play className="w-10 h-10 text-white/80" />
                              </div>
                            )}
                            {isVideo && (
                              <span className="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-black/25">
                                <span className="w-10 h-10 rounded-full bg-black/30 dark:bg-black/50 backdrop-blur flex items-center justify-center">
                                  <Play className="w-5 h-5 ml-0.5 text-white" />
                                </span>
                              </span>
                            )}
                          </button>
                        )}
                        {typeof duration === 'number' && duration > 0 && !isPlaying && (
                          <span className="absolute bottom-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/20 dark:bg-black/70 text-white backdrop-blur z-10 pointer-events-none">
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
                        : 'bg-gray-100/80 dark:bg-zinc-800/80 border border-gray-200 dark:border-zinc-700/50 text-gray-800 dark:text-zinc-200 chat-bubble-in'
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
                        ? 'bg-gray-100/60 dark:bg-zinc-800/60 border border-gray-200 dark:border-zinc-700/50 text-gray-700 dark:text-zinc-300'
                        : 'bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400'
                    }`}
                  >
                    {!mine && (
                      <Languages className="w-3 h-3 text-gray-500 dark:text-zinc-500 shrink-0" />
                    )}
                    <span className="whitespace-pre-wrap break-words">{historyEn}</span>
                  </div>
                )}

                <div
                  className={`mt-2 flex flex-col gap-1.5 ${
                    mine ? 'items-end mr-1' : 'items-start ml-1'
                  }`}
                >
                  <span className="text-[10px] text-gray-400 dark:text-zinc-600">
                    {formatTime(msg.created_at)}
                  </span>
                  {sentBy && (
                    <div className="px-2.5 py-0.5 rounded-full bg-white/90 dark:bg-zinc-900/90 border border-gray-200 dark:border-zinc-800 text-[9px] font-medium text-gray-500 dark:text-zinc-400 shadow-sm">
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

      <div className="border-t border-gray-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 p-4 shrink-0 relative z-10 shadow-[0_-10px_40px_rgba(0,0,0,0.3)]">
        {selectedVaultItems.length > 0 && (
          <div className="flex items-center gap-3 mb-3 px-1 animate-fade-in">
            <div className="flex gap-2 max-w-[45%] overflow-x-auto">
              {selectedVaultItems.map((item) => {
                const thumb = mediaSrcForVaultItem(item);
                const id = vaultItemId(item);
                const isTeaser = teaserVaultId === id;
                const canSetTeaser =
                  hasPpvPrice && selectedVaultItems.length >= 2;
                return (
                  <div
                    key={id}
                    className={`relative w-12 h-12 rounded-lg overflow-hidden border shrink-0 ${
                      isTeaser
                        ? 'border-domx-500 ring-1 ring-domx-500/40'
                        : 'border-gray-300 dark:border-zinc-700'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleVaultItem(item)}
                      className="absolute inset-0 group"
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
                        <div className="w-full h-full bg-gray-100 dark:bg-zinc-800" />
                      )}
                      <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/35 dark:bg-black/60 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <X className="w-3 h-3" />
                      </span>
                    </button>
                    {canSetTeaser && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setVaultItemAsTeaser(id);
                        }}
                        className={`absolute bottom-0 inset-x-0 text-[8px] font-bold py-0.5 flex items-center justify-center gap-0.5 ${
                          isTeaser
                            ? 'bg-domx-600 text-white'
                            : 'bg-black/50 text-white/90 hover:bg-black/70'
                        }`}
                        title={
                          isTeaser
                            ? 'Clear preview (teaser)'
                            : 'Set as free preview for fan'
                        }
                      >
                        <Eye className="w-2.5 h-2.5" />
                        {isTeaser ? 'Preview' : 'Set'}
                      </button>
                    )}
                    {isVideoItem(item) && !canSetTeaser && (
                      <span className="absolute bottom-0.5 left-0.5 pointer-events-none">
                        <Play className="w-3 h-3 text-white drop-shadow" />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {hasPpvPrice ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setPriceDraft(ppvDollars);
                      setPriceModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-domx-500/40 bg-domx-600/10 text-sm font-semibold text-domx-600 dark:text-domx-400 hover:bg-domx-600/20 transition-colors"
                    title={`Provision $${ppvDollars} · you ~$${formatUsdAmount(ppvDollarsNum * CREATOR_SHARE)} · fan ~$${formatUsdAmount(ppvDollarsNum * FAN_TAX)}`}
                  >
                    <Lock className="w-3.5 h-3.5" />${ppvDollars}
                    <span className="text-[10px] font-normal text-gray-500 dark:text-zinc-500">
                      · you ${formatUsdAmount(ppvDollarsNum * CREATOR_SHARE)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPpvDollars('');
                      setPriceDraft('');
                      setTeaserVaultId(null);
                    }}
                    className="p-1 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white"
                    aria-label="Remove price"
                    title="Remove price (send free)"
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
                  className="text-sm font-medium text-domx-600 dark:text-domx-400 hover:text-domx-500 dark:hover:text-domx-300 transition-colors whitespace-nowrap"
                >
                  Add price for your media +
                </button>
              )}
              <button
                type="button"
                onClick={clearMediaAttachments}
                className="p-1 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white"
                aria-label="Clear attachment"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {sendError && <p className="text-xs text-red-400 mb-2">{sendError}</p>}
        {translatingOutgoing && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 mb-2">
            Translating to German…
          </p>
        )}

        <QuickEmojiBar onInsert={(emoji) => setDraft((d) => d + emoji)} />

        <div className="flex items-end gap-2 bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-2xl p-2 focus-within:border-domx-500/50 focus-within:bg-zinc-900 transition-all shadow-inner">
          <button
            type="button"
            onClick={() => void openVault()}
            className="p-2 rounded-xl text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
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
            disabled={sending || translatingOutgoing}
            rows={1}
            placeholder={
              autoTranslateOutgoing
                ? 'Type a message… (Auto-translates to German)'
                : 'Type a message…'
            }
            className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-gray-900 dark:text-white focus:outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600 leading-relaxed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleSendText()}
            disabled={
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
        {showTranslationToggles && (
          <FourBasedTranslationToggles className="mt-3" />
        )}
      </div>

      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80 backdrop-blur-sm"
            onClick={() => {
              setVaultOpen(false);
              setPreviewItem(null);
            }}
          />
          <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-slide-up">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60 bg-gray-50 dark:bg-zinc-900/50 backdrop-blur-md">
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
                {selectedVaultItems.length > 0 && (
                  <button
                    type="button"
                    onClick={clearMediaAttachments}
                    className="px-3 py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white transition-colors"
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
                <div className="w-px h-6 bg-gray-100 dark:bg-zinc-800 mx-1" />
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setPreviewItem(null);
                    setVaultPreviewPlaying(false);
                  }}
                  className="p-2 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
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
                <div className="flex justify-center bg-black/10 dark:bg-black/40 rounded-xl p-2 min-h-[240px]">
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
                          <div className="w-64 h-40 flex items-center justify-center rounded bg-black/10 dark:bg-black/40">
                            <Play className="w-12 h-12 text-white" />
                          </div>
                        )}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-black/25 rounded">
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
                      setPreviewItem(null);
                      setVaultPreviewPlaying(false);
                    }}
                    className="px-3 py-2 text-sm rounded-lg bg-domx-600 text-white hover:bg-domx-500"
                  >
                    {selectedVaultItems.some(
                      (entry) => vaultItemId(entry) === vaultItemId(previewItem)
                    )
                      ? 'Remove from selection'
                      : 'Attach'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col overflow-hidden min-h-0">
                <div className="shrink-0 border-b border-gray-200 dark:border-zinc-800/60 space-y-2 p-3">
                  <div className="flex gap-2 overflow-x-auto">
                    {(
                      [
                        { id: 'all' as const, label: 'All' },
                        { id: 'video' as const, label: 'Videos', icon: Video },
                        { id: 'image' as const, label: 'Images', icon: ImageIcon },
                        { id: 'not_purchased' as const, label: 'Not Purchased' },
                        { id: 'purchased' as const, label: 'Purchased' },
                      ] as const
                    ).map((chip) => {
                      const active = vaultCategoryFilter === chip.id;
                      const Icon = 'icon' in chip ? chip.icon : null;
                      return (
                        <button
                          key={chip.id}
                          type="button"
                          onClick={() => void applyVaultFilters({ category: chip.id })}
                          className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                              : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700'
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
                        { id: 'sent' as const, label: 'Sent' },
                        { id: 'not_sent' as const, label: 'Not Sent' },
                      ] as const
                    ).map((chip) => {
                      const active = vaultSentFilter === chip.id;
                      return (
                        <button
                          key={chip.id}
                          type="button"
                          onClick={() => void applyVaultFilters({ sent: chip.id })}
                          className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                              : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700'
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
                      className={`shrink-0 px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                        selectedFolder === null
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700'
                      }`}
                    >
                      All
                    </button>
                    {vaultFolders.map((folder) => {
                      const active = selectedFolder === folder;
                      return (
                        <button
                          key={folder}
                          type="button"
                          onClick={() => void applyVaultFilters({ folder })}
                          className={`shrink-0 px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors max-w-[200px] truncate ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                              : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700'
                          }`}
                          title={folder}
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
                      <Loader2 className="w-6 h-6 animate-spin text-gray-500 dark:text-zinc-400" />
                    </div>
                  )}
                  {vaultError && <p className="text-sm text-red-400">{vaultError}</p>}
                  {!vaultLoading && !vaultError && vaultItems.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-zinc-500">
                      {selectedFolder
                        ? `No media in “${selectedFolder}”.`
                        : 'Vault is empty.'}
                    </p>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {vaultItems.map((item) => {
                      const thumb = mediaSrcForVaultItem(item);
                      const video = isVideoItem(item);
                      const id = vaultItemId(item);
                      const selected = selectedVaultItems.some(
                        (entry) => vaultItemId(entry) === id
                      );
                      return (
                        <div
                          key={id}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleVaultItem(item)}
                          onDoubleClick={() => {
                            setVaultPreviewPlaying(false);
                            setPreviewItem(item);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleVaultItem(item);
                            }
                          }}
                          className={`relative aspect-square rounded-xl overflow-hidden group transition-all cursor-pointer ${
                            selected
                              ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950'
                              : 'border border-gray-200 dark:border-zinc-800 hover:border-gray-400 dark:hover:border-zinc-600'
                          }`}
                          title="Click to select · play to preview video · double-click to preview"
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
                            <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-500">
                              <ImageIcon className="w-6 h-6" />
                            </div>
                          )}
                          {selected && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center z-10 shadow-lg">
                              <Check className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {video && (
                            <>
                              <span className="absolute inset-0 bg-black/5 dark:bg-black/20 group-hover:bg-black/5 dark:group-hover:bg-black/10 transition-colors pointer-events-none" />
                              <button
                                type="button"
                                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/30 dark:bg-black/50 backdrop-blur flex items-center justify-center text-white/90 z-[5] hover:bg-black/50 dark:hover:bg-black/70 transition-colors"
                                aria-label="Play video"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPreviewItem(item);
                                  setVaultPreviewPlaying(true);
                                }}
                              >
                                <Play className="w-5 h-5 ml-0.5" />
                              </button>
                            </>
                          )}
                          {video && item.duration != null && (
                            <span className="absolute bottom-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/20 dark:bg-black/70 text-white backdrop-blur z-10 pointer-events-none">
                              {formatDuration(Number(item.duration))}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {vaultHasMore && (
                    <button
                      type="button"
                      onClick={loadMoreVaultItems}
                      disabled={vaultLoadingMore}
                      className="w-full mt-4 py-2.5 text-sm font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                    >
                      {vaultLoadingMore ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {priceModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 animate-fade-in">
          <button
            type="button"
            aria-label="Close media price"
            className="absolute inset-0 bg-black/40 dark:bg-black/70 backdrop-blur-sm"
            onClick={() => setPriceModalOpen(false)}
          />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 shadow-2xl p-6 animate-slide-up">
            <button
              type="button"
              onClick={() => setPriceModalOpen(false)}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-center text-lg font-bold text-gray-800 dark:text-white mb-2">
              Media price
            </h3>
            <p className="text-center text-xs text-gray-500 dark:text-zinc-500 mb-6">
              Set provision (before tax). Tax is paid by the fan via 4based.
            </p>
            <div className="flex items-center gap-3 border-b border-gray-200 dark:border-zinc-700 pb-3 mb-4">
              <span className="text-2xl font-medium text-gray-700 dark:text-zinc-300">
                $
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
                    const provision = Number(priceDraft);
                    if (Number.isFinite(provision) && provision > 0) {
                      setPpvDollars(String(provision));
                      setPriceModalOpen(false);
                    }
                  }
                }}
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            {Number.isFinite(Number(priceDraft)) && Number(priceDraft) > 0 ? (
              <div className="mb-5 space-y-2 text-sm text-gray-600 dark:text-zinc-400">
                <div className="flex justify-between gap-3">
                  <span>Your share (70%)</span>
                  <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
                    ${formatUsdAmount(Number(priceDraft) * CREATOR_SHARE)}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  ${formatUsdAmount(Number(priceDraft))} × 70% = $
                  {formatUsdAmount(Number(priceDraft) * CREATOR_SHARE)}
                </p>
                <div className="flex justify-between gap-3 pt-1 border-t border-gray-100 dark:border-zinc-800">
                  <span>User pays (+21% tax)</span>
                  <span className="font-semibold text-gray-900 dark:text-white tabular-nums">
                    ${formatUsdAmount(Number(priceDraft) * FAN_TAX)}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  ${formatUsdAmount(Number(priceDraft))} + $
                  {formatUsdAmount(Number(priceDraft) * (FAN_TAX - 1))} = $
                  {formatUsdAmount(Number(priceDraft) * FAN_TAX)}
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-zinc-500 mb-5 text-center">
                Leave unset to send free
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                const provision = Number(priceDraft);
                if (!Number.isFinite(provision) || provision <= 0) return;
                setPpvDollars(String(provision));
                setPriceModalOpen(false);
              }}
              disabled={!Number.isFinite(Number(priceDraft)) || Number(priceDraft) <= 0}
              className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-base transition-colors"
            >
              Set price
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
