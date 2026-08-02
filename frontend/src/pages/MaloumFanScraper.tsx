import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  checkpointMaloumFanScrapeJob,
  createMaloumChat,
  createMaloumChatList,
  getCreators,
  getMaloumFanAssignedLists,
  getMaloumFanScrapeJob,
  getMaloumUserProfile,
  listMaloumChatLists,
  listMaloumPostComments,
  listMaloumTopCreators,
  listMaloumUserPosts,
  maloumFanScrapeFansExist,
  setMaloumFanAssignedLists,
  startMaloumFanScrapeJob,
  stopMaloumFanScrapeJob,
  updateMaloumFanScrapeJob,
  upsertMaloumFanScrapeFan,
  type Creator,
  type MaloumChatListItem,
  type MaloumFanScrapeCheckpoint,
  type MaloumFanScrapeJob,
  type MaloumFanScrapeSourceMode,
} from '@/lib/api';

const COMMENT_DELAY_MS = 1200;
const STEP_DELAY_MS = 350;

function sleep(ms: number, signal: { aborted: boolean }) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const started = Date.now();
    const tick = () => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (Date.now() - started >= ms) {
        resolve();
        return;
      }
      window.setTimeout(tick, Math.min(100, ms - (Date.now() - started)));
    };
    window.setTimeout(tick, Math.min(100, ms));
  });
}

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
    invalidUsernames: [],
    lastError: null,
    currentCreatorUsername: null,
    currentPostId: null,
  };
}

