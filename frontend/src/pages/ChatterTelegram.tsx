import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import {
  TelegramChatList,
  TelegramChatThread,
} from '@/components/telegram/TelegramChatPanels';
import { FourBasedTranslationToggles } from '@/components/fourbased/FourBasedChatPanels';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import type { TelegramDialog } from '@/lib/api';
import telegramIcon from '@/assets/telegram_icon.svg';

export default function ChatterTelegram() {
  const location = useLocation();
  const pollEnabled = usePollEnabled(location.pathname === '/chatter/telegram');
  const {
    creators,
    creatorsLoading,
    creatorsError,
    badgesByCreatorId,
    refreshBadges,
  } = useCreatorLive({
    platform: 'telegram',
    wantBadges: true,
    pollEnabled,
  });
  const { onSyncEvent } = useStaffSync();
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [selectedDialog, setSelectedDialog] = useState<TelegramDialog | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((c) => c.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  useEffect(() => {
    setSelectedPeerId(null);
    setSelectedDialog(null);
  }, [selectedCreatorId]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'telegram:event') return;
      if (!pollEnabled) return;
      if (!selectedCreatorId || event.creatorId !== selectedCreatorId) return;
      void refreshBadges([selectedCreatorId]);
    });
  }, [onSyncEvent, selectedCreatorId, pollEnabled, refreshBadges]);

  const handleSelectDialog = useCallback((dialog: TelegramDialog) => {
    setSelectedPeerId(dialog.peerId);
    setSelectedDialog(dialog);
  }, []);

  return (
    <div className="bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 h-screen flex antialiased overflow-hidden">
      <Sidebar activePage="chatter" />
      <main className="flex-1 flex min-w-0 overflow-hidden">
        <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50 glass-panel">
          <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
            <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full" />
            <span className="text-sm font-semibold text-gray-900 dark:text-white">
              Telegram
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {creatorsLoading && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
                Loading creators…
              </p>
            )}
            {creatorsError && (
              <p className="text-xs text-red-400 p-3">{creatorsError}</p>
            )}
            {!creatorsLoading && !creatorsError && creators.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
                No Telegram creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => {
              const unread = badgesByCreatorId[creator.id] || {
                messages: 0,
                notifications: 0,
              };
              const active = selectedCreatorId === creator.id;
              return (
                <button
                  key={creator.id}
                  type="button"
                  onClick={() => setSelectedCreatorId(creator.id)}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all ${
                    active
                      ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50'
                      : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                  }`}
                >
                  <CreatorAvatar
                    avatarUrl={creator.avatarUrl}
                    displayName={creator.displayName}
                    className="w-10 h-10 rounded-full object-cover shadow-md shrink-0"
                    initialsClassName="w-10 h-10 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-sm font-bold text-white shadow-md"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-zinc-100 truncate block">
                      {creator.displayName}
                    </span>
                    {creator.username && (
                      <span className="text-[11px] text-gray-500 dark:text-zinc-500 truncate block">
                        @{creator.username}
                      </span>
                    )}
                    {unread.messages > 0 && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-sky-600">
                        <MessageSquare className="w-3 h-3" />
                        {unread.messages}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-4 bg-white/80 dark:bg-zinc-950/80">
            <FourBasedTranslationToggles />
          </div>
        </aside>

        <aside className="w-80 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-[#F7F8FA] dark:bg-[#0a0a0c] glass-panel">
          {selectedCreatorId ? (
            <TelegramChatList
              creatorId={selectedCreatorId}
              selectedPeerId={selectedPeerId}
              onSelectDialog={handleSelectDialog}
              pollEnabled={pollEnabled}
              onRefreshExtra={() => {
                void refreshBadges([selectedCreatorId]);
              }}
            />
          ) : (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-4">
              Select a creator
            </p>
          )}
        </aside>

        {selectedCreator && selectedPeerId ? (
          <TelegramChatThread
            creatorId={selectedCreator.id}
            creator={selectedCreator}
            peerId={selectedPeerId}
            initialFan={selectedDialog?.fan || null}
            pollEnabled={pollEnabled}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-zinc-500 chatter-thread-bg relative">
            <div className="absolute inset-0 bg-white/95 dark:bg-zinc-950/95" />
            <span className="relative z-10">Select a creator chat to start</span>
          </div>
        )}
      </main>
    </div>
  );
}
