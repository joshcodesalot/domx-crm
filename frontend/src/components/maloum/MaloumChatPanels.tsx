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
  Play,
  RefreshCw,
  Send,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import maloumIcon from '@/assets/maloum_icon.png';
import {
  createMessagingDashboardEntry,
  deleteMaloumMessage,
  getMaloumChat,
  getMaloumMessages,
  getMessagingDashboardSenders,
  listMaloumChats,
  listMaloumVaultFolders,
  listMaloumVaultMedia,
  sendMaloumMessage,
  translateToGerman,
  type Creator,
  type MaloumChat,
  type MaloumChatPartner,
  type MaloumMessage,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
  type TranslateHistoryItem,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

type MaloumMediaPreview = {
  url: string;
  kind: 'picture' | 'video' | 'embed';
};

const POLL_MS = 20_000;
const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const HISTORY_TRANSLATE_API_URL = 'https://translate.low7labs.cloud/translate';
const MAX_TRANSLATION_HISTORY = 8;
const TRANSLATION_SETTINGS_EVENT = 'domx-translation-settings';

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function emitTranslationSettings() {
  window.dispatchEvent(new Event(TRANSLATION_SETTINGS_EVENT));
}

function UnreadBadge({
  icon: Icon,
  count,
  label,
  accentClass = 'text-maloum-500',
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
        hasUnread ? accentClass : 'text-zinc-500'
      }`}
      title={label}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      <span>{count > 99 ? '99+' : count}</span>
    </span>
  );
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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

function TranslationToggles({
  autoTranslateOutgoing,
  autoTranslateHistory,
  onOutgoingChange,
  onHistoryChange,
}: {
  autoTranslateOutgoing: boolean;
  autoTranslateHistory: boolean;
  onOutgoingChange: (enabled: boolean) => void;
  onHistoryChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        Assist Settings
      </p>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-zinc-300 group-hover:text-white transition-colors">
          Auto-translate Out
        </span>
        <ToggleSwitch
          checked={autoTranslateOutgoing}
          onChange={onOutgoingChange}
          aria-label="Auto-translate outgoing messages"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-zinc-300 group-hover:text-white transition-colors">
          Show Translation UI
        </span>
        <ToggleSwitch
          checked={autoTranslateHistory}
          onChange={onHistoryChange}
          aria-label="Auto-translate chat history"
        />
      </label>
    </div>
  );
}

export function partnerName(chat: MaloumChat | null | undefined): string {
  if (!chat?.chatPartner) return 'Fan';
  return (
    chat.chatPartner.nickname ||
    chat.chatPartner.username ||
    chat.chatPartner._id ||
    'Fan'
  );
}

export function partnerId(chat: MaloumChat | null | undefined): string | null {
  return chat?.chatPartner?._id ? String(chat.chatPartner._id) : null;
}

export function formatRelativeTime(iso?: string | null): string | null {
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

export function formatSpend(amount?: number | null, currency = 'EUR'): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function parseMessageTime(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function computeMaloumResponseTime(
  messages: MaloumMessage[],
  providerUserId: string | null
): { responseTimeSeconds: number | null; previousFanMessageAt: string | null } {
  if (!providerUserId) {
    return { responseTimeSeconds: null, previousFanMessageAt: null };
  }

  let latestFanAt: number | null = null;
  let latestCreatorAt: number | null = null;

  for (const msg of messages) {
    const at = parseMessageTime(msg.sentAt);
    if (at == null) continue;
    if (msg.senderId === providerUserId) {
      if (latestCreatorAt == null || at > latestCreatorAt) latestCreatorAt = at;
    } else if (msg.senderId) {
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

export function vaultUploadId(item: MaloumVaultMediaItem): string | null {
  return item.media?.uploadId || item.thumbnail?.uploadId || null;
}

export function isVideoAsset(type?: string | null): boolean {
  return String(type || '').toLowerCase() === 'video';
}

export function isHttpsMediaUrl(url?: string | null): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

export function partnerAvatarUrl(
  partner?: MaloumChatPartner | null
): string | null {
  const url =
    partner?.profilePictureThumbnail?.url || partner?.profilePicture?.url;
  return isHttpsMediaUrl(url) ? url : null;
}

function PartnerAvatar({
  partner,
  name,
  className = 'w-10 h-10',
}: {
  partner?: MaloumChatPartner | null;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = partnerAvatarUrl(partner);
  const initial = (name || '?').charAt(0).toUpperCase();
  const showImage = Boolean(avatarUrl) && !failed;

  if (showImage && avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={`${className} rounded-full object-cover border border-zinc-700 shrink-0 bg-zinc-800`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`${className} rounded-full bg-zinc-800 flex items-center justify-center text-sm font-medium border border-zinc-700 shrink-0 text-zinc-300`}
    >
      {initial}
    </div>
  );
}

function isPersistedMaloumMessageId(id?: string | null): boolean {
  if (!id) return false;
  if (id.startsWith('temp-') || id.startsWith('optimistic-')) return false;
  return /^[a-f0-9]{24}$/i.test(id);
}

export function isMediaDeliveryEmbed(url: string): boolean {
  try {
    return new URL(url).hostname.includes('mediadelivery.net');
  } catch {
    return false;
  }
}

export function previewKindFor(
  url: string,
  type?: string | null
): MaloumMediaPreview['kind'] {
  if (isMediaDeliveryEmbed(url)) return 'embed';
  if (isVideoAsset(type)) return 'video';
  return 'picture';
}

export function vaultDirectUrl(item: MaloumVaultMediaItem): string | null {
  const url = item.thumbnail?.url || item.media?.url;
  return isHttpsMediaUrl(url) ? url : null;
}

/** Full/playable URL for vault preview (prefer media over thumbnail). */
export function vaultPreviewUrl(item: MaloumVaultMediaItem): string | null {
  const url = item.media?.url || item.thumbnail?.url;
  return isHttpsMediaUrl(url) ? url : null;
}

export function vaultPreviewFromItem(
  item: MaloumVaultMediaItem
): MaloumMediaPreview | null {
  const url = vaultPreviewUrl(item);
  if (!url) return null;
  return {
    url,
    kind: previewKindFor(url, item.media?.type || item.thumbnail?.type),
  };
}

export function messageText(msg: MaloumMessage): string {
  return msg.content?.text || '';
}

export function messageMediaAssets(msg: MaloumMessage): Array<{
  uploadId?: string;
  thumbUrl?: string;
  fullUrl?: string;
  type?: string;
  width?: number;
  height?: number;
}> {
  const content = msg.content;
  if (!content) return [];
  const thumbs = Array.isArray(content.thumbnails) ? content.thumbnails : [];
  const media = Array.isArray(content.media) ? content.media : [];
  const mediaById = new Map<string, (typeof media)[number]>();
  for (const m of media) {
    const id = m.uploadId || m.mediaId;
    if (id) mediaById.set(String(id), m);
  }

  if (thumbs.length > 0) {
    return thumbs.map((t) => {
      const uploadId = t.uploadId || t.mediaId;
      const full = uploadId ? mediaById.get(String(uploadId)) : undefined;
      return {
        uploadId,
        thumbUrl: t.url,
        fullUrl: full?.url || t.url,
        type: full?.type || t.type,
        width: full?.width ?? t.width,
        height: full?.height ?? t.height,
      };
    });
  }

  return media.map((m) => ({
    uploadId: m.uploadId || m.mediaId,
    thumbUrl: m.url,
    fullUrl: m.url,
    type: m.type,
    width: m.width,
    height: m.height,
  }));
}

type MaloumChatListProps = {
  creatorId: string;
  creatorName?: string;
  selectedChatId?: string | null;
  onSelectChat: (chat: MaloumChat) => void;
  className?: string;
  showHeader?: boolean;
  openActionLabel?: string;
};

export function MaloumChatList({
  creatorId,
  creatorName,
  selectedChatId,
  onSelectChat,
  className = '',
  showHeader = true,
  openActionLabel,
}: MaloumChatListProps) {
  const [chats, setChats] = useState<MaloumChat[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChats = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      const append = Boolean(opts?.append);
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const result = await listMaloumChats(creatorId, {
          limit: 30,
          next: opts?.next || undefined,
        });
        setChats((prev) =>
          append ? [...prev, ...(result.chats || [])] : result.chats || []
        );
        setNextCursor(result.next || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load chats');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [creatorId]
  );

  useEffect(() => {
    void loadChats();
    const timer = window.setInterval(() => {
      void loadChats();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadChats]);

  return (
    <div className={`flex flex-col h-full min-h-0 bg-[#0a0a0c] ${className}`}>
      {showHeader && (
        <div className="h-16 px-5 border-b border-zinc-800/60 flex items-center justify-between gap-2 shrink-0 bg-zinc-900/20">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2 min-w-0">
            <span className="truncate">{creatorName || 'Creator'}</span>
            {creatorName && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
                Active
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={() => void loadChats()}
            disabled={loading}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-40"
            title="Refresh chats"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto min-h-0 animate-fade-in">
        {error && (
          <p className="text-xs text-red-400 p-3">{error}</p>
        )}
        {!loading && !error && chats.length === 0 && (
          <p className="text-xs text-zinc-500 p-3">No chats yet.</p>
        )}
        {chats.map((chat) => {
          const active = chat._id === selectedChatId;
          const name = partnerName(chat);
          const spend = formatSpend(chat.chatPartner?.totalSpendForCreator, 'EUR');
          const relative = formatRelativeTime(chat.lastRelevantMessage?.sentAt);
          const preview =
            chat.lastRelevantMessage?.text ||
            (chat.lastRelevantMessage?.type === 'chat_product'
              ? 'PPV'
              : chat.lastRelevantMessage?.type === 'media'
                ? 'Media'
                : '—');
          return (
            <button
              key={chat._id}
              type="button"
              onClick={() => onSelectChat(chat)}
              className={`w-full text-left p-3 border-l-2 transition-colors relative ${
                active
                  ? 'border-maloum-500 bg-zinc-900/60 hover:bg-zinc-900/80'
                  : 'border-transparent hover:bg-zinc-900/40 border-b border-b-zinc-800/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <PartnerAvatar partner={chat.chatPartner} name={name} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between min-w-0 mb-0.5">
                    <span
                      className={`text-sm truncate ${
                        active
                          ? 'font-semibold text-white'
                          : 'font-medium text-zinc-200'
                      }`}
                    >
                      {name}
                    </span>
                    <span className="text-[10px] text-zinc-500 shrink-0 ml-2">
                      {relative || ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-zinc-400 truncate flex-1">{preview}</p>
                    {spend && (
                      <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {spend}
                      </span>
                    )}
                    {openActionLabel && (
                      <span className="text-[10px] text-maloum-500 shrink-0">
                        {openActionLabel}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {chat.unreadMessages && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-maloum-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" />
              )}
            </button>
          );
        })}
        {nextCursor && (
          <button
            type="button"
            onClick={() => void loadChats({ append: true, next: nextCursor })}
            disabled={loadingMore}
            className="w-full py-2 text-xs text-maloum-500 hover:underline disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

type MaloumChatThreadProps = {
  creator: Creator;
  chatId: string;
  initialChat?: MaloumChat | null;
  className?: string;
  onClose?: () => void;
  /** Show translation toggles under the composer (e.g. Message Pro). */
  showTranslationToggles?: boolean;
};

export function MaloumChatThread({
  creator,
  chatId,
  initialChat = null,
  className = '',
  onClose,
  showTranslationToggles = false,
}: MaloumChatThreadProps) {
  const { user } = useAuth();
  const creatorId = creator.id;

  const [chat, setChat] = useState<MaloumChat | null>(initialChat);
  const [providerUserId, setProviderUserId] = useState<string | null>(
    creator.accountId || null
  );
  const [messages, setMessages] = useState<MaloumMessage[]>([]);
  const [messagesNext, setMessagesNext] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

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
  const [historyTranslations, setHistoryTranslations] = useState<
    Record<string, string>
  >({});
  const historyTranslationsRef = useRef<Record<string, string>>({});
  const historyInFlightRef = useRef<Set<string>>(new Set());

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<MaloumVaultFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<MaloumVaultMediaItem[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItems, setSelectedVaultItems] = useState<MaloumVaultMediaItem[]>(
    []
  );
  const [vaultTypeFilter, setVaultTypeFilter] = useState<'all' | 'image' | 'video'>(
    'all'
  );
  const [ppvPrice, setPpvPrice] = useState('5');
  const [preview, setPreview] = useState<MaloumMediaPreview | null>(null);
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>(
    {}
  );
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  /** Maloum is EUR-only in the chatter UI. */
  const currency = 'EUR';

  const loadMessages = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      const append = Boolean(opts?.append);
      if (!append) setMessagesLoading(true);
      setMessagesError(null);
      try {
        const [chatResult, msgResult] = await Promise.all([
          append
            ? Promise.resolve(null)
            : getMaloumChat(creatorId, chatId).catch(() => null),
          getMaloumMessages(creatorId, chatId, {
            limit: 30,
            next: opts?.next || undefined,
          }),
        ]);
        if (chatResult?.chat) {
          setChat(chatResult.chat);
        }
        if (chatResult?.providerUserId) {
          setProviderUserId(chatResult.providerUserId);
        } else if (msgResult.providerUserId) {
          setProviderUserId(msgResult.providerUserId);
        }
        const incoming = msgResult.messages || [];
        // API returns newest-first; reverse for chronological display
        const chronological = [...incoming].reverse();
        setMessages((prev) =>
          append ? [...chronological, ...prev] : chronological
        );
        setMessagesNext(msgResult.next || null);
      } catch (err) {
        setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setMessagesLoading(false);
      }
    },
    [creatorId, chatId]
  );

  const loadSenders = useCallback(async () => {
    try {
      const result = await getMessagingDashboardSenders({
        creatorId,
        chatId,
        limit: 200,
      });
      setMessageSenders(result.senders || {});
    } catch {
      // best-effort
    }
  }, [creatorId, chatId]);

  useEffect(() => {
    setChat(initialChat);
    setMessages([]);
    setDraft('');
    setSendError(null);
    setSelectedVaultItems([]);
    setVaultOpen(false);
    setMessageSenders({});
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyInFlightRef.current.clear();
    void loadMessages();
    void loadSenders();
    const timer = window.setInterval(() => {
      void loadMessages();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [chatId, creatorId, initialChat, loadMessages, loadSenders]);

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

  const handleAutoTranslateOutgoingChange = useCallback((enabled: boolean) => {
    setAutoTranslateOutgoing(enabled);
    localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  const handleAutoTranslateHistoryChange = useCallback((enabled: boolean) => {
    setAutoTranslateHistory(enabled);
    localStorage.setItem(AUTO_TRANSLATE_HISTORY_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (!autoTranslateHistory) return;
    const pending: Array<{ key: string; text: string }> = [];
    for (const msg of messages) {
      const text = messageText(msg).trim();
      if (!text) continue;
      const msgKey = String(msg._id || '');
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
            // Best-effort
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

  const toggleVaultItem = useCallback((item: MaloumVaultMediaItem) => {
    const uploadId = vaultUploadId(item);
    if (!uploadId) return;
    setSelectedVaultItems((prev) => {
      const exists = prev.some((entry) => vaultUploadId(entry) === uploadId);
      if (exists) {
        return prev.filter((entry) => vaultUploadId(entry) !== uploadId);
      }
      return [...prev, item];
    });
  }, []);

  const openVault = useCallback(async () => {
    setVaultOpen(true);
    setVaultTypeFilter('all');
    setVaultLoading(true);
    setVaultError(null);
    try {
      const result = await listMaloumVaultFolders(creatorId, { limit: 30 });
      setVaultFolders(result.folders || []);
      if (!selectedFolderId && result.folders?.[0]?._id) {
        setSelectedFolderId(result.folders[0]._id);
      }
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
    } finally {
      setVaultLoading(false);
    }
  }, [creatorId, selectedFolderId]);

  useEffect(() => {
    if (!vaultOpen || !selectedFolderId) return;
    let cancelled = false;
    (async () => {
      setVaultLoading(true);
      setVaultError(null);
      try {
        const fanId = partnerId(chat) || undefined;
        const result = await listMaloumVaultMedia(creatorId, selectedFolderId, {
          fanId,
          limit: 50,
        });
        if (!cancelled) {
          setVaultItems(result.items || []);
        }
      } catch (err) {
        if (!cancelled) {
          setVaultError(err instanceof Error ? err.message : 'Failed to load media');
        }
      } finally {
        if (!cancelled) setVaultLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultOpen, selectedFolderId, creatorId, chat]);

  const handleSend = useCallback(async () => {
    const englishDraft = draft.trim();
    const vaultItemsSelected = selectedVaultItems;
    if (!englishDraft && vaultItemsSelected.length === 0) return;
    if (sending || translatingOutgoing) return;

    setSending(true);
    setSendError(null);
    try {
      let textToSend = englishDraft;
      if (autoTranslateOutgoing && englishDraft) {
        setTranslatingOutgoing(true);
        try {
          const history: TranslateHistoryItem[] = messages
            .filter((m) => messageText(m).trim())
            .slice(-MAX_TRANSLATION_HISTORY)
            .map((m) => ({
              role:
                providerUserId && m.senderId === providerUserId
                  ? 'assistant'
                  : 'user',
              content: messageText(m).trim(),
            }));
          textToSend = await translateToGerman(englishDraft, history);
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

      const optimisticMessageId = crypto.randomUUID();
      const priceNet = Number(ppvPrice) || 0;
      const responseSnapshot = computeMaloumResponseTime(messages, providerUserId);

      let mediaPayload:
        | Array<{ mediaId: string; type?: string; width?: number; height?: number }>
        | undefined;
      if (vaultItemsSelected.length > 0) {
        mediaPayload = [];
        for (const vaultItem of vaultItemsSelected) {
          const uploadId = vaultUploadId(vaultItem);
          if (!uploadId) {
            throw new Error('Selected vault item is missing uploadId');
          }
          mediaPayload.push({
            mediaId: uploadId,
            type: vaultItem.media?.type || 'picture',
            width: vaultItem.media?.width,
            height: vaultItem.media?.height,
          });
        }
      }

      const result = await sendMaloumMessage(creatorId, chatId, {
        text: textToSend,
        media: mediaPayload,
        priceNet: mediaPayload && priceNet > 0 ? priceNet : undefined,
        optimisticMessageId,
      });

      const messageId = result.messageId || result.message?._id;
      if (user?.id && messageId) {
        const hasMedia = Boolean(mediaPayload?.length);
        const pictureCount = vaultItemsSelected.filter(
          (item) => !isVideoAsset(item.media?.type)
        ).length;
        const videoCount = vaultItemsSelected.filter((item) =>
          isVideoAsset(item.media?.type)
        ).length;
        const chatterName = user.name;
        setMessageSenders((prev) => ({
          ...prev,
          [messageId]: chatterName,
          [optimisticMessageId]: chatterName,
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
          fanId: partnerId(chat),
          fanUsername: partnerName(chat),
          maloumMessageId: messageId,
          optimisticMessageId,
          contentType: hasMedia
            ? priceNet > 0
              ? 'chat_product'
              : 'media'
            : 'text',
          englishMessage: englishDraft || textToSend || null,
          germanTranslatedMessage: textToSend || null,
          actualSentText: textToSend || null,
          priceNet: hasMedia && priceNet > 0 ? priceNet : null,
          currency: 'EUR',
          purchased: false,
          mediaCount: mediaPayload?.length || 0,
          pictureCount,
          videoCount,
          mediaJson: hasMedia
            ? mediaPayload!.map((entry) => ({
                mediaId: entry.mediaId,
                type: isVideoAsset(entry.type) ? 'video' : 'image',
              }))
            : null,
          previousFanMessageAt: responseSnapshot.previousFanMessageAt,
          responseTimeSeconds: responseSnapshot.responseTimeSeconds,
          sentAt: new Date().toISOString(),
        }).catch(() => {
          // Non-blocking
        });
      }

      setDraft('');
      setSelectedVaultItems([]);
      await loadMessages();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
      setTranslatingOutgoing(false);
    }
  }, [
    draft,
    selectedVaultItems,
    sending,
    translatingOutgoing,
    autoTranslateOutgoing,
    ppvPrice,
    messages,
    providerUserId,
    creatorId,
    chatId,
    user,
    creator,
    chat,
    currency,
    loadMessages,
  ]);

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!isPersistedMaloumMessageId(messageId) || deletingMessageId) return;
      if (!window.confirm('Delete this message?')) return;
      setDeletingMessageId(messageId);
      setDeleteError(null);
      try {
        await deleteMaloumMessage(creatorId, chatId, messageId, {
          deleteTextOnly: false,
        });
        setMessages((prev) => prev.filter((m) => m._id !== messageId));
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : 'Failed to delete message');
      } finally {
        setDeletingMessageId(null);
      }
    },
    [creatorId, chatId, deletingMessageId]
  );

  const title = partnerName(chat);
  const spend = formatSpend(chat?.chatPartner?.totalSpendForCreator, 'EUR');
  const currencySymbol = '€';

  const filteredVaultItems = useMemo(() => {
    if (vaultTypeFilter === 'all') return vaultItems;
    return vaultItems.filter((item) => {
      const video = isVideoAsset(item.media?.type);
      return vaultTypeFilter === 'video' ? video : !video;
    });
  }, [vaultItems, vaultTypeFilter]);

  return (
    <div
      className={`flex flex-col h-full min-h-0 relative chatter-thread-bg ${className}`}
    >
      <div className="absolute inset-0 bg-zinc-950/95 z-0 pointer-events-none" />

      <div className="h-16 px-4 md:px-6 border-b border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 relative z-10 bg-zinc-950/80 backdrop-blur-md">
        <div className="flex items-center gap-4 min-w-0">
          <div className="relative shrink-0 hidden sm:block">
            <PartnerAvatar partner={chat?.chatPartner} name={title} />
            <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-zinc-950" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-base font-bold text-white truncate">{title}</h2>
              {spend && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  LTV: {spend}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500 truncate mt-0.5">
              @{chat?.chatPartner?.username || 'fan'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadMessages()}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all border border-transparent hover:border-zinc-700"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all border border-transparent hover:border-zinc-700"
              title="Close chat"
              aria-label="Close chat"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 min-h-0 relative z-10 scroll-smooth animate-fade-in">
        {messagesNext && (
          <button
            type="button"
            onClick={() => void loadMessages({ append: true, next: messagesNext })}
            className="mx-auto block text-xs text-maloum-500 hover:underline"
          >
            Load older messages
          </button>
        )}
        {messagesLoading && messages.length === 0 && (
          <p className="text-xs text-zinc-500 text-center py-8">Loading messages…</p>
        )}
        {messagesError && (
          <p className="text-xs text-red-400">{messagesError}</p>
        )}
        {deleteError && (
          <p className="text-xs text-red-400">{deleteError}</p>
        )}
        {messages.map((msg) => {
          const mine = Boolean(
            providerUserId && msg.senderId && msg.senderId === providerUserId
          );
          const assets = messageMediaAssets(msg);
          const text = messageText(msg);
          const msgKey = String(msg._id || '');
          const canDelete = mine && isPersistedMaloumMessageId(msgKey);
          const deleting = deletingMessageId === msgKey;
          const optimisticKey =
            typeof msg.optimisticMessageId === 'string'
              ? msg.optimisticMessageId
              : '';
          const sentBy =
            mine && msgKey
              ? messageSenders[msgKey] ||
                (optimisticKey ? messageSenders[optimisticKey] : undefined)
              : undefined;
          const historyEn =
            autoTranslateHistory && msgKey && text.trim()
              ? historyTranslations[`${msgKey}::${text.trim()}`]
              : undefined;
          const isPpv = msg.content?.type === 'chat_product';
          const ppvLabel =
            isPpv && typeof msg.content?.priceNet === 'number'
              ? formatSpend(msg.content.priceNet, 'EUR')
              : null;
          return (
            <div
              key={msg._id}
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
                      onClick={() => void handleDeleteMessage(msgKey)}
                      disabled={deleting}
                      className="opacity-0 group-hover/msg:opacity-100 focus:opacity-100 p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
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
                {assets.length > 0 || isPpv ? (
                  <div
                    className={`rounded-2xl p-1.5 shadow-lg relative overflow-hidden ${
                      mine
                        ? 'bg-zinc-900 border border-maloum-500/30 text-white chat-bubble-out'
                        : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 chat-bubble-in'
                    }`}
                  >
                    {ppvLabel && (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/60 backdrop-blur border border-white/10 text-[10px] font-bold tracking-widest text-emerald-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> PPV · {ppvLabel}
                      </div>
                    )}
                    {assets.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {assets.map((asset, idx) => {
                          const thumbSrc =
                            (isHttpsMediaUrl(asset.thumbUrl) && asset.thumbUrl) ||
                            (isHttpsMediaUrl(asset.fullUrl) && asset.fullUrl) ||
                            null;
                          const fullSrc =
                            (isHttpsMediaUrl(asset.fullUrl) && asset.fullUrl) ||
                            thumbSrc;
                          const video = isVideoAsset(asset.type);
                          return (
                            <button
                              key={`${msg._id}-${asset.uploadId || idx}`}
                              type="button"
                              onClick={() => {
                                if (!fullSrc) return;
                                setPreview({
                                  url: fullSrc,
                                  kind: previewKindFor(fullSrc, asset.type),
                                });
                              }}
                              className="w-32 h-32 md:w-40 md:h-40 rounded-xl relative overflow-hidden group"
                            >
                              {thumbSrc ? (
                                <img
                                  src={thumbSrc}
                                  alt=""
                                  className="w-full h-full object-cover bg-black/20 group-hover:scale-105 transition-transform duration-500"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                                  <ImageIcon className="w-6 h-6" />
                                </div>
                              )}
                              {video && (
                                <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                                  <span className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white/90">
                                    <Play className="w-5 h-5 ml-0.5" />
                                  </span>
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {text && (
                      <div className="px-3 pb-2 pt-1 text-sm">
                        <p className="whitespace-pre-wrap break-words">{text}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm shadow-sm backdrop-blur-sm ${
                      mine
                        ? 'bg-maloum-600 text-white chat-bubble-out shadow-md'
                        : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 chat-bubble-in'
                    }`}
                  >
                    {text && (
                      <p className="whitespace-pre-wrap break-words">{text}</p>
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
                    {formatRelativeTime(msg.sentAt) || ''}
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
                const uploadId = vaultUploadId(item);
                const src = vaultDirectUrl(item);
                return (
                  <button
                    key={uploadId || src || 'vault-chip'}
                    type="button"
                    onClick={() => toggleVaultItem(item)}
                    className="w-12 h-12 rounded-lg relative group overflow-hidden border border-zinc-700 shrink-0"
                    title="Remove"
                  >
                    {src ? (
                      <img src={src} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                        <ImageIcon className="w-4 h-4" />
                      </div>
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
                    {currencySymbol}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ppvPrice}
                    onChange={(e) => setPpvPrice(e.target.value)}
                    className="w-20 pl-6 pr-2 py-1 rounded-md border border-zinc-700 bg-zinc-900 text-sm text-white focus:border-domx-500 focus:outline-none transition-colors"
                  />
                </div>
              </div>
              <span className="text-xs text-zinc-400 mt-4">
                {selectedVaultItems.length} item
                {selectedVaultItems.length === 1 ? '' : 's'} attached
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
            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors shrink-0"
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
                void handleSend();
              }
            }}
            rows={1}
            placeholder={
              autoTranslateOutgoing
                ? 'Type a message… (Auto-translates to German)'
                : 'Type a message…'
            }
            className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-white focus:outline-none placeholder:text-zinc-600 leading-relaxed"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
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
          <div className="mt-3">
            <TranslationToggles
              autoTranslateOutgoing={autoTranslateOutgoing}
              autoTranslateHistory={autoTranslateHistory}
              onOutgoingChange={handleAutoTranslateOutgoingChange}
              onHistoryChange={handleAutoTranslateHistoryChange}
            />
          </div>
        )}
      </div>

      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-fade-in">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setVaultOpen(false)}
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
                  onClick={() => setVaultOpen(false)}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500 transition-colors shadow-lg shadow-domx-600/20"
                >
                  Insert Media
                </button>
                <div className="w-px h-6 bg-zinc-800 mx-1" />
                <button
                  type="button"
                  onClick={() => setVaultOpen(false)}
                  className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden min-h-0">
              <div className="w-48 sm:w-56 border-r border-zinc-800/60 bg-zinc-900/20 p-3 overflow-y-auto hidden md:block shrink-0">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-3 px-2">
                  Folders
                </h4>
                <ul className="space-y-1">
                  {vaultFolders.map((folder) => {
                    const active = selectedFolderId === folder._id;
                    return (
                      <li key={folder._id}>
                        <button
                          type="button"
                          onClick={() => setSelectedFolderId(folder._id)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 truncate ${
                            active
                              ? 'bg-zinc-800 text-white font-medium'
                              : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'
                          }`}
                          title={folder.name || 'Folder'}
                        >
                          {active ? (
                            <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 shrink-0" />
                          )}
                          <span className="truncate">{folder.name || 'Folder'}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="flex-1 flex flex-col min-w-0">
                <div className="p-3 border-b border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0 md:hidden">
                  {vaultFolders.map((folder) => (
                    <button
                      key={folder._id}
                      type="button"
                      onClick={() => setSelectedFolderId(folder._id)}
                      className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors max-w-[160px] truncate ${
                        selectedFolderId === folder._id
                          ? 'bg-zinc-800 text-white border-zinc-700'
                          : 'bg-zinc-900/50 text-zinc-400 border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      {folder.name || 'Folder'}
                    </button>
                  ))}
                </div>
                <div className="p-3 border-b border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
                  {(
                    [
                      { id: 'all', label: 'All Types' },
                      { id: 'image', label: 'Images', icon: ImageIcon },
                      { id: 'video', label: 'Videos', icon: Video },
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
                        {selectedFolderId
                          ? 'No media in this folder.'
                          : 'Vault is empty.'}
                      </p>
                    )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {filteredVaultItems.map((item) => {
                      const uploadId = vaultUploadId(item);
                      const src = vaultDirectUrl(item);
                      const selected = selectedVaultItems.some(
                        (entry) => vaultUploadId(entry) === uploadId
                      );
                      const video = isVideoAsset(item.media?.type);
                      const durationSec =
                        typeof item.media?.length === 'number'
                          ? item.media.length
                          : undefined;
                      const durationLabel = formatDuration(durationSec);
                      const openPreview = () => {
                        const next = vaultPreviewFromItem(item);
                        if (next) setPreview(next);
                      };
                      return (
                        <div
                          key={uploadId || src || 'vault-item'}
                          className={`relative aspect-square rounded-xl overflow-hidden group transition-all ${
                            selected
                              ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-zinc-950'
                              : 'border border-zinc-800 hover:border-zinc-600'
                          }`}
                          title="Click to select · double-click to preview"
                        >
                          <button
                            type="button"
                            onClick={() => toggleVaultItem(item)}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              openPreview();
                            }}
                            className="absolute inset-0 w-full h-full text-left"
                            aria-label={video ? 'Select video' : 'Select image'}
                          >
                            {src ? (
                              <img
                                src={src}
                                alt=""
                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
                                loading="lazy"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                                <ImageIcon className="w-6 h-6" />
                              </div>
                            )}
                          </button>
                          {selected && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center z-10 shadow-lg pointer-events-none">
                              <Check className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {video && (
                            <div className="absolute inset-0 z-[5] flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors pointer-events-none">
                              <button
                                type="button"
                                aria-label="Play video"
                                className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white/90 pointer-events-auto hover:bg-black/70 transition-colors"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openPreview();
                                }}
                              >
                                <Play className="w-5 h-5 ml-0.5" />
                              </button>
                            </div>
                          )}
                          {video && durationLabel && (
                            <span className="absolute bottom-2 right-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white backdrop-blur pointer-events-none">
                              {durationLabel}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 animate-fade-in">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close preview"
            onClick={() => setPreview(null)}
          />
          {preview.kind === 'embed' ? (
            <iframe
              src={preview.url}
              title="Video"
              className="relative z-10 w-full max-w-3xl aspect-[9/16] max-h-full rounded-lg bg-black animate-slide-up"
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : preview.kind === 'video' ? (
            <video
              src={preview.url}
              controls
              autoPlay
              playsInline
              className="relative z-10 max-w-full max-h-full rounded-lg bg-black animate-slide-up"
            >
              <track kind="captions" />
            </video>
          ) : (
            <img
              src={preview.url}
              alt=""
              className="relative z-10 max-w-full max-h-full rounded-lg object-contain animate-slide-up"
            />
          )}
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

type MaloumSingleCreatorChatProps = {
  creators: Creator[];
  creatorsLoading?: boolean;
  selectedCreatorId: string | null;
  onSelectCreator: (id: string) => void;
  unreadByCreatorId?: Record<string, number>;
  notificationUnreadByCreatorId?: Record<string, number>;
};

export function MaloumSingleCreatorChat({
  creators,
  creatorsLoading = false,
  selectedCreatorId,
  onSelectCreator,
  unreadByCreatorId = {},
  notificationUnreadByCreatorId = {},
}: MaloumSingleCreatorChatProps) {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<MaloumChat | null>(null);
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const [autoTranslateHistory, setAutoTranslateHistory] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true)
  );

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  useEffect(() => {
    setSelectedChatId(null);
    setSelectedChat(null);
  }, [selectedCreatorId]);

  useEffect(() => {
    const sync = () => {
      setAutoTranslateOutgoing(readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true));
      setAutoTranslateHistory(readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true));
    };
    window.addEventListener(TRANSLATION_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(TRANSLATION_SETTINGS_EVENT, sync);
  }, []);

  const handleAutoTranslateOutgoingChange = useCallback((enabled: boolean) => {
    setAutoTranslateOutgoing(enabled);
    localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  const handleAutoTranslateHistoryChange = useCallback((enabled: boolean) => {
    setAutoTranslateHistory(enabled);
    localStorage.setItem(AUTO_TRANSLATE_HISTORY_KEY, String(enabled));
    emitTranslationSettings();
  }, []);

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-zinc-950 text-zinc-300">
      <aside className="w-64 border-r border-zinc-800/60 flex flex-col shrink-0 bg-zinc-950/50 glass-panel">
        <div className="h-16 px-4 border-b border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-white">Maloum</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5 animate-fade-in">
          {creatorsLoading && (
            <p className="text-xs text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-zinc-500 p-3">
              No Maloum creators yet. Connect one from Manage Creators.
            </p>
          )}
          {creators.map((creator) => {
            const unread = unreadByCreatorId[creator.id] || 0;
            const notificationUnread = notificationUnreadByCreatorId[creator.id] || 0;
            const active = selectedCreatorId === creator.id;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => onSelectCreator(creator.id)}
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
                    className={`w-10 h-10 rounded-full object-cover shrink-0 ${
                      active ? 'shadow-md' : 'opacity-80 group-hover:opacity-100'
                    }`}
                    initialsClassName={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 ${
                      active
                        ? 'shadow-md bg-gradient-to-br from-orange-400 to-rose-500'
                        : 'opacity-80 group-hover:opacity-100 bg-gradient-to-br from-pink-400 to-purple-500'
                    }`}
                  />
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
                      count={unread}
                      label="Unread messages"
                      accentClass="text-maloum-500"
                    />
                    <UnreadBadge
                      icon={Bell}
                      count={notificationUnread}
                      label="Unread notifications"
                      accentClass="text-zinc-400"
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-zinc-800/60 p-4 bg-zinc-950/80">
          <TranslationToggles
            autoTranslateOutgoing={autoTranslateOutgoing}
            autoTranslateHistory={autoTranslateHistory}
            onOutgoingChange={handleAutoTranslateOutgoingChange}
            onHistoryChange={handleAutoTranslateHistoryChange}
          />
        </div>
      </aside>

      <aside className="w-80 border-r border-zinc-800/60 flex flex-col shrink-0 bg-[#0a0a0c] glass-panel">
        {selectedCreatorId ? (
          <MaloumChatList
            creatorId={selectedCreatorId}
            creatorName={selectedCreator?.displayName}
            selectedChatId={selectedChatId}
            onSelectChat={(chat) => {
              setSelectedChatId(chat._id);
              setSelectedChat(chat);
            }}
          />
        ) : (
          <p className="text-xs text-zinc-500 p-4">Select a creator</p>
        )}
      </aside>

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selectedCreator && selectedChatId ? (
          <MaloumChatThread
            creator={selectedCreator}
            chatId={selectedChatId}
            initialChat={selectedChat}
            onClose={() => {
              setSelectedChatId(null);
              setSelectedChat(null);
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-zinc-500 chatter-thread-bg relative">
            <div className="absolute inset-0 bg-zinc-950/95" />
            <span className="relative z-10">Select a creator chat to start</span>
          </div>
        )}
      </main>
    </div>
  );
}
