import { useCallback, useEffect, useMemo, useState } from 'react';
import { Home, Plus, X } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import ThemeToggle from '@/components/ThemeToggle';
import {
  MaloumChatList,
  MaloumChatThread,
  partnerName,
} from '@/components/maloum/MaloumChatPanels';
import { getCreators, type Creator, type MaloumChat } from '@/lib/api';

const HOME_TAB_ID = 'home';

interface FanTab {
  chatId: string;
  displayName: string;
  avatarUrl: string | null;
  chat?: MaloumChat | null;
}

interface CreatorWorkspace {
  creator: Creator;
  fanTabs: FanTab[];
  activeTabId: string;
}

function isOpenableCreator(creator: Creator): boolean {
  return creator.platform === 'maloum' && Boolean(creator.accountId || creator.id);
}

export default function MessagePro() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [workspaces, setWorkspaces] = useState<CreatorWorkspace[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const openableCreators = useMemo(
    () => creators.filter(isOpenableCreator),
    [creators]
  );

  const availableCreators = useMemo(() => {
    const openIds = new Set(workspaces.map((w) => w.creator.id));
    return openableCreators.filter((c) => !openIds.has(c.id));
  }, [openableCreators, workspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.creator.id === activeAccountId) || null,
    [workspaces, activeAccountId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { creators: list } = await getCreators();
        if (cancelled) return;
        setCreators(list.filter((c) => c.platform === 'maloum'));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load creators');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openCreator = useCallback((creator: Creator) => {
    setWorkspaces((prev) => {
      if (prev.some((w) => w.creator.id === creator.id)) return prev;
      return [
        ...prev,
        {
          creator,
          fanTabs: [],
          activeTabId: HOME_TAB_ID,
        },
      ];
    });
    setActiveAccountId(creator.id);
    setPickerOpen(false);
  }, []);

  const closeCreator = useCallback(
    (creatorId: string) => {
      setWorkspaces((prev) => {
        const remaining = prev.filter((w) => w.creator.id !== creatorId);
        if (activeAccountId === creatorId) {
          setActiveAccountId(remaining[0]?.creator.id || null);
        }
        return remaining;
      });
    },
    [activeAccountId]
  );

  const openFanTab = useCallback(
    (creatorId: string, chat: MaloumChat) => {
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
    },
    []
  );

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
        <button
          type="button"
          onClick={() => {
            window.location.hash = '#/dashboard';
          }}
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          title="Back to dashboard"
        >
          <Home className="w-4 h-4" />
        </button>
        <span className="text-sm font-semibold mr-2">Message Pro</span>
        <div className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0">
          {workspaces.map((workspace) => {
            const creatorId = workspace.creator.id;
            const active = creatorId === activeAccountId;
            return (
              <div
                key={creatorId}
                className={`flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg border shrink-0 ${
                  active
                    ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-900/20'
                    : 'border-gray-200 dark:border-white/10'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveAccountId(creatorId)}
                  className="flex items-center gap-1.5 min-w-0"
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
                </button>
                <button
                  type="button"
                  onClick={() => closeCreator(creatorId)}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-700"
                  title="Close creator"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              className="p-1.5 rounded-lg border border-dashed border-gray-300 dark:border-white/20 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              title="Add creator"
            >
              <Plus className="w-4 h-4" />
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg py-1">
                {availableCreators.length === 0 ? (
                  <p className="text-xs text-gray-500 px-3 py-2">
                    {loading ? 'Loading…' : 'No more Maloum creators available'}
                  </p>
                ) : (
                  availableCreators.map((creator) => (
                    <button
                      key={creator.id}
                      type="button"
                      onClick={() => openCreator(creator)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <CreatorAvatar
                        avatarUrl={creator.avatarUrl}
                        displayName={creator.displayName}
                        className="w-7 h-7 rounded-full object-cover"
                        initialsClassName="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs"
                      />
                      <span className="truncate">{creator.displayName}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
        <ThemeToggle />
      </header>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 px-4 py-2 border-b border-gray-200 dark:border-white/10">
          {error}
        </p>
      )}

      {!activeWorkspace ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
          {loading
            ? 'Loading…'
            : 'Open a Maloum creator to start messaging'}
        </div>
      ) : (
        <>
          <div className="h-10 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-1 px-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab(activeWorkspace.creator.id, HOME_TAB_ID)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs shrink-0 ${
                activeWorkspace.activeTabId === HOME_TAB_ID
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/20 dark:text-brand-300'
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
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/20 dark:text-brand-300'
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

          <div className="flex-1 min-h-0">
            {activeWorkspace.activeTabId === HOME_TAB_ID ? (
              <MaloumChatList
                creatorId={activeWorkspace.creator.id}
                onSelectChat={(chat) =>
                  openFanTab(activeWorkspace.creator.id, chat)
                }
                openActionLabel="Open tab"
              />
            ) : activeFanTab ? (
              <MaloumChatThread
                creator={activeWorkspace.creator}
                chatId={activeFanTab.chatId}
                initialChat={activeFanTab.chat || null}
                onClose={() =>
                  closeFanTab(activeWorkspace.creator.id, activeFanTab.chatId)
                }
              />
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-gray-500">
                Tab not found
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
