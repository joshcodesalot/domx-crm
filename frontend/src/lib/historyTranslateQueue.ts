import { translateToEnglish } from '@/lib/api';
import { stripModelTokens } from '@/lib/stripModelTokens';

export {
  HISTORY_AUTO_TRANSLATE_LIMIT,
  selectAutoHistoryTranslations,
} from '@/lib/historyTranslateWindow.mjs';

const DEFAULT_CONCURRENCY = 4;

export type HistoryTranslateItem = {
  key: string;
  text: string;
};

function isFanslyPlatform(platform?: string | null): boolean {
  return String(platform || '').trim().toLowerCase() === 'fansly';
}

export async function translateTextToEnglish(
  text: string,
  platform?: string
): Promise<string | null> {
  if (isFanslyPlatform(platform)) return null;
  const source = stripModelTokens(text);
  if (!source) return null;
  const translated = stripModelTokens(await translateToEnglish(source, platform));
  return translated || null;
}

export type HistoryTranslateQueue = {
  enqueue: (items: HistoryTranslateItem[]) => void;
  clear: () => void;
  dispose: () => void;
  isBusy: (key: string) => boolean;
};

type CreateHistoryTranslateQueueOptions = {
  concurrency?: number;
  platform?: string;
  onResult: (key: string, translated: string) => void;
  onStart?: (key: string) => void;
  onSettle?: (key: string) => void;
  translate?: (text: string) => Promise<string | null>;
};

/**
 * Concurrency-limited DE→EN history translate queue.
 * Successful results are never dropped because a React effect re-ran;
 * only clear()/dispose() invalidate in-flight work (chat switch / unmount).
 */
export function createHistoryTranslateQueue(
  options: CreateHistoryTranslateQueueOptions
): HistoryTranslateQueue {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const translate = isFanslyPlatform(options.platform)
    ? async () => null
    : (options.translate ??
      ((text: string) => translateTextToEnglish(text, options.platform)));
  const pending: HistoryTranslateItem[] = [];
  const inFlight = new Set<string>();
  const done = new Set<string>();
  let active = 0;
  let generation = 0;
  let disposed = false;

  function pump() {
    if (disposed) return;
    while (active < concurrency && pending.length > 0) {
      const item = pending.shift();
      if (!item) break;
      const gen = generation;
      active += 1;
      options.onStart?.(item.key);

      void (async () => {
        try {
          const translated = await translate(item.text);
          if (disposed || gen !== generation) return;
          const cleaned = stripModelTokens(translated || '');
          if (cleaned) {
            done.add(item.key);
            options.onResult(item.key, cleaned);
          }
        } catch {
          // Best-effort; leave bubble without overlay on failure
        } finally {
          // Always release the slot so concurrency stays accurate across clear().
          active -= 1;
          if (!disposed && gen === generation) {
            inFlight.delete(item.key);
            options.onSettle?.(item.key);
          }
          pump();
        }
      })();
    }
  }

  return {
    enqueue(items) {
      if (disposed) return;
      for (const item of items) {
        const key = item.key;
        const text = stripModelTokens(typeof item.text === 'string' ? item.text : '');
        if (!key || !text) continue;
        if (done.has(key) || inFlight.has(key)) continue;
        inFlight.add(key);
        pending.push({ key, text });
      }
      pump();
    },
    clear() {
      generation += 1;
      pending.length = 0;
      inFlight.clear();
      done.clear();
      // Do not reset `active`; in-flight workers still own their slots until finally.
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending.length = 0;
      inFlight.clear();
      done.clear();
    },
    isBusy(key) {
      return inFlight.has(key);
    },
  };
}
