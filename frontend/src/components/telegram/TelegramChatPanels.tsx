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
  Image as ImageIcon,
  Languages,
  Loader2,
  Play,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Search,
  Send,
  Smile,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { berlinDateString, useStaffTimeZone } from '@/lib/berlinTime';
import {
  TRANSLATION_SETTINGS_EVENT,
} from '@/components/fourbased/FourBasedChatPanels';
import { DEFAULT_FAN_NOTES_TEMPLATE } from '@/components/maloum/MaloumFanPanel';
import GermanTimeClock from '@/components/GermanTimeClock';
import QuickEmojiBar from '@/components/QuickEmojiBar';
import VaultMediaLightbox from '@/components/VaultMediaLightbox';
import ScriptToolbarButton from '@/components/scripts/ScriptToolbarButton';
import SuggestReplyToolbarButton from '@/components/suggest/SuggestReplyToolbarButton';
import TelegramFanPanel from '@/components/telegram/TelegramFanPanel';
import TelegramReactionPicker, {
  applyOptimisticReactions,
  chosenReactionEmoji,
  reactionsMatch,
  TelegramReactionChips,
} from '@/components/telegram/TelegramReactionPicker';
import TelegramSextingSessionModal from '@/components/telegram/TelegramSextingSessionModal';
import TelegramVaultModal from '@/components/telegram/TelegramVaultModal';
import TelegramAudioPlayer, {
  TelegramVoiceTile,
} from '@/components/telegram/TelegramAudioPlayer';
import {
  createHistoryTranslateQueue,
  type HistoryTranslateQueue,
} from '@/lib/historyTranslateQueue';
import {
  addVaultSentIds,
  vaultCacheKey,
} from '@/lib/vaultListingCache';
import {
  createMessagingDashboardEntry,
  deleteTelegramMessage,
  getMessageUnsends,
  getMessagingDashboardSenders,
  getTelegramDialogs,
  getTelegramMessages,
  markScriptSent,
  resolveCreatorAvatarUrl,
  resolveTelegramUsername,
  sendTelegramMessage,
  setTelegramMessageReaction,
  telegramChatMediaUrl,
  telegramVaultMediaUrl,
  translateToGerman,
  type Creator,
  type CreatorScript,
  type CreatorScriptMediaItem,
  type MessageUnsendRecord,
  type TelegramDialog,
  type TelegramFan,
  type TelegramMessage,
  type TelegramVaultItem,
  type TranslateHistoryItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const FAN_PANEL_OPEN_KEY = 'domx-telegram-fan-panel';
const THREAD_WIDE_BREAKPOINT = 1000;
const MAX_TRANSLATION_HISTORY = 8;
const MESSAGE_PAGE_LIMIT = 50;
const NEAR_BOTTOM_PX = 120;
const NEAR_TOP_PX = 80;
const MEDIA_RETRY_MS = 1500;
const MEDIA_RETRY_MAX = 2;

function withCacheBust(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}retry=${attempt}`;
}

type TelegramHistoryCursor = { id: string; date: number };

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function fanLabel(fan: TelegramFan | null | undefined, fallback = 'Fan'): string {
  const nick = fan?.nickname?.trim();
  if (nick) return nick;
  return fan?.displayName?.trim() || fallback;
}

function canSeeFanUsername(role: string | undefined): boolean {
  return role === 'owner' || role === 'manager' || role === 'backend' || role === 'team_leader';
}

function canOpenByUsername(role: string | undefined): boolean {
  return role === 'owner' || role === 'manager';
}

function formatTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

function formatRelativeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function messageDayKey(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return berlinDateString(date, timeZone);
}

function formatDayLabel(dayKey: string, timeZone: string): string {
  const today = berlinDateString(new Date(), timeZone);
  const yesterday = berlinDateString(new Date(Date.now() - 86_400_000), timeZone);
  if (dayKey === today) return 'Today';
  if (dayKey === yesterday) return 'Yesterday';
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return dayKey;
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const thisYear = Number(today.slice(0, 4));
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(year !== thisYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

function messageHasVisualMedia(msg: TelegramMessage): boolean {
  if (msg.deleted) return false;
  return msg.kind === 'photo' || msg.kind === 'video';
}

function messageHasPlayableAudio(msg: TelegramMessage): boolean {
  if (msg.deleted) return false;
  return msg.kind === 'voice' || msg.kind === 'audio';
}

function vaultMediaType(kind: TelegramVaultItem['kind']): 'video' | 'voice' | 'image' {
  if (kind === 'video') return 'video';
  if (kind === 'voice') return 'voice';
  return 'image';
}

export function telegramVaultItemToScriptMedia(
  creatorId: string,
  item: TelegramVaultItem
): CreatorScriptMediaItem {
  return {
    mediaKey: item.id,
    type: vaultMediaType(item.kind),
    previewUrl:
      item.kind === 'voice'
        ? undefined
        : telegramVaultMediaUrl(creatorId, item.id, 'thumb'),
    width: item.width || undefined,
    height: item.height || undefined,
  };
}

export function scriptMediaToTelegramVaultItem(
  item: CreatorScriptMediaItem
): TelegramVaultItem {
  return {
    id: item.mediaKey,
    folderId: null,
    savedMessageId: '',
    kind:
      item.type === 'video' ? 'video' : item.type === 'voice' ? 'voice' : 'photo',
    width: item.width ?? null,
    height: item.height ?? null,
  };
}

const SENDER_NAME_COLORS = [
  'text-sky-600 dark:text-sky-400',
  'text-violet-600 dark:text-violet-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-rose-600 dark:text-rose-400',
  'text-teal-600 dark:text-teal-400',
  'text-orange-600 dark:text-orange-400',
  'text-fuchsia-600 dark:text-fuchsia-400',
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function senderClusterKey(msg: TelegramMessage): string {
  if (msg.isOutgoing) return 'out';
  return `in:${msg.senderId || msg.senderName || 'unknown'}`;
}

function senderNameColor(key: string): string {
  return SENDER_NAME_COLORS[hashString(key) % SENDER_NAME_COLORS.length];
}

function incomingClusterRadius(isStart: boolean, isEnd: boolean): string {
  if (isStart && isEnd) return 'rounded-2xl';
  if (isStart) return 'rounded-2xl rounded-bl-md';
  if (isEnd) return 'rounded-2xl rounded-tl-md';
  return 'rounded-2xl rounded-l-md';
}

function mergeTelegramMessages(
  prev: TelegramMessage[],
  incoming: TelegramMessage[]
): TelegramMessage[] {
  const byId = new Map(prev.map((msg) => [msg.id, msg]));
  for (const msg of incoming) {
    if (!msg?.id) continue;
    byId.set(msg.id, msg);
  }
  return [...byId.values()].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || ''))
  );
}

function mergeUnsendTombstones(
  messages: TelegramMessage[],
  unsends: Record<string, MessageUnsendRecord>,
  peerId: string
): TelegramMessage[] {
  const byId = new Map(messages.map((msg) => [msg.id, { ...msg }]));
  for (const [id, rec] of Object.entries(unsends)) {
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, {
        ...existing,
        deleted: true,
        text: rec.originalText || existing.text,
      });
      continue;
    }
    byId.set(id, {
      id,
      peerId,
      isOutgoing: true,
      date: rec.messageSentAt || rec.unsentAt,
      text: rec.originalText || '',
      kind: 'text',
      placeholder: null,
      deleted: true,
    });
  }
  return [...byId.values()].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || ''))
  );
}

function TelegramFanAvatar({
  name,
  avatarUrl,
  size = 'md',
}: {
  name: string;
  avatarUrl?: string | null;
  size?: 'xs' | 'cluster' | 'sm' | 'md';
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const dim =
    size === 'xs'
      ? 'w-5 h-5'
      : size === 'cluster'
        ? 'w-7 h-7'
        : size === 'sm'
          ? 'w-9 h-9'
          : 'w-10 h-10';
  const src = resolveCreatorAvatarUrl(avatarUrl);
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const initialClass =
    size === 'xs' ? 'text-[10px]' : size === 'cluster' ? 'text-[11px]' : 'text-sm';

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!failed || attempt >= MEDIA_RETRY_MAX) return undefined;
    const timer = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      setFailed(false);
    }, MEDIA_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);

  const exhausted = failed && attempt >= MEDIA_RETRY_MAX;
  if (src && !exhausted) {
    return (
      <img
        src={withCacheBust(src, attempt)}
        alt=""
        loading="lazy"
        decoding="async"
        className={`${dim} rounded-full object-cover bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 shrink-0`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`${dim} rounded-full bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 text-gray-700 dark:text-zinc-300 flex items-center justify-center ${initialClass} font-medium shrink-0`}
    >
      {initial}
    </div>
  );
}

function TelegramChatThumb({ src }: { src: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    setLoaded(false);
  }, [src]);

  useEffect(() => {
    if (!failed || attempt >= MEDIA_RETRY_MAX) return undefined;
    const timer = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      setFailed(false);
      setLoaded(false);
    }, MEDIA_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);

  const exhausted = failed && attempt >= MEDIA_RETRY_MAX;

  return (
    <span className="relative block min-h-[80px] min-w-[80px] bg-black/10 dark:bg-white/10">
      {!loaded && !exhausted ? (
        <span className="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10" />
      ) : null}
      {!exhausted ? (
        <img
          src={withCacheBust(src, attempt)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`max-h-56 max-w-full object-cover ${loaded ? '' : 'opacity-0'}`}
        />
      ) : (
        <span className="block h-20 w-28 bg-black/10 dark:bg-white/10" />
      )}
    </span>
  );
}

export function TelegramChatList({
  creatorId,
  selectedPeerId,
  onSelectDialog,
  pollEnabled,
  onRefreshExtra,
  clearedPeerId,
  clearedReadNonce,
}: {
  creatorId: string;
  selectedPeerId: string | null;
  onSelectDialog: (dialog: TelegramDialog) => void;
  pollEnabled: boolean;
  onRefreshExtra?: () => void;
  clearedPeerId?: string | null;
  clearedReadNonce?: number;
}) {
  const { user } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const showOpenByUsername = canOpenByUsername(user?.role);

  const loadDialogs = useCallback(async () => {
    try {
      const result = await getTelegramDialogs(creatorId);
      setDialogs(result.dialogs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats');
    } finally {
      setLoading(false);
    }
  }, [creatorId]);

  useEffect(() => {
    setLoading(true);
    void loadDialogs();
  }, [loadDialogs]);

  useEffect(() => {
    if (!pollEnabled) return;
    const timer = window.setInterval(() => {
      void loadDialogs();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadDialogs, pollEnabled]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'telegram:event') return;
      if (!pollEnabled) return;
      if (event.creatorId !== creatorId) return;
      void loadDialogs();
      onRefreshExtra?.();
    });
  }, [onSyncEvent, creatorId, loadDialogs, pollEnabled, onRefreshExtra]);

  const handleRefreshDialogs = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await loadDialogs();
      onRefreshExtra?.();
    } finally {
      setRefreshing(false);
    }
  }, [loadDialogs, onRefreshExtra, refreshing]);

  useEffect(() => {
    if (!clearedPeerId) return;
    setDialogs((prev) =>
      prev.map((dialog) =>
        dialog.peerId === clearedPeerId && dialog.unreadCount > 0
          ? { ...dialog, unreadCount: 0 }
          : dialog
      )
    );
  }, [clearedPeerId, clearedReadNonce]);

  const markDialogRead = useCallback((peerId: string) => {
    setDialogs((prev) =>
      prev.map((dialog) =>
        dialog.peerId === peerId && dialog.unreadCount > 0
          ? { ...dialog, unreadCount: 0 }
          : dialog
      )
    );
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dialogs;
    return dialogs.filter((dialog) => {
      const name = fanLabel(dialog.fan, dialog.displayName).toLowerCase();
      return name.includes(q);
    });
  }, [dialogs, query]);

  async function handleOpenByUsername() {
    const handle = usernameDraft.trim().replace(/^@/, '');
    if (!handle) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await resolveTelegramUsername(creatorId, handle);
      onSelectDialog({
        peerId: result.peerId,
        kind: 'dm',
        unreadCount: 0,
        lastMessage: null,
        displayName: result.fan.displayName,
        nickname: result.fan.nickname,
        notes: result.fan.notes,
        fan: { ...result.fan, kind: 'dm' },
      });
      setUsernameDraft('');
      void loadDialogs();
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : 'Could not open that user');
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-2 shrink-0">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">Chats</span>
        <button
          type="button"
          onClick={() => void handleRefreshDialogs()}
          disabled={loading || refreshing}
          className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all disabled:opacity-40"
          title="Refresh chats"
          aria-label="Refresh chats"
        >
          {loading || refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </button>
      </div>
      <div className="p-3 space-y-2 border-b border-gray-200 dark:border-zinc-800/60">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a]"
          />
        </div>
        {showOpenByUsername && (
          <div className="space-y-1">
            <div className="flex gap-1.5">
              <input
                value={usernameDraft}
                onChange={(e) => setUsernameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !opening) void handleOpenByUsername();
                }}
                placeholder="@username"
                className="flex-1 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a]"
              />
              <button
                type="button"
                onClick={() => void handleOpenByUsername()}
                disabled={opening}
                className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white disabled:opacity-50"
              >
                Open
              </button>
            </div>
            {openError && <p className="text-[11px] text-red-400">{openError}</p>}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">Loading chats…</p>
        )}
        {error && <p className="text-xs text-red-400 p-4">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">No chats yet.</p>
        )}
        {filtered.map((dialog) => {
          const active = selectedPeerId === dialog.peerId;
          const preview = dialog.lastMessage?.text || dialog.lastMessage?.placeholder || '';
          const isGroup = (dialog.kind || dialog.fan?.kind) === 'group';
          const ago = formatRelativeAgo(dialog.lastMessage?.date);
          return (
            <button
              key={dialog.peerId}
              type="button"
              onClick={() => {
                markDialogRead(dialog.peerId);
                onSelectDialog(dialog);
              }}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-white/5 ${
                active
                  ? 'bg-gray-100 dark:bg-zinc-800/50'
                  : 'hover:bg-gray-50 dark:hover:bg-white/[0.03]'
              }`}
            >
              <div className="flex items-start gap-3">
                <TelegramFanAvatar
                  name={fanLabel(dialog.fan, dialog.displayName)}
                  avatarUrl={dialog.fan?.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-zinc-100 truncate">
                      {fanLabel(dialog.fan, dialog.displayName)}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {ago ? (
                        <span className="text-[10px] text-gray-500 dark:text-zinc-500">
                          {ago}
                        </span>
                      ) : null}
                      {dialog.unreadCount > 0 && (
                        <span className="text-[10px] font-semibold bg-sky-600 text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                          {dialog.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-zinc-500 truncate mt-0.5">
                    {isGroup ? (
                      <span className="mr-1.5 text-[10px] uppercase tracking-wide text-sky-600">
                        Group
                      </span>
                    ) : null}
                    {preview || '—'}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TelegramChatThread({
  creatorId,
  creator,
  peerId,
  initialFan,
  pollEnabled,
  onClose,
  onMarkedRead,
}: {
  creatorId: string;
  creator?: Creator | null;
  peerId: string;
  initialFan?: TelegramFan | null;
  pollEnabled: boolean;
  onClose?: () => void;
  onMarkedRead?: (peerId: string) => void;
}) {
  const { user, hasPermission } = useAuth();
  const confirm = useConfirm();
  const { onSyncEvent } = useStaffSync();
  const staffTimeZone = useStaffTimeZone();
  const canUseSuggestReply = user?.role === 'owner' || user?.role === 'manager';
  const canManageScripts = hasPermission('scripts.manage');
  const [fan, setFan] = useState<TelegramFan | null>(initialFan || null);
  const [messages, setMessages] = useState<TelegramMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [skipOutgoingTranslate, setSkipOutgoingTranslate] = useState(false);
  const [suggestedEnglish, setSuggestedEnglish] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messagesNext, setMessagesNext] = useState<TelegramHistoryCursor | null>(
    null
  );
  const threadRootRef = useRef<HTMLDivElement | null>(null);
  const [threadWide, setThreadWide] = useState(true);
  const [fanPanelOpen, setFanPanelOpen] = useState(() =>
    readStoredBoolean(FAN_PANEL_OPEN_KEY, true)
  );
  const fanPanelUserOverrideRef = useRef(
    localStorage.getItem(FAN_PANEL_OPEN_KEY) != null
  );
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const [autoTranslateHistory, setAutoTranslateHistory] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true)
  );
  const [historyTranslations, setHistoryTranslations] = useState<Record<string, string>>({});
  const [translatingKeys, setTranslatingKeys] = useState<Record<string, boolean>>({});
  const [messageSenders, setMessageSenders] = useState<Record<string, string>>({});
  const [messageUnsends, setMessageUnsends] = useState<
    Record<string, MessageUnsendRecord>
  >({});
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [reactingMessageId, setReactingMessageId] = useState<string | null>(null);
  const [reactionPickerId, setReactionPickerId] = useState<string | null>(null);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultPickMode, setVaultPickMode] = useState<'composer' | 'script'>('composer');
  const [vaultItems, setVaultItems] = useState<TelegramVaultItem[]>([]);
  const [pendingScriptVaultMedia, setPendingScriptVaultMedia] = useState<
    CreatorScriptMediaItem[] | null
  >(null);
  const [appliedScriptId, setAppliedScriptId] = useState<string | null>(null);
  const [scriptsRefreshKey, setScriptsRefreshKey] = useState(0);
  const [chatMediaPreview, setChatMediaPreview] = useState<TelegramMessage | null>(
    null
  );
  const [generateSessionOpen, setGenerateSessionOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const nearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const messagesNextRef = useRef<TelegramHistoryCursor | null>(null);
  const loadedOlderRef = useRef(false);
  const messageUnsendsRef = useRef(messageUnsends);
  messageUnsendsRef.current = messageUnsends;
  const threadKeyRef = useRef(`${creatorId}:${peerId}`);
  threadKeyRef.current = `${creatorId}:${peerId}`;
  const historyTranslateQueueRef = useRef<HistoryTranslateQueue | null>(null);
  const historyTranslationsRef = useRef(historyTranslations);
  historyTranslationsRef.current = historyTranslations;
  const markedReadOnOpenRef = useRef(false);
  const onMarkedReadRef = useRef(onMarkedRead);
  onMarkedReadRef.current = onMarkedRead;
  const showUsername = canSeeFanUsername(user?.role);
  const isGroup = fan?.kind === 'group';

  useEffect(() => {
    const sync = () => {
      setAutoTranslateOutgoing(readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true));
      setAutoTranslateHistory(readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true));
    };
    window.addEventListener(TRANSLATION_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(TRANSLATION_SETTINGS_EVENT, sync);
  }, []);

  useEffect(() => {
    const el = threadRootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const applyWidth = (width: number) => {
      const wide = width >= THREAD_WIDE_BREAKPOINT;
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

  useEffect(() => {
    const queue = createHistoryTranslateQueue({
      onStart: (key) => {
        setTranslatingKeys((prev) => ({ ...prev, [key]: true }));
      },
      onSettle: (key) => {
        setTranslatingKeys((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      },
      onResult: (key, translated) => {
        setHistoryTranslations((prev) => ({ ...prev, [key]: translated }));
      },
    });
    historyTranslateQueueRef.current = queue;
    return () => {
      queue.dispose();
      if (historyTranslateQueueRef.current === queue) {
        historyTranslateQueueRef.current = null;
      }
    };
  }, [creatorId, peerId]);

  useEffect(() => {
    setHistoryTranslations({});
    historyTranslateQueueRef.current?.clear();
    setMessageSenders({});
    setMessageUnsends({});
    setMessages([]);
    setMessagesNext(null);
    messagesNextRef.current = null;
    loadedOlderRef.current = false;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    nearBottomRef.current = true;
    preserveScrollRef.current = null;
    setVaultItems([]);
    setVaultOpen(false);
    setVaultPickMode('composer');
    setPendingScriptVaultMedia(null);
    setAppliedScriptId(null);
    setSkipOutgoingTranslate(false);
    setSuggestedEnglish(null);
    setChatMediaPreview(null);
    setGenerateSessionOpen(false);
    setReactingMessageId(null);
    setReactionPickerId(null);
    markedReadOnOpenRef.current = false;
  }, [creatorId, peerId]);

  const loadMessages = useCallback(
    async (opts?: {
      append?: boolean;
      next?: TelegramHistoryCursor | null;
      silent?: boolean;
    }) => {
      const append = Boolean(opts?.append);
      const silent = Boolean(opts?.silent);
      const key = `${creatorId}:${peerId}`;
      if (append) {
        if (loadingOlderRef.current) return;
        loadingOlderRef.current = true;
        setLoadingOlder(true);
      }
      try {
        const offset = append ? opts?.next || messagesNextRef.current : null;
        const [result, unsendResult] = await Promise.all([
          getTelegramMessages(creatorId, peerId, {
            limit: MESSAGE_PAGE_LIMIT,
            ...(append && offset
              ? { offsetId: offset.id, offsetDate: offset.date }
              : {}),
          }),
          append
            ? Promise.resolve({ unsends: messageUnsendsRef.current })
            : getMessageUnsends({
                creatorId,
                chatId: peerId,
                platform: 'telegram',
                limit: 200,
              }).catch(() => ({
                unsends: {} as Record<string, MessageUnsendRecord>,
              })),
        ]);
        if (threadKeyRef.current !== key) return;
        const unsends = unsendResult.unsends || {};
        if (!append) setMessageUnsends(unsends);
        if (result.fan) {
          setFan({
            ...result.fan,
            kind: result.kind || result.fan.kind || 'dm',
          });
        }
        const incoming = result.messages || [];
        const hasMore =
          result.hasMore != null
            ? Boolean(result.hasMore)
            : Boolean(result.next?.id);
        const nextCursor =
          hasMore && result.next?.id
            ? {
                id: String(result.next.id),
                date: Number(result.next.date) || 0,
              }
            : null;
        if (append) {
          const scrollEl = messagesScrollRef.current;
          if (scrollEl) {
            preserveScrollRef.current = {
              height: scrollEl.scrollHeight,
              top: scrollEl.scrollTop,
            };
          }
          const incomingIds = incoming.map((msg) => msg.id).filter(Boolean);
          setMessages((prev) => {
            const existing = new Set(prev.map((msg) => msg.id));
            const fresh = incoming.filter(
              (msg) => msg.id && !existing.has(msg.id)
            );
            if (fresh.length === 0) return prev;
            return mergeUnsendTombstones(
              [...fresh, ...prev],
              messageUnsendsRef.current,
              peerId
            );
          });
          loadedOlderRef.current = true;
          const offsetUnchanged =
            Boolean(offset?.id) && nextCursor?.id === offset?.id;
          const exhausted =
            incomingIds.length === 0 || offsetUnchanged || !nextCursor;
          const cursor = exhausted ? null : nextCursor;
          messagesNextRef.current = cursor;
          setMessagesNext(cursor);
        } else {
          setMessages((prev) => {
            const merged =
              silent && (prev.length > 0 || loadedOlderRef.current)
                ? mergeTelegramMessages(prev, incoming)
                : incoming;
            return mergeUnsendTombstones(merged, unsends, peerId);
          });
          if (!loadedOlderRef.current) {
            messagesNextRef.current = nextCursor;
            setMessagesNext(nextCursor);
          }
          if (!markedReadOnOpenRef.current) {
            markedReadOnOpenRef.current = true;
            onMarkedReadRef.current?.(peerId);
          }
        }
      } catch (err) {
        if (!silent && threadKeyRef.current === key) {
          setError(
            err instanceof Error ? err.message : 'Failed to load messages'
          );
        }
      } finally {
        if (append) {
          loadingOlderRef.current = false;
          if (threadKeyRef.current === key) setLoadingOlder(false);
        }
      }
    },
    [creatorId, peerId]
  );

  const loadSenders = useCallback(async () => {
    const key = `${creatorId}:${peerId}`;
    try {
      const result = await getMessagingDashboardSenders({
        creatorId,
        chatId: peerId,
        limit: 200,
      });
      if (threadKeyRef.current !== key) return;
      setMessageSenders(result.senders || {});
    } catch {
      // best-effort
    }
  }, [creatorId, peerId]);

  const handleRefreshMessages = useCallback(async () => {
    if (messagesRefreshing) return;
    setMessagesRefreshing(true);
    setError(null);
    try {
      await loadMessages({ silent: true });
      await loadSenders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setMessagesRefreshing(false);
    }
  }, [loadMessages, loadSenders, messagesRefreshing]);

  useEffect(() => {
    setError(null);
    void loadMessages().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    });
    void loadSenders();
  }, [loadMessages, loadSenders]);

  useEffect(() => {
    if (!pollEnabled) return;
    const timer = window.setInterval(() => {
      void loadMessages({ silent: true }).catch(() => undefined);
      void loadSenders();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadMessages, loadSenders, pollEnabled]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'telegram:event') return;
      if (!pollEnabled) return;
      if (event.creatorId !== creatorId) return;
      const eventPeer = event.payload && typeof event.payload === 'object'
        ? String((event.payload as { peerId?: string }).peerId || '')
        : '';
      if (eventPeer && eventPeer !== peerId) return;
      void loadMessages({ silent: true }).catch(() => undefined);
      void loadSenders();
    });
  }, [onSyncEvent, creatorId, peerId, loadMessages, loadSenders, pollEnabled]);

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
    bottomRef.current?.scrollIntoView({ behavior });
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
    if (!autoTranslateHistory || !pollEnabled) return;
    const pending: Array<{ key: string; text: string }> = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text || msg.placeholder || msg.deleted) continue;
      const cacheKey = `${msg.id}::${text}`;
      if (historyTranslationsRef.current[cacheKey]) continue;
      pending.push({ key: cacheKey, text });
    }
    if (pending.length) {
      historyTranslateQueueRef.current?.enqueue(pending);
    }
  }, [messages, autoTranslateHistory, pollEnabled]);

  const translateMessage = useCallback((msgKey: string, text: string) => {
    const trimmed = text.trim();
    if (!msgKey || !trimmed) return;
    const cacheKey = `${msgKey}::${trimmed}`;
    if (historyTranslationsRef.current[cacheKey]) return;
    historyTranslateQueueRef.current?.enqueue([{ key: cacheKey, text: trimmed }]);
  }, []);

  async function handleSend() {
    const text = draft.trim();
    const attached = vaultItems;
    if ((!text && attached.length === 0) || sending || translatingOutgoing) return;
    setSending(true);
    setError(null);
    const englishDraft =
      skipOutgoingTranslate && suggestedEnglish ? suggestedEnglish : text;
    try {
      let messageToSend = text;
      if (text && autoTranslateOutgoing && !skipOutgoingTranslate) {
        setTranslatingOutgoing(true);
        try {
          const history: TranslateHistoryItem[] = messages
            .filter((m) => typeof m.text === 'string' && m.text.trim())
            .slice(-MAX_TRANSLATION_HISTORY)
            .map((m) => ({
              role: m.isOutgoing ? 'assistant' : 'user',
              content: m.text.trim(),
            }));
          messageToSend = await translateToGerman(text, history);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : 'Translation failed. Message was not sent.'
          );
          return;
        } finally {
          setTranslatingOutgoing(false);
        }
      }

      const result = await sendTelegramMessage(
        creatorId,
        peerId,
        messageToSend,
        englishDraft,
        attached.length ? { vaultIds: attached.map((item) => item.id) } : undefined
      );
      setDraft('');
      setVaultItems([]);
      setSkipOutgoingTranslate(false);
      setSuggestedEnglish(null);
      const sentMessages = (result.messages || (result.message ? [result.message] : [])).filter(
        Boolean
      ) as TelegramMessage[];
      if (sentMessages.length) {
        nearBottomRef.current = true;
        setMessages((prev) => [...prev, ...sentMessages]);
      } else {
        nearBottomRef.current = true;
        await loadMessages({ silent: true });
      }

      if (attached.length && fan?.telegramUserId) {
        addVaultSentIds(
          vaultCacheKey({
            platform: 'telegram',
            creatorId,
            kind: 'sent',
            fanId: fan.telegramUserId,
          }),
          attached.map((item) => item.id)
        );
      }

      if (user?.id && sentMessages[0]) {
        const first = sentMessages[0];
        const dashboardMessageId = `telegram:${first.id}`;
        const chatterName = user.name;
        setMessageSenders((prev) => ({
          ...prev,
          [dashboardMessageId]: chatterName,
        }));
        const pictureCount = attached.filter((item) => item.kind === 'photo').length;
        const videoCount = attached.filter((item) => item.kind === 'video').length;
        void createMessagingDashboardEntry({
          id: crypto.randomUUID(),
          creatorId,
          creatorName: creator?.displayName,
          creatorUsername: creator?.username,
          creatorAvatarUrl: creator?.avatarUrl,
          chatterId: user.id,
          chatterName,
          chatterEmail: user.email,
          chatId: peerId,
          fanId: peerId,
          fanUsername:
            fan?.nickname?.trim() || fan?.displayName?.trim() || null,
          maloumMessageId: dashboardMessageId,
          contentType: attached.length ? 'media' : 'text',
          englishMessage: englishDraft || null,
          germanTranslatedMessage: messageToSend || null,
          actualSentText: messageToSend || null,
          mediaCount: attached.length,
          pictureCount,
          videoCount,
          mediaJson: attached.length
            ? attached.map((item) => ({
                mediaId: item.id,
                type: vaultMediaType(item.kind),
                width: item.width || undefined,
                height: item.height || undefined,
              }))
            : null,
          sentAt: first.date || new Date().toISOString(),
        }).catch(() => {
          // Persistence failures are non-blocking for the chatter UI.
        });
      }

      if (appliedScriptId) {
        void markScriptSent(creatorId, appliedScriptId, {
          fanId: fan?.telegramUserId || peerId,
          chatId: peerId,
        })
          .then(() => setScriptsRefreshKey((k) => k + 1))
          .catch(() => {
            // Non-blocking
          });
        setAppliedScriptId(null);
      }
      onMarkedRead?.(peerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
      setTranslatingOutgoing(false);
    }
  }

  async function handleDeleteMessage(messageId: string) {
    if (!messageId || deletingMessageId) return;
    const existing = messages.find((m) => m.id === messageId);
    if (!existing || !existing.isOutgoing || existing.deleted) return;
    const ok = await confirm({
      title: 'Unsend message',
      message: 'Unsend this message? It will remain visible in DomX for audit.',
      confirmLabel: 'Unsend',
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingMessageId(messageId);
    setError(null);
    try {
      const result = await deleteTelegramMessage(creatorId, peerId, messageId, {
        originalText: existing.text || '',
        messageSentAt: existing.date,
      });
      const unsend = result.unsend || {
        originalText: existing.text || '',
        unsentByUserName: user?.name || 'Unknown',
        unsentAt: new Date().toISOString(),
        messageSentAt: existing.date,
      };
      setMessageUnsends((prev) => ({
        ...prev,
        [messageId]: unsend,
      }));
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                deleted: true,
                text: unsend.originalText || msg.text,
              }
            : msg
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unsend');
    } finally {
      setDeletingMessageId(null);
    }
  }

  async function handleReact(messageId: string, emoji: string) {
    if (!messageId || reactingMessageId) return;
    const existing = messages.find((m) => m.id === messageId);
    if (!existing || existing.deleted) return;
    const chosen = chosenReactionEmoji(existing.reactions);
    const nextEmoji = chosen && reactionsMatch(emoji, chosen) ? null : emoji;
    setReactingMessageId(messageId);
    setReactionPickerId(null);
    setError(null);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, reactions: applyOptimisticReactions(msg.reactions, nextEmoji) }
          : msg
      )
    );
    try {
      const result = await setTelegramMessageReaction(
        creatorId,
        peerId,
        messageId,
        nextEmoji
      );
      if (result.message) {
        setMessages((prev) => {
          const current = prev.find((m) => m.id === messageId);
          return mergeTelegramMessages(prev, [
            {
              ...result.message,
              senderAvatarUrl:
                result.message.senderAvatarUrl ||
                current?.senderAvatarUrl ||
                existing.senderAvatarUrl,
              deleted: current?.deleted || existing.deleted,
            },
          ]);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to react');
      void loadMessages({ silent: true }).catch(() => undefined);
    } finally {
      setReactingMessageId(null);
    }
  }

  const applySuggestedReply = useCallback(
    (payload: { english: string; german: string }) => {
      setDraft(payload.german || '');
      setSuggestedEnglish(payload.english || null);
      setSkipOutgoingTranslate(true);
      setAppliedScriptId(null);
    },
    []
  );

  const getSuggestMessages = useCallback((): TranslateHistoryItem[] => {
    return messages
      .filter((m) => typeof m.text === 'string' && m.text.trim())
      .slice(-12)
      .map((m) => ({
        role: m.isOutgoing ? 'assistant' : 'user',
        content: m.text.trim(),
      }));
  }, [messages]);

  const getSuggestFanNotes = useCallback(() => {
    const notes = fan?.notes?.trim() || '';
    if (!notes || notes === DEFAULT_FAN_NOTES_TEMPLATE.trim()) return '';
    return notes;
  }, [fan?.notes]);

  const applyScriptToComposer = useCallback(
    (script: CreatorScript) => {
      setDraft(script.messageText || '');
      setSkipOutgoingTranslate(false);
      setSuggestedEnglish(null);
      setVaultItems((script.media || []).map(scriptMediaToTelegramVaultItem));
      setAppliedScriptId(script.id);
    },
    []
  );

  const openVault = useCallback(() => {
    setVaultPickMode('composer');
    setVaultOpen(true);
  }, []);

  const openVaultForScript = useCallback(() => {
    setVaultPickMode('script');
    setVaultOpen(true);
  }, []);

  const handleFanUpdated = useCallback((updated: TelegramFan) => {
    setFan((prev) => ({
      ...(prev || {}),
      ...updated,
      kind: prev?.kind || updated.kind,
    }));
  }, []);

  return (
    <div
      ref={threadRootRef}
      className="flex-1 flex h-full min-w-0 min-h-0 overflow-hidden relative"
    >
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden chatter-thread-bg relative">
      <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95 z-0 pointer-events-none" />
      <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 bg-white/80 dark:bg-zinc-950/80 relative z-10 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <TelegramFanAvatar
            name={fanLabel(fan, isGroup ? 'Group' : 'Fan')}
            avatarUrl={fan?.avatarUrl}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {fanLabel(fan, isGroup ? 'Group' : 'Fan')}
            </p>
            {isGroup ? (
              <p className="text-xs text-sky-600 truncate">Group</p>
            ) : showUsername && fan?.username ? (
              <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">@{fan.username}</p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <GermanTimeClock />
          <button
            type="button"
            onClick={() => setGenerateSessionOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            title={
              isGroup
                ? 'Generate multi-model sexting session'
                : 'Generate 1:1 sexting session'
            }
          >
            <Sparkles className="w-3.5 h-3.5" />
            Generate session
          </button>
          <button
            type="button"
            onClick={() => void handleRefreshMessages()}
            disabled={messagesRefreshing}
            className="p-2 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all border border-transparent hover:border-gray-300 dark:hover:border-zinc-700 disabled:opacity-40"
            title="Refresh"
            aria-label="Refresh messages"
          >
            {messagesRefreshing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleFanPanel}
            className={`p-2 rounded-lg transition-all border ${
              fanPanelOpen
                ? 'text-sky-500 bg-sky-500/10 border-sky-500/30'
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
              className="p-1.5 rounded-md text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
              title="Close conversation"
              aria-label="Close conversation"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={messagesScrollRef}
        onScroll={handleMessagesScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 relative z-10 chat-thread-scroll"
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
        {messages.map((msg, index) => {
          const msgText = msg.text || '';
          const cacheKey = `${msg.id}::${msgText.trim()}`;
          const historyEn = historyTranslations[cacheKey];
          const translatingThis = Boolean(translatingKeys[cacheKey]);
          const showManualTranslate =
            !autoTranslateHistory &&
            Boolean(msgText.trim()) &&
            !msg.placeholder &&
            !msg.deleted &&
            !historyEn;
          const sentBy = msg.isOutgoing
            ? messageSenders[`telegram:${msg.id}`]
            : undefined;
          const unsentBy = messageUnsends[msg.id]?.unsentByUserName;
          const canUnsend = msg.isOutgoing && !msg.deleted;
          const deleting = deletingMessageId === msg.id;
          const clusterKey = senderClusterKey(msg);
          const prevKey = index > 0 ? senderClusterKey(messages[index - 1]) : null;
          const nextKey =
            index < messages.length - 1 ? senderClusterKey(messages[index + 1]) : null;
          const dayKey = messageDayKey(msg.date, staffTimeZone);
          const prevDayKey =
            index > 0 ? messageDayKey(messages[index - 1].date, staffTimeZone) : null;
          const nextDayKey =
            index < messages.length - 1
              ? messageDayKey(messages[index + 1].date, staffTimeZone)
              : null;
          const isNewDay = Boolean(dayKey && dayKey !== prevDayKey);
          const isClusterStart = clusterKey !== prevKey || isNewDay;
          const isClusterEnd = clusterKey !== nextKey || Boolean(dayKey && dayKey !== nextDayKey);
          const showGroupChrome = isGroup && !msg.isOutgoing;
          const showName = showGroupChrome && isClusterStart && Boolean(msg.senderName);
          const showAvatar = showGroupChrome && isClusterEnd;
          const nameHover =
            showUsername && msg.senderUsername ? `@${msg.senderUsername}` : undefined;
          const bubbleRadius = showGroupChrome
            ? incomingClusterRadius(isClusterStart, isClusterEnd)
            : 'rounded-2xl';
          return (
            <div key={msg.id}>
              {isNewDay && dayKey && (
                <div className="flex justify-center my-3">
                  <span className="text-[11px] font-medium text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-800 rounded-full px-3 py-0.5">
                    {formatDayLabel(dayKey, staffTimeZone)}
                  </span>
                </div>
              )}
              <div
                className={`group/msg flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'} ${
                  isNewDay ? '' : index === 0 ? '' : isClusterStart ? 'mt-3' : 'mt-0.5'
                }`}
              >
                <div
                  className={`relative max-w-[75%] min-w-0 flex flex-col ${
                    msg.isOutgoing ? 'items-end' : 'items-start'
                  }`}
                >
                {!msg.deleted && (
                  <div
                    className={`absolute bottom-full mb-0.5 z-20 flex items-center gap-0.5 rounded-lg bg-white/95 dark:bg-zinc-950/95 px-0.5 shadow-sm ${
                      msg.isOutgoing ? 'right-0' : 'left-0'
                    } ${
                      reactionPickerId === msg.id
                        ? 'opacity-100'
                        : 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100'
                    } transition-opacity`}
                  >
                    {canUnsend && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteMessage(msg.id)}
                        disabled={deleting}
                        className="p-1 rounded-md text-gray-500 dark:text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                        title="Unsend message"
                        aria-label="Unsend message"
                      >
                        {deleting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                    <div
                      className="relative"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setReactionPickerId((current) =>
                            current === msg.id ? null : msg.id
                          )
                        }
                        disabled={reactingMessageId === msg.id}
                        className="p-1 rounded-md text-gray-500 dark:text-zinc-500 hover:text-sky-500 hover:bg-sky-500/10 transition-all disabled:opacity-50"
                        title="React"
                        aria-label="React to message"
                        aria-expanded={reactionPickerId === msg.id}
                      >
                        {reactingMessageId === msg.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Smile className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <TelegramReactionPicker
                        open={reactionPickerId === msg.id}
                        chosenEmoji={chosenReactionEmoji(msg.reactions)}
                        alignEnd={msg.isOutgoing}
                        onSelect={(emoji) => void handleReact(msg.id, emoji)}
                        onClose={() => setReactionPickerId(null)}
                      />
                    </div>
                  </div>
                )}
                <div className={showGroupChrome ? 'flex items-end gap-2 min-w-0' : 'min-w-0'}>
                  {showGroupChrome &&
                    (showAvatar ? (
                      <TelegramFanAvatar
                        name={msg.senderName || 'Fan'}
                        avatarUrl={msg.senderAvatarUrl}
                        size="cluster"
                      />
                    ) : (
                      <div className="w-7 shrink-0" aria-hidden />
                    ))}
                  <div
                    className={`min-w-0 flex flex-col ${
                      msg.isOutgoing ? 'items-end' : 'items-start'
                    }`}
                  >
                    {showName && (
                      <p
                        className={`text-[11px] font-medium truncate max-w-full px-1 mb-0.5 ${senderNameColor(
                          clusterKey
                        )}`}
                        title={nameHover}
                      >
                        {msg.senderName}
                      </p>
                    )}
                    <div
                      className={`${bubbleRadius} px-3 py-2 text-sm ${
                        msg.deleted
                          ? 'bg-gray-100 dark:bg-zinc-800/80 text-gray-500 dark:text-zinc-400 border border-dashed border-gray-300 dark:border-zinc-700'
                          : msg.isOutgoing
                            ? 'bg-sky-600 text-white'
                            : 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 border border-gray-100 dark:border-white/5'
                      }`}
                    >
                      {messageHasVisualMedia(msg) && (
                        <button
                          type="button"
                          onClick={() => setChatMediaPreview(msg)}
                          className="mb-2 relative block overflow-hidden rounded-lg"
                          aria-label={msg.kind === 'video' ? 'Play video' : 'Open image'}
                        >
                          <TelegramChatThumb
                            src={telegramChatMediaUrl(
                              creatorId,
                              peerId,
                              msg.id,
                              'thumb'
                            )}
                          />
                          {msg.kind === 'video' && (
                            <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                              <span className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center">
                                <Play className="w-5 h-5 ml-0.5 text-white" />
                              </span>
                            </span>
                          )}
                        </button>
                      )}
                      {messageHasPlayableAudio(msg) && (
                        <div className={msgText ? 'mb-2' : undefined}>
                          <TelegramAudioPlayer
                            src={telegramChatMediaUrl(
                              creatorId,
                              peerId,
                              msg.id,
                              'full'
                            )}
                            duration={msg.duration}
                            fileName={msg.kind === 'audio' ? msg.fileName : null}
                            variant={msg.isOutgoing ? 'outgoing' : 'incoming'}
                          />
                        </div>
                      )}
                      {(msgText ||
                        (!messageHasVisualMedia(msg) &&
                          !messageHasPlayableAudio(msg) &&
                          (msg.placeholder || '—'))) && (
                        <p className="whitespace-pre-wrap break-words">
                          {msgText ||
                            (messageHasVisualMedia(msg) || messageHasPlayableAudio(msg)
                              ? ''
                              : msg.placeholder || '—')}
                        </p>
                      )}
                      {historyEn && (
                        <p
                          className={`mt-1.5 pt-1.5 border-t text-[11px] italic flex items-start gap-1.5 ${
                            msg.deleted
                              ? 'border-gray-300 dark:border-zinc-700 text-gray-400'
                              : msg.isOutgoing
                                ? 'border-white/25 text-white/80'
                                : 'border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400'
                          }`}
                        >
                          {!msg.isOutgoing && (
                            <Languages className="w-3 h-3 shrink-0 mt-0.5" />
                          )}
                          <span className="whitespace-pre-wrap break-words">{historyEn}</span>
                        </p>
                      )}
                      <p
                        className={`text-[10px] mt-1 ${
                          msg.deleted
                            ? 'text-gray-400'
                            : msg.isOutgoing
                              ? 'text-white/70'
                              : 'text-gray-400'
                        }`}
                      >
                        {formatTime(msg.date, staffTimeZone)}
                      </p>
                    </div>
                    {!msg.deleted && (
                      <TelegramReactionChips
                        reactions={msg.reactions || []}
                        disabled={reactingMessageId === msg.id}
                        onToggle={(emoji) => void handleReact(msg.id, emoji)}
                      />
                    )}
                  </div>
                </div>
                {sentBy && !msg.deleted && (
                  <div className="mt-1 px-2.5 py-0.5 rounded-full bg-white/90 dark:bg-zinc-900/90 border border-gray-200 dark:border-zinc-800 text-[9px] font-medium text-gray-500 dark:text-zinc-400 shadow-sm">
                    Sent by {sentBy}
                  </div>
                )}
                {msg.deleted && unsentBy && (
                  <div className="mt-1 px-2.5 py-0.5 rounded-full bg-white/90 dark:bg-zinc-900/90 border border-gray-200 dark:border-zinc-800 text-[9px] font-medium text-gray-500 dark:text-zinc-400 shadow-sm">
                    Unsent by {unsentBy}
                  </div>
                )}
                {showManualTranslate && (
                  <button
                    type="button"
                    onClick={() => void translateMessage(msg.id, msgText)}
                    disabled={translatingThis}
                    className={`mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50 ${
                      showGroupChrome ? 'ml-9' : ''
                    }`}
                    title="Translate to English"
                  >
                    {translatingThis ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Languages className="w-3 h-3" />
                    )}
                    Translate
                  </button>
                )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 p-4 shrink-0 relative z-10 shadow-[0_-10px_40px_rgba(0,0,0,0.3)]">
        {vaultItems.length > 0 && (
          <div className="flex items-center gap-3 mb-3 px-1 animate-fade-in">
            <div className="flex gap-2 max-w-[50%] overflow-x-auto">
              {vaultItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setVaultItems((prev) => prev.filter((entry) => entry.id !== item.id))
                  }
                  className="w-12 h-12 rounded-lg relative group overflow-hidden border border-gray-300 dark:border-zinc-700 shrink-0"
                  title="Remove"
                >
                  {item.kind === 'voice' ? (
                    <TelegramVoiceTile duration={item.duration} />
                  ) : (
                    <img
                      src={telegramVaultMediaUrl(creatorId, item.id, 'thumb')}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  )}
                  <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/35 dark:bg-black/60 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-3 h-3" />
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setVaultItems([])}
              className="p-1 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white"
              aria-label="Clear attachment"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        {translatingOutgoing && (
          <p className="text-xs text-gray-500 dark:text-zinc-500 mb-2">
            Translating to German…
          </p>
        )}
        {skipOutgoingTranslate && !translatingOutgoing && (
          <p className="text-xs text-domx-600 dark:text-domx-400 mb-2">
            AI German — won’t re-translate
          </p>
        )}

        <QuickEmojiBar
          disabled={sending || translatingOutgoing}
          onInsert={(emoji) => setDraft((d) => d + emoji)}
          trailing={
            <div className="flex items-center gap-0.5">
              {canUseSuggestReply && (
                <SuggestReplyToolbarButton
                  disabled={sending || translatingOutgoing || messages.length === 0}
                  getMessages={getSuggestMessages}
                  getFanNotes={getSuggestFanNotes}
                  fanNickname={fan?.nickname || null}
                  onApply={applySuggestedReply}
                />
              )}
              <ScriptToolbarButton
                creatorId={creatorId}
                platform="telegram"
                fanId={fan?.telegramUserId || peerId}
                canManage={canManageScripts}
                disabled={sending || translatingOutgoing}
                onApply={applyScriptToComposer}
                onRequestVaultPick={openVaultForScript}
                pendingVaultMedia={pendingScriptVaultMedia}
                onPendingVaultMediaConsumed={() => setPendingScriptVaultMedia(null)}
                refreshKey={scriptsRefreshKey}
              />
            </div>
          }
        />

        <div className="flex items-end gap-2 bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-2xl p-2 focus-within:border-domx-500/50 focus-within:bg-white dark:focus-within:bg-zinc-900 transition-all shadow-inner">
          <button
            type="button"
            onClick={openVault}
            className="p-2 rounded-xl text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
            title="Open Media Vault"
            aria-label="Open vault"
          >
            <ImageIcon className="w-5 h-5" />
          </button>
          <textarea
            value={draft}
            disabled={sending || translatingOutgoing}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              if (!next.trim()) {
                setSkipOutgoingTranslate(false);
                setSuggestedEnglish(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder={
              skipOutgoingTranslate
                ? 'Edit German reply… (won’t re-translate)'
                : autoTranslateOutgoing
                  ? 'Type a message… (Auto-translates to German)'
                  : 'Type a message…'
            }
            className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent text-gray-900 dark:text-white focus:outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600 leading-relaxed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={
              sending ||
              translatingOutgoing ||
              (!draft.trim() && vaultItems.length === 0)
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
      {generateSessionOpen && (
        <TelegramSextingSessionModal
          groupPeerId={peerId}
          groupLabel={fanLabel(fan, isGroup ? 'Group' : 'Fan')}
          defaultFanName={fanLabel(fan, isGroup ? 'Group' : 'Fan')}
          defaultCreatorIds={creatorId ? [creatorId] : []}
          lockCreators={!isGroup}
          onClose={() => setGenerateSessionOpen(false)}
        />
      )}
      {vaultOpen && (
        <TelegramVaultModal
          creatorId={creatorId}
          fanId={fan?.telegramUserId || peerId}
          mode={vaultPickMode}
          selectedItems={vaultPickMode === 'script' ? [] : vaultItems}
          onChangeSelected={(items) => {
            if (vaultPickMode === 'script') {
              setPendingScriptVaultMedia(
                items.map((item) => telegramVaultItemToScriptMedia(creatorId, item))
              );
              setVaultOpen(false);
              setVaultPickMode('composer');
              return;
            }
            setVaultItems(items);
            setVaultOpen(false);
          }}
          onClose={() => {
            setVaultOpen(false);
            setVaultPickMode('composer');
          }}
        />
      )}
      {chatMediaPreview && (
        <VaultMediaLightbox
          url={telegramChatMediaUrl(
            creatorId,
            peerId,
            chatMediaPreview.id,
            'full'
          )}
          kind={chatMediaPreview.kind === 'video' ? 'video' : 'picture'}
          poster={telegramChatMediaUrl(
            creatorId,
            peerId,
            chatMediaPreview.id,
            'thumb'
          )}
          fallbackUrl={telegramChatMediaUrl(
            creatorId,
            peerId,
            chatMediaPreview.id,
            'thumb'
          )}
          onClose={() => setChatMediaPreview(null)}
        />
      )}
      </div>

      {fanPanelOpen && threadWide && (
        <TelegramFanPanel
          creatorId={creatorId}
          fan={fan}
          showUsername={showUsername}
          onFanUpdated={handleFanUpdated}
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
          <TelegramFanPanel
            creatorId={creatorId}
            fan={fan}
            showUsername={showUsername}
            onFanUpdated={handleFanUpdated}
            onClose={toggleFanPanel}
            className="absolute right-0 top-0 bottom-0 w-72 z-30 shadow-2xl animate-slide-up"
          />
        </>
      )}
    </div>
  );
}
