import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { getCreatorSession, getCreators, getHealth, getMe } from '@/lib/api';
import type { PlaywrightCookie, StaffSyncEvent } from '@/types/electron';
import BootLoadingScreen from '@/components/BootLoadingScreen';
import { useMessagingTrackerPersistence } from '@/hooks/useMessagingTrackerPersistence';

type BootStatus = 'idle' | 'loading' | 'ready';

interface CreatorBootContextValue {
  bootStatus: BootStatus;
  prepareCreatorChat: (creatorId: string, accountId: string) => Promise<void>;
}

const CreatorBootContext = createContext<CreatorBootContextValue | null>(null);

function isBackendSessionNewer(
  backendSavedAt: string | null | undefined,
  localSavedAt: string | null | undefined
): boolean {
  if (!backendSavedAt) {
    return false;
  }
  if (!localSavedAt) {
    return true;
  }

  const backendMs = Date.parse(backendSavedAt);
  const localMs = Date.parse(localSavedAt);
  if (Number.isNaN(backendMs)) {
    return false;
  }
  if (Number.isNaN(localMs)) {
    return true;
  }
  return backendMs > localMs;
}

async function resolveCreatorSessionEntry(creatorId: string, accountId: string) {
  const localMeta = await window.electronAPI!.getLocalCreatorProfileMeta(accountId);
  const session = await getCreatorSession(creatorId);

  if (!session.accountId || session.cookies.length === 0) {
    const hydrated = await window.electronAPI!.hydrateCreatorProfile(accountId);
    if (hydrated.hydrated) {
      return {
        creatorId,
        accountId,
        hydrated: true as const,
        source: hydrated.source,
      };
    }
    return null;
  }

  if (
    !localMeta.exists ||
    isBackendSessionNewer(session.sessionUpdatedAt, localMeta.savedAt)
  ) {
    return {
      creatorId,
      accountId: session.accountId,
      cookies: session.cookies as PlaywrightCookie[],
      origins: session.origins,
      savedAt: session.sessionUpdatedAt,
      force: true,
      source: 'backend' as const,
    };
  }

  const hydrated = await window.electronAPI!.hydrateCreatorProfile(accountId);
  if (hydrated.hydrated) {
    return {
      creatorId,
      accountId,
      hydrated: true as const,
      source: hydrated.source,
    };
  }

  return {
    creatorId,
    accountId: session.accountId,
    cookies: session.cookies as PlaywrightCookie[],
    origins: session.origins,
    savedAt: session.sessionUpdatedAt,
    force: true,
    source: 'backend' as const,
  };
}

async function applyBackendSession(creatorId: string, accountId: string) {
  const session = await getCreatorSession(creatorId);
  if (!session.accountId || session.cookies.length === 0) {
    throw new Error('No saved session for this creator.');
  }

  await window.electronAPI!.loadCreatorSession({
    accountId: session.accountId || accountId,
    cookies: session.cookies as PlaywrightCookie[],
    origins: session.origins,
    force: true,
    savedAt: session.sessionUpdatedAt,
  });

  return session;
}

