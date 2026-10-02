import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import { useLocation } from 'react-router-dom';
import fanslyIcon from '@/assets/fansly.svg';
import {
  listFanslyChats,
  listFanslyMessages,
  sendFanslyMessage,
  type FanslyChat,
  type FanslyMessage,
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

  async function handleSend() {
    if (!selectedCreatorId || !selectedGroupId || !draft.trim() || sending) return;
    setSending(true);
    setThreadError(null);
    try {
      const result = await sendFanslyMessage(selectedCreatorId, selectedGroupId, draft.trim());
      setDraft('');
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

  const orderedMessages = [...messages].reverse();

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
            {chats.map((chat) => (
              <button
                key={chat.groupId}
                type="button"
                onClick={() => setSelectedGroupId(chat.groupId)}
                className={`w-full px-4 py-3 text-left border-b border-gray-100 dark:border-white/5 ${
                  chat.groupId === selectedGroupId
                    ? 'bg-white dark:bg-white/10'
                    : 'hover:bg-white/70 dark:hover:bg-white/5'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{chat.partnerUsername}</span>
                  {chat.unreadCount > 0 && (
                    <span className="text-[10px] font-semibold bg-sky-500 text-white rounded-full px-1.5">
                      {chat.unreadCount}
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-gray-500 mt-0.5">
                  {chat.lastMessage?.content || 'Open conversation'}
                </span>
              </button>
            ))}
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
              <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10">
                <p className="font-medium text-sm">{selectedChat.partnerUsername}</p>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
                {threadLoading && (
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading messages…
                  </p>
                )}
                {threadError && <p className="text-sm text-red-500">{threadError}</p>}
                {orderedMessages.map((message) => {
                  const mine = selfId && message.senderId === selfId;
                  return (
                    <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                          mine
                            ? 'bg-sky-500 text-white'
                            : 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{message.content || 'Attachment'}</p>
                        <p className={`text-[10px] mt-1 ${mine ? 'text-white/80' : 'text-gray-500'}`}>
                          {formatTime(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <form
                className="p-3 border-t border-gray-200 dark:border-white/10 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSend();
                }}
              >
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  rows={2}
                  placeholder="Write a message"
                  className="flex-1 resize-none px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="self-end px-3 py-2 rounded-lg bg-sky-500 text-white disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
