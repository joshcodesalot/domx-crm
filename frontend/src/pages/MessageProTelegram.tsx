import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bell, Home, MessageSquare, X } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import GermanTimeClock from '@/components/GermanTimeClock';
import ThemeToggle from '@/components/ThemeToggle';
import {
  FourBasedTranslationToggles,
  UnreadBadge,
} from '@/components/fourbased/FourBasedChatPanels';
import {
  TelegramChatList,
  TelegramChatThread,
} from '@/components/telegram/TelegramChatPanels';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import { type Creator, type TelegramDialog, type TelegramFan } from '@/lib/api';

const HOME_TAB_ID = 'home';

interface FanTab {
  peerId: string;
  displayName: string;
  fan?: TelegramFan | null;
}

interface CreatorWorkspace {
  creator: Creator;
  fanTabs: FanTab[];
  activeTabId: string;
}

function isOpenableCreator(creator: Creator): boolean {
  return creator.platform === 'telegram' && Boolean(creator.id);
}

function dialogLabel(dialog: TelegramDialog): string {
  return (
    dialog.fan?.nickname?.trim() ||
    dialog.displayName?.trim() ||
    dialog.title?.trim() ||
    'Chat'
  );
}

export default function MessageProTelegram() {
  const location = useLocation();
  const pagePollEnabled = usePollEnabled(location.pathname === '/message-pro/telegram');
  const {
    creators,
    creatorsLoading: loading,
    creatorsError: error,
    badgesByCreatorId,
    refreshBadges,
  } = useCreatorLive({
    platform: 'telegram',
    wantBadges: true,
    pollEnabled: pagePollEnabled,
  });
  const [workspaces, setWorkspaces] = useState<CreatorWorkspace[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [mountedHomeIds, setMountedHomeIds] = useState<string[]>([]);
  const [clearedPeerId, setClearedPeerId] = useState<string | null>(null);
  const [clearedCreatorId, setClearedCreatorId] = useState<string | null>(null);
  const [clearedReadNonce, setClearedReadNonce] = useState(0);

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

  const openFanTab = useCallback((creatorId: string, dialog: TelegramDialog) => {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.creator.id !== creatorId) return workspace;
        const exists = workspace.fanTabs.some((tab) => tab.peerId === dialog.peerId);
        const fanTabs = exists
          ? workspace.fanTabs
          : [
              ...workspace.fanTabs,
              {
                peerId: dialog.peerId,
                displayName: dialogLabel(dialog),
                fan: dialog.fan || null,
              },
            ];
        return {
          ...workspace,
          fanTabs,
          activeTabId: dialog.peerId,
        };
      })
    );
    setActiveAccountId(creatorId);
  }, []);

  const closeFanTab = useCallback((creatorId: string, peerId: string) => {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.creator.id !== creatorId) return workspace;
        const fanTabs = workspace.fanTabs.filter((tab) => tab.peerId !== peerId);
        const activeTabId =
          workspace.activeTabId === peerId ? HOME_TAB_ID : workspace.activeTabId;
        return { ...workspace, fanTabs, activeTabId };
      })
    );
  }, []);

  const handleMarkedRead = useCallback((creatorId: string, peerId: string) => {
    setClearedCreatorId(creatorId);
    setClearedPeerId(peerId);
    setClearedReadNonce((n) => n + 1);
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
        (tab) => tab.peerId === activeWorkspace.activeTabId
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
                    ? 'border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-900/20'
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
                    accentClass="text-sky-500"
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
          {loading ? 'Loading…' : 'No Telegram creators assigned to you'}
        </div>
      ) : (
        <>
          <div className="h-10 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-1 px-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab(activeWorkspace.creator.id, HOME_TAB_ID)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs shrink-0 ${
                activeWorkspace.activeTabId === HOME_TAB_ID
                  ? 'bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'
              }`}
            >
              <Home className="w-3.5 h-3.5" />
              Home
            </button>
            {activeWorkspace.fanTabs.map((tab) => {
              const active = activeWorkspace.activeTabId === tab.peerId;
              return (
                <div
                  key={tab.peerId}
                  className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md text-xs shrink-0 ${
                    active
                      ? 'bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300'
                      : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setActiveTab(activeWorkspace.creator.id, tab.peerId)
                    }
                    className="truncate max-w-[120px]"
                  >
                    {tab.displayName}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      closeFanTab(activeWorkspace.creator.id, tab.peerId)
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
                  <TelegramChatList
                    creatorId={creatorId}
                    selectedPeerId={null}
                    pollEnabled={pagePollEnabled && isActiveHome}
                    onSelectDialog={(dialog) => openFanTab(creatorId, dialog)}
                    clearedPeerId={
                      clearedCreatorId === creatorId ? clearedPeerId : null
                    }
                    clearedReadNonce={clearedReadNonce}
                    onRefreshExtra={() => {
                      void refreshBadges([creatorId]);
                    }}
                  />
                </div>
              );
            })}
            {activeFanTab ? (
              <div className="h-full min-h-0 overflow-hidden flex">
                <TelegramChatThread
                  key={`${activeWorkspace.creator.id}:${activeFanTab.peerId}`}
                  creatorId={activeWorkspace.creator.id}
                  creator={activeWorkspace.creator}
                  peerId={activeFanTab.peerId}
                  initialFan={activeFanTab.fan || null}
                  pollEnabled={pagePollEnabled}
                  onMarkedRead={(peerId) =>
                    handleMarkedRead(activeWorkspace.creator.id, peerId)
                  }
                  onClose={() =>
                    closeFanTab(activeWorkspace.creator.id, activeFanTab.peerId)
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
