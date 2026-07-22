import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, Globe, MessageSquare, RefreshCw, type LucideIcon } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ChatterRevalidateLoginModal from '@/components/ChatterRevalidateLoginModal';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useAuth } from '@/context/AuthContext';
import {
  LAST_CHATTER_ACCOUNT_ID_KEY,
  useCreatorBoot,
} from '@/context/CreatorBootContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { getCreators, getMaloumSentMessages, type Creator } from '@/lib/api';
import {
  LocalMaloumSessionError,
  loadBackendCreatorSession,
  needsInteractiveSessionRecovery,
  revalidateLocalMaloumSessionForChat,
  uploadRefreshedCreatorSession,
} from '@/lib/localMaloumSession';
import type { BrowserBounds } from '@/types/electron';

type SessionStatus = 'idle' | 'loading' | 'valid' | 'error';

type CreatorUnreadCounts = { messages: number; notifications: number };

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const AUTO_TRANSLATE_HISTORY_KEY = 'domx_auto_translate_history';
const SENT_MESSAGE_HYDRATION_TTL_MS = 5 * 60 * 1000;

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function getCreatorUnreadCounts(
  creator: Creator,
  badgeCountsByAccountId: Record<string, CreatorUnreadCounts>
): CreatorUnreadCounts {
  const counts = creator.accountId ? badgeCountsByAccountId[creator.accountId] : undefined;
  return {
    messages: counts?.messages ?? 0,
    notifications: counts?.notifications ?? 0,
  };
}

function UnreadBadge({
  icon: Icon,
  count,
  label,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
}) {
  const hasUnread = count > 0;
  const badgeClass = hasUnread
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-400';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${badgeClass}`}
      title={label}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      <span>{count > 99 ? '99+' : count}</span>
    </span>
  );
}

