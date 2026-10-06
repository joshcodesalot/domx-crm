import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Image as ImageIcon,
  Loader2,
  Newspaper,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { isCreatorRosterEvent } from '@/lib/creatorAccessEvents';
import { useToast } from '@/context/ToastContext';
import fanslyIcon from '@/assets/fansly.svg';
import {
  createFanslyFeedPost,
  deleteFanslyFeedPost,
  fanslyVaultPreviewSrc,
  getCreators,
  listFanslyFeedPosts,
  listFanslySubscriptionTiers,
  listFanslyVaultAlbums,
  listFanslyVaultMedia,
  uploadFanslyFeedMedia,
  type Creator,
  type FanslyFeedPost,
  type FanslyMediaPermissions,
  type FanslySubscriptionTier,
  type FanslyVaultAlbum,
  type FanslyVaultMedia,
} from '@/lib/api';

function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatFeedTime(createdAt: number | null): string {
  if (createdAt == null || !Number.isFinite(createdAt)) return '';
  const ms = createdAt < 1e12 ? createdAt * 1000 : createdAt;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function previewSrc(creatorId: string, item: FanslyVaultMedia | FanslyFeedPost['media']): string | null {
  if (!item?.mediaId) return null;
  return fanslyVaultPreviewSrc(creatorId, {
    mediaId: item.mediaId,
    previewUrl: item.previewUrl,
    previewLocked: item.previewLocked,
  });
}

export default function FanslyFeed() {
  const { onSyncEvent } = useStaffSync();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [posts, setPosts] = useState<FanslyFeedPost[]>([]);
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [mediaSource, setMediaSource] = useState<'upload' | 'vault'>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postPhase, setPostPhase] = useState<'idle' | 'uploading' | 'creating'>('idle');
  const [postError, setPostError] = useState<string | null>(null);

  const [requirePurchase, setRequirePurchase] = useState(false);
  const [price, setPrice] = useState('');
  const [requireSubscription, setRequireSubscription] = useState(false);
  const [tierId, setTierId] = useState('');
  const [requireFollow, setRequireFollow] = useState(false);
  const [tiers, setTiers] = useState<FanslySubscriptionTier[]>([]);

  const [vaultOpen, setVaultOpen] = useState(false);
  const [albums, setAlbums] = useState<FanslyVaultAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [vaultMedia, setVaultMedia] = useState<FanslyVaultMedia[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selectedVaultItem, setSelectedVaultItem] = useState<FanslyVaultMedia | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const postsBeforeRef = useRef<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((creator) => creator.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const permissions = useMemo<FanslyMediaPermissions>(
    () => ({
      requirePurchase,
      price: Number(price),
      requireSubscription,
      subscriptionTierId: tierId || null,
      requireFollow,
    }),
    [requirePurchase, price, requireSubscription, tierId, requireFollow]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fansly = list.filter((creator) => creator.platform === 'fansly');
      setCreators(fansly);
      setSelectedCreatorId((prev) => prev || fansly[0]?.id || null);
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
      const before = append ? postsBeforeRef.current || undefined : undefined;
      if (!append) setPostsLoading(true);
      setPostsError(null);
      try {
        const result = await listFanslyFeedPosts(selectedCreatorId, { before });
        const nextPosts = result.posts || [];
        setPosts((prev) => (append ? [...prev, ...nextPosts] : nextPosts));
        postsBeforeRef.current = result.before;
        setPostsHasMore(Boolean(result.hasMore) && nextPosts.length > 0);
      } catch (err) {
        setPostsError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setPostsLoading(false);
      }
    },
    [selectedCreatorId]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (!isCreatorRosterEvent(event)) return;
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  useEffect(() => {
    setPosts([]);
    postsBeforeRef.current = null;
    setPostsHasMore(false);
    setPostError(null);
    setSelectedVaultItem(null);
    setUploadFile(null);
    setTiers([]);
    setTierId('');
    if (!selectedCreatorId) return;
    void loadPosts();
    listFanslySubscriptionTiers(selectedCreatorId)
      .then((result) => setTiers(result.tiers || []))
      .catch(() => setTiers([]));
  }, [selectedCreatorId, loadPosts]);

  useEffect(() => {
    if (!uploadFile) {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(uploadFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadFile]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId) return;
    let cancelled = false;
    setAlbumsLoading(true);
    setVaultError(null);
    listFanslyVaultAlbums(selectedCreatorId)
      .then((result) => {
        if (cancelled) return;
        const next = result.albums || [];
        setAlbums(next);
        setSelectedAlbumId((prev) => prev || next[0]?.id || null);
      })
      .catch((err) => {
        if (cancelled) return;
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault');
        setAlbums([]);
      })
      .finally(() => {
        if (!cancelled) setAlbumsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOpen, selectedCreatorId]);

  useEffect(() => {
    if (!vaultOpen || !selectedCreatorId || !selectedAlbumId) return;
    let cancelled = false;
    setVaultLoading(true);
    setVaultError(null);
    listFanslyVaultMedia(selectedCreatorId, selectedAlbumId)
      .then((result) => {
        if (!cancelled) setVaultMedia(result.media || []);
      })
      .catch((err) => {
        if (cancelled) return;
        setVaultError(err instanceof Error ? err.message : 'Failed to load vault media');
        setVaultMedia([]);
      })
      .finally(() => {
        if (!cancelled) setVaultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOpen, selectedCreatorId, selectedAlbumId]);

  const priceInvalid = requirePurchase && !(Number(price) > 0);
  const hasMedia =
    (mediaSource === 'upload' && Boolean(uploadFile)) ||
    (mediaSource === 'vault' && Boolean(selectedVaultItem));
  const canPost = !posting && hasMedia && !priceInvalid;

  async function handlePost() {
    if (!selectedCreatorId || !canPost) return;
    if (priceInvalid) {
      setPostError('Enter a purchase price');
      return;
    }
    setPosting(true);
    setPostError(null);
    try {
      let created: FanslyFeedPost;
      if (mediaSource === 'upload') {
        if (!uploadFile) return;
        setPostPhase('uploading');
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('content', draft);
        form.append('permissions', JSON.stringify(permissions));
        const result = await uploadFanslyFeedMedia(selectedCreatorId, form);
        created = result.post;
      } else {
        if (!selectedVaultItem) return;
        setPostPhase('creating');
        const result = await createFanslyFeedPost(selectedCreatorId, {
          content: draft,
          mediaId: selectedVaultItem.mediaId,
          permissions,
        });
        created = result.post;
      }
      setPosts((prev) => [created, ...prev.filter((post) => post.id !== created.id)]);
      setDraft('');
      setUploadFile(null);
      setSelectedVaultItem(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.success('Post published');
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to publish post');
    } finally {
      setPosting(false);
      setPostPhase('idle');
    }
  }

  const handleDelete = useCallback(
    async (postId: string) => {
      if (!selectedCreatorId || deletingId) return;
      const ok = await confirm({
        title: 'Delete post',
        message: 'This removes the post from the Fansly feed.',
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(postId);
      try {
        await deleteFanslyFeedPost(selectedCreatorId, postId);
        setPosts((prev) => prev.filter((post) => post.id !== postId));
        toast.success('Post deleted');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete post');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId, confirm, toast]
  );

  const selectedVaultThumb =
    selectedCreatorId && selectedVaultItem
      ? previewSrc(selectedCreatorId, selectedVaultItem)
      : null;

  return (
    <AppShell
      title="Fansly Feed"
      activePage="chatter"
      bleed
      headerExtras={
        <WorkspaceDrawerButton
          id="fansly-feed-accounts"
          size="lg"
          label="Creators"
          className="lg:hidden"
        />
      }
    >
      <WorkspaceDrawer
        id="fansly-feed-accounts"
        size="lg"
        className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50"
      >
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fanslyIcon} alt="" className="w-5 h-5 object-contain" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Feed</span>
        </div>
        <div data-drawer-list className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">No Fansly creators</p>
          )}
          {creators.map((creator) => {
            const active = creator.id === selectedCreatorId;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left ${
                  active ? 'bg-gray-100 dark:bg-white/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'
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
      </WorkspaceDrawer>

      {!selectedCreatorId ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
          {creatorsLoading ? 'Loading creators…' : 'Select a creator'}
        </div>
      ) : (
        <>
          <section className="w-full max-w-md border-r border-gray-200 dark:border-zinc-800/60 flex flex-col min-h-0 shrink-0 bg-white dark:bg-zinc-950">
            <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-3 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-sky-500/15 flex items-center justify-center border border-sky-500/30">
                <Newspaper className="w-4 h-4 text-sky-500" />
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
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 p-4 text-sm text-gray-500 hover:border-sky-500/50"
                  >
                    {uploadFile ? uploadFile.name : 'Choose a photo or video'}
                  </button>
                  {uploadPreviewUrl && uploadFile?.type.startsWith('image/') && (
                    <img
                      src={uploadPreviewUrl}
                      alt=""
                      className="w-full max-h-48 object-cover rounded-xl border border-gray-200 dark:border-zinc-800"
                    />
                  )}
                  {uploadFile?.type.startsWith('video/') && (
                    <p className="text-xs text-gray-500">Video selected</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setVaultOpen(true)}
                    className="w-full rounded-xl border border-dashed border-gray-300 dark:border-zinc-700 p-4 text-sm text-gray-500 hover:border-sky-500/50"
                  >
                    {selectedVaultItem
                      ? selectedVaultItem.filename || 'Vault media selected'
                      : 'Choose from vault'}
                  </button>
                  {selectedVaultThumb && (
                    <img
                      src={selectedVaultThumb}
                      alt=""
                      className="w-full max-h-48 object-cover rounded-xl border border-gray-200 dark:border-zinc-800"
                    />
                  )}
                </div>
              )}

              <label className="block text-xs text-gray-500">
                Caption
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={4}
                  placeholder="Write a caption"
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-xl bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 outline-none resize-none"
                />
              </label>

              <div className="space-y-3 rounded-xl border border-gray-200 dark:border-zinc-800 p-3">
                <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">
                  Who can view
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requirePurchase}
                    onChange={(event) => setRequirePurchase(event.target.checked)}
                  />
                  Require Purchase
                </label>
                {requirePurchase && (
                  <label className="block text-xs text-gray-500">
                    Amount
                    <span className="mt-1 flex items-center gap-1 px-2 py-1.5 border border-gray-200 dark:border-white/10 rounded-lg">
                      $
                      <input
                        value={price}
                        onChange={(event) => setPrice(event.target.value)}
                        inputMode="decimal"
                        placeholder="10"
                        className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none"
                      />
                    </span>
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requireSubscription}
                    onChange={(event) => setRequireSubscription(event.target.checked)}
                  />
                  Require Subscription
                </label>
                {requireSubscription && (
                  <label className="block text-xs text-gray-500">
                    Subscription Tier
                    <select
                      value={tierId}
                      onChange={(event) => setTierId(event.target.value)}
                      className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100"
                    >
                      <option value="">Any Tier</option>
                      {tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requireFollow}
                    onChange={(event) => setRequireFollow(event.target.checked)}
                  />
                  Require Follow
                </label>
                {!requirePurchase && !requireSubscription && !requireFollow && (
                  <p className="text-[11px] text-gray-500">Visible to everyone</p>
                )}
              </div>

              {postError && <p className="text-xs text-red-400">{postError}</p>}
              {priceInvalid && <p className="text-xs text-red-400">Enter a purchase price</p>}
              {postPhase !== 'idle' && (
                <p className="text-xs text-gray-500">
                  {postPhase === 'uploading' ? 'Uploading media…' : 'Publishing post…'}
                </p>
              )}

              <button
                type="button"
                onClick={() => void handlePost()}
                disabled={!canPost}
                className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-sky-500 text-white font-semibold text-sm hover:bg-sky-400 disabled:opacity-40"
              >
                {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
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
                <p className="text-xs text-gray-500 dark:text-zinc-500">Posts wall on Fansly</p>
              </div>
              <button
                type="button"
                onClick={() => void loadPosts()}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw className={`w-4 h-4 ${postsLoading ? 'animate-spin' : ''}`} />
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
                const src = selectedCreatorId ? previewSrc(selectedCreatorId, post.media) : null;
                return (
                  <article
                    key={post.id}
                    className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 overflow-hidden"
                  >
                    <div className="flex items-start justify-between gap-3 p-4 pb-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                          {post.content || <span className="text-gray-400 italic">No caption</span>}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-gray-500 dark:text-zinc-500">
                          {formatFeedTime(post.createdAt) && <span>{formatFeedTime(post.createdAt)}</span>}
                          {post.accessLabel && (
                            <span className="px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300">
                              {post.accessLabel}
                            </span>
                          )}
                          {post.media?.kind === 'video' && <span>Video</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDelete(post.id)}
                        disabled={deletingId === post.id}
                        className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                        title="Delete post"
                      >
                        {deletingId === post.id ? (
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
                  className="w-full py-2 text-sm text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40"
                >
                  {postsLoading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </main>
        </>
      )}

      {vaultOpen && selectedCreatorId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close vault"
            className="absolute inset-0 bg-black/30 dark:bg-black/80"
            onClick={() => setVaultOpen(false)}
          />
          <div className="relative bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-zinc-800/60">
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-white">Media Vault</h3>
                <p className="text-xs text-gray-500 dark:text-zinc-400">Select one photo or video</p>
              </div>
              <button
                type="button"
                aria-label="Close vault"
                onClick={() => setVaultOpen(false)}
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-1 min-h-0">
              <div className="w-52 shrink-0 border-r border-gray-200 dark:border-zinc-800 overflow-y-auto p-2">
                {albumsLoading && (
                  <p className="px-2 py-3 text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </p>
                )}
                {albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    onClick={() => setSelectedAlbumId(album.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate ${
                      album.id === selectedAlbumId
                        ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 font-medium'
                        : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900'
                    }`}
                  >
                    {album.title}
                    {album.itemCount > 0 ? ` (${album.itemCount})` : ''}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {vaultError && <p className="text-sm text-red-500 mb-3">{vaultError}</p>}
                {vaultLoading && (
                  <p className="text-sm text-gray-500 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading media…
                  </p>
                )}
                {selectedAlbumId && !vaultLoading && vaultMedia.length === 0 && (
                  <p className="text-sm text-gray-500">This album is empty.</p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {vaultMedia.map((item) => {
                    const src = previewSrc(selectedCreatorId, item);
                    const selected = selectedVaultItem?.mediaId === item.mediaId;
                    const video = item.kind === 'video' || item.mediaType === 2;
                    const durationLabel = video ? formatDuration(item.duration) : '';
                    return (
                      <button
                        key={item.id || item.mediaId}
                        type="button"
                        onClick={() => {
                          setSelectedVaultItem(item);
                          setVaultOpen(false);
                        }}
                        className={`relative aspect-square rounded-xl overflow-hidden border ${
                          selected
                            ? 'border-sky-500 ring-2 ring-sky-500/40'
                            : 'border-gray-200 dark:border-zinc-800'
                        }`}
                      >
                        {src ? (
                          <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-500 px-2">
                            {item.filename || 'Media'}
                          </span>
                        )}
                        {selected && (
                          <span className="absolute top-2 right-2 bg-sky-500 text-white rounded-full p-1">
                            <Check className="w-3 h-3" />
                          </span>
                        )}
                        {video && (
                          <span className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white">
                            Video
                          </span>
                        )}
                        {durationLabel && (
                          <span className="absolute bottom-2 right-2 z-10 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white pointer-events-none">
                            {durationLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
