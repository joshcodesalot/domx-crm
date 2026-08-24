import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { DEFAULT_FAN_NOTES_TEMPLATE } from '@/components/maloum/MaloumFanPanel';
import {
  getTelegramGroupMembers,
  patchTelegramFan,
  resolveCreatorAvatarUrl,
  type TelegramFan,
  type TelegramGroupMember,
} from '@/lib/api';

const NOTES_DEBOUNCE_MS = 3500;
const MEMBER_FILTER_THRESHOLD = 12;
const STATUS_ORDER: Record<string, number> = { creator: 0, admin: 1, member: 2 };

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
      {children}
    </h3>
  );
}

function FanAvatar({
  avatarUrl,
  name,
  size = 'md',
}: {
  avatarUrl?: string | null;
  name: string;
  size?: 'md' | 'sm';
}) {
  const [failed, setFailed] = useState(false);
  const src = resolveCreatorAvatarUrl(avatarUrl);
  const initial = (name || '?').charAt(0).toUpperCase();
  const dim = size === 'sm' ? 'w-8 h-8 text-[11px]' : 'w-12 h-12 text-sm';
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        className={`${dim} rounded-full object-cover border border-gray-300 dark:border-zinc-700 shrink-0 bg-gray-100 dark:bg-zinc-800`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`${dim} rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center font-medium border border-gray-300 dark:border-zinc-700 shrink-0 text-gray-700 dark:text-zinc-300`}
    >
      {initial}
    </div>
  );
}

function memberRoleLabel(member: TelegramGroupMember): string | null {
  if (member.title) return member.title;
  if (member.status === 'creator') return 'Owner';
  if (member.status === 'admin') return 'Admin';
  return null;
}

function sortMembers(members: TelegramGroupMember[]): TelegramGroupMember[] {
  return [...members].sort((a, b) => {
    const sa = STATUS_ORDER[a.status || 'member'] ?? 2;
    const sb = STATUS_ORDER[b.status || 'member'] ?? 2;
    if (sa !== sb) return sa - sb;
    if (Boolean(a.isBot) !== Boolean(b.isBot)) return a.isBot ? 1 : -1;
    return (a.displayName || '').localeCompare(b.displayName || '', undefined, {
      sensitivity: 'base',
    });
  });
}

