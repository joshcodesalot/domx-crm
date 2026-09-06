import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  listTelegramSavedGifs,
  searchTelegramGifs,
  sendTelegramGif,
  telegramGifMediaUrl,
  type TelegramGifItem,
  type TelegramMessage,
} from '@/lib/api';

function TelegramGifTile({
  creatorId,
  gif,
  disabled,
  sending,
  onSend,
}: {
  creatorId: string;
  gif: TelegramGifItem;
  disabled?: boolean;
  sending?: boolean;
  onSend: (gif: TelegramGifItem) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || sending}
      onClick={() => onSend(gif)}
      title="Send GIF"
      className="relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
    >
      <video
        src={telegramGifMediaUrl(creatorId, gif.uniqueId, 'full')}
        poster={telegramGifMediaUrl(creatorId, gif.uniqueId, 'thumb')}
        muted
        loop
        autoPlay
        playsInline
        preload="metadata"
        className="w-full h-full object-cover"
      />
      {sending ? (
        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
          <Loader2 className="w-4 h-4 text-white animate-spin" />
        </span>
      ) : null}
    </button>
  );
}

export default function TelegramGifPicker({
  creatorId,
  peerId,
  disabled,
  onSent,
}: {
  creatorId: string;
  peerId: string;
  disabled?: boolean;
  onSent: (message: TelegramMessage) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [gifs, setGifs] = useState<TelegramGifItem[]>([]);
  const [nextOffset, setNextOffset] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (searchTimerRef.current != null) {
      window.clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => {
      if (searchTimerRef.current != null) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, [query]);

  useEffect(() => {
    if (!open || !creatorId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextOffset('');
    const work = debouncedQuery
      ? searchTelegramGifs(creatorId, debouncedQuery).then((result) => ({
          gifs: result.gifs || [],
          nextOffset: result.nextOffset || '',
        }))
      : listTelegramSavedGifs(creatorId).then((result) => ({
          gifs: result.gifs || [],
          nextOffset: '',
        }));
    void work
      .then((result) => {
        if (cancelled) return;
        setGifs(result.gifs);
        setNextOffset(result.nextOffset);
      })
      .catch((err) => {
        if (cancelled) return;
        setGifs([]);
        setNextOffset('');
        setError(err instanceof Error ? err.message : 'Failed to load GIFs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, creatorId, debouncedQuery]);

  async function loadMore() {
    if (!debouncedQuery || !nextOffset || loading || loadingMore || !creatorId) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await searchTelegramGifs(creatorId, debouncedQuery, nextOffset);
      setGifs((prev) => {
        const seen = new Set(prev.map((gif) => gif.uniqueId));
        const extra = (result.gifs || []).filter((gif) => !seen.has(gif.uniqueId));
        return [...prev, ...extra];
      });
      setNextOffset(result.nextOffset || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more GIFs');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleSend(gif: TelegramGifItem) {
    if (disabled || sendingId || !peerId) return;
    setSendingId(gif.uniqueId);
    setError(null);
    try {
      const result = await sendTelegramGif(creatorId, peerId, {
        ...(gif.fileId ? { fileId: gif.fileId } : {}),
        ...(gif.queryId ? { queryId: gif.queryId } : {}),
        ...(gif.resultId ? { resultId: gif.resultId } : {}),
      });
      if (result.message) {
        onSent(result.message);
        setOpen(false);
        setQuery('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send GIF');
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={`px-2 h-9 rounded-xl text-[11px] font-semibold tracking-wide transition-colors shrink-0 ${
          open
            ? 'text-domx-600 bg-domx-50 dark:text-domx-400 dark:bg-domx-500/10'
            : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800'
        } disabled:opacity-40`}
        title="GIFs"
        aria-label="GIFs"
        aria-expanded={open}
      >
        GIF
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden z-30">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search GIFs…"
              className="w-full rounded-lg bg-gray-50 dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none"
            />
          </div>
          <div
            className="h-56 overflow-y-auto p-2"
            onScroll={(event) => {
              const el = event.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
                void loadMore();
              }
            }}
          >
            {loading ? (
              <div className="h-full flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : error ? (
              <p className="text-xs text-red-400 px-2 py-6 text-center">{error}</p>
            ) : gifs.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-zinc-500 px-2 py-6 text-center">
                {debouncedQuery
                  ? 'No GIFs match that search.'
                  : 'No saved GIFs on this Telegram account.'}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {gifs.map((gif) => (
                  <TelegramGifTile
                    key={gif.uniqueId}
                    creatorId={creatorId}
                    gif={gif}
                    disabled={disabled}
                    sending={sendingId === gif.uniqueId}
                    onSend={handleSend}
                  />
                ))}
              </div>
            )}
            {loadingMore ? (
              <div className="flex justify-center py-2 text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
