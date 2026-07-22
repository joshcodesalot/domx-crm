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
import { getCreators, getHealth, type Creator } from '@/lib/api';
import {
  ensureCreatorSessionReady,
  ensureLocalMaloumSessionForChat,
  warmCreatorInBackground,
} from '@/lib/localMaloumSession';
import type { StaffSyncEvent } from '@/types/electron';
import BootLoadingScreen from '@/components/BootLoadingScreen';
import { useMessagingTrackerPersistence } from '@/hooks/useMessagingTrackerPersistence';

type BootStatus = 'idle' | 'loading' | 'ready';

export const LAST_CHATTER_ACCOUNT_ID_KEY = 'domx_last_chatter_account_id';

const BOOT_SESSION_CONCURRENCY = 4;
const BOOT_PREPARE_CONCURRENCY = 3;

function sortCreatorsForBoot(creators: Creator[]): Creator[] {
  const lastUsed = localStorage.getItem(LAST_CHATTER_ACCOUNT_ID_KEY);
  if (!lastUsed) {
    return creators;
  }
  const lastUsedCreator = creators.find((creator) => creator.accountId === lastUsed);
  if (!lastUsedCreator) {
    return creators;
  }
  return [lastUsedCreator, ...creators.filter((creator) => creator.accountId !== lastUsed)];
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  shouldContinue: () => boolean,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let index = 0; index < items.length; index += concurrency) {
    if (!shouldContinue()) {
      return;
    }

    const batch = items.slice(index, index + concurrency);
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
  bootCreators: Creator[] | null;
  prepareCreatorChat: (
    creatorId: string,
    accountId: string,
    loginEmail?: string | null
  ) => Promise<void>;
  waitForChatReady: (accountId: string) => Promise<void>;
}

const CreatorBootContext = createContext<CreatorBootContextValue | null>(null);

export function CreatorBootProvider() {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();
  const { onSyncEvent } = useStaffSync();
  useMessagingTrackerPersistence();
  const [bootStatus, setBootStatus] = useState<BootStatus>('idle');
  const [bootCreators, setBootCreators] = useState<Creator[] | null>(null);
  const bootCompleteRef = useRef(false);
  const bootRunIdRef = useRef(0);
  const chatWarmupPromiseRef = useRef<Promise<void> | null>(null);

  const prepareCreatorChat = useCallback(
    async (creatorId: string, accountId: string, loginEmail?: string | null) => {
      if (!window.electronAPI?.isElectron) {
        return;
      }

      await ensureLocalMaloumSessionForChat(creatorId, accountId, loginEmail);
    },
    []
  );

  const waitForChatReady = useCallback(async (accountId: string) => {
    if (!window.electronAPI?.isElectron) {
      return;
    }

    if (await window.electronAPI.isChatPrepared(accountId)) {
      return;
    }

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await window.electronAPI.isChatPrepared(accountId)) {
        return;
      }

      if (chatWarmupPromiseRef.current) {
        await Promise.race([
          chatWarmupPromiseRef.current.catch(() => {}),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          }),
        ]);
      } else {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      }
    }
  }, []);

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

    async function warmAllCreators(creators: Creator[]): Promise<void> {
      const [priorityCreator, ...otherCreators] = creators;

      if (priorityCreator && isActiveBoot()) {
        try {
          await ensureCreatorSessionReady(
            priorityCreator.id,
            priorityCreator.accountId!,
            priorityCreator.loginEmail
          );

          if (isActiveBoot() && priorityCreator.accountId) {
            await window.electronAPI!.prepareChatBrowser(priorityCreator.accountId);
          }
        } catch {
          // Best-effort warm-up for the most likely first click; recovery on chat open.
        }
      }

      if (!isActiveBoot()) {
        return;
      }

      await runWithConcurrency(otherCreators, BOOT_SESSION_CONCURRENCY, isActiveBoot, async (creator) => {
        try {
          await ensureCreatorSessionReady(
            creator.id,
            creator.accountId!,
            creator.loginEmail
          );
        } catch {
          // Best-effort session warm-up; recovery happens when chat opens.
        }
      });

      if (!isActiveBoot()) {
        return;
      }

      const accountIds = otherCreators
        .map((creator) => creator.accountId!)
        .filter((accountId) => Boolean(accountId));

      if (accountIds.length === 0) {
        return;
      }

      await window.electronAPI!.prepareAllChatBrowsersParallel(
        accountIds,
        BOOT_PREPARE_CONCURRENCY
      );
    }

    async function runBoot() {
      setBootStatus('loading');

      try {
        const [, { creators }] = await Promise.all([getHealth(), getCreators()]);
        if (!isActiveBoot()) return;

        const targets = creators.filter(
          (creator) => creator.platform === 'maloum' && creator.accountId
        );
        const sortedTargets = sortCreatorsForBoot(targets);

        if (isActiveBoot()) {
          setBootCreators(sortedTargets);
          bootCompleteRef.current = true;
          setBootStatus('ready');
        }

        if (!isActiveBoot()) return;

        if (sortedTargets.length > 0) {
          const warmupPromise = warmAllCreators(sortedTargets).then(() => {});
          chatWarmupPromiseRef.current = warmupPromise;
          void warmupPromise.finally(() => {
            chatWarmupPromiseRef.current = null;
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

    return onSyncEvent((event: StaffSyncEvent) => {
      if (event.type !== 'creator:access-granted' || !event.accountId) {
        return;
      }

      if (!hasPermission('creators.view')) {
        return;
      }

      void warmCreatorInBackground(event.creatorId, event.accountId);
    });
  }, [isAuthenticated, hasPermission, onSyncEvent]);

  const value = useMemo(
    () => ({
      bootStatus,
      bootCreators,
      prepareCreatorChat,
      waitForChatReady,
    }),
    [bootStatus, bootCreators, prepareCreatorChat, waitForChatReady]
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
