import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  LockKeyhole,
  Megaphone,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useToast } from '@/context/ToastContext';
import {
  countTelegramMassRecipients,
  deleteTelegramBumpMessage,
  getTelegramMassCampaign,
  listTelegramLists,
  listTelegramMassMessages,
  listMassMessageLocks,
  lockMassMessage,
  sendTelegramBump,
  stopTelegramMassMessage,
  unlockMassMessage,
  unsendTelegramMassCampaign,
  type TelegramList,
  type MassMessageLock,
  type TelegramMmCampaign,
  type TelegramMmProgress,
  type TelegramMmRecipient,
} from '@/lib/api';
import telegramIcon from '@/assets/telegram_icon.svg';

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function progressLabel(progress: TelegramMmProgress | null | undefined): string | null {
  if (!progress || progress.status === 'idle') return null;
  const total = progress.total || 0;
  const done = (progress.done || 0) + (progress.failed || 0) + (progress.skipped || 0);
  const skipped = progress.skipped ? ` · ${progress.skipped} skipped` : '';
  if (progress.status === 'waiting') {
    return `Waiting… ${done}/${total || '?'}${skipped}`;
  }
  if (progress.status === 'running' || progress.status === 'paused') {
    const verb =
      progress.kind === 'unsend' || progress.kind === 'unsendLast' ? 'Deleting' : 'Bumping';
    return `${verb} ${done}/${total || '?'}${skipped}`;
  }
  return null;
}

function fanLabel(recipient: TelegramMmRecipient): string {
  return recipient.displayName?.trim() || recipient.peerId;
}

function messageLine(campaign: TelegramMmCampaign, recipient: TelegramMmRecipient): string {
  if (recipient.bodyText?.trim()) return recipient.bodyText;
  if (campaign.mode !== 'bump' && recipient.status === 'sent' && campaign.bodyText?.trim()) {
    return campaign.bodyText;
  }
  if (recipient.error?.trim()) return recipient.error;
  return recipient.status;
}

