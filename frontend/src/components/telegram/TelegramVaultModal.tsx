import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type UIEvent,
} from 'react';
import {
  Box,
  Check,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Mic,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import VaultMediaLightbox from '@/components/VaultMediaLightbox';
import VaultMediaNoteModal, {
  VaultMediaNoteButton,
} from '@/components/VaultMediaNoteModal';
import TelegramAudioPlayer, {
  TelegramVoiceTile,
} from '@/components/telegram/TelegramAudioPlayer';
import { useAuth } from '@/context/AuthContext';
import {
  createTelegramVaultFolder,
  deleteTelegramVaultItems,
  listTelegramVault,
  listTelegramVaultFolders,
  listTelegramVaultSent,
  listVaultMediaNotes,
  isVaultUploadAborted,
  moveTelegramVaultItems,
  renameTelegramVaultFolder,
  telegramVaultMediaUrl,
  uploadTelegramVaultFile,
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
const MAX_VAULT_UPLOAD_BYTES = 1024 * 1024 * 1024;
const VAULT_MEDIA_EXT =
  /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?|mp4|mov|webm|mkv|avi|m4v|ogg|opus|mp3|m4a|wav|aac)$/i;

type KindFilter = 'all' | 'photo' | 'video' | 'voice';
type SentFilter = 'all' | 'sent' | 'not_sent';
type UploadAction = 'run' | 'skip' | 'stop' | 'cancel';

function currentUploadAction(ref: { current: UploadAction }): UploadAction {
  return ref.current;
}

function isVaultMediaFile(file: File): boolean {
  const mime = String(file.type || '');
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
    return true;
  }
  return VAULT_MEDIA_EXT.test(file.name);
}

function hasFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types || []).includes('Files');
}

function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const items = dt.items;
  if (items && items.length) {
    const files: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry && !entry.isFile) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return Array.from(dt.files || []);
}

function toFileList(files: File[]): FileList {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer.files;
}

function formatDuration(seconds?: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

type PreparedVaultMedia = {
  blob: Blob | null;
  width: number | null;
  height: number | null;
};

function videoFrameThumb(file: File): Promise<PreparedVaultMedia> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const finish = (
      blob: Blob | null,
      width: number | null = null,
      height: number | null = null
    ) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve({ blob, width, height });
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
        canvas.toBlob((blob) => finish(blob, width, height), 'image/jpeg', 0.82);
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

function photoFrameThumb(file: File): Promise<PreparedVaultMedia> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const finish = (blob: Blob | null, width: number | null, height: number | null) => {
      URL.revokeObjectURL(url);
      resolve({ blob, width, height });
    };
    image.onload = () => {
      const width = image.naturalWidth || 0;
      const height = image.naturalHeight || 0;
      if (!width || !height) {
        finish(null, null, null);
        return;
      }
      const canvas = document.createElement('canvas');
      const side = 320;
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        finish(null, width, height);
        return;
      }
      const scale = Math.max(side / width, side / height);
      const drawnWidth = width * scale;
      const drawnHeight = height * scale;
      ctx.drawImage(image, (side - drawnWidth) / 2, (side - drawnHeight) / 2, drawnWidth, drawnHeight);
      canvas.toBlob((blob) => finish(blob, width, height), 'image/jpeg', 0.8);
    };
    image.onerror = () => finish(null, null, null);
    image.src = url;
  });
}

