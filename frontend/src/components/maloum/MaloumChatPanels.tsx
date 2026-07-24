import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import {
  createMessagingDashboardEntry,
  getMaloumChat,
  getMaloumMessages,
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
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

const POLL_MS = 20_000;

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
};

export function MaloumChatThread({
  creator,
  chatId,
  initialChat = null,
  className = '',
  onClose,
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
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(true);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<MaloumVaultFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<MaloumVaultMediaItem[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItem, setSelectedVaultItem] = useState<MaloumVaultMediaItem | null>(
    null
  );
  const [ppvPrice, setPpvPrice] = useState('5');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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

  useEffect(() => {
    setChat(initialChat);
    setMessages([]);
    setDraft('');
    setSendError(null);
    setSelectedVaultItem(null);
    setVaultOpen(false);
    void loadMessages();
    const timer = window.setInterval(() => {
      void loadMessages();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [chatId, creatorId, initialChat, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

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
    const vaultItem = selectedVaultItem;
    if (!englishDraft && !vaultItem) return;
    if (sending) return;

    setSending(true);
    setSendError(null);
    try {
      let textToSend = englishDraft;
      if (autoTranslateOutgoing && englishDraft) {
        try {
          textToSend = await translateToGerman(englishDraft);
        } catch {
          // Fall back to English draft if translation fails
        }
      }

      const optimisticMessageId = crypto.randomUUID();
      const priceNet = Number(ppvPrice) || 0;
      const responseSnapshot = computeMaloumResponseTime(messages, providerUserId);

      let mediaPayload:
        | Array<{ mediaId: string; type?: string; width?: number; height?: number }>
        | undefined;
      if (vaultItem) {
        const uploadId = vaultUploadId(vaultItem);
        if (!uploadId) {
          throw new Error('Selected vault item is missing uploadId');
        }
        mediaPayload = [
          {
            mediaId: uploadId,
            type: vaultItem.media?.type || 'picture',
            width: vaultItem.media?.width,
            height: vaultItem.media?.height,
          },
        ];
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
        const isVideo = isVideoAsset(vaultItem?.media?.type);
        void createMessagingDashboardEntry({
          id: crypto.randomUUID(),
          creatorId,
          creatorName: creator.displayName,
          creatorUsername: creator.username,
          creatorAvatarUrl: creator.avatarUrl,
          chatterId: user.id,
          chatterName: user.name,
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
          mediaCount: hasMedia ? 1 : 0,
          pictureCount: hasMedia && !isVideo ? 1 : 0,
          videoCount: hasMedia && isVideo ? 1 : 0,
          mediaJson: hasMedia
            ? [
                {
                  mediaId: mediaPayload![0].mediaId,
                  type: isVideo ? 'video' : 'image',
                },
              ]
            : null,
          previousFanMessageAt: responseSnapshot.previousFanMessageAt,
          responseTimeSeconds: responseSnapshot.responseTimeSeconds,
          sentAt: new Date().toISOString(),
        }).catch(() => {
          // Non-blocking
        });
      }

      setDraft('');
      setSelectedVaultItem(null);
      await loadMessages();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [
    draft,
    selectedVaultItem,
    sending,
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
            title="Close"
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
                <p
                  className={`text-[10px] mt-1 ${
                    mine ? 'text-white/70' : 'text-gray-400'
                  }`}
                >
                  {formatRelativeTime(msg.sentAt) || ''}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {selectedVaultItem && (
        <div className="px-4 py-2 border-t border-gray-200 dark:border-white/10 flex items-center gap-3 bg-gray-50 dark:bg-white/5">
          {(() => {
            const uploadId = vaultUploadId(selectedVaultItem);
            const thumbUrl = selectedVaultItem.thumbnail?.url || selectedVaultItem.media?.url;
            const src = maloumMediaUrl(creatorId, {
              uploadId,
              variant: 'thumbnail',
              url: thumbUrl,
            });
            return (
              <img src={src} alt="" className="w-12 h-12 rounded object-cover" />
            );
          })()}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">
              {isVideoAsset(selectedVaultItem.media?.type) ? 'Video' : 'Picture'} selected
            </p>
            <label className="flex items-center gap-2 text-xs text-gray-500 mt-1">
              PPV price ({currency || 'EUR'})
              <input
                type="number"
                min="0"
                step="1"
                value={ppvPrice}
                onChange={(e) => setPpvPrice(e.target.value)}
                className="w-20 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-black/30 px-2 py-0.5"
              />
              <span className="text-[10px]">0 = free media</span>
            </label>
          </div>
          <button
            type="button"
            onClick={() => setSelectedVaultItem(null)}
            className="p-1 text-gray-400 hover:text-gray-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-2">
        {sendError && (
          <p className="text-xs text-red-600 dark:text-red-400">{sendError}</p>
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
            disabled={sending || (!draft.trim() && !selectedVaultItem)}
            className="p-2.5 rounded-xl bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
            title="Send"
          >
            {sending ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={autoTranslateOutgoing}
            onChange={(e) => setAutoTranslateOutgoing(e.target.checked)}
          />
          Auto-translate outgoing to German
        </label>
      </div>

      {vaultOpen && (
        <div className="absolute inset-0 z-20 flex">
          <button
            type="button"
            className="flex-1 bg-black/40"
            aria-label="Close vault"
            onClick={() => setVaultOpen(false)}
          />
          <div className="w-full max-w-md h-full bg-white dark:bg-[#0a0a0a] border-l border-gray-200 dark:border-white/10 flex flex-col shadow-xl">
            <div className="h-14 px-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between">
              <span className="text-sm font-medium">Vault</span>
              <button
                type="button"
                onClick={() => setVaultOpen(false)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="w-36 border-r border-gray-200 dark:border-white/10 overflow-y-auto">
                {vaultFolders.map((folder) => {
                  const thumb = folder.mostRecentMediaThumbnails?.[0];
                  const thumbSrc = thumb
                    ? maloumMediaUrl(creatorId, {
                        uploadId: thumb.uploadId,
                        variant: 'thumbnail',
                        url: thumb.url,
                      })
                    : null;
                  return (
                    <button
                      key={folder._id}
                      type="button"
                      onClick={() => setSelectedFolderId(folder._id)}
                      className={`w-full text-left px-2 py-2 border-b border-gray-100 dark:border-white/5 ${
                        selectedFolderId === folder._id
                          ? 'bg-brand-50 dark:bg-brand-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-white/5'
                      }`}
                    >
                      {thumbSrc ? (
                        <img
                          src={thumbSrc}
                          alt=""
                          className="w-full aspect-square object-cover rounded mb-1"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full aspect-square rounded bg-gray-100 dark:bg-white/5 mb-1" />
                      )}
                      <p className="text-[11px] truncate">{folder.name || 'Folder'}</p>
                      <p className="text-[10px] text-gray-400">
                        {(folder.pictureCount || 0) + (folder.videoCount || 0)} items
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {vaultLoading && (
                  <p className="text-xs text-gray-500 p-2">Loading…</p>
                )}
                {vaultError && (
                  <p className="text-xs text-red-600 dark:text-red-400 p-2">{vaultError}</p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  {vaultItems.map((item) => {
                    const uploadId = vaultUploadId(item);
                    const src = maloumMediaUrl(creatorId, {
                      uploadId,
                      variant: 'thumbnail',
                      url: item.thumbnail?.url || item.media?.url,
                    });
                    const selected = vaultUploadId(selectedVaultItem || {}) === uploadId;
                    return (
                      <button
                        key={uploadId || src}
                        type="button"
                        onClick={() => {
                          setSelectedVaultItem(item);
                          setVaultOpen(false);
                        }}
                        className={`relative aspect-square rounded-lg overflow-hidden border-2 ${
                          selected
                            ? 'border-brand-500'
                            : 'border-transparent hover:border-gray-300'
                        }`}
                      >
                        <img
                          src={src}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        {isVideoAsset(item.media?.type) && (
                          <span className="absolute bottom-1 left-1 text-[10px] px-1 rounded bg-black/70 text-white">
                            Video
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
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

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  useEffect(() => {
    setSelectedChatId(null);
    setSelectedChat(null);
  }, [selectedCreatorId]);

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
                  {(unread > 0 || notificationUnread > 0) && (
                    <span className="text-[10px] text-red-600 dark:text-red-400 block">
                      {unread > 0 ? `${unread} unread` : null}
                      {unread > 0 && notificationUnread > 0 ? ' · ' : null}
                      {notificationUnread > 0
                        ? `${notificationUnread} notif${notificationUnread === 1 ? '' : 's'}`
                        : null}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
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