export default function MaloumFanScraper() {
  const { toast } = useToast();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);

  const [job, setJob] = useState<MaloumFanScrapeJob | null>(null);
  const [scrapedFanCount, setScrapedFanCount] = useState(0);
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
  const [savingConfig, setSavingConfig] = useState(false);
  const [running, setRunning] = useState(false);
  const [statusLine, setStatusLine] = useState('Idle');

  const abortRef = useRef(0);
  const runningRef = useRef(false);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const checkpoint = job?.checkpoint || emptyCheckpoint();
  const sourceLocked = (checkpoint.sourceCreators?.length || 0) > 0;
  const parsedCustomCount = normalizeUsernameList(customUsernamesText).length;

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

  const loadJob = useCallback(async (creatorId: string) => {
    setJobLoading(true);
    setJobError(null);
    try {
      const result = await getMaloumFanScrapeJob(creatorId);
      setJob(result.job);
      setScrapedFanCount(result.scrapedFanCount || 0);
      setSourceMode(result.job.sourceMode);
      setTopCreatorsLimit(result.job.topCreatorsLimit);
      setPostsPerCreator(result.job.postsPerCreator);
      setCustomUsernamesText((result.job.customUsernames || []).join('\n'));
      if (result.job.status === 'running') {
        setStatusLine('Job marked running — press Start to resume this session');
      }
    } catch (err) {
      setJob(null);
      setJobError(err instanceof Error ? err.message : 'Failed to load scrape job');
    } finally {
      setJobLoading(false);
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
    abortRef.current += 1;
    runningRef.current = false;
    setRunning(false);
    void loadJob(selectedCreatorId);
    void loadChatLists();
  }, [selectedCreatorId, loadJob, loadChatLists]);

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
      toast,
    ]
  );

  const selectList = useCallback(
    async (list: MaloumChatListItem) => {
      if (!selectedCreatorId || runningRef.current) return;
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
      sourceMode,
      topCreatorsLimit,
      postsPerCreator,
      customUsernamesText,
      toast,
    ]
  );

  const handleCreateList = useCallback(async () => {
    if (!selectedCreatorId || creatingList) return;
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
  }, [selectedCreatorId, creatingList, newListName, selectList, toast]);

  const saveCheckpoint = useCallback(
    async (
      creatorId: string,
      next: MaloumFanScrapeCheckpoint,
      status?: MaloumFanScrapeJob['status']
    ) => {
      const result = await checkpointMaloumFanScrapeJob(creatorId, {
        checkpoint: next,
        status,
      });
      setJob(result.job);
      return result.job;
    },
    []
  );

  const resolveSourceCreators = useCallback(
    async (
      creatorId: string,
      currentJob: MaloumFanScrapeJob,
      signal: { aborted: boolean }
    ): Promise<MaloumFanScrapeCheckpoint> => {
      let cp = { ...currentJob.checkpoint };
      if (cp.sourceCreators.length > 0) return cp;

      if (currentJob.sourceMode === 'top_creators') {
        setStatusLine('Loading top creators…');
        const usernames: string[] = [];
        let next: number | undefined;
        const limit = currentJob.topCreatorsLimit || 50;
        while (usernames.length < limit) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const pageLimit = Math.min(15, limit - usernames.length);
          const page = await listMaloumTopCreators(creatorId, {
            limit: pageLimit,
            next,
          });
          for (const item of page.creators || []) {
            const username = item.user?.username?.trim().toLowerCase();
            if (username && !usernames.includes(username)) {
              usernames.push(username);
            }
            if (usernames.length >= limit) break;
          }
          if (page.next == null || (page.creators || []).length === 0) break;
          next = page.next;
          await sleep(STEP_DELAY_MS, signal);
        }
        cp = {
          ...cp,
          sourceCreators: usernames,
          creatorIndex: 0,
          postIndex: 0,
          posts: [],
          commentNext: null,
        };
        await saveCheckpoint(creatorId, cp, 'running');
        return cp;
      }

      setStatusLine('Resolving custom usernames…');
      const usernames = normalizeUsernameList(
        (currentJob.customUsernames || []).join('\n')
      );
      const valid: string[] = [];
      const invalid: string[] = [...(cp.invalidUsernames || [])];
      for (const username of usernames) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          const profile = await getMaloumUserProfile(creatorId, username);
          const resolved =
            profile.profile?.username?.trim().toLowerCase() || username;
          if (!valid.includes(resolved)) valid.push(resolved);
        } catch {
          if (!invalid.includes(username)) invalid.push(username);
        }
        await sleep(STEP_DELAY_MS, signal);
      }
      cp = {
        ...cp,
        sourceCreators: valid,
        invalidUsernames: invalid,
        creatorIndex: 0,
        postIndex: 0,
        posts: [],
        commentNext: null,
      };
      await saveCheckpoint(creatorId, cp, 'running');
      return cp;
    },
    [saveCheckpoint]
  );

  const ensureCreatorPosts = useCallback(
    async (
      creatorId: string,
      username: string,
      postsLimit: number,
      cp: MaloumFanScrapeCheckpoint,
      signal: { aborted: boolean }
    ): Promise<MaloumFanScrapeCheckpoint> => {
      if (cp.posts.length > 0) return cp;
      setStatusLine(`Loading posts for @${username}…`);
      const postIds: string[] = [];
      let next: string | undefined;
      while (postIds.length < postsLimit) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const page = await listMaloumUserPosts(creatorId, username, {
          limit: Math.min(15, postsLimit - postIds.length),
          next,
        });
        for (const post of page.posts || []) {
          if (post._id && !postIds.includes(post._id)) postIds.push(post._id);
          if (postIds.length >= postsLimit) break;
        }
        if (!page.next || (page.posts || []).length === 0) break;
        next = page.next;
        await sleep(STEP_DELAY_MS, signal);
      }
      const nextCp: MaloumFanScrapeCheckpoint = {
        ...cp,
        posts: postIds,
        postIndex: 0,
        commentNext: null,
        currentCreatorUsername: username,
      };
      await saveCheckpoint(creatorId, nextCp, 'running');
      return nextCp;
    },
    [saveCheckpoint]
  );

  const processFan = useCallback(
    async (
      creatorId: string,
      listId: string,
      fanId: string,
      username: string | undefined,
      sourceCreatorUsername: string,
      sourcePostId: string,
      cp: MaloumFanScrapeCheckpoint
    ): Promise<MaloumFanScrapeCheckpoint> => {
      const exists = await maloumFanScrapeFansExist(creatorId, [fanId]);
      if (exists.existing.includes(fanId)) {
        return {
          ...cp,
          skippedFans: cp.skippedFans + 1,
        };
      }

      try {
        const chatResult = await createMaloumChat(creatorId, fanId);
        const chatId = chatResult.chat?._id || null;
        const assigned = await getMaloumFanAssignedLists(creatorId, fanId);
        const currentIds = (assigned.lists || []).map((list) => list._id);
        if (!currentIds.includes(listId)) {
          await setMaloumFanAssignedLists(creatorId, fanId, [
            ...currentIds,
            listId,
          ]);
        }
        await upsertMaloumFanScrapeFan(creatorId, {
          fanId,
          chatId,
          username: username || null,
          sourceCreatorUsername,
          sourcePostId,
          listId,
        });
        setScrapedFanCount((n) => n + 1);
        return {
          ...cp,
          processedFans: cp.processedFans + 1,
        };
      } catch (err) {
        return {
          ...cp,
          failedFans: cp.failedFans + 1,
          lastError: err instanceof Error ? err.message : 'Failed to process fan',
        };
      }
    },
    []
  );

  const runLoop = useCallback(
    async (creatorId: string) => {
      const runId = ++abortRef.current;
      const signal = {
        get aborted() {
          return abortRef.current !== runId;
        },
      };
      runningRef.current = true;
      setRunning(true);
      setJobError(null);

      try {
        const existing = await getMaloumFanScrapeJob(creatorId);
        // Clear stale "running" from a previous browser session so settings can save.
        if (existing.job.status === 'running') {
          await stopMaloumFanScrapeJob(creatorId);
        }

        let current = await persistConfig();
        if (!current) return;
        if (!current.targetListId) {
          toast.error('Select or create a target list first');
          return;
        }

        const started = await startMaloumFanScrapeJob(creatorId);
        current = started.job;
        setJob(current);

        let cp = await resolveSourceCreators(creatorId, current, signal);
        if (cp.sourceCreators.length === 0) {
          cp = {
            ...cp,
            lastError: 'No source creators to scrape',
          };
          await saveCheckpoint(creatorId, cp, 'failed');
          setStatusLine('No source creators found');
          return;
        }

        while (cp.creatorIndex < cp.sourceCreators.length) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const username = cp.sourceCreators[cp.creatorIndex];
          cp = {
            ...cp,
            currentCreatorUsername: username,
          };
          cp = await ensureCreatorPosts(
            creatorId,
            username,
            current.postsPerCreator || 50,
            cp,
            signal
          );

          while (cp.postIndex < cp.posts.length) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const postId = cp.posts[cp.postIndex];
            cp = {
              ...cp,
              currentPostId: postId,
            };
            setStatusLine(
              `@${username} · post ${cp.postIndex + 1}/${cp.posts.length} · fans ${cp.processedFans}`
            );

            let commentNext: string | undefined =
              cp.commentNext || undefined;
            let pageDone = false;
            while (!pageDone) {
              if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
              await sleep(COMMENT_DELAY_MS, signal);
              const page = await listMaloumPostComments(creatorId, postId, {
                limit: 15,
                next: commentNext,
              });
              const comments = page.comments || [];
              for (const comment of comments) {
                if (signal.aborted) {
                  throw new DOMException('Aborted', 'AbortError');
                }
                const fan = comment.user;
                const fanId = fan?._id;
                if (!fanId || fan.isCreator) {
                  cp = { ...cp, skippedFans: cp.skippedFans + 1 };
                  continue;
                }
                cp = await processFan(
                  creatorId,
                  current.targetListId!,
                  fanId,
                  fan.username,
                  username,
                  postId,
                  cp
                );
                cp = {
                  ...cp,
                  commentNext: page.next || null,
                };
                await saveCheckpoint(creatorId, cp, 'running');
                await sleep(STEP_DELAY_MS, signal);
              }

              if (!page.next || comments.length === 0) {
                pageDone = true;
                commentNext = undefined;
              } else {
                commentNext = page.next;
                cp = { ...cp, commentNext: page.next };
                await saveCheckpoint(creatorId, cp, 'running');
              }
            }

            cp = {
              ...cp,
              postIndex: cp.postIndex + 1,
              commentNext: null,
            };
            await saveCheckpoint(creatorId, cp, 'running');
          }

          cp = {
            ...cp,
            creatorIndex: cp.creatorIndex + 1,
            postIndex: 0,
            posts: [],
            commentNext: null,
            currentPostId: null,
          };
          await saveCheckpoint(creatorId, cp, 'running');
        }

        cp = { ...cp, lastError: null };
        await saveCheckpoint(creatorId, cp, 'completed');
        setStatusLine(
          `Completed · ${cp.processedFans} added · ${cp.skippedFans} skipped · ${cp.failedFans} failed`
        );
        toast.success('Fan scrape completed');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          try {
            const stopped = await stopMaloumFanScrapeJob(creatorId);
            setJob(stopped.job);
            setStatusLine(
              `Paused · ${stopped.job.checkpoint.processedFans} added`
            );
          } catch {
            setStatusLine('Paused');
          }
          return;
        }
        const message = err instanceof Error ? err.message : 'Scrape failed';
        setJobError(message);
        setStatusLine(message);
        try {
          const latest = await getMaloumFanScrapeJob(creatorId);
          await saveCheckpoint(
            creatorId,
            {
              ...latest.job.checkpoint,
              lastError: message,
            },
            'failed'
          );
        } catch {
          /* ignore */
        }
        toast.error(message);
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [
      persistConfig,
      resolveSourceCreators,
      ensureCreatorPosts,
      processFan,
      saveCheckpoint,
      toast,
    ]
  );

  const handleStart = useCallback(async () => {
    if (!selectedCreatorId || runningRef.current) return;
    await runLoop(selectedCreatorId);
  }, [selectedCreatorId, runLoop]);

  const handleStop = useCallback(async () => {
    abortRef.current += 1;
    if (selectedCreatorId) {
      try {
        const stopped = await stopMaloumFanScrapeJob(selectedCreatorId);
        setJob(stopped.job);
      } catch {
        /* loop will also stop */
      }
    }
    setStatusLine('Stopping…');
  }, [selectedCreatorId]);

  const handleReset = useCallback(async () => {
    if (!selectedCreatorId || runningRef.current) return;
    const updated = await persistConfig({ resetCheckpoint: true });
    if (updated) {
      setScrapedFanCount(0);
      setStatusLine('Reset — ready to start');
      toast.success('Progress reset');
      const refreshed = await getMaloumFanScrapeJob(selectedCreatorId);
      setScrapedFanCount(refreshed.scrapedFanCount || 0);
    }
  }, [selectedCreatorId, persistConfig, toast]);

  const creatorsDone = checkpoint.creatorIndex;
  const creatorsTotal = checkpoint.sourceCreators.length || 0;
  const postsDone = checkpoint.postIndex;
  const postsTotal = checkpoint.posts.length || 0;

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
                disabled={running}
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
                  active
                    ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                } ${running && !active ? 'opacity-50' : ''}`}
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
                ? `Scraping with ${selectedCreator.displayName || selectedCreator.username}`
                : 'Select a mother model'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!running ? (
              <button
                type="button"
                disabled={!selectedCreatorId || jobLoading || savingConfig}
                onClick={() => void handleStart()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                Start
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500"
              >
                <Pause className="w-3.5 h-3.5" />
                Stop
              </button>
            )}
            <button
              type="button"
              disabled={running || !selectedCreatorId}
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
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">Creators</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {creatorsDone}/{creatorsTotal || '—'}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-3">
                <p className="text-[11px] text-gray-500 dark:text-zinc-500">Posts (current)</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">
                  {postsDone}/{postsTotal || '—'}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-600 dark:text-zinc-400">
              Status:{' '}
              <span className="font-medium text-gray-900 dark:text-white">
                {running ? 'Running' : job?.status || 'idle'}
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
              After scraping, use{' '}
              <Link
                to="/chatter/maloum/mass-message"
                className="underline underline-offset-2 text-gray-800 dark:text-zinc-200"
              >
                Mass Message
              </Link>{' '}
              with the selected list.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Source
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={running || sourceLocked}
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
                disabled={running || sourceLocked}
                onClick={() => setSourceMode('custom_usernames')}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  sourceMode === 'custom_usernames'
                    ? 'border-gray-900 dark:border-white bg-gray-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'border-gray-200 dark:border-zinc-700'
                } disabled:opacity-50`}
              >
                Custom usernames
              </button>
            </div>

            {sourceMode === 'top_creators' ? (
              <label className="block text-sm space-y-1 max-w-xs">
                <span className="text-xs text-gray-500 dark:text-zinc-500">
                  Top creators limit
                </span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  disabled={running || sourceLocked}
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
                  disabled={running || sourceLocked}
                  value={customUsernamesText}
                  onChange={(e) => setCustomUsernamesText(e.target.value)}
                  placeholder={'stella4twenty\ncreator2\nhttps://app.maloum.com/creator/name'}
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
                disabled={running || sourceLocked}
                value={postsPerCreator}
                onChange={(e) =>
                  setPostsPerCreator(
                    Math.min(200, Math.max(1, Number(e.target.value) || 50))
                  )
                }
                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
              />
            </label>

            {sourceLocked && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Source list is locked for this run. Use Reset progress to change it.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-500">
              Target list
            </h2>
            <div className="flex flex-wrap gap-2 items-end">
              <label className="block text-sm space-y-1 flex-1 min-w-[200px]">
                <span className="text-xs text-gray-500 dark:text-zinc-500">
                  Create new list
                </span>
                <input
                  type="text"
                  disabled={running}
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="Bot - fans"
                  className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                disabled={running || creatingList || !newListName.trim()}
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
                    disabled={running}
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
                disabled={chatListsLoading || running}
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
