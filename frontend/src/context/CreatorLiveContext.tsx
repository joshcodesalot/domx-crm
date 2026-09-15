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
const FOCUS_BADGE_POLL_MS = 15_000;
const ALL_BADGE_POLL_MS = 60_000;
const MALOUM_BADGE_CONCURRENCY = 1;
const OTHER_BADGE_CONCURRENCY = 3;

type BadgeNeedEntry = {
  all: boolean;
  creatorIds: string[];
};

type BadgeNeedSpec = {
  enabled: boolean;
  all?: boolean;
  creatorIds?: string[];
};

type CreatorLiveContextValue = {
  creators: Creator[];
  creatorsLoading: boolean;
  creatorsError: string | null;
  badgesByCreatorId: Record<string, CreatorBadgeCounts>;
  throneUnread: number;
  refreshCreators: (opts?: { silent?: boolean }) => Promise<void>;
  refreshBadges: (creatorIds?: string[]) => Promise<void>;
  refreshThroneUnread: () => Promise<void>;
  registerBadgeNeed: (key: string, spec: BadgeNeedSpec) => void;
};

function badgeNeedEqual(
  prev: BadgeNeedEntry | undefined,
  next: BadgeNeedEntry
): boolean {
  if (!prev) return false;
  if (prev.all !== next.all) return false;
  if (prev.creatorIds.length !== next.creatorIds.length) return false;
  return prev.creatorIds.every((id, index) => id === next.creatorIds[index]);
}

export function collectBadgePollPlan(
  creators: Creator[],
  needs: Iterable<BadgeNeedEntry>
): { wantAll: boolean; focusIds: string[] } {
  let wantAll = false;
  const known = new Set(creators.map((creator) => creator.id));
  const focus = new Set<string>();
  for (const need of needs) {
    if (need.all) wantAll = true;
    for (const id of need.creatorIds) {
      if (known.has(id)) focus.add(id);
    }
  }
  return { wantAll, focusIds: [...focus] };
}

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
  const [badgeNeedsVersion, setBadgeNeedsVersion] = useState(0);
  const [throneUnread, setThroneUnread] = useState(0);
  const creatorsRef = useRef<Creator[]>([]);
  const badgeNeedsRef = useRef(new Map<string, BadgeNeedEntry>());
  const badgePollPlanRef = useRef<{ wantAll: boolean; focusIds: string[] }>({
    wantAll: false,
    focusIds: [],
  });
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

  const registerBadgeNeed = useCallback((key: string, spec: BadgeNeedSpec) => {
    if (!spec.enabled) {
      if (!badgeNeedsRef.current.has(key)) {
        setBadgeNeeds((current) =>
          current === badgeNeedsRef.current.size ? current : badgeNeedsRef.current.size
        );
        return;
      }
      badgeNeedsRef.current.delete(key);
      setBadgeNeeds(badgeNeedsRef.current.size);
      setBadgeNeedsVersion((version) => version + 1);
      return;
    }

    const next: BadgeNeedEntry = {
      all: spec.all === true,
      creatorIds: Array.from(new Set((spec.creatorIds || []).filter(Boolean))),
    };
    const prev = badgeNeedsRef.current.get(key);
    if (badgeNeedEqual(prev, next)) {
      setBadgeNeeds((current) =>
        current === badgeNeedsRef.current.size ? current : badgeNeedsRef.current.size
      );
      return;
    }
    badgeNeedsRef.current.set(key, next);
    setBadgeNeeds(badgeNeedsRef.current.size);
    setBadgeNeedsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    badgePollPlanRef.current = collectBadgePollPlan(
      creators,
      badgeNeedsRef.current.values()
    );
  }, [creators, badgeNeeds, badgeNeedsVersion]);

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
    const maloumIds: string[] = [];
    const otherIds: string[] = [];
    for (const id of ids) {
      const creator = byId.get(id);
      if (!creator) continue;
      if (creator.platform === 'maloum') maloumIds.push(id);
      else otherIds.push(id);
    }
    const updates: Record<string, CreatorBadgeCounts> = {};
    const fetchOne = async (id: string) => {
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
    };
    await Promise.all([
      runWithConcurrency(maloumIds, MALOUM_BADGE_CONCURRENCY, fetchOne),
      runWithConcurrency(otherIds, OTHER_BADGE_CONCURRENCY, fetchOne),
    ]);
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
    const plan = badgePollPlanRef.current;
    if (plan.focusIds.length > 0) {
      void refreshBadges(plan.focusIds);
    }
    if (plan.wantAll) {
      void refreshBadges();
    }
    void refreshThroneUnread();

    const focusTimer =
      plan.focusIds.length > 0
        ? window.setInterval(() => {
            const ids = badgePollPlanRef.current.focusIds;
            if (ids.length > 0) void refreshBadges(ids);
          }, FOCUS_BADGE_POLL_MS)
        : null;
    const allTimer = plan.wantAll
      ? window.setInterval(() => {
          if (badgePollPlanRef.current.wantAll) void refreshBadges();
        }, ALL_BADGE_POLL_MS)
      : null;
    const throneTimer = window.setInterval(() => {
      void refreshThroneUnread();
    }, FOCUS_BADGE_POLL_MS);

    return () => {
      if (focusTimer) window.clearInterval(focusTimer);
      if (allTimer) window.clearInterval(allTimer);
      window.clearInterval(throneTimer);
    };
  }, [
    isAuthenticated,
    documentVisible,
    badgeNeeds,
    badgeNeedsVersion,
    refreshBadges,
    refreshThroneUnread,
  ]);

  const wasVisibleRef = useRef(documentVisible);
  useEffect(() => {
    const justVisible = documentVisible && !wasVisibleRef.current;
    wasVisibleRef.current = documentVisible;
    if (!justVisible || !isAuthenticated) return;
    void refreshCreatorsRef.current({ silent: true });
    if (badgeNeedsRef.current.size > 0) {
      const plan = badgePollPlanRef.current;
      if (plan.focusIds.length > 0) {
        void refreshBadgesRef.current(plan.focusIds);
      }
      if (plan.wantAll) {
        void refreshBadgesRef.current();
      }
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
  badgeScope?: 'all' | string[];
  pollAllBadges?: boolean;
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
  const badgeScope = opts?.badgeScope;
  const focusedIds = Array.isArray(badgeScope) ? badgeScope : [];
  const pollAllBadges =
    opts?.pollAllBadges === true ||
    badgeScope === 'all' ||
    (wantBadges && badgeScope === undefined);
  const focusKey = focusedIds.join(',');

  useEffect(() => {
    const enabled = wantBadges && pollEnabled;
    ctx.registerBadgeNeed(subscriberKey, {
      enabled,
      all: enabled && pollAllBadges,
      creatorIds: enabled ? focusedIds : [],
    });
    return () => ctx.registerBadgeNeed(subscriberKey, { enabled: false });
  }, [ctx, subscriberKey, wantBadges, pollEnabled, pollAllBadges, focusKey]);

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
