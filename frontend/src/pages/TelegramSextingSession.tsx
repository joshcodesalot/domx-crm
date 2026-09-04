import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, Plus, Send, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import TelegramVaultModal from '@/components/telegram/TelegramVaultModal';
import { TelegramVoiceTile } from '@/components/telegram/TelegramAudioPlayer';
import {
  SEXTING_FORM_INPUT_CLASS,
  TelegramSextingSessionForm,
} from '@/components/telegram/TelegramSextingSessionForm';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import {
  createMessagingDashboardEntry,
  deleteTelegramSextingSession,
  getTelegramSextingSession,
  listTelegramSextingSessions,
  sendTelegramSextingSessionBlock,
  telegramVaultMediaUrl,
  translateToGerman,
  updateTelegramSextingSessionBlock,
  type TelegramSextingSession,
  type TelegramSextingSessionBlock,
  type TelegramVaultItem,
} from '@/lib/api';
import telegramIcon from '@/assets/telegram_icon.svg';

const NEW_SESSION_ID = 'new';
const AUTO_TRANSLATE_OUTGOING_KEY = 'domx_auto_translate_outgoing';

function readAutoTranslateOutgoing(): boolean {
  const stored = localStorage.getItem(AUTO_TRANSLATE_OUTGOING_KEY);
  if (stored === 'false') return false;
  return true;
}

function stubVaultItems(ids: string[]): TelegramVaultItem[] {
  return ids.map((id) => ({
    id,
    folderId: null,
    savedMessageId: '',
    kind: 'photo',
  }));
}

