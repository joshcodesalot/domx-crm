import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/context/AuthContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useDocumentVisible } from '@/hooks/useDocumentVisible';
import {
  getCreators,
  getFourBasedBadges,
  getMaloumBadges,
  getTelegramBadges,
  getThroneUnreadCount,
  type Creator,
} from '@/lib/api';
import { isCreatorRosterEvent } from '@/lib/creatorAccessEvents';
import { runWithConcurrency } from '@/lib/runWithConcurrency';

export type CreatorBadgeCounts = { messages: number; notifications: number };

const CREATOR_POLL_MS = 15_000;
const BADGE_POLL_MS = 15_000;

type CreatorLiveContextValue = {
  creators: Creator[];
  creatorsLoading: boolean;
  creatorsError: string | null;
  badgesByCreatorId: Record<string, CreatorBadgeCounts>;
  throneUnread: number;
  refreshCreators: (opts?: { silent?: boolean }) => Promise<void>;
  refreshBadges: (creatorIds?: string[]) => Promise<void>;
  refreshThroneUnread: () => Promise<void>;
  registerBadgeNeed: (key: string, enabled: boolean) => void;
};

const CreatorLiveContext = createContext<CreatorLiveContextValue | null>(null);

function badgesEqual(
  prev: Record<string, CreatorBadgeCounts>,
  next: Record<string, CreatorBadgeCounts>
): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    const a = prev[key];
    const b = next[key];
    if (!a || !b || a.messages !== b.messages || a.notifications !== b.notifications) {
      return false;
    }
  }
  return true;
}

function creatorsEqual(prev: Creator[], next: Creator[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.displayName !== b.displayName ||
      a.platform !== b.platform ||
      a.avatarUrl !== b.avatarUrl ||
      a.accountId !== b.accountId
    ) {
      return false;
    }
  }
  return true;
}

