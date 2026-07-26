const HISTORY_TRANSLATE_API_URL = 'https://translate.low7labs.cloud/translate';
const DEFAULT_CONCURRENCY = 4;

export type HistoryTranslateItem = {
  key: string;
  text: string;
};

export async function translateTextToEnglish(
  text: string
): Promise<string | null> {
  if (!text.trim()) return null;
  const response = await fetch(HISTORY_TRANSLATE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'de',
      target: 'en',
      format: 'text',
    }),
  });
  if (!response.ok) {
    throw new Error('Translation API failed with status ' + response.status);
  }
  const data = (await response.json()) as { translatedText?: string };
  return data?.translatedText?.trim() || null;
}

export type HistoryTranslateQueue = {
  enqueue: (items: HistoryTranslateItem[]) => void;
  clear: () => void;
  dispose: () => void;
  isBusy: (key: string) => boolean;
};

type CreateHistoryTranslateQueueOptions = {
  concurrency?: number;
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
  const translate = options.translate ?? translateTextToEnglish;
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
          if (translated) {
            done.add(item.key);
            options.onResult(item.key, translated);
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
        const text = typeof item.text === 'string' ? item.text.trim() : '';
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
