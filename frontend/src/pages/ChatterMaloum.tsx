import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import { MaloumSingleCreatorChat } from '@/components/maloum/MaloumChatPanels';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';

export default function ChatterMaloum() {
  const location = useLocation();
  const pollEnabled = usePollEnabled(location.pathname === '/chatter');
  const { creators, creatorsLoading, badgesByCreatorId } = useCreatorLive({
    platform: 'maloum',
    wantBadges: true,
    pollEnabled,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkCreatorId = searchParams.get('creatorId') || '';
  const deepLinkChatId = searchParams.get('chatId') || '';
  const appliedCreatorDeepLinkRef = useRef(false);
  const consumedChatIdRef = useRef<string | null>(null);
  const [pendingChatId, setPendingChatId] = useState<string | null>(
    () => searchParams.get('chatId') || null
  );
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((c) => c.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const consumeChatDeepLink = useCallback(() => {
    const current = searchParams.get('chatId') || pendingChatId || '';
    if (current) consumedChatIdRef.current = current;
    setPendingChatId(null);
    if (!searchParams.get('chatId') && !searchParams.get('fanId')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('chatId');
    next.delete('fanId');
    setSearchParams(next, { replace: true });
  }, [pendingChatId, searchParams, setSearchParams]);

  useEffect(() => {
    if (
      deepLinkCreatorId &&
      creators.some((creator) => creator.id === deepLinkCreatorId)
    ) {
      if (deepLinkChatId || !appliedCreatorDeepLinkRef.current) {
        appliedCreatorDeepLinkRef.current = true;
        setSelectedCreatorId(deepLinkCreatorId);
      }
    }
    if (deepLinkChatId && consumedChatIdRef.current !== deepLinkChatId) {
      setPendingChatId(deepLinkChatId);
    }
  }, [creators, deepLinkCreatorId, deepLinkChatId]);

  const unreadByCreatorId: Record<string, number> = {};
  const notificationUnreadByCreatorId: Record<string, number> = {};
  for (const creator of creators) {
    const badges = badgesByCreatorId[creator.id];
    if (!badges) continue;
    unreadByCreatorId[creator.id] = badges.messages;
    notificationUnreadByCreatorId[creator.id] = badges.notifications;
  }

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />
      <MaloumSingleCreatorChat
        creators={creators}
        creatorsLoading={creatorsLoading}
        selectedCreatorId={selectedCreatorId}
        onSelectCreator={(id) => {
          if (id !== selectedCreatorId) consumeChatDeepLink();
          setSelectedCreatorId(id);
        }}
        unreadByCreatorId={unreadByCreatorId}
        notificationUnreadByCreatorId={notificationUnreadByCreatorId}
        initialChatId={pendingChatId}
        onDeepLinkConsumed={consumeChatDeepLink}
        pollEnabled={pollEnabled}
      />
    </div>
  );
}
