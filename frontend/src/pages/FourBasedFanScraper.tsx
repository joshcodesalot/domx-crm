import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image as ImageIcon,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  UserSearch,
  Video,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import fourBasedIcon from '@/assets/4based_icon.ico';
import { useToast } from '@/context/ToastContext';
import {
  fourBasedPreviewPath,
  getCreators,
  getFourBasedFanScrapeJob,
  listFourBasedVault,
  pickFourBasedPreviewUrl,
  resolveFourBasedMediaSrc,
  startFourBasedFanScrapeJob,
  stopFourBasedFanScrapeJob,
  updateFourBasedFanScrapeJob,
  type Creator,
  type FourBasedFanScrapeCheckpoint,
  type FourBasedFanScrapeJob,
  type FourBasedFanScrapeSourceMode,
  type FourBasedVaultItem,
} from '@/lib/api';

const POLL_MS = 2000;
const VAULT_PAGE_SIZE = 60;
const COINS_PER_DOLLAR = 121;

function emptyCheckpoint(): FourBasedFanScrapeCheckpoint {
  return {
    trendingOffset: 0,
    currentPagePostIds: [],
    postIndex: 0,
    commentOffset: 0,
    processedFans: 0,
    skippedFans: 0,
    failedFans: 0,
    skippedPosts: 0,
    importFanIndex: 0,
    importCreatorIndex: 0,
    lastError: null,
    currentPostId: null,
    statusMessage: null,
    trendingExhausted: false,
  };
}

function parseFourBasedImportFans(
  text: string
): Record<string, string | null> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string | null> = {};
      for (const [id, name] of Object.entries(parsed)) {
        const fanId = String(id).trim();
        if (!fanId) continue;
        out[fanId] =
          name == null || name === ''
            ? null
            : String(name).trim() || null;
      }
      return out;
    }
    if (Array.isArray(parsed)) {
      const out: Record<string, string | null> = {};
      for (const item of parsed) {
        const fanId = String(item).trim();
        if (fanId) out[fanId] = null;
      }
      return out;
    }
  } catch {
    // fall through
  }
  const out: Record<string, string | null> = {};
  for (const part of trimmed.split(/[\n,\s]+/)) {
    const fanId = part.trim();
    if (fanId) out[fanId] = null;
  }
  return out;
}

function vaultItemId(item: FourBasedVaultItem): string {
  return String(item._id || item.id || '');
}

function isVideoItem(item: FourBasedVaultItem | null | undefined): boolean {
  if (!item) return false;
  const type = String(item.fileStackType || item.type || '').toLowerCase();
  return type.includes('video');
}

function dollarsToCoins(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * COINS_PER_DOLLAR);
}

function coinsToDollars(coins: number): string {
  if (!coins) return '';
  return (coins / COINS_PER_DOLLAR).toFixed(2).replace(/\.00$/, '');
}

function mediaThumbSrc(
  creatorId: string,
  providerUserId: string | null,
  item: FourBasedVaultItem
): string | null {
  const preview = pickFourBasedPreviewUrl(item.preview, [
    '200x200',
    '100x100',
    '400x400',
    '500x500',
  ]);
  if (preview) return resolveFourBasedMediaSrc(creatorId, preview);
  const id = vaultItemId(item);
  if (!providerUserId || !id) return null;
  return resolveFourBasedMediaSrc(
    creatorId,
    fourBasedPreviewPath(providerUserId, id, '200x200.jpg')
  );
}

