import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  Box,
  CalendarClock,
  Check,
  Folder,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  Newspaper,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import VaultMediaLightbox from '@/components/VaultMediaLightbox';
import ScheduleDateTimePicker from '@/components/ScheduleDateTimePicker';
import maloumIcon from '@/assets/maloum_icon.png';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useToast } from '@/context/ToastContext';
import {
  formatRelativeTime,
  friendlyVaultFolderName,
  isVideoAsset,
  vaultDirectUrl,
  vaultPreviewFromItem,
  vaultUploadId,
} from '@/components/maloum/MaloumChatPanels';
import {
  createMaloumPost,
  deleteMaloumPost,
  getCreators,
  listMaloumCategories,
  listMaloumMyPosts,
  listAllMaloumVaultFolders,
  listMaloumVaultMedia,
  maloumMediaUrl,
  translateToGerman,
  uploadMaloumFeedPhoto,
  createScheduledContent,
  type Creator,
  type MaloumCategory,
  type MaloumFeedPost,
  type MaloumVaultFolder,
  type MaloumVaultMediaItem,
} from '@/lib/api';
import { berlinNowParts, berlinWallToIso, useStaffTimeZone } from '@/lib/berlinTime';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const MAX_CATEGORIES = 3;

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function parseHashtags(description: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const re = /#([\p{L}\p{N}_]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(description)) !== null) {
    const tag = String(match[1] || '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function stripHashtags(text: string): string {
  return text
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reattachHashtags(translated: string, tags: string[]): string {
  const existing = new Set(
    parseHashtags(translated).map((tag) => tag.toLowerCase())
  );
  const missing = tags.filter((tag) => !existing.has(tag.toLowerCase()));
  if (missing.length === 0) return translated.trim();
  return `${translated.trim()} ${missing.map((tag) => `#${tag}`).join(' ')}`.trim();
}

function nearScrollEnd(
  target: HTMLElement,
  thresholdPx = 80,
  axis: 'vertical' | 'horizontal' = 'vertical'
): boolean {
  if (axis === 'horizontal') {
    const remaining =
      target.scrollWidth - target.scrollLeft - target.clientWidth;
    return remaining <= thresholdPx;
  }
  const remaining =
    target.scrollHeight - target.scrollTop - target.clientHeight;
  return remaining <= thresholdPx;
}

function mergeVaultMediaItems(
  prev: MaloumVaultMediaItem[],
  incoming: MaloumVaultMediaItem[]
): MaloumVaultMediaItem[] {
  const seen = new Set(
    prev.map((item) => vaultUploadId(item)).filter(Boolean) as string[]
  );
  const next = [...prev];
  for (const item of incoming) {
    const id = vaultUploadId(item);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    next.push(item);
  }
  return next;
}

function friendlyCategoryName(name: string): string {
  const raw = (name || '').trim();
  if (!raw || raw === '__default__') return raw || 'Category';
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function postThumbUrl(creatorId: string, post: MaloumFeedPost): string | null {
  const thumb = post.thumbnail;
  if (thumb?.url && /^https?:\/\//i.test(thumb.url)) return thumb.url;
  if (thumb?.uploadId) {
    return maloumMediaUrl(creatorId, {
      uploadId: thumb.uploadId,
      variant: 'thumbnail',
    });
  }
  const media = Array.isArray(post.media) ? post.media[0] : null;
  if (media?.url && /^https?:\/\//i.test(media.url)) return media.url;
  if (media?.uploadId) {
    return maloumMediaUrl(creatorId, {
      uploadId: media.uploadId,
      variant: 'thumbnail',
    });
  }
  return null;
}

export default function MaloumFeed() {
  const { onSyncEvent } = useStaffSync();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [posts, setPosts] = useState<MaloumFeedPost[]>([]);
  const [postsNext, setPostsNext] = useState<string | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [mediaSource, setMediaSource] = useState<'upload' | 'vault'>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadFolderId, setUploadFolderId] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [posting, setPosting] = useState(false);
  const [postPhase, setPostPhase] = useState<'idle' | 'uploading' | 'creating'>(
    'idle'
  );
  const [postError, setPostError] = useState<string | null>(null);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );
  const timeZone = useStaffTimeZone();
  const berlin = berlinNowParts(timeZone);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(berlin.date);
  const [scheduleTime, setScheduleTime] = useState(berlin.time);

  const [categories, setCategories] = useState<MaloumCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<MaloumVaultFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<MaloumVaultMediaItem[]>([]);
  const [vaultMediaNext, setVaultMediaNext] = useState<number | null>(null);
  const [vaultFoldersLoading, setVaultFoldersLoading] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItem, setSelectedVaultItem] =
    useState<MaloumVaultMediaItem | null>(null);
  const [vaultPreview, setVaultPreview] = useState<{
    url: string;
    kind: 'picture' | 'video' | 'embed';
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingMoreMediaRef = useRef(false);
  const vaultMediaNextRef = useRef<number | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const postCategories = useMemo(
    () =>
      categories.filter((c) => {
        const type = (c.type || '').toUpperCase();
        if (!type) return true;
        return type === 'POST' || type === 'ALL';
      }),
    [categories]
  );

  const filteredCategories = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    const list = postCategories.filter((c) => c.name !== '__default__');
    if (!q) return list;
    return list.filter((c) => {
      const name = friendlyCategoryName(c.name || '').toLowerCase();
      return name.includes(q) || (c.name || '').toLowerCase().includes(q);
    });
  }, [postCategories, categoryQuery]);

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const maloum = list.filter((c) => c.platform === 'maloum');
      setCreators(maloum);
      setSelectedCreatorId((prev) => prev || maloum[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const loadPosts = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) setPostsLoading(true);
      setPostsError(null);
      try {
        const result = await listMaloumMyPosts(selectedCreatorId, {
          limit: 15,
          next: opts?.next || undefined,
        });
        setPosts((prev) =>
          append ? [...prev, ...(result.posts || [])] : result.posts || []
        );
        setPostsNext(result.next || null);
      } catch (err) {
        setPostsError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setPostsLoading(false);
      }
    },
    [selectedCreatorId]
  );

  const loadCategories = useCallback(async () => {
    if (!selectedCreatorId) return;
    setCategoriesLoading(true);
    try {
      const result = await listMaloumCategories(selectedCreatorId);
      setCategories(result.categories || []);
    } catch {
      setCategories([]);
    } finally {
      setCategoriesLoading(false);
    }
  }, [selectedCreatorId]);

  const loadUploadFolders = useCallback(async () => {
    if (!selectedCreatorId) return;
    try {
      const result = await listAllMaloumVaultFolders(selectedCreatorId);
      setVaultFolders(result.folders || []);
    } catch {
      // Folder list is optional until user opens vault / uploads
    }
  }, [selectedCreatorId]);

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    return onSyncEvent(() => {
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  useEffect(() => {
    setPosts([]);
    setPostsNext(null);
    setPostError(null);
    setSelectedCategoryIds([]);
    setSelectedVaultItem(null);
    setUploadFile(null);
    setUploadFolderId(null);
    setVaultFolders([]);
    setSelectedFolderId(null);
    setVaultItems([]);
    setVaultError(null);
    vaultMediaNextRef.current = null;
    setVaultMediaNext(null);
    setDraft('');
    setIsPublic(true);
    if (selectedCreatorId) {
      void loadPosts();
      void loadCategories();
      void loadUploadFolders();
    }
  }, [selectedCreatorId, loadPosts, loadCategories, loadUploadFolders]);

  useEffect(() => {
    if (!uploadFile) {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(uploadFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadFile]);

  const loadVaultFolders = useCallback(async () => {
    if (!selectedCreatorId) return;
    setVaultFoldersLoading(true);
    setVaultError(null);
    try {
      const result = await listAllMaloumVaultFolders(selectedCreatorId);
      setVaultFolders(result.folders || []);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
    } finally {
      setVaultFoldersLoading(false);
    }
  }, [selectedCreatorId]);

  const loadVaultMedia = useCallback(
    async (opts?: { append?: boolean; next?: number | null; folderId?: string }) => {
      if (!selectedCreatorId) return;
      const folderId = opts?.folderId || selectedFolderId;
      if (!folderId) return;
      const append = Boolean(opts?.append);
      if (append) {
        if (
          loadingMoreMediaRef.current ||
          opts?.next == null ||
          !Number.isFinite(opts.next)
        ) {
          return;
        }
        loadingMoreMediaRef.current = true;
        setLoadingMoreMedia(true);
      } else {
        setVaultLoading(true);
        setVaultItems([]);
        vaultMediaNextRef.current = null;
        setVaultMediaNext(null);
      }
      setVaultError(null);
      try {
        const result = await listMaloumVaultMedia(selectedCreatorId, folderId, {
          limit: 50,
          next: append && opts?.next != null ? opts.next : undefined,
        });
        const items = (result.items || []).filter(
          (item) => !isVideoAsset(item.media?.type)
        );
        const next =
          typeof result.next === 'number' && Number.isFinite(result.next)
            ? result.next
            : null;
        vaultMediaNextRef.current = next;
        setVaultMediaNext(next);
        setVaultItems((prev) =>
          append ? mergeVaultMediaItems(prev, items) : items
        );
      } catch (err) {
        setVaultError(err instanceof Error ? err.message : 'Failed to load media');
      } finally {
        if (append) {
          loadingMoreMediaRef.current = false;
          setLoadingMoreMedia(false);
        } else {
          setVaultLoading(false);
        }
      }
    },
    [selectedCreatorId, selectedFolderId]
  );

  const openVault = useCallback(async () => {
    if (!selectedCreatorId) return;
    setVaultOpen(true);
    setSelectedFolderId(null);
    setVaultItems([]);
    setVaultError(null);
    vaultMediaNextRef.current = null;
    setVaultMediaNext(null);
    setVaultFolders([]);
    await loadVaultFolders();
  }, [selectedCreatorId, loadVaultFolders]);

  useEffect(() => {
    if (!vaultOpen || !selectedFolderId || !selectedCreatorId) return;
    void loadVaultMedia({ folderId: selectedFolderId });
  }, [vaultOpen, selectedFolderId, selectedCreatorId, loadVaultMedia]);

  const handleVaultMediaScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!nearScrollEnd(event.currentTarget)) return;
      const next = vaultMediaNextRef.current;
      if (next == null) return;
      void loadVaultMedia({ append: true, next });
    },
    [loadVaultMedia]
  );

  const toggleCategory = useCallback((id: string) => {
    setSelectedCategoryIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_CATEGORIES) return prev;
      return [...prev, id];
    });
  }, []);

  const resetCompose = useCallback(() => {
    setDraft('');
    setUploadFile(null);
    setSelectedVaultItem(null);
    setSelectedCategoryIds([]);
    setIsPublic(true);
    setPostError(null);
    setPostPhase('idle');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handlePost = useCallback(async () => {
    if (!selectedCreatorId || posting || translatingOutgoing) return;
    if (selectedCategoryIds.length === 0) {
      setPostError('Select at least one category (up to 3)');
      return;
    }
    if (mediaSource === 'upload' && !uploadFile) {
      setPostError('Choose a photo to upload');
      return;
    }
    if (mediaSource === 'upload' && !uploadFolderId) {
      setPostError('Select a vault folder for the upload');
      return;
    }
    if (mediaSource === 'vault' && !selectedVaultItem) {
      setPostError('Select a photo from the vault');
      return;
    }

    setPosting(true);
    setPostError(null);
    try {
      if (scheduleEnabled) {
        if (mediaSource === 'upload' && uploadFile) {
          await createScheduledContent({
            kind: 'feed_post',
            creatorId: selectedCreatorId,
            platform: 'maloum',
            runAt: berlinWallToIso(scheduleDate, scheduleTime, timeZone),
            bodyText: draft.trim(),
            payload: {
              folderId: uploadFolderId,
              categories: selectedCategoryIds,
              public: isPublic,
            },
            file: uploadFile,
          });
        } else if (selectedVaultItem) {
          const mediaId = vaultUploadId(selectedVaultItem);
          if (!mediaId) throw new Error('Could not resolve media id');
          await createScheduledContent({
            kind: 'feed_post',
            creatorId: selectedCreatorId,
            platform: 'maloum',
            runAt: berlinWallToIso(scheduleDate, scheduleTime, timeZone),
            bodyText: draft.trim(),
            payload: {
              mediaId,
              categories: selectedCategoryIds,
              public: isPublic,
            },
          });
        }
        toast.success(`Post scheduled (${timeZone})`);
        resetCompose();
        return;
      }

      let mediaId: string | null = null;
      if (mediaSource === 'upload' && uploadFile && uploadFolderId) {
        setPostPhase('uploading');
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('folderId', uploadFolderId);
        const uploaded = await uploadMaloumFeedPhoto(selectedCreatorId, form);
        mediaId = uploaded.uploadId;
      } else if (selectedVaultItem) {
        mediaId = vaultUploadId(selectedVaultItem);
      }
      if (!mediaId) throw new Error('Could not resolve media id');

      let caption = draft.trim();
      if (caption && autoTranslateOutgoing) {
        setTranslatingOutgoing(true);
        try {
          const tags = parseHashtags(caption);
          const body = stripHashtags(caption);
          if (body) {
            caption = reattachHashtags(await translateToGerman(body), tags);
          } else {
            caption = tags.map((tag) => `#${tag}`).join(' ');
          }
          setDraft(caption);
        } finally {
          setTranslatingOutgoing(false);
        }
      }

      setPostPhase('creating');
      await createMaloumPost(selectedCreatorId, {
        caption,
        categories: selectedCategoryIds,
        public: isPublic,
        mediaIds: [mediaId],
      });
      toast.success('Post published');
      resetCompose();
      await loadPosts();
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to create post');
    } finally {
      setPosting(false);
      setPostPhase('idle');
    }
  }, [
    selectedCreatorId,
    posting,
    translatingOutgoing,
    selectedCategoryIds,
    mediaSource,
    uploadFile,
    uploadFolderId,
    selectedVaultItem,
    draft,
    autoTranslateOutgoing,
    isPublic,
    toast,
    resetCompose,
    loadPosts,
    scheduleEnabled,
    scheduleDate,
    scheduleTime,
    timeZone,
  ]);

  const handleDelete = useCallback(
    async (postId: string) => {
      if (!selectedCreatorId || deletingId) return;
      const ok = await confirm({
        title: 'Delete post?',
        message: 'This removes the post from the creator feed on Maloum.',
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(postId);
      try {
        await deleteMaloumPost(selectedCreatorId, postId);
        setPosts((prev) => prev.filter((p) => p._id !== postId));
        toast.success('Post deleted');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete post');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId, confirm, toast]
  );

  const canPost =
    !posting &&
    !translatingOutgoing &&
    selectedCategoryIds.length > 0 &&
    ((mediaSource === 'upload' && Boolean(uploadFile) && Boolean(uploadFolderId)) ||
      (mediaSource === 'vault' && Boolean(selectedVaultItem)));

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Feed
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              Loading creators…
            </p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              No Maloum creators yet. Connect one from Manage Creators.
            </p>
          )}
          {creators.map((creator) => {
            const active = selectedCreatorId === creator.id;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all ${
                  active
                    ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={creator.avatarUrl}
                  displayName={creator.displayName}
                  className="w-10 h-10 rounded-full object-cover shrink-0"
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-orange-400 to-rose-500"
                />
                <span
                  className={`text-sm truncate ${
                    active
                      ? 'font-semibold text-gray-900 dark:text-white'
                      : 'font-medium text-gray-700 dark:text-zinc-300'
                  }`}
                >
                  {creator.displayName}
                </span>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-gray-200 dark:border-zinc-800/60 p-4">
          <label className="flex items-center justify-between cursor-pointer gap-3">
            <span className="text-xs font-medium text-gray-700 dark:text-zinc-300">
              Auto-translate Out
            </span>
            <ToggleSwitch
              checked={autoTranslateOutgoing}
              onChange={(enabled) => {
                setAutoTranslateOutgoing(enabled);
                localStorage.setItem(AUTO_TRANSLATE_OUTGOING_KEY, String(enabled));
              }}
              aria-label="Auto-translate outgoing captions"
            />
          </label>
        </div>
      </aside>

      {!selectedCreatorId ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
          Select a creator
        </div>
      ) : (
        <>
          <section className="w-full max-w-md border-r border-gray-200 dark:border-zinc-800/60 flex flex-col min-h-0 shrink-0 bg-white dark:bg-zinc-950">
            <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-3 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                <Newspaper className="w-4 h-4 text-domx-400" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                  New post
                </h1>
                <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
                  {selectedCreator?.displayName}
                </p>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="flex rounded-xl border border-gray-200 dark:border-zinc-800 p-1 gap-1">
                {(
                  [
                    { id: 'upload' as const, label: 'Upload', icon: Upload },
                    { id: 'vault' as const, label: 'Vault', icon: ImageIcon },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setMediaSource(tab.id)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
                      mediaSource === tab.id
                        ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white'
                        : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                    }`}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {mediaSource === 'upload' ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">
                      Vault folder
                    </label>
                    <select
                      value={uploadFolderId || ''}
                      onChange={(e) => setUploadFolderId(e.target.value || null)}
                      className="w-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-white"
                    >
                      <option value="">Select folder…</option>
                      {vaultFolders.map((folder) => (
                        <option key={folder._id} value={folder._id}>
                          {friendlyVaultFolderName(folder)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;
                      setUploadFile(file);
                      setSelectedVaultItem(null);
                    }}
                  />
                  {uploadPreviewUrl ? (
                    <div className="relative rounded-xl overflow-hidden border border-gray-200 dark:border-zinc-800 aspect-[3/4] bg-gray-100 dark:bg-zinc-900">
                      <img
                        src={uploadPreviewUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setUploadFile(null);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}
                        className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white hover:bg-red-500"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 py-10 px-4 text-sm text-gray-500 hover:border-domx-500/50 hover:text-gray-800 dark:hover:text-zinc-200"
                    >
                      Choose photo…
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {selectedVaultItem ? (
                    <div className="relative rounded-xl overflow-hidden border border-gray-200 dark:border-zinc-800 aspect-[3/4] bg-gray-100 dark:bg-zinc-900">
                      {vaultDirectUrl(selectedVaultItem) ? (
                        <img
                          src={vaultDirectUrl(selectedVaultItem) || ''}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                          <ImageIcon className="w-8 h-8" />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedVaultItem(null)}
                        className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white hover:bg-red-500"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openVault()}
                      className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 py-10 px-4 text-sm text-gray-500 hover:border-domx-500/50 hover:text-gray-800 dark:hover:text-zinc-200"
                    >
                      Pick from vault…
                    </button>
                  )}
                  {selectedVaultItem && (
                    <button
                      type="button"
                      onClick={() => void openVault()}
                      className="text-xs font-medium text-domx-600 dark:text-domx-400 hover:underline"
                    >
                      Change vault photo
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">
                  Caption / story
                </label>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  placeholder={
                    autoTranslateOutgoing
                      ? 'Write a caption… (Auto-translates to German)'
                      : 'Write a caption…'
                  }
                  className="w-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-white resize-none focus:outline-none focus:border-domx-500/50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                    Categories ({selectedCategoryIds.length}/{MAX_CATEGORIES})
                  </label>
                  {categoriesLoading && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
                  )}
                </div>
                {selectedCategoryIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {selectedCategoryIds.map((id) => {
                      const cat = categories.find((c) => c._id === id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => toggleCategory(id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium bg-domx-600/15 text-domx-600 dark:text-domx-400 border border-domx-500/30"
                        >
                          {friendlyCategoryName(cat?.name || id)}
                          <X className="w-3 h-3" />
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  type="search"
                  value={categoryQuery}
                  onChange={(e) => setCategoryQuery(e.target.value)}
                  placeholder="Search categories…"
                  className="w-full mb-2 rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
                />
                <div className="max-h-40 overflow-y-auto rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/80">
                  {filteredCategories.slice(0, 80).map((cat) => {
                    const selected = selectedCategoryIds.includes(cat._id);
                    const disabled =
                      !selected && selectedCategoryIds.length >= MAX_CATEGORIES;
                    return (
                      <button
                        key={cat._id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleCategory(cat._id)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-left text-sm disabled:opacity-40 ${
                          selected
                            ? 'bg-domx-600/10 text-gray-900 dark:text-white'
                            : 'hover:bg-gray-50 dark:hover:bg-zinc-900/60 text-gray-700 dark:text-zinc-300'
                        }`}
                      >
                        <span className="truncate">
                          {friendlyCategoryName(cat.name)}
                        </span>
                        {selected && <Check className="w-4 h-4 text-domx-500 shrink-0" />}
                      </button>
                    );
                  })}
                  {filteredCategories.length === 0 && (
                    <p className="px-3 py-4 text-xs text-gray-500">No categories found</p>
                  )}
                </div>
              </div>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-gray-800 dark:text-zinc-200">
                  Public post
                </span>
                <ToggleSwitch
                  checked={isPublic}
                  onChange={setIsPublic}
                  aria-label="Public post"
                />
              </label>

              {postError && <p className="text-xs text-red-400">{postError}</p>}
              {(translatingOutgoing || postPhase !== 'idle') && (
                <p className="text-xs text-gray-500">
                  {translatingOutgoing
                    ? 'Translating to German…'
                    : postPhase === 'uploading'
                      ? 'Uploading photo and waiting for approval…'
                      : 'Creating post…'}
                </p>
              )}

              <label className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 inline-flex items-center gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5" />
                  Schedule instead of posting now
                </span>
                <ToggleSwitch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  aria-label="Schedule feed post"
                />
              </label>
              {scheduleEnabled && (
                <ScheduleDateTimePicker
                  date={scheduleDate}
                  time={scheduleTime}
                  onDateChange={setScheduleDate}
                  onTimeChange={setScheduleTime}
                />
              )}

              <button
                type="button"
                onClick={() => void handlePost()}
                disabled={!canPost}
                className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-domx-600 text-white font-semibold text-sm hover:bg-domx-500 shadow-lg shadow-domx-600/20 disabled:opacity-40"
              >
                {posting || translatingOutgoing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : scheduleEnabled ? (
                  <CalendarClock className="w-4 h-4" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                {scheduleEnabled ? 'Schedule post' : 'Publish post'}
              </button>
            </div>
          </section>

          <main className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                  {selectedCreator?.displayName || 'Creator'} — Feed
                </h2>
                <p className="text-xs text-gray-500 dark:text-zinc-500">
                  Profile posts on Maloum
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadPosts()}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw
                  className={`w-4 h-4 ${postsLoading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {postsLoading && posts.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {postsError && <p className="text-sm text-red-400">{postsError}</p>}
              {!postsLoading && !postsError && posts.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  No posts yet.
                </p>
              )}
              {posts.map((post) => {
                const src = postThumbUrl(selectedCreatorId, post);
                const when = formatRelativeTime(post.publishedAt || post.createdAt);
                return (
                  <article
                    key={post._id}
                    className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden"
                  >
                    <div className="flex items-start justify-between gap-3 p-4 pb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                          {post.caption || (
                            <span className="text-gray-400 italic">No caption</span>
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-500 dark:text-zinc-500">
                          {when && <span>{when}</span>}
                          {post.public !== false ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                              Public
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-500 font-medium">
                              Private
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Heart className="w-3 h-3" />
                            {post.likeCount ?? 0}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MessageCircle className="w-3 h-3" />
                            {post.commentCount ?? 0}
                          </span>
                        </div>
                        {Array.isArray(post.categories) && post.categories.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {post.categories.map((cat) => (
                              <span
                                key={cat._id || cat.name}
                                className="px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400"
                              >
                                {friendlyCategoryName(cat.name || '')}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDelete(post._id)}
                        disabled={deletingId === post._id}
                        className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                        title="Delete post"
                      >
                        {deletingId === post._id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    {src && (
                      <div className="mx-4 mb-4 rounded-xl overflow-hidden border border-gray-200 dark:border-zinc-800 bg-gray-100 dark:bg-zinc-900 aspect-[3/4] max-h-80 relative">
                        <img
                          src={src}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          loading="lazy"
                        />
                      </div>
                    )}
                  </article>
                );
              })}
              {postsNext && (
                <button
                  type="button"
                  onClick={() => void loadPosts({ append: true, next: postsNext })}
                  disabled={postsLoading}
                  className="w-full py-2 text-sm text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                >
                  {postsLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </main>
        </>
      )}

      {vaultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80 backdrop-blur-sm"
            onClick={() => {
              setVaultOpen(false);
              setVaultPreview(null);
            }}
          />
          <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                  <Box className="w-5 h-5 text-domx-400" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-gray-900 dark:text-white">
                    Media Vault
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-zinc-400">
                    Select one photo for the feed post
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setVaultPreview(null);
                  }}
                  className="px-5 py-2 text-sm font-semibold rounded-lg bg-domx-600 text-white hover:bg-domx-500 disabled:opacity-40"
                  disabled={!selectedVaultItem}
                >
                  Use photo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVaultOpen(false);
                    setVaultPreview(null);
                  }}
                  className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white rounded-lg"
                  aria-label="Close vault"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex flex-1 overflow-hidden min-h-0">
              <div className="w-48 sm:w-56 border-r border-gray-200 dark:border-zinc-800/60 p-3 overflow-y-auto hidden md:block shrink-0">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3 px-2">
                  Folders
                </h4>
                {vaultFoldersLoading && vaultFolders.length === 0 && (
                  <div className="flex justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                )}
                <ul className="space-y-1">
                  {vaultFolders.map((folder) => {
                    const active = selectedFolderId === folder._id;
                    const folderLabel = friendlyVaultFolderName(folder);
                    return (
                      <li key={folder._id}>
                        <button
                          type="button"
                          onClick={() => setSelectedFolderId(folder._id)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                              : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500'
                          }`}
                          title={folderLabel}
                        >
                          {active ? (
                            <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 shrink-0" />
                          )}
                          <span className="truncate">{folderLabel}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="flex-1 flex flex-col min-w-0">
                <div className="md:hidden p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto">
                  {vaultFolders.map((folder) => (
                    <button
                      key={folder._id}
                      type="button"
                      onClick={() => setSelectedFolderId(folder._id)}
                      className={`shrink-0 px-3 py-1.5 text-xs rounded-full border max-w-[160px] truncate ${
                        selectedFolderId === folder._id
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {friendlyVaultFolderName(folder)}
                    </button>
                  ))}
                </div>
                <div
                  className="flex-1 overflow-y-auto p-4"
                  onScroll={handleVaultMediaScroll}
                >
                  {vaultLoading && vaultItems.length === 0 && selectedFolderId && (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                    </div>
                  )}
                  {!selectedFolderId &&
                    !vaultLoading &&
                    !vaultError &&
                    !vaultFoldersLoading && (
                      <p className="text-sm text-gray-500 dark:text-zinc-500">
                        Select a folder to browse media.
                      </p>
                    )}
                  {vaultError && <p className="text-sm text-red-400">{vaultError}</p>}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {vaultItems.map((item) => {
                      const uploadId = vaultUploadId(item);
                      const src = vaultDirectUrl(item);
                      const selected =
                        Boolean(uploadId) &&
                        selectedVaultItem != null &&
                        vaultUploadId(selectedVaultItem) === uploadId;
                      return (
                        <div
                          key={uploadId || src || 'item'}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setSelectedVaultItem(item);
                            setUploadFile(null);
                          }}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            const next = vaultPreviewFromItem(item);
                            if (next) setVaultPreview(next);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedVaultItem(item);
                              setUploadFile(null);
                            }
                          }}
                          className={`relative aspect-square rounded-xl overflow-hidden border-2 cursor-pointer ${
                            selected
                              ? 'border-domx-500'
                              : 'border-transparent hover:border-gray-300 dark:hover:border-zinc-700'
                          }`}
                        >
                          {src ? (
                            <img
                              src={src}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-zinc-900 text-gray-400">
                              <ImageIcon className="w-5 h-5" />
                            </div>
                          )}
                          {selected && (
                            <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-domx-600 text-white flex items-center justify-center">
                              <Check className="w-3.5 h-3.5" />
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {vaultMediaNext != null && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = vaultMediaNextRef.current;
                        if (next == null) return;
                        void loadVaultMedia({ append: true, next });
                      }}
                      disabled={loadingMoreMedia}
                      className="w-full mt-4 py-2 text-xs font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                    >
                      {loadingMoreMedia ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {vaultPreview && (
        <VaultMediaLightbox
          url={vaultPreview.url}
          kind={vaultPreview.kind}
          onClose={() => setVaultPreview(null)}
        />
      )}
    </div>
  );
}
