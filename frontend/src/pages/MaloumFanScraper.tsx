import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  UserSearch,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import maloumIcon from '@/assets/maloum_icon.png';
import { useToast } from '@/context/ToastContext';
import {
  createMaloumChatList,
  getCreators,
  getMaloumFanScrapeJob,
  listMaloumChatLists,
  startMaloumFanScrapeJob,
  stopMaloumFanScrapeJob,
  updateMaloumFanScrapeJob,
  type Creator,
  type MaloumChatListItem,
  type MaloumFanScrapeCheckpoint,
  type MaloumFanScrapeJob,
  type MaloumFanScrapeSourceMode,
} from '@/lib/api';

const POLL_MS = 2000;

function normalizeUsernameList(input: string): string[] {
  const parts = input
    .split(/[\n,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let value = part.replace(/^@+/, '');
      const urlMatch = value.match(
        /(?:https?:\/\/)?(?:app\.)?maloum\.com\/creator\/([^/?#]+)/i
      );
      if (urlMatch) value = urlMatch[1];
      return value.trim().toLowerCase();
    })
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const username of parts) {
    if (seen.has(username)) continue;
    seen.add(username);
    out.push(username);
  }
  return out;
}

function emptyCheckpoint(): MaloumFanScrapeCheckpoint {
  return {
    sourceCreators: [],
    creatorIndex: 0,
    postIndex: 0,
    posts: [],
    commentNext: null,
    processedFans: 0,
    skippedFans: 0,
    failedFans: 0,
    skippedPosts: 0,
    distributedFans: 0,
    distributeFailed: 0,
    invalidUsernames: [],
    lastError: null,
    currentCreatorUsername: null,
    currentPostId: null,
    statusMessage: null,
  };
}

function parseMaloumImportIds(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((v) => String(v).trim()).filter(Boolean))];
    }
  } catch {
    // fall through
  }
  return [
    ...new Set(
      trimmed
        .split(/[\n,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ];
}

export default function MaloumFanScraper() {
  const { toast } = useToast();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [job, setJob] = useState<MaloumFanScrapeJob | null>(null);
  const [scrapedFanCount, setScrapedFanCount] = useState(0);
  const [serverRunning, setServerRunning] = useState(false);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const [chatLists, setChatLists] = useState<MaloumChatListItem[]>([]);
  const [chatListsNext, setChatListsNext] = useState<string | null>(null);
  const [chatListsLoading, setChatListsLoading] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [creatingList, setCreatingList] = useState(false);

  const [sourceMode, setSourceMode] = useState<MaloumFanScrapeSourceMode>('top_creators');
  const [topCreatorsLimit, setTopCreatorsLimit] = useState(50);
  const [postsPerCreator, setPostsPerCreator] = useState(50);
  const [customUsernamesText, setCustomUsernamesText] = useState('');
  const [distributeToAllCreators, setDistributeToAllCreators] = useState(false);
  const [distributeListName, setDistributeListName] = useState('Fan Scrape');
  const [importFanIdsText, setImportFanIdsText] = useState('');
  const [targetCreatorIds, setTargetCreatorIds] = useState<string[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const checkpoint = job?.checkpoint || emptyCheckpoint();
  const isRunning = job?.status === 'running' || serverRunning;
  const isImportMode = sourceMode === 'import_ids';
  const sourceLocked =
    !isImportMode && (checkpoint.sourceCreators?.length || 0) > 0;
  const parsedCustomCount = normalizeUsernameList(customUsernamesText).length;
  const parsedImportCount = parseMaloumImportIds(importFanIdsText).length;

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

  const loadJob = useCallback(async (creatorId: string, opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setJobLoading(true);
    setJobError(null);
    try {
      const result = await getMaloumFanScrapeJob(creatorId);
      setJob(result.job);
      setScrapedFanCount(result.scrapedFanCount || 0);
      setServerRunning(Boolean(result.serverRunning));
      setSourceMode(result.job.sourceMode);
      setTopCreatorsLimit(result.job.topCreatorsLimit);
      setPostsPerCreator(result.job.postsPerCreator);
      setCustomUsernamesText((result.job.customUsernames || []).join('\n'));
      setDistributeToAllCreators(Boolean(result.job.distributeToAllCreators));
      setDistributeListName(result.job.distributeListName || 'Fan Scrape');
      setImportFanIdsText(
        (result.job.importFanIds || []).length
          ? JSON.stringify(result.job.importFanIds, null, 2)
          : ''
      );
      setTargetCreatorIds(result.job.targetCreatorIds || []);
      if (result.job.checkpoint?.lastError && result.job.status === 'failed') {
        setJobError(result.job.checkpoint.lastError);
      }
    } catch (err) {
      setJob(null);
      if (!opts?.quiet) {
        setJobError(err instanceof Error ? err.message : 'Failed to load scrape job');
      }
    } finally {
      if (!opts?.quiet) setJobLoading(false);
    }
  }, []);

  const loadChatLists = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) setChatListsLoading(true);
      try {
        const result = await listMaloumChatLists(selectedCreatorId, {
          limit: 25,
          next: opts?.next || undefined,
        });
        setChatLists((prev) =>
          append ? [...prev, ...(result.lists || [])] : result.lists || []
        );
        setChatListsNext(result.next || null);
      } catch (err) {
        if (!append) setChatLists([]);
        toast.error(err instanceof Error ? err.message : 'Failed to load lists');
      } finally {
        setChatListsLoading(false);
      }
    },
    [selectedCreatorId, toast]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    void loadJob(selectedCreatorId);
    void loadChatLists();
  }, [selectedCreatorId, loadJob, loadChatLists]);

  useEffect(() => {
    if (!selectedCreatorId || !isRunning) return;
    const timer = window.setInterval(() => {
      void loadJob(selectedCreatorId, { quiet: true });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedCreatorId, isRunning, loadJob]);

  const persistConfig = useCallback(
    async (extra?: { resetCheckpoint?: boolean }) => {
      if (!selectedCreatorId) return null;
      setSavingConfig(true);
      try {
        const result = await updateMaloumFanScrapeJob(selectedCreatorId, {
          sourceMode,
          topCreatorsLimit,
          postsPerCreator,
          customUsernames:
            sourceMode === 'custom_usernames'
              ? normalizeUsernameList(customUsernamesText)
              : [],
          targetListId: job?.targetListId ?? null,
          targetListName: job?.targetListName ?? null,
          distributeToAllCreators,
          distributeListName,
          importFanIds:
            sourceMode === 'import_ids'
              ? parseMaloumImportIds(importFanIdsText)
              : [],
          targetCreatorIds,
          resetCheckpoint: extra?.resetCheckpoint,
        });
        setJob(result.job);
        return result.job;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save settings');
        return null;
      } finally {
        setSavingConfig(false);
      }
    },
    [
      selectedCreatorId,
      sourceMode,
      topCreatorsLimit,
      postsPerCreator,
      customUsernamesText,
      job?.targetListId,
      job?.targetListName,
      distributeToAllCreators,
      distributeListName,
      importFanIdsText,
      targetCreatorIds,
      toast,
    ]
  );

  const selectList = useCallback(
    async (list: MaloumChatListItem) => {
      if (!selectedCreatorId || isRunning) return;
      try {
        const result = await updateMaloumFanScrapeJob(selectedCreatorId, {
          targetListId: list._id,
          targetListName: list.name || list._id,
          sourceMode,
          topCreatorsLimit,
          postsPerCreator,
          customUsernames:
            sourceMode === 'custom_usernames'
              ? normalizeUsernameList(customUsernamesText)
              : [],
        });
        setJob(result.job);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to select list');
      }
    },
    [
      selectedCreatorId,
      isRunning,
      sourceMode,
      topCreatorsLimit,
      postsPerCreator,
      customUsernamesText,
      toast,
    ]
  );

  const handleCreateList = useCallback(async () => {
    if (!selectedCreatorId || creatingList || isRunning) return;
    const name = newListName.trim();
    if (!name) {
      toast.error('Enter a list name');
      return;
    }
    setCreatingList(true);
    try {
      const created = await createMaloumChatList(selectedCreatorId, name);
      const list = created.list;
      setChatLists((prev) => [list, ...prev.filter((item) => item._id !== list._id)]);
      setNewListName('');
      await selectList(list);
      toast.success(`Created list "${list.name || name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list');
    } finally {
      setCreatingList(false);
    }
  }, [selectedCreatorId, creatingList, isRunning, newListName, selectList, toast]);

  const handleStart = useCallback(async () => {
    if (!selectedCreatorId || actionBusy || isRunning) return;
    setActionBusy(true);
    setJobError(null);
    try {
      const saved = await persistConfig();
      if (!saved) return;
      if (saved.sourceMode === 'import_ids') {
        if (!(saved.importFanIds || []).length) {
          toast.error('Paste at least one fan ID to import');
          return;
        }
      }
      if (!saved.targetListId) {
        toast.error('Select or create a target list first');
        return;
      }
      const started = await startMaloumFanScrapeJob(selectedCreatorId);
      setJob(started.job);
      setServerRunning(Boolean(started.serverRunning ?? true));
      toast.success('Scrape started on server — safe to close the CRM');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start scrape';
      setJobError(message);
      toast.error(message);
    } finally {
      setActionBusy(false);
    }
  }, [selectedCreatorId, actionBusy, isRunning, persistConfig, toast]);

  const handleStop = useCallback(async () => {
    if (!selectedCreatorId || actionBusy) return;
    setActionBusy(true);
    try {
      const stopped = await stopMaloumFanScrapeJob(selectedCreatorId);
      setJob(stopped.job);
      setServerRunning(Boolean(stopped.serverRunning));
      toast.info('Stop requested — server will pause shortly');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop scrape');
    } finally {
      setActionBusy(false);
    }
  }, [selectedCreatorId, actionBusy, toast]);

  const handleReset = useCallback(async () => {
    if (!selectedCreatorId || isRunning || actionBusy) return;
    setActionBusy(true);
    try {
      const updated = await persistConfig({ resetCheckpoint: true });
      if (updated) {
        toast.success('Progress reset');
        await loadJob(selectedCreatorId);
      }
    } finally {
      setActionBusy(false);
    }
  }, [selectedCreatorId, isRunning, actionBusy, persistConfig, loadJob, toast]);

  const creatorsDone = checkpoint.creatorIndex;
  const creatorsTotal = checkpoint.sourceCreators.length || 0;
  const postsDone = checkpoint.postIndex;
  const postsTotal = checkpoint.posts.length || 0;
  const statusLine =
    checkpoint.statusMessage ||
    (job?.status === 'running'
      ? 'Running on server…'
      : job?.status === 'paused'
        ? `Paused · ${checkpoint.processedFans} added`
        : job?.status === 'completed'
          ? `Completed · ${checkpoint.processedFans} added`
          : 'Idle');

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Fan Scraper
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
                  displayName={creator.displayName || creator.username || '?'}
                  avatarUrl={creator.avatarUrl}
                  className="w-9 h-9 rounded-full object-cover shrink-0"
                  initialsClassName="w-9 h-9 rounded-full bg-orange-100 flex items-center justify-center shrink-0 text-orange-600 font-bold text-sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {creator.displayName || creator.username}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-zinc-500 truncate">
                    Mother model
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="h-16 px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <UserSearch className="w-4 h-4" />
              Fan Scraper
            </h1>
            <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
              {selectedCreator
                ? `Server job on ${selectedCreator.displayName || selectedCreator.username}`
                : 'Select a mother model'}
              {isRunning ? ' · runs after CRM closes' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <button
                type="button"
                disabled={!selectedCreatorId || jobLoading || savingConfig || actionBusy}
                onClick={() => void handleStart()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {actionBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Start
              </button>
            ) : (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => void handleStop()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {actionBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Pause className="w-3.5 h-3.5" />
                )}
                Stop
              </button>
            )}
            <button
              type="button"
              disabled={isRunning || !selectedCreatorId || actionBusy}
              onClick={() => void handleReset()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-900 disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reset progress
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {jobError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {jobError}
            </div>
          )}

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Progress
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">Fans added</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {checkpoint.processedFans}
                  <span className="text-sm font-normal text-gray-400">
                    {' '}
                    / {scrapedFanCount || checkpoint.processedFans}
                  </span>
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">Skipped / failed</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {checkpoint.skippedFans}
                  <span className="text-sm font-normal text-gray-400">
                    {' '}
                    / {checkpoint.failedFans}
                  </span>
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  {isImportMode ? 'Import fans' : 'Creators'}
                </p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {isImportMode
                    ? `${checkpoint.importFanIndex || 0}/${parsedImportCount || '—'}`
                    : `${creatorsDone}/${creatorsTotal || '—'}`}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  {isImportMode ? 'Creators targeted' : 'Posts skipped / current'}
                </p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {isImportMode
                    ? `${checkpoint.importCreatorIndex || 0}/${targetCreatorIds.length || creators.length || '—'}`
                    : `${checkpoint.skippedPosts || 0} / ${postsDone}/${postsTotal || '—'}`}
                </p>
              </div>
            </div>
            {!isImportMode && (checkpoint.distributedFans || 0) > 0 && (
              <p className="text-xs text-gray-500 dark:text-zinc-500">
                Distributed to other creators: {checkpoint.distributedFans}
                {(checkpoint.distributeFailed || 0) > 0
                  ? ` · ${checkpoint.distributeFailed} distribute failures`
                  : ''}
              </p>
            )}
            <p className="text-sm text-gray-600 dark:text-zinc-400">
              Status:{' '}
              <span className="font-medium text-gray-900 dark:text-white">
                {job?.status || 'idle'}
                {serverRunning ? ' (server active)' : ''}
              </span>
              {' · '}
              {statusLine}
            </p>
            {checkpoint.currentCreatorUsername && (
              <p className="text-xs text-gray-500 dark:text-zinc-500">
                Current: @{checkpoint.currentCreatorUsername}
                {checkpoint.currentPostId
                  ? ` · post ${checkpoint.currentPostId.slice(0, 8)}…`
                  : ''}
              </p>
            )}
            {(checkpoint.invalidUsernames?.length || 0) > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Invalid usernames: {checkpoint.invalidUsernames.join(', ')}
              </p>
            )}
            <p className="text-xs text-gray-500 dark:text-zinc-500">
              Scraping runs on the DomX API server. Closing the CRM will not stop it.
              Message later via{' '}
              <Link
                to="/chatter/maloum/mass-message"
                className="underline underline-offset-2 text-gray-800 dark:text-zinc-200"
              >
                Mass Message
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Source
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isRunning || sourceLocked}
                onClick={() => setSourceMode('top_creators')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  sourceMode === 'top_creators'
                    ? 'border-gray-900 dark:border-white bg-gray-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'border-gray-200 dark:border-zinc-700'
                } disabled:opacity-50`}
              >
                Top creators
              </button>
              <button
                type="button"
                disabled={isRunning || sourceLocked}
                onClick={() => setSourceMode('custom_usernames')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  sourceMode === 'custom_usernames'
                    ? 'border-gray-900 dark:border-white bg-gray-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'border-gray-200 dark:border-zinc-700'
                } disabled:opacity-50`}
              >
                Custom usernames
              </button>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setSourceMode('import_ids')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  sourceMode === 'import_ids'
                    ? 'border-gray-900 dark:border-white bg-gray-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'border-gray-200 dark:border-zinc-700'
                } disabled:opacity-50`}
              >
                Import IDs
              </button>
            </div>

            {sourceMode === 'import_ids' ? (
              <>
                <label className="block text-sm space-y-1">
                  <span className="text-xs text-gray-500 dark:text-zinc-500">
                    Fan IDs JSON array ({parsedImportCount} parsed) — add to lists only
                  </span>
                  <textarea
                    rows={8}
                    disabled={isRunning}
                    value={importFanIdsText}
                    onChange={(e) => setImportFanIdsText(e.target.value)}
                    placeholder={'["63efe68732ab5388bc029607", "641347a4a740eeb4f352a9be"]'}
                    className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-mono disabled:opacity-50"
                  />
                </label>
                <label className="block text-sm space-y-1 max-w-xs">
                  <span className="text-xs text-gray-500 dark:text-zinc-500">
                    List name on other creators
                  </span>
                  <input
                    type="text"
                    disabled={isRunning}
                    value={distributeListName}
                    onChange={(e) => setDistributeListName(e.target.value)}
                    placeholder="Fan Scrape"
                    className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                  />
                </label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500 dark:text-zinc-500">
                      Add to creators&apos; lists (empty = all Maloum creators)
                    </p>
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() =>
                        setTargetCreatorIds(
                          targetCreatorIds.length === creators.length
                            ? []
                            : creators.map((c) => c.id)
                        )
                      }
                      className="text-xs underline underline-offset-2 disabled:opacity-50"
                    >
                      {targetCreatorIds.length === creators.length
                        ? 'Clear all'
                        : 'Select all'}
                    </button>
                  </div>
                  <div className="rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/80 max-h-48 overflow-y-auto">
                    {creators.map((creator) => {
                      const checked = targetCreatorIds.includes(creator.id);
                      return (
                        <label
                          key={creator.id}
                          className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            disabled={isRunning}
                            checked={checked}
                            onChange={() =>
                              setTargetCreatorIds((prev) =>
                                checked
                                  ? prev.filter((id) => id !== creator.id)
                                  : [...prev, creator.id]
                              )
                            }
                          />
                          <span className="truncate">
                            {creator.displayName || creator.username}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <>
                {sourceMode === 'top_creators' ? (
                  <label className="block text-sm space-y-1 max-w-xs">
                    <span className="text-xs text-gray-500 dark:text-zinc-500">
                      Top creators limit
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      disabled={isRunning || sourceLocked}
                      value={topCreatorsLimit}
                      onChange={(e) =>
                        setTopCreatorsLimit(
                          Math.min(200, Math.max(1, Number(e.target.value) || 50))
                        )
                      }
                      className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                    />
                  </label>
                ) : (
                  <label className="block text-sm space-y-1">
                    <span className="text-xs text-gray-500 dark:text-zinc-500">
                      Creator usernames ({parsedCustomCount} parsed)
                    </span>
                    <textarea
                      rows={6}
                      disabled={isRunning || sourceLocked}
                      value={customUsernamesText}
                      onChange={(e) => setCustomUsernamesText(e.target.value)}
                      placeholder={
                        'stella4twenty\ncreator2\nhttps://app.maloum.com/creator/name'
                      }
                      className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-mono disabled:opacity-50"
                    />
                  </label>
                )}

                <label className="block text-sm space-y-1 max-w-xs">
                  <span className="text-xs text-gray-500 dark:text-zinc-500">
                    Posts per creator
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    disabled={isRunning || sourceLocked}
                    value={postsPerCreator}
                    onChange={(e) =>
                      setPostsPerCreator(
                        Math.min(200, Math.max(1, Number(e.target.value) || 50))
                      )
                    }
                    className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                  />
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={distributeToAllCreators}
                    onChange={(e) => setDistributeToAllCreators(e.target.checked)}
                  />
                  <span>Add scraped fans to all Maloum creators&apos; lists</span>
                </label>
                {distributeToAllCreators && (
                  <label className="block text-sm space-y-1 max-w-xs">
                    <span className="text-xs text-gray-500 dark:text-zinc-500">
                      List name on other creators
                    </span>
                    <input
                      type="text"
                      disabled={isRunning}
                      value={distributeListName}
                      onChange={(e) => setDistributeListName(e.target.value)}
                      placeholder="Fan Scrape"
                      className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                    />
                  </label>
                )}
              </>
            )}

            {sourceLocked && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Source list is locked for this run. Use Reset progress to change it.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              {isImportMode ? 'Target list (this mother)' : 'Target list'}
            </h2>
            <div className="flex flex-wrap gap-2 items-end">
              <label className="block text-sm space-y-1 flex-1 min-w-[200px]">
                <span className="text-xs text-gray-500 dark:text-zinc-500">
                  Create new list
                </span>
                <input
                  type="text"
                  disabled={isRunning}
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="Bot - fans"
                  className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                disabled={isRunning || creatingList || !newListName.trim()}
                onClick={() => void handleCreateList()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-900 disabled:opacity-50"
              >
                {creatingList ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                Create
              </button>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/80 max-h-72 overflow-y-auto">
              {chatListsLoading && chatLists.length === 0 && (
                <p className="p-3 text-xs text-gray-500">Loading lists…</p>
              )}
              {!chatListsLoading && chatLists.length === 0 && (
                <p className="p-3 text-xs text-gray-500">No lists found.</p>
              )}
              {chatLists.map((list) => {
                const selected = job?.targetListId === list._id;
                return (
                  <button
                    key={list._id}
                    type="button"
                    disabled={isRunning}
                    onClick={() => void selectList(list)}
                    className={`w-full text-left px-3 py-2.5 text-sm flex items-center justify-between gap-2 disabled:opacity-50 ${
                      selected
                        ? 'bg-gray-100 dark:bg-zinc-800/60'
                        : 'hover:bg-gray-50 dark:hover:bg-zinc-900/50'
                    }`}
                  >
                    <span className="truncate text-gray-900 dark:text-white">
                      {list.name || list._id}
                    </span>
                    <span className="text-[11px] text-gray-500 shrink-0">
                      {typeof list.totalMemberCount === 'number'
                        ? `${list.totalMemberCount} members`
                        : ''}
                      {selected ? ' · selected' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
            {chatListsNext && (
              <button
                type="button"
                disabled={chatListsLoading || isRunning}
                onClick={() => void loadChatLists({ append: true, next: chatListsNext })}
                className="text-xs text-gray-600 dark:text-zinc-400 underline underline-offset-2 disabled:opacity-50"
              >
                Load more lists
              </button>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
