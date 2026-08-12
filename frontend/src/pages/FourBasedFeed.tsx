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
import fourBasedIcon from '@/assets/4based_icon.ico';
import { formatRelativeTime } from '@/components/fourbased/FourBasedChatPanels';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { useToast } from '@/context/ToastContext';
import {
  createFourBasedFeedPost,
  deleteFourBasedFeedPost,
  fourBasedPreviewPath,
  getCreators,
  getFourBasedProfile,
  listFourBasedFeedPosts,
  listFourBasedVault,
  pickFourBasedPreviewUrl,
  resolveFourBasedMediaSrc,
  translateToGerman,
  uploadFourBasedFeedPhoto,
  type Creator,
  type FourBasedFeedPost,
  type FourBasedVaultItem,
} from '@/lib/api';

const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';
const PAGE_SIZE = 24;
const VAULT_PAGE_SIZE = 60;

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

function nearScrollEnd(target: HTMLElement, thresholdPx = 80): boolean {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= thresholdPx;
}

function vaultItemId(item: FourBasedVaultItem): string {
  return String(item._id || item.id || '');
}

function isVideoItem(item: FourBasedVaultItem | null | undefined): boolean {
  if (!item) return false;
  const type = String(item.fileStackType || item.type || '').toLowerCase();
  return type.includes('video');
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

function pickDefaultFeedFolder(folders: string[]): string | null {
  const feed = folders.find((f) => /feed/i.test(f.trim()));
  return feed || folders[0] || null;
}

function mediaThumbSrc(
  creatorId: string,
  providerUserId: string | null,
  item: FourBasedFeedPost | FourBasedVaultItem | null | undefined
): string | null {
  if (!item) return null;
  const preview = pickFourBasedPreviewUrl(item.preview, [
    '500x500',
    '400x400',
    '200x200',
    '100x100',
  ]);
  if (preview) return resolveFourBasedMediaSrc(creatorId, preview);
  const id = String(
    (item as FourBasedFeedPost)._id || (item as FourBasedVaultItem).id || ''
  );
  if (!providerUserId || !id) return null;
  return resolveFourBasedMediaSrc(
    creatorId,
    fourBasedPreviewPath(providerUserId, id, '500x500.jpg')
  );
}

function mediaFullSrc(
  creatorId: string,
  providerUserId: string | null,
  item: FourBasedVaultItem
): string | null {
  const fromPreview = pickFourBasedPreviewUrl(item.preview, [
    '900xxx',
    '500x500',
    '400x400',
  ]);
  if (fromPreview) return resolveFourBasedMediaSrc(creatorId, fromPreview);
  const id = vaultItemId(item);
  if (!providerUserId || !id) return null;
  return resolveFourBasedMediaSrc(
    creatorId,
    fourBasedPreviewPath(providerUserId, id, '900xxx.jpg')
  );
}

export default function FourBasedFeed() {
  const { onSyncEvent } = useStaffSync();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [providerUserId, setProviderUserId] = useState<string | null>(null);

  const [posts, setPosts] = useState<FourBasedFeedPost[]>([]);
  const [postsOffset, setPostsOffset] = useState(0);
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [mediaSource, setMediaSource] = useState<'upload' | 'vault'>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadFolder, setUploadFolder] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postPhase, setPostPhase] = useState<'idle' | 'uploading' | 'creating'>(
    'idle'
  );
  const [postError, setPostError] = useState<string | null>(null);
  const [translatingOutgoing, setTranslatingOutgoing] = useState(false);
  const [autoTranslateOutgoing, setAutoTranslateOutgoing] = useState(() =>
    readStoredBoolean(AUTO_TRANSLATE_OUTGOING_KEY, true)
  );

  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFolders, setVaultFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [vaultItems, setVaultItems] = useState<FourBasedVaultItem[]>([]);
  const [vaultOffset, setVaultOffset] = useState(0);
  const [vaultHasMore, setVaultHasMore] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultLoadingMore, setVaultLoadingMore] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItem, setSelectedVaultItem] =
    useState<FourBasedVaultItem | null>(null);
  const [vaultPreview, setVaultPreview] = useState<{
    url: string;
    kind: 'picture' | 'video' | 'embed';
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const vaultLoadingMoreRef = useRef(false);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const draftTags = useMemo(() => parseHashtags(draft), [draft]);

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fourBased = list.filter((c) => c.platform === '4based');
      setCreators(fourBased);
      setSelectedCreatorId((prev) => prev || fourBased[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const loadPosts = useCallback(
    async (opts?: { append?: boolean }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      const offset = append ? postsOffset : 0;
      if (!append) setPostsLoading(true);
      setPostsError(null);
      try {
        const result = await listFourBasedFeedPosts(selectedCreatorId, {
          limit: PAGE_SIZE,
          offset,
        });
        if (result.providerUserId) setProviderUserId(result.providerUserId);
        const nextPosts = result.posts || [];
        setPosts((prev) => (append ? [...prev, ...nextPosts] : nextPosts));
        setPostsOffset(offset + nextPosts.length);
        setPostsHasMore(Boolean(result.hasMore));
      } catch (err) {
        setPostsError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setPostsLoading(false);
      }
    },
    [selectedCreatorId, postsOffset]
  );

  const loadProfileFolders = useCallback(async () => {
    if (!selectedCreatorId) return;
    try {
      const result = await getFourBasedProfile(selectedCreatorId);
      if (result.providerUserId) setProviderUserId(result.providerUserId);
      const folders = Array.isArray(result.profile?.folders)
        ? result.profile.folders.filter(
            (f): f is string => typeof f === 'string' && f.trim().length > 0
          )
        : [];
      setVaultFolders(folders);
      setUploadFolder((prev) => prev || pickDefaultFeedFolder(folders));
      setSelectedFolder((prev) => prev || folders[0] || null);
    } catch {
      setVaultFolders([]);
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
    setPostsOffset(0);
    setPostsHasMore(false);
    setPostError(null);
    setSelectedVaultItem(null);
    setUploadFile(null);
    setUploadFolder(null);
    setDraft('');
    setProviderUserId(null);
    setVaultFolders([]);
    setVaultItems([]);
    setSelectedFolder(null);
    setVaultOpen(false);
    if (selectedCreatorId) {
      void loadPosts();
      void loadProfileFolders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCreatorId]);

  useEffect(() => {
    if (!uploadFile) {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(uploadFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadFile]);

  const loadVaultMedia = useCallback(
    async (opts?: {
      append?: boolean;
      folder?: string | null;
    }) => {
      if (!selectedCreatorId) return;
      const folder =
        opts?.folder !== undefined ? opts.folder : selectedFolder;
      const append = Boolean(opts?.append);
      const offset = append ? vaultOffset : 0;
      if (append) {
        if (vaultLoadingMoreRef.current || !vaultHasMore) return;
        vaultLoadingMoreRef.current = true;
        setVaultLoadingMore(true);
      } else {
        setVaultLoading(true);
        setVaultItems([]);
        setVaultOffset(0);
        setVaultHasMore(false);
      }
      setVaultError(null);
      try {
        const result = await listFourBasedVault(selectedCreatorId, null, {
          limit: VAULT_PAGE_SIZE,
          offset,
          folder: folder || undefined,
          fileType: 'image',
        });
        if (result.providerUserId) setProviderUserId(result.providerUserId);
        const items = (result.items || []).filter((item) => !isVideoItem(item));
        setVaultItems((prev) => (append ? [...prev, ...items] : items));
        setVaultOffset(offset + items.length);
        setVaultHasMore(items.length >= VAULT_PAGE_SIZE);
      } catch (err) {
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
      } finally {
        if (append) {
          vaultLoadingMoreRef.current = false;
          setVaultLoadingMore(false);
        } else {
          setVaultLoading(false);
        }
      }
    },
    [selectedCreatorId, selectedFolder, vaultOffset, vaultHasMore]
  );

  const openVault = useCallback(async () => {
    if (!selectedCreatorId) return;
    setVaultOpen(true);
    if (vaultFolders.length === 0) {
      await loadProfileFolders();
    }
    await loadVaultMedia({ folder: selectedFolder });
  }, [
    selectedCreatorId,
    vaultFolders.length,
    loadProfileFolders,
    loadVaultMedia,
    selectedFolder,
  ]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId) return;
    void loadVaultMedia({ folder: selectedFolder });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultOpen, selectedFolder, selectedCreatorId]);

  const handleVaultMediaScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!nearScrollEnd(event.currentTarget)) return;
      void loadVaultMedia({ append: true });
    },
    [loadVaultMedia]
  );

  const resetCompose = useCallback(() => {
    setDraft('');
    setUploadFile(null);
    setSelectedVaultItem(null);
    setPostError(null);
    setPostPhase('idle');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handlePost = useCallback(async () => {
    if (!selectedCreatorId || posting || translatingOutgoing) return;
    if (mediaSource === 'upload' && !uploadFile) {
      setPostError('Choose a photo to upload');
      return;
    }
    if (mediaSource === 'upload' && !uploadFolder) {
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
      let caption = draft.trim();
      if (caption && autoTranslateOutgoing) {
        setTranslatingOutgoing(true);
        try {
          caption = await translateToGerman(caption);
          setDraft(caption);
        } finally {
          setTranslatingOutgoing(false);
        }
      }

      if (mediaSource === 'upload' && uploadFile && uploadFolder) {
        setPostPhase('uploading');
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('folder', uploadFolder);
        form.append('description', caption);
        await uploadFourBasedFeedPhoto(selectedCreatorId, form);
      } else if (selectedVaultItem) {
        setPostPhase('creating');
        const vaultId = vaultItemId(selectedVaultItem);
        if (!vaultId) throw new Error('Could not resolve vault item id');
        await createFourBasedFeedPost(selectedCreatorId, {
          vaultId,
          vaultGuid:
            typeof selectedVaultItem.guid === 'string'
              ? selectedVaultItem.guid
              : undefined,
          description: caption,
        });
      }

      toast.success('Post published');
      resetCompose();
      setPostsOffset(0);
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
    mediaSource,
    uploadFile,
    uploadFolder,
    selectedVaultItem,
    draft,
    autoTranslateOutgoing,
    toast,
    resetCompose,
    loadPosts,
  ]);

  const handleDelete = useCallback(
    async (postId: string) => {
      if (!selectedCreatorId || deletingId) return;
      const ok = await confirm({
        title: 'Delete post?',
        message: 'This removes the post from the creator feed on 4based.',
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(postId);
      try {
        await deleteFourBasedFeedPost(selectedCreatorId, postId);
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
    ((mediaSource === 'upload' && Boolean(uploadFile) && Boolean(uploadFolder)) ||
      (mediaSource === 'vault' && Boolean(selectedVaultItem)));

  const selectedVaultThumb =
    selectedCreatorId && selectedVaultItem
      ? mediaThumbSrc(selectedCreatorId, providerUserId, selectedVaultItem)
      : null;

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
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
              No 4based creators yet. Connect one from Manage Creators.
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
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-sky-400 to-blue-600"
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
                      value={uploadFolder || ''}
                      onChange={(e) => setUploadFolder(e.target.value || null)}
                      className="w-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-white"
                    >
                      <option value="">Select folder…</option>
                      {vaultFolders.map((folder) => (
                        <option key={folder} value={folder}>
                          {folder}
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
                      {selectedVaultThumb ? (
                        <img
                          src={selectedVaultThumb}
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
                      ? 'Write a caption with #hashtags… (Auto-translates to German)'
                      : 'Write a caption with #hashtags…'
                  }
                  className="w-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-white resize-none focus:outline-none focus:border-domx-500/50"
                />
                {draftTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {draftTags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-1 rounded-full text-[11px] font-medium bg-domx-600/15 text-domx-600 dark:text-domx-400 border border-domx-500/30"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {postError && <p className="text-xs text-red-400">{postError}</p>}
              {(translatingOutgoing || postPhase !== 'idle') && (
                <p className="text-xs text-gray-500">
                  {translatingOutgoing
                    ? 'Translating to German…'
                    : postPhase === 'uploading'
                      ? 'Uploading photo…'
                      : 'Creating post…'}
                </p>
              )}

              <button
                type="button"
                onClick={() => void handlePost()}
                disabled={!canPost}
                className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-domx-600 text-white font-semibold text-sm hover:bg-domx-500 shadow-lg shadow-domx-600/20 disabled:opacity-40"
              >
                {posting || translatingOutgoing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                Publish post
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
                  Profile posts on 4based
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPostsOffset(0);
                  void loadPosts();
                }}
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
                const src = mediaThumbSrc(
                  selectedCreatorId,
                  providerUserId,
                  post
                );
                const when = formatRelativeTime(post.created_at);
                const likeCount = post.likes_count ?? 0;
                const commentCount =
                  post.comment_count ?? post.comments_count ?? 0;
                const tags = Array.isArray(post.tag) ? post.tag : [];
                return (
                  <article
                    key={post._id}
                    className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden"
                  >
                    <div className="flex items-start justify-between gap-3 p-4 pb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                          {post.description || (
                            <span className="text-gray-400 italic">No caption</span>
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-500 dark:text-zinc-500">
                          {when && <span>{when}</span>}
                          <span className="inline-flex items-center gap-1">
                            <Heart className="w-3 h-3" />
                            {likeCount}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MessageCircle className="w-3 h-3" />
                            {commentCount}
                          </span>
                        </div>
                        {tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400"
                              >
                                #{tag}
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
              {postsHasMore && (
                <button
                  type="button"
                  onClick={() => void loadPosts({ append: true })}
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
                <ul className="space-y-1">
                  <li>
                    <button
                      type="button"
                      onClick={() => setSelectedFolder(null)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${
                        selectedFolder == null
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                          : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500'
                      }`}
                    >
                      {selectedFolder == null ? (
                        <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                      ) : (
                        <Folder className="w-4 h-4 shrink-0" />
                      )}
                      <span className="truncate">All</span>
                    </button>
                  </li>
                  {vaultFolders.map((folder) => {
                    const active = selectedFolder === folder;
                    return (
                      <li key={folder}>
                        <button
                          type="button"
                          onClick={() => setSelectedFolder(folder)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${
                            active
                              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white font-medium'
                              : 'hover:bg-gray-100 dark:hover:bg-zinc-800/50 text-gray-500'
                          }`}
                          title={folder}
                        >
                          {active ? (
                            <FolderOpen className="w-4 h-4 text-domx-400 shrink-0" />
                          ) : (
                            <Folder className="w-4 h-4 shrink-0" />
                          )}
                          <span className="truncate">{folder}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="flex-1 flex flex-col min-w-0">
                <div className="md:hidden p-3 border-b border-gray-200 dark:border-zinc-800/60 flex gap-2 overflow-x-auto">
                  <button
                    type="button"
                    onClick={() => setSelectedFolder(null)}
                    className={`shrink-0 px-3 py-1.5 text-xs rounded-full border ${
                      selectedFolder == null
                        ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                        : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 border-gray-200 dark:border-zinc-800'
                    }`}
                  >
                    All
                  </button>
                  {vaultFolders.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      onClick={() => setSelectedFolder(folder)}
                      className={`shrink-0 px-3 py-1.5 text-xs rounded-full border max-w-[160px] truncate ${
                        selectedFolder === folder
                          ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white border-gray-300 dark:border-zinc-700'
                          : 'bg-gray-50 dark:bg-zinc-900/50 text-gray-500 border-gray-200 dark:border-zinc-800'
                      }`}
                    >
                      {folder}
                    </button>
                  ))}
                </div>
                <div
                  className="flex-1 overflow-y-auto p-4"
                  onScroll={handleVaultMediaScroll}
                >
                  {vaultLoading && vaultItems.length === 0 && (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                    </div>
                  )}
                  {vaultError && <p className="text-sm text-red-400">{vaultError}</p>}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {vaultItems.map((item) => {
                      const id = vaultItemId(item);
                      const src =
                        selectedCreatorId
                          ? mediaThumbSrc(selectedCreatorId, providerUserId, item)
                          : null;
                      const selected =
                        Boolean(id) &&
                        selectedVaultItem != null &&
                        vaultItemId(selectedVaultItem) === id;
                      return (
                        <div
                          key={id || src || 'item'}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setSelectedVaultItem(item);
                            setUploadFile(null);
                          }}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            if (!selectedCreatorId) return;
                            const url = mediaFullSrc(
                              selectedCreatorId,
                              providerUserId,
                              item
                            );
                            if (url) setVaultPreview({ url, kind: 'picture' });
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
                  {vaultHasMore && (
                    <button
                      type="button"
                      onClick={() => void loadVaultMedia({ append: true })}
                      disabled={vaultLoadingMore}
                      className="w-full mt-4 py-2 text-xs font-medium text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                    >
                      {vaultLoadingMore ? 'Loading…' : 'Load more'}
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
