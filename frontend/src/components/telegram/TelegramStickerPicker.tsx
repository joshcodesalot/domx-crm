import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sticker } from 'lucide-react';
import {
  listTelegramStickerSet,
  listTelegramStickerSets,
  sendTelegramSticker,
  telegramStickerMediaUrl,
  type TelegramMessage,
  type TelegramPackSticker,
  type TelegramStickerSet,
} from '@/lib/api';

const LAST_PACK_PREFIX = 'domx_telegram_sticker_pack_';

function lastPackKey(creatorId: string) {
  return `${LAST_PACK_PREFIX}${creatorId}`;
}

function readLastPack(creatorId: string): string {
  try {
    return localStorage.getItem(lastPackKey(creatorId)) || '';
  } catch {
    return '';
  }
}

function writeLastPack(creatorId: string, shortName: string) {
  try {
    localStorage.setItem(lastPackKey(creatorId), shortName);
  } catch {
    // ignore
  }
}

function TelegramStickerTile({
  creatorId,
  sticker,
  disabled,
  sending,
  onSend,
}: {
  creatorId: string;
  sticker: TelegramPackSticker;
  disabled?: boolean;
  sending?: boolean;
  onSend: (sticker: TelegramPackSticker) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || sending}
      onClick={() => onSend(sticker)}
      title={sticker.emoji || 'Sticker'}
      className="relative aspect-square rounded-lg overflow-hidden hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
    >
      <img
        src={telegramStickerMediaUrl(creatorId, sticker.uniqueId, 'thumb')}
        alt={sticker.emoji || 'Sticker'}
        loading="lazy"
        decoding="async"
        className="w-full h-full object-contain p-0.5"
      />
      {sending ? (
        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
          <Loader2 className="w-4 h-4 text-white animate-spin" />
        </span>
      ) : null}
    </button>
  );
}

export default function TelegramStickerPicker({
  creatorId,
  peerId,
  disabled,
  replyToMessageId,
  onSent,
}: {
  creatorId: string;
  peerId: string;
  disabled?: boolean;
  replyToMessageId?: string;
  onSent: (message: TelegramMessage) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<TelegramStickerSet[]>([]);
  const [activeShortName, setActiveShortName] = useState('');
  const [stickers, setStickers] = useState<TelegramPackSticker[]>([]);
  const [loadingSets, setLoadingSets] = useState(false);
  const [loadingPack, setLoadingPack] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSet = useMemo(
    () => sets.find((set) => set.shortName === activeShortName) || null,
    [sets, activeShortName]
  );

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
    if (!open || !creatorId) return undefined;
    let cancelled = false;
    setLoadingSets(true);
    setError(null);
    void listTelegramStickerSets(creatorId)
      .then((result) => {
        if (cancelled) return;
        const nextSets = result.sets || [];
        setSets(nextSets);
        const remembered = readLastPack(creatorId);
        const next =
          nextSets.find((set) => set.shortName === remembered)?.shortName ||
          nextSets[0]?.shortName ||
          '';
        setActiveShortName(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load sticker packs');
      })
      .finally(() => {
        if (!cancelled) setLoadingSets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, creatorId]);

  useEffect(() => {
    if (!open || !creatorId || !activeShortName) {
      setStickers([]);
      return undefined;
    }
    let cancelled = false;
    setLoadingPack(true);
    setError(null);
    void listTelegramStickerSet(creatorId, activeShortName)
      .then((result) => {
        if (cancelled) return;
        setStickers(result.stickers || []);
        writeLastPack(creatorId, activeShortName);
      })
      .catch((err) => {
        if (cancelled) return;
        setStickers([]);
        setError(err instanceof Error ? err.message : 'Failed to load stickers');
      })
      .finally(() => {
        if (!cancelled) setLoadingPack(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, creatorId, activeShortName]);

  async function handleSend(sticker: TelegramPackSticker) {
    if (disabled || sendingId || !peerId) return;
    setSendingId(sticker.uniqueId);
    setError(null);
    try {
      const result = await sendTelegramSticker(creatorId, peerId, sticker.fileId, {
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      if (result.message) {
        onSent(result.message);
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send sticker');
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
        className={`p-2 rounded-xl transition-colors shrink-0 ${
          open
            ? 'text-domx-600 bg-domx-50 dark:text-domx-400 dark:bg-domx-500/10'
            : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800'
        } disabled:opacity-40`}
        title="Stickers"
        aria-label="Stickers"
        aria-expanded={open}
      >
        <Sticker className="w-5 h-5" />
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden z-30">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
            <p className="text-xs font-medium text-gray-600 dark:text-zinc-300 truncate">
              {activeSet?.title || 'Stickers'}
            </p>
          </div>
          <div className="h-56 overflow-y-auto p-2">
            {loadingSets || loadingPack ? (
              <div className="h-full flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : error ? (
              <p className="text-xs text-red-400 px-2 py-6 text-center">{error}</p>
            ) : stickers.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-zinc-500 px-2 py-6 text-center">
                {sets.length === 0
                  ? 'No sticker packs installed on this Telegram account.'
                  : 'This pack is empty.'}
              </p>
            ) : (
              <div className="grid grid-cols-5 gap-1">
                {stickers.map((sticker) => (
                  <TelegramStickerTile
                    key={sticker.uniqueId}
                    creatorId={creatorId}
                    sticker={sticker}
                    disabled={disabled}
                    sending={sendingId === sticker.uniqueId}
                    onSend={handleSend}
                  />
                ))}
              </div>
            )}
          </div>
          {sets.length > 0 ? (
            <div className="flex items-center gap-1 overflow-x-auto px-2 py-2 border-t border-gray-100 dark:border-zinc-800">
              {sets.map((set) => {
                const active = set.shortName === activeShortName;
                return (
                  <button
                    key={set.shortName}
                    type="button"
                    onClick={() => setActiveShortName(set.shortName)}
                    title={set.title}
                    className={`shrink-0 max-w-[7rem] truncate px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                      active
                        ? 'bg-domx-600 text-white'
                        : 'text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {set.title}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
