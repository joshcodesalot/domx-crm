import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Check,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  X,
  type LucideIcon,
} from 'lucide-react';
import ToggleSwitch from '@/components/ToggleSwitch';
import {
  createMessagingDashboardEntry,
  getMaloumChat,
  getMaloumMessages,
  getMessagingDashboardSenders,
  listMaloumChats,
  listMaloumVaultFolders,
  listMaloumVaultMedia,
  maloumMediaUrl,
  sendMaloumMessage,
  translateToGerman,
  type Creator,
  type MaloumChat,
  type MaloumMessage,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
  type TranslateHistoryItem,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

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
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Translation
      </p>
      <label className="flex items-start gap-3 cursor-pointer">
        <ToggleSwitch
          checked={autoTranslateOutgoing}
          onChange={onOutgoingChange}
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
          onChange={onHistoryChange}
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

export function messageText(msg: MaloumMessage): string {
  return msg.content?.text || '';
}

export function messageMediaAssets(msg: MaloumMessage): Array<{
  uploadId?: string;
  url?: string;
  type?: string;
  width?: number;
  height?: number;
  isThumb?: boolean;
}> {
  const content = msg.content;
  if (!content) return [];
  const thumbs = Array.isArray(content.thumbnails) ? content.thumbnails : [];
  const media = Array.isArray(content.media) ? content.media : [];
  if (thumbs.length > 0) {
    return thumbs.map((t) => ({
      uploadId: t.uploadId || t.mediaId,
      url: t.url,
      type: t.type,
      width: t.width,
      height: t.height,
      isThumb: true,
    }));
  }
  return media.map((m) => ({
    uploadId: m.uploadId || m.mediaId,
    url: m.url,
    type: m.type,
    width: m.width,
    height: m.height,
    isThumb: false,
  }));
}

type MaloumChatListProps = {
  creatorId: string;
  selectedChatId?: string | null;
  onSelectChat: (chat: MaloumChat) => void;
  className?: string;
  showHeader?: boolean;
  openActionLabel?: string;
};

export function MaloumChatList({
  creatorId,
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
    <div className={`flex flex-col h-full min-h-0 ${className}`}>
      {showHeader && (
        <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between gap-2 shrink-0">
          <span className="text-sm font-medium">Chats</span>
          <button
            type="button"
            onClick={() => void loadChats()}
            disabled={loading}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-40"
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
      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400 p-3">{error}</p>
        )}
        {!loading && !error && chats.length === 0 && (
          <p className="text-xs text-gray-500 p-3">No conversations yet.</p>
        )}
        {chats.map((chat) => {
          const active = chat._id === selectedChatId;
          const name = partnerName(chat);
          const spend = formatSpend(chat.chatPartner?.totalSpendForCreator);
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
              className={`w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-white/5 transition-colors ${
                active
                  ? 'bg-brand-50 dark:bg-brand-900/20'
                  : 'hover:bg-gray-50 dark:hover:bg-white/5'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium shrink-0">
                  {name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium truncate">{name}</span>
                    {spend && (
                      <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        {spend}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1 shrink-0">
                      {chat.unreadMessages && (
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                      )}
                      {openActionLabel && (
                        <span className="text-[10px] text-brand-600 dark:text-brand-400">
                          {openActionLabel}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {preview}
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
        {nextCursor && (
          <button
            type="button"
            onClick={() => void loadChats({ append: true, next: nextCursor })}
            disabled={loadingMore}
            className="w-full py-2 text-xs text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50"
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
  const [ppvPrice, setPpvPrice] = useState('5');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>(
    {}
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const currency =
    (typeof chat?.lastRelevantMessage?.priceCurrency === 'string' &&
      chat.lastRelevantMessage.priceCurrency) ||
    'EUR';

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
          currency: typeof currency === 'string' ? currency : 'EUR',
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

  const title = partnerName(chat);
  const spend = formatSpend(chat?.chatPartner?.totalSpendForCreator);

  return (
    <div className={`flex flex-col h-full min-h-0 relative ${className}`}>
      <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold truncate">{title}</h2>
            {spend && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                {spend}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">
            @{chat?.chatPartner?.username || 'fan'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadMessages()}
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5"
            title="Close conversation"
            aria-label="Close conversation"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {messagesNext && (
          <button
            type="button"
            onClick={() => void loadMessages({ append: true, next: messagesNext })}
            className="mx-auto block text-xs text-brand-600 dark:text-brand-400 hover:underline"
          >
            Load older messages
          </button>
        )}
        {messagesLoading && messages.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-8">Loading messages…</p>
        )}
        {messagesError && (
          <p className="text-xs text-red-600 dark:text-red-400">{messagesError}</p>
        )}
        {messages.map((msg) => {
          const mine = Boolean(
            providerUserId && msg.senderId && msg.senderId === providerUserId
          );
          const assets = messageMediaAssets(msg);
          const text = messageText(msg);
          const msgKey = String(msg._id || '');
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
          return (
            <div
              key={msg._id}
              className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                  mine
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100'
                }`}
              >
                {assets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {assets.map((asset, idx) => {
                      const src = maloumMediaUrl(creatorId, {
                        uploadId: asset.uploadId,
                        variant: 'thumbnail',
                        url: asset.url,
                      });
                      const fullSrc = maloumMediaUrl(creatorId, {
                        uploadId: asset.uploadId,
                        variant: 'full',
                        url: asset.url,
                      });
                      return (
                        <button
                          key={`${msg._id}-${asset.uploadId || idx}`}
                          type="button"
                          onClick={() => setPreviewUrl(fullSrc)}
                          className="block overflow-hidden rounded-lg"
                        >
                          <img
                            src={src}
                            alt=""
                            className="w-28 h-28 object-cover bg-black/20"
                            loading="lazy"
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
                {isPpv && typeof msg.content?.priceNet === 'number' && (
                  <p className="text-[10px] uppercase tracking-wide opacity-80 mb-1">
                    PPV · {formatSpend(msg.content.priceNet, currency || 'EUR')}
                  </p>
                )}
                {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
                {historyEn && (
                  <p
                    className={`mt-1 text-xs whitespace-pre-wrap break-words ${
                      mine ? 'text-white/75' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {historyEn}
                  </p>
                )}
                <p
                  className={`text-[10px] mt-1 ${
                    mine ? 'text-white/70' : 'text-gray-400'
                  }`}
                >
                  {formatRelativeTime(msg.sentAt) || ''}
                </p>
                {sentBy && (
                  <p
                    className={`text-[10px] mt-0.5 ${
                      mine ? 'text-white/60' : 'text-gray-400'
                    }`}
                  >
                    Sent by {sentBy}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {selectedVaultItems.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] flex items-center gap-3">
          <div className="flex items-center gap-1.5 shrink-0 max-w-[40%] overflow-x-auto">
            {selectedVaultItems.map((item) => {
              const uploadId = vaultUploadId(item);
              const src = maloumMediaUrl(creatorId, {
                uploadId,
                variant: 'thumbnail',
                url: item.thumbnail?.url || item.media?.url,
              });
              return (
                <button
                  key={uploadId || src}
                  type="button"
                  onClick={() => toggleVaultItem(item)}
                  className="relative shrink-0"
                  title="Remove"
                >
                  <img src={src} alt="" className="w-12 h-12 rounded object-cover" />
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center">
                    <X className="w-3 h-3" />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">
              {selectedVaultItems.length} media selected
            </p>
            <div className="flex items-center gap-2 mt-1">
              <label className="text-xs text-gray-500">
                Price {currency || 'EUR'}
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={ppvPrice}
                onChange={(e) => setPpvPrice(e.target.value)}
                className="w-20 px-2 py-1 text-xs rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5"
              />
              <span className="text-xs text-gray-400">
                {Number(ppvPrice) > 0 ? '(PPV)' : '(free)'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedVaultItems([])}
            className="p-1 text-gray-400 hover:text-gray-600"
            aria-label="Clear attachment"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-2">
        {sendError && (
          <p className="text-xs text-red-600 dark:text-red-400">{sendError}</p>
        )}
        {translatingOutgoing && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Translating to German…
          </p>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => void openVault()}
            className="p-2 rounded-lg border border-gray-200 dark:border-white/10 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
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
                void handleSend();
              }
            }}
            rows={2}
            placeholder="Type a message…"
            className="flex-1 resize-none rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={
              sending ||
              translatingOutgoing ||
              (!draft.trim() && selectedVaultItems.length === 0)
            }
            className="p-2.5 rounded-xl bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
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
          <TranslationToggles
            autoTranslateOutgoing={autoTranslateOutgoing}
            autoTranslateHistory={autoTranslateHistory}
            onOutgoingChange={handleAutoTranslateOutgoingChange}
            onHistoryChange={handleAutoTranslateHistoryChange}
          />
        )}
      </div>

      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/50"
            onClick={() => setVaultOpen(false)}
          />
          <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col border border-gray-200 dark:border-white/10">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-white/10 gap-2">
              <h3 className="font-semibold">
                Vault
                {selectedVaultItems.length > 0
                  ? ` · ${selectedVaultItems.length} selected`
                  : ''}
              </h3>
              <div className="flex items-center gap-1">
                {selectedVaultItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedVaultItems([])}
                    className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setVaultOpen(false)}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700"
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => setVaultOpen(false)}
                  className="p-1 text-gray-400 hover:text-gray-600"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="px-3 py-2 border-b border-gray-100 dark:border-white/10 overflow-x-auto flex gap-1.5 shrink-0">
              {vaultFolders.map((folder) => (
                <button
                  key={folder._id}
                  type="button"
                  onClick={() => setSelectedFolderId(folder._id)}
                  className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors max-w-[180px] truncate ${
                    selectedFolderId === folder._id
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                  title={folder.name || 'Folder'}
                >
                  {folder.name || 'Folder'}
                </button>
              ))}
            </div>

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
                  {selectedFolderId ? 'No media in this folder.' : 'Vault is empty.'}
                </p>
              )}
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                {vaultItems.map((item) => {
                  const uploadId = vaultUploadId(item);
                  const src = maloumMediaUrl(creatorId, {
                    uploadId,
                    variant: 'thumbnail',
                    url: item.thumbnail?.url || item.media?.url,
                  });
                  const selected = selectedVaultItems.some(
                    (entry) => vaultUploadId(entry) === uploadId
                  );
                  const video = isVideoAsset(item.media?.type);
                  const durationSec =
                    typeof item.media?.length === 'number'
                      ? item.media.length
                      : undefined;
                  const durationLabel = formatDuration(durationSec);
                  return (
                    <button
                      key={uploadId || src}
                      type="button"
                      onClick={() => toggleVaultItem(item)}
                      className={`relative aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-white/5 group border-2 ${
                        selected ? 'border-brand-500' : 'border-transparent'
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
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <ImageIcon className="w-6 h-6" />
                        </div>
                      )}
                      {selected && (
                        <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center z-10">
                          <Check className="w-3 h-3" />
                        </span>
                      )}
                      {video && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30">
                          <Play className="w-8 h-8 text-white drop-shadow" />
                        </span>
                      )}
                      {video && durationLabel && (
                        <span className="absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/70 text-white">
                          {durationLabel}
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

      {previewUrl && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close preview"
            onClick={() => setPreviewUrl(null)}
          />
          <img
            src={previewUrl}
            alt=""
            className="relative z-10 max-w-full max-h-full rounded-lg object-contain"
          />
          <button
            type="button"
            onClick={() => setPreviewUrl(null)}
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
    <div className="flex-1 flex min-w-0 min-h-0">
      <aside className="w-56 border-r border-gray-200 dark:border-white/10 flex flex-col shrink-0">
        <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center">
          <span className="text-sm font-medium">Maloum</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 p-3">
              No Maloum creators yet. Connect one from Manage Creators.
            </p>
          )}
          {creators.map((creator) => {
            const unread = unreadByCreatorId[creator.id] || 0;
            const notificationUnread = notificationUnreadByCreatorId[creator.id] || 0;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => onSelectCreator(creator.id)}
                className={`w-full flex items-center gap-2 p-2 rounded-lg text-left transition-colors ${
                  selectedCreatorId === creator.id
                    ? 'bg-brand-50 dark:bg-brand-900/20 border border-brand-200 dark:border-brand-800'
                    : 'hover:bg-gray-50 dark:hover:bg-white/5 border border-transparent'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                  {creator.avatarUrl ? (
                    <img
                      src={creator.avatarUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    creator.displayName.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm truncate block">{creator.displayName}</span>
                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                    <UnreadBadge
                      icon={MessageSquare}
                      count={unread}
                      label="Unread messages"
                    />
                    <UnreadBadge
                      icon={Bell}
                      count={notificationUnread}
                      label="Unread notifications"
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-3 bg-white dark:bg-[#0a0a0a]">
          <TranslationToggles
            autoTranslateOutgoing={autoTranslateOutgoing}
            autoTranslateHistory={autoTranslateHistory}
            onOutgoingChange={handleAutoTranslateOutgoingChange}
            onHistoryChange={handleAutoTranslateHistoryChange}
          />
        </div>
      </aside>

      <aside className="w-80 border-r border-gray-200 dark:border-white/10 flex flex-col shrink-0">
        {selectedCreatorId ? (
          <MaloumChatList
            creatorId={selectedCreatorId}
            selectedChatId={selectedChatId}
            onSelectChat={(chat) => {
              setSelectedChatId(chat._id);
              setSelectedChat(chat);
            }}
          />
        ) : (
          <p className="text-xs text-gray-500 p-4">Select a creator</p>
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
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            Select a conversation
          </div>
        )}
      </main>
    </div>
  );
}
