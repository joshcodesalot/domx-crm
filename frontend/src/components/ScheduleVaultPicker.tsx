import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react';
import { Folder, Loader2, X } from 'lucide-react';
import { TelegramVoiceTile } from '@/components/telegram/TelegramAudioPlayer';
import {
  friendlyVaultFolderName,
  vaultThumbUrl,
  vaultUploadId,
} from '@/components/maloum/MaloumChatPanels';
import {
  loadVaultListingCache,
  setVaultListingCache,
  vaultCacheKey,
} from '@/lib/vaultListingCache';
import {
  getFourBasedProfile,
  listAllMaloumVaultFolders,
  listFourBasedVault,
  listMaloumVaultMedia,
  listTelegramVault,
  listTelegramVaultFolders,
  pickFourBasedPreviewUrl,
  pickFourBasedSourceUrl,
  resolveFourBasedMediaSrc,
  telegramVaultMediaUrl,
  type FourBasedVaultItem,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
  type TelegramVaultItem,
} from '@/lib/api';

export type ScheduleVaultPick = {
  label: string;
  thumbUrl: string | null;
  payload: Record<string, unknown>;
};

function fourBasedItemId(item: FourBasedVaultItem): string {
  return String(item._id || item.id || '');
}

function fourBasedThumb(creatorId: string, item: FourBasedVaultItem): string | null {
  return resolveFourBasedMediaSrc(
    creatorId,
    pickFourBasedPreviewUrl(item.preview) || pickFourBasedSourceUrl(item.source)
  );
}

function maloumThumb(creatorId: string, item: MaloumVaultMediaItem): string | null {
  return vaultThumbUrl(creatorId, item);
}