function CreatorsListSkeleton() {
  return (
    <div className="p-2 space-y-2" aria-hidden>
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 p-3 rounded-lg border border-transparent"
        >
          <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-white/10 shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="h-3.5 w-24 rounded bg-gray-200 dark:bg-white/10" />
            <div className="flex gap-1.5">
              <div className="h-5 w-10 rounded-full bg-gray-100 dark:bg-white/5" />
              <div className="h-5 w-10 rounded-full bg-gray-100 dark:bg-white/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatPanelSkeleton() {
  return (
    <div
      className="absolute inset-0 flex bg-[#f8f9fa] dark:bg-[#0d0d0d] z-10"
      aria-hidden
    >
      <div className="w-72 border-r border-gray-200 dark:border-white/10 p-3 space-y-3 shrink-0">
        <div className="h-8 w-32 rounded bg-gray-200 dark:bg-white/10" />
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-white/10 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-24 rounded bg-gray-200 dark:bg-white/10" />
              <div className="h-2.5 w-36 rounded bg-gray-100 dark:bg-white/5" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex-1 flex flex-col p-6 space-y-4">
        <div className="flex justify-start">
          <div className="h-10 w-48 rounded-2xl bg-gray-200 dark:bg-white/10" />
        </div>
        <div className="flex justify-end">
          <div className="h-10 w-56 rounded-2xl bg-gray-200 dark:bg-white/10" />
        </div>
        <div className="flex justify-start">
          <div className="h-16 w-64 rounded-2xl bg-gray-100 dark:bg-white/5" />
        </div>
        <div className="flex justify-end">
          <div className="h-10 w-40 rounded-2xl bg-gray-200 dark:bg-white/10" />
        </div>
        <div className="mt-auto h-12 w-full rounded-xl bg-gray-100 dark:bg-white/5" />
      </div>
    </div>
  );
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

async function waitForChatBounds(
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

function connectionDotClass(status: Creator['connectionStatus']): string {
  if (status === 'connected') return 'bg-green-500';
  if (status === 'error') return 'bg-red-500';
  return 'bg-yellow-500';
}

export default function Chatter() {
  const { user, hasPermission } = useAuth();
  const { bootCreators, prepareCreatorChat } = useCreatorBoot();
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadingChat, setReloadingChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessRevokedMessage, setAccessRevokedMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [showRevalidateLoginModal, setShowRevalidateLoginModal] = useState(false);
  const [badgeCountsByAccountId, setBadgeCountsByAccountId] = useState<
    Record<string, CreatorUnreadCounts>
  >({});
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const [autoTranslateHistory, setAutoTranslateHistory] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_HISTORY_KEY, true)
  );
  const [fullBrowserMode, setFullBrowserMode] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedCreatorRef = useRef<Creator | null>(null);
  const fullBrowserModeRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const sentMessageHydrationAtRef = useRef<Record<string, number>>({});
  const isElectron = Boolean(window.electronAPI?.isElectron);
  const canManageFullBrowser = hasPermission('creators.manage');

  const selectedCreator = creators.find((c) => c.id === selectedId) || null;

  const syncChatBounds = useCallback(() => {
    if (!window.electronAPI || !selectedIdRef.current) return;
    const bounds = getBrowserBounds(chatContainerRef.current);
    if (bounds) {
      window.electronAPI.resizeChatBrowser(bounds);
    }
  }, []);

  const scheduleSyncChatBounds = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      return;
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      syncChatBounds();
    });
  }, [syncChatBounds]);

  const hydrateSentMessagesIfNeeded = useCallback(async (creator: Creator) => {
    if (!creator.accountId) {
      return;
    }

    const lastHydratedAt = sentMessageHydrationAtRef.current[creator.id];
    if (
      lastHydratedAt &&
      Date.now() - lastHydratedAt < SENT_MESSAGE_HYDRATION_TTL_MS
    ) {
      return;
    }

    try {
      const { records } = await getMaloumSentMessages({
        creatorId: creator.id,
        limit: 200,
      });

      if (records.length > 0) {
        await window.electronAPI!.hydrateSentMessages({
          accountId: creator.accountId,
          records,
        });
      }

      sentMessageHydrationAtRef.current[creator.id] = Date.now();
    } catch {
      // Badge hydration is best-effort
    }
  }, []);

  const hideChatBrowser = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.hideChatBrowser();
    }
    setFullBrowserMode(false);
  }, []);

  const loadCreatorsList = useCallback(async () => {
    const { creators: list } = await getCreators();
    setCreators(list.filter((c) => c.platform === 'maloum'));
    return list;
  }, []);

  useEffect(() => {
    if (bootCreators) {
      setCreators(bootCreators);
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      setError(null);
      try {
        await loadCreatorsList();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load creators');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [bootCreators, loadCreatorsList]);

  useEffect(() => {
    const unsubscribe = onSyncEvent((event) => {
      if (event.type === 'creator:access-granted') {
        void loadCreatorsList();
        return;
      }

      if (event.type === 'creator:session-updated' && event.accountId) {
        void loadBackendCreatorSession(event.creatorId, event.accountId).catch(() => {});
        void loadCreatorsList();
        return;
      }

      if (event.type !== 'creator:access-revoked') {
        return;
      }

      const wasSelected = selectedIdRef.current === event.creatorId;

      setCreators((prev) => prev.filter((creator) => creator.id !== event.creatorId));

      if (wasSelected) {
        void hideChatBrowser();
        setSelectedId(null);
        setSessionStatus('idle');
        setSessionError(null);
        setAccessRevokedMessage(
          `Access to ${event.displayName} was removed by your manager.`
        );
      }

      if (event.accountId) {
        setBadgeCountsByAccountId((prev) => {
          const next = { ...prev };
          delete next[event.accountId!];
          return next;
        });
      }

      void loadCreatorsList();
    });

    return unsubscribe;
  }, [onSyncEvent, hideChatBrowser, loadCreatorsList]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.setTranslationSettings) {
      return;
    }

    void window.electronAPI.setTranslationSettings({
      preSendEnabled: autoTranslateOutgoing,
      historyEnabled: autoTranslateHistory,
    });
  }, [isElectron, autoTranslateOutgoing, autoTranslateHistory]);

  const handleAutoTranslateOutgoingChange = useCallback((enabled: boolean) => {
    setAutoTranslateOutgoing(enabled);
    localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
  }, []);

  const handleAutoTranslateHistoryChange = useCallback((enabled: boolean) => {
    setAutoTranslateHistory(enabled);
    localStorage.setItem(AUTO_TRANSLATE_HISTORY_KEY, String(enabled));
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selectedCreatorRef.current = selectedCreator;
  }, [selectedCreator]);

  useEffect(() => {
    fullBrowserModeRef.current = fullBrowserMode;
  }, [fullBrowserMode]);

  const showChatForSelectedCreator = useCallback(
    async (fullBrowserAccess: boolean) => {
      const creator = selectedCreatorRef.current;
      if (!creator?.accountId || !window.electronAPI) {
        throw new Error('Chat panel is not ready. Try again.');
      }

      const bounds = await waitForChatBounds(chatContainerRef.current);
      if (!bounds) {
        throw new Error('Chat panel is not ready. Try again.');
      }

      await window.electronAPI.showChatBrowser({
        accountId: creator.accountId,
        bounds,
        fullBrowserAccess,
      });

      localStorage.setItem(LAST_CHATTER_ACCOUNT_ID_KEY, creator.accountId);
      setSessionStatus('valid');
      setSessionError(null);
      void hydrateSentMessagesIfNeeded(creator);
    },
    [hydrateSentMessagesIfNeeded]
  );

  const handleSessionRecoveryFailure = useCallback(
    async (err: unknown) => {
      setSessionStatus('error');
      if (err instanceof LocalMaloumSessionError) {
        setSessionError(err.message);
      } else {
        setSessionError(err instanceof Error ? err.message : 'Failed to load session');
      }
      setFullBrowserMode(false);
      await hideChatBrowser();
    },
    [hideChatBrowser]
  );

  const handleRevalidateSession = useCallback(
    async (options: { openInteractiveOnFailure?: boolean } = {}) => {
      const creator = selectedCreatorRef.current;
      if (!isElectron || !creator?.accountId) {
        return;
      }

      setRevalidating(true);
      setSessionError(null);
      setSessionStatus('loading');
      setShowRevalidateLoginModal(false);

      try {
        if (window.electronAPI?.setActiveChatter && user) {
          await window.electronAPI.setActiveChatter({
            userId: user.id,
            userName: user.name,
            fullBrowserAccess: fullBrowserModeRef.current,
          });
        }

        await revalidateLocalMaloumSessionForChat(
          creator.id,
          creator.accountId,
          creator.loginEmail
        );

        await showChatForSelectedCreator(fullBrowserModeRef.current);

        void uploadRefreshedCreatorSession(creator.id, creator.accountId).catch(() => {
          // Best-effort sync for other machines.
        });
      } catch (err) {
        await handleSessionRecoveryFailure(err);
        if (options.openInteractiveOnFailure !== false && needsInteractiveSessionRecovery(err)) {
          setShowRevalidateLoginModal(true);
        }
      } finally {
        setRevalidating(false);
      }
    },
    [isElectron, user, showChatForSelectedCreator, handleSessionRecoveryFailure]
  );

  const handleInteractiveRevalidateSuccess = useCallback(async () => {
    setShowRevalidateLoginModal(false);
    await handleRevalidateSession({ openInteractiveOnFailure: false });
  }, [handleRevalidateSession]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.setActiveChatter || !user) {
      return;
    }

    void window.electronAPI.setActiveChatter({
      userId: user.id,
      userName: user.name,
    });
  }, [isElectron, user]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.getCreatorBadgeCounts) {
      return;
    }

    let cancelled = false;

    async function loadBadgeCounts() {
      try {
        const counts = await window.electronAPI!.getCreatorBadgeCounts();
        if (cancelled) return;

        const mapped: Record<string, CreatorUnreadCounts> = {};
        for (const [accountId, state] of Object.entries(counts)) {
          mapped[accountId] = {
            messages: state.messages ?? 0,
            notifications: state.notificationCount ?? 0,
          };
        }
        setBadgeCountsByAccountId(mapped);
      } catch {
        // Badge counts are best-effort
      }
    }

    void loadBadgeCounts();

    const unsubscribe = window.electronAPI.onCreatorBadgeCountsUpdated((payload) => {
      setBadgeCountsByAccountId((prev) => ({
        ...prev,
        [payload.accountId]: {
          messages: payload.messages ?? 0,
          notifications: payload.notificationCount ?? 0,
        },
      }));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isElectron]);

  const openCreatorChat = useCallback(
    async (creator: Creator, options: { fullBrowserAccess?: boolean } = {}) => {
      const fullBrowserAccess = options.fullBrowserAccess ?? false;
      setSelectedId(creator.id);
      setSessionError(null);
      setFullBrowserMode(fullBrowserAccess);

      if (!isElectron) {
        setSessionStatus('error');
        setSessionError('Chatter requires the DomX desktop app.');
        return;
      }

      if (!creator.accountId) {
        setSessionStatus('error');
        setSessionError('No saved session for this creator. Reconnect the account.');
        return;
      }

      try {
        if (window.electronAPI?.setActiveChatter && user) {
          await window.electronAPI.setActiveChatter({
            userId: user.id,
            userName: user.name,
            fullBrowserAccess,
          });
        }

        const isPrepared = await window.electronAPI!.isChatPrepared(creator.accountId);

        if (!isPrepared) {
          setSessionStatus('loading');
          await prepareCreatorChat(creator.id, creator.accountId, creator.loginEmail);
        }

        const bounds = await waitForChatBounds(chatContainerRef.current);
        if (!bounds) {
          throw new Error('Chat panel is not ready. Try again.');
        }

        await window.electronAPI!.showChatBrowser({
          accountId: creator.accountId,
          bounds,
          fullBrowserAccess,
        });

        localStorage.setItem(LAST_CHATTER_ACCOUNT_ID_KEY, creator.accountId);
        setSessionStatus('valid');

        void hydrateSentMessagesIfNeeded(creator);
      } catch (err) {
        await handleSessionRecoveryFailure(err);
        if (needsInteractiveSessionRecovery(err)) {
          setShowRevalidateLoginModal(true);
        }
      }
    },
    [isElectron, prepareCreatorChat, handleSessionRecoveryFailure, user, hydrateSentMessagesIfNeeded]
  );

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.onChatSessionExpired) {
      return;
    }

    const unsubscribe = window.electronAPI.onChatSessionExpired((payload) => {
      const creator = selectedCreatorRef.current;
      if (!creator?.accountId || creator.accountId !== payload.accountId) {
        return;
      }

      void hideChatBrowser();
      setSessionStatus('error');
      setSessionError('Session expired — revalidate to continue.');
      setFullBrowserMode(false);
    });

    return unsubscribe;
  }, [isElectron, hideChatBrowser]);

  useEffect(() => {
    if (!selectedId || !isElectron || sessionStatus !== 'valid') return;

    const resizeObserver = new ResizeObserver(() => scheduleSyncChatBounds());
    if (chatContainerRef.current) {
      resizeObserver.observe(chatContainerRef.current);
    }

    window.addEventListener('resize', scheduleSyncChatBounds);
    const unsubscribeResize = window.electronAPI?.onWindowResized(() => {
      scheduleSyncChatBounds();
    });

    syncChatBounds();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleSyncChatBounds);
      unsubscribeResize?.();
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [selectedId, isElectron, sessionStatus, syncChatBounds, scheduleSyncChatBounds]);

  useEffect(() => {
    return () => {
      void hideChatBrowser();
    };
  }, [hideChatBrowser]);

  async function handleSelectCreator(creator: Creator) {
    if (creator.id === selectedId && sessionStatus === 'valid' && !fullBrowserMode) {
      return;
    }
    await openCreatorChat(creator, { fullBrowserAccess: false });
  }

  async function handleOpenFullBrowser(creator: Creator) {
    await openCreatorChat(creator, { fullBrowserAccess: true });
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await loadCreatorsList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh creators');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleReloadChat() {
    if (!isElectron || !selectedCreator?.accountId || sessionStatus !== 'valid') {
      return;
    }

    setReloadingChat(true);
    setSessionError(null);
    try {
      await window.electronAPI!.reloadChatBrowser(selectedCreator.accountId);

      delete sentMessageHydrationAtRef.current[selectedCreator.id];
      await hydrateSentMessagesIfNeeded(selectedCreator);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to reload chat');
    } finally {
      setReloadingChat(false);
    }
  }

  return (
    <div className="bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 min-h-screen flex antialiased">
      <Sidebar activePage="chatter" />

      <main className="flex-1 flex min-w-0 overflow-hidden">
        <aside className="w-72 border-r border-gray-200 dark:border-white/10 flex flex-col shrink-0">
          <div className="h-16 px-4 border-b border-gray-200 dark:border-white/10 flex items-center justify-between">
            <h1 className="text-sm font-semibold">Creators</h1>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="p-1.5 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && <CreatorsListSkeleton />}
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400 p-3">{error}</p>
            )}
            {!loading && !error && creators.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400 p-3">
                {user?.role === 'chatter' && !hasPermission('creators.manage')
                  ? 'No creators assigned to you. Contact your manager.'
                  : 'No Maloum creators connected yet.'}
              </p>
            )}
            {creators.map((creator) => {
              const isSelected = creator.id === selectedId;
              const unread = getCreatorUnreadCounts(creator, badgeCountsByAccountId);
              const showReload =
                isSelected && isElectron && sessionStatus === 'valid' && Boolean(creator.accountId);
              const showFullBrowser =
                canManageFullBrowser &&
                isElectron &&
                Boolean(creator.accountId) &&
                creator.connectionStatus === 'connected';
              return (
                <div
                  key={creator.id}
                  className={`creator-item w-full flex items-center gap-3 p-3 rounded-lg transition-colors border ${
                    isSelected
                      ? 'bg-brand-50 dark:bg-brand-900/20 border-brand-200 dark:border-brand-800/40'
                      : 'border-transparent hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void handleSelectCreator(creator)}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  >
                    <CreatorAvatar
                      avatarUrl={creator.avatarUrl}
                      displayName={creator.displayName}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{creator.displayName}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
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
                  {showFullBrowser ? (
                    <button
                      type="button"
                      onClick={() => void handleOpenFullBrowser(creator)}
                      disabled={sessionStatus === 'loading'}
                      className={`p-1.5 rounded-md shrink-0 transition-colors disabled:opacity-50 ${
                        fullBrowserMode && isSelected
                          ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20'
                          : 'text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20'
                      }`}
                      title="Open full browser"
                    >
                      <Globe className="w-4 h-4" />
                    </button>
                  ) : null}
                  {showReload ? (
                    <button
                      type="button"
                      onClick={() => void handleReloadChat()}
                      disabled={reloadingChat}
                      className="p-1.5 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50 shrink-0"
                      title="Reload page"
                    >
                      <RefreshCw className={`w-4 h-4 ${reloadingChat ? 'animate-spin' : ''}`} />
                    </button>
                  ) : (
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${connectionDotClass(creator.connectionStatus)}`}
                      title={creator.connectionStatus.toUpperCase()}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {isElectron && (
            <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3 space-y-3 bg-white dark:bg-[#0a0a0a]">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Translation
              </p>
              <label className="flex items-start gap-3 cursor-pointer">
                <ToggleSwitch
                  checked={autoTranslateOutgoing}
                  onChange={handleAutoTranslateOutgoingChange}
                  aria-label="Auto-translate outgoing messages"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    Auto-translate outgoing
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Translate messages to German before sending
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <ToggleSwitch
                  checked={autoTranslateHistory}
                  onChange={handleAutoTranslateHistoryChange}
                  aria-label="Auto-translate chat history"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                    Auto-translate chat history
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Show English translations under messages
                  </span>
                </span>
              </label>
            </div>
          )}
        </aside>

        <section className="flex-1 flex flex-col min-w-0 min-h-0">
          {fullBrowserMode && sessionStatus === 'valid' && (
            <div className="shrink-0 px-4 py-2 border-b border-gray-200 dark:border-white/10 bg-brand-50/60 dark:bg-brand-900/10">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">
                <Globe className="w-3.5 h-3.5" />
                Full browser
              </span>
            </div>
          )}

          {!isElectron && (
            <div className="m-4 flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg text-sm text-amber-800 dark:text-amber-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Chatter requires the DomX desktop app to embed Maloum chat.</span>
            </div>
          )}

          {sessionError && (
            <div className="mx-4 mt-4 flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg text-sm text-red-800 dark:text-red-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span>{sessionError}</span>
                {selectedCreator?.accountId && isElectron && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleRevalidateSession()}
                      disabled={revalidating || sessionStatus === 'loading'}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-100 dark:hover:bg-red-900/60 disabled:opacity-50"
                    >
                      {revalidating ? 'Revalidating…' : 'Revalidate session'}
                    </button>
                    {sessionStatus === 'error' && (
                      <button
                        type="button"
                        onClick={() => setShowRevalidateLoginModal(true)}
                        disabled={revalidating || sessionStatus === 'loading'}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-200 text-red-800 hover:bg-red-100/60 dark:border-red-800/40 dark:text-red-100 dark:hover:bg-red-900/30 disabled:opacity-50"
                      >
                        Sign in to Maloum
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {accessRevokedMessage && (
            <div className="mx-4 mt-4 flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg text-sm text-amber-800 dark:text-amber-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{accessRevokedMessage}</span>
            </div>
          )}

          <div
            ref={chatContainerRef}
            className={`flex-1 min-h-0 relative ${
              sessionStatus === 'valid' ? 'bg-white' : 'bg-[#f8f9fa] dark:bg-[#0d0d0d]'
            }`}
          >
            {sessionStatus === 'loading' && <ChatPanelSkeleton />}
            {!selectedCreator && sessionStatus !== 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 p-4 text-center">
                {canManageFullBrowser
                  ? 'Choose a creator for Chatter, or use the globe button for unrestricted Maloum access.'
                  : 'Choose a creator from the list to open their Maloum chat session.'}
              </div>
            )}
          </div>
        </section>
      </main>

      {showRevalidateLoginModal && selectedCreator?.accountId && (
        <ChatterRevalidateLoginModal
          creator={selectedCreator}
          onClose={() => setShowRevalidateLoginModal(false)}
          onSuccess={() => void handleInteractiveRevalidateSuccess()}
        />
      )}
    </div>
  );
}
