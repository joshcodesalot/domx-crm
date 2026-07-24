import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Home, Plus, X } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import ThemeToggle from '@/components/ThemeToggle';
import { getCreators, type Creator } from '@/lib/api';
import type { BrowserBounds } from '@/types/electron';

const HOME_TAB_ID = 'home';

interface FanTab {
  chatId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface CreatorWorkspace {
  creator: Creator;
  fanTabs: FanTab[];
  activeTabId: string;
}

function getBrowserBounds(element: HTMLElement | null): BrowserBounds | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

async function waitForBounds(
  element: HTMLElement | null,
  attempts = 40
): Promise<BrowserBounds | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bounds = getBrowserBounds(element);
    if (bounds) {
      return bounds;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return getBrowserBounds(element);
}

function isOpenableCreator(creator: Creator): boolean {
  return creator.platform === 'maloum' && Boolean(creator.accountId);
}

export default function MessagePro() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [workspaces, setWorkspaces] = useState<CreatorWorkspace[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const activeAccountIdRef = useRef<string | null>(null);
  const workspacesRef = useRef<CreatorWorkspace[]>([]);
  const resizeFrameRef = useRef<number | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const didAutoOpenRef = useRef(false);

  const isElectron = Boolean(window.electronAPI?.isElectron);

  useEffect(() => {
    activeAccountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.creator.accountId === activeAccountId) || null,
    [workspaces, activeAccountId]
  );

  const openableCreators = useMemo(
    () => creators.filter(isOpenableCreator),
    [creators]
  );

  const availableCreators = useMemo(() => {
    const openIds = new Set(
      workspaces
        .map((workspace) => workspace.creator.accountId)
        .filter((id): id is string => Boolean(id))
    );
    return openableCreators.filter(
      (creator) => creator.accountId && !openIds.has(creator.accountId)
    );
  }, [openableCreators, workspaces]);

  const syncBounds = useCallback(() => {
    if (!window.electronAPI?.setMessageProBounds || !activeAccountIdRef.current) {
      return;
    }
    const bounds = getBrowserBounds(hostRef.current);
    if (bounds) {
      void window.electronAPI.setMessageProBounds(bounds);
    }
  }, []);

  const scheduleSyncBounds = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      return;
    }
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      syncBounds();
    });
  }, [syncBounds]);

  const showActiveView = useCallback(async () => {
    if (!isElectron || !window.electronAPI?.showMessageProView) {
      return;
    }

    const accountId = activeAccountIdRef.current;
    const workspace = workspacesRef.current.find(
      (item) => item.creator.accountId === accountId
    );

    if (!accountId || !workspace) {
      return;
    }

    const bounds = await waitForBounds(hostRef.current);
    if (!bounds) {
      return;
    }

    setViewLoading(true);
    setError(null);
    try {
      await window.electronAPI.showMessageProView({
        accountId,
        tabId: workspace.activeTabId || HOME_TAB_ID,
        bounds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open Maloum view');
    } finally {
      setViewLoading(false);
    }
  }, [isElectron]);

  const openCreator = useCallback((creator: Creator) => {
    if (!creator.accountId) {
      return;
    }

    setWorkspaces((prev) => {
      if (prev.some((workspace) => workspace.creator.accountId === creator.accountId)) {
        return prev;
      }
      return [
        ...prev,
        {
          creator,
          fanTabs: [],
          activeTabId: HOME_TAB_ID,
        },
      ];
    });
    setActiveAccountId(creator.accountId);
    setPickerOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { creators: list } = await getCreators();
        if (cancelled) {
          return;
        }
        const maloumCreators = list.filter((creator) => creator.platform === 'maloum');
        setCreators(maloumCreators);

        if (!didAutoOpenRef.current) {
          didAutoOpenRef.current = true;
          const openable = maloumCreators.filter(isOpenableCreator);
          if (openable.length > 0) {
            setWorkspaces(
              openable.map((creator) => ({
                creator,
                fanTabs: [],
                activeTabId: HOME_TAB_ID,
              }))
            );
            setActiveAccountId(openable[0].accountId);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load creators');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    const isDark = document.documentElement.classList.contains('dark');
    void window.electronAPI?.setDomXTheme(isDark ? 'dark' : 'light');
  }, [isElectron]);

  useEffect(() => {
    void showActiveView();
  }, [activeAccountId, activeWorkspace?.activeTabId, showActiveView]);

  useEffect(() => {
    if (activeAccountId || !isElectron || !window.electronAPI?.hideMessageProView) {
      return;
    }
    void window.electronAPI.hideMessageProView();
  }, [activeAccountId, isElectron]);

  useEffect(() => {
    return () => {
      if (window.electronAPI?.hideMessageProView) {
        void window.electronAPI.hideMessageProView();
      }
    };
  }, []);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.onMessageProWindowResized) {
      return;
    }

    const unsubscribe = window.electronAPI.onMessageProWindowResized(() => {
      scheduleSyncBounds();
    });

    const onWindowResize = () => scheduleSyncBounds();
    window.addEventListener('resize', onWindowResize);

    const host = hostRef.current;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && host
        ? new ResizeObserver(() => {
            scheduleSyncBounds();
          })
        : null;
    if (host && resizeObserver) {
      resizeObserver.observe(host);
    }

    return () => {
      unsubscribe();
      window.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, [isElectron, scheduleSyncBounds, activeAccountId]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.onMessageProOpenFanTab) {
      return;
    }

    return window.electronAPI.onMessageProOpenFanTab((payload) => {
      if (!payload?.accountId || !payload.chatId) {
        return;
      }

      setWorkspaces((prev) => {
        const index = prev.findIndex(
          (workspace) => workspace.creator.accountId === payload.accountId
        );
        if (index < 0) {
          return prev;
        }

        const current = prev[index];
        const exists = current.fanTabs.some((tab) => tab.chatId === payload.chatId);
        const fanTabs = exists
          ? current.fanTabs
          : [
              ...current.fanTabs,
              {
                chatId: payload.chatId,
                displayName: payload.displayName || payload.chatId,
                avatarUrl: payload.avatarUrl || null,
              },
            ];

        const next = [...prev];
        next[index] = {
          ...current,
          fanTabs,
          activeTabId: payload.chatId,
        };
        return next;
      });

      setActiveAccountId(payload.accountId);
    });
  }, [isElectron]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPickerOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pickerOpen]);

  async function closeCreatorTab(accountId: string, event?: ReactMouseEvent) {
    event?.stopPropagation();

    const remaining = workspaces.filter(
      (workspace) => workspace.creator.accountId !== accountId
    );
    setWorkspaces(remaining);

    if (activeAccountId === accountId) {
      setActiveAccountId(remaining[0]?.creator.accountId || null);
    }

    if (window.electronAPI?.closeMessageProCreator) {
      await window.electronAPI.closeMessageProCreator({ accountId });
    }
  }

  function selectCreator(accountId: string) {
    setActiveAccountId(accountId);
  }

  function selectTab(tabId: string) {
    if (!activeAccountId) {
      return;
    }

    setWorkspaces((prev) =>
      prev.map((workspace) =>
        workspace.creator.accountId === activeAccountId
          ? { ...workspace, activeTabId: tabId }
          : workspace
      )
    );
  }

  async function closeFanTab(chatId: string, event?: ReactMouseEvent) {
    event?.stopPropagation();
    if (!activeAccountId) {
      return;
    }

    const accountId = activeAccountId;
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.creator.accountId !== accountId) {
          return workspace;
        }
        const fanTabs = workspace.fanTabs.filter((tab) => tab.chatId !== chatId);
        const activeTabId =
          workspace.activeTabId === chatId ? HOME_TAB_ID : workspace.activeTabId;
        return { ...workspace, fanTabs, activeTabId };
      })
    );

    if (window.electronAPI?.closeMessageProTab) {
      await window.electronAPI.closeMessageProTab({ accountId, tabId: chatId });
    }
  }

  return (
    <div className="bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 h-screen flex flex-col antialiased overflow-hidden">
      <header className="h-12 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-3 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 shrink-0">
            Message Pro
          </span>
          <div className="flex items-center gap-1 overflow-x-auto min-w-0 py-1">
            {workspaces.map((workspace) => {
              const accountId = workspace.creator.accountId!;
              const selected = accountId === activeAccountId;
              return (
                <button
                  key={accountId}
                  type="button"
                  onClick={() => selectCreator(accountId)}
                  className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm shrink-0 transition-colors ${
                    selected
                      ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700/50 dark:bg-brand-900/30 dark:text-brand-200'
                      : 'border-transparent bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10'
                  }`}
                >
                  <CreatorAvatar
                    avatarUrl={workspace.creator.avatarUrl}
                    displayName={workspace.creator.displayName}
                    className="w-5 h-5 rounded-full object-cover shrink-0"
                    initialsClassName="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center shrink-0 text-orange-600 font-bold text-[10px]"
                  />
                  <span className="max-w-[140px] truncate">
                    {workspace.creator.displayName}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      void closeCreatorTab(accountId, event);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void closeCreatorTab(accountId);
                      }
                    }}
                    className="ml-0.5 rounded p-0.5 text-gray-400 opacity-70 hover:text-gray-700 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/10 group-hover:opacity-100"
                    title="Close creator"
                  >
                    <X className="w-3.5 h-3.5" />
                  </span>
                </button>
              );
            })}

            <div ref={pickerRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setPickerOpen((open) => !open)}
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:text-gray-800 hover:border-gray-400 dark:border-white/20 dark:text-gray-400 dark:hover:text-white dark:hover:border-white/40"
                title="Add creator"
              >
                <Plus className="w-4 h-4" />
              </button>

              {pickerOpen && (
                <div className="absolute left-0 top-full mt-2 z-50 w-72 max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-xl py-1">
                  {availableCreators.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      {openableCreators.length === 0
                        ? 'No Maloum creators available.'
                        : 'All creators are already open.'}
                    </p>
                  ) : (
                    availableCreators.map((creator) => (
                      <button
                        key={creator.id}
                        type="button"
                        onClick={() => openCreator(creator)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        <CreatorAvatar
                          avatarUrl={creator.avatarUrl}
                          displayName={creator.displayName}
                          className="w-7 h-7 rounded-full object-cover shrink-0"
                          initialsClassName="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center shrink-0 text-orange-600 font-bold text-xs"
                        />
                        <span className="truncate">{creator.displayName}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <ThemeToggle />
      </header>

      {activeWorkspace ? (
        <div className="h-10 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center gap-1 px-2 overflow-x-auto bg-gray-50/80 dark:bg-white/[0.02]">
          <button
            type="button"
            onClick={() => selectTab(HOME_TAB_ID)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium shrink-0 ${
              activeWorkspace.activeTabId === HOME_TAB_ID
                ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white'
                : 'text-gray-500 hover:text-gray-800 hover:bg-white/70 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/5'
            }`}
          >
            <Home className="w-3.5 h-3.5" />
            Home
          </button>

          {activeWorkspace.fanTabs.map((tab) => {
            const selected = activeWorkspace.activeTabId === tab.chatId;
            return (
              <button
                key={tab.chatId}
                type="button"
                onClick={() => selectTab(tab.chatId)}
                className={`group inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium shrink-0 max-w-[180px] ${
                  selected
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white'
                    : 'text-gray-500 hover:text-gray-800 hover:bg-white/70 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/5'
                }`}
              >
                {tab.avatarUrl ? (
                  <img
                    src={tab.avatarUrl}
                    alt=""
                    className="w-4 h-4 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <span className="w-4 h-4 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 flex items-center justify-center text-[9px] font-bold shrink-0">
                    {tab.displayName.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="truncate">{tab.displayName}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    void closeFanTab(tab.chatId, event);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void closeFanTab(tab.chatId);
                    }
                  }}
                  className="rounded p-0.5 text-gray-400 opacity-70 hover:text-gray-700 hover:bg-black/5 dark:hover:text-white dark:hover:bg-white/10"
                  title="Close chat"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {(loading || error) && (
        <div className="px-4 py-2 text-sm border-b border-gray-200 dark:border-white/10 shrink-0">
          {loading && (
            <p className="text-gray-500 dark:text-gray-400">Loading creators...</p>
          )}
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div ref={hostRef} className="absolute inset-0" />
        {!activeWorkspace && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6 pointer-events-none">
            <div className="w-14 h-14 rounded-2xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
              <Plus className="w-7 h-7" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                Add a creator with +
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-sm">
                Home shows the inbox. Use the open-in-tab button next to each fan chat
                timestamp to pin it under this creator.
              </p>
            </div>
          </div>
        )}
        {viewLoading && activeWorkspace && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-black/40 text-sm text-gray-500 dark:text-gray-300 pointer-events-none">
            Loading Maloum...
          </div>
        )}
        {!isElectron && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-amber-700 dark:text-amber-300 p-6 text-center">
            Message Pro requires the DomX desktop app.
          </div>
        )}
      </div>
    </div>
  );
}
