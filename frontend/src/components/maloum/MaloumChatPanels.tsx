import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  Banknote,
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
  PanelRight,
  PanelRightClose,
  Play,
  RefreshCw,
  Send,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import QuickEmojiBar from '@/components/QuickEmojiBar';
import ToggleSwitch from '@/components/ToggleSwitch';
import VaultMediaNoteModal, {
  VaultMediaNoteButton,
} from '@/components/VaultMediaNoteModal';
import ScriptToolbarButton from '@/components/scripts/ScriptToolbarButton';
import MaloumFanPanel from '@/components/maloum/MaloumFanPanel';
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
  listVaultMediaNotes,
  markScriptSent,
  sendMaloumMessage,
  translateToGerman,
  type Creator,
  type CreatorScript,
  type CreatorScriptMediaItem,
  type MaloumChat,
  type MaloumChatPartner,
  type MaloumMessage,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
  type TranslateHistoryItem,
} from '@/lib/api';
import {
  createHistoryTranslateQueue,
  type HistoryTranslateQueue,
} from '@/lib/historyTranslateQueue';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';

type MaloumMediaPreview = {
  url: string;
  kind: 'picture' | 'video' | 'embed';
};

const POLL_MS = 20_000;
const MESSAGE_PAGE_LIMIT = 30;
const CHAT_PAGE_LIMIT = 30;
const NEAR_BOTTOM_PX = 120;
const NEAR_TOP_PX = 80;
const CHAT_LIST_NEAR_BOTTOM_PX = 240;

type MaloumInboxFilterId = 'all' | 'unread' | 'waiting' | 'needs_reply';

const MALOUM_INBOX_FILTERS: Array<{ id: MaloumInboxFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'needs_reply', label: 'Needs reply' },
];

function maloumInboxFilterParams(filterId: MaloumInboxFilterId): {
  filter?: 'unread';
  lastMessageSender?: 'sentByMe' | 'sentByOther';
} {
  if (filterId === 'unread') return { filter: 'unread' };
  if (filterId === 'waiting') {
    return { filter: 'unread', lastMessageSender: 'sentByMe' };
  }
  if (filterId === 'needs_reply') {
    return { filter: 'unread', lastMessageSender: 'sentByOther' };
  }
  return {};
}

function mergeMaloumChatPages(
  prev: MaloumChat[],
  incoming: MaloumChat[]
): MaloumChat[] {
  const incomingIds = new Set(incoming.map((c) => c._id));
  const rest = prev.filter((c) => c._id && !incomingIds.has(c._id));
  return [...incoming, ...rest];
}

function appendMaloumChats(
  prev: MaloumChat[],
  incoming: MaloumChat[]
): MaloumChat[] {
  const seen = new Set(prev.map((c) => c._id));
  const next = [...prev];
  for (const chat of incoming) {
    if (!chat._id || seen.has(chat._id)) continue;
    seen.add(chat._id);
    next.push(chat);
  }
  return next;
}
const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const MAX_TRANSLATION_HISTORY = 8;
const TRANSLATION_SETTINGS_EVENT = 'domx-translation-settings';
const FAN_PANEL_OPEN_KEY = 'domx-maloum-fan-panel';
const FAN_PANEL_WIDE_BREAKPOINT = 1000;

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
        hasUnread ? accentClass : 'text-gray-500 dark:text-zinc-500'
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
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500">
        Assist Settings
      </p>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
          Auto-translate Out
        </span>
        <ToggleSwitch
          checked={autoTranslateOutgoing}
          onChange={onOutgoingChange}
          aria-label="Auto-translate outgoing messages"
        />
      </label>
      <label className="flex items-center justify-between cursor-pointer group gap-3">
        <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
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

export function maloumVaultItemToScriptMedia(
  item: MaloumVaultMediaItem
): CreatorScriptMediaItem | null {
  const mediaKey = vaultUploadId(item);
  if (!mediaKey) return null;
  return {
    mediaKey,
    type: item.media?.type || item.thumbnail?.type,
    previewUrl: vaultDirectUrl(item) || undefined,
    width: item.media?.width,
    height: item.media?.height,
  };
}

export function scriptMediaToMaloumVaultItem(
  media: CreatorScriptMediaItem
): MaloumVaultMediaItem {
  return {
    media: {
      uploadId: media.mediaKey,
      type: media.type || 'picture',
      url: media.previewUrl,
      width: media.width,
      height: media.height,
    },
    thumbnail: media.previewUrl
      ? {
          uploadId: media.mediaKey,
          url: media.previewUrl,
          type: media.type || 'picture',
        }
      : undefined,
  };
}

const MANAGED_VAULT_FOLDER_LABELS: Record<string, string> = {
  __q8h2j5p4__: 'All media',
};

