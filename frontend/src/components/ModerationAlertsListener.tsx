import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useToast } from '@/context/ToastContext';

/**
 * Global SSE handlers for moderation alerts (managers) and block warnings (chatters).
 */
export default function ModerationAlertsListener() {
  const { onSyncEvent } = useStaffSync();
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type === 'moderation:alert') {
        if (
          !hasPermission('moderation.review') &&
          !hasPermission('moderation.manage')
        ) {
          return;
        }
        const keyword = event.matchedKeyword || 'keyword';
        const chatter = event.chatterName || 'Chatter';
        const model = event.creatorName || 'Model';
        toast.info(
          `Moderation: "${keyword}" — ${chatter} → ${model}. Open Review to inspect.`
        );
        return;
      }

      if (event.type === 'moderation:warned') {
        const message =
          event.message ||
          (event.matchedKeyword
            ? `Message blocked: prohibited word "${event.matchedKeyword}".`
            : 'Message blocked by content moderation.');
        void confirm({
          title: 'Message blocked',
          message,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
          variant: 'default',
        });
      }
    });
  }, [onSyncEvent, hasPermission, toast, confirm]);

  return null;
}
