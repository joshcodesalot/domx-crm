import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bell, Home, MessageSquare, X } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import GermanTimeClock from '@/components/GermanTimeClock';
import ThemeToggle from '@/components/ThemeToggle';
import {
  FourBasedChatList,
  FourBasedChatThread,
  FourBasedTranslationToggles,
  UnreadBadge,
  partnerName,
} from '@/components/fourbased/FourBasedChatPanels';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import { type Creator, type FourBasedChat } from '@/lib/api';

const HOME_TAB_ID = 'home';

interface FanTab {
  chatId: string;
  displayName: string;
  avatarUrl: string | null;
  chat?: FourBasedChat | null;
}

interface CreatorWorkspace {
  creator: Creator;
  fanTabs: FanTab[];
  activeTabId: string;
}

function isOpenableCreator(creator: Creator): boolean {
  return creator.platform === '4based' && Boolean(creator.accountId || creator.id);
}

export default function MessagePro4Based() {
  const location = useLocation();
  const pagePollEnabled = usePollEnabled(location.pathname === '/message-pro/4based');
  const {
    creators,
    creatorsLoading: loading,
    creatorsError: error,
    badgesByCreatorId,
    refreshBadges,
  } = useCreatorLive({
    platform: '4based',
    wantBadges: true,
    pollEnabled: pagePollEnabled,
  });
  const [workspaces, setWorkspaces] = useState<CreatorWorkspace[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [mountedHomeIds, setMountedHomeIds] = useState<string[]>([]);

  const openableCreators = useMemo(
    () => creators.filter(isOpenableCreator),
    [creators]
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.creator.id === activeAccountId) || null,
    [workspaces, activeAccountId]
  );

  useEffect(() => {
    setWorkspaces((prev) => {
      const prevById = new Map(prev.map((w) => [w.creator.id, w]));
      return openableCreators.map((creator) => {
        const existing = prevById.get(creator.id);
        if (existing) {
          return { ...existing, creator };
        }
        return {
          creator,
          fanTabs: [],
          activeTabId: HOME_TAB_ID,
        };
      });
    });

    setActiveAccountId((prev) => {
      if (prev && openableCreators.some((c) => c.id === prev)) {
        return prev;
      }
      return openableCreators[0]?.id || null;
    });
  }, [openableCreators]);

  useEffect(() => {
    const openableIds = new Set(openableCreators.map((c) => c.id));
    setMountedHomeIds((prev) => prev.filter((id) => openableIds.has(id)));
  }, [openableCreators]);

  useEffect(() => {
    if (!activeAccountId || !activeWorkspace) return;
    if (activeWorkspace.activeTabId !== HOME_TAB_ID) return;
    setMountedHomeIds((prev) =>
      prev.includes(activeAccountId) ? prev : [...prev, activeAccountId]
    );
  }, [activeAccountId, activeWorkspace]);

  const openFanTab = useCallback((creatorId: string, chat: FourBasedChat) => {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.creator.id !== creatorId) return workspace;
        const exists = workspace.fanTabs.some((tab) => tab.chatId === chat._id);
        const fanTabs = exists
          ? workspace.fanTabs
          : [
              ...workspace.fanTabs,
              {
                chatId: chat._id,
                displayName: partnerName(chat),
                avatarUrl: null,
                chat,
              },
            ];
        return {
          ...workspace,
          fanTabs,
          activeTabId: chat._id,
        };
      })
    );
    setActiveAccountId(creatorId);
  }, []);

  const closeFanTab = useCallback((creatorId: string, chatId: string) => {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.creator.id !== creatorId) return workspace;
        const fanTabs = workspace.fanTabs.filter((tab) => tab.chatId !== chatId);
        const activeTabId =
          workspace.activeTabId === chatId ? HOME_TAB_ID : workspace.activeTabId;
        return { ...workspace, fanTabs, activeTabId };
      })
    );
  }, []);

  const setActiveTab = useCallback((creatorId: string, tabId: string) => {
    setWorkspaces((prev) =>
      prev.map((workspace) =>
        workspace.creator.id === creatorId
          ? { ...workspace, activeTabId: tabId }
          : workspace
      )
    );
  }, []);

  const activeFanTab = useMemo(() => {
    if (!activeWorkspace || activeWorkspace.activeTabId === HOME_TAB_ID) return null;
    return (
      activeWorkspace.fanTabs.find(
        (tab) => tab.chatId === activeWorkspace.activeTabId
      ) || null
    );
  }, [activeWorkspace]);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100">
      <header className="h-12 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-2 px-3">
        <span className="text-sm font-semibold mr-2">Message Pro</span>
        <div className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0">
          {workspaces.map((workspace) => {
            const creatorId = workspace.creator.id;
            const active = creatorId === activeAccountId;
            const unread = badgesByCreatorId[creatorId] || {
              messages: 0,
              notifications: 0,
            };
            return (
              <button
                key={creatorId}
                type="button"
                onClick={() => setActiveAccountId(creatorId)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border shrink-0 min-w-0 ${
                  active
                    ? 'border-4based-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'
                    : 'border-gray-200 dark:border-white/10'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={workspace.creator.avatarUrl}
                  displayName={workspace.creator.displayName}
                  className="w-6 h-6 rounded-full object-cover"
                  initialsClassName="w-6 h-6 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-[10px] font-medium"
                />
                <span className="text-xs font-medium truncate max-w-[100px]">
                  {workspace.creator.displayName}
                </span>
                <span className="inline-flex items-center gap-1.5 shrink-0">
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
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <GermanTimeClock />
          <FourBasedTranslationToggles compact />
          <ThemeToggle />
        </div>
      </header>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 px-4 py-2 border-b border-gray-200 dark:border-white/10">
          {error}
        </p>
      )}

      {!activeWorkspace ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          {loading ? 'Loading…' : 'No 4based creators assigned to you'}
        </div>
      ) : (
        <>
          <div className="h-10 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-1 px-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab(activeWorkspace.creator.id, HOME_TAB_ID)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs shrink-0 ${
                activeWorkspace.activeTabId === HOME_TAB_ID
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'
              }`}
            >
              <Home className="w-3.5 h-3.5" />
              Home
            </button>
            {activeWorkspace.fanTabs.map((tab) => {
              const active = activeWorkspace.activeTabId === tab.chatId;
              return (
                <div
                  key={tab.chatId}
                  className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md text-xs shrink-0 ${
                    active
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setActiveTab(activeWorkspace.creator.id, tab.chatId)
                    }
                    className="truncate max-w-[120px]"
                  >
                    {tab.displayName}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      closeFanTab(activeWorkspace.creator.id, tab.chatId)
                    }
                    className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex-1 min-h-0 overflow-hidden relative">
            {mountedHomeIds.map((creatorId) => {
              const workspace = workspaces.find((w) => w.creator.id === creatorId);
              if (!workspace) return null;
              const isActiveHome =
                creatorId === activeAccountId &&
                workspace.activeTabId === HOME_TAB_ID;
              return (
                <div
                  key={creatorId}
                  className={isActiveHome ? 'h-full' : undefined}
                  aria-hidden={!isActiveHome}
                  style={isActiveHome ? undefined : { display: 'none' }}
                >
                  <FourBasedChatList
                    creatorId={creatorId}
                    pollEnabled={pagePollEnabled && isActiveHome}
                    messagesUnread={
                      badgesByCreatorId[creatorId]?.messages || 0
                    }
                    onSelectChat={(chat) => openFanTab(creatorId, chat)}
                    openActionLabel="Open tab"
                    onRefreshExtra={() => {
                      void refreshBadges([creatorId]);
                    }}
                  />
                </div>
              );
            })}
            {activeFanTab ? (
              <div className="h-full min-h-0 overflow-hidden flex">
                <FourBasedChatThread
                  key={`${activeWorkspace.creator.id}:${activeFanTab.chatId}`}
                  creator={activeWorkspace.creator}
                  chatId={activeFanTab.chatId}
                  initialChat={activeFanTab.chat || null}
                  pollEnabled={pagePollEnabled}
                  onClose={() =>
                    closeFanTab(activeWorkspace.creator.id, activeFanTab.chatId)
                  }
                />
              </div>
            ) : activeWorkspace.activeTabId !== HOME_TAB_ID ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                Tab not found
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
