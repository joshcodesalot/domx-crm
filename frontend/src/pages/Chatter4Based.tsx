import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, MessageSquare } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import {
  FourBasedChatList,
  FourBasedChatThread,
  FourBasedTranslationToggles,
  UnreadBadge,
} from '@/components/fourbased/FourBasedChatPanels';
import { useStaffSync } from '@/context/StaffSyncContext';
import fourBasedIcon from '@/assets/4based_icon.ico';
import {
  getCreators,
  getFourBasedBadges,
  type Creator,
  type FourBasedChat,
} from '@/lib/api';

const BADGE_POLL_INTERVAL_MS = 30_000;
const CREATOR_POLL_INTERVAL_MS = 15_000;

type CreatorUnreadCounts = { messages: number; notifications: number };

export default function Chatter4Based() {
  const { onSyncEvent } = useStaffSync();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [creatorsError, setCreatorsError] = useState<string | null>(null);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [badgeCountsByCreatorId, setBadgeCountsByCreatorId] = useState<
    Record<string, CreatorUnreadCounts>
  >({});

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<FourBasedChat | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const loadCreators = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fourBased = list.filter((c) => c.platform === '4based');
      setCreators(fourBased);
      setCreatorsError(null);
      setSelectedCreatorId((prev) => {
        if (prev && fourBased.some((c) => c.id === prev)) return prev;
        return fourBased[0]?.id || null;
      });
      setBadgeCountsByCreatorId((prev) => {
        const next: Record<string, CreatorUnreadCounts> = {};
        for (const creator of fourBased) {
          if (prev[creator.id]) next[creator.id] = prev[creator.id];
        }
        return next;
      });
    } catch (err) {
      if (!silent) {
        setCreatorsError(
          err instanceof Error ? err.message : 'Failed to load creators'
        );
        setCreators([]);
        setSelectedCreatorId(null);
      }
    } finally {
      if (!silent) setCreatorsLoading(false);
    }
  }, []);

  const refreshCreatorBadges = useCallback(async (creatorIds: string[]) => {
    if (creatorIds.length === 0) return;
    // Serialize to avoid burning concurrent ISP proxy sessions.
    const updates: Record<string, CreatorUnreadCounts> = {};
    for (const creatorId of creatorIds) {
      try {
        const badges = await getFourBasedBadges(creatorId);
        updates[creatorId] = {
          messages: Number(badges.messages) || 0,
          notifications: Number(badges.notifications) || 0,
        };
      } catch {
        // Best-effort; leave previous counts for this creator
      }
    }
    if (Object.keys(updates).length === 0) return;
    setBadgeCountsByCreatorId((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadCreators({ silent: true });
    }, CREATOR_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadCreators]);

  useEffect(() => {
    if (creators.length === 0) return;
    const creatorIds = creators.map((c) => c.id);
    void refreshCreatorBadges(creatorIds);
    const timer = window.setInterval(() => {
      void refreshCreatorBadges(creatorIds);
    }, BADGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [creators, refreshCreatorBadges]);

  useEffect(() => {
    setSelectedChatId(null);
    setSelectedChat(null);
  }, [selectedCreatorId]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (
        event.type === 'creator:access-granted' ||
        event.type === 'creator:access-revoked'
      ) {
        void loadCreators({ silent: true });
        return;
      }
      if (event.type !== '4based:event') return;
      if (!selectedCreatorId || event.creatorId !== selectedCreatorId) return;
      void refreshCreatorBadges([selectedCreatorId]);
    });
  }, [onSyncEvent, selectedCreatorId, loadCreators, refreshCreatorBadges]);

  return (
    <div className="bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 h-screen flex antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <main className="flex-1 flex min-w-0 overflow-hidden">
        {/* Creators column */}
        <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50 glass-panel">
          <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
            <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
            <span className="text-sm font-semibold text-gray-900 dark:text-white">
              4based
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 animate-fade-in">
            {creatorsLoading && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
                Loading creators…
              </p>
            )}
            {creatorsError && (
              <p className="text-xs text-red-400 p-3">{creatorsError}</p>
            )}
            {!creatorsLoading && !creatorsError && creators.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
                No 4based creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => {
              const unread = badgeCountsByCreatorId[creator.id] || {
                messages: 0,
                notifications: 0,
              };
              const active = selectedCreatorId === creator.id;
              return (
                <button
                  key={creator.id}
                  type="button"
                  onClick={() => setSelectedCreatorId(creator.id)}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
                    active
                      ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50 hover:bg-gray-100 dark:hover:bg-zinc-800'
                      : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                  }`}
                >
                  <CreatorAvatar
                    avatarUrl={creator.avatarUrl}
                    displayName={creator.displayName}
                    className="w-10 h-10 rounded-full object-cover shadow-md shrink-0"
                    initialsClassName="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-sm font-bold text-white shadow-md"
                  />
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
                        count={unread.messages}
                        label="Unread messages"
                      />
                      <UnreadBadge
                        icon={Bell}
                        count={unread.notifications}
                        label="Unread notifications"
                      />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-4 bg-white/80 dark:bg-zinc-950/80">
            <FourBasedTranslationToggles />
          </div>
        </aside>

        {/* Conversations */}
        <aside className="w-80 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-[#F7F8FA] dark:bg-[#0a0a0c] glass-panel">
          {selectedCreatorId ? (
            <FourBasedChatList
              creatorId={selectedCreatorId}
              creatorName={selectedCreator?.displayName}
              selectedChatId={selectedChatId}
              onSelectChat={(chat) => {
                setSelectedChatId(chat._id);
                setSelectedChat(chat);
              }}
              onRefreshExtra={() => {
                void refreshCreatorBadges([selectedCreatorId]);
              }}
            />
          ) : (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">
              Select a creator
            </p>
          )}
        </aside>

        {/* Thread */}
        {selectedCreator && selectedChatId ? (
          <FourBasedChatThread
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
