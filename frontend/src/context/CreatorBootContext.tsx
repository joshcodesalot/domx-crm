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
import { getCreators, getHealth, getMe } from '@/lib/api';
import { ensureLocalMaloumSessionForChat } from '@/lib/localMaloumSession';
import type { StaffSyncEvent } from '@/types/electron';
import BootLoadingScreen from '@/components/BootLoadingScreen';
import { useMessagingTrackerPersistence } from '@/hooks/useMessagingTrackerPersistence';

type BootStatus = 'idle' | 'loading' | 'ready';

const BOOT_HYDRATE_CONCURRENCY = 4;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  shouldContinue: () => boolean,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    if (!shouldContinue()) {
      return;
    }

    const batch = items.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        if (!shouldContinue()) {
          return;
        }
        await fn(item);
      })
    );
  }
}

interface CreatorBootContextValue {
  bootStatus: BootStatus;
  prepareCreatorChat: (
    creatorId: string,
    accountId: string,
    loginEmail?: string | null
  ) => Promise<void>;
}

const CreatorBootContext = createContext<CreatorBootContextValue | null>(null);

export function CreatorBootProvider() {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();
  const { onSyncEvent } = useStaffSync();
  useMessagingTrackerPersistence();
  const [bootStatus, setBootStatus] = useState<BootStatus>('idle');
  const bootCompleteRef = useRef(false);
  const bootRunIdRef = useRef(0);

  const prepareCreatorChat = useCallback(
    async (creatorId: string, accountId: string, loginEmail?: string | null) => {
      if (!window.electronAPI?.isElectron) {
        return;
      }

      await ensureLocalMaloumSessionForChat(creatorId, accountId, loginEmail);
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
          (creator) => creator.platform === 'maloum' && creator.accountId
        );

        if (!isActiveBoot()) return;

        if (targets.length === 0) {
          bootCompleteRef.current = true;
          setBootStatus('ready');
          return;
        }

        await runWithConcurrency(
          targets,
          BOOT_HYDRATE_CONCURRENCY,
          isActiveBoot,
          async (creator) => {
            try {
              await window.electronAPI!.registerCreatorMapping({
                accountId: creator.accountId!,
                creatorId: creator.id,
              });
              await window.electronAPI!.hydrateCreatorProfile(creator.accountId!);
            } catch {
              // Best-effort local hydration only; recovery happens when chat opens.
            }
          }
        );

        if (!isActiveBoot()) return;

        const warmResults = await Promise.all(
          targets.map(async (creator) => {
            try {
              const warm = await window.electronAPI!.isCreatorSessionWarm(creator.accountId!);
              return warm ? creator.accountId! : null;
            } catch {
              return null;
            }
          })
        );
        const warmAccountIds = warmResults.filter((accountId): accountId is string => accountId !== null);

        if (isActiveBoot()) {
          bootCompleteRef.current = true;
          setBootStatus('ready');
        }

        if (warmAccountIds.length > 0 && isActiveBoot()) {
          void window.electronAPI!.prepareAllChatBrowsers(warmAccountIds).catch(() => {
            // Best-effort background warmup; chat open will retry prepare.
          });
        }
      } catch {
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

    return onSyncEvent((_event: StaffSyncEvent) => {
      // Local Maloum sessions stay on-device; session-updated is metadata-only now.
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
