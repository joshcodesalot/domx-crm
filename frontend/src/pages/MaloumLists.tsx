import { useCallback, useEffect, useMemo, useState } from 'react';
import { List, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import maloumIcon from '@/assets/maloum_icon.png';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useToast } from '@/context/ToastContext';
import {
  createMaloumChatList,
  deleteMaloumChatList,
  listMaloumChatLists,
  type MaloumChatListItem,
} from '@/lib/api';
import {
  buildManagedListRanks,
  friendlyListName,
  isManagedChatList,
} from '@/lib/maloumLabels';

function listTag(list: MaloumChatListItem): string | null {
  const tag = typeof list.tag === 'string' ? list.tag.trim() : '';
  return tag || null;
}

export default function MaloumLists() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { creators, creatorsLoading } = useCreatorLive({
    platform: 'maloum',
    wantBadges: false,
  });
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [lists, setLists] = useState<MaloumChatListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newListName, setNewListName] = useState('');
  const [useNameAsTag, setUseNameAsTag] = useState(false);
  const [customTag, setCustomTag] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const managedRanks = useMemo(() => buildManagedListRanks(lists), [lists]);

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((c) => c.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const loadLists = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) {
        setLoading(true);
        setError(null);
      }
      try {
        const result = await listMaloumChatLists(selectedCreatorId, {
          limit: 100,
          next: opts?.next || undefined,
        });
        setLists((prev) =>
          append ? [...prev, ...(result.lists || [])] : result.lists || []
        );
        setNextCursor(result.next || null);
      } catch (err) {
        if (!append) setLists([]);
        setError(err instanceof Error ? err.message : 'Failed to load lists');
      } finally {
        if (!append) setLoading(false);
      }
    },
    [selectedCreatorId]
  );

  useEffect(() => {
    setLists([]);
    setNextCursor(null);
    setError(null);
    if (!selectedCreatorId) return;
    void loadLists();
  }, [selectedCreatorId, loadLists]);

  const handleCreate = useCallback(async () => {
    if (!selectedCreatorId || creating) return;
    const name = newListName.trim();
    if (!name) {
      toast.error('Enter a list name');
      return;
    }
    const tagFromInput = customTag.trim();
    const tag = useNameAsTag ? tagFromInput || name : undefined;
    setCreating(true);
    try {
      const created = await createMaloumChatList(
        selectedCreatorId,
        name,
        tag ? { tag } : undefined
      );
      const list = created.list;
      setLists((prev) => [list, ...prev.filter((item) => item._id !== list._id)]);
      setNewListName('');
      setCustomTag('');
      setUseNameAsTag(false);
      toast.success(
        tag
          ? `Created list "${list.name || name}" with inbox tag`
          : `Created list "${list.name || name}"`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list');
    } finally {
      setCreating(false);
    }
  }, [
    selectedCreatorId,
    creating,
    newListName,
    customTag,
    useNameAsTag,
    toast,
  ]);

  const handleDelete = useCallback(
    async (list: MaloumChatListItem) => {
      if (!selectedCreatorId || deletingId || isManagedChatList(list)) return;
      const label = friendlyListName(list, managedRanks);
      const ok = await confirm({
        title: 'Delete list?',
        message: `This removes "${label}" from Maloum. Fans stay in other lists.`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(list._id);
      try {
        await deleteMaloumChatList(selectedCreatorId, list._id);
        setLists((prev) => prev.filter((item) => item._id !== list._id));
        toast.success(`Deleted "${label}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete list');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId, managedRanks, confirm, toast]
  );

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Lists
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
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
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
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-sm truncate block ${
                      active
                        ? 'font-semibold text-gray-900 dark:text-white'
                        : 'font-medium text-gray-700 dark:text-zinc-300'
                    }`}
                  >
                    {creator.displayName}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!selectedCreatorId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            Select a creator
          </div>
        ) : (
          <>
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-maloum-600/20 flex items-center justify-center border border-maloum-500/30">
                  <List className="w-4 h-4 text-maloum-500" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Lists
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Create lists with or without an inbox filter tag
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadLists()}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <section className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
                  Create list
                </h2>
                <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                  <label className="block text-sm space-y-1 flex-1 min-w-0">
                    <span className="text-xs text-gray-500 dark:text-zinc-500">
                      Name
                    </span>
                    <input
                      type="text"
                      value={newListName}
                      onChange={(e) => setNewListName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreate();
                      }}
                      placeholder="VIP spenders"
                      className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={creating || !newListName.trim()}
                    onClick={() => void handleCreate()}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 shrink-0"
                  >
                    {creating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    Create
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 dark:text-zinc-200">
                      Show as inbox filter
                    </p>
                    <p className="text-xs text-gray-500 dark:text-zinc-500">
                      Tagged lists appear as chips in inbox/chats
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={useNameAsTag}
                    onChange={setUseNameAsTag}
                    aria-label="Show as inbox filter"
                  />
                </div>
                {useNameAsTag && (
                  <label className="block text-sm space-y-1 max-w-xs">
                    <span className="text-xs text-gray-500 dark:text-zinc-500">
                      Inbox tag (optional — defaults to name)
                    </span>
                    <input
                      type="text"
                      value={customTag}
                      onChange={(e) => setCustomTag(e.target.value)}
                      placeholder={newListName.trim() || 'Tag'}
                      className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                )}
              </section>

              {loading && lists.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              {!loading && !error && lists.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  No lists yet.
                </p>
              )}

              {lists.length > 0 && (
                <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/80 overflow-hidden">
                  {lists.map((list) => {
                    const name = friendlyListName(list, managedRanks);
                    const tag = listTag(list);
                    const managed = isManagedChatList(list);
                    const deleting = deletingId === list._id;
                    return (
                      <div
                        key={list._id}
                        className="px-4 py-3 flex items-center gap-3 bg-white dark:bg-zinc-900/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {name}
                            </p>
                            {managed && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border border-gray-200 dark:border-zinc-700 shrink-0">
                                Managed
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-500">
                            {tag ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-maloum-500/10 text-maloum-600 dark:text-maloum-500 font-semibold">
                                {tag}
                              </span>
                            ) : (
                              <span>No tag</span>
                            )}
                            {typeof list.totalMemberCount === 'number' && (
                              <span>
                                {list.totalMemberCount}{' '}
                                {list.totalMemberCount === 1 ? 'member' : 'members'}
                              </span>
                            )}
                          </div>
                        </div>
                        {!managed && (
                          <button
                            type="button"
                            disabled={Boolean(deletingId)}
                            onClick={() => void handleDelete(list)}
                            className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
                            title="Delete list"
                          >
                            {deleting ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {nextCursor && (
                <button
                  type="button"
                  onClick={() => void loadLists({ append: true, next: nextCursor })}
                  disabled={loading}
                  className="w-full py-2 text-sm text-maloum-500 hover:underline disabled:opacity-40"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