function prepareVaultMedia(file: File): Promise<PreparedVaultMedia> {
  const isVideo =
    file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);
  const isPhoto =
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i.test(file.name);
  if (isVideo) return videoFrameThumb(file);
  if (isPhoto) return photoFrameThumb(file);
  return Promise.resolve({ blob: null, width: null, height: null });
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
    const Icon = kind === 'video' ? Video : kind === 'voice' ? Mic : ImageIcon;
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
  const { hasPermission, user } = useAuth();
  const canEditNotes = hasPermission('vault.notes.edit');
  const canDeleteVault = user?.role === 'owner' || user?.role === 'manager';
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
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    index: number;
    total: number;
    percent: number;
    fileName: string;
  } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
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
  const uploadActionRef = useRef<UploadAction>('run');
  const abortUploadRef = useRef<AbortController | null>(null);
  const resumeResolveRef = useRef<((action: 'resume' | 'skip' | 'cancel') => void) | null>(null);
  const renameBusyRef = useRef(false);
  const renameCancelRef = useRef(false);
  const dragDepthRef = useRef(0);
  const draggingItemIdsRef = useRef<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setSelected(selectedItems);
  }, [selectedItems]);

  useEffect(() => {
    return () => {
      uploadActionRef.current = 'cancel';
      abortUploadRef.current?.abort();
      resumeResolveRef.current?.('cancel');
      resumeResolveRef.current = null;
    };
  }, []);

  useEffect(() => {
    const blockNavigate = (event: globalThis.DragEvent) => {
      if (!hasFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', blockNavigate);
    window.addEventListener('drop', blockNavigate);
    return () => {
      window.removeEventListener('dragover', blockNavigate);
      window.removeEventListener('drop', blockNavigate);
    };
  }, []);

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

  function beginRename(folder: TelegramVaultFolder) {
    renameCancelRef.current = false;
    renameBusyRef.current = false;
    setRenamingFolderId(folder.id);
    setRenameDraft(folder.name);
  }

  async function commitRename(targetId: string) {
    if (renameBusyRef.current || renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    const name = renameDraft.trim();
    const current = folders.find((folder) => folder.id === targetId);
    if (!current || !name || name === current.name) {
      renameBusyRef.current = true;
      setRenamingFolderId(null);
      return;
    }
    if (name.length > 120) {
      setError('Folder name must be 120 characters or fewer');
      return;
    }
    renameBusyRef.current = true;
    setError(null);
    try {
      const result = await renameTelegramVaultFolder(creatorId, targetId, name);
      const next = folders.map((folder) =>
        folder.id === result.folder.id ? result.folder : folder
      );
      setFolders(next);
      setVaultListingCache(
        vaultCacheKey({ platform: 'telegram', creatorId, kind: 'folders' }),
        { folders: next }
      );
      setRenamingFolderId(null);
    } catch (err) {
      renameBusyRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to rename folder');
    }
  }

  function cancelRename() {
    renameCancelRef.current = true;
    renameBusyRef.current = true;
    setRenamingFolderId(null);
  }

  function skipUpload() {
    uploadActionRef.current = 'skip';
    if (resumeResolveRef.current) {
      resumeResolveRef.current('skip');
      resumeResolveRef.current = null;
      return;
    }
    abortUploadRef.current?.abort();
  }

  function stopUpload() {
    uploadActionRef.current = 'stop';
    setUploadPaused(true);
    abortUploadRef.current?.abort();
  }

  function cancelUpload() {
    uploadActionRef.current = 'cancel';
    abortUploadRef.current?.abort();
    if (resumeResolveRef.current) {
      resumeResolveRef.current('cancel');
      resumeResolveRef.current = null;
    }
  }

  function resumeUpload() {
    uploadActionRef.current = 'run';
    setUploadPaused(false);
    resumeResolveRef.current?.('resume');
    resumeResolveRef.current = null;
  }

  function waitForResume(): Promise<'resume' | 'skip' | 'cancel'> {
    setUploadPaused(true);
    return new Promise((resolve) => {
      resumeResolveRef.current = resolve;
    });
  }

  const canDrop = Boolean(folderId) && !uploading;

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragging(false);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!canDrop || !hasFileDrag(event.dataTransfer)) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.dataTransfer) return;
    event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }

  function queueVaultFiles(input: File[] | FileList | null, targetFolderId?: string) {
    const destFolder = targetFolderId || folderId;
    if (!input?.length || !destFolder || uploading) return;
    const raw = Array.from(input);
    const accepted: File[] = [];
    let skippedType = 0;
    let skippedSize = 0;
    for (const file of raw) {
      if (!isVaultMediaFile(file)) {
        skippedType += 1;
        continue;
      }
      if (file.size > MAX_VAULT_UPLOAD_BYTES) {
        skippedSize += 1;
        continue;
      }
      accepted.push(file);
    }
    const warningParts: string[] = [];
    if (skippedType) warningParts.push('Only photos, videos, and audio can be added to the vault');
    if (skippedSize) warningParts.push('Files larger than 1 GB were skipped');
    const warning = warningParts.length ? `${warningParts.join('. ')}.` : null;
    if (!accepted.length) {
      setError(warning || 'No photos, videos, or audio to upload.');
      return;
    }
    void handleUpload(toFileList(accepted), warning, destFolder);
  }

  async function moveItemsToFolder(itemIds: string[], destFolderId: string) {
    if (!itemIds.length || destFolderId === folderId) return;
    setError(null);
    try {
      await moveTelegramVaultItems(creatorId, itemIds, destFolderId);
      const moving = new Set(itemIds);
      setItems((prev) => prev.filter((item) => !moving.has(item.id)));
      setSelected((prev) => prev.filter((item) => !moving.has(item.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move vault items');
    }
  }

  async function deleteSelectedItems() {
    if (!canDeleteVault || !selected.length || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTelegramVaultItems(
        creatorId,
        selected.map((item) => item.id)
      );
      const removing = new Set(selected.map((item) => item.id));
      setItems((prev) => prev.filter((item) => !removing.has(item.id)));
      setSelected([]);
      setDeleteArmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete vault items');
    } finally {
      setDeleting(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    resetDragState();
    if (!canDrop) return;
    queueVaultFiles(filesFromDataTransfer(event.dataTransfer));
  }

  async function handleUpload(
    files: FileList | null,
    warning?: string | null,
    targetFolderId?: string
  ) {
    const destFolder = targetFolderId || folderId;
    if (!files?.length || !destFolder || uploading) return;
    const queue = Array.from(files);
    uploadActionRef.current = 'run';
    resetDragState();
    setUploading(true);
    setUploadPaused(false);
    setUploadProgress({
      index: 1,
      total: queue.length,
      percent: 0,
      fileName: queue[0]?.name || 'file',
    });
    setError(warning || null);
    let index = 0;
    try {
      while (index < queue.length) {
        if (currentUploadAction(uploadActionRef) === 'cancel') break;
        if (currentUploadAction(uploadActionRef) === 'stop') {
          const decision = await waitForResume();
          if (decision === 'cancel') break;
          if (decision === 'skip') {
            index += 1;
            uploadActionRef.current = 'run';
            setUploadPaused(false);
            continue;
          }
          uploadActionRef.current = 'run';
          setUploadPaused(false);
        }
        const file = queue[index];
        setUploadProgress({
          index: index + 1,
          total: queue.length,
          percent: 0,
          fileName: file.name,
        });
        const prepared = await prepareVaultMedia(file);
        if (currentUploadAction(uploadActionRef) === 'cancel') break;
        if (currentUploadAction(uploadActionRef) === 'skip') {
          uploadActionRef.current = 'run';
          index += 1;
          continue;
        }
        if (currentUploadAction(uploadActionRef) === 'stop') continue;
        const controller = new AbortController();
        abortUploadRef.current = controller;
        try {
          const result = await uploadTelegramVaultFile(creatorId, {
            folderId: destFolder,
            file,
            thumb: prepared.blob,
            width: prepared.width,
            height: prepared.height,
            signal: controller.signal,
            onProgress: (percent) => {
              setUploadProgress({
                index: index + 1,
                total: queue.length,
                percent,
                fileName: file.name,
              });
            },
          });
          if (destFolder === folderId) {
            setItems((prev) => [result.item, ...prev.filter((item) => item.id !== result.item.id)]);
            if (kindFilter === 'all' || result.item.kind === kindFilter) {
              offsetRef.current += 1;
            }
          }
          index += 1;
          const action = currentUploadAction(uploadActionRef);
          if (action === 'skip') uploadActionRef.current = 'run';
          if (action === 'cancel') break;
        } catch (err) {
          if (isVaultUploadAborted(err)) {
            const action = currentUploadAction(uploadActionRef);
            if (action === 'skip') {
              uploadActionRef.current = 'run';
              index += 1;
              continue;
            }
            if (action === 'stop') continue;
            break;
          }
          setError(err instanceof Error ? err.message : 'Upload failed');
          index += 1;
        } finally {
          if (abortUploadRef.current === controller) abortUploadRef.current = null;
        }
      }
    } finally {
      setUploading(false);
      setUploadPaused(false);
      setUploadProgress(null);
      uploadActionRef.current = 'run';
      resumeResolveRef.current = null;
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
              accept="image/*,video/*,audio/*,.ogg,.opus,.mp3,.m4a,.wav,.aac"
              multiple
              className="hidden"
              onChange={(e) => queueVaultFiles(e.target.files)}
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
                ? uploadPaused
                  ? `Paused ${uploadProgress.index}/${uploadProgress.total}`
                  : `${uploadProgress.percent}% · ${uploadProgress.index}/${uploadProgress.total}`
                : 'Upload'}
            </button>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelected([]);
                  setDeleteArmed(false);
                }}
                className="px-3 py-2 text-sm text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white"
              >
                Clear Selection
              </button>
            )}
            {canDeleteVault && selected.length > 0 && (
              <button
                type="button"
                onClick={() => setDeleteArmed(true)}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                Delete
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

        {uploading && uploadProgress && (
          <div className="px-5 py-3 border-b border-gray-200 dark:border-zinc-800/60 bg-gray-50 dark:bg-zinc-900/40">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-sm text-gray-700 dark:text-zinc-200 truncate">
                <span className="font-medium">{uploadProgress.fileName}</span>
                {' · '}
                {uploadPaused ? 'Paused' : `${uploadProgress.percent}%`}
                {' · '}
                {uploadProgress.index}/{uploadProgress.total}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={skipUpload}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  Skip
                </button>
                {uploadPaused ? (
                  <button
                    type="button"
                    onClick={resumeUpload}
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopUpload}
                    className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelUpload}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-gray-200 dark:bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-domx-500 transition-[width] duration-150"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
          </div>
        )}

        {deleteArmed && canDeleteVault && selected.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30">
            <p className="text-sm text-red-800 dark:text-red-200">
              Delete {selected.length} item{selected.length === 1 ? '' : 's'} from the vault? This
              cannot be undone.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setDeleteArmed(false)}
                disabled={deleting}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void deleteSelectedItems()}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="w-48 sm:w-56 border-r border-gray-200 dark:border-zinc-800/60 bg-gray-100/40 dark:bg-zinc-900/20 p-3 overflow-y-auto hidden md:block shrink-0">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-3 px-2">
              Folders
            </h4>
            <ul className="space-y-1">
              {folders.map((folder) => {
                const active = folderId === folder.id;
                const dropTarget = dropFolderId === folder.id;
                const renaming = renamingFolderId === folder.id;
                return (
                  <li
                    key={folder.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!event.dataTransfer) return;
                      if (uploading && hasFileDrag(event.dataTransfer)) {
                        event.dataTransfer.dropEffect = 'none';
                        return;
                      }
                      event.dataTransfer.dropEffect = hasFileDrag(event.dataTransfer)
                        ? 'copy'
                        : 'move';
                      setDropFolderId(folder.id);
                    }}
                    onDragLeave={(event) => {
                      const next = event.relatedTarget;
                      if (next instanceof Node && event.currentTarget.contains(next)) return;
                      setDropFolderId((current) => (current === folder.id ? null : current));
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDropFolderId(null);
                      if (hasFileDrag(event.dataTransfer)) {
                        queueVaultFiles(filesFromDataTransfer(event.dataTransfer), folder.id);
                        return;
                      }
                      const ids = draggingItemIdsRef.current;
                      draggingItemIdsRef.current = [];
                      if (!ids.length) return;
                      void moveItemsToFolder(ids, folder.id);
                    }}
                  >
                    {renaming ? (
                      <input
                        value={renameDraft}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitRename(folder.id);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelRename();
                          }
                        }}
                        onBlur={() => {
                          void commitRename(folder.id);
                        }}
                        className="w-full px-2 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                        aria-label={`Rename ${folder.name}`}
                      />
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setFolderId(folder.id)}
                          className={`min-w-0 flex-1 text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                            dropTarget
                              ? 'bg-domx-600/15 text-gray-900 dark:text-white ring-1 ring-domx-500'
                              : active
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
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            beginRename(folder);
                          }}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 shrink-0"
                          aria-label={`Rename ${folder.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
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
                  { id: 'voice' as const, label: 'Audio', icon: Mic },
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

            <div className="flex-1 relative min-h-0">
              <div
                className="absolute inset-0 overflow-y-auto p-4"
                onScroll={handleScroll}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
              {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
              {loading && items.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
                </div>
              )}
              {!loading && visibleItems.length === 0 && (
                folderId ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!canDrop}
                    className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 py-16 px-4 text-sm text-gray-500 dark:text-zinc-400 hover:border-domx-500/50 hover:text-gray-800 dark:hover:text-zinc-200 disabled:opacity-50 disabled:hover:border-gray-300 dark:disabled:hover:border-zinc-700 disabled:hover:text-gray-500 dark:disabled:hover:text-zinc-400"
                  >
                    <span className="flex flex-col items-center gap-2">
                      <Upload className="w-6 h-6" />
                      Drop photos, videos, or audio here, or click to browse.
                    </span>
                  </button>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-zinc-500">
                    Create a folder to start the vault.
                  </p>
                )
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
                        draggable
                        onDragStart={(event) => {
                          const ids = selected.some((entry) => entry.id === item.id)
                            ? selected.map((entry) => entry.id)
                            : [item.id];
                          draggingItemIdsRef.current = ids;
                          event.dataTransfer.setData('text/plain', ids.join(','));
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          draggingItemIdsRef.current = [];
                          setDropFolderId(null);
                        }}
                        onClick={() => toggleItem(item)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setPreview(item);
                        }}
                        className="absolute inset-0 w-full h-full"
                        aria-label={
                          item.kind === 'video'
                            ? 'Select video'
                            : item.kind === 'voice'
                              ? 'Select voice note'
                              : 'Select image'
                        }
                      >
                        {item.kind === 'voice' ? (
                          <TelegramVoiceTile duration={item.duration} />
                        ) : (
                          <VaultThumbImg key={src} src={src} kind={item.kind} />
                        )}
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
              {isDragging && canDrop && (
                <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center border-2 border-dashed border-domx-500 bg-domx-600/10 rounded-none">
                  <div className="flex flex-col items-center gap-2 text-domx-600 dark:text-domx-400">
                    <Upload className="w-8 h-8" />
                    <span className="text-sm font-medium">Drop to upload</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {preview && preview.kind === 'voice' ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 dark:bg-black/70 p-6 animate-fade-in">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close preview"
            onClick={() => setPreview(null)}
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-2xl">
            <TelegramAudioPlayer
              src={telegramVaultMediaUrl(creatorId, preview.id, 'full')}
              duration={preview.duration}
              fileName={preview.fileName}
              variant="neutral"
            />
          </div>
        </div>
      ) : preview ? (
        <VaultMediaLightbox
          url={telegramVaultMediaUrl(creatorId, preview.id, 'full')}
          kind={preview.kind === 'video' ? 'video' : 'picture'}
          poster={telegramVaultMediaUrl(creatorId, preview.id, 'thumb')}
          onClose={() => setPreview(null)}
          zClassName="z-[100]"
        />
      ) : null}
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