export function CreatorBootProvider() {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();
  const { onSyncEvent } = useStaffSync();
  useMessagingTrackerPersistence();
  const [bootStatus, setBootStatus] = useState<BootStatus>('idle');
  const bootCompleteRef = useRef(false);
  const bootRunIdRef = useRef(0);

  const prepareCreatorChat = useCallback(
    async (creatorId: string, accountId: string) => {
      if (!window.electronAPI?.isElectron) {
        return;
      }

      await window.electronAPI.registerCreatorMapping({ accountId, creatorId });

      const entry = await resolveCreatorSessionEntry(creatorId, accountId);
      if (!entry) {
        throw new Error('No saved session for this creator.');
      }

      if (!entry.hydrated) {
        await window.electronAPI.loadCreatorSession({
          accountId: entry.accountId,
          cookies: entry.cookies!,
          origins: entry.origins,
          force: Boolean(entry.force),
          savedAt: entry.savedAt,
        });
      }

      const prepared = await window.electronAPI.isChatPrepared(accountId);
      if (!prepared) {
        await window.electronAPI.prepareChatBrowser(accountId);
      }
    },
    []
  );

  useEffect(() => {
    if (!isAuthenticated || isLoading) {
      setBootStatus('idle');
      return;
    }

    if (!hasPermission('creators.view')) {
      setBootStatus('ready');
      return;
    }

    if (!window.electronAPI?.isElectron) {
      setBootStatus('ready');
      return;
    }

    if (bootCompleteRef.current) {
      setBootStatus('ready');
      return;
    }

    const runId = ++bootRunIdRef.current;
    let cancelled = false;
    const isActiveBoot = () => !cancelled && runId === bootRunIdRef.current;

    async function runBoot() {
      setBootStatus('loading');

      try {
        await getHealth();
        if (!isActiveBoot()) return;

        await getMe();
        if (!isActiveBoot()) return;

        const { creators } = await getCreators();
        if (!isActiveBoot()) return;
        const targets = creators.filter(
          (creator) =>
            creator.platform === 'maloum' &&
            creator.connectionStatus === 'connected' &&
            creator.accountId
        );

        if (!isActiveBoot()) return;

        if (targets.length === 0) {
          bootCompleteRef.current = true;
          setBootStatus('ready');
          return;
        }

        const sessions = (
          await Promise.all(
            targets.map(async (creator) => {
              try {
                return await resolveCreatorSessionEntry(
                  creator.id,
                  creator.accountId!
                );
              } catch {
                return null;
              }
            })
          )
        ).filter((session): session is NonNullable<typeof session> => session !== null);

        if (!isActiveBoot()) return;

        if (sessions.length > 0) {
          await window.electronAPI!.preloadCreatorSessions(sessions);
        }

        if (!isActiveBoot()) return;

        const accountIds = sessions.map((s) => s.accountId);

        await window.electronAPI!.prepareAllChatBrowsers(accountIds);

        if (isActiveBoot()) {
          bootCompleteRef.current = true;
          setBootStatus('ready');
        }
      } catch (err) {
        if (isActiveBoot()) {
          bootCompleteRef.current = true;
          setBootStatus('ready');
        }
      }
    }

    void runBoot();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, hasPermission]);

  useEffect(() => {
    if (!isAuthenticated || !window.electronAPI?.isElectron) {
      return;
    }

    return onSyncEvent((event: StaffSyncEvent) => {
      if (event.type !== 'creator:session-updated' || !event.accountId) {
        return;
      }

      void (async () => {
        try {
          const localMeta = await window.electronAPI!.getLocalCreatorProfileMeta(
            event.accountId!
          );
          if (
            localMeta.exists &&
            !isBackendSessionNewer(event.sessionUpdatedAt, localMeta.savedAt)
          ) {
            return;
          }

          await applyBackendSession(event.creatorId, event.accountId!);

          const prepared = await window.electronAPI!.isChatPrepared(event.accountId!);
          if (prepared) {
            await window.electronAPI!.reloadChatBrowser(event.accountId!);
          } else {
            await window.electronAPI!.prepareChatBrowser(event.accountId!);
          }
        } catch {
          // Best-effort live sync; next boot/verify will recover.
        }
      })();
    });
  }, [isAuthenticated, onSyncEvent]);

  const value = useMemo(
    () => ({
      bootStatus,
      prepareCreatorChat,
    }),
    [bootStatus, prepareCreatorChat]
  );

  if (isAuthenticated && !isLoading && bootStatus === 'loading') {
    return <BootLoadingScreen />;
  }

  return (
    <CreatorBootContext.Provider value={value}>
      <Outlet />
    </CreatorBootContext.Provider>
  );
}

export function useCreatorBoot(): CreatorBootContextValue {
  const context = useContext(CreatorBootContext);
  if (!context) {
    throw new Error('useCreatorBoot must be used within CreatorBootProvider');
  }
  return context;
}
