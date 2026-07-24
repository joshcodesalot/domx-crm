import { useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { MaloumSingleCreatorChat } from '@/components/maloum/MaloumChatPanels';
import { useStaffSync } from '@/context/StaffSyncContext';
import { getCreators, getMaloumBadges, type Creator } from '@/lib/api';

const BADGE_POLL_MS = 30_000;

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

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const maloum = list.filter((c) => c.platform === 'maloum');
      setCreators(maloum);
      setSelectedCreatorId((prev) => prev || maloum[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
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
    const ids = creators.map((c) => c.id);
    void refreshBadges(ids);
    const timer = window.setInterval(() => {
      void refreshBadges(ids);
    }, BADGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [creators, refreshBadges]);

  useEffect(() => {
    return onSyncEvent(() => {
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  return (
    <div className="h-screen flex bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100">
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
