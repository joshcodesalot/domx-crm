import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Image as ImageIcon,
  Loader2,
  Megaphone,
  RefreshCw,
  Send,
  Square,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ToggleSwitch from '@/components/ToggleSwitch';
import ScheduleDateTimePicker from '@/components/ScheduleDateTimePicker';
import TelegramVaultModal from '@/components/telegram/TelegramVaultModal';
import { TelegramVoiceTile } from '@/components/telegram/TelegramAudioPlayer';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useToast } from '@/context/ToastContext';
import { berlinNowParts, berlinWallToIso, useStaffTimeZone } from '@/lib/berlinTime';
import {
  countTelegramMassRecipients,
  createScheduledContent,
  listTelegramLists,
  listTelegramMassMessages,
  sendTelegramMassMessage,
  stopTelegramMassMessage,
  telegramVaultMediaUrl,
  unsendLastTelegramMassMessages,
  unsendTelegramMassCampaign,
  type TelegramList,
  type TelegramMmCampaign,
  type TelegramMmProgress,
  type TelegramVaultItem,
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
  const done = (progress.done || 0) + (progress.failed || 0);
  if (progress.status === 'waiting') {
    return `Waiting… ${done}/${total || '?'}`;
  }
  if (progress.status === 'running' || progress.status === 'paused') {
    return `${progress.kind === 'unsend' || progress.kind === 'unsendLast' ? 'Unsending' : 'Sending'} ${done}/${total || '?'}`;
  }
  return null;
}

