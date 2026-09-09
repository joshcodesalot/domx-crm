import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';

export interface AiSuggestionCardDraft {
  reply: string;
  replyEnglish: string;
  intent?: string | null;
  action?: string | null;
  mediaId?: string | null;
  price?: number | null;
  output?: Record<string, unknown> | null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ppvLine(suggestion: AiSuggestionCardDraft): string | null {
  const output =
    suggestion.output && typeof suggestion.output === 'object'
      ? suggestion.output
      : null;
  const action = suggestion.action || asOptionalString(output?.action) || null;
  if (action !== 'SEND_PPV') return null;
  const mediaId = suggestion.mediaId || asOptionalString(output?.mediaId) || '';
  const price = suggestion.price ?? asOptionalNumber(output?.price);
  return `PPV ${price ?? ''} · ${mediaId}`;
}

export interface AiSuggestionCardProps {
  suggestion: AiSuggestionCardDraft;
  stale?: boolean;
  platform?: string | null;
  busy?: boolean;
  error?: string | null;
  onDismiss?: () => void;
  onApprove?: () => void;
  onEditSend?: (text: string) => void;
  onReject?: () => void;
  onRegenerate?: () => void;
  onPause?: () => void;
  onTakeover?: () => void;
}

const btnBase =
  'px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors';
const btnEnabled =
  `${btnBase} border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800`;
const btnDisabled =
  `${btnBase} border-gray-200 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 disabled:opacity-50 cursor-not-allowed`;
const btnPrimary =
  `${btnBase} border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40`;

export default function AiSuggestionCard({
  suggestion,
  stale = false,
  platform = null,
  busy = false,
  error = null,
  onDismiss,
  onApprove,
  onEditSend,
  onReject,
  onRegenerate,
  onPause,
  onTakeover,
}: AiSuggestionCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(suggestion.reply);
  const english = suggestion.replyEnglish.trim();
  const reply = suggestion.reply.trim();
  const intent = suggestion.intent?.trim();
  const ppv = ppvLine(suggestion);
  const canSend = platform === 'maloum' && !stale && !busy;
  const approveEnabled = Boolean(canSend && onApprove && !editing);
  const editEnabled = Boolean(canSend && onEditSend);
  const rejectEnabled = Boolean(onReject && !busy);
  const regenEnabled = Boolean(onRegenerate && !busy);
  const pauseEnabled = Boolean(onPause && !busy);
  const takeoverEnabled = Boolean(onTakeover && !busy);

  return (
    <div className="mb-2 rounded-xl border border-gray-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-domx-600 dark:text-domx-400 shrink-0" />
          <p className="text-xs font-medium text-gray-800 dark:text-zinc-200">
            AI draft
          </p>
          {intent ? (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400">
              {intent}
            </span>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-800 dark:hover:text-zinc-200"
            aria-label="Dismiss AI draft"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      {stale ? (
        <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900/50 rounded-lg px-2 py-1">
          Stale — a newer fan message arrived. Review before using.
        </p>
      ) : null}

      {english ? (
        <p className="text-[11px] text-gray-500 dark:text-zinc-400 leading-relaxed mb-1">
          {english}
        </p>
      ) : null}
      {editing ? (
        <textarea
          value={editText}
          onChange={(event) => setEditText(event.target.value)}
          rows={3}
          disabled={busy}
          className="w-full text-sm text-gray-900 dark:text-zinc-100 leading-relaxed rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1.5 resize-y"
        />
      ) : reply ? (
        <p className="text-sm text-gray-900 dark:text-zinc-100 leading-relaxed">
          {reply}
        </p>
      ) : null}

      {ppv ? (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">
          {ppv}
        </p>
      ) : null}

      {error ? (
        <p className="mt-1.5 text-[11px] text-red-500">{error}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1">
        <button
          type="button"
          disabled={!approveEnabled}
          onClick={onApprove}
          className={approveEnabled ? btnPrimary : btnDisabled}
        >
          Approve
        </button>
        {editing ? (
          <>
            <button
              type="button"
              disabled={!editEnabled || !editText.trim()}
              onClick={() => onEditSend?.(editText.trim())}
              className={editEnabled && editText.trim() ? btnPrimary : btnDisabled}
            >
              Edit&amp;Send
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setEditText(suggestion.reply);
              }}
              className={busy ? btnDisabled : btnEnabled}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!editEnabled}
            onClick={() => {
              setEditText(suggestion.reply);
              setEditing(true);
            }}
            className={editEnabled ? btnEnabled : btnDisabled}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          disabled={!rejectEnabled}
          onClick={onReject}
          className={rejectEnabled ? btnEnabled : btnDisabled}
        >
          Reject
        </button>
        <button
          type="button"
          disabled={!regenEnabled}
          onClick={onRegenerate}
          className={regenEnabled ? btnEnabled : btnDisabled}
        >
          Regenerate
        </button>
        <button
          type="button"
          disabled={!pauseEnabled}
          onClick={onPause}
          className={pauseEnabled ? btnEnabled : btnDisabled}
        >
          Pause
        </button>
        <button
          type="button"
          disabled={!takeoverEnabled}
          onClick={onTakeover}
          className={takeoverEnabled ? btnEnabled : btnDisabled}
        >
          Take over
        </button>
      </div>
    </div>
  );
}