export default function TelegramMassMessage() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { creators, creatorsLoading } = useCreatorLive({
    platform: 'telegram',
    wantBadges: false,
  });

  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [lists, setLists] = useState<TelegramList[]>([]);
  const [includeIds, setIncludeIds] = useState<string[]>([]);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);

  const [campaigns, setCampaigns] = useState<TelegramMmCampaign[]>([]);
  const [massLocks, setMassLocks] = useState<MassMessageLock[]>([]);
  const [lockingId, setLockingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<TelegramMmProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [unsendingId, setUnsendingId] = useState<string | null>(null);
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Record<string, TelegramMmRecipient[]>>({});
  const [recipientsLoadingId, setRecipientsLoadingId] = useState<string | null>(null);
  const [deletingRecipientId, setDeletingRecipientId] = useState<string | null>(null);

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
    try {
      const result = await listTelegramLists(selectedCreatorId);
      setLists(result.lists || []);
    } catch {
      setLists([]);
    }
  }, [selectedCreatorId]);

  const loadCampaigns = useCallback(async () => {
    if (!selectedCreatorId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listTelegramMassMessages(selectedCreatorId);
      setCampaigns(result.campaigns || []);
      setProgress(result.progress || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bumps');
    } finally {
      setLoading(false);
    }
  }, [selectedCreatorId]);

  const loadRecipients = useCallback(
    async (campaignId: string) => {
      if (!selectedCreatorId) return;
      setRecipientsLoadingId(campaignId);
      try {
        const result = await getTelegramMassCampaign(selectedCreatorId, campaignId);
        setRecipients((prev) => ({ ...prev, [campaignId]: result.recipients || [] }));
        setCampaigns((prev) =>
          prev.map((item) => (item.id === result.campaign.id ? { ...item, ...result.campaign } : item))
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        setRecipientsLoadingId((current) => (current === campaignId ? null : current));
      }
    },
    [selectedCreatorId, toast]
  );

  useEffect(() => {
    setIncludeIds([]);
    setExcludeIds([]);
    setRecipientCount(null);
    setSendError(null);
    setOpenCampaignId(null);
    setRecipients({});
    if (!selectedCreatorId) return;
    void loadLists();
    void loadCampaigns();
  }, [selectedCreatorId, loadLists, loadCampaigns]);

  const lockedIds = useMemo(
    () => new Set(massLocks.map((lock) => lock.platformMessageId)),
    [massLocks]
  );

  const loadMassLocks = useCallback(async (creatorId: string) => {
    try {
      const result = await listMassMessageLocks(creatorId, 'telegram');
      setMassLocks(result.locks || []);
    } catch {
      setMassLocks([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedCreatorId) {
      setMassLocks([]);
      return;
    }
    void loadMassLocks(selectedCreatorId);
  }, [selectedCreatorId, loadMassLocks]);

  const toggleMassLock = useCallback(
    async (campaign: TelegramMmCampaign) => {
      if (!selectedCreatorId || lockingId) return;
      const locked = lockedIds.has(campaign.id);
      setLockingId(campaign.id);
      try {
        if (locked) {
          await unlockMassMessage(selectedCreatorId, {
            platform: 'telegram',
            platformMessageId: campaign.id,
          });
        } else {
          await lockMassMessage(selectedCreatorId, {
            platform: 'telegram',
            platformMessageId: campaign.id,
            bodyText: campaign.mode === 'bump' ? 'Personal bumps' : campaign.bodyText || '',
            mediaIds: campaign.vaultIds || [],
          });
        }
        await loadMassLocks(selectedCreatorId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update lock');
      } finally {
        setLockingId(null);
      }
    },
    [selectedCreatorId, lockingId, lockedIds, loadMassLocks, toast]
  );

  const busy =
    progress?.status === 'running' ||
    progress?.status === 'waiting' ||
    sending;

  useEffect(() => {
    if (!selectedCreatorId || !busy) return;
    const timer = window.setInterval(() => {
      void listTelegramMassMessages(selectedCreatorId)
        .then((result) => {
          setCampaigns(result.campaigns || []);
          setProgress(result.progress || null);
        })
        .catch(() => undefined);
      if (openCampaignId) {
        void getTelegramMassCampaign(selectedCreatorId, openCampaignId)
          .then((result) => {
            setRecipients((prev) => ({
              ...prev,
              [openCampaignId]: result.recipients || [],
            }));
          })
          .catch(() => undefined);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [selectedCreatorId, busy, openCampaignId]);

  useEffect(() => {
    if (!selectedCreatorId || includeIds.length === 0) {
      setRecipientCount(null);
      return;
    }
    let cancelled = false;
    setCountLoading(true);
    void countTelegramMassRecipients(selectedCreatorId, includeIds, excludeIds)
      .then((result) => {
        if (!cancelled) setRecipientCount(result.count);
      })
      .catch(() => {
        if (!cancelled) setRecipientCount(null);
      })
      .finally(() => {
        if (!cancelled) setCountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCreatorId, includeIds, excludeIds]);

  function toggleList(id: string, target: 'include' | 'exclude') {
    if (target === 'include') {
      setIncludeIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      );
      setExcludeIds((prev) => prev.filter((item) => item !== id));
      return;
    }
    setExcludeIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
    setIncludeIds((prev) => prev.filter((item) => item !== id));
  }

  const handleStart = useCallback(async () => {
    if (!selectedCreatorId || sending) return;
    if (includeIds.length === 0) {
      setSendError('Select at least one include list');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const result = await sendTelegramBump(selectedCreatorId, {
        includeListIds: includeIds,
        excludeListIds: excludeIds,
      });
      setCampaigns((prev) => [
        result.campaign,
        ...prev.filter((item) => item.id !== result.campaign.id),
      ]);
      setProgress(result.progress);
      toast.success(
        result.campaign.total === 0
          ? 'No recipients in the selected lists'
          : `Bumping ${result.campaign.total} fans`
      );
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to start bumps');
    } finally {
      setSending(false);
    }
  }, [selectedCreatorId, sending, includeIds, excludeIds, toast]);

  const handleDeleteBump = useCallback(
    async (campaign: TelegramMmCampaign) => {
      if (!selectedCreatorId || unsendingId) return;
      const ok = await confirm({
        title: 'Delete bump',
        message: 'Delete this bump from each fan chat? This walks chats one by one.',
        confirmLabel: 'Delete bump',
        variant: 'danger',
      });
      if (!ok) return;
      setUnsendingId(campaign.id);
      try {
        const result = await unsendTelegramMassCampaign(selectedCreatorId, campaign.id);
        setProgress(result.progress);
        await loadCampaigns();
        if (openCampaignId === campaign.id) await loadRecipients(campaign.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete bump');
      } finally {
        setUnsendingId(null);
      }
    },
    [selectedCreatorId, unsendingId, confirm, loadCampaigns, loadRecipients, openCampaignId, toast]
  );

  const handleToggleCheck = useCallback(
    (campaignId: string) => {
      setOpenCampaignId((current) => {
        const next = current === campaignId ? null : campaignId;
        if (next) void loadRecipients(next);
        return next;
      });
    },
    [loadRecipients]
  );

  const handleDeleteMessage = useCallback(
    async (campaign: TelegramMmCampaign, recipient: TelegramMmRecipient) => {
      if (!selectedCreatorId || deletingRecipientId) return;
      const ok = await confirm({
        title: 'Delete message',
        message: `Delete this bump from ${fanLabel(recipient)}'s chat?`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingRecipientId(recipient.id);
      try {
        const result = await deleteTelegramBumpMessage(
          selectedCreatorId,
          campaign.id,
          recipient.id
        );
        const nextRecipient = result.recipient;
        setCampaigns((prev) =>
          prev.map((item) =>
            item.id === result.campaign.id ? { ...item, ...result.campaign } : item
          )
        );
        if (nextRecipient) {
          setRecipients((prev) => ({
            ...prev,
            [campaign.id]: (prev[campaign.id] || []).map((row) =>
              row.id === nextRecipient.id ? nextRecipient : row
            ),
          }));
        } else {
          await loadRecipients(campaign.id);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete message');
        await loadRecipients(campaign.id);
      } finally {
        setDeletingRecipientId(null);
      }
    },
    [selectedCreatorId, deletingRecipientId, confirm, loadRecipients, toast]
  );

  const liveLabel = progressLabel(progress);

  return (
    <AppShell title="Telegram Bumps" activePage="chatter" bleed headerExtras={<><WorkspaceDrawerButton id="telegram-mass-accounts" size="lg" label="Creators" className="lg:hidden" /></>}>

      <WorkspaceDrawer id="telegram-mass-accounts" size="lg" className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Bumps
          </span>
        </div>
        <div data-drawer-list className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
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
      </WorkspaceDrawer>

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!selectedCreatorId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            Select a creator
          </div>
        ) : (
          <>
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-sky-600/20 flex items-center justify-center border border-sky-500/30">
                  <Megaphone className="w-4 h-4 text-sky-500" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Bumps
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    {liveLabel || 'A short personal German line for each fan'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {busy && (
                  <button
                    type="button"
                    onClick={() =>
                      selectedCreatorId && void stopTelegramMassMessage(selectedCreatorId)
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-zinc-700"
                  >
                    <Square className="w-3 h-3" />
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadCampaigns()}
                  className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {error && <p className="text-sm text-red-400">{error}</p>}
              {loading && campaigns.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {!loading && campaigns.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-12">No bumps yet.</p>
              )}
              {campaigns.map((campaign) => {
                const isLocked = lockedIds.has(campaign.id);
                const open = openCampaignId === campaign.id;
                const rows = recipients[campaign.id] || [];
                const canDeleteRun = campaign.sent > 0 && campaign.status !== 'unsending' && !isLocked;
                return (
                <article
                  key={campaign.id}
                  className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">
                      {campaign.mode === 'bump'
                        ? 'Personal bumps'
                        : campaign.bodyText || '(media only)'}
                    </p>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void toggleMassLock(campaign)}
                        disabled={lockingId === campaign.id}
                        className={`p-1.5 rounded-lg disabled:opacity-40 ${
                          isLocked
                            ? 'text-amber-500 hover:bg-amber-500/10'
                            : 'text-gray-400 hover:text-amber-500 hover:bg-amber-500/10'
                        }`}
                        title={
                          isLocked
                            ? 'Undeleteable. Click to allow delete'
                            : 'Make undeleteable'
                        }
                        aria-label={isLocked ? 'Unlock bump' : 'Make undeleteable'}
                      >
                        {lockingId === campaign.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <LockKeyhole className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">
                        {campaign.status}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    {campaign.sent}/{campaign.total} sent
                    {campaign.skipped ? ` · ${campaign.skipped} skipped` : ''}
                    {campaign.failed ? ` · ${campaign.failed} failed` : ''}
                    {campaign.unsent ? ` · ${campaign.unsent} deleted` : ''}
                    {campaign.createdAt ? ` · ${formatWhen(campaign.createdAt)}` : ''}
                  </p>
                  {campaign.lastError && (
                    <p className="text-[11px] text-red-400">{campaign.lastError}</p>
                  )}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleToggleCheck(campaign.id)}
                      className="text-xs text-sky-600 hover:underline"
                    >
                      {open ? 'Hide messages' : 'Check messages'}
                    </button>
                    {canDeleteRun && (
                      <button
                        type="button"
                        disabled={Boolean(unsendingId) || busy}
                        onClick={() => void handleDeleteBump(campaign)}
                        className="inline-flex items-center gap-1 text-xs text-red-500 hover:underline disabled:opacity-40"
                      >
                        {unsendingId === campaign.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Trash2 className="w-3 h-3" />
                        )}
                        Delete bump
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="rounded-lg border border-gray-100 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800">
                      {recipientsLoadingId === campaign.id && rows.length === 0 && (
                        <div className="flex justify-center py-4">
                          <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                        </div>
                      )}
                      {rows.length === 0 && recipientsLoadingId !== campaign.id && (
                        <p className="px-3 py-3 text-xs text-gray-500">No messages.</p>
                      )}
                      {rows.map((recipient) => {
                        const canDeleteOne =
                          !isLocked &&
                          (recipient.status === 'sent' || recipient.status === 'unsend_failed');
                        return (
                          <div
                            key={recipient.id}
                            className="px-3 py-2 flex items-start gap-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-gray-800 dark:text-zinc-200 truncate">
                                {fanLabel(recipient)}
                                <span className="ml-2 font-normal uppercase tracking-wide text-[10px] text-gray-400">
                                  {recipient.status}
                                </span>
                              </p>
                              <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap mt-0.5">
                                {messageLine(campaign, recipient)}
                              </p>
                            </div>
                            {canDeleteOne && (
                              <button
                                type="button"
                                disabled={Boolean(deletingRecipientId) || Boolean(unsendingId) || busy}
                                onClick={() => void handleDeleteMessage(campaign, recipient)}
                                className="inline-flex items-center gap-1 shrink-0 text-xs text-red-500 hover:underline disabled:opacity-40"
                              >
                                {deletingRecipientId === recipient.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3 h-3" />
                                )}
                                Delete
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
                );
              })}
            </div>

            <div className="border-t border-gray-200 dark:border-zinc-800 shrink-0 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                    Include
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {lists.map((list) => {
                      const on = includeIds.includes(list.id);
                      return (
                        <button
                          key={`in-${list.id}`}
                          type="button"
                          onClick={() => toggleList(list.id, 'include')}
                          className={`px-2 py-1 rounded-md text-[11px] border ${
                            on
                              ? 'bg-sky-600/15 border-sky-500/50 text-sky-600'
                              : 'border-gray-200 dark:border-zinc-700 text-gray-500'
                          }`}
                        >
                          {list.name}
                          <span className="ml-1 opacity-70">{list.memberCount}</span>
                        </button>
                      );
                    })}
                    {lists.length === 0 && (
                      <p className="text-xs text-gray-500">Create lists first.</p>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                    Exclude
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {lists.map((list) => {
                      const on = excludeIds.includes(list.id);
                      return (
                        <button
                          key={`ex-${list.id}`}
                          type="button"
                          onClick={() => toggleList(list.id, 'exclude')}
                          className={`px-2 py-1 rounded-md text-[11px] border ${
                            on
                              ? 'bg-red-500/10 border-red-500/50 text-red-500'
                              : 'border-gray-200 dark:border-zinc-700 text-gray-500'
                          }`}
                        >
                          {list.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500 inline-flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  {countLoading
                    ? 'Counting fans…'
                    : includeIds.length === 0
                      ? 'Select at least one include list'
                      : `${recipientCount ?? 0} fans`}
                </p>
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={sending || busy || includeIds.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-600 text-white text-sm hover:bg-sky-500 disabled:opacity-40"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Start bump
                </button>
              </div>
              {sendError && <p className="text-xs text-red-400">{sendError}</p>}
            </div>
          </>
        )}
      </main>
    </AppShell>
  );
}