export default function TelegramSextingSession() {
  const { toast } = useToast();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionFromUrl = searchParams.get('session') || '';

  const [sessions, setSessions] = useState<TelegramSextingSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(
    sessionFromUrl || NEW_SESSION_ID
  );
  const [session, setSession] = useState<TelegramSextingSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [vaultByBlock, setVaultByBlock] = useState<Record<string, TelegramVaultItem[]>>(
    {}
  );
  const [vaultBlockId, setVaultBlockId] = useState<string | null>(null);
  const [sendingBlockId, setSendingBlockId] = useState<string | null>(null);
  const [savingBlockId, setSavingBlockId] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);

  useEffect(() => {
    if (sessionFromUrl && sessionFromUrl !== selectedId) {
      setSelectedId(sessionFromUrl);
    }
  }, [sessionFromUrl, selectedId]);

  function selectSession(id: string) {
    setSelectedId(id);
    if (id === NEW_SESSION_ID) {
      setSearchParams({});
      return;
    }
    setSearchParams({ session: id });
  }

  const loadSessions = useCallback(async () => {
    try {
      const result = await listTelegramSextingSessions();
      setSessions(result.sessions || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setSessionsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const applySession = useCallback((next: TelegramSextingSession, replaceDrafts = false) => {
    setSession(next);
    setDrafts((prev) => {
      const merged: Record<string, string> = replaceDrafts ? {} : { ...prev };
      for (const block of next.blocks || []) {
        if (replaceDrafts || merged[block.id] == null || block.status === 'sent') {
          merged[block.id] = block.englishText;
        }
      }
      return merged;
    });
    setVaultByBlock((prev) => {
      const merged: Record<string, TelegramVaultItem[]> = replaceDrafts ? {} : { ...prev };
      for (const block of next.blocks || []) {
        if (replaceDrafts || merged[block.id] == null || block.status === 'sent') {
          merged[block.id] = stubVaultItems(block.vaultIds || []);
        }
      }
      return merged;
    });
  }, []);

  const loadSession = useCallback(
    async (id: string) => {
      setSessionLoading(true);
      try {
        const result = await getTelegramSextingSession(id);
        applySession(result.session, true);
        setSessions((prev) => {
          const exists = prev.some((item) => item.id === result.session.id);
          if (!exists) return [result.session, ...prev];
          return prev.map((item) =>
            item.id === result.session.id
              ? {
                  ...item,
                  pendingCount: result.session.pendingCount,
                  sentCount: result.session.sentCount,
                }
              : item
          );
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load session');
        setSession(null);
      } finally {
        setSessionLoading(false);
      }
    },
    [applySession, toast]
  );

  useEffect(() => {
    if (selectedId === NEW_SESSION_ID) {
      setSession(null);
      return;
    }
    void loadSession(selectedId);
  }, [selectedId, loadSession]);

  async function persistBlock(
    block: TelegramSextingSessionBlock,
    englishText: string,
    vaultItems: TelegramVaultItem[]
  ) {
    setSavingBlockId(block.id);
    try {
      const result = await updateTelegramSextingSessionBlock(block.sessionId, block.id, {
        englishText,
        vaultIds: vaultItems.map((item) => item.id),
      });
      applySession(result.session);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save block');
    } finally {
      setSavingBlockId(null);
    }
  }

  async function handleSend(block: TelegramSextingSessionBlock) {
    if (sendingBlockId || block.status === 'sent') return;
    const english = (drafts[block.id] ?? block.englishText).trim();
    const vaultItems = vaultByBlock[block.id] || [];
    if (!english && vaultItems.length === 0) {
      toast.error('Add text or media before sending');
      return;
    }

    setSendingBlockId(block.id);
    try {
      let textToSend = english;
      if (english && readAutoTranslateOutgoing()) {
        textToSend = await translateToGerman(english);
      }
      const result = await sendTelegramSextingSessionBlock(block.sessionId, block.id, {
        text: textToSend,
        englishText: english,
        vaultIds: vaultItems.map((item) => item.id),
      });
      applySession(result.session);
      setSessions((prev) =>
        prev.map((item) =>
          item.id === result.session.id
            ? {
                ...item,
                pendingCount: result.session.pendingCount,
                sentCount: result.session.sentCount,
              }
            : item
        )
      );

      if (user?.id && result.telegramMessageId) {
        void createMessagingDashboardEntry({
          id: crypto.randomUUID(),
          creatorId: block.creatorId,
          creatorName: block.creatorName,
          creatorAvatarUrl: block.creatorAvatarUrl,
          chatterId: user.id,
          chatterName: user.name,
          chatterEmail: user.email,
          chatId: session?.groupPeerId || '',
          fanId: session?.groupPeerId || '',
          fanUsername: session?.fanName || null,
          maloumMessageId: `telegram:${result.telegramMessageId}`,
          contentType: vaultItems.length ? 'media' : 'text',
          englishMessage: english || null,
          germanTranslatedMessage: textToSend || null,
          actualSentText: textToSend || null,
          mediaCount: vaultItems.length,
          pictureCount: vaultItems.filter((item) => item.kind === 'photo').length,
          videoCount: vaultItems.filter((item) => item.kind === 'video').length,
          sentAt: new Date().toISOString(),
        }).catch(() => {
          // Persistence failures are non-blocking for the session UI.
        });
      }
      toast.success(`Block ${block.blockIndex} sent`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send block');
    } finally {
      setSendingBlockId(null);
    }
  }

  async function handleDeleteSession() {
    if (!session || deletingSession) return;
    const ok = await confirm({
      title: 'Delete session',
      message: `Delete “${session.fanName}”? This cannot be undone. Already sent Telegram messages stay in the group.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingSession(true);
    try {
      await deleteTelegramSextingSession(session.id);
      setSessions((prev) => prev.filter((item) => item.id !== session.id));
      setSession(null);
      selectSession(NEW_SESSION_ID);
      toast.success('Session deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete session');
    } finally {
      setDeletingSession(false);
    }
  }

  const vaultBlock = session?.blocks?.find((block) => block.id === vaultBlockId) || null;

  return (
    <div className="bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 h-screen flex antialiased overflow-hidden">
      <Sidebar activePage="chatter" />
      <main className="flex-1 flex min-w-0 overflow-hidden">
        <aside className="w-80 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
          <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full" />
              <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                Sexting Sessions
              </span>
            </div>
            <button
              type="button"
              onClick={() => selectSession(NEW_SESSION_ID)}
              className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {sessionsLoading && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading…</p>
            )}
            {!sessionsLoading && sessions.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
                No sessions yet. Generate one to start.
              </p>
            )}
            {sessions.map((item) => {
              const active = selectedId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectSession(item.id)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 border transition-colors ${
                    active
                      ? 'bg-sky-50 border-sky-200 dark:bg-sky-900/20 dark:border-sky-800'
                      : 'border-transparent hover:bg-gray-100 dark:hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {item.fanName}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-zinc-500 shrink-0">
                      {item.sentCount}/{item.sentCount + item.pendingCount} sent
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-zinc-500 truncate mt-0.5">
                    Chat {item.groupPeerId}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-1.5 py-0.5 text-[10px]">
                      {item.pendingCount} pending
                    </span>
                    <span className="rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 px-1.5 py-0.5 text-[10px]">
                      {item.sentCount} sent
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex-1 min-w-0 overflow-y-auto">
          {selectedId === NEW_SESSION_ID ? (
            <TelegramSextingSessionForm
              onCreated={(created) => {
                applySession(created, true);
                setSessions((prev) => [
                  created,
                  ...prev.filter((item) => item.id !== created.id),
                ]);
                selectSession(created.id);
              }}
            />
          ) : sessionLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">
              Loading session…
            </div>
          ) : session ? (
            <div className="max-w-4xl mx-auto p-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {session.fanName}
                  </h1>
                  <p className="text-sm text-gray-500 dark:text-zinc-500 mt-1">
                    Slave {session.slaveName} · Chat {session.groupPeerId} · {session.pendingCount} pending ·{' '}
                    {session.sentCount} sent
                  </p>
                  <p className="text-xs text-gray-400 dark:text-zinc-500 mt-1">
                    Add media, edit the English text, then send at the right time.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={deletingSession}
                  onClick={() => void handleDeleteSession()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-900/50 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 shrink-0"
                >
                  {deletingSession ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  Delete session
                </button>
              </div>

              <div className="space-y-3">
                {(session.blocks || []).map((block) => {
                  const vaultItems = vaultByBlock[block.id] || [];
                  const sent = block.status === 'sent';
                  const sending = sendingBlockId === block.id;
                  return (
                    <article
                      key={block.id}
                      className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-semibold text-gray-500 dark:text-zinc-500">
                            Block {block.blockIndex}
                          </span>
                          <CreatorAvatar
                            avatarUrl={block.creatorAvatarUrl}
                            displayName={block.creatorName}
                            className="w-6 h-6 rounded-full object-cover"
                            initialsClassName="w-6 h-6 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-[10px]"
                          />
                          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {block.creatorName}
                          </span>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                            sent
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                          }`}
                        >
                          {sent ? 'sent' : 'pending'}
                        </span>
                      </div>

                      <textarea
                        className={`${SEXTING_FORM_INPUT_CLASS} min-h-[140px] resize-y`}
                        value={drafts[block.id] ?? block.englishText}
                        disabled={sent}
                        onChange={(event) =>
                          setDrafts((prev) => ({ ...prev, [block.id]: event.target.value }))
                        }
                        onBlur={() => {
                          if (sent) return;
                          const next = drafts[block.id] ?? block.englishText;
                          if (next === block.englishText) return;
                          void persistBlock(block, next, vaultItems);
                        }}
                      />

                      {vaultItems.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {vaultItems.map((item) => (
                            <div key={item.id} className="relative">
                              {item.kind === 'voice' ? (
                                <div className="w-14 h-14 rounded-md overflow-hidden border border-gray-200 dark:border-white/10">
                                  <TelegramVoiceTile duration={item.duration} />
                                </div>
                              ) : (
                                <img
                                  src={telegramVaultMediaUrl(block.creatorId, item.id, 'thumb')}
                                  alt=""
                                  className="w-14 h-14 rounded-md object-cover border border-gray-200 dark:border-white/10"
                                />
                              )}
                              {!sent && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = vaultItems.filter((entry) => entry.id !== item.id);
                                    setVaultByBlock((prev) => ({ ...prev, [block.id]: next }));
                                    void persistBlock(
                                      block,
                                      drafts[block.id] ?? block.englishText,
                                      next
                                    );
                                  }}
                                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          disabled={sent}
                          onClick={() => setVaultBlockId(block.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          Add media
                        </button>
                        <button
                          type="button"
                          disabled={sent || sending || savingBlockId === block.id}
                          onClick={() => void handleSend(block)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                        >
                          {sending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          {sent ? 'Sent' : sending ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">
              Select a session
            </div>
          )}
        </section>
      </main>

      {vaultBlock && (
        <TelegramVaultModal
          creatorId={vaultBlock.creatorId}
          fanId={session?.groupPeerId || null}
          mode="composer"
          selectedItems={vaultByBlock[vaultBlock.id] || []}
          onChangeSelected={(items) => {
            setVaultByBlock((prev) => ({ ...prev, [vaultBlock.id]: items }));
            void persistBlock(
              vaultBlock,
              drafts[vaultBlock.id] ?? vaultBlock.englishText,
              items
            );
          }}
          onClose={() => setVaultBlockId(null)}
        />
      )}
    </div>
  );
}