export default function TelegramMassMessage() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const timeZone = useStaffTimeZone();
  const now = berlinNowParts(timeZone);
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
  const [progress, setProgress] = useState<TelegramMmProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [vaultItems, setVaultItems] = useState<TelegramVaultItem[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(now.date);
  const [scheduleTime, setScheduleTime] = useState(now.time);
  const [unsendingId, setUnsendingId] = useState<string | null>(null);
  const [unsendingLast, setUnsendingLast] = useState(false);

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
      setError(err instanceof Error ? err.message : 'Failed to load mass messages');
    } finally {
      setLoading(false);
    }
  }, [selectedCreatorId]);

  useEffect(() => {
    setIncludeIds([]);
    setExcludeIds([]);
    setRecipientCount(null);
    setDraft('');
    setVaultItems([]);
    setSendError(null);
    if (!selectedCreatorId) return;
    void loadLists();
    void loadCampaigns();
  }, [selectedCreatorId, loadLists, loadCampaigns]);

  const busy =
    progress?.status === 'running' ||
    progress?.status === 'waiting' ||
    sending ||
    unsendingLast;

  useEffect(() => {
    if (!selectedCreatorId || !busy) return;
    const timer = window.setInterval(() => {
      void listTelegramMassMessages(selectedCreatorId)
        .then((result) => {
          setCampaigns(result.campaigns || []);
          setProgress(result.progress || null);
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [selectedCreatorId, busy]);

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

  const handleSend = useCallback(async () => {
    if (!selectedCreatorId || sending) return;
    const text = draft.trim();
    if (!text && vaultItems.length === 0) {
      setSendError('Add text or media');
      return;
    }
    if (includeIds.length === 0) {
      setSendError('Select at least one include list');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      if (scheduleEnabled) {
        await createScheduledContent({
          kind: 'mass_message',
          creatorId: selectedCreatorId,
          platform: 'telegram',
          runAt: berlinWallToIso(scheduleDate, scheduleTime, timeZone),
          bodyText: text,
          payload: {
            includeFromLists: includeIds.map((id) => {
              const list = lists.find((item) => item.id === id);
              return { id, name: list?.name || '' };
            }),
            excludeFromLists: excludeIds.map((id) => {
              const list = lists.find((item) => item.id === id);
              return { id, name: list?.name || '' };
            }),
            vaultIds: vaultItems.map((item) => item.id),
          },
        });
        toast.success(`Mass message scheduled (${timeZone})`);
        setDraft('');
        setVaultItems([]);
        return;
      }
      const result = await sendTelegramMassMessage(selectedCreatorId, {
        text,
        englishText: text,
        vaultIds: vaultItems.map((item) => item.id),
        includeListIds: includeIds,
        excludeListIds: excludeIds,
      });
      setCampaigns((prev) => [
        result.campaign,
        ...prev.filter((item) => item.id !== result.campaign.id),
      ]);
      setProgress(result.progress);
      setDraft('');
      setVaultItems([]);
      toast.success(
        result.campaign.total === 0
          ? 'No recipients in the selected lists'
          : `Sending to ${result.campaign.total} fans`
      );
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send mass message');
    } finally {
      setSending(false);
    }
  }, [
    selectedCreatorId,
    sending,
    draft,
    vaultItems,
    includeIds,
    excludeIds,
    lists,
    scheduleEnabled,
    scheduleDate,
    scheduleTime,
    timeZone,
    toast,
  ]);

  const handleUnsend = useCallback(
    async (campaign: TelegramMmCampaign) => {
      if (!selectedCreatorId || unsendingId) return;
      const ok = await confirm({
        title: 'Unsend mass message',
        message: 'Delete this campaign from each fan chat? This walks chats one by one.',
        confirmLabel: 'Unsend',
        variant: 'danger',
      });
      if (!ok) return;
      setUnsendingId(campaign.id);
      try {
        const result = await unsendTelegramMassCampaign(selectedCreatorId, campaign.id);
        setProgress(result.progress);
        await loadCampaigns();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to unsend');
      } finally {
        setUnsendingId(null);
      }
    },
    [selectedCreatorId, unsendingId, confirm, loadCampaigns, toast]
  );

  const handleUnsendLast = useCallback(async () => {
    if (!selectedCreatorId || unsendingLast) return;
    const ok = await confirm({
      title: 'Unsend last 30',
      message: 'Unsend the last 30 Telegram mass-message campaigns for this creator?',
      confirmLabel: 'Unsend last 30',
      variant: 'danger',
    });
    if (!ok) return;
    setUnsendingLast(true);
    try {
      const result = await unsendLastTelegramMassMessages(selectedCreatorId, 30);
      setProgress(result.progress);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unsend last campaigns');
    } finally {
      setUnsendingLast(false);
    }
  }, [selectedCreatorId, unsendingLast, confirm, toast]);

  const liveLabel = progressLabel(progress);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Mass Message
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
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
      </aside>

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
                    {selectedCreator?.displayName || 'Creator'} — Sent mass messages
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    {liveLabel || 'Sends one DM at a time with delays'}
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
                  onClick={() => void handleUnsendLast()}
                  disabled={unsendingLast || busy}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-zinc-700 disabled:opacity-40"
                >
                  {unsendingLast ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Undo2 className="w-3 h-3" />
                  )}
                  Unsend last 30
                </button>
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
                <p className="text-sm text-gray-500 text-center py-12">No mass messages yet.</p>
              )}
              {campaigns.map((campaign) => (
                <article
                  key={campaign.id}
                  className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">
                      {campaign.bodyText || '(media only)'}
                    </p>
                    <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0">
                      {campaign.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    {campaign.sent}/{campaign.total} sent
                    {campaign.failed ? ` · ${campaign.failed} failed` : ''}
                    {campaign.unsent ? ` · ${campaign.unsent} unsent` : ''}
                    {campaign.createdAt ? ` · ${formatWhen(campaign.createdAt)}` : ''}
                  </p>
                  {campaign.lastError && (
                    <p className="text-[11px] text-red-400">{campaign.lastError}</p>
                  )}
                  {campaign.sent > 0 && campaign.status !== 'unsending' && (
                    <button
                      type="button"
                      disabled={Boolean(unsendingId) || busy}
                      onClick={() => void handleUnsend(campaign)}
                      className="inline-flex items-center gap-1 text-xs text-red-500 hover:underline disabled:opacity-40"
                    >
                      {unsendingId === campaign.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Undo2 className="w-3 h-3" />
                      )}
                      Unsend this campaign
                    </button>
                  )}
                </article>
              ))}
            </div>

            <div className="border-t border-gray-200 dark:border-zinc-800 p-4 space-y-3 shrink-0">
              <div className="grid grid-cols-2 gap-3 max-h-36 overflow-y-auto">
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

              <p className="text-xs text-gray-500 inline-flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                {countLoading
                  ? 'Counting recipients…'
                  : includeIds.length === 0
                    ? 'Select at least one include list'
                    : `${recipientCount ?? 0} recipients`}
              </p>

              {vaultItems.length > 0 && (
                <div className="flex items-center gap-2">
                  {vaultItems.map((item) =>
                    item.kind === 'voice' ? (
                      <div
                        key={item.id}
                        className="w-12 h-12 rounded-lg overflow-hidden border border-gray-200 dark:border-zinc-700"
                      >
                        <TelegramVoiceTile duration={item.duration} />
                      </div>
                    ) : (
                      <img
                        key={item.id}
                        src={telegramVaultMediaUrl(selectedCreatorId, item.id, 'thumb')}
                        alt=""
                        className="w-12 h-12 rounded-lg object-cover"
                      />
                    )
                  )}
                  <button
                    type="button"
                    onClick={() => setVaultItems([])}
                    className="p-1 text-gray-400 hover:text-gray-700"
                    aria-label="Clear media"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {sendError && <p className="text-xs text-red-400">{sendError}</p>}

              <label className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium inline-flex items-center gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5" />
                  Schedule instead of sending now
                </span>
                <ToggleSwitch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  aria-label="Schedule mass message"
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

              <div className="flex items-end gap-2 rounded-2xl border border-gray-200 dark:border-zinc-800 p-2">
                <button
                  type="button"
                  onClick={() => setVaultOpen(true)}
                  className="p-2 rounded-xl text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
                  title="Open Media Vault"
                >
                  <ImageIcon className="w-5 h-5" />
                </button>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder="Type a mass message…"
                  className="flex-1 max-h-32 min-h-[44px] resize-none px-2 py-3 text-sm bg-transparent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={
                    sending ||
                    (!draft.trim() && vaultItems.length === 0) ||
                    includeIds.length === 0
                  }
                  className="p-3 rounded-xl bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40"
                  title={scheduleEnabled ? 'Schedule mass message' : 'Send mass message'}
                >
                  {sending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : scheduleEnabled ? (
                    <CalendarClock className="w-5 h-5" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {vaultOpen && selectedCreatorId && (
        <TelegramVaultModal
          creatorId={selectedCreatorId}
          fanId={null}
          selectedItems={vaultItems}
          onChangeSelected={setVaultItems}
          onClose={() => setVaultOpen(false)}
        />
      )}
    </div>
  );
}
