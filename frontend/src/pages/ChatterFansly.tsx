import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImagePlus, Loader2, RefreshCw, Send, Trash2, UserRound, X } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import FanslyFanPanel from '@/components/fansly/FanslyFanPanel';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useSyncedDrawer } from '@/context/ShellContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import { useLocation } from 'react-router-dom';
import fanslyIcon from '@/assets/fansly.svg';
import {
  deleteFanslyMessage,
  listFanslyChats,
  listFanslyMessages,
  listFanslySubscriptionTiers,
  fanslyVaultPreviewSrc,
  listFanslyVaultAlbums,
  listFanslyVaultMedia,
  sendFanslyMessage,
  type FanslyChat,
  type FanslyMessage,
  type FanslySubscriptionTier,
  type FanslyVaultAlbum,
  type FanslyVaultMedia,
} from '@/lib/api';

function formatTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function attachmentCount(message: FanslyMessage): number {
  return Array.isArray(message.attachments) ? message.attachments.length : 0;
}

function letterFromName(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] || '?').toUpperCase();
}

function formatRelativeTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatTime(value);
}

function LetterAvatar({ name }: { name: string }) {
  return (
    <span className="w-9 h-9 shrink-0 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300 text-sm font-semibold flex items-center justify-center">
      {letterFromName(name)}
    </span>
  );
}

