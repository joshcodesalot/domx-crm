import { useEffect, useRef } from 'react';
import type { TelegramMessageReaction } from '@/lib/api';

export const TELEGRAM_REACTION_EMOJIS = [
  '❤️',
  '👍',
  '🔥',
  '🥰',
  '👏',
  '😂',
  '💋',
  '🙏',
] as const;

export function normalizeReactionEmoji(emoji: string): string {
  return String(emoji || '').replace(/\uFE0F/g, '');
}

export function reactionsMatch(a: string, b: string): boolean {
  return normalizeReactionEmoji(a) === normalizeReactionEmoji(b);
}

export function chosenReactionEmoji(
  reactions?: TelegramMessageReaction[] | null
): string | null {
  return reactions?.find((item) => item.chosen)?.emoji || null;
}

export function applyOptimisticReactions(
  reactions: TelegramMessageReaction[] | undefined,
  emoji: string | null
): TelegramMessageReaction[] {
  const next = (Array.isArray(reactions) ? reactions : [])
    .map((item) => {
      if (!item.chosen) return { ...item };
      const count = item.count - 1;
      if (count <= 0) return null;
      return { ...item, count, chosen: false };
    })
    .filter((item): item is TelegramMessageReaction => Boolean(item));

  if (!emoji) return next;

  const existing = next.find((item) => reactionsMatch(item.emoji, emoji));
  if (existing) {
    existing.count += 1;
    existing.chosen = true;
    return next;
  }
  next.push({ emoji, count: 1, chosen: true });
  return next;
}

export function TelegramReactionChips({
  reactions,
  disabled,
  onToggle,
}: {
  reactions: TelegramMessageReaction[];
  disabled?: boolean;
  onToggle: (emoji: string) => void;
}) {
  if (!reactions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((item) => (
        <button
          key={item.emoji}
          type="button"
          disabled={disabled}
          onClick={() => onToggle(item.emoji)}
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] leading-none border transition-colors disabled:opacity-50 ${
            item.chosen
              ? 'bg-sky-500/15 border-sky-400/60 text-sky-700 dark:text-sky-300'
              : 'bg-white/90 dark:bg-zinc-900/90 border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-zinc-800'
          }`}
          title={item.chosen ? 'Remove reaction' : `React with ${item.emoji}`}
        >
          <span>{item.emoji}</span>
          {item.count > 1 ? (
            <span className="tabular-nums text-[10px] font-medium">{item.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export default function TelegramReactionPicker({
  open,
  chosenEmoji,
  alignEnd,
  onSelect,
  onClose,
}: {
  open: boolean;
  chosenEmoji: string | null;
  alignEnd?: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className={`absolute bottom-full mb-1 z-20 flex items-center gap-0.5 rounded-full border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-1 py-1 shadow-lg ${
        alignEnd ? 'right-0' : 'left-0'
      }`}
      role="listbox"
      aria-label="React to message"
    >
      {TELEGRAM_REACTION_EMOJIS.map((emoji) => {
        const chosen = chosenEmoji ? reactionsMatch(emoji, chosenEmoji) : false;
        return (
          <button
            key={emoji}
            type="button"
            role="option"
            aria-selected={chosen}
            onClick={() => onSelect(emoji)}
            className={`w-7 h-7 rounded-full text-sm flex items-center justify-center transition-colors ${
              chosen
                ? 'bg-sky-500/20 ring-1 ring-sky-400/70'
                : 'hover:bg-gray-100 dark:hover:bg-zinc-800'
            }`}
            title={chosen ? 'Remove reaction' : `React with ${emoji}`}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