export default function FourBasedFanScraper() {
  const { toast } = useToast();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [providerUserId, setProviderUserId] = useState<string | null>(null);

  const [job, setJob] = useState<FourBasedFanScrapeJob | null>(null);
  const [scrapedFanCount, setScrapedFanCount] = useState(0);
  const [serverRunning, setServerRunning] = useState(false);
  const [jobLoading, setJobLoading] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const [sourceMode, setSourceMode] =
    useState<FourBasedFanScrapeSourceMode>('trending');
  const [importFansText, setImportFansText] = useState('');
  const [targetCreatorIds, setTargetCreatorIds] = useState<string[]>([]);
  const [messageText, setMessageText] = useState('');
  const [priceDollars, setPriceDollars] = useState('');
  const [selectedVaultItems, setSelectedVaultItems] = useState<FourBasedVaultItem[]>(
    []
  );
  const [vaultItems, setVaultItems] = useState<FourBasedVaultItem[]>([]);
  const [vaultOffset, setVaultOffset] = useState(0);
  const [vaultHasMore, setVaultHasMore] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);

  const [savingConfig, setSavingConfig] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const checkpoint = job?.checkpoint || emptyCheckpoint();
  const isRunning = job?.status === 'running' || serverRunning;
  const isImportMode = sourceMode === 'import_ids';
  const priceCoins = dollarsToCoins(Number(priceDollars) || 0);
  const parsedImportFans = parseFourBasedImportFans(importFansText);
  const parsedImportCount = Object.keys(parsedImportFans).length;
  const otherCreators = useMemo(
    () => creators.filter((c) => c.id !== selectedCreatorId),
    [creators, selectedCreatorId]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fourbased = list.filter((c) => c.platform === '4based');
      setCreators(fourbased);
      setSelectedCreatorId((prev) => prev || fourbased[0]?.id || null);
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
      const result = await getFourBasedFanScrapeJob(creatorId);
      setJob(result.job);
      setScrapedFanCount(result.scrapedFanCount || 0);
      setServerRunning(Boolean(result.serverRunning));
      if (result.providerUserId) setProviderUserId(result.providerUserId);
      if (!opts?.quiet) {
        setSourceMode(result.job.sourceMode || 'trending');
        setMessageText(result.job.messageText || '');
        setPriceDollars(coinsToDollars(result.job.priceCoins || 0));
        setTargetCreatorIds(
          (result.job.targetCreatorIds || []).filter((id) => id !== creatorId)
        );
        const fans = result.job.importFans || {};
        setImportFansText(
          Object.keys(fans).length ? JSON.stringify(fans, null, 2) : ''
        );
      }
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

  const loadVault = useCallback(
    async (opts?: { append?: boolean; offset?: number }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      setVaultLoading(true);
      try {
        const offset =
          opts?.offset != null ? opts.offset : append ? vaultOffset : 0;
        const result = await listFourBasedVault(selectedCreatorId, null, {
          limit: VAULT_PAGE_SIZE,
          offset,
        });
        if (result.providerUserId) setProviderUserId(result.providerUserId);
        const items = result.items || [];
        setVaultItems((prev) => (append ? [...prev, ...items] : items));
        setVaultOffset(offset + items.length);
        setVaultHasMore(items.length >= VAULT_PAGE_SIZE);

        // Rehydrate selected items from job vaultIds when vault loads
        if (!append && job?.vaultIds?.length) {
          const wanted = new Set(job.vaultIds);
          setSelectedVaultItems((prev) => {
            const fromPage = items.filter((item) => wanted.has(vaultItemId(item)));
            const kept = prev.filter((item) => wanted.has(vaultItemId(item)));
            const byId = new Map<string, FourBasedVaultItem>();
            for (const item of [...kept, ...fromPage]) {
              byId.set(vaultItemId(item), item);
            }
            return [...byId.values()];
          });
        }
      } catch (err) {
        if (!append) setVaultItems([]);
        toast.error(err instanceof Error ? err.message : 'Failed to load vault');
      } finally {
        setVaultLoading(false);
      }
    },
    [selectedCreatorId, vaultOffset, job?.vaultIds, toast]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    setSelectedVaultItems([]);
    setVaultItems([]);
    setVaultOffset(0);
    void loadJob(selectedCreatorId);
    void loadVault({ offset: 0 });
  }, [selectedCreatorId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedCreatorId || !isRunning) return;
    const timer = window.setInterval(() => {
      void loadJob(selectedCreatorId, { quiet: true });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedCreatorId, isRunning, loadJob]);

  const toggleVaultItem = useCallback((item: FourBasedVaultItem) => {
    const id = vaultItemId(item);
    if (!id) return;
    setSelectedVaultItems((prev) => {
      if (prev.some((x) => vaultItemId(x) === id)) {
        return prev.filter((x) => vaultItemId(x) !== id);
      }
      return [...prev, item];
    });
  }, []);

  const persistConfig = useCallback(
    async (extra?: { resetCheckpoint?: boolean }) => {
      if (!selectedCreatorId) return null;
      setSavingConfig(true);
      try {
        const result = await updateFourBasedFanScrapeJob(selectedCreatorId, {
          messageText,
          vaultIds: selectedVaultItems.map(vaultItemId).filter(Boolean),
          priceCoins,
          sourceMode,
          importFans:
            sourceMode === 'import_ids'
              ? parseFourBasedImportFans(importFansText)
              : {},
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
      messageText,
      selectedVaultItems,
      priceCoins,
      sourceMode,
      importFansText,
      targetCreatorIds,
      toast,
    ]
  );

  const handleStart = useCallback(async () => {
    if (!selectedCreatorId || actionBusy || isRunning) return;
    if (!messageText.trim() && selectedVaultItems.length === 0) {
      toast.error('Add a message or vault media');
      return;
    }
    if (sourceMode === 'import_ids' && parsedImportCount === 0) {
      toast.error('Paste at least one fan ID to import');
      return;
    }
    setActionBusy(true);
    setJobError(null);
    try {
      const saved = await persistConfig();
      if (!saved) return;
      const started = await startFourBasedFanScrapeJob(selectedCreatorId);
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
  }, [
    selectedCreatorId,
    actionBusy,
    isRunning,
    messageText,
    selectedVaultItems.length,
    sourceMode,
    parsedImportCount,
    persistConfig,
    toast,
  ]);

  const handleStop = useCallback(async () => {
    if (!selectedCreatorId || actionBusy) return;
    setActionBusy(true);
    try {
      const stopped = await stopFourBasedFanScrapeJob(selectedCreatorId);
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

  const statusLine =
    checkpoint.statusMessage ||
    (job?.status === 'running'
      ? 'Running on server…'
      : job?.status === 'paused'
        ? `Paused · ${checkpoint.processedFans} messaged`
        : job?.status === 'completed'
          ? `Completed · ${checkpoint.processedFans} messaged`
          : 'Idle');

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
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
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">Messaged</p>
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
                  {isImportMode ? 'Import fans' : 'Trending offset'}
                </p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {isImportMode
                    ? `${checkpoint.importFanIndex || 0}/${parsedImportCount || '—'}`
                    : checkpoint.trendingOffset}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">
                  {isImportMode ? 'Send creators' : 'Posts skipped / page'}
                </p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {isImportMode
                    ? `${checkpoint.importCreatorIndex || 0}/${(targetCreatorIds.length || 0) + 1}`
                    : `${checkpoint.skippedPosts || 0} / ${checkpoint.postIndex}/${checkpoint.currentPagePostIds.length || '—'}`}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-600 dark:text-zinc-400">
              Status:{' '}
              <span className="font-medium text-gray-900 dark:text-white">
                {job?.status || 'idle'}
                {serverRunning ? ' (server active)' : ''}
              </span>
              {' · '}
              {statusLine}
            </p>
            <p className="text-xs text-gray-500 dark:text-zinc-500">
              {isImportMode
                ? 'Source: Import IDs (cold DM). Runs on the DomX API — closing the CRM will not stop it.'
                : 'Source: Trending (unlimited). Scraping runs on the DomX API — closing the CRM will not stop it.'}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Source
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setSourceMode('trending')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  sourceMode === 'trending'
                    ? 'border-gray-900 dark:border-white bg-gray-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'border-gray-200 dark:border-zinc-700'
                } disabled:opacity-50`}
              >
                Trending
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
            {isImportMode && (
              <>
                <label className="block text-sm space-y-1">
                  <span className="text-xs text-gray-500 dark:text-zinc-500">
                    Fan map JSON ({parsedImportCount} parsed) — cold DM only
                  </span>
                  <textarea
                    rows={8}
                    disabled={isRunning}
                    value={importFansText}
                    onChange={(e) => setImportFansText(e.target.value)}
                    placeholder={
                      '{\n  "66fae4034d6a02bb6c0b3b4c": "rudolfo99",\n  "66fb6cc3d34866383a059e37": "thor061"\n}'
                    }
                    className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-mono disabled:opacity-50"
                  />
                </label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500 dark:text-zinc-500">
                      Also send from other creators (empty = this creator only)
                    </p>
                    <button
                      type="button"
                      disabled={isRunning || otherCreators.length === 0}
                      onClick={() =>
                        setTargetCreatorIds(
                          targetCreatorIds.length === otherCreators.length &&
                            otherCreators.length > 0
                            ? []
                            : otherCreators.map((c) => c.id)
                        )
                      }
                      className="text-xs underline underline-offset-2 disabled:opacity-50"
                    >
                      {targetCreatorIds.length === otherCreators.length &&
                      otherCreators.length > 0
                        ? 'Clear all'
                        : 'Select all'}
                    </button>
                  </div>
                  <div className="rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/80 max-h-48 overflow-y-auto">
                    {otherCreators.length === 0 && (
                      <p className="p-3 text-xs text-gray-500">
                        No other 4based creators.
                      </p>
                    )}
                    {otherCreators.map((creator) => {
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
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Message
            </h2>
            <textarea
              rows={4}
              disabled={isRunning}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Message to send each fan…"
              className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            />
            <label className="block text-sm space-y-1 max-w-xs">
              <span className="text-xs text-gray-500 dark:text-zinc-500">
                Price (USD, optional — 0 = free)
              </span>
              <input
                type="number"
                min={0}
                step="0.01"
                disabled={isRunning}
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
              />
              {priceCoins > 0 && (
                <span className="text-[11px] text-gray-500">{priceCoins} coins</span>
              )}
            </label>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
                Vault media
              </h2>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => {
                  setVaultOpen((open) => !open);
                  if (!vaultOpen && vaultItems.length === 0) void loadVault();
                }}
                className="text-xs underline underline-offset-2 disabled:opacity-50"
              >
                {vaultOpen ? 'Hide vault' : 'Pick from vault'}
              </button>
            </div>

            {selectedVaultItems.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedVaultItems.map((item) => {
                  const id = vaultItemId(item);
                  const thumb =
                    selectedCreatorId &&
                    mediaThumbSrc(selectedCreatorId, providerUserId, item);
                  return (
                    <div
                      key={id}
                      className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-zinc-700"
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-zinc-800">
                          {isVideoItem(item) ? (
                            <Video className="w-4 h-4" />
                          ) : (
                            <ImageIcon className="w-4 h-4" />
                          )}
                        </div>
                      )}
                      {!isRunning && (
                        <button
                          type="button"
                          onClick={() => toggleVaultItem(item)}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {vaultOpen && (
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 max-h-72 overflow-y-auto p-2">
                {vaultLoading && vaultItems.length === 0 && (
                  <p className="p-3 text-xs text-gray-500">Loading vault…</p>
                )}
                {!vaultLoading && vaultItems.length === 0 && (
                  <p className="p-3 text-xs text-gray-500">No vault media.</p>
                )}
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {vaultItems.map((item) => {
                    const id = vaultItemId(item);
                    const selected = selectedVaultItems.some(
                      (x) => vaultItemId(x) === id
                    );
                    const thumb =
                      selectedCreatorId &&
                      mediaThumbSrc(selectedCreatorId, providerUserId, item);
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={isRunning}
                        onClick={() => toggleVaultItem(item)}
                        className={`relative aspect-square rounded-lg overflow-hidden border ${
                          selected
                            ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                            : 'border-gray-200 dark:border-zinc-700'
                        } disabled:opacity-50`}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-zinc-800">
                            {isVideoItem(item) ? (
                              <Video className="w-4 h-4" />
                            ) : (
                              <ImageIcon className="w-4 h-4" />
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {vaultHasMore && (
                  <button
                    type="button"
                    disabled={vaultLoading || isRunning}
                    onClick={() => void loadVault({ append: true })}
                    className="mt-2 text-xs underline underline-offset-2 disabled:opacity-50"
                  >
                    Load more
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
