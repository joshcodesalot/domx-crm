import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import {
  Box,
  Check,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Plus,
  Upload,
  Video,
  X,
} from 'lucide-react';
import VaultMediaLightbox from '@/components/VaultMediaLightbox';
import VaultMediaNoteModal, {
  VaultMediaNoteButton,
} from '@/components/VaultMediaNoteModal';
import { useAuth } from '@/context/AuthContext';
import {
  createTelegramVaultFolder,
  listTelegramVault,
  listTelegramVaultFolders,
  listTelegramVaultSent,
  listVaultMediaNotes,
  telegramVaultMediaUrl,
  uploadTelegramVaultItem,
  type TelegramVaultFolder,
  type TelegramVaultItem,
} from '@/lib/api';
import {
  getVaultListingCache,
  loadVaultListingCache,
  setVaultListingCache,
  vaultCacheKey,
} from '@/lib/vaultListingCache';

const PAGE_SIZE = 60;

type KindFilter = 'all' | 'photo' | 'video';
type SentFilter = 'all' | 'sent' | 'not_sent';

function formatDuration(seconds?: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function videoFrameThumb(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(blob);
    };
    const timer = window.setTimeout(() => finish(null), 4000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => finish(null);
    const capture = () => {
      try {
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        if (!width || !height) {
          finish(null);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82);
      } catch {
        finish(null);
      }
    };
    video.onloadeddata = () => {
      const duration = Number(video.duration);
      const seekTo =
        Number.isFinite(duration) && duration > 0
          ? Math.min(0.5, duration * 0.1)
          : 0.1;
      video.onseeked = capture;
      try {
        video.currentTime = seekTo;
      } catch {
        capture();
      }
    };
    video.src = url;
  });
}

