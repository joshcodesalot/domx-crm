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
import { getCreatorSession, getCreators, getHealth, getMe } from '@/lib/api';
import type { PlaywrightCookie } from '@/types/electron';
import BootLoadingScreen from '@/components/BootLoadingScreen';
import { useMessagingTrackerPersistence } from '@/hooks/useMessagingTrackerPersistence';

type BootStatus = 'idle' | 'loading' | 'ready';

interface CreatorBootContextValue {
  bootStatus: BootStatus;
  prepareCreatorChat: (creatorId: string, accountId: string) => Promise<void>;
}

const CreatorBootContext = createContext<CreatorBootContextValue | null>(null);

export function CreatorBootProvider() {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();
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

      const hydrated = await window.electronAPI.hydrateCreatorProfile(accountId);
      if (!hydrated.hydrated) {
        const session = await getCreatorSession(creatorId);
        if (!session.accountId || session.cookies.length === 0) {
          throw new Error('No saved session for this creator.');
        }
        await window.electronAPI.loadCreatorSession({
          accountId: session.accountId,
          cookies: session.cookies as PlaywrightCookie[],
          origins: session.origins,
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
        const health = await getHealth();
        if (!isActiveBoot()) return;

        const me = await getMe();
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
              const accountId = creator.accountId!;

              try {
                const hydrated = await window.electronAPI!.hydrateCreatorProfile(accountId);
                if (hydrated.hydrated) {
                  return {
                    creatorId: creator.id,
                    accountId,
                    hydrated: true,
                    source: hydrated.source,
                  };
                }

                const session = await getCreatorSession(creator.id);
                if (!session.accountId || session.cookies.length === 0) {
                  return null;
                }

                return {
                  creatorId: creator.id,
                  accountId: session.accountId,
                  cookies: session.cookies as PlaywrightCookie[],
                  origins: session.origins,
                  source: 'backend',
                };
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

  const value = useMemo(
    () => ({
      bootStatus,
      prepareCreatorChat,
    }),
    [bootStatus, prepareCreatorChat]
  );

  if (bootStatus === 'loading') {
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
