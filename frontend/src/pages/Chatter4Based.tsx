import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Bell, MessageSquare } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import {
  FourBasedChatList,
  FourBasedChatThread,
  FourBasedTranslationToggles,
  UnreadBadge,
} from '@/components/fourbased/FourBasedChatPanels';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import fourBasedIcon from '@/assets/4based_icon.ico';
import {
  getFourBasedChat,
  getFourBasedChatByUser,
  type FourBasedChat,
} from '@/lib/api';

function isRealFourBasedChatId(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  return /^[a-f0-9]{24}$/i.test(chatId);
}

export default function Chatter4Based() {
  const location = useLocation();
  const pollEnabled = usePollEnabled(location.pathname === '/chatter/4based');
  const {
    creators,
    creatorsLoading,
    creatorsError,
    badgesByCreatorId,
    refreshBadges,
  } = useCreatorLive({
    platform: '4based',
    wantBadges: true,
    pollEnabled,
  });
  const { onSyncEvent } = useStaffSync();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkCreatorId = searchParams.get('creatorId') || '';
  const deepLinkFanId = searchParams.get('fanId') || '';
  const deepLinkChatId = searchParams.get('chatId') || '';
  const appliedCreatorDeepLinkRef = useRef(false);
  const consumedDeepLinkRef = useRef<string | null>(null);
  const userPickedChatRef = useRef(false);
  const selectedChatIdRef = useRef<string | null>(null);
  const [pendingChatId, setPendingChatId] = useState(
    () => searchParams.get('chatId') || ''
  );
  const [pendingFanId, setPendingFanId] = useState(
    () => searchParams.get('fanId') || ''
  );

  const [openChatError, setOpenChatError] = useState<string | null>(null);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<FourBasedChat | null>(null);
  selectedChatIdRef.current = selectedChatId;

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((c) => c.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const consumeChatDeepLink = useCallback(() => {
    const key = `${pendingChatId}|${pendingFanId}`;
    if (key !== '|') consumedDeepLinkRef.current = key;
    setPendingChatId('');
    setPendingFanId('');
    if (!searchParams.get('chatId') && !searchParams.get('fanId')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('chatId');
    next.delete('fanId');
    setSearchParams(next, { replace: true });
  }, [pendingChatId, pendingFanId, searchParams, setSearchParams]);

  useEffect(() => {
    if (
      deepLinkCreatorId &&
      creators.some((creator) => creator.id === deepLinkCreatorId)
    ) {
      if (deepLinkChatId || deepLinkFanId || !appliedCreatorDeepLinkRef.current) {
        appliedCreatorDeepLinkRef.current = true;
        setSelectedCreatorId(deepLinkCreatorId);
      }
    }
    const incomingKey = `${deepLinkChatId}|${deepLinkFanId}`;
    if (
      (deepLinkChatId || deepLinkFanId) &&
      consumedDeepLinkRef.current !== incomingKey
    ) {
      setPendingChatId(deepLinkChatId);
      setPendingFanId(deepLinkFanId);
    }
  }, [creators, deepLinkCreatorId, deepLinkChatId, deepLinkFanId]);

  useEffect(() => {
    userPickedChatRef.current = false;
    setSelectedChatId(null);
    setSelectedChat(null);
    setOpenChatError(null);
  }, [selectedCreatorId]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    const realChatId = isRealFourBasedChatId(pendingChatId) ? pendingChatId : '';
    if (!realChatId && !pendingFanId) return;

    let cancelled = false;
    setOpenChatError(null);

    const open = async () => {
      try {
        const result = realChatId
          ? await getFourBasedChat(selectedCreatorId, realChatId)
          : await getFourBasedChatByUser(selectedCreatorId, pendingFanId);
        if (cancelled) return;
        if (!result.chat?._id) {
          if (!realChatId) setOpenChatError('Could not open this fan chat.');
          consumeChatDeepLink();
          return;
        }
        if (
          userPickedChatRef.current &&
          selectedChatIdRef.current !== result.chat._id
        ) {
          consumeChatDeepLink();
          return;
        }
        setSelectedChatId(result.chat._id);
        setSelectedChat(result.chat);
        consumeChatDeepLink();
      } catch (err) {
        if (cancelled) return;
        consumeChatDeepLink();
        setOpenChatError(
          err instanceof Error ? err.message : 'Could not open this fan chat.'
        );
      }
    };

    void open();
    return () => {
      cancelled = true;
    };
  }, [selectedCreatorId, pendingChatId, pendingFanId, consumeChatDeepLink]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== '4based:event') return;
      if (!pollEnabled) return;
      if (!selectedCreatorId || event.creatorId !== selectedCreatorId) return;
      void refreshBadges([selectedCreatorId]);
    });
  }, [onSyncEvent, selectedCreatorId, pollEnabled, refreshBadges]);

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
              const unread = badgesByCreatorId[creator.id] || {
                messages: 0,
                notifications: 0,
              };
              const active = selectedCreatorId === creator.id;
              return (
                <button
                  key={creator.id}
                  type="button"
                  onClick={() => {
                    if (creator.id !== selectedCreatorId) consumeChatDeepLink();
                    setSelectedCreatorId(creator.id);
                  }}
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
                userPickedChatRef.current = true;
                setSelectedChatId(chat._id);
                setSelectedChat(chat);
                consumeChatDeepLink();
              }}
              pollEnabled={pollEnabled}
              onRefreshExtra={() => {
                void refreshBadges([selectedCreatorId]);
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
            key={`${selectedCreator.id}:${selectedChatId}`}
            creator={selectedCreator}
            chatId={selectedChatId}
            initialChat={selectedChat}
            pollEnabled={pollEnabled}
            onClose={() => {
              setSelectedChatId(null);
              setSelectedChat(null);
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-zinc-500 chatter-thread-bg relative">
            <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95" />
            <span className="relative z-10">
              {openChatError || 'Select a creator chat to start'}
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