function VaultThumbImg({
  src,
  kind,
}: {
  src: string;
  kind?: TelegramVaultItem['kind'];
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    const Icon = kind === 'video' ? Video : ImageIcon;
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500">
        <Icon className="w-6 h-6" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover opacity-80 group-hover:opacity-100"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export default function TelegramVaultModal({
  creatorId,
  fanId,
  mode = 'composer',
  selectedItems,
  onChangeSelected,
  onClose,
}: {
  creatorId: string;
  fanId: string | null;
  mode?: 'composer' | 'script';
  selectedItems: TelegramVaultItem[];
  onChangeSelected: (items: TelegramVaultItem[]) => void;
  onClose: () => void;
}) {
  const { hasPermission } = useAuth();
  const canEditNotes = hasPermission('vault.notes.edit');
  const [folders, setFolders] = useState<TelegramVaultFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [items, setItems] = useState<TelegramVaultItem[]>([]);
  const [selected, setSelected] = useState<TelegramVaultItem[]>(selectedItems);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [sentFilter, setSentFilter] = useState<SentFilter>('all');
  const [sentIds, setSentIds] = useState<Record<string, true>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TelegramVaultItem | null>(null);
  const [noteModal, setNoteModal] = useState<{
    mediaKey: string;
    note: string;
  } | null>(null);
  const hasMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelUploadRef = useRef(false);

  useEffect(() => {
    setSelected(selectedItems);
  }, [selectedItems]);

  const loadFolders = useCallback(async () => {
    const cacheKey = vaultCacheKey({
      platform: 'telegram',
      creatorId,
      kind: 'folders',
    });
    const cached = await loadVaultListingCache<{ folders: TelegramVaultFolder[] }>(
      cacheKey
    );
    if (cached?.folders?.length) {
      setFolders(cached.folders);
      setFolderId((prev) => prev || cached.folders[0]?.id || null);
    }
    try {
      const result = await listTelegramVaultFolders(creatorId);
      const next = result.folders || [];
      setFolders(next);
      setFolderId((prev) => {
        if (prev && next.some((folder) => folder.id === prev)) return prev;
        return next[0]?.id || null;
      });
      setVaultListingCache(cacheKey, { folders: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folders');
    }
  }, [creatorId]);

  const loadSent = useCallback(async () => {
    if (!fanId) {
      setSentIds({});
      return;
    }
    const cacheKey = vaultCacheKey({
      platform: 'telegram',
      creatorId,
      kind: 'sent',
      fanId,
    });
    const cached = getVaultListingCache<{ itemIds: string[] }>(cacheKey);
    if (cached?.itemIds) {
      setSentIds(Object.fromEntries(cached.itemIds.map((id) => [id, true])));
    }
    try {
      const result = await listTelegramVaultSent(creatorId, fanId);
      const ids = result.itemIds || [];
      setSentIds(Object.fromEntries(ids.map((id) => [id, true])));
      setVaultListingCache(cacheKey, { itemIds: ids });
    } catch {
      // sent overlay is optional
    }
  }, [creatorId, fanId]);

  const loadItems = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!folderId) return;
      const append = Boolean(opts?.append);
      if (append) {
        if (!hasMoreRef.current || loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
        offsetRef.current = 0;
        hasMoreRef.current = false;
      }
      setError(null);
      const offset = append ? offsetRef.current : 0;
      try {
        const result = await listTelegramVault(creatorId, {
          folderId,
          kind: kindFilter === 'all' ? undefined : kindFilter,
          fanId,
          limit: PAGE_SIZE,
          offset,
        });
        const incoming = result.items || [];
        setItems((prev) => (append ? [...prev, ...incoming] : incoming));
        offsetRef.current = offset + incoming.length;
        hasMoreRef.current = Boolean(result.hasMore);
        const keys = incoming.map((item) => item.id);
        if (keys.length) {
          const noteResult = await listVaultMediaNotes(creatorId, 'telegram', keys);
          setNotes((prev) => ({ ...prev, ...(noteResult.notes || {}) }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load vault');
      } finally {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    },
    [creatorId, fanId, folderId, kindFilter]
  );

  useEffect(() => {
    void loadFolders();
    void loadSent();
  }, [loadFolders, loadSent]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const visibleItems = useMemo(() => {
    if (sentFilter === 'all') return items;
    return items.filter((item) => {
      const sent = Boolean(item.sent || sentIds[item.id]);
      return sentFilter === 'sent' ? sent : !sent;
    });
  }, [items, sentFilter, sentIds]);

  function toggleItem(item: TelegramVaultItem) {
    setSelected((prev) => {
      const exists = prev.some((entry) => entry.id === item.id);
      return exists ? prev.filter((entry) => entry.id !== item.id) : [...prev, item];
    });
  }

  async function handleCreateFolder() {
    const name = folderDraft.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const result = await createTelegramVaultFolder(creatorId, name);
      setFolderDraft('');
      setFolders((prev) => [...prev, result.folder]);
      setFolderId(result.folder.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }

  function cancelUpload() {
    cancelUploadRef.current = true;
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length || !folderId || uploading) return;
    const queue = Array.from(files);
    cancelUploadRef.current = false;
    setUploading(true);
    setUploadProgress({ done: 0, total: queue.length });
    setError(null);
    let failed = 0;
    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (cancelUploadRef.current) break;
        setUploadProgress({ done: index + 1, total: queue.length });
        const file = queue[index];
        const form = new FormData();
        form.append('file', file);
        form.append('folderId', folderId);
        const isVideo =
          file.type.startsWith('video/') ||
          /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);
        if (isVideo) {
          const thumb = await videoFrameThumb(file);
          if (cancelUploadRef.current) break;
          if (thumb) {
            form.append('thumb', new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }));
          }
        }
        try {
          const result = await uploadTelegramVaultItem(creatorId, form);
          setItems((prev) => [result.item, ...prev.filter((item) => item.id !== result.item.id)]);
          if (kindFilter === 'all' || result.item.kind === kindFilter) {
            offsetRef.current += 1;
          }
        } catch (err) {
          failed += 1;
          setError(err instanceof Error ? err.message : 'Upload failed');
        }
      }
      if (cancelUploadRef.current && failed === 0) {
        setError(null);
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      cancelUploadRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return;
    void loadItems({ append: true });
  }

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center p-4 sm:p-6 animate-fade-in ${
        mode === 'script' ? 'z-[95]' : 'z-50'
      }`}
    >
      <button
        type="button"
        aria-label="Close vault"
        className="absolute inset-0 bg-black/30 dark:bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-slide-up">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60 bg-gray-50 dark:bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
              <Box className="w-5 h-5 text-domx-400" />
            </div>
            <div>
              <h3 className="font-bold text-lg text-gray-900 dark:text-white">
                {mode === 'script' ? 'Add media to script' : 'Media Vault'}
              </h3>
              <p className="text-xs text-gray-500 dark:text-zinc-400">
                {selected.length} item{selected.length === 1 ? '' : 's'} selected
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => void handleUpload(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!folderId || uploading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {uploading && uploadProgress
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}`
                : 'Upload'}
            </button>
            {uploading && (
              <button
                type="button"
                onClick={cancelUpload}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            )}
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected([])}
                className="px-3 py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white"
              >
                Clear Selection
              </button>
            )}
            <button
              type="button"
              onClick={() => onChangeSelected(selected)}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500"
            >
              {mode === 'script' ? 'Add to Script' : 'Insert Media'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg"
              aria-label="Close vault"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="w-48 sm:w-56 border-r border-gray-200 dark:border-zinc-800/60 bg-gray-100/40 dark:bg-zinc-900/20 p-3 overflow-y-auto hidden md:block shrink-0">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-3 px-2">
              Folders
            </h4>
            <ul className="space-y-1">
              {folders.map((folder) => {
                const active = folderId === folder.id;
                return (
                  <li key={folder.id}>
                    <button
                      type="button"
                      onClick={() => setFolderId(folder.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 truncate ${
                        active
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                          : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500 dark:text-zinc-400'
                      }`}
                    >
                      {active ? (
                        <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                      ) : (
                        <Folder className="w-4 h-4 shrink-0" />
                      )}
                      <span className="truncate">{folder.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex gap-1">
              <input
                value={folderDraft}
                onChange={(e) => setFolderDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreateFolder();
                  }
                }}
                placeholder="New folder"
                className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() => void handleCreateFolder()}
                disabled={!folderDraft.trim() || creatingFolder}
                className="p-1.5 rounded-lg border border-gray-200 dark:border-zinc-800 disabled:opacity-40"
                aria-label="Create folder"
              >
                {creatingFolder ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <div className="p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
              {(
                [
                  { id: 'all' as const, label: 'All Types' },
                  { id: 'photo' as const, label: 'Images', icon: ImageIcon },
                  { id: 'video' as const, label: 'Videos', icon: Video },
                ] as const
              ).map((chip) => {
                const Icon = 'icon' in chip ? chip.icon : null;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setKindFilter(chip.id)}
                    className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap flex items-center gap-1.5 ${
                      kindFilter === chip.id
                        ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                        : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-800'
                    }`}
                  >
                    {Icon && <Icon className="w-3 h-3" />}
                    {chip.label}
                  </button>
                );
              })}
            </div>
            <div className="px-3 pb-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto shrink-0">
              {(
                [
                  { id: 'all' as const, label: 'All' },
                  { id: 'sent' as const, label: 'Sent' },
                  { id: 'not_sent' as const, label: 'Not Sent' },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setSentFilter(chip.id)}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap ${
                    sentFilter === chip.id
                      ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                      : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-zinc-800'
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4" onScroll={handleScroll}>
              {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
              {loading && items.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
                </div>
              )}
              {!loading && visibleItems.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500">
                  {folderId
                    ? 'No media in this folder. Upload photos or videos to get started.'
                    : 'Create a folder to start the vault.'}
                </p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {visibleItems.map((item) => {
                  const src = telegramVaultMediaUrl(creatorId, item.id, 'thumb');
                  const isSelected = selected.some((entry) => entry.id === item.id);
                  const alreadySent = Boolean(item.sent || sentIds[item.id]);
                  const durationLabel = formatDuration(item.duration);
                  return (
                    <div
                      key={item.id}
                      className={`relative aspect-square rounded-xl overflow-hidden group ${
                        isSelected
                          ? 'ring-2 ring-domx-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950'
                          : 'border border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleItem(item)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setPreview(item);
                        }}
                        className="absolute inset-0 w-full h-full"
                        aria-label={item.kind === 'video' ? 'Select video' : 'Select image'}
                      >
                        <VaultThumbImg key={src} src={src} kind={item.kind} />
                      </button>
                      <VaultMediaNoteButton
                        hasNote={Boolean(notes[item.id]?.trim())}
                        onOpen={() =>
                          setNoteModal({
                            mediaKey: item.id,
                            note: notes[item.id] || '',
                          })
                        }
                      />
                      {alreadySent && (
                        <span className="absolute bottom-2 left-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded bg-domx-600/90 text-white pointer-events-none">
                          Sent
                        </span>
                      )}
                      {isSelected && (
                        <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-500 text-white flex items-center justify-center z-10 pointer-events-none">
                          <Check className="w-3.5 h-3.5" />
                        </span>
                      )}
                      {item.kind === 'video' && (
                        <span className="absolute bottom-2 right-2 z-10 text-[10px] font-medium px-1.5 py-0.5 rounded bg-black/70 text-white pointer-events-none">
                          {durationLabel || 'Video'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {loadingMore && (
                <div className="flex justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {preview && (
        <VaultMediaLightbox
          url={telegramVaultMediaUrl(creatorId, preview.id, 'full')}
          kind={preview.kind === 'video' ? 'video' : 'picture'}
          poster={telegramVaultMediaUrl(creatorId, preview.id, 'thumb')}
          onClose={() => setPreview(null)}
          zClassName="z-[100]"
        />
      )}
      {noteModal && (
        <VaultMediaNoteModal
          creatorId={creatorId}
          platform="telegram"
          mediaKey={noteModal.mediaKey}
          initialNote={noteModal.note}
          canEdit={canEditNotes}
          onClose={() => setNoteModal(null)}
          onSaved={(note) => {
            setNotes((prev) => ({ ...prev, [noteModal.mediaKey]: note }));
          }}
        />
      )}
    </div>
  );
}