export default function ScheduleVaultPicker({
  open,
  creatorId,
  platform,
  onClose,
  onSelect,
}: {
  open: boolean;
  creatorId: string;
  platform: '4based' | 'maloum' | 'telegram';
  onClose: () => void;
  onSelect: (pick: ScheduleVaultPick) => void;
}) {
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fourBasedItems, setFourBasedItems] = useState<FourBasedVaultItem[]>([]);
  const [maloumItems, setMaloumItems] = useState<MaloumVaultMediaItem[]>([]);
  const [telegramItems, setTelegramItems] = useState<TelegramVaultItem[]>([]);
  const offsetRef = useRef(0);
  const maloumNextRef = useRef<number | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);

  const loadFolders = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFourBasedItems([]);
    setMaloumItems([]);
    setTelegramItems([]);
    try {
      const folderKey = vaultCacheKey({
        platform,
        creatorId,
        kind: 'folders',
      });
      const cached = await loadVaultListingCache<{
        folders: Array<{ id: string; name: string }>;
      }>(folderKey);
      if (cached?.folders?.length) {
        setFolders(cached.folders);
        setFolderId(cached.folders[0]?.id || null);
      }
      if (platform === '4based') {
        const result = await getFourBasedProfile(creatorId);
        const names = (result.profile.folders || []).filter(
          (name): name is string => typeof name === 'string' && Boolean(name.trim())
        );
        const nextFolders = names.map((name) => ({ id: name, name }));
        setFolders(nextFolders);
        setFolderId(names[0] || null);
        setVaultListingCache(folderKey, { folders: nextFolders });
      } else if (platform === 'telegram') {
        const result = await listTelegramVaultFolders(creatorId);
        const list = (result.folders || []).map((folder) => ({
          id: folder.id,
          name: folder.name,
        }));
        const nextFolders = list.length ? list : [{ id: 'all', name: 'All' }];
        setFolders(nextFolders);
        setFolderId(nextFolders[0]?.id || 'all');
        setVaultListingCache(folderKey, { folders: nextFolders });
      } else {
        const result = await listAllMaloumVaultFolders(creatorId);
        const list = (result.folders || []).map((folder: MaloumVaultFolder) => ({
          id: String(folder._id),
          name: friendlyVaultFolderName(folder),
        }));
        setFolders(list);
        setFolderId(list[0]?.id || null);
        setVaultListingCache(folderKey, { folders: list });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vault');
    } finally {
      setLoading(false);
    }
  }, [creatorId, platform]);

  const loadMedia = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!folderId) return;
      const append = Boolean(opts?.append);
      if (append) {
        if (loadingMoreRef.current || !hasMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
        setFourBasedItems([]);
        setMaloumItems([]);
        setTelegramItems([]);
        offsetRef.current = 0;
        hasMoreRef.current = false;
        maloumNextRef.current = null;
      }
      setError(null);
      try {
        const mediaKey = vaultCacheKey({
          platform,
          creatorId,
          kind: 'media',
          folderId,
        });
        if (!append) {
          const cached = await loadVaultListingCache<{
            fourBasedItems?: FourBasedVaultItem[];
            maloumItems?: MaloumVaultMediaItem[];
          }>(mediaKey);
          if (cached?.fourBasedItems) setFourBasedItems(cached.fourBasedItems);
          if (cached?.maloumItems) setMaloumItems(cached.maloumItems);
        }
        if (platform === 'telegram') {
          const nextOffset = append ? offsetRef.current : 0;
          const result = await listTelegramVault(creatorId, {
            folderId: folderId === 'all' ? null : folderId,
            limit: 60,
            offset: nextOffset,
          });
          const items = result.items || [];
          setTelegramItems((prev) => (append ? [...prev, ...items] : items));
          offsetRef.current = nextOffset + items.length;
          hasMoreRef.current = Boolean(result.hasMore);
        } else if (platform === '4based') {
          const nextOffset = append ? offsetRef.current : 0;
          const result = await listFourBasedVault(creatorId, null, {
            limit: 60,
            offset: nextOffset,
            folder: folderId,
            fileType: 'image',
          });
          const items = result.items || [];
          setFourBasedItems((prev) => (append ? [...prev, ...items] : items));
          offsetRef.current = nextOffset + items.length;
          hasMoreRef.current = items.length >= 60;
          if (!append) setVaultListingCache(mediaKey, { fourBasedItems: items });
        } else {
          const result = await listMaloumVaultMedia(creatorId, folderId, {
            limit: 50,
            next:
              append && maloumNextRef.current != null
                ? maloumNextRef.current
                : undefined,
          });
          const items = (result.items || []).filter((item) => {
            const type = String(item.media?.type || item.thumbnail?.type || '').toLowerCase();
            return !type.includes('video');
          });
          setMaloumItems((prev) => (append ? [...prev, ...items] : items));
          if (!append) setVaultListingCache(mediaKey, { maloumItems: items });
          const next = result.next;
          maloumNextRef.current = next;
          hasMoreRef.current = next != null;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load vault');
      } finally {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    },
    [creatorId, folderId, platform]
  );

  useEffect(() => {
    if (!open) return;
    void loadFolders();
  }, [open, loadFolders]);

  useEffect(() => {
    if (!open || !folderId) return;
    void loadMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folderId]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight > 80) return;
    void loadMedia({ append: true });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-zinc-800">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">
            Pick from vault
          </p>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-44 shrink-0 border-r border-gray-200 dark:border-zinc-800 overflow-y-auto p-2 space-y-1">
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => setFolderId(folder.id)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-xs truncate ${
                  folder.id === folderId
                    ? 'bg-domx-600/15 text-domx-600'
                    : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Folder className="w-3.5 h-3.5 shrink-0" />
                {folder.name}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 overflow-y-auto p-3" onScroll={onScroll}>
            {loading && (
              <div className="flex justify-center py-10">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
              </div>
            )}
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {platform === '4based' &&
                fourBasedItems.map((item) => {
                  const id = fourBasedItemId(item);
                  const thumb = fourBasedThumb(creatorId, item);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() =>
                        onSelect({
                          label: item.name || id,
                          thumbUrl: thumb,
                          payload: {
                            vaultId: id,
                            vaultGuid:
                              typeof item.guid === 'string' ? item.guid : undefined,
                          },
                        })
                      }
                      className="aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800"
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-gray-400 p-2 block truncate">
                          {item.name || id}
                        </span>
                      )}
                    </button>
                  );
                })}
              {platform === 'telegram' &&
                telegramItems.map((item) => {
                  const isVoice = item.kind === 'voice';
                  const thumb = isVoice
                    ? ''
                    : telegramVaultMediaUrl(creatorId, item.id, 'thumb');
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        onSelect({
                          label: item.fileName || item.id,
                          thumbUrl: thumb,
                          payload: { vaultIds: [item.id], vaultId: item.id },
                        })
                      }
                      className="aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800"
                    >
                      {isVoice ? (
                        <TelegramVoiceTile duration={item.duration} />
                      ) : (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      )}
                    </button>
                  );
                })}
              {platform === 'maloum' &&
                maloumItems.map((item, index) => {
                  const mediaId = vaultUploadId(item);
                  const thumb = maloumThumb(creatorId, item);
                  if (!mediaId) return null;
                  return (
                    <button
                      key={`${mediaId}-${index}`}
                      type="button"
                      onClick={() =>
                        onSelect({
                          label: mediaId,
                          thumbUrl: thumb,
                          payload: { mediaId },
                        })
                      }
                      className="aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800"
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-gray-400 p-2 block truncate">
                          {mediaId}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
            {loadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
