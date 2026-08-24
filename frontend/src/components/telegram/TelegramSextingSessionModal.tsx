import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { TelegramSextingSessionForm } from '@/components/telegram/TelegramSextingSessionForm';

export default function TelegramSextingSessionModal({
  groupPeerId,
  groupLabel,
  defaultFanName,
  defaultCreatorIds,
  onClose,
}: {
  groupPeerId: string;
  groupLabel: string;
  defaultFanName: string;
  defaultCreatorIds: string[];
  onClose: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close generate session"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-200 dark:border-white/10 bg-white/95 dark:bg-[#111]/95">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sky-500 shrink-0" />
              Generate session
            </h2>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate mt-0.5">
              {groupLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <TelegramSextingSessionForm
            compact
            lockGroupId
            groupPeerId={groupPeerId}
            groupLabel={groupLabel}
            defaultFanName={defaultFanName}
            defaultCreatorIds={defaultCreatorIds}
            onCreated={(session) => {
              onClose();
              navigate(
                `/chatter/telegram/sexting-session?session=${encodeURIComponent(session.id)}`
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}