export default function ChatterFansly() {
  const location = useLocation();
  const pollEnabled = usePollEnabled(location.pathname === '/chatter/fansly');
  const { creators, creatorsLoading, creatorsError, badgesByCreatorId } = useCreatorLive({
    platform: 'fansly',
    wantBadges: true,
    pollEnabled,
  });
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [flags, setFlags] = useState<0 | 32>(0);
  const [chats, setChats] = useState<FanslyChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<FanslyMessage[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<string[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [albums, setAlbums] = useState<FanslyVaultAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [vaultMedia, setVaultMedia] = useState<FanslyVaultMedia[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<FanslyVaultMedia[]>([]);
  const [requirePurchase, setRequirePurchase] = useState(false);
  const [price, setPrice] = useState('');
  const [requireSubscription, setRequireSubscription] = useState(false);
  const [tierId, setTierId] = useState('');
  const [requireFollow, setRequireFollow] = useState(false);
  const [tiers, setTiers] = useState<FanslySubscriptionTier[]>([]);
  const [fanPanelOpen, setFanPanelOpen] = useState(false);
  const [fanNickname, setFanNickname] = useState('');
  const fanScope = `${selectedCreatorId || ''}:${selectedGroupId || ''}`;
  const [openFanScope, setOpenFanScope] = useState(fanScope);
  if (fanScope !== openFanScope) {
    setOpenFanScope(fanScope);
    setFanPanelOpen(false);
    setFanNickname('');
  }
  useSyncedDrawer('fansly-fan', 'xl', fanPanelOpen, setFanPanelOpen);

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((creator) => creator.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const selectedCreator = useMemo(
    () => creators.find((creator) => creator.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );
  const selectedChat = chats.find((chat) => chat.groupId === selectedGroupId) || null;

  useEffect(() => {
    setVaultOpen(false);
    setAlbums([]);
    setSelectedAlbumId(null);
    setVaultMedia([]);
    setSelectedMedia([]);
    setVaultError(null);
    setTiers([]);
    setHiddenMessageIds([]);
    setRequirePurchase(false);
    setPrice('');
    setRequireSubscription(false);
    setTierId('');
    setRequireFollow(false);
  }, [selectedCreatorId, selectedGroupId]);

  const loadChats = useCallback(async () => {
    if (!selectedCreatorId) {
      setChats([]);
      return;
    }
    setChatsError(null);
    try {
      const result = await listFanslyChats(selectedCreatorId, { flags, limit: flags === 32 ? 10 : 20 });
      setChats(result.chats || []);
      setSelfId(result.providerUserId);
    } catch (err) {
      setChatsError(err instanceof Error ? err.message : 'Failed to load inbox');
    }
  }, [flags, selectedCreatorId]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    let cancelled = false;
    setChatsLoading(true);
    loadChats().finally(() => {
      if (!cancelled) setChatsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadChats, selectedCreatorId]);

  const loadThread = useCallback(async () => {
    if (!selectedCreatorId || !selectedGroupId) {
      setMessages([]);
      return;
    }
    setThreadError(null);
    try {
      const result = await listFanslyMessages(selectedCreatorId, selectedGroupId);
      setMessages(result.messages || []);
      setSelfId(result.providerUserId);
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [selectedCreatorId, selectedGroupId]);

  useEffect(() => {
    if (!selectedGroupId) return;
    let cancelled = false;
    setThreadLoading(true);
    loadThread().finally(() => {
      if (!cancelled) setThreadLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadThread, selectedGroupId]);

  useEffect(() => {
    if (!pollEnabled || !selectedCreatorId) return;
    const timer = window.setInterval(() => {
      void loadChats();
      if (selectedGroupId) void loadThread();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadChats, loadThread, pollEnabled, selectedCreatorId, selectedGroupId]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId) return;
    let cancelled = false;
    setAlbumsLoading(true);
    setVaultError(null);
    listFanslyVaultAlbums(selectedCreatorId)
      .then((result) => {
        if (!cancelled) setAlbums(result.albums || []);
      })
      .catch((err) => {
        if (!cancelled) setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
      })
      .finally(() => {
        if (!cancelled) setAlbumsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCreatorId, vaultOpen]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId || !selectedAlbumId) return;
    let cancelled = false;
    setMediaLoading(true);
    setVaultError(null);
    listFanslyVaultMedia(selectedCreatorId, selectedAlbumId)
      .then((result) => {
        if (!cancelled) setVaultMedia(result.media || []);
      })
      .catch((err) => {
        if (!cancelled) setVaultError(err instanceof Error ? err.message : 'Failed to load media');
      })
      .finally(() => {
        if (!cancelled) setMediaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAlbumId, selectedCreatorId, vaultOpen]);

  useEffect(() => {
    if (!selectedCreatorId || selectedMedia.length === 0) return;
    let cancelled = false;
    listFanslySubscriptionTiers(selectedCreatorId)
      .then((result) => {
        if (!cancelled) setTiers(result.tiers || []);
      })
      .catch(() => {
        if (!cancelled) setTiers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCreatorId, selectedMedia.length > 0]);

  function toggleMedia(item: FanslyVaultMedia) {
    setSelectedMedia((prev) =>
      prev.some((row) => row.mediaId === item.mediaId)
        ? prev.filter((row) => row.mediaId !== item.mediaId)
        : [...prev, item]
    );
  }

  async function handleDelete(messageId: string) {
    if (!selectedCreatorId || !selectedGroupId || deletingId) return;
    setDeletingId(messageId);
    setThreadError(null);
    try {
      await deleteFanslyMessage(selectedCreatorId, selectedGroupId, messageId);
      setHiddenMessageIds((prev) => (prev.includes(messageId) ? prev : [...prev, messageId]));
      setMessages((prev) => prev.filter((row) => row.id !== messageId));
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to delete message');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!selectedCreatorId || !selectedGroupId || sending) return;
    if (!text && selectedMedia.length === 0) return;
    if (selectedMedia.length > 0 && requirePurchase && !(Number(price) > 0)) {
      setThreadError('Enter a purchase price');
      return;
    }
    setSending(true);
    setThreadError(null);
    try {
      const result = await sendFanslyMessage(
        selectedCreatorId,
        selectedGroupId,
        text,
        selectedMedia.length
          ? {
              media: selectedMedia.map((item) => ({
                mediaId: item.mediaId,
                mediaType: item.mediaType,
              })),
              permissions: {
                requirePurchase,
                price: Number(price),
                requireSubscription,
                subscriptionTierId: tierId || null,
                requireFollow,
              },
            }
          : undefined
      );
      setDraft('');
      setSelectedMedia([]);
      setVaultOpen(false);
      if (result.message) {
        setMessages((prev) => [result.message, ...prev.filter((row) => row.id !== result.message.id)]);
      }
      void loadChats();
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  const orderedMessages = [...messages]
    .reverse()
    .filter((message) => !message.deletedAt && !hiddenMessageIds.includes(message.id));
  const canSend = !sending && (Boolean(draft.trim()) || selectedMedia.length > 0);

  return (
    <AppShell
      title="Fansly Chat"
      activePage="chatter"
      bleed
      headerExtras={
        <>
          <WorkspaceDrawerButton id="fansly-creators" size="lg" label="Creators" className="lg:hidden" />
          <WorkspaceDrawerButton id="fansly-inbox" size="md" label="Inbox" className="md:hidden" />
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <WorkspaceDrawer
          id="fansly-creators"
          size="lg"
          className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50"
        >
          <div className="px-4 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
            <img src={fanslyIcon} alt="" className="w-5 h-5" />
            <span className="font-medium text-sm">Fansly</span>
          </div>
          <div data-drawer-list className="flex-1 overflow-y-auto">
            {creatorsLoading && <p className="px-4 py-3 text-sm text-gray-500">Loading creators…</p>}
            {creatorsError && <p className="px-4 py-3 text-sm text-red-500">{creatorsError}</p>}
            {!creatorsLoading && creators.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-500">
                No Fansly creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => {
              const unread = badgesByCreatorId[creator.id]?.messages || 0;
              const active = creator.id === selectedCreatorId;
              return (
                <button
                  key={creator.id}
                  type="button"
                  onClick={() => {
                    setSelectedCreatorId(creator.id);
                    setSelectedGroupId(null);
                    setMessages([]);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left ${
                    active ? 'bg-brand-50 dark:bg-white/5' : 'hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                >
                  <CreatorAvatar avatarUrl={creator.avatarUrl} displayName={creator.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{creator.displayName}</span>
                    <span className="block truncate text-xs text-gray-500">@{creator.username || 'fansly'}</span>
                  </span>
                  {unread > 0 && (
                    <span className="text-[10px] font-semibold bg-sky-500 text-white rounded-full px-1.5 py-0.5">
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </WorkspaceDrawer>

        <WorkspaceDrawer
          id="fansly-inbox"
          size="md"
          className="w-80 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-[#F7F8FA] dark:bg-[#0a0a0c]"
        >
          <div className="px-3 py-2 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2">
            <button
              type="button"
              onClick={() => setFlags(0)}
              className={`text-xs px-2.5 py-1 rounded-full ${
                flags === 0 ? 'bg-sky-500 text-white' : 'bg-white dark:bg-white/10 text-gray-600 dark:text-gray-300'
              }`}
            >
              Inbox
            </button>
            <button
              type="button"
              onClick={() => setFlags(32)}
              className={`text-xs px-2.5 py-1 rounded-full ${
                flags === 32 ? 'bg-sky-500 text-white' : 'bg-white dark:bg-white/10 text-gray-600 dark:text-gray-300'
              }`}
            >
              Staff
            </button>
          </div>
          <div data-drawer-list className="flex-1 overflow-y-auto">
            {chatsLoading && (
              <p className="px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading inbox…
              </p>
            )}
            {chatsError && <p className="px-4 py-3 text-sm text-red-500">{chatsError}</p>}
            {!chatsLoading && !chatsError && chats.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-500">No conversations.</p>
            )}
            {chats.map((chat) => {
              const active = chat.groupId === selectedGroupId;
              const preview =
                chat.lastMessage?.content ||
                (chat.lastMessage && attachmentCount(chat.lastMessage) > 0
                  ? 'Attachment'
                  : 'Open conversation');
              return (
                <button
                  key={chat.groupId}
                  type="button"
                  onClick={() => setSelectedGroupId(chat.groupId)}
                  className={`w-full text-left p-3 border-l-2 relative ${
                    active
                      ? 'border-sky-500 bg-gray-50/60 dark:bg-zinc-900/60'
                      : 'border-transparent hover:bg-gray-100 dark:hover:bg-zinc-900/40 border-b border-b-gray-200 dark:border-b-zinc-800/30'
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <LetterAvatar name={chat.partnerUsername} />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center justify-between gap-2 mb-0.5">
                        <span
                          className={`text-sm truncate ${
                            active
                              ? 'font-semibold text-gray-900 dark:text-white'
                              : 'font-medium text-gray-800 dark:text-zinc-200'
                          }`}
                        >
                          {chat.partnerUsername}
                        </span>
                        <span className="text-[10px] text-gray-500 dark:text-zinc-500 shrink-0">
                          {formatRelativeTime(chat.lastMessage?.createdAt)}
                        </span>
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-zinc-400 truncate pr-4">
                        {preview}
                      </span>
                    </span>
                  </span>
                  {chat.unreadCount > 0 && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-sky-500" />
                  )}
                </button>
              );
            })}
          </div>
        </WorkspaceDrawer>

        <section className="flex-1 min-w-0 flex flex-col bg-white dark:bg-[#111]">
          {!selectedChat && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              {selectedCreator ? 'Select a conversation.' : 'Select a Fansly creator.'}
            </div>
          )}
          {selectedChat && (
            <>
              <div className="px-4 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-3">
                <LetterAvatar name={fanNickname.trim() || selectedChat.partnerUsername} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-gray-900 dark:text-white truncate">
                    {fanNickname.trim() || selectedChat.partnerUsername}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
                    @{selectedChat.partnerUsername.replace(/^@/, '')}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Refresh messages"
                  onClick={() => void loadThread()}
                  className="p-2 rounded-xl text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  <RefreshCw className={`w-4 h-4 ${threadLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  aria-label="Fan info"
                  onClick={() => setFanPanelOpen((open) => !open)}
                  className={`p-2 rounded-xl ${
                    fanPanelOpen
                      ? 'bg-sky-500 text-white'
                      : 'text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  <UserRound className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
                {threadLoading && (
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading messages…
                  </p>
                )}
                {threadError && <p className="text-sm text-red-500">{threadError}</p>}
                {orderedMessages.map((message) => {
                  const mine = Boolean(selfId && message.senderId === selfId);
                  const attachments = attachmentCount(message);
                  return (
                    <div key={message.id} className={`flex items-end gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                      {mine && (
                        <button
                          type="button"
                          aria-label="Delete message"
                          disabled={deletingId === message.id}
                          onClick={() => void handleDelete(message.id)}
                          className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
                        >
                          {deletingId === message.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                          mine
                            ? 'bg-sky-500 text-white'
                            : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {attachments > 0 && (
                          <p className={`text-[11px] mb-1 ${mine ? 'text-white/80' : 'text-gray-500'}`}>
                            {attachments === 1 ? 'Attachment' : `${attachments} attachments`}
                          </p>
                        )}
                        {message.content ? (
                          <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        ) : attachments === 0 ? (
                          <p>Attachment</p>
                        ) : null}
                        <p className={`text-[10px] mt-1 ${mine ? 'text-white/80' : 'text-gray-500'}`}>
                          {formatTime(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {selectedMedia.length > 0 && (
                <div className="border-t border-gray-200 dark:border-white/10 px-3 py-3 space-y-3">
                  <div className="flex gap-2 overflow-x-auto">
                    {selectedMedia.map((item) => {
                      const previewSrc = selectedCreatorId
                        ? fanslyVaultPreviewSrc(selectedCreatorId, item)
                        : item.previewUrl;
                      return (
                        <div key={item.mediaId} className="relative shrink-0">
                          {previewSrc ? (
                            <img src={previewSrc} alt="" className="w-14 h-14 object-cover rounded-md" />
                          ) : (
                            <span className="w-14 h-14 rounded-md bg-gray-100 dark:bg-white/10 flex items-center justify-center text-[10px] text-gray-500 px-1">
                              {item.filename || 'Media'}
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label="Remove media"
                            onClick={() =>
                              setSelectedMedia((prev) => prev.filter((row) => row.mediaId !== item.mediaId))
                            }
                            className="absolute -top-1 -right-1 bg-black/70 text-white rounded-full p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={requirePurchase}
                      onChange={(event) => setRequirePurchase(event.target.checked)}
                    />
                    Require Purchase
                  </label>
                  {requirePurchase && (
                    <label className="block text-xs text-gray-500">
                      Amount
                      <span className="mt-1 flex items-center gap-1 px-2 py-1.5 border border-gray-200 dark:border-white/10 rounded-lg">
                        $
                        <input
                          value={price}
                          onChange={(event) => setPrice(event.target.value)}
                          inputMode="decimal"
                          placeholder="10"
                          className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none"
                        />
                      </span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={requireSubscription}
                      onChange={(event) => setRequireSubscription(event.target.checked)}
                    />
                    Require Subscription
                  </label>
                  {requireSubscription && (
                    <label className="block text-xs text-gray-500">
                      Subscription Tier
                      <select
                        value={tierId}
                        onChange={(event) => setTierId(event.target.value)}
                        className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100"
                      >
                        <option value="">Any Tier</option>
                        {tiers.map((tier) => (
                          <option key={tier.id} value={tier.id}>
                            {tier.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={requireFollow}
                      onChange={(event) => setRequireFollow(event.target.checked)}
                    />
                    Require Follow
                  </label>
                </div>
              )}
              <form
                className="p-3 border-t border-gray-200 dark:border-zinc-800/60"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSend();
                }}
              >
                <div className="flex items-end gap-2 bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-2xl p-2 focus-within:border-sky-500/50">
                  <button
                    type="button"
                    aria-label="Open media vault"
                    onClick={() => setVaultOpen(true)}
                    className="p-2 rounded-xl text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 shrink-0"
                  >
                    <ImagePlus className="w-5 h-5" />
                  </button>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void handleSend();
                      }
                    }}
                    rows={1}
                    placeholder="Write a message"
                    className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-gray-900 dark:text-white outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600"
                  />
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="p-3 rounded-xl bg-sky-500 text-white disabled:opacity-40 shrink-0"
                  >
                    {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                  </button>
                </div>
              </form>
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
                          {selectedMedia.length} item{selectedMedia.length === 1 ? '' : 's'} selected
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setVaultOpen(false)}
                          className="px-5 py-2 text-sm font-semibold rounded-lg bg-sky-500 text-white"
                        >
                          Insert Media
                        </button>
                        <button
                          type="button"
                          aria-label="Close vault"
                          onClick={() => setVaultOpen(false)}
                          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
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
                        {mediaLoading && (
                          <p className="text-sm text-gray-500 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading media…
                          </p>
                        )}
                        {selectedAlbumId && !mediaLoading && vaultMedia.length === 0 && (
                          <p className="text-sm text-gray-500">This album is empty.</p>
                        )}
                        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                          {vaultMedia.map((item) => {
                            const selected = selectedMedia.some((row) => row.mediaId === item.mediaId);
                            const previewSrc = fanslyVaultPreviewSrc(selectedCreatorId, item);
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => toggleMedia(item)}
                                className={`relative text-left rounded-lg overflow-hidden border ${
                                  selected
                                    ? 'border-sky-500 ring-2 ring-sky-500'
                                    : 'border-gray-200 dark:border-white/10'
                                }`}
                              >
                                {previewSrc ? (
                                  <img src={previewSrc} alt="" className="aspect-square w-full object-cover" />
                                ) : (
                                  <span className="aspect-square w-full flex items-center justify-center text-[10px] text-gray-500 px-1">
                                    {item.filename || 'Media'}
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
            </>
          )}
        </section>
        {fanPanelOpen && selectedCreatorId && selectedChat && (
          <div className="workspace-drawer drawer-xl workspace-open w-80 shrink-0 flex flex-col min-h-0">
            <FanslyFanPanel
              creatorId={selectedCreatorId}
              groupId={selectedChat.groupId}
              partnerAccountId={selectedChat.partnerAccountId}
              partnerUsername={selectedChat.partnerUsername}
              onNickname={setFanNickname}
              onClose={() => setFanPanelOpen(false)}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