/** Maloum managed vault folders arrive as opaque codes like __q8h2j5p4__. */
export function friendlyVaultFolderName(
  folder: Pick<MaloumVaultFolder, 'name' | 'isManaged'> | null | undefined
): string {
  const raw = (folder?.name || '').trim();
  if (raw && MANAGED_VAULT_FOLDER_LABELS[raw]) {
    return MANAGED_VAULT_FOLDER_LABELS[raw];
  }
  if (folder?.isManaged || /^__[\w]+__$/.test(raw)) {
    return 'All media';
  }
  return raw || 'Folder';
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

export function PartnerAvatar({
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
        className={`${className} rounded-full object-cover border border-gray-300 dark:border-zinc-700 shrink-0 bg-gray-100 dark:bg-zinc-800`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`${className} rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-sm font-medium border border-gray-300 dark:border-zinc-700 shrink-0 text-gray-700 dark:text-zinc-300`}
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

function maloumMessageId(msg: MaloumMessage): string {
  return String(msg._id || '');
}

function mergeMaloumMessages(
  prev: MaloumMessage[],
  incoming: MaloumMessage[]
): MaloumMessage[] {
  if (prev.length === 0) return incoming;
  const byId = new Map<string, MaloumMessage>();
  for (const msg of prev) {
    const id = maloumMessageId(msg);
    if (id) byId.set(id, msg);
  }
  for (const msg of incoming) {
    const id = maloumMessageId(msg);
    if (id) byId.set(id, msg);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  for (const msg of prev) {
    const id = maloumMessageId(msg);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const msg of incoming) {
    const id = maloumMessageId(msg);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
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
  /** When false, stop polling and keep cached chats (Message Pro keep-alive). */
  pollEnabled?: boolean;
  /** Messages badge count; silent refresh on return only when > 0. */
  messagesUnread?: number;
};

export function MaloumChatList({
  creatorId,
  creatorName,
  selectedChatId,
  onSelectChat,
  className = '',
  showHeader = true,
  openActionLabel,
  pollEnabled = true,
  messagesUnread = 0,
}: MaloumChatListProps) {
  const [chats, setChats] = useState<MaloumChat[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inboxFilter, setInboxFilter] = useState<MaloumInboxFilterId>('all');
  const chatCountRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const paginatedBeyondFirstRef = useRef(false);
  const prevPollEnabledRef = useRef(pollEnabled);
  const prevLoadChatsRef = useRef<((opts?: {
    append?: boolean;
    next?: string | null;
    silent?: boolean;
  }) => Promise<void>) | null>(null);
  const prevMessagesUnreadRef = useRef(messagesUnread);

  useEffect(() => {
    chatCountRef.current = chats.length;
  }, [chats.length]);

  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

  const loadChats = useCallback(
    async (opts?: { append?: boolean; next?: string | null; silent?: boolean }) => {
      const append = Boolean(opts?.append);
      const silent = Boolean(opts?.silent);
      const next = opts?.next ?? (append ? nextCursorRef.current : null);

      if (append) {
        if (loadingMoreRef.current || !next) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const filterParams = maloumInboxFilterParams(inboxFilter);
        const result = await listMaloumChats(creatorId, {
          limit: CHAT_PAGE_LIMIT,
          next: next || undefined,
          ...filterParams,
        });
        const page = result.chats || [];
        const resultNext = result.next || null;

        if (append) {
          setChats((prev) => appendMaloumChats(prev, page));
          setNextCursor(resultNext);
          nextCursorRef.current = resultNext;
          paginatedBeyondFirstRef.current = true;
        } else if (silent) {
          setChats((prev) =>
            prev.length === 0 ? page : mergeMaloumChatPages(prev, page)
          );
          // Keep the deeper cursor when the user already loaded past page 1.
          if (!paginatedBeyondFirstRef.current) {
            setNextCursor(resultNext);
            nextCursorRef.current = resultNext;
          }
        } else {
          setChats(page);
          setNextCursor(resultNext);
          nextCursorRef.current = resultNext;
          paginatedBeyondFirstRef.current = false;
        }
      } catch (err) {
        if (!silent && !append) {
          setError(err instanceof Error ? err.message : 'Failed to load chats');
        }
      } finally {
        if (append) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        } else if (!silent) {
          setLoading(false);
        }
      }
    },
    [creatorId, inboxFilter]
  );

  function handleChatsScroll(e: UIEvent<HTMLDivElement>) {
    if (!nearScrollEnd(e.currentTarget, CHAT_LIST_NEAR_BOTTOM_PX)) return;
    const next = nextCursorRef.current;
    if (!next || loadingMoreRef.current) return;
    void loadChats({ append: true, next });
  }

  useEffect(() => {
    if (!pollEnabled) {
      prevPollEnabledRef.current = false;
      return;
    }

    const loadChatsChanged =
      prevLoadChatsRef.current !== null && prevLoadChatsRef.current !== loadChats;
    prevLoadChatsRef.current = loadChats;
    const justEnabled = !prevPollEnabledRef.current;
    prevPollEnabledRef.current = true;
    const unreadIncreased = messagesUnread > prevMessagesUnreadRef.current;
    prevMessagesUnreadRef.current = messagesUnread;

    if (chatCountRef.current === 0 || loadChatsChanged) {
      void loadChats();
    } else if (justEnabled && messagesUnread > 0) {
      void loadChats({ silent: true });
    } else if (!justEnabled && unreadIncreased) {
      void loadChats({ silent: true });
    }

    const timer = window.setInterval(() => {
      void loadChats({ silent: true });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollEnabled, loadChats, messagesUnread]);

  return (
    <div className={`flex flex-col h-full min-h-0 bg-[#F7F8FA] dark:bg-[#0a0a0c] ${className}`}>
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
            onClick={() => void loadChats()}
            disabled={loading}
            className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all disabled:opacity-40"
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
      <div className="px-2 py-2 border-b border-gray-200 dark:border-zinc-800/60 shrink-0">
        <div className="flex flex-wrap gap-1">
          {MALOUM_INBOX_FILTERS.map((chip) => {
            const active = inboxFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setInboxFilter(chip.id)}
                className={`px-2 py-1 rounded-full text-[10px] font-semibold transition-colors ${
                  active
                    ? 'bg-maloum-500 text-white'
                    : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="flex-1 overflow-y-auto min-h-0 animate-fade-in"
        onScroll={handleChatsScroll}
      >
        {error && (
          <p className="text-xs text-red-400 p-3">{error}</p>
        )}
        {!loading && !error && chats.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">No chats yet.</p>
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
                : chat.lastRelevantMessage?.type === 'tip'
                  ? 'Tip'
                  : '—');
          return (
            <button
              key={chat._id}
              type="button"
              onClick={() => onSelectChat(chat)}
              className={`w-full text-left p-3 border-l-2 transition-colors relative ${
                active
                  ? 'border-maloum-500 bg-gray-50/60 dark:bg-zinc-900/60 hover:bg-white/80 dark:hover:bg-zinc-900/80'
                  : 'border-transparent hover:bg-gray-100 dark:hover:bg-zinc-900/40 border-b border-b-gray-200 dark:border-b-zinc-800/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <PartnerAvatar partner={chat.chatPartner} name={name} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between min-w-0 mb-0.5">
                    <span
                      className={`text-sm truncate ${
                        active
                          ? 'font-semibold text-gray-900 dark:text-white'
                          : 'font-medium text-gray-800 dark:text-zinc-200'
                      }`}
                    >
                      {name}
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-zinc-500 shrink-0 ml-2">
                      {relative || ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-gray-500 dark:text-zinc-400 truncate flex-1">{preview}</p>
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
  const { user, hasPermission } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const creatorId = creator.id;
  const canEditVaultNotes = hasPermission('vault.notes.edit');
  const canManageScripts = hasPermission('scripts.manage');

  const [chat, setChat] = useState<MaloumChat | null>(initialChat);
  const [providerUserId, setProviderUserId] = useState<string | null>(
    creator.accountId || null
  );
  const [messages, setMessages] = useState<MaloumMessage[]>([]);
  const [messagesNext, setMessagesNext] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
  const [manualTranslateOnlyIds, setManualTranslateOnlyIds] = useState<
    Set<string>
  >(() => new Set());
  const manualTranslateOnlyIdsRef = useRef<Set<string>>(new Set());
  const [translatingMessageKeys, setTranslatingMessageKeys] = useState<
    Set<string>
  >(() => new Set());
  const historyTranslateQueueRef = useRef<HistoryTranslateQueue | null>(null);

  useEffect(() => {
    const queue = createHistoryTranslateQueue({
      concurrency: 4,
      onStart: (key) => {
        setTranslatingMessageKeys((prev) => new Set(prev).add(key));
      },
      onResult: (key, translated) => {
        historyTranslationsRef.current = {
          ...historyTranslationsRef.current,
          [key]: translated,
        };
        setHistoryTranslations((prev) => ({ ...prev, [key]: translated }));
      },
      onSettle: (key) => {
        setTranslatingMessageKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      },
    });
    historyTranslateQueueRef.current = queue;
    return () => {
      queue.dispose();
      if (historyTranslateQueueRef.current === queue) {
        historyTranslateQueueRef.current = null;
      }
    };
  }, []);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultPickMode, setVaultPickMode] = useState<'composer' | 'script'>('composer');
  const [scriptPickItems, setScriptPickItems] = useState<MaloumVaultMediaItem[]>([]);
  const [pendingScriptVaultMedia, setPendingScriptVaultMedia] = useState<
    CreatorScriptMediaItem[] | null
  >(null);
  const [appliedScriptId, setAppliedScriptId] = useState<string | null>(null);
  const [scriptsRefreshKey, setScriptsRefreshKey] = useState(0);
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
  const [vaultNotes, setVaultNotes] = useState<Record<string, string>>({});
  const [vaultNoteModal, setVaultNoteModal] = useState<{
    mediaKey: string;
    note: string;
  } | null>(null);
  const [ppvPrice, setPpvPrice] = useState('');
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState('');
  const [preview, setPreview] = useState<MaloumMediaPreview | null>(null);
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>(
    {}
  );
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const threadRootRef = useRef<HTMLDivElement | null>(null);
  const [threadWide, setThreadWide] = useState(true);
  const [fanPanelOpen, setFanPanelOpen] = useState(() =>
    readStoredBoolean(FAN_PANEL_OPEN_KEY, true)
  );
  const fanPanelUserOverrideRef = useRef(localStorage.getItem(FAN_PANEL_OPEN_KEY) != null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const nearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const messagesNextRef = useRef<string | null>(null);
  const loadingMoreFoldersRef = useRef(false);
  const loadingMoreMediaRef = useRef(false);
  const vaultFoldersNextRef = useRef<number | null>(null);
  const vaultMediaNextRef = useRef<number | null>(null);
  /** Maloum is EUR-only in the chatter UI. */
  const currency = 'EUR';

  const loadMessages = useCallback(
    async (opts?: { append?: boolean; next?: string | null; silent?: boolean }) => {
      const append = Boolean(opts?.append);
      const silent = Boolean(opts?.silent);
      if (append) {
        if (loadingOlderRef.current) return;
        loadingOlderRef.current = true;
        setLoadingOlder(true);
      } else if (!silent) {
        setMessagesLoading(true);
      }
      if (!silent) setMessagesError(null);
      try {
        const [chatResult, msgResult] = await Promise.all([
          append || silent
            ? Promise.resolve(null)
            : getMaloumChat(creatorId, chatId).catch(() => null),
          getMaloumMessages(creatorId, chatId, {
            limit: MESSAGE_PAGE_LIMIT,
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
        if (append) {
          const scrollEl = messagesScrollRef.current;
          if (scrollEl) {
            preserveScrollRef.current = {
              height: scrollEl.scrollHeight,
              top: scrollEl.scrollTop,
            };
          }
          const olderIds = chronological
            .map(maloumMessageId)
            .filter(Boolean);
          if (olderIds.length > 0) {
            setManualTranslateOnlyIds((prev) => {
              const next = new Set(prev);
              for (const id of olderIds) next.add(id);
              manualTranslateOnlyIdsRef.current = next;
              return next;
            });
          }
          setMessages((prev) => {
            const existing = new Set(prev.map(maloumMessageId).filter(Boolean));
            const fresh = chronological.filter((msg) => {
              const id = maloumMessageId(msg);
              return id && !existing.has(id);
            });
            return fresh.length > 0 ? [...fresh, ...prev] : prev;
          });
        } else {
          setMessages((prev) =>
            prev.length > 0 && manualTranslateOnlyIdsRef.current.size > 0
              ? mergeMaloumMessages(prev, chronological)
              : chronological
          );
        }
        const nextCursor = msgResult.next || null;
        // Keep the oldest-page cursor when a live refresh merges into already-loaded history.
        if (append || manualTranslateOnlyIdsRef.current.size === 0) {
          messagesNextRef.current = nextCursor;
          setMessagesNext(nextCursor);
        }
      } catch (err) {
        if (!silent) {
          setMessagesError(
            err instanceof Error ? err.message : 'Failed to load messages'
          );
        }
      } finally {
        if (append) {
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        } else if (!silent) {
          setMessagesLoading(false);
        }
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
    setMessagesNext(null);
    messagesNextRef.current = null;
    setDraft('');
    setSendError(null);
    setSelectedVaultItems([]);
    setPpvPrice('');
    setPriceModalOpen(false);
    setPriceDraft('');
    setVaultOpen(false);
    setMessageSenders({});
    setHistoryTranslations({});
    historyTranslationsRef.current = {};
    historyTranslateQueueRef.current?.clear();
    setManualTranslateOnlyIds(new Set());
    manualTranslateOnlyIdsRef.current = new Set();
    setTranslatingMessageKeys(new Set());
    nearBottomRef.current = true;
    preserveScrollRef.current = null;
    void loadMessages();
    void loadSenders();
    const timer = window.setInterval(() => {
      void loadMessages({ silent: true });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [chatId, creatorId, initialChat, loadMessages, loadSenders]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'messaging:sent') return;
      if (event.creatorId !== creatorId || event.chatId !== chatId) return;
      const name = event.chatterName;
      if (!name) return;
      setMessageSenders((prev) => {
        const next = { ...prev };
        if (event.maloumMessageId) next[event.maloumMessageId] = name;
        if (event.optimisticMessageId) next[event.optimisticMessageId] = name;
        return next;
      });
      void loadMessages({ silent: true });
    });
  }, [onSyncEvent, creatorId, chatId, loadMessages]);

  useEffect(() => {
    const el = threadRootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const applyWidth = (width: number) => {
      const wide = width >= FAN_PANEL_WIDE_BREAKPOINT;
      setThreadWide(wide);
      if (!fanPanelUserOverrideRef.current) {
        setFanPanelOpen(wide);
      }
    };
    applyWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toggleFanPanel = useCallback(() => {
    setFanPanelOpen((prev) => {
      const next = !prev;
      fanPanelUserOverrideRef.current = true;
      localStorage.setItem(FAN_PANEL_OPEN_KEY, String(next));
      return next;
    });
  }, []);

  const handleChatUpdated = useCallback((nextChat: MaloumChat) => {
    setChat(nextChat);
  }, []);

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

  const updateNearBottom = useCallback((el: HTMLDivElement) => {
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = messagesScrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
      nearBottomRef.current = true;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior });
    nearBottomRef.current = true;
  }, []);

  useLayoutEffect(() => {
    const preserved = preserveScrollRef.current;
    const el = messagesScrollRef.current;
    if (!preserved || !el) return;
    el.scrollTop = preserved.top + (el.scrollHeight - preserved.height);
    preserveScrollRef.current = null;
    updateNearBottom(el);
  }, [messages, updateNearBottom]);

  useEffect(() => {
    if (loadingOlderRef.current || preserveScrollRef.current) return;
    if (!nearBottomRef.current) return;
    scrollToBottom('smooth');
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    if (!autoTranslateHistory) return;
    if (loadingOlderRef.current || preserveScrollRef.current) return;
    if (!nearBottomRef.current) return;
    if (Object.keys(historyTranslations).length === 0) return;
    scrollToBottom('smooth');
  }, [historyTranslations, autoTranslateHistory, scrollToBottom]);

  const translateMessage = useCallback((msgKey: string, text: string) => {
    const trimmed = text.trim();
    if (!msgKey || !trimmed) return;
    const cacheKey = `${msgKey}::${trimmed}`;
    if (historyTranslationsRef.current[cacheKey]) return;
    historyTranslateQueueRef.current?.enqueue([
      { key: cacheKey, text: trimmed },
    ]);
  }, []);

  const handleMessagesScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      updateNearBottom(el);
      if (el.scrollTop > NEAR_TOP_PX) return;
      if (!messagesNextRef.current) return;
      if (loadingOlderRef.current) return;
      void loadMessages({ append: true, next: messagesNextRef.current });
    },
    [loadMessages, updateNearBottom]
  );

  useEffect(() => {
    if (!autoTranslateHistory) return;
    const pending: Array<{ key: string; text: string }> = [];
    // Newest first so the bottom of the thread fills in first.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const text = messageText(msg).trim();
      if (!text) continue;
      const msgKey = maloumMessageId(msg);
      if (!msgKey) continue;
      if (manualTranslateOnlyIdsRef.current.has(msgKey)) continue;
      const cacheKey = `${msgKey}::${text}`;
      if (historyTranslationsRef.current[cacheKey]) continue;
      pending.push({ key: cacheKey, text });
    }
    if (pending.length === 0) return;
    historyTranslateQueueRef.current?.enqueue(pending);
  }, [messages, autoTranslateHistory]);

  const toggleVaultItem = useCallback(
    (item: MaloumVaultMediaItem) => {
      const uploadId = vaultUploadId(item);
      if (!uploadId) return;
      if (vaultPickMode === 'script') {
        setScriptPickItems((prev) => {
          const exists = prev.some((entry) => vaultUploadId(entry) === uploadId);
          return exists
            ? prev.filter((entry) => vaultUploadId(entry) !== uploadId)
            : [...prev, item];
        });
        return;
      }
      setSelectedVaultItems((prev) => {
        const exists = prev.some((entry) => vaultUploadId(entry) === uploadId);
        const next = exists
          ? prev.filter((entry) => vaultUploadId(entry) !== uploadId)
          : [...prev, item];
        if (next.length === 0) {
          setPpvPrice('');
          setPriceDraft('');
          setPriceModalOpen(false);
        }
        return next;
      });
    },
    [vaultPickMode]
  );

  const loadVaultFolders = useCallback(
    async (opts?: { append?: boolean; next?: number | null }) => {
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
        const result = await listMaloumVaultFolders(creatorId, {
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
    [creatorId]
  );

  const loadMoreVaultFolders = useCallback(() => {
    const next = vaultFoldersNextRef.current;
    if (next == null) return;
    void loadVaultFolders({ append: true, next });
  }, [loadVaultFolders]);

  const vaultFanId = partnerId(chat) || undefined;

  const loadVaultMedia = useCallback(
    async (opts?: { append?: boolean; next?: number | null; folderId?: string }) => {
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
        setVaultNotes({});
        vaultMediaNextRef.current = null;
        setVaultMediaNext(null);
      }
      setVaultError(null);
      try {
        const result = await listMaloumVaultMedia(creatorId, folderId, {
          fanId: vaultFanId,
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
        const keys = items
          .map((item) => vaultUploadId(item))
          .filter((key): key is string => Boolean(key));
        if (keys.length > 0) {
          try {
            const notesResult = await listVaultMediaNotes(creatorId, 'maloum', keys);
            setVaultNotes((prev) =>
              append ? { ...prev, ...notesResult.notes } : { ...notesResult.notes }
            );
          } catch {
            // Notes are optional; vault grid still works without them.
          }
        }
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
    [creatorId, selectedFolderId, vaultFanId]
  );

  const loadMoreVaultMedia = useCallback(() => {
    const next = vaultMediaNextRef.current;
    if (next == null) return;
    void loadVaultMedia({ append: true, next });
  }, [loadVaultMedia]);

  const openVault = useCallback(async () => {
    setVaultPickMode('composer');
    setVaultOpen(true);
    setVaultTypeFilter('all');
    setVaultFolders([]);
    vaultFoldersNextRef.current = null;
    setVaultFoldersNext(null);
    await loadVaultFolders();
  }, [loadVaultFolders]);

  const openVaultForScript = useCallback(async () => {
    setVaultPickMode('script');
    setScriptPickItems([]);
    setVaultOpen(true);
    setVaultTypeFilter('all');
    setVaultFolders([]);
    vaultFoldersNextRef.current = null;
    setVaultFoldersNext(null);
    await loadVaultFolders();
  }, [loadVaultFolders]);

  const applyScriptToComposer = useCallback((script: CreatorScript) => {
    setDraft(script.messageText || '');
    setSelectedVaultItems(
      (script.media || []).map(scriptMediaToMaloumVaultItem)
    );
    setPpvPrice(
      script.price != null && script.price > 0 ? String(script.price) : ''
    );
    setPriceDraft('');
    setPriceModalOpen(false);
    setAppliedScriptId(script.id);
  }, []);

  const activeVaultSelection =
    vaultPickMode === 'script' ? scriptPickItems : selectedVaultItems;

  useEffect(() => {
    if (!vaultOpen || !selectedFolderId) return;
    void loadVaultMedia({ folderId: selectedFolderId });
  }, [vaultOpen, selectedFolderId, loadVaultMedia]);

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
      setPpvPrice('');
      setPriceModalOpen(false);
      setPriceDraft('');
      if (appliedScriptId) {
        const fanId = partnerId(chat);
        if (fanId) {
          void markScriptSent(creatorId, appliedScriptId, {
            fanId,
            chatId,
          })
            .then(() => setScriptsRefreshKey((k) => k + 1))
            .catch(() => {
              // Non-blocking
            });
        }
        setAppliedScriptId(null);
      }
      await loadMessages();
      requestAnimationFrame(() => {
        scrollToBottom();
      });
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
    scrollToBottom,
    appliedScriptId,
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
      ref={threadRootRef}
      className={`flex h-full min-h-0 relative ${className}`}
    >
      <div className="flex flex-col flex-1 min-w-0 min-h-0 relative chatter-thread-bg">
      <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95 z-0 pointer-events-none" />

      <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 relative z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md">
        <div className="flex items-center gap-4 min-w-0">
          <div className="relative shrink-0 hidden sm:block">
            <PartnerAvatar partner={chat?.chatPartner} name={title} />
            <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-500 border-2 border-gray-200 dark:border-zinc-950" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-base font-bold text-gray-900 dark:text-white truncate">{title}</h2>
              {spend && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  LTV: {spend}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate mt-0.5">
              @{chat?.chatPartner?.username || 'fan'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadMessages()}
            className="p-2 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all border border-transparent hover:border-gray-300 dark:hover:border-zinc-700"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={toggleFanPanel}
            className={`p-2 rounded-lg transition-all border ${
              fanPanelOpen
                ? 'text-orange-500 bg-orange-500/10 border-orange-500/30'
                : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 border-transparent hover:border-gray-300 dark:hover:border-zinc-700'
            }`}
            title={fanPanelOpen ? 'Hide fan info' : 'Show fan info'}
            aria-label={fanPanelOpen ? 'Hide fan info' : 'Show fan info'}
            aria-pressed={fanPanelOpen}
          >
            {fanPanelOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRight className="w-4 h-4" />
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

      <div
        ref={messagesScrollRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 min-h-0 relative z-10 scroll-smooth animate-fade-in"
      >
        {(loadingOlder || (messagesNext && messages.length > 0)) && (
          <div className="flex justify-center py-1">
            {loadingOlder ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading older messages…
              </span>
            ) : (
              <span className="text-[11px] text-gray-400 dark:text-zinc-600">
                Scroll up for older messages
              </span>
            )}
          </div>
        )}
        {messagesLoading && messages.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 text-center py-8">Loading messages…</p>
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
          const msgKey = maloumMessageId(msg);
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
          const trimmedText = text.trim();
          const cacheKey =
            msgKey && trimmedText ? `${msgKey}::${trimmedText}` : '';
          const historyEn =
            autoTranslateHistory && cacheKey
              ? historyTranslations[cacheKey]
              : undefined;
          const translatingThis =
            Boolean(cacheKey) && translatingMessageKeys.has(cacheKey);
          const showManualTranslate =
            autoTranslateHistory &&
            Boolean(msgKey && trimmedText) &&
            !historyEn &&
            manualTranslateOnlyIds.has(msgKey);
          const isPpv = msg.content?.type === 'chat_product';
          const isFreeMedia =
            !isPpv &&
            (msg.content?.type === 'media' || assets.length > 0);
          const priceNet =
            typeof msg.content?.price?.net === 'number'
              ? msg.content.price.net
              : typeof msg.content?.priceNet === 'number'
                ? msg.content.priceNet
                : null;
          const priceGross =
            typeof msg.content?.price?.gross === 'number'
              ? msg.content.price.gross
              : null;
          const priceCurrency =
            typeof msg.content?.price?.currency === 'string'
              ? msg.content.price.currency
              : 'EUR';
          const isTip =
            msg.content?.type === 'tip' ||
            (priceNet != null && !isPpv && !text && assets.length === 0) ||
            (priceGross != null && !isPpv && !text && assets.length === 0);
          const tipAmount = priceNet ?? priceGross;
          const tipLabel =
            isTip && tipAmount != null
              ? (() => {
                  try {
                    return new Intl.NumberFormat(undefined, {
                      style: 'currency',
                      currency: priceCurrency,
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format(tipAmount);
                  } catch {
                    return `${tipAmount} ${priceCurrency}`;
                  }
                })()
              : null;
          const ppvLabel =
            isPpv && priceNet != null
              ? formatSpend(priceNet, priceCurrency)
              : null;
          const isSold = isPpv && msg.isBought === true;
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
                {isTip ? (
                  <div className="rounded-2xl px-4 py-3 shadow-lg bg-zinc-900 border border-emerald-500/30 text-white chat-bubble-in min-w-[140px]">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300/90 uppercase tracking-wide">
                      <Banknote className="w-3.5 h-3.5" />
                      <span>Tip</span>
                    </div>
                    <div className="mt-1 text-2xl font-semibold tracking-tight">
                      {tipLabel || 'Tip'}
                    </div>
                  </div>
                ) : assets.length > 0 || isPpv ? (
                  <div
                    className={`rounded-2xl p-1.5 shadow-lg relative overflow-hidden ${
                      mine
                        ? 'bg-blue-50 dark:bg-zinc-900 border border-maloum-500/30 text-gray-900 dark:text-white chat-bubble-out'
                        : 'bg-gray-100/80 dark:bg-zinc-800/80 border border-gray-200 dark:border-zinc-700/50 text-gray-800 dark:text-zinc-200 chat-bubble-in'
                    }`}
                  >
                    {isSold && ppvLabel ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-emerald-600/90 backdrop-blur border border-emerald-400/40 text-[10px] font-bold tracking-widest text-white flex items-center gap-1">
                        <Check className="w-3 h-3" /> Sold · {ppvLabel}
                      </div>
                    ) : ppvLabel ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/35 dark:bg-black/60 backdrop-blur border border-gray-200 dark:border-white/10 text-[10px] font-bold tracking-widest text-amber-300 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> PPV · {ppvLabel}
                      </div>
                    ) : isFreeMedia ? (
                      <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/35 dark:bg-black/60 backdrop-blur border border-gray-200 dark:border-white/10 text-[10px] font-bold tracking-widest text-zinc-300 flex items-center gap-1">
                        Free
                      </div>
                    ) : null}
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
                                  className="w-full h-full object-cover bg-black/5 dark:bg-black/20 group-hover:scale-105 transition-transform duration-500"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-500">
                                  <ImageIcon className="w-6 h-6" />
                                </div>
                              )}
                              {video && (
                                <span className="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-black/20 group-hover:bg-black/5 dark:group-hover:bg-black/10 transition-colors">
                                  <span className="w-10 h-10 rounded-full bg-black/30 dark:bg-black/50 backdrop-blur flex items-center justify-center text-white/90">
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
                        : 'bg-gray-100/80 dark:bg-zinc-800/80 border border-gray-200 dark:border-zinc-700/50 text-gray-800 dark:text-zinc-200 chat-bubble-in'
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

                {showManualTranslate && (
                  <button
                    type="button"
                    onClick={() => void translateMessage(msgKey, trimmedText)}
                    disabled={translatingThis}
                    className={`mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                      mine
                        ? 'text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800'
                        : 'text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                    }`}
                    title="Translate to English"
                    aria-label="Translate message to English"
                  >
                    {translatingThis ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Languages className="w-3 h-3" />
                    )}
                    Translate
                  </button>
                )}

                <div
                  className={`mt-2 flex flex-col gap-1.5 ${
                    mine ? 'items-end mr-1' : 'items-start ml-1'
                  }`}
                >
                  <span className="text-[10px] text-gray-400 dark:text-zinc-600">
                    {formatRelativeTime(msg.sentAt) || ''}
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
            <div className="flex gap-2 max-w-[50%] overflow-x-auto">
              {selectedVaultItems.map((item) => {
                const uploadId = vaultUploadId(item);
                const src = vaultDirectUrl(item);
                return (
                  <button
                    key={uploadId || src || 'vault-chip'}
                    type="button"
                    onClick={() => toggleVaultItem(item)}
                    className="w-12 h-12 rounded-lg relative group overflow-hidden border border-gray-300 dark:border-zinc-700 shrink-0"
                    title="Remove"
                  >
                    {src ? (
                      <img src={src} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-500">
                        <ImageIcon className="w-4 h-4" />
                      </div>
                    )}
                    <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/35 dark:bg-black/60 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-domx-500/40 bg-domx-600/10 text-sm font-semibold text-domx-600 dark:text-domx-400 hover:bg-domx-600/20 transition-colors"
                    title="Edit media price"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    {currencySymbol}
                    {ppvPrice}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPpvPrice('');
                      setPriceDraft('');
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
                onClick={() => {
                  setSelectedVaultItems([]);
                  setPpvPrice('');
                  setPriceDraft('');
                  setPriceModalOpen(false);
                }}
                className="p-1 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white"
                aria-label="Clear attachment"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {sendError && (
          <p className="text-xs text-red-400 mb-2">{sendError}</p>
        )}
        {translatingOutgoing && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 mb-2">Translating to German…</p>
        )}

        <QuickEmojiBar
          onInsert={(emoji) => setDraft((d) => d + emoji)}
          trailing={
            <ScriptToolbarButton
              creatorId={creatorId}
              platform="maloum"
              fanId={partnerId(chat)}
              canManage={canManageScripts}
              onApply={applyScriptToComposer}
              onRequestVaultPick={() => void openVaultForScript()}
              pendingVaultMedia={pendingScriptVaultMedia}
              onPendingVaultMediaConsumed={() => setPendingScriptVaultMedia(null)}
              refreshKey={scriptsRefreshKey}
            />
          }
        />

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
                void handleSend();
              }
            }}
            rows={1}
            placeholder={
              autoTranslateOutgoing
                ? 'Type a message… (Auto-translates to German)'
                : 'Type a message…'
            }
            className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-gray-900 dark:text-white focus:outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600 leading-relaxed"
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
        <div
          className={`fixed inset-0 flex items-center justify-center p-4 sm:p-6 animate-fade-in ${
            vaultPickMode === 'script' ? 'z-[95]' : 'z-50'
          }`}
        >
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80 backdrop-blur-sm"
            onClick={() => {
              setVaultOpen(false);
              setVaultPickMode('composer');
              setScriptPickItems([]);
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
                    {vaultPickMode === 'script' ? 'Add media to script' : 'Media Vault'}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">
                    {activeVaultSelection.length} item
                    {activeVaultSelection.length === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {activeVaultSelection.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (vaultPickMode === 'script') {
                        setScriptPickItems([]);
                      } else {
                        setSelectedVaultItems([]);
                        setPpvPrice('');
                        setPriceDraft('');
                        setPriceModalOpen(false);
                      }
                    }}
                    className="px-3 py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                  >
                    Clear Selection
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (vaultPickMode === 'script') {
                      const media = scriptPickItems
                        .map(maloumVaultItemToScriptMedia)
                        .filter((m): m is CreatorScriptMediaItem => Boolean(m));
                      setPendingScriptVaultMedia(media);
                      setScriptPickItems([]);
                      setVaultPickMode('composer');
                    }
                    setVaultOpen(false);
                  }}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500 transition-colors shadow-lg shadow-domx-600/20"
                >
                  {vaultPickMode === 'script' ? 'Add to Script' : 'Insert Media'}
                </button>
                <div className="w-px h-6 bg-gray-100 dark:bg-zinc-800 mx-1" />
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setVaultPickMode('composer');
                    setScriptPickItems([]);
                  }}
                  className="p-2 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden min-h-0">
              <div
                className="w-48 sm:w-56 border-r border-gray-200 dark:border-zinc-800/60 bg-gray-100/40 dark:bg-zinc-900/20 p-3 overflow-y-auto hidden md:block shrink-0"
                onScroll={(e) => handleVaultFoldersScroll(e, 'vertical')}
              >
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-3 px-2">
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
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 truncate ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                              : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'
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
                <div
                  className="p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0 md:hidden"
                  onScroll={(e) => handleVaultFoldersScroll(e, 'horizontal')}
                >
                  {vaultFolders.map((folder) => {
                    const folderLabel = friendlyVaultFolderName(folder);
                    return (
                      <button
                        key={folder._id}
                        type="button"
                        onClick={() => setSelectedFolderId(folder._id)}
                        className={`shrink-0 px-3 py-1.5 text-xs rounded-full border transition-colors max-w-[160px] truncate ${
                          selectedFolderId === folder._id
                            ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                            : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700'
                        }`}
                        title={folderLabel}
                      >
                        {folderLabel}
                      </button>
                    );
                  })}
                  {vaultFoldersNext != null && (
                    <button
                      type="button"
                      onClick={loadMoreVaultFolders}
                      disabled={loadingMoreFolders}
                      className="shrink-0 self-center px-3 py-1.5 text-xs font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40 whitespace-nowrap"
                    >
                      {loadingMoreFolders ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
                <div className="p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
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

                <div
                  className="flex-1 overflow-y-auto p-4"
                  onScroll={handleVaultMediaScroll}
                >
                  {vaultLoading && vaultItems.length === 0 && (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-gray-500 dark:text-zinc-400" />
                    </div>
                  )}
                  {vaultError && (
                    <p className="text-sm text-red-400">{vaultError}</p>
                  )}
                  {!vaultLoading &&
                    !vaultError &&
                    filteredVaultItems.length === 0 && (
                      <p className="text-sm text-gray-500 dark:text-zinc-500">
                        {selectedFolderId
                          ? 'No media in this folder.'
                          : 'Vault is empty.'}
                      </p>
                    )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {filteredVaultItems.map((item) => {
                      const uploadId = vaultUploadId(item);
                      const src = vaultDirectUrl(item);
                      const selected = activeVaultSelection.some(
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
                              ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950'
                              : 'border border-gray-200 dark:border-zinc-800 hover:border-gray-400 dark:hover:border-zinc-600'
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
                              <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-500">
                                <ImageIcon className="w-6 h-6" />
                              </div>
                            )}
                          </button>
                          {uploadId ? (
                            <VaultMediaNoteButton
                              hasNote={Boolean(vaultNotes[uploadId]?.trim())}
                              onOpen={() =>
                                setVaultNoteModal({
                                  mediaKey: uploadId,
                                  note: vaultNotes[uploadId] || '',
                                })
                              }
                            />
                          ) : null}
                          {selected && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center z-10 shadow-lg pointer-events-none">
                              <Check className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {video && (
                            <div className="absolute inset-0 z-[5] flex items-center justify-center bg-black/5 dark:bg-black/20 group-hover:bg-black/5 dark:group-hover:bg-black/10 transition-colors pointer-events-none">
                              <button
                                type="button"
                                aria-label="Play video"
                                className="w-10 h-10 rounded-full bg-black/30 dark:bg-black/50 backdrop-blur flex items-center justify-center text-white/90 pointer-events-auto hover:bg-black/20 dark:hover:bg-black/70 transition-colors"
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
                            <span className="absolute bottom-2 right-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/20 dark:bg-black/70 text-white backdrop-blur pointer-events-none">
                              {durationLabel}
                            </span>
                          )}
                        </div>
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
            <h3 className="text-center text-lg font-bold text-gray-800 dark:text-white mb-6">
              Media price
            </h3>
            <div className="flex items-center gap-3 border-b border-gray-200 dark:border-zinc-700 pb-3 mb-5">
              <span className="text-2xl font-medium text-gray-700 dark:text-zinc-300">
                {currencySymbol}
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
              className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-base transition-colors"
            >
              Set price
            </button>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 dark:bg-black/70 p-6 animate-fade-in">
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
              className="relative z-10 w-full max-w-3xl aspect-[9/16] max-h-full rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : preview.kind === 'video' ? (
            <video
              src={preview.url}
              controls
              autoPlay
              playsInline
              className="relative z-10 max-w-full max-h-full rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
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
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/30 dark:bg-black/50 text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {vaultNoteModal && (
        <VaultMediaNoteModal
          creatorId={creatorId}
          platform="maloum"
          mediaKey={vaultNoteModal.mediaKey}
          initialNote={vaultNoteModal.note}
          canEdit={canEditVaultNotes}
          onClose={() => setVaultNoteModal(null)}
          onSaved={(note) => {
            setVaultNotes((prev) => ({
              ...prev,
              [vaultNoteModal.mediaKey]: note,
            }));
          }}
        />
      )}
      </div>

      {fanPanelOpen && threadWide && (
        <MaloumFanPanel
          creatorId={creatorId}
          chatId={chatId}
          chat={chat}
          onChatUpdated={handleChatUpdated}
          className="w-72 shrink-0"
        />
      )}

      {fanPanelOpen && !threadWide && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-20 bg-black/40 animate-fade-in"
            aria-label="Close fan info"
            onClick={toggleFanPanel}
          />
          <MaloumFanPanel
            creatorId={creatorId}
            chatId={chatId}
            chat={chat}
            onChatUpdated={handleChatUpdated}
            onClose={toggleFanPanel}
            className="absolute right-0 top-0 bottom-0 w-72 z-30 shadow-2xl animate-slide-up"
          />
        </>
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
    <div className="flex-1 flex min-w-0 min-h-0 bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300">
      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50 glass-panel">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Maloum</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5 animate-fade-in">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
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
                    ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50 hover:bg-gray-100 dark:hover:bg-zinc-800'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
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
                        ? 'font-semibold text-gray-900 dark:text-zinc-100 group-hover:text-gray-900 dark:group-hover:text-white'
                        : 'font-medium text-gray-700 dark:text-zinc-300 group-hover:text-gray-900 dark:group-hover:text-white'
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
                      accentClass="text-gray-500 dark:text-zinc-400"
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-4 bg-white/80 dark:bg-zinc-950/80">
          <TranslationToggles
            autoTranslateOutgoing={autoTranslateOutgoing}
            autoTranslateHistory={autoTranslateHistory}
            onOutgoingChange={handleAutoTranslateOutgoingChange}
            onHistoryChange={handleAutoTranslateHistoryChange}
          />
        </div>
      </aside>

      <aside className="w-80 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-[#F7F8FA] dark:bg-[#0a0a0c] glass-panel">
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
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">Select a creator</p>
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
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-zinc-500 chatter-thread-bg relative">
            <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95" />
            <span className="relative z-10">Select a creator chat to start</span>
          </div>
        )}
      </main>
    </div>
  );
}
