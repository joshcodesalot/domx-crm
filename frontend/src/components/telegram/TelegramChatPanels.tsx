import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Loader2, Search, Send, Trash2, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useStaffTimeZone } from '@/lib/berlinTime';
import {
  TRANSLATION_SETTINGS_EVENT,
} from '@/components/fourbased/FourBasedChatPanels';
import {
  createHistoryTranslateQueue,
  type HistoryTranslateQueue,
} from '@/lib/historyTranslateQueue';
import {
  createMessagingDashboardEntry,
  deleteTelegramMessage,
  getMessageUnsends,
  getMessagingDashboardSenders,
  getTelegramDialogs,
  getTelegramMessages,
  patchTelegramFan,
  resolveCreatorAvatarUrl,
  resolveTelegramUsername,
  sendTelegramMessage,
  translateToGerman,
  type Creator,
  type MessageUnsendRecord,
  type TelegramDialog,
  type TelegramFan,
  type TelegramMessage,
  type TranslateHistoryItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const MAX_TRANSLATION_HISTORY = 8;

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
  size?: 'xs' | 'sm' | 'md';
}) {
  const [failed, setFailed] = useState(false);
  const dim = size === 'xs' ? 'w-5 h-5' : size === 'sm' ? 'w-9 h-9' : 'w-10 h-10';
  const src = resolveCreatorAvatarUrl(avatarUrl);
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const initialClass = size === 'xs' ? 'text-[10px]' : 'text-sm';
  if (src && !failed) {
    return (
      <img
        src={src}
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

export function TelegramChatList({
  creatorId,
  selectedPeerId,
  onSelectDialog,
  pollEnabled,
  onRefreshExtra,
}: {
  creatorId: string;
  selectedPeerId: string | null;
  onSelectDialog: (dialog: TelegramDialog) => void;
  pollEnabled: boolean;
  onRefreshExtra?: () => void;
}) {
  const { user } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [loading, setLoading] = useState(true);
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
      <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">Chats</span>
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
          return (
            <button
              key={dialog.peerId}
              type="button"
              onClick={() => onSelectDialog(dialog)}
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
                    {dialog.unreadCount > 0 && (
                      <span className="text-[10px] font-semibold bg-sky-600 text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                        {dialog.unreadCount}
                      </span>
                    )}
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
}: {
  creatorId: string;
  creator?: Creator | null;
  peerId: string;
  initialFan?: TelegramFan | null;
  pollEnabled: boolean;
  onClose?: () => void;
}) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { onSyncEvent } = useStaffSync();
  const staffTimeZone = useStaffTimeZone();
  const [fan, setFan] = useState<TelegramFan | null>(initialFan || null);
  const [messages, setMessages] = useState<TelegramMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState(initialFan?.nickname || '');
  const [savingNick, setSavingNick] = useState(false);
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
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const threadKeyRef = useRef(`${creatorId}:${peerId}`);
  threadKeyRef.current = `${creatorId}:${peerId}`;
  const historyTranslateQueueRef = useRef<HistoryTranslateQueue | null>(null);
  const historyTranslationsRef = useRef(historyTranslations);
  historyTranslationsRef.current = historyTranslations;
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
  }, [creatorId, peerId]);

  const loadMessages = useCallback(async () => {
    const [result, unsendResult] = await Promise.all([
      getTelegramMessages(creatorId, peerId),
      getMessageUnsends({
        creatorId,
        chatId: peerId,
        platform: 'telegram',
        limit: 200,
      }).catch(() => ({ unsends: {} as Record<string, MessageUnsendRecord> })),
    ]);
    const unsends = unsendResult.unsends || {};
    setFan({ ...result.fan, kind: result.kind || result.fan.kind || 'dm' });
    setNicknameDraft(result.fan.nickname || '');
    setMessageUnsends(unsends);
    setMessages(mergeUnsendTombstones(result.messages || [], unsends, peerId));
  }, [creatorId, peerId]);

  const loadSenders = useCallback(async () => {
    try {
      const result = await getMessagingDashboardSenders({
        creatorId,
        chatId: peerId,
        limit: 200,
      });
      if (threadKeyRef.current !== `${creatorId}:${peerId}`) return;
      setMessageSenders(result.senders || {});
    } catch {
      // best-effort
    }
  }, [creatorId, peerId]);

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
      void loadMessages().catch(() => undefined);
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
      void loadMessages().catch(() => undefined);
      void loadSenders();
    });
  }, [onSyncEvent, creatorId, peerId, loadMessages, loadSenders, pollEnabled]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, historyTranslations]);

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
    if (!text || sending || translatingOutgoing) return;
    setSending(true);
    setError(null);
    const englishDraft = text;
    try {
      let messageToSend = text;
      if (autoTranslateOutgoing) {
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
        englishDraft
      );
      setDraft('');
      if (result.message) {
        setMessages((prev) => [...prev, result.message]);
      } else {
        await loadMessages();
      }

      if (user?.id && result.message) {
        const dashboardMessageId = `telegram:${result.message.id}`;
        const chatterName = user.name;
        setMessageSenders((prev) => ({
          ...prev,
          [dashboardMessageId]: chatterName,
        }));
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
          contentType: 'text',
          englishMessage: englishDraft,
          germanTranslatedMessage: messageToSend,
          actualSentText: messageToSend,
          sentAt: result.message.date || new Date().toISOString(),
        }).catch(() => {
          // Persistence failures are non-blocking for the chatter UI.
        });
      }
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

  async function handleSaveNickname() {
    setSavingNick(true);
    try {
      const result = await patchTelegramFan(creatorId, peerId, {
        nickname: nicknameDraft.trim(),
      });
      setFan((prev) => ({ ...result.fan, kind: prev?.kind || result.fan.kind }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save nickname');
    } finally {
      setSavingNick(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 chatter-thread-bg relative">
      <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95 z-0 pointer-events-none" />
      <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 bg-white/80 dark:bg-zinc-950/80 relative z-10">
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
          <input
            value={nicknameDraft}
            onChange={(e) => setNicknameDraft(e.target.value)}
            placeholder="Nickname"
            className="w-32 px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a]"
          />
          <button
            type="button"
            onClick={() => void handleSaveNickname()}
            disabled={savingNick}
            className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-white/10 disabled:opacity-50"
          >
            Save
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

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 relative z-10">
        {messages.map((msg) => {
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
          return (
            <div
              key={msg.id}
              className={`group/msg flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[75%] flex flex-col ${msg.isOutgoing ? 'items-end' : 'items-start'}`}>
                {canUnsend && (
                  <div className={`mb-1 flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMessage(msg.id)}
                      disabled={deleting}
                      className="opacity-0 group-hover/msg:opacity-100 focus:opacity-100 p-1 rounded-md text-gray-500 dark:text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                      title="Unsend message"
                      aria-label="Unsend message"
                    >
                      {deleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                )}
                {isGroup && !msg.isOutgoing && (
                  <div className="flex items-center gap-1.5 mb-0.5 px-1">
                    <TelegramFanAvatar
                      name={msg.senderName || 'Fan'}
                      avatarUrl={msg.senderAvatarUrl}
                      size="xs"
                    />
                    {msg.senderName && (
                      <p className="text-[11px] text-gray-500 dark:text-zinc-500 truncate">
                        {msg.senderName}
                        {showUsername && msg.senderUsername ? ` @${msg.senderUsername}` : ''}
                      </p>
                    )}
                  </div>
                )}
                <div
                  className={`rounded-2xl px-3 py-2 text-sm ${
                    msg.deleted
                      ? 'bg-gray-100 dark:bg-zinc-800/80 text-gray-500 dark:text-zinc-400 border border-dashed border-gray-300 dark:border-zinc-700'
                      : msg.isOutgoing
                        ? 'bg-sky-600 text-white'
                        : 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 border border-gray-100 dark:border-white/5'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">
                    {msgText || msg.placeholder || '—'}
                  </p>
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
                {historyEn && (
                  <div
                    className={`mt-1.5 rounded-xl px-3 py-2 text-[11px] italic shadow-sm w-fit max-w-full flex items-center gap-1.5 ${
                      msg.isOutgoing
                        ? 'bg-gray-100/60 dark:bg-zinc-800/60 border border-gray-200 dark:border-zinc-700/50 text-gray-700 dark:text-zinc-300'
                        : 'bg-white/80 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400'
                    }`}
                  >
                    {!msg.isOutgoing && (
                      <Languages className="w-3 h-3 text-gray-500 dark:text-zinc-500 shrink-0" />
                    )}
                    <span className="whitespace-pre-wrap break-words">{historyEn}</span>
                  </div>
                )}
                {showManualTranslate && (
                  <button
                    type="button"
                    onClick={() => void translateMessage(msg.id, msgText)}
                    disabled={translatingThis}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
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
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t border-gray-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-950/90 relative z-10">
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <div className="flex items-end gap-2">
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
            placeholder={
              translatingOutgoing
                ? 'Translating…'
                : autoTranslateOutgoing
                  ? 'Type a message… (Auto-translates to German)'
                  : 'Write a message…'
            }
            className="flex-1 px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] resize-none"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || translatingOutgoing || !draft.trim()}
            className="h-10 w-10 rounded-xl bg-sky-600 text-white flex items-center justify-center disabled:opacity-40"
          >
            {translatingOutgoing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
