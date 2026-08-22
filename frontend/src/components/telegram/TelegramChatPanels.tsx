import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Send } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import {
  getTelegramDialogs,
  getTelegramMessages,
  patchTelegramFan,
  resolveTelegramUsername,
  sendTelegramMessage,
  type TelegramDialog,
  type TelegramFan,
  type TelegramMessage,
} from '@/lib/api';

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

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
        unreadCount: 0,
        lastMessage: null,
        displayName: result.fan.displayName,
        nickname: result.fan.nickname,
        notes: result.fan.notes,
        fan: result.fan,
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
          <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">No private chats yet.</p>
        )}
        {filtered.map((dialog) => {
          const active = selectedPeerId === dialog.peerId;
          const preview = dialog.lastMessage?.text || dialog.lastMessage?.placeholder || '';
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
                {preview || '—'}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TelegramChatThread({
  creatorId,
  peerId,
  initialFan,
  pollEnabled,
}: {
  creatorId: string;
  peerId: string;
  initialFan?: TelegramFan | null;
  pollEnabled: boolean;
}) {
  const { user } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const [fan, setFan] = useState<TelegramFan | null>(initialFan || null);
  const [messages, setMessages] = useState<TelegramMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState(initialFan?.nickname || '');
  const [savingNick, setSavingNick] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const showUsername = canSeeFanUsername(user?.role);

  const loadMessages = useCallback(async () => {
    const result = await getTelegramMessages(creatorId, peerId);
    setFan(result.fan);
    setNicknameDraft(result.fan.nickname || '');
    setMessages(result.messages || []);
  }, [creatorId, peerId]);

  useEffect(() => {
    setError(null);
    void loadMessages().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    });
  }, [loadMessages]);

  useEffect(() => {
    if (!pollEnabled) return;
    const timer = window.setInterval(() => {
      void loadMessages().catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadMessages, pollEnabled]);

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
    });
  }, [onSyncEvent, creatorId, peerId, loadMessages, pollEnabled]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendTelegramMessage(creatorId, peerId, text);
      setDraft('');
      if (result.message) {
        setMessages((prev) => [...prev, result.message]);
      } else {
        await loadMessages();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  async function handleSaveNickname() {
    setSavingNick(true);
    try {
      const result = await patchTelegramFan(creatorId, peerId, {
        nickname: nicknameDraft.trim(),
      });
      setFan(result.fan);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save nickname');
    } finally {
      setSavingNick(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 chatter-thread-bg relative">
      <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 bg-white/90 dark:bg-zinc-950/90">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            {fanLabel(fan)}
          </p>
          {showUsername && fan?.username && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">@{fan.username}</p>
          )}
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
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                msg.isOutgoing
                  ? 'bg-sky-600 text-white'
                  : 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 border border-gray-100 dark:border-white/5'
              }`}
            >
              <p className="whitespace-pre-wrap break-words">
                {msg.text || msg.placeholder || '—'}
              </p>
              <p
                className={`text-[10px] mt-1 ${
                  msg.isOutgoing ? 'text-white/70' : 'text-gray-400'
                }`}
              >
                {formatTime(msg.date)}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t border-gray-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-950/90">
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
            placeholder="Write a message…"
            className="flex-1 px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] resize-none"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !draft.trim()}
            className="h-10 w-10 rounded-xl bg-sky-600 text-white flex items-center justify-center disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