export function CreatorLiveProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { onSyncEvent } = useStaffSync();
  const documentVisible = useDocumentVisible();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(false);
  const [creatorsError, setCreatorsError] = useState<string | null>(null);
  const [badgesByCreatorId, setBadgesByCreatorId] = useState<
    Record<string, CreatorBadgeCounts>
  >({});
  const [badgeNeeds, setBadgeNeeds] = useState(0);
  const [throneUnread, setThroneUnread] = useState(0);
  const creatorsRef = useRef<Creator[]>([]);
  const badgeNeedsRef = useRef(new Map<string, boolean>());
  const refreshCreatorsRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(
    async () => undefined
  );
  const refreshBadgesRef = useRef<(creatorIds?: string[]) => Promise<void>>(
    async () => undefined
  );
  const refreshThroneUnreadRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    creatorsRef.current = creators;
  }, [creators]);

  const registerBadgeNeed = useCallback((key: string, enabled: boolean) => {
    const prev = badgeNeedsRef.current.get(key) === true;
    if (enabled) badgeNeedsRef.current.set(key, true);
    else badgeNeedsRef.current.delete(key);
    const next = badgeNeedsRef.current.get(key) === true;
    if (prev === next && enabled === prev) {
      const count = badgeNeedsRef.current.size;
      setBadgeNeeds((current) => (current === count ? current : count));
      return;
    }
    setBadgeNeeds(badgeNeedsRef.current.size);
  }, []);

  const refreshCreators = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      setCreators((prev) => (creatorsEqual(prev, list) ? prev : list));
      setCreatorsError(null);
      setBadgesByCreatorId((prev) => {
        const next: Record<string, CreatorBadgeCounts> = {};
        for (const creator of list) {
          if (prev[creator.id]) next[creator.id] = prev[creator.id];
        }
        return badgesEqual(prev, next) ? prev : next;
      });
    } catch (err) {
      if (!silent) {
        setCreatorsError(
          err instanceof Error ? err.message : 'Failed to load creators'
        );
      }
    } finally {
      if (!silent) setCreatorsLoading(false);
    }
  }, []);

  const refreshBadges = useCallback(async (creatorIds?: string[]) => {
    const ids =
      creatorIds && creatorIds.length > 0
        ? creatorIds
        : creatorsRef.current.map((creator) => creator.id);
    if (ids.length === 0) return;
    const byId = new Map(creatorsRef.current.map((creator) => [creator.id, creator]));
    const updates: Record<string, CreatorBadgeCounts> = {};
    await runWithConcurrency(ids, 3, async (id) => {
      const creator = byId.get(id);
      if (!creator) return;
      try {
        const result =
          creator.platform === '4based'
            ? await getFourBasedBadges(id)
            : creator.platform === 'maloum'
              ? await getMaloumBadges(id)
              : creator.platform === 'telegram'
                ? await getTelegramBadges(id)
                : null;
        if (!result) return;
        updates[id] = {
          messages: Number(result.messages) || 0,
          notifications: Number(result.notifications) || 0,
        };
      } catch (err) {
        console.warn(
          'Badge poll failed:',
          id,
          err instanceof Error ? err.message : err
        );
      }
    });
    if (Object.keys(updates).length === 0) return;
    setBadgesByCreatorId((prev) => {
      const next = { ...prev, ...updates };
      return badgesEqual(prev, next) ? prev : next;
    });
  }, []);

  const refreshThroneUnread = useCallback(async () => {
    try {
      const result = await getThroneUnreadCount();
      const next = Number(result.unreadCount) || 0;
      setThroneUnread((prev) => (prev === next ? prev : next));
    } catch (err) {
      console.warn(
        'Throne unread poll failed:',
        err instanceof Error ? err.message : err
      );
    }
  }, []);

  refreshCreatorsRef.current = refreshCreators;
  refreshBadgesRef.current = refreshBadges;
  refreshThroneUnreadRef.current = refreshThroneUnread;

  useEffect(() => {
    if (!isAuthenticated) {
      setCreators([]);
      setBadgesByCreatorId({});
      setThroneUnread(0);
      setCreatorsError(null);
      setCreatorsLoading(false);
      return;
    }
    void refreshCreators();
  }, [isAuthenticated, refreshCreators]);

  useEffect(() => {
    if (!isAuthenticated || !documentVisible) return;
    const timer = window.setInterval(() => {
      void refreshCreators({ silent: true });
    }, CREATOR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isAuthenticated, documentVisible, refreshCreators]);

  useEffect(() => {
    if (!isAuthenticated || !documentVisible || badgeNeeds === 0) return;
    void refreshBadges();
    void refreshThroneUnread();
    const timer = window.setInterval(() => {
      void refreshBadges();
      void refreshThroneUnread();
    }, BADGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isAuthenticated, documentVisible, badgeNeeds, refreshBadges, refreshThroneUnread]);

  const wasVisibleRef = useRef(documentVisible);
  useEffect(() => {
    const justVisible = documentVisible && !wasVisibleRef.current;
    wasVisibleRef.current = documentVisible;
    if (!justVisible || !isAuthenticated) return;
    void refreshCreatorsRef.current({ silent: true });
    if (badgeNeedsRef.current.size > 0) {
      void refreshBadgesRef.current();
      void refreshThroneUnreadRef.current();
    }
  }, [documentVisible, isAuthenticated]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (!isCreatorRosterEvent(event)) return;
      void refreshCreators({ silent: true });
    });
  }, [onSyncEvent, refreshCreators]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'telegram:throne') return;
      void refreshThroneUnread();
    });
  }, [onSyncEvent, refreshThroneUnread]);

  const value = useMemo(
    () => ({
      creators,
      creatorsLoading,
      creatorsError,
      badgesByCreatorId,
      throneUnread,
      refreshCreators,
      refreshBadges,
      refreshThroneUnread,
      registerBadgeNeed,
    }),
    [
      creators,
      creatorsLoading,
      creatorsError,
      badgesByCreatorId,
      throneUnread,
      refreshCreators,
      refreshBadges,
      refreshThroneUnread,
      registerBadgeNeed,
    ]
  );

  return (
    <CreatorLiveContext.Provider value={value}>{children}</CreatorLiveContext.Provider>
  );
}

export function useCreatorLive(opts?: {
  platform?: 'maloum' | '4based' | 'telegram';
  wantBadges?: boolean;
  pollEnabled?: boolean;
}) {
  const ctx = useContext(CreatorLiveContext);
  if (!ctx) {
    throw new Error('useCreatorLive must be used within CreatorLiveProvider');
  }
  const subscriberKey = useRef(
    `live-${Math.random().toString(36).slice(2, 10)}`
  ).current;
  const wantBadges = opts?.wantBadges === true;
  const pollEnabled = opts?.pollEnabled !== false;

  useEffect(() => {
    ctx.registerBadgeNeed(subscriberKey, wantBadges && pollEnabled);
    return () => ctx.registerBadgeNeed(subscriberKey, false);
  }, [ctx, subscriberKey, wantBadges, pollEnabled]);

  const creators = useMemo(() => {
    if (!opts?.platform) return ctx.creators;
    return ctx.creators.filter((creator) => creator.platform === opts.platform);
  }, [ctx.creators, opts?.platform]);

  return {
    creators,
    creatorsLoading: ctx.creatorsLoading,
    creatorsError: ctx.creatorsError,
    badgesByCreatorId: ctx.badgesByCreatorId,
    throneUnread: ctx.throneUnread,
    refreshCreators: ctx.refreshCreators,
    refreshBadges: ctx.refreshBadges,
    refreshThroneUnread: ctx.refreshThroneUnread,
  };
}
