import { useCallback, useEffect, useMemo, useState } from 'react';
import { List, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useToast } from '@/context/ToastContext';
import {
  createTelegramList,
  deleteTelegramList,
  listTelegramLists,
  type TelegramList,
} from '@/lib/api';
import telegramIcon from '@/assets/telegram_icon.svg';

export default function TelegramLists() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { creators, creatorsLoading } = useCreatorLive({
    platform: 'telegram',
    wantBadges: false,
  });
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [lists, setLists] = useState<TelegramList[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((c) => c.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const loadLists = useCallback(async () => {
    if (!selectedCreatorId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listTelegramLists(selectedCreatorId);
      setLists(result.lists || []);
    } catch (err) {
      setLists([]);
      setError(err instanceof Error ? err.message : 'Failed to load lists');
    } finally {
      setLoading(false);
    }
  }, [selectedCreatorId]);

  useEffect(() => {
    setLists([]);
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
    setCreating(true);
    try {
      const created = await createTelegramList(selectedCreatorId, name);
      setLists((prev) => [created.list, ...prev.filter((item) => item.id !== created.list.id)]);
      setNewListName('');
      toast.success(`Created list "${created.list.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list');
    } finally {
      setCreating(false);
    }
  }, [selectedCreatorId, creating, newListName, toast]);

  const handleDelete = useCallback(
    async (list: TelegramList) => {
      if (!selectedCreatorId || deletingId) return;
      const ok = await confirm({
        title: 'Delete list?',
        message: `This removes "${list.name}". Fans stay in other lists.`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(list.id);
      try {
        await deleteTelegramList(selectedCreatorId, list.id);
        setLists((prev) => prev.filter((item) => item.id !== list.id));
        toast.success(`Deleted "${list.name}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete list');
      } finally {
        setDeletingId(null);
      }
    },
    [selectedCreatorId, deletingId, confirm, toast]
  );

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Lists</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              No Telegram creators yet. Connect one from Manage Creators.
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
                <div className="w-9 h-9 rounded-xl bg-sky-600/20 flex items-center justify-center border border-sky-500/30">
                  <List className="w-4 h-4 text-sky-500" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Lists
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Assign fans from the chat panel, then use lists for mass messages
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
                    <span className="text-xs text-gray-500 dark:text-zinc-500">Name</span>
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
                    const deleting = deletingId === list.id;
                    const count = list.memberCount ?? list.totalMemberCount ?? 0;
                    return (
                      <div
                        key={list.id}
                        className="px-4 py-3 flex items-center gap-3 bg-white dark:bg-zinc-900/40"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {list.name}
                          </p>
                          <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-500">
                            {count} {count === 1 ? 'member' : 'members'}
                          </p>
                        </div>
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
