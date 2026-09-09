import { useEffect, useRef } from 'react';
import { useStaffSync } from '@/context/StaffSyncContext';
import type { StaffSyncEvent } from '@/types/electron';

export type AiSuggestionEvent = Extract<StaffSyncEvent, { type: 'ai:suggestion' }>;

export function useAiSuggestionEvents(opts: {
  creatorId?: string;
  platformChatId?: string;
  onSuggestion: (event: AiSuggestionEvent) => void;
}) {
  const { onSyncEvent } = useStaffSync();
  const onSuggestionRef = useRef(opts.onSuggestion);
  onSuggestionRef.current = opts.onSuggestion;

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'ai:suggestion') return;
      if (opts.creatorId && event.creatorId !== opts.creatorId) return;
      if (opts.platformChatId && event.platformChatId !== opts.platformChatId) {
        return;
      }
      onSuggestionRef.current(event);
    });
  }, [onSyncEvent, opts.creatorId, opts.platformChatId]);
}
