import type { StaffSyncEvent } from '@/types/electron';

export function isCreatorRosterEvent(event: StaffSyncEvent): boolean {
  return (
    event.type === 'creator:access-granted' ||
    event.type === 'creator:access-revoked' ||
    event.type === 'creator:session-updated'
  );
}