export default function TelegramFanPanel({
  creatorId,
  fan,
  showUsername,
  onFanUpdated,
  className = '',
  onClose,
}: {
  creatorId: string;
  fan: TelegramFan | null;
  showUsername: boolean;
  onFanUpdated: (fan: TelegramFan) => void;
  className?: string;
  onClose?: () => void;
}) {
  const fanId = fan?.telegramUserId || '';
  const isGroup = fan?.kind === 'group';
  const displayName =
    fan?.nickname?.trim() || fan?.displayName?.trim() || (isGroup ? 'Group' : 'Fan');

  const [alias, setAlias] = useState(fan?.nickname || '');
  const [nicknameDraft, setNicknameDraft] = useState(fan?.nickname || '');
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);

  const [remoteNotes, setRemoteNotes] = useState(fan?.notes || '');
  const [notesDraft, setNotesDraft] = useState(
    fan?.notes?.trim() ? fan.notes : DEFAULT_FAN_NOTES_TEMPLATE
  );
  const [notesStatus, setNotesStatus] = useState<
    'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  >('idle');
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesSavedBaselineRef = useRef(fan?.notes || '');
  const notesTimerRef = useRef<number | null>(null);
  const notesDraftRef = useRef(notesDraft);
  const fanIdRef = useRef(fanId);
  fanIdRef.current = fanId;

  const [members, setMembers] = useState<TelegramGroupMember[]>([]);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [membersStatus, setMembersStatus] = useState<'idle' | 'loading' | 'error'>(
    'idle'
  );
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState('');

  useEffect(() => {
    notesDraftRef.current = notesDraft;
  }, [notesDraft]);

  useEffect(() => {
    setEditingNickname(false);
    setNicknameError(null);
    setNotesStatus('idle');
    setNotesError(null);
    if (notesTimerRef.current != null) {
      window.clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
    const nextAlias = fan?.nickname || '';
    const nextNotes = fan?.notes || '';
    setAlias(nextAlias);
    setNicknameDraft(nextAlias);
    setRemoteNotes(nextNotes);
    notesSavedBaselineRef.current = nextNotes;
    setNotesDraft(nextNotes.trim() ? nextNotes : DEFAULT_FAN_NOTES_TEMPLATE);
  }, [fan?.telegramUserId, fan?.nickname, fan?.notes]);

  useEffect(() => {
    if (!isGroup || !creatorId || !fanId) {
      setMembers([]);
      setMemberCount(null);
      setMembersStatus('idle');
      setMembersError(null);
      setMemberQuery('');
      return;
    }
    let cancelled = false;
    setMembersStatus('loading');
    setMembersError(null);
    setMemberQuery('');
    void getTelegramGroupMembers(creatorId, fanId)
      .then((result) => {
        if (cancelled) return;
        setMembers(sortMembers(result.members || []));
        setMemberCount(
          typeof result.memberCount === 'number' ? result.memberCount : null
        );
        setMembersStatus('idle');
      })
      .catch((err) => {
        if (cancelled) return;
        setMembers([]);
        setMemberCount(null);
        setMembersStatus('error');
        setMembersError(
          err instanceof Error ? err.message : 'Failed to load members'
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isGroup, creatorId, fanId]);

  const visibleMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) => {
      const name = (member.displayName || '').toLowerCase();
      const username = (member.username || '').toLowerCase();
      return name.includes(query) || username.includes(query);
    });
  }, [members, memberQuery]);

  async function handleNicknameSave() {
    if (!fanId) return;
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const result = await patchTelegramFan(creatorId, fanId, {
        nickname: nicknameDraft.trim(),
      });
      setAlias(result.fan.nickname || '');
      setNicknameDraft(result.fan.nickname || '');
      setEditingNickname(false);
      onFanUpdated(result.fan);
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : 'Failed to save nickname');
    } finally {
      setNicknameSaving(false);
    }
  }

  async function handleNicknameRemove() {
    if (!fanId) return;
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const result = await patchTelegramFan(creatorId, fanId, { nickname: '' });
      setAlias('');
      setNicknameDraft('');
      setEditingNickname(false);
      onFanUpdated(result.fan);
    } catch (err) {
      setNicknameError(
        err instanceof Error ? err.message : 'Failed to remove nickname'
      );
    } finally {
      setNicknameSaving(false);
    }
  }

  const saveNotes = useCallback(
    async (value: string) => {
      if (!fanId) return;
      if (fanIdRef.current !== fanId) return;
      const trimmed = value.trim();
      const baseline = notesSavedBaselineRef.current;
      const isTemplateOnly =
        !baseline.trim() && trimmed === DEFAULT_FAN_NOTES_TEMPLATE.trim();
      if (isTemplateOnly) {
        setNotesStatus('idle');
        return;
      }
      if (value === baseline) {
        setNotesStatus('idle');
        return;
      }
      setNotesStatus('saving');
      setNotesError(null);
      try {
        const result = await patchTelegramFan(creatorId, fanId, {
          notes: trimmed,
        });
        const next = result.fan.notes || '';
        notesSavedBaselineRef.current = next;
        setRemoteNotes(next);
        setNotesStatus('saved');
        onFanUpdated(result.fan);
      } catch (err) {
        setNotesStatus('error');
        setNotesError(err instanceof Error ? err.message : 'Failed to save notes');
      }
    },
    [creatorId, fanId, onFanUpdated]
  );

  function scheduleNotesSave(value: string) {
    setNotesStatus('dirty');
    if (notesTimerRef.current != null) {
      window.clearTimeout(notesTimerRef.current);
    }
    notesTimerRef.current = window.setTimeout(() => {
      notesTimerRef.current = null;
      void saveNotes(value);
    }, NOTES_DEBOUNCE_MS);
  }

  return (
    <aside
      className={`flex flex-col h-full min-h-0 bg-white dark:bg-zinc-950 border-l border-gray-200 dark:border-zinc-800 ${className}`}
    >
      <div className="h-12 px-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-1 shrink-0">
        <p className="text-xs font-semibold text-gray-900 dark:text-white">
          {isGroup ? 'Group info' : 'Fan info'}
        </p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
            title="Close panel"
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-4 pt-4 pb-3 flex items-start gap-3 border-b border-gray-200 dark:border-zinc-800/60">
          <FanAvatar avatarUrl={fan?.avatarUrl} name={displayName} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-gray-900 dark:text-white truncate">
              {displayName}
            </p>
            {showUsername && fan?.username ? (
              <p className="text-xs text-gray-500 dark:text-zinc-500 truncate">
                @{fan.username}
              </p>
            ) : fan?.kind === 'group' ? (
              <p className="text-xs text-sky-600">Group</p>
            ) : null}
          </div>
        </div>

        <div className="p-4 space-y-5">
          {isGroup && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <SectionHeading>Participants</SectionHeading>
                {membersStatus !== 'loading' && members.length > 0 && (
                  <span className="text-[10px] text-gray-400 dark:text-zinc-500 tabular-nums">
                    {memberCount != null && memberCount > members.length
                      ? `${members.length} of ${memberCount}`
                      : String(memberCount ?? members.length)}
                  </span>
                )}
              </div>
              {membersStatus === 'loading' && (
                <p className="text-xs text-gray-500 dark:text-zinc-500 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading members…
                </p>
              )}
              {membersStatus === 'error' && (
                <p className="text-[11px] text-red-400">
                  {membersError || 'Failed to load members'}
                </p>
              )}
              {membersStatus === 'idle' && members.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-zinc-500">
                  No members found
                </p>
              )}
              {membersStatus === 'idle' && members.length > 0 && (
                <>
                  {members.length > MEMBER_FILTER_THRESHOLD && (
                    <input
                      type="search"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder="Filter members…"
                      className="w-full mb-2 px-2.5 py-1.5 text-xs rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-white outline-none focus:border-sky-500/60"
                    />
                  )}
                  {visibleMembers.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-zinc-500">
                      No matching members
                    </p>
                  ) : (
                    <ul className="space-y-1 max-h-72 overflow-y-auto -mx-1 px-1">
                      {visibleMembers.map((member) => {
                        const role = memberRoleLabel(member);
                        return (
                          <li
                            key={member.telegramUserId}
                            className="flex items-center gap-2 py-1.5"
                          >
                            <FanAvatar
                              avatarUrl={member.avatarUrl}
                              name={member.displayName}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                                  {member.displayName || 'Fan'}
                                  {member.isSelf ? ' (you)' : ''}
                                </p>
                                {role && (
                                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-sky-600 bg-sky-500/10 px-1.5 py-0.5 rounded">
                                    {role}
                                  </span>
                                )}
                                {member.isBot && (
                                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:text-zinc-400 bg-gray-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                                    Bot
                                  </span>
                                )}
                              </div>
                              {showUsername && member.username ? (
                                <p className="text-[11px] text-gray-500 dark:text-zinc-500 truncate">
                                  @{member.username}
                                </p>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-2">
              <SectionHeading>Nickname</SectionHeading>
              {alias && !editingNickname && (
                <button
                  type="button"
                  onClick={() => void handleNicknameRemove()}
                  disabled={nicknameSaving || !fanId}
                  className="text-[10px] font-semibold text-red-400 hover:text-red-300 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              )}
            </div>
            {editingNickname ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={nicknameDraft}
                  onChange={(e) => setNicknameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleNicknameSave();
                    }
                    if (e.key === 'Escape') {
                      setNicknameDraft(alias);
                      setEditingNickname(false);
                    }
                  }}
                  autoFocus
                  placeholder="Nickname"
                  className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white outline-none focus:border-sky-500/60"
                  disabled={nicknameSaving}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleNicknameSave()}
                    disabled={nicknameSaving}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-sky-600 text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {nicknameSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNicknameDraft(alias);
                      setEditingNickname(false);
                    }}
                    disabled={nicknameSaving}
                    className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingNickname(true)}
                disabled={!fanId}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-left hover:border-gray-300 dark:hover:border-zinc-700 disabled:opacity-50"
              >
                <span
                  className={`text-sm truncate ${
                    alias
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-400 dark:text-zinc-500'
                  }`}
                >
                  {alias || 'Add nickname…'}
                </span>
                <Pencil className="w-3.5 h-3.5 text-gray-400 dark:text-zinc-500 shrink-0" />
              </button>
            )}
            {nicknameError && (
              <p className="mt-1.5 text-[11px] text-red-400">{nicknameError}</p>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <SectionHeading>Notes</SectionHeading>
              <span className="text-[10px] text-gray-400 dark:text-zinc-500">
                {notesStatus === 'saving' && (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                  </span>
                )}
                {notesStatus === 'saved' && (
                  <span className="inline-flex items-center gap-0.5 text-emerald-400">
                    <Check className="w-3 h-3" /> Saved
                  </span>
                )}
                {notesStatus === 'dirty' && 'Unsaved'}
                {notesStatus === 'error' && 'Error'}
              </span>
            </div>
            <textarea
              value={notesDraft}
              onChange={(e) => {
                const value = e.target.value;
                setNotesDraft(value);
                scheduleNotesSave(value);
              }}
              onBlur={() => {
                if (notesTimerRef.current != null) {
                  window.clearTimeout(notesTimerRef.current);
                  notesTimerRef.current = null;
                }
                void saveNotes(notesDraft);
              }}
              rows={14}
              spellCheck={false}
              disabled={!fanId}
              className="w-full px-3 py-2.5 text-xs leading-relaxed rounded-lg bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-zinc-200 outline-none focus:border-sky-500/60 resize-y min-h-[200px] font-mono disabled:opacity-50"
              placeholder="Notes about this fan…"
            />
            {remoteNotes.trim() && (
              <button
                type="button"
                onClick={() => {
                  setNotesDraft('');
                  void saveNotes('');
                }}
                disabled={!fanId}
                className="mt-1.5 text-[10px] font-semibold text-red-400 hover:text-red-300 disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Clear notes
              </button>
            )}
            {notesError && (
              <p className="mt-1.5 text-[11px] text-red-400">{notesError}</p>
            )}
          </section>
        </div>
      </div>
    </aside>
  );
}
