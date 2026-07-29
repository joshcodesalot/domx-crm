import { useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { MaloumSingleCreatorChat } from '@/components/maloum/MaloumChatPanels';
import { useStaffSync } from '@/context/StaffSyncContext';
import { getCreators, getMaloumBadges, type Creator } from '@/lib/api';

const BADGE_POLL_MS = 15_000;
const CREATOR_POLL_MS = 15_000;

export default function ChatterMaloum() {
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [unreadByCreatorId, setUnreadByCreatorId] = useState<Record<string, number>>(
    {}
  );
  const [notificationUnreadByCreatorId, setNotificationUnreadByCreatorId] = useState<
    Record<string, number>
  >({});

  const loadCreators = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const maloum = list.filter((c) => c.platform === 'maloum');
      setCreators(maloum);
      setSelectedCreatorId((prev) => {
        if (prev && maloum.some((c) => c.id === prev)) return prev;
        return maloum[0]?.id || null;
      });
      setUnreadByCreatorId((prev) => {
        const next: Record<string, number> = {};
        for (const creator of maloum) {
          if (prev[creator.id] != null) next[creator.id] = prev[creator.id];
        }
        return next;
      });
      setNotificationUnreadByCreatorId((prev) => {
        const next: Record<string, number> = {};
        for (const creator of maloum) {
          if (prev[creator.id] != null) next[creator.id] = prev[creator.id];
        }
        return next;
      });
    } catch {
      if (!silent) setCreators([]);
    } finally {
      if (!silent) setCreatorsLoading(false);
    }
  }, []);

  const refreshBadges = useCallback(async (creatorIds: string[]) => {
    if (creatorIds.length === 0) return;
    const messageUpdates: Record<string, number> = {};
    const notificationUpdates: Record<string, number> = {};
    for (const id of creatorIds) {
      try {
        const result = await getMaloumBadges(id);
        messageUpdates[id] = Number(result.messages) || 0;
        notificationUpdates[id] = Number(result.notifications) || 0;
      } catch {
        // best-effort
      }
    }
    if (Object.keys(messageUpdates).length > 0) {
      setUnreadByCreatorId((prev) => ({ ...prev, ...messageUpdates }));
    }
    if (Object.keys(notificationUpdates).length > 0) {
      setNotificationUnreadByCreatorId((prev) => ({ ...prev, ...notificationUpdates }));
    }
  }, []);

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadCreators({ silent: true });
    }, CREATOR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadCreators]);

  useEffect(() => {
    const ids = creators.map((c) => c.id);
    void refreshBadges(ids);
    const timer = window.setInterval(() => {
      void refreshBadges(ids);
    }, BADGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [creators, refreshBadges]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (
        event.type === 'creator:access-granted' ||
        event.type === 'creator:access-revoked'
      ) {
        void loadCreators({ silent: true });
      }
    });
  }, [onSyncEvent, loadCreators]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />
      <MaloumSingleCreatorChat
        creators={creators}
        creatorsLoading={creatorsLoading}
        selectedCreatorId={selectedCreatorId}
        onSelectCreator={setSelectedCreatorId}
        unreadByCreatorId={unreadByCreatorId}
        notificationUnreadByCreatorId={notificationUnreadByCreatorId}
      />
    </div>
  );
}
