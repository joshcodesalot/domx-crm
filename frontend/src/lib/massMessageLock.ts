import type { MassMessageLock } from '@/lib/api';

export function normalizeLockText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function chatCopyIsLocked(
  locks: MassMessageLock[],
  details: { text?: string; mediaIds?: string[] }
): boolean {
  const needle = normalizeLockText(details.text || '');
  const media = new Set((details.mediaIds || []).map((id) => id.trim()).filter(Boolean));
  return locks.some((lock) => {
    const lockText = normalizeLockText(lock.bodyText || '');
    if (lockText && needle && lockText === needle) return true;
    if (!lockText && media.size > 0) {
      return (lock.mediaIds || []).some((id) => media.has(id));
    }
    return false;
  });
}

export function telegramMessageIsLocked(
  locks: MassMessageLock[],
  messageId: string
): boolean {
  const id = String(messageId || '').trim();
  if (!id) return false;
  return locks.some((lock) => (lock.telegramMessageIds || []).includes(id));
}
